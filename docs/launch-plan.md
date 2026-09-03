# Axis — Launch Plan

Working document. Started 2026-09-02. **Nothing here is final until marked DECIDED.**
Decisions move to DECIDED only once we have stopped arguing with them.

---

## 0. Sequencing — what blocks what

Several items are upstream of others in ways that are easy to miss:

```
LLC ── EIN ── business bank account ── Stripe ── master dashboard (revenue half)
  └────────── Terms of Service + Privacy Policy ── public launch

Google Solar fix ── accurate measurement ── selling measurement at all

Report size reduction ── affordable storage ── real usage
```

**Do not launch publicly before:** LLC exists, ToS + Privacy Policy published,
Google Solar returning measured pitch, report size reduced, background worker
for report generation.

---

## 0. THE BACKLOG — everything open, by what gates it

Captured 2026-09-03. Nothing here is done. Ordered by what blocks what, not by
size — several items cannot start until the LLC clears (~mid/late September).

### A. Blocks any customer touching it
- [ ] **Verify accuracy against a physical measurement.** Zero verified data
      exists; every `roof_actuals` row is a rushed-trace artefact. Solar now
      reaches facets (run `fd1b3168`: 4/12 and 5/12 measured where 6/12 was
      always assumed). One roof with a tape closes this. See
      [[project_axis_accuracy_verification]].
- [ ] **Cold starts.** ~75s on the free Render instance. That is a contractor's
      first impression, and the cheapest thing here to fix.
- [ ] **Report generation blocks the API** — synchronous PIL + PDF in the single
      web process. Two concurrent reports queue. Needs a background worker.

### B. Blocks taking money (chained — each needs the previous)
- [ ] LLC approval (filed 2026-09-02) -> EIN -> business bank account -> Stripe
- [ ] **Wire Stripe properly**: real `STRIPE_PRICE_*` config, signature-verified
      webhook, subscription state on the user, correct redirect URLs. The router
      is currently unmounted because it was placeholder code with an
      unauthenticated endpoint handing out Stripe portal links.
- [ ] **Terms of Service + Privacy Policy.** Not paperwork to defer: Axis stores
      homeowner addresses, imagery and contact details, and the widget collects
      homeowner data ON THE CONTRACTOR'S OWN SITE — so the terms must define what
      the contractor is agreeing to on their visitors' behalf, and who is the
      data controller for widget leads. Must name the LLC, so it is gated on
      approval. Also needs stated data-retention periods.

### C. Dispatch — known bugs
- [ ] **Quick-job geocoded to the wrong STATE** (a Wilmington-area job resolved
      to Swatara Township, Pennsylvania). `POST /scheduling/jobs/quick` takes the
      FIRST geocoder match with no confirmation and no regional bias. A wrong
      location silently means wrong job-site weather.
- [ ] **Tray vs grid is undiscoverable.** A new job lands unassigned in the Jobs
      Tray; the grid only shows jobs with an appointment. Correct behaviour,
      but nothing says so, so a created job looks like it vanished.
- [ ] Quick jobs have no squares, so they contribute no capacity until measured
      or linked to a project.
- [ ] Broader dispatch pass — Lance: "will need a decent amount of work".

### D. Measurement quality
- [ ] **Bounding-box matching risk.** Google returns a BOX per plane, not the
      plane's shape. On a cut-up hip-and-valley roof a facet can match the wrong
      neighbouring plane and inherit a confidently WRONG pitch — worse than a
      default, because it looks measured.
- [ ] **Tune the 50% overlap threshold.** On run `fd1b3168` facet C missed at
      46% and kept its default. Right call or too strict? Needs more roofs.
- [ ] Re-saving old runs would adopt Solar pitch (it only applies on save).

### E. Mobile
- [ ] Foundation is in (viewport meta, touch sensors, 44px targets, `useDevice`)
      but no screen has had a real mobile pass. Priority order for a contractor
      in the field: roof-v2 tracing, project detail, dispatch, CRM.
- [ ] Dispatch on a phone likely needs a single-crew day view rather than a
      squeezed 7-column week.

