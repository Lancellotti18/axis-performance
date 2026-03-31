"use client";

import React, { useRef, useState, useEffect, useMemo, Suspense, useCallback, createContext, useContext } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Html, ContactShadows, Environment, Grid } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, ChromaticAberration } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode  = "iso" | "fp";
type UnitKey   = "ft" | "in" | "m" | "cm";
type StyleMode = "photo" | "minimal" | "wireframe";

interface LayerState {
  foundation: boolean; framing: boolean; electrical: boolean;
  plumbing: boolean;   drywall: boolean;  roof: boolean;
}

interface Annotation { id: number; x: number; z: number; text: string }

interface SceneRoom      { name: string; x: number; z: number; width: number; depth: number; floor_type: string; sqft: number }
interface SceneWall      { x1: number; z1: number; x2: number; z2: number; thickness: number; type: "exterior" | "interior" }
interface SceneDoor      { x: number; z: number; width: number; height: number }
interface SceneWindow    { x: number; z: number; width: number; height: number; sill_height: number }
interface SceneElectrical { type: string; x: number; z: number }
interface ScenePlumbing   { type: string; x: number; z: number; rotation: number }

interface SceneData {
  building_width_ft: number; building_depth_ft: number; total_sqft: number;
  wall_height_ft: number; stories: number; confidence: number; scale_detected: string;
  rooms: SceneRoom[]; walls: SceneWall[]; doors: SceneDoor[]; windows: SceneWindow[];
  electrical: SceneElectrical[]; plumbing: ScenePlumbing[];
}

interface PlacedRoom { name: string; sqft: number; w: number; h: number; x: number; z: number; colorIdx: number }

// ─── Context ──────────────────────────────────────────────────────────────────

const StyleCtx = createContext<StyleMode>("photo");

// ─── Constants ────────────────────────────────────────────────────────────────

const WALL_H_DEFAULT = 9;
const EYE_HEIGHT     = 5.5;

const UNIT_LABELS:   Record<UnitKey, string> = { ft: "Feet", in: "Inches", m: "Meters", cm: "Centimeters" };
const UNIT_FACTORS:  Record<UnitKey, number> = { ft: 1, in: 12, m: 0.3048, cm: 30.48 };
const UNIT_SUFFIXES: Record<UnitKey, string> = { ft: "ft", in: "in", m: "m", cm: "cm" };

