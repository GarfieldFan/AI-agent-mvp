"""Fast, deterministic tests for `_apply_lead_capture` — the DB half of
lead capture, split out from the LLM-calling half specifically so it CAN
be tested without a real model call (see apis/chat.py's
`_lead_extraction_call`/`_apply_lead_capture` split, 2026-08-20). Feeds
it an already-parsed dict directly, the same shape `_lead_extraction_call`
would hand it after a real classification call.
"""

from apis.chat import _apply_lead_capture
from models import CrmEntry


def test_apply_lead_capture_persists_wants_human(db_session):
    """The human-handoff stub (models.CrmEntry.wants_human, 2026-08-20) —
    a fresh CrmEntry should pick up wants_human=True from the parsed
    extraction result. Uses the no-schema fallback path (schemas=[]),
    the simplest one that still exercises the field."""
    parsed = {
        "is_lead": True,
        "category": "inquiry",
        "contact_email": "wants-human-test@example.com",
        "summary": "Wants to talk to a person.",
        "wants_human": True,
    }
    _apply_lead_capture(db_session, parsed, message="please connect me to a human", schemas=[])
    db_session.flush()

    entry = (
        db_session.query(CrmEntry).filter_by(contact_email="wants-human-test@example.com").one()
    )
    assert entry.wants_human is True


def test_apply_lead_capture_defaults_wants_human_false(db_session):
    """The other direction — an ordinary lead with no wants_human in the
    parsed result (or explicitly false) should not get flagged."""
    parsed = {
        "is_lead": True,
        "category": "quote",
        "contact_email": "ordinary-test@example.com",
        "summary": "Wants a quote.",
    }
    _apply_lead_capture(db_session, parsed, message="can I get a quote", schemas=[])
    db_session.flush()

    entry = db_session.query(CrmEntry).filter_by(contact_email="ordinary-test@example.com").one()
    assert entry.wants_human is False


def test_apply_lead_capture_uses_message_fallback_for_summary(db_session):
    """Regression test for a real bug found 2026-08-20: `_apply_lead_capture`
    used to reference a `message` variable that wasn't one of its own
    parameters (a leftover from before it was split out of the combined
    `_maybe_capture_lead`) — a NameError that would only surface, and
    crash the request, on the rare turn where the model omitted
    "summary" from its JSON output. `message` is now a real parameter,
    used as the summary fallback exactly as the docstring always claimed."""
    parsed = {
        "is_lead": True,
        "category": "inquiry",
        "contact_email": "summary-fallback-test@example.com",
        # no "summary" key at all — must not raise, must fall back to `message`
    }
    _apply_lead_capture(
        db_session, parsed, message="this exact text should become the summary", schemas=[]
    )
    db_session.flush()

    entry = (
        db_session.query(CrmEntry).filter_by(contact_email="summary-fallback-test@example.com").one()
    )
    assert entry.summary == "this exact text should become the summary"
