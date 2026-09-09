"""Fast, deterministic tests for `_build_triage_control` (2026-09-09,
apis/chat.py) — the function that turns `_intent_triage_call`'s raw,
model-produced JSON into the real `ChatControlOut` the frontend renders.
Never trusts the model's `control_type`/`options` shape blindly; these
tests lock in the degrade-to-"text" safety net that was verified by hand
during the session that built it but never captured as a permanent
regression test."""

from apis.chat import ChatOptionOut, _build_triage_control


def test_build_triage_control_passes_through_a_well_formed_radio_control():
    triage = {
        "control_type": "radio",
        "options": [{"label": "File a claim", "value": "claim"}, {"label": "Something else", "value": "other"}],
    }
    control = _build_triage_control(triage)
    assert control.type == "radio"
    assert control.options == [
        ChatOptionOut(label="File a claim", value="claim"),
        ChatOptionOut(label="Something else", value="other"),
    ]


def test_build_triage_control_degrades_unrecognized_type_to_text():
    control = _build_triage_control({"control_type": "dropdown", "options": None})
    assert control.type == "text"
    assert control.options is None


def test_build_triage_control_degrades_radio_with_no_options_to_text():
    """A model that says "radio" but gives zero usable options would
    otherwise render a broken control with nothing to click."""
    control = _build_triage_control({"control_type": "radio", "options": []})
    assert control.type == "text"
    assert control.options is None


def test_build_triage_control_drops_malformed_options_and_keeps_the_rest():
    triage = {
        "control_type": "checkbox",
        "options": [
            {"label": "Valid", "value": "valid"},
            {"label": "Missing value"},  # malformed — no "value" key
            {"value": "missing-label"},  # malformed — no "label" key
        ],
    }
    control = _build_triage_control(triage)
    assert control.type == "checkbox"
    assert control.options is not None
    assert [o.value for o in control.options] == ["valid"]


def test_build_triage_control_degrades_checkbox_to_text_when_every_option_is_malformed():
    triage = {"control_type": "checkbox", "options": [{"label": "no value here"}]}
    control = _build_triage_control(triage)
    assert control.type == "text"
    assert control.options is None
