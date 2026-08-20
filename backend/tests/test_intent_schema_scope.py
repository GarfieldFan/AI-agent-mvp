"""Live-LLM regression tests for how the chatbot decides what's "in
scope" — both for structured capture (does an out-of-scope request avoid
polluting a schema it doesn't belong to) and for the main conversational
reply (does it correctly claim/deny that the business offers something).

Two conversations shaped this file (2026-08-20):

1. "If the owner's business is only home insurance and a car-insurance
   visitor shows up, does the chatbot refuse them?" — verified: the
   structured-capture side already correctly declines to match.

2. A real manual test (the owner's own RAG documents describe a
   real-estate business; the DB also had insurance_application/
   insurance_claim schemas configured from earlier testing) surfaced that
   the *conversational reply* would say "insurance isn't our business"
   even though a matching schema existed — the schema's mere existence
   IS the owner's business-scope declaration and should win over RAG
   silence. Fixed by adding `_available_request_types_block` (unconditional
   whenever any schema exists) and rewording SYSTEM_PROMPT's scope-honesty
   instruction to treat a match against that block as authoritative.

These hit the REAL configured chat provider (whatever's set in
AppSettings) — matches this project's own established "verify against
the real thing" testing culture rather than mocking the LLM, so they're
slow (seconds-to-tens-of-seconds per call, model-dependent) and
technically non-deterministic (a real classification/generation call,
not a pure function) — marked `slow`, excluded from the default run,
execute explicitly with `pytest -m slow`.
"""

import pytest

from apis.chat import SYSTEM_PROMPT, _available_request_types_block, _lead_extraction_system_prompt
from apis.model_settings import resolve_chat_provider
from llm_json import parse_lenient_json
from models import IntentField, IntentSchema

pytestmark = pytest.mark.slow


def _narrow_home_insurance_schema() -> IntentSchema:
    """A transient (never persisted/committed) IntentSchema mirroring what
    an owner whose business is ONLY home insurance might configure —
    narrow enough that a car-insurance request shouldn't match it.
    Transient on purpose: the functions under test only ever read
    .key/.label/.description/.fields, so no DB row is needed to exercise
    the real prompt-building + classification logic against a controlled
    schema, without touching the shared dev DB's real seeded schemas
    (insurance_application/insurance_claim, which are deliberately
    generic and would make this specific scenario untestable as-is)."""
    schema = IntentSchema(
        key="home_insurance_application",
        label="Home insurance application",
        description=(
            "The visitor wants to apply for a NEW HOME/PROPERTY insurance policy specifically. "
            "This business only writes home/property insurance — NOT auto, car, life, health, "
            "or any other insurance type."
        ),
    )
    schema.fields = [
        IntentField(field_key="full_name", label="Full name", field_type="text", required=True, sort_order=0),
        IntentField(
            field_key="property_address", label="Property address", field_type="text", required=True, sort_order=1
        ),
    ]
    return schema


def _generic_insurance_schema() -> IntentSchema:
    """A transient schema covering ANY policy type — mirrors this dev
    DB's real `insurance_application` schema, kept transient here so this
    test doesn't depend on that row's exact wording surviving future
    edits."""
    schema = IntentSchema(
        key="insurance_application",
        label="Insurance application",
        description="The visitor wants to apply for a new insurance policy (any type — auto, home, life, etc.).",
    )
    schema.fields = [
        IntentField(field_key="full_name", label="Full name", field_type="text", required=True, sort_order=0),
        IntentField(
            field_key="desired_policy_type", label="Desired policy type", field_type="text", required=True, sort_order=1
        ),
    ]
    return schema


@pytest.mark.asyncio
async def test_out_of_scope_extraction_does_not_match_the_narrow_schema(db_session):
    """The structured-capture side: a car-insurance request against a
    home-insurance-only schema should NOT be classified as a lead for
    that schema. Locks in the (empirically confirmed 2026-08-20) current
    behavior so a future prompt-wording change can't silently start
    mis-capturing out-of-scope requests as real home-insurance leads."""
    provider = resolve_chat_provider(db_session)
    schema = _narrow_home_insurance_schema()
    message = "Hi, I'd like to get a quote for car insurance for my Honda Civic. My email is test@example.com."
    system = _lead_extraction_system_prompt(
        known_email=None, attachment_info=None, schemas=[schema], active_schema=None, active_entry=None
    )
    raw = await provider.chat([{"role": "user", "content": message}], system=system)
    parsed = parse_lenient_json(raw)

    matched_this_schema = bool(parsed.get("is_lead")) and parsed.get("schema_key") == schema.key
    assert not matched_this_schema, (
        f"a car-insurance request should not match the home-insurance-only schema, got: {parsed}"
    )


