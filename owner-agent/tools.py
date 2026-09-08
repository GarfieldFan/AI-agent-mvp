"""The fixed tool allowlist — the only actions the owner-agent loop can ever
take. Each tool is a thin HTTP call onto one of backend/apis/agent.py's
already-real, already-RBAC-gated endpoints; nothing here reaches a
filesystem, a shell, or an arbitrary URL. See agent_loop.py for how the
model selects a tool; this module only defines what's selectable.

generate_landing_page (2026-08-19) takes an already-uploaded image's URL,
not raw base64 — asking the model to reproduce a whole image as base64
inside its own tool-call JSON would be neither reliable nor something a
text-generation model should be doing at all. The owner uploads a design
image via the dashboard's media library first, gets a URL back, then
tells owner-agent to use it; backend/apis/agent.py's
generate_landing_page_from_url does the actual URL-to-local-file
resolution (paranoid, mirrors chat_attachments.resolve_local_path) —
this tool is still just a plain HTTP call like every other one here,
image_url is a normal JSON string arg, no special-casing needed in
execute_tool below.

`list_intent_schemas`/`manage_review_queue` (2026-08-19) are the second
half of the "owner-configurable structured collection" framework (see
the root AGENTS.md and models.py's IntentSchema/IntentView docstrings)
— an owner describes a review/approval workflow in plain language
("I want to review insurance applications, approve or reject them") and
the model creates or updates an `IntentView` itself, rather than the
owner filling in another dashboard form. `manage_review_queue` upserts
by `schema_key`, so a follow-up command ("actually call the statuses X
instead") updates the same queue instead of creating a duplicate — this
run can't pause mid-execution to ask the owner a clarifying question
(see agent_loop.py's turn budget), so the tool's own description tells
the model to apply a sensible default and state the assumption in its
final answer instead.

`path` may contain `{param}` placeholders (first used by
scan_crm_attachment below) — execute_tool() substitutes them from `args`
before making the request, and strips those keys out of what's actually
sent as the request body/query, so a tool's own description is the only
place the model needs to see the distinction between "goes in the URL"
and "goes in the body."

`detect_business_type`/`propose_intent_schema` (2026-08-19) deliberately
DON'T follow manage_review_queue's "apply a default, let the owner
adjust afterward" pattern — propose_intent_schema only ever returns a
draft (backend/apis/intent_schemas.py's propose_intent_schema never
writes to the database), which the dashboard's OwnerAgentPanel renders
as an editable review form the owner must explicitly Apply. A schema
defines what data gets collected from real future visitors, a
meaningfully higher-stakes and harder-to-reverse change than a review
queue's status_options list, which is why this one pair gets a stricter
confirm-before-apply flow instead.

`propose_products` (2026-08-19, backend/apis/products.py) follows the
exact same propose-then-owner-applies posture as propose_intent_schema,
for the same reason applied to a different kind of mistake: a misread
price directly affects what a real customer gets quoted, so owner-agent
never writes a Product itself — see models.py's Product docstring.
`set_order_status_options`, by contrast, stays apply-directly like
manage_review_queue — a status-label list is cheap to adjust afterward,
same reasoning that already applies to review queues.
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
# wait_for_completion plus overlay compositing. Per-tool override below
# (ToolSpec.timeout) for tools that need more — landing-page generation
# is vision + a full page's worth of structured JSON, backend already
# budgets up to 600s for that single call (see providers/custom.py's
# timeout comment), so the default here would cut it off mid-generation.
_TOOL_CALL_TIMEOUT = 200.0


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    # PUT/PATCH added 2026-08-19 for set_order_status_options — found and
    # fixed a real bug adding it: execute_tool() below only ever attached
    # a JSON body for method == "POST", so a PUT tool call silently sent
    # an empty body and 422'd against the backend's own required-field
    # validation, discovered via a real owner-agent run, not a code read.
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str
    timeout: float = _TOOL_CALL_TIMEOUT


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
        description=(
            'Returns CRM entries, most recent first, as {"items": [...], "total": <count>}. No '
            "arguments needed — defaults to the 100 most recent entries, which covers \"every entry\" "
            'for a typical catalog; pass {"limit": <n>} for more if "total" says there are more than '
            "you got back."
        ),
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
    "list_intent_schemas": ToolSpec(
        name="list_intent_schemas",
        description=(
            "Returns every owner-configured intent schema (each has a key, label, description, and "
            "the list of fields it collects) — use this BEFORE manage_review_queue to find the exact "
            "schema_key that matches what the owner described, rather than guessing one. No arguments."
        ),
        method="GET",
        path="/api/agent/intent-schemas",
    ),
    "manage_review_queue": ToolSpec(
        name="manage_review_queue",
        description=(
            "Creates or updates a review queue for an intent schema's captured entries — use this when "
            "the owner describes wanting to track, review, or approve/reject entries of some kind that "
            "already has a matching intent schema (check with list_intent_schemas first; if nothing "
            "matches, tell the owner to create that schema in the dashboard first instead of guessing). "
            'Args: {"schema_key": "<an existing schema\'s key>", "name": "<short label for this queue>", '
            '"description": "<what it\'s for>", "status_options": ["<status>", ...]}. If the owner didn\'t '
            'say what statuses they want to track, default to ["pending", "approved", "rejected"] and say '
            "so plainly in your final answer — don't ask a follow-up question, since this run can't pause "
            "and wait for one; the owner can send another command to adjust the statuses afterward, which "
            "updates this same queue in place rather than creating a second one. Never creates a new "
            "intent schema itself — schemas are configured in the dashboard, not by this tool."
        ),
        method="POST",
        path="/api/agent/intent-views",
    ),
    "detect_business_type": ToolSpec(
        name="detect_business_type",
        description=(
            "Best-effort guess at what business/industry this SaaS instance is running, inferred "
            "from currently-ingested documents. Use this only if the owner hasn't directly told you "
            "what their business is — if they HAVE told you (even if it seems to contradict what the "
            "documents are about), always trust what the owner said over this tool's result. No "
            "arguments."
        ),
        method="GET",
        path="/api/agent/business-profile/detect",
    ),
    "propose_intent_schema": ToolSpec(
        name="propose_intent_schema",
        description=(
            "Drafts a new or updated intent schema for the owner to review — this NEVER creates or "
            "changes a real schema itself, it only returns a draft. Call list_intent_schemas first to "
            "check whether a schema with a matching key already exists, so your draft's key lines up "
            'and the owner sees it as an update rather than a duplicate. Args: {"key": "<stable id, e.g. '
            'insurance_claim>", "label": "<shown to the owner>", "description": "<when this schema '
            'applies>", "fields": [{"field_key": "<id>", "label": "<shown to the owner>", "field_type": '
            '"text|email|phone|date|number|note", "required": true, "prompt_hint": "<optional>"}]}. '
            "After calling this, tell the owner in your final answer that a draft is ready to review "
            "and apply themselves in the Owner agent panel — never claim the schema has already been "
            "created or changed."
        ),
        method="POST",
        path="/api/agent/intent-schemas/propose",
    ),
    "list_products": ToolSpec(
        name="list_products",
        description=(
            'Returns the owner\'s catalog (id, name, description, price, tags, available) as '
            '{"items": [...], "total": <count>} — use this BEFORE propose_products to check what '
            "already exists, so you don't re-propose something that's already there. No arguments "
            'needed — defaults to the 100 most recent products; pass {"limit": <n>} for more if '
            '"total" says there are more than you got back.'
        ),
        method="GET",
        path="/api/agent/products",
    ),
    "propose_products": ToolSpec(
        name="propose_products",
        description=(
            "Drafts one or more products for the owner to review — this NEVER creates or changes real "
            "products itself, it only returns a draft. Call list_products first to avoid re-proposing "
            'something that already exists. Args: {"products": [{"name": "<name>", "description": '
            '"<optional>", "price": <number>, "tags": ["<optional, e.g. \\"Coffee\\", plus a translation '
            'like \\"咖啡\\" if the business serves multi-lingual customers>"], "available": true}]}. '
            "Add multiple tags freely — a product can carry both a category-like tag and a translation, "
            "which is also what makes cross-lingual product search work. Get prices right — a real "
            "customer will be quoted whatever "
            "you propose once the owner applies it. After calling this, tell the owner a draft is ready "
            "to review in the Owner agent panel — never claim any product has already been created."
        ),
        method="POST",
        path="/api/agent/products/propose",
    ),
    "set_order_status_options": ToolSpec(
        name="set_order_status_options",
        description=(
            "Sets the list of order status labels available in the dashboard's order-management view "
            '(e.g. received/preparing/ready/delivered/paid/refunded). Args: {"status_options": '
            '["<status>", ...]}. If the owner didn\'t specify statuses, default to '
            '["received", "preparing", "ready", "delivered", "paid", "refunded"] and say so plainly in '
            "your final answer — this applies immediately (unlike propose_products), since a status-"
            "label list is cheap for the owner to adjust with a follow-up command."
        ),
        method="PUT",
        path="/api/agent/order-status-options",
    ),
    "generate_landing_page": ToolSpec(
        name="generate_landing_page",
        description=(
            "Turns an already-uploaded design image into a real page (vision LLM picks section types "
            "and fills in content, never raw HTML). The owner must have already uploaded the design "
            "image via the dashboard's media library or CTE's Upload tab — you need the URL that upload "
            'returned; ask for it if the owner hasn\'t given you one. Args: {"image_url": "<url from the '
            'media library>", "notes": "<optional tone/must-keep-copy notes>"}. This only returns the '
            "generated sections — it does NOT save/publish them; tell the owner to review and save it "
            "themselves via the Page generator panel if they want to keep it. Can take several minutes "
            "for a large local vision model."
        ),
        method="POST",
        path="/api/agent/landing-page/generate-from-url",
        timeout=620.0,
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
    "cleanup_stale_crm_entries": ToolSpec(
        name="cleanup_stale_crm_entries",
        description=(
            "Purges abandoned, never-engaged structured intake entries (a visitor's in-progress "
            'insurance claim, project inquiry, etc. that they never came back to finish) — only ever '
            'touches an entry whose status is still "new" (the owner hasn\'t started working it) and '
            "whose underlying conversation has gone cold past its own retention window (24h if almost "
            "nothing was collected yet, 7 days if real data was). Never touches an entry the owner has "
            'already contacted/closed, and never touches chat session/message history itself — only '
            'this app\'s own resumable-request rows. Args (optional): {"dry_run": <true to preview what '
            "would be deleted without actually deleting anything, default false>}."
        ),
        method="POST",
        path="/api/agent/crm/cleanup-stale-entries",
    ),
    "ingest_documents_from_url": ToolSpec(
        name="ingest_documents_from_url",
        description=(
            "Fetches one or more URLs and ingests each as a RAG knowledge-base document — a webpage's "
            "own main text is extracted automatically (ads/navigation/footers stripped), or a URL "
            "pointing directly at a PDF/DOCX is parsed the same way an upload would be. Runs in the "
            'background; each URL becomes its own document with pending/processing/ready/error status, '
            'visible in the dashboard\'s Document manager, not immediately in this call\'s own result. '
            'Args: {"url": "<a single URL>"} or {"url": ["<URL>", "<URL>", ...]} for a batch — both '
            "shapes are accepted. Use this when the owner wants to add a page/document by link instead "
            "of uploading a file themselves (e.g. a government regulation page). Optional: "
            '"is_company_material": <true/false, default true — false marks this as background '
            "reference material the business doesn't own (a law, a regulation), not a fact about the "
            'business itself>, "suggest_status_note": <true to have the model draft a short status '
            "note (e.g. \"repealed 2024, replaced by SB-123\") ONLY when the source text explicitly "
            "states its own status — never a guess; default false>."
        ),
        method="POST",
        path="/api/agent/documents/ingest-from-url",
    ),
    "list_scheduled_tasks": ToolSpec(
        name="list_scheduled_tasks",
        description=(
            "Lists every currently configured recurring scheduled task (name, task_type, cron_expression, "
            "enabled, last run result) — call this before manage_scheduled_task if the owner refers to an "
            'existing schedule ("change that daily sync to weekly instead") so you know its exact name '
            "rather than guessing."
        ),
        method="GET",
        path="/api/agent/scheduled-tasks",
    ),
    "manage_scheduled_task": ToolSpec(
        name="manage_scheduled_task",
        description=(
            "Creates or updates a recurring scheduled task by name — calling this again with the same "
            '"name" updates that same task in place rather than creating a duplicate, so a follow-up '
            'command like "run it every Monday instead" just works. Args: {"name": "<short label>", '
            '"task_type": "<one of: resync_url_document, reembed_all_documents, cleanup_chat_uploads, '
            'cleanup_stale_crm_entries>", "task_args": {<args that task_type needs — resync_url_document '
            'needs {"document_id": <int, from ingest_documents_from_url\'s or the Document manager\'s own '
            'result>, "suggest_status_note": <optional, true to re-run the status-note classification on '
            "every recurring re-sync, not just once>}; the other three take no required args, though "
            'cleanup_chat_uploads accepts an optional "older_than_hours">}, "cron_expression": '
            '"<standard 5-field cron, e.g. \'0 3 * * *\' '
            'for daily at 3am>", "enabled": <true/false, default true>}. If the owner doesn\'t specify a '
            "time, default to a reasonable off-peak hour (e.g. 3am) and say so plainly in your final "
            "answer rather than asking — this run can't pause for a follow-up question."
        ),
        method="POST",
        path="/api/agent/scheduled-tasks",
    ),
    "check_seo_schema": ToolSpec(
        name="check_seo_schema",
        description=(
            "Runs a read-only GEO/AI-discoverability health check against the live site: business "
            "profile (NAP) completeness, whether robots.txt allows the major AI crawlers (GPTBot, "
            "ClaudeBot, etc.), whether llms.txt and sitemap.xml are reachable, whether the homepage "
            "carries LocalBusiness structured data, and whether a sampled product page carries Product "
            'structured data. Returns {"items": [{"check", "label", "status": "ok"|"warning"|"error", '
            '"detail"}, ...]}. Diagnostic only — never changes anything; report warnings/errors to the '
            "owner in plain language (e.g. missing phone number in the business profile) rather than "
            "trying to fix them yourself, since every real fix here is a manual owner edit (dashboard "
            "settings), not something another tool can safely automate. No arguments."
        ),
        method="GET",
        path="/api/agent/seo/check",
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
    itself isn't always a dict — e.g. list_intent_schemas returns a JSON
    array. (crm_list_entries/list_products used to be array responses too,
    before 2026-08-20's pagination — now {"items": [...], "total": N}.)"""
    path = spec.path
    remaining_args = dict(args)
    for param in _PATH_PARAM_RE.findall(path):
        if param not in remaining_args:
            return False, {"error": f"Missing required argument {param!r} for tool {spec.name!r}."}
        path = path.replace(f"{{{param}}}", str(remaining_args.pop(param)))

    try:
        async with httpx.AsyncClient(timeout=spec.timeout) as client:
            resp = await client.request(
                spec.method,
                f"{BACKEND_URL}{path}",
                json=remaining_args if spec.method in ("POST", "PUT", "PATCH") else None,
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
