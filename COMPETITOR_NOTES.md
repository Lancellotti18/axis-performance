# BuildAI — Competitive Positioning Notes

Written 2026-04-16. Based on the current state of BuildAI (axis-performance) and public info on EagleView, Hover, CompanyCam, Xactimate, and PlanSwift/STACK.

---

## Who the competitors actually are

Your app overlaps a few distinct categories. Understanding which one the user thinks they're in changes how you position.

| Company | Core product | What they sell | Weakness |
|---|---|---|---|
| **EagleView** | Aerial roof measurements from satellite imagery | PDFs with ridges/valleys/squares, pitch, waste factor. ~$25–$100 per report. | Slow (hours–days), no interior, no estimate, no permits. Single data product. |
| **Hover** | Photogrammetry — user photos → 3D exterior model | Exterior measurements, materials, siding/window visualizations. | Needs 6–12 photos of the home, doesn't do interiors or permits. |
| **CompanyCam** | Photo documentation & job-site notes | Timestamped/geotagged photos organized by project. Contractor-facing workflow tool. | Not AI. Not analytical. Just storage + tagging. |
| **Xactimate** | Insurance-grade estimating software | Industry-standard line items, unit costs, scope of loss. Dominant for insurance restoration. | $200+/month, week-long learning curve, desktop-first, 90s UI. |
| **PlanSwift / STACK** | On-screen blueprint takeoff | Manual digital measuring of PDFs to generate material lists. | Still mostly manual; user draws polygons. Not AI. |
| **Bolt / Beam / Togal.ai** | AI blueprint takeoff (newer, VC-funded) | Automated room detection, quantities. Closer to what you're doing. | Expensive ($5k+/mo), enterprise sales motion, targets commercial GCs not residential contractors. |

**Your actual niche**: residential + light-commercial contractor who wants *one tool* for blueprint → estimate → permit. Nobody above covers that full span. EagleView + Xactimate + a permit service is 3 tools and ~$400/mo combined. You're trying to be the one-stop.

---

## Where BuildAI beats each competitor today

- **vs EagleView**: you do roof measurement *plus* interior, materials, cost, compliance, permits. EagleView is one artifact.
- **vs Hover**: you work from a blueprint PDF. User doesn't need to be on-site to get a measurement. Hover requires physical photos of the finished structure; you work at the design/estimate stage (bigger wallet, higher urgency).
- **vs CompanyCam**: you have the photo-documentation feature (before/during/after) AND analysis. CompanyCam has no analysis.
- **vs Xactimate**: order of magnitude faster, modern UI, actually usable on mobile, and the user doesn't need to know a 20k-line item codebook.
- **vs PlanSwift/STACK**: automated, not manual. 3-minute flow vs 3-hour flow.

---

## Where BuildAI is currently losing

Honest list. These are the things a paying contractor will notice in the first week and use to justify not renewing.

### 1. Measurement accuracy is the whole game

EagleView's moat is that their numbers hold up in litigation. Insurance adjusters accept their reports without question. Your roof measurements are AI-derived from blueprints without a confidence interval the user can trust.

**What to do**
- Show a per-measurement confidence score in the UI. Don't hide it.
- When confidence is low, force "confirm or correct" step before the number flows into the estimate. (Roofing tab already has `confirmed: boolean` — use it everywhere, not just roofing.)
- Publish a one-page methodology doc. EagleView, Hover, and Xactimate all have these. It's a sales tool.
- Offer an optional "human verified" tier where a reviewer checks the AI output for an extra fee. Cheaper than EagleView, higher trust than raw AI. This is the insurance-restoration beachhead.

### 2. No 3D exterior from photos

Hover's killer demo is: 8 photos from your phone → a rotatable 3D model with siding/window measurements. You don't have a photogrammetry flow. Your 3D viewer is a blueprint-derived floor-plan extrusion, which is impressive but different.

**What to do**
- Short-term: position 3D as "what the finished build looks like from this blueprint" — a *visualization* feature for selling the project to the homeowner, not a measurement feature.
- Medium-term: add a photo-to-3D flow. Open source options: Meshroom, nerfstudio, Polycam's API. Even a basic "upload 10 photos → get a rotatable mesh" feature closes the Hover gap for siding/exterior jobs.
- Long-term: drone integration. DJI has an SDK. "Fly the drone, get measurements" is a real moat.

### 3. The estimate isn't defensible to adjusters

Xactimate's line items are the language insurance adjusters speak. Your material list uses plain-English names ("2x4 stud, 8ft") and your cost engine uses BLS/RS Means. Good data, wrong format for insurance work.

**What to do**
- Add an "export as Xactimate-compatible scope" button. Map your line items to Xactimate codes (ESX/CSV). This unlocks the insurance-restoration market, which is the highest-paying contractor segment.
- Keep the plain-English UI. Contractors hate Xactimate codes. Only surface them at export time.

