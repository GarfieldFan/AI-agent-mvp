"""Lenient JSON extraction from raw LLM chat output — shared by every
place in this backend that asks a model for a JSON-shaped answer
(apis/agent.py's landing-page/GEO-page generation, apis/chat.py's lead
extraction). Kept as one module so the same tolerance (stripped
<think> blocks, code fences, json_repair fallback) doesn't drift between
call sites.
"""

import json
import re

from json_repair import repair_json


def extract_json_object(text: str) -> str:
    """Best-effort cleanup of a model's raw output before json.loads().

    Handles two things models do despite being told not to: a "thinking"
    model prepending a <think>...</think> reasoning block, and models in
    general wrapping JSON in ```json fences. Falls back to slicing
    between the first '{' and the last '}' if neither pattern matches, so
    a merely-surrounded-by-prose response still has a chance to parse.
    """
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    fence_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if fence_match:
        return fence_match.group(1)

    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


def parse_lenient_json(raw_text: str) -> dict:
    """Parses a model's raw chat output as a JSON object, tolerating the
    near-miss formatting issues LLMs produce (unescaped control
    characters, trailing commas, unquoted keys, ...) via json_repair —
    tried only after strict parsing fails, never first, so a
    systematically broken prompt still surfaces a clear error instead of
    being silently papered over. Raises ValueError (with the strict parse
    error and raw text) if both strict parsing and repair fail, or the
    repaired result isn't a JSON object."""
    cleaned = extract_json_object(raw_text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as strict_error:
        try:
            parsed = repair_json(cleaned, return_objects=True)
        except Exception:
            parsed = None
        if not isinstance(parsed, dict):
            raise ValueError(
                f"Model did not return valid JSON ({strict_error}), and the automatic repair "
                f"couldn't fix it either. Raw output: {raw_text[:2000]}"
            )
        return parsed
