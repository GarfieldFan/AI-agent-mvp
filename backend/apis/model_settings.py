"""Owner-facing AI model selection.

Lets an admin/owner see which chat and vision-capable models are actually
available right now (Ollama models are queried live; cloud providers show
their configured default) and pick one. The choice is persisted globally
in `AppSettings` (a singleton row) so it applies to every visitor's
`POST /api/chat` and every `generate_landing_page` call from then on —
survives a restart, not just a per-admin-session override.

Chat model selection is fully real across every configured provider: it
goes through the same `ChatProvider` registry `apis/chat.py` already uses
(`resolve_chat_provider` below just adds a settings-row lookup on top of
`providers.registry.get_chat_provider`), so picking an OpenAI/Anthropic/
Gemini model here works the moment that provider's API key is set — no
code change needed, same principle as the provider abstraction generally
(see the root AGENTS.md).

Vision model selection (2026-08-18) goes through the same `ChatProvider`
abstraction as chat — `generate_landing_page` (apis/agent.py) and
chat_attachments.py's automatic image analysis both call
`resolve_vision_provider(db).chat(messages, ...)` with an image content
part, same as any other chat call. Every provider that can do vision at
all (Ollama live-queried via `ollama show`'s `capabilities`, custom
live-queried via a `/models` response's `architecture.input_modalities`,
cloud providers assumed vision-capable on their default flagship models)
is selectable here — see providers/base.py's `ChatProvider` docstring for
the generic image-content-part shape every provider now understands.

Embedding model selection persists the same way, but switching it has a
real consequence chat/vision don't: `document_chunks.embedding` is a
single dimension-less pgvector column that can only ever hold one
provider's vectors consistently at a time (see models.py's
`DocumentChunk.embedding` comment). `update_settings` below clears that
table the instant the embedding provider/model actually changes — RAG
retrieval degrades to plain chat until an admin runs
`POST /agent/documents/reembed-all` (apis/documents.py). Embedding's
"custom" provider also gets its OWN endpoint config
(`embedding_base_url`/`embedding_api_key`), separate from chat/vision's
shared `custom_base_url`/`custom_api_key` (2026-08-18) — real local
llama.cpp setups run embedding as its own process (embedding mode is a
process-level flag, incompatible with serving a chat model from the same
router instance), so forcing all three onto one endpoint broke that case.

Image generation (2026-08-18) is a fourth, independent picker, but
shaped differently: there's no per-provider **model** list the way
chat/vision/embedding have (ComfyUI has one fixed workflow, each cloud
vendor has exactly one sensible default image model this round) — it's a
plain 3-way provider choice (comfyui/openai/gemini). "Custom" for image
generation specifically means "a different ComfyUI instance" (its own
`image_comfyui_url`, normalized the same `host.docker.internal` way as
the chat/embedding custom endpoint) — ComfyUI has no OpenAI-compatible-
style universal API the way LLM backends do, so unlike `custom_base_url`
this isn't a stand-in for "any" self-hosted image backend.
"""

import json
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.orm import Session

from apis.api import COMFYUI_URL, list_comfyui_loader_options
from apis.deps import CurrentUser, Role, get_current_user, require_role
from db import get_db
from models import AppSettings, DocumentChunk
from providers.anthropic import ANTHROPIC_API_KEY, AnthropicChatProvider
from providers.base import ProviderNotConfigured, normalize_loopback_host
from providers.comfyui import ComfyUIImageProvider
from providers.custom import CustomChatProvider, CustomEmbeddingProvider, list_custom_models
from providers.gemini import GEMINI_API_KEY, GeminiChatProvider, GeminiEmbeddingProvider, GeminiImageProvider
from providers.ollama import OLLAMA_BASE_URL
from providers.openai import OPENAI_API_KEY, OpenAIChatProvider, OpenAIEmbeddingProvider, OpenAIImageProvider
from providers.registry import (
    DEFAULT_CHAT_PROVIDER,
    DEFAULT_EMBEDDING_PROVIDER,
    default_chat_model,
    default_embedding_model,
    get_chat_provider,
    get_embedding_provider,
)

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])

# Ollama's *native* API (tags/show, for listing models + capabilities) is
# unversioned — OLLAMA_BASE_URL already carries the OpenAI-compat "/v1"
# suffix everything else in this codebase uses, so strip it back off here.
_OLLAMA_NATIVE_BASE = OLLAMA_BASE_URL.removesuffix("/v1")

# The vision model generate_landing_page falls back to when nothing's been
# explicitly chosen — same default apis/agent.py used before this module
# existed (qwen3.6:latest has vision; gemma4:latest's vision status is
# unclear from one Ollama API to another, see the root AGENTS.md gotcha —
# don't assume either way without checking the live /models list).
DEFAULT_VISION_MODEL = os.environ.get("OLLAMA_VISION_MODEL", "qwen3.6:latest")

# One row per cloud provider: (provider key, a callable returning its
# configured default chat model). Callables, not plain values, so the
# model name stays correct if an env var default changes after the
# process started. "configured" is no longer a fixed callable here
# (2026-09-09) — see `_cloud_api_key` below, which checks the DB first.
_CLOUD_PROVIDERS = [
    ("openai", lambda: OpenAIChatProvider().model),
    ("anthropic", lambda: AnthropicChatProvider().model),
    ("gemini", lambda: GeminiChatProvider().model),
]

