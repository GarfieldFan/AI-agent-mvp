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
from urllib.parse import urlparse

import httpx
import trafilatura
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from apis.deps import CurrentUser, Role, get_current_user, require_role
from apis.model_settings import resolve_chat_provider, resolve_embedding_provider
from db import SessionLocal, get_db
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
    # True (default) = this document states facts about the business
    # itself; False = background reference material (a law, a
    # regulation) the business operates within but doesn't own. See
    # models.Document.is_company_material's own docstring.
    is_company_material: bool = True
    # Owner-typed status note, or leave unset and use suggest_status_note
    # below to have the model draft one from the document's own text.
    status_note: str | None = None
    # When true, _suggest_status_note runs after parsing succeeds and
    # fills status_note automatically if (and only if) the text
    # explicitly states its own status — never overrides an explicitly
    # provided status_note above.
    suggest_status_note: bool = False


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
    # Set only for a document ingested via POST .../ingest-from-url
    # (2026-08-21) — null for a plain file upload. DocumentManager shows
    # this as a link + a "Re-sync" action; ScheduledTask's
    # "resync_url_document" task_type re-fetches it on a recurring basis.
    source_url: str | None = None
    is_company_material: bool = True
    status_note: str | None = None


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
        source_url=document.source_url,
        is_company_material=document.is_company_material,
        status_note=document.status_note,
    )


_URL_FETCH_TIMEOUT = 60.0

# Content-types this app already knows how to parse directly (see
# ingest.parse_document) — a URL whose response carries one of these (or
# whose path ends in the matching extension) is treated as a document
# fetch, not a webpage: the raw bytes are stored and parsed exactly like
# an upload. Anything else is treated as HTML and run through
# trafilatura's own content extraction instead.
_DIRECT_PARSE_CONTENT_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
}


def _filename_from_url(url: str, suffix: str) -> str:
    """Best-effort human-readable filename from a URL's own path — falls
    back to the URL's host when the path is empty/just "/" (common for a
    bare domain or a JS-rendered SPA route)."""
    parsed = urlparse(url)
    last_segment = parsed.path.rstrip("/").rsplit("/", 1)[-1]
    base = last_segment or parsed.netloc or "page"
    return base if base.lower().endswith(suffix) else f"{base}{suffix}"


# A generic browser-shaped User-Agent, not httpx's own default
# ("python-httpx/x.x.x") — confirmed live during development that a
# real, well-known site (Wikipedia) 403s the default UA outright while
# working fine with this one. Many government/legal-database sites run
# similar WAF-level bot filtering, so this isn't a hypothetical edge
# case for this feature's actual target use case.
_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; AI-Employee-DocumentBot/1.0; RAG document ingestion)"


async def _fetch_url_content(url: str) -> tuple[bytes, str, str]:
    """Fetches `url` and returns (effective_bytes, effective_content_type,
    filename) ready to feed straight into ingest.parse_document — a PDF/
    DOCX response is passed through as-is; anything else is treated as
    HTML and run through trafilatura's own text extraction first, since
    parse_document has no HTML support of its own. Raises ValueError on
    an unreachable URL or a page with no extractable text (e.g. a login
    wall, a JS-only SPA shell)."""
    async with httpx.AsyncClient(
        timeout=_URL_FETCH_TIMEOUT, follow_redirects=True, headers={"User-Agent": _FETCH_USER_AGENT}
    ) as client:
        try:
            response = await client.get(url)
            response.raise_for_status()
        except httpx.HTTPError as e:
            raise ValueError(f"Could not fetch {url}: {e}")

    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    lower_url = url.lower()

    for direct_type, suffix in _DIRECT_PARSE_CONTENT_TYPES.items():
        if content_type == direct_type or lower_url.endswith(suffix):
            return response.content, direct_type, _filename_from_url(url, suffix)

    extracted = trafilatura.extract(
        response.text, url=url, favor_recall=True, include_tables=True, output_format="txt"
    )
    if not extracted or not extracted.strip():
        raise ValueError(f"No extractable text found at {url} — it may be a JS-rendered page or behind a login wall.")
    return extracted.encode("utf-8"), "text/plain", _filename_from_url(url, ".txt")


