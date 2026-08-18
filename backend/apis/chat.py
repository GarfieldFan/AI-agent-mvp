"""User-tier chatbot: FE -> BE -> [optional RAG retrieval] -> ChatProvider -> BE -> FE.

Deliberately the *only* thing a regular `user`-role visitor's chat message
can reach — plain LLM inference plus read-only document retrieval, no
tools, no filesystem access, no agent. Admin/owner-only agent capabilities
(document ingest, generation, CRM, reports, ...) live in apis/agent.py
behind require_role, not here. See the architecture note in the repo root
AGENTS.md for why that split exists.

Merged with the old standalone /knowledge page's RAG Q&A on 2026-08-04 —
a real company deployment wouldn't split "ask about us" and "chat with the
assistant" across two separate public surfaces; a visitor should get one
chatbot that answers from uploaded documents when relevant and otherwise
just converses normally. Every free-text turn now retrieves the closest
document chunks (retrieval.py) and includes them as optional context —
the model is told to use them only if relevant, so general questions
("what is 1+1", "who are you") still work exactly as before even once
documents exist. If nothing's been uploaded yet (or the embedding
provider isn't configured/reachable), retrieval degrades to a no-op
rather than breaking the chatbot.

Session persistence added 2026-08-04 — see ChatSession's docstring in
models.py. This is a DB-only, read-with-a-DB-client feature for now
(deliberately no admin viewer UI yet, see the root AGENTS.md): every turn
carrying a client-generated `session_id` gets logged as a ChatSession +
ChatMessage rows, purely for the owner to review visitor questions later.
It has no effect on the chat request/response itself — `history` (sent by
the frontend on every call) is still what gives the model conversational
context, independent of this logging.

Lead capture added 2026-08-08 — this MVP has no separate contact form, so
`_maybe_capture_lead` below lets a visitor book an appointment/request a
quote/estimate/file a claim entirely inside this same chat, no login.
This does NOT reopen the "no tools" boundary above: it's one fixed-shape
classification call (is this a real lead? which category? what email?),
never the model choosing among arbitrary actions, and its only possible
side effect is a bounded `CrmEntry` insert — the same shape admin/owner
already create by hand via `apis/agent.py`'s `create_crm_entry`, just
triggered by the visitor's own words instead of a dashboard form.

Optional caller identity added 2026-08-08 — `chat()` now resolves
`get_current_user` (apis/deps.py), the exact same never-rejects dependency
`require_role` is built on, just used here for its "who is this, if
anyone" resolution rather than its RBAC gate. A missing/invalid token
still resolves to an anonymous, email-less `CurrentUser` — this endpoint
stays reachable with zero login, unchanged. When a real account *is*
logged in, `_build_visitor_context` looks up that email's own past
`CrmEntry` rows (nothing new is collected — this only reads what the
visitor already gave us, whether via this chatbot or the dashboard) so
the model can recognize a returning visitor instead of re-asking who they
are, and `_maybe_capture_lead` can log a new request under their known
account email even if this particular message never spells the email
out. Same non-tool boundary as lead capture above: reading one's own
identity off an already-issued JWT isn't a privileged action.

Chat file attachment added 2026-08-08 — `POST /chat/upload` lets a
visitor attach one photo/PDF (a damage photo for a claim, a spec doc for
a quote, ...) before sending a chat turn, same public/no-auth tier as
`/chat` itself. Deliberately narrow for an endpoint with no auth gate at
all: a fixed extension whitelist (no `.svg`/`.html` — a browser can
execute script from either if ever opened directly), a hard size cap, and
a random `uuid4` filename (never the client-supplied name), stored under
a per-conversation folder (the caller's account email if logged in,
otherwise their client-generated `session_id`) — see
`backend/chat_attachments.py`, shared with `apis/agent.py`'s owner-
triggered deep scan.

Automatic attachment analysis added 2026-08-08 (same day, second pass) —
the chat model *does* now read an attachment's actual content:
`chat_attachments.extract_lead_info` runs an owner-selected vision model
(image) or the plain chat model over extracted text (PDF) to pull out
name/phone/email/intent, best-effort, on every turn that carries a fresh
attachment. The result is folded into both the main reply's context (so
the assistant doesn't ask the visitor to retype what's already legible in
their file) and `_maybe_capture_lead`'s `CrmEntry` fields
(`contact_name`/`contact_phone`, alongside the existing `contact_email`).
Swallows every failure — an unreadable file or an unreachable provider
degrades to "nothing extracted," never a broken chat reply.
"""