### F. Operations
- [ ] **Daily automated health check** (Playwright) exercising each feature and
      alerting with the specific failure. Needs a dedicated TEST ACCOUNT and
      cleanup, or it pollutes production and bills a Solar call every morning.
      Tier it: cheap checks daily (health, auth_key_source, load
      projects/dispatch/CRM, open a STORED report), expensive end-to-end
      (generate a report, run a quote) weekly. Build AFTER the product settles.
- [ ] Set `SENTRY_DSN` for durable error history — the hook already exists,
      `/diag/errors` is in-memory only and resets on deploy.
- [ ] Verify Supabase backup policy on the current tier.
- [ ] Shrink stored reports further (already 3.4 MB -> ~225 KB by removing a
      duplicate page).

### G. AI providers
- [ ] **Add more AI sources / fallbacks.** Three Gemini keys are already being
      rotated at a volume of one user — that is quota circumvention, not
      capacity. Move to paid quota on one key and add genuine provider
      fallbacks. Decide per task which model actually suits it rather than
      defaulting everything to one.

## 0a. NEXT SESSION — verify accuracy before anything else

- [ ] **Check a measured pitch against a tape / gable photo.** Solar now reaches
      facets end to end (first success 2026-09-03, run fd1b3168: 4/12 and 5/12
      measured where 6/12 was always assumed). Axis has still never been verified
      against physical reality — every calibration row is a test artefact — so the
      core product claim has no evidence behind it. One roof closes that.

## 0b. Triggered reminders

- **At 12 paying customers → move billing to a business bank account.** Google Cloud
  (and any other vendor) is on a personal card as of 2026-09-02. This is the same
  cluster of work as the LLC and Stripe payouts — entity, business account, card
  migration. Do them together rather than three times.

## 1. Legal & entity — REQUIRED, not optional

- [x] **Form the LLC.** ✅ FILED 2026-09-02 with NC Secretary of State (form
      L-01, $125, effective upon filing). Entity: **RW AI Infrastructure LLC**.
      NC quotes 10–15 business days for entity creation, so expect approval
      around mid-to-late September. Axis Performance is the product brand
      operating under it.
- [ ] **Register for an EIN** (Employer Identification Number) with the IRS.
      Free, applied for directly at irs.gov — do not pay a third party for it.
      Comes AFTER the LLC exists (the application asks for the entity), and is
      needed BEFORE the business bank account, which is needed before Stripe
      payouts. So the real order is: LLC → EIN → business bank account → Stripe. Upstream of billing (Stripe needs an entity + business
      bank account) and of the legal docs (they must name an operating entity).
      Structure and tax election → ask a lawyer/accountant, not Claude.
- [ ] **Terms of Service.**
- [ ] **Privacy Policy.** Non-trivial here: Axis stores homeowner addresses,
      property imagery, contact details and photos. The public quote widget
      collects homeowner data **on the contractor's own site**, so the policy
      must be explicit about who is the data controller for widget leads and
      what the contractor is agreeing to on their visitors' behalf.
- [ ] Decide data retention: how long are homeowner leads, photos and reports
      kept, and what happens to them when a contractor cancels.

---

## 2. Pricing — DECIDED in shape, numbers provisional

**Headline: $350/month.**

**Founding offer (DECIDED):**
> "$350/month. First 10 contractors get 50% off for 12 months, locked — in
> exchange for a testimonial and a monthly call about what's not working."

Why this rather than launching at $175: it keeps the anchor, makes the discount
a *reason* rather than a weakness, and buys the feedback loop. Raising a price
later is one of the hardest things in software.

### Tiers (provisional)

| Tier | For | Includes |
|---|---|---|
| Entry | 1 crew, owner-operator | Fewer reports, 1–2 dispatch crews, widget, CRM |
| **Core — $350** | **2–4 crews** | **~25–40 reports, widget, CRM, unlimited scheduling + material lists** |
| Top | 5+ crews | High/unlimited reports, more crews, priority support |

- Widget is included in **every** tier. It is the wedge; charging for it would
  be charging for the reason they came.
- Meter **reports** (real marginal cost) and **crews** (scales with their value).
  Everything else unlimited — near-zero marginal cost, and "unlimited" is a
  strong word in a market where competitors meter.
- **Overage, never a wall.** Hitting the cap mid-month is the moment they churn.
  Sell extra reports per-report, priced to beat per-report incumbents.
