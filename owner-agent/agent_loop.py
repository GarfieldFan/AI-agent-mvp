"""The tool-calling loop itself.

Deliberately NOT a model's native OpenAI-style tools/tool_calls param —
support for that varies across models, and this loop's "brain" isn't
fixed to any one model (see _backend_chat below). Instead, a manual
JSON-envelope format: the system prompt asks the model to reply with one
JSON object per turn, parsed the same lenient way backend/apis/agent.py
already does for its vision/GEO page generation (strip <think> blocks and
code fences, then fall back to json_repair.repair_json on a strict-parse
failure) — a proven pattern in this exact codebase, and one that works with
any chat-capable model, not just ones with a function-calling template.
"""

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from json_repair import repair_json

from tools import BACKEND_URL, TOOL_REGISTRY, execute_tool, render_tools_for_prompt

MAX_ITERATIONS = 6
# Checked only *between* turns (the loop below), not while a _backend_chat
# call is in flight — that call has its own 600s httpx timeout to give a
# slow local model room to finish (see _backend_chat), which can itself
# exceed this "budget." Not new: even the old fixed-120s-per-call version
# could already blow past 300s total across up to 6 turns; this just
# makes an already-loose budget more visibly loose, not categorically so.
RUN_TIMEOUT_SECONDS = 300.0

SYSTEM_PROMPT_TEMPLATE = """You are the owner's operations agent for this company's internal admin \
dashboard. The owner has typed a command; your job is to decide which of the following tools (if any) \
to call, in what order, with what arguments, to fulfill it — then report back.

You are currently running on: {model_identity}. If the owner asks what model/provider you are, state \
this plainly and accurately — don't deflect or be vague about it. They need this to make real decisions \
(e.g. switching providers if this one is too slow); hiding it would work against them, not for them.

Available tools:
{tools}

On every turn, respond with ONLY one JSON object — no markdown fences, no commentary before or after:
  To call a tool:   {{"thought": "<brief reason>", "action": "tool_call", "tool": "<name>", "args": {{...}}}}
  To finish:        {{"thought": "<brief reason>", "action": "final_answer", "text": "<answer for the owner>"}}

Rules:
- Never invent a tool name outside the ones listed above.
- If a tool call fails, the next message will contain the error — decide whether to retry with \
corrected arguments, try a different tool, or give up and explain the failure in your final_answer. \
Do not repeat the exact same failing call twice.
- You have at most {max_iterations} turns total. If you're near that limit, stop and give a \
final_answer summarizing what you accomplished, even if incomplete.
- Output ONLY the JSON object described above."""


@dataclass
class StepRecord:
    index: int
    type: Literal["tool_call", "final_answer", "parse_error"]
    thought: str | None = None
    tool: str | None = None
    args: dict = field(default_factory=dict)
    # Not always a dict — crm_list_entries' backend endpoint returns a JSON
    # array, and execute_tool() passes whatever backend returned through
    # unchanged.
    result: Any = None
    ok: bool | None = None
    text: str | None = None


@dataclass
class RunResult:
    final_answer: str
    stopped_reason: Literal["final_answer", "max_iterations", "timeout"]
    steps: list[StepRecord]


