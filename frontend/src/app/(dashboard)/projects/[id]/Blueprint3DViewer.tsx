"use client";

import React, {
  useRef, useState, useEffect, useMemo, Suspense, useCallback, createContext, useContext,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Html, ContactShadows, Environment, Grid, Line } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, ChromaticAberration, DepthOfField, ToneMapping } from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import toast from "react-hot-toast";
import { describeError } from "@/lib/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode  = "iso" | "fp";
type UnitKey   = "ft" | "in" | "m" | "cm";
type StyleMode = "photo" | "minimal" | "wireframe";

interface LayerState {
  foundation: boolean; framing: boolean; electrical: boolean;
  plumbing: boolean; drywall: boolean; roof: boolean;
}
interface Annotation   { id: number; x: number; z: number; text: string }
interface SelectedObject { type: "room"|"wall"|"door"|"window"|"electrical"|"plumbing"; data: any }

interface SceneRoom      { name: string; x: number; z: number; width: number; depth: number; floor_type: string; sqft: number }
interface SceneWall      { x1: number; z1: number; x2: number; z2: number; thickness: number; type: "exterior"|"interior" }
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
const UNIT_LABELS:   Record<UnitKey,string> = { ft:"Feet", in:"Inches", m:"Meters", cm:"Centimeters" };
const UNIT_FACTORS:  Record<UnitKey,number> = { ft:1, in:12, m:0.3048, cm:30.48 };
const UNIT_SUFFIXES: Record<UnitKey,string> = { ft:"ft", in:"in", m:"m", cm:"cm" };

const FLOOR_COLORS: Record<string,{color:string;roughness:number;metalness:number}> = {
  hardwood:{ color:"#c4863a", roughness:0.48, metalness:0.02 },
  tile:    { color:"#d8d4c8", roughness:0.12, metalness:0.04 },
  carpet:  { color:"#9c96b4", roughness:0.98, metalness:0    },
  concrete:{ color:"#9e9e96", roughness:0.92, metalness:0.05 },
  vinyl:   { color:"#c4b892", roughness:0.65, metalness:0    },
  wood:    { color:"#c4863a", roughness:0.48, metalness:0.02 },
};

const ROOM_TINT = ["#cce0ff","#ccf0e0","#fff0cc","#ffccd8","#e8ccff","#ccf0f8","#ffd8c0","#ccf8e8"];

const LAYER_META: {key:keyof LayerState;label:string;color:string}[] = [
  {key:"foundation",label:"Foundation",color:"#9ca3af"},
  {key:"framing",   label:"Framing",   color:"#92400e"},
  {key:"electrical",label:"Electrical",color:"#fbbf24"},
  {key:"plumbing",  label:"Plumbing",  color:"#3b82f6"},
  {key:"drywall",   label:"Drywall",   color:"#e5e7eb"},
  {key:"roof",      label:"Roof",      color:"#6b7280"},
];

// ─── Procedural Textures ──────────────────────────────────────────────────────

const texCache: Record<string, THREE.CanvasTexture> = {};

function makeHardwoodTexture(): THREE.CanvasTexture {
  const S = 512, c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d")!;
  const ph = S / 7;
  ctx.fillStyle = "#c4863a"; ctx.fillRect(0,0,S,S);
  for (let row=0; row<8; row++) {
    const ox = row%2===0?0:S*0.5, y = row*ph;
    for (let col=-1; col<3; col++) {
      const x = col*(S*0.5)+ox, s = 0.82+Math.random()*0.18;
      ctx.fillStyle=`rgb(${~~(196*s)},${~~(134*s)},${~~(58*s)})`;
      ctx.fillRect(x+1.5,y+1.5,S*0.5-3,ph-3);
      ctx.strokeStyle="rgba(0,0,0,0.07)"; ctx.lineWidth=0.5;
      for (let g=1;g<5;g++){
        ctx.beginPath(); ctx.moveTo(x,y+ph*(g/5));
        ctx.bezierCurveTo(x+S*.15,y+ph*(g/5)+(Math.random()-.5)*3,x+S*.35,y+ph*(g/5)+(Math.random()-.5)*3,x+S*.5,y+ph*(g/5)+(Math.random()-.5)*3);
        ctx.stroke();
      }
      ctx.fillStyle="rgba(0,0,0,0.18)"; ctx.fillRect(x,y,S*0.5,2); ctx.fillRect(x,y,2,ph);
    }
  }
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.18,0.18); return t;
}

function makeTileTexture(): THREE.CanvasTexture {
  const S=512, c=document.createElement("canvas"); c.width=c.height=S;
  const ctx=c.getContext("2d")!, ts=S/4;
  ctx.fillStyle="#d8d4c8"; ctx.fillRect(0,0,S,S);
  for(let r=0;r<4;r++) for(let col=0;col<4;col++){
    const s=0.93+Math.random()*.07;
    ctx.fillStyle=`rgb(${~~(216*s)},${~~(212*s)},${~~(200*s)})`;
    ctx.fillRect(col*ts+3,r*ts+3,ts-6,ts-6);
    ctx.fillStyle=`rgba(255,255,255,${.04+Math.random()*.04})`;
    ctx.fillRect(col*ts+4,r*ts+4,ts*.35,ts*.25);
  }
  ctx.fillStyle="#b0ac9e";
  for(let i=0;i<=4;i++){ctx.fillRect(i*ts-2,0,4,S);ctx.fillRect(0,i*ts-2,S,4);}
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.14,0.14); return t;
}

function makeCarpetTexture(): THREE.CanvasTexture {
  const S=256, c=document.createElement("canvas"); c.width=c.height=S;
  const ctx=c.getContext("2d")!;
  ctx.fillStyle="#9c96b4"; ctx.fillRect(0,0,S,S);
  for(let i=0;i<3000;i++){
    const x=Math.random()*S,y=Math.random()*S,v=~~(Math.random()*40-20);
    ctx.fillStyle=`rgba(${Math.max(0,156+v)},${Math.max(0,150+v)},${Math.max(0,180+v)},0.35)`;
    ctx.fillRect(x,y,1.5,1.5);
  }
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.25,0.25); return t;
}

function makeWallTexture(): THREE.CanvasTexture {
  const S=512, c=document.createElement("canvas"); c.width=c.height=S;
  const ctx=c.getContext("2d")!;
  ctx.fillStyle="#f2ede6"; ctx.fillRect(0,0,S,S);
  // Subtle roller-paint horizontal streaks
  for(let y=0;y<S;y+=2){
    const a=0.008+Math.random()*0.012;
    ctx.fillStyle=`rgba(255,252,246,${a})`; ctx.fillRect(0,y,S,1);
  }
  // Fine noise
  const id=ctx.getImageData(0,0,S,S);
  for(let i=0;i<id.data.length;i+=4){
    const n=(Math.random()-.5)*5;
    id.data[i]=Math.max(0,Math.min(255,id.data[i]+n));
    id.data[i+1]=Math.max(0,Math.min(255,id.data[i+1]+n));
    id.data[i+2]=Math.max(0,Math.min(255,id.data[i+2]+n));
  }
  ctx.putImageData(id,0,0);
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.35,0.35); return t;
}

function makeCeilingTexture(): THREE.CanvasTexture {
  const S=512, c=document.createElement("canvas"); c.width=c.height=S;
  const ctx=c.getContext("2d")!;
  ctx.fillStyle="#f8f5f2"; ctx.fillRect(0,0,S,S);
  const id=ctx.getImageData(0,0,S,S);
  for(let i=0;i<id.data.length;i+=4){
    const n=(Math.random()-.5)*4;
    id.data[i]=Math.max(0,Math.min(255,id.data[i]+n));
    id.data[i+1]=Math.max(0,Math.min(255,id.data[i+1]+n));
    id.data[i+2]=Math.max(0,Math.min(255,id.data[i+2]+n));
  }
  ctx.putImageData(id,0,0);
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.25,0.25); return t;
}

