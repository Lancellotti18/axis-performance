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
  stories: number | null; tear_off_layers: number; waste_factor_pct: number | string | null
  sold_amount: number | string | null; deadline: string | null
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

// ── M3: preview + move ───────────────────────────────────────────────────────
export interface Conflict { code: string; severity: 'BLOCK' | 'WARN'; message: string }
export interface CrewDaysBreakdown {
  crew_days: number; is_estimated: boolean; tear_off_days: number; install_days: number
  pitch_multiplier: number; story_multiplier: number; warnings: string[]
}
export interface PreviewResult {
  conflicts: Conflict[]; blocked: boolean
  resulting_utilization_pct: number; resulting_state: LoadState
  resulting_planned_squares: number; capacity_squares: number
  crew_days: CrewDaysBreakdown
}
export interface AffectedSlice {
  appointment: Appointment; series: Appointment[]; day_loads: Record<string, DayLoad>
}

async function authHeaders(): Promise<Record<string, string>> {
  const s = await getCachedSession()
  return s?.access_token ? { Authorization: `Bearer ${s.access_token}` } : {}
}

export async function previewMove(appointmentId: string, crewId: string, dateStr: string): Promise<PreviewResult> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/preview?appointment_id=${appointmentId}&crew_id=${crewId}&date=${dateStr}`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function patchAppointment(
  appointmentId: string,
  body: { crew_id?: string; date?: string; status?: string; request_id?: string },
): Promise<AffectedSlice> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/appointments/${appointmentId}`, {
    method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text(); let detail = t
    try { detail = JSON.parse(t).detail ?? t } catch { /* raw */ }
    throw new Error(String(detail))
  }
  return res.json()
}

// ── M4: tray + bulk ──────────────────────────────────────────────────────────
export interface TrayRow {
  job_id: string; appointment_id: string | null; job_number: number; job_type: string
  status: string; priority: string; customer: string; city: string
  squares: number | null; est_crew_days: number; is_estimated: boolean
  sold_amount: number | null; age_days: number | null; deadline: string | null
  tags: string[]; conflicts?: Conflict[]
}
export interface TrayData {
  unassigned: TrayRow[]; needs_measurements: TrayRow[]; on_hold: TrayRow[]; conflicts: TrayRow[]; canceled: TrayRow[]
}
export interface BulkChange {
  id: string; job_number: number | null; from: { crew_id: string | null; date: string | null }
  to: { crew_id: string | null; date: string | null }; conflicts?: Conflict[]
}
export interface AffectedMulti { appointments: Appointment[]; day_loads: Record<string, DayLoad>; appointment_crew: Record<string, string> }
export interface BulkResult {
  applied: boolean; dry_run?: boolean; op?: string; batch_id?: string
  changes?: BulkChange[]; conflicts?: Record<string, Conflict[]>; affected?: AffectedMulti
}

export async function fetchTray(): Promise<TrayData> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/tray`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function bulkOp(ids: string[], op: string, payload: Record<string, unknown>, dryRun: boolean): Promise<BulkResult> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/bulk`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, op, payload, dry_run: dryRun }),
  })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}

