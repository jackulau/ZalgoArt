#!/usr/bin/env node
/* Tests for the core, the PNG decoder and the CLI. Plain Node, no framework: node test/run.js
   One line per test, then a total. Exits non-zero when anything fails.
   To run a few, give a pattern for their names: ZALGO_ONLY='^text|^cli: text' node test/run.js
   Expected values are worked out here, by hand or by a second route, never by the function under test. */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const ROOT=path.join(__dirname,'..'),CLI=path.join(ROOT,'bin','zalgo');
const Z=require(path.join(ROOT,'src','zalgo-core.js')),png=require(path.join(ROOT,'src','png.js')),chrome=require(path.join(ROOT,'tools','chrome.js')),enc=require('./png-encode.js');
const S=String.fromCodePoint,NL=S(10),NBSP=S(0xa0),PAD=S(0x2800),ESC=S(27);
const seg=new Intl.Segmenter();
const BUILD=require(path.join(ROOT,'tools','build.js')),SITE=require('./site.js');

/* ---------- a very small harness ---------- */
let passed=0,failed=0,skipped=0;
const ONLY=process.env.ZALGO_ONLY?new RegExp(process.env.ZALGO_ONLY):null,wanted=name=>!ONLY||ONLY.test(name);
function test(name,fn){
  if(!wanted(name))return;
  let note;
  try{note=fn();}
  catch(e){failed++;console.log('FAIL     '+name+': '+String(e&&e.message||e).split(NL)[0]);return;}
  passed++;console.log('ok       '+name+(note?' ('+note+')':''));
}
function skip(name,reason){if(!wanted(name))return;skipped++;console.log('SKIPPED  '+name+': '+reason);}
// Zalgo text in a failure message would be unreadable, so strings are cut short and shown as code points.
function show(v){
  if(typeof v!=='string')return JSON.stringify(v);
  const head=Array.from(v.slice(0,24),c=>{const p=c.codePointAt(0);return p>=0x20&&p<0x7f?c:'<U+'+p.toString(16).toUpperCase()+'>';}).join('');
  return '"'+head+'"'+(v.length>24?'... ('+v.length+' units)':'');
}
function ok(cond,msg){if(!cond)throw new Error(msg);}
function eq(got,want,msg){if(got!==want)throw new Error(msg+': got '+show(got)+', expected '+show(want));}
function none(problems,total){
  if(problems.length)throw new Error(problems.length+' of '+total+' wrong, first: '+problems[0]);
}

const profile=name=>JSON.parse(fs.readFileSync(path.join(ROOT,'profiles',name+'.json'),'utf8'));
const HELV=Z.metrics(profile('helvetica')),ARIAL=Z.metrics(profile('arial'));

/* ---------- synthetic images ---------- */
function image(w,h,bg,paint){
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const c=paint(x,y)||bg,i=(y*w+x)*4;data[i]=c[0];data[i+1]=c[1];data[i+2]=c[2];data[i+3]=c[3];}
  return {w,h,data};
}
const WHITE=[255,255,255,255],CLEAR=[0,0,0,0];
const disc=(cx,cy,r,col)=>(x,y)=>Math.hypot(x-cx,y-cy)<r?col(x,y):null;
const SHAPES={
  // Larger than 220 pixels, so the core's downscale is on the path.
  disc:image(300,300,WHITE,disc(150,150,120,(x,y)=>[30+(x>>1),40,20+(y>>1),255])),
  triangle:image(180,140,WHITE,(x,y)=>y>12&&y<128&&Math.abs(x-90)<(y-12)*.7?[20,60+y,150,255]:null),
  // Low and wide, resting on its base: its end columns are too short to carry a mark.
  lowTriangle:image(240,60,WHITE,(x,y)=>y>8&&y<52&&Math.abs(x-120)<(y-8)*2.4?[20,60+y,150,255]:null),
  twoBlobs:image(220,100,WHITE,(x,y)=>disc(55,50,36,()=>[200,40,40,255])(x,y)||disc(165,50,30,()=>[30,30,160,255])(x,y)),
  clearBackground:image(160,160,CLEAR,disc(80,80,64,(x,y)=>[40+x,30,30+y,255]))
};

/* ---------- what a postable picture must satisfy ---------- */
const isMark=cp=>cp>=0x300&&cp<=0x36f;
function unanchored(text){
  for(const {segment} of seg.segment(text)){
    const cps=Array.from(segment,c=>c.codePointAt(0));
    if(cps.some(isMark)&&!cps.some(cp=>Z.ANCHOR.has(cp)))return true;
  }
  return false;
}
/* Some platforms' own font has the marks but draws them all at one height (Slack). There a pile only stacks
   on a letter that font lacks, listed as the platform's carrier. Worked out here from the text alone. */
function flattened(text,P){
  if(!P.carrier)return false;
  for(const {segment} of seg.segment(text)){
    const cps=Array.from(segment.normalize('NFD'),c=>c.codePointAt(0));
    if(cps.filter(isMark).length>1&&!P.carrier.includes(cps[0]))return true;
  }
  return false;
}
// How a platform reports flattened piles: a failure (flat for everyone, Slack) or a warning (flat in one browser, X).
const flatLevel=P=>P.flatLevel||'fail';
// What check must say about a text: nothing failed, or, for flattened piles, exactly that one report at the platform's level.
function checkProblems(ck,text,P){
  const fails=ck.items.filter(i=>i.level==='fail'),said=ck.items.filter(i=>i.msg===P.flat);
  if(!flattened(text,P)){
    if(said.length)return ['check reports flat piles on a text that has none'];
    return fails.length?['check failed: '+fails[0].msg.slice(0,80)]:[];
  }
  if(said.length!==1||said[0].level!==flatLevel(P))return ['piles on letters this platform draws flat must be reported once, as '+flatLevel(P)];
  if(flatLevel(P)==='fail')return fails.length===1&&!ck.ok?[]:['flat piles must be the one failed check'];
  return fails.length?['check failed: '+fails[0].msg.slice(0,80)]:[];
}
// Problems that hold for any picture, whatever its size.
function textProblems(t){
  const bad=[];
  if(t.normalize('NFC')!==t)bad.push('NFC changes it');
  if(t.normalize('NFD').normalize('NFC')!==t)bad.push('NFD then NFC changes it');
  if(t.normalize('NFKC')!==t.split(NBSP).join(' '))bad.push('NFKC changes more than the no-break spaces');
  if(t.trim()!==t)bad.push('starts or ends with whitespace');
  if(t.split(NL).some(l=>l.trim()===''))bad.push('has a whitespace-only line');
  if(unanchored(t))bad.push('a column with marks has no anchor mark');
  return bad;
}
// Problems of fit. Counts and width are measured again here rather than read from the result.
function fitProblems(r,P,M,o){
  const bad=[],t=r.text;
  if(Z.count[P.unit](t)>P.limit)bad.push(Z.count[P.unit](t)+' '+P.unit+' is over the limit of '+P.limit);
  if(P.second&&Z.count[P.second.unit](t)>P.second.limit)bad.push('over the second limit');
  if(o.phone!==false&&Z.inspect(t,M,P).width>P.width)bad.push('wider than the phone column');
  if(o.room!==false){
    const stacks=r.check.items.find(i=>i.msg.startsWith('Stacks'));
    if(!stacks||stacks.level!=='ok')bad.push('stacks leave the post box');
  }
  return bad;
}
/* The fitter never goes below 6 columns. On the smallest limits a tall shape on a wide base does not fit
   even then: the core returns the 6 column picture and its check says it is too long. That is the one
   accepted way to be over a limit, and only on platforms this small. */
const atFloor=(r,P)=>P.limit<=150&&r.opts.cols===6&&!r.check.ok&&r.check.items[0].level==='fail';

function pictures(P,M,bases,shapes,o){
  const bad=[];let n=0,floor=0,flat=0;
  for(const base of bases)for(const name of shapes){
    const opts=Object.assign({base},o||{}),r=Z.picture(SHAPES[name],opts,M,P),id=base+'/'+name;n++;
    if(!r.text){bad.push(id+': empty');continue;}
    const p=textProblems(r.text);
    if(flattened(r.text,P))flat++;
    if(atFloor(r,P))floor++;
    else p.push(...fitProblems(r,P,M,opts),...checkProblems(r.check,r.text,P));
    for(const m of p)bad.push(id+': '+m);
  }
  none(bad,n);
  // A platform with a carrier must still have bases that work, or the rule above would hide a dead platform.
  if(P.carrier)ok(flat<n,'no base stacks on '+P.id);
  return n+' pictures'+(floor?', '+floor+' stopped at the 6 column floor and reported too long':'')+(flat?', '+flat+' on letters '+P.name+' draws flat, which check reports as failed':'');
}

/* ---------- counters ---------- */
const COUNTS=[
  // name, text, utf16, codepoints, bytes, graphemes, weighted, mastodon
  ['ASCII','hello',5,5,5,5,5,5],
  ['newline','A'+NL+'b',3,3,3,3,3,3],
  ['one letter, four marks','i'+S(0x333,0x33f,0x30d,0x305),5,5,9,1,5,2],
  ['one letter, eight marks','l'+S(0x33f).repeat(8),9,9,17,1,9,3],
  ['a mark that composes','e'+S(0x301),2,2,3,1,1,1],
  ['no-break spaces',NBSP+NBSP,2,2,4,2,2,2],
  ['U+2800 spacers',PAD.repeat(3),3,3,9,3,6,3],
  ['emoji',S(0x1f600),2,1,4,1,2,1],
  ['CJK',S(0x65e5,0x672c),2,2,6,2,4,2],
  ['dash and zero-width space',S(0x2013,0x200b),2,2,6,2,2,2]
];
const UNITS=['utf16','codepoints','bytes','graphemes','weighted','mastodon'];
for(const [name,text,...want] of COUNTS)test('count: '+name,()=>{
  UNITS.forEach((u,i)=>eq(Z.count[u](text),want[i],u));
});
test('count: measure uses the platform unit',()=>{
  const t='abc'+PAD;
  eq(Z.measure(t,Z.platform('x')),5,'x');eq(Z.measure(t,Z.platform('bluesky')),4,'bluesky');eq(Z.measure(t,Z.platform('discord')),4,'discord');
});

/* ---------- pictures: every platform, every base, every shape ---------- */
const ALL_BASES=Z.BASES.map(b=>b.id),ALL_SHAPES=Object.keys(SHAPES);
for(const P of Z.PLATFORMS)test('picture: '+P.id,()=>pictures(P,HELV,ALL_BASES,ALL_SHAPES));
test('picture: with no base given, every platform gets a picture that passes its check',()=>{
  let n=0;
  for(const P of Z.PLATFORMS)for(const M of [HELV,ARIAL])for(const name of ALL_SHAPES){
    const r=Z.picture(SHAPES[name],{},M,P),id=P.id+'/'+name;n++;
    ok(r.text,id+': empty');eq(r.opts.base,P.base||'blank',id+' base');
    ok(!flattened(r.text,P),id+': the default base does not stack on this platform');
    ok(r.check.ok,id+': '+(r.check.items.find(i=>i.level==='fail')||{}).msg);
    none(textProblems(r.text).concat(fitProblems(r,P,M,{})).map(m=>id+': '+m),1);
  }
  return n+' pictures';
});
test('picture: Arial profile on x, bluesky, discord, sms and platforms with their own letter',()=>{
  let n=0;
  for(const id of ['x','bluesky','discord','sms'])n+=parseInt(pictures(Z.platform(id),ARIAL,ALL_BASES,['disc','lowTriangle','twoBlobs']),10);
  // And every platform that needs a special letter, on the other font as well.
  for(const P of Z.PLATFORMS)if(P.carrier)n+=parseInt(pictures(P,ARIAL,ALL_BASES,['disc','lowTriangle','twoBlobs']),10);
  return n+' pictures';
});
test('picture: other options keep the text postable',()=>{
  const variants=[{dither:true},{tall:false},{light:true},{invert:true},{light:true,invert:true},{pad:'dot'},{room:false},{phone:false},
    {baseline:.3},{cutoff:.3},{tones:1},{tones:2},{tones:4},{tones:6},{dither:true,tall:false,tones:5}];
  const bad=[];let n=0;
  for(const id of ['x','bluesky','discord'])for(const v of variants)for(const name of ['disc','twoBlobs','clearBackground']){
    const P=Z.platform(id),r=Z.picture(SHAPES[name],v,HELV,P),tag=id+'/'+name+'/'+JSON.stringify(v);n++;
    if(!r.text){bad.push(tag+': empty');continue;}
    for(const m of textProblems(r.text).concat(fitProblems(r,P,HELV,v)))bad.push(tag+': '+m);
  }
  none(bad,n);return n+' pictures';
});
test('picture: a fixed column count is kept and still safe to post',()=>{
  const bad=[];let n=0;
  for(const cols of [6,12,30,60,120])for(const base of ALL_BASES){
    const r=Z.picture(SHAPES.disc,{cols,base},HELV,Z.platform('xpremium'));n++;
    eq(r.opts.cols,cols,'cols');
    for(const m of textProblems(r.text))bad.push(cols+'/'+base+': '+m);
  }
  none(bad,n);return n+' pictures';
});
test('picture: defaults, automatic tones and the returned fields',()=>{
  const P=Z.platform('discord'),r=Z.picture(SHAPES.disc,{},HELV,P);
  for(const k of ['text','line','layout','check','opts','src','result'])ok(k in r,'missing field '+k);
  eq(r.opts.base,'blank','base');eq(r.opts.tall,true,'tall');eq(r.opts.dither,false,'dither');eq(r.opts.room,true,'room');eq(r.opts.pad,'blank','pad');eq(r.opts.phone,true,'phone');
  // Automatic tones, worked out again here: the most tones whose own fit still has the columns to carry them.
  let auto=3;
  for(;auto>1;auto--)if(Z.autoTones(Z.fit(r.src,Object.assign({},r.opts,{tones:auto}),HELV,P,6,160))>=auto)break;
  eq(r.opts.tones,auto,'automatic tones');ok(r.opts.tones<=Z.autoTones(r.opts.cols),'more tones than '+r.opts.cols+' columns can carry');
  eq(r.opts.cols,Z.fit(r.src,r.opts,HELV,P,6,160),'fitted columns');
  eq(r.opts.baseline,Z.autoBaseline(r.src)/100,'automatic baseline');
  eq(r.text,r.layout.text,'text is the laid out text');
  eq(Z.picture(SHAPES.disc,{tones:4},HELV,P).opts.tones,4,'given tones');
  eq(Z.picture(SHAPES.disc,{baseline:.25},HELV,P).opts.baseline,.25,'given baseline');
  // A dark theme and an inverted picture cancel out.
  eq(Z.picture(SHAPES.disc,{light:true,invert:true},HELV,P).text,r.text,'light and invert together');
  // The theme swaps which end of the shading is ink, so it shows only where there is shading: more than one tone.
  ok(Z.picture(SHAPES.disc,{light:true,tones:3},HELV,P).text!==Z.picture(SHAPES.disc,{tones:3},HELV,P).text,'a dark theme should change the picture');
});

/* ---------- tiny and odd inputs ---------- */
/* A logo in one flat colour has no tones to rank. It must come out solid, not as the lightest mark, and the
   small differences a JPEG leaves inside a flat colour must not turn into shading. */
test('picture: a flat colour is drawn solid, two flat colours keep their order, shading is ranked as before',()=>{
  const P=Z.platform('xpremium'),blue=[40,90,200,255],inkOf=(img,light)=>{
    const s=Z.subject(Z.analyse(Z.downscale(img,220)),.10,light),v=[];
    for(let i=0;i<s.ink.length;i++)if(s.mask[i])v.push(s.ink[i]);
    return v;
  };
  const share=(r,dark)=>{let n=0,k=0;for(const ch of r.line.normalize('NFD')){const cp=ch.codePointAt(0);if(isMark(cp)){n++;if(dark.includes(cp))k++;}}return k/n;};
  const flat=image(200,200,WHITE,disc(100,100,80,()=>blue));
  // The same disc with the noise of a saved photo: every channel a few levels off, differently in every pixel.
  const noisy=image(200,200,WHITE,disc(100,100,80,(x,y)=>{const d=(x*7+y*13)%5-2;return [blue[0]+d,blue[1]+d,blue[2]+d,255];}));
  for(const [name,img] of [['flat',flat],['noisy',noisy]])for(const light of [false,true]){
    const v=inkOf(img,light),tag=name+' disc, '+(light?'dark':'light')+' theme';
    ok(v.length>15000,tag+': subject of '+v.length+' pixels');
    ok(v.every(q=>q===1),tag+': ink runs from '+Math.min(...v).toFixed(2)+' to '+Math.max(...v).toFixed(2)+', expected 1 everywhere');
    const r=Z.picture(img,{tones:3,light},HELV,P);
    ok(r.check.ok,tag+' does not pass');none(textProblems(r.text).map(m=>tag+': '+m),1);
    const dark=[r.result.pal.up[r.result.pal.up.length-1].cp,r.result.pal.dn[r.result.pal.dn.length-1].cp];
    eq(dark.map(cp=>cp.toString(16)).join(),'33f,333',tag+': darkest marks');
    ok(share(r,dark)>.9,tag+': '+Math.round(share(r,dark)*100)+'% of the marks are the darkest, expected a solid shape');
  }
  // One tone or three, a flat shape is the same solid shape.
  eq(Z.picture(noisy,{tones:3,cols:20},HELV,P).result.cols,Z.picture(noisy,{tones:1,cols:20},HELV,P).result.cols,'columns at one tone and three');
  /* Two flat colours. By hand: the red disc (radius 36, brightness 88) is 59% of the subject, the blue one
     (radius 30, brightness 45) is 41%. On a light page the darker blue is solid and red ranks above 41% of the
     subject; on a dark page red is solid and blue ranks at its own 41%. */
  for(const [light,solid,other,n] of [[false,1,.59,'light'],[true,1,.41,'dark']]){
    const v=inkOf(SHAPES.twoBlobs,light),levels=[...new Set(v.map(q=>q.toFixed(2)))].sort();
    eq(levels.join(),other.toFixed(2)+','+solid.toFixed(2),'two discs on a '+n+' page: levels');
    const big=v.filter(q=>q===1).length/v.length;
    ok(Math.abs(big-(light?.59:.41))<.01,'two discs on a '+n+' page: '+Math.round(big*100)+'% is solid');
  }
  // A shaded shape has no flat band, so every pixel still ranks by how much of the subject is inkier than it.
  for(const light of [false,true]){
    const v=inkOf(SHAPES.disc,light).sort((a,b)=>a-b),tag='shaded disc, '+(light?'dark':'light')+' theme';
    ok(new Set(v).size>20,tag+': only '+new Set(v).size+' levels');
    for(const q of [.1,.25,.5,.75,.9])ok(Math.abs(v[v.length*q|0]-q)<.04,tag+': the pixel '+q*100+'% of the way up ranks '+v[v.length*q|0].toFixed(2));
  }
});
test('picture: images with no subject give empty text, not an exception',()=>{
  const flat=[['1x1',image(1,1,WHITE,()=>null)],['1x1 clear',image(1,1,CLEAR,()=>null)],['fully transparent',image(50,50,CLEAR,()=>null)],
    ['one colour',image(50,50,[90,120,200,255],()=>null)],['one colour, 2000x4',image(2000,4,WHITE,()=>null)],['one colour, 4x2000',image(4,2000,WHITE,()=>null)]];
  for(const id of ['x','bluesky','sms','custom'])for(const [name,img] of flat){
    const r=Z.picture(img,{},HELV,Z.platform(id));
    eq(r.text,'',name+' on '+id);eq(r.src,null,name+' src');eq(r.layout.text,'',name+' layout');ok(r.check.ok,name+' check');
  }
  return flat.length*4+' pictures';
});
test('picture: very wide, very tall and tiny images do not crash',()=>{
  const stripes=(x,y)=>(x>>3)%2?[0,0,0,255]:null,blob=(w,h)=>image(w,h,WHITE,disc(w/2,h/2,Math.min(w,h)*.45,()=>[10,10,10,255]));
  const odd=[image(2000,4,WHITE,stripes),image(4,2000,WHITE,(x,y)=>stripes(y,x)),blob(2000,40),blob(40,2000),image(2000,60,WHITE,stripes),image(20,2000,[0,0,0,255],(x,y)=>(y>>4)%2?WHITE:null),
    blob(3,3),blob(2,2),image(2,1,WHITE,x=>x?[0,0,0,255]:null),image(9,9,CLEAR,disc(4,4,4,()=>[0,0,0,255]))];
  // A plain Uint8Array must work as well as the clamped kind a canvas gives.
  const plain=blob(64,64);odd.push({w:64,h:64,data:new Uint8Array(plain.data)});
  let made=0;
  for(const id of ['x','bluesky','sms'])for(const img of odd)for(const base of ['blank','wide','auto']){
    const r=Z.picture(img,{base},HELV,Z.platform(id));
    ok(typeof r.text==='string','text is not a string');
    if(r.text){made++;none(textProblems(r.text).map(m=>img.w+'x'+img.h+' '+base+' on '+id+': '+m),1);}
  }
  eq(Z.picture(odd[odd.length-1],{},HELV,Z.platform('x')).text,Z.picture(plain,{},HELV,Z.platform('x')).text,'Uint8Array and Uint8ClampedArray');
  return odd.length*9+' pictures, '+made+' with text';
});