function getFloorTex(type:string): THREE.CanvasTexture|null {
  if(typeof window==="undefined") return null;
  if(!texCache[type]){
    if(type==="hardwood"||type==="wood") texCache[type]=makeHardwoodTexture();
    else if(type==="tile")               texCache[type]=makeTileTexture();
    else if(type==="carpet")             texCache[type]=makeCarpetTexture();
    else return null;
  }
  return texCache[type];
}
function getWallTex(): THREE.CanvasTexture|null {
  if(typeof window==="undefined") return null;
  if(!texCache["wall"]) texCache["wall"]=makeWallTexture();
  return texCache["wall"];
}
function getCeilTex(): THREE.CanvasTexture|null {
  if(typeof window==="undefined") return null;
  if(!texCache["ceil"]) texCache["ceil"]=makeCeilingTexture();
  return texCache["ceil"];
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function projectOntoWall(px:number,pz:number,wall:SceneWall):number {
  const dx=wall.x2-wall.x1,dz=wall.z2-wall.z1,len=Math.sqrt(dx*dx+dz*dz);
  if(len<0.01) return 0;
  return ((px-wall.x1)*dx+(pz-wall.z1)*dz)/len;
}
function isOnWall(px:number,pz:number,wall:SceneWall,tol=2.5):boolean {
  const dx=wall.x2-wall.x1,dz=wall.z2-wall.z1,len=Math.sqrt(dx*dx+dz*dz);
  if(len<0.01) return false;
  const t=((px-wall.x1)*dx+(pz-wall.z1)*dz)/(len*len);
  if(t<-0.05||t>1.05) return false;
  return Math.sqrt((px-(wall.x1+t*dx))**2+(pz-(wall.z1+t*dz))**2)<tol;
}
function getRoomType(name:string):string {
  const n=name.toLowerCase();
  if(n.includes("living")||n.includes("lounge")||n.includes("family")) return "living";
  if(n.includes("kitchen"))                                              return "kitchen";
  if(n.includes("master")||n.includes("primary"))                       return "master";
  if(n.includes("bed"))                                                  return "bedroom";
  if(n.includes("bath"))                                                 return "bathroom";
  if(n.includes("dining"))                                               return "dining";
  if(n.includes("office")||n.includes("study"))                         return "office";
  if(n.includes("garage"))                                               return "garage";
  return "generic";
}

// ─── LOD wrapper ──────────────────────────────────────────────────────────────

function FurnitureLOD({ children, cx, cz, maxDist=55 }:{ children:React.ReactNode; cx:number; cz:number; maxDist?:number }) {
  const ref = useRef<THREE.Group>(null);
  const pos = useMemo(()=>new THREE.Vector3(cx,0,cz),[cx,cz]);
  const { camera } = useThree();
  useFrame(()=>{
    if(!ref.current) return;
    const show = camera.position.distanceTo(pos)<maxDist;
    if(ref.current.visible!==show) ref.current.visible=show;
  });
  return <group ref={ref}>{children}</group>;
}

// ─── Building components ──────────────────────────────────────────────────────

function Foundation({ rooms }:{ rooms:SceneRoom[] }) {
  if(!rooms.length) return null;
  let mnX=Infinity,mnZ=Infinity,mxX=-Infinity,mxZ=-Infinity;
  for(const r of rooms){mnX=Math.min(mnX,r.x);mnZ=Math.min(mnZ,r.z);mxX=Math.max(mxX,r.x+r.width);mxZ=Math.max(mxZ,r.z+r.depth);}
  return(
    <mesh receiveShadow position={[(mnX+mxX)/2,-0.18,(mnZ+mxZ)/2]} rotation={[-Math.PI/2,0,0]}>
      <planeGeometry args={[mxX-mnX+0.8,mxZ-mnZ+0.8]}/>
      <meshStandardMaterial color="#88867e" roughness={0.95} metalness={0.04}/>
    </mesh>
  );
}

function RoomFloor({ room, selected, onSelect }:{ room:SceneRoom; selected:boolean; onSelect:()=>void }) {
  const style=useContext(StyleCtx);
  const mat=FLOOR_COLORS[room.floor_type]??{color:"#c8b890",roughness:0.6,metalness:0};
  const tex=useMemo(()=>getFloorTex(room.floor_type),[room.floor_type]);
  return(
    <mesh receiveShadow position={[room.x+room.width/2,0.012,room.z+room.depth/2]} rotation={[-Math.PI/2,0,0]}
      onClick={e=>{e.stopPropagation();onSelect();}}>
      <planeGeometry args={[room.width-0.06,room.depth-0.06]}/>
      <meshStandardMaterial color={selected?"#fde68a":mat.color} roughness={mat.roughness} metalness={mat.metalness}
        map={style==="photo"&&!selected?(tex??undefined):undefined}
        wireframe={style==="wireframe"} emissive={selected?"#f59e0b":"#000"} emissiveIntensity={selected?0.10:0}/>
    </mesh>
  );
}

function RoomCeiling({ room, wallH }:{ room:SceneRoom; wallH:number }) {
  const style=useContext(StyleCtx);
  const tex=useMemo(()=>getCeilTex(),[]);
  return(
    <mesh receiveShadow position={[room.x+room.width/2,wallH-0.01,room.z+room.depth/2]} rotation={[Math.PI/2,0,0]}>
      <planeGeometry args={[room.width-0.06,room.depth-0.06]}/>
      <meshStandardMaterial color="#f7f4f0" roughness={0.94} metalness={0}
        map={style==="photo"?(tex??undefined):undefined} wireframe={style==="wireframe"}/>
    </mesh>
  );
}

function WallBox({ x1,z1,x2,z2,yBot,yTop,thickness,color,roughness=0.84,isWall=false,onClick }:{
  x1:number;z1:number;x2:number;z2:number;yBot:number;yTop:number;
  thickness:number;color:string;roughness?:number;isWall?:boolean;onClick?:()=>void;
}) {
  const style=useContext(StyleCtx);
  const tex=useMemo(()=>isWall&&style==="photo"?getWallTex():null,[isWall,style]);
  const len=Math.sqrt((x2-x1)**2+(z2-z1)**2);
  if(len<0.05) return null;
  const dx=(x2-x1)/len,dz=(z2-z1)/len;
  return(
    <mesh castShadow receiveShadow
      position={[(x1+x2)/2,yBot+(yTop-yBot)/2,(z1+z2)/2]}
      rotation={[0,-Math.atan2(dz,dx),0]}
      onClick={onClick?e=>{e.stopPropagation();onClick();}:undefined}>
      <boxGeometry args={[len,yTop-yBot,thickness]}/>
      <meshStandardMaterial color={color} roughness={roughness} metalness={0}
        map={tex??undefined} wireframe={style==="wireframe"}/>
    </mesh>
  );
}

function WallWithDoors({ wall, wallHeight, doors, color, onWallClick }:{
  wall:SceneWall; wallHeight:number; doors:SceneDoor[]; color:string; onWallClick?:()=>void;
}) {
  const len=Math.sqrt((wall.x2-wall.x1)**2+(wall.z2-wall.z1)**2);
  if(len<0.05) return null;
  const t=wall.thickness||(wall.type==="exterior"?0.5:0.33);
  const dirX=(wall.x2-wall.x1)/len, dirZ=(wall.z2-wall.z1)/len;
  const openings=doors
    .filter(d=>isOnWall(d.x,d.z,wall))
    .map(d=>{const pos=projectOntoWall(d.x,d.z,wall),hw=(d.width||3)/2;return{start:pos-hw,end:pos+hw,height:d.height||7};})
    .sort((a,b)=>a.start-b.start);
  const segs:{x1:number;z1:number;x2:number;z2:number;yBot:number;yTop:number}[]=[];
  let cur=0;
  for(const op of openings){
    if(op.start>cur+0.1) segs.push({x1:wall.x1+dirX*cur,z1:wall.z1+dirZ*cur,x2:wall.x1+dirX*op.start,z2:wall.z1+dirZ*op.start,yBot:0,yTop:wallHeight});
    if(op.height<wallHeight-0.1) segs.push({x1:wall.x1+dirX*op.start,z1:wall.z1+dirZ*op.start,x2:wall.x1+dirX*op.end,z2:wall.z1+dirZ*op.end,yBot:op.height,yTop:wallHeight});
    cur=op.end;
  }
  if(cur<len-0.1) segs.push({x1:wall.x1+dirX*cur,z1:wall.z1+dirZ*cur,x2:wall.x2,z2:wall.z2,yBot:0,yTop:wallHeight});
  return(
    <>
      {segs.map((s,i)=>(
        <React.Fragment key={i}>
          {/* Main wall segment */}
          <WallBox {...s} thickness={t} color={color} roughness={0.84} isWall onClick={onWallClick}/>
          {/* Baseboard trim — dark stained wood */}
          <WallBox x1={s.x1} z1={s.z1} x2={s.x2} z2={s.z2} yBot={0} yTop={0.35} thickness={t+0.06} color="#4a2e14" roughness={0.38}/>
          {/* Crown molding — bright white */}
          <WallBox x1={s.x1} z1={s.z1} x2={s.x2} z2={s.z2} yBot={wallHeight-0.3} yTop={wallHeight} thickness={t+0.05} color="#f0ece4" roughness={0.7}/>
        </React.Fragment>
      ))}
    </>
  );
}

// ─── Door with frame ──────────────────────────────────────────────────────────

function DoorWithFrame({ door, walls, wallHeight, onSelect }:{ door:SceneDoor; walls:SceneWall[]; wallHeight:number; onSelect?:()=>void }) {
  const wall=walls.find(w=>isOnWall(door.x,door.z,w,3));
  if(!wall) return null;
  const len=Math.sqrt((wall.x2-wall.x1)**2+(wall.z2-wall.z1)**2);
  if(len<0.01) return null;
  const dx=(wall.x2-wall.x1)/len,dz=(wall.z2-wall.z1)/len;
  const pos=projectOntoWall(door.x,door.z,wall);
  const t=(wall.thickness||0.5);
  const dH=door.height||7, dW=door.width||3;
  const angle=-Math.atan2(dz,dx);
  const cx=wall.x1+dx*pos, cz=wall.z1+dz*pos;
  const fc="#ede8e0", dc="#b8925a";
  const fw=0.14;
  return(
    <group position={[cx,0,cz]} rotation={[0,angle,0]}
      onClick={onSelect?e=>{e.stopPropagation();onSelect();}:undefined}>
      {/* Left jamb */}
      <mesh castShadow position={[-(dW/2+fw/2),dH/2,0]}>
        <boxGeometry args={[fw,dH+fw,t+0.06]}/><meshStandardMaterial color={fc} roughness={0.68}/>
      </mesh>
      {/* Right jamb */}
      <mesh castShadow position={[(dW/2+fw/2),dH/2,0]}>
        <boxGeometry args={[fw,dH+fw,t+0.06]}/><meshStandardMaterial color={fc} roughness={0.68}/>
      </mesh>
      {/* Header */}
      <mesh castShadow position={[0,dH+fw/2,0]}>
        <boxGeometry args={[dW+fw*2,fw,t+0.06]}/><meshStandardMaterial color={fc} roughness={0.68}/>
      </mesh>
      {/* Door panel — slightly ajar */}
      <mesh castShadow position={[-dW/2+dW*0.05,dH/2,t*0.3]} rotation={[0,-0.22,0]}>
        <boxGeometry args={[dW-0.06,dH-0.06,0.11]}/><meshStandardMaterial color={dc} roughness={0.48} metalness={0.02}/>
      </mesh>
      {/* Door panel inset detail */}
      <mesh position={[-dW/2+dW*0.05,dH*0.65,t*0.3+0.06]} rotation={[0,-0.22,0]}>
        <boxGeometry args={[dW*0.75,dH*0.3,0.02]}/><meshStandardMaterial color="#a07840" roughness={0.5}/>
      </mesh>
      <mesh position={[-dW/2+dW*0.05,dH*0.28,t*0.3+0.06]} rotation={[0,-0.22,0]}>
        <boxGeometry args={[dW*0.75,dH*0.32,0.02]}/><meshStandardMaterial color="#a07840" roughness={0.5}/>
      </mesh>
      {/* Door handle — brass knob */}
      <mesh castShadow position={[dW*0.25,dH*0.47,t*0.35]}>
        <sphereGeometry args={[0.11,10,10]}/><meshStandardMaterial color="#c8a030" roughness={0.12} metalness={0.82}/>
      </mesh>
      <mesh position={[dW*0.25,dH*0.47,t*0.35-0.16]}>
        <cylinderGeometry args={[0.04,0.04,0.32,8]}/><meshStandardMaterial color="#b89020" roughness={0.15} metalness={0.8}/>
      </mesh>
    </group>
  );
}

// ─── Window with frame ────────────────────────────────────────────────────────

function WindowWithFrame({ win, walls, onSelect }:{ win:SceneWindow; walls:SceneWall[]; onSelect?:()=>void }) {
  const wall=walls.find(w=>isOnWall(win.x,win.z,w,3));
  if(!wall) return null;
  const len=Math.sqrt((wall.x2-wall.x1)**2+(wall.z2-wall.z1)**2);
  if(len<0.01) return null;
  const dx=(wall.x2-wall.x1)/len,dz=(wall.z2-wall.z1)/len;
  const pos=projectOntoWall(win.x,win.z,wall);
  const t=(wall.thickness||0.5);
  const sill=win.sill_height||2.5, wH=win.height||3.5, wW=win.width||3;
  const angle=-Math.atan2(dz,dx);
  const cx=wall.x1+dx*pos, cz=wall.z1+dz*pos;
  const fc="#f0ece4", fw=0.12;
  return(
    <group position={[cx,sill,cz]} rotation={[0,angle,0]}
      onClick={onSelect?e=>{e.stopPropagation();onSelect();}:undefined}>
      {/* Outer frame — 4 sides */}
      <mesh castShadow position={[-(wW/2+fw/2),wH/2,0]}><boxGeometry args={[fw,wH+fw*2,t+0.04]}/><meshStandardMaterial color={fc} roughness={0.65}/></mesh>
      <mesh castShadow position={[(wW/2+fw/2),wH/2,0]}><boxGeometry args={[fw,wH+fw*2,t+0.04]}/><meshStandardMaterial color={fc} roughness={0.65}/></mesh>
      <mesh castShadow position={[0,wH+fw/2,0]}><boxGeometry args={[wW+fw*2,fw,t+0.04]}/><meshStandardMaterial color={fc} roughness={0.65}/></mesh>
      <mesh castShadow position={[0,-fw/2,0]}><boxGeometry args={[wW+fw*2,fw,t+0.04]}/><meshStandardMaterial color={fc} roughness={0.65}/></mesh>
      {/* Mullions (horizontal + vertical) */}
      <mesh position={[0,wH/2,0]}><boxGeometry args={[wW,fw*0.8,t+0.04]}/><meshStandardMaterial color={fc} roughness={0.65}/></mesh>
      <mesh position={[0,wH/2,0]}><boxGeometry args={[fw*0.8,wH,t+0.04]}/><meshStandardMaterial color={fc} roughness={0.65}/></mesh>
      {/* 4 glass panes */}
      {([[-wW/4,wH*3/4],[wW/4,wH*3/4],[-wW/4,wH/4],[wW/4,wH/4]] as [number,number][]).map(([gx,gy],i)=>(
        <mesh key={i} position={[gx,gy,0]}>
          <planeGeometry args={[wW/2-fw*0.9,wH/2-fw*0.9]}/>
          <meshStandardMaterial color="#b8d8f0" transparent opacity={0.38} roughness={0.02} metalness={0.12} side={THREE.DoubleSide}/>
        </mesh>
      ))}
      {/* Interior window sill ledge */}
      <mesh receiveShadow position={[0,-0.08,0.45]}>
        <boxGeometry args={[wW+fw*2,0.08,0.7]}/><meshStandardMaterial color="#e8e0d0" roughness={0.45}/>
      </mesh>
    </group>
  );
}

// ─── Window light shaft ───────────────────────────────────────────────────────

function WindowLightShaft({ win,walls,cx,cz }:{ win:SceneWindow; walls:SceneWall[]; cx:number; cz:number }) {
  const style=useContext(StyleCtx);
  if(style!=="photo") return null;
  const wall=walls.find(w=>isOnWall(win.x,win.z,w,3));
  if(!wall) return null;
  const len=Math.sqrt((wall.x2-wall.x1)**2+(wall.z2-wall.z1)**2);
  if(len<0.01) return null;
  const dx=(wall.x2-wall.x1)/len,dz=(wall.z2-wall.z1)/len;
  const nx=-dz,nz=dx;
  const dot=nx*(cx-win.x)+nz*(cz-win.z);
  const inX=dot>0?nx:-nx,inZ=dot>0?nz:-nz;
  const pos=projectOntoWall(win.x,win.z,wall);
  const sill=win.sill_height||2.5,wH=win.height||3.5,sl=9;
  const px=wall.x1+dx*pos+inX*sl*0.5,pz=wall.z1+dz*pos+inZ*sl*0.5;
  const ry=-Math.atan2(inZ,inX)+Math.PI/2;
  return(
    <mesh position={[px,sill+wH*0.45,pz]} rotation={[0,ry,0]}>
      <boxGeometry args={[sl,wH*0.82,win.width||3]}/>
      <meshStandardMaterial color="#fff8d0" transparent opacity={0.028} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending}/>
    </mesh>
  );
}