- **Meter crews, not users.** Crews is the unit dispatch is built around, and it
  grows with their business rather than their headcount.

**TODO before finalising:** price out what a 2–4 crew shop in this market
actually pays today for (measurements + CRM). That combined number is the real
ceiling — not a gut figure.

---

## 3. Leads — NOT DECIDED, unresolved tension

Proposed: $50/lead, 2 for $85.

**Two objections to resolve first:**

1. **A lead has real marginal cost.** The second lead is not cheaper to produce
   — same ad spend or SEO effort. Software bundles discount because marginal
   cost is ~zero; leads do not have that property, so the bundle discount comes
   straight out of margin for no structural reason. If a volume mechanic is
   wanted, bundle by **commitment** ("4/month reserved"), not discount-on-two.

2. **Selling leads competes with the widget.** Axis's pitch is "turn your own
   traffic into leads that are exclusively yours." If Axis also sells leads, a
   contractor can fairly ask whether the good ones are being kept back. That is
   precisely the suspicion they already hold about Angi — the feeling the wedge
   exists to escape.

**Needs a clean story before shipping**, probably: *widget leads are always 100%
yours; Axis-sourced leads come from our own consumer marketing and are offered
to subscribers first.* Two visibly separate pipes.

**Also check:** exclusive roofing leads generally command more than shared ones.
$50 may be underpriced for an exclusive lead — check local market rates.

**Recommendation: delay leads until subscriptions are proven.** One business at
a time.

---

## 4. Trial — DECIDED

**They use Axis themselves, capped at one project.**

Better than us running reports for them: it tests the real product, produces
real feedback, and scales past ten customers.

**But** they hit the UI cold, on a real bid, unassisted — so a clumsy first
trace produces a bad report and the wrong lesson. Therefore:

- [ ] Pair the first project with a **20-minute screen-share**. They drive, we
      watch, we do not touch the mouse. Watching a stranger use it is the most
      valuable data available.
- [ ] Enforce the one-project cap in product (not honour system).
- [ ] Decide what happens at the cap: upgrade prompt, not a dead end.

**Not doing:** 7-day trial (expires before a roofing sales cycle produces
value), and no free lead giveaway (unsustainable, and reframes Axis as a broker).

---

## 5. Go-to-market — DECIDED in shape

**No bulk outreach agent.** The market is ~150–350 contractors across Leland /
Wilmington / Topsail / New Bern — small enough to hand-build. Automating removes
the early conversations that ARE the product research, and cold volume from a
new domain risks the sending domain's deliverability.

**Instead: a research + draft agent for 10–20 prospects. Lance sends every email.**

### Ideal customer profile
- **Has a website** (required — no site, no widget, no wedge)
- **No instant-quote tool on it** (detectable, and it is the opening line)
- **1–5 crews** — big shops already run AccuLynx; solo operators will not pay
- **Signals of active bidding** — recent reviews, active socials, a "request a
  quote" form that is just a contact form
- **Not a franchise** (no autonomy to buy software)
- **Licensed and real** — NC licensing board is a clean source

### The prospect filter — a script, not an agent

The one genuinely automatable piece, and the highest-signal qualifier we have:

- [ ] **Find contractors with a website but NO instant-quote tool on it.**
      Fetch each homepage (and any /quote, /estimate, /contact page), look for
      the signatures of an existing tool — embedded quote widgets, "instant
      estimate" copy, third-party iframes from known providers — and classify:
        * no site            -> not a prospect (no widget, no wedge)
        * site, no quote tool -> **the target list**
        * site with a quote tool -> deprioritise (already solved, harder sell)

      Why this is the wedge qualifier: a contractor with a plain "contact us"
      form is already paying for traffic and losing it. That is a specific,
      true, checkable observation about THEIR business — which is exactly what
      makes an email read as written rather than merged.

      Keep it a ~50-line script over the hand-built list. Not an agent.

### Draft rules
- Reference something **specific and true** about that contractor. A template
  with a merge field reads as a template; contractors get five a week.
- Lead with the widget, not measurement:
  *"Your website gets visitors who leave without calling — this turns them into
  quoted leads that are yours alone."*

---

## 6. Positioning — DECIDED

Axis is three products, and only one is defensible:

| Part | Competing with | Assessment |
|---|---|---|
| Roof measurement | EagleView, Hover | Heavily funded, years of data |
| CRM + dispatch | JobNimbus, AccuLynx | Entrenched, high switching cost |
| **Instant-quote widget** | **Very few** | **The wedge** |

Lead with the widget. Measurement is what makes the widget credible, not the
thing we ask them to switch to.

---

## 7. Master admin dashboard

**Blocked in part:** billing does not exist. `billing.py` was unmounted — it had
placeholder price IDs, localhost URLs, no webhook, and an unauthenticated
endpoint handing out Stripe portal links.

**Buildable now:** sign-ups, active accounts, usage per account (reports
generated, quota consumed), feedback/complaints inbox, support view, free
internal access.

**Needs Stripe first:** MRR, recurring revenue, payment state, dunning.

- [ ] Wire Stripe properly: real STRIPE_PRICE_* config, signature-verified
      webhook, subscription state on the user record, correct redirect URLs.
- [ ] Then build the revenue half of the dashboard.

---

## 8. Feedback — the questions

Ask about **behaviour and last real events**, not opinions. "Do you like it?"
gets politeness.

**Behavioural (most valuable)**
- Walk me through the last roof you bid. Where would Axis have fitted, and where
  would it have got in your way?
- What did you do right before, and right after, using Axis?
- Did you use the report with a homeowner? What did they say? Did you change
  anything before showing them?
- What did you go back to your old way for?

**Predicts retention**
- If Axis disappeared tomorrow, how disappointed would you be — very, somewhat,
  not really? What would you use instead?
  *(If "not really": "what would have made it 'very'" is the most useful
  sentence in the call.)*

**Trust — critical for Axis specifically**
- Did you trust the measurements? What would you need to see to order material
  off them without checking?
- Was anything on the report you could not explain to a homeowner?

**Pricing, asked properly**
- What do you pay today for measurements, and for your CRM?
- At what price is Axis so expensive you would not consider it? At what price
  would you wonder if something is wrong with it?

**Subtraction**
- What would you remove?
- What did you expect to be there and was not?

Avoid "what features do you want?" — they will name things they never use.

---

## 9. Infrastructure before real usage

Measured, not estimated:

- Stored reports average **3.93 MB each**. 100 contractors × 20 reports/month
  ≈ **7.9 GB/month** of new storage.
- **Report generation is synchronous** (`asyncio.to_thread` in the single web
  process) — CPU-bound PIL + PDF. Concurrent requests queue and time out.
- Render free tier cold-starts (~75s), single instance.
- Three Gemini keys already rotating at a volume of one user.

**Actions, cheapest first:**
- [ ] **Shrink the report** — downsample embedded satellite imagery, compress
      diagrams. Plausibly 4× smaller with no visible loss at print size. An
      afternoon of work; changes storage math from days to months. **Do first.**
- [ ] Background worker for report generation (stop blocking the API).
- [ ] Paid Render instance + storage tier.
- [ ] **Paid Gemini quota — NOT more keys.** Rotating keys to evade per-project
      quota is circumvention: against Google's terms, revocable together, and it
      does not reduce cost, only limits. It also fails randomly, which is the
      worst failure mode for a contractor mid-bid.

---

## 10. Daily health check — build AFTER the product stabilises

Playwright routine exercising each feature every morning, alerting with the
specific failure.

**The trap:** a test that exercises every feature creates real data. Generating
a report costs a Solar call and ~4 MB *every morning*; a dispatch job stays on
the board. Within a month production is mostly robot exhaust and it is billed.

Requirements:
- Dedicated **test account and test project**, isolated from real data
- **Cleanup after every run**
- **Tiered:** cheap checks daily (health, auth_key_source, load
  projects/dispatch/CRM, open a *stored* report); expensive end-to-end
  (generate a report, run a quote) **weekly**
- Alerts that name the specific failure

Build it after the product stops changing daily, or mornings go to fixing the
test.

---

## Open questions
- What does a 2–4 crew shop here actually pay today for measurements + CRM?
- Entry and Top tier numbers.
- Lead story — can we say the two-pipes sentence convincingly? If not, delay.
- Data retention periods for the Privacy Policy.