/* ---------- glitch ---------- */
const GLITCH={up:12,dn:12,mid:1,seed:7,room:true,pad:'blank'};
// The message with every mark, spacer line and line break taken out again.
const unglitch=t=>Array.from(t.normalize('NFD')).filter(c=>!isMark(c.codePointAt(0))&&c!==PAD&&c!==NL).join('');
test('glitch: the same seed gives the same text, another seed differs',()=>{
  const a=Z.glitch('Hello, world',GLITCH,HELV).line;
  eq(Z.glitch('Hello, world',GLITCH,HELV).line,a,'same seed');
  ok(Z.glitch('Hello, world',Object.assign({},GLITCH,{seed:8}),HELV).line!==a,'seed 8 gave the same text as seed 7');
  eq(unglitch(a),'Hello, world','the message underneath');
  eq(a.normalize('NFC'),a,'NFC');
});
test('glitch: fitted output passes every platform',()=>{
  const bad=[];let thinned=0;
  for(const P of Z.PLATFORMS){
    const g=Z.fitGlitch('Hello, world',GLITCH,HELV,P),t=Z.layout(Z.glitch('Hello, world',g,HELV).line,HELV,P,g).text;
    if(g.up<GLITCH.up)thinned++;
    if(Z.count[P.unit](t)>P.limit)bad.push(P.id+': over the limit');
    if(P.second&&Z.count[P.second.unit](t)>P.second.limit)bad.push(P.id+': over the second limit');
    if(t.normalize('NFC')!==t)bad.push(P.id+': not NFC');
    if(unglitch(t)!=='Hello, world')bad.push(P.id+': the message changed');
    // Glitch stands on the message's own letters, so a platform that flattens piles on them must say so.
    for(const m of checkProblems(Z.check(t,P,HELV),t,P))bad.push(P.id+': '+m);
  }
  none(bad,Z.PLATFORMS.length);
  ok(thinned>0,'no platform needed thinning, so the fit was not exercised');
  return Z.PLATFORMS.length+' platforms, '+thinned+' thinned';
});
test('glitch: empty, emoji and over-long input do not crash',()=>{
  const P=Z.platform('x');
  eq(Z.glitch('',GLITCH,HELV).line,'','empty');
  eq(Z.layout(Z.glitch('',Z.fitGlitch('',GLITCH,HELV,P),HELV).line,HELV,P,GLITCH).text,'','empty, fitted');
  const family=S(0x1f468,0x200d,0x1f469,0x200d,0x1f467),msg='hi '+S(0x1f600)+' '+family+' '+S(0x65e5,0x672c)+NL+'two';
  const g=Z.fitGlitch(msg,GLITCH,HELV,P),t=Z.layout(Z.glitch(msg,g,HELV).line,HELV,P,g).text;
  ok(t.length>msg.length,'no marks were added');eq(t.normalize('NFC'),t,'NFC');ok(Z.measure(t,P)<=P.limit,'over the limit');
  ok(t.includes(family),'the emoji sequence was broken apart');
  // Nothing can make 100 letters fit 70 units. The fit must give up with no marks instead of looping.
  const none0=Z.fitGlitch('x'.repeat(100),GLITCH,HELV,Z.platform('sms'));
  eq(none0.up,0,'up');eq(none0.dn,0,'down');eq(none0.mid,0,'through');
});

/* ---------- PNG decoder ---------- */
// A small repeatable random source, so a failure can be reproduced.
function random(seed){let s=seed>>>0;return n=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return Math.floor(s/4294967296*n);};}
const CH={0:1,2:3,3:1,4:2,6:4};
function randomPng(rnd,type,depth,w,h,more){
  const o=Object.assign({w,h,type,depth},more||{}),top=type===3?o.palette.length:2**depth;
  o.samples=Array.from({length:w*h*CH[type]},()=>rnd(top));
  return o;
}
// The RGBA a file must decode to. Sample scaling is by bit replication, which is how the PNG spec puts it.
function expectedRgba(o){
  const {w,h,type,depth,samples,palette,trns}=o,out=new Uint8ClampedArray(w*h*4);
  const to8=v=>depth===16?v>>8:depth===8?v:depth===4?v*17:depth===2?v*85:v*255;
  const word=i=>trns[i]*256+trns[i+1];
  for(let p=0;p<w*h;p++){
    const s=samples.slice(p*CH[type],(p+1)*CH[type]);let px;
    if(type===0)px=[to8(s[0]),to8(s[0]),to8(s[0]),trns&&word(0)===s[0]?0:255];
    else if(type===2)px=[to8(s[0]),to8(s[1]),to8(s[2]),trns&&word(0)===s[0]&&word(2)===s[1]&&word(4)===s[2]?0:255];
    else if(type===3)px=[...palette[s[0]],trns&&s[0]<trns.length?trns[s[0]]:255];
    else if(type===4)px=[to8(s[0]),to8(s[0]),to8(s[0]),to8(s[1])];
    else px=s.map(to8);
    out.set(px,p*4);
  }
  return out;
}
function samePixels(got,want,tag){
  eq(got.length,want.length,tag+' size');
  for(let i=0;i<want.length;i++)if(got[i]!==want[i])throw new Error(tag+': byte '+i+' is '+got[i]+', expected '+want[i]);
}
const SIZES=[[1,1],[7,1],[1,9],[13,11],[32,9]];
const FILTERS=[[0],[1],[2],[3],[4],[0,1,2,3,4],[4,3,2,1,0]];
const PALETTE=Array.from({length:256},(_,i)=>[(i*7)&255,(i*13+5)&255,255-i]);
const FORMATS=[[0,[1,2,4,8,16],'grey'],[2,[8,16],'RGB'],[3,[1,2,4,8],'palette'],[4,[8,16],'grey with alpha'],[6,[8,16],'RGBA']];
for(const [type,depths,name] of FORMATS)test('png: '+name+' (type '+type+'), depths '+depths.join('/')+', every filter',()=>{
  const rnd=random(type+1);let n=0;
  for(const depth of depths)for(const [w,h] of SIZES)for(const filters of FILTERS){
    const o=randomPng(rnd,type,depth,w,h,Object.assign({filters},type===3?{palette:PALETTE.slice(0,2**depth)}:{}));
    const img=png.decode(enc.encode(o));
    eq(img.w,w,'width');eq(img.h,h,'height');
    samePixels(img.data,expectedRgba(o),depth+' bit '+w+'x'+h+' filters '+filters.join(''));n++;
  }
  return n+' files';
});
test('png: tRNS transparency for grey, RGB and palette',()=>{
  const rnd=random(99);let n=0;
  const cases=[[0,1,[0,1]],[0,2,[0,2]],[0,4,[0,9]],[0,8,[0,200]],[0,16,[0x12,0x34]],[2,8,[0,10,0,20,0,30]],[2,16,[1,2,3,4,5,6]],
    [3,2,[0,128]],[3,4,[255,0,7,90,200]],[3,8,Array.from({length:256},(_,i)=>255-i)]];
  for(const [type,depth,trns] of cases){
    const o=randomPng(rnd,type,depth,17,13,Object.assign({trns,filters:[0,1,2,3,4]},type===3?{palette:PALETTE.slice(0,2**depth)}:{}));
    // Random 16-bit and RGB samples would almost never hit the key colour, so plant it in a few pixels.
    if(type!==3)for(const p of [0,5,100,220]){
      const key=type===0?[trns[0]*256+trns[1]]:[trns[0]*256+trns[1],trns[2]*256+trns[3],trns[4]*256+trns[5]];
      key.forEach((v,k)=>{o.samples[p*CH[type]+k]=v;});
    }
    const want=expectedRgba(o);
    ok(want.some((v,i)=>i%4===3&&v<255),'the test image has no transparent pixel');
    samePixels(png.decode(enc.encode(o)).data,want,'type '+type+' at '+depth+' bits');n++;
  }
  return n+' files';
});
test('png: Adam7 interlaced files decode to the same pixels',()=>{
  const rnd=random(5);let n=0;
  for(const [type,depth] of [[0,1],[0,2],[0,4],[0,8],[0,16],[2,8],[2,16],[3,1],[3,4],[3,8],[4,8],[6,8],[6,16]])
    for(const [w,h] of [[1,1],[2,3],[3,2],[5,5],[8,8],[9,17],[33,7]]){
      const o=randomPng(rnd,type,depth,w,h,Object.assign({filters:[0,1,2,3,4],interlace:1},type===3?{palette:PALETTE.slice(0,2**depth)}:{}));
      const file=enc.encode(o);
      ok(png.header(file).interlaced,'the header should say interlaced');
      samePixels(png.decode(file).data,expectedRgba(o),'type '+type+' at '+depth+' bits, '+w+'x'+h);n++;
    }
  return n+' files';
});
test('png: EXIF orientation in an eXIf chunk turns the picture',()=>{
  // Six grey pixels named A to F. Each orientation is written out by hand as the grid a viewer shows.
  const grid=['ABC','DEF'],value=c=>(c.charCodeAt(0)-64)*40;
  const shown={1:['ABC','DEF'],2:['CBA','FED'],3:['FED','CBA'],4:['DEF','ABC'],5:['AD','BE','CF'],6:['DA','EB','FC'],7:['FC','EB','DA'],8:['CF','BE','AD']};
  for(const o in shown)for(const little of [false,true]){
    const tiff=Buffer.alloc(26),w16=(v,p)=>little?tiff.writeUInt16LE(v,p):tiff.writeUInt16BE(v,p),w32=(v,p)=>little?tiff.writeUInt32LE(v,p):tiff.writeUInt32BE(v,p);
    tiff.write(little?'II':'MM','latin1');w16(42,2);w32(8,4);w16(1,8);w16(0x112,10);w16(3,12);w32(1,14);w16(+o,18);
    const file=enc.encode({w:3,h:2,type:0,depth:8,samples:Array.from(grid.join(''),value),chunks:[['eXIf',tiff]]});
    const img=png.decode(file,{orient:true}),want=shown[o];
    eq(img.w,want[0].length,'orientation '+o+' width');eq(img.h,want.length,'orientation '+o+' height');
    eq(Array.from({length:img.w*img.h},(_,p)=>String.fromCharCode(64+img.data[p*4]/40)).join(''),want.join(''),'orientation '+o);
    eq(png.decode(file).w,3,'without the option the picture is left alone');
  }
});
test('png: damaged files give a one-line PngError',()=>{
  const rnd=random(3),o=randomPng(rnd,2,8,20,15,{filters:[0,1,2,3,4]}),good=enc.encode(o);
  const cut=n=>good.subarray(0,n),flip=i=>{const b=Buffer.from(good);b[i]^=0x40;return b;};
  // Rebuild the file from chunks, so a broken part can still carry a correct checksum.
  const zlib=require('zlib'),sig=good.subarray(0,8),ihdr=good.subarray(8,33),iend=enc.chunk('IEND',Buffer.alloc(0)),rows=Buffer.alloc(15*61);
  const build=(...chunks)=>Buffer.concat([sig,...chunks,iend]),idat=data=>enc.chunk('IDAT',data);
  const badFilter=Buffer.from(rows);badFilter[61]=9;
  const head=(w,h,depth,type)=>{const b=Buffer.alloc(13);b.writeUInt32BE(w,0);b.writeUInt32BE(h,4);b[8]=depth;b[9]=type;return enc.chunk('IHDR',b);};
  const cases={
    'empty file':Buffer.alloc(0),'not a PNG':Buffer.from('GIF89a, not a PNG at all'),'signature only':cut(8),'cut inside the header':cut(20),
    'cut inside the data':cut(good.length-30),'no IEND':cut(good.length-12),'a flipped byte in the header':flip(18),'a flipped byte in the data':flip(60),
    'no image data':build(ihdr),'data that is not zlib':build(ihdr,idat(Buffer.from('this is not a zlib stream'))),
    'too little data':build(ihdr,idat(zlib.deflateSync(rows.subarray(0,200)))),'too much data':build(ihdr,idat(zlib.deflateSync(Buffer.alloc(15*61+500)))),
    'an unknown row filter':build(ihdr,idat(zlib.deflateSync(badFilter))),'zero width':build(head(0,5,8,2),idat(zlib.deflateSync(rows))),
    'a depth the colour type does not allow':build(head(4,4,4,2),idat(zlib.deflateSync(rows))),'an unknown colour type':build(head(4,4,8,5),idat(zlib.deflateSync(rows))),
    'a palette image with no palette':build(head(4,4,8,3),idat(zlib.deflateSync(Buffer.alloc(4*5)))),'data before the header':build(idat(zlib.deflateSync(rows)),ihdr)
  };
  for(const name in cases){
    let err=null;
    try{png.decode(cases[name]);}catch(e){err=e;}
    ok(err,name+': decoded without an error');
    ok(err instanceof png.PngError,name+': threw '+err.name+' ('+err.message+') instead of PngError');
    ok(err.message&&!err.message.includes(NL),name+': the message is not one line');
  }
  samePixels(png.decode(good).data,expectedRgba(o),'the undamaged file');
  return Object.keys(cases).length+' kinds of damage';
});
test('png: random damage never escapes as another kind of error',()=>{
  const rnd=random(11);let threw=0,n=0;
  const files=[enc.encode(randomPng(rnd,6,8,16,12,{filters:[0,1,2,3,4]})),enc.encode(randomPng(rnd,3,4,21,9,{filters:[1,4],palette:PALETTE.slice(0,16),trns:[0,9,200],interlace:1})),
    enc.encode(randomPng(rnd,0,16,9,9,{filters:[3],trns:[1,2]}))];
  for(const file of files)for(let k=0;k<400;k++,n++){
    let b=Buffer.from(file);
    if(k%4===0)b=b.subarray(0,rnd(b.length));
    else for(let j=0;j<=k%3;j++)b[rnd(b.length)]=rnd(256);
    try{const img=png.decode(b,{maxPixels:1e6,orient:true});ok(img.data.length===img.w*img.h*4,'a decoded image has the wrong size');}
    catch(e){if(!(e instanceof png.PngError))throw new Error('damage '+k+' threw '+e.name+': '+e.message);threw++;}
  }
  return n+' damaged files, '+threw+' refused';
});
test('png: the size cap refuses a huge image before decoding it',()=>{
  // Only a header claiming 30000 x 30000: the pixels are never needed to say no.
  const b=Buffer.alloc(13);b.writeUInt32BE(30000,0);b.writeUInt32BE(30000,4);b[8]=8;b[9]=2;
  const file=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),enc.chunk('IHDR',b),enc.chunk('IDAT',Buffer.alloc(4)),enc.chunk('IEND',Buffer.alloc(0))]);
  let err=null;try{png.decode(file,{maxPixels:50e6});}catch(e){err=e;}
  ok(err instanceof png.PngError,'no PngError');eq(err.code,'PNG_TOO_BIG','code');
  eq(png.header(file).w,30000,'header width');
});

/* ---------- the CLI, end to end ---------- */
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'zalgo-test-'));
process.on('exit',()=>fs.rmSync(TMP,{recursive:true,force:true}));
const tmp=name=>path.join(TMP,name);
function cli(args,o){
  o=o||{};
  const env=Object.assign({},process.env,o.env||{});delete env.NO_COLOR;if(o.noColor)env.NO_COLOR='1';
  const r=spawnSync(o.direct?CLI:process.execPath,o.direct?args:[CLI].concat(args),{encoding:'utf8',input:o.input==null?'':o.input,env,maxBuffer:1<<26});
  if(r.error)throw new Error('could not start the CLI: '+r.error.message);
  return r;
}
// A usage error is exit code 2, nothing on standard output and exactly one line on standard error.
function usageError(args,o){
  const r=cli(args,o),tag='zalgo '+args.map(a=>path.basename(a)).join(' ');
  eq(r.status,2,tag+' exit code');eq(r.stdout,'',tag+' stdout');
  ok(r.stderr.startsWith('zalgo: ')&&r.stderr.endsWith(NL)&&r.stderr.trimEnd().split(NL).length===1,tag+' did not print one line: '+show(r.stderr));
  ok(!/\n\s+at /.test(r.stderr),tag+' printed a stack trace');
  return r.stderr;
}
const sips=!spawnSync('sips',['--help']).error;
const DISC_PNG=tmp('disc.png');fs.writeFileSync(DISC_PNG,enc.rgb(SHAPES.disc));
const BURGER=path.join(ROOT,'examples','burger.jpg');
const THREE=['x','bluesky','discord'];
const within=(t,P)=>Z.count[P.unit](t)<=P.limit&&(!P.second||Z.count[P.second.unit](t)<=P.second.limit);

