/* PNG decoder for the CLI: file bytes in, {w,h,data} out, where data is RGBA, 8 bits a channel, not
   premultiplied. Node built-ins only. Handles colour types 0, 2, 3, 4 and 6 at every legal bit depth, tRNS,
   all five row filters and Adam7 interlacing. Every failure is a PngError with a one-line message.
   The results were compared with Chrome's own decoder, pixel for pixel, so the CLI and the page agree. */
'use strict';
const zlib=require('zlib');

const SIGNATURE=[137,80,78,71,13,10,26,10];
const CHANNELS={0:1,2:3,3:1,4:2,6:4};
const DEPTHS={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};

class PngError extends Error{
  constructor(msg,code){super(msg);this.name='PngError';this.code=code||'PNG_BAD';}
}
const bad=(msg,code)=>{throw new PngError(msg,code);};

// Checksums are checked because a damaged file otherwise decodes to noise without any warning.
const CRC=new Int32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;CRC[n]=c;}
function crc32(buf,from,to){
  let c=-1;
  for(let i=from;i<to;i++)c=CRC[(c^buf[i])&255]^(c>>>8);
  return (c^-1)>>>0;
}

const isPng=buf=>buf.length>=8&&SIGNATURE.every((b,i)=>buf[i]===b);

// Reads the chunks up to IEND. Returns the header and the pieces the decoder needs.
function parse(buf){
  if(!isPng(buf))bad('not a PNG file','PNG_SIGNATURE');
  let p=8,head=null,plte=null,trns=null,exif=null,ended=false;const idat=[];
  while(!ended){
    if(p+12>buf.length)bad(head?'the file is cut short':'the file has no header');
    const len=buf.readUInt32BE(p),type=buf.toString('latin1',p+4,p+8),at=p+8;
    if(at+len+4>buf.length)bad('the file is cut short (inside the '+type.replace(/[^A-Za-z]/g,'?')+' chunk)');
    if(crc32(buf,p+4,at+len)!==buf.readUInt32BE(at+len))bad('the file is damaged (checksum of the '+type.replace(/[^A-Za-z]/g,'?')+' chunk is wrong)');
    if(!head&&type!=='IHDR')bad('the header is missing');
    if(type==='IHDR'){
      if(head||len!==13)bad('the header is malformed');
      head={w:buf.readUInt32BE(at),h:buf.readUInt32BE(at+4),depth:buf[at+8],type:buf[at+9],interlace:buf[at+12]};
      if(!head.w||!head.h||head.w>0x7fffffff||head.h>0x7fffffff)bad('the header gives an impossible size');
      if(!DEPTHS[head.type]||!DEPTHS[head.type].includes(head.depth))bad('unknown colour type '+head.type+' at '+head.depth+' bits');
      if(buf[at+10]||buf[at+11])bad('unknown compression or filter method');
      if(head.interlace>1)bad('unknown interlace method');
    }else if(type==='PLTE'){
      if(len%3||len>768||!len)bad('the palette is malformed');
      plte=buf.subarray(at,at+len);
    }else if(type==='tRNS')trns=buf.subarray(at,at+len);
    else if(type==='eXIf')exif=buf.subarray(at,at+len);
    else if(type==='IDAT')idat.push(buf.subarray(at,at+len));
    else if(type==='IEND')ended=true;
    p=at+len+4;
  }
  return {head,plte,trns,exif,idat};
}

// Size and format without decoding the pixels.
function header(buf){
  const h=parse(buf).head;
  return {w:h.w,h:h.h,depth:h.depth,type:h.type,interlaced:h.interlace===1};
}

