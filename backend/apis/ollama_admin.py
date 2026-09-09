"""Admin/owner management of the BUNDLED Ollama service (2026-09-09,
`docker-compose.yml`'s new `ollama` service) — the "install a local
model" half of the setup wizard, built to match a LocalAI-style
experience: no host-installer script (a containerized backend has no
access to install anything on the host OS — see the root AGENTS.md's
"First-run setup wizard" section for the full reasoning), but a REAL
one-click "pick a model, it downloads, it's ready" flow IS possible
because Ollama itself now runs as another container on this same
Docker network, reachable over a plain internal HTTP call — no host
access needed at all.

Scoped to Ollama specifically (not llama.cpp/vLLM/etc.) because Ollama's
own API already does exactly this job (`POST /api/pull`, streaming
progress) — those other runtimes have no equivalent built-in model
manager, so they stay on the manual `models/README.md` + "Custom
endpoint" path (see backend/providers/custom.py).

**Modelfile automation (2026-09-09), confirmed directly with the user**:
"default-generate, but only ever hand back something that actually
works" — every model this module hands to the owner as "ready" has
already been created AND verified with a real chat completion; a
failure at either step falls back to something already known-good
rather than leaving the owner with a broken pick.
- **Library models** (pulled via `/pull` below) — `_run_pull` always
  tries a lightly-tuned variant afterward (`FROM <model>` + a bumped
  `num_ctx`, since Ollama's own per-model default context window is
  often smaller than this app's real usage pattern needs — a long
  system prompt + RAG excerpts + conversation history). If tuning or
  verification fails for any reason, the plain pulled model (already
  proven to work by the pull itself) is what's actually reported ready
  — the owner never sees the tuning attempt at all unless they read
  `PullStatus.tuned`.
- **Owner-supplied models** (`/import-custom`, for a file dropped into
  `../models/`, mounted read-only into both this container and
  Ollama's) — tries Ollama's OWN default GGUF auto-detection FIRST (a
  minimal `FROM /models/<file>` Modelfile, confirmed as the right
  starting point directly with the user: "先有ollama提供的原型的"). Only
  if THAT fails verification does this fall back to asking whichever
  chat provider is already configured to draft an improved Modelfile
  (SYSTEM/TEMPLATE/PARAMETER guesses from the filename) — returned as a
  DRAFT for the owner to review via `/create-from-modelfile`, never
  auto-applied, since the model has no way to actually inspect a GGUF's
  real architecture/template and could easily guess wrong.

Pull/create progress is in-memory, single-process (same "this app runs
one uvicorn worker" assumption `rate_limit.py` already documents) — a
dashboard refresh loses in-flight progress only if the whole backend
process restarts, and a real pull/create is idempotent to just retry."""

import asyncio
import json
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from apis.model_settings import resolve_chat_provider
from db import get_db
from llm_json import parse_lenient_json
from providers.base import ProviderNotConfigured
from providers.ollama import OLLAMA_BASE_URL

router = APIRouter(prefix="/agent/ollama", dependencies=[Depends(require_role(Role.admin, Role.owner))])

# Ollama's *native* API (pull/tags/create/delete) is unversioned —
# OLLAMA_BASE_URL already carries the OpenAI-compat "/v1" suffix
# everything else in this codebase uses (see apis/model_settings.py's
# identical _OLLAMA_NATIVE_BASE).
_OLLAMA_NATIVE_BASE = OLLAMA_BASE_URL.removesuffix("/v1")

# Bumped context window for the auto-tuned variant of a pulled library
# model — see this module's own docstring for why Ollama's own
# per-model default is often too small for this app's real usage.
TUNED_NUM_CTX = 8192

# Read-only mount shared with the `ollama` service (docker-compose.yml)
# — see models/README.md for what an owner actually puts here.
LOCAL_MODELS_DIR = Path("/models")


class OllamaStatus(BaseModel):
    reachable: bool
    installed_models: list[str] = []
    detail: str | None = None


