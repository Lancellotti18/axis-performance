# Exclusive leads — what still needs Ryan

**Everything on this list is DONE as of 2026-10-11.** Both migrations are run,
the anon-key exposure was found and locked down, and `SECRET_KEY` is set. The
only remaining gate before merge is the security review.

Branch `leads-purchase`, worktree `~/buildai-leads`. Nothing is pushed or live.
Purchases stay shut until Stripe is live, so none of this is urgent today — but
items 1 and 2 must be done **before the first lead is ever sold.**

---

## 1. Run the RLS migration (Supabase) — DONE 2026-10-11 ✅

`purchased_leads` was created with no row-level security. Your anon key is
public by design in the site's JS bundle, so with RLS off that key can read the
table straight from Supabase's REST endpoint, bypassing the API entirely —
every owner name and mailing address anybody has paid for. That is exactly the
data contractors would be paying to have exclusively.

Nothing is exposed today: no lead has ever been sold and the table is empty.

Ryan ran this and confirmed `rls_on = true` with one policy,
`purchased_leads_select_own` / `SELECT`.

It enables RLS with one owner-only SELECT policy (no client INSERT/UPDATE, or a
client could reserve every lead in a county for free), and widens the status
CHECK to allow `expired`, which the 15-minute reservation timeout needs.

---

## 2. The anon-key check — DONE 2026-10-11 ✅ (by session -3b, at Ryan's direction)

Answered, and it was not theoretical. With the published anon key:

- `crm_leads` returned **15 rows** of homeowner name, phone, email and address.
  Also exposed: `crm_lead_notes`, `contractor_profiles`, `legal_acknowledgments`
  (user_id + IP + user agent) and `regional_pricing`.
- Cause: `20260712_version_crm_tables.sql` had the correct fix written in July
  and was never applied.
- `sched_*` were never exposed — RLS was already on in the live project even
  though no migration did it. The tenancy blocker was a false alarm.
- Ryan applied the combined lockdown (20260712 + `20261011_rls_lockdown.sql`,
  30 tables). Re-probed: all closed.

Two things from that work that affect this branch:

- There are now **two** migrations touching `purchased_leads` — theirs enables
  RLS with no policy, mine adds the owner SELECT policy. Net effect is the
  SELECT grant, which is what we want. Just know both exist.
- **CRM `user_id` is TEXT in production** though the repo declares UUID. Any
  future RLS on those tables must cast both sides or `auth.uid() = user_id`
  throws. This branch is unaffected: it only inserts into `crm_leads` (a string
  is fine for TEXT) and never writes a policy for it.

---

## 3. Set `SECRET_KEY` in Render — DONE 2026-10-11 ✅

The lead tokens that replace the county parcel id are derived from
`SECRET_KEY`, and the default in `config.py` is the placeholder
`changeme-min-32-chars-secret-key`.

Ryan set this in Render on 2026-10-11. Nothing on `main` reads it yet, so it
had no visible effect — it just needed to be in place before leads ship.
Rotating it later only invalidates in-flight tokens (a stale tab gets "no
longer in the county's results"); purchased leads are keyed by parcel, not by
token, so nothing sold is affected.

Not a catastrophe if it stays as-is — the tokens are one-way either way, and the
underlying records are public county data — but it is a shared default sitting
in a public repo, so it should not be the thing standing between anyone and a
forged token.

---

## 4. Run the second migration (Supabase) — DONE 2026-10-11 ✅

Ryan ran this on 2026-10-11 ("Success. No rows returned", which is what this
DDL returns when every statement applied).

It creates `lead_problem_reports` (RLS on, owner-only SELECT, one claim per
purchase enforced by a unique index) and adds `subscriptions.lead_credits`,
which is how an approved claim pays for the next lead instead of a refund.

Verify with:

```sql
SELECT relrowsecurity AS rls_on FROM pg_class WHERE relname = 'lead_problem_reports';
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'subscriptions' AND column_name = 'lead_credits';
```

---

## Still not built

- **The security review** CLAUDE.md requires before merging.
