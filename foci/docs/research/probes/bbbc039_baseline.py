"""BBBC039 baseline + float32-vs-float64 parity run (research scratch). Needs, in the working directory: b39/*.tif (the 50 test-split
images of BBBC039 images.zip) and masks039.zip (BBBC039 masks.zip). Uses the repo pipeline src/telomere_lab/foci/segment.py with DEFAULT
parameters, run once, no tuning. See docs/FOCI_BROWSER_COMPUTE.md sections 2 and 6."""
import sys,os,io,zipfile,json,glob
sys.path.insert(0,os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','..','..','src'))
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from telomere_lab.foci import segment as S
P=S.FociParams()
mz=zipfile.ZipFile('masks039.zip')
def gt(name):
    a=np.array(Image.open(io.BytesIO(mz.read('masks/'+name.replace('.tif','.png')))))[...,0]
    lab=np.zeros(a.shape,np.int32);n=0
    for k in range(1,int(a.max())+1):
        l,m=ndi.label(a==k); lab[l>0]=l[l>0]+n; n+=m
    return lab,n
def f1(pred,g,ths=(0.5,0.6,0.7,0.8,0.9)):
    npred=int(pred.max()); ng=int(g.max()); out={}
    if npred==0 or ng==0: return {t:0.0 for t in ths}
    pair=pred.astype(np.int64)*(ng+1)+g
    cnt=np.bincount(pair.ravel(),minlength=(npred+1)*(ng+1)).reshape(npred+1,ng+1)
    ap=cnt.sum(1);ag=cnt.sum(0)
    inter=cnt[1:,1:]; union=ap[1:,None]+ag[None,1:]-inter; iou=inter/np.maximum(union,1)
    for t in ths:
        tp=int((iou>t).sum()) # unique when t>=0.5
        out[t]=2*tp/(2*tp+(npred-tp)+(ng-tp))
    return out
# variants of the nucleus segmentation given a 'smooth' and 'opening' provider
def seg(dna,mode):
    if mode=='repo':   # float32 input, as in repo
        return S.segment_nuclei(dna,P)
    if mode=='f64':
        sm=ndi.gaussian_filter(dna.astype(np.float64),P.nucleus_sigma)
        flat=sm-ndi.grey_opening(sm,size=P.background_size)
        v=np.log1p(np.clip(flat,0,None)); th=np.expm1(S.otsu_threshold(v[v>0]))
        mask=flat>th
    elif mode.startswith('f32'):
        # emulate GPU: f32 separable gaussian with explicit accumulation order
        r=int(4.0*P.nucleus_sigma+0.5); x=np.arange(-r,r+1); w=np.exp(-0.5*(x/P.nucleus_sigma)**2); w/=w.sum(); w32=w.astype(np.float32)
        def blur(a,axis):
            pad=[(0,0)]*2; pad[axis]=(r,r); ap=np.pad(a,pad,mode='symmetric'); acc=np.zeros(a.shape,np.float32)
            order=range(2*r+1) if mode=='f32_seq' else reversed(range(2*r+1))
            for k in order:
                sl=[slice(None)]*2; sl[axis]=slice(k,k+a.shape[axis]); acc=(acc+ap[tuple(sl)]*w32[k]).astype(np.float32)
            return acc
        sm=blur(blur(dna.astype(np.float32),0),1)
        flat=(sm-ndi.grey_opening(sm,size=P.background_size)).astype(np.float32)
        v=np.log1p(np.clip(flat,0,None)).astype(np.float32)  # f32 log1p (CPU-exact-ish; GPU log ulp differs)
        th=float(np.expm1(S.otsu_threshold(v[v>0])))
        mask=flat>th
    mask=ndi.binary_fill_holes(ndi.binary_opening(mask,iterations=2))
    lab,n=ndi.label(mask)
    if n==0: return lab
    sizes=np.bincount(lab.ravel());sizes[0]=0;keep=sizes>=P.min_nucleus_px
    remap=np.zeros(sizes.size,np.int32);remap[keep]=np.arange(1,int(keep.sum())+1);return remap[lab]
files=sorted(glob.glob('b39/*.tif'))
modes=['repo','f64','f32_seq','f32_rev']
rows=[]
for f in files:
    dna=np.array(Image.open(f)).astype(np.float32); g,ng=gt(os.path.basename(f))
    r={'file':os.path.basename(f),'gt_n':ng}
    labs={m:seg(dna,m) for m in modes}
    for m,l in labs.items():
        r[m+'_objs']=int(l.max()); r[m+'_nuc']=int(S.estimate_nuclei(l).sum()) if l.max() else 0
        r[m+'_f1']=f1(l,g)
        r[m+'_fg']=int((l>0).sum())
    for m in modes[1:]:
        r[m+'_pixdiff']=int(((labs[m]>0)!=(labs['repo']>0)).sum())
    rows.append(r)
json.dump(rows,open('exp_rows.json','w'))
def mean(k,t=None): return float(np.mean([ (r[k][t] if t is not None else r[k]) for r in rows]))
print('n images',len(rows),'GT nuclei total',sum(r['gt_n'] for r in rows))
for m in modes:
    print(m,'F1@',{t:round(mean(m+'_f1',t),3) for t in (0.5,0.6,0.7,0.8,0.9)},
      'objs/img',round(mean(m+'_objs'),1),'nuc_est/img',round(mean(m+'_nuc'),1),'GT/img',round(mean('gt_n'),1),
      'MAE est',round(np.mean([abs(r[m+'_nuc']-r['gt_n']) for r in rows]),2),'bias',round(np.mean([r[m+'_nuc']-r['gt_n'] for r in rows]),2),
      'MAE objs',round(np.mean([abs(r[m+'_objs']-r['gt_n']) for r in rows]),2))
for m in modes[1:]:
    d=[r[m+'_pixdiff'] for r in rows]; c=[r[m+'_objs']-r['repo_objs'] for r in rows]
    print(m,'vs repo: mean fg-pixel diffs',np.mean(d),'max',max(d),'of ~',np.mean([r['repo_fg'] for r in rows]),'fg; images with different object count',sum(1 for x in c if x!=0),'/',len(c))
