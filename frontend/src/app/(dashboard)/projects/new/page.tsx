'use client'
import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'

const US_STATES = [
  { value: 'US-AL', label: 'Alabama' }, { value: 'US-AK', label: 'Alaska' },
  { value: 'US-AZ', label: 'Arizona' }, { value: 'US-CA', label: 'California' },
  { value: 'US-CO', label: 'Colorado' }, { value: 'US-FL', label: 'Florida' },
  { value: 'US-GA', label: 'Georgia' }, { value: 'US-IL', label: 'Illinois' },
  { value: 'US-MI', label: 'Michigan' }, { value: 'US-NC', label: 'North Carolina' },
  { value: 'US-NY', label: 'New York' }, { value: 'US-OH', label: 'Ohio' },
  { value: 'US-PA', label: 'Pennsylvania' }, { value: 'US-TX', label: 'Texas' },
  { value: 'US-WA', label: 'Washington' }, { value: 'US-VA', label: 'Virginia' },
]

type Stage = 'idle' | 'creating-project' | 'uploading' | 'registering' | 'analyzing' | 'done' | 'error'

export default function NewProjectPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [region, setRegion] = useState('US-TX')
  const [city, setCity] = useState('')
  const [blueprintType, setBlueprintType] = useState<'residential' | 'commercial'>('residential')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState('')

  const STAGES: { key: Stage; label: string; pct: number }[] = [
    { key: 'creating-project', label: 'Creating project...', pct: 10 },
    { key: 'uploading', label: 'Uploading blueprint...', pct: 40 },
    { key: 'registering', label: 'Registering file...', pct: 60 },
    { key: 'analyzing', label: 'Starting AI analysis...', pct: 80 },
    { key: 'done', label: 'Done!', pct: 100 },
  ]

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) validateAndSetFile(f)
  }

  function validateAndSetFile(f: File) {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']
    if (!allowed.includes(f.type)) {
      setError('Only PDF, PNG, and JPEG files are supported.')
      return
    }
    if (f.size > 100 * 1024 * 1024) {
      setError('File must be under 100MB.')
      return
    }
    setError('')
    setFile(f)
  }

  async function uploadToS3(presignedUrl: string, file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploadProgress(Math.round((e.loaded / e.total) * 100))
        }
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
      // 1. Get user
      const user = await getUser()
      if (!user) { router.push('/login'); return }

      // 2. Create project
      setStage('creating-project')
      const project = await api.projects.create({ name, region, blueprint_type: blueprintType }, user.id)

      // 2b. Kick off compliance check in background (non-blocking)
      api.compliance.triggerForProject(project.id, city || undefined).catch(() => {})

      // 3. Get presigned upload URL
      setStage('uploading')
      const { upload_url, key } = await api.blueprints.getUploadUrl(project.id, file.name, file.type)

      // 4. Upload directly to S3/R2
      await uploadToS3(upload_url, file)

      // 5. Register blueprint in DB
      setStage('registering')
      const ext = file.name.split('.').pop() || 'pdf'
      const blueprint = await api.blueprints.register(
        project.id, key, ext, Math.round(file.size / 1024)
      )

      // 6. Trigger AI analysis
      setStage('analyzing')
      await api.blueprints.triggerAnalysis(blueprint.id)

      // Done — redirect to project page
      setStage('done')
      setTimeout(() => router.push(`/projects/${project.id}`), 800)

    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
      setStage('error')
    }
  }

  const currentStageIdx = STAGES.findIndex(s => s.key === stage)
  const isProcessing = stage !== 'idle' && stage !== 'error'

  return (
    <div className="min-h-screen bg-slate-950">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center gap-4">
        <Link href="/dashboard" className="text-slate-400 hover:text-white transition-colors text-sm">← Dashboard</Link>
        <span className="text-slate-600">/</span>
        <span className="text-white text-sm font-medium">New Project</span>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-white mb-8">Upload Blueprint</h1>

        {isProcessing ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-10 text-center">
            <div className="mb-6">
              <div className="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                {stage === 'done' ? (
                  <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-8 h-8 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                )}
              </div>
              <p className="text-white font-medium">{STAGES[currentStageIdx]?.label || 'Processing...'}</p>
              {stage === 'uploading' && (
                <p className="text-slate-400 text-sm mt-1">{uploadProgress}%</p>
              )}
            </div>
            {/* Progress bar */}
            <div className="w-full bg-slate-800 rounded-full h-2 mb-6">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${STAGES[currentStageIdx]?.pct || 0}%` }}
              />
            </div>
            <div className="space-y-2">
              {STAGES.map((s, i) => (
                <div key={s.key} className={`flex items-center gap-3 text-sm ${i <= currentStageIdx ? 'text-white' : 'text-slate-600'}`}>
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ${i < currentStageIdx ? 'bg-green-500' : i === currentStageIdx ? 'bg-blue-500' : 'bg-slate-700'}`}>
                    {i < currentStageIdx && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Project Name</label>
                <input
                  type="text" required value={name} onChange={e => setName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="123 Oak Street - Residential"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">State</label>
                  <select
                    value={region} onChange={e => setRegion(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {US_STATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">City / County <span className="text-slate-500 font-normal">(optional)</span></label>
                  <input
                    type="text" value={city} onChange={e => setCity(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g. Houston, Harris County"
                  />
                </div>
              </div>

              <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Blueprint Type</label>
                  <div className="flex gap-2 mt-1">
                    {(['residential', 'commercial'] as const).map(type => (
                      <button
                        key={type} type="button" onClick={() => setBlueprintType(type)}
                        className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors capitalize ${blueprintType === type ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'}`}
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
              className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${dragOver ? 'border-blue-400 bg-blue-500/5' : file ? 'border-green-500 bg-green-500/5' : 'border-slate-700 hover:border-slate-500'}`}
            >
              <input
                ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg"
                className="hidden" onChange={e => { if (e.target.files?.[0]) validateAndSetFile(e.target.files[0]) }}
              />
              {file ? (
                <div>
                  <div className="text-4xl mb-3">📄</div>
                  <p className="text-white font-medium">{file.name}</p>
                  <p className="text-slate-400 text-sm mt-1">{(file.size / 1024 / 1024).toFixed(1)} MB — click to change</p>
                </div>
              ) : (
                <div>
                  <div className="text-4xl mb-3">📐</div>
                  <p className="text-white font-medium">Drop blueprint here</p>
                  <p className="text-slate-400 text-sm mt-1">PDF, PNG, JPEG — up to 100MB</p>
                  <p className="text-blue-400 text-sm mt-3">or click to browse</p>
                </div>
              )}
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!file || !name}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
            >
              Analyze Blueprint
            </button>
          </form>
        )}
      </main>
    </div>
  )
}
