"""Document management for RAG — upload/list/delete. Admin/owner only:
only an authenticated admin/owner can feed the knowledge base. The public
chatbot (apis/chat.py, via retrieval.py) only ever *reads* what's ingested
here, never writes — same split as backend/apis/pages.py's admin vs
public routers.

This used to be a 501 stub in apis/agent.py (`ingest_document`) — moved
here once it became real, both because there's real supporting logic now
(parsing, chunking, storage) and to give document *management* (list,
delete) a home alongside it.
"""

import base64
import os
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from apis.deps import CurrentUser, Role, get_current_user, require_role
from apis.model_settings import resolve_embedding_provider
from db import get_db
from ingest import chunk_text, parse_document
from models import AppSettings, Document, DocumentChunk
from providers.base import ProviderNotConfigured

router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])

# Relative filenames are stored on the Document row; this is where they
# actually live on disk. Under the existing ./backend bind mount (see
# docker-compose.yml) — persists naturally, no separate named volume
# needed. backend/.dockerignore keeps uploads from getting baked into the
# image on rebuild.
STORAGE_DIR = Path(os.environ.get("DOCUMENT_STORAGE_DIR", "/app/storage/documents"))


class IngestDocumentRequest(BaseModel):
    filename: str
    content_type: str
    content_base64: str


class DocumentSummary(BaseModel):
    id: int
    filename: str
    content_type: str
    size_bytes: int
    status: str
    error_message: str | None = None
    chunk_count: int
    uploaded_by: str | None = None
    created_at: datetime
    embedding_provider: str | None = None
    embedding_model: str | None = None
    # True when this document's chunks (if any) were embedded under a
    # different provider/model than AppSettings' current one — e.g. the
    # owner switched embedding providers since this document was last
    # (re-)ingested. See POST /agent/documents/reembed-all.
    needs_reembed: bool = False


class ReembedFailure(BaseModel):
    document_id: int
    filename: str
    error: str


class ReembedAllResponse(BaseModel):
    processed: int
    succeeded: int
    failed: list[ReembedFailure]


def _current_embedding_config(db: Session) -> tuple[str | None, str | None]:
    """(provider, model) actually in effect right now — via
    resolve_embedding_provider so this matches exactly what ingestion/
    retrieval will use, including the env-var fallback when nothing's
    been explicitly saved. None/None (rather than raising) when custom is
    selected but not configured — every document then correctly shows as
    needing re-embed, since the active config is unusable anyway."""
    try:
        provider = resolve_embedding_provider(db)
    except ProviderNotConfigured:
        return None, None
    return provider.name, getattr(provider, "model", None)


def _record_embedding_dimensions(db: Session, vectors: list[list[float]]) -> None:
    """Stamps AppSettings.embedding_dimensions with the actual length of a
    just-computed vector — more trustworthy than any provider's claimed
    static dimension (custom especially, see providers/custom.py), and
    gives the owner-facing picker something real to display."""
    if not vectors:
        return
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    row.embedding_dimensions = len(vectors[0])


def _to_summary(document: Document, current: tuple[str | None, str | None]) -> DocumentSummary:
    current_provider, current_model = current
    return DocumentSummary(
        id=document.id,
        filename=document.filename,
        content_type=document.content_type,
        size_bytes=document.size_bytes,
        status=document.status,
        error_message=document.error_message,
        chunk_count=len(document.chunks),
        uploaded_by=document.uploaded_by,
        created_at=document.created_at,
        embedding_provider=document.embedding_provider,
        embedding_model=document.embedding_model,
        needs_reembed=(document.embedding_provider, document.embedding_model) != (current_provider, current_model),
    )


