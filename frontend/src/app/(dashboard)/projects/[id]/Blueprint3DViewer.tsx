"use client";

import React, { useRef, useState, useEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Html, ContactShadows, Environment, Grid } from "@react-three/drei";
import * as THREE from "three";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode = "iso" | "fp";
type UnitKey  = "ft" | "in" | "m" | "cm";

interface LayerState {
  foundation: boolean; framing: boolean; electrical: boolean;
  plumbing: boolean;   drywall: boolean;  roof: boolean;
}

interface Annotation { id: number; x: number; z: number; text: string }

interface SceneRoom     { name: string; x: number; z: number; width: number; depth: number; floor_type: string; sqft: number }
interface SceneWall     { x1: number; z1: number; x2: number; z2: number; thickness: number; type: "exterior" | "interior" }
interface SceneDoor     { x: number; z: number; width: number; height: number }
interface SceneWindow   { x: number; z: number; width: number; height: number; sill_height: number }
interface SceneElectrical { type: string; x: number; z: number }
interface ScenePlumbing   { type: string; x: number; z: number; rotation: number }

interface SceneData {
  building_width_ft: number; building_depth_ft: number; total_sqft: number;
  wall_height_ft: number; stories: number; confidence: number; scale_detected: string;
  rooms: SceneRoom[]; walls: SceneWall[]; doors: SceneDoor[]; windows: SceneWindow[];
  electrical: SceneElectrical[]; plumbing: ScenePlumbing[];
}

interface PlacedRoom { name: string; sqft: number; w: number; h: number; x: number; z: number; colorIdx: number }

// ─── Constants ────────────────────────────────────────────────────────────────

const WALL_H_DEFAULT = 9;
const EYE_HEIGHT     = 5.5;

const UNIT_LABELS:   Record<UnitKey, string> = { ft: "Feet", in: "Inches", m: "Meters", cm: "Centimeters" };
const UNIT_FACTORS:  Record<UnitKey, number> = { ft: 1, in: 12, m: 0.3048, cm: 30.48 };
const UNIT_SUFFIXES: Record<UnitKey, string> = { ft: "ft", in: "in", m: "m", cm: "cm" };

// PBR material palette — warm residential interior palette
const FLOOR_MAT: Record<string, { color: string; roughness: number; metalness: number }> = {
  hardwood: { color: "#c4863a", roughness: 0.48, metalness: 0.02 },
  tile:     { color: "#d8d4c8", roughness: 0.12, metalness: 0.04 },
  carpet:   { color: "#9c96b4", roughness: 0.98, metalness: 0    },
  concrete: { color: "#9e9e96", roughness: 0.92, metalness: 0.05 },
  vinyl:    { color: "#c4b892", roughness: 0.65, metalness: 0    },
  wood:     { color: "#c4863a", roughness: 0.48, metalness: 0.02 },
};

const ROOM_TINT = ["#cce0ff","#ccf0e0","#fff0cc","#ffccd8","#e8ccff","#ccf0f8","#ffd8c0","#ccf8e8"];

const LAYER_META: { key: keyof LayerState; label: string; color: string }[] = [
  { key: "foundation", label: "Foundation", color: "#9ca3af" },
  { key: "framing",    label: "Framing",    color: "#92400e" },
  { key: "electrical", label: "Electrical", color: "#fbbf24" },
  { key: "plumbing",   label: "Plumbing",   color: "#3b82f6" },
  { key: "drywall",    label: "Drywall",    color: "#e5e7eb" },
  { key: "roof",       label: "Roof",       color: "#6b7280" },
];

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function projectOntoWall(px: number, pz: number, wall: SceneWall): number {
  const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) return 0;
  return ((px - wall.x1) * dx + (pz - wall.z1) * dz) / len;
}

function isOnWall(px: number, pz: number, wall: SceneWall, tol = 2.5): boolean {
  const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) return false;
  const t = ((px - wall.x1) * dx + (pz - wall.z1) * dz) / (len * len);
  if (t < -0.05 || t > 1.05) return false;
  const projX = wall.x1 + t * dx, projZ = wall.z1 + t * dz;
  return Math.sqrt((px - projX) ** 2 + (pz - projZ) ** 2) < tol;
}

// ─── 3D components ────────────────────────────────────────────────────────────