# Same shape as _CLOUD_PROVIDERS, but no "anthropic" row — Anthropic has
# no embeddings API at all (see providers/anthropic.py's docstring), a
# vendor gap, not something missing here.
_CLOUD_EMBEDDING_PROVIDERS = [
    ("openai", lambda: OpenAIEmbeddingProvider().model),
    ("gemini", lambda: GeminiEmbeddingProvider().model),
]

# Same shape again — no "anthropic" row, Anthropic has no image-gen API
# either (chat-only vendor, same gap as embeddings).
_CLOUD_IMAGE_PROVIDERS = [
    ("openai", lambda: OpenAIImageProvider().model),
    ("gemini", lambda: GeminiImageProvider().model),
]


def _cloud_api_key(db: Session, provider: str) -> str | None:
    """The key that will actually be used for `provider` right now — a
    DB-stored key (`AppSettings.openai_api_key`/etc., set via the
    dashboard/setup wizard) takes priority over the env-var default,
    same "DB overrides env" precedence every provider class itself now
    implements (see providers/openai.py's docstring). Centralized here
    so every "is this cloud provider configured" check (the model list,
    `resolve_*_provider`, `update_settings`'s validation) agrees."""
    row = db.get(AppSettings, 1)
    db_key = {
        "openai": row.openai_api_key if row else None,
        "anthropic": row.anthropic_api_key if row else None,
        "gemini": row.gemini_api_key if row else None,
    }.get(provider)
    env_key = {"openai": OPENAI_API_KEY, "anthropic": ANTHROPIC_API_KEY, "gemini": GEMINI_API_KEY}.get(provider)
    return db_key or env_key


# One class per (provider, capability) — used by resolve_chat_provider/
# resolve_vision_provider (chat-shaped) and resolve_embedding_provider/
# resolve_image_provider (their own dicts, since not every vendor offers
# every capability — see the _CLOUD_*_PROVIDERS lists above).
_CLOUD_CHAT_CLASSES = {"openai": OpenAIChatProvider, "anthropic": AnthropicChatProvider, "gemini": GeminiChatProvider}
_CLOUD_EMBEDDING_CLASSES = {"openai": OpenAIEmbeddingProvider, "gemini": GeminiEmbeddingProvider}


class ModelOption(BaseModel):
    provider: str
    model: str
    vision: bool
    configured: bool
    selectable: bool
    note: str | None = None


class ComfyUIAssetOptions(BaseModel):
    """Live-queried file lists for the fixed z_image_turbo-shaped workflow's
    3 loader widgets (see providers/comfyui.py's docstring) — empty lists
    when ComfyUI is unreachable or the currently-configured address hasn't
    changed since import (see _list_comfyui_assets)."""

    unets: list[str] = []
    clips: list[str] = []
    vaes: list[str] = []


class ModelListResponse(BaseModel):
    chat_models: list[ModelOption]
    vision_models: list[ModelOption]
    embedding_models: list[ModelOption]
    # Not a provider+model list like the other three — one ModelOption per
    # *provider* (comfyui/openai/gemini), `model` holding a fixed,
    # non-editable label (see _list_image_providers) since there's no
    # per-provider model choice to make this round.
    image_providers: list[ModelOption]
    # Only meaningful when image_provider == "comfyui" — the actual files
    # ComfyUI currently reports for unet/clip/vae, so the picker offers
    # real choices instead of free text.
    image_comfyui_assets: ComfyUIAssetOptions = ComfyUIAssetOptions()


class ModelSettings(BaseModel):
    chat_provider: str
    chat_model: str
    vision_provider: str
    vision_model: str
    embedding_provider: str
    embedding_model: str
    # Informational only — the *actual* length of the last successfully
    # computed vector (see models.py's AppSettings.embedding_dimensions
    # comment), not settable by the client.
    embedding_dimensions: int | None = None
    # Only meaningful when chat_provider == "custom" or vision_provider ==
    # "custom" — those two share one endpoint config (2026-08-18: embedding
    # has its own separate endpoint below, not this one — a real setup
    # this was built against runs chat/vision and embedding as two
    # different llama.cpp processes, since embedding-mode is a per-process
    # flag that can't coexist with a chat model in the same router
    # instance). custom_base_url is echoed back on GET so the frontend can
    # prefill it; custom_api_key is write-only — never echoed back once
    # saved (see get_settings).
    custom_base_url: str | None = None
    custom_api_key: str | None = None
    # Only meaningful when embedding_provider == "custom" — deliberately
    # separate from custom_base_url/custom_api_key above (see the comment
    # there). Same echo-back rules: base_url returned, api_key write-only.
    embedding_base_url: str | None = None
    embedding_api_key: str | None = None
    # Cloud provider API keys (2026-09-09) — write-only, never echoed
    # back once saved (same posture as custom_api_key above); the
    # matching `*_set` booleans (GET-only, informational — same pattern
    # as apis/payments.py's stripe_secret_key_set) tell the frontend
    # whether a DB-saved key already exists, so it can show a "Saved"
    # placeholder without ever seeing the actual value. See
    # providers/openai.py's docstring for how these flow into the
    # actual provider classes.
    openai_api_key: str | None = None
    openai_api_key_set: bool = False
    anthropic_api_key: str | None = None
    anthropic_api_key_set: bool = False
    gemini_api_key: str | None = None
    gemini_api_key_set: bool = False
    image_provider: str
    # Only meaningful when image_provider == "comfyui" — a *separate*
    # endpoint config from custom_base_url above, since ComfyUI speaks a
    # completely different (non-OpenAI-compatible) API than the chat/
    # embedding custom endpoint. None means "use the env-var-configured
    # instance."
    image_comfyui_url: str | None = None
    # Checkpoint choice within ComfyUI itself — only meaningful when
    # image_provider == "comfyui". None means "use the fixed workflow's
    # own default file" for that slot (see providers/comfyui.py).
    image_comfyui_unet: str | None = None
    image_comfyui_clip: str | None = None
    image_comfyui_vae: str | None = None
    # An owner-pasted ComfyUI "Save (API Format)" workflow — when set,
    # REPLACES the fixed workflow + unet/clip/vae fields above entirely
    # (see providers/comfyui.py's docstring). prompt_node/prompt_field say
    # which node/input the generation prompt gets spliced into;
    # prompt_field defaults to "text" (a typical CLIPTextEncode) when left
    # blank.
    image_comfyui_workflow: str | None = None
    image_comfyui_prompt_node: str | None = None
    image_comfyui_prompt_field: str | None = None
    # Local resource coordination (2026-08-19, see resource_broker.py) —
    # only meaningful alongside image_provider == "comfyui" and a custom
    # llama.cpp-shaped chat/vision endpoint; a no-op otherwise. Off by
    # default (see AppSettings.resource_coordination_enabled).
    resource_coordination_enabled: bool = False
    resource_coordination_headroom_mb: int = 4096


