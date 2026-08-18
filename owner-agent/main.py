"""Owner Agent — the first real implementation of the isolated-worker
principle documented in the repo root AGENTS.md ("Agent execution must
eventually be isolated"). Runs as its own container (docker-compose service
`owner-agent`), separate from the public-facing `backend` process.

Its only capability is a fixed allowlist of 8 tool calls onto backend's
already-RBAC-gated REST endpoints (see tools.py) — no DB connection, no
filesystem access beyond its own code/logs, no shell, no arbitrary-URL
fetch tool. The caller's own bearer token is forwarded on every backend
call, so backend's own require_role independently re-authorizes every real
action too, not just this service's own front-door check (deps.py).

Explicitly NOT wired to the user's personal openclaw instance — see root
AGENTS.md's Phase 6 note for why.
"""

import os

from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from agent_loop import RunResult, run_owner_agent
from deps import require_owner
from logging_ import log_step

app = FastAPI()

CORS_ALLOW_ORIGINS = os.environ.get("CORS_ALLOW_ORIGINS", "http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


class RunRequest(BaseModel):
    command: str


class StepResponse(BaseModel):
    index: int
    type: str
    thought: str | None = None
    tool: str | None = None
    args: dict = {}
    # Not always a dict — crm_list_entries' backend endpoint returns a JSON
    # array, passed through unchanged from agent_loop.StepRecord.
    result: Any = None
    ok: bool | None = None
    text: str | None = None


class RunResponse(BaseModel):
    final_answer: str
    stopped_reason: str
    steps: list[StepResponse]


@app.post("/run", response_model=RunResponse)
async def run(req: RunRequest, bearer_token: str = Depends(require_owner)) -> RunResponse:
    command = req.command.strip()
    if not command:
        raise HTTPException(status_code=400, detail="command must not be empty")

    def on_step(step):
        log_step(command, step)

    result: RunResult = await run_owner_agent(command, bearer_token, on_step=on_step)

    return RunResponse(
        final_answer=result.final_answer,
        stopped_reason=result.stopped_reason,
        steps=[StepResponse(**vars(s)) for s in result.steps],
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8100)
