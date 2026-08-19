import asyncio
import base64
import io
import json
import os
import uuid
from pathlib import Path
from typing import Optional

import httpx
import websockets
from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

router = APIRouter()

WORKFLOW_PATH_TXT2IMG = Path(__file__).parent.parent / "comfy" / "image" / "image_z_image_turbo.json"
WORKFLOW_PATH_IMG2IMG = Path(__file__).parent.parent / "comfy" / "image" / "image_z_image_turbo_img2img.json"

# Read from env vars (see docker-compose.yml, composed from the root
# .env's COMFYUI_HOST/COMFYUI_PORT/HOST — see .env.example) rather than
# hardcoded, matching COMFYUI_OUTPUT_DIR's existing pattern just below.
# Defaults here match the values this used to be hardcoded to, so nothing
# changes if .env/docker-compose ever don't set these.
COMFYUI_URL: str = os.environ.get("COMFYUI_URL", "http://host.docker.internal:8188")
COMFYUI_PUBLIC_URL: str = os.environ.get("COMFYUI_PUBLIC_URL", "http://localhost:8188")
COMFYUI_WS_URL: str = os.environ.get("COMFYUI_WS_URL", "ws://host.docker.internal:8188/ws")

# Must point at a path THIS PROCESS can actually write to. If the wrapper
# runs in a Docker container (as it does here — see docker-compose.yml),
# this must be a container-internal path with a volume mount to ComfyUI's
# real --output-directory on the host; it is NOT the same string as what
# you passed to ComfyUI's own launch command. Override via the
# COMFYUI_OUTPUT_DIR env var in docker-compose.yml; the Windows path below
# is only a fallback for running the wrapper directly on the host (no
# container) where the two DO coincide.
COMFYUI_OUTPUT_DIR = Path(os.environ.get("COMFYUI_OUTPUT_DIR", r"D:\AI_Models\comfy\output"))

# A TTF/OTF font with the glyph coverage you need (e.g. Noto Sans SC for
# Chinese) must be placed here. PIL's built-in default font is a tiny
# bitmap font with Latin-only coverage — fine for testing, not for a demo.
POSTER_FONT_PATH = Path(__file__).parent.parent / "assets" / "fonts" / "NotoSansSC-Bold.otf"