export async function bulkUndo(batchId: string): Promise<{ affected: AffectedMulti }> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/bulk/undo`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ batch_id: batchId }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── M6: audit trail ──────────────────────────────────────────────────────────
export interface AuditEvent {
  id: string; created_at: string | null; action: string; entity_type: string
  entity_id: string | null; actor_id: string | null; job_number: number | null; summary: string
}

export async function fetchAudit(limit = 60, appointmentId?: string): Promise<{ events: AuditEvent[] }> {
  const h = await authHeaders()
  const qs = new URLSearchParams({ limit: String(limit) })
  if (appointmentId) qs.set('appointment_id', appointmentId)
  const res = await fetch(`${API_BASE}/api/v1/scheduling/audit?${qs.toString()}`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── M7: crew & time-off administration ───────────────────────────────────────
export interface TimeOffEvent { id: string; crew_id: string; title: string; start_at: string; end_at: string; blocks_capacity: boolean }
export interface CrewInput {
  name: string; business_unit_id: string; squares_per_day: number; tear_off_squares_per_day: number
  max_pitch: number; max_stories: number; lead_id?: string | null
  shift_weekdays?: number[]; shift_start?: string; shift_end?: string; shift_weeks?: number
}

export async function createCrew(body: CrewInput): Promise<Crew> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/crews`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}
export async function updateCrew(id: string, patch: Partial<CrewInput>): Promise<Crew> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/crews/${id}`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}
/**
 * Retires a crew. `archived` is true when it had completed work — the crew comes
 * off the board but the record of who did those jobs is preserved rather than
 * cascaded away. Only genuinely upcoming jobs block the call (409).
 */
export async function deleteCrew(id: string): Promise<{ ok: boolean; archived?: boolean; completed_jobs?: number }> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/crews/${id}`, { method: 'DELETE', headers: h })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}
async function shiftCall(crewId: string, day: string, method: 'PUT' | 'DELETE') {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/crews/${crewId}/shifts/${day}`, { method, headers: h })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}

/** Give a crew a working day. Idempotent — pressing + twice is harmless. */
export async function addShift(crewId: string, day: string): Promise<{ ok: boolean; created: boolean }> {
  return shiftCall(crewId, day, 'PUT')
}

/** Take a working day away. Refused (409) while jobs are still booked on it. */
export async function removeShift(crewId: string, day: string): Promise<{ ok: boolean }> {
  return shiftCall(crewId, day, 'DELETE')
}

export async function listTimeOff(crewId?: string): Promise<{ events: TimeOffEvent[] }> {
  const h = await authHeaders()
  const qs = crewId ? `?crew_id=${crewId}` : ''
  const res = await fetch(`${API_BASE}/api/v1/scheduling/timeoff${qs}`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function addTimeOff(body: { crew_id: string; title: string; start_date: string; end_date: string; blocks_capacity?: boolean }): Promise<TimeOffEvent> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/timeoff`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}
export async function deleteTimeOff(id: string): Promise<{ ok: boolean }> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/timeoff/${id}`, { method: 'DELETE', headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── M7: live per-crew weather ─────────────────────────────────────────────────
export interface LiveWx {
  precip_probability: number | null; precip_in: number | null
  temp_high_f: number | null; temp_low_f: number | null; wind_mph: number | null
}
export interface LiveWeather { crew_weather: Record<string, LiveWx>; regional: Record<string, LiveWx> }

export async function fetchLiveWeather(start: string, end: string): Promise<LiveWeather> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/weather/live?start=${start}&end=${end}`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── M7: dispatch ↔ project link ──────────────────────────────────────────────
export interface ProjectSearchResult { id: string; name: string; address: string | null; status: string | null; thumbnail_url: string | null }
export interface RoofLinear {
  ridges_ft: number | null; hips_ft: number | null; valleys_ft: number | null
  eaves_ft: number | null; rakes_ft: number | null
  perimeter_ft: number | null; ridge_total_ft: number | null
}
export interface JobProject {
  linked: boolean
  project?: { id: string; name: string; status: string | null; address: string | null }
  thumbnail_url?: string | null
  squares?: number | null
  facet_count?: number | null
  roof_sqft?: number | null
  plan_sqft?: number | null
  /** As measured, e.g. "6/12". */
  pitch?: string | null
  /** Same pitch as a number (rise over 12), for math and comparison. */
  pitch_rise?: number | null
  stories?: number | null
  roof_type?: string | null
  waste_pct?: number | null
  /** Linear footage behind the materials list — ridge cap, drip edge, valley metal. */
  linear?: RoofLinear | null
  confidence?: number | null
  confirmed?: boolean
  measured_at?: string | null
  photos?: { url: string; caption: string | null; phase: string | null }[]
  has_report?: boolean
  share_token?: string | null
}
// A roof-run tile / photo URL may be absolute or a same-origin proxy path.
export const mediaUrl = (u: string | null | undefined): string | null =>
  !u ? null : (u.startsWith('http') || u.startsWith('data:') ? u : `${API_BASE}${u}`)