import base64
import re
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import sqlalchemy.exc
from sqlalchemy.orm import Session

import chat_attachments
from apis.deps import CurrentUser, get_current_user
from apis.model_settings import resolve_chat_provider, resolve_embedding_provider
from db import get_db
from llm_json import parse_lenient_json
from models import ChatMessage, ChatSession, CrmEntry
from providers.base import ProviderNotConfigured
from retrieval import retrieve

router = APIRouter()

# Gates *citation display only* — NOT whether the model gets context (see
# the chat() handler: every retrieved chunk is always passed as context,
# unfiltered). Cosine-similarity score (retrieval.py — 1 - distance,
# roughly 0..1) is a weaker signal than it looks: real testing (a Chinese
# question against an English PDF, "what does your company do") scored
# genuinely-relevant chunks anywhere from 0.37 to 0.51 depending on query
# phrasing/language, while a same-language but off-topic question ("what
# is the capital of France?") against the same document scored up to
# 0.38 on its closest chunks — the two distributions *overlap*, so no
# fixed threshold cleanly separates "relevant" from "not" here. An earlier
# version of this code used a threshold (0.45) to gate context inclusion
# itself, not just citations — that was a real bug: a genuine cross-
# lingual question (Chinese query, English document) scored 0.43, missed
# the 0.45 bar, and the model got ZERO context and couldn't answer at all
# ("we don't have any company info"), even though a same-language version
# of the identical question scored 0.51 on the same document. Decoupling
# fixed it: context inclusion no longer depends on this number at all, so
# a low cross-lingual score can never fully break retrieval again — this
# constant now only controls whether a citation chip is worth showing,
# where a wrong call is cosmetic (an occasional spurious/missing chip),
# not "the chatbot can't see its own documents."
MIN_CITATION_SCORE = 0.4

SYSTEM_PROMPT = (
    "You are a helpful AI assistant embedded in a developer's portfolio website. "
    "If document excerpts are provided below a question, treat them as your "
    "knowledge about a company/business the site owner has configured you to "
    "represent — answer using them when relevant, and don't invent details "
    "beyond what they say. If no excerpts are provided, or none of them are "
    "actually relevant to the question, fall back to being a friendly "
    "general-purpose conversational assistant: answer general questions "
    "directly and honestly (including simple ones like math) instead of "
    "deflecting them. If asked what you are, say you're an LLM the site "
    "owner has configured for this demo — the model/provider is swappable "
    "(local open-source or a cloud API), so don't name a specific vendor "
    "unless you're actually certain, and it's fine to say you don't know "
    "the exact underlying model. If asked about the site owner, mention "
    "they're a full-stack developer moving into AI/LLM application "
    "engineering, with projects "
    "covering RAG, agents, and local AI deployment. Keep replies short "
    "(2-4 sentences) and conversational — no corporate marketing tone, no "
    "vague non-answers. There is no separate contact form on this site — "
    "if the visitor wants to book an appointment, request a quote/estimate, "
    "or file/check an insurance claim, handle it right here in the "
    "conversation: ask a couple of clarifying questions about what they "
    "need, and if they haven't given a contact email yet, ask for one so "
    "the team can follow up. Once they've given you an email, confirm "
    "you've noted their request — don't ask for it again. If a message "
    "below starts with '(Signed-in visitor', the visitor is logged in and "
    "you already know their email and past requests from that block — "
    "don't ask them who they are or for their email, and greet a "
    "returning visitor naturally (e.g. referencing a past request) when "
    "it's relevant, without being creepy about it. If a message contains "
    "a line like '[Attached file: <url>]', the visitor attached a photo "
    "or document — acknowledge that you see it. If that's immediately "
    "followed by a line like '(Automatic analysis of the attached file "
    "found: ...)', that's real information already read off the file "
    "automatically — treat it as already known, don't ask the visitor to "
    "repeat their name/phone/email if it's listed there, just briefly "
    "confirm it's correct if relevant. If no such analysis line is "
    "present, be upfront that you can't view the file's contents yourself "
    "and a team member will review it directly."
)