const FLOOR_MAT_PROPS: Record<string, { color: string; roughness: number; metalness: number }> = {
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

// ─── Procedural floor textures ────────────────────────────────────────────────

function makeHardwoodTexture(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const ctx = c.getContext("2d")!;
  const plankH = S / 7;
  ctx.fillStyle = "#c4863a";
  ctx.fillRect(0, 0, S, S);
  for (let row = 0; row < 8; row++) {
    const offsetX = row % 2 === 0 ? 0 : S * 0.5;
    const y = row * plankH;
    for (let col = -1; col < 3; col++) {
      const x = col * (S * 0.5) + offsetX;
      const shade = 0.82 + Math.random() * 0.18;
      ctx.fillStyle = `rgb(${Math.round(196 * shade)},${Math.round(134 * shade)},${Math.round(58 * shade)})`;
      ctx.fillRect(x + 1.5, y + 1.5, S * 0.5 - 3, plankH - 3);
      ctx.strokeStyle = "rgba(0,0,0,0.07)";
      ctx.lineWidth = 0.5;
      for (let g = 1; g < 5; g++) {
        ctx.beginPath();
        ctx.moveTo(x, y + plankH * (g / 5));
        ctx.bezierCurveTo(
          x + S * 0.15, y + plankH * (g / 5) + (Math.random() - 0.5) * 3,
          x + S * 0.35, y + plankH * (g / 5) + (Math.random() - 0.5) * 3,
          x + S * 0.5,  y + plankH * (g / 5) + (Math.random() - 0.5) * 3
        );
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(x, y, S * 0.5, 2);
      ctx.fillRect(x, y, 2, plankH);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.18, 0.18);
  return tex;
}

function makeTileTexture(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const ctx = c.getContext("2d")!;
  const ts = S / 4;
  ctx.fillStyle = "#d8d4c8"; ctx.fillRect(0, 0, S, S);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const shade = 0.93 + Math.random() * 0.07;
      ctx.fillStyle = `rgb(${Math.round(216 * shade)},${Math.round(212 * shade)},${Math.round(200 * shade)})`;
      ctx.fillRect(col * ts + 3, row * ts + 3, ts - 6, ts - 6);
      ctx.fillStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.04})`;
      ctx.fillRect(col * ts + 4, row * ts + 4, ts * 0.35, ts * 0.25);
    }
  }
  ctx.fillStyle = "#b0ac9e";
  for (let i = 0; i <= 4; i++) { ctx.fillRect(i * ts - 2, 0, 4, S); ctx.fillRect(0, i * ts - 2, S, 4); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.14, 0.14);
  return tex;
}

function makeCarpetTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#9c96b4"; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 3000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const v = Math.floor(Math.random() * 40 - 20);
    ctx.fillStyle = `rgba(${Math.max(0, 156 + v)},${Math.max(0, 150 + v)},${Math.max(0, 180 + v)},0.35)`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.25, 0.25);
  return tex;
}

const texCache: Record<string, THREE.CanvasTexture> = {};
function getFloorTex(type: string): THREE.CanvasTexture | null {
  if (typeof window === "undefined") return null;
  if (!texCache[type]) {
    if (type === "hardwood" || type === "wood") texCache[type] = makeHardwoodTexture();
    else if (type === "tile")                   texCache[type] = makeTileTexture();
    else if (type === "carpet")                 texCache[type] = makeCarpetTexture();
    else return null;
  }
  return texCache[type];
}

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

function getRoomType(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("living") || n.includes("lounge") || n.includes("family")) return "living";
  if (n.includes("kitchen"))                                                  return "kitchen";
  if (n.includes("master") || n.includes("primary"))                          return "master";
  if (n.includes("bed"))                                                       return "bedroom";
  if (n.includes("bath"))                                                      return "bathroom";
  if (n.includes("dining"))                                                    return "dining";
  if (n.includes("office") || n.includes("study"))                            return "office";
  if (n.includes("garage"))                                                    return "garage";
  if (n.includes("laundry") || n.includes("utility"))                         return "laundry";
  return "generic";
}

// ─── 3D components ────────────────────────────────────────────────────────────

function RoomFloor({ room, selected, onSelect }: { room: SceneRoom; selected: boolean; onSelect: () => void }) {
  const style = useContext(StyleCtx);
  const mat  = FLOOR_MAT_PROPS[room.floor_type] ?? { color: "#c8b890", roughness: 0.6, metalness: 0 };
  const tex  = useMemo(() => getFloorTex(room.floor_type), [room.floor_type]);
  const wireframe = style === "wireframe";
  const showTex   = style === "photo" && !selected;
  return (
    <mesh
      receiveShadow
      position={[room.x + room.width / 2, 0.012, room.z + room.depth / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
    >
      <planeGeometry args={[room.width - 0.06, room.depth - 0.06]} />
      <meshStandardMaterial
        color={selected ? "#fde68a" : mat.color}
        roughness={mat.roughness}
        metalness={mat.metalness}
        map={showTex ? (tex ?? undefined) : undefined}
        wireframe={wireframe}
        emissive={selected ? "#f59e0b" : "#000000"}
        emissiveIntensity={selected ? 0.12 : 0}
      />
    </mesh>
  );
}

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

function WallBox({ x1, z1, x2, z2, yBot, yTop, thickness, color, roughness = 0.84 }: {
  x1: number; z1: number; x2: number; z2: number;
  yBot: number; yTop: number; thickness: number; color: string; roughness?: number;
}) {
  const style = useContext(StyleCtx);
  const len = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
  if (len < 0.05) return null;
  const dx = (x2 - x1) / len, dz = (z2 - z1) / len;
  return (
    <mesh castShadow receiveShadow position={[(x1 + x2) / 2, yBot + (yTop - yBot) / 2, (z1 + z2) / 2]} rotation={[0, -Math.atan2(dz, dx), 0]}>
      <boxGeometry args={[len, yTop - yBot, thickness]} />
      <meshStandardMaterial color={color} roughness={roughness} metalness={0} wireframe={style === "wireframe"} />
    </mesh>
  );
}

function WallWithDoors({ wall, wallHeight, doors, color }: {
  wall: SceneWall; wallHeight: number; doors: SceneDoor[]; color: string;
}) {
  const len = Math.sqrt((wall.x2 - wall.x1) ** 2 + (wall.z2 - wall.z1) ** 2);
  if (len < 0.05) return null;
  const t    = wall.thickness || (wall.type === "exterior" ? 0.5 : 0.33);
  const dirX = (wall.x2 - wall.x1) / len, dirZ = (wall.z2 - wall.z1) / len;
  const openings = doors
    .filter(d => isOnWall(d.x, d.z, wall))
    .map(d => { const pos = projectOntoWall(d.x, d.z, wall); const hw = (d.width || 3) / 2; return { start: pos - hw, end: pos + hw, height: d.height || 7 }; })
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
  const t   = (wall.thickness || 0.5) + 0.08;
  const doorH = door.height || 7;
  return (
    <mesh position={[wall.x1 + dx * pos, doorH / 2, wall.z1 + dz * pos]} rotation={[0, -Math.atan2(dz, dx), 0]}>
      <boxGeometry args={[door.width || 3, doorH, t]} />
      <meshStandardMaterial color="#140a02" roughness={0.95} />
    </mesh>
  );
}

function WindowPane({ win, walls }: { win: SceneWindow; walls: SceneWall[] }) {
  const wall = walls.find(w => isOnWall(win.x, win.z, w, 3));
  if (!wall) return null;
  const len = Math.sqrt((wall.x2 - wall.x1) ** 2 + (wall.z2 - wall.z1) ** 2);
  if (len < 0.01) return null;
  const dx   = (wall.x2 - wall.x1) / len, dz = (wall.z2 - wall.z1) / len;
  const pos  = projectOntoWall(win.x, win.z, wall);
  const t    = (wall.thickness || 0.5) + 0.06;
  const sill = win.sill_height || 2.5;
  const winH = win.height || 3.5;
  const winW = win.width  || 3;
  return (
    <mesh position={[wall.x1 + dx * pos, sill + winH / 2, wall.z1 + dz * pos]} rotation={[0, -Math.atan2(dz, dx), 0]}>
      <boxGeometry args={[winW, winH, t]} />
      <meshStandardMaterial color="#a8d4f0" transparent opacity={0.42} roughness={0.04} metalness={0.18} />
    </mesh>
  );
}

function WindowLightShaft({ win, walls, cx, cz }: { win: SceneWindow; walls: SceneWall[]; cx: number; cz: number }) {
  const style = useContext(StyleCtx);
  if (style !== "photo") return null;
  const wall = walls.find(w => isOnWall(win.x, win.z, w, 3));
  if (!wall) return null;
  const len = Math.sqrt((wall.x2 - wall.x1) ** 2 + (wall.z2 - wall.z1) ** 2);
  if (len < 0.01) return null;
  const dx = (wall.x2 - wall.x1) / len, dz = (wall.z2 - wall.z1) / len;
  const nx = -dz, nz = dx;
  const toCxX = cx - win.x, toCzZ = cz - win.z;
  const dot   = nx * toCxX + nz * toCzZ;
  const inX   = dot > 0 ? nx : -nx;
  const inZ   = dot > 0 ? nz : -nz;
  const pos   = projectOntoWall(win.x, win.z, wall);
  const sill  = win.sill_height || 2.5;
  const winH  = win.height || 3.5;
  const shaftLen = 8;
  const cx3 = wall.x1 + dx * pos + inX * shaftLen * 0.5;
  const cz3 = wall.z1 + dz * pos + inZ * shaftLen * 0.5;
  const rotY = -Math.atan2(inZ, inX) + Math.PI / 2;
  return (
    <mesh position={[cx3, sill + winH * 0.45, cz3]} rotation={[0, rotY, 0]}>
      <boxGeometry args={[shaftLen, winH * 0.85, win.width || 3]} />
      <meshStandardMaterial color="#fff8d0" transparent opacity={0.03} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
    </mesh>
  );
}

// ─── Dimension overlays ───────────────────────────────────────────────────────

function DimensionOverlays({ walls, rooms, wallH, unit }: { walls: SceneWall[]; rooms: SceneRoom[]; wallH: number; unit: UnitKey }) {
  const factor = UNIT_FACTORS[unit];
  const suffix = UNIT_SUFFIXES[unit];
  return (
    <>
      {walls.filter(w => w.type === "exterior").map((wall, i) => {
        const len = Math.sqrt((wall.x2 - wall.x1) ** 2 + (wall.z2 - wall.z1) ** 2);
        if (len < 3) return null;
        const mx = (wall.x1 + wall.x2) / 2;
        const mz = (wall.z1 + wall.z2) / 2;
        return (
          <Html key={i} position={[mx, wallH + 0.6, mz]} center style={{ pointerEvents: "none" }}>
            <div style={{ background: "rgba(15,23,42,0.82)", color: "#fbbf24", padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap", backdropFilter: "blur(4px)" }}>
              {(len * factor).toFixed(1)}{suffix}
            </div>
          </Html>
        );
      })}
      {rooms.map((r, i) => (
        <Html key={`r${i}`} position={[r.x + r.width / 2, wallH + 1.5, r.z + r.depth / 2]} center style={{ pointerEvents: "none" }}>
          <div style={{ background: "rgba(15,23,42,0.7)", color: "#bfdbfe", padding: "1px 7px", borderRadius: 5, fontSize: 9, fontWeight: 600, whiteSpace: "nowrap" }}>
            {(r.width * factor).toFixed(1)} × {(r.depth * factor).toFixed(1)} {suffix}
          </div>
        </Html>
      ))}
    </>
  );
}

// ─── Measurement tool ─────────────────────────────────────────────────────────

function MeasureFloor({ active, points, onPoint, bw, bd }: {
  active: boolean;
  points: THREE.Vector3[];
  onPoint: (p: THREE.Vector3) => void;
  bw: number; bd: number;
}) {
  const handleClick = useCallback((e: any) => {
    if (!active) return;
    e.stopPropagation();
    onPoint(e.point.clone());
  }, [active, onPoint]);

  const linePositions = useMemo(() => {
    if (points.length < 2) return null;
    return new Float32Array([points[0].x, 0.08, points[0].z, points[1].x, 0.08, points[1].z]);
  }, [points]);

  const dist = points.length === 2 ? points[0].distanceTo(points[1]) : null;

  return (
    <>
      {/* Invisible clickable floor for measurement */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[bw / 2, 0.05, bd / 2]} onClick={handleClick}>
        <planeGeometry args={[bw + 60, bd + 60]} />
        <meshStandardMaterial visible={false} />
      </mesh>

      {/* Point A */}
      {points.length >= 1 && (
        <mesh position={[points[0].x, 0.2, points[0].z]}>
          <sphereGeometry args={[0.35, 12, 12]} />
          <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.7} />
        </mesh>
      )}

      {/* Point B + line + label */}
      {points.length >= 2 && linePositions && (
        <>
          <mesh position={[points[1].x, 0.2, points[1].z]}>
            <sphereGeometry args={[0.35, 12, 12]} />
            <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.7} />
          </mesh>
          <line_>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[linePositions, 3]} />
            </bufferGeometry>
            <lineBasicMaterial color="#f59e0b" />
          </line_>
          <Html position={[(points[0].x + points[1].x) / 2, 1.2, (points[0].z + points[1].z) / 2]} center style={{ pointerEvents: "none" }}>
            <div style={{ background: "rgba(0,0,0,0.85)", color: "#fbbf24", padding: "4px 12px", borderRadius: 8, fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", boxShadow: "0 2px 10px rgba(0,0,0,0.4)" }}>
              📐 {dist!.toFixed(2)} ft
            </div>
          </Html>
        </>
      )}
    </>
  );
}

// ─── Electrical ───────────────────────────────────────────────────────────────

function ElectricalMarker({ el }: { el: SceneElectrical }) {
  const ceiling = el.type === "ceiling_light" || el.type === "ceiling_fan";
  const y   = ceiling ? 8.7 : 4.0;
  const cfg: Record<string, { color: string; emissive: string; intensity: number }> = {
    ceiling_light: { color: "#fff5a0", emissive: "#ffee44", intensity: 1.8 },
    ceiling_fan:   { color: "#bae6fd", emissive: "#88c8f8", intensity: 0.5 },
    panel:         { color: "#94a3b8", emissive: "#000",    intensity: 0   },
    outlet:        { color: "#fbbf24", emissive: "#f59e0b", intensity: 0.4 },
    switch:        { color: "#f1f5f9", emissive: "#000",    intensity: 0   },
  };
  const c = cfg[el.type] ?? cfg.outlet;
  return (
    <mesh position={[el.x, y, el.z]}>
      {ceiling ? <cylinderGeometry args={[0.3, 0.3, 0.14, 14]} /> : <boxGeometry args={[0.22, 0.22, 0.12]} />}
      <meshStandardMaterial color={c.color} emissive={c.emissive} emissiveIntensity={c.intensity} roughness={0.35} />
    </mesh>
  );
}

function CeilingLight({ el }: { el: SceneElectrical }) {
  if (el.type !== "ceiling_light") return null;
  return <pointLight position={[el.x, 8.3, el.z]} intensity={1.2} color="#fff5c0" distance={14} decay={2} castShadow={false} />;
}

// ─── Plumbing ─────────────────────────────────────────────────────────────────

function PlumbingFixture({ pl }: { pl: ScenePlumbing }) {
  const style = useContext(StyleCtx);
  const size: [number, number, number] =
    pl.type === "toilet"       ? [1.8, 0.4, 2.5] :
    pl.type === "bathtub"      ? [3.0, 0.5, 6.0] :
    pl.type === "shower"       ? [3.0, 0.2, 3.0] :
    pl.type === "water_heater" ? [1.4, 4.5, 1.4] : [1.6, 0.35, 1.6];
  return (
    <mesh castShadow receiveShadow position={[pl.x, size[1] / 2, pl.z]} rotation={[0, pl.rotation * (Math.PI / 180), 0]}>
      <boxGeometry args={size} />
      <meshStandardMaterial color="#7ecaef" roughness={0.22} metalness={0.28} wireframe={style === "wireframe"} />
    </mesh>
  );
}

// ─── Furniture ────────────────────────────────────────────────────────────────

function Box3({ pos, size, color, roughness = 0.7, metalness = 0 }: {
  pos: [number, number, number]; size: [number, number, number];
  color: string; roughness?: number; metalness?: number;
}) {
  return (
    <mesh castShadow receiveShadow position={pos}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
    </mesh>
  );
}

function LivingRoomFurniture({ room }: { room: SceneRoom }) {
  const { x, z, width, depth } = room;
  const m = 1.0;
  const sofaW = Math.min(width - m * 2, 7);
  const sofaX = x + width / 2;
  const sofaZ = z + depth - m - 1.5;
  const tvW   = Math.min(width - m * 2, 5.5);
  return (
    <>
      <Box3 pos={[sofaX, 1.4, sofaZ]}         size={[sofaW, 2.8, 3.2]}     color="#7a6a5a" roughness={0.92} />
      <Box3 pos={[sofaX, 2.5, sofaZ + 1.1]}   size={[sofaW, 1.0, 0.8]}     color="#8a7a68" roughness={0.9} />
      <Box3 pos={[sofaX, 0.8, sofaZ - 3.0]}   size={[Math.min(sofaW - 1, 4), 1.6, 2.2]} color="#4a3010" roughness={0.38} metalness={0.04} />
      {[-1, 1].map(sx => [-1, 1].map(sz => (
        <Box3 key={`${sx}${sz}`} pos={[sofaX + sx * 1.5, 0.5, sofaZ - 3 + sz * 0.8]} size={[0.15, 1.0, 0.15]} color="#3a2008" roughness={0.4} />
      )))}
      <Box3 pos={[sofaX, 1.0, z + m + 0.3]}   size={[tvW, 2.0, 0.55]}      color="#1e1e1e" roughness={0.25} metalness={0.1} />
      <Box3 pos={[sofaX, 1.6, z + m + 0.04]}  size={[tvW - 0.4, 1.5, 0.05]} color="#0a0a12" roughness={0.05} metalness={0.2} />
      <Box3 pos={[x + m + 0.5, 4.2, sofaZ - 1]} size={[0.12, 8.4, 0.12]}   color="#888" roughness={0.2} metalness={0.6} />
      <Box3 pos={[x + m + 0.5, 8.5, sofaZ - 1]} size={[0.7, 0.5, 0.7]}     color="#fff8d0" roughness={0.3} />
    </>
  );
}

function KitchenFurniture({ room }: { room: SceneRoom }) {
  const { x, z, width, depth } = room;
  const m = 0.3, cH = 3.5, cD = 2.0;
  return (
    <>
      <Box3 pos={[x + width / 2, cH / 2, z + depth - m - cD / 2]} size={[width - m * 2, cH, cD]}         color="#d4c8b0" roughness={0.3} metalness={0.08} />
      <Box3 pos={[x + width / 2, cH + 0.1, z + depth - m - cD / 2]} size={[width - m * 2, 0.2, cD + 0.1]} color="#e8e0d0" roughness={0.15} metalness={0.05} />
      <Box3 pos={[x + m + cD / 2, cH / 2, z + depth / 2]}           size={[cD, cH, depth - 4]}            color="#d4c8b0" roughness={0.3} metalness={0.08} />
      <Box3 pos={[x + m + cD / 2, cH + 0.1, z + depth / 2]}          size={[cD + 0.1, 0.2, depth - 4]}    color="#e8e0d0" roughness={0.15} metalness={0.05} />
      {width > 10 && depth > 12 && (
        <>
          <Box3 pos={[x + width / 2, cH * 0.7, z + depth / 2]}       size={[4, cH * 0.7, 2.5]}            color="#c8bca8" roughness={0.35} metalness={0.06} />
          <Box3 pos={[x + width / 2, cH * 0.7 + 0.1, z + depth / 2]} size={[4.1, 0.2, 2.6]}               color="#e0d8c8" roughness={0.12} metalness={0.05} />
        </>
      )}
      <Box3 pos={[x + width - m - 1.0, 4.5, z + depth - m - 1.2]} size={[2.0, 9, 2.4]} color="#d8d8d8" roughness={0.15} metalness={0.3} />
    </>
  );
}

function BedroomFurniture({ room, isMaster }: { room: SceneRoom; isMaster: boolean }) {
  const { x, z, width, depth } = room;
  const m = 0.8, bedW = isMaster ? 6.0 : 4.5, bedL = isMaster ? 7.5 : 6.5;
  const bedX = x + width / 2, bedZ = z + depth - m - bedL / 2, nightW = 1.5;
  return (
    <>
      <Box3 pos={[bedX, 0.6, bedZ]}            size={[bedW + 0.3, 1.2, bedL + 0.3]}  color="#5a3820" roughness={0.55} metalness={0.02} />
      <Box3 pos={[bedX, 1.5, bedZ]}            size={[bedW, 0.8, bedL]}               color="#f0ece4" roughness={0.9} />
      {isMaster
        ? [[-1.1], [1.1]].map(([ox], i) => <Box3 key={i} pos={[bedX + ox, 2.05, bedZ + bedL / 2 - 1.5]} size={[1.8, 0.5, 1.2]} color="#f5f0e8" roughness={0.95} />)
        : [<Box3 key="p" pos={[bedX, 2.05, bedZ + bedL / 2 - 1.5]} size={[1.8, 0.5, 1.2]} color="#f5f0e8" roughness={0.95} />]
      }
      <Box3 pos={[bedX, 1.82, bedZ - bedL * 0.15]} size={[bedW, 0.18, bedL * 0.7]}   color="#e0d8d0" roughness={0.88} />
      <Box3 pos={[bedX - bedW / 2 - nightW / 2 - 0.1, 1.5, bedZ + 1.5]} size={[nightW, 3.0, nightW]} color="#6b4226" roughness={0.5} />
      {isMaster && <Box3 pos={[bedX + bedW / 2 + nightW / 2 + 0.1, 1.5, bedZ + 1.5]} size={[nightW, 3.0, nightW]} color="#6b4226" roughness={0.5} />}
      <Box3 pos={[x + m + 1.5, 2.5, z + m + 1.0]} size={[3.0, 5.0, 1.5]}            color="#6b4226" roughness={0.5} />
    </>
  );
}

function DiningFurniture({ room }: { room: SceneRoom }) {
  const { x, z, width, depth } = room;
  const tW = Math.min(width - 3, 6), tL = Math.min(depth - 3, 4.5);
  const tx = x + width / 2, tz = z + depth / 2, chairs = tW > 4 ? 3 : 2;
  return (
    <>
      <Box3 pos={[tx, 2.9, tz]} size={[tW, 0.22, tL]} color="#5a3010" roughness={0.4} metalness={0.03} />
      {[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz], i) => (
        <Box3 key={i} pos={[tx + sx * (tW / 2 - 0.4), 1.5, tz + sz * (tL / 2 - 0.4)]} size={[0.18, 3.0, 0.18]} color="#3a1e08" roughness={0.45} />
      ))}
      {[-1, 1].map(side => Array.from({ length: chairs }).map((_, i) => {
        const cx2 = tx + (tW / 2 + 1.1) * side;
        const cz2 = tz + (i - (chairs - 1) / 2) * 2;
        return (
          <React.Fragment key={`${side}_${i}`}>
            <Box3 pos={[cx2, 1.4, cz2]}      size={[1.8, 2.8, 1.8]}  color="#8a7060" roughness={0.88} />
            <Box3 pos={[cx2, 4.5, cz2 + side * 0.65]} size={[1.8, 3.0, 0.22]} color="#8a7060" roughness={0.88} />
          </React.Fragment>
        );
      }))}
    </>
  );
}

function OfficeFurniture({ room }: { room: SceneRoom }) {
  const { x, z } = room;
  const m = 0.5;
  return (
    <>
      <Box3 pos={[x + m + 2.5, 2.8, z + m + 1.0]}  size={[5, 0.22, 2.0]} color="#c8b898" roughness={0.35} metalness={0.04} />
      <Box3 pos={[x + m + 0.9, 2.8, z + m + 2.7]}  size={[1.8, 0.22, 3.4]} color="#c8b898" roughness={0.35} metalness={0.04} />
      <Box3 pos={[x + m + 2.5, 1.4, z + m + 1.0]}  size={[4.8, 2.8, 1.8]} color="#b8a888" roughness={0.5} />
      <Box3 pos={[x + m + 2.5, 4.5, z + m + 0.4]}  size={[2.4, 1.8, 0.12]} color="#111" roughness={0.08} metalness={0.3} />
      <Box3 pos={[x + m + 2.5, 3.3, z + m + 0.45]} size={[0.3, 0.9, 0.1]}  color="#222" roughness={0.2} metalness={0.3} />
      <Box3 pos={[x + m + 2.5, 1.8, z + m + 3.0]}  size={[2.2, 3.6, 2.2]} color="#3a3a3a" roughness={0.7} />
    </>
  );
}

function GarageFurniture({ room }: { room: SceneRoom }) {
  const { x, z, width, depth } = room;
  const carW = Math.min(width - 2, 7.5), carL = Math.min(depth - 3, 14);
  return (
    <>
      <Box3 pos={[x + width / 2, 1.8, z + depth / 2 + 1]}       size={[carW, 3.6, carL]}     color="#3a5a8a" roughness={0.25} metalness={0.35} />
      <Box3 pos={[x + width / 2, 3.9, z + depth / 2 + 0.5]}     size={[carW - 1.5, 2.0, carL * 0.55]} color="#3a5a8a" roughness={0.2} metalness={0.35} />
      <Box3 pos={[x + width / 2, 3.5, z + depth / 2 - carL * 0.19]} size={[carW - 1.5, 1.8, 0.1]} color="#a8cce8" roughness={0.04} metalness={0.2} />
      <Box3 pos={[x + 1.2, 3.0, z + 1.0]}                        size={[2.4, 6.0, 0.5]}      color="#8a6a40" roughness={0.6} />
    </>
  );
}

function RoomFurniture({ room }: { room: SceneRoom }) {
  const type = getRoomType(room.name);
  if (room.width < 6 || room.depth < 6) return null;
  if (type === "living")   return <LivingRoomFurniture room={room} />;
  if (type === "kitchen")  return <KitchenFurniture room={room} />;
  if (type === "master")   return <BedroomFurniture room={room} isMaster />;
  if (type === "bedroom")  return <BedroomFurniture room={room} isMaster={false} />;
  if (type === "dining")   return <DiningFurniture room={room} />;
  if (type === "office")   return <OfficeFurniture room={room} />;
  if (type === "garage" && room.width > 12 && room.depth > 16) return <GarageFurniture room={room} />;
  return null;
}

// ─── Labels & annotations ─────────────────────────────────────────────────────

function RoomLabel({ room, wallH, unit }: { room: SceneRoom; wallH: number; unit: UnitKey }) {
  const suffix   = UNIT_SUFFIXES[unit];
  const factor   = UNIT_FACTORS[unit];
  const sqftText = room.sqft
    ? `${Math.round(room.sqft).toLocaleString()} sqft`
    : `${(room.width * factor).toFixed(0)} × ${(room.depth * factor).toFixed(0)} ${suffix}`;
  return (
    <Html position={[room.x + room.width / 2, wallH + 0.9, room.z + room.depth / 2]} center style={{ pointerEvents: "none", userSelect: "none" }}>
      <div style={{
        background: "rgba(255,255,255,0.92)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
        border: "1px solid rgba(0,0,0,0.08)", borderRadius: 8, padding: "4px 10px 5px",
        fontSize: 11, fontWeight: 700, color: "#1e293b", textAlign: "center", whiteSpace: "nowrap",
        boxShadow: "0 2px 12px rgba(0,0,0,0.14)", fontFamily: "system-ui,-apple-system,sans-serif", lineHeight: 1.4,
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
      <Html position={[ann.x, wallH * 0.62, ann.z]} center style={{ pointerEvents: "none" }}>
        <div style={{ background: "rgba(124,58,237,0.9)", color: "#fff", borderRadius: 7, padding: "3px 9px", fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
          📌 {ann.text}
        </div>
      </Html>
    </>
  );
}

// ─── Fallback room boxes ───────────────────────────────────────────────────────

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
          <WallBox x1={room.x} z1={room.z} x2={room.x + room.w} z2={room.z}            yBot={0} yTop={wallH} thickness={0.42} color={layers.drywall ? "#f0ece4" : "#b07040"} />
          <WallBox x1={room.x} z1={room.z + room.h} x2={room.x + room.w} z2={room.z + room.h} yBot={0} yTop={wallH} thickness={0.42} color={layers.drywall ? "#f0ece4" : "#b07040"} />
          <WallBox x1={room.x} z1={room.z} x2={room.x} z2={room.z + room.h}            yBot={0} yTop={wallH} thickness={0.42} color={layers.drywall ? "#ece8e0" : "#8a5c2a"} />
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

// ─── Screenshot & GLB export triggers ────────────────────────────────────────

function ScreenshotTrigger({ triggerRef }: { triggerRef: React.MutableRefObject<(() => void) | null> }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    triggerRef.current = () => {
      gl.render(scene, camera);
      const url  = gl.domElement.toDataURL("image/png");
      const link = document.createElement("a");
      link.href     = url;
      link.download = "floor-plan-3d.png";
      link.click();
    };
  }, [gl, scene, camera, triggerRef]);
  return null;
}

function GLBExportTrigger({ triggerRef }: { triggerRef: React.MutableRefObject<(() => void) | null> }) {
  const { scene } = useThree();
  useEffect(() => {
    triggerRef.current = async () => {
      try {
        const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js" as any);
        const exporter = new GLTFExporter();
        exporter.parse(
          scene,
          (result: any) => {
            const blob = new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
            const url  = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href     = url;
            link.download = "floor-plan-3d.glb";
            link.click();
            URL.revokeObjectURL(url);
          },
          (err: any) => console.error("GLB export failed", err),
          { binary: true }
        );
      } catch (e) {
        console.error("GLB export error", e);
      }
    };
  }, [scene, triggerRef]);
  return null;
}

// ─── Camera controllers ───────────────────────────────────────────────────────

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

function WalkthroughCamera({ startX, startZ, onExit }: { startX: number; startZ: number; onExit: () => void }) {
  const { camera, gl } = useThree();
  const keys       = useRef<Set<string>>(new Set());
  const mouseDown  = useRef(false);
  const lastMouseX = useRef(0);
  const yaw        = useRef(0);

  useEffect(() => {
    camera.position.set(startX, EYE_HEIGHT, startZ);
    yaw.current = 0;
    const onKD = (e: KeyboardEvent) => { keys.current.add(e.key.toLowerCase()); if (e.key === "Escape") onExit(); };
    const onKU = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const onMD = (e: MouseEvent)    => { mouseDown.current = true; lastMouseX.current = e.clientX; };
    const onMU = ()                  => { mouseDown.current = false; };
    const onMM = (e: MouseEvent)    => { if (!mouseDown.current) return; yaw.current -= (e.clientX - lastMouseX.current) * 0.004; lastMouseX.current = e.clientX; };
    window.addEventListener("keydown", onKD); window.addEventListener("keyup", onKU);
    gl.domElement.addEventListener("mousedown", onMD);
    window.addEventListener("mouseup", onMU); window.addEventListener("mousemove", onMM);
    return () => {
      window.removeEventListener("keydown", onKD); window.removeEventListener("keyup", onKU);
      gl.domElement.removeEventListener("mousedown", onMD);
      window.removeEventListener("mouseup", onMU); window.removeEventListener("mousemove", onMM);
    };
  }, [startX, startZ, onExit, camera, gl.domElement]);

  useFrame((_, dt) => {
    const speed = 13 * dt;
    const fwd   = new THREE.Vector3(Math.sin(yaw.current), 0, Math.cos(yaw.current));
    const right  = new THREE.Vector3(fwd.z, 0, -fwd.x);
    if (keys.current.has("w") || keys.current.has("arrowup"))    camera.position.addScaledVector(fwd,   speed);
    if (keys.current.has("s") || keys.current.has("arrowdown"))  camera.position.addScaledVector(fwd,  -speed);
    if (keys.current.has("a") || keys.current.has("arrowleft"))  camera.position.addScaledVector(right, -speed);
    if (keys.current.has("d") || keys.current.has("arrowright")) camera.position.addScaledVector(right,  speed);
    camera.position.y = EYE_HEIGHT;
    camera.lookAt(camera.position.x + fwd.x * 10, EYE_HEIGHT, camera.position.z + fwd.z * 10);
  });
  return null;
}

// ─── Main 3D scene ────────────────────────────────────────────────────────────

interface Scene3DProps {
  sceneData: SceneData | null | undefined;
  layers: LayerState;
  unit: UnitKey;
  viewMode: ViewMode;
  onExitWalk: () => void;
  fallbackRooms: PlacedRoom[];
  annotations: Annotation[];
  overviewKey: number;
  screenshotRef: React.MutableRefObject<(() => void) | null>;
  glbRef: React.MutableRefObject<(() => void) | null>;
  selectedRoomName: string | null;
  onRoomSelect: (room: SceneRoom) => void;
  showDimensions: boolean;
  measureMode: boolean;
  measurePts: THREE.Vector3[];
  onMeasurePoint: (p: THREE.Vector3) => void;
}

function Scene3D({ sceneData, layers, unit, viewMode, onExitWalk, fallbackRooms, annotations, overviewKey, screenshotRef, glbRef, selectedRoomName, onRoomSelect, showDimensions, measureMode, measurePts, onMeasurePoint }: Scene3DProps) {
  const style = useContext(StyleCtx);
  const sd    = sceneData;
  const hasSD = !!(sd?.walls?.length);
  const bw    = hasSD ? sd!.building_width_ft  : Math.max(30, fallbackRooms.reduce((m, r) => Math.max(m, r.x + r.w), 0));
  const bd    = hasSD ? sd!.building_depth_ft  : Math.max(30, fallbackRooms.reduce((m, r) => Math.max(m, r.z + r.h), 0));
  const cx    = bw / 2, cz = bd / 2;
  const wallH = sd?.wall_height_ft || WALL_H_DEFAULT;
  const extColor = layers.drywall ? "#f0ece4" : "#b07040";
  const intColor = layers.drywall ? "#f5f2ee" : "#a06030";

  const isMinimal  = style === "minimal";
  const isWireframe = style === "wireframe";

  return (
    <>
      <color attach="background" args={[isMinimal || isWireframe ? "#f8fafc" : "#e4eaf5"]} />
      {!isMinimal && !isWireframe && <fog attach="fog" args={["#e4eaf5", 180, 600]} />}

      {/* ── Lighting ──────────────────────────────────────────────────────── */}
      {isMinimal || isWireframe ? (
        <ambientLight intensity={1.2} />
      ) : (
        <>
          <directionalLight castShadow position={[cx + 35, 52, cz + 28]} intensity={1.65} color="#fff6e0"
            shadow-mapSize-width={4096} shadow-mapSize-height={4096}
            shadow-camera-near={1} shadow-camera-far={450}
            shadow-camera-left={-110} shadow-camera-right={110}
            shadow-camera-top={110} shadow-camera-bottom={-110}
            shadow-bias={-0.0004} shadow-normalBias={0.02}
          />
          <directionalLight position={[cx - 30, 20, cz - 22]} intensity={0.38} color="#b8d0ff" />
          <hemisphereLight args={["#f0eeff", "#e8d4b0", 0.48]} />
          <Environment preset="apartment" background={false} />
        </>
      )}

      {/* ── Camera ────────────────────────────────────────────────────────── */}
      {viewMode === "iso" ? (
        <>
          <OverviewCameraSetup key={overviewKey} cx={cx} cz={cz} bw={bw} bd={bd} />
          <OrbitControls target={[cx, 0, cz]} enableDamping dampingFactor={0.07} makeDefault minPolarAngle={0.05} maxPolarAngle={Math.PI / 2.05} minDistance={5} maxDistance={600} />
        </>
      ) : (
        <WalkthroughCamera key="fp" startX={cx} startZ={cz} onExit={onExitWalk} />
      )}

      {/* ── Ground & grid ─────────────────────────────────────────────────── */}
      <mesh receiveShadow={!isMinimal} rotation={[-Math.PI / 2, 0, 0]} position={[cx, -0.22, cz]}>
        <planeGeometry args={[bw + 100, bd + 100]} />
        <meshStandardMaterial color={isMinimal || isWireframe ? "#e2e8f0" : "#a8a098"} roughness={0.93} wireframe={isWireframe} />
      </mesh>
      {layers.foundation && !isWireframe && (
        <Grid position={[cx, -0.19, cz]} args={[bw + 70, bd + 70]}
          cellSize={5} cellThickness={0.3} cellColor="#88867e"
          sectionSize={20} sectionThickness={0.7} sectionColor="#6a6860"
          fadeDistance={250} fadeStrength={1.6} infiniteGrid={false} />
      )}

      {/* ── Export triggers ───────────────────────────────────────────────── */}
      <ScreenshotTrigger triggerRef={screenshotRef} />
      <GLBExportTrigger  triggerRef={glbRef} />

      {/* ── Post-processing (photo only) ──────────────────────────────────── */}
      {style === "photo" && (
        <EffectComposer>
          <Bloom luminanceThreshold={0.75} luminanceSmoothing={0.5} intensity={0.45} blendFunction={BlendFunction.ADD} />
          <ChromaticAberration offset={new THREE.Vector2(0.0004, 0.0004)} blendFunction={BlendFunction.NORMAL} />
          <Vignette eskil={false} offset={0.38} darkness={0.48} blendFunction={BlendFunction.NORMAL} />
        </EffectComposer>
      )}

      {/* ── Measurement tool ──────────────────────────────────────────────── */}
      <MeasureFloor active={measureMode} points={measurePts} onPoint={onMeasurePoint} bw={bw} bd={bd} />

      {/* ── Building (Vision data) ────────────────────────────────────────── */}
      {hasSD ? (
        <>
          {layers.foundation && <Foundation rooms={sd!.rooms} />}
          {layers.drywall && sd!.rooms.map((r, i) => (
            <RoomFloor key={i} room={r} selected={selectedRoomName === r.name} onSelect={() => onRoomSelect(r)} />
          ))}
          {(layers.framing || layers.drywall) && sd!.walls.map((w, i) => (
            <WallWithDoors key={i} wall={w} wallHeight={wallH} doors={sd!.doors} color={w.type === "exterior" ? extColor : intColor} />
          ))}
          {layers.drywall && sd!.doors.map((d, i)   => <DoorVoid   key={i} door={d} walls={sd!.walls} wallHeight={wallH} />)}
          {layers.drywall && sd!.windows.map((w, i)  => <WindowPane key={i} win={w}  walls={sd!.walls} />)}
          {layers.drywall && sd!.windows.map((w, i)  => <WindowLightShaft key={i} win={w} walls={sd!.walls} cx={cx} cz={cz} />)}
          {layers.roof    && sd!.rooms.map((r, i)    => (
            <mesh key={i} position={[r.x + r.width / 2, wallH + 0.08, r.z + r.depth / 2]}>
              <boxGeometry args={[r.width + 0.12, 0.16, r.depth + 0.12]} />
              <meshStandardMaterial color="#e8e4dc" transparent opacity={0.15} roughness={0.9} />
            </mesh>
          ))}
          {layers.electrical && sd!.electrical.map((el, i) => (
            <React.Fragment key={i}><ElectricalMarker el={el} />{style === "photo" && <CeilingLight el={el} />}</React.Fragment>
          ))}
          {layers.plumbing   && sd!.plumbing.map((pl, i)   => <PlumbingFixture key={i} pl={pl} />)}
          {/* Furniture — photo/minimal only, not wireframe, not in tiny rooms */}
          {!isWireframe && layers.drywall && sd!.rooms.map((r, i) => <RoomFurniture key={i} room={r} />)}
          {viewMode === "iso" && sd!.rooms.map((r, i) => <RoomLabel key={i} room={r} wallH={wallH} unit={unit} />)}
          {showDimensions && <DimensionOverlays walls={sd!.walls} rooms={sd!.rooms} wallH={wallH} unit={unit} />}
          {!isMinimal && !isWireframe && (
            <ContactShadows position={[cx, 0.02, cz]} width={bw + 22} height={bd + 22} far={4.5} blur={2.8} opacity={0.4} />
          )}
        </>
      ) : (
        <>
          {fallbackRooms.map((r, i) => <FallbackRoom key={i} room={r} layers={layers} wallH={WALL_H_DEFAULT} />)}
          {viewMode === "iso" && fallbackRooms.map((r, i) => (
            <Html key={i} position={[r.x + r.w / 2, WALL_H_DEFAULT + 0.9, r.z + r.h / 2]} center style={{ pointerEvents: "none" }}>
              <div style={{ background: "rgba(255,255,255,0.92)", backdropFilter: "blur(8px)", borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#1e293b", whiteSpace: "nowrap", boxShadow: "0 2px 12px rgba(0,0,0,0.14)" }}>
                {r.name}<div style={{ fontSize: 9, fontWeight: 400, color: "#64748b" }}>{Math.round(r.sqft).toLocaleString()} sqft</div>
              </div>
            </Html>
          ))}
          <ContactShadows position={[cx, 0.02, cz]} width={bw + 15} height={bd + 15} far={4} blur={2.5} opacity={0.3} />
        </>
      )}

      {annotations.map(ann => <AnnotationPin key={ann.id} ann={ann} wallH={wallH} />)}

      {/* ── Walkthrough HUD ───────────────────────────────────────────────── */}
      {viewMode === "fp" && (
        <Html fullscreen style={{ pointerEvents: "none" }}>
          <>
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 24, height: 24 }}>
              <div style={{ position: "absolute", top: "50%", left: 0, width: "100%", height: 1.5, background: "rgba(255,255,255,0.85)", borderRadius: 2, transform: "translateY(-50%)" }} />
              <div style={{ position: "absolute", left: "50%", top: 0, height: "100%", width: 1.5, background: "rgba(255,255,255,0.85)", borderRadius: 2, transform: "translateX(-50%)" }} />
            </div>
            <div style={{ position: "absolute", bottom: 52, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.52)", color: "#fff", borderRadius: 10, padding: "6px 20px", fontSize: 12, fontWeight: 500, backdropFilter: "blur(10px)", whiteSpace: "nowrap" }}>
              W / A / S / D · Drag to look · Esc to exit
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
      { name: "Living Room", sqft: total * 0.30 }, { name: "Kitchen",  sqft: total * 0.18 },
      { name: "Master Bedroom", sqft: total * 0.20 }, { name: "Bedroom 2", sqft: total * 0.14 },
      { name: "Bathroom", sqft: total * 0.10 }, { name: "Garage", sqft: total * 0.08 },
    ].map(r => { const w = Math.sqrt(r.sqft * 1.3); return { ...r, w, h: r.sqft / w }; });
  }
  rawRooms.sort((a, b) => b.sqft - a.sqft);
  const maxRowW = Math.sqrt(rawRooms.reduce((s, r) => s + r.sqft, 0)) * 1.5;
  const placed: PlacedRoom[] = [];
  let curX = 0, curZ = 0, rowH = 0, ci = 0;
  for (const r of rawRooms) {
    if (curX > 0 && curX + r.w > maxRowW) { curX = 0; curZ += rowH + 2; rowH = 0; }
    placed.push({ name: r.name, sqft: r.sqft, w: r.w, h: r.h, x: curX, z: curZ, colorIdx: ci++ });
    curX += r.w + 2; rowH = Math.max(rowH, r.h);
  }
  return placed;
}

// ─── Main exported component ───────────────────────────────────────────────────

export default function Blueprint3DViewer({
  analysis,
  sceneData,
  blueprintUrl,
}: {
  analysis: any;
  sceneData?: SceneData | null;
  blueprintUrl?: string;
}) {
  const [viewMode,        setViewMode]        = useState<ViewMode>("iso");
  const [styleMode,       setStyleMode]       = useState<StyleMode>("photo");
  const [layers,          setLayers]          = useState<LayerState>({ foundation: true, framing: true, electrical: false, plumbing: false, drywall: true, roof: true });
  const [unit,            setUnit]            = useState<UnitKey>("ft");
  const [showLayersPanel, setShowLayersPanel] = useState(false);
  const [annotations,     setAnnotations]     = useState<Annotation[]>([]);
  const [overviewKey,     setOverviewKey]     = useState(0);
  const [selectedRoom,    setSelectedRoom]    = useState<SceneRoom | null>(null);
  const [showDimensions,  setShowDimensions]  = useState(false);
  const [measureMode,     setMeasureMode]     = useState(false);
  const [measurePts,      setMeasurePts]      = useState<THREE.Vector3[]>([]);
  const [showSplit,       setShowSplit]        = useState(false);

  const screenshotRef = useRef<(() => void) | null>(null);
  const glbRef        = useRef<(() => void) | null>(null);
  const nextId        = useRef(1);

  const fallbackRooms = useRef<PlacedRoom[]>(buildRooms(analysis));
  useEffect(() => { fallbackRooms.current = buildRooms(analysis); }, [analysis]);

  const sd    = sceneData;
  const hasSD = !!(sd?.walls?.length);

  function toggleLayer(key: keyof LayerState) { setLayers(p => ({ ...p, [key]: !p[key] })); }
  function exitWalkthrough() { setViewMode("iso"); setOverviewKey(k => k + 1); }
  const handleScreenshot = useCallback(() => screenshotRef.current?.(), []);
  const handleGLBExport  = useCallback(() => glbRef.current?.(), []);

  function handleRoomSelect(room: SceneRoom) {
    setSelectedRoom(prev => prev?.name === room.name ? null : room);
  }

  function handleMeasurePoint(p: THREE.Vector3) {
    setMeasurePts(prev => {
      if (prev.length === 0) return [p];
      if (prev.length === 1) return [prev[0], p];
      return [p]; // reset on 3rd click
    });
  }

  function toggleMeasure() {
    setMeasureMode(m => !m);
    setMeasurePts([]);
  }

  const canvas = (
    <Canvas
      shadows
      camera={{ position: [40, 32, 40], fov: 42, near: 0.1, far: 1500 }}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true }}
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
          screenshotRef={screenshotRef}
          glbRef={glbRef}
          selectedRoomName={selectedRoom?.name ?? null}
          onRoomSelect={handleRoomSelect}
          showDimensions={showDimensions}
          measureMode={measureMode}
          measurePts={measurePts}
          onMeasurePoint={handleMeasurePoint}
        />
      </Suspense>
    </Canvas>
  );

  return (
    <StyleCtx.Provider value={styleMode}>
      <div className="flex flex-col gap-3 select-none">

        {/* ── Toolbar ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap px-1">

          {/* View mode */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 shadow-sm">
            <button className={`px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode === "iso" ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`} onClick={exitWalkthrough}>
              ⬡ Overview
            </button>
            <button className={`px-3 py-1.5 text-xs font-semibold border-l border-gray-200 transition-colors ${viewMode === "fp" ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`} onClick={() => setViewMode("fp")}>
              🚶 Walk Through
            </button>
          </div>

          <div className="w-px h-5 bg-gray-200" />

          {/* Style mode */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 shadow-sm">
            {(["photo", "minimal", "wireframe"] as StyleMode[]).map((s, i) => (
              <button
                key={s}
                className={`px-2.5 py-1.5 text-xs font-semibold transition-colors ${i > 0 ? "border-l border-gray-200" : ""} ${styleMode === s ? "bg-slate-700 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                onClick={() => setStyleMode(s)}
              >
                {s === "photo" ? "🖼 Photo" : s === "minimal" ? "◻ Minimal" : "⬡ Wire"}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-gray-200" />

          {/* Layers */}
          <div className="relative">
            <button className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showLayersPanel ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`} onClick={() => setShowLayersPanel(p => !p)}>
              🏗 Layers
            </button>
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

          {/* Dimensions toggle */}
          <button
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showDimensions ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`}
            onClick={() => setShowDimensions(d => !d)}
            title="Toggle dimension labels"
          >
            📏 Dims
          </button>

          {/* Measure tool */}
          <button
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${measureMode ? "bg-amber-500 text-white border-amber-500" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`}
            onClick={toggleMeasure}
            title="Click two floor points to measure distance"
          >
            📐 Measure
          </button>

          {/* Split view — only when blueprint URL available */}
          {blueprintUrl && (
            <button
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showSplit ? "bg-teal-600 text-white border-teal-600" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`}
              onClick={() => setShowSplit(s => !s)}
              title="Side-by-side 2D blueprint and 3D view"
            >
              ⬛ Split
            </button>
          )}

          <div className="flex-1" />

          {/* Screenshot */}
          <button className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors" onClick={handleScreenshot} title="Download PNG">
            📸 PNG
          </button>

          {/* GLB Export */}
          <button className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors" onClick={handleGLBExport} title="Export 3D model as GLB">
            📦 GLB
          </button>

          {/* Unit selector */}
          <select className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 font-medium" value={unit} onChange={e => setUnit(e.target.value as UnitKey)}>
            {(Object.keys(UNIT_LABELS) as UnitKey[]).map(k => <option key={k} value={k}>{UNIT_LABELS[k]}</option>)}
          </select>

          {viewMode === "fp" && (
            <button className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors" onClick={exitWalkthrough}>
              ✕ Exit Walk
            </button>
          )}
        </div>

        {/* ── Measure hint ──────────────────────────────────────────────────── */}
        {measureMode && (
          <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs font-medium flex items-center gap-2">
            <span className="text-base">📐</span>
            {measurePts.length === 0 && "Click a point on the floor to start measuring"}
            {measurePts.length === 1 && "Click a second point to complete the measurement"}
            {measurePts.length === 2 && `Distance: ${measurePts[0].distanceTo(measurePts[1]).toFixed(2)} ft — click again to reset`}
            <button className="ml-auto text-amber-600 hover:text-amber-800 font-semibold" onClick={toggleMeasure}>Done</button>
          </div>
        )}

        {/* ── Canvas (normal or split) ──────────────────────────────────────── */}
        {showSplit && blueprintUrl ? (
          <div className="flex gap-3" style={{ height: 560 }}>
            {/* Blueprint image */}
            <div className="flex-1 rounded-2xl overflow-hidden border border-gray-200 shadow-xl bg-white flex items-center justify-center">
              <img
                src={blueprintUrl}
                alt="Blueprint"
                className="w-full h-full object-contain"
                style={{ maxHeight: 560 }}
              />
            </div>
            {/* 3D viewer */}
            <div className="flex-1 rounded-2xl overflow-hidden border border-gray-200 shadow-xl">
              {canvas}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl overflow-hidden border border-gray-200 shadow-xl" style={{ height: 560 }}>
            {canvas}
          </div>
        )}

        {/* ── Selected room info panel ──────────────────────────────────────── */}
        {selectedRoom && (
          <div className="bg-white rounded-2xl border border-indigo-100 shadow-sm px-5 py-4 flex items-start gap-4" style={{ boxShadow: "0 2px 16px rgba(99,102,241,0.10)" }}>
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-xl flex-shrink-0">🏠</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-800 text-sm">{selectedRoom.name}</h3>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                  {selectedRoom.floor_type || "—"}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-4 text-xs text-slate-500">
                {selectedRoom.sqft > 0 && <span><span className="font-semibold text-slate-700">{Math.round(selectedRoom.sqft).toLocaleString()}</span> sqft</span>}
                <span><span className="font-semibold text-slate-700">{selectedRoom.width?.toFixed(1)}</span>′ wide</span>
                <span><span className="font-semibold text-slate-700">{selectedRoom.depth?.toFixed(1)}</span>′ deep</span>
                <span>at <span className="font-semibold text-slate-700">({selectedRoom.x.toFixed(0)}, {selectedRoom.z.toFixed(0)})</span></span>
              </div>
            </div>
            <button className="text-slate-400 hover:text-slate-600 text-lg leading-none" onClick={() => setSelectedRoom(null)}>×</button>
          </div>
        )}

        {/* ── Stats panel ───────────────────────────────────────────────────── */}
        {hasSD && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: "Total Area",    value: `${(sd!.total_sqft || 0).toLocaleString()} sqft` },
              { label: "Rooms",         value: sd!.rooms.length },
              { label: "Wall Height",   value: `${sd!.wall_height_ft ?? WALL_H_DEFAULT} ft` },
              { label: "Parse Quality", value: `${Math.round((sd!.confidence || 0) * 100)}%` },
            ].map(s => (
              <div key={s.label} className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
                <p className="text-xs text-gray-400 font-medium">{s.label}</p>
                <p className="text-sm font-bold text-gray-800 mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Annotations list ──────────────────────────────────────────────── */}
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
    </StyleCtx.Provider>
  );
}
