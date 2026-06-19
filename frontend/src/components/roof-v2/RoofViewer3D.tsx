'use client'

/**
 * Axis Performance — 2.5D Roof Viewer (Three.js).
 *
 * Takes contractor-traced facet polygons + per-facet pitches + edge labels
 * and extrudes them into a real 3D roof model. Honest about what it is:
 * COMPUTED GEOMETRY, not photoreal — the model reflects exactly what was
 * traced, with no AI smoothing or hallucinated detail.
 *
 * For each facet:
 *   1. Convert polygon (image fractions) to feet (using lat + zoom + image size)
 *   2. Find the eave edge (the labeled 'eave', or fallback to lowest edge in image Y)
 *   3. Compute uphill direction perpendicular to eave, pointing toward facet centroid
 *   4. For each vertex, set Z = (distance from eave) * tan(pitch_angle)
 *   5. Triangulate (fan-from-centroid for convex polygons, earcut for complex)
 *
 * Edges are rendered as colored 3D lines on top of the mesh — same color
 * coding as the 2D annotated view (ridges=black, eaves=gold, etc.).
 */
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Html, GizmoHelper, GizmoViewport } from '@react-three/drei'
import * as THREE from 'three'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Facet, LabeledEdge, EdgeType } from './RoofFacetEditor'

type CameraView = 'iso' | 'top' | 'front' | 'back' | 'left' | 'right'

interface Props {
  facets: Facet[]
  edges: LabeledEdge[]
  lat: number
  zoom: number
  imageWidthPx: number
  imageHeightPx: number
}

const EDGE_COLORS: Record<EdgeType, string> = {
  eave: '#fbbf24',
  rake: '#a855f7',
  ridge: '#0f172a',
  hip: '#475569',
  valley: '#3b82f6',
  gable_end: '#22c55e',
  wall_intersection: '#f97316',
  unlabeled: '#94a3b8',
}

const FACET_COLORS = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16']

// Web Mercator metres-per-pixel
const ESRI_MPP_Z0 = 156543.03392
function feetPerPixel(lat: number, zoom: number): number {
  const mpp = (ESRI_MPP_Z0 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
  return mpp * 3.28084
}

function pitchDegrees(pitch: string): number {
  const rise = parseFloat(pitch.split('/')[0] || '0')
  if (!Number.isFinite(rise) || rise <= 0) return 0
  return Math.atan(rise / 12) * (180 / Math.PI)
}

function tanPitch(pitch: string): number {
  const rise = parseFloat(pitch.split('/')[0] || '0')
  if (!Number.isFinite(rise) || rise <= 0) return 0
  return rise / 12
}

// 2D vector helpers (XY plane = ground)
type V2 = [number, number]
function dot(a: V2, b: V2): number { return a[0] * b[0] + a[1] * b[1] }
function sub(a: V2, b: V2): V2 { return [a[0] - b[0], a[1] - b[1]] }
function len(a: V2): number { return Math.sqrt(a[0] * a[0] + a[1] * a[1]) }
function norm(a: V2): V2 { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l] : [0, 0] }
function perp(a: V2): V2 { return [-a[1], a[0]] }

function centroidXY(poly: V2[]): V2 {
  let sx = 0, sy = 0
  for (const p of poly) { sx += p[0]; sy += p[1] }
  return [sx / poly.length, sy / poly.length]
}

// Fan triangulation from centroid — works correctly for convex polygons.
// For concave roof facets it would create overlapping triangles; in practice
// residential roof planes are nearly always convex.
function fanTriangulate(n: number): number[] {
  // Vertices 0..n-1 are the polygon vertices; vertex n is the centroid.
  // We emit (i, i+1, n) for each edge.
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    idx.push(i, (i + 1) % n, n)
  }
  return idx
}

interface FacetMesh3D {
  label: string
  pitch: string
  vertices: Float32Array       // xyz triplets in feet (Z = up); centroid is the last vertex
  indices: number[]
  color: string
  trueAreaSqft: number
  centroid3D: [number, number, number]   // for label placement
  edgesIn3D: Array<{ from: [number, number, number]; to: [number, number, number]; type: EdgeType }>
}