function Foundation({ rooms }: { rooms: SceneRoom[] }) {
  if (!rooms.length) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of rooms) {
    minX = Math.min(minX, r.x); minZ = Math.min(minZ, r.z);
    maxX = Math.max(maxX, r.x + r.width); maxZ = Math.max(maxZ, r.z + r.depth);
  }
  return (
    <mesh receiveShadow position={[(minX + maxX) / 2, -0.18, (minZ + maxZ) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[maxX - minX + 0.8, maxZ - minZ + 0.8]} />
      <meshStandardMaterial color="#88867e" roughness={0.95} metalness={0.04} />
    </mesh>
  );
}

function RoomFloor({ room }: { room: SceneRoom }) {
  const mat = FLOOR_MAT[room.floor_type] ?? { color: "#c8b890", roughness: 0.6, metalness: 0 };
  return (
    <mesh receiveShadow position={[room.x + room.width / 2, 0.012, room.z + room.depth / 2]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[room.width - 0.06, room.depth - 0.06]} />
      <meshStandardMaterial color={mat.color} roughness={mat.roughness} metalness={mat.metalness} />
    </mesh>
  );
}

function WallBox({ x1, z1, x2, z2, yBot, yTop, thickness, color, roughness = 0.84 }: {
  x1: number; z1: number; x2: number; z2: number;
  yBot: number; yTop: number; thickness: number; color: string; roughness?: number;
}) {
  const len = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
  if (len < 0.05) return null;
  const dx = (x2 - x1) / len, dz = (z2 - z1) / len;
  return (
    <mesh
      castShadow receiveShadow
      position={[(x1 + x2) / 2, yBot + (yTop - yBot) / 2, (z1 + z2) / 2]}
      rotation={[0, -Math.atan2(dz, dx), 0]}
    >
      <boxGeometry args={[len, yTop - yBot, thickness]} />
      <meshStandardMaterial color={color} roughness={roughness} metalness={0} />
    </mesh>
  );
}

function WallWithDoors({ wall, wallHeight, doors, color }: {
  wall: SceneWall; wallHeight: number; doors: SceneDoor[]; color: string;
}) {
  const len = Math.sqrt((wall.x2 - wall.x1) ** 2 + (wall.z2 - wall.z1) ** 2);
  if (len < 0.05) return null;
  const t = wall.thickness || (wall.type === "exterior" ? 0.5 : 0.33);
  const dirX = (wall.x2 - wall.x1) / len, dirZ = (wall.z2 - wall.z1) / len;

  const openings = doors
    .filter(d => isOnWall(d.x, d.z, wall))
    .map(d => {
      const pos = projectOntoWall(d.x, d.z, wall);
      const hw  = (d.width || 3) / 2;
      return { start: pos - hw, end: pos + hw, height: d.height || 7 };
    })
    .sort((a, b) => a.start - b.start);

  const segs: { x1: number; z1: number; x2: number; z2: number; yBot: number; yTop: number }[] = [];
  let cur = 0;
  for (const op of openings) {
    if (op.start > cur + 0.1) segs.push({ x1: wall.x1 + dirX * cur, z1: wall.z1 + dirZ * cur, x2: wall.x1 + dirX * op.start, z2: wall.z1 + dirZ * op.start, yBot: 0, yTop: wallHeight });
    if (op.height < wallHeight - 0.1) segs.push({ x1: wall.x1 + dirX * op.start, z1: wall.z1 + dirZ * op.start, x2: wall.x1 + dirX * op.end, z2: wall.z1 + dirZ * op.end, yBot: op.height, yTop: wallHeight });
    cur = op.end;
  }
  if (cur < len - 0.1) segs.push({ x1: wall.x1 + dirX * cur, z1: wall.z1 + dirZ * cur, x2: wall.x2, z2: wall.z2, yBot: 0, yTop: wallHeight });

  return <>{segs.map((s, i) => <WallBox key={i} {...s} thickness={t} color={color} />)}</>;
}

function DoorVoid({ door, walls, wallHeight }: { door: SceneDoor; walls: SceneWall[]; wallHeight: number }) {
  const wall = walls.find(w => isOnWall(door.x, door.z, w, 3));
  if (!wall) return null;
  const len = Math.sqrt((wall.x2 - wall.x1) ** 2 + (wall.z2 - wall.z1) ** 2);
  if (len < 0.01) return null;
  const dx = (wall.x2 - wall.x1) / len, dz = (wall.z2 - wall.z1) / len;
  const pos = projectOntoWall(door.x, door.z, wall);
  const t = (wall.thickness || 0.5) + 0.08;
  const doorH = door.height || 7;
  return (
    <mesh position={[wall.x1 + dx * pos, doorH / 2, wall.z1 + dz * pos]} rotation={[0, -Math.atan2(dz, dx), 0]}>
      <boxGeometry args={[door.width || 3, doorH, t]} />
      <meshStandardMaterial color="#1a0d05" roughness={0.95} />
    </mesh>
  );
}

