// Research scratch: rough unoptimised Float64 timing of a separable Gaussian and a van Herk 41x41 grey opening on 696x520 in Node.
const W=696,H=520,N=W*H;const a=new Float64Array(N);for(let i=0;i<N;i++)a[i]=(Math.sin(i*0.013)+2)*500+(i*2654435761%97);
function gauss(src,sigma){const r=Math.trunc(4*sigma+0.5);const w=new Float64Array(2*r+1);let s=0;for(let k=-r;k<=r;k++){w[k+r]=Math.exp(-0.5*(k/sigma)**2);s+=w[k+r]}for(let k=0;k<w.length;k++)w[k]/=s;
 const t=new Float64Array(N),o=new Float64Array(N);const refl=(i,n)=>{const p=2*n;i=((i%p)+p)%p;return i<n?i:p-1-i};
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){let acc=0;for(let k=-r;k<=r;k++)acc+=w[k+r]*src[y*W+refl(x+k,W)];t[y*W+x]=acc}
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){let acc=0;for(let k=-r;k<=r;k++)acc+=w[k+r]*t[refl(y+k,H)*W+x];o[y*W+x]=acc}return o}
// van Herk / Gil-Werman 1D along rows, window 41 (radius 20), reflect border via padded line
function vh(line,n,r,isMin,out,tmp){const L=2*r+1,refl=(i)=>{const p=2*n;i=((i%p)+p)%p;return i<n?i:p-1-i};const m=n+2*r;const pad=tmp.pad,g=tmp.g,h=tmp.h;
 for(let i=0;i<m;i++)pad[i]=line[refl(i-r)];
 const f=isMin?Math.min:Math.max;
 for(let i=0;i<m;i++){g[i]=(i%L===0)?pad[i]:f(g[i-1],pad[i])}
 for(let i=m-1;i>=0;i--){h[i]=(i===m-1||(i+1)%L===0)?pad[i]:f(h[i+1],pad[i])}
 for(let i=0;i<n;i++)out[i]=f(h[i],g[i+L-1])}
function pass2d(src,isMin,r){const o=new Float64Array(N),t=new Float64Array(N);const mx=Math.max(W,H)+2*r;const tmp={pad:new Float64Array(mx),g:new Float64Array(mx),h:new Float64Array(mx)};
 const row=new Float64Array(W),ro=new Float64Array(W);for(let y=0;y<H;y++){for(let x=0;x<W;x++)row[x]=src[y*W+x];vh(row,W,r,isMin,ro,tmp);for(let x=0;x<W;x++)t[y*W+x]=ro[x]}
 const col=new Float64Array(H),co=new Float64Array(H);for(let x=0;x<W;x++){for(let y=0;y<H;y++)col[y]=t[y*W+x];vh(col,H,r,isMin,co,tmp);for(let y=0;y<H;y++)o[y*W+x]=co[y]}return o}
const T=(f,n=5)=>{f();const t=performance.now();for(let i=0;i<n;i++)f();return ((performance.now()-t)/n).toFixed(1)+' ms'};
console.log('node',process.version);
console.log('gaussian sigma2 float64 696x520:',T(()=>gauss(a,2)));
console.log('grey opening 41x41 (van Herk, 4 separable passes):',T(()=>pass2d(pass2d(a,true,20),false,20)));
const o1=pass2d(pass2d(a,true,20),false,20);
// brute-force check of a few pixels of erosion
const e=pass2d(a,true,20);let bad=0;for(const [x,y] of [[0,0],[10,300],[695,519],[350,260],[5,515]]){let m=Infinity;for(let dy=-20;dy<=20;dy++)for(let dx=-20;dx<=20;dx++){let yy=y+dy,xx=x+dx;const rf=(i,n)=>{const p=2*n;i=((i%p)+p)%p;return i<n?i:p-1-i};m=Math.min(m,a[rf(yy,H)*W+rf(xx,W)])}if(m!==e[y*W+x])bad++}
console.log('van Herk erosion vs brute force on 5 px, mismatches:',bad);