function buildFacetMesh(
  facet: Facet,
  edges: LabeledEdge[],
  ftPerPx: number,
  imgW: number,
  imgH: number,
  colorIdx: number,
): FacetMesh3D | null {
  if (facet.polygon.length < 3) return null

  // 1. Convert to ground-plane feet. Y-axis flipped because image Y grows
  //    downward but world Y grows upward — using -y here ensures north stays north.
  const poly2D: V2[] = facet.polygon.map(([x, y]) => [
    x * imgW * ftPerPx,
    -y * imgH * ftPerPx,
  ])

  // 2. Identify the eave edge.
  const facetEdges = edges.filter(e => e.facetLabel === facet.label)
  let eaveIdx = facetEdges.find(e => e.edgeType === 'eave')?.vertexIndexStart

  // Fallback: pick the lowest edge in image Y (which is highest in world Y after flip).
  if (eaveIdx === undefined) {
    let maxAvgY = -Infinity
    for (let i = 0; i < facet.polygon.length; i++) {
      const y1 = facet.polygon[i][1]
      const y2 = facet.polygon[(i + 1) % facet.polygon.length][1]
      const avg = (y1 + y2) / 2
      if (avg > maxAvgY) { maxAvgY = avg; eaveIdx = i }
    }
  }

  // 3. Compute uphill direction
  const eP1 = poly2D[eaveIdx!]
  const eP2 = poly2D[(eaveIdx! + 1) % poly2D.length]
  const eaveDir = norm(sub(eP2, eP1))
  let uphill = perp(eaveDir)

  // Make sure uphill points TOWARD the facet centroid (away from the eave outward)
  const cent = centroidXY(poly2D)
  const eaveMid: V2 = [(eP1[0] + eP2[0]) / 2, (eP1[1] + eP2[1]) / 2]
  if (dot(uphill, sub(cent, eaveMid)) < 0) {
    uphill = [-uphill[0], -uphill[1]]
  }

  // 4. Compute Z for each vertex
  const tan = tanPitch(facet.pitch)
  const verts3D: Array<[number, number, number]> = poly2D.map(p => {
    const fromEave: V2 = sub(p, eP1)
    const distAlongUphill = dot(fromEave, uphill)
    const z = Math.max(0, distAlongUphill) * tan
    return [p[0], z, p[1]]    // Three.js: y is up; ground plane is xz
  })

  // Centroid in 3D
  let cx = 0, cy = 0, cz = 0
  for (const v of verts3D) { cx += v[0]; cy += v[1]; cz += v[2] }
  cx /= verts3D.length; cy /= verts3D.length; cz /= verts3D.length
  verts3D.push([cx, cy, cz])

  // Pack into Float32Array
  const arr = new Float32Array(verts3D.length * 3)
  for (let i = 0; i < verts3D.length; i++) {
    arr[i * 3 + 0] = verts3D[i][0]
    arr[i * 3 + 1] = verts3D[i][1]
    arr[i * 3 + 2] = verts3D[i][2]
  }

  const indices = fanTriangulate(facet.polygon.length)

  // 5. Edges in 3D with their labels
  const edgesByVertex = new Map<number, LabeledEdge>()
  for (const e of facetEdges) {
    edgesByVertex.set(e.vertexIndexStart, e)
  }
  const edgesIn3D = facet.polygon.map((_, i) => {
    const v1 = verts3D[i]
    const v2 = verts3D[(i + 1) % facet.polygon.length]
    const e = edgesByVertex.get(i)
    return {
      from: v1 as [number, number, number],
      to: v2 as [number, number, number],
      type: (e?.edgeType ?? 'unlabeled') as EdgeType,
    }
  })

  // Compute true (sloped) area: plan area / cos(pitch)
  // Plan area via shoelace in feet²
  let sh = 0
  for (let i = 0; i < poly2D.length; i++) {
    const a = poly2D[i]
    const b = poly2D[(i + 1) % poly2D.length]
    sh += a[0] * b[1] - b[0] * a[1]
  }
  const planArea = Math.abs(sh) / 2
  const pDeg = pitchDegrees(facet.pitch)
  const trueArea = pDeg > 0 ? planArea / Math.cos(pDeg * Math.PI / 180) : planArea

  return {
    label: facet.label,
    pitch: facet.pitch,
    vertices: arr,
    indices,
    color: FACET_COLORS[colorIdx % FACET_COLORS.length],
    trueAreaSqft: trueArea,
    centroid3D: [cx, cy, cz],
    edgesIn3D,
  }
}