function WindowPane({ win, walls }: { win: SceneWindow; walls: SceneWall[] }) {
  const wall = walls.find(w => isOnWall(win.x, win.z, w, 3));
  if (!wall) return null;
  const len = Math.sqrt((wall.x2 - wall.x1) ** 2 + (wall.z2 - wall.z1) ** 2);
  if (len < 0.01) return null;
  const dx = (wall.x2 - wall.x1) / len, dz = (wall.z2 - wall.z1) / len;
  const pos = projectOntoWall(win.x, win.z, wall);
  const t = (wall.thickness || 0.5) + 0.06;
  const sill  = win.sill_height || 2.5;
  const winH  = win.height      || 3.5;
  const winW  = win.width       || 3;
  return (
    <mesh position={[wall.x1 + dx * pos, sill + winH / 2, wall.z1 + dz * pos]} rotation={[0, -Math.atan2(dz, dx), 0]}>
      <boxGeometry args={[winW, winH, t]} />
      <meshStandardMaterial color="#a8d4f0" transparent opacity={0.42} roughness={0.04} metalness={0.18} />
    </mesh>
  );
}

function ElectricalMarker({ el }: { el: SceneElectrical }) {
  const ceiling = el.type === "ceiling_light" || el.type === "ceiling_fan";
  const y = ceiling ? 8.7 : 4.0;
  const cfg = {
    ceiling_light: { color: "#fff5a0", emissive: "#ffee44", intensity: 1.4 },
    ceiling_fan:   { color: "#bae6fd", emissive: "#88c8f8", intensity: 0.4 },
    panel:         { color: "#94a3b8", emissive: "#000",    intensity: 0   },
    outlet:        { color: "#fbbf24", emissive: "#f59e0b", intensity: 0.3 },
    switch:        { color: "#f1f5f9", emissive: "#000",    intensity: 0   },
  } as any;
  const c = cfg[el.type] ?? cfg.outlet;
  return (
    <mesh position={[el.x, y, el.z]}>
      {ceiling ? <cylinderGeometry args={[0.3, 0.3, 0.14, 14]} /> : <boxGeometry args={[0.22, 0.22, 0.12]} />}
      <meshStandardMaterial color={c.color} emissive={c.emissive} emissiveIntensity={c.intensity} roughness={0.35} />
    </mesh>
  );
}

// Point light under ceiling fixtures
function CeilingLight({ el }: { el: SceneElectrical }) {
  if (el.type !== "ceiling_light") return null;
  return <pointLight position={[el.x, 8.4, el.z]} intensity={0.6} color="#fff5c0" distance={12} decay={2} />;
}

function PlumbingFixture({ pl }: { pl: ScenePlumbing }) {
  const size: [number, number, number] =
    pl.type === "toilet"       ? [1.8, 0.4, 2.5] :
    pl.type === "bathtub"      ? [3.0, 0.5, 6.0] :
    pl.type === "shower"       ? [3.0, 0.2, 3.0] :
    pl.type === "water_heater" ? [1.4, 4.5, 1.4] : [1.6, 0.35, 1.6];
  return (
    <mesh castShadow receiveShadow position={[pl.x, size[1] / 2, pl.z]} rotation={[0, pl.rotation * (Math.PI / 180), 0]}>
      <boxGeometry args={size} />
      <meshStandardMaterial color="#7ecaef" roughness={0.22} metalness={0.28} />
    </mesh>
  );
}

function RoomLabel({ room, wallH, unit }: { room: SceneRoom; wallH: number; unit: UnitKey }) {
  const suffix = UNIT_SUFFIXES[unit];
  const factor = UNIT_FACTORS[unit];
  const sqftText = room.sqft
    ? `${Math.round(room.sqft).toLocaleString()} sqft`
    : `${(room.width * factor).toFixed(0)} × ${(room.depth * factor).toFixed(0)} ${suffix}`;
  return (
    <Html position={[room.x + room.width / 2, wallH + 0.9, room.z + room.depth / 2]} center style={{ pointerEvents: "none", userSelect: "none" }}>
      <div style={{
        background: "rgba(255,255,255,0.9)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
        border: "1px solid rgba(0,0,0,0.08)", borderRadius: 8, padding: "4px 10px 5px",
        fontSize: 11, fontWeight: 700, color: "#1e293b", textAlign: "center", whiteSpace: "nowrap",
        boxShadow: "0 2px 12px rgba(0,0,0,0.15)", fontFamily: "system-ui,-apple-system,sans-serif", lineHeight: 1.4,
      }}>
        {room.name}
        <div style={{ fontSize: 9, fontWeight: 400, color: "#64748b", marginTop: 1 }}>{sqftText}</div>
      </div>
    </Html>
  );
}