async def list_comfyui_loader_options(base_url: str, node_class: str, param_name: str) -> list[str]:
    """Live-query ComfyUI's own `/object_info/{node_class}` for what files
    it currently reports as loadable for one widget (e.g. `UNETLoader`'s
    `unet_name`) — the actual list of `.safetensors`/etc. files ComfyUI
    found in its own models folder, not a hardcoded guess. Returns []
    on any failure (unreachable, node class not installed, ...) rather
    than raising — this is enrichment for a picker, not load-bearing."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base_url}/object_info/{node_class}")
            resp.raise_for_status()
            data = resp.json()
        return list(data[node_class]["input"]["required"][param_name][0])
    except (httpx.HTTPError, KeyError, IndexError, TypeError):
        return []


def _load_workflow(path: Path) -> dict:
    """Load a ComfyUI workflow JSON template from the given path."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _decode_base64_image(b64_data: str) -> bytes:
    """Decode a base64 image string, tolerating a data-URI prefix
    (e.g. 'data:image/png;base64,....') if the caller included one."""
    if "," in b64_data and b64_data.strip().lower().startswith("data:"):
        b64_data = b64_data.split(",", 1)[1]
    try:
        return base64.b64decode(b64_data, validate=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image data: {e}")


async def _upload_image_to_comfyui(image_bytes: bytes, filename: str = "source.png") -> str:
    """Upload raw image bytes into ComfyUI's own input/ folder via its
    native /upload/image endpoint, so a LoadImage node can reference it by
    name. Returns the filename ComfyUI actually saved it under (it may
    rename on collision, so don't assume it matches what was passed in)."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            files = {"image": (filename, image_bytes, "image/png")}
            resp = await client.post(f"{COMFYUI_URL}/upload/image", files=files)
            resp.raise_for_status()
            result = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Failed to upload source image to ComfyUI: {e}")

    name = result.get("name")
    if not name:
        raise HTTPException(status_code=502, detail=f"ComfyUI upload did not return a filename: {result}")
    return name


def _build_payload_txt2img(
    prompt: str = "",
    seed: int = 614209039322779,
    steps: int = 8,
    cfg_scale: float = 1.0,
    width: int = 1024,
    height: int = 1024,
    ckpt_name: str = "z_image_turbo_bf16.safetensors",
    clip_name: str = "qwen_3_4b.safetensors",
    vae_name: str = "ae.safetensors",
) -> dict:
    """Build a ComfyUI prompt payload for text-to-image (pure-noise start)."""

    workflow = _load_workflow(WORKFLOW_PATH_TXT2IMG)

    # --- Node 57:27: CLIPTextEncode (positive prompt) ---
    if prompt:
        workflow["57:27"]["inputs"]["text"] = prompt

    # --- Node 57:3: KSampler ---
    workflow["57:3"]["inputs"]["seed"] = seed
    workflow["57:3"]["inputs"]["steps"] = steps
    workflow["57:3"]["inputs"]["cfg"] = cfg_scale

    # --- Node 57:13: EmptySD3LatentImage ---
    workflow["57:13"]["inputs"]["width"] = width
    workflow["57:13"]["inputs"]["height"] = height

    # --- Node 57:28: UNETLoader (checkpoint) ---
    workflow["57:28"]["inputs"]["unet_name"] = ckpt_name

    # --- Node 57:30: CLIPLoader ---
    workflow["57:30"]["inputs"]["clip_name"] = clip_name

    # --- Node 57:29: VAELoader ---
    workflow["57:29"]["inputs"]["vae_name"] = vae_name

    client_id = str(uuid.uuid4())
    return {"prompt": workflow, "client_id": client_id}


def _build_payload_img2img(
    prompt: str,
    source_image_filename: str,
    denoise: float = 0.6,
    seed: int = 614209039322779,
    steps: int = 8,
    cfg_scale: float = 1.0,
    ckpt_name: str = "z_image_turbo_bf16.safetensors",
    clip_name: str = "qwen_3_4b.safetensors",
    vae_name: str = "ae.safetensors",
) -> dict:
    """Build a ComfyUI prompt payload for image-to-image: starts KSampler
    from a VAE-encoded real image instead of noise. `denoise` controls how
    much of the source is preserved — 1.0 ~= ignore it entirely (same as
    txt2img), lower values (e.g. 0.4-0.6) stay closer to the original
    structure/composition while restyling it per the prompt."""

    workflow = _load_workflow(WORKFLOW_PATH_IMG2IMG)

    # --- Node 57:27: CLIPTextEncode (positive prompt) ---
    if prompt:
        workflow["57:27"]["inputs"]["text"] = prompt

    # --- Node 57:3: KSampler ---
    workflow["57:3"]["inputs"]["seed"] = seed
    workflow["57:3"]["inputs"]["steps"] = steps
    workflow["57:3"]["inputs"]["cfg"] = cfg_scale
    workflow["57:3"]["inputs"]["denoise"] = denoise

    # --- Node 58:1: LoadImage (the uploaded source image) ---
    workflow["58:1"]["inputs"]["image"] = source_image_filename

    # --- Node 57:28: UNETLoader (checkpoint) ---
    workflow["57:28"]["inputs"]["unet_name"] = ckpt_name

    # --- Node 57:30: CLIPLoader ---
    workflow["57:30"]["inputs"]["clip_name"] = clip_name

    # --- Node 57:29: VAELoader ---
    workflow["57:29"]["inputs"]["vae_name"] = vae_name

    client_id = str(uuid.uuid4())
    return {"prompt": workflow, "client_id": client_id}


class GenerateImageRequest(BaseModel):
    """Request body schema for /generate-image.

    Leave `source_image_base64` unset for text-to-image (the original
    behavior, unchanged). Set it to run image-to-image instead: the image
    is uploaded into ComfyUI and used as the starting point, restyled
    according to `prompt` at strength `denoise` (lower = closer to the
    original, e.g. 0.4-0.6; higher = closer to a fresh txt2img).
    `width`/`height` are ignored for img2img — the source image's own
    dimensions are used.
    """
    prompt: str = ""
    seed: int = 614209039322779
    steps: int = 8
    cfg_scale: float = 1.0
    width: int = 1024
    height: int = 1024
    ckpt_name: str = "z_image_turbo_bf16.safetensors"
    clip_name: str = "qwen_3_4b.safetensors"
    vae_name: str = "ae.safetensors"
    source_image_base64: Optional[str] = None
    denoise: float = 0.6


@router.post("/generate-image")
async def generate_image(req: GenerateImageRequest):
    """Generate an image using the Z Image Turbo workflow — text-to-image
    by default, or image-to-image if `source_image_base64` is provided.

    Sends a ComfyUI prompt payload to the running ComfyUI instance and returns
    the submission result (prompt_id, client_id).
    """
    try:
        if req.source_image_base64:
            image_bytes = _decode_base64_image(req.source_image_base64)
            uploaded_filename = await _upload_image_to_comfyui(image_bytes)
            payload = _build_payload_img2img(
                prompt=req.prompt,
                source_image_filename=uploaded_filename,
                denoise=req.denoise,
                seed=req.seed,
                steps=req.steps,
                cfg_scale=req.cfg_scale,
                ckpt_name=req.ckpt_name,
                clip_name=req.clip_name,
                vae_name=req.vae_name,
            )
        else:
            payload = _build_payload_txt2img(
                prompt=req.prompt,
                seed=req.seed,
                steps=req.steps,
                cfg_scale=req.cfg_scale,
                width=req.width,
                height=req.height,
                ckpt_name=req.ckpt_name,
                clip_name=req.clip_name,
                vae_name=req.vae_name,
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to build workflow: {e}")

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{COMFYUI_URL}/prompt", json=payload)
            resp.raise_for_status()
            result = resp.json()
            if result.get("node_errors"):
                raise HTTPException(status_code=422, detail={"node_errors": result["node_errors"]})
            if not result.get("prompt_id"):
                raise HTTPException(status_code=502, detail=f"ComfyUI did not return a prompt_id: {result}")

        return {
            "status": "success",
            "message": "Task submitted to ComfyUI",
            "prompt_id": result.get("prompt_id"),
            "client_id": payload["client_id"],
            "comfyui_response": result,
        }
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to connect to ComfyUI at {COMFYUI_URL}: {e}",
        )


async def _fetch_history_result(
    prompt_id: str, *, base_url: str = COMFYUI_URL, public_url: str = COMFYUI_PUBLIC_URL
) -> dict:
    """Fetch and normalize ComfyUI's /history/{prompt_id} into our response
    shape. Shared by the /history route and the /wait endpoint below.

    `base_url`/`public_url` default to the env-var-configured instance
    (unchanged behavior for this module's own routes and any existing
    caller) — providers/comfyui.py's ComfyUIImageProvider is the only
    caller that ever passes an override, when the owner has pointed image
    generation at a different ComfyUI instance via the model picker."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{base_url}/history/{prompt_id}")
            resp.raise_for_status()
            history = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to connect to ComfyUI at {base_url}: {e}",
        )

    # ComfyUI returns {} if the prompt_id hasn't finished (or doesn't exist yet)
    if prompt_id not in history:
        return {
            "status": "pending",
            "prompt_id": prompt_id,
            "message": "Task not found in history yet.",
        }

    entry = history[prompt_id]
    status_info = entry.get("status", {})
    status_str = status_info.get("status_str", "unknown")

    if status_str == "error":
        return {
            "status": "error",
            "prompt_id": prompt_id,
            "message": "ComfyUI execution failed",
            "details": status_info.get("messages", []),
        }

    outputs = entry.get("outputs", {})
    images = []
    for node_output in outputs.values():
        for img in node_output.get("images", []):
            images.append(
                {
                    "filename": img.get("filename"),
                    "subfolder": img.get("subfolder", ""),
                    "type": img.get("type", "output"),
                    "url": (
                        f"{public_url}/view?filename={img.get('filename')}"
                        f"&subfolder={img.get('subfolder', '')}"
                        f"&type={img.get('type', 'output')}"
                    ),
                }
            )

    if not images:
        return {
            "status": "error",
            "prompt_id": prompt_id,
            "message": "Task finished but no images were produced.",
            "raw_status": status_info,
        }

    return {
        "status": "completed",
        "prompt_id": prompt_id,
        "images": images,
    }


