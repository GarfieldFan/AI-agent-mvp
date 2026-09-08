"""Custom OpenAI-compatible chat provider — for a self-hosted backend this
codebase has no dedicated provider for (llama.cpp's `llama-server`, vLLM,
LM Studio, text-generation-webui, ...). Unlike the other providers, there's
no fixed model/URL: an admin fills in `base_url` (+ optional `api_key`)
via the owner-facing model picker (apis/model_settings.py), tests it, and
picks a model from what that server reports — see AppSettings.custom_base_url
/ custom_api_key. Same OpenAI-compatible surface providers/ollama.py already
talks to Ollama with (/chat/completions, /models), just against a
caller-supplied URL instead of an env-var default.
"""

import httpx

from providers.base import normalize_loopback_host


class CustomChatProvider:
    name = "custom"

    def __init__(self, base_url: str, model: str, api_key: str | None = None):
        self.base_url = normalize_loopback_host(base_url)
        self.model = model
        self.api_key = api_key

    async def chat(
        self, messages: list[dict], *, system: str | None = None, json_mode: bool = False
    ) -> str:
        full_messages = ([{"role": "system", "content": system}] if system else []) + messages
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        payload = {"model": self.model, "messages": full_messages, "stream": False}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        # 600s (was 120s) — vision-to-page-JSON generation (routed through
        # this same method as of 2026-08-18) needs real headroom. Verified
        # for real this session: a large local model (27B, 65536 ctx) via
        # a custom llama.cpp endpoint took 159s for a *one-word* reply
        # cold, and a full vision+JSON generation still exceeded 240s warm
        # — a plain short chat reply finishes long before this ceiling
        # either way, so a generous cap costs nothing for the fast case.
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"]


class CustomEmbeddingProvider:
    name = "custom"

    def __init__(self, base_url: str, model: str, api_key: str | None = None):
        self.base_url = normalize_loopback_host(base_url)
        self.model = model
        self.api_key = api_key
        # Unlike the other EmbeddingProviders, there's no way to know this
        # ahead of time — a custom endpoint's model could be anything.
        # apis/model_settings.py's resolve_embedding_provider callers set
        # AppSettings.embedding_dimensions from the actual first embed()
        # result instead of trusting this attribute.
        self.dimensions = 0

    async def embed(self, texts: list[str]) -> list[list[float]]:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.base_url}/embeddings",
                headers=headers,
                json={"model": self.model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()
        by_index = sorted(data["data"], key=lambda item: item["index"])
        vectors = [item["embedding"] for item in by_index]
        if vectors:
            self.dimensions = len(vectors[0])
        return vectors


async def list_custom_models(base_url: str, api_key: str | None) -> list[tuple[str, bool]]:
    """Live GET /models against a caller-supplied OpenAI-compatible
    endpoint. Raises httpx.HTTPError on failure — callers decide how to
    surface that (a hard error from the test-connection route, a silent
    [] fallback when just enriching the settings list).

    Returns `(id, vision)` pairs, not bare ids — llama.cpp's router mode
    reports `architecture.input_modalities` per model in the OpenAI-shaped
    `data` array (confirmed via a real request this session: a
    vision-capable entry reports `["text","image"]`, a text-only one just
    `["text"]`), which is real capability metadata, not a guess — same
    spirit as apis/model_settings.py's Ollama listing using `ollama
    show`'s `capabilities` instead of assuming.

    **Second signal, added 2026-09-08 — a real false negative the user
    hit**: some `llama-server` builds respond to `GET /models` with BOTH
    an OpenAI-shaped `data` array (checked above) AND an Ollama-shaped
    `models` array in the SAME response — confirmed live against the
    user's own server, whose `data` entries carried no `architecture`
    field at all (so the check above alone always fell through to
    `False`), while its `models` array reported `"capabilities":
    ["completion", "multimodal"]` for the exact same model. Matched by
    id/name (the two arrays describe the same models under the same
    string) — a model counts as vision-capable if EITHER signal says so,
    never downgraded by the other being silent. `vision` only defaults to
    `False` when NEITHER signal is present at all (vLLM/LM Studio might
    report neither) — still conservative, matching this project's posture
    everywhere else a capability can't be positively confirmed."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{normalize_loopback_host(base_url)}/models", headers=headers)
        resp.raise_for_status()
        data = resp.json()
    multimodal_ids = {
        m["model"]
        for m in data.get("models", [])
        if isinstance(m, dict) and "multimodal" in (m.get("capabilities") or [])
    }
    return [
        (
            m["id"],
            "image" in m.get("architecture", {}).get("input_modalities", []) or m["id"] in multimodal_ids,
        )
        for m in data.get("data", [])
    ]