// Undo the per-row prediction in place, for the h rows that start at byte `base`. Each row starts with one
// byte naming the filter.
function unfilter(raw,base,h,rowBytes,bpp){
  const stride=rowBytes+1;
  for(let y=0;y<h;y++){
    const o=base+y*stride+1,f=raw[o-1],up=o-stride;
    if(f===0)continue;
    if(f===1){for(let i=bpp;i<rowBytes;i++)raw[o+i]=(raw[o+i]+raw[o+i-bpp])&255;}
    else if(f===2){if(y)for(let i=0;i<rowBytes;i++)raw[o+i]=(raw[o+i]+raw[up+i])&255;}
    else if(f===3){
      for(let i=0;i<rowBytes;i++){
        const a=i>=bpp?raw[o+i-bpp]:0,b=y?raw[up+i]:0;
        raw[o+i]=(raw[o+i]+((a+b)>>1))&255;
      }
    }else if(f===4){
      for(let i=0;i<rowBytes;i++){
        const a=i>=bpp?raw[o+i-bpp]:0,b=y?raw[up+i]:0,c=i>=bpp&&y?raw[up+i-bpp]:0;
        // Paeth: whichever of left, up, upper-left is closest to left + up - upper-left. Ties go in that order.
        const pa=Math.abs(b-c),pb=Math.abs(a-c),pc=Math.abs(a+b-2*c);
        raw[o+i]=(raw[o+i]+(pa<=pb&&pa<=pc?a:pb<=pc?b:c))&255;
      }
    }else bad('row '+y+' names an unknown filter ('+f+')');
  }
}

// EXIF orientation (1 to 8) from an eXIf chunk, or 1. Converters keep a rotated photo's pixels as shot and
// record the turn here, so a phone photo comes out sideways unless this is applied.
function orientation(exif){
  if(!exif||exif.length<14)return 1;
  const le=exif[0]===0x49&&exif[1]===0x49;
  if(!le&&!(exif[0]===0x4d&&exif[1]===0x4d))return 1;
  const u16=p=>le?exif.readUInt16LE(p):exif.readUInt16BE(p),u32=p=>le?exif.readUInt32LE(p):exif.readUInt32BE(p);
  const dir=u32(4);if(dir+2>exif.length)return 1;
  const n=u16(dir);
  for(let k=0;k<n;k++){
    const e=dir+2+k*12;if(e+12>exif.length)break;
    if(u16(e)===0x112){const v=u16(e+8);return v>=1&&v<=8?v:1;}
  }
  return 1;
}
function orient(img,o){
  if(o<2||o>8)return img;
  const {w,h,data}=img,swap=o>=5,W=swap?h:w,H=swap?w:h,out=new Uint8ClampedArray(W*H*4);
  const src=new Uint32Array(data.buffer,data.byteOffset,w*h),dst=new Uint32Array(out.buffer);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    let sx,sy;
    switch(o){
      case 2:sx=w-1-x;sy=y;break;
      case 3:sx=w-1-x;sy=h-1-y;break;
      case 4:sx=x;sy=h-1-y;break;
      case 5:sx=y;sy=x;break;
      case 6:sx=y;sy=h-1-x;break;
      case 7:sx=w-1-y;sy=h-1-x;break;
      default:sx=w-1-y;sy=x;
    }
    dst[y*W+x]=src[sy*w+sx];
  }
  return {w:W,h:H,data:out};
}

