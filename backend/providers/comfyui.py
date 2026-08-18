"""ComfyUI image-gen provider — the self-hosted option, and the default
(matches this project's original always-ComfyUI behavior when nothing's
been explicitly configured). Reuses `apis.api`'s existing workflow-
building and job-submission logic directly rather than duplicating it;
see that module's own functions for the ComfyUI-specific details (this
provider is deliberately a thin wrapper, not a reimplementation).

The *address* is owner-configurable here (AppSettings.image_comfyui_url
via the model picker) — ComfyUI has no universal "OpenAI-compatible" API
standard the way LLM backends do (different front-ends —
Automatic1111, InvokeAI, ComfyUI itself — all speak different APIs), so
unlike providers/custom.py's chat/embedding endpoint, "custom" here
specifically means "another ComfyUI instance," not an arbitrary SD API.

The *checkpoint* is owner-configurable too (2026-08-18,
`unet_name`/`clip_name`/`vae_name` below) — but only within this one
fixed workflow's own node shape (`UNETLoader` + separate `CLIPLoader` +
`VAELoader`, the z_image_turbo/Flux/SD3-style split-file layout — see
`apis/api.py`'s `_build_payload_txt2img`), not a free choice of any SD
architecture. A single-file SDXL/SD1.5-style checkpoint needs a
different node graph (`CheckpointLoaderSimple`) this workflow doesn't
have — swapping in a compatible unet/clip/vae trio (e.g. a different
Flux/SD3-family unet) works via these three fields; a fundamentally
different architecture doesn't, by design (kept the scope to what one
workflow file can actually express).

An owner can also bring an entirely different graph (2026-08-19,
`custom_workflow`/`prompt_node`/`prompt_field` below) — the owner pastes
ComfyUI's own "Save (API Format)" export (any checkpoint architecture,
any node layout) via the model picker, and this provider submits it
as-is, only splicing the generation prompt into one designated node's
input field first. When set, this REPLACES `_build_payload_txt2img` +
the unet/clip/vae fields entirely (not layered together — a pasted
workflow already specifies its own checkpoint/sampler/etc., so this
project's own defaults would just be dead weight). Only the prompt text
is wired up this round, not seed/width/height/etc. — those come from
whatever the pasted workflow already has baked in.
"""

import copy
import uuid

import httpx
from fastapi import HTTPException

from apis.api import (
    COMFYUI_PUBLIC_URL,
    COMFYUI_URL,
    _build_payload_txt2img,
    _wait_for_completion_impl,
)
from providers.base import normalize_loopback_host


class ComfyUIImageProvider:
    name = "comfyui"

    def __init__(
        self,
        base_url: str = COMFYUI_URL,
        public_url: str = COMFYUI_PUBLIC_URL,
        ws_url: str | None = None,
        unet_name: str | None = None,
        clip_name: str | None = None,
        vae_name: str | None = None,
        custom_workflow: dict | None = None,
        prompt_node: str | None = None,
        prompt_field: str | None = None,
    ):
        # base_url is what an admin actually types (from their own
        # machine's point of view) — normalize localhost/127.0.0.1 to
        # host.docker.internal the same way providers/custom.py's chat
        # endpoint does; public_url stays exactly as typed (the browser
        # needs to reach it from the user's own machine, same reasoning
        # apis/api.py's COMFYUI_URL-vs-COMFYUI_PUBLIC_URL split already
        # documents). ws_url is derived from base_url when not given
        # explicitly (http(s) -> ws(s), + /ws) — only the env-var default
        # path ever passes one in, to keep that case byte-for-byte
        # unchanged.
        self.base_url = normalize_loopback_host(base_url)
        self.public_url = public_url.rstrip("/")
        if ws_url is not None:
            self.ws_url = ws_url
        else:
            self.ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        # None means "use _build_payload_txt2img's own default" — only
        # override the kwarg when the owner actually picked something.
        self.unet_name = unet_name
        self.clip_name = clip_name
        self.vae_name = vae_name
        self.custom_workflow = custom_workflow
        self.prompt_node = prompt_node
        self.prompt_field = prompt_field or "text"

    def _build_custom_payload(self, prompt: str) -> dict:
        # Deep-copy: this provider (and thus this dict) can be reused
        # across multiple generate() calls — mutating the owner's stored
        # workflow in place would corrupt every generation after the
        # first with whatever prompt happened to run before it.
        workflow = copy.deepcopy(self.custom_workflow)
        node = workflow.get(self.prompt_node) if self.prompt_node else None
        if not isinstance(node, dict) or "inputs" not in node:
            raise HTTPException(
                status_code=422,
                detail=f"Prompt node {self.prompt_node!r} not found in the configured custom workflow.",
            )
        node["inputs"][self.prompt_field] = prompt
        return {"prompt": workflow, "client_id": str(uuid.uuid4())}

    async def generate(self, prompt: str) -> tuple[str, bytes]:
        if self.custom_workflow is not None:
            payload = self._build_custom_payload(prompt)
        else:
            overrides = {
                k: v
                for k, v in (
                    ("ckpt_name", self.unet_name),
                    ("clip_name", self.clip_name),
                    ("vae_name", self.vae_name),
                )
                if v
            }
            payload = _build_payload_txt2img(prompt=prompt, **overrides)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(f"{self.base_url}/prompt", json=payload)
                resp.raise_for_status()
                submit_result = resp.json()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Failed to reach ComfyUI at {self.base_url}: {e}")

        if submit_result.get("node_errors"):
            raise HTTPException(status_code=422, detail={"node_errors": submit_result["node_errors"]})
        prompt_id = submit_result.get("prompt_id")
        if not prompt_id:
            raise HTTPException(status_code=502, detail=f"ComfyUI did not return a prompt_id: {submit_result}")

        # Budget minutes, not seconds — same as every other generation
        # workload in this codebase (see providers/*.py's chat timeouts).
        outcome = await _wait_for_completion_impl(
            prompt_id, timeout=180.0, base_url=self.base_url, public_url=self.public_url, ws_url=self.ws_url
        )
        if outcome["status"] != "completed":
            raise HTTPException(status_code=502, detail=f"Image generation did not complete: {outcome}")

        image_url = outcome["images"][0]["url"]

        # image_url is built from self.public_url (browser-facing) —
        # correct for the browser, unreachable from inside this backend
        # container. Same class of fix apis/agent.py's old generate_poster
        # already needed for its own overlay-fetch step: swap in
        # self.base_url for this server-side fetch only.
        internal_image_url = image_url.replace(self.public_url, self.base_url, 1)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                img_resp = await client.get(internal_image_url)
                img_resp.raise_for_status()
                image_bytes = img_resp.content
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Image generated but failed to fetch it back: {e}")

        return image_url, image_bytes