### 4. Permits are 90% good, 10% broken in a way that matters

Your permit flow finds the portal, pre-fills the PDF, hands it back. The last mile — *actually submitting* — is still manual. Your memory file mentions this is a planned feature.

**What to do** (this IS your biggest differentiator if you pull it off)
- Browser automation per-city: Playwright scripts for the top 50 jurisdictions. Investment: 1–2 eng-weeks per city, but each city is a permanent moat.
- Partner model: some cities have B2B API access for licensed "permit runners." Apply for that status in your home state first.
- Explicit audit trail: capture the submission confirmation screen, the receipt number, the date. This is what contractors currently pay permit expediters $200–$500 per application for.

### 5. No integration story

Contractors already use QuickBooks, Procore, Buildertrend, JobTread. If you're a new tool they have to manually transfer estimates *out of*, you're a toy. If you're a tool that pushes estimates *into* their existing system, you're the layer they can't remove.

**What to do**
- QuickBooks Online API (free, well-documented) — push estimate to QuickBooks Invoice. One-week integration.
- Procore / Buildertrend later — they're enterprise and have sales-gated APIs.
- Stripe invoicing direct from the app for solo contractors without QuickBooks. You already have Stripe wired in.

### 6. No moat on the AI itself

Anyone can wire up Gemini/Claude/Tavily. Your advantage isn't the model — it's the pipeline, the training corpus, and the workflow. Today that corpus is small.

**What to do**
- Every blueprint uploaded is training data. With explicit opt-in consent, use them to fine-tune a room/wall detection model. After 10k blueprints you have a detector EagleView/Hover can't match because they don't have floor plans.
- Build a private dataset of (blueprint, approved permit) pairs. That's unique and defensible.

### 7. Pricing / value perception

Contractors won't pay $99/mo for a tool they haven't closed a deal with. EagleView charges per-report — low commitment, immediate ROI on one job. You're subscription-first.

**What to do**
- Add a per-report option ($10–$20 per project) in addition to the subscription. Use it as a wedge — once a contractor has used it on 3 jobs, they'll upgrade.
- First report free with signup. No credit card. The current "uploads_used" tracking on Profile already supports this.
- Tier the subscriptions around outcome, not features: "5 projects/mo, 50, unlimited." Contractors count projects, not features.

---

## What to build next — prioritized

Prioritized by (impact) ÷ (effort). Rough estimates.

1. **Confidence-scored measurements with confirm/correct UX** — 1 week. Unlocks trust. Low risk.
2. **Per-report pricing option** — 2 days. Opens a new funnel without disrupting subscribers.
3. **QuickBooks Online export** — 1 week. Kills the #1 integration objection.
4. **Xactimate-compatible CSV export** — 1 week. Unlocks insurance-restoration vertical.
5. **Photo-to-3D exterior (even rough)** — 3–4 weeks. Closes the Hover gap.
6. **Permit auto-submission for 3 pilot cities** — 3 weeks per city. Nuclear-grade moat per city.
7. **Fine-tuned room detector on your own data** — 2 months. AI moat. Long-horizon bet.

---

## Positioning line to steal

> **EagleView gives you numbers. Hover gives you a model. Xactimate gives you an estimate. Buildertrend gives you a job site. BuildAI gives you the whole project — blueprint, materials, costs, compliance, permits — in one flow.**

Use this everywhere.

---

## What I'd stop doing

- **The CRM feature.** It's a half-feature. Contractors use Jobber, HoneyBook, ServiceTitan, or a spreadsheet. You can't out-CRM them and you shouldn't try. Either integrate with those or drop the tab.
- **The home visualizer as a primary nav item.** It's cool but it's a demo, not a job-to-be-done. Move it inside a project page as "preview this build."
- **Storm report / aerial report as separate top-level pages.** They're data feeds that belong inside a project ("this project is in a high-hail zone"), not standalone pages. Cut the nav noise.
- **Dual-AI fallback chains** (Gemini → Groq → Anthropic) — fine for reliability but the user doesn't care. Don't advertise it.

---

## Things the app currently does that competitors don't

Keep these. They're your differentiators:

- Blueprint → estimate in one flow (nobody else connects analysis to pricing)
- Compliance checks with real code citations (Xactimate doesn't do code review)
- Real regional labor rates from BLS (most competitors use stale national averages)
- Photo phases (before/during/after) tied to the same project as the estimate
- Automated permit portal discovery (nobody else does this automatically)

---

## Closing honest take

You're not trying to beat EagleView at roofs or Hover at exteriors. You're trying to be the operating system for a residential contractor's project, and those are features within it. Stay in that lane. The moment you try to out-EagleView EagleView on roof measurement accuracy, you lose because their training data and legal acceptance are a 10-year head start. The moment you try to out-Xactimate Xactimate on line items, you lose on ecosystem.

Win on **span** and **speed**, not depth-at-any-single-point.