// ─── Ceiling light fixture ────────────────────────────────────────────────────

function CeilingLightFixture({ el }:{ el:SceneElectrical }) {
  const style=useContext(StyleCtx);
  if(el.type!=="ceiling_light"&&el.type!=="ceiling_fan") return null;
  const y=8.75;
  return(
    <group position={[el.x,y,el.z]}>
      {/* Canopy plate */}
      <mesh><cylinderGeometry args={[0.22,0.22,0.06,16]}/><meshStandardMaterial color="#c8c4be" roughness={0.28} metalness={0.5}/></mesh>
      {/* Housing cone */}
      <mesh position={[0,-0.2,0]}>
        <coneGeometry args={[0.2,0.22,16,1,true]}/>
        <meshStandardMaterial color="#1a1a1a" roughness={0.25} metalness={0.55} side={THREE.BackSide}/>
      </mesh>
      {/* Bulb glow sphere */}
      <mesh position={[0,-0.3,0]}>
        <sphereGeometry args={[0.09,12,12]}/>
        <meshStandardMaterial color="#fff8e0" emissive="#ffee44" emissiveIntensity={style==="photo"?2.5:0.5} roughness={0.2}/>
      </mesh>
      {/* Light source */}
      {style==="photo"&&(
        <pointLight position={[0,-0.5,0]} intensity={55} color="#fff5c0" distance={15} decay={2} castShadow={false}/>
      )}
    </group>
  );
}

function ElectricalMarker({ el }:{ el:SceneElectrical }) {
  if(el.type==="ceiling_light"||el.type==="ceiling_fan") return null;
  const y=4.0;
  const cfg:Record<string,{color:string;emissive:string;intensity:number}>={
    panel: {color:"#94a3b8",emissive:"#000",intensity:0},
    outlet:{color:"#fbbf24",emissive:"#f59e0b",intensity:0.4},
    switch:{color:"#f1f5f9",emissive:"#000",intensity:0},
  };
  const c=cfg[el.type]??cfg.outlet;
  return(
    <mesh position={[el.x,y,el.z]}>
      <boxGeometry args={[0.22,0.22,0.12]}/>
      <meshStandardMaterial color={c.color} emissive={c.emissive} emissiveIntensity={c.intensity} roughness={0.35}/>
    </mesh>
  );
}

function PlumbingFixture({ pl, onSelect }:{ pl:ScenePlumbing; onSelect?:()=>void }) {
  const style=useContext(StyleCtx);
  const size:[number,number,number]=
    pl.type==="toilet"       ?[1.8,0.4,2.5]:
    pl.type==="bathtub"      ?[3.0,0.5,6.0]:
    pl.type==="shower"       ?[3.0,0.2,3.0]:
    pl.type==="water_heater" ?[1.4,4.5,1.4]:[1.6,0.35,1.6];
  return(
    <mesh castShadow receiveShadow position={[pl.x,size[1]/2,pl.z]} rotation={[0,pl.rotation*(Math.PI/180),0]}
      onClick={onSelect?e=>{e.stopPropagation();onSelect();}:undefined}>
      <boxGeometry args={size}/>
      <meshStandardMaterial color="#7ecaef" roughness={0.22} metalness={0.28} wireframe={style==="wireframe"}/>
    </mesh>
  );
}

// ─── Furniture ────────────────────────────────────────────────────────────────

function B({ p,s,c,r=0.7,m=0 }:{ p:[number,number,number];s:[number,number,number];c:string;r?:number;m?:number }) {
  return(
    <mesh castShadow receiveShadow position={p}>
      <boxGeometry args={s}/><meshStandardMaterial color={c} roughness={r} metalness={m}/>
    </mesh>
  );
}
function Cyl({ p,ra,rb,h,seg=12,c,r=0.4,m=0,rot }:{ p:[number,number,number];ra:number;rb:number;h:number;seg?:number;c:string;r?:number;m?:number;rot?:[number,number,number] }) {
  return(
    <mesh castShadow position={p} rotation={rot??[0,0,0]}>
      <cylinderGeometry args={[ra,rb,h,seg]}/><meshStandardMaterial color={c} roughness={r} metalness={m}/>
    </mesh>
  );
}
function Cone({ p,ra,h,seg=12,c,r=0.5,m=0 }:{ p:[number,number,number];ra:number;h:number;seg?:number;c:string;r?:number;m?:number }) {
  return(
    <mesh position={p}><coneGeometry args={[ra,h,seg]}/><meshStandardMaterial color={c} roughness={r} metalness={m} side={THREE.DoubleSide}/></mesh>
  );
}