# Gates lead-capture extraction: only worth a second LLM call on a turn
# that could plausibly finish a booking/quote/claim, i.e. one where the
# visitor has actually typed something email-shaped. Without this,
# _maybe_capture_lead would run (and cost a model call) on every single
# ordinary chat turn, the overwhelming majority of which are never a lead.
_LEAD_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

_LEAD_CATEGORIES = {"appointment", "quote", "claim", "inquiry"}

# Recent lead history shown to the model when a caller is a signed-in
# visitor with prior CrmEntry rows — small on purpose, this is a "does the
# assistant recognize a returning visitor" nudge, not a full CRM export.
_VISITOR_CONTEXT_ENTRY_LIMIT = 5


def _lead_extraction_system_prompt(known_email: str | None, attachment_info: dict | None) -> str:
    known_email_clause = (
        f"The visitor is signed in with account email {known_email} — if they're making a real "
        "request but never spell an email out in the conversation, use this account email as "
        "contact_email rather than returning null.\n\n"
        if known_email
        else ""
    )
    attachment_clause = ""
    if attachment_info:
        facts = [f"{k}: {v}" for k, v in attachment_info.items() if v]
        if facts:
            attachment_clause = (
                "Automatic analysis of a file the visitor attached found: "
                + "; ".join(facts)
                + ". Use these as already-known facts for contact_name/contact_phone/contact_email — "
                "prefer the conversation text if it disagrees with these, but don't return null for a "
                "field this analysis already found.\n\n"
            )
    return (
        "You read a visitor's conversation with a company website's chatbot and decide whether it "
        "contains a real lead worth logging for the business to follow up on: a request to book an "
        "appointment, get a price quote/estimate, or file/check an insurance claim, where the visitor "
        "has also given a contact email (in the latest message, earlier in the conversation, or via the "
        "signed-in/attachment facts below).\n\n"
        f"{known_email_clause}"
        f"{attachment_clause}"
        "Respond with ONLY a single JSON object, no markdown fences, no commentary before or after it:\n"
        '{"is_lead": true or false, "category": "appointment" or "quote" or "claim" or "inquiry" or null, '
        '"contact_email": "<the email address, or null>", "contact_name": "<the visitor\'s name, or '
        'null>", "contact_phone": "<a phone number, or null>", "summary": "<one concise sentence '
        'describing what they want, for a human reviewing this later>"}\n\n'
        "Set is_lead to false for small talk, general questions, or a real request that has no contact "
        "email anywhere in the conversation, no signed-in account email, and no attachment-analysis email "
        "above. Never invent a value that isn't actually present in the conversation text or given above."
    )