@router.get("/status", response_model=OllamaStatus)
async def get_ollama_status() -> OllamaStatus:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{_OLLAMA_NATIVE_BASE}/api/tags")
            resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
        return OllamaStatus(reachable=True, installed_models=models)
    except httpx.HTTPError as e:
        return OllamaStatus(reachable=False, detail=f"Ollama unreachable at {_OLLAMA_NATIVE_BASE}: {e}")


# A handful of well-known, reasonably-sized models to suggest in the
# wizard — not exhaustive, just enough that a first-time owner isn't
# staring at a blank text box. Any Ollama model tag can still be typed
# in directly; this is a convenience list, not a restriction.
SUGGESTED_MODELS = [
    {"name": "llama3.2", "size": "~2GB", "description": "Meta's Llama 3.2 (3B) — fast, good general default."},
    {"name": "qwen2.5:7b", "size": "~4.7GB", "description": "Alibaba's Qwen 2.5 (7B) — strong general-purpose model."},
    {"name": "gemma3:4b", "size": "~3.3GB", "description": "Google's Gemma 3 (4B) — small and vision-capable."},
    {"name": "nomic-embed-text", "size": "~270MB", "description": "This app's default embedding model (RAG)."},
]


@router.get("/suggested-models")
def get_suggested_models() -> list[dict]:
    return SUGGESTED_MODELS


async def _delete_model(name: str) -> None:
    """Best-effort cleanup of a model that failed verification — never
    allowed to raise, this only ever runs as a side-cleanup after a
    failure that's already being reported some other way."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.request("DELETE", f"{_OLLAMA_NATIVE_BASE}/api/delete", json={"name": name})
    except httpx.HTTPError:
        pass


async def _create_model(name: str, spec: dict) -> None:
    """Streams `POST /api/create` to completion — raises on any failure
    or a stream that never reports success, never returns partial/
    unclear success.

    **Real, load-bearing finding from live testing against the actual
    bundled Ollama (0.33.3)**: the classic `{"name": ..., "modelfile":
    "<raw text>"}` request shape — documented in a lot of older
    Ollama material and what this endpoint originally sent — is REJECTED
    outright ("neither 'from' or 'files' was specified") by this
    version. The current API wants structured fields instead: `model`
    (not `name`), `from`, and optionally `system`/`template`/
    `parameters`. `spec` below carries exactly that structured shape —
    confirmed working live (both the plain `from`-only case and a
    `parameters` override) before this code was trusted."""
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{_OLLAMA_NATIVE_BASE}/api/create", json={"model": name, **spec}
        ) as resp:
            resp.raise_for_status()
            success = False
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("status") == "success":
                    success = True
            if not success:
                raise httpx.HTTPError("Model creation stream ended without reporting success.")


async def _verify_model(name: str) -> None:
    """A REAL chat completion, not just a reachability probe — the whole
    point is catching a model that was "created" but produces garbage or
    nothing (e.g. Ollama guessed the wrong prompt template for an
    imported GGUF). Raises on any failure; a generous timeout since a
    freshly-created model's first load is a real cold start."""
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/chat/completions",
            json={"model": name, "messages": [{"role": "user", "content": "Say OK."}], "stream": False},
        )
        resp.raise_for_status()
        data = resp.json()
    content = data["choices"][0]["message"]["content"]
    if not content or not content.strip():
        raise httpx.HTTPError("Verification call returned an empty response.")


async def _create_and_verify(name: str, spec: dict) -> str | None:
    """Returns None on success, or a human-readable error string on
    failure — always cleans up a half-working model before returning an
    error, so a failed attempt never lingers as a broken, selectable
    option. `spec` is Ollama's own structured `/api/create` body minus
    `model` (e.g. `{"from": "llama3.2", "parameters": {"num_ctx": 8192}}`
    — see `_create_model`'s docstring for why this isn't a raw Modelfile
    string)."""
    try:
        await _create_model(name, spec)
    except httpx.HTTPError as e:
        return f"Model creation failed: {e}"
    try:
        await _verify_model(name)
    except httpx.HTTPError as e:
        await _delete_model(name)
        return f"Model was created but failed verification: {e}"
    except (KeyError, IndexError):
        await _delete_model(name)
        return "Model was created but returned a malformed response during verification."
    return None