function LivingRoomFurniture({ room }:{ room:SceneRoom }) {
  const {x,z,width,depth}=room;
  const m=1.0, sW=Math.min(width-m*2,7), sX=x+width/2, sZ=z+depth-m-1.5, tvW=Math.min(width-m*2,5.5);
  return(
    <>
      {/* Sofa base */}
      <B p={[sX,0.9,sZ]} s={[sW,1.8,3.0]} c="#7a6a5a" r={0.92}/>
      {/* Sofa cushion segments */}
      {([-1,0,1] as number[]).map(o=><B key={o} p={[sX+o*(sW/3-.05),1.55,sZ-.3]} s={[sW/3-.18,0.55,2.1]} c="#8a7a68" r={0.9}/>)}
      {/* Sofa back */}
      <B p={[sX,2.4,sZ+1.1]} s={[sW,1.5,0.62]} c="#7a6a5a" r={0.92}/>
      {/* Back cushions */}
      {([-1,0,1] as number[]).map(o=><B key={o} p={[sX+o*(sW/3-.05),2.4,sZ+.9]} s={[sW/3-.18,1.2,.5]} c="#8a7a68" r={0.9}/>)}
      {/* Armrests */}
      <B p={[sX-sW/2+.26,1.8,sZ]} s={[.52,2.5,3.0]} c="#6a5a4a" r={0.92}/>
      <B p={[sX+sW/2-.26,1.8,sZ]} s={[.52,2.5,3.0]} c="#6a5a4a" r={0.92}/>
      {/* Coffee table top */}
      <B p={[sX,1.48,sZ-3.2]} s={[Math.min(sW*.62,4.6),.18,2.5]} c="#2c1a08" r={0.32} m={0.04}/>
      {/* Table legs — cylinders */}
      {([-1,1] as number[]).map(sx=>([-1,1] as number[]).map(sz=>(
        <Cyl key={`${sx}${sz}`} p={[sX+sx*1.55,.72,sZ-3.2+sz*.95]} ra={.07} rb={.07} h={1.44} c="#1e0e04" r={0.4}/>
      )))}
      {/* TV unit */}
      <B p={[sX,1.2,z+m+.36]} s={[tvW,2.4,.6]} c="#1a1a1a" r={0.22} m={0.15}/>
      {/* TV screen */}
      <B p={[sX,1.8,z+m+.05]} s={[tvW-.28,1.82,.06]} c="#050510" r={0.04} m={0.18}/>
      {/* TV screen gleam */}
      <B p={[sX+tvW*.12,1.95,z+m+.03]} s={[tvW*.22,.7,.02]} c="#1a1a3a" r={0.02} m={0.2}/>
      {/* Floor lamp */}
      <Cyl p={[x+m+.5,4.2,sZ-1.2]} ra={.05} rb={.05} h={8.4} c="#888" r={0.2} m={0.6}/>
      <Cone p={[x+m+.5,8.8,sZ-1.2]} ra={0.7} h={0.9} c="#f5e8c0" r={0.6}/>
      <pointLight position={[x+m+.5,8.2,sZ-1.2]} intensity={12} color="#ffeecc" distance={10} decay={2}/>
    </>
  );
}

function KitchenFurniture({ room }:{ room:SceneRoom }) {
  const {x,z,width,depth}=room;
  const m=.3, cH=3.5, cD=2.0;
  return(
    <>
      {/* Back counter */}
      <B p={[x+width/2,cH/2,z+depth-m-cD/2]} s={[width-m*2,cH,cD]} c="#d4c8b0" r={0.3} m={0.08}/>
      <B p={[x+width/2,cH+.1,z+depth-m-cD/2]} s={[width-m*2,.22,cD+.1]} c="#e8e0d0" r={0.12} m={0.06}/>
      {/* Left counter */}
      <B p={[x+m+cD/2,cH/2,z+depth/2]} s={[cD,cH,depth-4]} c="#d4c8b0" r={0.3} m={0.08}/>
      <B p={[x+m+cD/2,cH+.1,z+depth/2]} s={[cD+.1,.22,depth-4]} c="#e8e0d0" r={0.12} m={0.06}/>
      {/* Cabinet door faces */}
      {([0,1,2,3] as number[]).map(i=>(
        <B key={i} p={[x+width/2,0.85+i*cH/4,z+depth-m-cD-.02]} s={[(width-m*2-0.2)/2,.8,.04]} c="#c8bc9c" r={0.35}/>
      ))}
      {/* Island */}
      {width>10&&depth>12&&<>
        <B p={[x+width/2,cH*.7,z+depth/2]} s={[4,cH*.7,2.5]} c="#c8bca8" r={0.35} m={0.06}/>
        <B p={[x+width/2,cH*.7+.1,z+depth/2]} s={[4.1,.2,2.6]} c="#e0d8c8" r={0.1} m={0.06}/>
      </>}
      {/* Refrigerator */}
      <B p={[x+width-m-1.0,4.5,z+depth-m-1.2]} s={[2.0,9,2.4]} c="#d8d8d8" r={0.14} m={0.32}/>
      <B p={[x+width-m-1.0,4.9,z+depth-m-.02]} s={[1.82,4.2,.04]} c="#c8c8c8" r={0.18} m={0.28}/>
      {/* Handle */}
      <Cyl p={[x+width-m-1.3,5.5,z+depth-m+.15]} ra={.04} rb={.04} h={1.4} c="#aaa" r={0.15} m={0.7} rot={[0,0,Math.PI/2]}/>
    </>
  );
}

function BedroomFurniture({ room, isMaster }:{ room:SceneRoom; isMaster:boolean }) {
  const {x,z,width,depth}=room;
  const m=.8, bW=isMaster?6.0:4.5, bL=isMaster?7.5:6.5;
  const bX=x+width/2, bZ=z+depth-m-bL/2, nW=1.5;
  const fc="#3a2010";
  return(
    <>
      {/* Bed frame */}
      <B p={[bX,.5,bZ]} s={[bW+.6,1.0,bL+.6]} c={fc} r={0.55}/>
      {/* Headboard */}
      <B p={[bX,3.0,bZ+bL/2+.12]} s={[bW+.4,5.2,.32]} c={fc} r={0.5}/>
      {([-1,0,1] as number[]).map(o=>(
        <B key={o} p={[bX+o*bW/3,2.8,bZ+bL/2+.06]} s={[bW/3-.25,4.5,.08]} c="#4a2e18" r={0.48}/>
      ))}
      {/* Mattress */}
      <B p={[bX,1.3,bZ]} s={[bW,.65,bL]} c="#f0ece4" r={0.88}/>
      <B p={[bX,1.6,bZ]} s={[bW,.08,bL]} c="#e0dcd4" r={0.9}/>
      {/* Duvet */}
      <B p={[bX,1.78,bZ-bL*.1]} s={[bW-.1,.28,bL*.8]} c="#e8e4f0" r={0.92}/>
      <B p={[bX,1.7,bZ-bL*.48]} s={[bW-.1,.16,bL*.08]} c="#d8d4e8" r={0.92}/>
      {/* Pillows */}
      {(isMaster?[[-bW/4,0],[bW/4,0]]:[[0,0]]).map(([ox],i)=>(
        <B key={i} p={[bX+ox,2.05,bZ+bL/2-1.2]} s={[isMaster?bW/2-.3:bW-.6,.55,1.3]} c="#f5f2ee" r={0.95}/>
      ))}
      {/* Nightstands + lamps */}
      {([[-1,isMaster?1:0]] as [number,number][]).filter(()=>true).map(([side],i)=>{
        const nx2=bX+side*(bW/2+nW/2+.15);
        return(
          <React.Fragment key={i}>
            <B p={[nx2,1.55,bZ+bL/4]} s={[nW,3.1,nW]} c="#4a2e18" r={0.5}/>
            <B p={[nx2,1.28,bZ+bL/4+nW/2-.02]} s={[nW-.15,.5,.04]} c="#3a2010" r={0.45}/>
            <Cyl p={[nx2,4.3,bZ+bL/4]} ra={.055} rb={.055} h={3.0} c="#888" r={0.2} m={0.65}/>
            <Cone p={[nx2,5.55,bZ+bL/4]} ra={0.52} h={0.85} c="#f0e8d0" r={0.6}/>
            <pointLight position={[nx2,4.85,bZ+bL/4]} intensity={10} color="#ffeecc" distance={8} decay={2}/>
          </React.Fragment>
        );
      })}
      {isMaster&&(()=>{const nx2=bX+bW/2+nW/2+.15;return(
        <React.Fragment>
          <B p={[nx2,1.55,bZ+bL/4]} s={[nW,3.1,nW]} c="#4a2e18" r={0.5}/>
          <Cyl p={[nx2,4.3,bZ+bL/4]} ra={.055} rb={.055} h={3.0} c="#888" r={0.2} m={0.65}/>
          <Cone p={[nx2,5.55,bZ+bL/4]} ra={0.52} h={0.85} c="#f0e8d0" r={0.6}/>
          <pointLight position={[nx2,4.85,bZ+bL/4]} intensity={10} color="#ffeecc" distance={8} decay={2}/>
        </React.Fragment>
      );})()}
      {/* Dresser */}
      <B p={[x+m+2.0,2.2,z+m+.9]} s={[4.0,4.4,1.4]} c="#4a2e18" r={0.5}/>
      {([0,1,2] as number[]).map(row=><B key={row} p={[x+m+2.0,.9+row*1.2,z+m+.92+.72/2]} s={[3.7,1.0,.06]} c="#3a2010" r={0.45}/>)}
      {/* Mirror above dresser */}
      <B p={[x+m+2.0,7.5,z+m+.6]} s={[2.8,4.0,.07]} c="#c8d8e8" r={0.02} m={0.15}/>
      <B p={[x+m+2.0,7.5,z+m+.56]} s={[3.1,4.3,.06]} c="#8a6a40" r={0.5}/>
    </>
  );
}

function DiningFurniture({ room }:{ room:SceneRoom }) {
  const {x,z,width,depth}=room;
  const tW=Math.min(width-3,6),tL=Math.min(depth-3,4.5),tx=x+width/2,tz=z+depth/2,ch=tW>4?3:2;
  return(
    <>
      <B p={[tx,2.9,tz]} s={[tW,.2,tL]} c="#3c1e08" r={0.35} m={0.04}/>
      {([-1,-1,-1,1,1,-1,1,1] as number[]).reduce((a,_,i,arr)=>i%2===0?[...a,[arr[i],arr[i+1]]]:a,[] as number[][]).map(([sx,sz],i)=>(
        <Cyl key={i} p={[tx+sx*(tW/2-.4),1.5,tz+sz*(tL/2-.4)]} ra={.08} rb={.08} h={3.0} c="#2a1208" r={0.45}/>
      ))}
      {([-1,1] as number[]).map(side=>Array.from({length:ch}).map((_,i)=>{
        const cx2=tx+(tW/2+1.1)*side,cz2=tz+(i-(ch-1)/2)*2;
        return(
          <React.Fragment key={`${side}_${i}`}>
            <B p={[cx2,1.4,cz2]} s={[1.8,2.8,1.8]} c="#8a7060" r={0.88}/>
            <B p={[cx2,4.5,cz2+side*.65]} s={[1.8,3.0,.22]} c="#8a7060" r={0.88}/>
            {/* Chair legs */}
            {([-1,1] as number[]).map(lx=>([-1,1] as number[]).map(lz=>(
              <Cyl key={`${lx}${lz}`} p={[cx2+lx*.7,.7,cz2+lz*.7]} ra={.06} rb={.06} h={1.4} c="#6a5040" r={0.5}/>
            )))}
          </React.Fragment>
        );
      }))}
    </>
  );
}

