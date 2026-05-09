"""
AxisChat — contextual AI assistant endpoint.

The frontend mounts a floating chat widget that knows which section of the app
the user is on AND what data is on their screen. Each request includes:
  - section:    a key like 'permit' / 'storm-report' / 'project-detail'
  - page_data:  arbitrary JSON describing the current state (form fields,
                hazard scores, project info, etc.)
  - history:    recent message turns for conversational context
  - message:    the user's new question

We build a section-tailored system prompt so the LLM is grounded in what's
actually on screen — answers like "your hail score is 7 because…" instead of
generic chatbot output. Read-only by design — the assistant never edits the
user's data, just explains and clarifies.
"""
from __future__ import annotations

import json
import logging
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()
logger = logging.getLogger(__name__)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    section: str = Field(default="general", description="Page identifier — drives the system prompt")
    page_data: dict = Field(default_factory=dict, description="Current state of the page")
    history: List[ChatMessage] = Field(default_factory=list)
    message: str

    # Hard caps so a buggy frontend can't blow up our LLM bill
    @property
    def trimmed_history(self) -> List[ChatMessage]:
        return self.history[-10:]


# ── System prompts per section ─────────────────────────────────────────────
#
# Each prompt assumes the user is a contractor (busy, time-pressured, knows
# construction terminology). Keep responses TIGHT — contractors hate walls
# of text. Default to 1-3 short paragraphs unless they ask for detail.

_BASE_PERSONA = """You are Axis, the AI assistant for Axis Performance — an AI blueprint and permit platform for contractors.

The user is a contractor or construction professional. Match their pace:
- Be direct. Lead with the answer; explain only as much as they need.
- Use construction industry terms naturally (sqft, APN, R-3, Type V-B, etc.).
- 1-3 short paragraphs is usually right. Use bullet lists only when listing distinct items.
- Never hallucinate field values, prices, code citations, or jurisdiction-specific rules. If you don't know, say so and suggest where they can verify.
- Never offer to edit, submit, or change anything in the system — you're read-only. If they ask you to fill something in, tell them which field/section to fill it in themselves."""


_SECTION_PROMPTS: dict[str, str] = {
    "permit": """{base}

The user is on the PERMIT FILING flow. Here is the current state of their application:

{page_data}

Help them with:
- Explaining what specific permit fields mean (APN, occupancy type, construction type, valuation, etc.) and how to find the answer
- Confirming whether the form they have is the right one for their jurisdiction
- Interpreting the AI-extracted blueprint scan or document analysis
- Walking through what each section requires
- Clarifying jurisdiction-specific quirks if you know them

Don't make up specific permit fees, exact required documents, or city-specific rules unless the page_data confirms them. When unsure, point them to the building department phone number or website.""",

    "storm-report": """{base}

The user is on the STORM / NATURAL DISASTER RISK REPORT. Here is the report they're looking at:

{page_data}

Help them with:
- Explaining why a specific hazard scored what it did (lean on the rationale field if present)
- Translating risk scores into roofing / building reinforcement priorities
- Interpreting the recent_events list and what those mean for their property
- Suggesting specific reinforcements aligned to the highest-scoring hazards
- Comparing this location's risk to nearby cities or the state baseline

Don't invent recent disasters. If the report has empty arrays, say "no live events were retrieved for this location" rather than fabricating events.""",

    "project-detail": """{base}

The user is on a PROJECT DETAIL page. Here is the project state:

{page_data}

Help them with:
- Explaining material quantities, cost breakdowns, or pricing
- Interpreting blueprint analysis output (rooms, dimensions, sqft, openings)
- Walking through compliance flags or AI insights shown on the page
- Suggesting which next step makes sense (estimate, compliance check, permit, etc.)
- Clarifying confidence scores and what "AI inferred" vs "verified" means""",

    "aerial-report": """{base}

The user is on the AERIAL ROOF REPORT page. Here is the report state:

{page_data}

Help them with:
- Interpreting the roof outline polygon and area calculations
- Explaining what the aerial measurements mean for materials estimation
- Identifying potential issues with the auto-traced outline (offsets, missing extensions)
- Suggesting reinforcements based on visible roof features""",

    "compliance": """{base}

The user is on the COMPLIANCE CHECK page. Here is the state:

{page_data}

Help them with:
- Explaining what each compliance item means in practical terms
- Walking through which code section applies and why
- Suggesting how to address specific failures
- Distinguishing must-fix items from nice-to-have

Don't fabricate code section numbers. Use only what's in page_data.""",

    "dashboard": """{base}

The user is on the DASHBOARD / overview page. Here is the high-level state:

{page_data}

Help them with:
- Pointing them to the right section for their question
- Explaining what each tool in the platform does
- Triaging which task to do next based on their projects' status""",

    "general": """{base}

The user is somewhere in the app. Here is whatever context is available:

{page_data}

Help them navigate the platform, explain what each tool does, and answer general questions about contractor workflows, permits, blueprints, materials, and compliance.""",
}


def _build_system_prompt(section: str, page_data: dict) -> str:
    template = _SECTION_PROMPTS.get(section) or _SECTION_PROMPTS["general"]
    # Cap page_data JSON so a giant project can't blow the prompt
    try:
        data_json = json.dumps(page_data, indent=2, default=str)
    except Exception:
        data_json = "{}"
    if len(data_json) > 8000:
        data_json = data_json[:8000] + "\n\n…[truncated for length]"
    return template.format(base=_BASE_PERSONA, page_data=data_json)


# ── Endpoint ────────────────────────────────────────────────────────────────

@router.post("/ask")
async def ask_axis(body: ChatRequest):
    """
    Single-shot chat completion. Returns the assistant's reply as plain text.
    Non-streaming for now — keeps the UI simple. If we want streaming later
    we'd add a separate /stream endpoint that uses Server-Sent Events.
    """
    from app.services.llm import llm_text

    user_msg = (body.message or "").strip()
    if not user_msg:
        raise HTTPException(status_code=422, detail="message is required")
    if len(user_msg) > 2000:
        raise HTTPException(status_code=413, detail="message exceeds 2000 character limit")

    system = _build_system_prompt(body.section, body.page_data)

    # Roll the last 10 turns into the prompt as a transcript. llm_text doesn't
    # take a structured chat history, but the providers behind it handle
    # transcript-style prompts cleanly.
    parts: list[str] = []
    for turn in body.trimmed_history:
        if turn.role == "user":
            parts.append(f"User: {turn.content.strip()}")
        else:
            parts.append(f"Assistant: {turn.content.strip()}")
    parts.append(f"User: {user_msg}")
    parts.append("Assistant:")
    user_prompt = "\n\n".join(parts)

    try:
        reply = await llm_text(user_prompt, system=system, max_tokens=800)
    except Exception as e:
        logger.warning(f"chat: LLM call failed: {e}")
        raise HTTPException(status_code=502, detail=f"AI is temporarily unavailable: {e}")

    reply = (reply or "").strip()
    # Some models echo "Assistant:" — strip it if present
    for prefix in ("Assistant:", "assistant:", "AXIS:", "Axis:"):
        if reply.startswith(prefix):
            reply = reply[len(prefix):].lstrip()
            break

    if not reply:
        return {"reply": "I'm not sure how to answer that — could you rephrase or give me more detail about what you're trying to do?"}

    return {"reply": reply, "section": body.section}
