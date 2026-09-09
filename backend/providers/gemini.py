"""Google Gemini provider. Real API calls against the Generative Language
API (no SDK dependency), gated on GEMINI_API_KEY being set.
"""

import base64
import os

import httpx

from providers.base import ProviderNotConfigured, parse_data_uri

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def _to_gemini_parts(content: str | list[dict]) -> list[dict]:
    """Translates ChatProvider's generic OpenAI-shaped content (see
    providers/base.py's ChatProvider docstring) into Gemini's `parts`
    shape: a plain string becomes one `{"text": ...}` part;
    `{"type":"image_url","image_url":{"url":u}}` becomes
    `{"inline_data": {"mime_type": ..., "data": ...}}`."""
    if isinstance(content, str):
        return [{"text": content}]
    parts = []
    for part in content:
        if part.get("type") == "image_url":
            mime, data = parse_data_uri(part["image_url"]["url"])
            parts.append({"inline_data": {"mime_type": mime, "data": data}})
        else:
            parts.append({"text": part.get("text", "")})
    return parts


def _to_gemini_contents(messages: list[dict]) -> list[dict]:
    # Gemini uses "model" where everyone else says "assistant"; everything
    # else maps straight across.
    return [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": _to_gemini_parts(m["content"])}
        for m in messages
    ]


class GeminiChatProvider:
    name = "gemini"

    def __init__(self, model: str | None = None, api_key: str | None = None):
        self.model = model or os.environ.get("GEMINI_CHAT_MODEL", "gemini-2.5-flash")
        # Falls back to the module-level env var when not given — see
        # providers/openai.py's docstring (lets apis/model_settings.py
        # pass a DB-stored key instead).
        self.api_key = api_key or GEMINI_API_KEY

    async def chat(
        self, messages: list[dict], *, system: str | None = None, json_mode: bool = False
    ) -> str:
        if not self.api_key:
            raise ProviderNotConfigured("Gemini", "GEMINI_API_KEY")

        payload: dict = {"contents": _to_gemini_contents(messages)}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        if json_mode:
            payload["generationConfig"] = {"responseMimeType": "application/json"}

        # 600s — vision-to-page-JSON generation (routed through this same
        # method as of 2026-08-18) needs real headroom; see
        # providers/custom.py's comment for the real timing data this is
        # based on (a comparable local-model workload). A short chat
        # reply finishes long before this ceiling either way.
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{GEMINI_BASE_URL}/models/{self.model}:generateContent",
                params={"key": self.api_key},
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

    def __init__(self, model: str | None = None, api_key: str | None = None):
        self.model = model or os.environ.get("GEMINI_EMBEDDING_MODEL", "text-embedding-004")
        self.api_key = api_key or GEMINI_API_KEY

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.api_key:
            raise ProviderNotConfigured("Gemini", "GEMINI_API_KEY")

        requests = [
            {"model": f"models/{self.model}", "content": {"parts": [{"text": text}]}} for text in texts
        ]
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{GEMINI_BASE_URL}/models/{self.model}:batchEmbedContents",
                params={"key": self.api_key},
                json={"requests": requests},
            )
            resp.raise_for_status()
            data = resp.json()
        return [item["values"] for item in data["embeddings"]]


class GeminiImageProvider:
    name = "gemini"

    def __init__(self, model: str | None = None, api_key: str | None = None):
        self.model = model or os.environ.get("GEMINI_IMAGE_MODEL", "imagen-4.0-generate-001")
        self.api_key = api_key or GEMINI_API_KEY

    async def generate(self, prompt: str) -> tuple[str, bytes]:
        if not self.api_key:
            raise ProviderNotConfigured("Gemini", "GEMINI_API_KEY")

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{GEMINI_BASE_URL}/models/{self.model}:predict",
                params={"key": self.api_key},
                json={"instances": [{"prompt": prompt}], "parameters": {"sampleCount": 1}},
            )
            resp.raise_for_status()
            data = resp.json()
        image_bytes = base64.b64decode(data["predictions"][0]["bytesBase64Encoded"])

        # Same reasoning/pattern as providers/openai.py's OpenAIImageProvider
        # — imported here to keep the (deliberate, one-directional)
        # providers -> apis dependency visible at the point it's needed.
        from apis.media import save_media_bytes

        url = save_media_bytes(image_bytes, prefix="imagen")
        return url, image_bytes
