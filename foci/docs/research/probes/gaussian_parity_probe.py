"""Precision probe (research scratch, not application code). Shows that scipy.ndimage.gaussian_filter on float32 input is reproduced
BIT-EXACTLY by float64 accumulation with a float32 store after EACH axis pass, and quantifies GPU-like float32 accumulation error.
Run from a folder containing b39/*.tif (BBBC039 test images). Result 2026-09-30, numpy 2.3.4 / scipy as installed here: see docs/FOCI_BROWSER_COMPUTE.md section 2."""
import numpy as np, glob
from PIL import Image
from scipy import ndimage as ndi
from scipy.ndimage import _filters
f=sorted(glob.glob('b39/*.tif'))[0]
a=np.array(Image.open(f)).astype(np.float32)
s=2.0
ref=ndi.gaussian_filter(a,s)
# kernel exactly as scipy builds it
w=_filters._gaussian_kernel1d(s,0,int(4.0*s+0.5)); r=len(w)//2
print('kernel len',len(w),'symmetric',np.array_equal(w,w[::-1]),w.dtype)
def pass1d(x,axis,mode):
    x=np.moveaxis(x,axis,-1); n=x.shape[-1]
    p=np.pad(x.astype(np.float64),[(0,0)]*(x.ndim-1)+[(r,r)],mode='symmetric')
    c=p[...,r:r+n]
    if mode=='scipy_order':
        t=c*w[r]
        for k in range(r,0,-1): t=t+(p[...,r-k:r-k+n]+p[...,r+k:r+k+n])*w[r+k]
    elif mode=='sequential':   # left to right, no symmetry
        t=np.zeros_like(c)
        for k in range(2*r+1): t=t+p[...,k:k+n]*w[k]
    return np.moveaxis(t,-1,axis)
for mode in ('scipy_order','sequential'):
    for inter in ('f32-between-passes','f64-between-passes'):
        t0=pass1d(a,0,mode); 
        if inter.startswith('f32'): t0=t0.astype(np.float32)
        t1=pass1d(t0,1,mode).astype(np.float32)
        d=np.abs(t1.astype(np.float64)-ref)
        print(mode,inter,'max abs diff vs scipy',d.max(),'bitwise-equal fraction',float((t1==ref).mean()))
# f32 accumulation (GPU-like) error vs scipy
def acc32(x,axis):
    x=np.moveaxis(x,axis,-1).astype(np.float32); n=x.shape[-1]; p=np.pad(x,[(0,0)]*(x.ndim-1)+[(r,r)],mode='symmetric'); t=np.zeros_like(x); w32=w.astype(np.float32)
    for k in range(2*r+1): t=(t+p[...,k:k+n]*w32[k]).astype(np.float32)
    return np.moveaxis(t,-1,axis)
g=acc32(acc32(a,0),1); d=np.abs(g.astype(np.float64)-ref); print('f32-accumulate GPU-like: max abs diff',d.max(),'max rel',(d/np.maximum(np.abs(ref),1)).max(), 'input max',a.max())
# grey opening / tophat exactness in f32 (min/max are exact)
sm=ref.astype(np.float32); o=ndi.grey_opening(sm,size=41)
print('opening dtype',o.dtype)
