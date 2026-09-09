"""Anthropic (Claude) provider — chat only. Anthropic does not offer an
embeddings API at all (they point people at third parties like Voyage AI
for that), so there's deliberately no `AnthropicEmbeddingProvider` here —
that's a structural gap in what this vendor offers, not something we
forgot to implement. `get_embedding_provider("anthropic")` in registry.py
raises accordingly rather than pretending this exists.
"""

import os

import httpx

from providers.base import ProviderNotConfigured, parse_data_uri

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"


def _to_anthropic_content(content: str | list[dict]) -> str | list[dict]:
    """Translates ChatProvider's generic OpenAI-shaped multi-part content
    (see providers/base.py's ChatProvider docstring) into Claude's own
    content-block shape. A plain string passes straight through — only a
    list needs translating: `{"type":"text","text":t}` already matches
    Claude's shape as-is; `{"type":"image_url","image_url":{"url":u}}`
    becomes `{"type":"image","source":{"type":"base64","media_type":...,
    "data":...}}`."""
    if isinstance(content, str):
        return content
    parts = []
    for part in content:
        if part.get("type") == "image_url":
            mime, data = parse_data_uri(part["image_url"]["url"])
            parts.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
        else:
            parts.append(part)
    return parts


class AnthropicChatProvider:
    name = "anthropic"

    def __init__(self, model: str | None = None, api_key: str | None = None):
        self.model = model or os.environ.get("ANTHROPIC_CHAT_MODEL", "claude-sonnet-5")
        # Falls back to the module-level env var when not given — see
        # providers/openai.py's docstring for the full reasoning (lets
        # apis/model_settings.py pass a DB-stored key instead).
        self.api_key = api_key or ANTHROPIC_API_KEY

    async def chat(
        self, messages: list[dict], *, system: str | None = None, json_mode: bool = False
    ) -> str:
        if not self.api_key:
            raise ProviderNotConfigured("Anthropic", "ANTHROPIC_API_KEY")

        # json_mode is a documented no-op here — Claude's Messages API has
        # no native forced-JSON mechanism (unlike OpenAI/Ollama/Gemini).
        # Every caller already runs the result through
        # llm_json.parse_lenient_json, so this doesn't change correctness.
        translated = [{**m, "content": _to_anthropic_content(m["content"])} for m in messages]

        # 600s — vision-to-page-JSON generation (routed through this same
        # method as of 2026-08-18) needs real headroom; see
        # providers/custom.py's comment for the real timing data this is
        # based on (a comparable local-model workload). A short chat
        # reply finishes long before this ceiling either way.
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{ANTHROPIC_BASE_URL}/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": ANTHROPIC_VERSION,
                },
                json={
                    # 8192 (was 1024) — vision-to-page-JSON generation
                    # needs far more than a short chat reply does, and
                    # Claude's API (unlike OpenAI/Ollama) requires
                    # max_tokens to be set at all.
                    "model": self.model,
                    "max_tokens": 8192,
                    "system": system or "",
                    "messages": translated,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        # Claude's response content is a list of blocks — join the text
        # ones back into a single string, same as before.
        return "".join(block.get("text", "") for block in data.get("content", []))