_STATUS_NOTE_SYSTEM_PROMPT = (
    "You are given the text of an ingested reference document. If — and ONLY if — the text "
    "explicitly states its own legal/official status (e.g. it says it has been repealed, "
    "superseded, withdrawn, is a proposed/draft/pending version, or states an explicit "
    "effective/expiration date), write ONE short sentence capturing that status "
    "(e.g. \"Repealed 2024-01-01, replaced by SB-123.\"). If the text does NOT explicitly "
    "state its own status, respond with EXACTLY the single word NONE — never guess or infer "
    "a status the text doesn't directly say. Respond with only the sentence or the word NONE, "
    "no other commentary."
)

# Enough for the model to see the document's own header/preamble (where a
# status statement typically lives) without spending the full document on
# a single-sentence classification call.
_STATUS_NOTE_TEXT_BUDGET = 6000


async def _suggest_status_note(db: Session, text: str) -> str | None:
    """Best-effort LLM classification, never raises — a failure here
    (provider unreachable, malformed response) should never break
    ingestion, which is why every caller treats this as optional
    (suggest_status_note=False by default) rather than part of the core
    pipeline. Deliberately conservative: returns None unless the source
    text explicitly states its own status, mirroring
    business_profile.py's suggest_business_profile's "don't invent
    facts" discipline."""
    try:
        provider = resolve_chat_provider(db)
        messages = [{"role": "user", "content": text[:_STATUS_NOTE_TEXT_BUDGET]}]
        raw = await provider.chat(messages, system=_STATUS_NOTE_SYSTEM_PROMPT)
    except Exception:
        return None
    note = raw.strip().strip('"')
    if not note or note.upper() == "NONE":
        return None
    return note[:500]


async def _run_url_ingest(document_id: int, suggest_status_note: bool = False) -> None:
    """Fetches/re-fetches a URL-sourced Document's content and (re-)runs
    it through the exact same parse -> chunk -> embed pipeline
    ingest_document uses for an upload — the only difference is where the
    raw bytes come from. Runs with its OWN DB session (SessionLocal, not
    a request-scoped `db`), since this is always called either from a
    FastAPI BackgroundTask (the request's own session is already closed
    by the time this runs) or from scheduler.py's recurring dispatch
    (no request at all). Every failure is caught and stored on the
    Document row itself, never raised — there's no caller left to receive
    an exception either way."""
    db = SessionLocal()
    try:
        document = db.get(Document, document_id)
        if document is None or not document.source_url:
            return

        document.status = "processing"
        db.commit()

        try:
            raw_bytes, content_type, filename = await _fetch_url_content(document.source_url)

            STORAGE_DIR.mkdir(parents=True, exist_ok=True)
            stored_name = f"{uuid.uuid4().hex}_{filename}"
            (STORAGE_DIR / stored_name).write_bytes(raw_bytes)
            # Best-effort cleanup of the previous fetch's file on a
            # re-sync — a missing/already-gone file is fine, nothing else
            # references storage_path once it's overwritten below.
            if document.storage_path:
                (STORAGE_DIR / document.storage_path).unlink(missing_ok=True)

            text = parse_document(raw_bytes, content_type, filename)
            chunks = chunk_text(text)
            if not chunks:
                raise ValueError("No extractable text found in this document.")

            embedder = resolve_embedding_provider(db)
            vectors = await embedder.embed(chunks)

            db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document.id))
            for index, (chunk_content, vector) in enumerate(zip(chunks, vectors)):
                db.add(
                    DocumentChunk(document_id=document.id, chunk_index=index, content=chunk_content, embedding=vector)
                )

            document.filename = filename
            document.content_type = content_type
            document.size_bytes = len(raw_bytes)
            document.storage_path = stored_name
            document.status = "ready"
            document.error_message = None
            document.embedding_provider = embedder.name
            document.embedding_model = getattr(embedder, "model", None)
            _record_embedding_dimensions(db, vectors)
            if suggest_status_note:
                document.status_note = await _suggest_status_note(db, text)
            db.commit()
        except Exception as e:
            db.rollback()
            document.status = "error"
            document.error_message = str(e)
            db.commit()
    finally:
        db.close()