@router.get("/history/{prompt_id}")
async def get_history(prompt_id: str):
    """Check the progress/result of a previously submitted ComfyUI task.

    Proxies ComfyUI's native /history/{prompt_id} endpoint. Returns whether
    the task has finished, and if so, the list of output image filenames.
    """
    return await _fetch_history_result(prompt_id)


async def _wait_via_websocket(
    prompt_id: str,
    timeout: float,
    *,
    ws_url: str = COMFYUI_WS_URL,
    base_url: str = COMFYUI_URL,
    public_url: str = COMFYUI_PUBLIC_URL,
    client_id: Optional[str] = None,
):
    """Try to catch ComfyUI's completion event over its native websocket
    instead of polling. Returns a result dict on a definitive outcome
    (completed/error), or None if the socket couldn't tell us anything
    within a reasonable window — in which case the caller should fall
    back to plain polling rather than trusting the socket for the whole
    timeout budget (protects against dropped connections/missed events).

    `client_id` MUST be the same client_id that was submitted alongside
    the /prompt request that produced `prompt_id`, or this will never see
    a single event for it: ComfyUI's server routes "executing"/"progress"/
    "executed" messages only to the websocket connection whose clientId
    matches the submission's client_id (it does not broadcast them to
    every connected socket). Connecting with a fresh, unrelated client_id
    (the old behavior here) means this call always burns its full
    per-recv timeout waiting for events that can never arrive, silently
    degrading every wait into "however long the polling fallback below
    takes to next notice the job already finished" — found from a real
    report of ComfyUI finishing in ~6s but the image not showing up in
    the app for ~30s (exactly this function's 30s per-recv cap). If
    `client_id` isn't supplied (e.g. a caller that never had it, like the
    plain /wait/{prompt_id} route below), we still generate a throwaway
    one so the connection succeeds, but it degrades to the same always-
    times-out behavior as before — the fix requires the caller to have
    and pass the real submission client_id.

    `ws_url`/`base_url`/`public_url` default to the env-var-configured
    instance — see _fetch_history_result's docstring for why."""
    ws_client_id = client_id or str(uuid.uuid4())
    uri = f"{ws_url}?clientId={ws_client_id}"
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout

    try:
        async with websockets.connect(uri, open_timeout=10, close_timeout=5) as ws:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return None
                try:
                    # Cap each recv wait at 30s: if the socket goes quiet for
                    # that long we bail to the polling fallback rather than
                    # silently trusting it for the rest of the budget.
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(remaining, 30))
                except asyncio.TimeoutError:
                    return None

                if isinstance(raw, (bytes, bytearray)):
                    continue  # binary preview/progress frames, not JSON

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                data = msg.get("data") or {}
                if data.get("prompt_id") != prompt_id:
                    continue

                if msg.get("type") == "execution_error":
                    return {
                        "status": "error",
                        "prompt_id": prompt_id,
                        "message": "ComfyUI execution failed",
                        "details": data,
                    }

                # ComfyUI signals "this whole prompt is done" by sending an
                # "executing" event with node == None for the prompt_id.
                if msg.get("type") == "executing" and data.get("node") is None:
                    return await _fetch_history_result(prompt_id, base_url=base_url, public_url=public_url)
    except Exception:
        # Any websocket-level failure (refused, dropped, etc.) -> let the
        # caller fall back to polling instead of raising.
        return None


