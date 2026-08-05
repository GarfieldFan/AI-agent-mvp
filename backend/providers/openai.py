"""OpenAI provider. Real API calls (no SDK dependency, just httpx against
OpenAI's REST API) gated on OPENAI_API_KEY being set — raises
ProviderNotConfigured before attempting a call if it isn't, rather than
failing with a confusing 401 from OpenAI itself.
"""

import os

import httpx

from providers.base import ProviderNotConfigured

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_BASE_URL = "https://api.openai.com/v1"


class OpenAIChatProvider:
    name = "openai"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("OPENAI_CHAT_MODEL", "gpt-4o-mini")

    async def chat(self, messages: list[dict], *, system: str | None = None) -> str:
        if not OPENAI_API_KEY:
            raise ProviderNotConfigured("OpenAI", "OPENAI_API_KEY")

        full_messages = ([{"role": "system", "content": system}] if system else []) + messages
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{OPENAI_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={"model": self.model, "messages": full_messages},
            )
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"]


class OpenAIEmbeddingProvider:
    name = "openai"
    # text-embedding-3-small's default output size. Do NOT change this
    # without also re-embedding every stored chunk — see
    # providers/base.py's module docstring.
    dimensions = 1536

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not OPENAI_API_KEY:
            raise ProviderNotConfigured("OpenAI", "OPENAI_API_KEY")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{OPENAI_BASE_URL}/embeddings",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={"model": self.model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()
        by_index = sorted(data["data"], key=lambda item: item["index"])
        return [item["embedding"] for item in by_index]
