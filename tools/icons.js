#!/usr/bin/env node
/* Draws the site's icon files from the Z mark in assets/logo-icon.svg into src/icons/, which the build copies
   to docs/ as they are. Run it only when the mark changes: node tools/icons.js   (needs Chrome and ImageMagick)
   The build itself needs neither, so what it writes is the same on every machine. */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process'),{run,find,ROOT}=require('./chrome.js');
const OUT=path.join(ROOT,'src','icons'),svg=fs.readFileSync(path.join(ROOT,'assets','logo-icon.svg'),'utf8');
if(!find()){console.error('Chrome was not found. Set CHROME=/path/to/chrome.');process.exit(1);}
fs.mkdirSync(OUT,{recursive:true});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'zalgo-icons-'));
// Chrome draws the mark once at 512 px: on its rounded tile with clear corners, and on a full square for
// iOS, which rounds the corners itself and paints clear pixels black.
function draw(name,markup){
  const file=path.join(tmp,name);
  run('<style>html,body{margin:0;background:transparent}#out{display:none}svg{display:block;width:512px;height:512px}</style>'+markup,
    {screenshot:file,size:'512,512',scale:1,args:['--default-background-color=00000000']});
  return file;
}
const tile=draw('tile.png',svg),square=draw('square.png',svg.replace('rx="7.5"','rx="0"'));
const magick=(...a)=>execFileSync('magick',a,{stdio:['ignore','inherit','inherit']});
const png=(src,size,name)=>magick(src,'-filter','Lanczos','-resize',size+'x'+size,'-strip','-define','png:exclude-chunks=date,time',path.join(OUT,name));
fs.writeFileSync(path.join(OUT,'favicon.svg'),svg);
png(tile,96,'favicon-96x96.png');          // search results want a multiple of 48 px
png(tile,192,'icon-192.png');png(tile,512,'icon-512.png');
png(square,180,'apple-touch-icon.png');
magick(tile,'-filter','Lanczos','-define','icon:auto-resize=48,32,16',path.join(OUT,'favicon.ico'));
fs.rmSync(tmp,{recursive:true,force:true});
for(const f of fs.readdirSync(OUT).sort())console.log('src/icons/'+f,fs.statSync(path.join(OUT,f)).size,'bytes');