async def _wait_for_completion_impl(
    prompt_id: str,
    timeout: float = 300.0,
    *,
    base_url: str = COMFYUI_URL,
    public_url: str = COMFYUI_PUBLIC_URL,
    ws_url: str = COMFYUI_WS_URL,
    client_id: Optional[str] = None,
) -> dict:
    """The actual implementation behind the /wait route below — kept
    separate so base_url/public_url/ws_url overrides (providers/comfyui.py's
    ComfyUIImageProvider is the only caller that ever passes one, when the
    owner has pointed image generation at a different ComfyUI instance via
    the model picker) never become accidentally-public query parameters on
    the HTTP route itself. See _fetch_history_result's docstring for the
    same default-to-env-var reasoning.

    `client_id` should be the same client_id used to submit prompt_id to
    ComfyUI's /prompt — see _wait_via_websocket's docstring for why this
    is required for the websocket fast path to ever fire."""
    # In case it already finished before this request even arrived.
    existing = await _fetch_history_result(prompt_id, base_url=base_url, public_url=public_url)
    if existing["status"] in ("completed", "error"):
        return existing

    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout

    result = await _wait_via_websocket(
        prompt_id, timeout, ws_url=ws_url, base_url=base_url, public_url=public_url, client_id=client_id
    )
    if result is not None:
        return result

    # Fallback: plain polling for whatever's left of the timeout budget.
    while loop.time() < deadline:
        await asyncio.sleep(5)
        result = await _fetch_history_result(prompt_id, base_url=base_url, public_url=public_url)
        if result["status"] in ("completed", "error"):
            return result

    return {
        "status": "timeout",
        "prompt_id": prompt_id,
        "message": f"No completion after {timeout:.0f}s (websocket + polling fallback both exhausted). "
                   f"Sent a cancel/interrupt request to ComfyUI to free up resources.",
        "cancel_results": await _cancel_task_internal(prompt_id, base_url=base_url),
    }