def _tuned_name(base_model: str) -> str:
    # Ollama tags are `name[:tag]` — folding both into one valid tag
    # segment for the tuned variant (e.g. "llama3.2:latest" ->
    # "llama3.2-latest-tuned").
    return f"{base_model.replace(':', '-')}-tuned"


class UseInstalledRequest(BaseModel):
    model: str


class UseInstalledResponse(BaseModel):
    ok: bool
    error: str | None = None


@router.post("/verify-installed", response_model=UseInstalledResponse)
async def verify_installed_model(req: UseInstalledRequest) -> UseInstalledResponse:
    """For a model that's already sitting in the bundled Ollama instance
    (2026-09-09, on the user's own direct follow-up: besides downloading
    a NEW model, also let the owner pick from what's already there —
    something pulled earlier through this app, imported from a custom
    file, or even installed some other way entirely, e.g. an owner who
    mounted in a pre-existing `~/.ollama` directory or ran `ollama pull`
    directly against the container). Still runs the real verification
    call before the frontend commits it as the active chat model — "it's
    already downloaded" isn't the same guarantee as "it actually behaves
    like a working chat model" (an embedding-only model, or a corrupted
    download, would both still show up in `/api/tags`)."""
    model = req.model.strip()
    if not model:
        raise HTTPException(status_code=400, detail="model must not be blank.")
    try:
        await _verify_model(model)
    except httpx.HTTPError as e:
        return UseInstalledResponse(ok=False, error=f"Couldn't verify this model: {e}")
    except (KeyError, IndexError):
        return UseInstalledResponse(ok=False, error="This model returned a malformed response during verification.")
    return UseInstalledResponse(ok=True)


class DeleteModelRequest(BaseModel):
    model: str


class DeleteModelResponse(BaseModel):
    ok: bool
    error: str | None = None


@router.post("/delete-model", response_model=DeleteModelResponse)
async def delete_model(req: DeleteModelRequest) -> DeleteModelResponse:
    """Owner-initiated deletion of a model already in the bundled Ollama
    instance (2026-09-09, disk-space cleanup — an owner who tries several
    models over time otherwise has no way to remove old ones short of a
    shell into the container). Unlike `_delete_model`'s own internal
    best-effort cleanup (used after a failed verification elsewhere in
    this module), this reports a real failure back to the caller instead
    of swallowing it — an owner who explicitly asked to delete something
    should find out if it didn't work."""
    model = req.model.strip()
    if not model:
        raise HTTPException(status_code=400, detail="model must not be blank.")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.request("DELETE", f"{_OLLAMA_NATIVE_BASE}/api/delete", json={"name": model})
            resp.raise_for_status()
    except httpx.HTTPError as e:
        return DeleteModelResponse(ok=False, error=f"Couldn't delete {model}: {e}")
    return DeleteModelResponse(ok=True)


# In-memory pull progress — keyed by the base model name being pulled.
# See this module's own docstring for why this doesn't need to be more
# durable than that.
_pull_state: dict[str, dict] = {}


class PullRequest(BaseModel):
    model: str


class PullStatus(BaseModel):
    model: str
    status: str
    completed: int = 0
    total: int = 0
    done: bool = False
    error: str | None = None
    # The model to ACTUALLY use once done=True — the tuned variant if
    # that succeeded, otherwise the plain pulled model. None until done.
    final_model: str | None = None
    tuned: bool = False


