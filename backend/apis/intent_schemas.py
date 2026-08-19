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
from models import IntentField, IntentSchema, IntentView
from providers.base import ProviderNotConfigured

router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])

_VALID_FIELD_TYPES = {"text", "email", "phone", "date", "number", "note"}


class IntentFieldPayload(BaseModel):
    field_key: str
    label: str
    field_type: str = "text"
    required: bool = True
    prompt_hint: str | None = None


class IntentFieldSummary(IntentFieldPayload):
    id: int


class IntentSchemaPayload(BaseModel):
    key: str
    label: str
    description: str
    fields: list[IntentFieldPayload] = []


class IntentSchemaSummary(BaseModel):
    id: int
    key: str
    label: str
    description: str
    fields: list[IntentFieldSummary]
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
            )
            for f in row.fields
        ],
        created_at=row.created_at,
    )


@router.get("/agent/intent-schemas", response_model=list[IntentSchemaSummary])
def list_intent_schemas(db: Session = Depends(get_db)) -> list[IntentSchemaSummary]:
    rows = db.execute(select(IntentSchema).options(selectinload(IntentSchema.fields))).scalars().all()
    return [_to_summary(r) for r in rows]


@router.post("/agent/intent-schemas", response_model=IntentSchemaSummary)
def create_intent_schema(req: IntentSchemaPayload, db: Session = Depends(get_db)) -> IntentSchemaSummary:
    if not req.key.strip():
        raise HTTPException(status_code=400, detail="key must not be empty.")
    _validate_fields(req.fields)
    if db.execute(select(IntentSchema).where(IntentSchema.key == req.key)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"An intent schema with key {req.key!r} already exists.")

    row = IntentSchema(key=req.key, label=req.label, description=req.description)
    row.fields = [
        IntentField(
            field_key=f.field_key,
            label=f.label,
            field_type=f.field_type,
            required=f.required,
            prompt_hint=f.prompt_hint,
            sort_order=i,
        )
        for i, f in enumerate(req.fields)
    ]
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
    existing = db.execute(
        select(IntentSchema).where(IntentSchema.key == req.key, IntentSchema.id != schema_id)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail=f"Another intent schema already uses key {req.key!r}.")

    row.key = req.key
    row.label = req.label
    row.description = req.description
    # Whole-list replace (cascade="all, delete-orphan" on the relationship
    # handles removing whatever isn't in the new list) — simplest correct
    # semantics for "the owner edited the field list in a form and hit
    # save," no per-field diffing needed at this scale.
    row.fields = [
        IntentField(
            field_key=f.field_key,
            label=f.label,
            field_type=f.field_type,
            required=f.required,
            prompt_hint=f.prompt_hint,
            sort_order=i,
        )
        for i, f in enumerate(req.fields)
    ]
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