class CustomProviderTestRequest(BaseModel):
    base_url: str
    api_key: str | None = None


class CustomProviderTestResponse(BaseModel):
    ok: bool
    models: list[str] = []
    # Subset of `models` the endpoint reports as vision-capable (via
    # `architecture.input_modalities` — see providers/custom.py's
    # list_custom_models) — the frontend uses this to decide which tested
    # models feed the vision dropdown, not just chat/embedding.
    vision_model_ids: list[str] = []
    error: str | None = None


async def _query_ollama_models() -> list[tuple[str, list[str]]]:
    """Live (name, capabilities) pairs from Ollama's native API — real
    installed models and their real capabilities, not a hardcoded guess
    (see the root AGENTS.md's gotcha about a stale hardcoded
    vision-capability claim this replaces). Returns [] if Ollama is
    unreachable rather than failing the whole endpoint — a model list is
    a nice-to-have for the dashboard, not something that should break it.
    Shared by the chat and embedding listers below so a single dashboard
    load only round-trips to Ollama once, not twice."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            tags_resp = await client.get(f"{_OLLAMA_NATIVE_BASE}/api/tags")
            tags_resp.raise_for_status()
            names = [m["name"] for m in tags_resp.json().get("models", [])]

            results: list[tuple[str, list[str]]] = []
            for name in names:
                show_resp = await client.post(f"{_OLLAMA_NATIVE_BASE}/api/show", json={"model": name})
                show_resp.raise_for_status()
                results.append((name, show_resp.json().get("capabilities", [])))
            return results
    except httpx.HTTPError:
        return []


def _ollama_chat_options(raw: list[tuple[str, list[str]]]) -> list[ModelOption]:
    return [
        ModelOption(provider="ollama", model=name, vision="vision" in caps, configured=True, selectable=True)
        for name, caps in raw
        if "completion" in caps  # embedding-only models (e.g. nomic-embed-text) aren't chat-usable
    ]


def _ollama_embedding_options(raw: list[tuple[str, list[str]]]) -> list[ModelOption]:
    return [
        ModelOption(provider="ollama", model=name, vision=False, configured=True, selectable=True)
        for name, caps in raw
        if "embedding" in caps  # chat-only models don't report this capability
    ]


def _cloud_note(provider: str, configured: bool) -> str | None:
    if configured:
        return None
    return f"Set an API key for {provider} (dashboard Model settings, or {provider.upper()}_API_KEY) to enable this provider."


def _list_cloud_chat_models(db: Session) -> list[ModelOption]:
    options = []
    for provider, get_model in _CLOUD_PROVIDERS:
        configured = bool(_cloud_api_key(db, provider))
        options.append(
            ModelOption(
                provider=provider,
                model=get_model(),
                vision=False,
                configured=configured,
                selectable=configured,
                note=_cloud_note(provider, configured),
            )
        )
    return options


def _list_cloud_embedding_models(db: Session) -> list[ModelOption]:
    options = []
    for provider, get_model in _CLOUD_EMBEDDING_PROVIDERS:
        configured = bool(_cloud_api_key(db, provider))
        options.append(
            ModelOption(
                provider=provider,
                model=get_model(),
                vision=False,
                configured=configured,
                selectable=configured,
                note=_cloud_note(provider, configured),
            )
        )
    return options


async def _list_custom_models_safe(base_url: str, api_key: str | None) -> list[ModelOption]:
    """Live-query a caller-configured custom endpoint the same way
    _list_ollama_models queries Ollama — returns [] on any failure rather
    than breaking the whole model list (this is enrichment, not the
    source of truth for whether the endpoint currently works)."""
    try:
        results = await list_custom_models(base_url, api_key)
    except httpx.HTTPError:
        return []
    return [
        ModelOption(provider="custom", model=model_id, vision=vision, configured=True, selectable=True)
        for model_id, vision in results
    ]


def _list_cloud_vision_models(db: Session) -> list[ModelOption]:
    """Same providers/models as _list_cloud_chat_models — every cloud
    provider's default flagship model (gpt-4o-mini, claude-sonnet-5,
    gemini-2.5-flash) is vision-capable, so there's no separate "does
    this model support vision" check to make here the way Ollama/custom
    need one. selectable-if-configured, same as the chat list — no longer
    a permanent placeholder (providers/anthropic.py and providers/gemini.py
    both translate image content parts into their own wire format now)."""
    options = []
    for provider, get_model in _CLOUD_PROVIDERS:
        configured = bool(_cloud_api_key(db, provider))
        options.append(
            ModelOption(
                provider=provider,
                model=get_model(),
                vision=True,
                configured=configured,
                selectable=configured,
                note=_cloud_note(provider, configured),
            )
        )
    return options


def _resolve_comfyui_url(db: Session) -> str:
    row = db.get(AppSettings, 1)
    return normalize_loopback_host((row.image_comfyui_url if row else None) or COMFYUI_URL)


async def _list_comfyui_assets(comfyui_url: str) -> ComfyUIAssetOptions:
    """Live unet/clip/vae file lists for the picker (see
    ComfyUIAssetOptions) — each underlying /object_info call already
    tolerates unreachability on its own (list_comfyui_loader_options
    returns [] rather than raising), so this needs no separate
    reachability check first."""
    return ComfyUIAssetOptions(
        unets=await list_comfyui_loader_options(comfyui_url, "UNETLoader", "unet_name"),
        clips=await list_comfyui_loader_options(comfyui_url, "CLIPLoader", "clip_name"),
        vaes=await list_comfyui_loader_options(comfyui_url, "VAELoader", "vae_name"),
    )


async def _list_image_providers(db: Session) -> list[ModelOption]:
    """One ModelOption per *provider*, not per model (see
    ModelListResponse's docstring) — comfyui's `model` is a fixed label
    describing the one workflow this app ships, not something the admin
    picks. comfyui's `selectable` reflects a live reachability check
    (same /system_stats probe apis/agent.py's get_integrations already
    uses) against whatever address is *currently* configured — a stale
    or unreachable ComfyUI shouldn't look pickable."""
    comfyui_url = _resolve_comfyui_url(db)
    comfyui_reachable = False
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{comfyui_url}/system_stats")
            resp.raise_for_status()
        comfyui_reachable = True
    except httpx.HTTPError:
        pass

    options = [
        ModelOption(
            provider="comfyui",
            model="z_image_turbo (fixed workflow)",
            vision=False,
            configured=comfyui_reachable,
            selectable=comfyui_reachable,
            note=None if comfyui_reachable else f"ComfyUI unreachable at {comfyui_url}.",
        )
    ]
    for provider, get_model in _CLOUD_IMAGE_PROVIDERS:
        configured = bool(_cloud_api_key(db, provider))
        options.append(
            ModelOption(
                provider=provider,
                model=get_model(),
                vision=False,
                configured=configured,
                selectable=configured,
                note=_cloud_note(provider, configured),
            )
        )
    return options


def _current_settings(db: Session) -> ModelSettings:
    row = db.get(AppSettings, 1)
    chat_provider = (row.chat_provider if row else None) or DEFAULT_CHAT_PROVIDER
    chat_model = (row.chat_model if row else None) or default_chat_model(
        row.chat_provider if row and row.chat_provider else None
    )
    vision_provider = (row.vision_provider if row else None) or "ollama"
    vision_model = (row.vision_model if row else None) or DEFAULT_VISION_MODEL
    embedding_provider = (row.embedding_provider if row else None) or DEFAULT_EMBEDDING_PROVIDER
    # Same invariant as chat_model above: update_settings() always sets
    # embedding_model together with embedding_provider == "custom", so
    # default_embedding_model (which has no "custom" entry) never
    # actually gets reached for that case.
    embedding_model = (row.embedding_model if row else None) or default_embedding_model(
        row.embedding_provider if row and row.embedding_provider else None
    )
    image_provider = (row.image_provider if row else None) or "comfyui"
    return ModelSettings(
        chat_provider=chat_provider,
        chat_model=chat_model,
        vision_provider=vision_provider,
        vision_model=vision_model,
        embedding_provider=embedding_provider,
        embedding_model=embedding_model,
        embedding_dimensions=row.embedding_dimensions if row else None,
        custom_base_url=row.custom_base_url if row else None,
        # custom_api_key deliberately omitted — never echoed back once saved.
        embedding_base_url=row.embedding_base_url if row else None,
        # embedding_api_key deliberately omitted — never echoed back once saved.
        openai_api_key_set=bool(row and row.openai_api_key),
        anthropic_api_key_set=bool(row and row.anthropic_api_key),
        gemini_api_key_set=bool(row and row.gemini_api_key),
        image_provider=image_provider,
        image_comfyui_url=row.image_comfyui_url if row else None,
        image_comfyui_unet=row.image_comfyui_unet if row else None,
        image_comfyui_clip=row.image_comfyui_clip if row else None,
        image_comfyui_vae=row.image_comfyui_vae if row else None,
        image_comfyui_workflow=row.image_comfyui_workflow if row else None,
        image_comfyui_prompt_node=row.image_comfyui_prompt_node if row else None,
        image_comfyui_prompt_field=row.image_comfyui_prompt_field if row else None,
        resource_coordination_enabled=row.resource_coordination_enabled if row else False,
        resource_coordination_headroom_mb=row.resource_coordination_headroom_mb if row else 4096,
    )


def resolve_chat_provider(db: Session):
    """Live `ChatProvider` honoring the owner's global selection, falling
    back to the registry's env-var default when nothing's been chosen
    yet. Used by apis/chat.py instead of calling
    `providers.registry.get_chat_provider()` directly."""
    row = db.get(AppSettings, 1)
    provider = row.chat_provider if row else None
    model = row.chat_model if row else None
    if provider == "custom":
        if not row or not row.custom_base_url:
            raise ProviderNotConfigured("Custom", "custom_base_url")
        return CustomChatProvider(base_url=row.custom_base_url, model=model, api_key=row.custom_api_key)
    if provider in _CLOUD_CHAT_CLASSES:
        return _CLOUD_CHAT_CLASSES[provider](model=model, api_key=_cloud_api_key(db, provider))
    return get_chat_provider(provider, model)


def resolve_embedding_provider(db: Session):
    """Live `EmbeddingProvider` honoring the owner's global selection,
    falling back to the registry's env-var default when nothing's been
    chosen yet. Used by apis/documents.py (ingest, reembed-all) and
    apis/chat.py (retrieval) instead of calling
    `providers.registry.get_embedding_provider()` directly.

    Uses `embedding_base_url`/`embedding_api_key`, NOT
    `custom_base_url`/`custom_api_key` — embedding gets its own endpoint,
    separate from chat/vision's shared one (see AppSettings.
    embedding_base_url's comment)."""
    row = db.get(AppSettings, 1)
    provider = row.embedding_provider if row else None
    model = row.embedding_model if row else None
    if provider == "custom":
        if not row or not row.embedding_base_url:
            raise ProviderNotConfigured("Custom", "embedding_base_url")
        return CustomEmbeddingProvider(base_url=row.embedding_base_url, model=model, api_key=row.embedding_api_key)
    if provider in _CLOUD_EMBEDDING_CLASSES:
        return _CLOUD_EMBEDDING_CLASSES[provider](model=model, api_key=_cloud_api_key(db, provider))
    return get_embedding_provider(provider, model)


def resolve_vision_provider(db: Session):
    """Live `ChatProvider` for vision generation — mirrors
    resolve_chat_provider exactly (same custom special-case), just reads
    vision_provider/vision_model and defaults to "ollama"/
    DEFAULT_VISION_MODEL instead. Used by apis/agent.py's
    generate_landing_page and chat_attachments.py's image analysis;
    callers build an image content part into `messages` themselves — see
    providers/base.py's ChatProvider docstring for the shape."""
    row = db.get(AppSettings, 1)
    provider = (row.vision_provider if row else None) or "ollama"
    model = (row.vision_model if row else None) or DEFAULT_VISION_MODEL
    if provider == "custom":
        if not row or not row.custom_base_url:
            raise ProviderNotConfigured("Custom", "custom_base_url")
        return CustomChatProvider(base_url=row.custom_base_url, model=model, api_key=row.custom_api_key)
    if provider in _CLOUD_CHAT_CLASSES:
        return _CLOUD_CHAT_CLASSES[provider](model=model, api_key=_cloud_api_key(db, provider))
    return get_chat_provider(provider, model)


def resolve_image_provider(db: Session):
    """Live `ImageProvider` honoring the owner's global selection.
    Defaults to `"comfyui"` (this project's original always-ComfyUI
    behavior when nothing's been explicitly chosen) — no "custom" special
    case the way chat/vision/embedding have, since comfyui *is* the
    self-hosted option here, not a separate branch. Used by
    apis/agent.py's generate_poster."""
    row = db.get(AppSettings, 1)
    provider = (row.image_provider if row else None) or "comfyui"
    if provider == "openai":
        return OpenAIImageProvider(api_key=_cloud_api_key(db, "openai"))
    if provider == "gemini":
        return GeminiImageProvider(api_key=_cloud_api_key(db, "gemini"))
    comfyui_url = row.image_comfyui_url if row else None
    checkpoint_kwargs = {
        "unet_name": row.image_comfyui_unet if row else None,
        "clip_name": row.image_comfyui_clip if row else None,
        "vae_name": row.image_comfyui_vae if row else None,
        # Parsed once here rather than stored pre-parsed — the raw JSON
        # string is the source of truth (what update_settings validated
        # and what the picker echoes back), this is just a read-time
        # convenience. update_settings already guarantees this parses and
        # has the configured prompt_node/inputs shape, so no error
        # handling needed here beyond what generate() already has as a
        # defense-in-depth fallback.
        "custom_workflow": json.loads(row.image_comfyui_workflow) if row and row.image_comfyui_workflow else None,
        "prompt_node": row.image_comfyui_prompt_node if row else None,
        "prompt_field": row.image_comfyui_prompt_field if row else None,
    }
    if comfyui_url:
        # public_url stays exactly as typed (the browser needs to reach
        # it from the user's own machine); base_url gets the same
        # host.docker.internal normalization the chat custom endpoint
        # uses, for the backend's own server-side requests.
        return ComfyUIImageProvider(
            base_url=normalize_loopback_host(comfyui_url), public_url=comfyui_url.rstrip("/"), **checkpoint_kwargs
        )
    return ComfyUIImageProvider(**checkpoint_kwargs)  # env-var address default


_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "[::1]"}


