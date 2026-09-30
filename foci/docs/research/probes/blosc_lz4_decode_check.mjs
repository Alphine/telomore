// Research scratch: pure-JS blosc(lz4, shuffle) decode of one IDR/BIA OME-Zarr chunk (S-BIAD885, plate 7-14, well A1, DNA channel), big-endian uint16. Needs chunk0.bin = the inflated zip entry.
import fs from 'node:fs';
const b=fs.readFileSync('chunk0.bin'); const dv=new DataView(b.buffer,b.byteOffset,b.length);
const flags=b[2],typesize=b[3],nbytes=dv.getUint32(4,true),blocksize=dv.getUint32(8,true),cbytes=dv.getUint32(12,true);
const out=new Uint8Array(nbytes); const nblocks=Math.ceil(nbytes/blocksize);
function lz4(src,s,e,dst,d,dend){while(s<e){const t=src[s++];let ll=t>>4;if(ll===15){let x;do{x=src[s++];ll+=x}while(x===255)}
 for(let i=0;i<ll;i++)dst[d++]=src[s++]; if(s>=e)break; const off=src[s]|(src[s+1]<<8);s+=2;let ml=t&15;if(ml===15){let x;do{x=src[s++];ml+=x}while(x===255)}ml+=4;
 for(let i=0;i<ml;i++){dst[d]=dst[d-off];d++}} return d}
for(let k=0;k<nblocks;k++){const bs=dv.getUint32(16+4*k,true);const len=Math.min(blocksize,nbytes-k*blocksize);
 const tmp=new Uint8Array(len);let p=bs;const nst=(flags&1)&&typesize>1&&len%typesize===0?typesize:1;const sl=len/nst;
 for(let j=0;j<nst;j++){const cs=dv.getInt32(p,true);p+=4; if(cs===sl){tmp.set(b.subarray(p,p+cs),j*sl)}else lz4(b,p,p+cs,tmp,j*sl,0);p+=cs}
 if(nst>1){for(let i=0;i<sl;i++)for(let j=0;j<nst;j++)out[k*blocksize+i*nst+j]=tmp[j*sl+i]}else out.set(tmp,k*blocksize)}
const v=new DataView(out.buffer);let mn=1e9,mx=0,sum=0;for(let i=0;i<nbytes/2;i++){const x=v.getUint16(i*2,false);if(x<mn)mn=x;if(x>mx)mx=x;sum+=x}
console.log({flags,typesize,nbytes,blocksize,nblocks,min:mn,max:mx,mean:sum/(nbytes/2)});
