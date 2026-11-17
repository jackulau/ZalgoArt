#!/usr/bin/env node
/* Which code points does a font file have a glyph for? Reads the cmap table of a .ttf/.otf/.ttc.
   Usage: node tools/cmap.js <font file> [face index]   -> prints the count
   As a module: require('./cmap').coverage(path, face) -> Set of code points */
'use strict';
const fs=require('fs');
function coverage(path,face){
  const b=fs.readFileSync(path);let off=0;
  if(b.toString('latin1',0,4)==='ttcf')off=b.readUInt32BE(12+4*(face||0));
  const n=b.readUInt16BE(off+4);let cmap=-1;
  for(let i=0;i<n;i++){const r=off+12+16*i;if(b.toString('latin1',r,r+4)==='cmap')cmap=b.readUInt32BE(r+8);}
  if(cmap<0)throw new Error('no cmap table in '+path);
  const set=new Set(),subs=b.readUInt16BE(cmap+2),seen=new Set();
  for(let i=0;i<subs;i++){
    const r=cmap+4+8*i,pid=b.readUInt16BE(r),eid=b.readUInt16BE(r+2),o=cmap+b.readUInt32BE(r+4);
    if(!(pid===0||(pid===3&&(eid===1||eid===10)))||seen.has(o))continue;seen.add(o);
    const fmt=b.readUInt16BE(o);
    if(fmt===4){
      const sc=b.readUInt16BE(o+6)/2,end=o+14,start=end+2*sc+2,delta=start+2*sc,range=delta+2*sc;
      for(let s=0;s<sc;s++){
        const e=b.readUInt16BE(end+2*s),st=b.readUInt16BE(start+2*s),d=b.readUInt16BE(delta+2*s),ro=b.readUInt16BE(range+2*s);
        for(let c=st;c<=e&&c<0xffff;c++){
          let g;
          if(ro===0)g=(c+d)&0xffff;
          else{const p=range+2*s+ro+2*(c-st);g=p+1<b.length?b.readUInt16BE(p):0;if(g)g=(g+d)&0xffff;}
          if(g)set.add(c);
        }
      }
    }else if(fmt===12){
      const g=b.readUInt32BE(o+12);
      for(let k=0;k<g;k++){const p=o+16+12*k,st=b.readUInt32BE(p),e=b.readUInt32BE(p+4);for(let c=st;c<=e;c++)set.add(c);}
    }
  }
  return set;
}
module.exports={coverage};
if(require.main===module){
  const s=coverage(process.argv[2],+process.argv[3]||0);
  console.log(s.size+' code points');
}
