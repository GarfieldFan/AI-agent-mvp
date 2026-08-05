"""AI provider abstraction — the project's other core differentiator
alongside the RBAC/agent-isolation work: the chat model and the embedding
model are each swappable behind a common interface, not hardcoded to one
vendor. RAG (backend/retrieval.py, apis/chat.py, apis/documents.py) is
built against these protocols, never against Ollama/OpenAI/etc. directly.

Two separate roles, not one, because they don't swap the same way:

- `ChatProvider` (generation) is swappable per-call, freely — today's
  answer can come from Ollama, tomorrow's from Claude, with no side
  effects on anything already stored.
- `EmbeddingProvider` (embeddings) is NOT freely swappable once documents
  are ingested: different providers/models produce vectors of different
  dimensions (nomic-embed-text is 768-dim, OpenAI's text-embedding-3-small
  is 1536, etc.), and a similarity search can't compare vectors from two
  different embedding spaces. Switching the embedding provider means
  re-embedding every stored chunk, not just flipping a config value. See
  `backend/models.py`'s `DocumentChunk.embedding` column comment and the
  root `AGENTS.md`'s RAG section for how this project handles that.
"""

from typing import Protocol


class ChatProvider(Protocol):
    """A model that can answer a prompt, optionally with conversation
    history. Implementations: providers/ollama.py (real),
    providers/openai.py, providers/anthropic.py, providers/gemini.py
    (interface satisfied, 501 until an API key is configured)."""

    name: str

    async def chat(self, messages: list[dict], *, system: str | None = None) -> str: ...


class EmbeddingProvider(Protocol):
    """A model that turns text into vectors for similarity search. See
    this module's docstring — swapping this one has real consequences for
    anything already ingested, unlike ChatProvider."""

    name: str
    dimensions: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class ProviderNotConfigured(Exception):
    """Raised by a provider that's implemented but has no API key/config
    set — distinct from a network/API failure, so callers (and error
    messages) can tell "you haven't set this up" apart from "this broke"."""

    def __init__(self, provider_name: str, missing_env_var: str):
        self.provider_name = provider_name
        self.missing_env_var = missing_env_var
        super().__init__(
            f"{provider_name} is not configured — set the {missing_env_var} environment variable to use it."
        )
