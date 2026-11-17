/* Zalgo core: pure functions shared by the page and the CLI. No DOM, no dependencies.
   All lengths are in em, so results do not depend on the font size a platform uses. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();else root.Zalgo=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';
const S=String.fromCodePoint,NL=S(10),NBSP=S(0xa0),PAD=S(0x2800);
const seg=new Intl.Segmenter();
// Dots, bars, rings and strokes read as tone. The rest of the block is kept for glitch only.
const CLEAN=new Set([0x304,0x305,0x307,0x308,0x30a,0x30d,0x30e,0x33f,0x346,0x323,0x324,0x325,0x329,0x331,0x332,0x333,0x347,0x348]);
// Shading a picture uses only the marks that tile into an even texture when columns stand side by side: bars,
// dots and ticks. A ring or a bracket is clean too, but a field of them reads as bubbles, not as a grey.
const SHADE=new Set([0x304,0x305,0x33f,0x307,0x308,0x30d,0x30e,0x331,0x332,0x333,0x323,0x324,0x329,0x348]);
// Marks that brand fonts (Chirp on X, Inter on Bluesky) do not contain. One of these in a column makes the
// browser draw the whole column with the system font, which stacks every mark. Without one, the brand font
// draws common accents itself and piles them on the same spot.
const ANCHOR=new Set([0x33f,0x30d,0x333]);
const MID=[0x334,0x335,0x336,0x337,0x338].map(c=>S(c));
// Apple's text engine (Safari, and the iPhone, iPad and Mac apps built on it) stacks the first 30 marks of a
// column and draws every later one on a single line. Measured in WebKit on macOS with Helvetica alone, so it
// belongs to the engine and not to a platform. Chrome and Firefox stacked 90.
const STACK=30;

/* ---------- counting, the way each platform does it ---------- */
const count={
  utf16:t=>t.length,
  codepoints:t=>{let n=0;for(const c of t)n++;return n;},
  bytes:t=>{let n=0;for(const c of t){const p=c.codePointAt(0);n+=p<0x80?1:p<0x800?2:p<0x10000?3:4;}return n;},
  graphemes:t=>{let n=0;for(const g of seg.segment(t))n++;return n;},
  // Mastodon's web composer (stringz): a letter with n marks counts about 1 + ceil((n-2)/3).
  mastodon:t=>{let n=0;for(const g of seg.segment(t)){let k=-1;for(const c of g.segment)k++;n+=1+Math.max(0,Math.ceil((k-2)/3));}return n;},
  // twitter-text v3: NFC first, then 1 for U+0000-10FF and a few punctuation ranges, 2 for everything else.
  weighted:t=>{let w=0;for(const c of t.normalize('NFC')){const p=c.codePointAt(0);w+=(p<=4351||(p>=8192&&p<=8205)||(p>=8208&&p<=8223)||(p>=8242&&p<=8247))?1:2;}return w;}
};
const UNIT={utf16:'UTF-16 units',codepoints:'code points',bytes:'UTF-8 bytes',graphemes:'graphemes',weighted:'weighted characters',mastodon:'characters, as the web composer counts'};

/* ---------- platforms ----------
   limit/unit: how long a post may be and what is counted.   second: an extra limit that also applies.
   width: text column of a phone, in em.   lh: line height in em.
   clip: 'post' = stacks are cut at the post's box, 'none' = they spill over neighbours, 'unknown'.
   marks: 'kept' | 'stripped' | 'unknown'.   blank: advance of a lone NBSP in the brand font, when measured.
   base: what a column stands on by default.   carrier: the only characters a column may stand on and still
   stack everywhere. A column stacks when one font draws all of it. Chrome hands a whole column to the first
   font that has every character in it. Firefox chooses a font character by character: it draws a blank or a
   letter in the platform's own font and leaves the marks, in the next font, with nothing to stack on. So the
   letter itself has to be missing from the platform's font (and on Slack, whose font has the marks but piles
   them on one spot, that is the only way in any browser).
   flat: what to say about a column on any other letter.   flatLevel: 'fail' unless given.
   src: 'measured' on the live site in Chrome on macOS, 'font' = only the stacking was measured, in the
   platform's font stack, 'documented', or 'unverified'. */
