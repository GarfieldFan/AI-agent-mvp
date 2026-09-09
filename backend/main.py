import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

sys.path.append(str(Path(__file__).resolve().parent))

from apis.agent import router as agent_router
from apis.api import router as image_router
from apis.auth import router as auth_router
from apis.business_profile import admin_router as business_profile_admin_router
from apis.business_profile import public_router as business_profile_public_router
from apis.chat import router as chat_router
from apis.chat_sessions import router as chat_sessions_router
from apis.chat_settings import router as chat_settings_router
from apis.contact import router as contact_router
from apis.documents import router as documents_router
from apis.error_log import router as error_log_router
from apis.intent_schemas import router as intent_schemas_router
from apis.media import MEDIA_UPLOAD_DIR
from apis.media import router as media_router
from apis.crm_resume import router as crm_resume_router
from apis.maps import admin_router as maps_admin_router
from apis.maps import public_router as maps_public_router
from apis.model_settings import router as model_settings_router
from apis.my_account import router as my_account_router
from apis.notifications import router as notifications_router
from apis.oauth import admin_router as oauth_admin_router
from apis.oauth import public_router as oauth_public_router
from apis.ollama_admin import router as ollama_admin_router
from apis.pages import admin_router as pages_admin_router
from apis.pages import public_router as pages_public_router
from apis.payments import admin_router as payments_admin_router
from apis.payments import public_router as payments_public_router
from apis.products import admin_router as products_admin_router
from apis.products import public_router as products_public_router
from apis.scheduled_tasks import router as scheduled_tasks_router
from apis.seo_audit import admin_router as seo_audit_router
from apis.turnstile_settings import admin_router as turnstile_admin_router
from apis.turnstile_settings import public_router as turnstile_public_router
from apis.users import router as users_router
from chat_attachments import CHAT_UPLOAD_DIR
from error_alerts import unhandled_exception_handler
from rate_limit import RateLimitMiddleware
from migrate import run_migrations_with_retry
from scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Runs `alembic upgrade head` automatically (2026-09-09) — see
    # migrate.py's own docstring for why: a non-technical owner can't be
    # expected to run a migration command by hand. Must happen before
    # anything else touches the DB.
    run_migrations_with_retry()
    # Starts scheduler.py's in-process APScheduler (2026-08-21) — loads
    # every enabled ScheduledTask row and registers its cron job. See
    # scheduler.py's own module docstring for the full design, including
    # the dev-mode --reload restart note.
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(lifespan=lifespan)

# Basic error logging + email-on-severe-error (2026-09-09, error_alerts.py)
# — only ever reaches a genuinely UNHANDLED exception; every deliberate
# `raise HTTPException(...)` elsewhere in this codebase is handled by
# Starlette's own dedicated handler and never lands here. See that
# module's own docstring for the full "why."
app.add_exception_handler(Exception, unhandled_exception_handler)

# The frontend runs on a different port (:3000 vs :8000) so browser calls
# from it are cross-origin. Comma-separated so a deployed frontend origin
# can be added later without code changes.
CORS_ALLOW_ORIGINS = os.environ.get("CORS_ALLOW_ORIGINS", "http://localhost:3000").split(",")

# Order matters here, and it's the opposite of what it looks like: Starlette
# wraps the *most recently added* middleware as the *outermost* layer (see
# Starlette's Router.build_middleware_stack — user_middleware is built via
# insert(0, ...), then wrapped in reversed order). RateLimitMiddleware is
# added first so CORSMiddleware (added second) ends up outermost, wrapping
# even a 429 short-circuited by the rate limiter — added the other way
# around, a rate-limited browser request would come back with no CORS
# headers at all and surface as an opaque CORS failure instead of a
# readable 429 in the frontend.
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(image_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(agent_router, prefix="/api")
app.include_router(pages_admin_router, prefix="/api")
app.include_router(pages_public_router, prefix="/api")
app.include_router(auth_router, prefix="/api")
app.include_router(documents_router, prefix="/api")
app.include_router(intent_schemas_router, prefix="/api")
app.include_router(products_admin_router, prefix="/api")
app.include_router(products_public_router, prefix="/api")
app.include_router(model_settings_router, prefix="/api")
app.include_router(media_router, prefix="/api")
app.include_router(payments_admin_router, prefix="/api")
app.include_router(payments_public_router, prefix="/api")
app.include_router(notifications_router, prefix="/api")
app.include_router(crm_resume_router, prefix="/api")
app.include_router(maps_admin_router, prefix="/api")
app.include_router(maps_public_router, prefix="/api")
app.include_router(business_profile_admin_router, prefix="/api")
app.include_router(business_profile_public_router, prefix="/api")
app.include_router(chat_sessions_router, prefix="/api")
app.include_router(chat_settings_router, prefix="/api")
app.include_router(oauth_admin_router, prefix="/api")
app.include_router(oauth_public_router, prefix="/api")
app.include_router(my_account_router, prefix="/api")
app.include_router(scheduled_tasks_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(seo_audit_router, prefix="/api")
app.include_router(contact_router, prefix="/api")
app.include_router(error_log_router, prefix="/api")
app.include_router(turnstile_admin_router, prefix="/api")
app.include_router(turnstile_public_router, prefix="/api")
app.include_router(ollama_admin_router, prefix="/api")

# Serves apis/media.py's uploaded images back out — publicly readable by
# filename (no RBAC), same as ComfyUI's own /view endpoint for generated
# images. Uploading is still admin/owner-gated (see media_router above);
# only *reading* a known filename is open, and a filename alone isn't
# guessable/listable without the (gated) GET /api/agent/media endpoint.
MEDIA_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/media/uploads", StaticFiles(directory=str(MEDIA_UPLOAD_DIR)), name="media-uploads")

# Serves apis/chat.py's POST /chat/upload attachments back out — same
# "publicly readable by filename, not listable" shape as the media mount
# above. Filenames are random uuid4s (never the client-supplied name), so
# this is safe to leave open even though the upload endpoint itself has
# no auth gate at all.
CHAT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/chat/uploads", StaticFiles(directory=str(CHAT_UPLOAD_DIR)), name="chat-uploads")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000)