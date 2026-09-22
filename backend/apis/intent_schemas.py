"""Owner-configurable "intent schemas" (2026-08-19) — admin/owner CRUD for
the structured field lists apis/chat.py's automatic lead-capture pipeline
uses to collect information conversationally. See models.py's
`IntentSchema`/`IntentField` docstrings for the full design rationale:
this generalizes CrmEntry's old fixed category enum
(appointment/quote/claim/inquiry) into something any vertical (insurance,
real estate, a clinic, a restaurant, ...) can define for itself — the
owner fills in a structured form here, apis/chat.py reads it back to
decide what to ask a visitor for and when to stop asking.

Also owns `IntentView` CRUD (2026-08-19, second half of this file) — the
follow-on layer, see models.py's IntentView docstring. Views are meant
to be created by owner-agent's `manage_review_queue` tool
(owner-agent/tools.py) from a plain-language request, applied directly
with a sensible default and no owner confirmation step (a queue's
status_options is cheap to adjust afterward) — this router just exposes
the deterministic CRUD underneath, same trust boundary as every other
owner-agent tool (a real bearer token, re-checked here).

Schemas themselves (create_intent_schema/update_intent_schema above) are
still only ever written by the owner's own direct dashboard action, even
though owner-agent CAN now draft one — see propose_intent_schema below
and owner-agent/tools.py's module docstring: it returns a draft only,
never constructs or commits a row, specifically because a schema
controls what data gets collected from real future visitors, a
meaningfully higher-stakes, harder-to-reverse change than a review
queue's status list.

Same admin/owner gate as backend/apis/documents.py and backend/apis/agent.py.
"""

from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from apis.agent import _gather_ready_document_text
from apis.deps import Role, require_role
from apis.model_settings import resolve_chat_provider
from db import get_db
from llm_json import parse_lenient_json
from models import IntentField, IntentSchema, IntentView
from providers.base import ProviderNotConfigured

router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()

_VALID_FIELD_TYPES = {"text", "email", "phone", "date", "number", "note", "select"}


class IntentFieldOption(BaseModel):
    """A select field's own choice — {label, value} mirrors frontend/src/
    lib/types.ts's ChatOption shape, the other structured-choice contract
    this app already has, so a displayed label ("Australia") can differ
    from its stored value ("AU")."""

    label: str
    value: str


class IntentFieldPayload(BaseModel):
    field_key: str
    label: str
    field_type: str = "text"
    required: bool = True
    prompt_hint: str | None = None
    options: list[IntentFieldOption] | None = None


class IntentFieldSummary(IntentFieldPayload):
    id: int


# StructuredIntakeForm's template shape (2026-09-22, see models.py's
# IntentSchema.form_template docstring) — a section-grouped layout over
# an already-defined field list. `items` references fields by field_key
# only (never duplicates type/required/options — IntentField stays the
# single source of truth for those), plus optional static "label" items
# for inline instructional text that isn't a real collected field.
class FormTemplateItem(BaseModel):
    kind: str  # "field" | "label"
    field_key: str | None = None  # required when kind == "field"
    text: str | None = None  # required when kind == "label"


class FormTemplateSection(BaseModel):
    title: str
    subtitle: str | None = None
    description: str | None = None
    items: list[FormTemplateItem] = []


class FormTemplate(BaseModel):
    title: str
    subtitle: str | None = None
    description: str | None = None
    sections: list[FormTemplateSection] = []


class IntentSchemaPayload(BaseModel):
    key: str
    label: str
    description: str
    fields: list[IntentFieldPayload] = []
    form_template: FormTemplate | None = None


class IntentSchemaSummary(BaseModel):
    id: int
    key: str
    label: str
    description: str
    fields: list[IntentFieldSummary]
    form_template: FormTemplate | None
    created_at: datetime


def _validate_fields(fields: list[IntentFieldPayload]) -> None:
    seen: set[str] = set()
    for f in fields:
        if not f.field_key.strip():
            raise HTTPException(status_code=400, detail="Every field needs a non-empty field_key.")
        if f.field_key in seen:
            raise HTTPException(status_code=400, detail=f"Duplicate field_key {f.field_key!r} in this schema.")
        seen.add(f.field_key)
        if f.field_type not in _VALID_FIELD_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"{f.field_type!r} isn't a supported field_type — use one of {sorted(_VALID_FIELD_TYPES)}.",
            )
        if f.field_type == "select" and not f.options:
            raise HTTPException(
                status_code=400, detail=f"Field {f.field_key!r} is a select — it needs at least one option."
            )


