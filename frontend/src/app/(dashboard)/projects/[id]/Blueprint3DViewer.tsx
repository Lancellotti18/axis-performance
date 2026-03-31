"use client";

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Vec3 = { x: number; y: number; z: number };

type ViewMode = "iso" | "fp";
type ToolMode = "none" | "measure" | "annotate";
type UnitKey = "ft" | "in" | "m" | "cm";

interface PlacedRoom {
  name: string;
  sqft: number;
  w: number; // feet
  h: number; // feet
  x: number; // world left (feet)
  z: number; // world top (feet)
  colorIdx: number;
}

interface Annotation {
  id: number;
  wx: number;
  wz: number;
  text: string;
}

interface MeasurePt {
  wx: number;
  wz: number;
  sx: number;
  sy: number;
}

interface LayerState {
  foundation: boolean;
  framing: boolean;
  electrical: boolean;
  plumbing: boolean;
  drywall: boolean;
  roof: boolean;
}

interface SceneRoom { name: string; x: number; z: number; width: number; depth: number; floor_type: string; sqft: number }
interface SceneWall { x1: number; z1: number; x2: number; z2: number; thickness: number; type: 'exterior' | 'interior' }
interface SceneDoor { x: number; z: number; width: number; height: number }
interface SceneWindow { x: number; z: number; width: number; height: number; sill_height: number }
interface SceneElectrical { type: string; x: number; z: number }
interface ScenePlumbing { type: string; x: number; z: number; rotation: number }
interface SceneData {
  building_width_ft: number; building_depth_ft: number; total_sqft: number; wall_height_ft: number; stories: number
  rooms: SceneRoom[]; walls: SceneWall[]; doors: SceneDoor[]; windows: SceneWindow[]
  electrical: SceneElectrical[]; plumbing: ScenePlumbing[]
  confidence: number; scale_detected: string
}

interface ProjectedPoint {
  sx: number;
  sy: number;
  depth: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANVAS_W = 860;
const CANVAS_H = 520;
const WALL_HEIGHT = 9; // feet
const EYE_HEIGHT = 5.5; // feet

const UNIT_LABELS: Record<UnitKey, string> = {
  ft: "Feet",
  in: "Inches",
  m: "Meters",
  cm: "Centimeters",
};

const UNIT_FACTORS: Record<UnitKey, number> = {
  ft: 1,
  in: 12,
  m: 0.3048,
  cm: 30.48,
};

const UNIT_SUFFIXES: Record<UnitKey, string> = {
  ft: "ft",
  in: "in",
  m: "m",
  cm: "cm",
};

// ISO_COLORS: triads [light, medium, dark] for floor, side-wall-1, side-wall-2
const ISO_COLORS: [string, string, string][] = [
  ["#bfdbfe", "#3b82f6", "#1d4ed8"], // blue
  ["#bbf7d0", "#22c55e", "#15803d"], // green
  ["#fef08a", "#eab308", "#a16207"], // yellow
  ["#fecdd3", "#f43f5e", "#be123c"], // rose
  ["#e9d5ff", "#a855f7", "#7e22ce"], // purple
  ["#a5f3fc", "#06b6d4", "#0e7490"], // cyan
  ["#fed7aa", "#f97316", "#c2410c"], // orange
  ["#6ee7b7", "#10b981", "#065f46"], // emerald
];

const LAYER_META: { key: keyof LayerState; label: string; color: string }[] = [
  { key: "foundation", label: "Foundation", color: "#9ca3af" },
  { key: "framing", label: "Framing", color: "#92400e" },
  { key: "electrical", label: "Electrical", color: "#fbbf24" },
  { key: "plumbing", label: "Plumbing", color: "#3b82f6" },
  { key: "drywall", label: "Drywall", color: "#e5e7eb" },
  { key: "roof", label: "Roof", color: "#6b7280" },
];

// ---------------------------------------------------------------------------
// Scene-data rendering helpers
// ---------------------------------------------------------------------------

function projectOntoWall(px: number, pz: number, wall: SceneWall): number {
  const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.01) return 0
  return ((px - wall.x1) * dx + (pz - wall.z1) * dz) / len
}

function isOnWall(px: number, pz: number, wall: SceneWall, tol = 2.5): boolean {
  const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.01) return false
  const t = ((px - wall.x1) * dx + (pz - wall.z1) * dz) / (len * len)
  if (t < -0.05 || t > 1.05) return false
  const projX = wall.x1 + t * dx, projZ = wall.z1 + t * dz
  return Math.sqrt((px - projX) ** 2 + (pz - projZ) ** 2) < tol
}

function drawWallBox3D(
  ctx: CanvasRenderingContext2D,
  x1: number, z1: number, x2: number, z2: number,
  yBot: number, yTop: number, thickness: number,
  fillColor: string, darkColor: string,
  isoP: (x: number, y: number, z: number) => { sx: number; sy: number }
) {
  const len = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2)
  if (len < 0.05) return
  const nx = -(z2 - z1) / len * thickness / 2
  const nz = (x2 - x1) / len * thickness / 2

  const bf0 = isoP(x1 + nx, yBot, z1 + nz), bf1 = isoP(x2 + nx, yBot, z2 + nz)
  const tf0 = isoP(x1 + nx, yTop, z1 + nz), tf1 = isoP(x2 + nx, yTop, z2 + nz)
  const bb0 = isoP(x1 - nx, yBot, z1 - nz), bb1 = isoP(x2 - nx, yBot, z2 - nz)
  const tb0 = isoP(x1 - nx, yTop, z1 - nz), tb1 = isoP(x2 - nx, yTop, z2 - nz)

  // Top face
  fillPoly(ctx, [tf0, tf1, tb1, tb0], '#f0ece4', 0.95)
  strokePoly(ctx, [tf0, tf1, tb1, tb0], '#00000015', 0.5)
  // Front face
  fillPoly(ctx, [bf0, bf1, tf1, tf0], fillColor)
  strokePoly(ctx, [bf0, bf1, tf1, tf0], '#00000025', 0.8)
  // Back face
  fillPoly(ctx, [bb0, bb1, tb1, tb0], darkColor, 0.75)
  // End caps
  fillPoly(ctx, [bf0, bb0, tb0, tf0], darkColor, 0.9)
  fillPoly(ctx, [bf1, bb1, tb1, tf1], darkColor, 0.9)
}

