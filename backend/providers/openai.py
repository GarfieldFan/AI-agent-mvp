"""OpenAI provider. Real API calls (no SDK dependency, just httpx against
OpenAI's REST API) gated on OPENAI_API_KEY being set — raises
ProviderNotConfigured before attempting a call if it isn't, rather than
failing with a confusing 401 from OpenAI itself.
"""

import base64
import os

import httpx

from providers.base import ProviderNotConfigured

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_BASE_URL = "https://api.openai.com/v1"


class OpenAIChatProvider:
    name = "openai"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("OPENAI_CHAT_MODEL", "gpt-4o-mini")

    async def chat(
        self, messages: list[dict], *, system: str | None = None, json_mode: bool = False
    ) -> str:
        if not OPENAI_API_KEY:
            raise ProviderNotConfigured("OpenAI", "OPENAI_API_KEY")

        full_messages = ([{"role": "system", "content": system}] if system else []) + messages
        payload = {"model": self.model, "messages": full_messages}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        # 600s (was 60s) — a short chat reply finishes long before that
        # ceiling either way, but vision-to-page-JSON generation (routed
        # through this same method as of 2026-08-18) genuinely needs real
        # headroom — see providers/custom.py's comment for the real
        # timing data this bump is based on.
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{OPENAI_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json=payload,
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


class OpenAIImageProvider:
    name = "openai"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("OPENAI_IMAGE_MODEL", "dall-e-3")

    async def generate(self, prompt: str) -> tuple[str, bytes]:
        if not OPENAI_API_KEY:
            raise ProviderNotConfigured("OpenAI", "OPENAI_API_KEY")

        # b64_json (not the default "url") — OpenAI's own hosted URLs are
        # short-lived, and this app persists generated images long-term
        # (posters get reused, referenced from CRM entries, etc.). See
        # providers/base.py's ImageProvider docstring.
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OPENAI_BASE_URL}/images/generations",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={"model": self.model, "prompt": prompt, "n": 1, "size": "1024x1024", "response_format": "b64_json"},
            )
            resp.raise_for_status()
            data = resp.json()
        image_bytes = base64.b64decode(data["data"][0]["b64_json"])

        # Imported here, not at module level — apis/media.py imports from
        # apis/api.py, and this keeps the import graph's actual direction
        # (apis -> providers is the norm; this one file inverts it, same
        # as providers/comfyui.py already does for the same reason: reuse
        # existing, working storage/URL logic instead of duplicating it)
        # visible at the point it's actually needed.
        from apis.media import save_media_bytes

        url = save_media_bytes(image_bytes, prefix="dalle")
        return url, image_bytes