def _validate_form_template(template: FormTemplate | None, fields: list[IntentFieldPayload]) -> None:
    """Server-side sanity check before a template is ever saved — never
    trusts a caller (owner-typed edit, or an AI-drafted proposal the
    owner may have hand-edited) to only reference real fields. A
    field-kind item pointing at an unknown field_key, or a label-kind
    item with no text, both 400 immediately rather than silently
    rendering broken on the next visitor's page load."""
    if template is None:
        return
    valid_keys = {f.field_key for f in fields}
    for section in template.sections:
        if not section.title.strip():
            raise HTTPException(status_code=400, detail="Every form section needs a non-empty title.")
        for item in section.items:
            if item.kind == "field":
                if not item.field_key or item.field_key not in valid_keys:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Form section {section.title!r} references unknown field_key {item.field_key!r}.",
                    )
            elif item.kind == "label":
                if not item.text or not item.text.strip():
                    raise HTTPException(status_code=400, detail="A label item needs non-empty text.")
            else:
                raise HTTPException(status_code=400, detail=f"{item.kind!r} isn't a supported item kind.")


def _to_summary(row: IntentSchema) -> IntentSchemaSummary:
    return IntentSchemaSummary(
        id=row.id,
        key=row.key,
        label=row.label,
        description=row.description,
        fields=[
            IntentFieldSummary(
                id=f.id,
                field_key=f.field_key,
                label=f.label,
                field_type=f.field_type,
                required=f.required,
                prompt_hint=f.prompt_hint,
                options=[IntentFieldOption(**o) for o in f.options] if f.options else None,
            )
            for f in row.fields
        ],
        form_template=FormTemplate(**row.form_template) if row.form_template else None,
        created_at=row.created_at,
    )


@router.get("/agent/intent-schemas", response_model=list[IntentSchemaSummary])
def list_intent_schemas(db: Session = Depends(get_db)) -> list[IntentSchemaSummary]:
    rows = db.execute(select(IntentSchema).options(selectinload(IntentSchema.fields))).scalars().all()
    return [_to_summary(r) for r in rows]


def _to_field_rows(fields: list[IntentFieldPayload]) -> list[IntentField]:
    return [
        IntentField(
            field_key=f.field_key,
            label=f.label,
            field_type=f.field_type,
            required=f.required,
            prompt_hint=f.prompt_hint,
            options=[o.model_dump() for o in f.options] if f.options else None,
            sort_order=i,
        )
        for i, f in enumerate(fields)
    ]


@router.post("/agent/intent-schemas", response_model=IntentSchemaSummary)
def create_intent_schema(req: IntentSchemaPayload, db: Session = Depends(get_db)) -> IntentSchemaSummary:
    if not req.key.strip():
        raise HTTPException(status_code=400, detail="key must not be empty.")
    _validate_fields(req.fields)
    _validate_form_template(req.form_template, req.fields)
    if db.execute(select(IntentSchema).where(IntentSchema.key == req.key)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"An intent schema with key {req.key!r} already exists.")

    row = IntentSchema(
        key=req.key,
        label=req.label,
        description=req.description,
        form_template=req.form_template.model_dump() if req.form_template else None,
    )
    row.fields = _to_field_rows(req.fields)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_summary(row)


