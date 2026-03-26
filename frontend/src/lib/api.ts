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
    create: (payload: { name: string; description?: string; region?: string; blueprint_type?: string }, userId: string) =>
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
