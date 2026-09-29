'use client'
import { supabase, getCachedSession } from './supabase'

export async function signUp(email: string, password: string, fullName: string, companyName: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName, company_name: companyName },
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