@router.get("/wait/{prompt_id}")
async def wait_for_completion(prompt_id: str, timeout: float = 300.0, client_id: Optional[str] = None):
    """Block server-side until prompt_id finishes (or times out).

    Replaces client-side polling with a single call: we listen on
    ComfyUI's native websocket for a near-instant notification, and only
    fall back to polling /history every 5s if the socket is unreachable,
    drops, or goes quiet for 30s. Either way we return one final result,
    so the caller (poll_history.py) makes exactly one HTTP request and
    blocks on it instead of looping itself. Always targets the env-var-
    configured ComfyUI instance — see _wait_for_completion_impl for the
    internal-only override used when the owner has pointed image
    generation at a different instance.

    `client_id` should be the same client_id the caller submitted
    alongside /prompt (returned as `client_id` in /generate-image's
    response) — without it, the websocket fast path can never receive
    this prompt's completion event (see _wait_via_websocket's docstring)
    and every call silently degrades to the ~30s polling fallback even
    when ComfyUI finished almost immediately.
    """
    return await _wait_for_completion_impl(prompt_id, timeout, client_id=client_id)


async def _cancel_task_internal(prompt_id: str, *, base_url: str = COMFYUI_URL) -> dict:
    """Shared cancel logic: dequeue (if pending) and interrupt (if running).
    Used both by the /cancel route and internally by /wait's timeout path.
    `base_url` defaults to the env-var-configured instance — see
    _fetch_history_result's docstring for the same reasoning."""
    results: dict = {}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.post(f"{base_url}/queue", json={"delete": [prompt_id]})
            results["queue_delete_status"] = resp.status_code
        except httpx.HTTPError as e:
            results["queue_delete_error"] = str(e)

        # ComfyUI's /interrupt is GLOBAL — it has no way to target a
        # specific prompt_id, it just kills whatever is currently running.
        # If this cancel call arrives late (e.g. a client that gave up
        # minutes ago finally gets around to calling /cancel), blindly
        # calling /interrupt could kill a completely unrelated job that
        # happens to be running by then. So check first, and only
        # interrupt if prompt_id is actually the one currently executing.
        try:
            queue_resp = await client.get(f"{base_url}/queue")
            queue_resp.raise_for_status()
            queue_data = queue_resp.json()
            running_ids = {
                entry[1] for entry in queue_data.get("queue_running", []) if len(entry) > 1
            }
            if prompt_id in running_ids:
                resp = await client.post(f"{base_url}/interrupt")
                results["interrupt_status"] = resp.status_code
            else:
                results["interrupt_skipped"] = (
                    "prompt_id is not the currently-running job — skipped /interrupt "
                    "to avoid killing an unrelated task"
                )
        except httpx.HTTPError as e:
            results["interrupt_error"] = str(e)
    return results