class IngestFromUrlRequest(BaseModel):
    # A single URL or a batch — the caller doesn't have to choose between
    # two shapes; str/list[str] is Pydantic-validated directly. Legal/
    # regulation research is the motivating case: an owner adding a whole
    # batch of statute URLs at once, not one at a time.
    url: str | list[str]
    # Applies to every URL in this batch — the motivating case (a batch
    # of statute/regulation URLs) is usually all-reference or
    # all-company-material together; a mixed batch just means two
    # separate calls. See models.Document.is_company_material.
    is_company_material: bool = True
    # Per-URL, not per-batch (unlike is_company_material above) — each
    # URL's own text is classified independently, since a batch of
    # statutes plausibly has a genuine mix of current/repealed/proposed.
    # See _suggest_status_note's own docstring for the "never guess"
    # discipline.
    suggest_status_note: bool = False


class IngestFromUrlResponse(BaseModel):
    documents: list[DocumentSummary]


@router.post("/agent/documents/ingest-from-url", response_model=IngestFromUrlResponse)
def ingest_from_url(
    req: IngestFromUrlRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(get_current_user),
) -> IngestFromUrlResponse:
    """Creates one `pending` Document row per URL immediately and returns
    right away — the actual fetch/parse/chunk/embed work runs as a
    FastAPI BackgroundTask (_run_url_ingest), not inline, unlike
    ingest_document's synchronous upload path. This matters specifically
    for the case that motivated it: a batch of large legal/regulation
    documents can take real time to fetch and embed, and this app runs
    a single uvicorn worker (see rate_limit.py's own docstring) — a
    long synchronous request here would block that worker, including the
    public /api/chat path. The owner watches progress via the existing
    pending -> processing -> ready/error status already shown in
    DocumentManager (GET /agent/documents), no new UI needed."""
    urls = req.url if isinstance(req.url, list) else [req.url]
    urls = [u.strip() for u in urls if u.strip()]
    if not urls:
        raise HTTPException(status_code=400, detail="At least one URL is required.")

    current_config = _current_embedding_config(db)
    summaries: list[DocumentSummary] = []
    for url in urls:
        document = Document(
            filename=url,
            content_type="application/octet-stream",
            size_bytes=0,
            storage_path="",
            status="pending",
            source_url=url,
            is_company_material=req.is_company_material,
            uploaded_by=current.email,
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        background_tasks.add_task(_run_url_ingest, document.id, req.suggest_status_note)
        summaries.append(_to_summary(document, current_config))

    return IngestFromUrlResponse(documents=summaries)


@router.post("/agent/documents/{document_id}/resync", response_model=DocumentSummary)
def resync_document(
    document_id: int,
    background_tasks: BackgroundTasks,
    suggest_status_note: bool = False,
    db: Session = Depends(get_db),
) -> DocumentSummary:
    """Manually re-fetches and re-embeds a URL-sourced document right now
    — same background-task mechanism as ingest_from_url. Also what
    scheduler.py's "resync_url_document" task_type calls under the hood
    for a recurring re-sync (see backend/scheduler.py) — that path reads
    suggest_status_note from the ScheduledTask's own task_args."""
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not document.source_url:
        raise HTTPException(status_code=400, detail="This document wasn't ingested from a URL, so it can't be re-synced.")

    document.status = "processing"
    db.commit()
    db.refresh(document)
    background_tasks.add_task(_run_url_ingest, document.id, suggest_status_note)
    return _to_summary(document, _current_embedding_config(db))


async def _ingest_content(
    db: Session,
    uploaded_by: str | None,
    filename: str,
    content_type: str,
    raw_bytes: bytes,
    *,
    is_company_material: bool = True,
    status_note: str | None = None,
    suggest_status_note: bool = False,
) -> Document:
    """Shared parse -> chunk -> embed -> store core (2026-09-10, factored
    out of ingest_document below once create_document_from_text needed
    the identical pipeline) — synchronous (blocks until done, same
    tradeoff generate_landing_page makes), fine for MVP-sized documents."""
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{filename}"
    (STORAGE_DIR / stored_name).write_bytes(raw_bytes)

    document = Document(
        filename=filename,
        content_type=content_type,
        size_bytes=len(raw_bytes),
        storage_path=stored_name,
        status="processing",
        is_company_material=is_company_material,
        status_note=status_note,
        uploaded_by=uploaded_by,
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    try:
        text = parse_document(raw_bytes, content_type, filename)
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
        if suggest_status_note and not document.status_note:
            document.status_note = await _suggest_status_note(db, text)
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
    return document


@router.post("/agent/documents/ingest", response_model=DocumentSummary)
async def ingest_document(
    req: IngestDocumentRequest,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(get_current_user),
) -> DocumentSummary:
    """A base64-encoded file upload — see _ingest_content above for the
    actual parse/chunk/embed/store pipeline."""
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

    document = await _ingest_content(
        db,
        current.email,
        req.filename,
        req.content_type,
        raw_bytes,
        is_company_material=req.is_company_material,
        status_note=req.status_note,
        suggest_status_note=req.suggest_status_note,
    )
    return _to_summary(document, _current_embedding_config(db))


class CreateDocumentFromTextRequest(BaseModel):
    title: str
    content: str
    is_company_material: bool = True


@router.post("/agent/documents/create-from-text", response_model=DocumentSummary)
async def create_document_from_text(
    req: CreateDocumentFromTextRequest,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(get_current_user),
) -> DocumentSummary:
    """Owner-agent's create_document tool (owner-agent/tools.py) — the
    plain-text counterpart to ingest_document above, built specifically
    so the model never has to produce base64 inside its own tool-call
    JSON (same "a text-generation model shouldn't be asked to emit a
    binary encoding" reasoning as generate_landing_page_from_url uses
    for images). Shares ingest_document's exact pipeline via
    _ingest_content — the only difference is the input is already plain
    text, never a file the owner uploaded first."""
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title must not be empty")
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="content must not be empty")
    filename = title if title.lower().endswith((".txt", ".md")) else f"{title}.txt"
    document = await _ingest_content(
        db,
        current.email,
        filename,
        "text/plain",
        req.content.encode("utf-8"),
        is_company_material=req.is_company_material,
    )
    return _to_summary(document, _current_embedding_config(db))


class DocumentListResponse(BaseModel):
    items: list[DocumentSummary]
    total: int
    # Stale-document count across EVERY document, not just this page
    # (2026-08-20, added alongside pagination) — DocumentManager's
    # "needs re-embed" banner needs the true total; computing it from
    # `items` alone would silently undercount (or wrongly hide the
    # banner) once a stale document lands on a page the owner isn't
    # currently viewing.
    needs_reembed_count: int


@router.get("/agent/documents", response_model=DocumentListResponse)
def list_documents(limit: int = 50, offset: int = 0, db: Session = Depends(get_db)) -> DocumentListResponse:
    """Paginated (2026-08-20, was a plain unbounded list — see the root
    AGENTS.md's pagination entry)."""
    total = db.execute(select(func.count()).select_from(Document)).scalar_one()
    documents = (
        db.scalars(select(Document).order_by(Document.created_at.desc()).limit(limit).offset(offset)).all()
    )
    current = _current_embedding_config(db)
    current_provider, current_model = current
    needs_reembed_count = db.execute(
        select(func.count())
        .select_from(Document)
        .where(
            or_(
                Document.embedding_provider.is_distinct_from(current_provider),
                Document.embedding_model.is_distinct_from(current_model),
            )
        )
    ).scalar_one()
    return DocumentListResponse(
        items=[_to_summary(d, current) for d in documents],
        total=total,
        needs_reembed_count=needs_reembed_count,
    )


class UpdateDocumentRequest(BaseModel):
    # None = don't touch that field — lets a caller update just one of
    # the two independently. For status_note specifically, an explicitly
    # sent empty string clears it (same "blank clears" convention as
    # apis/chat_settings.py's chat_system_prompt); None/omitted leaves
    # whatever's already stored untouched.
    is_company_material: bool | None = None
    status_note: str | None = None


@router.patch("/agent/documents/{document_id}", response_model=DocumentSummary)
def update_document(document_id: int, req: UpdateDocumentRequest, db: Session = Depends(get_db)) -> DocumentSummary:
    """Toggles is_company_material and/or edits status_note after the
    fact (2026-08-21) — e.g. a document uploaded as company material
    that turns out to actually be reference material, or a status note
    that needs correcting once a law is actually repealed. Doesn't touch
    status/chunks/embeddings at all, this is purely classification
    metadata."""
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if req.is_company_material is not None:
        document.is_company_material = req.is_company_material
    if req.status_note is not None:
        document.status_note = req.status_note.strip() or None
    db.commit()
    db.refresh(document)
    return _to_summary(document, _current_embedding_config(db))


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
