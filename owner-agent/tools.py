"""The fixed tool allowlist — the only actions the owner-agent loop can ever
take. Each tool is a thin HTTP call onto one of backend/apis/agent.py's
already-real, already-RBAC-gated endpoints; nothing here reaches a
filesystem, a shell, or an arbitrary URL. See agent_loop.py for how the
model selects a tool; this module only defines what's selectable.

generate_landing_page is deliberately excluded — it takes an image upload,
which doesn't fit a text-command tool.

`path` may contain `{param}` placeholders (first used by
scan_crm_attachment below) — execute_tool() substitutes them from `args`
before making the request, and strips those keys out of what's actually
sent as the request body/query, so a tool's own description is the only
place the model needs to see the distinction between "goes in the URL"
and "goes in the body."
"""

import os
import re
from dataclasses import dataclass
from typing import Any, Literal

import httpx

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")

_PATH_PARAM_RE = re.compile(r"\{(\w+)\}")

# Poster generation submits a ComfyUI job and waits for it — matches
# apis/agent.py's own generate_poster, which budgets up to 180s for
# wait_for_completion plus overlay compositing.
_TOOL_CALL_TIMEOUT = 200.0


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    method: Literal["GET", "POST", "DELETE"]
    path: str


TOOL_REGISTRY: dict[str, ToolSpec] = {
    "generate_poster": ToolSpec(
        name="generate_poster",
        description=(
            'Generates a promotional image via a local Stable Diffusion pipeline. '
            'Args: {"prompt": "<image description>", "overlay_text": "<optional text '
            'to render on top>"}. Can take up to a few minutes.'
        ),
        method="POST",
        path="/api/agent/poster/generate",
    ),
    "crm_create_entry": ToolSpec(
        name="crm_create_entry",
        description=(
            'Records a captured lead/inquiry in this app\'s own database. Args: '
            '{"contact_email": "<email>", "summary": "<what they want>", "tags": ["<tag>", ...]}.'
        ),
        method="POST",
        path="/api/agent/crm/entries",
    ),
    "crm_list_entries": ToolSpec(
        name="crm_list_entries",
        description="Returns every CRM entry captured so far, most recent first. No arguments.",
        method="GET",
        path="/api/agent/crm/entries",
    ),
    "generate_report": ToolSpec(
        name="generate_report",
        description=(
            'Returns per-day chat session/message counts for a date range. Args: '
            '{"report_type": "chat-volume", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD"}. '
            'Keep ranges reasonable (a few weeks at most) unless explicitly asked for a longer span.'
        ),
        method="POST",
        path="/api/agent/reports/generate",
    ),
    "generate_geo_page": ToolSpec(
        name="generate_geo_page",
        description=(
            "Regenerates the company's public GEO/SEO profile page from currently-ingested "
            "documents and publishes it as a new version immediately. No arguments."
        ),
        method="POST",
        path="/api/agent/geo-page/generate",
    ),
    "scan_crm_attachment": ToolSpec(
        name="scan_crm_attachment",
        description=(
            "Runs a fresh AI analysis of a CRM entry's attached photo/document with your own custom "
            "instructions — use this when the automatic extraction that ran when the file was first "
            'attached wasn\'t enough, e.g. pulling a policy number and incident date off an insurance '
            'claim photo, or itemizing damage described in an attached estimate. Args: {"crm_id": '
            '<entry id, as a number>, "instructions": "<what to look for/extract>"}. The result is '
            "appended to that entry's analysis_notes, not returned as a one-off answer — check "
            "crm_list_entries afterward to see it. Fails if the entry has no attachment. Can take up to "
            "a couple of minutes for an image."
        ),
        method="POST",
        path="/api/agent/crm/entries/{crm_id}/scan",
    ),
    "crm_delete_entry": ToolSpec(
        name="crm_delete_entry",
        description=(
            'Permanently deletes a CRM entry (and its attached file, if any) — no undo. Use for '
            'spam/junk/test leads the owner explicitly wants removed, never speculatively. Args: '
            '{"crm_id": <entry id, as a number>}.'
        ),
        method="DELETE",
        path="/api/agent/crm/entries/{crm_id}",
    ),
    "cleanup_chat_uploads": ToolSpec(
        name="cleanup_chat_uploads",
        description=(
            "Scans the public chatbot's uploaded-file storage for files nothing references anymore "
            "(no CRM entry, no chat transcript) and deletes them — cleans up files from visitors who "
            'attached something but never sent the message, or whose message never became a real lead. '
            'Args (both optional): {"older_than_hours": <int, default 24 — how old an unreferenced file '
            'must be before it\'s touched>, "dry_run": <true to preview what would be deleted without '
            'actually deleting anything, default false>}.'
        ),
        method="POST",
        path="/api/agent/storage/cleanup-uploads",
    ),
}


def render_tools_for_prompt() -> str:
    lines = []
    for i, spec in enumerate(TOOL_REGISTRY.values(), start=1):
        lines.append(f"{i}. {spec.name} — {spec.description}")
    return "\n".join(lines)


async def execute_tool(spec: ToolSpec, args: dict, bearer_token: str) -> tuple[bool, Any]:
    """Never raises — a network/timeout failure becomes a {"error": ...}
    result the model sees in its next turn and can react to (retry, adjust,
    or give up gracefully), same as a backend 4xx/5xx does. The result
    itself isn't always a dict — crm_list_entries returns a JSON array."""
    path = spec.path
    remaining_args = dict(args)
    for param in _PATH_PARAM_RE.findall(path):
        if param not in remaining_args:
            return False, {"error": f"Missing required argument {param!r} for tool {spec.name!r}."}
        path = path.replace(f"{{{param}}}", str(remaining_args.pop(param)))

    try:
        async with httpx.AsyncClient(timeout=_TOOL_CALL_TIMEOUT) as client:
            resp = await client.request(
                spec.method,
                f"{BACKEND_URL}{path}",
                json=remaining_args if spec.method == "POST" else None,
                params=remaining_args if spec.method == "GET" else None,
                headers={"Authorization": f"Bearer {bearer_token}"},
            )
    except httpx.HTTPError as e:
        return False, {"error": f"Request to backend failed: {e}"}

    if resp.status_code >= 400:
        try:
            detail = resp.json()
        except ValueError:
            detail = resp.text[:500]
        return False, {"status": resp.status_code, "detail": detail}

    if resp.status_code == 204:
        return True, {"ok": True}  # e.g. crm_delete_entry — no response body to parse

    try:
        return True, resp.json()
    except ValueError:
        return True, {"raw": resp.text[:2000]}
