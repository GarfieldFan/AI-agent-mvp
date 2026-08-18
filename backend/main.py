import os
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

sys.path.append(str(Path(__file__).resolve().parent))

from apis.agent import router as agent_router
from apis.api import router as image_router
from apis.auth import router as auth_router
from apis.chat import router as chat_router
from apis.documents import router as documents_router
from apis.media import MEDIA_UPLOAD_DIR
from apis.media import router as media_router
from apis.model_settings import router as model_settings_router
from apis.pages import admin_router as pages_admin_router
from apis.pages import public_router as pages_public_router
from chat_attachments import CHAT_UPLOAD_DIR
from rate_limit import RateLimitMiddleware

app = FastAPI()

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
app.include_router(model_settings_router, prefix="/api")
app.include_router(media_router, prefix="/api")

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