function OfficeFurniture({ room }:{ room:SceneRoom }) {
  const {x,z}=room; const m=.5;
  return(
    <>
      <B p={[x+m+2.5,2.8,z+m+1.0]} s={[5,.22,2.0]} c="#c8b898" r={0.32} m={0.05}/>
      <B p={[x+m+.9,2.8,z+m+2.7]} s={[1.8,.22,3.4]} c="#c8b898" r={0.32} m={0.05}/>
      <B p={[x+m+2.5,1.4,z+m+1.0]} s={[4.8,2.8,1.8]} c="#b8a888" r={0.5}/>
      <B p={[x+m+2.5,4.5,z+m+.4]} s={[2.4,1.8,.12]} c="#111" r={0.06} m={0.3}/>
      <B p={[x+m+2.5,3.3,z+m+.45]} s={[.3,.9,.1]} c="#222" r={0.2} m={0.3}/>
      {/* Chair */}
      <B p={[x+m+2.5,1.8,z+m+3.0]} s={[2.2,2.2,2.2]} c="#2a2a2a" r={0.7}/>
      <B p={[x+m+2.5,3.8,z+m+3.8]} s={[2.1,3.4,.22]} c="#1a1a1a" r={0.7}/>
      {([-1,1] as number[]).map(sx=>([-1,1] as number[]).map(sz=>(
        <Cyl key={`${sx}${sz}`} p={[x+m+2.5+sx*.8,.6,z+m+3.0+sz*.8]} ra={.06} rb={.06} h={1.2} c="#1a1a1a" r={0.4} m={0.4}/>
      )))}
    </>
  );
}

function GarageFurniture({ room }:{ room:SceneRoom }) {
  const {x,z,width,depth}=room;
  const cW=Math.min(width-2,7.5),cL=Math.min(depth-3,14);
  return(
    <>
      <B p={[x+width/2,1.8,z+depth/2+1]} s={[cW,3.6,cL]} c="#3a5a8a" r={0.25} m={0.35}/>
      <B p={[x+width/2,3.9,z+depth/2+.5]} s={[cW-1.5,2.0,cL*.55]} c="#3a5a8a" r={0.2} m={0.35}/>
      <B p={[x+width/2,3.5,z+depth/2-cL*.19]} s={[cW-1.5,1.8,.1]} c="#a8cce8" r={0.04} m={0.2}/>
      {/* Wheels */}
      {([-1,1] as number[]).map(sx=>([-1,1] as number[]).map(sz=>(
        <Cyl key={`${sx}${sz}`} p={[x+width/2+sx*(cW/2-.4),.55,z+depth/2+sz*(cL/2-1.5)]} ra={.55} rb={.55} h={.35} c="#1a1a1a" r={0.9} rot={[0,0,Math.PI/2]}/>
      )))}
      <B p={[x+1.2,3.0,z+1.0]} s={[2.4,6.0,.5]} c="#8a6a40" r={0.6}/>
    </>
  );
}

function RoomFurniture({ room }:{ room:SceneRoom }) {
  const type=getRoomType(room.name);
  if(room.width<6||room.depth<6) return null;
  return(
    <FurnitureLOD cx={room.x+room.width/2} cz={room.z+room.depth/2}>
      {type==="living"  &&<LivingRoomFurniture room={room}/>}
      {type==="kitchen" &&<KitchenFurniture room={room}/>}
      {type==="master"  &&<BedroomFurniture room={room} isMaster/>}
      {type==="bedroom" &&<BedroomFurniture room={room} isMaster={false}/>}
      {type==="dining"  &&<DiningFurniture room={room}/>}
      {type==="office"  &&<OfficeFurniture room={room}/>}
      {(type==="garage"&&room.width>12&&room.depth>16)&&<GarageFurniture room={room}/>}
    </FurnitureLOD>
  );
}

// ─── Labels ───────────────────────────────────────────────────────────────────

function RoomLabel({ room,wallH,unit }:{ room:SceneRoom; wallH:number; unit:UnitKey }) {
  const suf=UNIT_SUFFIXES[unit], fac=UNIT_FACTORS[unit];
  const txt=room.sqft?`${Math.round(room.sqft).toLocaleString()} sqft`:`${(room.width*fac).toFixed(0)}×${(room.depth*fac).toFixed(0)} ${suf}`;
  return(
    <Html position={[room.x+room.width/2,wallH+1.0,room.z+room.depth/2]} center style={{pointerEvents:"none",userSelect:"none"}}>
      <div style={{background:"rgba(255,255,255,0.93)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",border:"1px solid rgba(0,0,0,0.07)",borderRadius:8,padding:"4px 10px 5px",fontSize:11,fontWeight:700,color:"#1e293b",textAlign:"center",whiteSpace:"nowrap",boxShadow:"0 2px 12px rgba(0,0,0,0.13)",fontFamily:"system-ui,sans-serif",lineHeight:1.4}}>
        {room.name}
        <div style={{fontSize:9,fontWeight:400,color:"#64748b",marginTop:1}}>{txt}</div>
      </div>
    </Html>
  );
}

function AnnotationPin({ ann,wallH }:{ ann:Annotation; wallH:number }) {
  return(
    <>
      <mesh position={[ann.x,wallH*.4,ann.z]}><sphereGeometry args={[0.28,14,14]}/><meshStandardMaterial color="#7c3aed" emissive="#7c3aed" emissiveIntensity={0.5} roughness={0.3}/></mesh>
      <Html position={[ann.x,wallH*.62,ann.z]} center style={{pointerEvents:"none"}}>
        <div style={{background:"rgba(124,58,237,0.9)",color:"#fff",borderRadius:7,padding:"3px 9px",fontSize:10,fontWeight:600,whiteSpace:"nowrap",boxShadow:"0 2px 8px rgba(0,0,0,0.2)"}}>{ann.text}</div>
      </Html>
    </>
  );
}

// ─── Dimension overlays ───────────────────────────────────────────────────────

function DimensionOverlays({ walls,rooms,wallH,unit }:{ walls:SceneWall[]; rooms:SceneRoom[]; wallH:number; unit:UnitKey }) {
  const fac=UNIT_FACTORS[unit], suf=UNIT_SUFFIXES[unit];
  return(
    <>
      {walls.filter(w=>w.type==="exterior").map((wall,i)=>{
        const len=Math.sqrt((wall.x2-wall.x1)**2+(wall.z2-wall.z1)**2);
        if(len<3) return null;
        return(
          <Html key={i} position={[(wall.x1+wall.x2)/2,wallH+.65,(wall.z1+wall.z2)/2]} center style={{pointerEvents:"none"}}>
            <div style={{background:"rgba(15,23,42,0.84)",color:"#fbbf24",padding:"2px 8px",borderRadius:6,fontSize:10,fontWeight:700,whiteSpace:"nowrap",backdropFilter:"blur(4px)"}}>
              {(len*fac).toFixed(1)}{suf}
            </div>
          </Html>
        );
      })}
      {rooms.map((r,i)=>(
        <Html key={`r${i}`} position={[r.x+r.width/2,wallH+1.6,r.z+r.depth/2]} center style={{pointerEvents:"none"}}>
          <div style={{background:"rgba(15,23,42,0.7)",color:"#bfdbfe",padding:"1px 7px",borderRadius:5,fontSize:9,fontWeight:600,whiteSpace:"nowrap"}}>
            {(r.width*fac).toFixed(1)}×{(r.depth*fac).toFixed(1)} {suf}
          </div>
        </Html>
      ))}
    </>
  );
}

// ─── Measurement tool ─────────────────────────────────────────────────────────

function MeasureFloor({ active,points,onPoint,bw,bd }:{ active:boolean; points:THREE.Vector3[]; onPoint:(p:THREE.Vector3)=>void; bw:number; bd:number }) {
  const handleClick=useCallback((e:any)=>{ if(!active) return; e.stopPropagation(); onPoint(e.point.clone()); },[active,onPoint]);
  const dist=points.length===2?points[0].distanceTo(points[1]):null;
  return(
    <>
      <mesh rotation={[-Math.PI/2,0,0]} position={[bw/2,.05,bd/2]} onClick={handleClick}>
        <planeGeometry args={[bw+60,bd+60]}/><meshStandardMaterial visible={false}/>
      </mesh>
      {points.length>=1&&<mesh position={[points[0].x,.2,points[0].z]}><sphereGeometry args={[.35,12,12]}/><meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.8}/></mesh>}
      {points.length>=2&&(
        <>
          <mesh position={[points[1].x,.2,points[1].z]}><sphereGeometry args={[.35,12,12]}/><meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.8}/></mesh>
          <Line points={[[points[0].x,.12,points[0].z],[points[1].x,.12,points[1].z]]} color="#f59e0b" lineWidth={2.5}/>
          <Html position={[(points[0].x+points[1].x)/2,1.4,(points[0].z+points[1].z)/2]} center style={{pointerEvents:"none"}}>
            <div style={{background:"rgba(0,0,0,0.88)",color:"#fbbf24",padding:"4px 12px",borderRadius:8,fontSize:13,fontWeight:800,whiteSpace:"nowrap",boxShadow:"0 2px 10px rgba(0,0,0,0.4)"}}>
              {dist!.toFixed(2)} ft
            </div>
          </Html>
        </>
      )}
    </>
  );
}

// ─── Fallback rooms ───────────────────────────────────────────────────────────

