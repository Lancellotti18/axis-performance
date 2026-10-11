# Exclusive leads — the three things that need your logins

Branch `leads-purchase`, worktree `~/buildai-leads`. Nothing is pushed or live.
Purchases stay shut until Stripe is live, so none of this is urgent today — but
items 1 and 2 must be done **before the first lead is ever sold.**

---

## 1. Run the RLS migration (Supabase) — REQUIRED before the first sale

`purchased_leads` was created with no row-level security. Your anon key is
public by design in the site's JS bundle, so with RLS off that key can read the
table straight from Supabase's REST endpoint, bypassing the API entirely —
every owner name and mailing address anybody has paid for. That is exactly the
data contractors would be paying to have exclusively.

Nothing is exposed today: no lead has ever been sold and the table is empty.

**Do this:** Supabase dashboard → SQL Editor → New query → paste the whole
contents of `supabase/migrations/20261011_leads_rls.sql` → Run.

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

## Still not built

- **The dud flow.** "Report a problem" with the 7-day window, verifiable
  reasons, the 3-per-month cap, the free replacement lead, and the admin review
  page. Needs a new table. Nothing of it exists yet.
- **The security review** CLAUDE.md requires before merging.
