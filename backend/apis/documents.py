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
from sqlalchemy import select
from sqlalchemy.orm import Session

from apis.deps import CurrentUser, Role, get_current_user, require_role
from db import get_db
from ingest import chunk_text, parse_document
from models import Document, DocumentChunk
from providers.base import ProviderNotConfigured
from providers.registry import get_embedding_provider

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


def _to_summary(document: Document) -> DocumentSummary:
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

        embedder = get_embedding_provider()
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
    return _to_summary(document)


@router.get("/agent/documents", response_model=list[DocumentSummary])
def list_documents(db: Session = Depends(get_db)) -> list[DocumentSummary]:
    documents = db.scalars(select(Document).order_by(Document.created_at.desc())).all()
    return [_to_summary(d) for d in documents]


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