const X_FLAT='A pile on a blank or an ordinary letter comes out flat on X in Firefox: X\'s own font draws the letter and the marks are left with nothing to stack on. Chrome and Safari stack it. Only a column standing on '+S(0x2cd)+' stacks in all three.';
const X_NOTE='X counts every mark as 1 and an invisible spacer as 2. Picture columns stand on '+S(0x2cd)+', which X\'s own font lacks, so the system font draws the whole column and stacks it. Checked with X\'s fonts in Chrome, Firefox and Safari\'s engine on macOS. The compose box, Windows and the phone apps were not.';
const DISCORD_NOTE='Blank width taken from Discord\'s own font in Chrome, which the desktop app is built on. Firefox, Safari and the phone apps were not checked.';
const PLATFORMS=[
  {id:'x',name:'X (280)',limit:280,unit:'weighted',second:null,width:20.5,lh:1.333,clip:'none',marks:'kept',blank:.226,base:'low',carrier:[0x2cd],flatLevel:'warn',flat:X_FLAT,src:'measured',note:X_NOTE},
  {id:'xpremium',name:'X Premium (25,000)',limit:25000,unit:'weighted',second:null,width:20.5,lh:1.333,clip:'none',marks:'kept',blank:.226,base:'low',carrier:[0x2cd],flatLevel:'warn',flat:X_FLAT,src:'measured',
   fold:{lines:1e9,chars:280,level:'warn',msg:'Over 280 the timeline shows only the start of the post until someone opens it, so the picture is cut there.'},note:X_NOTE},
  {id:'bluesky',name:'Bluesky',limit:300,unit:'graphemes',second:{limit:3000,unit:'bytes'},width:20,lh:1.333,clip:'post',marks:'kept',blank:.25,src:'measured',
   fold:{lines:24,msg:'The feed folds posts of 25 lines or more.'},note:'A column is one grapheme, so the 3,000 byte cap is the real limit: each mark is 2 bytes.'},
  {id:'mastodon',name:'Mastodon',limit:500,unit:'mastodon',second:null,width:20,lh:1.467,clip:'post',marks:'kept',src:'documented',
   note:'The server counts one per letter, but the web composer counts about one per three marks and blocks sending over the limit. Servers can raise the limit.'},
  {id:'discord',name:'Discord',limit:2000,unit:'utf16',second:null,width:18.5,lh:1.375,clip:'post',marks:'kept',blank:.22,src:'documented',note:'Nitro allows 4,000. '+DISCORD_NOTE},
  {id:'discordnitro',name:'Discord Nitro',limit:4000,unit:'utf16',second:null,width:18.5,lh:1.375,clip:'post',marks:'kept',blank:.22,src:'documented',note:DISCORD_NOTE},
  {id:'reddit',name:'Reddit comment',limit:10000,unit:'codepoints',second:null,width:20,lh:1.43,clip:'unknown',marks:'unknown',src:'documented',note:'Post bodies allow 40,000.'},
  {id:'telegram',name:'Telegram',limit:4096,unit:'utf16',second:null,width:18,lh:1.3,clip:'unknown',marks:'capped',cap:2,src:'documented',
   note:'Telegram Desktop draws at most 2 marks per letter, so pictures only have a chance in the phone apps.'},
  {id:'threads',name:'Threads',limit:500,unit:'utf16',second:null,width:20,lh:1.35,clip:'unknown',marks:'unknown',src:'unverified',note:'Threads does not say what it counts. If it counts bytes, each mark costs 2.'},
  {id:'instagram',name:'Instagram caption',limit:2200,unit:'utf16',second:null,width:20,lh:1.3,clip:'unknown',marks:'unknown',src:'unverified',
   fold:{lines:2,msg:'Captions fold after a couple of lines until tapped.'},note:''},
  {id:'tiktok',name:'TikTok comment',limit:150,unit:'utf16',second:null,width:18,lh:1.3,clip:'unknown',marks:'unknown',src:'unverified',note:''},
  {id:'youtube',name:'YouTube comment',limit:10000,unit:'utf16',second:null,width:20,lh:1.43,clip:'unknown',marks:'unknown',src:'unverified',
   fold:{lines:4,msg:'Comments fold after four lines until Read more is tapped.'},note:'Live chat is 200 characters and rejects special characters.'},
  {id:'twitch',name:'Twitch chat',limit:500,unit:'utf16',second:null,width:16,lh:1.5,clip:'unknown',marks:'unknown',src:'documented',note:'Twitch can drop a message for "too many characters that cannot be processed".'},
  {id:'whatsapp',name:'WhatsApp',limit:65536,unit:'utf16',second:null,width:17,lh:1.3,clip:'unknown',marks:'unknown',src:'unverified',note:''},
  {id:'slack',name:'Slack',limit:4000,unit:'utf16',second:null,width:20,lh:1.467,clip:'unknown',marks:'kept',blank:.256,base:'point',carrier:[0x2027,0x2206],src:'font',
   flat:"Slack's own font (Lato) has every mark but draws them all at one height, so a pile on any ordinary letter comes out as a flat line. A pile only stacks on "+S(0x2027)+' or '+S(0x2206)+', which Lato lacks.',
   note:'Slack asks for 4,000 and cuts text off at 40,000. Columns stand on '+S(0x2027)+', checked on macOS only. If it comes out flat for someone on Windows, switch to '+S(0x2206)+': coarser, but in the fallback font of both systems.'},
  {id:'facebook',name:'Facebook post',limit:63206,unit:'utf16',second:null,width:20,lh:1.34,clip:'unknown',marks:'unknown',src:'unverified',note:'Comments allow 8,000.'},
  {id:'sms',name:'SMS (one segment)',limit:70,unit:'utf16',second:null,width:17,lh:1.3,clip:'unknown',marks:'unknown',src:'documented',note:'Marks force the 16-bit encoding: 70 units per text, 67 each when it is split.'},
  {id:'custom',name:'Custom limit',limit:2000,unit:'utf16',second:null,width:20,lh:1.35,clip:'unknown',marks:'unknown',src:'unverified',note:''}
];
const platform=id=>PLATFORMS.find(p=>p.id===id)||PLATFORMS[0];
const measure=(t,P)=>count[P.unit](t);

/* ---------- font metrics ---------- */
function metrics(profile){
  const mk=a=>({cp:a[0],ch:S(a[0]),pitch:a[1],ink:a[2]});
  const up=profile.up.map(mk),dn=profile.dn.map(mk),bases={};
  for(const k in profile.bases){const b=profile.bases[k],ch=S(parseInt(k,16));bases[ch]={ch,adv:b[0],up0:b[1],dn0:b[2]};}
  const clean=l=>{const c=l.filter(m=>CLEAN.has(m.cp));return c.length>=2?c:l;};
  const shade=l=>{const c=l.filter(m=>SHADE.has(m.cp));return c.length>=2?c:clean(l);};
  const any=bases.l||bases.o||{adv:.25,up0:.7,dn0:.05};
  // Helvetica has no stacking rules of its own, so each engine spaces its marks its own way. Apple's adds this
  // much to every mark above and below (measured against Chrome, the same for all 86 marks). Fonts that carry
  // the rules, like Arial, come out the same everywhere. A profile measured in Safari says [0,0].
  const apple=profile.apple||(/helvetica/i.test(profile.font||'')?[.0275,.0425]:[0,0]);
  return {font:profile.font,up,dn,artUp:clean(up),artDn:clean(dn),shadeUp:shade(up),shadeDn:shade(dn),bases,apple,ok:up.length>0&&dn.length>0,
    base:ch=>bases[ch]||{ch,adv:(bases.o||any).adv,up0:any.up0,dn0:any.dn0}};
}

