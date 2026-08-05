"""Anthropic (Claude) provider — chat only. Anthropic does not offer an
embeddings API at all (they point people at third parties like Voyage AI
for that), so there's deliberately no `AnthropicEmbeddingProvider` here —
that's a structural gap in what this vendor offers, not something we
forgot to implement. `get_embedding_provider("anthropic")` in registry.py
raises accordingly rather than pretending this exists.
"""

import os

import httpx

from providers.base import ProviderNotConfigured

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"


class AnthropicChatProvider:
    name = "anthropic"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("ANTHROPIC_CHAT_MODEL", "claude-sonnet-5")

    async def chat(self, messages: list[dict], *, system: str | None = None) -> str:
        if not ANTHROPIC_API_KEY:
            raise ProviderNotConfigured("Anthropic", "ANTHROPIC_API_KEY")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{ANTHROPIC_BASE_URL}/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": ANTHROPIC_VERSION,
                },
                json={
                    "model": self.model,
                    "max_tokens": 1024,
                    "system": system or "",
                    "messages": messages,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        # Claude's response content is a list of blocks; we only ever send
        # plain text in, so joining the text blocks back is enough here.
        return "".join(block.get("text", "") for block in data.get("content", []))
