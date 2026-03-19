import { supabase } from './supabase'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export async function apiRequest<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options?.headers,
      },
    })
  } catch (err: any) {
    clearTimeout(timer)
    if (err.name === 'AbortError') throw new Error('Request timed out. The server may be unavailable.')
    throw new Error('Network error. Please check your connection.')
  }
  clearTimeout(timer)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
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
      }),
    get: (id: string) =>
      apiRequest<any>(`/api/v1/projects/${id}`),
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