function palette(list,tones,tall){
  const inks=list.map(m=>m.ink),lo=Math.min(...inks),hi=Math.max(...inks),sign=tall?-1:1,pick=new Set();
  for(let k=0;k<tones;k++){
    const t=tones===1?hi:lo+(hi-lo)*k/(tones-1);let best=null,bs=1e9;
    for(const m of list){const s=Math.abs(m.ink-t)+sign*.35*m.pitch;if(s<bs){bs=s;best=m;}}
    pick.add(best);
  }
  const p=[...pick].sort((a,b)=>a.ink-b.ink);
  p.mean=p.reduce((s,m)=>s+m.pitch,0)/p.length;
  return p;
}

/* ---------- making a column safe to post ---------- */
const composes=(base,mark)=>(base+mark).normalize('NFC')!==base+mark;
function nearest(list,m,ok){
  let best=null,bs=1e9;
  for(const q of list){if(!ok(q))continue;const s=Math.abs(q.ink-m.ink)+.5*Math.abs(q.pitch-m.pitch);if(s<bs){bs=s;best=q;}}
  return best;
}
// The first mark on each side is the only one normalisation can fuse with the letter (i + macron = one
// character). Swap it for the closest mark that does not fuse, then make sure the column has an anchor.
function fixColumn(base,dn,up,M){
  base=base[base.length-1];
  const safe=q=>!composes(base,q.ch);
  if(dn.length&&!safe(dn[0]))dn[0]=nearest(M.artDn,dn[0],safe)||nearest(M.dn,dn[0],safe)||dn[0];
  if(up.length&&!safe(up[0]))up[0]=nearest(M.artUp,up[0],safe)||nearest(M.up,up[0],safe)||up[0];
  const anch=q=>ANCHOR.has(q.cp);
  if(dn.some(anch)||up.some(anch))return;
  if(up.length){const a=nearest(M.up,up[0],anch);if(a){up[0]=a;return;}}
  if(dn.length){const a=nearest(M.dn,dn[0],anch);if(a)dn[0]=a;}
}

/* ---------- base letters ----------
   What each column stands on. 'blank' is a no-break space: it has width and no ink, so the picture has no
   row of letters through it. 'wide' puts an empty no-break space in front of the platform's usual letter,
   which widens the column for one extra character, so a small limit holds a bigger picture. */
const BASES=[
  {id:'blank',name:'Blank (no letter row)'},
  {id:'wide',name:'Wide (a blank in front of each column)'},
  {id:'auto',name:'i / l by tone'},
  {id:'l',name:'l'},{id:'i',name:'i'},{id:'dot',name:'. (dot)'},{id:'o',name:'o (wide)'},
  {id:'low',name:S(0x2cd)+' (X, every browser)'},
  {id:'point',name:S(0x2027)+' (Slack, finest)'},
  {id:'delta',name:S(0x2206)+' (Slack, Windows fonts too)'}
];
function baseSet(id,tones,M,P){
  const blank=(P&&P.blank)||M.base(NBSP).adv,mk=(ch,m,lead)=>({ch,adv:m.adv+(lead||0),up0:m.up0,dn0:m.dn0});
  switch(id){
    case 'auto':return tones>1?[mk('i',M.base('i')),mk('l',M.base('l'))]:[mk('l',M.base('l'))];
    case 'dot':return [mk('.',M.base('.'))];
    case 'blank':return [mk(NBSP,M.base(NBSP))];
    case 'wide':{const ch=P&&P.carrier?S(P.carrier[0]):NBSP;return [mk(NBSP+ch,M.base(ch),blank)];}
    case 'low':return [mk(S(0x2cd),M.base(S(0x2cd)))];
    case 'delta':return [mk(S(0x2206),M.base(S(0x2206)))];
    case 'point':return [mk(S(0x2027),M.base(S(0x2027)))];
    default:return [mk(id,M.base(id))];
  }
}

/* ---------- encoder: source {w,h,ink,mask} -> one line of text ----------
   Marks below are written before marks above. That is Unicode's canonical order, so a platform that
   normalises the text finds nothing to move. */