async def _maybe_capture_lead(
    db: Session,
    provider,
    history: list["ChatTurn"],
    message: str,
    known_email: str | None = None,
    attachment_url: str | None = None,
    attachment_info: dict | None = None,
) -> None:
    """Best-effort structured lead capture — see this module's docstring
    for why this doesn't reopen the public chat's "no tools" boundary.
    `known_email` (a signed-in caller's own account email — see
    get_current_user above) both widens the gate below (a logged-in
    visitor doesn't need to retype an email that's already known) and
    backstops a missing/invalid model-extracted email. `attachment_url`
    (see POST /chat/upload) also widens the gate — a visitor attaching a
    file is itself a strong signal this turn is a real request, not small
    talk — and is stored on the captured entry unchanged. `attachment_info`
    (chat_attachments.extract_lead_info's best-effort name/phone/email/
    intent_summary, or None) both widens the gate further and backstops
    the extraction model's own contact_name/contact_phone/contact_email
    the same way known_email already backstops contact_email. Swallows
    every failure (provider unreachable, malformed JSON, bad email, DB
    error): losing a lead-capture attempt is fine, breaking the chat reply
    the visitor is waiting on is not."""
    if (
        not known_email
        and not attachment_url
        and not (attachment_info and any(attachment_info.values()))
        and not _LEAD_EMAIL_RE.search(message)
    ):
        return

    extraction_messages = [{"role": turn.role, "content": turn.content} for turn in history]
    extraction_messages.append({"role": "user", "content": message})

    try:
        raw = await provider.chat(
            extraction_messages, system=_lead_extraction_system_prompt(known_email, attachment_info)
        )
        parsed = parse_lenient_json(raw)

        if not parsed.get("is_lead"):
            return

        contact_email = parsed.get("contact_email")
        if not isinstance(contact_email, str) or not _LEAD_EMAIL_RE.search(contact_email):
            contact_email = known_email or (attachment_info or {}).get("email")
        if not contact_email:
            return

        contact_name = parsed.get("contact_name")
        if not isinstance(contact_name, str) or not contact_name.strip():
            contact_name = (attachment_info or {}).get("name")

        contact_phone = parsed.get("contact_phone")
        if not isinstance(contact_phone, str) or not contact_phone.strip():
            contact_phone = (attachment_info or {}).get("phone")

        category = parsed.get("category")
        if category not in _LEAD_CATEGORIES:
            category = "inquiry"

        summary = parsed.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            summary = message[:500]

        db.add(
            CrmEntry(
                contact_email=contact_email.strip(),
                contact_name=contact_name.strip() if contact_name else None,
                contact_phone=contact_phone.strip() if contact_phone else None,
                summary=summary.strip(),
                category=category,
                tags=["source:chat"],
                attachment_url=attachment_url,
            )
        )
        db.commit()
    except (httpx.HTTPError, ProviderNotConfigured, ValueError):
        db.rollback()


def _build_visitor_context(db: Session, email: str) -> str | None:
    """A short "here's what we already know about this signed-in visitor"
    block, built purely from their own past CrmEntry rows — nothing new is
    collected to build this. Returns None when they have no prior entries,
    so a first-time (but logged-in) visitor doesn't get an empty/awkward
    context block."""
    entries = (
        db.query(CrmEntry)
        .filter(CrmEntry.contact_email == email)
        .order_by(CrmEntry.created_at.desc())
        .limit(_VISITOR_CONTEXT_ENTRY_LIMIT)
        .all()
    )
    if not entries:
        return None

    lines = "\n".join(
        f"- [{e.category or 'inquiry'}, status: {e.status}] {e.summary} ({e.created_at.date().isoformat()})"
        for e in entries
    )
    return f"(Signed-in visitor: {email}. Their past requests with us:\n{lines})"


class ChatTurn(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatTurn] = []
    # Client-generated (see frontend/src/lib/chat.ts's getChatSessionId),
    # not a login — purely a grouping key so /api/chat's turns can be
    # logged as one visitor's conversation. Optional and best-effort:
    # missing/empty just skips persistence, never breaks the chat itself.
    session_id: str | None = None
    # Set when the visitor attached a file via POST /chat/upload first —
    # see this module's docstring's "Chat file attachment" section. Never
    # a raw file on this request, always a URL onto this module's own
    # storage.
    attachment_url: str | None = None


class ChatSource(BaseModel):
    document_id: int
    chunk_id: int
    document_title: str
    excerpt: str
    score: float | None = None