@router.post("/cancel/{prompt_id}")
async def cancel_task(prompt_id: str):
    """Cancel a ComfyUI task that's taking too long.

    Two-pronged, best-effort:
      1. Remove it from the queue via POST /queue {"delete": [prompt_id]},
         in case it hasn't started running yet.
      2. Call POST /interrupt, in case it's the currently-executing prompt.

    Both calls are attempted independently; a failure in one doesn't block
    the other. Exposed as a route for poll_history.py's client-side safety
    net; also called internally when /wait itself times out.
    """
    results = await _cancel_task_internal(prompt_id)
    return {
        "status": "cancel_requested",
        "prompt_id": prompt_id,
        "results": results,
    }


class TextOverlayRequest(BaseModel):
    """Request body schema for /add-text-overlay.

    This does NOT touch ComfyUI or the diffusion model at all — it composites
    real, crisp, rendered text onto an existing image using PIL. Use this for
    any poster/flyer text instead of asking the diffusion model to render
    words, which is unreliable (garbled glyphs, wrong characters, especially
    for non-Latin scripts).
    """
    image_base64: str
    text: str
    x: Optional[int] = None          # None = horizontally centered
    y: Optional[int] = None          # None = placed in the lower third
    font_size: int = 64
    color: str = "#FFFFFF"
    stroke_color: str = "#000000"
    stroke_width: int = 3
    align: str = "center"            # "left" | "center" | "right"
    background: bool = False         # semi-transparent box behind the text —
                                      # helps a lot over busy/detailed photos
    background_color: str = "#000000"
    background_opacity: float = 0.45  # 0.0 (invisible) - 1.0 (solid)
    background_padding: int = 20


@router.post("/add-text-overlay")
async def add_text_overlay(req: TextOverlayRequest):
    """Composite real rendered text onto an image (poster-style caption/title).

    Writes the result into ComfyUI's own output directory and returns a URL
    through ComfyUI's native /view endpoint — the same way generated images
    are served, so the caller doesn't need a separate code path. No GPU work
    happens here; it's pure CPU image compositing.
    """
    try:
        from PIL import Image, ImageColor, ImageDraw, ImageFont
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="Pillow is not installed on the wrapper. Run: pip install pillow",
        )

    image_bytes = _decode_base64_image(req.image_base64)

    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open image data: {e}")

    if POSTER_FONT_PATH.is_file():
        font = ImageFont.truetype(str(POSTER_FONT_PATH), req.font_size)
    else:
        # Falls back to PIL's tiny built-in bitmap font (Latin-only, fixed
        # size) if no font file was bundled. Fine for a quick smoke test,
        # NOT fine for a real poster — see POSTER_FONT_PATH's docstring.
        font = ImageFont.load_default()

    measure_draw = ImageDraw.Draw(img)
    bbox = measure_draw.textbbox((0, 0), req.text, font=font, stroke_width=req.stroke_width)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    x = req.x
    if x is None:
        if req.align == "left":
            x = int(img.width * 0.05)
        elif req.align == "right":
            x = img.width - text_w - int(img.width * 0.05)
        else:
            x = (img.width - text_w) // 2

    y = req.y if req.y is not None else int(img.height * 0.78) - text_h // 2

    if req.background:
        # Draw the box on a separate transparent layer and alpha-composite
        # it in, so opacity < 1.0 actually blends with the photo underneath
        # rather than just being a flat translucent-looking fill.
        pad = req.background_padding
        box_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        box_draw = ImageDraw.Draw(box_layer)
        bg_rgb = ImageColor.getrgb(req.background_color)
        alpha = max(0, min(255, int(255 * req.background_opacity)))
        box_draw.rectangle(
            (bbox[0] + x - pad, bbox[1] + y - pad, bbox[2] + x + pad, bbox[3] + y + pad),
            fill=(*bg_rgb, alpha),
        )
        img = Image.alpha_composite(img, box_layer)

    draw = ImageDraw.Draw(img)
    draw.text(
        (x, y),
        req.text,
        font=font,
        fill=req.color,
        stroke_width=req.stroke_width,
        stroke_fill=req.stroke_color,
    )

    filename = f"poster_{uuid.uuid4().hex}.png"
    out_path = COMFYUI_OUTPUT_DIR / filename
    try:
        img.convert("RGB").save(out_path, "PNG")
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to write poster to {out_path}: {e}. "
                f"COMFYUI_OUTPUT_DIR must be reachable from this process — "
                f"if the wrapper runs in a different container than ComfyUI, "
                f"that directory needs to be a shared/mounted volume."
            ),
        )

    return {
        "status": "completed",
        "filename": filename,
        "url": f"{COMFYUI_PUBLIC_URL}/view?filename={filename}&subfolder=&type=output",
        "font_used": str(POSTER_FONT_PATH) if POSTER_FONT_PATH.is_file() else "PIL default (bundle a font for real use)",
    }


