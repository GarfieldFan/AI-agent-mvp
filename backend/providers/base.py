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

import httpx


class ChatProvider(Protocol):
    """A model that can answer a prompt, optionally with conversation
    history. Implementations: providers/ollama.py (real),
    providers/openai.py, providers/anthropic.py, providers/gemini.py
    (interface satisfied, 501 until an API key is configured).

    `messages[i]["content"]` may be a plain string, or (2026-08-18, vision
    unification) a list of OpenAI-shaped content parts —
    `{"type": "text", "text": ...}` / `{"type": "image_url", "image_url":
    {"url": "data:<mime>;base64,<data>"}}`. Ollama/OpenAI/Custom pass this
    straight through (already OpenAI-compatible); Anthropic/Gemini
    translate it into their own vendor-specific shape internally — see
    each provider's `chat()`. Callers (apis/agent.py's
    generate_landing_page, chat_attachments.py) build this shape once and
    never need to know which provider is actually resolved.

    `json_mode`, when a provider supports it, asks for a forced-JSON
    response (Ollama/OpenAI/Custom: `response_format`; Gemini:
    `responseMimeType`); Anthropic has no native equivalent and silently
    ignores it — every caller already runs the result through
    llm_json.parse_lenient_json regardless, so this is a reliability
    boost, not a correctness requirement."""

    name: str

    async def chat(
        self, messages: list[dict], *, system: str | None = None, json_mode: bool = False
    ) -> str: ...


class EmbeddingProvider(Protocol):
    """A model that turns text into vectors for similarity search. See
    this module's docstring — swapping this one has real consequences for
    anything already ingested, unlike ChatProvider."""

    name: str
    dimensions: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class ImageProvider(Protocol):
    """A model that turns a text prompt into an image. Implementations:
    providers/comfyui.py (self-hosted, always returns real bytes),
    providers/openai.py's OpenAIImageProvider, providers/gemini.py's
    GeminiImageProvider (interface satisfied, ProviderNotConfigured until
    an API key is set — same posture as ChatProvider/EmbeddingProvider).

    `generate()` always returns **both** a stable, servable URL and the
    raw image bytes — never just one. This is what lets
    apis/agent.py's generate_poster composite text onto the result
    (add_text_overlay, needs raw bytes) identically regardless of which
    provider generated it, instead of each caller needing a
    provider-specific "fetch this back" step. ComfyUI already has the
    bytes in hand after generating (fetched from its own output);
    OpenAI/Gemini return base64 image data directly from their API, which
    gets persisted into apis/media.py's MEDIA_UPLOAD_DIR to produce a
    stable URL (unlike a chat reply, a generated image needs to keep
    existing after the request completes — this project has no
    reason to trust a cloud vendor's own, often short-lived, hosted URL
    for that)."""

    name: str

    async def generate(self, prompt: str) -> tuple[str, bytes]: ...


# An admin filling in a custom endpoint field is describing an address
# from their own browser's point of view ("my machine") — but every
# actual request is made by the `backend` container, where these
# addresses mean the container itself, not the host machine anything
# else (llama.cpp, ComfyUI, ...) is running on. Nobody sets up a custom
# endpoint meaning to point back at this project's own backend, so
# silently retargeting is the right default here — the same fix
# providers/ollama.py's OLLAMA_BASE_URL default already relies on
# (`host.docker.internal`, not `localhost`). Shared by providers/custom.py
# (chat/embedding) and providers/comfyui.py (image-gen) so both normalize
# a caller-typed address identically instead of duplicating this list.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def normalize_loopback_host(base_url: str) -> str:
    try:
        url = httpx.URL(base_url)
    except Exception:
        return base_url.rstrip("/")
    if url.host in _LOOPBACK_HOSTS:
        url = url.copy_with(host="host.docker.internal")
    return str(url).rstrip("/")


def parse_data_uri(url: str) -> tuple[str, str]:
    """Splits a `data:<mime>;base64,<data>` URL (the shape every caller
    that builds an image content part already uses, e.g.
    `f"data:image/png;base64,{image_b64}"`) into `(mime, base64_data)`.
    Shared by providers/anthropic.py and providers/gemini.py, both of
    which need the raw base64 payload + mime type separately for their
    own vendor-specific image content shape (unlike Ollama/OpenAI/Custom,
    which accept the whole data: URL as-is)."""
    if not url.startswith("data:") or ";base64," not in url:
        raise ValueError(f"Expected a data:<mime>;base64,<data> URL, got: {url[:50]!r}")
    header, data = url.split(",", 1)
    mime = header[len("data:") : -len(";base64")]
    return mime, data


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
