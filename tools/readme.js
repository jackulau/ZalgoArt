#!/usr/bin/env node
/* Keeps the README's lettering and pictures in step with examples/.
   Usage: node tools/readme.js            -> rewrites the lettering block in README.md
          node tools/readme.js images     -> also draws assets/lettering-{light,dark}.png and docs/og.png (needs Chrome)
   As a module: require('./readme').block() -> the block README.md must hold, which the tests compare. */
'use strict';
const fs=require('fs'),path=require('path'),{run,find,ROOT}=require('./chrome.js');
const NL=String.fromCodePoint(10),SRC='examples/introducing-zalgoart.x-premium.txt';
const START='<!-- lettering:start',END='<!-- lettering:end -->';
const art=()=>fs.readFileSync(path.join(ROOT,SRC),'utf8');
/* One HTML paragraph, lines joined with <br>. A code block would use a monospace font, which stacks the marks
   differently, and would scroll on a phone. A Markdown paragraph would join the lines into one. */
const block=()=>START+' made by tools/readme.js from '+SRC+', do not edit by hand -->'+NL+
  '<p align="center">'+art().split(NL).join('<br>')+'</p>'+NL+END;
function write(){
  const file=path.join(ROOT,'README.md'),s=fs.readFileSync(file,'utf8'),a=s.indexOf(START),b=s.indexOf(END);
  if(a<0||b<a)throw new Error('README.md has no lettering block ('+START+' ... '+END+')');
  const next=s.slice(0,a)+block()+s.slice(b+END.length);
  if(next!==s)fs.writeFileSync(file,next);
  console.log('README.md: lettering '+(next===s?'already current':'updated'));
}
// GitHub's README font stack and sizes, so the pictures show what a Mac reader sees there.
const GH='-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif';
const cps=s=>JSON.stringify([...s].map(c=>c.codePointAt(0)));
const fill=(id,s)=>'<script>document.getElementById("'+id+'").textContent=String.fromCodePoint(...'+cps(s)+');</'+'script>';
function images(){
  if(!find())throw new Error('Chrome was not found. Set CHROME=/path/to/chrome.');
  for(const [name,ink] of [['light','#1f2328'],['dark','#f0f6fc']]){
    const out=path.join(ROOT,'assets','lettering-'+name+'.png');
    run('<style>html,body{margin:0;background:transparent}#out{display:none}#a{margin:0;width:340px;font:16px/1.5 '+GH+';color:'+ink+
      ';text-align:center;white-space:pre}</style><p id="a"></p>'+fill('a',art()),{screenshot:out,size:'340,176',scale:3,args:['--default-background-color=00000000']});
    console.log(path.relative(ROOT,out),fs.statSync(out).size,'bytes');
  }
  const logo=fs.readFileSync(path.join(ROOT,'assets','logo.svg'),'utf8').replace('<svg ','<svg width="56" height="56" '),og=path.join(ROOT,'docs','og.png');
  run('<style>html,body{margin:0;background:#fff;color:#171717}#out{display:none}.c{box-sizing:border-box;width:1200px;height:630px;padding:56px 72px;display:flex;flex-direction:column;font-family:'+GH+
    '}.h{display:flex;align-items:center;gap:18px;font-size:34px;font-weight:600;letter-spacing:-.02em}#a{margin:auto 0;font-size:40px;line-height:1.5;text-align:center;white-space:pre}'+
    '.t{font-size:27px;color:#666;letter-spacing:-.01em}</style><div class="c"><div class="h">'+logo+'<span>Zalgo Art</span></div><p id="a"></p>'+
    '<div class="t">Pictures, drawings and words as one line of stacked Unicode marks, sized to arrive whole.</div></div>'+fill('a',art()),{screenshot:og,size:'1200,630',scale:1});
  console.log(path.relative(ROOT,og),fs.statSync(og).size,'bytes');
}
if(require.main===module){
  try{write();if(process.argv[2]==='images')images();}
  catch(e){console.error(e.message);process.exit(1);}
}
module.exports={block,START,END};
