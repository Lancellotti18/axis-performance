'use client'

/**
 * Axis Performance — Address + County picker.
 *
 * Replaces the static state→county→city dropdown with a server-validated
 * lookup:
 *   1. User types an address
 *   2. We debounce 350ms then call /v2/location/search (no county, fast)
 *   3. User picks a match → we call /v2/location/validate to get the
 *      authoritative county + FIPS from the Census Geocoder
 *   4. Selected result is reported via onSelected
 *
 * If Census doesn't return county, we fall back to the FCC Area API via
 * the /v2/location/reverse endpoint.
 *
 * Manual override: if the user can't find their address, they can click
 * "Enter manually" and type each field directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

export interface LocationSelected {
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
}

interface Props {
  initialQuery?: string
  onSelected: (loc: LocationSelected) => void
}

interface Match {
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
}

export function LocationPicker({ initialQuery = '', onSelected }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Match | null>(null)
  const [manual, setManual] = useState(false)
  const [manualForm, setManualForm] = useState({
    street: '', city: '', state: '', zip: '', county: '',
  })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setMatches([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await api.roofing.v2.locationSearch(q, false)
      setMatches(res.matches ?? [])
      if (res.error && (!res.matches || res.matches.length === 0)) {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Address search failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    // 250ms feels closer to Apple/Google Maps responsiveness; MapTiler returns
    // in ~200ms so 250 keeps us snappy without firing every single keystroke.
    debounceRef.current = setTimeout(() => { void runSearch(query) }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, runSearch])

  const pick = useCallback(async (m: Match) => {
    setSelected(m)
    setMatches([])
    // Resolve county via /validate if not already present
    if (!m.county) {
      try {
        const full = await api.roofing.v2.locationValidate(m.matched_address)
        setSelected(full as Match)
        onSelected(full as LocationSelected)
        return
      } catch (err) {
        // Fall through; we still have the basic match
      }
    }
    onSelected(m)
  }, [onSelected])

  const submitManual = useCallback(() => {
    const m = manualForm
    if (!m.street || !m.city || !m.state) {
      setError('Please enter street, city, and state.')
      return
    }
    const full: LocationSelected = {
      matched_address: `${m.street}, ${m.city}, ${m.state} ${m.zip}`.trim(),
      street: m.street, city: m.city, state: m.state, zip: m.zip,
      lat: 0, lng: 0,
      county: m.county, county_fips: '', state_fips: '',
      source: 'manual',
    }
    setSelected(full as Match)
    onSelected(full)
  }, [manualForm, onSelected])

  if (selected) {
    return (
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-slate-100">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold">{selected.matched_address}</div>
            <div className="mt-1 text-xs text-slate-300">
              {selected.city}, {selected.state} {selected.zip}
              {selected.county && (
                <span> · <strong>{selected.county}</strong> County</span>
              )}
              {selected.county_fips && (
                <span className="ml-2 text-slate-500">FIPS {selected.county_fips}</span>
              )}
            </div>
            {selected.lat !== 0 && (
              <div className="text-[10px] text-slate-500">
                {selected.lat.toFixed(5)}, {selected.lng.toFixed(5)} · source: {selected.source}
              </div>
            )}
          </div>
          <button
            onClick={() => { setSelected(null); setQuery(''); setMatches([]); setManual(false) }}
            className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
          >Change</button>
        </div>
      </div>
    )
  }

  if (manual) {
    return (
      <div className="space-y-3 rounded-lg border border-white/10 bg-slate-900/60 p-3">
        <div className="text-xs text-slate-300">Enter address manually</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            placeholder="Street"
            value={manualForm.street}
            onChange={e => setManualForm(s => ({ ...s, street: e.target.value }))}
            className="col-span-2 rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
          <input
            placeholder="City"
            value={manualForm.city}
            onChange={e => setManualForm(s => ({ ...s, city: e.target.value }))}
            className="rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
          <input
            placeholder="State (2-letter)"
            maxLength={2}
            value={manualForm.state}
            onChange={e => setManualForm(s => ({ ...s, state: e.target.value.toUpperCase() }))}
            className="rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
          <input
            placeholder="ZIP"
            value={manualForm.zip}
            onChange={e => setManualForm(s => ({ ...s, zip: e.target.value }))}
            className="rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
          <input
            placeholder="County (optional)"
            value={manualForm.county}
            onChange={e => setManualForm(s => ({ ...s, county: e.target.value }))}
            className="rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </div>
        <div className="flex gap-2">
          <button onClick={submitManual} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500">Use this address</button>
          <button onClick={() => setManual(false)} className="rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-600">Back to search</button>
        </div>
        <p className="text-[10px] text-slate-500">Manual entry skips Census validation. The report will note this in the methodology section.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Start typing the property address…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-400/60 focus:outline-none"
        autoFocus
      />
      {loading && <p className="text-xs text-slate-500">Searching US Census Geocoder…</p>}
      {error && !loading && <p className="text-xs text-rose-400">{error}</p>}

      {matches.length > 0 && (
        <ul className="max-h-60 overflow-y-auto rounded-lg border border-white/10 bg-slate-900/80">
          {matches.map((m, i) => (
            <li
              key={i}
              onClick={() => void pick(m)}
              className="cursor-pointer border-b border-white/5 px-3 py-2 text-sm text-slate-100 transition hover:bg-blue-500/10"
            >
              <div className="font-medium">{m.matched_address}</div>
              <div className="text-[10px] text-slate-500">
                {m.lat.toFixed(5)}, {m.lng.toFixed(5)}
                {m.county && ` · ${m.county} County`}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Powered by US Census Bureau + FCC Area API (free, authoritative)</span>
        <button onClick={() => setManual(true)} className="text-blue-400 hover:text-blue-300">Enter manually →</button>
      </div>
    </div>
  )
}

export default LocationPicker
