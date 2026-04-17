import { supabase } from './supabase'
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
  Photo,
  PermitField,
  Jurisdiction,
  VendorOption,
} from '@/types'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

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

export async function apiRequest<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = 90000   // 90s — Render free tier cold starts can take 75s
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  const fetchOptions: RequestInit = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
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
      return apiRequest<{ portal_url: string | null; portal_name: string | null; instructions: string | null; source: string }>(
        `/api/v1/permits/portal-search?${params}`
      )
    },
    analyzeRequirements: (projectId: string, notes: string, files: File[]) => {
      const form = new FormData()
      form.append('project_id', projectId)
      form.append('notes', notes)
      for (const f of files) form.append('files', f)
      return fetchWithTimeout(
        `${API_BASE}/api/v1/permits/analyze-requirements`,
        { method: 'POST', body: form },
        120000,
      ).then(async res => {
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.json() as Promise<{ fields: Record<string, string>; summary: string; files_processed: number }>
      })
    },
    fetchForm: (projectId: string, requirementsFields: Record<string, string> = {}) =>
      apiRequest<{ form_url: string | null; city: string; state: string; project_type: string; fields: PermitField[]; jurisdiction: Jurisdiction }>(
        `/api/v1/permits/fetch-form/${projectId}`,
        { method: 'POST', body: JSON.stringify({ requirements_context: JSON.stringify(requirementsFields) }) },
        60000
      ),
    generatePdf: (projectId: string, fields: PermitField[], formUrl: string | null, useWebForm: boolean): Promise<Blob> =>
      fetch(`${API_BASE}/api/v1/permits/generate-pdf/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, form_url: formUrl, use_web_form: useWebForm }),
      }).then(async res => {
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.blob()
      }),
  },
  contractorProfile: {
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
      const { data: { session } } = await supabase.auth.getSession()
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
    aerialReport: (projectId: string, address: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/roofing/aerial-report`, {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, address }),
      }, 60000),
    aerialReportStandalone: (address: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/roofing/aerial-report/standalone`, {
        method: 'POST',
        body: JSON.stringify({ address }),
      }, 60000),
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
    analyzePhotos: async (photos: File[], address: string): Promise<Record<string, unknown>> => {
      const { data: { session } } = await (await import('./supabase')).supabase.auth.getSession()
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
  photos: {
    getUploadUrl: (projectId: string, filename: string, contentType: string) =>
      apiRequest<{ upload_url: string; key: string; public_url: string }>(
        `/api/v1/photos/upload-url/${projectId}?filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(contentType)}`
      ),
    register: (
      projectId: string,
      payload: {
        storage_key: string
        filename: string
        phase: string
        captured_at?: string
        latitude?: number
        longitude?: number
        notes?: string
        tags?: string[]
      },
    ) =>
      apiRequest<Photo>(`/api/v1/photos/register/${projectId}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    list: (projectId: string) =>
      apiRequest<Photo[]>(`/api/v1/photos/${projectId}`),
    update: (
      projectId: string,
      photoId: string,
      patch: { notes?: string; tags?: string[]; phase?: string },
    ) =>
      apiRequest<Photo>(`/api/v1/photos/${projectId}/${photoId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    autoTag: (projectId: string, photoId: string) =>
      apiRequest<{ photo_id: string; auto_tags: Record<string, unknown> }>(
        `/api/v1/photos/autotag/${projectId}/${photoId}`,
        { method: 'POST' },
        60000,
      ),
    transcribe: async (audio: Blob, filename = 'note.webm') => {
      const { data: { session } } = await supabase.auth.getSession()
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
    downloadDamageReport: async (projectId: string, opts?: { includeAll?: boolean }) => {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const qs = opts?.includeAll ? '?include_all=true' : ''
      const res = await fetch(`${API_BASE}/api/v1/photos/damage-report/${projectId}/pdf${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(t || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="?([^";]+)"?/)
      a.download = match?.[1] || `damage-report-${projectId.slice(0, 8)}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    },
    delete: (projectId: string, photoId: string) =>
      apiRequest<{ ok: boolean }>(`/api/v1/photos/${projectId}/${photoId}`, { method: 'DELETE' }),
    measure: (projectId: string) =>
      apiRequest<Record<string, unknown>>(`/api/v1/photos/measure/${projectId}`, { method: 'POST' }, 120000),
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
