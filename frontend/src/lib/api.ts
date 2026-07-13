import { supabase, getCachedSession, refreshCachedSession } from './supabase'
import type {
  Project,
  Blueprint,
  Analysis,
  MaterialEstimate,
  CRMLead,
  RoofMeasurements,
  ContractorProfile,
  ComplianceCheck,
  EstimateFull,
  ReportFull,
  PermitField,
  Jurisdiction,
  VendorOption,
} from '@/types'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

// ── Growth-engine types ─────────────────────────────────────────────────────
export interface QuoteWidget {
  id: string
  user_id: string
  widget_key: string
  enabled: boolean
  company_name: string | null
  phone: string | null
  price_low: number
  price_high: number
  roofvision_palette?: string[] | null
}

// RoofIQ quote presentation — good/better/best tiers, financing teaser,
// the honest measurement band, and the show-the-math breakdown.
export interface QuoteTier {
  name: string
  headline: string
  detail: string
  price: number
}
export interface QuoteFinancing {
  from_per_month: number
  disclaimer: string
}
export interface QuoteBand {
  level: 'tight' | 'wider' | 'unknown'
  how: string
}
export interface QuoteMath {
  roof_sqft: number
  squares: number
  waste_pct: number
  order_squares: number
  rate_low_per_sq: number | null
  rate_high_per_sq: number | null
  method: string
  slope_factor: number | null
  calibration?: { jobs: number; adjust_pct: number; note: string } | null
}
export type AppointmentStatus = 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
export interface Appointment {
  id: string
  report_token: string | null
  homeowner_name: string | null
  homeowner_phone: string | null
  homeowner_email: string | null
  address: string | null
  preferred_date: string
  time_window: 'morning' | 'afternoon' | 'evening' | 'anytime'
  homeowner_note: string | null
  status: AppointmentStatus
  contractor_note: string | null
  created_at: string
}

export interface WidgetLead {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string
  squares_estimate: number | null
  price_low: number | null
  price_high: number | null
  quote_source: string | null
  status: 'new' | 'contacted' | 'quoted' | 'won' | 'lost'
  notes: string | null
  created_at: string
  roof_age?: string | null
  stories?: number | null
  issues?: string[] | null
  lead_score?: number | null
  score_reasons?: string[] | null
  report_token?: string | null
  report_opens?: number | null
}

export interface ProposalTier {
  name: string
  headline: string
  description: string
  features: string[]
  price: number
  // RoofVision: the homeowner's own roof rendered in this tier's shingle color.
  render_url?: string | null
  color_name?: string | null
  homeowner_pick?: boolean
}

export interface RoofProposal {
  id: string
  token: string
  project_id: string | null
  run_id: string | null
  company_name: string | null
  address: string | null
  squares: number | null
  tiers: ProposalTier[]
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired'
  accepted_tier: string | null
  accepted_by_name: string | null
  valid_until: string | null
  created_at: string
}

export interface PortalMessage {
  id: string
  sender: 'contractor' | 'homeowner'
  sender_name: string | null
  body: string
  created_at: string
}

export interface PublicProposal {
  company_name: string
  license_number: string | null
  phone: string | null
  email: string | null
  logo_url: string | null
  address: string | null
  squares: number | null
  total_roof_sqft: number | null
  predominant_pitch: string | null
  tiers: ProposalTier[]
  status: string
  accepted_tier: string | null
  valid_until: string | null
  created_at: string
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (err: unknown) {
    clearTimeout(timer)
    throw err
  }
}

async function buildAuthHeaders(options?: RequestInit): Promise<Record<string, string>> {
  // Use the module-level session cache (see supabase.ts) — calling
  // supabase.auth.getSession() directly under concurrency causes
  // "AbortError: Lock was stolen by another request".
  const session = await getCachedSession()
  const token = session?.access_token
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options?.headers as Record<string, string> | undefined),
  }
}

// In-flight request de-duplication. Two identical requests fired before the
// first resolves (e.g. a double-clicked "Generate Report", or two components
// requesting the same data on mount) share ONE network call + promise. This
// prevents duplicate side effects (double PDF generation, double report rows)
// and saves redundant round-trips. Cleared as soon as the request settles.
const _inflight = new Map<string, Promise<unknown>>()

// Optional short-TTL cache for idempotent GETs (opt-in via cacheMs). Covers the
// "re-open the same run" cost without an IndexedDB layer (the browser already
// HTTP-caches the heavy tile image bytes; this just spares the JSON round-trip).
const _ttlCache = new Map<string, { at: number; value: unknown }>()

/** Drop cached GET responses whose path contains `substr`. Needed when an
 *  action changes what an endpoint would return — e.g. tapping "this is my
 *  house" changes the anchor for /solar + /footprint lookups, so their cached
 *  (possibly wrong-building) responses must not be served afterward. */
export function invalidateApiCache(substr: string): void {
  for (const key of _ttlCache.keys()) {
    if (key.includes(substr)) _ttlCache.delete(key)
  }
}

export async function apiRequest<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = 90000,  // 90s — Render free tier cold starts can take 75s
  cacheMs = 0,        // >0 → cache this GET response for cacheMs milliseconds
): Promise<T> {
  const method = (options?.method || 'GET').toUpperCase()
  const dedupKey = `${method} ${path} ${typeof options?.body === 'string' ? options.body : ''}`

  // Serve from TTL cache (idempotent GETs only).
  if (cacheMs > 0 && method === 'GET') {
    const hit = _ttlCache.get(dedupKey)
    if (hit && Date.now() - hit.at < cacheMs) return hit.value as T
  }

  // Share an identical in-flight request instead of issuing a duplicate.
  const existing = _inflight.get(dedupKey)
  if (existing) return existing as Promise<T>

  const run = (async (): Promise<T> => {
    const result = await _doRequest<T>(path, options, timeoutMs)
    if (cacheMs > 0 && method === 'GET') {
      _ttlCache.set(dedupKey, { at: Date.now(), value: result })
    }
    return result
  })()
  _inflight.set(dedupKey, run)
  try {
    return await run
  } finally {
    _inflight.delete(dedupKey)
  }
}

async function _doRequest<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = 90000,
): Promise<T> {
  const fetchOptions: RequestInit = {
    ...options,
    headers: await buildAuthHeaders(options),
  }

  let res: Response | undefined
  // Retry up to 3 times — handles cold starts and transient failures
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetchWithTimeout(`${API_BASE}${path}`, fetchOptions, timeoutMs)
      lastErr = null
      break
    } catch (err: unknown) {
      lastErr = err
      const name = err instanceof Error ? err.name : ''
      if (name === 'AbortError') continue   // timed out — retry
      // Network-level failure (CORS, connection refused, etc.) — wait briefly then retry
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500))
    }
  }
  if (lastErr) {
    const name = lastErr instanceof Error ? lastErr.name : ''
    if (name === 'AbortError') throw new Error('Server is taking too long to respond. Please try again in a moment.')
    throw new Error('Network error. Please check your connection.')
  }

  // On 401, the cached session is likely stale. Force-refresh through the
  // cache helper (also updates the module-level cache) and retry once.
  if (res!.status === 401) {
    try {
      const refreshed = await refreshCachedSession()
      if (refreshed?.access_token) {
        const retryOptions: RequestInit = {
          ...options,
          headers: await buildAuthHeaders(options),
        }
        res = await fetchWithTimeout(`${API_BASE}${path}`, retryOptions, timeoutMs)
      }
    } catch {
      // fall through with the original 401 response
    }
  }

  if (!res!.ok) {
    const text = await res!.text()
    // FastAPI returns {"detail":"..."} — extract just the message
    try {
      const json = JSON.parse(text)
      const detail = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)
      throw new Error(`[HTTP ${res!.status}] ${detail}`)
    } catch (parseErr: unknown) {
      if (parseErr instanceof Error && parseErr.message.startsWith('[HTTP')) throw parseErr
    }
    throw new Error(text || `HTTP ${res!.status}`)
  }
  return res!.json()
}

/**
 * Like apiRequest but returns the raw response text (not JSON).
 * Used by APIR's HTML preview endpoint which serves text/html.
 */