function encode(src,o,M,P){
  const pal={up:palette(M.shadeUp||M.artUp,o.tones,o.tall),dn:palette(M.shadeDn||M.artDn,o.tones,o.tall)};
  // One tone means a silhouette, so 'auto' keeps a single base letter and the rows stay level.
  const bases=baseSet(o.base||(P&&P.base)||'blank',o.tones,M,P);
  const blankAdv=(P&&P.blank)||M.base(NBSP).adv;
  const {w,h,ink,mask}=src,s=o.cols*bases[0].adv/w,rb=o.baseline*h,W=w*s;
  const avg=(x0,x1,ya,yb)=>{
    let r0=Math.max(0,Math.floor(ya)),r1=Math.min(h,Math.max(Math.floor(ya)+1,Math.ceil(yb))),t=0,n=0;
    for(let y=r0;y<r1;y++)for(let x=x0;x<x1;x++){t+=ink[y*w+x];n++;}
    return n?t/n:0;
  };
  // Which of n tones most of the drawn pixels in a cell have. The empty part of a cell on the edge of a shape
  // does not count, and a cell across two inks takes one of them: averaging gave both a stray in-between mark.
  const major=(x0,x1,ya,yb,n)=>{
    const r0=Math.max(0,Math.floor(ya)),r1=Math.min(h,Math.max(Math.floor(ya)+1,Math.ceil(yb))),c=new Array(n).fill(0);let b=0;
    for(let y=r0;y<r1;y++)for(let x=x0;x<x1;x++){const q=y*w+x;if(mask[q])c[Math.min(n-1,ink[q]*n|0)]++;}
    for(let k=1;k<n;k++)if(c[k]&&c[k]>=c[b])b=k;
    return b;
  };
  // cell(a,c,n): the tone of the cell from a to c em off the line, as an index into n tones, or its mean ink if n is 0.
  const walk=(p,y0,end,cell)=>{
    let y=y0,err=0;const out=[],lo=p[0].ink,hi=p[p.length-1].ink;
    for(;;){
      let m,want;
      if(o.dither){
        const t=cell(y,y+p.mean,0);want=lo+t*(hi-lo)+err;m=p[Math.min(p.length-1,t*p.length|0)];
        for(const q of p)if(Math.abs(q.ink-want)<Math.abs(m.ink-want))m=q;
      }else m=p[cell(y,y+p.mean,p.length)];
      if(y+m.pitch*.5>end)break;
      if(o.dither)err=Math.max(lo-hi,Math.min(hi-lo,want-m.ink));out.push(m);y+=m.pitch;
    }
    return out;
  };
  const cols=[],xs=[];let x=0;
  while(x<W-bases[0].adv*.5){
    xs.push(x/s);
    const x0=Math.min(w-1,Math.floor(x/s)),x1=Math.min(w,Math.max(x0+1,Math.floor((x+bases[0].adv)/s)));
    let yt=-1,yb=-1;
    for(let y=0;y<h;y++)for(let xx=x0;xx<x1;xx++)if(mask[y*w+xx]){if(yt<0)yt=y;yb=y;break;}
    if(yt<0){cols.push(null);x+=blankAdv;continue;}
    const b=bases.length>1&&avg(x0,x1,rb-bases[1].up0/s,rb)>.45?bases[1]:bases[0];
    const up=walk(pal.up,b.up0,(rb-yt)*s,(a,c,n)=>n?major(x0,x1,rb-c/s,rb-a/s,n):avg(x0,x1,rb-c/s,rb-a/s));
    const dn=walk(pal.dn,b.dn0,(yb+1-rb)*s,(a,c,n)=>n?major(x0,x1,rb+a/s,rb+c/s,n):avg(x0,x1,rb+a/s,rb+c/s));
    fixColumn(b.ch,dn,up,M);
    cols.push({b,up,dn});x+=b.adv;
  }
  xs.push(x/s);
  // The cells the text is made of, in source pixels, so a page can rule them over the picture: the edges of
  // every column, how far the first mark starts from the line, and the height of one dark mark.
  const row=p=>p[p.length-1].pitch/s;
  return Object.assign(assemble(cols,blankAdv,pal,M),{grid:{xs,baseline:rb,up0:bases[0].up0/s,dn0:bases[0].dn0/s,rowUp:row(pal.up),rowDn:row(pal.dn)}});
}
// Columns ({b,up,dn}, or null for a gap) -> the line of text and its size.
function assemble(cols,blankAdv,pal,M){
  // A blank column with no marks is plain whitespace, the same as a gap. Platforms trim it from either end
  // of a post, so it is dropped here and the text starts and ends on a column that carries marks.
  const bare=c=>!c||(!c.up.length&&!c.dn.length&&c.b.ch[c.b.ch.length-1]===NBSP);
  while(cols.length&&bare(cols[0]))cols.shift();
  while(cols.length&&bare(cols[cols.length-1]))cols.pop();
  let line='',up=0,dn=0,width=0,tallest=0;
  const sum=l=>l.reduce((t,m)=>t+m.pitch,0),str=l=>l.map(m=>m.ch).join('');
  for(const c of cols){
    if(!c){line+=NBSP;width+=blankAdv;continue;}
    // Platforms trim whitespace from the start of a post or a line, which would leave the first column's
    // marks with nothing to stand on. A full stop is the same width and survives.
    const stop=line===''&&c.b.ch[0]===NBSP,b=stop?M.base('.'):c.b;
    line+=(stop?'.'+c.b.ch.slice(1):c.b.ch)+str(c.dn)+str(c.up);width+=c.b.adv;
    up=Math.max(up,b.up0+sum(c.up));dn=Math.max(dn,b.dn0+sum(c.dn));tallest=Math.max(tallest,c.up.length+c.dn.length);
  }
  return {line,up,dn,width,cols:cols.length,tallest,pal};
}

/* ---------- words: pixel letters, a fixed number of marks per letter pixel ----------
   A picture of text goes through `encode` as a blur: a letter is only a few columns wide and the sampling
   lands between its strokes. Here the letters come from a built-in pixel font, so every column of the font
   is a whole number of text columns and every row a whole number of marks.
   A stack cannot have holes, so the space under a stroke is filled with the lightest mark. That mark is not
   as tall as the dark one, and a column of it would end lower than the stroke beside it. So the filler mixes
   in a second light mark that is taller, in the proportion that keeps every column level with its
   neighbours. Each column then holds the same number of marks per row, which also keeps the rows level in
   Safari, where every mark gets the same extra spacing (measured: 13 ticks + 2 bars against 14 bars was
   .05 em off in Chrome and .08 in Safari; ticks and rings 2:1 are within .03 in both).
   One row of words stands on the baseline. A second row hangs below it, so neither sits on the other's
   filler. The tables are made by tools/font.js: two hex digits per column, bit 0 is the top row. */