class ChatResponse(BaseModel):
    reply: str
    sources: list[ChatSource] = []


class ChatUploadRequest(BaseModel):
    filename: str
    content_base64: str
    # Same client-generated id as ChatRequest.session_id — resolves the
    # per-conversation storage folder for an anonymous caller (see
    # chat_attachments.save_upload). A logged-in caller's account email
    # takes priority over this when both are available.
    session_id: str | None = None


class ChatUploadResponse(BaseModel):
    filename: str
    url: str


@router.post("/chat/upload", response_model=ChatUploadResponse)
def upload_chat_attachment(
    req: ChatUploadRequest, current: CurrentUser = Depends(get_current_user)
) -> ChatUploadResponse:
    """Public, no-auth (same tier as /chat itself) — see this module's
    docstring for why the validation here is stricter than
    apis/media.py's admin-gated equivalent it's otherwise modeled on."""
    content_b64 = req.content_base64
    # Tolerate a data-URI prefix, same pattern as apis/media.py/documents.py.
    if content_b64.strip().lower().startswith("data:") and "," in content_b64:
        content_b64 = content_b64.split(",", 1)[1]

    try:
        raw_bytes = base64.b64decode(content_b64, validate=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 file data: {e}")

    if len(raw_bytes) > chat_attachments.CHAT_UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large — max {chat_attachments.CHAT_UPLOAD_MAX_BYTES // (1024 * 1024)}MB.",
        )

    conversation_id = current.email or req.session_id or "anonymous"
    try:
        url = chat_attachments.save_upload(conversation_id, req.filename, raw_bytes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return ChatUploadResponse(filename=url.rsplit("/", 1)[-1], url=url)


def _attachment_note(attachment_url: str | None) -> str:
    """Appended to both the persisted ChatMessage and the model-facing
    text when the visitor attached a file — see this module's docstring's
    "Chat file attachment" section. `SYSTEM_PROMPT` tells the model what
    this `[Attached file: ...]` marker means."""
    return f"\n\n[Attached file: {attachment_url}]" if attachment_url else ""


def _attachment_info_note(info: dict | None) -> str:
    """Appended right after `_attachment_note` in the model-facing text
    when `chat_attachments.extract_lead_info` found something — see this
    module's docstring's "Automatic attachment analysis" section.
    `SYSTEM_PROMPT` tells the model what this block means. Returns "" if
    nothing was actually extracted, so a failed/empty analysis doesn't add
    a hollow context block."""
    if not info:
        return ""
    facts = []
    if info.get("name"):
        facts.append(f"name: {info['name']}")
    if info.get("phone"):
        facts.append(f"phone: {info['phone']}")
    if info.get("email"):
        facts.append(f"email: {info['email']}")
    if info.get("intent_summary"):
        facts.append(f"apparent purpose: {info['intent_summary']}")
    if not facts:
        return ""
    return f"\n\n(Automatic analysis of the attached file found: {'; '.join(facts)}.)"


def _get_or_create_session(db: Session, session_key: str, user_email: str | None) -> ChatSession:
    session = db.query(ChatSession).filter(ChatSession.session_key == session_key).first()
    if session is None:
        session = ChatSession(session_key=session_key, user_email=user_email)
        db.add(session)
        db.flush()  # populates session.id for the ChatMessage rows below
    else:
        session.last_seen_at = datetime.utcnow()
        if user_email:
            # Backfills identity onto a session that started anonymously
            # (visitor logs in mid-conversation) — never clears a known
            # email back to anonymous, since a request never carries proof
            # of "logged out," only the absence of a token.
            session.user_email = user_email
    return session


@router.post("/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest, db: Session = Depends(get_db), current: CurrentUser = Depends(get_current_user)
) -> ChatResponse:
    """Send one turn to the owner-selected chat model, augmented with
    retrieved document context when relevant. `current` resolves whatever
    JWT (if any) the caller sent — see this module's docstring's "Optional
    caller identity" section; a missing/invalid token behaves exactly as
    before this existed."""
    sources: list[ChatSource] = []
    user_content = req.message

    # Logged (and committed) before the provider call so the question
    # itself is captured for market-research review even if generation
    # fails below — see ChatSession's docstring in models.py.
    session = None
    if req.session_id:
        session = _get_or_create_session(db, req.session_id, current.email)
        db.add(
            ChatMessage(
                session_id=session.id,
                role="user",
                content=req.message + _attachment_note(req.attachment_url),
            )
        )
        db.commit()

    # Best-effort automatic extraction off a fresh attachment — see this
    # module's docstring's "Automatic attachment analysis" section.
    # extract_lead_info never raises (see chat_attachments.py), so nothing
    # further needs to guard this call.
    attachment_info: dict | None = None
    if req.attachment_url:
        local_path = chat_attachments.resolve_local_path(req.attachment_url)
        if local_path is not None:
            attachment_info = await chat_attachments.extract_lead_info(db, local_path)

    try:
        embedder = resolve_embedding_provider(db)
        chunks = await retrieve(db, req.message, embedder)
    except ProviderNotConfigured:
        chunks = []  # embeddings not configured — degrade to plain chat, don't break the chatbot over it
    except httpx.HTTPError:
        chunks = []  # e.g. embedding model not pulled — same degrade-gracefully treatment
    except sqlalchemy.exc.DBAPIError:
        # Defensive fallback: update_settings() clears document_chunks the
        # instant the embedding provider/model changes specifically to
        # prevent this, but a request racing that save could still catch
        # a table briefly mid-transition — degrade the same way, not a 500.
        chunks = []

    if chunks:
        # Every retrieved chunk goes to the model, regardless of score —
        # see MIN_CITATION_SCORE's comment for why gating this on score
        # broke real cross-lingual questions. The system prompt already
        # tells the model to use these "only if relevant"; that judgment
        # call belongs to the model reading the actual content, not to a
        # cosine-similarity number computed before it ever sees the text.
        context_block = "\n\n".join(
            f"[{i + 1}] (from {c.document_title}): {c.content}" for i, c in enumerate(chunks)
        )
        user_content = f"Context (use only if relevant to the question):\n{context_block}\n\nQuestion: {req.message}"
        # One citation chip per *document*, not per chunk — `chunks` is
        # already ordered best-score-first (retrieve()'s query orders by
        # distance ascending), so keeping the first chunk seen per
        # document_id keeps its highest-scoring chunk. Without this, a
        # single multi-chunk document matching on several chunks showed
        # up as several identical-looking citation chips.
        seen_document_ids: set[int] = set()
        sources = []
        for c in chunks:
            if c.score < MIN_CITATION_SCORE or c.document_id in seen_document_ids:
                continue
            seen_document_ids.add(c.document_id)
            sources.append(
                ChatSource(
                    document_id=c.document_id,
                    chunk_id=c.chunk_id,
                    document_title=c.document_title,
                    excerpt=c.excerpt,
                    score=c.score,
                )
            )

    if current.email:
        visitor_context = _build_visitor_context(db, current.email)
        if visitor_context:
            user_content = f"{visitor_context}\n\n{user_content}"

    user_content = f"{user_content}{_attachment_note(req.attachment_url)}{_attachment_info_note(attachment_info)}"

    messages = [{"role": turn.role, "content": turn.content} for turn in req.history]
    messages.append({"role": "user", "content": user_content})

    try:
        provider = resolve_chat_provider(db)
        reply = await provider.chat(messages, system=SYSTEM_PROMPT)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")

    await _maybe_capture_lead(
        db, provider, req.history, req.message, current.email, req.attachment_url, attachment_info
    )

    if session is not None:
        db.add(ChatMessage(session_id=session.id, role="assistant", content=reply))
        db.commit()

    return ChatResponse(reply=reply, sources=sources)
