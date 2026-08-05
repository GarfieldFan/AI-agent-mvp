"""RAG retrieval — pure query-time logic (embed -> pgvector similarity
search), no FastAPI router of its own. Used by apis/chat.py to ground the
public chatbot's replies in uploaded documents when relevant.

Used to be its own endpoint (apis/rag.py, backing a standalone /knowledge
page) until 2026-08-04, when it was folded into the main chatbot — see the
root AGENTS.md's note on that merge for the reasoning. This module is what
survived the merge: the retrieval half, kept separate from apis/chat.py's
generation/prompting logic so it stays easy to reason about (and reuse
again, if some other surface ever needs plain retrieval without the chat
persona wrapped around it).
"""

import os

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Document, DocumentChunk
from providers.base import EmbeddingProvider

TOP_K = int(os.environ.get("RAG_TOP_K", "5"))
EXCERPT_LENGTH = 240


class RetrievedChunk(BaseModel):
    document_id: int
    chunk_id: int
    document_title: str
    content: str
    excerpt: str
    score: float


async def retrieve(
    db: Session, query: str, embedder: EmbeddingProvider, top_k: int = TOP_K
) -> list[RetrievedChunk]:
    """Embeds `query` and returns the `top_k` closest chunks across every
    `status="ready"` document, regardless of how relevant they actually
    are — pgvector always returns *something* if any chunks exist.
    Callers that need to decide "is this actually relevant" (as opposed to
    "merely the closest of what's available") must apply their own score
    threshold; see apis/chat.py's MIN_RELEVANCE_SCORE for the one place
    that currently does."""
    [query_vector] = await embedder.embed([query])

    stmt = (
        select(
            DocumentChunk.id,
            DocumentChunk.document_id,
            DocumentChunk.content,
            Document.filename,
            DocumentChunk.embedding.cosine_distance(query_vector).label("distance"),
        )
        .join(Document, Document.id == DocumentChunk.document_id)
        .where(Document.status == "ready")
        .order_by("distance")
        .limit(top_k)
    )
    rows = db.execute(stmt).all()

    return [
        RetrievedChunk(
            document_id=row.document_id,
            chunk_id=row.id,
            document_title=row.filename,
            content=row.content,
            excerpt=row.content[:EXCERPT_LENGTH] + ("…" if len(row.content) > EXCERPT_LENGTH else ""),
            score=max(0.0, 1 - row.distance),
        )
        for row in rows
    ]