const unpack=(h,gap,s)=>{const g={};for(const t of s.split(' '))g[t[0]]=t.slice(1).match(/../g).map(v=>parseInt(v,16));return {h,gap,g};};
const FONTS={
  big:unpack(7,3,"03e5149453e 1427f40 24261514946 32141454b31 41814127f10 52745454539 63c4a494930 70171090503 83649494936 9064949291e A7e0909097e B7f49494936 C3e41414122 D7f4141413e E7f49494941 F7f09090901 G3e4149493a H7f0808087f I7f J2040413f01 K7f08142241 L7f40404040 M7f020c027f N7f0408107f O3e4141413e P7f09090906 Q3e4151215e R7f09192946 S4649494931 T01017f0101 U3f4040403f V1f2040201f W3f4038403f X6314081463 Y0304780403 Z6151494543 .40 ,4020 !5f ?0201510906 -080808 +08083e0808 :14 '03 /6010080403 #147f147f14 @3e415d551e &3649552250 _4040404040"),
  small:unpack(5,2,"01f111f 1021f 2191512 311150a 407041f 5171509 61e151d 7011d03 81f151f 917150f A1e051e B1f150a C0e1111 D1f110e E1f1511 F1f0501 G0e111d H1f041f I1f J08100f K1f041b L1f1010 M1f0204021f N1f02041f O0e110e P1f0502 Q0e191e R1f051a S121509 T011f01 U1f101f V0f100f W1f0804081f X1b041b Y031c03 Z191513 .10 ,1008 !17 ?011502 -0404 +040e04 :0a '03 /180403 #1f0a1f @0e111516 &0a150a10 _101010")
};
// Largest first: the font, text columns per letter pixel, dark marks per letter pixel.
const SIZES=[
  {id:6,font:'big',sx:2,sy:3},{id:5,font:'big',sx:2,sy:2},{id:4,font:'big',sx:1,sy:2},
  {id:3,font:'big',sx:1,sy:1},{id:2,font:'small',sx:1,sy:2},{id:1,font:'small',sx:1,sy:1}
];
// Words -> one bit mask per text column (0 is a gap).
function strip(words,f,sx){
  const c=[],put=(v,n)=>{for(let k=0;k<n*sx;k++)c.push(v);};
  words.forEach((w,i)=>{if(i)put(0,f.gap);[...w].forEach((ch,j)=>{if(j)put(0,1);for(const v of f.g[ch])put(v,1);});});
  return c;
}
// The light mark on the other side of the dark mark's height, to even the filler out. Null if none is needed.
function spacer(list,light,dark){
  let best=null;
  for(const m of list)if(m!==light&&m!==dark&&(m.pitch-dark.pitch)*(light.pitch-dark.pitch)<0&&m.ink<(light.ink+dark.ink)/2&&(!best||m.ink<best.ink))best=m;
  return best;
}
function letters(words,z,two,o,M,P,hang){
  const f=FONTS[z.font],pal={up:palette(M.artUp,2,true),dn:palette(M.artDn,2,true)};
  const b=baseSet(o.base||(P&&P.base)||'blank',1,M,P)[0],blankAdv=(P&&P.blank)||M.base(NBSP).adv;
  let top=strip(words,f,z.sx),bot=[];
  if(two){
    // The split that leaves the two rows closest in width; the shorter row is centred on the longer.
    let best=1e9;
    for(let k=1;k<words.length;k++){
      const a=strip(words.slice(0,k),f,z.sx),c=strip(words.slice(k),f,z.sx),m=Math.max(a.length,c.length);
      if(m<best){best=m;top=a;bot=c;}
    }
    const d=top.length-bot.length,pad=Array(Math.abs(d)>>1).fill(0);
    if(d>0)bot=pad.concat(bot);else top=pad.concat(top);
  }else if(hang){bot=top;top=[];}
  // n rows counted away from the baseline, z.sy marks each. `off` is how far the column has drifted from
  // a column of dark marks alone; the filler is whichever light mark brings it back.
  const used=new Set();
  const side=(p,list,n,ink)=>{
    const light=p[0],dark=p[p.length-1],alt=spacer(list,light,dark),out=[];let off=0;
    for(let r=0;r<n;r++)for(let k=0;k<z.sy;k++){
      const m=ink(r)?dark:alt&&Math.abs(off+alt.pitch-dark.pitch)<Math.abs(off+light.pitch-dark.pitch)?alt:light;
      off+=m.pitch-dark.pitch;out.push(m);used.add(m);
    }
    return out;
  };
  const cols=[];
  for(let x=0;x<Math.max(top.length,bot.length);x++){
    const tv=top[x]||0,bv=bot[x]||0;
    if(!tv&&!bv){cols.push(null);continue;}
    // The top row of words is read upward from the baseline, the bottom row downward.
    const up=side(pal.up,M.artUp,tv?f.h-(31-Math.clz32(tv&-tv)):0,r=>tv>>(f.h-1-r)&1);
    const dn=side(pal.dn,M.artDn,bv?32-Math.clz32(bv):0,r=>bv>>r&1);
    fixColumn(b.ch,dn,up,M);cols.push({b,up,dn});
  }
  // The marks the letters are really made of, lightest first, for whoever shows a legend.
  const seen=list=>list.filter(m=>used.has(m)).sort((a,c)=>a.ink-c.ink);
  return assemble(cols,blankAdv,{up:seen(M.artUp),dn:seen(M.artDn)},M);
}
/* Text -> the same bundle `picture` returns. o.size picks a size (see SIZES); without it the largest that
   passes the platform's limits is used, on one row if the words fit and on two if not. o.hang true or false
   puts a single row below or above the line; without it the side with fewer marks is used. Letters the font
   does not have are left out and listed in `skipped`. */