function FallbackRoom({ room,layers,wallH }:{ room:PlacedRoom; layers:LayerState; wallH:number }) {
  const fc=ROOM_TINT[room.colorIdx%ROOM_TINT.length];
  return(
    <>
      {layers.foundation&&<mesh receiveShadow position={[room.x+room.w/2,-.18,room.z+room.h/2]} rotation={[-Math.PI/2,0,0]}><planeGeometry args={[room.w+.5,room.h+.5]}/><meshStandardMaterial color="#88867e" roughness={0.95}/></mesh>}
      {layers.drywall&&<mesh receiveShadow position={[room.x+room.w/2,.012,room.z+room.h/2]} rotation={[-Math.PI/2,0,0]}><planeGeometry args={[room.w,room.h]}/><meshStandardMaterial color={fc} roughness={0.7}/></mesh>}
      {(layers.framing||layers.drywall)&&<>
        <WallBox x1={room.x} z1={room.z} x2={room.x+room.w} z2={room.z} yBot={0} yTop={wallH} thickness={.42} color={layers.drywall?"#f0ece4":"#b07040"}/>
        <WallBox x1={room.x} z1={room.z+room.h} x2={room.x+room.w} z2={room.z+room.h} yBot={0} yTop={wallH} thickness={.42} color={layers.drywall?"#f0ece4":"#b07040"}/>
        <WallBox x1={room.x} z1={room.z} x2={room.x} z2={room.z+room.h} yBot={0} yTop={wallH} thickness={.42} color={layers.drywall?"#ece8e0":"#8a5c2a"}/>
        <WallBox x1={room.x+room.w} z1={room.z} x2={room.x+room.w} z2={room.z+room.h} yBot={0} yTop={wallH} thickness={.42} color={layers.drywall?"#ece8e0":"#8a5c2a"}/>
      </>}
    </>
  );
}

// ─── Export triggers ──────────────────────────────────────────────────────────

function ScreenshotTrigger({ triggerRef }:{ triggerRef:React.MutableRefObject<(()=>void)|null> }) {
  const {gl,scene,camera}=useThree();
  useEffect(()=>{
    triggerRef.current=()=>{ gl.render(scene,camera); const a=document.createElement("a"); a.href=gl.domElement.toDataURL("image/png"); a.download="floorplan-3d.png"; a.click(); };
  },[gl,scene,camera,triggerRef]);
  return null;
}

function GLBExportTrigger({ triggerRef }:{ triggerRef:React.MutableRefObject<(()=>void)|null> }) {
  const {scene}=useThree();
  useEffect(()=>{
    triggerRef.current=async()=>{
      try{
        const {GLTFExporter}=await import("three/examples/jsm/exporters/GLTFExporter" as any);
        new GLTFExporter().parse(scene,(result:any)=>{
          const blob=new Blob([result as ArrayBuffer],{type:"model/gltf-binary"});
          const url=URL.createObjectURL(blob);
          const a=document.createElement("a"); a.href=url; a.download="floorplan.glb"; a.click();
          URL.revokeObjectURL(url);
        },(e:unknown)=>toast.error(`GLB export failed: ${describeError(e)}`),{binary:true});
      }catch(e){ toast.error(`GLB export failed: ${describeError(e)}`); }
    };
  },[scene,triggerRef]);
  return null;
}

// ─── Camera controllers ───────────────────────────────────────────────────────

function OverviewCameraSetup({ cx,cz,bw,bd }:{ cx:number; cz:number; bw:number; bd:number }) {
  const {camera}=useThree();
  useEffect(()=>{
    const dist=Math.max(bw,bd)*1.1+28;
    camera.position.set(cx+dist*.65,dist*.72,cz+dist*.65);
    (camera as THREE.PerspectiveCamera).fov=42;
    camera.updateProjectionMatrix();
  },[camera,cx,cz,bw,bd]);
  return null;
}

function WalkthroughCamera({ startX,startZ,onExit }:{ startX:number; startZ:number; onExit:()=>void }) {
  const {camera,gl}=useThree();
  const keys=useRef<Set<string>>(new Set());
  const md=useRef(false), lmx=useRef(0), yaw=useRef(0);
  useEffect(()=>{
    camera.position.set(startX,EYE_HEIGHT,startZ); yaw.current=0;
    const kd=(e:KeyboardEvent)=>{ keys.current.add(e.key.toLowerCase()); if(e.key==="Escape") onExit(); };
    const ku=(e:KeyboardEvent)=>keys.current.delete(e.key.toLowerCase());
    const mdown=(e:MouseEvent)=>{ md.current=true; lmx.current=e.clientX; };
    const mup=()=>{ md.current=false; };
    const mm=(e:MouseEvent)=>{ if(!md.current) return; yaw.current-=(e.clientX-lmx.current)*.004; lmx.current=e.clientX; };
    window.addEventListener("keydown",kd); window.addEventListener("keyup",ku);
    gl.domElement.addEventListener("mousedown",mdown); window.addEventListener("mouseup",mup); window.addEventListener("mousemove",mm);
    return()=>{ window.removeEventListener("keydown",kd); window.removeEventListener("keyup",ku); gl.domElement.removeEventListener("mousedown",mdown); window.removeEventListener("mouseup",mup); window.removeEventListener("mousemove",mm); };
  },[startX,startZ,onExit,camera,gl.domElement]);
  useFrame((_,dt)=>{
    const sp=13*dt, fwd=new THREE.Vector3(Math.sin(yaw.current),0,Math.cos(yaw.current)), rt=new THREE.Vector3(fwd.z,0,-fwd.x);
    if(keys.current.has("w")||keys.current.has("arrowup"))    camera.position.addScaledVector(fwd, sp);
    if(keys.current.has("s")||keys.current.has("arrowdown"))  camera.position.addScaledVector(fwd,-sp);
    if(keys.current.has("a")||keys.current.has("arrowleft"))  camera.position.addScaledVector(rt, -sp);
    if(keys.current.has("d")||keys.current.has("arrowright")) camera.position.addScaledVector(rt,  sp);
    camera.position.y=EYE_HEIGHT;
    camera.lookAt(camera.position.x+fwd.x*10,EYE_HEIGHT,camera.position.z+fwd.z*10);
  });
  return null;
}

// ─── Main 3D Scene ────────────────────────────────────────────────────────────

interface Scene3DProps {
  sceneData:SceneData|null|undefined; layers:LayerState; unit:UnitKey; viewMode:ViewMode;
  onExitWalk:()=>void; fallbackRooms:PlacedRoom[]; annotations:Annotation[]; overviewKey:number;
  screenshotRef:React.MutableRefObject<(()=>void)|null>; glbRef:React.MutableRefObject<(()=>void)|null>;
  selectedObjName:string|null; onSelect:(obj:SelectedObject)=>void;
  showDimensions:boolean; measureMode:boolean; measurePts:THREE.Vector3[]; onMeasurePoint:(p:THREE.Vector3)=>void;
}

