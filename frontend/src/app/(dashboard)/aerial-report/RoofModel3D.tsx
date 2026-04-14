'use client'
/**
 * RoofModel3D — parametric 3D roof model generated from real measurement data.
 * Uses @react-three/fiber + drei. No photogrammetry; model is derived from
 * actual measurements (pitch, sqft, segment count) returned by the aerial report.
 *
 * Roof types by segment count:
 *   ≤ 2  →  Gable (two slopes + triangular gable ends)
 *   3-4  →  Hip   (four slopes meeting at a ridge)
 *   5+   →  Complex hip/gable combination
 */
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid, Html } from '@react-three/drei'
import * as THREE from 'three'
import { useMemo } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type MaterialType = 'asphalt' | 'metal' | 'tile'
type ViewMode     = 'solid' | 'wireframe' | 'measurements'

interface Props {
  totalSqft:  number
  pitch:      string   // e.g. "6/12", "26.6°"
  segments:   number
  ridgeFt?:   number
  material?:  MaterialType
  viewMode?:  ViewMode
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SCALE = 0.038   // 1 Three.js unit ≈ 26.3 ft

const MAT_COLOR: Record<MaterialType, string> = {
  asphalt: '#38383a',
  metal:   '#8fa3b1',
  tile:    '#b5633a',
}
const MAT_SHINE: Record<MaterialType, number> = {
  asphalt: 12,
  metal:   80,
  tile:    25,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePitch(pitch: string): { rise: number; run: number } {
  let m = pitch.match(/(\d+(?:\.\d+)?)[\/:∶](\d+)/)
  if (m) return { rise: parseFloat(m[1]), run: parseFloat(m[2]) }
  m = pitch.match(/(\d+(?:\.\d+)?)\s*°/)
  if (m) {
    const rad = (parseFloat(m[1]) * Math.PI) / 180
    return { rise: Math.tan(rad) * 12, run: 12 }
  }
  return { rise: 6, run: 12 }
}

function makeBuf(verts: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.computeVertexNormals()
  return geo
}

function dims(totalSqft: number, pitch: string) {
  const { rise, run } = parsePitch(pitch)
  const pf = rise / run          // pitch factor (rise over run)
  const sf = Math.sqrt(rise * rise + run * run) / run   // slope factor (hyp / run)
  const footprint = Math.max(totalSqft / sf, 80)
  const W = Math.sqrt(footprint * 1.45) * SCALE
  const D = (footprint / Math.sqrt(footprint * 1.45)) * SCALE
  const H = (W / 2) * pf
  return { W, D, H, pf, sf, rise, run, footprint }
}

// ── Roof meshes ───────────────────────────────────────────────────────────────

function RoofMat({ color, wireframe, shininess }: { color: string; wireframe: boolean; shininess: number }) {
  return <meshPhongMaterial color={color} side={THREE.DoubleSide} wireframe={wireframe} shininess={shininess} />
}

function GableMesh({ W, D, H, color, wireframe, shininess }: { W: number; D: number; H: number; color: string; wireframe: boolean; shininess: number }) {
  const geos = useMemo(() => ({
    front: makeBuf([
      -W/2, 0,  D/2,   W/2, 0,  D/2,   W/2, H, 0,
      -W/2, 0,  D/2,   W/2, H, 0,      -W/2, H, 0,
    ]),
    back: makeBuf([
      -W/2, 0, -D/2,  -W/2, H, 0,     W/2, 0, -D/2,
       W/2, 0, -D/2,  -W/2, H, 0,     W/2, H, 0,
    ]),
    gL: makeBuf([-W/2, 0,  D/2,  -W/2, 0, -D/2,  -W/2, H, 0]),
    gR: makeBuf([ W/2, 0,  D/2,   W/2, H, 0,      W/2, 0, -D/2]),
  }), [W, D, H])

  const m = <RoofMat color={color} wireframe={wireframe} shininess={shininess} />
  return (
    <group>
      <mesh geometry={geos.front}>{m}</mesh>
      <mesh geometry={geos.back}>{m}</mesh>
      <mesh geometry={geos.gL}>{m}</mesh>
      <mesh geometry={geos.gR}>{m}</mesh>
    </group>
  )
}

function HipMesh({ W, D, H, color, wireframe, shininess }: { W: number; D: number; H: number; color: string; wireframe: boolean; shininess: number }) {
  const geos = useMemo(() => {
    const rL = Math.max((W - D) / 2, W * 0.08)
    return {
      front: makeBuf([
        -W/2, 0,  D/2,    W/2, 0,  D/2,    rL, H, 0,
        -W/2, 0,  D/2,    rL, H, 0,        -rL, H, 0,
      ]),
      back: makeBuf([
        -W/2, 0, -D/2,   -rL, H, 0,        W/2, 0, -D/2,
         W/2, 0, -D/2,   -rL, H, 0,         rL, H, 0,
      ]),
      left:  makeBuf([-W/2, 0,  D/2,  -W/2, 0, -D/2,  -rL, H, 0]),
      right: makeBuf([ W/2, 0,  D/2,   rL, H, 0,       W/2, 0, -D/2]),
    }
  }, [W, D, H])

  const m = <RoofMat color={color} wireframe={wireframe} shininess={shininess} />
  return (
    <group>
      <mesh geometry={geos.front}>{m}</mesh>
      <mesh geometry={geos.back}>{m}</mesh>
      <mesh geometry={geos.left}>{m}</mesh>
      <mesh geometry={geos.right}>{m}</mesh>
    </group>
  )
}

function ComplexMesh({ W, D, H, color, wireframe, shininess }: { W: number; D: number; H: number; color: string; wireframe: boolean; shininess: number }) {
  // L-shaped roof: main wing + perpendicular wing offset
  const p = { color, wireframe, shininess }
  return (
    <group>
      <GableMesh W={W} D={D * 0.65} H={H} {...p} />
      <group position={[W * 0.22, 0, D * 0.18]} rotation={[0, Math.PI / 2, 0]}>
        <GableMesh W={D * 0.5} D={W * 0.38} H={H * 0.75} {...p} />
      </group>
    </group>
  )
}

// ── Measurement labels ────────────────────────────────────────────────────────

function MeasurementLabels({ W, D, H, totalSqft, pitch, rise, run }: {
  W: number; D: number; H: number; totalSqft: number; pitch: string; rise: number; run: number
}) {
  const wFt  = Math.round(W  / SCALE)
  const dFt  = Math.round(D  / SCALE)
  const hFt  = Math.round(H  / SCALE)
  const angle = Math.round(Math.atan(rise / run) * 180 / Math.PI)

  const label = (pos: [number, number, number], text: string) => (
    <Html position={pos} center style={{ pointerEvents: 'none', userSelect: 'none', whiteSpace: 'nowrap' }}>
      <div style={{ background: 'rgba(15,23,42,0.88)', color: '#e2e8f0', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(99,102,241,0.5)', backdropFilter: 'blur(4px)' }}>
        {text}
      </div>
    </Html>
  )

  return (
    <>
      {label([0, H + 0.15, 0],     `Ridge — ${Math.round(W / SCALE * 0.55)} ft`)}
      {label([0, -0.1, D / 2 + 0.15], `Width — ${wFt} ft`)}
      {label([W / 2 + 0.15, -0.1, 0], `Depth — ${dFt} ft`)}
      {label([-W / 2 - 0.15, H / 2, 0], `${angle}° / ${pitch}`)}
      {label([0, H / 2, -D / 2 - 0.15], `${totalSqft.toLocaleString()} sq ft`)}
    </>
  )
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function RoofScene({ totalSqft, pitch, segments, material, viewMode }: Props & { material: MaterialType; viewMode: ViewMode }) {
  const color    = MAT_COLOR[material]
  const shininess = MAT_SHINE[material]
  const wireframe = viewMode === 'wireframe'
  const { W, D, H, rise, run } = dims(totalSqft, pitch)
  const wallH = H * 0.45
  const seg = Math.max(segments || 2, 1)

  return (
    <group>
      {/* Ground grid */}
      <Grid args={[18, 18]} cellSize={0.5} cellThickness={0.3} cellColor="#334155"
        sectionSize={5} sectionColor="#475569" fadeDistance={22} position={[0, -wallH, 0]} />

      {/* House walls */}
      <mesh position={[0, -wallH / 2, 0]}>
        <boxGeometry args={[W, wallH, D]} />
        <meshPhongMaterial color={wireframe ? '#64748b' : '#e2e8f0'} side={THREE.DoubleSide} wireframe={wireframe} shininess={5} />
      </mesh>

      {/* Roof */}
      {seg <= 2 && <GableMesh   W={W} D={D} H={H} color={color} wireframe={wireframe} shininess={shininess} />}
      {seg >= 3 && seg <= 4 && <HipMesh    W={W} D={D} H={H} color={color} wireframe={wireframe} shininess={shininess} />}
      {seg >= 5 &&              <ComplexMesh W={W} D={D} H={H} color={color} wireframe={wireframe} shininess={shininess} />}

      {/* Measurement overlays */}
      {viewMode === 'measurements' && (
        <MeasurementLabels W={W} D={D} H={H} totalSqft={totalSqft} pitch={pitch} rise={rise} run={run} />
      )}
    </group>
  )
}

// ── Public component ──────────────────────────────────────────────────────────

export default function RoofModel3D({
  totalSqft,
  pitch      = '6/12',
  segments   = 2,
  material   = 'asphalt',
  viewMode   = 'solid',
}: Props) {
  if (!totalSqft || totalSqft < 100) return (
    <div className="w-full h-full flex items-center justify-center bg-slate-900 text-slate-500 text-sm">
      Roof measurements required to generate 3D model
    </div>
  )

  return (
    <div style={{ width: '100%', height: '100%', background: '#0f172a' }}>
      <Canvas camera={{ position: [4.5, 3.5, 4.5], fov: 42, near: 0.01, far: 100 }}
        gl={{ antialias: true }} shadows>
        <color attach="background" args={['#0f172a']} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[6, 10, 6]}  intensity={1.6} castShadow />
        <directionalLight position={[-4, 6, -4]} intensity={0.45} color="#a5b4fc" />
        <RoofScene totalSqft={totalSqft} pitch={pitch} segments={segments}
          material={material} viewMode={viewMode} />
        <OrbitControls enablePan enableZoom enableRotate
          minDistance={1.5} maxDistance={18} target={[0, 0, 0]} />
      </Canvas>
    </div>
  )
}