@router.post("/agent/documents/ingest", response_model=DocumentSummary)
async def ingest_document(
    req: IngestDocumentRequest,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(get_current_user),
) -> DocumentSummary:
    """Parse -> chunk -> embed -> store. Synchronous (blocks until done,
    same tradeoff generate_landing_page makes) — fine for MVP-sized
    documents; a real background job queue would be the next step for
    anything large enough to time out a request."""
    content_b64 = req.content_base64
    # Tolerate a data-URI prefix (e.g. from the browser's FileReader
    # .readAsDataURL, "data:application/pdf;base64,...") — same pattern
    # apis/api.py and agent.py's vision endpoint already use.
    if content_b64.strip().lower().startswith("data:") and "," in content_b64:
        content_b64 = content_b64.split(",", 1)[1]

    try:
        raw_bytes = base64.b64decode(content_b64, validate=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 content: {e}")

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{req.filename}"
    (STORAGE_DIR / stored_name).write_bytes(raw_bytes)

    document = Document(
        filename=req.filename,
        content_type=req.content_type,
        size_bytes=len(raw_bytes),
        storage_path=stored_name,
        status="processing",
        uploaded_by=current.email,
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    try:
        text = parse_document(raw_bytes, req.content_type, req.filename)
        chunks = chunk_text(text)
        if not chunks:
            raise ValueError("No extractable text found in this document.")

        embedder = resolve_embedding_provider(db)
        vectors = await embedder.embed(chunks)

        for index, (chunk_content, vector) in enumerate(zip(chunks, vectors)):
            db.add(
                DocumentChunk(
                    document_id=document.id,
                    chunk_index=index,
                    content=chunk_content,
                    embedding=vector,
                )
            )

        document.status = "ready"
        document.embedding_provider = embedder.name
        document.embedding_model = getattr(embedder, "model", None)
        _record_embedding_dimensions(db, vectors)
        db.commit()
    except ProviderNotConfigured as e:
        document.status = "error"
        document.error_message = str(e)
        db.commit()
    except Exception as e:
        document.status = "error"
        document.error_message = str(e)
        db.commit()

    db.refresh(document)
    return _to_summary(document, _current_embedding_config(db))


@router.get("/agent/documents", response_model=list[DocumentSummary])
def list_documents(db: Session = Depends(get_db)) -> list[DocumentSummary]:
    documents = db.scalars(select(Document).order_by(Document.created_at.desc())).all()
    current = _current_embedding_config(db)
    return [_to_summary(d, current) for d in documents]


@router.delete("/agent/documents/{document_id}", status_code=204)
def delete_document(document_id: int, db: Session = Depends(get_db)) -> None:
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    storage_file = STORAGE_DIR / document.storage_path
    db.delete(document)  # cascades to document_chunks
    db.commit()
    if storage_file.exists():
        storage_file.unlink()


@router.post("/agent/documents/reembed-all", response_model=ReembedAllResponse)
async def reembed_all_documents(db: Session = Depends(get_db)) -> ReembedAllResponse:
    """Re-parses and re-embeds every document's raw file (still on disk
    under STORAGE_DIR — see IngestDocumentRequest's storage step) against
    whatever embedding provider/model is *currently* configured. This is
    the recovery path after apis/model_settings.py's update_settings
    clears document_chunks on an embedding provider switch — see this
    module's DocumentSummary.needs_reembed and the root AGENTS.md.

    Synchronous, like ingest_document — no background job queue exists in
    this codebase; fine for MVP-sized document sets, commits per-document
    so one failure doesn't roll back documents that already succeeded."""
    documents = db.scalars(select(Document)).all()
    succeeded = 0
    failed: list[ReembedFailure] = []

    for document in documents:
        try:
            raw_bytes = (STORAGE_DIR / document.storage_path).read_bytes()
            text = parse_document(raw_bytes, document.content_type, document.filename)
            chunks = chunk_text(text)
            if not chunks:
                raise ValueError("No extractable text found in this document.")

            embedder = resolve_embedding_provider(db)
            vectors = await embedder.embed(chunks)

            db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document.id))
            for index, (chunk_content, vector) in enumerate(zip(chunks, vectors)):
                db.add(
                    DocumentChunk(
                        document_id=document.id,
                        chunk_index=index,
                        content=chunk_content,
                        embedding=vector,
                    )
                )

            document.status = "ready"
            document.error_message = None
            document.embedding_provider = embedder.name
            document.embedding_model = getattr(embedder, "model", None)
            _record_embedding_dimensions(db, vectors)
            db.commit()
            succeeded += 1
        except Exception as e:
            db.rollback()
            document.status = "error"
            document.error_message = f"Re-embed failed: {e}"
            db.commit()
            failed.append(ReembedFailure(document_id=document.id, filename=document.filename, error=str(e)))

    return ReembedAllResponse(processed=len(documents), succeeded=succeeded, failed=failed)