function banner(text,o,M,P){
  o=Object.assign({room:true,pad:'blank',phone:true},o);
  o.base=o.base||(P&&P.base)||'blank';
  // Accents are dropped first, so an accented letter is drawn as its plain letter instead of being left out.
  const all=String(text==null?'':text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().split(/\s+/).filter(Boolean);
  const make=(z,two)=>{
    const f=FONTS[z.font],words=all.map(w=>[...w].filter(ch=>f.g[ch]).join('')).filter(Boolean);
    if(!words.length||(two&&words.length<2))return null;
    /* A hole needs a filler mark only when there is ink beyond it. Letters open at the foot (A, R, T) are cleaner
       hanging from the line, letters open at the top (L, U, V) standing on it. One row takes whichever needs
       fewer marks, which is also the one with less filler to look at. */
    let r=letters(words,z,two,o,M,P),hang=false;
    if(!two&&o.hang!==false){const h=letters(words,z,false,o,M,P,true);if(o.hang===true||h.line.length<r.line.length){r=h;hang=true;}}
    r.hang=hang;r.size=z.id;r.rows=two?2:1;r.skipped=[...new Set([...all.join('')].filter(ch=>!f.g[ch]))];
    return r;
  };
  const rows=o.rows===1?[false]:o.rows===2?[true]:[false,true];
  let r=null,done=false;
  for(const z of o.size?SIZES.filter(z=>z.id===+o.size):SIZES){
    for(const two of rows){
      const t=make(z,two);if(!t)continue;
      r=t;if(within(layout(t.line,M,P,o).text,t,o,P)){done=true;break;}
    }
    if(done)break;
  }
  if(!r)return {text:'',line:'',layout:layout('',M,P,{}),check:check('',P,M),opts:null,result:null,fits:false};
  const L=layout(r.line,M,P,o);
  return {text:L.text,line:r.line,layout:L,check:check(L.text,P,M),opts:Object.assign({},o,{size:r.size,rows:r.rows}),result:r,fits:done};
}

/* ---------- glitch: the classic random pile ---------- */
function rng(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function glitch(text,o,M){
  const r=rng(o.seed||1),au=M.up.filter(m=>ANCHOR.has(m.cp)),ad=M.dn.filter(m=>ANCHOR.has(m.cp));
  let line='';
  for(const {segment} of seg.segment(text)){
    line+=segment;if(!segment.trim())continue;
    for(let i=0;i<o.mid;i++)if(r()<.7)line+=MID[r()*MID.length|0];
    const nd=Math.round(o.dn*(.35+.65*r())),nu=Math.round(o.up*(.35+.65*r()));
    // Each letter gets one anchor so the pile stacks on platforms with a brand font.
    for(let n=0;n<nd;n++)line+=(n===0&&!nu&&ad.length?ad[r()*ad.length|0]:M.dn[r()*M.dn.length|0]).ch;
    for(let n=0;n<nu;n++)line+=(n===0&&au.length?au[r()*au.length|0]:M.up[r()*M.up.length|0]).ch;
  }
  return {line:line.normalize('NFC'),pal:null};
}

/* ---------- layout: give the stacks their own lines ----------
   A stack taller than its line is either cut off (the post box clips) or painted over the name above and
   the buttons below. Lines that hold one invisible character reserve the room instead. */
const ascent=P=>.5*P.lh+(P.asc==null?.35:P.asc);   // baseline, measured from the top of its line
const SLACK=.12;                                     // a stack may poke this far out before it earns a line
function inspect(text,M,P){
  const lh=P.lh,blank=P.blank||(M?M.base(NBSP).adv:.28);
  const pu=new Map(),pd=new Map();
  if(M){for(const m of M.up)pu.set(m.cp,m.pitch);for(const m of M.dn)pd.set(m.cp,m.pitch);}
  const lines=text.split(NL),asc=ascent(P),n=lines.length,ap=M?M.apple:[0,0];
  let cols=0,tallest=0,width=0,top=0,bottom=0,up=0,dn=0,flat=0;
  lines.forEach((ln,i)=>{
    let w=0;
    for(const {segment} of seg.segment(ln)){
      const cps=[...segment.normalize('NFD')],b=M?M.base(cps[0]):{adv:.5,up0:.7,dn0:0};let u=0,d=0,k=0,ua=0,da=0;
      for(let j=1;j<cps.length;j++){const cp=cps[j].codePointAt(0);if(cp>=0x300&&cp<=0x36f){k++;u+=pu.get(cp)||0;d+=pd.get(cp)||0;if(pu.has(cp))ua+=ap[0];if(pd.has(cp))da+=ap[1];}}
      w+=!k&&cps[0]===NBSP?blank:b.adv;cols++;tallest=Math.max(tallest,k);
      if(k>1&&P.carrier&&!P.carrier.includes(cps[0].codePointAt(0)))flat++;
      if(k){up=Math.max(up,b.up0+u);dn=Math.max(dn,b.dn0+d);
        // How far a stack leaves the post box, by the taller of the two engines, so the lines reserved hold both.
        top=Math.max(top,b.up0+u+ua-(i*lh+asc));bottom=Math.max(bottom,b.dn0+d+da-((n-1-i)*lh+lh-asc));}
    }
    width=Math.max(width,w);
  });
  return {lines:n,cols,tallest,width,up,dn,top,bottom,flat};
}
// o.caption is ordinary text for the line above the art. The stacks need their lines between it and the
// art whether or not `room` is on, or they would be drawn over the words.
function layout(line,M,P,o){
  if(!line)return {text:'',above:0,below:0};
  const lh=P.lh,i=inspect(line,M,P),p=o.pad==='dot'?'.':PAD,cap=String(o.caption||'').trim();
  const need=(v,must)=>o.room||must?Math.ceil(Math.max(0,v-SLACK)/lh):0;
  const above=need(i.top,!!cap),below=need(i.bottom);
  return {text:(cap?cap+NL:'')+(p+NL).repeat(above)+line+(NL+p).repeat(below),above,below};
}

/* ---------- fit: the most columns that still pass every limit ---------- */
function within(text,r,o,P){
  if(measure(text,P)>P.limit)return false;
  if(P.second&&count[P.second.unit](text)>P.second.limit)return false;
  // Safari's engine sets a column that carries marks up to 2% wider than Chrome does (.339 against .333 em).
  // With a blank in front of each column ('wide') it is up to 20% wider there.
  if(o.phone&&r.width*(o.base==='wide'?1.2:1.02)>P.width)return false;
  if(P.maxMarks&&r.tallest>P.maxMarks)return false;
  if(!o.dense&&r.tallest>STACK)return false;
  return true;
}
function fit(src,o,M,P,lo,hi){
  lo=lo||4;hi=hi||160;
  const ok=c=>{const r=encode(src,Object.assign({},o,{cols:c}),M,P);return within(layout(r.line,M,P,o).text,r,o,P);};
  if(!ok(lo))return lo;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ok(mid))lo=mid;else hi=mid-1;}
  return lo;
}

