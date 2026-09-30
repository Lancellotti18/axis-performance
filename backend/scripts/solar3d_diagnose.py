"""Shaded relief of the DSM with facet ids + every edge listed, for debugging the engine on real
data. Same /out layout as solar3d_compare.py. Writes relief.png."""import sys, json; sys.path.insert(0, "/app")
import numpy as np, cv2
from app.services.solar_layers_service import read_geotiff, assemble
from app.services.roof_from_dsm import extract_roof
O="/out"
dsm=read_geotiff(open(f"{O}/dsm.tif","rb").read()); mask=read_geotiff(open(f"{O}/mask.tif","rb").read())
ls=assemble(dsm,mask,None,40.0949358,-76.3227374,{})
m=extract_roof(ls.dsm,ls.mask,ls.px_m,ls.seed_rc)
# crop to the building
rr,cc=np.nonzero(m.labels>=0); r0,r1,c0,c1=rr.min()-25,rr.max()+25,cc.min()-25,cc.max()+25
z=ls.dsm[r0:r1,c0:c1].astype(np.float64)
gy,gx=np.gradient(z,0.1); az,alt=np.radians(315),np.radians(35)
slope=np.arctan(np.hypot(gx,gy)); aspect=np.arctan2(-gx,gy)
hs=np.sin(alt)*np.cos(slope)+np.cos(alt)*np.sin(slope)*np.cos(az-aspect)
hs=np.clip(hs*255,0,255).astype(np.uint8)
img=cv2.cvtColor(hs,cv2.COLOR_GRAY2BGR)
lab=m.labels[r0:r1,c0:c1]
edges=cv2.Canny((lab+3).astype(np.uint8)*20,1,1)
img[edges>0]=(0,0,255)
for f in m.facets:
    ys,xs=np.nonzero(lab==f.id)
    if len(ys): cv2.putText(img,f"{f.id}:{f.pitch_12:.0f}",(int(xs.mean())-12,int(ys.mean())+5),cv2.FONT_HERSHEY_SIMPLEX,0.4,(0,160,0),1)
big=cv2.resize(img,(img.shape[1]*3,img.shape[0]*3),interpolation=cv2.INTER_NEAREST)
cv2.imwrite(f"{O}/relief.png",big)
print("crop",r0,c0)
for e in sorted(m.edges,key=lambda e:(e.kind,e.facet)):
    print(f"{e.kind:17} f{e.facet}->{e.neighbour}  {e.length_m*3.28084:6.1f} ft  ({e.p0[0]-c0:.0f},{e.p0[1]-r0:.0f})->({e.p1[0]-c0:.0f},{e.p1[1]-r0:.0f})")
for f in m.facets: print(f"facet {f.id}: pitch {f.pitch_12}/12 az {f.azimuth_deg} plan {f.plan_m2:.1f} m2 rms {f.rms_m}")
