import { supabase } from './supabase'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (err: any) {
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

  let res: Response
  // Retry up to 3 times — handles cold starts and transient failures
  let lastErr: any
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetchWithTimeout(`${API_BASE}${path}`, fetchOptions, timeoutMs)
      lastErr = null
      break
    } catch (err: any) {
      lastErr = err
      if (err.name === 'AbortError') continue   // timed out — retry
      // Network-level failure (CORS, connection refused, etc.) — wait briefly then retry
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500))
    }
  }
  if (lastErr) {
    if (lastErr.name === 'AbortError') throw new Error('Server is taking too long to respond. Please try again in a moment.')
    throw new Error('Network error. Please check your connection.')
  }

  if (!res!.ok) {
    const text = await res!.text()
    throw new Error(text || `HTTP ${res!.status}`)
  }
  return res!.json()
}

// Projects
export const api = {
  projects: {
    list: (userId: string) =>
      apiRequest<any[]>(`/api/v1/projects/?user_id=${userId}`),
    create: (payload: { name: string; description?: string; region?: string; blueprint_type?: string; city?: string; zip_code?: string }, userId: string) =>
      apiRequest<any>(`/api/v1/projects/?user_id=${userId}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }, 60000),
    get: (id: string) =>
      apiRequest<any>(`/api/v1/projects/${id}`),
    rename: (id: string, name: string) =>
      apiRequest<any>(`/api/v1/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    delete: (id: string) =>
      apiRequest<any>(`/api/v1/projects/${id}`, { method: 'DELETE' }),
    archive: (id: string) =>
      apiRequest<any>(`/api/v1/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      }),
    restore: (id: string) =>
      apiRequest<any>(`/api/v1/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: false }),
      }),
    listArchived: (userId: string) =>
      apiRequest<any[]>(`/api/v1/projects/?user_id=${userId}&include_archived=true`),
    getRiskScore: (projectId: string) =>
      apiRequest<any>(`/api/v1/projects/${projectId}/risk-score`, {}, 90000),
  },
  blueprints: {
    getUploadUrl: (projectId: string, filename: string, contentType: string) =>
      apiRequest<{ upload_url: string; key: string }>(
        `/api/v1/blueprints/upload-url?project_id=${projectId}&filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(contentType)}`
      ),
    register: (projectId: string, fileKey: string, fileType: string, fileSizeKb: number) =>
      apiRequest<any>(`/api/v1/blueprints/?project_id=${projectId}&file_key=${encodeURIComponent(fileKey)}&file_type=${fileType}&file_size_kb=${fileSizeKb}`, {
        method: 'POST',
      }),
    triggerAnalysis: (blueprintId: string) =>
      apiRequest<{ job_id: string; status: string }>(`/api/v1/blueprints/${blueprintId}/analyze`, { method: 'POST' }),
    getStatus: (blueprintId: string) =>
      apiRequest<{ status: string }>(`/api/v1/blueprints/${blueprintId}/status`),
    viewUrl: (blueprintId: string) => `${API_BASE}/api/v1/blueprints/${blueprintId}/view`,
  },
  analyses: {
    getByBlueprint: (blueprintId: string) =>
      apiRequest<any>(`/api/v1/analyses/by-blueprint/${blueprintId}`),
  },
  estimates: {
    get: (projectId: string) =>
      apiRequest<any>(`/api/v1/estimates/${projectId}`),
    update: (projectId: string, payload: any) =>
      apiRequest<any>(`/api/v1/estimates/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
  },
  reports: {
    generate: (projectId: string) =>
      apiRequest<any>(`/api/v1/reports/${projectId}/generate`, { method: 'POST' }),
    download: (projectId: string, format: string) =>
      apiRequest<{ download_url: string }>(`/api/v1/reports/${projectId}/download?format=${format}`),
  },
  materials: {
    add: (projectId: string, item: { item_name: string; category: string; quantity: number; unit: string; unit_cost: number; total_cost: number }) =>
      apiRequest<any>(`/api/v1/materials/${projectId}/add`, {
        method: 'POST',
        body: JSON.stringify(item),
      }),
    update: (projectId: string, itemId: string, item: any) =>
      apiRequest<any>(`/api/v1/materials/${projectId}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(item),
      }),
    delete: (projectId: string, itemId: string) =>
      apiRequest<any>(`/api/v1/materials/${projectId}/items/${itemId}`, { method: 'DELETE' }),
    searchPrices: (payload: { item_name: string; category: string; unit_cost: number; region: string; city?: string }) =>
      apiRequest<{ options: any[] }>(`/api/v1/materials/search-prices`, {
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
    fetchForm: (projectId: string) =>
      apiRequest<{ form_url: string | null; city: string; state: string; project_type: string; fields: any[] }>(
        `/api/v1/permits/fetch-form/${projectId}`,
        { method: 'POST' },
        60000
      ),
    generatePdf: (projectId: string, fields: any[], formUrl: string | null, useWebForm: boolean) =>
      apiRequest<Blob>(`/api/v1/permits/generate-pdf/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ fields, form_url: formUrl, use_web_form: useWebForm }),
      }, 60000),
  },
  contractorProfile: {
    get: (userId: string) =>
      apiRequest<any>(`/api/v1/contractor-profile/${userId}`),
    save: (userId: string, profile: any) =>
      apiRequest<any>(`/api/v1/contractor-profile/${userId}`, {
        method: 'POST',
        body: JSON.stringify(profile),
      }),
  },
  compliance: {
    getForRegion: (regionCode: string, projectType: string, city?: string) => {
      const params = new URLSearchParams({ project_type: projectType })
      if (city) params.set('city', city)
      return apiRequest<any>(`/api/v1/compliance/region/${regionCode}?${params}`)
    },
    triggerForProject: (projectId: string, city?: string) => {
      const params = city ? `?city=${encodeURIComponent(city)}` : ''
      return apiRequest<{ status: string; check_id: string }>(
        `/api/v1/compliance/project/${projectId}${params}`,
        { method: 'POST' }
      )
    },
    getForProject: (projectId: string) =>
      apiRequest<any>(`/api/v1/compliance/project/${projectId}`),
    checkMaterials: (projectId: string) =>
      apiRequest<any>(`/api/v1/compliance/materials-check?project_id=${projectId}`, { method: 'POST' }, 240000),
  },
  roofing: {
    analyzeMeasurements: (blueprintId: string) =>
      apiRequest<any>(`/api/v1/roofing/${blueprintId}/measure`, { method: 'POST' }, 90000),
    confirmMeasurements: (blueprintId: string, measurements: any) =>
      apiRequest<any>(`/api/v1/roofing/${blueprintId}/confirm`, {
        method: 'POST',
        body: JSON.stringify(measurements),
      }),
    getMeasurements: (blueprintId: string) =>
      apiRequest<any>(`/api/v1/roofing/${blueprintId}/measurements`),
    getShingleEstimate: (projectId: string) =>
      apiRequest<any>(`/api/v1/roofing/project/${projectId}/shingle-estimate`),
    aerialReport: (projectId: string, address: string) =>
      apiRequest<any>(`/api/v1/roofing/aerial-report`, {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, address }),
      }, 60000),
    aerialReportStandalone: (address: string) =>
      apiRequest<any>(`/api/v1/roofing/aerial-report/standalone`, {
        method: 'POST',
        body: JSON.stringify({ address }),
      }, 60000),
    stormRisk: (city: string, state: string, zipCode?: string) =>
      apiRequest<any>(`/api/v1/roofing/storm-risk`, {
        method: 'POST',
        body: JSON.stringify({ city, state, zip_code: zipCode || '' }),
      }, 60000),
  },
  crm: {
    listLeads: (userId: string) =>
      apiRequest<any[]>(`/api/v1/crm/leads?user_id=${userId}`),
    createLead: (lead: any, userId: string) =>
      apiRequest<any>(`/api/v1/crm/leads?user_id=${userId}`, { method: 'POST', body: JSON.stringify(lead) }),
    updateLead: (leadId: string, patch: any) =>
      apiRequest<any>(`/api/v1/crm/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    deleteLead: (leadId: string) =>
      apiRequest<any>(`/api/v1/crm/leads/${leadId}`, { method: 'DELETE' }),
    getNotes: (leadId: string) =>
      apiRequest<any[]>(`/api/v1/crm/leads/${leadId}/notes`),
    addNote: (leadId: string, text: string, userId: string) =>
      apiRequest<any>(`/api/v1/crm/leads/${leadId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text, user_id: userId }),
      }),
    deleteNote: (leadId: string, noteId: string) =>
      apiRequest<any>(`/api/v1/crm/leads/${leadId}/notes/${noteId}`, { method: 'DELETE' }),
  },
  photos: {
    getUploadUrl: (projectId: string, filename: string, contentType: string) =>
      apiRequest<{ upload_url: string; key: string; public_url: string }>(
        `/api/v1/photos/upload-url/${projectId}?filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(contentType)}`
      ),
    register: (projectId: string, payload: { storage_key: string; filename: string; phase: string }) =>
      apiRequest<any>(`/api/v1/photos/register/${projectId}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    list: (projectId: string) =>
      apiRequest<any[]>(`/api/v1/photos/${projectId}`),
    delete: (projectId: string, photoId: string) =>
      apiRequest<any>(`/api/v1/photos/${projectId}/${photoId}`, { method: 'DELETE' }),
    measure: (projectId: string) =>
      apiRequest<any>(`/api/v1/photos/measure/${projectId}`, { method: 'POST' }, 120000),
  },
  model3d: {
    parse: (projectId: string) =>
      apiRequest<any>(`/api/v1/model3d/${projectId}/parse3d`, { method: 'POST' }, 120000),
    get: (projectId: string) =>
      apiRequest<any>(`/api/v1/model3d/${projectId}/model3d`),
  },
  visualizer: {
    generate: (file: File, description: string, city: string, state: string) => {
      const form = new FormData()
      form.append('file', file)
      form.append('description', description)
      form.append('city', city)
      form.append('state', state)
      return fetch(`${API_BASE}/api/v1/visualizer/generate`, {
        method: 'POST',
        body: form,
      }).then(async res => {
        if (!res.ok) { const t = await res.text(); throw new Error(t || `HTTP ${res.status}`) }
        return res.json()
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
        return res.json()
      })
    },
    checkText: (rawText: string, city: string, state: string, county: string, projectType: string) =>
      apiRequest<any>('/api/v1/material-check/text', {
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
        live_pricing: any
        summary: any
        quantities: any
        cost_report: any
        schedule: any
        insights: any
        render_urls: Record<string, string>
        pdf_url: string | null
      }>(`/api/v1/axis/${projectId}/results`),
    renderUrl: (projectId: string, filename: string) =>
      `${(process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()}/api/v1/axis/${projectId}/render/${filename}`,
    reportUrl: (projectId: string) =>
      `${(process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()}/api/v1/axis/${projectId}/report`,
  },
}
// cache-bust 1774803796
// cache-bust 1774804395
