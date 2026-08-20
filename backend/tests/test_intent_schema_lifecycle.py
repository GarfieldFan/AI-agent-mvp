"""What happens to related data when an owner deletes an IntentSchema —
the user asked directly (2026-08-20): "if I delete a schema, does the
[review] queue disappear? does the already-captured data disappear too?"
Answer, verified here against the real DB constraints (alembic/versions/
a7d3e9f1c5b2's crm_entries FK, c2e8b4d6f9a1's intent_views FK), not just
inferred from the migration files' intent: the queue (IntentView)
CASCADEs away, but a real captured CrmEntry survives with its
intent_schema_id set to NULL and collected_fields untouched — a
historical record is never silently deleted just because the owner later
removed/renamed the schema it came from (see apis/intent_schemas.py's
delete_intent_schema docstring).
"""

from models import CrmEntry, IntentField, IntentSchema, IntentView


def _make_schema(db, key: str, description: str) -> IntentSchema:
    schema = IntentSchema(key=key, label="Test schema", description=description)
    db.add(schema)
    db.flush()
    db.add(
        IntentField(
            intent_schema_id=schema.id, field_key="note", label="Note", field_type="text", required=False, sort_order=0
        )
    )
    db.flush()
    return schema


def test_deleting_schema_cascades_its_fields(db_session):
    schema = _make_schema(db_session, "test_delete_cascade_fields", "for the field-cascade test")
    field_id = db_session.query(IntentField).filter_by(intent_schema_id=schema.id).one().id

    db_session.delete(schema)
    db_session.flush()

    assert db_session.get(IntentField, field_id) is None


def test_deleting_schema_cascades_its_review_queue(db_session):
    schema = _make_schema(db_session, "test_delete_cascade_queue", "for the queue-cascade test")
    view = IntentView(
        intent_schema_id=schema.id, name="Test queue", description="test", status_options=["pending"]
    )
    db_session.add(view)
    db_session.flush()
    view_id = view.id

    db_session.delete(schema)
    db_session.flush()
    db_session.expire_all()  # the DB-level cascade delete happened outside the ORM's own tracking

    assert db_session.get(IntentView, view_id) is None, (
        "a schema's review queue should disappear along with it (ON DELETE CASCADE) — "
        "an orphaned queue pointing at a deleted schema would have nothing to show"
    )


def test_deleting_schema_keeps_crm_entries_but_clears_the_link(db_session):
    schema = _make_schema(db_session, "test_delete_keeps_entry", "for the SET NULL test")
    entry = CrmEntry(
        contact_email="test@example.com",
        summary="a real captured request",
        intent_schema_id=schema.id,
        collected_fields={"note": "already collected, must survive"},
    )
    db_session.add(entry)
    db_session.flush()
    entry_id = entry.id

    db_session.delete(schema)
    db_session.flush()
    db_session.expire_all()  # the DB-level SET NULL happened outside the ORM's own tracking

    survived = db_session.get(CrmEntry, entry_id)
    assert survived is not None, "a real captured lead must not be deleted just because its schema was later removed"
    assert survived.intent_schema_id is None
    assert survived.collected_fields == {"note": "already collected, must survive"}
