# Axis Copilot — the AI layer for Crew Scheduling & Dispatch

**Read this together with `crew-scheduling-brief.md`.** This document is the AI
portion of the same spec. It references that brief's section numbers directly
and lists the exact edits to fold into it (bottom of this file).

The one-line thesis: *an appointment calendar can bolt on a chatbot and still not
know the roof is 34 squares or that this crew actually lays 31/day in the fall.
Axis's AI is trustworthy because it stands on measured ground truth and a closing
feedback loop — measure the roof → estimate production → schedule → observe the
actual → correct the model. The AI narrates and co-pilots that loop; it never
authors it. Ground truth is the moat; the AI is the leverage on it.*

---

## A0. Guardrails (these come first, on purpose)

1. **Deterministic core, AI narration.** Every *number* on screen comes from the
   tested capacity engine (Brief §3). The AI never computes squares, crew-days,
   or utilization — it ranks, explains, drafts, and summarizes *on top of* those
   numbers. If the model is unplugged, the board is fully operable. AI is
   additive, never load-bearing — the same posture as the weather layer (§5.6).
2. **Propose, never dispose.** Every AI action emits the *same dry-run object* a
   human bulk action produces (§5.4) — reviewed, approved, and undone through the
   identical transactional + `AuditEvent` + 15s-undo path. There is **no AI write
   path the human doesn't approve.** It is a fast set of hands, not an agent.
3. **Grounded or silent.** The model is handed a structured board snapshot and
   must cite the fields it used. No free-floating advice. If it lacks grounding,
   it says so rather than guessing.
4. **Ambient, not nagging.** One proactive artifact (the Morning Brief) plus
   on-demand invocation (a ⌘K command bar; a subtle "suggest" sparkle on
   unassigned cards). No chat bubble, no interruptions, no "AI is thinking"
   theater. Invisible until useful.