// Few columns cannot carry shading: the marks read as noise. Below these sizes a plain shape reads better.
const autoTones=cols=>cols<26?1:cols<36?2:3;
/* Resolves tones 0 (automatic) and, when asked, the column count.
   The two depend on each other: more tones can mean fewer columns that fit. Automatic tones are the most
   whose own fit still has the columns to carry them, so a picture never has more shading than its size reads. */
function plan(src,o,M,P,doFit,lo,hi){
  let tones=o.tones,cols=o.cols;const w=t=>Object.assign({},o,{tones:t});
  if(!doFit){if(!tones)tones=autoTones(cols);}
  else if(tones)cols=fit(src,w(tones),M,P,lo,hi);
  else for(tones=3;;tones--){cols=fit(src,w(tones),M,P,lo,hi);if(tones===1||autoTones(cols)>=tones)break;}
  return Object.assign({},o,{tones,cols});
}
// Glitch: thin the piles until the text passes the platform's limits.
function fitGlitch(text,o,M,P){
  for(let k=20;k>=0;k--){
    const g=Object.assign({},o,{up:Math.round(o.up*k/20),dn:Math.round(o.dn*k/20),mid:k?o.mid:0}),t=layout(glitch(text,g,M).line,M,P,o).text;
    if(measure(t,P)<=P.limit&&(!P.second||count[P.second.unit](t)<=P.second.limit)&&(o.dense||inspect(t,M,P).tallest<=STACK))return g;
  }
  return Object.assign({},o,{up:0,dn:0,mid:0});
}

/* ---------- check: will this text arrive intact ---------- */
function check(text,P,M){
  const out=[],add=(level,msg)=>out.push({level,msg}),i=inspect(text,M,P),n=measure(text,P),f=v=>(Math.round(v*10)/10).toString();
  add(n>P.limit?'fail':'ok',n.toLocaleString('en')+' of '+P.limit.toLocaleString('en')+' '+UNIT[P.unit]+(n>P.limit?'. Too long by '+(n-P.limit).toLocaleString('en')+'.':'.'));
  if(P.second){const m=count[P.second.unit](text);add(m>P.second.limit?'fail':'ok',m.toLocaleString('en')+' of '+P.second.limit.toLocaleString('en')+' '+UNIT[P.second.unit]+(m>P.second.limit?'. Too long.':'.'));}
  if(P.marks==='stripped')add('fail','This platform removes combining marks, so the picture will not survive.');
  if(P.marks==='capped'&&i.tallest>P.cap)add('warn','Tallest pile is '+i.tallest+' marks. '+P.note);
  if(i.flat)add(P.flatLevel||'fail',P.flat);
  if(i.tallest>STACK)add('warn','Tallest pile is '+i.tallest+' marks. Safari and the iPhone, iPad and Mac apps stack only the first '+STACK+' of a column and draw the rest on one line.');
  if(P.maxMarks&&i.tallest>P.maxMarks)add('fail','Tallest pile is '+i.tallest+' marks. This platform keeps at most '+P.maxMarks+' per letter.');
  if(text.normalize('NFC')!==text)add('warn','Not in normalised (NFC) order, so a platform may rewrite it and the count can change.');
  else add('ok','Already normalised (NFC), so the platform has nothing to rewrite.');
  if(text&&(text.trim()!==text||/^\s*$/m.test(text)))add('warn','Starts, ends or has a line with only whitespace, which platforms trim.');
  if(M){
    if(i.width>P.width)add('warn','About '+f(i.width)+' em wide. A phone shows about '+f(P.width)+' em, so the line will wrap there.');
    else add('ok','About '+f(i.width)+' em wide, inside a phone column ('+f(P.width)+' em).');
    const o=Math.max(i.top,i.bottom);
    if(o>SLACK){
      const where=(i.top>SLACK?f(i.top)+' em above':'')+(i.top>SLACK&&i.bottom>SLACK?' and ':'')+(i.bottom>SLACK?f(i.bottom)+' em below':'');
      if(P.clip==='post')add('fail','Stacks reach '+where+' the post box, and this platform cuts them off there. Reserve lines to fix it.');
      else if(P.clip==='none')add('warn','Stacks reach '+where+' the post box and will paint over whatever is next to it.');
      else add('warn','Stacks reach '+where+' the post box. They may be cut off or overlap what is next to it.');
    }else add('ok','Stacks stay inside the post box ('+i.lines+(i.lines===1?' line':' lines')+').');
  }
  if(P.fold&&(i.lines>P.fold.lines||(P.fold.chars&&n>P.fold.chars)))add(P.fold.level||'note',P.fold.msg);
  if(P.note&&P.marks!=='capped')add('note',P.note);
  add('note',P.src==='measured'?'Layout measured on the live site (Chrome, macOS). Other devices use other fonts.':P.src==='font'?'Stacking measured in this platform\'s own font stack (Chrome, macOS). Line height and clipping are from documentation, and the phone apps were not measured.':P.src==='documented'?'Limits from documentation. Rendering not measured.':'Not verified. Send yourself a test first.');
  return {ok:!out.some(c=>c.level==='fail'),items:out,info:i,count:n};
}

