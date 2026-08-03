// Crew Scheduling board — data layer (self-contained section).
// Fetches the whole visible slice in one request; authenticates via the shared
// session helper (import only — no edits to existing modules).
import { getCachedSession } from '@/lib/supabase'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

export type LoadState = 'IDLE' | 'LIGHT' | 'BALANCED' | 'TIGHT' | 'OVERBOOKED'

export interface BusinessUnit { id: string; name: string; color_token: string; sort_order: number }
export interface Crew {
  id: string; name: string; business_unit_id: string; lead_id: string | null
  squares_per_day: number | string; tear_off_squares_per_day: number | string
  max_pitch: number | string; max_stories: number
}
export interface Person { id: string; first_name: string; last_name: string; role: string }
export interface CrewSkill { crew_id: string; skill: string }
export interface CrewMembership { crew_id: string; person_id: string; is_floating: boolean }
export interface Shift { crew_id: string; date: string; start_time: string; end_time: string; type: string }
export interface NonJobEvent { crew_id: string; title: string; start_at: string; end_at: string; blocks_capacity: boolean }
export interface Appointment {
  id: string; job_id: string; sequence: number; total_in_series: number
  scheduled_start: string; scheduled_end: string; status: string
  planned_squares: number | string | null; waive_trip_fee: boolean
}
export interface Job {
  id: string; business_unit_id: string; customer_id: string; property_id: string
  job_number: number; job_type: string; status: string; priority: string
  squares: number | string | null; predominant_pitch: number | string | null
  stories: number | null; tear_off_layers: number; sold_amount: number | string | null; deadline: string | null
}
export interface Customer { id: string; first_name: string; last_name: string }
export interface Property { id: string; line1: string; city: string; state: string; postal_code: string; lat: number; lng: number }
export interface JobTag { id: string; label: string; color_token: string; severity: 'INFO' | 'WARN' | 'CRITICAL'; icon: string | null }
export interface JobTagLink { job_id: string; tag_id: string }
export interface WeatherDay {
  date: string; postal_prefix: string; precip_probability: number
  precip_inches: number | string; wind_mph: number; temp_high_f: number | null; temp_low_f: number | null
}
export interface DayLoad {
  crew_id: string; date: string; appointment_count: number; scheduled_hours: number
  available_hours: number; planned_squares: number; capacity_squares: number
  utilization_pct: number; state: LoadState
}
export interface BoardData {
  range: { start: string; end: string; days: string[] }
  business_units: BusinessUnit[]; crews: Crew[]; persons: Person[]
  crew_skills: CrewSkill[]; crew_memberships: CrewMembership[]
  shifts: Shift[]; non_job_events: NonJobEvent[]
  appointments: Appointment[]; assignments: unknown[]; appointment_crew: Record<string, string>
  jobs: Job[]; customers: Customer[]; properties: Property[]
  tags: JobTag[]; job_tag_links: JobTagLink[]; weather: WeatherDay[]
  day_loads: Record<string, DayLoad>
}

export async function fetchBoard(start: string, end: string): Promise<BoardData> {
  const session = await getCachedSession()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/board?start=${start}&end=${end}`, {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
  })
  if (!res.ok) {
    const t = await res.text()
    let detail = t
    try { detail = JSON.parse(t).detail ?? t } catch { /* raw */ }
    throw new Error(String(detail))
  }
  return res.json()
}

export const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0)
  return Number.isFinite(n) ? (n as number) : 0
}
