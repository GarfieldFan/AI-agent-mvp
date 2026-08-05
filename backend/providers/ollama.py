"""Ollama provider — the only one with real local model backing today
(no API key, no network egress). Both chat and embeddings go through
Ollama's OpenAI-compatible endpoints, the same family backend/apis/chat.py
and agent.py's vision call already use.
"""

import os

import httpx

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434/v1")


class OllamaChatProvider:
    name = "ollama"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("OLLAMA_CHAT_MODEL", "gemma4:latest")

    async def chat(self, messages: list[dict], *, system: str | None = None) -> str:
        full_messages = ([{"role": "system", "content": system}] if system else []) + messages
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/chat/completions",
                json={"model": self.model, "messages": full_messages, "stream": False},
            )
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"]


class OllamaEmbeddingProvider:
    name = "ollama"
    # nomic-embed-text's output dimensionality — hardcoded because
    # pgvector needs a fixed column width (see models.py's DocumentChunk).
    # If you switch OLLAMA_EMBEDDING_MODEL to something with a different
    # output size, this must change AND every stored chunk must be
    # re-embedded — see providers/base.py's module docstring.
    dimensions = 768

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text")

    # Sending an entire document's chunk list in one /v1/embeddings call
    # breaks locally past ~200-300 texts: Ollama's internal tokenizer
    # subprocess drops the connection ("dial tcp 127.0.0.1:PORT:
    # connectex... actively refused") and the whole request 400s —
    # reproduced directly against Ollama (bypassing this codebase
    # entirely) while testing a ~1.5MB document, confirmed with a plain
    # 128-item batch working right after a 300-item one failed. Not a bug
    # in our code, just an Ollama batch-size ceiling — worked around here
    # by chunking the request client-side. 128 leaves comfortable margin
    # under the observed ~200-succeeds/~300-fails line.
    _BATCH_SIZE = 128

    async def embed(self, texts: list[str]) -> list[list[float]]:
        embeddings: list[list[float]] = []
        async with httpx.AsyncClient(timeout=120) as client:
            for start in range(0, len(texts), self._BATCH_SIZE):
                batch = texts[start : start + self._BATCH_SIZE]
                resp = await client.post(
                    f"{OLLAMA_BASE_URL}/embeddings",
                    json={"model": self.model, "input": batch},
                )
                resp.raise_for_status()
                data = resp.json()
                # OpenAI-compatible shape: {"data": [{"embedding": [...], "index": 0}, ...]}
                # — sorted defensively in case the provider doesn't preserve order
                # (index is relative to this batch, not the overall `texts` list).
                by_index = sorted(data["data"], key=lambda item: item["index"])
                embeddings.extend(item["embedding"] for item in by_index)
        return embeddings