/* ---------- image: RGBA -> subject mask and tone ---------- */
function downscale(img,max){
  const k=Math.min(1,max/Math.max(img.w,img.h)),w=Math.max(1,Math.round(img.w*k)),h=Math.max(1,Math.round(img.h*k));
  if(w===img.w&&h===img.h)return img;
  const out=new Uint8ClampedArray(w*h*4),d=img.data;
  for(let y=0;y<h;y++){
    const y0=Math.floor(y*img.h/h),y1=Math.max(y0+1,Math.floor((y+1)*img.h/h));
    for(let x=0;x<w;x++){
      const x0=Math.floor(x*img.w/w),x1=Math.max(x0+1,Math.floor((x+1)*img.w/w));let r=0,g=0,b=0,a=0;
      for(let yy=y0;yy<y1;yy++)for(let xx=x0,i=(yy*img.w+x0)*4;xx<x1;xx++,i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];a+=d[i+3];}
      const n=(y1-y0)*(x1-x0),o=(y*w+x)*4;out[o]=Math.round(r/n);out[o+1]=Math.round(g/n);out[o+2]=Math.round(b/n);out[o+3]=Math.round(a/n);
    }
  }
  return {w,h,data:out};
}
// Background is the median colour of the border, or transparency when most of the border is clear.
function analyse(img){
  const {w,h,data:d}=img,ch=[[],[],[]];let clear=0,n=0;
  const edge=(x,y)=>{const i=(y*w+x)*4;n++;if(d[i+3]<128)clear++;else for(let k=0;k<3;k++)ch[k].push(d[i+k]);};
  for(let x=0;x<w;x++){edge(x,0);edge(x,h-1);}for(let y=0;y<h;y++){edge(0,y);edge(w-1,y);}
  const bg=ch.map(a=>{a.sort((p,q)=>p-q);return a.length?a[a.length>>1]:255;}),alphaBg=clear>n/2;
  const lum=new Float32Array(w*h),dist=new Float32Array(w*h);
  for(let i=0,p=0;p<w*h;i+=4,p++){
    lum[p]=(.2126*d[i]+.7152*d[i+1]+.0722*d[i+2])/255;
    dist[p]=d[i+3]<128?0:alphaBg?1:Math.hypot(d[i]-bg[0],d[i+1]-bg[1],d[i+2]-bg[2])/441.7;
  }
  return {w,h,d,lum,dist};
}
// thr: 0..1 distance from the background. light: true when ink is brighter than the page (dark theme).
const FLAT=9;   // brightness levels out of 256 that still count as one flat colour
function subject(raw,thr,light){
  const {w,h}=raw,m0=new Uint8Array(w*h),m=new Uint8Array(w*h);
  for(let p=0;p<w*h;p++)m0[p]=raw.dist[p]>thr?1:0;
  let x0=w,x1=-1,y0=h,y1=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const p=y*w+x;if(!m0[p])continue;let c=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if((dx||dy)&&xx>=0&&yy>=0&&xx<w&&yy<h&&m0[yy*w+xx])c++;}
    if(c>=4){m[p]=1;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
  }
  if(x1<0)return null;
  const cw=x1-x0+1,ch=y1-y0+1,ink=new Float32Array(cw*ch),mask=new Uint8Array(cw*ch),cdf=new Float32Array(256);
  let n=0;
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const p=(y+y0)*w+x+x0;if(m[p]){mask[y*cw+x]=1;cdf[raw.lum[p]*255|0]++;n++;}}
  // Rank brightness within the subject, so every tone level covers a similar share of it.
  for(let i=0,c=0;i<256;i++){c+=cdf[i];cdf[i]=c/n;}
  const upTo=i=>i<0?0:cdf[Math.min(i,255)];
  /* A flat colour has no tones to rank. When one narrow band of brightness holds most of the subject, the
     picture is a flat graphic: the band counts as a single level, and the inkiest colour is drawn solid.
     Without this a one-colour logo ranks as the lightest tone, and noise inside it lands on every tone. */
  let f0=-1,share=.5;
  for(let i=0;i+FLAT<=256;i++){const s=upTo(i+FLAT-1)-upTo(i-1);if(s>share){share=s;f0=i;}}
  const rank=b=>light?upTo(b):1-upTo(f0<0?b:b-1),level=f0<0?0:rank(light?f0+FLAT-1:f0);
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){
    const b=raw.lum[(y+y0)*w+x+x0]*255|0;
    ink[y*cw+x]=f0>=0&&b>=f0&&b<f0+FLAT?level:rank(b);
  }
  return {w:cw,h:ch,ink,mask,x0,y0};
}
function autoBaseline(src){
  let best=0,by=0;
  for(let y=0;y<src.h;y++){let n=0;for(let x=0;x<src.w;x++)n+=src.mask[y*src.w+x];if(n>best){best=n;by=y;}}
  return Math.round((by+.5)/src.h*100);
}

/* ---------- picture: the whole pipeline, RGBA pixels in, post text out ----------
   The page and the CLI both call this, so they cannot drift apart.
   img: {w,h,data}. o.light: true when the reader's theme is dark. o.cols omitted = fit to the platform. */
function picture(img,o,M,P){
  o=o||{};
  const or=(v,d)=>v==null?d:v;
  const raw=analyse(downscale(img,220)),src=subject(raw,or(o.cutoff,.10),!!o.light!==!!o.invert);
  // A flat or empty image has no subject. Same keys as a normal result, so callers need no special case.
  if(!src)return {text:'',line:'',layout:layout('',M,P,{}),check:check('',P,M),opts:null,src:null,result:null};
  const baseline=o.baseline==null?autoBaseline(src)/100:o.baseline;
  const opts=plan(src,{cols:o.cols,baseline,tones:o.tones||0,tall:or(o.tall,true),base:o.base||P.base||'blank',dither:!!o.dither,
    room:or(o.room,true),pad:o.pad||'blank',phone:or(o.phone,true),dense:!!o.dense},M,P,o.cols==null,6,160);
  const r=encode(src,opts,M,P),L=layout(r.line,M,P,opts),ck=check(L.text,P,M);
  return {text:L.text,line:r.line,layout:L,check:ck,opts,src,result:r};
}

return {NBSP,PAD,CLEAN,ANCHOR,STACK,UNIT,PLATFORMS,BASES,platform,count,measure,metrics,palette,encode,glitch,inspect,layout,fit,fitGlitch,plan,autoTones,within,check,downscale,analyse,subject,autoBaseline,ascent,picture,banner,SIZES,FONTS};
});