function AnnotationPin({ ann, wallH }: { ann: Annotation; wallH: number }) {
  return (
    <>
      <mesh position={[ann.x, wallH * 0.4, ann.z]}>
        <sphereGeometry args={[0.28, 14, 14]} />
        <meshStandardMaterial color="#7c3aed" emissive="#7c3aed" emissiveIntensity={0.5} roughness={0.3} />
      </mesh>
      <Html position={[ann.x, wallH * 0.6, ann.z]} center style={{ pointerEvents: "none" }}>
        <div style={{
          background: "rgba(124,58,237,0.9)", color: "#fff", borderRadius: 7, padding: "3px 9px",
          fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        }}>
          📌 {ann.text}
        </div>
      </Html>
    </>
  );
}

// ─── Fallback room boxes (no Vision data yet) ─────────────────────────────────

function FallbackRoom({ room, layers, wallH }: { room: PlacedRoom; layers: LayerState; wallH: number }) {
  const floorColor = ROOM_TINT[room.colorIdx % ROOM_TINT.length];
  return (
    <>
      {layers.foundation && (
        <mesh receiveShadow position={[room.x + room.w / 2, -0.18, room.z + room.h / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[room.w + 0.5, room.h + 0.5]} />
          <meshStandardMaterial color="#88867e" roughness={0.95} />
        </mesh>
      )}
      {layers.drywall && (
        <mesh receiveShadow position={[room.x + room.w / 2, 0.012, room.z + room.h / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[room.w, room.h]} />
          <meshStandardMaterial color={floorColor} roughness={0.7} />
        </mesh>
      )}
      {(layers.framing || layers.drywall) && (
        <>
          <WallBox x1={room.x} z1={room.z} x2={room.x + room.w} z2={room.z} yBot={0} yTop={wallH} thickness={0.42} color={layers.drywall ? "#f0ece4" : "#b07040"} />
          <WallBox x1={room.x} z1={room.z + room.h} x2={room.x + room.w} z2={room.z + room.h} yBot={0} yTop={wallH} thickness={0.42} color={layers.drywall ? "#f0ece4" : "#b07040"} />
          <WallBox x1={room.x} z1={room.z} x2={room.x} z2={room.z + room.h} yBot={0} yTop={wallH} thickness={0.42} color={layers.drywall ? "#ece8e0" : "#8a5c2a"} />
          <WallBox x1={room.x + room.w} z1={room.z} x2={room.x + room.w} z2={room.z + room.h} yBot={0} yTop={wallH} thickness={0.42} color={layers.drywall ? "#ece8e0" : "#8a5c2a"} />
        </>
      )}
      {layers.roof && (
        <mesh position={[room.x + room.w / 2, wallH + 0.06, room.z + room.h / 2]}>
          <boxGeometry args={[room.w, 0.12, room.h]} />
          <meshStandardMaterial color="#ffffff" transparent opacity={0.13} />
        </mesh>
      )}
    </>
  );
}

// ─── Camera controllers ────────────────────────────────────────────────────────

function OverviewCameraSetup({ cx, cz, bw, bd }: { cx: number; cz: number; bw: number; bd: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const dist = Math.max(bw, bd) * 1.1 + 28;
    camera.position.set(cx + dist * 0.65, dist * 0.72, cz + dist * 0.65);
    (camera as THREE.PerspectiveCamera).fov = 42;
    camera.updateProjectionMatrix();
  }, [camera, cx, cz, bw, bd]);
  return null;
}

function WalkthroughCamera({ startX, startZ, onExit }: {
  startX: number; startZ: number; onExit: () => void;
}) {
  const { camera, gl } = useThree();
  const keys      = useRef<Set<string>>(new Set());
  const mouseDown = useRef(false);
  const lastMouseX = useRef(0);
  const yaw       = useRef(0);

  useEffect(() => {
    camera.position.set(startX, EYE_HEIGHT, startZ);
    yaw.current = 0;

    const onKD = (e: KeyboardEvent) => { keys.current.add(e.key.toLowerCase()); if (e.key === "Escape") onExit(); };
    const onKU = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const onMD = (e: MouseEvent)    => { mouseDown.current = true;  lastMouseX.current = e.clientX; };
    const onMU = ()                  => { mouseDown.current = false; };
    const onMM = (e: MouseEvent)    => {
      if (!mouseDown.current) return;
      yaw.current       -= (e.clientX - lastMouseX.current) * 0.004;
      lastMouseX.current = e.clientX;
    };

    window.addEventListener("keydown", onKD);
    window.addEventListener("keyup",   onKU);
    gl.domElement.addEventListener("mousedown", onMD);
    window.addEventListener("mouseup",   onMU);
    window.addEventListener("mousemove", onMM);
    return () => {
      window.removeEventListener("keydown", onKD);
      window.removeEventListener("keyup",   onKU);
      gl.domElement.removeEventListener("mousedown", onMD);
      window.removeEventListener("mouseup",   onMU);
      window.removeEventListener("mousemove", onMM);
    };
  }, [startX, startZ, onExit, camera, gl.domElement]);

  useFrame((_, dt) => {
    const speed = 13 * dt;
    const fwd   = new THREE.Vector3(Math.sin(yaw.current), 0, Math.cos(yaw.current));
    const right  = new THREE.Vector3(fwd.z, 0, -fwd.x);
    if (keys.current.has("w") || keys.current.has("arrowup"))    camera.position.addScaledVector(fwd,  speed);
    if (keys.current.has("s") || keys.current.has("arrowdown"))  camera.position.addScaledVector(fwd, -speed);
    if (keys.current.has("a") || keys.current.has("arrowleft"))  camera.position.addScaledVector(right, -speed);
    if (keys.current.has("d") || keys.current.has("arrowright")) camera.position.addScaledVector(right,  speed);
    camera.position.y = EYE_HEIGHT;
    camera.lookAt(camera.position.x + fwd.x * 10, EYE_HEIGHT, camera.position.z + fwd.z * 10);
  });

  return null;
}

// ─── Main 3D scene ────────────────────────────────────────────────────────────

interface Scene3DProps {
  sceneData:     SceneData | null | undefined;
  layers:        LayerState;
  unit:          UnitKey;
  viewMode:      ViewMode;
  onExitWalk:    () => void;
  fallbackRooms: PlacedRoom[];
  annotations:   Annotation[];
  overviewKey:   number;
}

function Scene3D({ sceneData, layers, unit, viewMode, onExitWalk, fallbackRooms, annotations, overviewKey }: Scene3DProps) {
  const sd    = sceneData;
  const hasSD = !!(sd?.walls?.length);
  const bw    = hasSD ? sd!.building_width_ft  : Math.max(30, fallbackRooms.reduce((m, r) => Math.max(m, r.x + r.w), 0));
  const bd    = hasSD ? sd!.building_depth_ft  : Math.max(30, fallbackRooms.reduce((m, r) => Math.max(m, r.z + r.h), 0));
  const cx    = bw / 2;
  const cz    = bd / 2;
  const wallH = sd?.wall_height_ft || WALL_H_DEFAULT;

  const extColor = layers.drywall ? "#f0ece4" : "#b07040";
  const intColor = layers.drywall ? "#f5f2ee" : "#a06030";

  return (
    <>
      {/* Scene background and atmosphere */}
      <color attach="background" args={["#e8edf6"]} />
      <fog attach="fog" args={["#e8edf6", 150, 500]} />

      {/* ── Photorealistic lighting ──────────────────────────────────────── */}
      {/* Warm afternoon sun — primary shadow caster */}
      <directionalLight
        castShadow
        position={[cx + 35, 50, cz + 28]}
        intensity={1.6}
        color="#fff6e0"
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-near={1}
        shadow-camera-far={400}
        shadow-camera-left={-100}
        shadow-camera-right={100}
        shadow-camera-top={100}
        shadow-camera-bottom={-100}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      {/* Cool sky bounce from opposite side */}
      <directionalLight position={[cx - 30, 18, cz - 22]} intensity={0.38} color="#c0d8ff" />
      {/* Soft warm fill from below (ground bounce) */}
      <hemisphereLight args={["#f0eeff", "#e8d4b0", 0.5]} />
      {/* HDRI-like environment for PBR reflections */}
      <Environment preset="apartment" background={false} />

      {/* ── Camera ──────────────────────────────────────────────────────── */}
      {viewMode === "iso" ? (
        <>
          <OverviewCameraSetup key={overviewKey} cx={cx} cz={cz} bw={bw} bd={bd} />
          <OrbitControls
            target={[cx, 0, cz]}
            enableDamping
            dampingFactor={0.07}
            makeDefault
            minPolarAngle={0.05}
            maxPolarAngle={Math.PI / 2.05}
            minDistance={5}
            maxDistance={500}
          />
        </>
      ) : (
        <WalkthroughCamera key="fp" startX={cx} startZ={cz} onExit={onExitWalk} />
      )}

      {/* ── Ground plane ─────────────────────────────────────────────────── */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[cx, -0.22, cz]}>
        <planeGeometry args={[bw + 80, bd + 80]} />
        <meshStandardMaterial color="#b0a898" roughness={0.93} metalness={0} />
      </mesh>

      {/* Subtle measurement grid */}
      {layers.foundation && (
        <Grid
          position={[cx, -0.19, cz]}
          args={[bw + 60, bd + 60]}
          cellSize={5}
          cellThickness={0.3}
          cellColor="#8a8880"
          sectionSize={20}
          sectionThickness={0.7}
          sectionColor="#706860"
          fadeDistance={220}
          fadeStrength={1.5}
          infiniteGrid={false}
        />
      )}

      {/* ── Building (Vision data) ────────────────────────────────────────── */}
      {hasSD ? (
        <>
          {layers.foundation && <Foundation rooms={sd!.rooms} />}

          {/* Floors — material varies by room type */}
          {layers.drywall && sd!.rooms.map((r, i) => <RoomFloor key={i} room={r} />)}

          {/* Walls with door cutouts */}
          {(layers.framing || layers.drywall) && sd!.walls.map((w, i) => (
            <WallWithDoors
              key={i} wall={w} wallHeight={wallH} doors={sd!.doors}
              color={w.type === "exterior" ? extColor : intColor}
            />
          ))}

          {/* Dark void inside door openings */}
          {layers.drywall && sd!.doors.map((d, i) => (
            <DoorVoid key={i} door={d} walls={sd!.walls} wallHeight={wallH} />
          ))}

          {/* Glass windows */}
          {layers.drywall && sd!.windows.map((w, i) => (
            <WindowPane key={i} win={w} walls={sd!.walls} />
          ))}

          {/* Roof cap (translucent — lets you see inside) */}
          {layers.roof && sd!.rooms.map((r, i) => (
            <mesh key={i} position={[r.x + r.width / 2, wallH + 0.08, r.z + r.depth / 2]}>
              <boxGeometry args={[r.width + 0.12, 0.16, r.depth + 0.12]} />
              <meshStandardMaterial color="#e8e4dc" transparent opacity={0.15} roughness={0.9} />
            </mesh>
          ))}

          {/* Electrical fixtures */}
          {layers.electrical && sd!.electrical.map((el, i) => (
            <React.Fragment key={i}>
              <ElectricalMarker el={el} />
              <CeilingLight el={el} />
            </React.Fragment>
          ))}

          {/* Plumbing fixtures */}
          {layers.plumbing && sd!.plumbing.map((pl, i) => <PlumbingFixture key={i} pl={pl} />)}

          {/* Room labels — overview only */}
          {viewMode === "iso" && sd!.rooms.map((r, i) => (
            <RoomLabel key={i} room={r} wallH={wallH} unit={unit} />
          ))}

          {/* Soft contact shadow on floor */}
          <ContactShadows
            position={[cx, 0.02, cz]}
            width={bw + 20} height={bd + 20}
            far={4} blur={2.5} opacity={0.38}
          />
        </>
      ) : (
        /* ── Fallback room boxes (before Vision parse) ───────────────────── */
        <>
          {fallbackRooms.map((r, i) => (
            <FallbackRoom key={i} room={r} layers={layers} wallH={WALL_H_DEFAULT} />
          ))}
          {viewMode === "iso" && fallbackRooms.map((r, i) => (
            <Html key={i} position={[r.x + r.w / 2, WALL_H_DEFAULT + 0.9, r.z + r.h / 2]} center style={{ pointerEvents: "none" }}>
              <div style={{
                background: "rgba(255,255,255,0.9)", backdropFilter: "blur(8px)", borderRadius: 8,
                padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#1e293b",
                whiteSpace: "nowrap", boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
              }}>
                {r.name}
                <div style={{ fontSize: 9, fontWeight: 400, color: "#64748b" }}>{Math.round(r.sqft).toLocaleString()} sqft</div>
              </div>
            </Html>
          ))}
          <ContactShadows position={[cx, 0.02, cz]} width={bw + 15} height={bd + 15} far={4} blur={2.5} opacity={0.3} />
        </>
      )}

      {/* Annotation pins */}
      {annotations.map(ann => <AnnotationPin key={ann.id} ann={ann} wallH={wallH} />)}

      {/* Walkthrough HUD overlay */}
      {viewMode === "fp" && (
        <Html fullscreen style={{ pointerEvents: "none" }}>
          <>
            {/* Crosshair */}
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 24, height: 24 }}>
              <div style={{ position: "absolute", top: "50%", left: 0, width: "100%", height: 1.5, background: "rgba(255,255,255,0.85)", borderRadius: 2, transform: "translateY(-50%)" }} />
              <div style={{ position: "absolute", left: "50%", top: 0, height: "100%", width: 1.5, background: "rgba(255,255,255,0.85)", borderRadius: 2, transform: "translateX(-50%)" }} />
            </div>
            {/* Controls hint */}
            <div style={{
              position: "absolute", bottom: 52, left: "50%", transform: "translateX(-50%)",
              background: "rgba(0,0,0,0.52)", color: "#fff", borderRadius: 10, padding: "6px 20px",
              fontSize: 12, fontWeight: 500, backdropFilter: "blur(10px)", letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}>
              W / A / S / D to move &nbsp;·&nbsp; Drag to look around &nbsp;·&nbsp; Esc to exit
            </div>
          </>
        </Html>
      )}
    </>
  );
}

