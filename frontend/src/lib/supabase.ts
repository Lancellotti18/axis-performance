import { createBrowserClient } from '@supabase/ssr'

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export type AuthUser = {
  id: string
  email: string
  full_name?: string
  company_name?: string
  plan?: string
  region?: string
}