// Unfiltered rows of a w x h image starting at byte `base`, as RGBA.
function toRgba(raw,base,w,h,head,plte,trns){
  const {depth,type}=head,ch=CHANNELS[type],stride=Math.ceil(w*ch*depth/8)+1,out=new Uint8ClampedArray(w*h*4);
  if(depth===16){
    // 16 bits to 8 by keeping the high byte, which is what browsers do when they draw to a canvas.
    const key=trns&&(type===0&&trns.length>=2?[trns.readUInt16BE(0)]:type===2&&trns.length>=6?[trns.readUInt16BE(0),trns.readUInt16BE(2),trns.readUInt16BE(4)]:null);
    for(let y=0,o=0;y<h;y++){
      let i=base+y*stride+1;
      for(let x=0;x<w;x++,o+=4,i+=ch*2){
        if(type===0||type===4){out[o]=out[o+1]=out[o+2]=raw[i];out[o+3]=type===4?raw[i+2]:255;}
        else{out[o]=raw[i];out[o+1]=raw[i+2];out[o+2]=raw[i+4];out[o+3]=type===6?raw[i+6]:255;}
        // tRNS names one colour, at full depth, that is fully transparent.
        if(key){let same=true;for(let k=0;k<key.length;k++)if(((raw[i+2*k]<<8)|raw[i+2*k+1])!==key[k])same=false;if(same)out[o+3]=0;}
      }
    }
  }else if(type===2||type===4||type===6){
    const key=type===2&&trns&&trns.length>=6?[trns.readUInt16BE(0),trns.readUInt16BE(2),trns.readUInt16BE(4)]:null;
    for(let y=0,o=0;y<h;y++){
      let i=base+y*stride+1;
      for(let x=0;x<w;x++,o+=4,i+=ch){
        if(type===4){out[o]=out[o+1]=out[o+2]=raw[i];out[o+3]=raw[i+1];}
        else{
          out[o]=raw[i];out[o+1]=raw[i+1];out[o+2]=raw[i+2];out[o+3]=type===6?raw[i+3]:255;
          if(key&&raw[i]===key[0]&&raw[i+1]===key[1]&&raw[i+2]===key[2])out[o+3]=0;
        }
      }
    }
  }else{
    // Grey or palette, 1 to 8 bits a pixel, packed from the high bit of each byte down.
    const max=(1<<depth)-1,key=type===0&&trns&&trns.length>=2?trns.readUInt16BE(0):-1,colours=plte?plte.length/3:0;
    for(let y=0,o=0;y<h;y++){
      const row=base+y*stride+1;
      for(let x=0;x<w;x++,o+=4){
        const bit=x*depth,v=(raw[row+(bit>>3)]>>(8-depth-(bit&7)))&max;
        if(type===3){
          // An index past the end of the palette is drawn black, as libpng does.
          if(v<colours){out[o]=plte[v*3];out[o+1]=plte[v*3+1];out[o+2]=plte[v*3+2];}
          out[o+3]=trns&&v<trns.length?trns[v]:255;
        }else{
          out[o]=out[o+1]=out[o+2]=Math.round(v*255/max);out[o+3]=v===key?0:255;
        }
      }
    }
  }
  return out;
}

// Adam7 interlacing stores the picture as seven passes, each a coarser grid: [first x, first y, x step, y step].
const ADAM7=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];

/* opts.maxPixels: refuse larger images with code PNG_TOO_BIG, before any memory is taken.
   opts.orient: apply the EXIF orientation of an eXIf chunk, as browsers do. */
function decode(buf,opts){
  opts=opts||{};
  const {head,plte,trns,exif,idat}=parse(buf),{w,h,depth,type}=head;
  if(opts.maxPixels&&w*h>opts.maxPixels)bad('the image is '+w+' x '+h+' pixels, which is too large','PNG_TOO_BIG');
  if(type===3&&!plte)bad('the palette is missing');
  if(!idat.length)bad('the file has no image data');
  const ch=CHANNELS[type],bpp=Math.max(1,ch*depth>>3),rowBytes=n=>Math.ceil(n*ch*depth/8);
  // The parts of the data stream: the whole image, or the passes that are not empty.
  const parts=[];let need=0;
  for(const [x0,y0,dx,dy] of head.interlace?ADAM7:[[0,0,1,1]]){
    const pw=Math.ceil((w-x0)/dx),ph=Math.ceil((h-y0)/dy);
    if(pw<=0||ph<=0)continue;
    parts.push({x0,y0,dx,dy,pw,ph,base:need});need+=(rowBytes(pw)+1)*ph;
  }
  let raw;
  // The output limit stops a small file that inflates to gigabytes.
  try{raw=zlib.inflateSync(Buffer.concat(idat),{maxOutputLength:need});}
  catch(e){bad(e.code==='ERR_BUFFER_TOO_LARGE'?'the file holds more image data than its header declares':'the image data is damaged ('+(e.message||e.code)+')');}
  if(raw.length<need)bad('the image data is cut short');
  let out;
  for(const p of parts){
    unfilter(raw,p.base,p.ph,rowBytes(p.pw),bpp);
    const px=toRgba(raw,p.base,p.pw,p.ph,head,plte,trns);
    if(!head.interlace){out=px;break;}
    if(!out)out=new Uint8ClampedArray(w*h*4);
    for(let y=0,i=0;y<p.ph;y++)for(let x=0;x<p.pw;x++,i+=4){
      const o=((p.y0+y*p.dy)*w+p.x0+x*p.dx)*4;
      out[o]=px[i];out[o+1]=px[i+1];out[o+2]=px[i+2];out[o+3]=px[i+3];
    }
  }
  const img={w,h,data:out};
  return opts.orient?orient(img,orientation(exif)):img;
}

module.exports={decode,header,isPng,crc32,PngError};
