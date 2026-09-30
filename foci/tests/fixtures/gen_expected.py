"""Regenerates the expected values hard-coded in site-lib.test.mjs (scipy reference).
Run: python foci/tests/fixtures/gen_expected.py   (needs scipy)"""
from scipy.stats import hypergeom, mannwhitneyu
import json
H = [(13330,29,50,5),(13330,4,100,1),(13330,25,200,3),(20,7,5,3),(13330,29,2000,20),(13330,25,10,0),(50,10,50,10),(13330,4,3,1),(13330,29,29,29),(100,30,40,20)]
for N,K,n,k in H:
    print("H", N,K,n,k, repr(float(hypergeom.sf(k-1,N,K,n))))
def gen(n,a,m,off): return [((i*a)%m)/10+off for i in range(n)]
M = {
 "small": ([-3.2,-2.5,-4.1],[0.1,-0.3,0.5,0.2,-0.1,0.9,-0.6,0.3,1.1,0.0,0.4,-0.2]),
 "ties": ([1,1,2,2,2,3,3],[1,1,1,2,2,3,3,3,3,4,4,0,0,0,1,2]),
 "alltie_mostly": ([0,0,0,0,1],[0,0,0,0,0,0,0,1,1]),
 "gen": (gen(60,37,101,-2), gen(400,53,97,0)),
 "shift": ([5.5,6.1,7.3,8.0],[1.0,2.0,3.0,4.0,5.0,5.5,5.5]),
}
for k,(x,y) in M.items():
    r = mannwhitneyu(x,y,use_continuity=False,alternative='two-sided',method='asymptotic')
    print("M",k,repr(float(r.statistic)),repr(float(r.pvalue)))
