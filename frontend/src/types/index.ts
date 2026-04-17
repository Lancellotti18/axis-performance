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
  archived?: boolean
  region?: string
  city?: string
  zip_code?: string
  blueprint_type?: BlueprintType | string
  address?: string
  blueprints?: Blueprint[]
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
  error_message?: string
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

export type CRMStage = 'new' | 'contacted' | 'site_visit' | 'estimate_sent' | 'won' | 'lost'

export interface CRMLead {
  id: string
  user_id: string
  name: string
  phone?: string
  email?: string
  address?: string
  city?: string
  state?: string
  job_type?: string
  stage: CRMStage
  notes?: string
  estimated_value?: number
  created_at: string
  updated_at: string
}

export interface RoofMeasurements {
  id: string
  blueprint_id: string
  project_id: string
  total_sqft: number
  pitch: string
  facets: number
  ridges_ft: number
  valleys_ft: number
  eaves_ft: number
  rakes_ft: number
  waste_pct: number
  roof_type: string
  stories: number
  confidence: number
  notes: string
  confirmed: boolean
  created_at: string
}

// ── Photos ────────────────────────────────────────────────────────────────
export type PhotoPhase = 'before' | 'during' | 'after'

export interface PhotoAutoTags {
  phase?: PhotoPhase | null
  area?: string | null
  materials?: string[]
  damage?: string[]
  safety?: string[]
  summary?: string | null
  confidence?: number
  autotag_unverified?: boolean
  error?: string
}

export interface Photo {
  id: string
  project_id: string
  storage_key: string
  filename: string
  phase: PhotoPhase
  url: string
  created_at: string
  captured_at?: string | null
  latitude?: number | null
  longitude?: number | null
  notes?: string | null
  tags?: string[] | null
  auto_tags?: PhotoAutoTags | null
  ai_tagged_at?: string | null
}

// ── Materials pricing ─────────────────────────────────────────────────────
export interface VendorOption {
  vendor: string
  price: number | null
  url: string
  is_local: boolean
  note: string
  quote_only?: boolean
  tag?: string
}

// ── Permits ───────────────────────────────────────────────────────────────
export type PermitFieldType = 'text' | 'date' | 'checkbox' | 'signature'
export type PermitFieldStatus = 'auto_filled' | 'needs_input' | 'optional'

export interface PermitField {
  key: string
  label: string
  value: string
  field_type: PermitFieldType
  required: boolean
  section: string
  x?: number | null
  y?: number | null
  page?: number
  status?: PermitFieldStatus
}

export interface Jurisdiction {
  found: boolean
  authority_name: string | null
  authority_type: string | null
  gov_url: string | null
  submission_method: string
  submission_email: string | null
  error: string | null
  fallback_search_url: string | null
}

// ── Contractor ────────────────────────────────────────────────────────────
export interface ContractorProfile {
  user_id?: string
  company_name: string
  license_number: string
  phone: string
  email: string
  address: string
  city: string
  state: string
  zip_code: string
  insurance_policy?: string
  updated_at?: string
}

// ── Estimates & reports ──────────────────────────────────────────────────
export interface EstimateFull extends CostEstimate {
  material_estimates: MaterialEstimate[]
}

export interface ReportFull {
  project: Project
  blueprint: Blueprint | null
  analysis: Analysis | null
  materials: MaterialEstimate[]
  cost: CostEstimate | null
  compliance: ComplianceCheck | null
  compliance_items: ComplianceItem[]
  permit_info: Record<string, unknown> | null
  overrides: Record<string, unknown>
}
