"""Owner-facing marketing/CRM platform configuration + the real
per-entry sync action.

Mirrors `apis/notifications.py`'s pattern exactly, applied to
`backend/marketing.py`'s provider family — see that module's own
docstring for the full "why." One settings row, a provider picker,
write-only secrets, and — unlike notifications.py's ephemeral test-send
— a real "sync this lead" action, since there's no side-effect-free way
to "test" a platform whose whole job is upserting real contact records;
`POST .../crm/entries/{id}/sync-to-marketing` doubles as both the real
feature and its own verification step (sync a real or deliberately
throwaway test entry, see the credentials actually work)."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from apis.deps import Role, require_role
from db import get_db
from marketing import (
    HubSpotProvider,
    MailchimpProvider,
    MarketingProvider,
    MarketingProviderNotConfigured,
    TestMarketingProvider,
)
from models import AppSettings, CrmEntry

router = APIRouter(prefix="/agent", dependencies=[Depends(require_role(Role.admin, Role.owner))])


def resolve_marketing_provider(db: Session) -> tuple[str, MarketingProvider]:
    row = db.get(AppSettings, 1)
    name = (row.marketing_provider if row else None) or "test"
    if name == "mailchimp":
        if not row or not row.mailchimp_api_key or not row.mailchimp_audience_id:
            raise MarketingProviderNotConfigured(
                "Mailchimp is selected as the marketing provider but its API key/audience id aren't "
                "both configured yet — set them in the dashboard's Marketing settings."
            )
        return name, MailchimpProvider(row.mailchimp_api_key, row.mailchimp_audience_id)
    if name == "hubspot":
        if not row or not row.hubspot_access_token:
            raise MarketingProviderNotConfigured(
                "HubSpot is selected as the marketing provider but its access token isn't configured "
                "yet — set it in the dashboard's Marketing settings."
            )
        return name, HubSpotProvider(row.hubspot_access_token)
    return "test", TestMarketingProvider()


class MarketingSettings(BaseModel):
    marketing_provider: str
    mailchimp_audience_id: str | None
    # mailchimp_api_key / hubspot_access_token deliberately omitted —
    # write-only, never echoed back once saved, same rule
    # apis/notifications.py's mailgun_api_key/twilio_auth_token already
    # follow.
    mailchimp_api_key_set: bool
    hubspot_access_token_set: bool


@router.get("/marketing-settings", response_model=MarketingSettings)
def get_marketing_settings(db: Session = Depends(get_db)) -> MarketingSettings:
    row = db.get(AppSettings, 1)
    return MarketingSettings(
        marketing_provider=(row.marketing_provider if row else None) or "test",
        mailchimp_audience_id=row.mailchimp_audience_id if row else None,
        mailchimp_api_key_set=bool(row and row.mailchimp_api_key),
        hubspot_access_token_set=bool(row and row.hubspot_access_token),
    )


class UpdateMarketingSettingsRequest(BaseModel):
    marketing_provider: str
    mailchimp_audience_id: str | None = None
    # None = leave the previously-saved secret alone (matches
    # apis/notifications.py's mailgun_api_key semantics) — only send
    # this when the owner actually typed a new one.
    mailchimp_api_key: str | None = None
    hubspot_access_token: str | None = None


@router.put("/marketing-settings", response_model=MarketingSettings)
def update_marketing_settings(req: UpdateMarketingSettingsRequest, db: Session = Depends(get_db)) -> MarketingSettings:
    if req.marketing_provider not in ("test", "mailchimp", "hubspot"):
        raise HTTPException(
            status_code=400, detail=f"{req.marketing_provider!r} isn't a supported marketing provider."
        )
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    row.marketing_provider = req.marketing_provider
    row.mailchimp_audience_id = req.mailchimp_audience_id
    if req.mailchimp_api_key is not None:
        row.mailchimp_api_key = req.mailchimp_api_key or None
    if req.hubspot_access_token is not None:
        row.hubspot_access_token = req.hubspot_access_token or None
    db.commit()
    db.refresh(row)
    return MarketingSettings(
        marketing_provider=row.marketing_provider or "test",
        mailchimp_audience_id=row.mailchimp_audience_id,
        mailchimp_api_key_set=bool(row.mailchimp_api_key),
        hubspot_access_token_set=bool(row.hubspot_access_token),
    )


class SyncCrmEntryResponse(BaseModel):
    provider: str
    result: dict


@router.post("/crm/entries/{entry_id}/sync-to-marketing", response_model=SyncCrmEntryResponse)
async def sync_crm_entry_to_marketing(entry_id: int, db: Session = Depends(get_db)) -> SyncCrmEntryResponse:
    """Pushes one captured lead's contact info (email/name/phone/tags —
    see `marketing.py`'s provider classes for the exact field mapping)
    to the owner's configured marketing platform. Deterministic — the
    request body is built entirely in `marketing.py`'s own Python code,
    never by an LLM. Also reachable as the owner-agent's
    `sync_crm_entry_to_marketing` tool (owner-agent/tools.py), which
    calls this exact route rather than constructing its own request —
    the model only ever decides WHICH entry to sync, never how."""
    entry = db.query(CrmEntry).filter(CrmEntry.id == entry_id).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="CRM entry not found")
    try:
        name, provider = resolve_marketing_provider(db)
        result = await provider.sync_contact(entry)
    except MarketingProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    return SyncCrmEntryResponse(provider=name, result=result)