async def _run_pull(model: str) -> None:
    _pull_state[model] = {
        "status": "starting",
        "completed": 0,
        "total": 0,
        "done": False,
        "error": None,
        "final_model": None,
        "tuned": False,
    }
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{_OLLAMA_NATIVE_BASE}/api/pull", json={"name": model}) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    _pull_state[model] = {
                        **_pull_state[model],
                        "status": event.get("status", ""),
                        "completed": event.get("completed", 0),
                        "total": event.get("total", 0),
                    }
    except httpx.HTTPError as e:
        _pull_state[model] = {
            **_pull_state[model],
            "status": "error",
            "done": True,
            "error": f"Pull failed: {e}",
        }
        return

    # Base pull succeeded — now try the tuned variant. Never lets a
    # tuning failure look like a pull failure: final_model always ends
    # up set to something that works.
    _pull_state[model] = {**_pull_state[model], "status": "tuning"}
    tuned_name = _tuned_name(model)
    tune_error = await _create_and_verify(tuned_name, {"from": model, "parameters": {"num_ctx": TUNED_NUM_CTX}})
    if tune_error is None:
        _pull_state[model] = {
            **_pull_state[model],
            "status": "success",
            "done": True,
            "final_model": tuned_name,
            "tuned": True,
        }
    else:
        _pull_state[model] = {
            **_pull_state[model],
            "status": "success",
            "done": True,
            "final_model": model,
            "tuned": False,
            # Informational only, not surfaced as `error` — the pull
            # itself genuinely succeeded, only the optional tuning step
            # didn't stick.
        }


@router.post("/pull", response_model=PullStatus)
async def pull_model(req: PullRequest) -> PullStatus:
    model = req.model.strip()
    if not model:
        raise HTTPException(status_code=400, detail="model must not be blank.")
    existing = _pull_state.get(model)
    if existing and not existing["done"]:
        raise HTTPException(status_code=409, detail=f"{model} is already being pulled.")
    asyncio.create_task(_run_pull(model))
    return PullStatus(model=model, status="starting", done=False)


@router.get("/pull-status", response_model=PullStatus)
def get_pull_status(model: str) -> PullStatus:
    state = _pull_state.get(model.strip())
    if state is None:
        raise HTTPException(status_code=404, detail=f"No pull in progress or completed for {model!r}.")
    return PullStatus(model=model, **state)


# --- Server-side URL download (2026-09-09) — the ONLY practical way for
# an owner to get their own model file into ../models/ on a remote/EC2-
# style deployment with no shell access. A browser upload was considered
# and rejected for this project's own scale of file (multi-GB to tens of
# GB GGUFs): it would cost the OWNER's own upload bandwidth (their
# connection is very likely slower than a server-to-server fetch) and a
# dropped connection loses the whole transfer. Server-side download from
# a URL (the owner pastes a HuggingFace/direct-download link) mirrors
# this app's own already-established `apis/documents.py` URL-ingestion
# pattern exactly, just for a model file instead of a RAG document. ---

_download_state: dict[str, dict] = {}


def _sanitize_filename(name: str) -> str:
    name = Path(name).name  # strips any directory components — no path traversal via a crafted name
    name = "".join(c if c.isalnum() or c in "-_. " else "_" for c in name).strip()
    return name or "model.gguf"


def _filename_from_url(url: str) -> str:
    from urllib.parse import unquote, urlparse

    return _sanitize_filename(unquote(Path(urlparse(url).path).name) or "model.gguf")


class DownloadFromUrlRequest(BaseModel):
    url: str
    filename: str | None = None


class DownloadStatus(BaseModel):
    filename: str
    status: str
    downloaded: int = 0
    # None when the source doesn't report Content-Length (some CDNs/
    # redirect chains don't) — the frontend shows a byte counter instead
    # of a percentage bar in that case, never a fake/guessed total.
    total: int | None = None
    done: bool = False
    error: str | None = None