test('cli: image on a generated PNG for x, bluesky, discord',()=>{
  for(const id of THREE){
    const P=Z.platform(id),r=cli(['image',DISC_PNG,'-p',id]);
    eq(r.status,0,id+' exit code');ok(r.stdout.length>0,id+' printed nothing');
    ok(within(r.stdout,P),id+' is over the limit when counted again');
    // No newline is added on a pipe, and the text is the core's, byte for byte.
    eq(r.stdout,Z.picture(SHAPES.disc,{},HELV,P).text,id+' text');
    ok(r.stderr.includes(P.name)&&r.stderr.includes('[ok]')&&r.stderr.includes('column'),id+' summary is missing');
    ok(!r.stderr.includes(ESC),id+' wrote colour codes to a pipe');
  }
});
if(sips)test('cli: image on examples/burger.jpg for x, bluesky, discord',()=>{
  const sizes=[];
  for(const id of THREE){
    const P=Z.platform(id),r=cli(['image',BURGER,'-p',id]);
    eq(r.status,0,id+' exit code');ok(r.stdout.length>0,id+' printed nothing');
    ok(within(r.stdout,P),id+' is over the limit when counted again');
    none(textProblems(r.stdout).map(m=>id+': '+m),1);
    sizes.push(id+' '+Z.count[P.unit](r.stdout)+'/'+P.limit);
  }
  return sizes.join(', ');
});else skip('cli: image on examples/burger.jpg','sips is not on this system, so JPEG cannot be read');
if(sips)test('cli: a turned JPEG is read the right way up',()=>{
  // The burger with an EXIF note saying "turn me a quarter clockwise" added in front.
  const j=fs.readFileSync(BURGER),tiff=Buffer.from([0x4d,0x4d,0,0x2a,0,0,0,8,0,1,0x01,0x12,0,3,0,0,0,1,0,6,0,0,0,0,0,0]);
  const body=Buffer.concat([Buffer.from('Exif'),Buffer.alloc(2),tiff]),app1=Buffer.concat([Buffer.from([0xff,0xe1,(body.length+2)>>8,(body.length+2)&255]),body]);
  fs.writeFileSync(tmp('turned.jpg'),Buffer.concat([j.subarray(0,2),app1,j.subarray(2)]));
  const a=JSON.parse(cli(['image',BURGER,'--json']).stdout).image,b=JSON.parse(cli(['image',tmp('turned.jpg'),'--json']).stdout).image;
  eq(b.width,a.height,'width');eq(b.height,a.width,'height');
});else skip('cli: a turned JPEG','sips is not on this system');
test('cli: the file runs by itself (shebang and executable bit)',()=>{
  const r=cli(['platforms'],{direct:true});
  eq(r.status,0,'exit code');ok(r.stdout.startsWith('id'),'no table');
});
test('cli: interlaced, 16-bit, palette and RGBA PNGs of one picture give one text',()=>{
  const img=SHAPES.twoBlobs,want=cli(['image',tmp('blobs.png'),'-p','discord'].map((a,i)=>i===1?(fs.writeFileSync(a,enc.rgb(img)),a):a));
  eq(want.status,0,'exit code');ok(want.stdout.length>0,'printed nothing');
  const rgb=Array.from({length:img.w*img.h*3},(_,i)=>img.data[(i/3|0)*4+i%3]);
  // This picture has three colours, so it also fits a palette.
  const colours=[[255,255,255],[200,40,40],[30,30,160]],index=Array.from({length:img.w*img.h},(_,p)=>colours.findIndex(c=>c[0]===img.data[p*4]&&c[2]===img.data[p*4+2]));
  const forms={
    interlaced:enc.encode({w:img.w,h:img.h,type:2,depth:8,samples:rgb,filters:[4,3],interlace:1}),
    '16-bit':enc.encode({w:img.w,h:img.h,type:2,depth:16,samples:rgb.map(v=>v*257),filters:[1,2]}),
    palette:enc.encode({w:img.w,h:img.h,type:3,depth:2,samples:index,palette:colours,filters:[0]}),
    RGBA:enc.rgba(img)
  };
  for(const name in forms){
    fs.writeFileSync(tmp('form.png'),forms[name]);
    const r=cli(['image',tmp('form.png'),'-p','discord']);
    eq(r.status,0,name+' exit code');eq(r.stdout,want.stdout,name+' text');
  }
});
test('cli: a transparent PNG is read with its alpha',()=>{
  fs.writeFileSync(tmp('clear.png'),enc.rgba(SHAPES.clearBackground));
  const r=cli(['image',tmp('clear.png'),'-p','bluesky']);
  eq(r.status,0,'exit code');eq(r.stdout,Z.picture(SHAPES.clearBackground,{},HELV,Z.platform('bluesky')).text,'text');
});
test('cli: every image option reaches the core',()=>{
  const P=Z.platform('discord');
  const r=cli(['image',DISC_PNG,'-p','discord','--cols','30','--tones','3','--marks','short','--base','o','--baseline','40','--cutoff','20','--invert','--theme','dark','--dither','--no-room','--pad','dot','--no-phone','--font','arial']);
  const want=Z.picture(SHAPES.disc,{cols:30,tones:3,tall:false,base:'o',baseline:.4,cutoff:.2,invert:true,light:true,dither:true,room:false,pad:'dot',phone:false},ARIAL,P);
  eq(r.stdout,want.text,'all options');eq(r.status,want.check.ok?0:1,'exit code');
  // One at a time, each must change the picture the same way it does in the core. Inverting, the theme and dithering
  // only show where there is shading, so those three are compared at three tones.
  const single=[[['--marks','short'],{tall:false}],[['--base','l'],{base:'l'}],[['--baseline','30'],{baseline:.3}],[['--baseline','auto'],{}],[['--cutoff','70'],{cutoff:.7}],[['--invert','--tones','3'],{invert:true,tones:3},{tones:3}],
    [['--theme','dark','--tones','3'],{light:true,tones:3},{tones:3}],[['--dither','--tones','3'],{dither:true,tones:3},{tones:3}],[['--no-room'],{room:false}],[['--pad','dot'],{pad:'dot'}],[['--no-phone'],{phone:false}],[['--tones','5'],{tones:5}],[['--cols=18'],{cols:18}]];
  for(const [args,o,ref] of single){
    const w=Z.picture(SHAPES.disc,o,HELV,P).text,base=Z.picture(SHAPES.disc,ref||{},HELV,P).text;
    eq(cli(['image',DISC_PNG,'-p','discord'].concat(args)).stdout,w,args.join(' '));
    if(args[1]!=='auto'&&args[0]!=='--no-phone')ok(w!==base,args.join(' ')+' changes nothing, so it proves nothing');
  }
  // A platform with its own default letter gets it without being asked, and passes.
  let own=0;
  for(const Pb of Z.PLATFORMS)if(Pb.base){
    const r=cli(['image',DISC_PNG,'-p',Pb.id]);own++;
    eq(r.status,0,Pb.id+' exit code');eq(r.stdout,Z.picture(SHAPES.disc,{},HELV,Pb).text,Pb.id+' default base');
    ok(!flattened(r.stdout,Pb),Pb.id+' default base does not stack');
  }
  eq(cli(['image',DISC_PNG,'--metrics',path.join(ROOT,'profiles','arial.json')]).stdout,cli(['image',DISC_PNG,'--font','arial']).stdout,'--metrics');
  const small=cli(['image',DISC_PNG,'-p','custom','--limit','120']);
  eq(small.status,0,'--limit exit code');ok(small.stdout.length>60&&small.stdout.length<=120,'--limit 120 gave '+small.stdout.length+' units');
  return single.length+3+' runs';
});
test('cli: --json is valid and complete',()=>{
  const r=cli(['image',DISC_PNG,'-p','bluesky','--json']),j=JSON.parse(r.stdout),P=Z.platform('bluesky');
  eq(r.status,0,'exit code');eq(r.stderr,'','--json should leave standard error empty');
  eq(j.text,cli(['image',DISC_PNG,'-p','bluesky']).stdout,'text');
  for(const u of UNITS)eq(j.counts[u],Z.count[u](j.text),'counts.'+u);
  eq(j.count,Z.count[P.unit](j.text),'count');eq(j.ok,true,'ok');eq(j.platform.id,'bluesky','platform.id');eq(j.platform.limit,300,'platform.limit');
  ok(Array.isArray(j.check)&&j.check.length>3&&j.check.every(i=>['ok','warn','fail','note'].includes(i.level)&&typeof i.msg==='string'),'check items');
  eq(j.options.platform,'bluesky','options.platform');eq(j.options.base,'blank','options.base');eq(j.options.colsFitted,true,'options.colsFitted');
  ok(Number.isInteger(j.options.cols)&&j.options.cols>=6,'options.cols');eq(j.size.columns>0,true,'size.columns');
  eq(j.image.width,300,'image.width');
  const g=JSON.parse(cli(['glitch','hello','--json','--seed','3']).stdout);
  eq(g.options.seed,3,'glitch options.seed');eq(g.text,cli(['glitch','hello','--seed','3']).stdout,'glitch text');
  eq(JSON.parse(cli(['platforms','--json']).stdout).length,Z.PLATFORMS.length,'platforms');
});
test('cli: -o writes the exact text and nothing else',()=>{
  const out=tmp('post.txt'),r=cli(['image',DISC_PNG,'-o',out]),want=Z.picture(SHAPES.disc,{},HELV,Z.platform('x')).text;
  eq(r.status,0,'exit code');eq(r.stdout,'','stdout');
  ok(fs.readFileSync(out).equals(Buffer.from(want,'utf8')),'the file is not the text in UTF-8, byte for byte');
  ok(r.stderr.includes('Wrote'),'no word that the file was written');
  // What was saved passes its own check when read back.
  eq(cli(['check',out,'-p','x']).status,0,'check of the saved file');
});
test('cli: --copy pipes the exact text to pbcopy',()=>{
  // A stand-in pbcopy first on the PATH, so the real clipboard is never touched.
  const bin=tmp('bin'),clip=tmp('clip.txt');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'pbcopy'),'#!/bin/sh'+NL+'cat > "$ZALGO_TEST_CLIP"'+NL,{mode:0o755});
  const r=cli(['image',DISC_PNG,'--copy'],{env:{PATH:bin+':/usr/bin:/bin',ZALGO_TEST_CLIP:clip}}),want=Z.picture(SHAPES.disc,{},HELV,Z.platform('x')).text;
  eq(r.status,0,'exit code');eq(r.stdout,want,'stdout');
  ok(fs.readFileSync(clip).equals(Buffer.from(want,'utf8')),'the clipboard did not get the text byte for byte');
  ok(r.stderr.includes('Copied'),'no word that it was copied');
  // With no pbcopy at all the text is still printed and the reason is one clear line.
  const empty=tmp('empty');fs.mkdirSync(empty);
  const m=cli(['image',DISC_PNG,'--copy','--json'],{env:{PATH:empty}});
  eq(m.status,2,'exit code without pbcopy');ok(m.stderr.includes('pbcopy')&&m.stderr.trimEnd().split(NL).length===1,'message without pbcopy: '+show(m.stderr));
  eq(JSON.parse(m.stdout).text,want,'text without pbcopy');
});
test('cli: an image with no subject is an empty result with a reason',()=>{
  fs.writeFileSync(tmp('flat.png'),enc.rgb(image(40,40,[10,200,90,255],()=>null)));
  const r=cli(['image',tmp('flat.png')]);
  eq(r.status,0,'exit code');eq(r.stdout,'','stdout');ok(r.stderr.includes('No picture'),'no reason given');
  eq(JSON.parse(cli(['image',tmp('flat.png'),'--json']).stdout).text,'','json text');
});
test('cli: glitch from arguments and from a pipe',()=>{
  const a=cli(['glitch','Hello,','world']);
  eq(a.status,0,'exit code');eq(unglitch(a.stdout),'Hello, world','message');
  eq(cli(['glitch','Hello, world']).stdout,a.stdout,'one argument or two');
  eq(cli(['glitch'],{input:'Hello, world'+NL}).stdout,a.stdout,'piped text, without the shell newline');
  ok(cli(['glitch','Hello, world','--seed','8']).stdout!==a.stdout,'another seed gave the same text');
  eq(cli(['glitch','Hello, world','--seed','7']).stdout,a.stdout,'the default seed is 7');
  const g=Object.assign({},GLITCH,{up:5,dn:0,mid:0,seed:2}),P=Z.platform('discord');
  eq(cli(['glitch','--up','5','--down','0','--through','0','--seed','2','-p','discord','--no-fit','--','-dash']).stdout,Z.layout(Z.glitch('-dash',g,HELV).line,HELV,P,g).text,'options');
  for(const Pf of Z.PLATFORMS){
    const r=cli(['glitch','Hello, world','-p',Pf.id]);
    // Fitting is about length. Where the platform draws piles on ordinary letters flat for everyone, the check still fails.
    eq(r.status,flattened(r.stdout,Pf)&&flatLevel(Pf)==='fail'?1:0,Pf.id+' exit code');ok(within(r.stdout,Pf),Pf.id+' is over the limit when counted again');
  }
  // Without the fit, 40 marks a side on 12 letters cannot pass SMS, and the exit code must say so.
  const big=cli(['glitch','Hello, world','-p','sms','--no-fit','--up','40','--down','40']);
  eq(big.status,1,'--no-fit exit code');ok(!within(big.stdout,Z.platform('sms')),'--no-fit still fitted');
  eq(cli(['glitch','']).status,0,'empty text');eq(cli(['glitch','']).stdout,'','empty text output');
  ok(cli(['glitch',S(0x1f600)+' ok']).stdout.includes(S(0x1f600)),'emoji');
});
/* ---------- X in every browser, and Safari's limit of 30 marks a column ---------- */
const LOW=0x2cd,warns=ck=>ck.items.filter(i=>i.level==='warn'||i.level==='fail');
// The letter each column with marks stands on.
const stands=line=>{const out=new Set();for(const {segment} of seg.segment(line)){const cps=Array.from(segment.normalize('NFD'),c=>c.codePointAt(0));if(cps.some(isMark))out.add(cps[0]);}return [...out];};
const tallest=(t,P)=>Z.inspect(t,HELV,P).tallest;
test('x: pictures stand on the one letter every browser stacks, with nothing to warn about but the fold',()=>{
  let n=0,folded=0;
  eq(Z.count.weighted(S(LOW)),1,'weight of the letter');eq(S(LOW).normalize('NFKC'),S(LOW),'NFKC leaves the letter alone');
  for(const id of ['x','xpremium'])for(const M of [HELV,ARIAL])for(const name of ALL_SHAPES){
    const P=Z.platform(id),r=Z.picture(SHAPES[name],{},M,P),tag=id+'/'+name;n++;
    eq(P.base,'low',id+' default base');ok(P.carrier.includes(LOW),id+' carrier');eq(r.opts.base,'low',tag+' base');
    eq(stands(r.line).join(),String(LOW),tag+': letters under the piles');
    ok(r.check.ok,tag+': check failed');
    // Over 280 the feed shows only the start of a Premium post. That is the one thing left to warn about.
    const long=!!P.fold&&Z.count[P.unit](r.text)>P.fold.chars;if(long)folded++;
    eq(warns(r.check).map(i=>i.level+' '+i.msg).join(' | '),long?'warn '+P.fold.msg:'',tag+': warnings');
  }
  ok(folded>0&&folded<n,'expected pictures on both sides of the fold: '+folded+' of '+n);
  return n+' pictures, '+folded+' past the fold';
});
test('x: a blank or an ordinary letter warns and still passes, on slack it fails',()=>{
  const X=Z.platform('x'),Sl=Z.platform('slack');
  for(const base of ['blank','o','i']){
    const r=Z.picture(SHAPES.disc,{base},HELV,X),said=r.check.items.filter(i=>i.msg===X.flat);
    ok(flattened(r.text,X),base+': expected piles on a letter X draws flat');
    eq(said.length,1,base+': reports');eq(said[0].level,'warn',base+': level');ok(r.check.ok,base+': a warning must not fail the check');
    const s=Z.picture(SHAPES.disc,{base},HELV,Sl),fail=s.check.items.filter(i=>i.msg===Sl.flat);
    eq(fail.length,1,base+' on slack: reports');eq(fail[0].level,'fail',base+' on slack: level');ok(!s.check.ok,base+' on slack must fail');
    eq(cli(['image',DISC_PNG,'-p','x','--base',base]).status,0,base+' on x: exit code');
    eq(cli(['image',DISC_PNG,'-p','slack','--base',base]).status,1,base+' on slack: exit code');
  }
  const d=Z.picture(SHAPES.disc,{},HELV,Sl);
  ok(d.check.ok,'slack default');ok(stands(d.line).every(cp=>Sl.carrier.includes(cp)),'slack default letter is not one it stacks');
  // Glitch keeps the message's own letters, so X can only warn about it.
  const g=cli(['glitch','Hello, world','-p','x','--json']),j=JSON.parse(g.stdout);
  eq(g.status,0,'glitch on x: exit code');ok(j.check.some(i=>i.level==='warn'&&i.msg===X.flat),'glitch on x: no warning');
  eq(cli(['glitch','Hello, world','-p','slack']).status,1,'glitch on slack: exit code');
});
test('x: the wide base puts a blank in front of the platform letter and leaves room for Safari',()=>{
  for(const id of ['x','xpremium','slack']){
    const P=Z.platform(id),r=Z.picture(SHAPES.disc,{base:'wide'},HELV,P),ch=S(P.carrier[0]);
    ok(r.line.includes(NBSP+ch),id+': no blank in front of the letter');ok(!flattened(r.text,P),id+': piles on a letter drawn flat');
    ok(r.check.ok,id+': check failed');ok(Z.inspect(r.text,HELV,P).width*1.2<=P.width,id+': no room for the wider Safari columns');
  }
  const B=Z.platform('bluesky'),b=Z.picture(SHAPES.disc,{base:'wide'},HELV,B);
  ok(b.line.includes(NBSP+NBSP),'bluesky: wide is two blanks');
});
test('stack cap: fitted pictures and glitch pile at most 30 marks on every platform',()=>{
  eq(Z.STACK,30,'the cap');let n=0;
  for(const P of Z.PLATFORMS)for(const base of [undefined,'blank','wide','o'])for(const name of ALL_SHAPES){
    const r=Z.picture(SHAPES[name],base?{base}:{},HELV,P);n++;
    if(!r.text||atFloor(r,P))continue;
    ok(tallest(r.text,P)<=Z.STACK,P.id+'/'+base+'/'+name+': '+tallest(r.text,P)+' marks in one column');
    ok(!r.check.items.some(i=>i.msg.includes('stack only the first')),P.id+'/'+base+'/'+name+': warned about Safari');
  }
  const heavy=Object.assign({},GLITCH,{up:40,dn:40});
  for(const P of Z.PLATFORMS){
    const g=Z.fitGlitch('Hello, world',heavy,HELV,P),t=Z.layout(Z.glitch('Hello, world',g,HELV).line,HELV,P,g).text;
    ok(tallest(t,P)<=Z.STACK,P.id+' glitch: '+tallest(t,P)+' marks in one column');ok(g.up<heavy.up,P.id+' glitch was not thinned');
  }
  return n+' pictures';
});
test('stack cap: dense lifts it, the check warns, and the CLI passes it on',()=>{
  const P=Z.platform('xpremium'),a=Z.picture(SHAPES.disc,{},HELV,P),b=Z.picture(SHAPES.disc,{dense:true},HELV,P);
  eq(a.opts.dense,false,'dense is off unless asked');eq(b.opts.dense,true,'dense');
  ok(b.opts.cols>a.opts.cols,'dense gave '+b.opts.cols+' columns, capped gave '+a.opts.cols);
  ok(tallest(b.text,P)>Z.STACK,'dense did not go over the cap, so it proves nothing');
  const w=b.check.items.filter(i=>i.msg.startsWith('Tallest pile is '+tallest(b.text,P)+' marks')&&i.msg.includes('stack only the first'));
  eq(w.length,1,'warnings');eq(w[0].level,'warn','level');ok(b.check.ok,'a warning must not fail the check');
  const c=cli(['image',DISC_PNG,'-p','xpremium','--dense']);
  eq(c.stdout,b.text,'--dense');eq(c.status,0,'--dense exit code');ok(c.stderr.includes('stack only the first'),'--dense warning is not shown');
  eq(JSON.parse(cli(['image',DISC_PNG,'-p','xpremium','--dense','--json']).stdout).options.dense,true,'--dense in --json');
  const heavy=['glitch','Hello, world','-p','xpremium','--up','40','--down','40'];
  ok(tallest(cli(heavy).stdout,P)<=Z.STACK,'glitch without --dense went over the cap');
  ok(tallest(cli(heavy.concat('--dense')).stdout,P)>Z.STACK,'glitch --dense stayed under the cap');
  // A text checked by itself gets the same warning.
  ok(Z.check(b.text,P,HELV).items.some(i=>i.msg.includes('stack only the first')),'check on the text alone');
});
test('safari: Helvetica piles are taken as taller, so the reserved lines hold both engines',()=>{
  eq(HELV.apple.join(),'0.0275,0.0425','Helvetica');eq(ARIAL.apple.join(),'0,0','Arial');
  const plain=Z.metrics(Object.assign({},profile('helvetica'),{apple:[0,0]}));
  eq(plain.apple.join(),'0,0','a profile made in Safari carries its own spacing');
  const P=Z.platform('xpremium'),r=Z.picture(SHAPES.disc,{},HELV,P),a=Z.inspect(r.line,HELV,P),b=Z.inspect(r.line,plain,P);
  ok(a.top>b.top&&a.bottom>b.bottom,'no extra height for Safari');
  eq(a.up,b.up,'the Chrome height itself is unchanged');
  // 30 marks above at .0275 em each is most of a line: the layout must have reserved for it.
  const need=v=>Math.ceil(Math.max(0,v-.12)/P.lh);
  eq(r.layout.above,need(a.top),'lines above');eq(r.layout.below,need(a.bottom),'lines below');
});
test('cli: count',()=>{
  const text='i'+S(0x333,0x33f,0x30d,0x305)+PAD+S(0x65e5)+NL,r=cli(['count'],{input:text});
  eq(r.status,0,'exit code');
  // Worked out by hand: 5 + 1 + 1 + 1 units, the same in code points, 9 + 3 + 3 + 1 bytes, 4 graphemes.
  const hand={utf16:8,codepoints:8,bytes:16,graphemes:4,weighted:10,mastodon:5};
  for(const u of UNITS)ok(new RegExp('^'+Z.UNIT[u].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s+'+hand[u]+'$','m').test(r.stdout),u+' should be '+hand[u]+' in:'+NL+r.stdout);
  for(const P of Z.PLATFORMS)ok(new RegExp('^'+P.id+'\\s','m').test(r.stdout),'no row for '+P.id);
  const j=JSON.parse(cli(['count','--json'],{input:text}).stdout);
  for(const u of UNITS)eq(j.counts[u],hand[u],'json '+u);
  eq(j.platforms.length,Z.PLATFORMS.length,'platform rows');
  fs.writeFileSync(tmp('long.txt'),'a'.repeat(300));
  const long=JSON.parse(cli(['count',tmp('long.txt'),'--json']).stdout),fit=id=>long.platforms.find(p=>p.id===id).fits;
  eq(fit('x'),false,'300 letters on x');eq(fit('bluesky'),true,'300 letters on bluesky');eq(fit('sms'),false,'300 letters on sms');eq(fit('discord'),true,'300 letters on discord');
  // Bluesky's second limit: 300 graphemes are fine, 3,000 bytes are not.
  eq(JSON.parse(cli(['count','-','--json'],{input:('e'+S(0x33f).repeat(20)).repeat(100)}).stdout).platforms.find(p=>p.id==='bluesky').fits,false,'bluesky byte limit');
});
test('cli: check exits 1 on a text that is too long',()=>{
  const long=cli(['check',tmp('long.txt'),'-p','x']);
  eq(long.status,1,'300 letters on x');ok(long.stdout.includes('[FAIL]')&&long.stdout.includes('Too long by 20'),'no failing line');
  ok(!long.stdout.includes(ESC),'colour codes on a pipe');
  eq(cli(['check',tmp('long.txt'),'-p','discord']).status,0,'300 letters on discord');
  eq(cli(['check','-p','x'],{input:'hello'}).status,0,'short text from a pipe');
  eq(cli(['check',tmp('long.txt'),'-p','x','--limit','300']).status,0,'--limit 300');
  eq(cli(['check',tmp('long.txt'),'-p','custom','--limit','299']).status,1,'--limit 299');
  const j=JSON.parse(cli(['check',tmp('long.txt'),'-p','x','--json']).stdout);
  eq(j.ok,false,'json ok');eq(j.count,300,'json count');eq(j.check[0].level,'fail','json first item');
  // A stack that leaves a box that clips is a failed check as well, not only length.
  const tall=cli(['check','-p','bluesky'],{input:'l'+S(0x333)+S(0x33f).repeat(30)});
  eq(tall.status,1,'a clipped stack');ok(/\[FAIL\] Stacks reach/.test(tall.stdout),'no stack line');
});
test('cli: platforms lists every platform',()=>{
  const r=cli(['platforms']);eq(r.status,0,'exit code');
  for(const P of Z.PLATFORMS){
    const row=r.stdout.split(NL).find(l=>l.startsWith(P.id+' '));
    ok(row&&row.includes(P.name)&&row.includes(String(P.limit))&&row.includes(Z.UNIT[P.unit])&&row.endsWith(P.src),'row for '+P.id+': '+row);
  }
});
test('cli: help, with examples',()=>{
  for(const args of [[],['help'],['--help'],['-h'],['image','--help']]){
    const r=cli(args);eq(r.status,0,'zalgo '+args.join(' ')+' exit code');
    ok(r.stdout.includes('Usage')&&r.stdout.includes('Examples')&&r.stdout.includes('zalgo image photo.png'),'zalgo '+args.join(' ')+' did not print the usage');
  }
});
test('cli: bad arguments exit 2 with one helpful line',()=>{
  fs.writeFileSync(tmp('notes.txt'),'just some text');fs.writeFileSync(tmp('fake.png'),'just some text');
  const good=fs.readFileSync(DISC_PNG);fs.writeFileSync(tmp('cut.png'),good.subarray(0,good.length>>1));
  const bad=[
    [['image'],'needs a file'],[['image',tmp('missing.png')],'no such file'],[['image',DISC_PNG,DISC_PNG],'one file'],[['image',TMP],'folder'],
    [['image',tmp('notes.txt')],'not an image'],[['image',tmp('fake.png')],'not an image'],[['image',tmp('cut.png')],'cut short'],
    [['image',DISC_PNG,'--bogus'],'unknown option --bogus'],[['image',DISC_PNG,'--colz','3'],'did you mean --cols'],[['image',DISC_PNG,'-x'],'unknown option -x'],
    [['image',DISC_PNG,'-p','nope'],'unknown platform'],[['image',DISC_PNG,'--cols','abc'],'whole number'],[['image',DISC_PNG,'--cols','0'],'whole number'],
    [['image',DISC_PNG,'--cols'],'needs a value'],[['image',DISC_PNG,'--base','zzz'],'must be one of'],[['image',DISC_PNG,'--marks','huge'],'tall, short'],
    [['image',DISC_PNG,'--theme','blue'],'light, dark'],[['image',DISC_PNG,'--pad','x'],'blank, dot'],[['image',DISC_PNG,'--baseline','150'],'from 0 to 100'],
    [['image',DISC_PNG,'--cutoff','lots'],'number'],[['image',DISC_PNG,'--tones','99'],'whole number'],[['image',DISC_PNG,'--limit','0'],'whole number'],
    [['image',DISC_PNG,'--font','comic'],'unknown font'],[['image',DISC_PNG,'--metrics',tmp('notes.txt')],'not valid JSON'],[['image',DISC_PNG,'--metrics',tmp('missing.json')],'no such file'],
    [['image',DISC_PNG,'--invert=yes'],'does not take a value'],[['image',DISC_PNG,'-o',path.join(TMP,'no','such','dir.txt')],'cannot write'],
    [['frobnicate'],'unknown command'],[['imag',DISC_PNG],'did you mean image'],[['check',tmp('missing.txt')],'no such file'],[['count',DISC_PNG,DISC_PNG],'one file'],
    [['glitch','hi','--up','many'],'whole number'],[['glitch','hi','-p','myspace'],'unknown platform'],[['platforms','extra'],'takes no arguments']
  ];
  fs.writeFileSync(tmp('profile.json'),'{"font":"x","up":[]}');bad.push([['image',DISC_PNG,'--metrics',tmp('profile.json')],'not a font profile']);
  for(const [args,want] of bad){const msg=usageError(args);ok(msg.includes(want),'zalgo '+args.map(a=>path.basename(a)).join(' ')+' should mention "'+want+'": '+msg.trim());}
  // With no sips to convert it, a JPEG is refused with a line that says what does work. A PNG needs no sips.
  const bare=tmp('nosips');fs.mkdirSync(bare);
  const noSips=usageError(['image',BURGER],{env:{PATH:bare}});
  ok(noSips.includes('sips')&&noSips.includes('PNG'),'without sips: '+noSips.trim());
  eq(cli(['image',DISC_PNG],{env:{PATH:bare}}).status,0,'a PNG without sips');
  // An option that exists but belongs to another command is ignored with a note, not refused.
  const r=cli(['count','--cols','3'],{input:'abc'});
  eq(r.status,0,'count --cols exit code');ok(r.stderr.includes('--cols')&&r.stderr.includes('ignored'),'no note about --cols');
  return bad.length+' bad commands';
});
// Colour needs a terminal. macOS "script" lends one, and its output shows what a person would see.
if(process.platform==='darwin'&&fs.existsSync('/usr/bin/script'))test('cli: colour on a terminal only, and never with NO_COLOR',()=>{
  const env=Object.assign({},process.env,{TERM:'xterm-256color'});delete env.NO_COLOR;
  // script refuses a pipe as its own input, so it gets none.
  const run=(e,args)=>spawnSync('/usr/bin/script',['-q','/dev/null',process.execPath,CLI].concat(args),{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:e});
  const args=['check',tmp('long.txt'),'-p','x'],on=run(env,args),off=run(Object.assign({},env,{NO_COLOR:'1'}),args);
  if(on.error||!on.stdout.includes('[FAIL]'))throw new Error('script could not run the CLI: '+show(on.stdout+on.stderr));
  ok(on.stdout.includes(ESC+'[31m[FAIL]'),'no colour on a terminal');
  ok(!off.stdout.includes(ESC)&&off.stdout.includes('[FAIL]'),'colour with NO_COLOR set');
  ok(!run(Object.assign({},env,{TERM:'dumb'}),args).stdout.includes(ESC),'colour on a dumb terminal');
  ok(!cli(args).stdout.includes(ESC),'colour on a pipe');
  // On a terminal the text ends with a line break, so the prompt does not land on the picture.
  const shown=run(env,['glitch','hi','--up','2','--down','0','--through','0']).stdout;
  ok(/\r?\n$/.test(shown)&&unglitch(shown.split(NL).find(l=>l.includes('h'))||'').includes('hi'),'no line break after the text on a terminal: '+show(shown.slice(-30)));
});else skip('cli: colour on a terminal','needs the macOS script command to lend a terminal');

/* ---------- words drawn as letters ----------
   What the letters should be is worked out here, from the pictures in tools/font.js and the size table
   below. The text is then read back mark by mark and compared with that. */
const FONT_SRC=require(path.join(ROOT,'tools','font.js')).FONTS;
// By hand: size, font, text columns per letter pixel, marks per letter pixel. Largest first.
const LETTER_SIZES=[[6,'big',2,3],[5,'big',2,2],[4,'big',1,2],[3,'big',1,1],[2,'small',1,2],[1,'small',1,1]];
// By hand: letter height and the gap between two words, in letter pixels.
const LETTER_FONT={big:{h:7,gap:3},small:{h:5,gap:2}},DARK_UP=0x33f,DARK_DN=0x333;
const sizeOf=id=>{const z=LETTER_SIZES.find(z=>z[0]===id);return {id,font:z[1],sx:z[2],sy:z[3],h:LETTER_FONT[z[1]].h};};
const topRow=v=>31-Math.clz32(v&-v),lowRow=v=>31-Math.clz32(v);   // bit 0 is the top row of a letter
// Words -> one bit mask per text column, 0 for a gap. One empty pixel between letters.
function wantStrip(words,font,sx){
  const g=FONT_SRC[font].g,c=[],put=(v,n)=>{for(let k=0;k<n*sx;k++)c.push(v);};
  words.forEach((w,i)=>{
    if(i)put(0,LETTER_FONT[font].gap);
    [...w].forEach((ch,j)=>{if(j)put(0,1);for(const hex of g[ch].match(/../g))put(parseInt(hex,16),1);});
  });
  return c;
}
/* The columns the art must have, as [mask of the row above the line, mask of the row below it].
   Two rows split the words where the wider row is narrowest, and the shorter row is centred on the longer.
   One row stands on the line, or with `hang` hangs from it. Empty columns at either end are not written. */
function wantColumns(text,z,rows,hang){
  const words=text.toUpperCase().split(/\s+/).filter(Boolean);
  let top=wantStrip(words,z.font,z.sx),bot=[];
  if(rows===2){
    let best=Infinity;
    for(let k=1;k<words.length;k++){
      const a=wantStrip(words.slice(0,k),z.font,z.sx),c=wantStrip(words.slice(k),z.font,z.sx),m=Math.max(a.length,c.length);
      if(m<best){best=m;top=a;bot=c;}
    }
    const d=top.length-bot.length,pad=Array(Math.abs(d)>>1).fill(0);
    if(d>0)bot=pad.concat(bot);else top=pad.concat(top);
  }else if(hang){bot=top;top=[];}
  const out=[];
  for(let x=0;x<Math.max(top.length,bot.length);x++)out.push([top[x]||0,bot[x]||0]);
  while(out.length&&!out[0][0]&&!out[0][1])out.shift();
  while(out.length&&!out[out.length-1][0]&&!out[out.length-1][1])out.pop();
  return out;
}
// A line of letter art, column by column: the letter it stands on and its marks, nearest the line first.
function readColumns(line,M){
  const up=new Set(M.up.map(m=>m.cp)),dn=new Set(M.dn.map(m=>m.cp));
  return Array.from(seg.segment(line),({segment})=>{
    const cps=Array.from(segment.normalize('NFD'),c=>c.codePointAt(0));
    return {base:cps[0],up:cps.filter(cp=>up.has(cp)),dn:cps.filter(cp=>dn.has(cp)),other:cps.slice(1).filter(cp=>!up.has(cp)&&!dn.has(cp)).length};
  });
}
/* Every letter pixel is exactly sy marks: all dark for ink, none dark for a hole. A pile runs from the line
   to the last inked pixel of its column and no further, so every column of a row has the same count per pixel. */
function letterProblems(line,text,z,rows,M,hang){
  const want=wantColumns(text,z,rows,hang),got=readColumns(line,M),bad=[];
  if(got.length!==want.length)return [got.length+' columns, expected '+want.length];
  const pixels=(list,dark,n,row,x,side)=>{
    let v=0;
    if(list.length!==n*z.sy){bad.push('column '+x+' has '+list.length+' marks '+side+', expected '+n+' pixels of '+z.sy);return -1;}
    for(let r=0;r<n;r++){
      const k=list.slice(r*z.sy,(r+1)*z.sy).filter(cp=>cp===dark).length;
      if(k&&k!==z.sy)bad.push('column '+x+' mixes ink and filler in one pixel '+side);
      if(k)v|=1<<row(r);
    }
    return v;
  };
  want.forEach(([tv,bv],x)=>{
    const c=got[x];
    if(c.other)bad.push('column '+x+' holds something that is neither a letter nor a known mark');
    if(!tv&&!bv){if(c.base!==0xa0||c.up.length||c.dn.length)bad.push('column '+x+' should be an empty gap');return;}
    const a=pixels(c.up,DARK_UP,tv?z.h-topRow(tv):0,r=>z.h-1-r,x,'above'),b=pixels(c.dn,DARK_DN,bv?lowRow(bv)+1:0,r=>r,x,'below');
    if(a>=0&&a!==tv)bad.push('column '+x+' above reads '+a.toString(2)+', the letter has '+tv.toString(2));
    if(b>=0&&b!==bv)bad.push('column '+x+' below reads '+b.toString(2)+', the letter has '+bv.toString(2));
  });
  return bad;
}
const FOLD_X=Z.platform('xpremium').fold;
const said=(ck,msg)=>ck.items.filter(i=>i.msg===msg);

/* ---------- shading: what the tones of a picture are made of ---------- */
const cps=t=>Array.from(t,c=>c.codePointAt(0)),hexes=l=>l.map(m=>m.cp.toString(16)).join(' ');
// A drawing as the encoder takes it: paint(x,y) gives the ink of a pixel, or null where nothing is drawn.
function drawn(w,h,paint){
  const ink=new Float32Array(w*h),mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const v=paint(x,y);if(v!=null){mask[y*w+x]=1;ink[y*w+x]=v;}}
  return {w,h,ink,mask};
}
test('shade: three tones are a tick, two dots and a double bar',()=>{
  eq(hexes(Z.palette(HELV.shadeUp,3,true)),'30d 308 33f','Helvetica above');
  eq(hexes(Z.palette(HELV.shadeDn,3,true)),'329 324 333','Helvetica below');
  eq(hexes(Z.palette(ARIAL.shadeUp,3,true)),'30d 304 33f','Arial above');
  eq(hexes(Z.palette(ARIAL.shadeDn,3,true)),'329 331 333','Arial below');
});
test('shade: no picture holds a ring or a bracket, and lettering keeps its ring',()=>{
  const shapes=new Set([0x30a,0x325,0x346,0x347]),bad=[];let n=0;
  for(const [name,M] of [['helvetica',HELV],['arial',ARIAL]])for(const id of ['x','xpremium','discord'])for(const tall of [true,false])for(let tones=1;tones<=6;tones++)for(const dither of [false,true]){
    const r=Z.picture(SHAPES.disc,{tones,tall,dither},M,Z.platform(id)),hit=cps(r.text).find(c=>shapes.has(c));n++;
    ok(r.text,'no picture for '+name+'/'+id);
    if(hit)bad.push(name+'/'+id+'/'+tones+' tones'+(tall?'':' short')+(dither?' dithered':'')+' holds U+'+hit.toString(16));
  }
  none(bad,n);
  ok(cps(Z.banner('ZALGO',{size:3,hang:true},HELV,Z.platform('xpremium')).line).includes(0x325),'the lettering lost the ring it spaces its strokes with');
  return n+' pictures';
});
test('shade: a cell across two inks takes one of them, never the tone between',()=>{
  const P=Z.platform('x'),bad=[];let n=0,both=0;
  // Light over dark above the line, and dark over light below it, with the boundary moved a pixel at a time
  // so that it falls inside a cell at some of the positions.
  for(let edge=4;edge<=16;edge++){
    const src=drawn(40,40,(x,y)=>y<20?(y<edge?.08:1):(y<40-edge?1:.08)),r=Z.encode(src,{cols:10,baseline:.5,tones:3,tall:true},HELV,P),got=new Set(cps(r.line));n++;
    for(const mid of [r.pal.up[1].cp,r.pal.dn[1].cp])if(got.has(mid))bad.push('boundary at row '+edge+' gave the middle tone U+'+mid.toString(16));
    if([r.pal.up[0],r.pal.up[2],r.pal.dn[0],r.pal.dn[2]].every(m=>got.has(m.cp)))both++;
  }
  none(bad,n);
  ok(both>=n-2,'the light and the dark ink should both show: '+both+' of '+n);
});
test('shade: the cells on the edge of a flat dark shape are dark',()=>{
  // A dark triangle above the line and its mirror below. Its slanted sides leave most edge cells part empty.
  const src=drawn(120,60,(x,y)=>Math.abs(x-60)<(y<30?y:59-y)*2?1:null),light=new Set([0x30d,0x30e,0x308,0x307,0x304,0x305,0x329,0x348,0x324,0x323,0x331,0x332]);let n=0;
  for(const tones of [2,3,4,5])for(const M of [HELV,ARIAL]){
    const r=Z.encode(src,{cols:24,baseline:.5,tones,tall:true},M,Z.platform('xpremium')),hit=cps(r.line).find(c=>light.has(c));n++;
    ok(r.line.includes(String.fromCodePoint(0x33f))&&r.line.includes(String.fromCodePoint(0x333)),'nothing drawn at '+tones+' tones');
    ok(!hit,'a flat dark shape at '+tones+' tones holds the lighter mark U+'+(hit||0).toString(16));
  }
  return n+' drawings';
});
test('grid: the encoder reports the cells its columns and marks fill',()=>{
  const src=drawn(232,66,(x,y)=>Math.hypot(x-116,y-33)<28?1:null);let n=0;
  for(const id of ['x','xpremium','discord'])for(const cols of [12,30,52])for(const tones of [1,3]){
    const r=Z.encode(src,{cols,baseline:.6,tones,tall:true},HELV,Z.platform(id)),g=r.grid,tag=id+'/'+cols+'/'+tones;n++;
    // Empty columns at either end are in the grid and not in the text, and an empty column is narrower than one with marks.
    ok(g.xs.length-1>=r.cols&&r.cols>0,'column edges, '+tag+': '+(g.xs.length-1)+' cells for '+r.cols+' columns');
    eq(g.xs[0],0,'first edge, '+tag);
    ok(g.xs.every((x,i)=>!i||x>g.xs[i-1]),'edges out of order, '+tag);
    ok(g.xs[g.xs.length-1]>src.w-src.w/cols&&g.xs[g.xs.length-1]<src.w+src.w/cols,'the columns do not span the picture, '+tag+': '+g.xs[g.xs.length-1]);
    ok(Math.abs(g.baseline-.6*src.h)<1e-9,'baseline, '+tag);
    ok(g.rowUp>0&&g.rowDn>0&&g.up0>=0&&g.dn0>=0,'rows, '+tag);
  }
  return n+' grids';
});

test('text: the letter tables are the pictures in tools/font.js',()=>{
  let n=0;
  eq(Object.keys(Z.FONTS).join(),Object.keys(FONT_SRC).join(),'fonts');
  for(const name in LETTER_FONT){
    const f=Z.FONTS[name],src=FONT_SRC[name];
    eq(f.h,LETTER_FONT[name].h,name+' height');eq(src.h,f.h,name+' height in tools/font.js');eq(f.gap,LETTER_FONT[name].gap,name+' word gap');
    eq(Object.keys(f.g).join(''),Object.keys(src.g).join(''),name+' characters');
    for(const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')ok(f.g[ch],name+' has no '+ch);
    for(const ch in f.g){
      const g=f.g[ch];n++;
      eq(g.map(v=>v.toString(16).padStart(2,'0')).join(''),src.g[ch],name+' '+ch);
      ok(g.length>0&&g.every(v=>Number.isInteger(v)&&v>=0&&v<1<<f.h),name+' '+ch+' is taller than the font');
      // A blank column at the edge of a letter would double the gap beside it.
      ok(g[0]&&g[g.length-1],name+' '+ch+' has an empty column at its edge');
      ok(g.reduce((a,v)=>a|v,0),name+' '+ch+' is empty');
    }
    // Every letter and digit of a font is one width, except the ones drawn narrow or wide on purpose.
    const odd=name==='big'?'I1':'I1MNW';
    for(const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')if(!odd.includes(ch))eq(f.g[ch].length,name==='big'?5:3,name+' '+ch+' width');
  }
  return n+' letters';
});
test('text: sizes run from the largest to the smallest',()=>{
  eq(JSON.stringify(Z.SIZES.map(z=>[z.id,z.font,z.sx,z.sy])),JSON.stringify(LETTER_SIZES),'sizes');
  // Larger means more marks for the same word, which is what "the largest that fits" relies on.
  const marks=Z.SIZES.map(z=>Z.count.codepoints(Z.banner('ZALGO',{size:z.id,rows:1,phone:false,dense:true},HELV,Z.platform('custom')).line));
  for(let i=1;i<marks.length;i++)ok(marks[i]<marks[i-1],'size '+Z.SIZES[i].id+' is not smaller than size '+Z.SIZES[i-1].id+': '+marks.join(' '));
});
test('text: letters worked out by hand',()=>{
  const P=Z.platform('xpremium'),L=S(LOW),D=S(DARK_UP),tick=S(0x30d),ring=S(0x30a);
  // One row is asked to stand on the line here. Hanging rows are worked out in the test after this one.
  const line=(t,o)=>Z.banner(t,Object.assign({hang:false},o),HELV,P).line;
  // I is one column, seven pixels high.
  eq(line('I',{size:3}),L+D.repeat(7),'I at size 3');
  eq(line('i',{size:4}),L+D.repeat(14),'I at size 4, two marks a pixel');
  eq(line('I',{size:1}),L+D.repeat(5),'I at size 1, the small font');
  eq(line('I',{size:6}),(L+D.repeat(21)).repeat(2),'I at size 6, two columns and three marks a pixel');
  // L is a full column, then four columns with only the bottom pixel.
  eq(line('L',{size:3}),L+D.repeat(7)+(L+D).repeat(4),'L at size 3');
  /* T: the bar is the top pixel, so the outer columns carry six pixels of filler under it. The filler is the
     tick (.2147 em), with a ring (.2667) whenever that brings the column closer to six dark marks (.232 each):
     tick -.017, ring +.017, tick 0, and again. */
  const under=tick+ring+tick+tick+ring+tick;
  eq(line('T',{size:3}),(L+under+D).repeat(2)+L+D.repeat(7)+(L+under+D).repeat(2),'T at size 3');
  // Two rows: the second word hangs below the line. Below marks are written first.
  eq(line('I I',{size:3,rows:2}),L+S(DARK_DN).repeat(7)+D.repeat(7),'I over I');
  // A gap between letters is one empty column, between words three.
  eq(line('II',{size:3}),L+D.repeat(7)+NBSP+L+D.repeat(7),'II');
  eq(line('I I',{size:3,rows:1}),L+D.repeat(7)+NBSP.repeat(3)+L+D.repeat(7),'I I on one row');
});
test('text: one row hangs from the line when that takes fewer marks',()=>{
  const P=Z.platform('xpremium'),L=S(LOW),D=S(DARK_UP),U=S(DARK_DN),tick=S(0x329),ring=S(0x325);
  const line=(t,o)=>Z.banner(t,o,HELV,P).line,marks=t=>Z.count.codepoints(t);
  // T hanging: the bar is the pixel at the line, so the outer columns are one mark and carry no filler at all.
  eq(line('T',{size:3,hang:true}),(L+U).repeat(2)+L+U.repeat(7)+(L+U).repeat(2),'T hanging at size 3');
  eq(line('I',{size:4,hang:true}),L+U.repeat(14),'I hanging at size 4');
  // L hanging: the foot is the pixel furthest from the line, so its four columns carry six pixels of filler first.
  const l=readColumns(line('L',{size:3,hang:true}),HELV);
  eq(l.map(c=>c.dn.length).join(),'7,7,7,7,7','L hanging: marks a column');eq(l.map(c=>c.up.length).join(),'0,0,0,0,0','L hanging: marks above');
  for(const c of l.slice(1)){eq(c.dn[6],DARK_DN,'L hanging: the foot');ok(c.dn.slice(0,6).every(cp=>cp===0x329||cp===0x325),'L hanging: filler under the line is '+c.dn.slice(0,6).map(cp=>cp.toString(16)).join());}
  ok(l.slice(1).some(c=>c.dn.includes(0x329))&&[tick,ring].every(m=>m.length===1),'L hanging uses no tick below');
  // Left alone, a row takes the side with fewer marks: T hangs, L stands, and a tie stands.
  for(const [t,hang] of [['T',true],['L',false],['I',false],['ART',true],['LUV',false]]){
    const up=Z.banner(t,{size:3,hang:false},HELV,P),dn=Z.banner(t,{size:3,hang:true},HELV,P),auto=Z.banner(t,{size:3},HELV,P);
    eq(up.result.hang,false,t+' asked to stand');eq(dn.result.hang,true,t+' asked to hang');eq(auto.result.hang,hang,t+' left alone hangs');
    eq(auto.text,(hang?dn:up).text,t+' left alone');
    ok(hang?marks(dn.line)<marks(up.line):marks(up.line)<=marks(dn.line),t+': '+marks(up.line)+' marks standing, '+marks(dn.line)+' hanging');
    // Either way it is the same letters, the same width and the same number of columns.
    eq(dn.result.cols,up.result.cols,t+' columns');ok(Math.abs(dn.result.width-up.result.width)<1e-9,t+' width');
    none(letterProblems(up.line,t,sizeOf(3),1,HELV,false).concat(letterProblems(dn.line,t,sizeOf(3),1,HELV,true)).map(m=>t+': '+m),2);
  }
  // Two rows have a word on each side already, so the side is not a choice.
  eq(Z.banner('zalgo art',{size:3,rows:2,hang:true},HELV,P).text,Z.banner('zalgo art',{size:3,rows:2},HELV,P).text,'hang with two rows');
  eq(Z.banner('zalgo art',{size:3,rows:2,hang:true},HELV,P).result.hang,false,'two rows report hang');
  // A hanging row reaches down and not up, and the text keeps its lines on that side.
  const h=Z.banner('ART',{size:3,hang:true},HELV,P),s=Z.banner('ART',{size:3,hang:false},HELV,P);
  ok(h.result.dn>s.result.dn+1&&h.result.up<s.result.up-1,'hanging: '+h.result.up.toFixed(2)+' em up, '+h.result.dn.toFixed(2)+' em down');
  eq(h.layout.above,0,'lines above hanging letters');ok(h.layout.below>0,'no lines below hanging letters');
  ok(s.layout.above>0,'no lines above standing letters');
  none(fitProblems(h,P,HELV,h.opts).concat(checkProblems(h.check,h.text,P)),1);
});
test('cli: text --side puts one row above or below the line',()=>{
  const X=Z.platform('x');
  for(const [side,hang] of [['above',false],['below',true]]){
    const want=Z.banner('gm',{size:4,hang},HELV,X),c=cli(['text','gm','--size','4','--side',side]),j=JSON.parse(cli(['text','gm','--size','4','--side',side,'--json']).stdout);
    eq(c.status,0,side+' exit code');eq(c.stdout,want.text,'--side '+side);
    ok(c.stderr.includes(hang?'1 row (automatic) hanging below the line':'1 row (automatic) standing on the line'),'--side '+side+' summary: '+c.stderr.split(NL)[1]);
    eq(j.options.side,side,'options.side with --side '+side);eq(j.options.sideAutomatic,false,'options.sideAutomatic with --side '+side);eq(j.text,want.text,'--json text with --side '+side);
  }
  eq(Z.banner('gm',{size:4,hang:false},HELV,X).check.count,148,'gm standing at size 4');eq(Z.banner('gm',{size:4,hang:true},HELV,X).check.count,130,'gm hanging at size 4');
  // Left alone it says which side it took, and two rows are on both.
  const a=JSON.parse(cli(['text','gm','--json']).stdout),two=JSON.parse(cli(['text','zalgo','art','--json']).stdout);
  eq(a.options.side,'below','options.side for gm');eq(a.options.sideAutomatic,true,'options.sideAutomatic');
  eq(JSON.parse(cli(['text','luv','--size','3','--json']).stdout).options.side,'above','options.side for luv');
  eq(two.options.side,'both','options.side for two rows');
  const t=cli(['text','zalgo','art','--side','below']);
  eq(t.stdout,Z.banner('zalgo art',{},HELV,X).text,'--side with two rows changes nothing');ok(!t.stderr.includes('hanging')&&!t.stderr.includes('standing'),'two rows named a side');
});
test('text: every size, on one row and two, reads back as the letters pixel for pixel',()=>{
  const bad=[],bases={xpremium:[LOW],slack:Z.platform('slack').carrier,discord:[0xa0,0x2e]};let n=0,fit=0;
  for(const id in bases)for(const M of [HELV,ARIAL])for(const [size] of LETTER_SIZES)for(const [rows,hang] of [[1,false],[1,true],[2]])for(const words of ['gm','Zalgo Art','to be or not 2 b?']){
    if(rows===2&&!words.includes(' '))continue;
    const P=Z.platform(id),z=sizeOf(size),r=Z.banner(words,{size,rows,hang},M,P),tag=id+'/'+M.font+'/size '+size+'/'+(rows===2?'2 rows':hang?'hanging':'standing')+'/'+words;n++;
    if(!r.result){bad.push(tag+': nothing drawn');continue;}
    const p=textProblems(r.text).concat(letterProblems(r.line,words,z,rows,M,hang)),cols=readColumns(r.line,M);
    if(r.result.size!==size||r.result.rows!==rows||r.opts.size!==size||r.opts.rows!==rows)p.push('reports size '+r.result.size+', '+r.result.rows+' rows');
    if(r.result.hang!==!!hang)p.push('reports hang '+r.result.hang);
    if(rows===1&&cols.some(c=>(hang?c.up:c.dn).length))p.push('marks on the wrong side of the line');
    if(!r.text.split(NL).includes(r.line))p.push('the art is not a line of the text');
    if(stands(r.line).some(cp=>!bases[id].includes(cp)))p.push('stands on '+stands(r.line).map(cp=>cp.toString(16)).join());
    // The numbers it reports, counted again from the text.
    const tall=Math.max(...cols.map(c=>c.up.length+c.dn.length)),i=Z.inspect(r.text,M,P);
    if(r.result.tallest!==tall||i.tallest!==tall)p.push('tallest is '+r.result.tallest+', counted '+tall);
    if(tall!==z.sy*z.h*rows)p.push('tallest pile is '+tall+', a full column is '+z.sy*z.h*rows);
    if(r.result.cols!==cols.length)p.push('reports '+r.result.cols+' columns, counted '+cols.length);
    if(r.check.count!==Z.count[P.unit](r.text))p.push('count');
    // It fits when it is inside the limits, the phone column and Safari's 30 marks, each measured here.
    const fits=within(r.text,P)&&i.width*1.02<=P.width&&tall<=Z.STACK;
    if(r.fits!==fits)p.push('fits is '+r.fits+', measured '+fits);
    if(fits){fit++;p.push(...fitProblems(r,P,M,r.opts),...checkProblems(r.check,r.text,P));}
    for(const m of p)bad.push(tag+': '+m);
  }
  none(bad,n);
  ok(fit>n/3&&fit<n,'expected some to fit and some not: '+fit+' of '+n);
  return n+' pieces of lettering, '+fit+' fit';
});
test('text: two rows of the tallest letters need --dense, like any pile over 30 marks',()=>{
  const P=Z.platform('xpremium'),a=Z.banner('ab cd',{size:6,rows:2},HELV,P),b=Z.banner('ab cd',{size:6,rows:2,dense:true},HELV,P);
  eq(a.result.tallest,42,'tallest');ok(!a.fits,'42 marks a column passed as fitting');ok(b.fits,'dense should allow it');
  eq(a.text,b.text,'dense changes the text of a fixed size');
  ok(warns(a.check).some(i=>i.msg.includes('42 marks')),'no warning about the 42 mark piles');
  // Left to itself it picks a size Safari draws whole.
  const auto=Z.banner('ab cd',{},HELV,P);
  ok(auto.fits&&auto.result.tallest<=Z.STACK,'automatic size has piles of '+auto.result.tallest);
});
test('text: letter tops stay level, whatever is under them',()=>{
  let worst=0,n=0;
  for(const M of [HELV,ARIAL])for(const id of ['xpremium','discord']){
    const P=Z.platform(id),r=Z.banner('Zalgo Art gm 2!',{size:6,rows:2},M,P);
    for(const [list,dark,pal,side] of [[M.up,DARK_UP,r.result.pal.up,'above'],[M.dn,DARK_DN,r.result.pal.dn,'below']]){
      const pitch=new Map(list.map(m=>[m.cp,m.pitch])),d=pitch.get(dark),steps=pal.filter(m=>m.cp!==dark).map(m=>m.pitch-d),tag=M.font+' '+side;
      // Two kinds of filler, one shorter than the dark mark and one taller, or a column of holes could only drift one way.
      eq(steps.length,2,tag+': kinds of filler');ok(steps[0]*steps[1]<0,tag+': both fillers are on one side of the dark mark');
      // Choosing the closer of the two at every mark can never leave a column further out than half their spread.
      const bound=(Math.abs(steps[0])+Math.abs(steps[1]))/2;
      ok(bound<.04,tag+': the fillers are '+bound.toFixed(3)+' em apart from the dark mark, too far to look level');
      for(const c of readColumns(r.line,M)){
        let off=0;n++;
        for(const cp of side==='above'?c.up:c.dn){off+=pitch.get(cp)-d;worst=Math.max(worst,Math.abs(off));ok(Math.abs(off)<=bound+1e-9,tag+': a column is '+Math.abs(off).toFixed(3)+' em off its neighbours');}
      }
    }
  }
  return n+' columns, at most '+worst.toFixed(3)+' em from level';
});
test('text: left alone, it picks the largest size that fits',()=>{
  /* words, platform, caption, then by hand from a run that was looked at in three browsers: size, rows, count,
     columns, and for one row whether it hangs from the line. */
  const KNOWN=[
    ['Introducing ZalgoArt','xpremium','',4,2,1101,57,false],['ZalgoArt','x','Introducing',2,1,255,31,true],['gm','x','',5,1,251,22,true],
    ['zalgo','x','',3,1,177,29,false],['hello','x','',4,1,270,29,false],['zalgo art','x','',3,2,249,29,false]
  ];
  for(const [words,id,caption,size,rows,count,cols,hang] of KNOWN){
    const P=Z.platform(id),r=Z.banner(words,{caption},HELV,P),tag='"'+words+'" on '+id;
    eq(r.result.size,size,tag+' size');eq(r.result.rows,rows,tag+' rows');eq(r.check.count,count,tag+' count');eq(r.result.cols,cols,tag+' columns');eq(r.result.hang,hang,tag+' hangs');
    eq(Z.count[P.unit](r.text),count,tag+' counted again');
    ok(r.fits&&r.check.ok&&within(r.text,P),tag+' does not fit');
    none(textProblems(r.text).concat(fitProblems(r,P,HELV,r.opts),letterProblems(r.line,words,sizeOf(size),rows,HELV,hang)).map(m=>tag+': '+m),1);
    // The same thing asked for by number.
    eq(Z.banner(words,{caption,size,rows},HELV,P).text,r.text,tag+' asked for by size');
    // Nothing larger fits, and at this size one row does not if two were used. One row comes first.
    for(const [bigger] of LETTER_SIZES)for(const k of [1,2]){
      if(bigger<size||(bigger===size&&k>=rows)||(k===2&&!words.includes(' ')))continue;
      const b=Z.banner(words,{caption,size:bigger,rows:k},HELV,P),i=Z.inspect(b.text,HELV,P);
      ok(!b.fits,tag+': size '+bigger+' on '+k+' rows fits and was not chosen');
      ok(!within(b.text,P)||i.width*1.02>P.width||i.tallest>Z.STACK,tag+': size '+bigger+' on '+k+' rows is called too big but measures inside every limit');
    }
  }
  // Another font profile changes the numbers a little and nothing else.
  for(const [words,id,caption] of KNOWN){
    const P=Z.platform(id),r=Z.banner(words,{caption},ARIAL,P);
    ok(r.fits&&r.check.ok,'"'+words+'" on '+id+' with Arial does not fit');
    none(textProblems(r.text).concat(fitProblems(r,P,ARIAL,r.opts),letterProblems(r.line,words,sizeOf(r.result.size),r.result.rows,ARIAL,r.result.hang)).map(m=>words+' (Arial): '+m),1);
  }
  return KNOWN.length+' phrases';
});
test('text: a phrase too long for the platform is returned at the smallest size and reported',()=>{
  const P=Z.platform('x'),r=Z.banner('Introducing ZalgoArt',{},HELV,P);
  eq(r.result.size,1,'size');eq(r.result.rows,2,'rows');eq(r.check.count,289,'count');
  ok(!r.fits,'fits');ok(!r.check.ok,'check passed');ok(!within(r.text,P),'it is inside the limit after all');
  eq(r.check.items[0].level,'fail','first check');
  none(textProblems(r.text).concat(letterProblems(r.line,'Introducing ZalgoArt',sizeOf(1),2,HELV)),1);
  const c=cli(['text','Introducing','ZalgoArt']);
  eq(c.status,1,'exit code');eq(c.stdout,r.text,'text');
  ok(c.stderr.includes('Does not fit even at the smallest size')&&c.stderr.includes('--caption')&&c.stderr.includes('[FAIL]'),'summary does not say why: '+c.stderr.split(NL).slice(3,5).join(' / '));
  // With the first word as a caption it does fit.
  eq(cli(['text','ZalgoArt','--caption','Introducing']).status,0,'exit code with a caption');
});
test('text: a caption is one plain line above the art',()=>{
  // The letters stand on the line here, so there are piles for the caption to stay clear of.
  const P=Z.platform('x'),a=Z.banner('zalgoart',{size:2,hang:false},HELV,P),b=Z.banner('zalgoart',{size:2,hang:false,caption:'Introducing'},HELV,P),lines=b.text.split(NL);
  eq(lines[0],'Introducing','first line');eq(b.line,a.line,'the art itself');eq(lines[lines.length-1-b.layout.below],b.line,'the art line');
  eq(b.text,'Introducing'+NL+a.text,'text');eq(b.check.count,a.check.count+12,'count: eleven letters and a line break');
  ok(b.layout.above>0&&lines.slice(1,1+b.layout.above).every(l=>l===PAD),'no spacer lines between the caption and the art');
  // Without room the art starts on its first line. A caption still gets the lines the piles need, or they would cover it.
  const bare=Z.banner('zalgoart',{size:2,hang:false,room:false},HELV,P),cap=Z.banner('zalgoart',{size:2,hang:false,room:false,caption:'Introducing'},HELV,P);
  eq(bare.text,bare.line,'no room, no caption');eq(cap.layout.above,b.layout.above,'lines kept under a caption');
  eq(cap.text,'Introducing'+NL+(PAD+NL).repeat(b.layout.above)+cap.line,'no room, with a caption');
  none(textProblems(b.text).concat(textProblems(cap.text)),2);
  // Letters that hang from the line have nothing above it, so the caption sits right on top of them.
  const h=Z.banner('zalgoart',{size:2,hang:true,caption:'Introducing'},HELV,P),hl=h.text.split(NL);
  eq(h.layout.above,0,'lines kept above hanging letters');eq(hl[0],'Introducing','caption over hanging letters');eq(hl[1],h.line,'hanging letters start on the next line');
  ok(h.layout.below>0&&hl.slice(2).every(l=>l===PAD)&&hl.length===2+h.layout.below,'no lines kept under hanging letters');
  eq(h.check.count,255,'count with hanging letters');none(textProblems(h.text).concat(fitProblems(h,P,HELV,h.opts)),1);
  // The caption counts toward the limit, so it can cost a size.
  const long='a caption of sixty characters, which the letters must pay for',free=Z.banner('hello',{},HELV,P),paid=Z.banner('hello',{caption:long},HELV,P);
  ok(paid.fits&&within(paid.text,P),'does not fit with a long caption');ok(paid.result.size<free.result.size,'a long caption did not cost a size');
  // On the command line a caption is one line whatever was typed.
  const c=cli(['text','zalgoart','--caption','  Intro '+NL+' ducing'+S(9)+' now ']);
  eq(c.status,0,'exit code');eq(c.stdout.split(NL)[0],'Intro ducing now','caption with line breaks and tabs');
  eq(cli(['text','zalgoart','--caption','   ']).stdout,cli(['text','zalgoart']).stdout,'a blank caption');
});
test('text: letters without a shape are left out and listed, accents and case are dropped',()=>{
  const P=Z.platform('xpremium'),e=S(0xe9),r=Z.banner('h'+e+'llo ~w'+S(0x1f600),{},HELV,P);
  eq(r.result.skipped.join(' '),'~ '+S(0x1f600),'skipped');
  eq(r.text,Z.banner('HELLO W',{},HELV,P).text,'text');
  eq(Z.banner(e,{},HELV,P).text,Z.banner('e',{},HELV,P).text,'e with an acute accent');
  eq(Z.banner(S(0xc5,0xf1,0xfc),{},HELV,P).text,Z.banner('ANU',{},HELV,P).text,'ring, tilde and umlaut');
  eq(Z.banner('zalgo art',{},HELV,P).text,Z.banner('  ZALGO'+NL+S(9)+'ART ',{},HELV,P).text,'case and white space');
  eq(Z.banner('hi',{},HELV,P).result.skipped.length,0,'nothing skipped in plain letters');
  // Each one is listed once.
  eq(Z.banner('~a~b~',{},HELV,P).result.skipped.join(),'~','repeats');
  none(textProblems(r.text),1);
});
test('text: nothing to draw gives an empty result, not an error',()=>{
  const P=Z.platform('x');
  for(const [t,o,why] of [['',{},'empty'],[null,{},'null'],[undefined,{},'undefined'],['   '+NL,{},'white space'],['~~~',{},'no shapes'],[S(0x65e5,0x672c),{},'CJK'],
    ['hello',{rows:2},'two rows of one word'],['~~ hi',{rows:2},'two rows with one drawable word'],['hi',{size:9},'a size that does not exist']]){
    const r=Z.banner(t,o,HELV,P);
    eq(r.result,null,why+': result');eq(r.text,'',why+': text');eq(r.line,'',why+': line');ok(!r.fits,why+': fits');eq(r.check.count,0,why+': count');
  }
  ok(Z.banner('~~ hi',{},HELV,P).result,'one drawable word on automatic rows');
});
test('text: the legend lists the marks the letters are made of, lightest first',()=>{
  const P=Z.platform('xpremium');let n=0;
  for(const M of [HELV,ARIAL])for(const [words,o] of [['I',{size:3}],['T',{size:3}],['Introducing ZalgoArt',{}],['I I',{size:3,rows:2}],['gm',{}]]){
    const r=Z.banner(words,o,M,P),cols=readColumns(r.line,M),tag=M.font+' "'+words+'"';n++;
    for(const [side,pal] of [['up',r.result.pal.up],['dn',r.result.pal.dn]]){
      const inText=[...new Set(cols.flatMap(c=>c[side]))].sort((a,b)=>a-b).join(),listed=pal.map(m=>m.cp).sort((a,b)=>a-b).join();
      eq(listed,inText,tag+' '+side+': marks listed against marks in the text');
      for(let i=1;i<pal.length;i++)ok(pal[i].ink>=pal[i-1].ink,tag+' '+side+' is not lightest first');
      if(pal.length)eq(pal[pal.length-1].cp,side==='up'?DARK_UP:DARK_DN,tag+' '+side+': darkest');
    }
  }
  const one=Z.banner('I',{size:3},HELV,P).result.pal;
  eq(one.up.length,1,'a solid letter uses one mark');eq(one.dn.length,0,'one row uses no marks below');
  return n+' legends';
});
test('check: over 280 an X Premium post warns that the feed cuts it, and still passes',()=>{
  const P=Z.platform('xpremium'),X=Z.platform('x'),row='a'.repeat(39)+NL;
  eq(FOLD_X.level,'warn','level');eq(FOLD_X.chars,280,'characters');
  const over=Z.check(row.repeat(7)+'b',P,HELV),at=Z.check(row.repeat(6)+'a'.repeat(40),P,HELV);
  eq(over.count,281,'281');eq(at.count,280,'280');
  eq(said(over,FOLD_X.msg).map(i=>i.level).join(),'warn','281 characters');ok(over.ok,'a warning failed the check');
  eq(said(at,FOLD_X.msg).length,0,'280 characters');
  // Marks count too: it is the counted length that folds, not what the eye sees.
  const big=Z.banner('Introducing ZalgoArt',{},HELV,P),small=Z.banner('gm',{size:4,hang:false},HELV,P);
  eq(said(big.check,FOLD_X.msg).map(i=>i.level).join(),'warn','1,101 characters of lettering');ok(big.check.ok&&big.fits,'the long lettering must still pass');
  eq(warns(big.check).length,1,'the fold should be the only warning');
  eq(small.check.count,148,'gm');eq(warns(small.check).length,0,'148 characters of lettering');
  // The standard post has no fold: 280 is its limit.
  ok(!X.fold,'x has a fold');eq(said(Z.check('a'.repeat(281),X,HELV),FOLD_X.msg).length,0,'x');
  const c=cli(['text','Introducing','ZalgoArt','-p','xpremium']);
  eq(c.status,0,'exit code');ok(c.stderr.includes('[warn] '+FOLD_X.msg.slice(0,40)),'the CLI does not show the warning');
  const j=JSON.parse(cli(['text','Introducing','ZalgoArt','-p','xpremium','--json']).stdout);
  ok(j.ok&&j.check.some(i=>i.level==='warn'&&i.msg===FOLD_X.msg),'--json');
});
test('check: every other fold is a note, at its own number of lines',()=>{
  const folds=Z.PLATFORMS.filter(P=>P.fold);
  eq(folds.map(P=>P.id).join(),'xpremium,bluesky,instagram,youtube','platforms with a fold');
  eq(folds.filter(P=>P.fold.level==='warn').map(P=>P.id).join(),'xpremium','folds that warn');
  // By hand from the platform table: lines shown before the fold.
  for(const [id,lines] of [['bluesky',24],['instagram',2],['youtube',4]]){
    const P=Z.platform(id),text=n=>Array(n).fill('a').join(NL),over=Z.check(text(lines+1),P,HELV),at=Z.check(text(lines),P,HELV);
    eq(P.fold.lines,lines,id+' lines');ok(!P.fold.chars,id+' folds by characters');
    eq(said(over,P.fold.msg).map(i=>i.level).join(),'note',id+' at '+(lines+1)+' lines');ok(over.ok,id+': a note failed the check');
    eq(warns(over).length,0,id+': a note must not warn');
    eq(said(at,P.fold.msg).length,0,id+' at '+lines+' lines');
  }
});

/* ---------- the CLI: text ---------- */
test('cli: text from arguments and from a pipe',()=>{
  const X=Z.platform('x'),want=Z.banner('gm',{},HELV,X).text;
  const a=cli(['text','gm']);
  eq(a.status,0,'exit code');eq(a.stdout,want,'text');ok(!a.stdout.endsWith(NL),'a line break was added on a pipe');
  for(const w of ['X (280): 251 of 280','22 columns','size 5 (automatic), 1 row (automatic) hanging below the line','letters 7 high','base low','[ok]'])ok(a.stderr.includes(w),'summary lacks "'+w+'"');
  ok(!a.stderr.includes(ESC),'colour codes on a pipe');
  // Words can be one argument or several, and come from a pipe when there are none.
  const two=Z.banner('zalgo art',{},HELV,X).text;
  eq(cli(['text','zalgo art']).stdout,two,'one quoted argument');eq(cli(['text','zalgo','art']).stdout,two,'two arguments');
  eq(cli(['text'],{input:'zalgo art'+NL}).stdout,two,'piped, with the line break echo adds');
  eq(cli(['text'],{input:'zalgo'+NL+'art'}).stdout,two,'piped on two lines');
  eq(cli(['text','gm'],{input:'ignored'}).stdout,want,'arguments win over the pipe');
  // Options.
  eq(cli(['text','gm','--size','5','--rows','1']).stdout,want,'--size 5 --rows 1');
  eq(cli(['text','gm','--size','auto','--rows','auto','--side','auto']).stdout,want,'--size auto --rows auto --side auto');
  eq(cli(['text','gm','--size','2']).stdout,Z.banner('gm',{size:2},HELV,X).text,'--size 2');
  eq(cli(['text','zalgo','art','--rows','1','--size','1']).stdout,Z.banner('zalgo art',{size:1,rows:1},HELV,X).text,'--rows 1');
  for(const id of ['xpremium','discord','slack','bluesky']){
    const P=Z.platform(id),r=cli(['text','zalgo','art','-p',id]);
    eq(r.status,0,id+' exit code');eq(r.stdout,Z.banner('zalgo art',{},HELV,P).text,id+' text');ok(within(r.stdout,P),id+' is over the limit when counted again');
    none(textProblems(r.stdout).map(m=>id+': '+m),1);
  }
  eq(cli(['text','gm','--font','arial']).stdout,Z.banner('gm',{},ARIAL,X).text,'--font arial');
  eq(cli(['text','gm','--base','blank','--no-room','--pad','dot','--no-phone','--dense']).stdout,Z.banner('gm',{base:'blank',room:false,pad:'dot',phone:false,dense:true},HELV,X).text,'--base, --no-room, --pad, --no-phone, --dense');
  eq(cli(['text','ab','cd','-p','xpremium','--size','6','--rows','2','--dense']).stdout,Z.banner('ab cd',{size:6,rows:2,dense:true},HELV,Z.platform('xpremium')).text,'--dense with tall letters');
  // Letters with no shape are named.
  const s=cli(['text','a~b']);
  eq(s.status,0,'exit code with a skipped letter');ok(s.stderr.includes('Left out')&&s.stderr.includes('~'),'no word about the letter left out');
  // A size that was asked for and is too big says so and points at the way out.
  const big=cli(['text','hello','world','--size','6']);
  eq(big.status,1,'exit code for a size that is too long');ok(big.stderr.includes('Size 6 does not fit')&&big.stderr.includes('--size'),'no advice: '+big.stderr.split(NL)[4]);
  // An option of another command is ignored with a note.
  const other=cli(['text','gm','--cols','3']);
  eq(other.status,0,'--cols exit code');eq(other.stdout,want,'--cols text');ok(other.stderr.includes('--cols')&&other.stderr.includes('ignored'),'no note about --cols');
});
test('cli: text --json and -o',()=>{
  const P=Z.platform('discord'),e=S(0xe9),words='h'+e+'llo ~w',r=Z.banner(words,{},HELV,P),i=Z.inspect(r.text,HELV,P);
  const c=cli(['text',words,'-p','discord','--json']),j=JSON.parse(c.stdout);
  eq(c.status,0,'exit code');eq(c.stderr,'','--json wrote a summary as well');
  eq(j.command,'text','command');eq(j.text,r.text,'text');eq(j.platform.id,'discord','platform');eq(j.count,Z.count[P.unit](r.text),'count');
  for(const u of UNITS)eq(j.counts[u],Z.count[u](r.text),'counts.'+u);
  eq(j.ok,true,'ok');eq(j.fits,true,'fits');ok(Array.isArray(j.check)&&j.check.every(k=>k.level&&k.msg),'check');
  eq(JSON.stringify(j.skipped),'["~"]','skipped');
  eq(j.size.columns,r.result.cols,'size.columns');eq(j.size.tallest,i.tallest,'size.tallest');eq(j.size.lines,r.text.split(NL).length,'size.lines');
  eq(j.size.reservedAbove+j.size.reservedBelow+1,j.size.lines,'reserved lines');
  // The height above the line is checked against a fresh measurement in a test of its own, below.
  ok(Math.abs(j.size.width-i.width)<1e-9&&Math.abs(j.size.down-i.dn)<1e-9,'size in em');eq(j.size.up,r.result.up,'size.up');
  eq(j.options.size,r.result.size,'options.size');eq(j.options.sizeAutomatic,true,'options.sizeAutomatic');
  eq(j.options.rows,r.result.rows,'options.rows');eq(j.options.rowsAutomatic,true,'options.rowsAutomatic');
  eq(j.options.platform,'discord','options.platform');eq(j.options.font,'Helvetica','options.font');eq(j.options.caption,'','options.caption');eq(j.options.base,'blank','options.base');
  const f=JSON.parse(cli(['text','zalgoart','--size','2','--rows','1','--caption',' Introducing ','--json']).stdout);
  eq(f.options.size,2,'fixed size');eq(f.options.sizeAutomatic,false,'sizeAutomatic with --size');eq(f.options.rowsAutomatic,false,'rowsAutomatic with --rows');
  eq(f.options.caption,'Introducing','options.caption');eq(f.count,255,'count with a caption');eq(f.text.split(NL)[0],'Introducing','caption in the text');
  // Too long: the JSON says so and the exit code agrees.
  const long=cli(['text','Introducing','ZalgoArt','--json']),lj=JSON.parse(long.stdout);
  eq(long.status,1,'exit code when too long');eq(lj.ok,false,'ok when too long');eq(lj.fits,false,'fits when too long');eq(lj.count,289,'count when too long');
  // -o writes the same bytes a pipe gets, and nothing to standard output.
  const out=tmp('letters.txt'),piped=cli(['text','zalgoart','--caption','Introducing']),w=cli(['text','zalgoart','--caption','Introducing','-o',out]);
  eq(w.status,0,'-o exit code');eq(w.stdout,'','-o also printed the text');
  ok(Buffer.from(piped.stdout,'utf8').equals(fs.readFileSync(out)),'the file differs from the piped text');
  ok(w.stderr.includes('Wrote')&&w.stderr.includes(String(fs.statSync(out).size)+' bytes'),'no word about the file written');
  // The files in examples/ are what the commands in the summary make.
  for(const [file,args] of [['introducing-zalgoart.x.txt',['text','zalgoart','--caption','Introducing']],['introducing-zalgoart.x-two-rows.txt',['text','zalgo art','--caption','Introducing']],['introducing-zalgoart.x-premium.txt',['text','Introducing ZalgoArt','-p','xpremium']]]){
    const saved=path.join(ROOT,'examples',file);
    if(fs.existsSync(saved))eq(fs.readFileSync(saved,'utf8'),cli(args).stdout,'examples/'+file+' is stale');
  }
});
test('cli: text with bad arguments exits 2 with one helpful line',()=>{
  const bad=[
    [['text','hi','--size','9'],'from 1 to 6'],[['text','hi','--size','0'],'from 1 to 6'],[['text','hi','--size','abc'],'whole number'],[['text','hi','--size'],'needs a value'],
    [['text','hi','--rows','3'],'from 1 to 2'],[['text','hi','--side','sideways'],'above, below, auto'],[['text','hi','--side'],'needs a value'],[['text','hi','--rows','2'],'at least two words'],
    [['text'],'needs letters'],[['text','~~~'],'can be drawn'],[['text','hi','--caption'],'needs a value'],
    [['text','hi','-p','nope'],'unknown platform'],[['text','hi','--base','zzz'],'must be one of'],[['text','hi','--pad','x'],'blank, dot'],
    [['text','hi','--font','comic'],'unknown font'],[['text','hi','--bogus'],'unknown option --bogus'],[['text','hi','--sise','2'],'did you mean --size'],
    [['text','hi','-o',path.join(TMP,'no','such','dir.txt')],'cannot write'],[['tex','hi'],'did you mean text']
  ];
  for(const [args,want] of bad){const msg=usageError(args);ok(msg.includes(want),'zalgo '+args.join(' ')+' should mention "'+want+'": '+msg.trim());}
  // Only white space on the pipe is no words either.
  ok(usageError(['text'],{input:'  '+NL}).includes('needs letters'),'a blank pipe');
  return bad.length+' bad commands';
});
/* On a platform whose columns stand on a blank, the first column stands on a full stop (see assemble), which
   is a little taller. When that column is the tallest, the height reported must be the full stop's. */
test('text: the height reported is the height of the text, when the first column is the tallest too',()=>{
  const P=Z.platform('discord');
  for(const words of ['gm','hello w']){
    const r=Z.banner(words,{},HELV,P),i=Z.inspect(r.line,HELV,P);
    ok(Math.abs(r.result.up-i.up)<1e-9,'"'+words+'" reports '+r.result.up.toFixed(3)+' em up, the line measures '+i.up.toFixed(3));
    ok(Math.abs(r.result.dn-i.dn)<1e-9&&Math.abs(r.result.width-i.width)<1e-9,'"'+words+'": width or depth');
  }
});
// "~~ hi" has two words and one that can be drawn. The line must say what is wrong, not that nothing can be drawn.
test('cli: text --rows 2 with only one drawable word says two words are needed',()=>{
  const msg=usageError(['text','~~','hi','--rows','2']);
  ok(msg.includes('at least two words'),'zalgo text ~~ hi --rows 2: '+msg.trim());
});
test('cli: help lists the text command, its options and examples',()=>{
  for(const args of [[],['help'],['text','--help'],['text','-h']]){
    const r=cli(args);eq(r.status,0,'zalgo '+args.join(' ')+' exit code');
    for(const w of ['zalgo text <words...>','--size <n|auto>','--rows <1|2|auto>','--side above|below|auto','--caption <text>','zalgo text "zalgo art" -p xpremium','zalgo text zalgoart --caption Introducing'])
      ok(r.stdout.includes(w),'zalgo '+args.join(' ')+' does not mention: '+w);
  }
});

/* ---------- golden parity: the page's pipeline in Chrome gives the CLI's text ---------- */
// The same hash runs in the page and here, so whole canvases can be compared without shipping the pixels.
const HASH='d=>{let h=0x811c9dc5;for(let i=0;i<d.length;i++)h=Math.imul(h^d[i],16777619);return h>>>0;}',hash=eval(HASH);
function parity(){
  // An opaque picture with shading, bigger than 220 pixels, saved with every row filter in turn.
  const main=image(300,260,[250,248,240,255],(x,y)=>disc(110,130,90,(a,b)=>[20+(a>>1),60,200-(b>>1),255])(x,y)||(y>40&&y<230&&Math.abs(x-220)<(y-40)*.35?[200,90+(y>>2),30,255]:null));
  const rnd=random(42),r=(type,depth,w,h,more)=>{
    const o=randomPng(rnd,type,depth,w,h,Object.assign({filters:[0,1,2,3,4]},more||{}));
    // Opaque only: a canvas premultiplies alpha, so see-through pixels do not come back as they went in.
    if(type===4||type===6)for(let p=0;p<w*h;p++)o.samples[p*CH[type]+CH[type]-1]=2**depth-1;
    return enc.encode(o);
  };
  const turn=Buffer.from([0x4d,0x4d,0,0x2a,0,0,0,8,0,1,0x01,0x12,0,3,0,0,0,1,0,6,0,0,0,0,0,0]);
  const files={main:enc.rgb(main),grey1:r(0,1,23,17),grey2:r(0,2,23,17),grey4:r(0,4,23,17),grey8:r(0,8,23,17),grey16:r(0,16,23,17),rgb16:r(2,16,23,17),
    palette1:r(3,1,23,17,{palette:PALETTE.slice(0,2)}),palette4:r(3,4,23,17,{palette:PALETTE.slice(0,16)}),palette8:r(3,8,23,17,{palette:PALETTE}),
    greyAlpha8:r(4,8,23,17),rgba8:r(6,8,23,17),rgba16:r(6,16,23,17),interlacedRgb:r(2,8,37,29,{interlace:1}),interlacedGrey2:r(0,2,37,29,{interlace:1}),
    interlacedPalette:r(3,4,9,9,{interlace:1,palette:PALETTE.slice(0,16)}),turned:r(2,8,13,7,{chunks:[['eXIf',turn]]})};
  const urls={};for(const k in files)urls[k]='data:image/png;base64,'+files[k].toString('base64');
  // Everything happens in img.onload: under a virtual time budget, animation frames do not fire reliably.
  // Text goes back as code point numbers, because the DOM dump rewrites no-break spaces.
  const page=`<script>(function(){
    const out=document.getElementById('out'),urls=${JSON.stringify(urls)},ids=${JSON.stringify(THREE)},res={files:{},text:{}},hash=${HASH};
    const fail=m=>{out.textContent=JSON.stringify({error:String(m)});};
    try{
      res.cal=ZalgoCal.calibrate('Helvetica');
      const M=Zalgo.metrics(res.cal),names=Object.keys(urls);let left=names.length;
      for(const name of names){
        const img=new Image();
        img.onerror=()=>fail('could not load '+name);
        img.onload=()=>{try{
          const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
          const g=c.getContext('2d');g.drawImage(img,0,0);
          const px=g.getImageData(0,0,c.width,c.height);
          res.files[name]={w:c.width,h:c.height,hash:hash(px.data)};
          if(name==='main')for(const id of ids)res.text[id]=Array.from(Zalgo.picture({w:c.width,h:c.height,data:px.data},{},M,Zalgo.platform(id)).text,ch=>ch.codePointAt(0));
          if(--left===0)out.textContent=JSON.stringify(res);
        }catch(e){fail(e&&e.stack||e);}};
        img.src=urls[name];
      }
    }catch(e){fail(e&&e.stack||e);}
  })();</`+`script>`;
  /* On a busy machine Chrome sometimes exits with an error code after it has printed the finished page.
     The page writes its result once, whole, so a result that parses is complete: take it, else try again. */
  let res={error:'Chrome gave no result'};
  for(let attempt=0;attempt<3;attempt++){
    let raw='';
    try{raw=chrome.run(page);}
    catch(e){
      const m=/<pre id="out">([\s\S]*?)<\/pre>/.exec(String(e.stdout||''));
      raw=m?m[1].split('&lt;').join('<').split('&gt;').join('>').split('&amp;').join('&'):'';
      res={error:'Chrome gave no result ('+String(e.message).split(NL)[0].slice(0,120)+')'};
    }
    try{res=JSON.parse(raw);break;}catch(e){}
  }
  if(res.error)res={error:res.error};
  fs.writeFileSync(tmp('main.png'),files.main);
  const need=fn=>()=>{if(res.error)throw new Error(res.error);return fn();};
  test('parity: a fresh Helvetica calibration equals profiles/helvetica.json',need(()=>{
    eq(JSON.stringify(res.cal),JSON.stringify(profile('helvetica')),'profile');
  }));
  test('parity: the PNG decoder gives the pixels Chrome draws',need(()=>{
    for(const name in files){
      const mine=png.decode(files[name],{orient:true}),theirs=res.files[name];
      ok(theirs,'Chrome did not report '+name);
      eq(mine.w+'x'+mine.h,theirs.w+'x'+theirs.h,name+' size');eq(hash(mine.data),theirs.hash,name+' pixels');
    }
    return Object.keys(files).length+' files';
  }));
  for(const id of THREE)test('parity: page text equals CLI text on '+id,need(()=>{
    const r=cli(['image',tmp('main.png'),'-p',id,'--font','helvetica']),page=S(...res.text[id]);
    eq(r.status,0,'exit code');ok(page.length>50,'the page made almost nothing');
    eq(r.stdout,page,'text');
    return page.length+' units, '+Z.count[Z.platform(id).unit](page)+' of '+Z.platform(id).limit;
  }));
}
/* ---- the repository: what is committed is what the sources make ---- */
test('repo: bin/zalgo can be run as a command',()=>{
  fs.accessSync(CLI,fs.constants.X_OK);
  ok(fs.readFileSync(CLI,'utf8').startsWith('#!/usr/bin/env node'+NL),'no node line at the top');
  const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
  eq(path.join(ROOT,pkg.bin.zalgo),CLI,'package.json bin');
});
test('repo: the README holds the lettering in examples/, and every file it points to exists',()=>{
  const readme=fs.readFileSync(path.join(ROOT,'README.md'),'utf8'),R=require(path.join(ROOT,'tools','readme.js'));
  ok(readme.includes(R.block()),'the lettering in README.md is stale: run node tools/readme.js');
  // The block is the saved text and nothing else: lines joined by <br> inside one paragraph.
  const saved=fs.readFileSync(path.join(ROOT,'examples','introducing-zalgoart.x-premium.txt'),'utf8');
  const inner=/<p align="center">([^]*?)<\/p>/.exec(readme.slice(readme.indexOf(R.START)))[1];
  eq(inner.split('<br>').join(NL),saved,'lettering');
  eq(saved,cli(['text','Introducing ZalgoArt','-p','xpremium']).stdout,'the command the README names');
  const missing=[];
  for(const m of readme.matchAll(/(?:src|srcset|href)="([^"#:]+)"|\]\(([^)#:]+)\)/g)){const f=m[1]||m[2];if(!fs.existsSync(path.join(ROOT,f)))missing.push(f);}
  none(missing,5);
});
test('repo: docs/ is what build.sh makes, file for file',()=>{
  const out=tmp('docs'),docs=path.join(ROOT,'docs'),r=spawnSync('bash',[path.join(ROOT,'build.sh'),out],{encoding:'utf8'});
  eq(r.status,0,'build.sh exit code '+r.stderr);
  const walk=(dir,rel)=>fs.readdirSync(path.join(dir,rel),{withFileTypes:true}).flatMap(e=>e.name.startsWith('.')?[]:e.isDirectory()?walk(dir,path.join(rel,e.name)):[path.join(rel,e.name)]);
  const made=walk(out,''),stale=[];
  ok(made.length>=20,'the build made only '+made.length+' files');
  for(const f of made){
    const have=path.join(docs,f);
    if(!fs.existsSync(have))stale.push('docs/'+f+' is missing: run ./build.sh');
    else if(!fs.readFileSync(have).equals(fs.readFileSync(path.join(out,f))))stale.push('docs/'+f+' is stale: run ./build.sh');
  }
  // Nothing is served that the build did not make, apart from the picture for link previews and the demo clips.
  const kept=new Set(SITE.KEPT.concat('vercel.json'));
  for(const f of walk(docs,''))if(!made.includes(f)&&!kept.has(f))stale.push('docs/'+f+' is not made by the build');
  none(stale,made.length);
  for(const f of SITE.KEPT)ok(fs.existsSync(path.join(docs,f)),'docs/'+f+' is missing');
  ok(fs.existsSync(path.join(docs,'.nojekyll')),'docs/.nojekyll is missing');
  const og=fs.readFileSync(path.join(docs,'og.png'));
  eq(og.readUInt32BE(16)+'x'+og.readUInt32BE(20),'1200x630','the size of docs/og.png, which every page gives as its preview');
  // The checks on addresses assume the host adds the slash and hides .html. This is where it is told to.
  const host=JSON.parse(fs.readFileSync(path.join(docs,'vercel.json'),'utf8'));
  ok(host.cleanUrls===true&&host.trailingSlash===true,'docs/vercel.json no longer sets cleanUrls and trailingSlash');
  // The same build twice gives the same bytes.
  const a=BUILD.build(),b=BUILD.build();
  ok([...a.keys()].join()===[...b.keys()].join()&&[...a].every(([f,v])=>v.equals(b.get(f))),'two builds differ');
  return made.length+' files';
});
test('repo: the new address is the one given everywhere',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
  eq(pkg.homepage,SITE.ORIGIN+'/','package.json homepage');
  const old=[];
  for(const f of ['README.md','package.json','src/site.html','src/page.html','src/site.css'].concat(fs.readdirSync(path.join(ROOT,'src','pages')).map(n=>'src/pages/'+n)))
    if(/jackulau\.github\.io/i.test(fs.readFileSync(path.join(ROOT,f),'utf8')))old.push(f+' still names the old address');
  none(old,old.length);
});

/* ---- the site: every page the build makes ---- */
const edit=(files,f,fn)=>{
  const was=files.get(f).toString('utf8'),now=fn(was);
  if(now===was)throw new Error('the edit to '+f+' changed nothing, so it tests nothing');
  return new Map(files).set(f,Buffer.from(now));
};
test('site: every page has its own title, description, one h1, a canonical in the sitemap, and links that lead somewhere',()=>{
  const files=BUILD.build(),pages=[...files.keys()].filter(f=>f.endsWith('.html'));
  none(SITE.problems(files),pages.length);
  eq(pages.length,11,'pages');
  eq((files.get('sitemap.xml').toString().match(/<loc>/g)||[]).length,10,'addresses in the sitemap');
  return pages.length+' pages';
});
test('site: the figures in the copy are the ones in the core, and none is typed by hand',()=>{
  const files=BUILD.build(),guide=files.get('character-limits/index.html').toString('utf8');
  const rows=[...guide.matchAll(/<tr data-platform="([^"]*)">/g)].map(m=>m[1]);
  eq(rows.join(),Z.PLATFORMS.filter(P=>P.id!=='custom').map(P=>P.id).join(),'rows of the limits table');
  // One row read by hand, so the checker is not the only thing vouching for the table.
  const x=/<tr data-platform="x">([\s\S]*?)<\/tr>/.exec(guide)[1].replace(/<[^>]*>/g,'|');
  ok(x.includes('|'+Z.platform('x').name+'|')&&x.includes('|'+Z.platform('x').limit+'|'),'the row for X does not show '+Z.platform('x').limit);
  // The guide says in words that a combining mark is one unit, one code point and two bytes.
  for(let c=0x300;c<=0x36f;c++){const m=S(c);ok(m.length===1&&Array.from(m).length===1&&Buffer.byteLength(m)===2,'U+'+c.toString(16)+' is not one unit, one code point and two bytes');}
  let tagged=0;for(const [f,v] of files)if(f.endsWith('.html'))tagged+=(v.toString('utf8').match(/<span data-(?:limit|n|ui)="/g)||[]).length;
  ok(tagged>=15,'only '+tagged+' tagged figures: the copy has stopped taking its numbers from the sources');
  return rows.length+' platforms, '+tagged+' tagged figures';
});
test('site: each kind of mistake is caught',()=>{
  const files=BUILD.build(),P='privacy/index.html',C='cli/index.html',L='character-limits/index.html',H='index.html';
  const titleOf=f=>/<title>[^<]*<\/title>/.exec(files.get(f).toString('utf8'))[0],descOf=f=>/<meta name="description" content="[^"]*">/.exec(files.get(f).toString('utf8'))[0];
  const without=f=>{const m=new Map(files);m.delete(f);return m;};
  const cases=[
    ['a canonical that is not the sitemap address',edit(files,C,s=>s.replace('<link rel="canonical" href="https://zalgoart.com/cli/">','<link rel="canonical" href="https://zalgoart.com/cli">')),/^cli\/index\.html: the canonical is https:\/\/zalgoart\.com\/cli,/],
    ['a canonical on another page',edit(files,C,s=>s.replace('<link rel="canonical" href="https://zalgoart.com/cli/">','<link rel="canonical" href="https://zalgoart.com/draw/">')),/^cli\/index\.html: the canonical is/],
    ['a sitemap address with no file',edit(files,'sitemap.xml',s=>s.replace('</urlset>','<url><loc>https://zalgoart.com/nope/</loc></url></urlset>')),/^sitemap\.xml: https:\/\/zalgoart\.com\/nope\/ has no file/],
    ['a sitemap address that would redirect',edit(files,'sitemap.xml',s=>s.replace('<loc>https://zalgoart.com/cli/</loc>','<loc>https://zalgoart.com/cli/index.html</loc>')),/^sitemap\.xml: .*would redirect/],
    ['a page left out of the sitemap',edit(files,'sitemap.xml',s=>s.replace(/<url><loc>https:\/\/zalgoart\.com\/draw\/<\/loc>[\s\S]*?<\/url>\s*/,'')),/^draw\/index\.html: not in the sitemap/],
    ['a page that is gone',without('draw/index.html'),/^sitemap\.xml: https:\/\/zalgoart\.com\/draw\/ has no file/],
    ['no h1',edit(files,P,s=>s.replace(/<h1([^>]*)>([\s\S]*?)<\/h1>/,'<h2$1>$2</h2>')),/^privacy\/index\.html: 0 h1 headings/],
    ['two h1s',edit(files,P,s=>s.replace('</article>','<h1>Again</h1></article>')),/^privacy\/index\.html: 2 h1 headings/],
    ['a title used twice',edit(files,C,s=>s.replace(titleOf(C),titleOf(P))),/the same title as/],
    ['a title that is too long',edit(files,C,s=>s.replace(titleOf(C),'<title>'+'Zalgo '.repeat(11)+'</title>')),/^cli\/index\.html: the title is 66 characters/],
    ['a description used twice',edit(files,C,s=>s.replace(descOf(C),descOf(P))),/the same description as/],
    ['a link to a page that does not exist',edit(files,P,s=>s.replace('href="../cli/"','href="../command-line/"')),/^privacy\/index\.html: the link \.\.\/command-line\/ leads to no file/],
    ['a link that only works at the root of a domain',edit(files,P,s=>s.replace('href="../cli/"','href="/cli/"')),/^privacy\/index\.html: the link \/cli\/ starts at the root/],
    ['a link with no trailing slash',edit(files,P,s=>s.replace('href="../cli/"','href="../cli"')),/^privacy\/index\.html: the link \.\.\/cli has no trailing slash/],
    ['a limit in the table that is not the one in the core',edit(files,L,s=>s.replace(/(<tr data-platform="x">[\s\S]*?<td class="n">)280/,'$1300')),/^character-limits\/index\.html: the row for x reads "300", the core says "280"/],
    ['a platform missing from the table',edit(files,L,s=>s.replace(/<tr data-platform="slack">[\s\S]*?<\/tr>/,'')),/the limits table does not list the platforms of the core/],
    ['a note that is not the one in the core',edit(files,L,s=>s.replace(/(<dd data-note="reddit">[^<]*?)40,000/,'$150,000')),/^character-limits\/index\.html: the note for reddit is not the note in the core/],
    ['a quoted warning that is not the one in the core',edit(files,'what-is-zalgo-text/index.html',s=>s.replace(/(<span data-flat="x">[^<]*?)Firefox/,'$1every browser')),/the warning for x is not the warning in the core/],
    ['a quoted note that is not the one in the core',edit(files,'what-is-zalgo-text/index.html',s=>s.replace(/(<span data-note="telegram">[^<]*?)at most 2/,'$1at most 5')),/the note for telegram is not the note in the core/],
    ['a tagged figure that differs from its source',edit(files,'what-is-zalgo-text/index.html',s=>s.replace(/(<span data-n="stack">)[^<]*/,'$199')),/the number stack reads 99, the source says 30/],
    ['a figure typed by hand',edit(files,P,s=>s.replace('</article>','<p>It holds up to 5000 marks.</p></article>')),/^privacy\/index\.html: the figure 5000 in the copy is typed by hand/],
    ['a figure typed into a description',edit(files,C,s=>s.replace(descOf(C),descOf(C).replace('Install','Install in 30 seconds'))),/^cli\/index\.html: the figure 30 in the description is typed by hand/],
    ['a question in the data that the page does not show',edit(files,H,s=>s.replace(/("@type":"Question","name":")/,'$1Is it the best? ')),/^index\.html: the FAQ data has/],
    ['a question on the page that the data lacks',edit(files,H,s=>s.replace(/(<h2 data-faq[\s\S]*?<h3[^>]*>)/,'$1Really? ')),/^index\.html: the FAQ data has|^index\.html: the page shows questions/],
    ['a rating in the data',edit(files,H,s=>s.replace('"@type":"WebApplication"','"@type":"WebApplication","aggregateRating":{"@type":"AggregateRating","ratingValue":"5","reviewCount":"1"}')),/^index\.html: JSON-LD holds a rating/],
    ['a price that is not zero',edit(files,H,s=>s.replace('"price":"0"','"price":"5"')),/^index\.html: WebApplication is not offered at price 0/],
    ['a script from another site',edit(files,P,s=>s.replace('</article>','</article><script src="https://example.com/a.js"></'+'script>')),/^privacy\/index\.html: loads https:\/\/example\.com\/a\.js from another site/],
    ['a font from another site',edit(files,P,s=>s.replace('<style>','<style>@import url(https://example.com/a.css);')),/^privacy\/index\.html: a stylesheet loads from another site/],
    // With a publisher id in site.config.json, one script from Google is allowed, and only as the privacy page describes it.
    ...(SITE.ADS?[
      ['an advertising script the privacy page does not name',edit(files,P,s=>s.replace('<code>'+SITE.ADS_HOST+'</code>','Google')),/^privacy\/index\.html: pages load a script from pagead2\.googlesyndication\.com, which the privacy page does not name/],
      ['an advertising script for another publisher',edit(files,C,s=>s.replace(SITE.ADS,'ca-pub-0000000000000000')),/^cli\/index\.html: loads https:\/\/pagead2\.googlesyndication\.com\S* from another site/],
      ['the advertising script twice on a page',edit(files,C,s=>s.replace(SITE.ADS_TAG,SITE.ADS_TAG+SITE.ADS_TAG)),/^cli\/index\.html: the advertising script is there 2 times/],
      ['a page without the advertising script',edit(files,C,s=>s.replace(SITE.ADS_TAG,'')),/^cli\/index\.html: the advertising script is there 0 times/],
      ['the advertising script on the error page',edit(files,'404.html',s=>s.replace('<style>',SITE.ADS_TAG+'<style>')),/^404\.html: the advertising script is there 1 times/],
      ['an ads.txt for another publisher',edit(files,'ads.txt',s=>s.replace(/pub-[0-9]+/,'pub-0000000000000000')),/^ads\.txt: does not name Google as the direct seller/],
    ]:[]),
    ['an error page that asks to be indexed',edit(files,'404.html',s=>s.replace('<meta name="robots" content="noindex">','')),/^404\.html: the error page does not say noindex/],
    ['an error page with relative links',edit(files,'404.html',s=>s.replace('href="https://zalgoart.com/cli/"','href="cli/"')),/^404\.html: the relative link cli\//],
    ['a robots.txt that shuts crawlers out',edit(files,'robots.txt',s=>s.replace('Allow: /','Disallow: /')),/^robots\.txt: does not allow everything/],
    ['a robots.txt with no sitemap',edit(files,'robots.txt',s=>s.replace(/^Sitemap:.*$/m,'')),/^robots\.txt: does not name/],
    ['an old-address redirect that goes to the wrong place',edit(files,P,s=>s.replace("replace(/^\\/ZalgoArt(?=\\/|$)/i,'')","replace(/^\\/Zalgo(?=\\/|$)/i,'')")),/^privacy\/index\.html: the old address goes to/],
    ['a redirect that fires on the new address',edit(files,P,s=>s.replace("if(location.hostname==='jackulau.github.io')","if(location.hostname!=='jackulau.github.io')")),/^privacy\/index\.html: the (old address goes to|redirect fires)/],
  ];
  const missed=[];
  for(const [name,broken,want] of cases){
    const found=SITE.problems(broken);
    if(!found.some(m=>want.test(m)))missed.push(name+' was not caught'+(found.length?' (it said: '+found[0]+')':''));
  }
  none(missed,cases.length);
  return cases.length+' mistakes';
});
const TOOLS={'index.html':'image','zalgo-text-generator/index.html':'glitch','image-to-zalgo/index.html':'image','zalgo-text-art/index.html':'text','draw/index.html':'draw'};
// What the pages' own code does that the privacy page has to say: one line for each thing the two disagree on.
function privacyGaps(files){
  const privacy=files.get('privacy/index.html').toString('utf8'),says=/paste a picture/.test(privacy),found=[];
  let pastes=0;
  for(const [f,v] of files){
    if(!f.endsWith('.html'))continue;
    const code=[...v.toString('utf8').matchAll(/<script\b(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join(NL);
    for(const m of code.matchAll(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|document\.cookie|sessionStorage|indexedDB|clipboard\.read\w*|clipboardData\.getData|\.src\s*=\s*["'`]https?:/g))found.push(f+' uses '+m[0]);
    // A paste is the one time the page takes anything from the clipboard, and only a picture file out of it.
    if(/clipboardData/.test(code)){pastes++;if(!says)found.push(f+' takes a pasted picture, which the privacy page does not say');}
    const keys=new Set([...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*'([^']*)'/g)].filter(m=>new RegExp('localStorage\\.\\w+\\('+m[1]+'\\b').test(code)).map(m=>m[2]));
    for(const k of keys)if(!privacy.includes('<code>'+k+'</code>'))found.push(f+' stores '+k+', which the privacy page does not name');
    if(/localStorage\.\w+\(\s*["'`]/.test(code))found.push(f+' stores something under a name written in place');
    if(TOOLS[f]&&!keys.size)found.push(f+' no longer stores the drawing, which the privacy page says it does');
  }
  if(says&&!pastes)found.push('privacy/index.html says a pasted picture is used, which no page does');
  if(!privacy.includes('<code>zalgoart.pad.1</code>'))found.push('privacy/index.html no longer names what is stored');
  return found;
}
test('site: the privacy page says what the code does',()=>{
  // The page promises that the site's own code sends nothing, stores one thing, writes to the clipboard on Copy and
  // takes a picture from it only when one is pasted. Any of these changing in the page's code means the privacy page
  // has to change with it. The one script from another site, Google's advertising script, is held to the privacy
  // page by the checks in test/site.js.
  const files=BUILD.build(),P='privacy/index.html',H='index.html';
  none(privacyGaps(files),files.size);
  const cases=[
    ['paste that the privacy page does not mention',edit(files,P,s=>s.replace(/If you paste a picture[^<]*/,'It never reads from the clipboard.')),/takes a pasted picture, which the privacy page does not say/],
    ['a privacy page that speaks of a paste no page takes',new Map([...files].map(([f,v])=>[f,f.endsWith('.html')&&f!==P?Buffer.from(v.toString('utf8').split('clipboardData').join('pasted')):v])),/says a pasted picture is used, which no page does/],
    ['pasted text being read',edit(files,H,s=>s.replace("addEventListener('paste',e=>{","addEventListener('paste',e=>{e.clipboardData.getData('text');")),/index\.html uses clipboardData\.getData/],
    ['the clipboard being read outside a paste',edit(files,H,s=>s.replace("addEventListener('paste',e=>{","navigator.clipboard.readText();addEventListener('paste',e=>{")),/index\.html uses clipboard\.readText/],
    ['a request sent by the page',edit(files,H,s=>s.replace("addEventListener('paste',e=>{","fetch('/log');addEventListener('paste',e=>{")),/index\.html uses fetch\(/],
    ['a stored name the privacy page does not give',edit(files,P,s=>s.replace('<code>zalgoart.pad.1</code>','a saved drawing')),/stores zalgoart\.pad\.1, which the privacy page does not name/],
  ];
  const missed=[];
  for(const [name,broken,want] of cases){
    const found=privacyGaps(broken);
    if(!found.some(m=>want.test(m)))missed.push(name+' was not caught'+(found.length?' (it said: '+found[0]+')':''));
  }
  none(missed,cases.length);
  return cases.length+' mistakes';
});
if(!wanted('site: in Chrome'));
else if(chrome.find())test('site: in Chrome, each tool page opens in its own mode and makes text, and no page scrolls sideways at 390 px',()=>{
  // The pages are opened from disk, each inside a frame of the width under test, because a headless window
  // is never as narrow as a phone. One extra page is too wide on purpose, to show the measurement can fail.
  const files=BUILD.build(),dir=tmp('site'),pages=[...files.keys()].filter(f=>f.endsWith('.html')),WIDE='too-wide/index.html';
  // The copies under test leave out Google's advertising script: a test does not call another company's servers,
  // and a frame would wait on that request before it reported that it had loaded.
  const local=v=>SITE.ADS?v.toString('utf8').split(SITE.ADS_TAG).join(''):v.toString('utf8');
  for(const [f,v] of files){fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.writeFileSync(path.join(dir,f),f.endsWith('.html')?local(v):v);}
  fs.mkdirSync(path.join(dir,'too-wide'));
  fs.writeFileSync(path.join(dir,WIDE),local(files.get('privacy/index.html')).replace('</article>','<div style="width:700px;height:8px"></div></article>'));
  const body=`<script>(function(){
    const out=document.getElementById('out'),base=${JSON.stringify('file://'+dir+'/')},jobs=[],res=[];
    for(const p of ${JSON.stringify(pages.concat(WIDE))})for(const w of [390,1280])jobs.push([p,w]);
    (function next(){
      if(!jobs.length){out.textContent=JSON.stringify(res);return;}
      const job=jobs.shift(),f=document.createElement('iframe');let tries=0;
      f.style.cssText='position:fixed;left:0;top:0;border:0;height:844px;width:'+job[1]+'px';
      const look=()=>{
        const r={page:job[0],width:job[1]};
        try{
          const d=f.contentDocument,win=f.contentWindow,mode=d.getElementById('mode');
          if(mode&&!(win.zalgo&&win.zalgo.ready)&&tries++<200)return setTimeout(look,50);
          r.scroll=d.documentElement.scrollWidth;r.client=d.documentElement.clientWidth;r.h1=d.querySelectorAll('h1').length;
          r.shown=!!d.querySelector('h1')&&d.querySelector('h1').getBoundingClientRect().width>0;
          if(mode){
            r.mode=mode.value;r.ready=!!(win.zalgo&&win.zalgo.ready);r.units=win.zalgo&&win.zalgo.last?win.zalgo.last.text.length:0;
            r.open=[].filter.call(d.querySelectorAll('[id^="src-"]'),e=>!e.hidden).map(e=>e.id.slice(4)).join();
            r.tab=[].filter.call(d.querySelectorAll('[role="tab"][aria-selected="true"],[aria-pressed="true"][data-mode]'),e=>true).map(e=>e.dataset.mode||e.id).join();
          }
        }catch(e){r.error=String(e);}
        res.push(r);f.remove();next();
      };
      f.onload=look;f.src=base+job[0];document.body.appendChild(f);
    })();
  })();</`+`script>`;
  const res=JSON.parse(chrome.run(body,{args:['--allow-file-access-from-files']})||'[]'),wrong=[];
  eq(res.length,(pages.length+1)*2,'pages measured');
  for(const r of res){
    const at=r.page+' at '+r.width+' px';
    if(r.error){wrong.push(at+': '+r.error);continue;}
    if(r.page===WIDE){if(r.width===390&&r.scroll<=r.client)wrong.push('the page made too wide on purpose measured as fitting, so this test cannot fail');continue;}
    if(r.scroll>r.client)wrong.push(at+' scrolls sideways: '+r.scroll+' px of content in '+r.client);
    if(r.h1!==1||!r.shown)wrong.push(at+' shows '+r.h1+' h1 headings');
    const mode=TOOLS[r.page];
    if(!mode){if(r.mode)wrong.push(at+' has the tool, but is not a tool page');continue;}
    if(r.mode!==mode||r.open!==mode)wrong.push(at+' opens in '+r.mode+' with the '+r.open+' panel, expected '+mode);
    if(!r.ready||!r.units)wrong.push(at+' made no text');
  }
  none(wrong,res.length);
  return res.length+' views';
});else skip('site: in Chrome, each tool page opens in its own mode and makes text, and no page scrolls sideways at 390 px','Chrome was not found. Set CHROME=/path/to/chrome to run it');

const REVIEW='site: menus that report only a change event still redraw, and Copied goes when the text changes';
if(!wanted(REVIEW));
else if(chrome.find())test(REVIEW,()=>{
  // A reader's browser sent the Post to menu only a 'change' event. The page kept X's numbers and X's letter,
  // and Draw then offered a row of X's letter as ready for Bluesky. This replays what they did, with no 'input'.
  const files=BUILD.build(),dir=tmp('review');
  const local=v=>SITE.ADS?v.toString('utf8').split(SITE.ADS_TAG).join(''):v.toString('utf8');
  for(const [f,v] of files){fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.writeFileSync(path.join(dir,f),f.endsWith('.html')?local(v):v);}
  const body=`<script>(function(){
    const out=document.getElementById('out'),f=document.createElement('iframe'),res={};let tries=0;
    f.style.cssText='position:fixed;left:0;top:0;border:0;height:844px;width:390px';
    const later=(fn,ms)=>setTimeout(()=>{try{fn();}catch(e){res.error=String(e);out.textContent=JSON.stringify(res);}},ms||300);
    f.onload=function look(){
      const d=f.contentDocument,w=f.contentWindow,$=id=>d.getElementById(id);
      if(!(w.zalgo&&w.zalgo.ready)&&tries++<200)return setTimeout(look,50);
      // Headless Chrome under a virtual time budget does not run animation frames, so a timer stands in for them.
      w.requestAnimationFrame=fn=>w.setTimeout(fn,16);
      const pick=(id,v)=>{$(id).value=v;$(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
      const mode=m=>{$('mode').value=m;$('mode').dispatchEvent(new w.Event('input',{bubbles:true}));};
      pick('platform','x');mode('text');$('ttext').value='Brightline Studio';$('ttext').dispatchEvent(new w.Event('input',{bubbles:true}));
      later(()=>{
        res.x=$('tally').textContent;pick('platform','discord');
        later(()=>{
          res.discord=$('tally').textContent;$('copyBtn').click();
          later(()=>{
            res.copied=$('copyBtn').classList.contains('done');
            $('ttext').value='Brightline Studios';$('ttext').dispatchEvent(new w.Event('input',{bubbles:true}));
            later(()=>{
              res.afterEdit=$('copyBtn').classList.contains('done');pick('platform','custom');
              later(()=>{
                res.limitShown=!$('limit').hidden;res.custom=$('tally').textContent;pick('platform','bluesky');mode('draw');
                later(()=>{
                  res.base=$('base').value;res.draw=w.zalgo.last.text;res.drawTally=$('tally').textContent;
                  out.textContent=JSON.stringify(res);
                },400);
              });
            },100);
          });
        });
      });
    };
    f.src=${JSON.stringify('file://'+dir+'/index.html')};document.body.appendChild(f);
  })();</`+`script>`;
  const r=JSON.parse(chrome.run(body,{args:['--allow-file-access-from-files']})||'{}'),wrong=[];
  if(r.error)wrong.push(r.error);
  if(!/\/ 280$/.test(r.x||''))wrong.push('X tally was '+r.x);
  if(!/\/ 2,000$/.test(r.discord||''))wrong.push('after choosing Discord the tally still read '+r.discord);
  if(!r.copied)wrong.push('Copy text showed no result');
  if(r.afterEdit)wrong.push('Copy text still said Copied after the text changed');
  if(!r.limitShown)wrong.push('Custom limit did not show the limit box');
  if(!/\/ 2,000$/.test(r.custom||''))wrong.push('after choosing Custom limit the tally read '+r.custom);
  if(r.base==='low'||/ˍ/.test(r.draw||''))wrong.push('Draw on Bluesky still stands on X’s letter ('+r.drawTally+')');
  if(!/\/ 300$/.test(r.drawTally||''))wrong.push('Draw on Bluesky tally was '+r.drawTally);
  none(wrong,8);
  return r.discord+', '+r.drawTally;
});else skip(REVIEW,'Chrome was not found. Set CHROME=/path/to/chrome to run it');

if(!wanted('parity: '));
else if(chrome.find())parity();
else skip('parity: page text equals CLI text (5 tests)','Chrome was not found. Set CHROME=/path/to/chrome to run them');

console.log(NL+(passed+failed)+' tests: '+passed+' passed, '+failed+' failed'+(skipped?', '+skipped+' skipped':'')+(ONLY?' (only the tests matching '+ONLY+')':''));
// A pattern that matches nothing must not look like a pass.
process.exitCode=failed||(ONLY&&!passed)?1:0;