export async function apiRequestText(
  path: string,
  options?: RequestInit,
  timeoutMs = 90000,
): Promise<string> {
  const fetchOptions: RequestInit = {
    ...options,
    headers: await buildAuthHeaders(options),
  }
  const res = await fetchWithTimeout(`${API_BASE}${path}`, fetchOptions, timeoutMs)
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`[HTTP ${res.status}] ${detail.slice(0, 300)}`)
  }
  return res.text()
}

// Projects
export const api = {
  projects: {
    list: (userId: string) =>
      apiRequest<Project[]>(`/api/v1/projects/?user_id=${userId}`),
    create: (payload: { name: string; description?: string; region?: string; blueprint_type?: string; city?: string; zip_code?: string }, userId: string) =>
      apiRequest<Project>(`/api/v1/projects/?user_id=${userId}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }, 60000),
    get: (id: string) =>
      apiRequest<Project>(`/api/v1/projects/${id}`),
    rename: (id: string, name: string) =>
      apiRequest<Project>(`/api/v1/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    delete: (id: string) =>
      apiRequest<{ ok: boolean }>(`/api/v1/projects/${id}`, { method: 'DELETE' }),
    archive: (id: string) =>
      apiRequest<Project>(`/api/v1/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      }),
    restore: (id: string) =>
      apiRequest<Project>(`/api/v1/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: false }),
      }),
    listArchived: (userId: string) =>
      apiRequest<Project[]>(`/api/v1/projects/?user_id=${userId}&include_archived=true`),
    getRiskScore: (projectId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/projects/${projectId}/risk-score`, {}, 90000),
  },
  blueprints: {
    getUploadUrl: (projectId: string, filename: string, contentType: string) =>
      apiRequest<{ upload_url: string; key: string }>(
        `/api/v1/blueprints/upload-url?project_id=${projectId}&filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(contentType)}`
      ),
    register: (projectId: string, fileKey: string, fileType: string, fileSizeKb: number) =>
      apiRequest<Blueprint>(`/api/v1/blueprints/?project_id=${projectId}&file_key=${encodeURIComponent(fileKey)}&file_type=${fileType}&file_size_kb=${fileSizeKb}`, {
        method: 'POST',
      }),
    triggerAnalysis: (blueprintId: string) =>
      apiRequest<{ job_id: string; status: string }>(`/api/v1/blueprints/${blueprintId}/analyze`, { method: 'POST' }),
    retryAnalysis: (blueprintId: string) =>
      apiRequest<{ job_id: string; status: string }>(`/api/v1/blueprints/${blueprintId}/retry`, { method: 'POST' }),
    getStatus: (blueprintId: string) =>
      apiRequest<{ status: string; error_message?: string }>(`/api/v1/blueprints/${blueprintId}/status`),
    viewUrl: (blueprintId: string) => `${API_BASE}/api/v1/blueprints/${blueprintId}/view`,
    takeoff: (blueprintId: string) =>
      apiRequest<{
        blueprint_id: string
        project_id: string
        takeoff: {
          rooms: Array<{
            name: string
            sqft: number
            width_ft: number | null
            depth_ft: number | null
            perimeter_ft: number | null
            drywall_sqft: number | null
            flooring_type: string
          }>
          walls: { exterior_lf: number; interior_lf: number; total_lf: number; by_type: Record<string, number> }
          openings: { doors: number; windows: number; opening_sqft_total: number }
          framing: { studs_count: number; plates_lf: number; osb_panels_wall: number; insulation_batts: number }
          drywall: { raw_sqft: number; ordered_sqft: number; sheets_4x8: number; waste_factor: number }
          flooring: Array<{ room: string; type: string; raw_sqft: number; ordered_sqft: number }>
          totals: { total_sqft: number; exterior_perimeter_ft: number; wall_height_ft: number; wall_area_net_sqft: number; room_count: number }
          scale: { detected: unknown; unverified: boolean; confidence: number; warning?: string }
        }
        material_rows: Array<{ item_name: string; category: string; quantity: number; unit: string; unit_cost: number; total_cost: number; source: string }>
      }>(`/api/v1/blueprints/${blueprintId}/takeoff`, {}, 90000),
    applyTakeoff: (blueprintId: string) =>
      apiRequest<{ project_id: string; rows_added: number; rows_total: number; takeoff: Record<string, unknown> }>(
        `/api/v1/blueprints/${blueprintId}/takeoff/apply`,
        { method: 'POST' },
        90000,
      ),
  },
  analyses: {
    getByBlueprint: (blueprintId: string) =>
      apiRequest<Analysis>(`/api/v1/analyses/by-blueprint/${blueprintId}`),
  },
  estimates: {
    get: (projectId: string) =>
      apiRequest<EstimateFull | null>(`/api/v1/estimates/${projectId}`),
    update: (projectId: string, payload: { markup_pct?: number; labor_rate?: number; region?: string }) =>
      apiRequest<EstimateFull>(`/api/v1/estimates/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
  },
  reports: {
    getFull: (projectId: string) =>
      apiRequest<ReportFull>(`/api/v1/reports/${projectId}/full`, {}, 30000),
    getDailyLogs: (projectId: string) =>
      apiRequest<Array<{
        date: string
        photo_count: number
        phases: Record<string, number>
        areas: string[]
        summary: string
        manual_tags: string[]
        auto_tags: string[]
        damage: string[]
        safety: string[]
        photos: Array<{ id: string; url: string; phase?: string; notes?: string }>
      }>>(`/api/v1/reports/${projectId}/daily-logs`, {}, 60000),
    saveOverrides: (projectId: string, overrides: Record<string, unknown>) =>
      apiRequest<{ saved: boolean }>(`/api/v1/reports/${projectId}/overrides`, {
        method: 'PATCH',
        body: JSON.stringify({ overrides }),
      }),
    downloadPdf: (projectId: string): Promise<Blob> =>
      fetch(`${API_BASE}/api/v1/reports/${projectId}/pdf`, { method: 'POST' })
        .then(async res => {
          if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
          return res.blob()
        }),
  },
  materials: {
    add: (projectId: string, item: { item_name: string; category: string; quantity: number; unit: string; unit_cost: number; total_cost: number }) =>
      apiRequest<MaterialEstimate>(`/api/v1/materials/${projectId}/add`, {
        method: 'POST',
        body: JSON.stringify(item),
      }),
    update: (projectId: string, itemId: string, item: Partial<MaterialEstimate>) =>
      apiRequest<MaterialEstimate>(`/api/v1/materials/${projectId}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(item),
      }),
    delete: (projectId: string, itemId: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/materials/${projectId}/items/${itemId}`, { method: 'DELETE' }),
    searchPrices: (payload: { item_name: string; category: string; unit_cost: number; region: string; city?: string }) =>
      apiRequest<{ options: VendorOption[] }>(`/api/v1/materials/search-prices`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }, 30000),
    validateLink: (url: string, productName: string, expectedPrice: number) =>
      apiRequest<{ valid: boolean; is_product_page: boolean; product_found: boolean; actual_price: number | null; price_match: boolean; price_mismatch: boolean; error: string | null; cached: boolean }>(
        `/api/v1/materials/validate-link`,
        { method: 'POST', body: JSON.stringify({ url, product_name: productName, expected_price: expectedPrice }) },
        15000
      ),
    refreshAllPrices: (projectId: string) =>
      apiRequest<{ updated: number }>(`/api/v1/materials/${projectId}/refresh-all-prices`, { method: 'POST' }, 120000),
  },
  permits: {
    searchPortal: (city: string, state: string, projectType: string) => {
      const params = new URLSearchParams({ city, state, project_type: projectType })
      return apiRequest<{ portal_url: string | null; portal_name: string | null; instructions: string | null; source: string; submission_method?: string; submission_email?: string | null; found?: boolean }>(
        `/api/v1/permits/portal-search?${params}`
      )
    },
    listAttachments: (projectId: string) =>
      apiRequest<{
        attachments: Array<{
          index: number
          kind: 'file' | 'text'
          filename?: string
          size?: number
          url?: string
          text?: string
        }>
      }>(`/api/v1/permits/${projectId}/attachments`).catch(() => ({ attachments: [] })),
    uploadRequirement: async (projectId: string, index: number, file: File) => {
      const session = await getCachedSession()
      const token = session?.access_token
      const form = new FormData()
      form.append('index', String(index))
      form.append('file', file)
      const res = await fetch(`${API_BASE}/api/v1/permits/${projectId}/requirements/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      })
      if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
      return res.json() as Promise<{ index: number; filename: string; size: number; url?: string }>
    },
    saveRequirementText: (projectId: string, index: number, text: string) =>
      apiRequest<{ index: number; text: string }>(`/api/v1/permits/${projectId}/requirements/text`, {
        method: 'POST',
        body: JSON.stringify({ index, text }),
      }, 30000),
    deleteRequirementAttachment: (projectId: string, index: number) =>
      apiRequest<{ ok: boolean }>(`/api/v1/permits/${projectId}/requirements/${index}/attachment`, {
        method: 'DELETE',
      }),
    previewDraftPdf: async (projectId: string): Promise<Blob> => {
      const session = await getCachedSession()
      const token = session?.access_token
      const res = await fetch(`${API_BASE}/api/v1/permits/generate-pdf/${projectId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ fields: [], form_url: null, use_web_form: true }),
      })
      if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
      return res.blob()
    },
    analyzeRequirements: async (projectId: string, notes: string, files: File[]) => {
      const form = new FormData()
      form.append('project_id', projectId)
      form.append('notes', notes)
      for (const f of files) form.append('files', f)
      const session = await getCachedSession()
      const token = session?.access_token
      return fetchWithTimeout(
        `${API_BASE}/api/v1/permits/analyze-requirements`,
        { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} },
        120000,
      ).then(async res => {
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.json() as Promise<{ fields: Record<string, string>; summary: string; files_processed: number }>
      })
    },
    fetchForm: (projectId: string, requirementsFields: Record<string, string> = {}, blueprintScan: Record<string, string> = {}) =>
      apiRequest<{ form_url: string | null; city: string; state: string; project_type: string; fields: PermitField[]; jurisdiction: Jurisdiction; confirmed_at: string | null; field_source: 'official_form' | 'standard_fallback' }>(
        `/api/v1/permits/fetch-form/${projectId}`,
        { method: 'POST', body: JSON.stringify({
          requirements_context: JSON.stringify(requirementsFields),
          blueprint_scan: JSON.stringify(blueprintScan),
        }) },
        60000
      ),
    scanBlueprint: (projectId: string) =>
      apiRequest<{ fields: Record<string, string>; summary: string; confidence: string }>(
        `/api/v1/permits/scan-blueprint/${projectId}`,
        { method: 'POST' },
        90000,
      ),
    confirmForm: (projectId: string, opts: { formUrl?: string | null; useManual?: boolean } = {}) =>
      apiRequest<{ ok: boolean; confirmed_at: string; form_url: string | null }>(
        `/api/v1/permits/confirm-form/${projectId}`,
        { method: 'POST', body: JSON.stringify({ form_url: opts.formUrl ?? null, use_manual: !!opts.useManual }) },
        15000,
      ),
    feesTimeline: (city: string, state: string, projectType: string, estimatedCost?: number) => {
      const params = new URLSearchParams({ city, state, project_type: projectType })
      if (estimatedCost) params.set('estimated_cost', String(estimatedCost))
      return apiRequest<{ fees_estimate: string; review_days_estimate: string; cached: boolean }>(
        `/api/v1/permits/fees-timeline?${params}`,
      )
    },
    preflight: (fields: PermitField[]) =>
      apiRequest<{ ok: boolean; missing_required: Array<{ key: string; label: string; section: string }>; missing_count: number }>(
        `/api/v1/permits/preflight`,
        { method: 'POST', body: JSON.stringify({ fields }) },
      ),
    generatePdf: async (projectId: string, fields: PermitField[], formUrl: string | null, useWebForm: boolean): Promise<Blob> => {
      const session = await getCachedSession()
      const token = session?.access_token
      return fetch(`${API_BASE}/api/v1/permits/generate-pdf/${projectId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ fields, form_url: formUrl, use_web_form: useWebForm }),
      }).then(async res => {
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.blob()
      })
    },
  },
  // ── Inspection appointments (homeowner books → contractor calendar) ──────
  appointments: {
    list: (upcoming = false) =>
      apiRequest<{ appointments: Appointment[] }>(`/api/v1/appointments${upcoming ? '?upcoming=1' : ''}`),
    update: (id: string, patch: { status?: AppointmentStatus; preferred_date?: string; time_window?: string; contractor_note?: string }) =>
      apiRequest<Appointment>(`/api/v1/appointments/${id}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
  },
  // ── Growth engine: instant quote widget + lead inbox ─────────────────────
  instantQuote: {
    // Public (homeowner-facing; no auth required)
    widgetConfig: (key: string) =>
      apiRequest<{ company_name: string; phone: string }>(`/api/v1/instant-quote/w/${key}`),
    locate: (key: string, payload: { address?: string; lat?: number; lng?: number }) =>
      apiRequest<{
        found: boolean
        lat?: number
        lng?: number
        address?: string
        message?: string
        imagery?: { url: string; width_px: number; height_px: number; feet_per_pixel: number } | null
      }>(`/api/v1/instant-quote/w/${key}/locate`, {
        method: 'POST', body: JSON.stringify(payload),
      }, 45000),
    quote: (key: string, address: string, lat?: number, lng?: number) =>
      apiRequest<{
        found: boolean
        measured?: boolean
        address?: string
        lat?: number
        lng?: number
        squares?: number
        roof_sqft?: number
        price_low?: number
        price_high?: number
        source?: string
        message?: string
        tiers?: QuoteTier[]
        financing?: QuoteFinancing
        band?: QuoteBand
        math?: QuoteMath
      }>(`/api/v1/instant-quote/w/${key}/quote`, {
        method: 'POST', body: JSON.stringify({ address, lat, lng }),
      }, 45000),
    trackEvent: (key: string, sessionId: string, event: string) =>
      apiRequest<{ ok: boolean }>(`/api/v1/instant-quote/w/${key}/event`, {
        method: 'POST', body: JSON.stringify({ session_id: sessionId, event }),
      }).catch(() => ({ ok: false })),   // analytics never blocks the flow
    report: (token: string) =>
      apiRequest<{
        first_name: string
        address: string | null
        created_at: string
        company_name: string
        company_phone: string
        company_license?: string | null
        service_area?: string | null
        roof_sqft: number | null
        squares: number | null
        price_low: number | null
        price_high: number | null
        source: string | null
        roof_confirmed: boolean
        imagery_url: string | null
        roof_age: string | null
        stories: number | null
        issues: string[]
        details: {
          work_type?: string | null
          condition?: string | null
          rooftop_items?: string[] | null
          chimney_skylights?: boolean | null
          attic?: boolean | null
          drainage?: string | null
          renders?: { key: string; name: string; tier: string; image_url: string }[] | null
        }
        tiers?: QuoteTier[]
        financing?: QuoteFinancing
        band?: QuoteBand
        math?: QuoteMath
      }>(`/api/v1/instant-quote/report/${token}`),
    bookInspection: (token: string, body: { preferred_date: string; time_window: string; note?: string; website?: string }) =>
      apiRequest<{ ok: boolean; status: string; preferred_date?: string; time_window?: string }>(`/api/v1/appointments/book/${token}`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    selectColor: (token: string, key: string) =>
      apiRequest<{ ok: boolean; chosen?: string }>(`/api/v1/instant-quote/report/${token}/select-color`, {
        method: 'POST', body: JSON.stringify({ key }),
      }),
    roofvisionCatalog: () =>
      apiRequest<{ catalog: { key: string; name: string; tier: string }[] }>(`/api/v1/instant-quote/roofvision/catalog`),
    analytics: () =>
      apiRequest<{ funnel: Record<string, number>; leads_30d: number; avg_score: number | null }>(
        `/api/v1/instant-quote/analytics`, undefined, 30000, 60000),
    submitLead: (key: string, payload: {
      name: string; phone?: string; email?: string; address: string
      lat?: number; lng?: number; squares_estimate?: number
      price_low?: number; price_high?: number; quote_source?: string
      notes?: string
      roof_age?: string; stories?: number; issues?: string[]
      work_type?: string; condition?: string; rooftop_items?: string[]
      chimney_skylights?: boolean; attic?: boolean; drainage?: string
      roof_confirmed?: boolean; roof_sqft?: number; imagery_url?: string
      sms_consent?: boolean   // TCPA: homeowner's logged consent to be texted
      website?: string   // honeypot
    }) =>
      apiRequest<{ ok: boolean; message: string; report_url?: string | null }>(`/api/v1/instant-quote/w/${key}/lead`, {
        method: 'POST', body: JSON.stringify(payload),
      }),
    // Contractor
    myWidget: () =>
      apiRequest<QuoteWidget>(`/api/v1/instant-quote/my-widget`),
    updateWidget: (patch: Partial<Pick<QuoteWidget, 'enabled' | 'company_name' | 'phone' | 'price_low' | 'price_high' | 'roofvision_palette'>>) =>
      apiRequest<QuoteWidget>(`/api/v1/instant-quote/my-widget`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
    leads: (status?: string) =>
      apiRequest<{ leads: WidgetLead[]; counts: Record<string, number> }>(
        `/api/v1/instant-quote/leads${status ? `?status=${status}` : ''}`),
    updateLead: (leadId: string, patch: { status?: WidgetLead['status']; notes?: string }) =>
      apiRequest<WidgetLead>(`/api/v1/instant-quote/leads/${leadId}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
  },
  // ── Growth engine: good/better/best proposals ────────────────────────────
  roofProposals: {
    createFromRun: (runId: string, validDays = 30) =>
      apiRequest<RoofProposal>(`/api/v1/roof-proposals/from-run/${runId}`, {
        method: 'POST', body: JSON.stringify({ valid_days: validDays }),
      }),
    // One click: a RoofIQ lead (already measured at quote time) → live proposal
    createFromLead: (leadId: string, validDays = 30) =>
      apiRequest<RoofProposal>(`/api/v1/roof-proposals/from-lead/${leadId}`, {
        method: 'POST', body: JSON.stringify({ valid_days: validDays }),
      }, 30000),
    list: (projectId?: string) =>
      apiRequest<{ proposals: RoofProposal[] }>(
        `/api/v1/roof-proposals${projectId ? `?project_id=${projectId}` : ''}`),
    update: (proposalId: string, patch: { tiers?: ProposalTier[]; status?: string; company_name?: string; phone?: string }) =>
      apiRequest<RoofProposal>(`/api/v1/roof-proposals/${proposalId}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
    // Public (homeowner)
    publicGet: (token: string) =>
      apiRequest<PublicProposal>(`/api/v1/roof-proposals/public/${token}`),
    publicAccept: (token: string, payload: { tier_name: string; name: string; email?: string; note?: string }) =>
      apiRequest<{ ok: boolean; message: string }>(`/api/v1/roof-proposals/public/${token}/accept`, {
        method: 'POST', body: JSON.stringify(payload),
      }),
  },
  // ── Client portal (homeowner window into the job) ─────────────────────────
  clientPortal: {
    my: (projectId: string) =>
      apiRequest<{ id: string; token: string; stage: string; enabled: boolean }>(
        `/api/v1/client-portal/my/${projectId}`),
    update: (projectId: string, patch: { stage?: string; enabled?: boolean }) =>
      apiRequest<{ id: string; token: string; stage: string; enabled: boolean }>(
        `/api/v1/client-portal/my/${projectId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    // Two-way messaging (contractor ⇄ homeowner)
    myMessages: (projectId: string) =>
      apiRequest<{ messages: PortalMessage[] }>(`/api/v1/client-portal/my/${projectId}/messages`),
    sendMyMessage: (projectId: string, body: string) =>
      apiRequest<{ ok: boolean; message: PortalMessage }>(
        `/api/v1/client-portal/my/${projectId}/messages`,
        { method: 'POST', body: JSON.stringify({ body }) }),
    publicMessages: (token: string) =>
      apiRequest<{ messages: PortalMessage[] }>(`/api/v1/client-portal/public/${token}/messages`),
    sendPublicMessage: (token: string, body: string, name?: string) =>
      apiRequest<{ ok: boolean; message: PortalMessage }>(
        `/api/v1/client-portal/public/${token}/messages`,
        { method: 'POST', body: JSON.stringify({ body, name }) }),
    publicGet: (token: string) =>
      apiRequest<{
        address: string
        stage: string
        stages: string[]
        contractor: { company_name?: string; license_number?: string; phone?: string; email?: string; logo_url?: string }
        roof: { squares?: number; total_roof_sqft?: number; predominant_pitch?: string }
        photos: string[]
        report_url: string | null
        proposal: { token: string; status: string; accepted_tier?: string; price_low?: number; price_high?: number; valid_until?: string } | null
        updated_at?: string
      }>(`/api/v1/client-portal/public/${token}`),
  },
  contractorProfile: {
    uploadLogo: async (userId: string, file: File) => {
      const session = await getCachedSession()
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetchWithTimeout(`${API_BASE}/api/v1/contractor-profile/${userId}/logo`, {
        method: 'POST',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        body: fd,
      }, 60000)
      if (!res.ok) {
        const text = await res.text()
        let detail = text
        try { detail = JSON.parse(text).detail ?? text } catch { /* raw */ }
        throw new Error(String(detail))
      }
      return res.json() as Promise<{ ok: boolean; logo_url: string }>
    },
    get: (userId: string) =>
      apiRequest<ContractorProfile | Record<string, never>>(`/api/v1/contractor-profile/${userId}`),
    save: (userId: string, profile: Partial<ContractorProfile>) =>
      apiRequest<ContractorProfile>(`/api/v1/contractor-profile/${userId}`, {
        method: 'POST',
        body: JSON.stringify(profile),
      }),
  },
  compliance: {
    getForRegion: (regionCode: string, projectType: string, city?: string) => {
      const params = new URLSearchParams({ project_type: projectType })
      if (city) params.set('city', city)
      return apiRequest<ComplianceCheck>(`/api/v1/compliance/region/${regionCode}?${params}`)
    },
    triggerForProject: (projectId: string, city?: string) => {
      const params = city ? `?city=${encodeURIComponent(city)}` : ''
      return apiRequest<{ status: string; check_id: string }>(
        `/api/v1/compliance/project/${projectId}${params}`,
        { method: 'POST' }
      )
    },
    getForProject: (projectId: string) =>
      apiRequest<ComplianceCheck>(`/api/v1/compliance/project/${projectId}`),
    checkMaterials: (projectId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/compliance/materials-check?project_id=${projectId}`, { method: 'POST' }, 240000),
  },
  roofing: {
    analyzeMeasurements: (blueprintId: string) =>
      apiRequest<RoofMeasurements>(`/api/v1/roofing/${blueprintId}/measure`, { method: 'POST' }, 90000),
    confirmMeasurements: (blueprintId: string, measurements: Partial<RoofMeasurements>) =>
      apiRequest<RoofMeasurements>(`/api/v1/roofing/${blueprintId}/confirm`, {
        method: 'POST',
        body: JSON.stringify(measurements),
      }),
    getMeasurements: (blueprintId: string) =>
      apiRequest<RoofMeasurements>(`/api/v1/roofing/${blueprintId}/measurements`),
    getShingleEstimate: (projectId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/roofing/project/${projectId}/shingle-estimate`),
    downloadPdfReport: async (projectId: string) => {
      const session = await getCachedSession()
      const token = session?.access_token
      const res = await fetch(`${API_BASE}/api/v1/roofing/project/${projectId}/pdf-report`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(msg || `PDF report failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers.get('content-disposition') || ''
      const m = /filename="([^"]+)"/.exec(cd)
      a.download = m ? m[1] : `roof-report-${projectId.slice(0, 8)}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    },
    stormRisk: (city: string, state: string, zipCode?: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/roofing/storm-risk`, {
        method: 'POST',
        body: JSON.stringify({ city, state, zip_code: zipCode || '' }),
      }, 60000),
    analyzeAerialDamage: (satelliteImageUrl: string, address: string, lat?: number | null, lng?: number | null) =>
      apiRequest<Record<string, unknown>>(`/api/v1/roofing/aerial-damage`, {
        method: 'POST',
        body: JSON.stringify({ satellite_image_url: satelliteImageUrl, address, lat, lng }),
      }, 90000),
    detectOutline: (
      satelliteImageUrl: string,
      lat?: number | null,
      opts?: { imageWidthPx?: number; imageHeightPx?: number; zoom?: number },
    ) =>
      apiRequest<{
        polygon: [number, number][]
        confidence: number
        structure: string
        notes: string
        warnings: string[]
        estimated_sqft: number | null
        estimated_perimeter_ft: number | null
        image_width_px: number
        image_height_px: number
        zoom: number
      }>(`/api/v1/roofing/outline`, {
        method: 'POST',
        body: JSON.stringify({
          satellite_image_url: satelliteImageUrl,
          lat,
          image_width_px: opts?.imageWidthPx ?? 1280,
          image_height_px: opts?.imageHeightPx ?? 840,
          zoom: opts?.zoom ?? 18,
        }),
      }, 60000),
    // ----- Roofing v2 (per-facet measurement workflow) -----
    v2: {
      imageryHealth: (lat: number, lng: number, zoom = 20, width = 2048, height = 1366) =>
        apiRequest<{
          status: 'ok' | 'degraded' | 'unavailable'
          provider?: string
          url?: string
          width_px?: number
          height_px?: number
          zoom?: number
          lat?: number
          lng?: number
          metres_per_pixel?: number
          feet_per_pixel?: number
          health_score: number
          warnings: string[]
          providers_tried: string[]
          cached?: boolean
        }>(`/api/v1/roofing/v2/imagery/health?lat=${lat}&lng=${lng}&zoom=${zoom}&width_px=${width}&height_px=${height}`,
          undefined, 90000, 300000),  // cache 5 min — tile health is deterministic per lat/lng/zoom
      imageryFetch: (lat: number, lng: number, opts?: { zoom?: number; width_px?: number; height_px?: number; include_bytes?: boolean }) =>
        apiRequest<Record<string, unknown>>(
          `/api/v1/roofing/v2/imagery/fetch?include_bytes=${opts?.include_bytes ? 'true' : 'false'}`,
          {
            method: 'POST',
            body: JSON.stringify({
              lat, lng,
              zoom: opts?.zoom ?? 20,
              width_px: opts?.width_px ?? 2048,
              height_px: opts?.height_px ?? 1366,
            }),
          },
        ),
      // Auto-center: ask the backend (Gemini Vision) for the subject
      // building's bounding box, returns a recommended new center + zoom.
      detectBuilding: (lat: number, lng: number, zoom = 22, width = 2048, height = 1366) =>
        apiRequest<{
          found: boolean
          message?: string
          bbox_frac?: { x0: number; y0: number; x1: number; y1: number }
          center_frac?: { x: number; y: number }
          recenter?: { lat: number; lng: number }
          coverage_frac?: number
          suggested_zoom?: number
          confidence?: number
        }>(`/api/v1/roofing/v2/imagery/detect-building`, {
          method: 'POST',
          body: JSON.stringify({ lat, lng, zoom, width_px: width, height_px: height }),
        }, 60000),
      // Street-level photo of the address, so users who don't recognize the house
      // from above can match it and tap the right roof. Best-effort.
      getStreetView: (lat: number, lng: number) =>
        apiRequest<{ available: boolean; image?: string }>(
          `/api/v1/roofing/v2/streetview?lat=${lat}&lng=${lng}`),
      locationSearch: (q: string, withGeographies = false) =>
        apiRequest<{
          matches: Array<{
            matched_address: string
            street: string
            city: string
            state: string
            zip: string
            lat: number
            lng: number
            county: string
            county_fips: string
            state_fips: string
            source: string
          }>
          error: string | null
        }>(`/api/v1/roofing/v2/location/search?q=${encodeURIComponent(q)}&with_geographies=${withGeographies}`),
      locationValidate: (address: string) =>
        apiRequest<{
          matched_address: string
          street: string
          city: string
          state: string
          zip: string
          lat: number
          lng: number
          county: string
          county_fips: string
          state_fips: string
        }>(`/api/v1/roofing/v2/location/validate?address=${encodeURIComponent(address)}`),
      createRun: (req: {
        project_id: string
        blueprint_id?: string
        source?: 'manual' | 'blueprint' | 'aerial_solar' | 'aerial_outline' | 'photo' | 'hybrid'
        satellite_image_url?: string
        satellite_provider?: string
        satellite_zoom?: number
        satellite_lat?: number
        satellite_lng?: number
        imagery_health?: number
      }) =>
        apiRequest<{ id: string; project_id: string }>(`/api/v1/roofing/v2/runs`, {
          method: 'POST',
          body: JSON.stringify(req),
        }),
      getRun: (runId: string) =>
        apiRequest<{
          run: Record<string, unknown>
          facets: Array<Record<string, unknown>>
          edges: Array<Record<string, unknown>>
          penetrations: Array<Record<string, unknown>>
        }>(`/api/v1/roofing/v2/runs/${runId}`),
      // Most recent run for a project — used to RESUME saved roof work.
      latestRun: (projectId: string) =>
        apiRequest<{ run_id: string | null }>(`/api/v1/roofing/v2/projects/${projectId}/latest-run`),
      patchRun: (runId: string, updates: Record<string, unknown>) =>
        apiRequest<Record<string, unknown>>(`/api/v1/roofing/v2/runs/${runId}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        }),
      putFacets: (runId: string, payload: {
        image_width_px: number
        image_height_px: number
        zoom: number
        lat: number
        lng: number
        facets: Array<{
          facet_label: string
          polygon: [number, number][]
          pitch: string
          confidence?: number
          user_confirmed?: boolean
          ai_suggested?: boolean
        }>
      }) =>
        apiRequest<{ facets: Array<Record<string, unknown>>; count: number }>(
          `/api/v1/roofing/v2/runs/${runId}/facets`,
          { method: 'PUT', body: JSON.stringify(payload) },
        ),
      putEdges: (runId: string, payload: {
        image_width_px: number
        image_height_px: number
        zoom: number
        lat: number
        edges: Array<{
          facet_label: string
          vertex_index_start: number
          vertex_index_end: number
          edge_type: 'eave' | 'rake' | 'ridge' | 'hip' | 'valley' | 'gable_end' | 'wall_intersection' | 'unlabeled'
          shared_with_facet_label?: string
          user_confirmed?: boolean
        }>
      }) =>
        apiRequest<{ edges: Array<Record<string, unknown>>; count: number }>(
          `/api/v1/roofing/v2/runs/${runId}/edges`,
          { method: 'PUT', body: JSON.stringify(payload) },
        ),
      recompute: (runId: string) =>
        apiRequest<Record<string, unknown>>(`/api/v1/roofing/v2/runs/${runId}/recompute`),
      addPenetration: (runId: string, p: {
        type: string
        count?: number
        facet_id?: string
        pos_x_frac?: number
        pos_y_frac?: number
        width_in?: number
        height_in?: number
        ai_suggested?: boolean
        user_confirmed?: boolean
        notes?: string
      }) =>
        apiRequest<Record<string, unknown>>(`/api/v1/roofing/v2/runs/${runId}/penetrations`, {
          method: 'POST',
          body: JSON.stringify(p),
        }),
      deletePenetration: (runId: string, pid: string) =>
        apiRequest<Record<string, unknown>>(`/api/v1/roofing/v2/runs/${runId}/penetrations/${pid}`, {
          method: 'DELETE',
        }),
      suggestPenetrations: (runId: string) =>
        apiRequest<{
          suggestions: Array<{
            type: string
            pos_x_frac: number
            pos_y_frac: number
            confidence: number
            note: string
            ai_suggested: boolean
            user_confirmed: boolean
          }>
          message: string
        }>(`/api/v1/roofing/v2/runs/${runId}/penetrations/suggest`),
      // Google Solar building insights — pre-segmented roof planes with
      // measured pitch/azimuth/area. Inert (available:false) until the backend
      // GOOGLE_SOLAR_API_KEY is set or where Google has no coverage.
      getSolar: (runId: string) =>
        apiRequest<{
          available: boolean
          reason?: string
          imagery_quality?: string
          imagery_date?: string
          whole_roof_area_sqft?: number
          segment_count?: number
          segments?: Array<{
            pitch_degrees: number
            pitch: string
            azimuth_degrees: number
            slope_direction: string
            area_m2: number
            area_sqft: number
            center: { lat: number; lng: number }
            bbox: { sw: { lat: number; lng: number }; ne: { lat: number; lng: number } }
            height_m: number | null
          }>
          cached?: boolean
        }>(`/api/v1/roofing/v2/runs/${runId}/solar`, undefined, 60000, 1800000),  // cache 30 min — never re-bill the same run in a session
      // Consolidated ground-photo findings persisted on the run (pitch, chimney,
      // dormers, wall_abutment, roof_shape) — used to corroborate flashing edges.
      getGroundFindings: (runId: string) =>
        apiRequest<{
          findings: {
            roof_pitch?: string
            roof_shape?: string
            chimney?: { present: boolean; count: number }
            skylights?: number
            dormers?: number
            wall_abutment?: { present: boolean; note: string }
          } | null
        }>(`/api/v1/roofing/v2/runs/${runId}/ground-findings`),
      // Building footprint (OpenStreetMap) — free, nationwide rural fallback
      // when Google Solar has no coverage. Returns the building outline ring.
      getFootprint: (runId: string) =>
        apiRequest<{
          available: boolean
          reason?: string
          source?: string
          ring?: Array<{ lat: number; lng: number }>
          cached?: boolean
        }>(`/api/v1/roofing/v2/runs/${runId}/footprint`, undefined, 60000, 1800000),
      // Ground-photo exterior intelligence — Gemini reads pitch/chimney/gable/
      // materials from a contractor-uploaded ground photo to improve the roof.
      analyzeGroundPhoto: async (runId: string, file: File) => {
        // Multipart upload — send the image BYTES directly (no storage round-
        // trip) so it works regardless of bucket config + accepts any phone
        // image. apiRequest forces JSON, so we hand-roll the multipart fetch.
        const session = await getCachedSession()
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetchWithTimeout(
          `${API_BASE}/api/v1/roofing/v2/runs/${runId}/ground-photos/analyze`,
          {
            method: 'POST',
            // No Content-Type — the browser sets the multipart boundary.
            headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
            body: fd,
          },
          120000,
        )
        if (!res.ok) {
          const text = await res.text()
          let detail = text
          try { detail = JSON.parse(text).detail ?? text } catch { /* keep raw */ }
          throw new Error(`[HTTP ${res.status}] ${detail}`)
        }
        type GroundFindings = {
          roof_pitch: string
          pitch_confidence: 'high' | 'medium' | 'low'
          pitch_method: 'gable_end' | 'slope_angle' | 'not_visible'
          roof_shape?: 'gable' | 'hip' | 'complex' | 'flat' | 'shed' | 'unknown'
          chimney: { present: boolean; count: number; height: 'short' | 'medium' | 'tall'; material: string }
          skylights: number
          dormers: number
          wall_abutment?: { present: boolean; note: string }
          gable_walls_visible: number
          roof_material: string
          roof_color: string
          siding_material: string
          stories: number
          notes: string
        }
        return res.json() as Promise<{
          // One entry per page (a single image → one entry; a PDF → one per page)
          results: Array<{ page: number; findings: GroundFindings | null; message: string }>
          findings: GroundFindings | null   // convenience alias for the first usable page
          message: string
        }>
      },
      // AI roof-to-wall transition detection — segments where the roof meets a
      // wall/dormer, used to auto-label wall_intersection edges for flashing.
      detectWallTransitions: (runId: string) =>
        apiRequest<{
          transitions: Array<{
            p0: [number, number]
            p1: [number, number]
            kind: 'wall' | 'dormer'
            confidence: number
            reason: string
          }>
          reason?: string
          message: string
        }>(`/api/v1/roofing/v2/runs/${runId}/detect-wall-transitions`, {}, 120000),
      // Flashing Intelligence — deterministic flashing requirements derived
      // from confirmed facets/edges/penetrations.
      getFlashing: (runId: string) =>
        apiRequest<{
          requirements: Array<{
            id: string
            type: 'step' | 'counter' | 'apron' | 'headwall' | 'kickout' | 'valley' | 'chimney' | 'skylight' | 'cricket'
            measure: 'linear' | 'count'
            length_ft: number
            quantity: number
            pieces: number | null
            source: string
            confidence: 'high' | 'medium' | 'estimated'
            needs_review: boolean
            location: Record<string, unknown>
          }>
          totals: Record<string, number>
          count: number
          message: string
          gaps?: Array<{ type: string; detected: number; present: number; message: string }>
        }>(`/api/v1/roofing/v2/runs/${runId}/flashing`),
      suggestFacets: (runId: string) =>
        apiRequest<{
          facets: Array<{
            polygon: [number, number][]
            confidence: number
            predicted_pitch: string
            pitch_source?: string
            facet_type?: string
            solar_confirmed?: boolean
            note: string
          }>
          solar_used?: boolean
          count_check?: {
            shape: string
            expected: number
            detected: number
            note: string
          } | null
          message: string
          reason?: string
        }>(`/api/v1/roofing/v2/runs/${runId}/facets/suggest`, {}, 120000),
      // Save the contractor's "tap your house" point (image fractions 0..1) so
      // facet auto-detect locks onto the right building regardless of geocode.
      setSubjectPoint: (runId: string, x: number, y: number, lat?: number, lng?: number) =>
        apiRequest<{ ok: boolean; subject_point: { x: number; y: number } }>(
          `/api/v1/roofing/v2/runs/${runId}/subject-point`,
          { method: 'POST', body: JSON.stringify({ x, y, lat, lng }) },
        ),
      // Record AI facet suggestions the contractor REJECTED, as negative training
      // data. Fire-and-forget — must never block the editor flow.
      recordFacetRejections: (
        runId: string,
        rejections: Array<{ polygon: [number, number][]; facet_type?: string; ai_confidence?: number }>,
      ) =>
        apiRequest<{ recorded: number; message?: string }>(
          `/api/v1/roofing/v2/runs/${runId}/facets/rejections`,
          { method: 'POST', body: JSON.stringify({ rejections }) },
        ),
      upscaleImagery: (imageUrl: string, scale: 2 | 4 = 4) =>
        apiRequest<{
          status: 'disabled' | 'completed' | 'failed'
          upscaled_url?: string
          scale_factor?: number
          error?: string
          honesty_note?: string
        }>(`/api/v1/roofing/v2/imagery/upscale`, {
          method: 'POST',
          body: JSON.stringify({ image_url: imageUrl, scale }),
        }, 240000),  // 4 minutes — covers Render cold start (~75s) + clarity-upscaler (~30s) + buffer
      suggestEdgeLabels: (runId: string, payload: {
        facets: Array<{ label: string; polygon: [number, number][]; pitch_degrees?: number }>
        unlabeled_edges: Array<{ facet_label: string; vertex_index_start: number; vertex_index_end: number }>
      }) =>
        apiRequest<{
          suggestions: Array<{
            facet_label: string
            vertex_index_start: number
            suggested_edge_type: 'eave' | 'rake' | 'ridge' | 'hip' | 'valley' | 'gable_end' | 'wall_intersection' | 'unlabeled'
            confidence: number
            reason: string
            shared_with_facet_label?: string | null
          }>
          message: string
        }>(`/api/v1/roofing/v2/runs/${runId}/edges/suggest-labels`, {
          method: 'POST',
          body: JSON.stringify(payload),
        }, 120000),
      getCatalog: (region?: string) =>
        apiRequest<{
          items: Array<{
            sku: string
            category: string
            item_name: string
            unit: string
            coverage_basis: string
            coverage_value: number
            unit_cost: number
            notes: string
          }>
          count: number
        }>(`/api/v1/roofing/v2/catalog${region ? `?region=${encodeURIComponent(region)}` : ''}`),
      // Accuracy flywheel — record what the roof ACTUALLY measured after the
      // job; Axis snapshots its prediction and builds calibration stats.
      recordActuals: (runId: string, payload: {
        actual_squares: number
        actual_ridge_hip_ft?: number
        actual_valley_ft?: number
        actual_eave_ft?: number
        notes?: string
      }) =>
        apiRequest<{
          recorded: boolean
          this_job_diff_pct: number | null
          calibration: { jobs: number; mean_abs_pct_error: number; median_abs_pct_error: number; bias_pct: number } | null
          message: string
        }>(`/api/v1/roofing/v2/runs/${runId}/actuals`, {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      getCalibration: () =>
        apiRequest<{ jobs: number; mean_abs_pct_error?: number; median_abs_pct_error?: number; bias_pct?: number }>(
          `/api/v1/roofing/v2/calibration`, undefined, 30000, 60000),
      // Price book: save/clear MY price for a SKU (dealer-desk rates)
      setMyPrice: (sku: string, unitCost: number | null) =>
        apiRequest<{ ok: boolean }>(`/api/v1/roofing/v2/materials/my-price`, {
          method: 'POST', body: JSON.stringify({ sku, unit_cost: unitCost }),
        }),
      // Live fetched-price check for one material line (Tavily-sourced)
      liveMaterialPrice: (item: string, basePrice: number, zip?: string) =>
        apiRequest<{
          material: string
          live_price: number
          adjusted_price: number
          regional_mult: number
          source: string
          source_url: string
          retrieved_at: string
          is_live: boolean
          note: string
        }>(`/api/v1/roofing/v2/materials/live-price?item=${encodeURIComponent(item)}&base_price=${basePrice}${zip ? `&zip_code=${zip}` : ''}`,
          undefined, 45000, 3600000),
      getMaterials: (runId: string, wastePct = 12) =>
        apiRequest<{
          run_id: string
          waste_pct: number
          waste_table: number[]
          lines: Array<{
            sku: string
            item_name: string
            category: string
            unit: string
            coverage_basis: string
            base_quantity: number
            waste_quantities: Record<string, number>
            unit_cost: number
            total_cost_at_default_waste: number
            default_waste_pct: number
            notes: string
            computation_trace: string
          }>
          summary: {
            per_waste_totals: Record<string, number>
            per_category: Record<string, { items: number; subtotal: number }>
            default_waste_pct: number
            line_count: number
          }
          grand_total_at_selected_waste: number
          totals_input: Record<string, number | string>
          penetrations_confirmed: Array<Record<string, unknown>>
        }>(`/api/v1/roofing/v2/runs/${runId}/materials?waste_pct=${wastePct}`),
      downloadReport: async (runId: string) => {
        const session = await getCachedSession()
        const token = session?.access_token
        const res = await fetch(`${API_BASE}/api/v1/roofing/v2/runs/${runId}/report`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) {
          const msg = await res.text().catch(() => '')
          throw new Error(msg || `Report failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const cd = res.headers.get('content-disposition') || ''
        const m = /filename="([^"]+)"/.exec(cd)
        a.download = m ? m[1] : `axis-roof-report-${runId.slice(0, 8)}.pdf`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      },
      // Every roof report across a user's projects (for the Reports tab).
      listReports: (userId: string) =>
        apiRequest<{ reports: Array<{
          run_id: string
          project_id: string
          project_name: string
          address: string | null
          created_at: string
          pdf_url: string | null
        }> }>(`/api/v1/roofing/v2/reports?user_id=${userId}`),
      // A shareable signed URL for a run's report (builds + stores it if needed).
      getReportShareUrl: (runId: string) =>
        apiRequest<{ url: string }>(`/api/v1/roofing/v2/runs/${runId}/report/url`, {}, 60000),
      addSidingMeasurement: (payload: {
        project_id: string
        elevation: 'front' | 'rear' | 'left' | 'right' | 'other'
        photo_url?: string
        reference_object?: 'standard_door_80' | 'garage_door_84' | 'garage_door_w_16' | 'window_36' | 'custom'
        reference_height_in?: number
        reference_pixel_h?: number
        region_polygon: [number, number][]
        material_type?: string
        notes?: string
      }) =>
        apiRequest<Record<string, unknown>>(`/api/v1/roofing/v2/siding/measurements`, {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      listSidingMeasurements: (projectId: string) =>
        apiRequest<{
          measurements: Array<Record<string, unknown>>
          total_sqft: number
          count: number
        }>(`/api/v1/roofing/v2/siding/measurements?project_id=${projectId}`),
    },
    analyzePhotos: async (photos: File[], address: string): Promise<Record<string, unknown>> => {
      const { getCachedSession: getSession } = await import('./supabase')
      const session = await getSession()
      const token = session?.access_token
      const form = new FormData()
      photos.forEach(p => form.append('photos', p))
      form.append('address', address)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 180000)
      try {
        const res = await fetch(`${API_BASE}/api/v1/roofing/analyze-photos`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form,
          signal: controller.signal,
        })
        clearTimeout(timer)
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.json()
      } catch (err) { clearTimeout(timer); throw err }
    },
  },
  training: {
    stats: () =>
      apiRequest<{
        total: number
        by_task_type: Record<string, number>
        by_quality: Record<string, number>
        by_capture_source: Record<string, number>
        ready_for_training: number
        recent_7d: number
      }>(`/api/v1/training/stats`),
    list: (params?: {
      task_type?: string
      quality_tier?: string
      capture_source?: string
      limit?: number
      offset?: number
    }) => {
      const qs = new URLSearchParams()
      if (params?.task_type) qs.set('task_type', params.task_type)
      if (params?.quality_tier) qs.set('quality_tier', params.quality_tier)
      if (params?.capture_source) qs.set('capture_source', params.capture_source)
      if (params?.limit) qs.set('limit', String(params.limit))
      if (params?.offset) qs.set('offset', String(params.offset))
      const q = qs.toString() ? `?${qs}` : ''
      return apiRequest<{
        examples: Array<Record<string, unknown>>
        count: number
      }>(`/api/v1/training/examples${q}`)
    },
    patch: (id: string, updates: { quality_tier?: string; reviewer_notes?: string }) =>
      apiRequest<Record<string, unknown>>(`/api/v1/training/examples/${id}`, {
        method: 'PATCH', body: JSON.stringify(updates),
      }),
    downloadCoco: async (taskType: string, minQuality = 'reviewed') => {
      const session = await getCachedSession()
      const token = session?.access_token
      const res = await fetch(
        `${API_BASE}/api/v1/training/export?task_type=${taskType}&min_quality=${minQuality}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      )
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `axis-training-${taskType}-${minQuality}.coco.json`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    },
  },
  exterior: {
    createJob: (payload: { project_id: string; report_type?: 'complete' | 'roof_only'; notes?: string }) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/jobs`, {
        method: 'POST', body: JSON.stringify(payload),
      }),
    listJobs: (projectId: string) =>
      apiRequest<{ jobs: Array<Record<string, unknown>> }>(
        `/api/v1/exterior/v1/jobs?project_id=${encodeURIComponent(projectId)}`,
      ),
    getJob: (jobId: string) =>
      apiRequest<{
        job: Record<string, unknown>
        photos: Array<Record<string, unknown>>
        measurements: Array<Record<string, unknown>>
        coverage: Record<string, { count: number; effective_count?: number; status: string }>
        photogrammetry_available: boolean
      }>(`/api/v1/exterior/v1/jobs/${jobId}`),
    patchJob: (jobId: string, updates: Record<string, unknown>) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/jobs/${jobId}`, {
        method: 'PATCH', body: JSON.stringify(updates),
      }),
    registerPhoto: (payload: {
      job_id: string
      photo_url: string
      storage_path?: string
      original_filename?: string
      file_size_kb?: number
      width_px?: number
      height_px?: number
      exif_data?: Record<string, unknown>
      gps_lat?: number
      gps_lng?: number
    }) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/photos`, {
        method: 'POST', body: JSON.stringify(payload),
      }, 60000),
    patchPhoto: (photoId: string, updates: Record<string, unknown>) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/photos/${photoId}`, {
        method: 'PATCH', body: JSON.stringify(updates),
      }),
    deletePhoto: (photoId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/photos/${photoId}`, {
        method: 'DELETE',
      }),
    createMeasurement: (payload: {
      job_id: string
      photo_id?: string
      measurement_type: 'wall' | 'window' | 'door' | 'trim' | 'corner_inside' | 'corner_outside' | 'roof_visible'
      facade_id?: string
      elevation?: 'front' | 'right' | 'rear' | 'left' | 'other'
      material_type?: string
      reference_object?: 'standard_door_80' | 'garage_door_84' | 'window_36' | 'custom' | 'photogrammetry'
      reference_height_in?: number
      reference_pixel_h?: number
      region_polygon?: [number, number][]
      width_in?: number
      height_in?: number
      snapped_to_standard?: boolean
      notes?: string
    }) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/measurements`, {
        method: 'POST', body: JSON.stringify(payload),
      }),
    deleteMeasurement: (id: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/measurements/${id}`, {
        method: 'DELETE',
      }),
    submitPhotogrammetry: (jobId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/jobs/${jobId}/photogrammetry/submit`, {
        method: 'POST',
      }, 120000),
    photogrammetryStatus: (jobId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/jobs/${jobId}/photogrammetry/status`),
    getSummary: (jobId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/exterior/v1/jobs/${jobId}/summary`),
    windowStandards: () =>
      apiRequest<{ sizes: Array<{ width_in: number; height_in: number }> }>(
        `/api/v1/exterior/v1/standards/windows`,
      ),
    doorStandards: () =>
      apiRequest<{ sizes: Array<{ width_in: number; height_in: number }> }>(
        `/api/v1/exterior/v1/standards/doors`,
      ),
    downloadReport: async (jobId: string) => {
      const session = await getCachedSession()
      const token = session?.access_token
      const res = await fetch(`${API_BASE}/api/v1/exterior/v1/jobs/${jobId}/report`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(msg || `Report failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers.get('content-disposition') || ''
      const m = /filename="([^"]+)"/.exec(cd)
      a.download = m ? m[1] : `axis-exterior-${jobId.slice(0, 8)}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    },
  },
  chat: {
    ask: (payload: {
      section: string
      page_data: Record<string, unknown>
      history: Array<{ role: 'user' | 'assistant'; content: string }>
      message: string
    }) =>
      apiRequest<{ reply: string; section?: string }>(
        `/api/v1/chat/ask`,
        { method: 'POST', body: JSON.stringify(payload) },
        45000,
      ),
  },
  crm: {
    listLeads: (userId: string) =>
      apiRequest<CRMLead[]>(`/api/v1/crm/leads?user_id=${userId}`),
    createLead: (lead: Partial<CRMLead>, userId: string) =>
      apiRequest<CRMLead>(`/api/v1/crm/leads?user_id=${userId}`, { method: 'POST', body: JSON.stringify(lead) }),
    updateLead: (leadId: string, patch: Partial<CRMLead>) =>
      apiRequest<CRMLead>(`/api/v1/crm/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    deleteLead: (leadId: string) =>
      apiRequest<{ ok: boolean }>(`/api/v1/crm/leads/${leadId}`, { method: 'DELETE' }),
    getNotes: (leadId: string) =>
      apiRequest<Array<{ id: string; lead_id: string; text: string; user_id: string; created_at: string }>>(`/api/v1/crm/leads/${leadId}/notes`),
    addNote: (leadId: string, text: string, userId: string) =>
      apiRequest<{ id: string; lead_id: string; text: string; user_id: string; created_at: string }>(`/api/v1/crm/leads/${leadId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text, user_id: userId }),
      }),
    deleteNote: (leadId: string, noteId: string) =>
      apiRequest<{ ok: boolean }>(`/api/v1/crm/leads/${leadId}/notes/${noteId}`, { method: 'DELETE' }),
  },
  // Voice-note transcription (the rest of the photos surface was archived
  // 2026-05-01 — see Obsidian: BuildAI - Photo Feature Archive (2026-05-01)).
  // Path stays /api/v1/photos/transcribe so client + server stay aligned.
  photos: {
    transcribe: async (audio: Blob, filename = 'note.webm') => {
      const session = await getCachedSession()
      const token = session?.access_token
      const form = new FormData()
      form.append('audio', audio, filename)
      const res = await fetch(`${API_BASE}/api/v1/photos/transcribe`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(t || `HTTP ${res.status}`)
      }
      return res.json() as Promise<{ text: string; language: string | null; provider: string }>
    },
  },
  model3d: {
    parse: (projectId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/model3d/${projectId}/parse3d`, { method: 'POST' }, 120000),
    get: (projectId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/model3d/${projectId}/model3d`),
  },
  visualizer: {
    generate: (file: File, description: string, city: string, state: string) => {
      const form = new FormData()
      form.append('file', file)
      form.append('description', description)
      form.append('city', city)
      form.append('state', state)
      return fetchWithTimeout(
        `${API_BASE}/api/v1/visualizer/generate`,
        { method: 'POST', body: form },
        180000,  // 3-minute timeout — image generation can be slow on first run
      ).then(async res => {
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.json() as Promise<Record<string, unknown>>
      })
    },
  },
  materialCheck: {
    uploadFile: (file: File, city: string, state: string, county: string, projectType: string) => {
      const form = new FormData()
      form.append('file', file)
      form.append('city', city)
      form.append('state', state)
      form.append('county', county)
      form.append('project_type', projectType)
      return fetch(`${API_BASE}/api/v1/material-check/upload`, {
        method: 'POST',
        body: form,
        // No Content-Type header — browser sets multipart boundary automatically
      }).then(async res => {
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.json() as Promise<Record<string, unknown>>
      })
    },
    checkText: (rawText: string, city: string, state: string, county: string, projectType: string) =>
      apiRequest<Record<string, unknown>>('/api/v1/material-check/text', {
        method: 'POST',
        body: JSON.stringify({ raw_text: rawText, city, state, county, project_type: projectType }),
      }, 240000),
  },
  axis: {
    run: (projectId: string, options?: {
      quality?: string
      roof_type?: string
      time_of_day?: string
      wall_material?: string
      roof_material?: string
      start_date?: string
      run_5d?: boolean
      generate_pdf?: boolean
      project_name?: string
      trade_type?: string
      use_cloud_gpu?: boolean
    }) =>
      apiRequest<{ job_id: string; status: string; message: string; blender_available: boolean }>(
        `/api/v1/axis/${projectId}/run`,
        { method: 'POST', body: JSON.stringify(options || {}) },
        300000, // 5-minute timeout for pipeline kickoff
      ),
    status: (projectId: string, jobId?: string) =>
      apiRequest<{ job_id: string | null; status: string; error?: string; elapsed_s: number }>(
        `/api/v1/axis/${projectId}/status${jobId ? `?job_id=${jobId}` : ''}`
      ),
    results: (projectId: string) =>
      apiRequest<{
        live_pricing: Record<string, unknown> | null
        summary: Record<string, unknown> | null
        quantities: Record<string, unknown> | null
        cost_report: Record<string, unknown> | null
        schedule: Record<string, unknown> | null
        insights: Record<string, unknown> | null
        render_urls: Record<string, string>
        pdf_url: string | null
      }>(`/api/v1/axis/${projectId}/results`),
    renderUrl: (projectId: string, filename: string) =>
      `${(process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()}/api/v1/axis/${projectId}/render/${filename}`,
    reportUrl: (projectId: string) =>
      `${(process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()}/api/v1/axis/${projectId}/report`,
  },
  renders: {
    generate: (projectId: string, style: string, timeOfDay: string, userContext = '') =>
      apiRequest<{
        exterior_views:     { angle: string; label: string; url: string | null }[]
        room_renders:       { name: string; url: string | null }[]
        style:              string
        time_of_day:        string
        blueprint_context?: Record<string, unknown>
      }>(
        `/api/v1/renders/${projectId}/generate`,
        { method: 'POST', body: JSON.stringify({ style, time_of_day: timeOfDay, user_context: userContext }) },
        300000,  // 5-min timeout — images generated serially with 10s gaps to respect Gemini rate limits
      ),
  },
}
