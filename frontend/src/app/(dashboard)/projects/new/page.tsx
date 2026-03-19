'use client'
import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import { STATES, COUNTIES, CITIES } from '@/lib/jurisdictions'

type Stage = 'idle' | 'creating-project' | 'uploading' | 'registering' | 'analyzing' | 'done' | 'error'

export default function NewProjectPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [stateCode, setStateCode] = useState('')
  const [county, setCounty] = useState('')
  const [city, setCity] = useState('')
  const [blueprintType, setBlueprintType] = useState<'residential' | 'commercial'>('residential')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState('')

  const counties = stateCode ? (COUNTIES[stateCode] || []) : []
  const cities = (stateCode && county) ? (CITIES[stateCode]?.[county] || []) : []

  const STAGES: { key: Stage; label: string; pct: number }[] = [
    { key: 'creating-project', label: 'Creating project...', pct: 10 },
    { key: 'uploading',        label: 'Uploading blueprint...', pct: 40 },
    { key: 'registering',      label: 'Registering file...', pct: 60 },
    { key: 'analyzing',        label: 'Starting AI analysis...', pct: 80 },
    { key: 'done',             label: 'Done!', pct: 100 },
  ]

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) validateAndSetFile(f)
  }

  function validateAndSetFile(f: File) {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']
    if (!allowed.includes(f.type)) { setError('Only PDF, PNG, and JPEG files are supported.'); return }
    if (f.size > 100 * 1024 * 1024) { setError('File must be under 100MB.'); return }
    setError('')
    setFile(f)
  }

  async function uploadToS3(presignedUrl: string, file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => (xhr.status < 400 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`)))
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.open('PUT', presignedUrl)
      xhr.setRequestHeader('Content-Type', file.type)
      xhr.send(file)
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { setError('Please select a blueprint file.'); return }
    if (!name.trim()) { setError('Please enter a project name.'); return }
    setError('')
    try {
      const user = await getUser()
      if (!user) { router.push('/login'); return }

      setStage('creating-project')
      const region = stateCode ? `US-${stateCode}` : 'US-TX'
      const project = await api.projects.create({ name, region, blueprint_type: blueprintType }, user.id)

      const locationStr = [city, county, stateCode].filter(Boolean).join(', ')
      api.compliance.triggerForProject(project.id, locationStr || undefined).catch(() => {})

      setStage('uploading')
      const { upload_url, key } = await api.blueprints.getUploadUrl(project.id, file.name, file.type)
      await uploadToS3(upload_url, file)

      setStage('registering')
      const ext = file.name.split('.').pop() || 'pdf'
      const blueprint = await api.blueprints.register(project.id, key, ext, Math.round(file.size / 1024))

      setStage('analyzing')
      await api.blueprints.triggerAnalysis(blueprint.id)

      setStage('done')
      setTimeout(() => router.push(`/projects/${project.id}`), 800)
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
      setStage('error')
    }
  }

  const currentStageIdx = STAGES.findIndex(s => s.key === stage)
  const isProcessing = stage !== 'idle' && stage !== 'error'

  const inputCls = 'w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-xl px-4 py-2.5 text-slate-700 placeholder-slate-300 focus:outline-none transition-all text-sm'
  const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2'
  const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard" className="text-slate-400 hover:text-slate-700 transition-colors text-sm">← Dashboard</Link>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700 text-sm font-semibold">Upload Blueprint</span>
      </div>

      <h1 className="text-2xl font-black text-slate-800 mb-6">Upload Blueprint</h1>

      {isProcessing ? (
        <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
          <div className="mb-6">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: stage === 'done' ? '#d1fae5' : '#dbeafe' }}>
              {stage === 'done' ? (
                <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-8 h-8 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              )}
            </div>
            <p className="text-slate-800 font-semibold">{STAGES[currentStageIdx]?.label || 'Processing...'}</p>
            {stage === 'uploading' && <p className="text-slate-400 text-sm mt-1">{uploadProgress}%</p>}
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2 mb-6">
            <div
              className="h-2 rounded-full transition-all duration-500"
              style={{ width: `${STAGES[currentStageIdx]?.pct || 0}%`, background: 'linear-gradient(90deg, #3b82f6, #1d4ed8)' }}
            />
          </div>
          <div className="space-y-2.5">
            {STAGES.map((s, i) => (
              <div key={s.key} className={`flex items-center gap-3 text-sm ${i <= currentStageIdx ? 'text-slate-700' : 'text-slate-300'}`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${i < currentStageIdx ? 'bg-emerald-500' : i === currentStageIdx ? 'bg-blue-500' : 'bg-slate-100'}`}>
                  {i < currentStageIdx && (
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                {s.label}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Project details card */}
          <div className="bg-white rounded-2xl p-6 space-y-5" style={cardStyle}>
            <div>
              <label className={labelCls}>Project Name</label>
              <input
                type="text" required value={name} onChange={e => setName(e.target.value)}
                className={inputCls}
                placeholder="e.g. 123 Oak Street — Residential Addition"
              />
            </div>

            {/* State / County / City — 3 columns */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>State</label>
                <select
                  value={stateCode}
                  onChange={e => { setStateCode(e.target.value); setCounty(''); setCity('') }}
                  className={inputCls}
                >
                  <option value="">Select state…</option>
                  {STATES.map(s => (
                    <option key={s.code} value={s.code}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>County</label>
                <select
                  value={county}
                  onChange={e => { setCounty(e.target.value); setCity('') }}
                  disabled={!stateCode}
                  className={`${inputCls} disabled:opacity-40`}
                >
                  <option value="">Select county…</option>
                  {counties.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>City</label>
                <select
                  value={city}
                  onChange={e => setCity(e.target.value)}
                  disabled={!county}
                  className={`${inputCls} disabled:opacity-40`}
                >
                  <option value="">Select city…</option>
                  {cities.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Blueprint type */}
            <div>
              <label className={labelCls}>Blueprint Type</label>
              <div className="flex gap-2">
                {(['residential', 'commercial'] as const).map(type => (
                  <button
                    key={type} type="button" onClick={() => setBlueprintType(type)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all capitalize ${
                      blueprintType === type
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-slate-50 text-slate-500 border border-slate-200 hover:border-blue-200 hover:text-slate-700'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Drop zone */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className="rounded-2xl p-12 text-center cursor-pointer transition-all duration-200"
            style={{
              border: `2px dashed ${dragOver ? '#3b82f6' : file ? '#10b981' : '#cbd5e1'}`,
              background: dragOver ? '#eff6ff' : file ? '#f0fdf4' : 'white',
              boxShadow: '0 2px 12px rgba(59,130,246,0.08)',
            }}
          >
            <input
              ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg"
              className="hidden" onChange={e => { if (e.target.files?.[0]) validateAndSetFile(e.target.files[0]) }}
            />
            {file ? (
              <div>
                <div className="text-4xl mb-3">📄</div>
                <p className="text-slate-800 font-semibold">{file.name}</p>
                <p className="text-slate-400 text-sm mt-1">{(file.size / 1024 / 1024).toFixed(1)} MB — click to change</p>
              </div>
            ) : (
              <div>
                <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                </div>
                <p className="text-slate-700 font-semibold">Drop blueprint here</p>
                <p className="text-slate-400 text-sm mt-1">PDF, PNG, JPEG — up to 100MB</p>
                <p className="text-blue-500 text-sm mt-3 font-medium">or click to browse</p>
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!file || !name}
            className="w-full text-white font-bold py-3.5 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:scale-[1.01]"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
          >
            Analyze Blueprint
          </button>
        </form>
      )}
    </div>
  )
}