function Scene3D({ sceneData,layers,unit,viewMode,onExitWalk,fallbackRooms,annotations,overviewKey,screenshotRef,glbRef,selectedObjName,onSelect,showDimensions,measureMode,measurePts,onMeasurePoint }:Scene3DProps) {
  const style=useContext(StyleCtx);
  const sd=sceneData, hasSD=!!(sd?.walls?.length);
  const bw=hasSD?sd!.building_width_ft:Math.max(30,fallbackRooms.reduce((m,r)=>Math.max(m,r.x+r.w),0));
  const bd=hasSD?sd!.building_depth_ft:Math.max(30,fallbackRooms.reduce((m,r)=>Math.max(m,r.z+r.h),0));
  const cx=bw/2, cz=bd/2, wallH=sd?.wall_height_ft||WALL_H_DEFAULT;
  const isPhoto=style==="photo", isWire=style==="wireframe";
  const extColor=layers.drywall?"#f0ece4":"#b07040";
  const intColor=layers.drywall?"#f5f2ee":"#a06030";

  return(
    <>
      <color attach="background" args={[isWire?"#f0f4f8":isPhoto?"#dde4f0":"#f4f6fa"]}/>
      {isPhoto&&<fog attach="fog" args={["#dde4f0",200,650]}/>}

      {/* ── Lighting ── */}
      {isPhoto?(
        <>
          <directionalLight castShadow position={[cx+40,58,cz+30]} intensity={1.8} color="#fff7e8"
            shadow-mapSize-width={4096} shadow-mapSize-height={4096}
            shadow-camera-near={1} shadow-camera-far={500}
            shadow-camera-left={-130} shadow-camera-right={130}
            shadow-camera-top={130} shadow-camera-bottom={-130}
            shadow-bias={-0.0003} shadow-normalBias={0.02}/>
          <directionalLight position={[cx-35,18,cz-25]} intensity={0.42} color="#aac8ff"/>
          <hemisphereLight args={["#eeeeff","#e0d5c0",0.52]}/>
          <Environment preset="apartment" background={false}/>
        </>
      ):(
        <ambientLight intensity={1.4}/>
      )}

      {/* ── Camera ── */}
      {viewMode==="iso"?(
        <>
          <OverviewCameraSetup key={overviewKey} cx={cx} cz={cz} bw={bw} bd={bd}/>
          <OrbitControls target={[cx,0,cz]} enableDamping dampingFactor={0.07} makeDefault minPolarAngle={0.05} maxPolarAngle={Math.PI/2.05} minDistance={5} maxDistance={600}/>
        </>
      ):(
        <WalkthroughCamera key="fp" startX={cx} startZ={cz} onExit={onExitWalk}/>
      )}

      {/* ── Ground ── */}
      <mesh receiveShadow rotation={[-Math.PI/2,0,0]} position={[cx,-.22,cz]}>
        <planeGeometry args={[bw+120,bd+120]}/>
        <meshStandardMaterial color={isWire?"#e2e8f0":"#a0988e"} roughness={0.94} wireframe={isWire}/>
      </mesh>
      {layers.foundation&&!isWire&&(
        <Grid position={[cx,-.19,cz]} args={[bw+80,bd+80]} cellSize={5} cellThickness={0.3} cellColor="#88867e" sectionSize={20} sectionThickness={0.7} sectionColor="#6a6860" fadeDistance={260} fadeStrength={1.6} infiniteGrid={false}/>
      )}

      <ScreenshotTrigger triggerRef={screenshotRef}/>
      <GLBExportTrigger triggerRef={glbRef}/>

      {/* ── Post-processing (photo only) ── */}
      {isPhoto&&viewMode==="iso"&&(
        <EffectComposer>
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC}/>
          <Bloom luminanceThreshold={0.7} luminanceSmoothing={0.45} intensity={0.5} blendFunction={BlendFunction.ADD}/>
          <DepthOfField focusDistance={0.012} focalLength={0.22} bokehScale={1.8} height={480}/>
          <ChromaticAberration offset={new THREE.Vector2(0.0003,0.0003)} blendFunction={BlendFunction.NORMAL}/>
          <Vignette eskil={false} offset={0.36} darkness={0.5} blendFunction={BlendFunction.NORMAL}/>
        </EffectComposer>
      )}
      {isPhoto&&viewMode==="fp"&&(
        <EffectComposer>
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC}/>
          <Bloom luminanceThreshold={0.7} luminanceSmoothing={0.45} intensity={0.4} blendFunction={BlendFunction.ADD}/>
          <Vignette eskil={false} offset={0.4} darkness={0.55} blendFunction={BlendFunction.NORMAL}/>
        </EffectComposer>
      )}

      {/* ── Measure ── */}
      <MeasureFloor active={measureMode} points={measurePts} onPoint={onMeasurePoint} bw={bw} bd={bd}/>

      {/* ── Building (Vision data) ── */}
      {hasSD?(
        <>
          {layers.foundation&&<Foundation rooms={sd!.rooms}/>}
          {layers.drywall&&sd!.rooms.map((r,i)=>(
            <RoomFloor key={i} room={r} selected={selectedObjName===`room:${r.name}`} onSelect={()=>onSelect({type:"room",data:r})}/>
          ))}
          {layers.drywall&&sd!.rooms.map((r,i)=>(
            <RoomCeiling key={i} room={r} wallH={wallH}/>
          ))}
          {(layers.framing||layers.drywall)&&sd!.walls.map((w,i)=>(
            <WallWithDoors key={i} wall={w} wallHeight={wallH} doors={sd!.doors}
              color={w.type==="exterior"?extColor:intColor}
              onWallClick={()=>onSelect({type:"wall",data:{...w,length:Math.sqrt((w.x2-w.x1)**2+(w.z2-w.z1)**2)}})}/>
          ))}
          {layers.drywall&&sd!.doors.map((d,i)=>(
            <DoorWithFrame key={i} door={d} walls={sd!.walls} wallHeight={wallH} onSelect={()=>onSelect({type:"door",data:d})}/>
          ))}
          {layers.drywall&&sd!.windows.map((w,i)=>(
            <WindowWithFrame key={i} win={w} walls={sd!.walls} onSelect={()=>onSelect({type:"window",data:w})}/>
          ))}
          {layers.drywall&&sd!.windows.map((w,i)=>(
            <WindowLightShaft key={i} win={w} walls={sd!.walls} cx={cx} cz={cz}/>
          ))}
          {layers.roof&&sd!.rooms.map((r,i)=>(
            <mesh key={i} position={[r.x+r.width/2,wallH+.08,r.z+r.depth/2]}>
              <boxGeometry args={[r.width+.12,.14,r.depth+.12]}/>
              <meshStandardMaterial color="#e8e4dc" transparent opacity={0.16} roughness={0.9}/>
            </mesh>
          ))}
          {layers.electrical&&sd!.electrical.map((el,i)=>(
            <React.Fragment key={i}><CeilingLightFixture el={el}/><ElectricalMarker el={el}/></React.Fragment>
          ))}
          {layers.plumbing&&sd!.plumbing.map((pl,i)=>(
            <PlumbingFixture key={i} pl={pl} onSelect={()=>onSelect({type:"plumbing",data:pl})}/>
          ))}
          {!isWire&&layers.drywall&&sd!.rooms.map((r,i)=><RoomFurniture key={i} room={r}/>)}
          {viewMode==="iso"&&sd!.rooms.map((r,i)=><RoomLabel key={i} room={r} wallH={wallH} unit={unit}/>)}
          {showDimensions&&<DimensionOverlays walls={sd!.walls} rooms={sd!.rooms} wallH={wallH} unit={unit}/>}
          {isPhoto&&<ContactShadows position={[cx,.02,cz]} width={bw+24} height={bd+24} far={4.5} blur={3.0} opacity={0.38}/>}
        </>
      ):(
        <>
          {fallbackRooms.map((r,i)=><FallbackRoom key={i} room={r} layers={layers} wallH={WALL_H_DEFAULT}/>)}
          {viewMode==="iso"&&fallbackRooms.map((r,i)=>(
            <Html key={i} position={[r.x+r.w/2,WALL_H_DEFAULT+.9,r.z+r.h/2]} center style={{pointerEvents:"none"}}>
              <div style={{background:"rgba(255,255,255,0.92)",backdropFilter:"blur(8px)",borderRadius:8,padding:"4px 10px",fontSize:11,fontWeight:700,color:"#1e293b",whiteSpace:"nowrap",boxShadow:"0 2px 12px rgba(0,0,0,0.14)"}}>
                {r.name}<div style={{fontSize:9,fontWeight:400,color:"#64748b"}}>{Math.round(r.sqft).toLocaleString()} sqft</div>
              </div>
            </Html>
          ))}
          <ContactShadows position={[cx,.02,cz]} width={bw+15} height={bd+15} far={4} blur={2.5} opacity={0.3}/>
        </>
      )}

      {annotations.map(ann=><AnnotationPin key={ann.id} ann={ann} wallH={wallH}/>)}

      {viewMode==="fp"&&(
        <Html fullscreen style={{pointerEvents:"none"}}>
          <>
            <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:24,height:24}}>
              <div style={{position:"absolute",top:"50%",left:0,width:"100%",height:1.5,background:"rgba(255,255,255,0.85)",borderRadius:2,transform:"translateY(-50%)"}}/>
              <div style={{position:"absolute",left:"50%",top:0,height:"100%",width:1.5,background:"rgba(255,255,255,0.85)",borderRadius:2,transform:"translateX(-50%)"}}/>
            </div>
            <div style={{position:"absolute",bottom:52,left:"50%",transform:"translateX(-50%)",background:"rgba(0,0,0,0.55)",color:"#fff",borderRadius:10,padding:"6px 20px",fontSize:12,fontWeight:500,backdropFilter:"blur(10px)",whiteSpace:"nowrap"}}>
              W / A / S / D · Drag to look · Esc to exit
            </div>
          </>
        </Html>
      )}
    </>
  );
}

// ─── Room builder ─────────────────────────────────────────────────────────────

function buildRooms(analysis:any):PlacedRoom[] {
  let raw:{name:string;sqft:number;w:number;h:number}[]=[];
  if(analysis?.rooms?.length>0){
    raw=analysis.rooms.map((r:any)=>{
      const sqft=r.sqft||r.area||100,w=r.dimensions?.width||r.width||Math.sqrt(sqft*1.3),h=r.dimensions?.height||r.height||sqft/w;
      return{name:r.name||"Room",sqft,w,h};
    });
  }else{
    const total=analysis?.total_sqft||1200;
    raw=[
      {name:"Living Room",sqft:total*.30},{name:"Kitchen",sqft:total*.18},
      {name:"Master Bedroom",sqft:total*.20},{name:"Bedroom 2",sqft:total*.14},
      {name:"Bathroom",sqft:total*.10},{name:"Garage",sqft:total*.08},
    ].map(r=>{const w=Math.sqrt(r.sqft*1.3);return{...r,w,h:r.sqft/w};});
  }
  raw.sort((a,b)=>b.sqft-a.sqft);
  const maxW=Math.sqrt(raw.reduce((s,r)=>s+r.sqft,0))*1.5;
  const placed:PlacedRoom[]=[]; let curX=0,curZ=0,rowH=0,ci=0;
  for(const r of raw){
    if(curX>0&&curX+r.w>maxW){curX=0;curZ+=rowH+2;rowH=0;}
    placed.push({name:r.name,sqft:r.sqft,w:r.w,h:r.h,x:curX,z:curZ,colorIdx:ci++});
    curX+=r.w+2; rowH=Math.max(rowH,r.h);
  }
  return placed;
}

// ─── Property panel ───────────────────────────────────────────────────────────