@router.put("/agent/intent-schemas/{schema_id}", response_model=IntentSchemaSummary)
def update_intent_schema(
    schema_id: int, req: IntentSchemaPayload, db: Session = Depends(get_db)
) -> IntentSchemaSummary:
    row = db.get(IntentSchema, schema_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Intent schema not found.")
    _validate_fields(req.fields)
    _validate_form_template(req.form_template, req.fields)
    existing = db.execute(
        select(IntentSchema).where(IntentSchema.key == req.key, IntentSchema.id != schema_id)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail=f"Another intent schema already uses key {req.key!r}.")

    row.key = req.key
    row.label = req.label
    row.description = req.description
    row.form_template = req.form_template.model_dump() if req.form_template else None
    # Whole-list replace (cascade="all, delete-orphan" on the relationship
    # handles removing whatever isn't in the new list) — simplest correct
    # semantics for "the owner edited the field list in a form and hit
    # save," no per-field diffing needed at this scale.
    row.fields = _to_field_rows(req.fields)
    db.commit()
    db.refresh(row)
    return _to_summary(row)


@router.put("/agent/intent-schemas/{schema_id}/form-template", response_model=IntentSchemaSummary)
def set_form_template(
    schema_id: int, req: FormTemplate | None = None, db: Session = Depends(get_db)
) -> IntentSchemaSummary:
    """Saves ONLY the form_template, without resending the whole field
    list — what the dashboard's "Apply"/"Save form layout" action calls
    after the owner reviews an AI-proposed (or hand-edited) template.
    `req: None` (an empty/null body) clears the form entirely, reverting
    this schema to conversational-only collection."""
    row = db.get(IntentSchema, schema_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Intent schema not found.")
    payload_fields = [
        IntentFieldPayload(
            field_key=f.field_key,
            label=f.label,
            field_type=f.field_type,
            required=f.required,
            prompt_hint=f.prompt_hint,
            options=[IntentFieldOption(**o) for o in f.options] if f.options else None,
        )
        for f in row.fields
    ]
    _validate_form_template(req, payload_fields)
    row.form_template = req.model_dump() if req else None
    db.commit()
    db.refresh(row)
    return _to_summary(row)


@router.delete("/agent/intent-schemas/{schema_id}", status_code=204)
def delete_intent_schema(schema_id: int, db: Session = Depends(get_db)) -> None:
    """No undo, matches crm_delete_entry's posture. Any CrmEntry rows that
    reference this schema keep their collected_fields (a historical
    record of what was actually captured) — the FK is ON DELETE SET NULL,
    not a cascade, so a real captured lead is never silently deleted just
    because an owner later removed/renamed its schema."""
    row = db.get(IntentSchema, schema_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Intent schema not found.")
    db.delete(row)
    db.commit()


_BUSINESS_TYPE_SYSTEM_PROMPT = (
    "You are given raw text extracted from a company's own documents. In one short phrase "
    "(a few words, not a sentence), name the kind of business or industry these documents "
    "suggest — e.g. \"residential real estate brokerage\", \"auto insurance\", \"family dental "
    "clinic\". Reply with the phrase only, no punctuation, no preamble."
)


class DetectBusinessTypeResponse(BaseModel):
    detected_label: str | None


@router.post("/agent/business-profile/detect", response_model=DetectBusinessTypeResponse)
async def detect_business_type(db: Session = Depends(get_db)) -> DetectBusinessTypeResponse:
    """Best-effort guess at what business this SaaS instance is running,
    inferred from currently-ingested RAG documents — owner-agent's
    detect_business_type tool calls this when the owner hasn't directly
    stated their business type. This is only ever a starting point: the
    owner's own explicit statement always takes priority over this
    result, a rule enforced by the calling model's own reasoning (this
    tool's description says so), not by this endpoint. Degrades to
    detected_label: null (not an error) when there are no ready
    documents to infer from, same posture as every other RAG-adjacent
    feature in this codebase."""
    doc_text, doc_count = _gather_ready_document_text(db)
    if doc_count == 0:
        return DetectBusinessTypeResponse(detected_label=None)

    messages = [{"role": "user", "content": f"Here is the source document text:\n\n{doc_text}"}]
    try:
        provider = resolve_chat_provider(db)
        raw_content = await provider.chat(messages, system=_BUSINESS_TYPE_SYSTEM_PROMPT)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")

    label = raw_content.strip().strip('"').strip(".")
    return DetectBusinessTypeResponse(detected_label=label or None)


class ProposeIntentSchemaResponse(BaseModel):
    # Named proposed_schema, not `schema` — that name shadows a
    # deprecated BaseModel method in Pydantic v2 and warns on every use.
    proposed_schema: IntentSchemaPayload
    already_exists: bool
    existing_id: int | None


@router.post("/agent/intent-schemas/propose", response_model=ProposeIntentSchemaResponse)
def propose_intent_schema(req: IntentSchemaPayload, db: Session = Depends(get_db)) -> ProposeIntentSchemaResponse:
    """Validates a draft schema exactly like create/update would, but
    never writes it — owner-agent's propose_intent_schema tool calls
    this so a schema change always goes through an explicit owner
    Apply/Discard in the dashboard (OwnerAgentPanel) instead of being
    written directly by the agent loop. See the root AGENTS.md's "Owner
    agent" section for why this tool proposes while manage_review_queue
    (a lower-stakes change) still applies directly."""
    if not req.key.strip():
        raise HTTPException(status_code=400, detail="key must not be empty.")
    _validate_fields(req.fields)
    existing = db.execute(select(IntentSchema).where(IntentSchema.key == req.key)).scalar_one_or_none()
    return ProposeIntentSchemaResponse(
        proposed_schema=req,
        already_exists=existing is not None,
        existing_id=existing.id if existing else None,
    )


_FORM_TEMPLATE_SYSTEM_PROMPT = (
    "You are given a list of fields an intake form needs to collect, for a form modeled on things like "
    "a government tax-return form, a visa application, or an event-registration flow — grouped into "
    "logical sections (e.g. Personal details, Address, Family) so a visitor doesn't face one long "
    "overwhelming page. You must reference ONLY the field_key values given to you — never invent a new "
    "one. Every given field_key must appear in exactly one section's items. You may also add short "
    "'label' items (kind: \"label\") between fields within a section for brief instructional text (e.g. "
    "\"We'll use this to verify your identity.\") — these are optional and never required.\n\n"
    "Respond with ONLY a single JSON object, no markdown fences, no commentary before or after it:\n"
    '{"title": "<form title>", "subtitle": "<short subtitle, or null>", "description": "<one short '
    'sentence about the form, or null>", "sections": [{"title": "<section title>", "subtitle": '
    '"<or null>", "description": "<or null>", "items": [{"kind": "field", "field_key": "<one of the '
    'given field_keys>"} , {"kind": "label", "text": "<short instructional text>"}, ...]}]}\n\n'
    "Aim for 3-6 fields per section where the field count allows it — split into more sections rather "
    "than one long one. Keep section/subtitle/description text short and plain."
)


class ProposeFormTemplateResponse(BaseModel):
    proposed_template: FormTemplate


@router.post("/agent/intent-schemas/{schema_id}/propose-form-template", response_model=ProposeFormTemplateResponse)
async def propose_form_template(schema_id: int, db: Session = Depends(get_db)) -> ProposeFormTemplateResponse:
    """Drafts a section-grouped form_template for an already-existing
    schema's own fields — never writes it (mirrors propose_intent_schema
    above): the owner reviews/edits the draft in the dashboard, then
    PUTs it via set_form_template above to actually apply it. Runs once,
    on request — never regenerated per visitor (see models.py's
    IntentSchema.form_template docstring)."""
    row = db.get(IntentSchema, schema_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Intent schema not found.")
    if not row.fields:
        raise HTTPException(status_code=400, detail="This schema has no fields yet — add some fields first.")

    field_lines = "\n".join(
        f'- field_key "{f.field_key}" ({f.label}, {f.field_type}{", required" if f.required else ", optional"})'
        for f in row.fields
    )
    messages = [
        {
            "role": "user",
            "content": f'Form: "{row.label}" — {row.description}\n\nFields to place into sections:\n{field_lines}',
        }
    ]
    try:
        provider = resolve_chat_provider(db)
        raw = await provider.chat(messages, system=_FORM_TEMPLATE_SYSTEM_PROMPT)
    except ProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Chat provider request failed: {e}")

    parsed = parse_lenient_json(raw)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="The model didn't return a usable form layout — try again.")
    try:
        template = FormTemplate(**parsed)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"The model's form layout didn't match the expected shape: {e}")

    payload_fields = [
        IntentFieldPayload(
            field_key=f.field_key,
            label=f.label,
            field_type=f.field_type,
            required=f.required,
            prompt_hint=f.prompt_hint,
            options=[IntentFieldOption(**o) for o in f.options] if f.options else None,
        )
        for f in row.fields
    ]
    # A hallucinated/missing field_key here would otherwise only surface
    # as a broken render on the owner's review screen — reject it now
    # with a clear reason instead.
    _validate_form_template(template, payload_fields)
    referenced = {
        item.field_key for section in template.sections for item in section.items if item.kind == "field"
    }
    missing = [f.field_key for f in row.fields if f.field_key not in referenced]
    if missing:
        raise HTTPException(
            status_code=502,
            detail=f"The model's form layout left out these fields: {', '.join(missing)} — try again.",
        )
    return ProposeFormTemplateResponse(proposed_template=template)


class PublicFieldOut(BaseModel):
    field_key: str
    label: str
    field_type: str
    required: bool
    prompt_hint: str | None
    options: list[IntentFieldOption] | None


class PublicIntentFormResponse(BaseModel):
    key: str
    label: str
    description: str
    fields: list[PublicFieldOut]
    form_template: FormTemplate | None


@public_router.get("/intent-schemas/{key}/form", response_model=PublicIntentFormResponse)
def get_public_intent_form(key: str, db: Session = Depends(get_db)) -> PublicIntentFormResponse:
    """Public, no-auth read — what StructuredIntakeForm (frontend) fetches
    to render either a standalone page/CTE-Block form or a chat-embedded
    one. `form_template: null` means this schema has no upfront-form
    layout configured yet (still fine to collect conversationally via the
    ordinary chat flow); the frontend renders an empty/unavailable state
    rather than erroring."""
    row = db.execute(
        select(IntentSchema).options(selectinload(IntentSchema.fields)).where(IntentSchema.key == key)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"No intent schema with key {key!r}.")
    return PublicIntentFormResponse(
        key=row.key,
        label=row.label,
        description=row.description,
        fields=[
            PublicFieldOut(
                field_key=f.field_key,
                label=f.label,
                field_type=f.field_type,
                required=f.required,
                prompt_hint=f.prompt_hint,
                options=[IntentFieldOption(**o) for o in f.options] if f.options else None,
            )
            for f in row.fields
        ],
        form_template=FormTemplate(**row.form_template) if row.form_template else None,
    )


# --- IntentView ("review queue") CRUD --------------------------------


class IntentViewPayload(BaseModel):
    schema_key: str
    name: str
    description: str
    status_options: list[str] = []


class IntentViewSummary(BaseModel):
    id: int
    intent_schema_id: int
    schema_key: str
    schema_label: str
    name: str
    description: str
    status_options: list[str]
    fields: list[IntentFieldSummary]
    created_at: datetime


def _view_summary(row: IntentView) -> IntentViewSummary:
    return IntentViewSummary(
        id=row.id,
        intent_schema_id=row.intent_schema_id,
        schema_key=row.intent_schema.key,
        schema_label=row.intent_schema.label,
        name=row.name,
        description=row.description,
        status_options=row.status_options,
        fields=[
            IntentFieldSummary(
                id=f.id,
                field_key=f.field_key,
                label=f.label,
                field_type=f.field_type,
                required=f.required,
                prompt_hint=f.prompt_hint,
            )
            for f in row.intent_schema.fields
        ],
        created_at=row.created_at,
    )


@router.get("/agent/intent-views", response_model=list[IntentViewSummary])
def list_intent_views(db: Session = Depends(get_db)) -> list[IntentViewSummary]:
    rows = (
        db.execute(
            select(IntentView).options(
                selectinload(IntentView.intent_schema).selectinload(IntentSchema.fields)
            )
        )
        .scalars()
        .all()
    )
    return [_view_summary(r) for r in rows]


@router.post("/agent/intent-views", response_model=IntentViewSummary)
def upsert_intent_view(req: IntentViewPayload, db: Session = Depends(get_db)) -> IntentViewSummary:
    """Create-or-update by schema_key, not a plain create — see
    models.py's IntentView docstring for why: this is what lets an owner
    (or owner-agent, on their behalf) adjust an already-generated queue
    with a follow-up request ("actually call it 'waitlisted' not
    'pending'") without needing to know or track a numeric view id
    across separate owner-agent runs."""
    schema = db.execute(select(IntentSchema).where(IntentSchema.key == req.schema_key)).scalar_one_or_none()
    if schema is None:
        raise HTTPException(
            status_code=404,
            detail=f"No intent schema with key {req.schema_key!r} — create it in the dashboard's "
            "Intent schemas panel first.",
        )

    row = db.execute(select(IntentView).where(IntentView.intent_schema_id == schema.id)).scalar_one_or_none()
    if row is None:
        row = IntentView(intent_schema_id=schema.id)
        db.add(row)
    row.name = req.name
    row.description = req.description
    row.status_options = req.status_options or ["pending", "approved", "rejected"]
    db.commit()
    db.refresh(row)
    return _view_summary(row)


@router.delete("/agent/intent-views/{view_id}", status_code=204)
def delete_intent_view(view_id: int, db: Session = Depends(get_db)) -> None:
    row = db.get(IntentView, view_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Review queue not found.")
    db.delete(row)
    db.commit()