# ──────────────────────────────────────────────
#  Manual test endpoints
# ──────────────────────────────────────────────

@router.get("/test/generate-image", response_class=HTMLResponse)
async def test_generate_image_form():
    """A simple HTML form for manual testing of /generate-image."""
    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Generate Image - Manual Test</title>
<style>
  body { font-family: monospace; margin: 2em; background: #1a1a2e; color: #eee; }
  label { display:block; margin-top:.6em; font-weight:bold; }
  input, textarea, select { width:100%; padding:.4em; margin-top:.2em;
    background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; }
  button { margin-top:1.5em; padding:.6em 2em; background:#e94560;
    color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:1em; }
  button:hover { background:#c73e54; }
  #result { margin-top:1.5em; white-space:pre-wrap; background:#16213e;
    padding:1em; border-radius:4px; display:none; max-height:60vh; overflow:auto; }
</style>
</head>
<body>
<h2>🎨 Generate Image (Manual Test)</h2>
<form id="f">
  <label>Prompt
    <input name="prompt" value="Latina female with thick wavy hair, harbor boats and pastel houses behind. Breezy seaside light, warm tones, cinematic close-up.">
  </label>
  <label>Seed
    <input name="seed" type="number" value="614209039322779">
  </label>
  <label>Steps
    <input name="steps" type="number" value="8">
  </label>
  <label>CFG Scale
    <input name="cfg_scale" type="number" step="0.1" value="1.0">
  </label>
  <label>Width
    <input name="width" type="number" value="1024">
  </label>
  <label>Height
    <input name="height" type="number" value="1024">
  </label>
  <label>Checkpoint Name (UNet)
    <input name="ckpt_name" value="z_image_turbo_bf16.safetensors">
  </label>
  <label>CLIP Name
    <input name="clip_name" value="qwen_3_4b.safetensors">
  </label>
  <label>VAE Name
    <input name="vae_name" value="ae.safetensors">
  </label>
  <button type="submit">🚀 Submit</button>
</form>
<pre id="result"></pre>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  // Convert types
  body.seed = parseInt(body.seed);
  body.steps = parseInt(body.steps);
  body.cfg_scale = parseFloat(body.cfg_scale);
  body.width = parseInt(body.width);
  body.height = parseInt(body.height);

  const r = document.getElementById('result');
  r.style.display = 'block';
  r.textContent = 'Submitting...';
  try {
    const resp = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    r.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    r.textContent = 'Error: ' + err.message;
  }
});
</script>
</body>
</html>"""
    return HTMLResponse(content=html)


@router.get("/test/workflow-preview")
async def test_workflow_preview():
    """Return the raw workflow JSON for inspection."""
    try:
        with open(WORKFLOW_PATH_TXT2IMG, "r", encoding="utf-8") as f:
            workflow = json.load(f)
        return {
            "status": "ok",
            "node_count": len(workflow),
            "workflow": workflow,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read workflow: {e}")