@pytest.mark.asyncio
async def test_main_reply_hedges_when_truly_out_of_scope(db_session):
    """The conversational-reply side, with NOTHING supporting the
    request — no RAG documents, no configured schemas at all (no
    `_available_request_types_block` prepended). The assistant should say
    it's not sure, not confidently claim yes. Documentation/smoke test,
    not a strict assertion — the reply is free-form prose — prints the
    actual reply so a human (or a future model swap) can eyeball whether
    SYSTEM_PROMPT's scope-honesty instruction is holding."""
    provider = resolve_chat_provider(db_session)
    message = "Hi, do you offer car insurance? I'd like a quote for my Honda Civic."
    reply = await provider.chat([{"role": "user", "content": message}], system=SYSTEM_PROMPT)
    print(f"\n--- main reply, nothing in context supports this request ---\n{reply}\n")
    assert reply.strip(), "should still produce some reply, not an empty string"


@pytest.mark.asyncio
async def test_reply_confidently_confirms_when_a_schema_matches_even_without_rag_support(db_session):
    """The real scenario that prompted this whole fix (2026-08-20): a
    business whose RAG documents describe something else entirely (real
    estate, in the actual manual test) but DOES have a matching
    IntentSchema configured. The schema's existence is itself the
    owner's business-scope declaration and must win over RAG silence —
    the reply should confirm it can help and start collecting info, NOT
    hedge with "not sure we offer that". No RAG content is injected here
    at all (simulates RAG being completely silent on insurance), only
    `_available_request_types_block`, to isolate that this block alone —
    not incidental RAG grounding — is what makes the difference."""
    provider = resolve_chat_provider(db_session)
    schema = _generic_insurance_schema()
    block = _available_request_types_block([schema])
    assert block is not None
    message = "Hi, do you offer auto insurance? I'd like a quote for my Honda Civic."
    user_content = f"{block}\n\nQuestion: {message}"
    reply = await provider.chat([{"role": "user", "content": user_content}], system=SYSTEM_PROMPT)
    print(f"\n--- main reply, schema matches but RAG is silent ---\n{reply}\n")
    hedged = "not sure" in reply.lower()
    assert not hedged, f"a schema-matched request should not be hedged on just because RAG is silent, got: {reply!r}"


@pytest.mark.asyncio
async def test_general_knowledge_question_is_not_hedged(db_session):
    """Regression check for the new scope-honesty instruction added
    2026-08-20 (see SYSTEM_PROMPT): it must only affect claims about
    what the business offers, not the existing "answer general questions
    directly, don't deflect" rule. A plain math question should still get
    a direct answer, not "I'm not sure that's something this business
    offers."."""
    provider = resolve_chat_provider(db_session)
    reply = await provider.chat([{"role": "user", "content": "What is 12 + 7?"}], system=SYSTEM_PROMPT)
    print(f"\n--- main reply for a general-knowledge question ---\n{reply}\n")
    assert "19" in reply, f"expected a direct answer containing 19, got: {reply!r}"


@pytest.mark.asyncio
async def test_wants_human_flag_is_extracted_when_explicitly_asked(db_session):
    """The human-handoff stub (models.CrmEntry.wants_human, 2026-08-20):
    the extraction call should set wants_human true when a visitor
    explicitly asks for a person, and false for an ordinary request that
    never mentions it — locks in both directions so a future prompt edit
    can't silently start over- or under-flagging."""
    provider = resolve_chat_provider(db_session)
    schema = _generic_insurance_schema()
    system = _lead_extraction_system_prompt(
        known_email=None, attachment_info=None, schemas=[schema], active_schema=None, active_entry=None
    )

    wants_human_message = (
        "I don't want to deal with a bot, can I please talk to a real person on your team? "
        "My email is test@example.com."
    )
    raw = await provider.chat([{"role": "user", "content": wants_human_message}], system=system)
    parsed = parse_lenient_json(raw)
    assert parsed.get("wants_human") is True, f"expected wants_human=True, got: {parsed}"

    ordinary_message = "I'd like to apply for auto insurance. My email is test2@example.com."
    raw2 = await provider.chat([{"role": "user", "content": ordinary_message}], system=system)
    parsed2 = parse_lenient_json(raw2)
    assert not parsed2.get("wants_human"), f"expected wants_human falsy for an ordinary request, got: {parsed2}"
