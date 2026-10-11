# Exclusive leads — the three things that need your logins

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

## 2. Check whether the anon key can already read the other tables

I tried to pull the anon key out of the published bundle to test this myself and
the permission classifier blocked it as credential materialization. I did not
route around it, so this one is yours. It is the open question from your other
session's tenancy work too.

Get the anon key from **Supabase → Settings → API → `anon` `public`**, then run
this in a terminal:

```sh
SB_URL="https://<your-project>.supabase.co"
SB_ANON="<paste the anon key>"

for t in purchased_leads crm_leads widget_leads sched_customer sched_job inspection_appointments; do
  n=$(curl -s "$SB_URL/rest/v1/$t?select=*&limit=1" \
        -H "apikey: $SB_ANON" -H "Authorization: Bearer $SB_ANON" \
        | head -c 200)
  echo "$t -> $n"
done
```

**Reading the result:**

- `[]` or a `42501` / permission-denied message → RLS is on. Good.
- Any row of real data → **that table is world-readable.** Tell me which ones
  and I will write the policies.

---

## 3. Set `SECRET_KEY` in Render

The lead tokens that replace the county parcel id are derived from
`SECRET_KEY`, and the default in `config.py` is the placeholder
`changeme-min-32-chars-secret-key`.

**Do this:** Render → backend service → Environment → add `SECRET_KEY` with 32+
random characters, e.g. from:

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Not a catastrophe if it stays as-is — the tokens are one-way either way, and the
underlying records are public county data — but it is a shared default sitting
in a public repo, so it should not be the thing standing between anyone and a
forged token.

---

## 4. Run the second migration (Supabase) — REQUIRED before the dud flow works

The report-a-problem flow needs its table and the credit column. Same routine:
SQL Editor → New query → paste `supabase/migrations/20261011_lead_problems.sql`
→ Run.

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