def _with_docker_loopback_hint(base_url: str, error: str) -> str:
    """The single most common way this fails: the admin types
    localhost/127.0.0.1 (correct from their own browser's point of view),
    but the request is actually made by the `backend` container, where
    that address means the container itself, not the host machine
    running llama.cpp/etc. — the exact mistake that bit this session.
    Real fix (providers/ollama.py already does this) is
    `host.docker.internal`; append a pointer to it rather than leaving an
    admin to guess why an address that "should work" doesn't."""
    try:
        host = httpx.URL(base_url).host
    except Exception:
        return error
    if host in _LOOPBACK_HOSTS:
        return (
            f"{error} — this backend runs inside Docker, so \"{host}\" points at the "
            f"container itself, not your machine. Try \"host.docker.internal\" instead."
        )
    return error


@router.post("/models/test-custom", response_model=CustomProviderTestResponse)
async def test_custom_provider(req: CustomProviderTestRequest) -> CustomProviderTestResponse:
    try:
        results = await list_custom_models(req.base_url, req.api_key)
    except httpx.HTTPError as exc:
        return CustomProviderTestResponse(ok=False, error=_with_docker_loopback_hint(req.base_url, str(exc)))
    return CustomProviderTestResponse(
        ok=True,
        models=[model_id for model_id, _ in results],
        vision_model_ids=[model_id for model_id, vision in results if vision],
    )