function drawSceneDataIso(
  ctx: CanvasRenderingContext2D,
  sd: SceneData,
  scale: number,
  angle: number,
  cx: number,
  cy: number,
  lyr: LayerState,
  factor: number,
  suffix: string
) {
  const wallH = sd.wall_height_ft || 9

  function isoP(wx: number, wy: number, wz: number) {
    const cosR = Math.cos(angle), sinR = Math.sin(angle)
    const ix = wx * cosR - wz * sinR
    const iz = wx * sinR + wz * cosR
    return { sx: cx + ix * scale, sy: cy + iz * scale * 0.45 - wy * scale * 0.6 }
  }

  const floorColors: Record<string, string> = {
    hardwood: '#d4a96a', tile: '#dde8e8', carpet: '#b8aec8',
    concrete: '#c0c0b8', vinyl: '#d8d0c0', wood: '#d4a96a',
  }

  // 1. Foundation slab
  if (lyr.foundation && sd.rooms.length > 0) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const r of sd.rooms) {
      minX = Math.min(minX, r.x); minZ = Math.min(minZ, r.z)
      maxX = Math.max(maxX, r.x + r.width); maxZ = Math.max(maxZ, r.z + r.depth)
    }
    const pad = 0.3
    const s00 = isoP(minX-pad, -0.3, minZ-pad), s10 = isoP(maxX+pad, -0.3, minZ-pad)
    const s11 = isoP(maxX+pad, -0.3, maxZ+pad), s01 = isoP(minX-pad, -0.3, maxZ+pad)
    fillPoly(ctx, [s00, s10, s11, s01], '#9ca3af', 0.7)
    strokePoly(ctx, [s00, s10, s11, s01], '#6b7280', 1)
  }

  // 2. Sort rooms back to front for painter's algorithm
  const sortedRooms = [...sd.rooms].sort((a, b) => {
    const da = isoP(a.x + a.width/2, 0, a.z + a.depth/2).sy
    const db = isoP(b.x + b.width/2, 0, b.z + b.depth/2).sy
    return da - db
  })

  // 3. Draw floors
  for (const r of sortedRooms) {
    const c00 = isoP(r.x, 0, r.z), c10 = isoP(r.x + r.width, 0, r.z)
    const c11 = isoP(r.x + r.width, 0, r.z + r.depth), c01 = isoP(r.x, 0, r.z + r.depth)
    const fc = floorColors[r.floor_type] || '#c8b99a'
    fillPoly(ctx, [c00, c10, c11, c01], lyr.drywall ? fc : '#d6b896')
    strokePoly(ctx, [c00, c10, c11, c01], '#00000018', 0.5)
  }

  // 4. Draw walls (sorted back to front)
  const sortedWalls = [...sd.walls].sort((a, b) => {
    const da = isoP((a.x1+a.x2)/2, 0, (a.z1+a.z2)/2).sy
    const db = isoP((b.x1+b.x2)/2, 0, (b.z1+b.z2)/2).sy
    return da - db
  })

  for (const wall of sortedWalls) {
    const wallLen = Math.sqrt((wall.x2-wall.x1)**2 + (wall.z2-wall.z1)**2)
    if (wallLen < 0.1) continue
    const dirX = (wall.x2-wall.x1)/wallLen, dirZ = (wall.z2-wall.z1)/wallLen
    const t = wall.thickness || (wall.type === 'exterior' ? 0.5 : 0.33)
    const isExt = wall.type === 'exterior'
    const fillColor = lyr.drywall ? (isExt ? '#e0d8c8' : '#ece8e0') : '#c8a070'
    const darkColor = lyr.drywall ? (isExt ? '#cec6b4' : '#dcd8d0') : '#a87848'

    // Find doors on this wall, build segments with gaps
    const wallDoors = sd.doors.filter(d => isOnWall(d.x, d.z, wall))
    const openings = wallDoors.map(d => {
      const pos = projectOntoWall(d.x, d.z, wall)
      const hw = (d.width || 3) / 2
      return { start: pos - hw, end: pos + hw, type: 'door' as const, height: d.height || 7 }
    }).sort((a, b) => a.start - b.start)

    const segments: { x1: number; z1: number; x2: number; z2: number; yBot: number; yTop: number }[] = []
    let cursor = 0
    for (const op of openings) {
      if (op.start > cursor + 0.1) {
        const s = cursor, e = op.start
        segments.push({ x1: wall.x1+dirX*s, z1: wall.z1+dirZ*s, x2: wall.x1+dirX*e, z2: wall.z1+dirZ*e, yBot: 0, yTop: wallH })
      }
      // Header above door
      if (op.height < wallH - 0.1) {
        const s = op.start, e = op.end
        segments.push({ x1: wall.x1+dirX*s, z1: wall.z1+dirZ*s, x2: wall.x1+dirX*e, z2: wall.z1+dirZ*e, yBot: op.height, yTop: wallH })
      }
      cursor = op.end
    }
    if (cursor < wallLen - 0.1) {
      segments.push({ x1: wall.x1+dirX*cursor, z1: wall.z1+dirZ*cursor, x2: wall.x2, z2: wall.z2, yBot: 0, yTop: wallH })
    }

    for (const seg of segments) {
      drawWallBox3D(ctx, seg.x1, seg.z1, seg.x2, seg.z2, seg.yBot, seg.yTop, t, fillColor, darkColor, isoP)
    }
  }

  // 5. Windows - glass panels
  for (const win of sd.windows) {
    const closestWall = sd.walls.reduce<SceneWall | null>((best, w) => {
      if (!isOnWall(win.x, win.z, w, 3)) return best
      const d = Math.abs(projectOntoWall(win.x, win.z, w))
      if (!best) return w
      return d < Math.abs(projectOntoWall(win.x, win.z, best)) ? w : best
    }, null)
    if (!closestWall) continue

    const t = closestWall.thickness || 0.5
    const wallLen = Math.sqrt((closestWall.x2-closestWall.x1)**2 + (closestWall.z2-closestWall.z1)**2)
    if (wallLen < 0.1) continue
    const dx = (closestWall.x2-closestWall.x1)/wallLen, dz = (closestWall.z2-closestWall.z1)/wallLen
    const nx = -dz * t/2, nz = dx * t/2
    const pos = projectOntoWall(win.x, win.z, closestWall)
    const hw = (win.width || 3) / 2
    const sill = win.sill_height || 2.5
    const winTop = sill + (win.height || 3.5)
    const x1 = closestWall.x1 + dx * (pos - hw), z1 = closestWall.z1 + dz * (pos - hw)
    const x2 = closestWall.x1 + dx * (pos + hw), z2 = closestWall.z1 + dz * (pos + hw)

    // Glass panel
    const gbl = isoP(x1+nx, sill, z1+nz), gbr = isoP(x2+nx, sill, z2+nz)
    const gtl = isoP(x1+nx, winTop, z1+nz), gtr = isoP(x2+nx, winTop, z2+nz)
    fillPoly(ctx, [gbl, gbr, gtr, gtl], '#93c5fd', 0.45)
    strokePoly(ctx, [gbl, gbr, gtr, gtl], '#3b82f6', 1.2)
  }

  // 6. Roof overlay
  if (lyr.roof && sd.rooms.length > 0) {
    for (const r of sd.rooms) {
      const c010 = isoP(r.x, wallH, r.z), c110 = isoP(r.x+r.width, wallH, r.z)
      const c111 = isoP(r.x+r.width, wallH, r.z+r.depth), c011 = isoP(r.x, wallH, r.z+r.depth)
      fillPoly(ctx, [c010, c110, c111, c011], '#ffffff', 0.25)
      strokePoly(ctx, [c010, c110, c111, c011], '#00000018', 0.5)
    }
  }

  // 7. Electrical markers
  if (lyr.electrical) {
    for (const el of sd.electrical) {
      const t = el.type
      if (t === 'ceiling_light' || t === 'ceiling_fan') {
        const p = isoP(el.x, wallH - 0.2, el.z)
        ctx.save()
        ctx.fillStyle = t === 'ceiling_light' ? '#fef08a' : '#bae6fd'
        ctx.strokeStyle = t === 'ceiling_light' ? '#d97706' : '#0284c7'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(p.sx, p.sy, 6, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()
        if (t === 'ceiling_fan') {
          for (let i = 0; i < 4; i++) {
            const a = i * Math.PI / 2
            ctx.beginPath()
            ctx.moveTo(p.sx + Math.cos(a)*6, p.sy + Math.sin(a)*6)
            ctx.lineTo(p.sx + Math.cos(a)*12, p.sy + Math.sin(a)*12)
            ctx.strokeStyle = '#0284c7'
            ctx.lineWidth = 2
            ctx.stroke()
          }
        } else {
          // Light rays
          for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4
            ctx.beginPath()
            ctx.moveTo(p.sx + Math.cos(a)*7, p.sy + Math.sin(a)*7)
            ctx.lineTo(p.sx + Math.cos(a)*11, p.sy + Math.sin(a)*11)
            ctx.strokeStyle = '#fbbf24'
            ctx.lineWidth = 1
            ctx.stroke()
          }
        }
        ctx.restore()
      } else {
        const p = isoP(el.x, t === 'panel' ? 5 : 4, el.z)
        ctx.save()
        if (t === 'outlet') {
          ctx.fillStyle = '#fbbf24'; ctx.strokeStyle = '#d97706'
          ctx.fillRect(p.sx - 4, p.sy - 4, 8, 8)
          ctx.strokeRect(p.sx - 4, p.sy - 4, 8, 8)
        } else if (t === 'switch') {
          ctx.fillStyle = '#f8fafc'; ctx.strokeStyle = '#64748b'
          ctx.lineWidth = 1
          ctx.fillRect(p.sx - 3, p.sy - 5, 6, 10)
          ctx.strokeRect(p.sx - 3, p.sy - 5, 6, 10)
        } else if (t === 'panel') {
          ctx.fillStyle = '#94a3b8'; ctx.strokeStyle = '#475569'
          ctx.lineWidth = 1.5
          ctx.fillRect(p.sx - 7, p.sy - 10, 14, 20)
          ctx.strokeRect(p.sx - 7, p.sy - 10, 14, 20)
          ctx.fillStyle = '#334155'
          ctx.font = 'bold 7px sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('⚡', p.sx, p.sy + 3)
        }
        ctx.restore()
      }
    }
  }

  // 8. Plumbing markers
  if (lyr.plumbing) {
    for (const pl of sd.plumbing) {
      const p = isoP(pl.x, 0.1, pl.z)
      ctx.save()
      ctx.fillStyle = '#93c5fd'
      ctx.strokeStyle = '#1d4ed8'
      ctx.lineWidth = 1.5
      const t = pl.type
      if (t === 'toilet') {
        ctx.beginPath()
        ctx.ellipse(p.sx, p.sy, 7, 10, 0, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()
        ctx.fillStyle = '#bfdbfe'
        ctx.beginPath()
        ctx.ellipse(p.sx, p.sy - 3, 5, 6, 0, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()
      } else if (t === 'bathtub') {
        ctx.fillRect(p.sx - 14, p.sy - 7, 28, 14)
        ctx.strokeRect(p.sx - 14, p.sy - 7, 28, 14)
        ctx.fillStyle = '#bfdbfe'
        ctx.fillRect(p.sx - 12, p.sy - 5, 24, 10)
      } else if (t === 'shower') {
        ctx.fillRect(p.sx - 9, p.sy - 9, 18, 18)
        ctx.strokeRect(p.sx - 9, p.sy - 9, 18, 18)
        ctx.strokeStyle = '#93c5fd'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(p.sx - 6, p.sy - 6); ctx.lineTo(p.sx + 6, p.sy + 6)
        ctx.moveTo(p.sx + 6, p.sy - 6); ctx.lineTo(p.sx - 6, p.sy + 6)
        ctx.stroke()
      } else if (t === 'water_heater') {
        ctx.fillStyle = '#bae6fd'; ctx.strokeStyle = '#0369a1'
        ctx.beginPath()
        ctx.arc(p.sx, p.sy, 8, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()
        ctx.fillStyle = '#0369a1'
        ctx.font = '8px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('WH', p.sx, p.sy + 3)
      } else {
        // sink, kitchen_sink, washer
        ctx.fillRect(p.sx - 7, p.sy - 7, 14, 14)
        ctx.strokeRect(p.sx - 7, p.sy - 7, 14, 14)
        ctx.fillStyle = '#bfdbfe'
        ctx.beginPath()
        ctx.arc(p.sx, p.sy, 4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
  }

  // 9. Room labels
  ctx.save()
  for (const r of sortedRooms) {
    const mid = isoP(r.x + r.width / 2, wallH + 0.6, r.z + r.depth / 2)
    const sqftLabel = r.sqft ? `${Math.round(r.sqft)} sqft` : `${(r.width * factor).toFixed(0)}×${(r.depth * factor).toFixed(0)}${suffix}`
    ctx.font = 'bold 11px sans-serif'
    ctx.fillStyle = '#1e293b'
    ctx.textAlign = 'center'
    ctx.fillText(r.name, mid.sx, mid.sy)
    ctx.font = '9px sans-serif'
    ctx.fillStyle = '#475569'
    ctx.fillText(sqftLabel, mid.sx, mid.sy + 13)
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Room layout algorithm
// ---------------------------------------------------------------------------

function buildRooms(analysis: any): PlacedRoom[] {
  let rawRooms: { name: string; sqft: number; w: number; h: number }[] = [];

  if (analysis?.rooms && Array.isArray(analysis.rooms) && analysis.rooms.length > 0) {
    rawRooms = analysis.rooms.map((r: any) => {
      const sqft = r.sqft || r.area || 100;
      const w =
        r.dimensions?.width ||
        r.width ||
        Math.sqrt(sqft * 1.3);
      const h =
        r.dimensions?.height ||
        r.height ||
        sqft / w;
      return { name: r.name || "Room", sqft, w, h };
    });
  } else {
    const total = analysis?.total_sqft || 1200;
    // synthesise a few rooms
    const rooms = [
      { name: "Living Room", sqft: total * 0.3 },
      { name: "Kitchen", sqft: total * 0.2 },
      { name: "Master Bedroom", sqft: total * 0.2 },
      { name: "Bedroom 2", sqft: total * 0.15 },
      { name: "Bathroom", sqft: total * 0.1 },
      { name: "Garage", sqft: total * 0.05 },
    ];
    rawRooms = rooms.map((r) => {
      const w = Math.sqrt(r.sqft * 1.3);
      const h = r.sqft / w;
      return { ...r, w, h };
    });
  }

  // Sort by sqft desc
  rawRooms.sort((a, b) => b.sqft - a.sqft);

  const totalSqft = rawRooms.reduce((s, r) => s + r.sqft, 0);
  const maxRowWidth = Math.sqrt(totalSqft) * 1.5;
  const GAP = 2;

  const placed: PlacedRoom[] = [];
  let curX = 0;
  let curZ = 0;
  let rowMaxH = 0;
  let colorIdx = 0;

  for (const r of rawRooms) {
    if (curX > 0 && curX + r.w > maxRowWidth) {
      curX = 0;
      curZ += rowMaxH + GAP;
      rowMaxH = 0;
    }
    placed.push({
      name: r.name,
      sqft: r.sqft,
      w: r.w,
      h: r.h,
      x: curX,
      z: curZ,
      colorIdx: colorIdx % ISO_COLORS.length,
    });
    curX += r.w + GAP;
    rowMaxH = Math.max(rowMaxH, r.h);
    colorIdx++;
  }

  return placed;
}

// ---------------------------------------------------------------------------
// Isometric projection helpers
// ---------------------------------------------------------------------------

function isoProject(
  wx: number,
  wy: number,
  wz: number,
  scale: number,
  angle: number,
  cx: number,
  cy: number
): { sx: number; sy: number } {
  const cosR = Math.cos(angle);
  const sinR = Math.sin(angle);
  const ix = wx * cosR - wz * sinR;
  const iz = wx * sinR + wz * cosR;
  return {
    sx: cx + ix * scale,
    sy: cy + iz * scale * 0.45 - wy * scale * 0.6,
  };
}

function isoInverse(
  sx: number,
  sy: number,
  scale: number,
  angle: number,
  cx: number,
  cy: number
): { wx: number; wz: number } {
  const cosR = Math.cos(angle);
  const sinR = Math.sin(angle);
  const a = (sx - cx) / scale;
  const b = (sy - cy) / (scale * 0.45);
  return {
    wx: a * cosR + b * sinR,
    wz: b * cosR - a * sinR,
  };
}

// ---------------------------------------------------------------------------
// First-person projection helpers
// ---------------------------------------------------------------------------

function toViewSpace(
  wx: number,
  wy: number,
  wz: number,
  camX: number,
  camZ: number,
  angle: number
): Vec3 {
  const dx = wx - camX;
  const dy = wy - EYE_HEIGHT;
  const dz = wz - camZ;
  const ca = Math.cos(-angle);
  const sa = Math.sin(-angle);
  return {
    x: dx * ca - dz * sa,
    y: dy,
    z: dx * sa + dz * ca,
  };
}

function perspProject(
  vx: number,
  vy: number,
  vz: number,
  W: number,
  H: number
): ProjectedPoint | null {
  if (vz < 0.2) return null;
  const fov = W * 0.65;
  return {
    sx: W / 2 + (vx / vz) * fov,
    sy: H / 2 - (vy / vz) * fov,
    depth: vz,
  };
}

// ---------------------------------------------------------------------------
// Auto-scale computation
// ---------------------------------------------------------------------------

function computeScale(rooms: PlacedRoom[]): number {
  if (rooms.length === 0) return 20;
  let maxX = 0;
  let maxZ = 0;
  for (const r of rooms) {
    maxX = Math.max(maxX, r.x + r.w);
    maxZ = Math.max(maxZ, r.z + r.h);
  }
  const margin = 80;
  const scaleX = (CANVAS_W - margin * 2) / ((maxX + maxZ) * 1.0);
  const scaleY = (CANVAS_H - margin * 2) / ((maxX + maxZ) * 0.5);
  return Math.max(8, Math.min(scaleX, scaleY));
}

// ---------------------------------------------------------------------------
// Snap helpers
// ---------------------------------------------------------------------------

function snapToGrid(
  wx: number,
  wz: number,
  rooms: PlacedRoom[],
  thresholdFt = 4
): { wx: number; wz: number } {
  let best = { wx, wz };
  let bestDist = thresholdFt;

  for (const r of rooms) {
    const corners: [number, number][] = [
      [r.x, r.z],
      [r.x + r.w, r.z],
      [r.x, r.z + r.h],
      [r.x + r.w, r.z + r.h],
    ];
    const mids: [number, number][] = [
      [r.x + r.w / 2, r.z],
      [r.x + r.w / 2, r.z + r.h],
      [r.x, r.z + r.h / 2],
      [r.x + r.w, r.z + r.h / 2],
    ];
    for (const [px, pz] of [...corners, ...mids]) {
      const d = Math.sqrt((wx - px) ** 2 + (wz - pz) ** 2);
      if (d < bestDist) {
        bestDist = d;
        best = { wx: px, wz: pz };
      }
    }
  }
  return best;
}

function roomContaining(wx: number, wz: number, rooms: PlacedRoom[]): PlacedRoom | null {
  for (const r of rooms) {
    if (wx >= r.x && wx <= r.x + r.w && wz >= r.z && wz <= r.z + r.h) {
      return r;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function fillPoly(
  ctx: CanvasRenderingContext2D,
  pts: { sx: number; sy: number }[],
  color: string,
  alpha = 1
) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0].sx, pts[0].sy);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function strokePoly(
  ctx: CanvasRenderingContext2D,
  pts: { sx: number; sy: number }[],
  color: string,
  lineWidth = 1
) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(pts[0].sx, pts[0].sy);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Blueprint3DViewer({ analysis, sceneData }: { analysis: any; sceneData?: SceneData | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("iso");
  const [toolMode, setToolMode] = useState<ToolMode>("none");
  const [isoAngle, setIsoAngle] = useState(Math.PI / 6);
  const [isoScale, setIsoScale] = useState(1); // multiplier on auto-scale
  const [unit, setUnit] = useState<UnitKey>("ft");
  const [showLayersPanel, setShowLayersPanel] = useState(false);
  const [layers, setLayers] = useState<LayerState>({
    foundation: true,
    framing: true,
    electrical: false,
    plumbing: false,
    drywall: true,
    roof: true,
  });

  // Measurement state
  const [measurePts, setMeasurePts] = useState<MeasurePt[]>([]);
  const [measureHint, setMeasureHint] = useState("Click first point");

  // Annotation state
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pendingPin, setPendingPin] = useState<{
    wx: number;
    wz: number;
    sx: number;
    sy: number;
  } | null>(null);
  const [pinText, setPinText] = useState("");
  const nextPinId = useRef(1);

  // Rooms (computed once from analysis)
  const rooms = useRef<PlacedRoom[]>([]);
  const baseScale = useRef(20);

  useEffect(() => {
    rooms.current = buildRooms(analysis);
    baseScale.current = computeScale(rooms.current);
  }, [analysis]);

  const sceneDataRef = useRef<SceneData | null>(null)
  useEffect(() => { sceneDataRef.current = sceneData || null }, [sceneData])

  // FP camera refs (not state to avoid stale closures)
  const fpCamX = useRef(0);
  const fpCamZ = useRef(0);
  const fpAngle = useRef(0); // look direction in XZ plane
  const fpKeys = useRef<Set<string>>(new Set());
  const fpDragging = useRef(false);
  const fpLastMouseX = useRef(0);
  const fpRafId = useRef<number | null>(null);
  const viewModeRef = useRef<ViewMode>("iso");
  const isoAngleRef = useRef(isoAngle);
  const isoScaleRef = useRef(isoScale);

  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { isoAngleRef.current = isoAngle; }, [isoAngle]);
  useEffect(() => { isoScaleRef.current = isoScale; }, [isoScale]);

  // Annotation pending popup ref
  const pendingPinRef = useRef(pendingPin);
  useEffect(() => { pendingPinRef.current = pendingPin; }, [pendingPin]);

  const layersRef = useRef(layers);
  useEffect(() => { layersRef.current = layers; }, [layers]);

  const unitRef = useRef(unit);
  useEffect(() => { unitRef.current = unit; }, [unit]);

  const measurePtsRef = useRef(measurePts);
  useEffect(() => { measurePtsRef.current = measurePts; }, [measurePts]);

  const toolModeRef = useRef(toolMode);
  useEffect(() => { toolModeRef.current = toolMode; }, [toolMode]);

  const annotationsRef = useRef(annotations);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);

  // -----------------------------------------------------------------------
  // Isometric draw
  // -----------------------------------------------------------------------

  const drawIso = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = CANVAS_W;
    const H = CANVAS_H;
    const scale = baseScale.current * isoScaleRef.current;
    const angle = isoAngleRef.current;
    const lyr = layersRef.current;
    const currentUnit = unitRef.current;
    const factor = UNIT_FACTORS[currentUnit];
    const suffix = UNIT_SUFFIXES[currentUnit];

    ctx.clearRect(0, 0, W, H);

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#f0f4ff");
    bg.addColorStop(1, "#e8edf7");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Scene-data-based rendering (Claude Vision parsed) ──────────────────
    const sd = sceneDataRef.current
    if (sd && sd.walls && sd.walls.length > 0) {
      // Compute cx/cy from scene data dimensions
      const sdW = sd.building_width_ft || 45
      const sdD = sd.building_depth_ft || 38
      const cosR2 = Math.cos(angle), sinR2 = Math.sin(angle)
      function proj2(wx: number, wz: number) {
        return { ix: wx * cosR2 - wz * sinR2, iz: wx * sinR2 + wz * cosR2 }
      }
      const corners2 = [proj2(0,0), proj2(sdW,0), proj2(0,sdD), proj2(sdW,sdD)]
      const minIX2 = Math.min(...corners2.map(c => c.ix))
      const maxIX2 = Math.max(...corners2.map(c => c.ix))
      const minIZ2 = Math.min(...corners2.map(c => c.iz))
      const maxIZ2 = Math.max(...corners2.map(c => c.iz))
      const cx = W / 2 - ((minIX2 + maxIX2) / 2) * scale
      const cy = H / 2 - ((minIZ2 + maxIZ2) / 2) * scale * 0.45 + ((sd.wall_height_ft || 9) * scale * 0.6) / 2
      drawSceneDataIso(ctx, sd, scale, angle, cx, cy, lyr, factor, suffix)
      // Draw annotations
      const anns = annotationsRef.current
      for (const ann of anns) {
        const cosR3 = Math.cos(angle), sinR3 = Math.sin(angle)
        function isoP3(wx: number, wy: number, wz: number) {
          const ix = wx * cosR3 - wz * sinR3
          const iz = wx * sinR3 + wz * cosR3
          return { sx: cx + ix * scale, sy: cy + iz * scale * 0.45 - wy * scale * 0.6 }
        }
        const base = isoP3(ann.wx, 0, ann.wz)
        const tip = isoP3(ann.wx, WALL_HEIGHT * 0.6, ann.wz)
        ctx.save()
        ctx.strokeStyle = '#7c3aed'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(base.sx, base.sy)
        ctx.lineTo(tip.sx, tip.sy)
        ctx.stroke()
        ctx.fillStyle = '#7c3aed'
        ctx.beginPath()
        ctx.arc(tip.sx, tip.sy, 8, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = '9px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('✏', tip.sx, tip.sy + 3)
        ctx.restore()
      }
      // Draw measure points
      const mPts = measurePtsRef.current
      if (mPts.length >= 1) {
        ctx.save()
        ctx.fillStyle = '#22c55e'
        ctx.beginPath()
        ctx.arc(mPts[0].sx, mPts[0].sy, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
      if (mPts.length >= 2) {
        ctx.save()
        ctx.fillStyle = '#22c55e'
        ctx.beginPath()
        ctx.arc(mPts[1].sx, mPts[1].sy, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        ctx.moveTo(mPts[0].sx, mPts[0].sy)
        ctx.lineTo(mPts[1].sx, mPts[1].sy)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.restore()
      }
      return
    }
    // ── end scene-data rendering ──────────────────────────────────────────

    const rs = rooms.current;
    if (rs.length === 0) return;

    // Compute center offset so layout is centered on canvas
    let maxX = 0, maxZ = 0;
    for (const r of rs) {
      maxX = Math.max(maxX, r.x + r.w);
      maxZ = Math.max(maxZ, r.z + r.h);
    }
    const cosR = Math.cos(angle);
    const sinR = Math.sin(angle);

    function proj(wx: number, wz: number) {
      const ix = wx * cosR - wz * sinR;
      const iz = wx * sinR + wz * cosR;
      return { ix, iz };
    }

    // Find bounding box in iso space
    const corners2D = [
      proj(0, 0), proj(maxX, 0), proj(0, maxZ), proj(maxX, maxZ),
    ];
    const minIX = Math.min(...corners2D.map((c) => c.ix));
    const maxIX = Math.max(...corners2D.map((c) => c.ix));
    const minIZ = Math.min(...corners2D.map((c) => c.iz));
    const maxIZ = Math.max(...corners2D.map((c) => c.iz));

    const cx = W / 2 - ((minIX + maxIX) / 2) * scale;
    const cy = H / 2 - ((minIZ + maxIZ) / 2) * scale * 0.45 + (WALL_HEIGHT * scale * 0.6) / 2;

    function isoP(wx: number, wy: number, wz: number) {
      return isoProject(wx, wy, wz, scale, angle, cx, cy);
    }

    // Painter's algorithm: sort rooms far to near
    const sorted = [...rs].sort((a, b) => {
      const da = isoP(a.x + a.w / 2, 0, a.z + a.h / 2).sy;
      const db = isoP(b.x + b.w / 2, 0, b.z + b.h / 2).sy;
      return da - db;
    });

    for (const r of sorted) {
      const [cLight, cMid, cDark] = ISO_COLORS[r.colorIdx];
      const wallColor = lyr.drywall ? cMid : "#92400e"; // framing brown if drywall off
      const floorColor = lyr.drywall ? cLight : "#d6b896";

      const x0 = r.x, x1 = r.x + r.w;
      const z0 = r.z, z1 = r.z + r.h;
      const yBot = 0, yTop = WALL_HEIGHT;

      // 8 corners
      const c000 = isoP(x0, yBot, z0);
      const c100 = isoP(x1, yBot, z0);
      const c010 = isoP(x0, yTop, z0);
      const c110 = isoP(x1, yTop, z0);
      const c001 = isoP(x0, yBot, z1);
      const c101 = isoP(x1, yBot, z1);
      const c011 = isoP(x0, yTop, z1);
      const c111 = isoP(x1, yTop, z1);

      // Foundation slab
      if (lyr.foundation) {
        const slabY = -0.3;
        const s00 = isoP(x0 - 0.15, slabY, z0 - 0.15);
        const s10 = isoP(x1 + 0.15, slabY, z0 - 0.15);
        const s11 = isoP(x1 + 0.15, slabY, z1 + 0.15);
        const s01 = isoP(x0 - 0.15, slabY, z1 + 0.15);
        fillPoly(ctx, [s00, s10, s11, s01], "#9ca3af", 0.7);
        strokePoly(ctx, [s00, s10, s11, s01], "#6b7280", 1);
      }

      // Floor
      fillPoly(ctx, [c000, c100, c101, c001], floorColor);
      strokePoly(ctx, [c000, c100, c101, c001], "#00000022", 0.5);

      // Left wall (near-left visible face)
      fillPoly(ctx, [c001, c101, c111, c011], wallColor);
      strokePoly(ctx, [c001, c101, c111, c011], "#00000033", 0.8);

      // Right wall (near-right visible face)
      fillPoly(ctx, [c100, c101, c111, c110], cDark);
      strokePoly(ctx, [c100, c101, c111, c110], "#00000033", 0.8);

      // Back walls (far faces, only draw if framing on)
      if (lyr.framing && !lyr.drywall) {
        fillPoly(ctx, [c000, c100, c110, c010], "#b45309");
        fillPoly(ctx, [c000, c001, c011, c010], "#92400e");
      }

      // Roof (top face)
      if (lyr.roof) {
        fillPoly(ctx, [c010, c110, c111, c011], "#ffffff", 0.35);
        strokePoly(ctx, [c010, c110, c111, c011], "#00000022", 0.5);
      }

      // Electrical dots (yellow circles on walls at shoulder height ~4ft)
      if (lyr.electrical) {
        const shoulderY = 4;
        const positions: [number, number][] = [
          [x0 + r.w * 0.25, z0],
          [x0 + r.w * 0.75, z0],
          [x0, z0 + r.h * 0.5],
          [x1, z0 + r.h * 0.5],
        ];
        for (const [px, pz] of positions) {
          const ep = isoP(px, shoulderY, pz);
          ctx.save();
          ctx.fillStyle = "#fbbf24";
          ctx.strokeStyle = "#d97706";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(ep.sx, ep.sy, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }

      // Plumbing dots (blue, only in wet rooms)
      if (lyr.plumbing) {
        const lname = r.name.toLowerCase();
        if (
          lname.includes("bath") ||
          lname.includes("kitchen") ||
          lname.includes("laundry")
        ) {
          const midPt = isoP(r.x + r.w / 2, 0.1, r.z + r.h / 2);
          ctx.save();
          ctx.fillStyle = "#3b82f6";
          ctx.strokeStyle = "#1d4ed8";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(midPt.sx, midPt.sy, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }

      // Room label
      const topMid = isoP(r.x + r.w / 2, WALL_HEIGHT + 0.5, r.z + r.h / 2);
      const displayW = (r.w * factor).toFixed(1);
      const displayH = (r.h * factor).toFixed(1);
      ctx.save();
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "#1e293b";
      ctx.textAlign = "center";
      ctx.fillText(r.name, topMid.sx, topMid.sy);
      ctx.font = "10px sans-serif";
      ctx.fillStyle = "#475569";
      ctx.fillText(
        `${Math.round(r.sqft)} sqft · ${displayW}×${displayH}${suffix}`,
        topMid.sx,
        topMid.sy + 13
      );
      ctx.restore();
    }

    // Annotation pins
    const anns = annotationsRef.current;
    for (const ann of anns) {
      const base = isoP(ann.wx, 0, ann.wz);
      const tip = isoP(ann.wx, WALL_HEIGHT * 0.6, ann.wz);
      // Stem
      ctx.save();
      ctx.strokeStyle = "#7c3aed";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(base.sx, base.sy);
      ctx.lineTo(tip.sx, tip.sy);
      ctx.stroke();
      // Circle
      ctx.fillStyle = "#7c3aed";
      ctx.beginPath();
      ctx.arc(tip.sx, tip.sy, 8, 0, Math.PI * 2);
      ctx.fill();
      // Pencil icon (simplified)
      ctx.fillStyle = "#fff";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("✏", tip.sx, tip.sy + 3);
      // Label
      ctx.fillStyle = "#1e293b";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      const labelW = ctx.measureText(ann.text).width + 10;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(tip.sx - labelW / 2, tip.sy - 28, labelW, 16);
      ctx.fillStyle = "#7c3aed";
      ctx.fillText(ann.text, tip.sx, tip.sy - 16);
      ctx.restore();
    }

    // Measure points & line
    const mPts = measurePtsRef.current;
    if (mPts.length >= 1) {
      // Dot 1
      ctx.save();
      ctx.fillStyle = "#22c55e";
      ctx.beginPath();
      ctx.arc(mPts[0].sx, mPts[0].sy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (mPts.length >= 2) {
      // Dot 2
      ctx.save();
      ctx.fillStyle = "#22c55e";
      ctx.beginPath();
      ctx.arc(mPts[1].sx, mPts[1].sy, 5, 0, Math.PI * 2);
      ctx.fill();
      // Dashed line
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(mPts[0].sx, mPts[0].sy);
      ctx.lineTo(mPts[1].sx, mPts[1].sy);
      ctx.stroke();
      ctx.setLineDash([]);
      // Distance label pill
      const dx = mPts[1].wx - mPts[0].wx;
      const dz = mPts[1].wz - mPts[0].wz;
      const distFt = Math.sqrt(dx * dx + dz * dz);
      const distDisplay = (distFt * UNIT_FACTORS[currentUnit]).toFixed(2);
      const label = `${distDisplay} ${UNIT_SUFFIXES[currentUnit]}`;
      const midSX = (mPts[0].sx + mPts[1].sx) / 2;
      const midSY = (mPts[0].sy + mPts[1].sy) / 2;
      const tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = "#16a34a";
      ctx.beginPath();
      ctx.roundRect(midSX - tw / 2, midSY - 12, tw, 22, 11);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, midSX, midSY + 4);
      ctx.restore();
    }
  }, []);

  // -----------------------------------------------------------------------
  // First-person draw
  // -----------------------------------------------------------------------

  const drawFP = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = CANVAS_W;
    const H = CANVAS_H;
    const camX = fpCamX.current;
    const camZ = fpCamZ.current;
    const angle = fpAngle.current;

    ctx.clearRect(0, 0, W, H);

    // Sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, H / 2);
    sky.addColorStop(0, "#1e3a5f");
    sky.addColorStop(1, "#7eb8f7");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H / 2);

    // Floor gradient
    const floor = ctx.createLinearGradient(0, H / 2, 0, H);
    floor.addColorStop(0, "#b0a090");
    floor.addColorStop(1, "#7a6a5a");
    ctx.fillStyle = floor;
    ctx.fillRect(0, H / 2, W, H / 2);

    const rs = rooms.current;

    interface FaceEntry {
      pts: ProjectedPoint[];
      color: string;
      alpha: number;
      avgDepth: number;
    }

    const faces: FaceEntry[] = [];

    for (const r of rs) {
      const [cLight, cMid, cDark] = ISO_COLORS[r.colorIdx];
      const x0 = r.x, x1 = r.x + r.w;
      const y0 = 0, y1 = WALL_HEIGHT;
      const z0 = r.z, z1 = r.z + r.h;

      type Corner = [number, number, number];
      const c000: Corner = [x0, y0, z0];
      const c100: Corner = [x1, y0, z0];
      const c010: Corner = [x0, y1, z0];
      const c110: Corner = [x1, y1, z0];
      const c001: Corner = [x0, y0, z1];
      const c101: Corner = [x1, y0, z1];
      const c011: Corner = [x0, y1, z1];
      const c111: Corner = [x1, y1, z1];

      const facesDef: { corners: Corner[]; color: string; alpha: number }[] = [
        { corners: [c000, c100, c101, c001], color: cLight, alpha: 1 }, // floor
        { corners: [c010, c110, c111, c011], color: "#ffffff", alpha: 0.5 }, // ceiling
        { corners: [c000, c100, c110, c010], color: cMid, alpha: 1 }, // front wall
        { corners: [c001, c101, c111, c011], color: cMid, alpha: 1 }, // back wall
        { corners: [c000, c001, c011, c010], color: cDark, alpha: 1 }, // left wall
        { corners: [c100, c101, c111, c110], color: cDark, alpha: 1 }, // right wall
      ];

      for (const fd of facesDef) {
        const projected: (ProjectedPoint | null)[] = fd.corners.map(([wx, wy, wz]) => {
          const v = toViewSpace(wx, wy, wz, camX, camZ, angle);
          return perspProject(v.x, v.y, v.z, W, H);
        });

        if (projected.some((p) => p === null)) continue;
        const pts = projected as ProjectedPoint[];
        const avgDepth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;

        faces.push({
          pts,
          color: fd.color,
          alpha: fd.alpha,
          avgDepth,
        });
      }
    }

    // Sort far to near
    faces.sort((a, b) => b.avgDepth - a.avgDepth);

    for (const face of faces) {
      ctx.save();
      ctx.globalAlpha = face.alpha;
      ctx.fillStyle = face.color;
      ctx.beginPath();
      ctx.moveTo(face.pts[0].sx, face.pts[0].sy);
      for (let i = 1; i < face.pts.length; i++) {
        ctx.lineTo(face.pts[i].sx, face.pts[i].sy);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#00000033";
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.restore();
    }

    // Crosshair
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 10, H / 2);
    ctx.lineTo(W / 2 + 10, H / 2);
    ctx.moveTo(W / 2, H / 2 - 10);
    ctx.lineTo(W / 2, H / 2 + 10);
    ctx.stroke();
    ctx.restore();

    // Room HUD
    const currentRoom = roomContaining(camX, camZ, rs);
    if (currentRoom) {
      const label = currentRoom.name;
      ctx.save();
      ctx.font = "bold 14px sans-serif";
      const tw = ctx.measureText(label).width + 24;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.roundRect(W / 2 - tw / 2, H - 50, tw, 30, 8);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(label, W / 2, H - 29);
      ctx.restore();
    }

    // Hint
    ctx.save();
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textAlign = "left";
    ctx.fillText("W/A/S/D · Drag to look", 12, H - 14);
    ctx.restore();
  }, []);

  // -----------------------------------------------------------------------
  // Animation loop for FP
  // -----------------------------------------------------------------------

  const startFPLoop = useCallback(() => {
    const SPEED = 0.12;

    function tick() {
      if (viewModeRef.current !== "fp") return;
      const keys = fpKeys.current;
      const angle = fpAngle.current;
      let moved = false;

      if (keys.has("w") || keys.has("arrowup")) {
        fpCamX.current += Math.sin(angle) * SPEED;
        fpCamZ.current += Math.cos(angle) * SPEED;
        moved = true;
      }
      if (keys.has("s") || keys.has("arrowdown")) {
        fpCamX.current -= Math.sin(angle) * SPEED;
        fpCamZ.current -= Math.cos(angle) * SPEED;
        moved = true;
      }
      if (keys.has("a") || keys.has("arrowleft")) {
        fpCamX.current += Math.cos(angle) * SPEED;
        fpCamZ.current -= Math.sin(angle) * SPEED;
        moved = true;
      }
      if (keys.has("d") || keys.has("arrowright")) {
        fpCamX.current -= Math.cos(angle) * SPEED;
        fpCamZ.current += Math.sin(angle) * SPEED;
        moved = true;
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) drawFP(ctx);
      }

      fpRafId.current = requestAnimationFrame(tick);
    }

    fpRafId.current = requestAnimationFrame(tick);
  }, [drawFP]);

  const stopFPLoop = useCallback(() => {
    if (fpRafId.current !== null) {
      cancelAnimationFrame(fpRafId.current);
      fpRafId.current = null;
    }
  }, []);

  // -----------------------------------------------------------------------
  // Enter/exit walk mode
  // -----------------------------------------------------------------------

  const enterWalkMode = useCallback(() => {
    // Start camera in center of first room
    const rs = rooms.current;
    if (rs.length > 0) {
      fpCamX.current = rs[0].x + rs[0].w / 2;
      fpCamZ.current = rs[0].z + rs[0].h / 2;
    }
    fpAngle.current = 0;
    setViewMode("fp");
    setToolMode("none");
    viewModeRef.current = "fp";
    setTimeout(startFPLoop, 50);
  }, [startFPLoop]);

  const exitWalkMode = useCallback(() => {
    stopFPLoop();
    setViewMode("iso");
    viewModeRef.current = "iso";
    // Trigger iso redraw
    setTimeout(() => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) drawIso(ctx);
      }
    }, 50);
  }, [stopFPLoop, drawIso]);

  // -----------------------------------------------------------------------
  // Keyboard handling
  // -----------------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const key = e.key.toLowerCase();
      if (viewModeRef.current === "fp") {
        fpKeys.current.add(key);
        if (key === "escape") exitWalkMode();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      fpKeys.current.delete(e.key.toLowerCase());
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [exitWalkMode]);

  // -----------------------------------------------------------------------
  // Iso redraw on state changes
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (viewMode !== "iso") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) drawIso(ctx);
  }, [viewMode, isoAngle, isoScale, layers, unit, annotations, measurePts, drawIso, sceneData]);

  // -----------------------------------------------------------------------
  // Canvas mouse handlers
  // -----------------------------------------------------------------------

  const didDrag = useRef(false);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);

  function getCanvasPos(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
      y: (e.clientY - rect.top) * (CANVAS_H / rect.height),
    };
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    mouseDownPos.current = getCanvasPos(e);
    didDrag.current = false;

    if (viewMode === "fp") {
      fpDragging.current = true;
      fpLastMouseX.current = e.clientX;
    }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (viewMode === "fp" && fpDragging.current) {
      const dx = e.clientX - fpLastMouseX.current;
      fpAngle.current -= dx * 0.005;
      fpLastMouseX.current = e.clientX;
      didDrag.current = true;
      return;
    }

    if (mouseDownPos.current) {
      const pos = getCanvasPos(e);
      const dist = Math.sqrt(
        (pos.x - mouseDownPos.current.x) ** 2 +
          (pos.y - mouseDownPos.current.y) ** 2
      );
      if (dist > 4) didDrag.current = true;
    }
  }

  function handleMouseUp(_e: React.MouseEvent<HTMLCanvasElement>) {
    fpDragging.current = false;
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (didDrag.current) return;
    if (viewMode !== "iso") return;

    const pos = getCanvasPos(e);
    const scale = baseScale.current * isoScaleRef.current;
    const angle = isoAngleRef.current;

    // Compute cx/cy (same logic as drawIso)
    const rs = rooms.current;
    let maxX = 0, maxZ = 0;
    for (const r of rs) {
      maxX = Math.max(maxX, r.x + r.w);
      maxZ = Math.max(maxZ, r.z + r.h);
    }
    const cosR = Math.cos(angle);
    const sinR = Math.sin(angle);
    const corners2D = [
      { ix: 0 * cosR - 0 * sinR, iz: 0 * sinR + 0 * cosR },
      { ix: maxX * cosR - 0 * sinR, iz: maxX * sinR + 0 * cosR },
      { ix: 0 * cosR - maxZ * sinR, iz: 0 * sinR + maxZ * cosR },
      { ix: maxX * cosR - maxZ * sinR, iz: maxX * sinR + maxZ * cosR },
    ];
    const minIX = Math.min(...corners2D.map((c) => c.ix));
    const maxIX = Math.max(...corners2D.map((c) => c.ix));
    const minIZ = Math.min(...corners2D.map((c) => c.iz));
    const maxIZ = Math.max(...corners2D.map((c) => c.iz));
    const cx = CANVAS_W / 2 - ((minIX + maxIX) / 2) * scale;
    const cy = CANVAS_H / 2 - ((minIZ + maxIZ) / 2) * scale * 0.45 + (WALL_HEIGHT * scale * 0.6) / 2;

    const { wx, wz } = isoInverse(pos.x, pos.y, scale, angle, cx, cy);

    if (toolMode === "measure") {
      const snapped = snapToGrid(wx, wz, rs);
      const snappedScreen = isoProject(snapped.wx, 0, snapped.wz, scale, angle, cx, cy);

      if (measurePtsRef.current.length === 0) {
        setMeasurePts([{ wx: snapped.wx, wz: snapped.wz, sx: snappedScreen.sx, sy: snappedScreen.sy }]);
        setMeasureHint("Click second point");
      } else if (measurePtsRef.current.length === 1) {
        setMeasurePts((prev) => [
          ...prev,
          { wx: snapped.wx, wz: snapped.wz, sx: snappedScreen.sx, sy: snappedScreen.sy },
        ]);
        const dx = snapped.wx - measurePtsRef.current[0].wx;
        const dz = snapped.wz - measurePtsRef.current[0].wz;
        const distFt = Math.sqrt(dx * dx + dz * dz);
        const u = unitRef.current;
        const display = (distFt * UNIT_FACTORS[u]).toFixed(2);
        setMeasureHint(`Distance: ${display} ${UNIT_SUFFIXES[u]}`);
      } else {
        // Reset and start new measurement
        setMeasurePts([{ wx: snapped.wx, wz: snapped.wz, sx: snappedScreen.sx, sy: snappedScreen.sy }]);
        setMeasureHint("Click second point");
      }
      return;
    }

    if (toolMode === "annotate") {
      const screenPos = isoProject(wx, 0, wz, scale, angle, cx, cy);
      setPendingPin({ wx, wz, sx: screenPos.sx, sy: screenPos.sy });
      setPinText("");
      return;
    }
  }

  // -----------------------------------------------------------------------
  // Toolbar actions
  // -----------------------------------------------------------------------

  function toggleTool(t: ToolMode) {
    setToolMode((prev) => {
      const next = prev === t ? "none" : t;
      if (next !== "measure") {
        setMeasurePts([]);
        setMeasureHint("Click first point");
      }
      if (next !== "annotate") {
        setPendingPin(null);
      }
      return next;
    });
  }

  function addPin() {
    if (!pendingPin || pinText.trim() === "") return;
    setAnnotations((prev) => [
      ...prev,
      { id: nextPinId.current++, wx: pendingPin.wx, wz: pendingPin.wz, text: pinText.trim() },
    ]);
    setPendingPin(null);
    setPinText("");
  }

  function toggleLayer(key: keyof LayerState) {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function convertUnit(val: number) {
    return (val * UNIT_FACTORS[unit]).toFixed(2);
  }

  // -----------------------------------------------------------------------
  // Cursor style
  // -----------------------------------------------------------------------

  const cursorStyle =
    toolMode === "measure" || toolMode === "annotate" ? "crosshair" : "default";

  // -----------------------------------------------------------------------
  // Pending pin popup position (clamped to canvas area)
  // -----------------------------------------------------------------------

  function pinPopupStyle(): React.CSSProperties {
    if (!pendingPin) return { display: "none" };
    const canvasEl = canvasRef.current;
    if (!canvasEl) return { display: "none" };
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = rect.width / CANVAS_W;
    const scaleY = rect.height / CANVAS_H;
    let left = pendingPin.sx * scaleX + rect.left;
    let top = pendingPin.sy * scaleY + rect.top - 80;
    // Clamp
    left = Math.max(rect.left + 4, Math.min(left, rect.right - 200));
    top = Math.max(rect.top + 4, top);
    return {
      position: "fixed",
      left,
      top,
      zIndex: 50,
    };
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-2 select-none">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap px-1">
        {/* View toggle group */}
        <div className="flex rounded-lg overflow-hidden border border-gray-200 shadow-sm">
          <button
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              viewMode === "iso"
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
            onClick={exitWalkMode}
          >
            ⬡ Overview
          </button>
          <button
            className={`px-3 py-1.5 text-xs font-medium border-l border-gray-200 transition-colors ${
              viewMode === "fp"
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
            onClick={enterWalkMode}
          >
            🚶 Walk Through
          </button>
        </div>

        <div className="w-px h-5 bg-gray-300" />

        {/* ISO-only tools */}
        {viewMode === "iso" && (
          <>
            <button
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                toolMode === "measure"
                  ? "bg-green-600 text-white border-green-600"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
              }`}
              onClick={() => toggleTool("measure")}
            >
              📏 Measure
            </button>
            <button
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                toolMode === "annotate"
                  ? "bg-purple-600 text-white border-purple-600"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
              }`}
              onClick={() => toggleTool("annotate")}
            >
              📌 Notes
            </button>
          </>
        )}

        {/* Layers dropdown */}
        <div className="relative">
          <button
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              showLayersPanel
                ? "bg-gray-700 text-white border-gray-700"
                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
            }`}
            onClick={() => setShowLayersPanel((p) => !p)}
          >
            🏗 Layers
          </button>
          {showLayersPanel && (
            <div className="absolute left-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-48">
              <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
                Layer Visibility
              </p>
              {LAYER_META.map(({ key, label, color }) => (
                <label
                  key={key}
                  className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 rounded px-1"
                >
                  <input
                    type="checkbox"
                    checked={layers[key]}
                    onChange={() => toggleLayer(key)}
                    className="rounded"
                  />
                  <span
                    className="w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-xs text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Right side */}
        <select
          className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700"
          value={unit}
          onChange={(e) => setUnit(e.target.value as UnitKey)}
        >
          {(Object.keys(UNIT_LABELS) as UnitKey[]).map((k) => (
            <option key={k} value={k}>
              {UNIT_LABELS[k]}
            </option>
          ))}
        </select>

        {viewMode === "iso" ? (
          <>
            <button
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50"
              onClick={() => setIsoAngle((a) => a - Math.PI / 12)}
              title="Rotate left"
            >
              ← Rotate
            </button>
            <button
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50"
              onClick={() => setIsoAngle((a) => a + Math.PI / 12)}
              title="Rotate right"
            >
              Rotate →
            </button>
            <button
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50"
              onClick={() => setIsoScale((s) => Math.max(0.3, s - 0.15))}
              title="Zoom out"
            >
              −
            </button>
            <button
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50"
              onClick={() => setIsoScale((s) => Math.min(3, s + 0.15))}
              title="Zoom in"
            >
              +
            </button>
            <button
              className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50"
              onClick={() => {
                setIsoAngle(Math.PI / 6);
                setIsoScale(1);
              }}
              title="Reset view"
            >
              Reset
            </button>
          </>
        ) : (
          <button
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
            onClick={exitWalkMode}
          >
            ✕ Exit Walk Mode
          </button>
        )}
      </div>

      {/* Measure hint bar */}
      {toolMode === "measure" && (
        <div className="flex items-center gap-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          <span className="font-medium">📏 {measureHint}</span>
          <div className="flex-1" />
          {measurePts.length > 0 && (
            <button
              className="px-2 py-1 rounded bg-amber-200 hover:bg-amber-300 text-amber-900 font-medium"
              onClick={() => {
                setMeasurePts([]);
                setMeasureHint("Click first point");
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Annotate hint bar */}
      {toolMode === "annotate" && !pendingPin && (
        <div className="px-3 py-2 bg-purple-50 border border-purple-200 rounded-lg text-xs text-purple-800 font-medium">
          📌 Click anywhere on the floor plan to place a note pin
        </div>
      )}

      {/* Canvas */}
      <div className="relative rounded-xl overflow-hidden border border-gray-200 shadow-md">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="w-full"
          style={{ cursor: cursorStyle, display: "block" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onClick={handleClick}
        />

        {/* Pending pin popup (fixed position) */}
        {pendingPin && (
          <div style={pinPopupStyle()}>
            <div className="bg-white border border-purple-300 rounded-xl shadow-lg p-3 w-52">
              <p className="text-xs font-semibold text-purple-700 mb-2">Add Note</p>
              <input
                autoFocus
                className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 mb-2 focus:outline-none focus:ring-2 focus:ring-purple-400"
                placeholder="Type your note..."
                value={pinText}
                onChange={(e) => setPinText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPin();
                  if (e.key === "Escape") setPendingPin(null);
                }}
              />
              <div className="flex gap-2">
                <button
                  className="flex-1 px-2 py-1 text-xs bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-medium"
                  onClick={addPin}
                >
                  Add Pin
                </button>
                <button
                  className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                  onClick={() => setPendingPin(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Notes panel */}
      {annotations.length > 0 && (
        <div className="border border-gray-200 rounded-xl bg-white shadow-sm p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
              📌 Notes ({annotations.length})
            </p>
            <button
              className="text-xs text-red-500 hover:text-red-700"
              onClick={() => setAnnotations([])}
            >
              Clear all
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {annotations.map((ann) => (
              <div
                key={ann.id}
                className="flex items-center gap-2 py-1.5 px-2 bg-purple-50 rounded-lg"
              >
                <span className="w-5 h-5 bg-purple-600 rounded-full flex items-center justify-center text-white text-xs flex-shrink-0">
                  ✏
                </span>
                <span className="text-xs text-gray-700 flex-1">{ann.text}</span>
                <span className="text-xs text-gray-400">
                  ({convertUnit(ann.wx)}, {convertUnit(ann.wz)}) {UNIT_SUFFIXES[unit]}
                </span>
                <button
                  className="text-gray-400 hover:text-red-500 text-sm leading-none"
                  onClick={() =>
                    setAnnotations((prev) => prev.filter((a) => a.id !== ann.id))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
