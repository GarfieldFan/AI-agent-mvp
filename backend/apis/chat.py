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
"""

from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.model_settings import resolve_chat_provider
from db import get_db
from models import ChatMessage, ChatSession
from providers.base import ProviderNotConfigured
from providers.registry import get_embedding_provider
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
    "deflecting them. If asked what you are, say you're a locally-hosted "
    "open-source LLM running via Ollama, part of this site's on-prem AI "
    "demo. If asked about the site owner, mention they're a full-stack "
    "developer moving into AI/LLM application engineering, with projects "
    "covering RAG, agents, and local AI deployment. Keep replies short "
    "(2-4 sentences) and conversational — no corporate marketing tone, no "
    "vague non-answers."
)


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


class ChatSource(BaseModel):
    document_id: int
    chunk_id: int
    document_title: str
    excerpt: str
    score: float | None = None


class ChatResponse(BaseModel):
    reply: str
    sources: list[ChatSource] = []


def _get_or_create_session(db: Session, session_key: str) -> ChatSession:
    session = db.query(ChatSession).filter(ChatSession.session_key == session_key).first()
    if session is None:
        session = ChatSession(session_key=session_key)
        db.add(session)
        db.flush()  # populates session.id for the ChatMessage rows below
    else:
        session.last_seen_at = datetime.utcnow()
    return session


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, db: Session = Depends(get_db)) -> ChatResponse:
    """Send one turn to the owner-selected chat model, augmented with
    retrieved document context when relevant."""
    sources: list[ChatSource] = []
    user_content = req.message

    # Logged (and committed) before the provider call so the question
    # itself is captured for market-research review even if generation
    # fails below — see ChatSession's docstring in models.py.
    session = None
    if req.session_id:
        session = _get_or_create_session(db, req.session_id)
        db.add(ChatMessage(session_id=session.id, role="user", content=req.message))
        db.commit()

    try:
        embedder = get_embedding_provider()
        chunks = await retrieve(db, req.message, embedder)
    except ProviderNotConfigured:
        chunks = []  # embeddings not configured — degrade to plain chat, don't break the chatbot over it
    except httpx.HTTPError:
        chunks = []  # e.g. embedding model not pulled — same degrade-gracefully treatment

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
        sources = [
            ChatSource(
                document_id=c.document_id,
                chunk_id=c.chunk_id,
                document_title=c.document_title,
                excerpt=c.excerpt,
                score=c.score,
            )
            for c in chunks
            if c.score >= MIN_CITATION_SCORE
        ]

    messages = [{"role": turn.role, "content": turn.content} for turn in req.history]
    messages.append({"role": "user", "content": user_content})

    try:
        provider = resolve_chat_provider(db)
        reply = await provider.chat(messages, system=SYSTEM_PROMPT)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")

    if session is not None:
        db.add(ChatMessage(session_id=session.id, role="assistant", content=reply))
        db.commit()

    return ChatResponse(reply=reply, sources=sources)