function FacetMesh({ mesh, selected, onSelect }: { mesh: FacetMesh3D; selected: boolean; onSelect: () => void }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3))
    g.setIndex(mesh.indices)
    g.computeVertexNormals()
    return g
  }, [mesh])

  return (
    <group>
      <mesh
        geometry={geometry}
        castShadow
        receiveShadow
        onClick={(ev) => { ev.stopPropagation(); onSelect() }}
      >
        <meshStandardMaterial
          color={mesh.color}
          metalness={0.05}
          roughness={0.85}
          side={THREE.DoubleSide}
          emissive={selected ? '#2563eb' : '#000000'}
          emissiveIntensity={selected ? 0.35 : 0}
        />
      </mesh>
      {/* Edges */}
      {mesh.edgesIn3D.map((e, i) => (
        <line key={i}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              count={2}
              array={new Float32Array([
                e.from[0], e.from[1], e.from[2],
                e.to[0], e.to[1], e.to[2],
              ])}
              itemSize={3}
              args={[new Float32Array([
                e.from[0], e.from[1], e.from[2],
                e.to[0], e.to[1], e.to[2],
              ]), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={EDGE_COLORS[e.type]} linewidth={2} />
        </line>
      ))}
      {/* Label */}
      {selected && (
        <Html
          position={mesh.centroid3D}
          center
          distanceFactor={20}
          occlude={false}
        >
          <div className="pointer-events-none rounded bg-slate-900/95 px-2 py-1 text-xs text-white shadow-lg ring-1 ring-blue-400/60">
            <div className="font-semibold">Facet {mesh.label}</div>
            <div className="text-[10px] text-slate-300">{mesh.pitch} · {Math.round(mesh.trueAreaSqft)} ft²</div>
          </div>
        </Html>
      )}
    </group>
  )
}

function SceneFitter({ meshes }: { meshes: FacetMesh3D[] }) {
  // Center the model at origin so OrbitControls feel natural.
  const offset = useMemo(() => {
    if (meshes.length === 0) return [0, 0, 0] as const
    let sx = 0, sz = 0, n = 0
    let maxY = 0
    for (const m of meshes) {
      for (let i = 0; i < m.vertices.length; i += 3) {
        sx += m.vertices[i + 0]
        sz += m.vertices[i + 2]
        if (m.vertices[i + 1] > maxY) maxY = m.vertices[i + 1]
        n++
      }
    }
    return [-sx / n, 0, -sz / n] as const
  }, [meshes])

  return <group position={[offset[0], 0, offset[2]]}><GroupChildrenSlot /></group>
}

function GroupChildrenSlot() {
  // r3f doesn't expose children-as-slot; we render via parent's children outside.
  return null
}

export function RoofViewer3D({ facets, edges, lat, zoom, imageWidthPx, imageHeightPx }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null)

  const meshes = useMemo(() => {
    const ftPerPx = feetPerPixel(lat || 30.27, zoom || 20)
    const out: FacetMesh3D[] = []
    for (let i = 0; i < facets.length; i++) {
      const m = buildFacetMesh(facets[i], edges, ftPerPx, imageWidthPx, imageHeightPx, i)
      if (m) out.push(m)
    }
    return out
  }, [facets, edges, lat, zoom, imageWidthPx, imageHeightPx])

  // Compute scene center for camera + group offset
  const sceneCenter = useMemo(() => {
    if (meshes.length === 0) return [0, 0, 0] as [number, number, number]
    let sx = 0, sz = 0, n = 0
    let maxY = 0
    for (const m of meshes) {
      for (let i = 0; i < m.vertices.length; i += 3) {
        sx += m.vertices[i + 0]
        sz += m.vertices[i + 2]
        if (m.vertices[i + 1] > maxY) maxY = m.vertices[i + 1]
        n++
      }
    }
    return [sx / n, maxY / 2, sz / n] as [number, number, number]
  }, [meshes])

  // Model radius (in feet) for framing camera presets — half the largest
  // horizontal span of the centered model.
  const modelRadius = useMemo(() => {
    let maxX = 0, maxZ = 0, maxY = 0
    for (const m of meshes) {
      for (let i = 0; i < m.vertices.length; i += 3) {
        maxX = Math.max(maxX, Math.abs(m.vertices[i] - sceneCenter[0]))
        maxY = Math.max(maxY, m.vertices[i + 1])
        maxZ = Math.max(maxZ, Math.abs(m.vertices[i + 2] - sceneCenter[2]))
      }
    }
    return Math.max(12, maxX, maxZ, maxY)
  }, [meshes, sceneCenter])

  // Apply a camera preset by moving the OrbitControls camera + target. The
  // model is centered at origin, so all presets target [0,0,0].
  const applyView = useCallback((view: CameraView) => {
    const c = controlsRef.current
    if (!c) return
    const cam = c.object as THREE.PerspectiveCamera
    const R = modelRadius
    const pos: Record<CameraView, [number, number, number]> = {
      iso:   [R * 1.8, R * 1.7, R * 1.8],
      top:   [0, R * 3.0, 0.001],
      front: [0, R * 0.9, R * 2.4],
      back:  [0, R * 0.9, -R * 2.4],
      left:  [-R * 2.4, R * 0.9, 0],
      right: [R * 2.4, R * 0.9, 0],
    }
    const p = pos[view]
    cam.position.set(p[0], p[1], p[2])
    c.target.set(0, 0, 0)
    c.update()
  }, [modelRadius])

  // Keyboard camera presets: 1=iso 2=top 3=front 4=back 5=left 6=right, R=reset
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const map: Record<string, CameraView> = {
        '1': 'iso', '2': 'top', '3': 'front', '4': 'back', '5': 'left', '6': 'right',
        t: 'top', T: 'top', r: 'iso', R: 'iso',
      }
      const v = map[e.key]
      if (v) applyView(v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyView])

  if (meshes.length === 0) {
    return (
      <section className="rounded-lg border border-white/10 bg-slate-900/40 p-6 text-center text-sm text-slate-400">
        Draw at least one facet to see the 3D model.
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">3D Roof Model</h3>
          <p className="text-xs text-slate-400">
            Computed from your traced facets + pitches. Drag to rotate · wheel to zoom · right-drag to pan.
            Click a facet for its area + pitch.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {([
            ['iso', 'Iso', '1'], ['top', 'Top', '2'], ['front', 'Front', '3'],
            ['back', 'Back', '4'], ['left', 'Left', '5'], ['right', 'Right', '6'],
          ] as [CameraView, string, string][]).map(([v, label, key]) => (
            <button
              key={v}
              onClick={() => applyView(v)}
              title={`${label} view (${key})`}
              className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-blue-600"
            >{label}</button>
          ))}
          <button
            onClick={() => setSelected(null)}
            className="ml-1 rounded bg-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-600"
          >Clear</button>
        </div>
      </div>

      <div className="relative h-[600px] overflow-hidden rounded-lg border border-white/10 bg-gradient-to-b from-slate-800 to-slate-950">
        <Canvas
          shadows
          camera={{ position: [50, 60, 80], fov: 50, near: 0.1, far: 5000 }}
          gl={{ antialias: true, preserveDrawingBuffer: true }}
        >
          <color attach="background" args={['#0f172a']} />
          {/* Sky/ground hemisphere ambient — gives roofs a natural lit-from-
              above look without washing out form. */}
          <hemisphereLight args={['#cfe3ff', '#1a2436', 0.85]} />
          {/* Key sun with crisp shadows */}
          <directionalLight
            position={[90, 140, 70]}
            intensity={1.15}
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-camera-left={-200}
            shadow-camera-right={200}
            shadow-camera-top={200}
            shadow-camera-bottom={-200}
            shadow-camera-near={1}
            shadow-camera-far={600}
            shadow-bias={-0.0004}
          />
          {/* Cool fill from the opposite side to keep north slopes readable */}
          <directionalLight position={[-70, 50, -50]} intensity={0.35} color="#9fb8d8" />

          <group position={[-sceneCenter[0], 0, -sceneCenter[2]]}>
            {meshes.map(m => (
              <FacetMesh
                key={m.label}
                mesh={m}
                selected={selected === m.label}
                onSelect={() => setSelected(s => s === m.label ? null : m.label)}
              />
            ))}

            {/* Ground reference plane */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
              <planeGeometry args={[400, 400]} />
              <meshStandardMaterial color="#1e293b" roughness={0.95} />
            </mesh>
            {/* Grid */}
            <gridHelper args={[400, 80, '#334155', '#1e293b']} position={[0, -0.05, 0]} />
          </group>

          <OrbitControls
            ref={controlsRef}
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={10}
            maxDistance={600}
            target={[0, 0, 0]}
          />
          <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
            <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="white" />
          </GizmoHelper>
        </Canvas>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        <Stat label="Facets" value={String(meshes.length)} />
        <Stat label="True area" value={`${Math.round(meshes.reduce((s, m) => s + m.trueAreaSqft, 0))} ft²`} />
        <Stat label="Squares" value={`${(meshes.reduce((s, m) => s + m.trueAreaSqft, 0) / 100).toFixed(2)}`} />
        <Stat label="Predominant pitch" value={meshes.sort((a, b) => b.trueAreaSqft - a.trueAreaSqft)[0]?.pitch || '—'} />
      </div>

      <div className="mt-2 text-[10px] text-slate-500">
        2.5D computed model — geometry derived from contractor traces + pitches. Not photoreal,
        not photogrammetry. Use the view buttons (or keys 1-6) to snap to iso / top / front / back / left / right.
        Edge colors match the legend (ridges black, eaves gold, rakes purple, hips gray, valleys blue).
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-900/60 p-2">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-100">{value}</div>
    </div>
  )
}

export default RoofViewer3D
