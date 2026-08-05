"""Google Gemini provider. Real API calls against the Generative Language
API (no SDK dependency), gated on GEMINI_API_KEY being set.
"""

import os

import httpx

from providers.base import ProviderNotConfigured

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def _to_gemini_contents(messages: list[dict]) -> list[dict]:
    # Gemini uses "model" where everyone else says "assistant"; everything
    # else maps straight across for our plain-text-only use.
    return [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
        for m in messages
    ]


class GeminiChatProvider:
    name = "gemini"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("GEMINI_CHAT_MODEL", "gemini-2.5-flash")

    async def chat(self, messages: list[dict], *, system: str | None = None) -> str:
        if not GEMINI_API_KEY:
            raise ProviderNotConfigured("Gemini", "GEMINI_API_KEY")

        payload: dict = {"contents": _to_gemini_contents(messages)}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{GEMINI_BASE_URL}/models/{self.model}:generateContent",
                params={"key": GEMINI_API_KEY},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
        parts = data["candidates"][0]["content"]["parts"]
        return "".join(part.get("text", "") for part in parts)


class GeminiEmbeddingProvider:
    name = "gemini"
    # text-embedding-004's default output size. Do NOT change this without
    # also re-embedding every stored chunk — see providers/base.py.
    dimensions = 768

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("GEMINI_EMBEDDING_MODEL", "text-embedding-004")

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not GEMINI_API_KEY:
            raise ProviderNotConfigured("Gemini", "GEMINI_API_KEY")

        requests = [
            {"model": f"models/{self.model}", "content": {"parts": [{"text": text}]}} for text in texts
        ]
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{GEMINI_BASE_URL}/models/{self.model}:batchEmbedContents",
                params={"key": GEMINI_API_KEY},
                json={"requests": requests},
            )
            resp.raise_for_status()
            data = resp.json()
        return [item["values"] for item in data["embeddings"]]