@router.get("/models", response_model=ModelListResponse)
async def list_models(db: Session = Depends(get_db)) -> ModelListResponse:
    raw_ollama = await _query_ollama_models()
    ollama_chat = _ollama_chat_options(raw_ollama)
    ollama_embedding = _ollama_embedding_options(raw_ollama)
    row = db.get(AppSettings, 1)
    custom_models = (
        await _list_custom_models_safe(row.custom_base_url, row.custom_api_key)
        if row and row.custom_base_url
        else []
    )
    # Embedding's custom endpoint is separate from chat/vision's (see
    # AppSettings.embedding_base_url's comment) — probed independently so
    # e.g. a dedicated embedding-only llama.cpp process on a different
    # port shows its own model list here, not chat/vision's.
    embedding_custom_models = (
        await _list_custom_models_safe(row.embedding_base_url, row.embedding_api_key)
        if row and row.embedding_base_url
        else []
    )
    return ModelListResponse(
        chat_models=ollama_chat + custom_models + _list_cloud_chat_models(db),
        vision_models=[m for m in ollama_chat if m.vision]
        + [m for m in custom_models if m.vision]
        + _list_cloud_vision_models(db),
        embedding_models=ollama_embedding + embedding_custom_models + _list_cloud_embedding_models(db),
        image_providers=await _list_image_providers(db),
        image_comfyui_assets=await _list_comfyui_assets(_resolve_comfyui_url(db)),
    )