5. **It shows its work.** Every suggestion renders its reasoning inline
   ("Kevin's Crew — steep-slope certified, 2 open days, 14 min from the prior
   stop, finishes before Thursday's rain") and links to the underlying numbers.

Follow the same three-layer LLM safety net used elsewhere in this platform:
tolerant parser + JSON-schema retry + static fallback. A malformed model response
is discarded, never partially applied.

---

## A1. Capabilities (priority order)

### A — The Morning Brief  `generateDispatchBrief(snapshot) → Brief`
The mission is a 10-second read at 6:30am. The Brief is a generated three-part
answer to the mission's *exact* three questions, pinned above the board and
dismissible:
- **Load** — who's overbooked, who's idle; one line each, ranked by severity.
- **Gaps** — the unassigned work that can *actually* be placed this week, each
  with the AI's single best suggested placement (one tap opens its dry-run).
- **Risk** — what breaks: weather, broken series, PTO collisions, deadline
  jeopardy; each with a one-tap fix.
Pure summarization + ranking over deterministic inputs. Numbers are **quoted, not
invented.** Regenerates on demand; cached per board-day.

### B — Smart placement  `suggestPlacements(jobId, snapshot) → RankedPlacement[]`
For any unassigned job, return a ranked shortlist of `{ crew, startDate }`, each
carrying: the capacity-engine crew-day estimate (deterministic, §3.1), a
plain-English rationale, and the conflicts it would create (§3.4). **Division of
labor:** the engine does the hard filtering (skills, pitch, availability); the AI
ranks the *survivors* across the soft factors a dispatcher actually weighs —
drive-time from the crew's prior stop, weather runway to finish a series, series
contiguity, customer/tag notes, throughput fit. Selecting one opens the standard
placement dry-run. Surfaced as a quiet sparkle affordance on unassigned cards and
tray rows — **never auto-applied.**

### C — Natural-language dispatch (the ⌘K bar)  `planFromIntent(text, snapshot) → DryRunBatch`
The dispatcher types intent — *"move everything off Thursday's rain to the
soonest dry day, keep crews together"* — and the AI compiles it into a concrete
batch of the **exact** bulk operations the API already supports (§4), returned as
the standard dry-run summary (§5.4) for approval. Constraints: it can only emit
operations the bulk endpoint validates; it cannot apply without approval; it is
one undo. Use **constrained decoding to the bulk-op Zod/Pydantic schema** — the
model fills a plan, it never free-forms SQL. This is the headline "eleven jobs
off a rain day in thirty seconds" flow, driven by intent instead of clicks.

### D — Proactive risk radar  (feeds the Brief + a quiet persistent indicator)
On board load and on data change, scan the schedule graph for non-obvious
jeopardy the per-drop conflict checks don't catch in isolation: a 3-day series
whose tail lands on a rain day *and then* a PTO Saturday; a sold deadline the
current placement misses; a crew idle Tuesday while an overdue URGENT job sits in
the tray. Each risk is a card with a one-tap suggested fix (a dry-run). This is
the literal answer to *"what breaks if it rains Thursday,"* surfaced before the
dispatcher asks.

### E — The throughput flywheel (the moat)  `learnCrewThroughput(crew, history) → CapacitySuggestion`
This is what makes Axis's AI uniquely trustworthy and compounds every job. The
platform already runs a predicted-vs-actual calibration flywheel on measurements;
extend it to crews. From completed appointments (planned squares vs the **actual**
squares/day the crew delivered), learn each crew's real throughput and — only
when the evidence is strong enough (min sample size + stable variance) — suggest
updating `squaresPerDay` / `tearOffSquaresPerDay`: *"Kevin's Crew has averaged 31
sq/day across the last 8 reroofs, not the 28 configured. Update capacity?"* The
dispatcher approves. Every competitor guesses a duration; Axis measures the roof,
watches the crew, and gets more accurate every job. **This is the billion-dollar
difference and it cannot be copied without the measurement + completion data only
Axis accumulates.** The AI's role here is detecting a significant, stable delta
and phrasing the ask — the statistics are deterministic and tested.

---

## A2. API additions

```
POST /api/ai/brief             { snapshot }         → Brief           (cached per board-day)
POST /api/ai/suggest-placements{ jobId }            → RankedPlacement[]
POST /api/ai/plan              { intent, context }  → DryRunBatch      (NEVER applies; same shape the bulk endpoint validates)
GET  /api/ai/throughput-review                      → CapacitySuggestion[]  (pending, evidence-backed)
```

- Every model output is validated against the **same** Zod/Pydantic schema as the
  human path; anything that fails validation is discarded, not applied.
- Rate-limited and cached. If any of these 500 or time out, the board is fully
  functional and the surface renders a clean, labeled "AI unavailable" — never an
  error, never a blocker.
- `/api/ai/plan` returns *only* a `DryRunBatch`; applying it goes through the
  existing transactional bulk endpoint (§4) with its `requestId` idempotency and
  all-or-nothing-on-BLOCK semantics. No new write path exists.

---

## A3. Data the flywheel needs at M1

The only schema change the AI layer forces early is **capturing actuals** so
history accrues from day one (the model can't learn throughput that was never
recorded):

- `Appointment.actualSquares  Decimal? @db.Decimal(6,2)`  — set when status → DONE
- `Appointment.startedAt / completedAt  DateTime?`        — real elapsed time
- (Optional) a thin `CrewThroughputSample` view/materialization derived from
  completed appointments; can also be computed on the fly for the first version.

Everything else the AI needs (loads, conflicts, weather, drive-time) already
exists in the board snapshot. Add these fields in **M1** even though the
suggestion UI ships in **M5.5** — otherwise the moat starts empty.

---

## A4. Build-order placement

The AI layer is **M5.5 — after** the deterministic board, drag, bulk, and undo
are solid (M1–M4) and folded in beside weather (M5). Rationale: the AI is only as
good as the engine it narrates — build the ground truth first, then the co-pilot.
The single exception is the flywheel's **data capture** (A3), which lands in M1.

Suggested M5.5 order: throughput-review (E, smallest, highest-moat) → Morning
Brief (A) → smart placement (B) → risk radar (D) → ⌘K dispatch (C, needs B and
the bulk dry-run to be rock-solid first).

---

## A5. Non-goals (AI)

- **No autonomous scheduling.** The AI never writes without an approved dry-run.
- **No invented numbers.** Squares / days / utilization come *only* from §3's
  tested pure functions.
- **No chatbot persona,** no open-ended Q&A, no "AI is thinking" theater.
- **No black-box ranking.** Every suggestion cites the fields it used.
- **No model in the hot path of correctness.** Conflict *detection* (§3.4) stays
  deterministic; the AI only explains and prioritizes what the engine found.

---

## A6. Definition of done (AI additions)

- Unplug the model → the board is fully operable; every AI surface degrades to a
  clean, labeled "unavailable," never an error.
- Every AI write flows through the identical dry-run → approve → transactional
  apply → `AuditEvent` → 15s-undo path as a human bulk action. There is no
  separate AI write path, verified by test.
- Every AI number on screen traces to a tested pure function; the model supplies
  language and ranking only.
- `planFromIntent` output is schema-validated; a malformed plan renders as
  "couldn't turn that into a safe action," never partially applied. Covered by a
  test that feeds it garbage and asserts nothing is written.
- The throughput suggestion only fires past a tested evidence threshold (sample
  size + variance); a single fast/slow job never moves a crew's capacity.

---

## A7. Edits to fold into `crew-scheduling-brief.md`

- **§0 Mission** — add a fourth thing the dispatcher gets in those ten seconds:
  *"…and a one-paragraph brief that already answers all three, which they trust
  because every number in it is one they could have computed themselves."*
- **§2 Domain model** — add `actualSquares`, `startedAt`, `completedAt` to
  `Appointment` (see A3).
- **§9 Build order** — insert **M5.5 — The Axis Copilot** after M5; move the
  flywheel's data-capture fields into M1's schema task.
- **§10 Non-goals** — append A5.
- **§11 Definition of done** — append A6.
- **§6 Design** — the AI surfaces use the *same* tokens and restraint as the rest
  of the board; the "signature element" may be the Copilot's inline-reasoning
  chips, but they must read as part of the board, not a bolted-on assistant.