// ─── Fallback room builder ─────────────────────────────────────────────────────

function buildRooms(analysis: any): PlacedRoom[] {
  let rawRooms: { name: string; sqft: number; w: number; h: number }[] = [];
  if (analysis?.rooms?.length > 0) {
    rawRooms = analysis.rooms.map((r: any) => {
      const sqft = r.sqft || r.area || 100;
      const w = r.dimensions?.width || r.width || Math.sqrt(sqft * 1.3);
      const h = r.dimensions?.height || r.height || sqft / w;
      return { name: r.name || "Room", sqft, w, h };
    });
  } else {
    const total = analysis?.total_sqft || 1200;
    rawRooms = [
      { name: "Living Room",    sqft: total * 0.30 },
      { name: "Kitchen",        sqft: total * 0.18 },
      { name: "Master Bedroom", sqft: total * 0.20 },
      { name: "Bedroom 2",      sqft: total * 0.14 },
      { name: "Bathroom",       sqft: total * 0.10 },
      { name: "Garage",         sqft: total * 0.08 },
    ].map(r => { const w = Math.sqrt(r.sqft * 1.3); return { ...r, w, h: r.sqft / w }; });
  }
  rawRooms.sort((a, b) => b.sqft - a.sqft);
  const maxRowWidth = Math.sqrt(rawRooms.reduce((s, r) => s + r.sqft, 0)) * 1.5;
  const placed: PlacedRoom[] = [];
  let curX = 0, curZ = 0, rowMaxH = 0, ci = 0;
  for (const r of rawRooms) {
    if (curX > 0 && curX + r.w > maxRowWidth) { curX = 0; curZ += rowMaxH + 2; rowMaxH = 0; }
    placed.push({ name: r.name, sqft: r.sqft, w: r.w, h: r.h, x: curX, z: curZ, colorIdx: ci++ });
    curX += r.w + 2; rowMaxH = Math.max(rowMaxH, r.h);
  }
  return placed;
}