def _extract_json_object(text: str) -> str:
    """Same cleanup as backend/apis/agent.py's helper of the same name:
    strips a <think>...</think> block and ```json fences some local models
    emit despite being told not to, falling back to slicing between the
    first '{' and the last '}'."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    fence_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if fence_match:
        return fence_match.group(1)

    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


def _parse_envelope(raw: str) -> dict | None:
    cleaned = _extract_json_object(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        try:
            parsed = repair_json(cleaned, return_objects=True)
        except Exception:
            return None
    return parsed if isinstance(parsed, dict) else None


async def _backend_chat(messages: list[dict], system: str, bearer_token: str) -> str:
    """The loop's "brain" call — proxies onto backend's
    POST /agent/chat-completion (apis/agent.py), which resolves whatever
    chat_provider/chat_model the owner has actually picked in the
    dashboard (apis/model_settings.py's resolve_chat_provider), the same
    way every one of this loop's 8 tool calls already resolves through
    backend rather than acting directly. This is deliberate, not
    incidental: this project is about giving the owner a choice of
    provider, not this worker silently making that choice for them by
    being hardcoded to one vendor — an owner-agent that only ever spoke
    to Ollama regardless of what was configured elsewhere contradicted
    that. Forwards the caller's own bearer token, same as tools.py's
    execute_tool — backend's require_role independently re-authorizes
    this the same way it does every tool call."""
    async with httpx.AsyncClient(timeout=600) as client:
        resp = await client.post(
            f"{BACKEND_URL}/api/agent/chat-completion",
            json={"messages": messages, "system": system, "json_mode": True},
            headers={"Authorization": f"Bearer {bearer_token}"},
        )
        resp.raise_for_status()
        data = resp.json()
    return data["reply"]


async def _current_model_identity(bearer_token: str) -> str:
    """`"{chat_provider}/{chat_model}"` — fetched fresh per run (not
    cached) so it's always accurate even if the owner just changed it in
    ModelSettingsPanel. Baked into the system prompt (not left for the
    model to guess/hallucinate about its own deployment, which no LLM can
    actually introspect) so a direct "what model are you" question gets a
    true answer — see SYSTEM_PROMPT_TEMPLATE. Falls back to "unknown"
    rather than failing the whole run over what's fundamentally a
    nice-to-have."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{BACKEND_URL}/api/agent/settings", headers={"Authorization": f"Bearer {bearer_token}"}
            )
            resp.raise_for_status()
            data = resp.json()
        return f"{data['chat_provider']}/{data['chat_model']}"
    except (httpx.HTTPError, KeyError):
        return "unknown"


async def run_owner_agent(command: str, bearer_token: str, on_step=None) -> RunResult:
    """on_step, if given, is called with each StepRecord as it completes —
    main.py wires this to logging_.log_step so a step is durably logged the
    moment it happens, not only once the whole run finishes."""
    model_identity = await _current_model_identity(bearer_token)
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        tools=render_tools_for_prompt(), max_iterations=MAX_ITERATIONS, model_identity=model_identity
    )
    conversation: list[dict] = [{"role": "user", "content": f"Owner command: {command}"}]
    steps: list[StepRecord] = []
    start = time.monotonic()

    for i in range(1, MAX_ITERATIONS + 1):
        if time.monotonic() - start > RUN_TIMEOUT_SECONDS:
            return RunResult("Stopped: exceeded the run's time budget.", "timeout", steps)

        raw = await _backend_chat(conversation, system=system_prompt, bearer_token=bearer_token)
        envelope = _parse_envelope(raw)

        if envelope is None or envelope.get("action") not in ("tool_call", "final_answer"):
            step = StepRecord(index=i, type="parse_error", text=raw[:2000])
            steps.append(step)
            if on_step:
                on_step(step)
            conversation += [
                {"role": "assistant", "content": raw},
                {
                    "role": "user",
                    "content": 'Invalid response. Reply again with ONLY the required JSON envelope '
                    '("action": "tool_call" or "final_answer").',
                },
            ]
            continue

        if envelope["action"] == "final_answer":
            text = str(envelope.get("text", ""))
            step = StepRecord(index=i, type="final_answer", thought=envelope.get("thought"), text=text)
            steps.append(step)
            if on_step:
                on_step(step)
            return RunResult(text, "final_answer", steps)

        tool_name = envelope.get("tool")
        args = envelope.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        spec = TOOL_REGISTRY.get(tool_name)
        if spec is None:
            ok, result = False, {"error": f"Unknown tool {tool_name!r}. Valid tools: {list(TOOL_REGISTRY)}"}
        else:
            ok, result = await execute_tool(spec, args, bearer_token)

        step = StepRecord(
            index=i,
            type="tool_call",
            thought=envelope.get("thought"),
            tool=tool_name,
            args=args,
            result=result,
            ok=ok,
        )
        steps.append(step)
        if on_step:
            on_step(step)

        conversation += [
            {"role": "assistant", "content": raw},
            {"role": "user", "content": f"Tool result: {json.dumps(result)[:4000]}"},
        ]

    return RunResult(
        "Stopped after the maximum number of steps without a final answer — see the step trace.",
        "max_iterations",
        steps,
    )
