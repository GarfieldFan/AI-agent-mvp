"""Best-effort local resource coordination between the chat/vision LLM
and ComfyUI (2026-08-19).

Not a general memory manager — this exists because llama.cpp and ComfyUI
each already have real, working memory-release primitives, but nothing
called them at the moments that actually matter (before/after an image
generation). Verified directly against a real running setup before this
was built:

- llama-server's router mode (`--models-dir`) tracks per-model load
  state (`GET /v1/models`, each entry's `status.value`) and exposes a
  real explicit-unload route: `POST /models/unload {"model": "<name>"}`
  -> `{"success": true}`. Note this route is NOT under `/v1` — it's a
  bare `/models/unload` on the router's own base host:port.
- `--models-autoload` (llama-server's default) means the router lazily
  reloads a model on the next request that needs it — there is
  deliberately no "reload"/"wake" call here; give-back is free.
- ComfyUI exposes `GET /system_stats` (live `ram_free`/`vram_free` per
  device) and `POST /free {"unload_models": bool, "free_memory": bool}`
  to release its own loaded checkpoints on demand.

Every function here swallows its own failures — this is an optimization
(free up memory when it's actually tight, so an image generation doesn't
have to compete with an already-loaded 27B model), never allowed to be
the reason a generation fails. A caller-supplied endpoint that isn't
actually llama.cpp-router-shaped (vLLM, LM Studio, a single-model
llama-server, ...) just means `/models/unload` 404s and this quietly
does nothing.
"""

import httpx
from sqlalchemy.orm import Session

from models import AppSettings
from providers.base import normalize_loopback_host

# In-process counter of /api/chat turns currently being handled — a
# single uvicorn worker in one container (same single-process assumption
# rate_limit.py's in-memory limiter already documents), so a plain
# module-level int is enough; no cross-process coordination needed.
#
# Exists specifically so maybe_release_llm_memory never unloads the
# chat/vision model out from under a real visitor's in-flight turn — a
# public chat visitor whose next reply suddenly takes minutes (a cold
# reload, measured up to 159s for a 27B model) looks like a broken site
# and is a real cost to this project's actual purpose (capturing leads
# through the chatbot); an owner's poster generation running a little
# slower because it had to compete for memory is a much smaller cost.
# One turn can trigger up to 3 chat/vision router calls (attachment
# analysis, the main reply, lead-capture extraction — see apis/chat.py's
# docstring), so callers should hold this for the whole request handler,
# not just the single main-reply call.
_active_chat_requests = 0


def chat_request_started() -> None:
    global _active_chat_requests
    _active_chat_requests += 1


def chat_request_finished() -> None:
    global _active_chat_requests
    _active_chat_requests = max(0, _active_chat_requests - 1)


def has_active_chat_requests() -> bool:
    return _active_chat_requests > 0


async def _comfyui_free_memory_mb(comfyui_base_url: str) -> tuple[float | None, float | None]:
    """(ram_free_mb, vram_free_mb) from ComfyUI's own /system_stats —
    whichever of the two the local setup actually cares about (a
    CPU-only box has no `devices` entries at all, just RAM; a GPU box
    reports both). Returns (None, None) on any failure — the caller
    treats "unknown" as "don't bother unloading," not as "assume it's
    tight," since acting on a guess would cost a real reload later for
    no confirmed benefit."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{comfyui_base_url}/system_stats")
            resp.raise_for_status()
            data = resp.json()
        ram_free = data.get("system", {}).get("ram_free")
        vram_free = None
        devices = data.get("devices") or []
        if devices:
            # Multiple devices (rare for a local desktop setup) — take the
            # tightest one, since that's the one that would actually block
            # a generation.
            vram_free = min(d.get("vram_free", float("inf")) for d in devices)
        ram_free_mb = ram_free / (1024 * 1024) if ram_free is not None else None
        vram_free_mb = vram_free / (1024 * 1024) if vram_free not in (None, float("inf")) else None
        return ram_free_mb, vram_free_mb
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        return None, None


async def _unload_router_model(router_base_url: str, model: str) -> None:
    """router_base_url is the llama.cpp custom_base_url as stored
    (typically ending in /v1) — /models/unload lives one level up from
    that, not under /v1."""
    base = router_base_url.removesuffix("/v1").removesuffix("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(f"{base}/models/unload", json={"model": model})
    except httpx.HTTPError:
        pass  # best-effort — see module docstring


async def maybe_release_llm_memory(db: Session, comfyui_base_url: str) -> None:
    """Called right before a ComfyUI generation. No-op unless the owner
    has opted in (AppSettings.resource_coordination_enabled) and
    chat/vision is actually a custom llama.cpp-shaped endpoint (nothing
    to unload for Ollama/cloud providers — Ollama has its own separate
    lifecycle, cloud providers have no local footprint at all). Checks
    ComfyUI's own free-memory numbers first and only unloads if either
    RAM or VRAM is actually below the configured headroom — the whole
    point is to avoid paying a real reload delay (measured up to 159s
    for a 27B model, see AGENTS.md) when there was no memory pressure to
    relieve in the first place.

    Refuses outright while a real /api/chat visitor turn is in flight
    (has_active_chat_requests()) — protecting an actual public visitor's
    conversation takes priority over an owner's poster generation running
    a little slower. This doesn't cover a visitor's *next* message
    arriving just after an unload-and-reload cycle starts — narrowing
    that further needs real request queueing, out of scope for now (see
    AGENTS.md)."""
    if has_active_chat_requests():
        return
    row = db.get(AppSettings, 1)
    if not row or not row.resource_coordination_enabled:
        return
    if row.chat_provider != "custom" or not row.custom_base_url:
        return

    headroom_mb = row.resource_coordination_headroom_mb or 4096
    ram_free_mb, vram_free_mb = await _comfyui_free_memory_mb(comfyui_base_url)
    tight = (ram_free_mb is not None and ram_free_mb < headroom_mb) or (
        vram_free_mb is not None and vram_free_mb < headroom_mb
    )
    if not tight:
        return

    router_base = normalize_loopback_host(row.custom_base_url)
    models_to_unload = {row.chat_model}
    if row.vision_provider == "custom" and row.vision_model:
        models_to_unload.add(row.vision_model)
    for model in models_to_unload:
        if model:
            await _unload_router_model(router_base, model)


async def release_comfyui_memory(comfyui_base_url: str) -> None:
    """Called after a ComfyUI generation completes (success or failure —
    callers should use try/finally). Unlike maybe_release_llm_memory,
    always attempted with no threshold check: freeing ComfyUI's own
    memory right after it's done with a job has no reload-latency
    downside the way unloading the chat model does."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{comfyui_base_url}/free", json={"unload_models": True, "free_memory": True}
            )
    except httpx.HTTPError:
        pass  # best-effort — see module docstring