// ─── Main exported component ───────────────────────────────────────────────────

export default function Blueprint3DViewer({
  analysis, sceneData,
}: {
  analysis: any;
  sceneData?: SceneData | null;
}) {
  const [viewMode,        setViewMode]        = useState<ViewMode>("iso");
  const [layers,          setLayers]          = useState<LayerState>({ foundation: true, framing: true, electrical: false, plumbing: false, drywall: true, roof: true });
  const [unit,            setUnit]            = useState<UnitKey>("ft");
  const [showLayersPanel, setShowLayersPanel] = useState(false);
  const [annotations,     setAnnotations]     = useState<Annotation[]>([]);
  const [overviewKey,     setOverviewKey]     = useState(0);
  const nextId = useRef(1);

  const fallbackRooms = useRef<PlacedRoom[]>(buildRooms(analysis));
  useEffect(() => { fallbackRooms.current = buildRooms(analysis); }, [analysis]);

  const sd    = sceneData;
  const hasSD = !!(sd?.walls?.length);
  const wallH = sd?.wall_height_ft || WALL_H_DEFAULT;

  function toggleLayer(key: keyof LayerState) {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function exitWalkthrough() {
    setViewMode("iso");
    setOverviewKey(k => k + 1); // force camera reset
  }

  return (
    <div className="flex flex-col gap-3 select-none">
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap px-1">
        {/* View mode toggle */}
        <div className="flex rounded-lg overflow-hidden border border-gray-200 shadow-sm">
          <button
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode === "iso" ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            onClick={exitWalkthrough}
          >⬡ Overview</button>
          <button
            className={`px-3 py-1.5 text-xs font-semibold border-l border-gray-200 transition-colors ${viewMode === "fp" ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            onClick={() => setViewMode("fp")}
          >🚶 Walk Through</button>
        </div>

        <div className="w-px h-5 bg-gray-200" />

        {/* Layers */}
        <div className="relative">
          <button
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showLayersPanel ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`}
            onClick={() => setShowLayersPanel(p => !p)}
          >🏗 Layers</button>
          {showLayersPanel && (
            <div className="absolute left-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded-xl shadow-xl p-3 w-48">
              <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-widest">Visibility</p>
              {LAYER_META.map(({ key, label, color }) => (
                <label key={key} className="flex items-center gap-2 py-1 px-1 cursor-pointer hover:bg-gray-50 rounded-lg">
                  <input type="checkbox" checked={layers[key]} onChange={() => toggleLayer(key)} className="rounded accent-indigo-600" />
                  <span className="w-3 h-3 rounded-sm flex-shrink-0 border border-gray-200" style={{ backgroundColor: color }} />
                  <span className="text-xs text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Unit selector */}
        <select
          className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 font-medium"
          value={unit}
          onChange={e => setUnit(e.target.value as UnitKey)}
        >
          {(Object.keys(UNIT_LABELS) as UnitKey[]).map(k => (
            <option key={k} value={k}>{UNIT_LABELS[k]}</option>
          ))}
        </select>

        {viewMode === "fp" && (
          <button
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
            onClick={exitWalkthrough}
          >✕ Exit Walk Mode</button>
        )}
      </div>

      {/* ── Three.js Canvas ───────────────────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden border border-gray-200 shadow-xl" style={{ height: 560 }}>
        <Canvas
          shadows
          camera={{ position: [40, 32, 40], fov: 42, near: 0.1, far: 1500 }}
          gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
          dpr={[1, 2]}
        >
          <Suspense fallback={null}>
            <Scene3D
              sceneData={sceneData}
              layers={layers}
              unit={unit}
              viewMode={viewMode}
              onExitWalk={exitWalkthrough}
              fallbackRooms={fallbackRooms.current}
              annotations={annotations}
              overviewKey={overviewKey}
            />
          </Suspense>
        </Canvas>
      </div>

      {/* ── Building stats panel ──────────────────────────────────────────── */}
      {hasSD && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: "Total Area",    value: `${(sd!.total_sqft || 0).toLocaleString()} sqft` },
            { label: "Rooms",         value: sd!.rooms.length },
            { label: "Wall Height",   value: `${wallH} ft` },
            { label: "Parse Quality", value: `${Math.round((sd!.confidence || 0) * 100)}%` },
          ].map(s => (
            <div key={s.label} className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <p className="text-xs text-gray-400 font-medium">{s.label}</p>
              <p className="text-sm font-bold text-gray-800 mt-0.5">{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Annotations list ─────────────────────────────────────────────── */}
      {annotations.length > 0 && (
        <div className="border border-gray-200 rounded-xl bg-white shadow-sm p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">📌 Notes ({annotations.length})</p>
            <button className="text-xs text-red-500 hover:text-red-700" onClick={() => setAnnotations([])}>Clear all</button>
          </div>
          <div className="flex flex-col gap-1">
            {annotations.map(ann => (
              <div key={ann.id} className="flex items-center gap-2 py-1.5 px-2 bg-purple-50 rounded-lg">
                <span className="w-5 h-5 bg-purple-600 rounded-full flex items-center justify-center text-white text-xs flex-shrink-0">✏</span>
                <span className="text-xs text-gray-700 flex-1">{ann.text}</span>
                <button className="text-gray-400 hover:text-red-500 text-sm" onClick={() => setAnnotations(p => p.filter(a => a.id !== ann.id))}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
