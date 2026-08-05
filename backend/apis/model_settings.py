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

Vision model selection is Ollama-only in practice: `generate_landing_page`
(apis/agent.py) sends an image content part straight to Ollama's chat
endpoint, not through the `ChatProvider` abstraction — no provider here
exposes an image-input chat call yet. Cloud providers still appear in the
vision list for roadmap visibility, but every entry is `selectable: false`
with an explicit note — letting someone pick one would silently do
nothing (or fail confusingly) inside `generate_landing_page` otherwise.
"""

import os

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.deps import CurrentUser, Role, get_current_user, require_role
from db import get_db
from models import AppSettings
from providers.anthropic import ANTHROPIC_API_KEY, AnthropicChatProvider
from providers.gemini import GEMINI_API_KEY, GeminiChatProvider
from providers.ollama import OLLAMA_BASE_URL
from providers.openai import OPENAI_API_KEY, OpenAIChatProvider
from providers.registry import DEFAULT_CHAT_PROVIDER, default_chat_model, get_chat_provider

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
# configured default chat model, a callable returning whether its API key
# is set). Callables, not plain values, so this stays correct if the env
# var is set after the process started (unlikely in practice, but cheap
# to get right and avoids caching a stale "not configured" at import time).
_CLOUD_PROVIDERS = [
    ("openai", lambda: OpenAIChatProvider().model, lambda: bool(OPENAI_API_KEY)),
    ("anthropic", lambda: AnthropicChatProvider().model, lambda: bool(ANTHROPIC_API_KEY)),
    ("gemini", lambda: GeminiChatProvider().model, lambda: bool(GEMINI_API_KEY)),
]


class ModelOption(BaseModel):
    provider: str
    model: str
    vision: bool
    configured: bool
    selectable: bool
    note: str | None = None


class ModelListResponse(BaseModel):
    chat_models: list[ModelOption]
    vision_models: list[ModelOption]


class ModelSettings(BaseModel):
    chat_provider: str
    chat_model: str
    vision_provider: str
    vision_model: str


async def _list_ollama_models() -> list[ModelOption]:
    """Live query against Ollama's native API — real installed models and
    their real capabilities, not a hardcoded guess (see the root
    AGENTS.md's gotcha about a stale hardcoded vision-capability claim
    this replaces). Returns [] if Ollama is unreachable rather than
    failing the whole endpoint — a model list is a nice-to-have for the
    dashboard, not something that should break it."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            tags_resp = await client.get(f"{_OLLAMA_NATIVE_BASE}/api/tags")
            tags_resp.raise_for_status()
            names = [m["name"] for m in tags_resp.json().get("models", [])]

            options: list[ModelOption] = []
            for name in names:
                show_resp = await client.post(f"{_OLLAMA_NATIVE_BASE}/api/show", json={"model": name})
                show_resp.raise_for_status()
                capabilities = show_resp.json().get("capabilities", [])
                if "completion" not in capabilities:
                    continue  # embedding-only models (e.g. nomic-embed-text) aren't chat-usable
                options.append(
                    ModelOption(
                        provider="ollama",
                        model=name,
                        vision="vision" in capabilities,
                        configured=True,
                        selectable=True,
                    )
                )
            return options
    except httpx.HTTPError:
        return []


def _list_cloud_chat_models() -> list[ModelOption]:
    options = []
    for provider, get_model, get_configured in _CLOUD_PROVIDERS:
        configured = get_configured()
        options.append(
            ModelOption(
                provider=provider,
                model=get_model(),
                vision=False,
                configured=configured,
                selectable=configured,
                note=None if configured else f"Set {provider.upper()}_API_KEY to enable this provider.",
            )
        )
    return options


def _list_cloud_vision_placeholders() -> list[ModelOption]:
    return [
        ModelOption(
            provider=provider,
            model=get_model(),
            vision=True,
            configured=get_configured(),
            selectable=False,
            note="Vision generation isn't implemented for this provider yet — Ollama is the only working vision path today.",
        )
        for provider, get_model, get_configured in _CLOUD_PROVIDERS
    ]


def _current_settings(db: Session) -> ModelSettings:
    row = db.get(AppSettings, 1)
    chat_provider = (row.chat_provider if row else None) or DEFAULT_CHAT_PROVIDER
    chat_model = (row.chat_model if row else None) or default_chat_model(
        row.chat_provider if row and row.chat_provider else None
    )
    vision_provider = (row.vision_provider if row else None) or "ollama"
    vision_model = (row.vision_model if row else None) or DEFAULT_VISION_MODEL
    return ModelSettings(
        chat_provider=chat_provider,
        chat_model=chat_model,
        vision_provider=vision_provider,
        vision_model=vision_model,
    )


def resolve_chat_provider(db: Session):
    """Live `ChatProvider` honoring the owner's global selection, falling
    back to the registry's env-var default when nothing's been chosen
    yet. Used by apis/chat.py instead of calling
    `providers.registry.get_chat_provider()` directly."""
    row = db.get(AppSettings, 1)
    provider = row.chat_provider if row else None
    model = row.chat_model if row else None
    return get_chat_provider(provider, model)


def resolve_vision_model(db: Session) -> tuple[str, str]:
    """Returns (provider, model) for vision generation. `provider` is
    effectively always "ollama" today (see this module's docstring) —
    still read from settings so a future cloud vision implementation only
    needs to stop special-casing "ollama" in apis/agent.py, not touch
    settings storage."""
    row = db.get(AppSettings, 1)
    provider = (row.vision_provider if row else None) or "ollama"
    model = (row.vision_model if row else None) or DEFAULT_VISION_MODEL
    return provider, model


@router.get("/models", response_model=ModelListResponse)
async def list_models() -> ModelListResponse:
    ollama_models = await _list_ollama_models()
    return ModelListResponse(
        chat_models=ollama_models + _list_cloud_chat_models(),
        vision_models=[m for m in ollama_models if m.vision] + _list_cloud_vision_placeholders(),
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
    ollama_models = await _list_ollama_models()
    selectable_chat = {
        (m.provider, m.model) for m in ollama_models + _list_cloud_chat_models() if m.selectable
    }
    if (req.chat_provider, req.chat_model) not in selectable_chat:
        raise HTTPException(
            status_code=400,
            detail=f"{req.chat_provider}/{req.chat_model} isn't a selectable chat model right now.",
        )

    selectable_vision = {(m.provider, m.model) for m in ollama_models if m.vision}
    if (req.vision_provider, req.vision_model) not in selectable_vision:
        raise HTTPException(
            status_code=400,
            detail=f"{req.vision_provider}/{req.vision_model} isn't a selectable vision model right now.",
        )

    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    row.chat_provider, row.chat_model = req.chat_provider, req.chat_model
    row.vision_provider, row.vision_model = req.vision_provider, req.vision_model
    row.updated_by = current.email
    db.commit()
    return _current_settings(db)
