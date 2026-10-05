'use client'
import { supabase, getCachedSession } from './supabase'

/** A plan picked on the homepage before the account existed. */
export interface PlanIntent { plan: string; interval: 'month' | 'year' }

export async function signUp(email: string, password: string, fullName: string, companyName: string,
                             phone = '', planIntent: PlanIntent | null = null) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // plan_intent rides on the account itself, not the URL or this browser:
      // the confirmation link is often opened on a phone, and the plan they
      // chose has to survive that trip to send them on to checkout.
      data: { full_name: fullName, company_name: companyName, phone,
              ...(planIntent ? { plan_intent: planIntent } : {}) },
      // Where the confirmation link lands. Stated explicitly rather than left
      // to Supabase's configured Site URL: if that setting is stale the link
      // points somewhere else entirely — the same shape as the SMS bug that
      // sent contractors a localhost link.
      emailRedirectTo: typeof window !== 'undefined'
        ? `${window.location.origin}/auth/callback`
        : undefined,
    },
  })
  return { data, error }
}

/** Send the confirmation email again. Needed because the first one lands in
 *  spam often enough that without this the account is simply stuck. */
export async function resendConfirmation(email: string) {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: typeof window !== 'undefined'
        ? `${window.location.origin}/auth/callback`
        : undefined,
    },
  })
  return { error }
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  return { data, error }
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function getSession() {
  // Uses the module-level session cache to avoid auth-lock contention.
  return getCachedSession()
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

type AuthUser = { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null }

function planIntentOf(user: AuthUser | null | undefined): PlanIntent | null {
  const pi = user?.user_metadata?.plan_intent as PlanIntent | null | undefined
  if (!pi || typeof pi.plan !== 'string' || !/^[a-z]+$/.test(pi.plan)) return null
  return { plan: pi.plan, interval: pi.interval === 'year' ? 'year' : 'month' }
}

/** Where someone goes the moment they are signed in: straight to checkout if
 *  they picked a plan before creating the account and have not paid yet,
 *  otherwise the dashboard. Used by signup, the email-confirmation callback
 *  and login, so the plan is never lost whichever way they come back in. */
export function postAuthDestination(user: AuthUser | null | undefined): string {
  const pi = planIntentOf(user)
  return pi ? `/checkout?plan=${pi.plan}&interval=${pi.interval}` : '/dashboard'
}

/** Checkout is done (or not needed): stop sending them back to it. */
export async function clearPlanIntent() {
  try { await supabase.auth.updateUser({ data: { plan_intent: null } }) } catch { /* harmless */ }
}

/** Company name and phone are asked for at signup, but the branded contractor
 *  profile (what goes on reports) is its own record that used to be created
 *  only from Settings. Fill it once from the signup details, never over the
 *  top of anything the contractor has already entered. Best-effort. */
export async function seedProfileFromSignup(user: AuthUser | null | undefined) {
  const md = user?.user_metadata || {}
  if (!user || md.profile_seeded) return
  const company = typeof md.company_name === 'string' ? md.company_name.trim() : ''
  const phone = typeof md.phone === 'string' ? md.phone.trim() : ''
  if (!company && !phone) return
  try {
    const { api } = await import('./api')
    // Only when no profile exists at all: the save endpoint writes every field
    // it is given, so seeding over a partial profile would blank the rest.
    const existing = await api.contractorProfile.get(user.id) as Record<string, unknown>
    if (!existing || Object.keys(existing).length === 0) {
      await api.contractorProfile.save(user.id, { company_name: company, phone, email: user.email || '' })
    }
    await supabase.auth.updateUser({ data: { profile_seeded: true } })
  } catch { /* Settings still works; this is a head start, not a requirement */ }
}