function PropertyPanel({ obj,onClose }:{ obj:SelectedObject; onClose:()=>void }) {
  const icons:Record<string,string>={ room:"",wall:"",door:"",window:"",electrical:"",plumbing:"" };
  const rows:{ label:string; value:string }[]=[];
  if(obj.type==="room"){
    const r=obj.data as SceneRoom;
    rows.push({label:"Floor type",value:r.floor_type||"—"});
    if(r.sqft) rows.push({label:"Area",value:`${Math.round(r.sqft).toLocaleString()} sqft`});
    rows.push({label:"Width",value:`${r.width?.toFixed(1)}′`},{label:"Depth",value:`${r.depth?.toFixed(1)}′`});
    rows.push({label:"Position",value:`(${r.x.toFixed(1)}, ${r.z.toFixed(1)})`});
  } else if(obj.type==="wall"){
    const w=obj.data;
    rows.push({label:"Type",value:w.type},{label:"Length",value:`${w.length?.toFixed(1)}′`},{label:"Thickness",value:`${((w.thickness||0.5)*12).toFixed(0)}″`});
  } else if(obj.type==="door"){
    const d=obj.data as SceneDoor;
    rows.push({label:"Width",value:`${d.width?.toFixed(1)}′`},{label:"Height",value:`${d.height?.toFixed(1)}′`});
  } else if(obj.type==="window"){
    const w=obj.data as SceneWindow;
    rows.push({label:"Width",value:`${w.width?.toFixed(1)}′`},{label:"Height",value:`${w.height?.toFixed(1)}′`},{label:"Sill height",value:`${w.sill_height?.toFixed(1)}′`});
  } else if(obj.type==="electrical"){
    const e=obj.data as SceneElectrical;
    rows.push({label:"Type",value:e.type.replace(/_/g," ")},{label:"Position",value:`(${e.x?.toFixed(1)}, ${e.z?.toFixed(1)})`});
  } else if(obj.type==="plumbing"){
    const p=obj.data as ScenePlumbing;
    rows.push({label:"Type",value:p.type.replace(/_/g," ")},{label:"Position",value:`(${p.x?.toFixed(1)}, ${p.z?.toFixed(1)})`});
  }
  return(
    <div className="bg-white rounded-2xl border border-indigo-100 px-5 py-4 flex items-start gap-4" style={{boxShadow:"0 2px 16px rgba(99,102,241,0.10)"}}>
      <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-xl flex-shrink-0">{icons[obj.type]}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <h3 className="font-bold text-slate-800 text-sm capitalize">{obj.type === "room" ? (obj.data as SceneRoom).name : obj.type}</h3>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100 uppercase">{obj.type}</span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {rows.map(r=>(
            <div key={r.label} className="text-xs text-slate-500">
              <span className="text-slate-400">{r.label}: </span>
              <span className="font-semibold text-slate-700">{r.value}</span>
            </div>
          ))}
        </div>
      </div>
      <button className="text-slate-400 hover:text-slate-600 text-lg leading-none" onClick={onClose}>×</button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Blueprint3DViewer({ analysis, sceneData, blueprintUrl }:{
  analysis:any; sceneData?:SceneData|null; blueprintUrl?:string;
}) {
  const [viewMode,       setViewMode]       = useState<ViewMode>("iso");
  const [styleMode,      setStyleMode]      = useState<StyleMode>("photo");
  const [layers,         setLayers]         = useState<LayerState>({foundation:true,framing:true,electrical:false,plumbing:false,drywall:true,roof:true});
  const [unit,           setUnit]           = useState<UnitKey>("ft");
  const [showLayers,     setShowLayers]     = useState(false);
  const [annotations,    setAnnotations]    = useState<Annotation[]>([]);
  const [overviewKey,    setOverviewKey]    = useState(0);
  const [selectedObj,    setSelectedObj]    = useState<SelectedObject|null>(null);
  const [showDimensions, setShowDimensions] = useState(false);
  const [measureMode,    setMeasureMode]    = useState(false);
  const [measurePts,     setMeasurePts]     = useState<THREE.Vector3[]>([]);
  const [showSplit,      setShowSplit]      = useState(false);

  const screenshotRef = useRef<(()=>void)|null>(null);
  const glbRef        = useRef<(()=>void)|null>(null);
  const fallbackRooms = useRef<PlacedRoom[]>(buildRooms(analysis));
  useEffect(()=>{ fallbackRooms.current=buildRooms(analysis); },[analysis]);

  const sd=sceneData, hasSD=!!(sd?.walls?.length);
  const toggleLayer=(k:keyof LayerState)=>setLayers(p=>({...p,[k]:!p[k]}));
  const exitWalk=()=>{ setViewMode("iso"); setOverviewKey(k=>k+1); };

  function handleSelect(obj:SelectedObject){
    const key=obj.type==="room"?`room:${(obj.data as SceneRoom).name}`:`${obj.type}:${JSON.stringify(obj.data).slice(0,30)}`;
    setSelectedObj(prev=>prev&&`${prev.type}:${JSON.stringify(prev.data).slice(0,30)}`===key?null:obj);
  }
  function handleMeasurePoint(p:THREE.Vector3){
    setMeasurePts(prev=>prev.length===0?[p]:prev.length===1?[prev[0],p]:[p]);
  }
  function toggleMeasure(){ setMeasureMode(m=>!m); setMeasurePts([]); }

  const selectedObjName = selectedObj
    ? (selectedObj.type==="room"?`room:${(selectedObj.data as SceneRoom).name}`:`${selectedObj.type}:${JSON.stringify(selectedObj.data).slice(0,30)}`)
    : null;

  const canvas=(
    <Canvas shadows camera={{position:[40,32,40],fov:42,near:0.1,far:1500}}
      gl={{antialias:true,alpha:false,powerPreference:"high-performance",preserveDrawingBuffer:true}} dpr={[1,2]}>
      <Suspense fallback={null}>
        <Scene3D sceneData={sceneData} layers={layers} unit={unit} viewMode={viewMode} onExitWalk={exitWalk}
          fallbackRooms={fallbackRooms.current} annotations={annotations} overviewKey={overviewKey}
          screenshotRef={screenshotRef} glbRef={glbRef}
          selectedObjName={selectedObjName} onSelect={handleSelect}
          showDimensions={showDimensions} measureMode={measureMode}
          measurePts={measurePts} onMeasurePoint={handleMeasurePoint}/>
      </Suspense>
    </Canvas>
  );

  return(
    <StyleCtx.Provider value={styleMode}>
      <div className="flex flex-col gap-3 select-none">

        {/* ── Toolbar ── */}
        <div className="flex items-center gap-1.5 flex-wrap px-1">
          {/* View mode */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 shadow-sm">
            <button className={`px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode==="iso"?"bg-indigo-600 text-white":"bg-white text-gray-600 hover:bg-gray-50"}`} onClick={exitWalk}>Overview</button>
            <button className={`px-3 py-1.5 text-xs font-semibold border-l border-gray-200 transition-colors ${viewMode==="fp"?"bg-indigo-600 text-white":"bg-white text-gray-600 hover:bg-gray-50"}`} onClick={()=>setViewMode("fp")}>Walk</button>
          </div>

          <div className="w-px h-5 bg-gray-200"/>

          {/* Style mode */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 shadow-sm">
            {(["photo","minimal","wireframe"] as StyleMode[]).map((s,i)=>(
              <button key={s} className={`px-2.5 py-1.5 text-xs font-semibold transition-colors ${i>0?"border-l border-gray-200":""} ${styleMode===s?"bg-slate-800 text-white":"bg-white text-gray-600 hover:bg-gray-50"}`} onClick={()=>setStyleMode(s)}>
                {s==="photo"?"Photo":s==="minimal"?"Flat":"Wire"}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-gray-200"/>

          {/* Layers */}
          <div className="relative">
            <button className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showLayers?"bg-gray-800 text-white border-gray-800":"bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`} onClick={()=>setShowLayers(p=>!p)}>Layers</button>
            {showLayers&&(
              <div className="absolute left-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded-xl shadow-xl p-3 w-48">
                <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-widest">Visibility</p>
                {LAYER_META.map(({key,label,color})=>(
                  <label key={key} className="flex items-center gap-2 py-1 px-1 cursor-pointer hover:bg-gray-50 rounded-lg">
                    <input type="checkbox" checked={layers[key]} onChange={()=>toggleLayer(key)} className="rounded accent-indigo-600"/>
                    <span className="w-3 h-3 rounded-sm flex-shrink-0 border border-gray-200" style={{backgroundColor:color}}/>
                    <span className="text-xs text-gray-700">{label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Dimensions */}
          <button className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showDimensions?"bg-blue-600 text-white border-blue-600":"bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`} onClick={()=>setShowDimensions(d=>!d)}>Dims</button>

          {/* Measure */}
          <button className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${measureMode?"bg-amber-500 text-white border-amber-500":"bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`} onClick={toggleMeasure}>Measure</button>

          {/* Split view */}
          {blueprintUrl&&(
            <button className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showSplit?"bg-teal-600 text-white border-teal-600":"bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`} onClick={()=>setShowSplit(s=>!s)}>Split</button>
          )}

          <div className="flex-1"/>

          <button className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50" onClick={()=>screenshotRef.current?.()} title="Export PNG">PNG</button>
          <button className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50" onClick={()=>glbRef.current?.()} title="Export GLB">GLB</button>

          <select className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 font-medium" value={unit} onChange={e=>setUnit(e.target.value as UnitKey)}>
            {(Object.keys(UNIT_LABELS) as UnitKey[]).map(k=><option key={k} value={k}>{UNIT_LABELS[k]}</option>)}
          </select>

          {viewMode==="fp"&&(
            <button className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100" onClick={exitWalk}>Exit Walk</button>
          )}
        </div>

        {/* Measure hint bar */}
        {measureMode&&(
          <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs font-medium flex items-center gap-2">
            <span></span>
            {measurePts.length===0&&"Click a point on the floor to start measuring"}
            {measurePts.length===1&&"Click a second point to complete the measurement"}
            {measurePts.length===2&&`Distance: ${measurePts[0].distanceTo(measurePts[1]).toFixed(2)} ft — click again to reset`}
            <button className="ml-auto text-amber-600 hover:text-amber-800 font-semibold" onClick={toggleMeasure}>Done</button>
          </div>
        )}

        {/* Canvas */}
        {showSplit&&blueprintUrl?(
          <div className="flex gap-3" style={{height:560}}>
            <div className="flex-1 rounded-2xl overflow-hidden border border-gray-200 shadow-xl bg-white flex items-center justify-center">
              <img src={blueprintUrl} alt="Blueprint" className="w-full h-full object-contain" style={{maxHeight:560}}/>
            </div>
            <div className="flex-1 rounded-2xl overflow-hidden border border-gray-200 shadow-xl">{canvas}</div>
          </div>
        ):(
          <div className="rounded-2xl overflow-hidden border border-gray-200 shadow-xl" style={{height:560}}>{canvas}</div>
        )}

        {/* Property panel */}
        {selectedObj&&<PropertyPanel obj={selectedObj} onClose={()=>setSelectedObj(null)}/>}

        {/* Stats */}
        {hasSD&&(
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              {label:"Total Area",  value:`${(sd!.total_sqft||0).toLocaleString()} sqft`},
              {label:"Rooms",       value:sd!.rooms.length},
              {label:"Wall Height", value:`${sd!.wall_height_ft??WALL_H_DEFAULT} ft`},
              {label:"Confidence",  value:`${Math.round((sd!.confidence||0)*100)}%`},
            ].map(s=>(
              <div key={s.label} className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
                <p className="text-xs text-gray-400 font-medium">{s.label}</p>
                <p className="text-sm font-bold text-gray-800 mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Annotations */}
        {annotations.length>0&&(
          <div className="border border-gray-200 rounded-xl bg-white shadow-sm p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Notes ({annotations.length})</p>
              <button className="text-xs text-red-500 hover:text-red-700" onClick={()=>setAnnotations([])}>Clear all</button>
            </div>
            {annotations.map(ann=>(
              <div key={ann.id} className="flex items-center gap-2 py-1.5 px-2 bg-purple-50 rounded-lg mb-1">
                <span className="w-5 h-5 bg-purple-600 rounded-full flex items-center justify-center text-white text-[10px] flex-shrink-0"></span>
                <span className="text-xs text-gray-700 flex-1">{ann.text}</span>
                <button className="text-gray-400 hover:text-red-500" onClick={()=>setAnnotations(p=>p.filter(a=>a.id!==ann.id))}>×</button>
              </div>
            ))}
          </div>
        )}

      </div>
    </StyleCtx.Provider>
  );
}