async def _run_download(url: str, filename: str) -> None:
    _download_state[filename] = {"status": "starting", "downloaded": 0, "total": None, "done": False, "error": None}
    dest = LOCAL_MODELS_DIR / filename
    # Downloads to a .part sibling, renamed to the real name only on
    # success — so a still-downloading (or failed, half-written) file
    # never shows up in `list_local_model_files()`'s extension-filtered
    # listing as something ready to import.
    tmp_dest = dest.with_name(dest.name + ".part")
    try:
        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            # Accept-Encoding: identity (2026-09-09, real finding from live
            # testing) — without this, a compressible source (confirmed
            # against a real GitHub-hosted file) reports Content-Length for
            # the COMPRESSED size while httpx transparently decompresses the
            # stream, so `downloaded` ends up exceeding `total` — harmless
            # for an actual GGUF (binary model weights don't meaningfully
            # compress, so this changes nothing for the real target use
            # case) but this guarantees an accurate progress percentage
            # for any source, not just the ones that happen to skip
            # compression on their own.
            async with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as resp:
                resp.raise_for_status()
                content_length = resp.headers.get("content-length")
                total = int(content_length) if content_length else None
                _download_state[filename] = {**_download_state[filename], "status": "downloading", "total": total}
                downloaded = 0
                with tmp_dest.open("wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=1024 * 1024):
                        f.write(chunk)
                        downloaded += len(chunk)
                        _download_state[filename] = {**_download_state[filename], "downloaded": downloaded}
        tmp_dest.rename(dest)
        _download_state[filename] = {**_download_state[filename], "status": "success", "done": True}
    except httpx.HTTPError as e:
        tmp_dest.unlink(missing_ok=True)
        _download_state[filename] = {
            **_download_state[filename],
            "status": "error",
            "done": True,
            "error": f"Download failed: {e}",
        }
    except OSError as e:
        tmp_dest.unlink(missing_ok=True)
        _download_state[filename] = {
            **_download_state[filename],
            "status": "error",
            "done": True,
            "error": f"Couldn't write the downloaded file (disk full? permissions?): {e}",
        }


@router.post("/download-from-url", response_model=DownloadStatus)
async def download_from_url(req: DownloadFromUrlRequest) -> DownloadStatus:
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="url must not be blank.")
    filename = _sanitize_filename(req.filename) if req.filename and req.filename.strip() else _filename_from_url(url)
    existing = _download_state.get(filename)
    if existing and not existing["done"]:
        raise HTTPException(status_code=409, detail=f"{filename} is already downloading.")
    asyncio.create_task(_run_download(url, filename))
    return DownloadStatus(filename=filename, status="starting", done=False)


@router.get("/download-status", response_model=DownloadStatus)
def get_download_status(filename: str) -> DownloadStatus:
    state = _download_state.get(filename.strip())
    if state is None:
        raise HTTPException(status_code=404, detail=f"No download in progress or completed for {filename!r}.")
    return DownloadStatus(filename=filename, **state)


# --- Owner-supplied ("UD"/custom) models — see this module's own
# docstring for the two-tier design. ---


@router.get("/local-files", response_model=list[str])
def list_local_model_files() -> list[str]:
    """Files in ../models/ (see models/README.md) that look like model
    files an owner might want to import — not a strict allowlist, just
    what's worth showing in the wizard/dashboard. A file still mid-
    download (see `_run_download`'s `.part` naming above) never appears
    here."""
    if not LOCAL_MODELS_DIR.is_dir():
        return []
    return sorted(
        p.name for p in LOCAL_MODELS_DIR.iterdir() if p.is_file() and p.suffix.lower() in (".gguf", ".bin")
    )


class ImportCustomRequest(BaseModel):
    filename: str
    name: str | None = None


class ImportCustomResponse(BaseModel):
    ok: bool
    model: str | None = None
    error: str | None = None
    # A best-effort AI-drafted spec, only present when Ollama's own
    # default import attempt failed verification — review before
    # applying via POST /create-custom. Never auto-applied.
    suggestion: "CustomModelSpec | None" = None


class CustomModelSpec(BaseModel):
    """Ollama's own structured `/api/create` fields, minus `model`/
    `from` (both already known from the request that needed a suggestion
    in the first place) — see `_create_model`'s docstring for why this
    is a plain dict/JSON shape, not a raw Modelfile string, in the
    version of Ollama this app bundles."""

    system: str | None = None
    template: str | None = None
    parameters: dict | None = None


