/* A small PNG writer for the tests. It is written from the PNG specification, separately from the decoder
   in src/png.js, so the two do not share a mistake by construction. Not used by the CLI.
   encode({w,h,type,depth,samples,palette,trns,filters,interlace,chunks}):   interlace: 1 writes Adam7 passes
     samples   w*h*channels numbers at the file's own bit depth (palette images: indices)
     palette   [[r,g,b],...] for type 3      trns  bytes of a tRNS chunk, or null
     filters   row filter types to cycle through, default [0]
     chunks    extra [type,Buffer] pairs written before the image data */
'use strict';
const zlib=require('zlib');
const CHANNELS={0:1,2:3,3:1,4:2,6:4};

function crc(buf){
  let c=0xffffffff;
  for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));}
  return (c^0xffffffff)>>>0;
}
function chunk(type,data){
  const body=Buffer.concat([Buffer.from(type,'latin1'),data]),out=Buffer.alloc(body.length+8);
  out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc(body),body.length+4);
  return out;
}
function paeth(a,b,c){
  const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);
  if(da<=db&&da<=dc)return a;
  return db<=dc?b:c;
}
// One row of samples packed into bytes: high bits first, 16-bit samples high byte first.
function pack(samples,from,count,depth){
  const row=Buffer.alloc(Math.ceil(count*depth/8));
  for(let k=0;k<count;k++){
    const v=samples[from+k];
    if(depth===16){row[k*2]=v>>8;row[k*2+1]=v&255;}
    else if(depth===8)row[k]=v;
    else row[(k*depth)>>3]|=v<<(8-depth-((k*depth)&7));
  }
  return row;
}
// Filters the rows of one image (or one interlace pass). Prediction starts afresh for each.
function filterRows(samples,w,h,ch,depth,filters,rows){
  const bpp=Math.max(1,(ch*depth)>>3);
  let prev=null;
  for(let y=0;y<h;y++){
    const cur=pack(samples,y*w*ch,w*ch,depth),f=filters[y%filters.length],line=Buffer.alloc(cur.length+1);
    line[0]=f;
    for(let i=0;i<cur.length;i++){
      const a=i>=bpp?cur[i-bpp]:0,b=prev?prev[i]:0,c=prev&&i>=bpp?prev[i-bpp]:0;
      const guess=f===0?0:f===1?a:f===2?b:f===3?Math.floor((a+b)/2):paeth(a,b,c);
      line[i+1]=(cur[i]-guess)&255;
    }
    rows.push(line);prev=cur;
  }
}
// Adam7: seven passes, each a coarser grid of the same picture. [first x, first y, x step, y step].
const ADAM7=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
function encode(o){
  const ch=CHANNELS[o.type],filters=o.filters||[0],rows=[];
  if(o.interlace){
    for(const [x0,y0,dx,dy] of ADAM7){
      const pw=Math.ceil((o.w-x0)/dx),ph=Math.ceil((o.h-y0)/dy);
      if(pw<=0||ph<=0)continue;
      const part=new Array(pw*ph*ch);
      for(let y=0;y<ph;y++)for(let x=0;x<pw;x++)for(let k=0;k<ch;k++)part[(y*pw+x)*ch+k]=o.samples[((y0+y*dy)*o.w+x0+x*dx)*ch+k];
      filterRows(part,pw,ph,ch,o.depth,filters,rows);
    }
  }else filterRows(o.samples,o.w,o.h,ch,o.depth,filters,rows);
  const head=Buffer.alloc(13);
  head.writeUInt32BE(o.w,0);head.writeUInt32BE(o.h,4);head[8]=o.depth;head[9]=o.type;head[12]=o.interlace||0;
  const parts=[Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head)];
  if(o.palette)parts.push(chunk('PLTE',Buffer.from(o.palette.flat())));
  if(o.trns)parts.push(chunk('tRNS',Buffer.from(o.trns)));
  for(const [type,data] of o.chunks||[])parts.push(chunk(type,data));
  // Two IDAT chunks, because real files split their data and the decoder has to join it.
  const z=zlib.deflateSync(Buffer.concat(rows)),cut=z.length>>1;
  parts.push(chunk('IDAT',z.subarray(0,cut)),chunk('IDAT',z.subarray(cut)),chunk('IEND',Buffer.alloc(0)));
  return Buffer.concat(parts);
}
// Opaque RGBA pixels as an 8-bit RGB file: the form the tests feed to the CLI and to Chrome.
function rgb(img,filters){
  const samples=new Uint8Array(img.w*img.h*3);
  for(let p=0;p<img.w*img.h;p++)for(let k=0;k<3;k++)samples[p*3+k]=img.data[p*4+k];
  return encode({w:img.w,h:img.h,type:2,depth:8,samples,filters:filters||[0,1,2,3,4]});
}
function rgba(img,filters){
  return encode({w:img.w,h:img.h,type:6,depth:8,samples:img.data,filters:filters||[0,1,2,3,4]});
}
module.exports={encode,rgb,rgba,chunk,crc};
