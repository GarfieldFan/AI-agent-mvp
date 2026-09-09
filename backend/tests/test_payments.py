"""Fast, deterministic tests for the payment-config visibility logic
added 2026-09-10 alongside Stripe's embedded Checkout (see
backend/payments.py's own docstring for the full design) — real,
new behavior worth locking in: a stale `stripe_publishable_key` left
over from a previous Stripe configuration must never leak out through
the PUBLIC `GET /api/payment-config` endpoint while `payment_provider`
is back on "test", since that endpoint has no auth gate at all.
"""

from apis.payments import get_payment_config
from models import AppSettings


def _settings_row(db):
    """This app's `AppSettings` is a singleton (id always 1) — the real
    dev DB already has a row, so mutate it in place rather than
    `db.add(AppSettings(id=1))`, which would collide on the primary key.
    Safe here since `db_session` rolls back the whole transaction after
    the test (see conftest.py's own docstring)."""
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
        db.flush()
    return row


def test_payment_config_hides_publishable_key_when_provider_is_test(db_session):
    row = _settings_row(db_session)
    row.payment_provider = "test"
    row.stripe_publishable_key = "pk_test_leftover_from_a_previous_stripe_setup"
    db_session.flush()

    result = get_payment_config(db_session)
    assert result.provider == "test"
    assert result.publishable_key is None, (
        "a stale publishable key from a previous Stripe configuration must never leak out "
        "of this public, no-auth endpoint while the provider is back on 'test'"
    )


def test_payment_config_exposes_publishable_key_when_provider_is_stripe(db_session):
    row = _settings_row(db_session)
    row.payment_provider = "stripe"
    row.stripe_publishable_key = "pk_test_real_looking_key"
    db_session.flush()

    result = get_payment_config(db_session)
    assert result.provider == "stripe"
    assert result.publishable_key == "pk_test_real_looking_key"