@router.get("/settings", response_model=ModelSettings)
def get_settings(db: Session = Depends(get_db)) -> ModelSettings:
    return _current_settings(db)


@router.put("/settings", response_model=ModelSettings)
async def update_settings(
    req: ModelSettings,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(get_current_user),
) -> ModelSettings:
    row = db.get(AppSettings, 1)

    # Effective *previous* value for each capability (same env-var-fallback
    # logic _current_settings uses) — computed up front so validation below
    # can skip re-checking a capability the client isn't actually touching.
    # Without this, saving *any* change (e.g. picking a custom chat model)
    # while Ollama happens to be unreachable would fail on vision/chat/
    # embedding's still-default "ollama" picks purely because they can't be
    # freshly re-verified right now — a real thing that happened this
    # session once the chat provider moved off Ollama entirely.
    prev_chat_provider = (row.chat_provider if row else None) or DEFAULT_CHAT_PROVIDER
    prev_chat_model = (row.chat_model if row else None) or default_chat_model(
        row.chat_provider if row and row.chat_provider else None
    )
    prev_vision_provider = (row.vision_provider if row else None) or "ollama"
    prev_vision_model = (row.vision_model if row else None) or DEFAULT_VISION_MODEL
    prev_embedding_provider = (row.embedding_provider if row else None) or DEFAULT_EMBEDDING_PROVIDER
    prev_embedding_model = (row.embedding_model if row else None) or default_embedding_model(
        row.embedding_provider if row and row.embedding_provider else None
    )
    chat_changed = (prev_chat_provider, prev_chat_model) != (req.chat_provider, req.chat_model)
    vision_changed = (prev_vision_provider, prev_vision_model) != (req.vision_provider, req.vision_model)
    embedding_changed = (prev_embedding_provider, prev_embedding_model) != (
        req.embedding_provider,
        req.embedding_model,
    )
    # Added 2026-09-08, alongside the "custom" branches below — a real gap
    # the user hit directly: changing *only* the base URL (same model id
    # re-picked from the refreshed list) wasn't covered by chat_changed/
    # vision_changed/embedding_changed above (those only compare provider+
    # model, never the URL), so switching endpoints while keeping the same
    # model name wouldn't have forced a re-probe.
    custom_endpoint_changed = req.custom_base_url != (row.custom_base_url if row else None)
    embedding_endpoint_changed = req.embedding_base_url != (row.embedding_base_url if row else None)

    raw_ollama = await _query_ollama_models()
    ollama_chat = _ollama_chat_options(raw_ollama)
    ollama_embedding = _ollama_embedding_options(raw_ollama)

    # Chat and vision share one custom endpoint config; embedding has its
    # own, separate one (2026-08-18 — see AppSettings.embedding_base_url's
    # comment for why: a real setup this was built against runs chat/vision
    # and embedding as two different llama.cpp processes). Probe whichever
    # endpoint(s) are ACTUALLY being changed — 2026-09-08 fix, a real gap
    # the user hit directly: this used to probe live the instant EITHER
    # capability's provider was "custom", with no "unless unchanged" guard
    # (unlike the non-custom `elif chat_changed`/etc. branches below, which
    # already had one) — so saving an unrelated field (e.g. fixing the chat
    # model) while the embedding endpoint merely happened to be unreachable
    # right now still 400'd the WHOLE save. Every capability but chat is
    # meant to be independently optional (nothing else is load-bearing for
    # the app to run at all — see this module's own docstring on graceful
    # degradation); this is what actually makes that true for saving
    # settings, not just for runtime behavior.
    custom_api_key: str | None = None
    custom_model_ids: list[str] = []
    custom_vision_ids: set[str] = set()
    needs_custom_chatvision = (req.chat_provider == "custom" and (chat_changed or custom_endpoint_changed)) or (
        req.vision_provider == "custom" and (vision_changed or custom_endpoint_changed)
    )
    if needs_custom_chatvision:
        if not req.custom_base_url:
            raise HTTPException(
                status_code=400,
                detail="custom_base_url is required when chat_provider or vision_provider is 'custom'.",
            )
        # Reuse the previously-saved key only if it was saved for this
        # same endpoint — never silently carry a key over to a different URL.
        custom_api_key = req.custom_api_key or (
            row.custom_api_key if row and row.custom_base_url == req.custom_base_url else None
        )
        try:
            custom_results = await list_custom_models(req.custom_base_url, custom_api_key)
        except httpx.HTTPError as exc:
            detail = _with_docker_loopback_hint(req.custom_base_url, f"Couldn't reach the custom endpoint: {exc}")
            raise HTTPException(status_code=400, detail=detail)
        custom_model_ids = [model_id for model_id, _ in custom_results]
        custom_vision_ids = {model_id for model_id, vision in custom_results if vision}

    embedding_api_key: str | None = None
    embedding_custom_model_ids: list[str] = []
    needs_custom_embedding = req.embedding_provider == "custom" and (embedding_changed or embedding_endpoint_changed)
    if needs_custom_embedding:
        if not req.embedding_base_url:
            raise HTTPException(
                status_code=400,
                detail="embedding_base_url is required when embedding_provider is 'custom'.",
            )
        embedding_api_key = req.embedding_api_key or (
            row.embedding_api_key if row and row.embedding_base_url == req.embedding_base_url else None
        )
        try:
            embedding_results = await list_custom_models(req.embedding_base_url, embedding_api_key)
        except httpx.HTTPError as exc:
            detail = _with_docker_loopback_hint(
                req.embedding_base_url, f"Couldn't reach the custom embedding endpoint: {exc}"
            )
            raise HTTPException(status_code=400, detail=detail)
        embedding_custom_model_ids = [model_id for model_id, _ in embedding_results]

    if req.chat_provider == "custom":
        # Only enforced when we actually re-probed above (chat_changed or
        # custom_endpoint_changed) — an unchanged custom pick is trusted
        # as-is, matching the non-custom `elif chat_changed` branch's own
        # "don't require the endpoint to be live just to save something
        # unrelated" reasoning.
        if (chat_changed or custom_endpoint_changed) and req.chat_model not in custom_model_ids:
            raise HTTPException(
                status_code=400,
                detail=f"{req.chat_model} isn't a model reported by that custom endpoint right now.",
            )
    elif chat_changed:
        selectable_chat = {
            (m.provider, m.model) for m in ollama_chat + _list_cloud_chat_models(db) if m.selectable
        }
        if (req.chat_provider, req.chat_model) not in selectable_chat:
            raise HTTPException(
                status_code=400,
                detail=f"{req.chat_provider}/{req.chat_model} isn't a selectable chat model right now.",
            )
    # else: chat_provider/chat_model are unchanged from what's already
    # persisted — trust it rather than requiring Ollama (or whatever it
    # was picked from) to be live-reachable just to save an unrelated
    # field, e.g. switching only the embedding model while Ollama is down.

    if req.vision_provider == "custom":
        if (vision_changed or custom_endpoint_changed) and req.vision_model not in custom_vision_ids:
            raise HTTPException(
                status_code=400,
                detail=f"{req.vision_model} isn't a vision-capable model reported by that custom endpoint right now.",
            )
    elif vision_changed:
        selectable_vision = {(m.provider, m.model) for m in ollama_chat if m.vision} | {
            (m.provider, m.model) for m in _list_cloud_vision_models(db) if m.selectable
        }
        if (req.vision_provider, req.vision_model) not in selectable_vision:
            raise HTTPException(
                status_code=400,
                detail=f"{req.vision_provider}/{req.vision_model} isn't a selectable vision model right now.",
            )

    if req.embedding_provider == "custom":
        if (embedding_changed or embedding_endpoint_changed) and req.embedding_model not in embedding_custom_model_ids:
            raise HTTPException(
                status_code=400,
                detail=f"{req.embedding_model} isn't a model reported by that custom endpoint right now.",
            )
    elif embedding_changed:
        selectable_embedding = {
            (m.provider, m.model) for m in ollama_embedding + _list_cloud_embedding_models(db) if m.selectable
        }
        if (req.embedding_provider, req.embedding_model) not in selectable_embedding:
            raise HTTPException(
                status_code=400,
                detail=f"{req.embedding_provider}/{req.embedding_model} isn't a selectable embedding model right now.",
            )

    # No live "selectable set" check the way chat/vision/embedding have —
    # there's no per-provider model list to check a pick against (see this
    # module's docstring). Just the 3 known providers, and a cloud pick
    # needs its key configured.
    if req.image_provider not in ("comfyui", "openai", "gemini"):
        raise HTTPException(status_code=400, detail=f"{req.image_provider!r} isn't a supported image-gen provider.")
    if req.image_provider == "openai" and not _cloud_api_key(db, "openai"):
        raise HTTPException(status_code=400, detail="Set an OpenAI API key (dashboard Model settings, or OPENAI_API_KEY) to use OpenAI for image generation.")
    if req.image_provider == "gemini" and not _cloud_api_key(db, "gemini"):
        raise HTTPException(status_code=400, detail="Set a Gemini API key (dashboard Model settings, or GEMINI_API_KEY) to use Gemini for image generation.")

    # A pasted custom workflow (2026-08-19) — validated the same way a
    # config error would surface at generate() time, but caught here so
    # the owner learns about a typo/missing node at save time instead of
    # on their next poster generation.
    if req.image_comfyui_workflow:
        try:
            parsed_workflow = json.loads(req.image_comfyui_workflow)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"image_comfyui_workflow isn't valid JSON: {exc}")
        if not isinstance(parsed_workflow, dict):
            raise HTTPException(
                status_code=400,
                detail="image_comfyui_workflow must be a JSON object (ComfyUI's own 'Save (API Format)' export).",
            )
        if not req.image_comfyui_prompt_node:
            raise HTTPException(
                status_code=400, detail="image_comfyui_prompt_node is required when a custom workflow is set."
            )
        node = parsed_workflow.get(req.image_comfyui_prompt_node)
        if not isinstance(node, dict) or "inputs" not in node:
            raise HTTPException(
                status_code=400,
                detail=f"Node {req.image_comfyui_prompt_node!r} isn't in that workflow, or has no 'inputs'.",
            )
        prompt_field = req.image_comfyui_prompt_field or "text"
        if prompt_field not in node["inputs"]:
            raise HTTPException(
                status_code=400,
                detail=f"Node {req.image_comfyui_prompt_node!r} has no {prompt_field!r} input to hold the prompt.",
            )

    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    row.chat_provider, row.chat_model = req.chat_provider, req.chat_model
    row.vision_provider, row.vision_model = req.vision_provider, req.vision_model
    row.embedding_provider, row.embedding_model = req.embedding_provider, req.embedding_model
    if needs_custom_chatvision:
        row.custom_base_url, row.custom_api_key = req.custom_base_url, custom_api_key
    # else: leave any previously-saved custom_base_url/custom_api_key alone,
    # so switching back to "custom" later prefills without re-entering them.
    if needs_custom_embedding:
        row.embedding_base_url, row.embedding_api_key = req.embedding_base_url, embedding_api_key
    # else: same "leave it alone" rule as custom_base_url above.
    # Cloud provider keys: None = leave the previously-saved key alone
    # (same convention as apis/payments.py's stripe_secret_key etc.),
    # an explicit blank string clears it back to "use the env var."
    if req.openai_api_key is not None:
        row.openai_api_key = req.openai_api_key or None
    if req.anthropic_api_key is not None:
        row.anthropic_api_key = req.anthropic_api_key or None
    if req.gemini_api_key is not None:
        row.gemini_api_key = req.gemini_api_key or None
    row.image_provider = req.image_provider
    row.image_comfyui_url = req.image_comfyui_url
    # No live-list validation the same way chat/vision/embedding models
    # are checked — ComfyUI's own /object_info round-trip already backs
    # the picker's option list on the frontend, and an admin-typed value
    # outside that list just means "not a currently loaded file," not a
    # dangerous input (same posture as image_provider's own simple checks
    # above — no per-provider live "selectable set" to validate against).
    row.image_comfyui_unet = req.image_comfyui_unet
    row.image_comfyui_clip = req.image_comfyui_clip
    row.image_comfyui_vae = req.image_comfyui_vae
    row.image_comfyui_workflow = req.image_comfyui_workflow
    row.image_comfyui_prompt_node = req.image_comfyui_prompt_node
    row.image_comfyui_prompt_field = req.image_comfyui_prompt_field
    row.resource_coordination_enabled = req.resource_coordination_enabled
    row.resource_coordination_headroom_mb = req.resource_coordination_headroom_mb or 4096
    row.updated_by = current.email

    if embedding_changed:
        # The one place that guarantees document_chunks never mixes two
        # providers' vectors — see models.py's DocumentChunk.embedding
        # comment. RAG retrieval degrades to plain chat (apis/chat.py)
        # until POST /agent/documents/reembed-all repopulates it.
        db.execute(delete(DocumentChunk))
        row.embedding_dimensions = None  # unknown again until the next successful embed()

    db.commit()
    return _current_settings(db)
