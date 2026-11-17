#!/usr/bin/env node
/* Builds profiles/<name>.json: how a font stacks combining marks, measured in headless Chrome.
   Usage: node tools/profile.js [name=font-family ...]     e.g. node tools/profile.js roboto=Roboto */
'use strict';
const fs=require('fs'),path=require('path'),{run,ROOT}=require('./chrome.js');
const want=process.argv.slice(2).map(a=>a.split('='));
const fonts=want.length?want:[['helvetica','Helvetica'],['arial','Arial']];
const out=run('<script>document.getElementById("out").textContent=JSON.stringify('+JSON.stringify(fonts)+'.map(f=>[f[0],ZalgoCal.calibrate(f[1])]));</'+'script>');
if(out===null){console.error('Chrome not found. Set CHROME=/path/to/chrome.');process.exit(1);}
for(const [name,p] of JSON.parse(out)){
  if(!p.up.length||!p.dn.length||!Object.keys(p.bases).length){console.error(name+': this font does not stack marks, skipped');continue;}
  const row=l=>'[\n'+l.map(m=>'    '+JSON.stringify(m)).join(',\n')+'\n  ]';
  const text='{\n  "font": '+JSON.stringify(p.font)+',\n  "up": '+row(p.up)+',\n  "dn": '+row(p.dn)+',\n  "bases": '+JSON.stringify(p.bases)+'\n}\n';
  fs.writeFileSync(path.join(ROOT,'profiles',name+'.json'),text);
  console.log(name+': '+p.up.length+' marks above, '+p.dn.length+' below');
}
