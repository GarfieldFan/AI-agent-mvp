"""Action logging for the owner-agent loop. Deliberately a bind-mounted
JSON-lines file, not a Postgres table — this service is stateless/DB-less
by design (see main.py's module docstring), so a durable-but-simple file is
the cheapest thing that's still greppable across container restarts,
without adding a DB dependency to a worker whose whole point is a minimal
blast radius. Named logging_ to avoid shadowing the stdlib `logging` module.

Never logs the bearer token — every step is tool name/args/result only.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

LOG_DIR = Path(os.environ.get("OWNER_AGENT_LOG_DIR", "logs"))
LOG_FILE = LOG_DIR / "runs.jsonl"


def log_step(command: str, step) -> None:
    """`step` is an agent_loop.StepRecord. Called once per completed step
    (not once per run) so a step is durably recorded the moment it happens,
    not only if the whole run eventually finishes."""
    record = {
        "logged_at": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "index": step.index,
        "type": step.type,
        "thought": step.thought,
        "tool": step.tool,
        "args": step.args,
        "result": step.result,
        "ok": step.ok,
        "text": step.text,
    }
    line = json.dumps(record, ensure_ascii=False)
    print(f"[owner-agent] {line}", flush=True)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
