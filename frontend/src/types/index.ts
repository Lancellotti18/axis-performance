export type Plan = 'starter' | 'pro' | 'enterprise'
export type ProjectStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type BlueprintType = 'residential' | 'commercial'

export interface Profile {
  id: string
  full_name: string
  company_name: string
  region: string
  plan: Plan
  uploads_used: number
  created_at: string
}

export interface Project {
  id: string
  user_id: string
  name: string
  description?: string
  status: ProjectStatus
  created_at: string
  updated_at: string
}

export interface Blueprint {
  id: string
  project_id: string
  file_url: string
  file_type: string
  page_count: number
  file_size_kb: number
  status: ProjectStatus
  created_at: string
}

export interface Room {
  name: string
  sqft: number
  dimensions: { width: number; height: number }
}

export interface Analysis {
  id: string
  blueprint_id: string
  rooms: Room[]
  walls: Array<{ length: number; thickness: number; type: string }>
  openings: Array<{ type: 'door' | 'window'; width: number; height: number }>
  electrical: Array<{ type: string; x: number; y: number }>
  plumbing: Array<{ type: string; x: number; y: number }>
  total_sqft: number
  confidence: number
  overlay_url?: string
}

export interface MaterialEstimate {
  id: string
  category: string
  item_name: string
  quantity: number
  unit: string
  unit_cost: number
  total_cost: number
}

export interface CostEstimate {
  id: string
  materials_total: number
  labor_total: number
  markup_pct: number
  overhead_pct: number
  grand_total: number
  region: string
  labor_hours: number
}

export type ComplianceSeverity = 'required' | 'recommended' | 'info'
export type ComplianceRisk = 'low' | 'medium' | 'high'
export type ComplianceStatus = 'not_run' | 'pending' | 'processing' | 'complete' | 'failed'

export interface ComplianceItem {
  id: string
  check_id: string
  category: string
  title: string
  description: string
  severity: ComplianceSeverity
  action: string
  deadline: string | null
  penalty: string | null
  source: string | null
}

export interface ComplianceCheck {
  status: ComplianceStatus
  summary: string | null
  risk_level: ComplianceRisk | null
  region: string | null
  city: string | null
  project_type: string | null
  created_at: string | null
  items: ComplianceItem[]
}