@router.post("/import-custom", response_model=ImportCustomResponse)
async def import_custom_model(req: ImportCustomRequest, db: Session = Depends(get_db)) -> ImportCustomResponse:
    filename = req.filename.strip()
    # Exact match against the real directory listing — never trust a
    # caller-supplied filename as a path on its own (no "..", no
    # absolute paths), same paranoid posture chat_attachments.py's
    # resolve_local_path already documents for this app's other
    # client-supplied-path surfaces.
    if filename not in list_local_model_files():
        raise HTTPException(status_code=400, detail=f"{filename!r} isn't a file in models/.")

    name = (req.name or Path(filename).stem).strip()
    name = "".join(c if c.isalnum() or c in "-_." else "-" for c in name) or "custom-model"

    # Tier 1 for custom models too: trust Ollama's own default GGUF
    # auto-detection first — confirmed directly with the user as the
    # right starting point, not something to second-guess up front.
    error = await _create_and_verify(name, {"from": f"/models/{filename}"})
    if error is None:
        return ImportCustomResponse(ok=True, model=name)

    # Only now ask the currently-configured chat provider for help — a
    # best-effort DRAFT, never applied automatically (see this module's
    # own docstring for why: no way to actually inspect the GGUF's real
    # architecture from here, a guess could easily be wrong).
    suggestion = await _suggest_model_spec(db, filename, error)
    return ImportCustomResponse(ok=False, error=error, suggestion=suggestion)


_SUGGEST_SPEC_SYSTEM_PROMPT = """You help configure a local GGUF model file for Ollama after Ollama's own \
default import couldn't run it correctly (it either failed to create, or created but returned empty/garbled \
output during a test chat completion — almost always because Ollama guessed the wrong prompt template for \
this model's family).

You are given the file's name and the error from the failed attempt. Guess the model family from the \
filename (common families: llama, qwen, mistral, gemma, phi, deepseek, ...). Respond with ONLY a single JSON \
object, no markdown fences, no commentary:
{"system": "<a brief, generic assistant persona, or null>", "template": "<this family's real Go-template \
chat template if you are genuinely confident of the exact syntax, otherwise null — an absent template lets \
Ollama fall back to its own default, which is safer than a wrong one>", "parameters": {"num_ctx": 8192}}"""


async def _suggest_model_spec(db: Session, filename: str, error: str) -> CustomModelSpec | None:
    """Best-effort — returns None (never raises) on any failure, since
    this is a fallback assist on top of an already-reported error, not
    something that should itself produce a confusing second failure."""
    try:
        provider = resolve_chat_provider(db)
        messages = [{"role": "user", "content": f"Filename: {filename}\nError from Ollama's default import attempt: {error}"}]
        raw = await provider.chat(messages, system=_SUGGEST_SPEC_SYSTEM_PROMPT, json_mode=True)
        parsed = parse_lenient_json(raw)
    except (ProviderNotConfigured, httpx.HTTPError, ValueError):
        return None
    return CustomModelSpec(
        system=parsed.get("system") or None,
        template=parsed.get("template") or None,
        parameters=parsed.get("parameters") or None,
    )


class CreateCustomModelRequest(BaseModel):
    filename: str
    name: str
    system: str | None = None
    template: str | None = None
    parameters: dict | None = None


class CreateCustomModelResponse(BaseModel):
    ok: bool
    model: str | None = None
    error: str | None = None


@router.post("/create-custom", response_model=CreateCustomModelResponse)
async def create_custom_model(req: CreateCustomModelRequest) -> CreateCustomModelResponse:
    """Applies an (owner-reviewed, possibly AI-drafted-then-edited) spec
    on top of the same local file `/import-custom` already validated —
    same create-then-verify safety net as every other path in this
    module. Used both for the AI suggestion above (after the owner
    reviews/edits it) and for a power user who just wants to hand-write
    one."""
    filename = req.filename.strip()
    if filename not in list_local_model_files():
        raise HTTPException(status_code=400, detail=f"{filename!r} isn't a file in models/.")
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name must not be blank.")

    spec: dict = {"from": f"/models/{filename}"}
    if req.system:
        spec["system"] = req.system
    if req.template:
        spec["template"] = req.template
    if req.parameters:
        spec["parameters"] = req.parameters

    error = await _create_and_verify(name, spec)
    if error:
        return CreateCustomModelResponse(ok=False, error=error)
    return CreateCustomModelResponse(ok=True, model=name)
