/* Zalgo calibration: asks the browser how a font stacks each combining mark. Browser only.
   The result is a plain profile object that Zalgo.metrics() accepts, so it can be saved and used by the CLI.
   All lengths are in em. */
(function(root){
'use strict';
const S=String.fromCodePoint,F=50,CW=180,CH=1600,BL=800,X0=70;
const A_UP=0x33f,A_DN=0x333;                       // anchors, see ANCHOR in zalgo-core.js
const BASES=['i','l','o','.',S(0x2013),S(0xa0),S(0x2206),S(0x2027),S(0x2cd)];   // the last three are for Slack and X, see PLATFORMS
const r4=v=>Math.round(v*1e4)/1e4,r3=v=>Math.round(v*1e3)/1e3;
let g=null;
function ctx(){
  if(!g){const c=document.createElement('canvas');c.width=CW;c.height=CH;g=c.getContext('2d',{willReadFrequently:true});}
  return g;
}
function ext(font,str){
  const g=ctx();g.clearRect(0,0,CW,CH);g.font=font;g.fillStyle='#000';g.fillText(str,X0,BL);
  const d=g.getImageData(0,0,CW,CH).data,rows=new Float32Array(CH);let top=-1,bot=-1;
  for(let y=0;y<CH;y++){let s=0;for(let x=0,i=y*CW*4+3;x<CW;x++,i+=4)s+=d[i];rows[y]=s/255;if(s){if(top<0)top=y;bot=y;}}
  return {up:top<0?0:BL-top,dn:bot<0?0:bot-BL+1,rows};
}
// Combining class from normalisation alone: 230 (above), 220 (below), 0 for everything else.
// Marks are sorted by class, so a mark that swaps places with a known one has a different class.
function ccc(cp){
  const m=S(cp),U=S(0x301),D=S(0x316),same=s=>s.normalize('NFD')===s;
  if(!same(m)||m.normalize('NFKD')!==m)return 0;
  if(same('a'+m+U)&&same('a'+U+m)&&!same('a'+m+D))return 230;
  if(same('a'+m+D)&&same('a'+D+m)&&!same('a'+U+m))return 220;
  return 0;
}
/* Every measurement is made on a letter that already carries both anchors, in the order the encoder writes
   (below marks, then above marks). That is the state a real column is in, and it is the only state in which
   brand fonts and system fonts agree. */
function calibrate(family){
  const font=F+'px '+family,g=ctx(),up=[],dn=[],au=S(A_UP),ad=S(A_DN);
  g.font=font;
  const oAdv=g.measureText('o').width,wide=g.measureText('o'+ad+au).width;
  for(let cp=0x300;cp<=0x36f;cp++){
    const c=ccc(cp);if(!c)continue;
    const ch=S(cp),str=n=>c===230?'o'+ad+au+ch.repeat(n):'o'+ad+ch.repeat(n)+au;
    // A mark the font lacks sends the whole column to another font, which would change every other pitch.
    g.font=font;if(Math.abs(g.measureText(str(1)).width-wide)>.01)continue;
    const a=ext(font,str(10)),b=ext(font,str(40));let ink=0;
    if(c===230){
      const p=(b.up-a.up)/30;if(p<1||Math.abs(b.dn-a.dn)>1)continue;
      for(let y=BL-b.up;y<BL-a.up;y++)ink+=b.rows[y];
      up.push([cp,r4(p/F),r3(ink/((b.up-a.up)*oAdv))]);
    }else{
      const p=(b.dn-a.dn)/30;if(p<1||Math.abs(b.up-a.up)>1)continue;
      for(let y=BL+a.dn;y<BL+b.dn;y++)ink+=b.rows[y];
      dn.push([cp,r4(p/F),r3(ink/((b.dn-a.dn)*oAdv))]);
    }
  }
  const pitch=(l,cp)=>{const m=l.find(x=>x[0]===cp);return m?m[1]*F:0;},pu=pitch(up,A_UP),pd=pitch(dn,A_DN),bases={};
  if(pu&&pd)for(const ch of BASES){
    g.font=font;
    const adv=g.measureText(ch+ad+au).width,e=ext(font,ch+ad.repeat(10)+au.repeat(10));
    bases[ch.codePointAt(0).toString(16)]=[r4(adv/F),r4((e.up-10*pu)/F),r4((e.dn-10*pd)/F)];
  }
  // Safari spaces Helvetica's marks itself, so a profile made there already has its spacing. See metrics().
  const ua=navigator.userAgent,apple=/AppleWebKit/.test(ua)&&!/Chrome\/|Chromium\/|Edg\//.test(ua);
  return apple?{font:family,up,dn,bases,apple:[0,0]}:{font:family,up,dn,bases};
}
// How far a finished line really reaches, to compare with what the metrics predicted.
function extent(family,line,up,dn){
  const f=24,c=document.createElement('canvas'),g0=c.getContext('2d');
  g0.font=f+'px '+family;const w=g0.measureText(line).width;
  c.width=Math.ceil(w+4*f);c.height=Math.ceil((up+dn+4)*f);
  const g1=c.getContext('2d',{willReadFrequently:true}),bl=Math.round((up+2)*f);
  g1.font=f+'px '+family;g1.fillStyle='#000';g1.fillText(line,2*f,bl);
  const d=g1.getImageData(0,0,c.width,c.height).data;let top=-1,bot=-1;
  for(let y=0;y<c.height;y++){let s=0;for(let x=0,i=y*c.width*4+3;x<c.width;x++,i+=4)s+=d[i];if(s){if(top<0)top=y;bot=y;}}
  return {up:top<0?0:(bl-top)/f,dn:bot<0?0:(bot-bl+1)/f,width:w/f};
}
root.ZalgoCal={calibrate,extent,ccc};
})(typeof self!=='undefined'?self:this);
