import { supabase } from './supabase'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

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
  try {
    res = await fetchWithTimeout(`${API_BASE}${path}`, fetchOptions, timeoutMs)
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // Auto-retry once — the cold start may have finished during the first attempt
      try {
        res = await fetchWithTimeout(`${API_BASE}${path}`, fetchOptions, timeoutMs)
      } catch (retryErr: any) {
        if (retryErr.name === 'AbortError') throw new Error('Server is taking too long to respond. Please try again in a moment.')
        throw new Error('Network error. Please check your connection.')
      }
    } else {
      throw new Error('Network error. Please check your connection.')
    }
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
  },
}
