"""Marketing/CRM platform sync (2026-09-21) — same "swappable, not
hardcoded" pattern as payments.py/notifications.py, applied to a fifth
capability domain: pushing a captured lead (`CrmEntry`) out to a
third-party marketing/CRM platform the owner already uses (Mailchimp/
HubSpot), rather than only ever living in this app's own internal
`CrmEntry` table (see that model's own docstring — this is the exact
extension point it always anticipated).

Confirmed directly with the user before building: this is a
DETERMINISTIC, code-level sync — no LLM ever constructs the outbound
API request. `owner-agent`'s `sync_crm_entry_to_marketing` tool (see
owner-agent/tools.py) only ever decides WHETHER/WHICH entry to sync, by
calling the exact same `POST /agent/crm/entries/{id}/sync-to-marketing`
route (apis/marketing.py) a human admin's own "Sync to marketing
platform" button in `CrmPanel` calls — the model never sees, let alone
builds, a Mailchimp/HubSpot request body. Mapping a lead to "worth
following up on" / drafting outreach copy is a legitimately good LLM
task; the wire-protocol part is not, and isn't one here.

Two real providers, plain `httpx` (same "no vendor SDK needed, this is
a simple REST call" reasoning as notifications.py's Mailgun/Twilio — no
security-critical inbound-webhook-signature concern here, this module
only ever sends outbound):

- `MailchimpProvider` — upserts a list/audience member via Mailchimp's
  own idiomatic PUT-to-upsert pattern (Marketing API v3).
- `HubSpotProvider` — upserts a contact via HubSpot's own batch/upsert
  endpoint (CRM API v3), a single-item batch — HubSpot's documented way
  to avoid a separate search-then-create-or-update round trip.

`TestMarketingProvider` (default, `marketing_provider` null/"test") is a
pure no-op, matching every other provider family's own "give the owner
choices, don't force config before anything works" default."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Protocol

import httpx

if TYPE_CHECKING:
    from models import CrmEntry


class MarketingProviderNotConfigured(Exception):
    """Mirrors PaymentProviderNotConfigured/NotificationProviderNotConfigured
    — raised when a real provider is selected but missing the
    credentials it needs (or genuinely rejects a request), so the API
    boundary can turn it into a clean 503 instead of a raw exception."""


class MarketingProvider(Protocol):
    async def sync_contact(self, entry: "CrmEntry") -> dict: ...


class TestMarketingProvider:
    """No real sync — the default, so nothing in this app requires a
    marketing-platform account to keep working. Deliberately returns an
    obviously-inert result rather than pretending to sync anything, same
    posture as TestEmailProvider/TestSMSProvider."""

    async def sync_contact(self, entry: "CrmEntry") -> dict:
        return {"synced": False}


def _split_name(contact_name: str | None) -> tuple[str, str]:
    """Best-effort first/last name split — neither vendor's API models a
    single "full name" field the way this app's own CrmEntry.contact_name
    does, so this is a real, disclosed approximation: a one-word name
    becomes just a first name; anything with 2+ words puts everything
    after the first word into "last name." No attempt at a smarter
    split (suffixes, multi-word surnames, ...) — same "store what's
    there, don't over-parse" posture as `Order.pickup_time` elsewhere in
    this app."""
    if not contact_name or not contact_name.strip():
        return "", ""
    parts = contact_name.strip().split(None, 1)
    return parts[0], parts[1] if len(parts) > 1 else ""


class MailchimpProvider:
    """Mailchimp Marketing API v3 — `PUT /lists/{audience_id}/members/
    {subscriber_hash}` upserts a member by the MD5 hash of their
    lowercased email, Mailchimp's own idiomatic "no separate create vs.
    update call" pattern. The API key's own suffix (after the last "-")
    names the account's datacenter, which the base URL must be built
    from (`https://{dc}.api.mailchimp.com`) — a real, easy-to-miss
    requirement confirmed against Mailchimp's own docs before building,
    not assumed."""

    def __init__(self, api_key: str, audience_id: str):
        self.api_key = api_key
        self.audience_id = audience_id
        self.datacenter = api_key.rsplit("-", 1)[-1] if "-" in api_key else ""

    async def sync_contact(self, entry: "CrmEntry") -> dict:
        if not self.datacenter:
            raise MarketingProviderNotConfigured(
                "This Mailchimp API key doesn't look valid — expected a '...-usXX'-style suffix "
                "naming the account's datacenter."
            )
        first_name, last_name = _split_name(entry.contact_name)
        subscriber_hash = hashlib.md5(entry.contact_email.strip().lower().encode()).hexdigest()
        tags = list(entry.tags or [])
        if entry.category and entry.category not in tags:
            tags.append(entry.category)
        body = {
            "email_address": entry.contact_email,
            "status_if_new": "subscribed",
            "merge_fields": {"FNAME": first_name, "LNAME": last_name},
            "tags": tags,
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.put(
                f"https://{self.datacenter}.api.mailchimp.com/3.0/lists/{self.audience_id}/members/{subscriber_hash}",
                auth=("anystring", self.api_key),
                json=body,
            )
        if resp.status_code >= 400:
            raise MarketingProviderNotConfigured(f"Mailchimp rejected the sync request: {resp.text[:300]}")
        data = resp.json()
        return {"id": data.get("id"), "status": data.get("status")}


class HubSpotProvider:
    """HubSpot CRM API v3 — the batch/upsert endpoint with a single
    input, matching by email (`idProperty: "email"`), creates or
    updates the contact in one call, no separate search-then-branch
    needed (HubSpot's own documented recommendation over the older
    create/PATCH-by-id endpoints). Bearer auth with a private app's
    access token (HubSpot's modern auth method — the older API-key auth
    is deprecated, not implemented here)."""

    def __init__(self, access_token: str):
        self.access_token = access_token

    async def sync_contact(self, entry: "CrmEntry") -> dict:
        first_name, last_name = _split_name(entry.contact_name)
        properties: dict[str, str] = {"email": entry.contact_email, "firstname": first_name, "lastname": last_name}
        if entry.contact_phone:
            properties["phone"] = entry.contact_phone
        body = {"inputs": [{"id": entry.contact_email, "idProperty": "email", "properties": properties}]}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert",
                headers={"Authorization": f"Bearer {self.access_token}"},
                json=body,
            )
        if resp.status_code >= 400:
            raise MarketingProviderNotConfigured(f"HubSpot rejected the sync request: {resp.text[:300]}")
        data = resp.json()
        results = data.get("results") or [{}]
        return {"id": results[0].get("id")}