export async function fetchJobProject(jobId: string): Promise<JobProject> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/jobs/${jobId}/project`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function searchProjects(q: string): Promise<{ projects: ProjectSearchResult[] }> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/projects/search?q=${encodeURIComponent(q)}`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
/** `inherited` reports the measurement fields the job just picked up from the roof. */
export async function linkJobProject(
  jobId: string, projectId: string | null,
): Promise<{ ok: boolean; project_id: string | null; inherited?: Record<string, number> }> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/jobs/${jobId}/link`, {
    method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: projectId }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── M5.5: Copilot (brief, throughput flywheel, ⌘K plan) ──────────────────────
export interface BriefItem { kind: string; severity: number; text: string; refs: Record<string, string | null>; action: Record<string, unknown> | null }
export interface Brief {
  date: string; load: BriefItem[]; gaps: BriefItem[]; risk: BriefItem[]
  counts: { load: number; gaps: number; risk: number }; prose: string; narrated: boolean
}
export interface ThroughputRow {
  crew_id: string; crew_name: string; configured_sqpd: number; observed_sqpd: number
  sample_size: number; delta_pct: number; stable: boolean; suggested_sqpd: number | null; rationale: string
}
export interface ThroughputReview { suggestions: ThroughputRow[]; watching: ThroughputRow[] }
export interface PlanResult {
  ok: boolean; reason?: string; kind?: 'bulk' | 'reschedule'; intent?: string; summary?: string
  op?: string; payload?: Record<string, unknown>; ids?: string[]
  moves?: { appointment_id: string; crew_id: string; date: string }[]
  changes?: BulkChange[]; conflicts?: Record<string, Conflict[]>
}

export async function fetchBrief(start: string, end: string): Promise<Brief> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/ai/brief?start=${start}&end=${end}`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchThroughputReview(): Promise<ThroughputReview> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/ai/throughput-review`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function applyThroughput(crewId: string, squaresPerDay: number): Promise<{ applied: boolean }> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/ai/throughput-apply`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ crew_id: crewId, squares_per_day: squaresPerDay }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function planIntent(intent: string, start: string, end: string): Promise<PlanResult> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/ai/plan`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ intent, start, end }),
  })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}

// ── M5: weather impact + reschedule ──────────────────────────────────────────
export interface WeatherRiskDay {
  date: string; precip_probability: number | null
  appointments: { appointment_id: string; crew_id: string | null; job_number: number; job_type: string; squares: number | null }[]
}
export interface RescheduleSuggestion {
  appointment_id: string; job_number: number | null; job_type: string | null
  from: { crew_id: string | null; date: string | null }
  to: { crew_id: string; date: string } | null
  resulting_state: LoadState | null; resulting_pct: number | null; ok: boolean; reason: string
}
export interface WeatherImpact {
  risk_days: WeatherRiskDay[]; at_risk_count: number; suggestions: RescheduleSuggestion[]; resolvable: number
}

export async function fetchWeatherImpact(start: string, end: string): Promise<WeatherImpact> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/weather/impact?start=${start}&end=${end}`, { headers: h })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function reschedule(moves: { appointment_id: string; crew_id: string; date: string }[], dryRun: boolean): Promise<BulkResult> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/reschedule`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ moves, dry_run: dryRun }),
  })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}

export async function createAppointment(jobId: string, crewId: string, dateStr: string): Promise<AffectedSlice> {
  const h = await authHeaders()
  const res = await fetch(`${API_BASE}/api/v1/scheduling/appointments`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, crew_id: crewId, date: dateStr, request_id: crypto.randomUUID() }),
  })
  if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t).detail ?? t } catch {} throw new Error(String(d)) }
  return res.json()
}
