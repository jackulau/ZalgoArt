/* Runs a page in headless Chrome and returns the text of its #out element. Used to build font profiles
   and by the tests. The keychain flags stop macOS from showing a keychain dialog on every launch. */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const CANDIDATES=[process.env.CHROME,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);
const find=()=>CANDIDATES.find(p=>fs.existsSync(p))||null;
const ROOT=path.join(__dirname,'..');
const inline=f=>'<script>'+fs.readFileSync(path.join(ROOT,f),'utf8')+'</'+'script>';
// body: HTML placed after the core and calibration scripts. It must write its result into #out.
function run(body,opts){
  const chrome=find();if(!chrome)return null;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zalgo-')),page=path.join(dir,'page.html');
  fs.writeFileSync(page,'<!doctype html><meta charset="utf-8"><pre id="out"></pre>'+inline('src/zalgo-core.js')+inline('src/zalgo-cal.js')+body);
  try{
    const args=['--headless=new','--disable-gpu','--use-mock-keychain','--password-store=basic','--no-first-run','--no-default-browser-check',
      '--user-data-dir='+path.join(dir,'profile'),'--virtual-time-budget=20000'];
    if(opts&&opts.screenshot)args.push('--screenshot='+opts.screenshot,'--window-size='+(opts.size||'1200,900'),'--hide-scrollbars','--force-device-scale-factor='+(opts.scale||2));
    else args.push('--dump-dom');
    if(opts&&opts.args)args.push(...opts.args);
    // Headless Chrome now and then exits with an error while shutting down, after the page has finished.
    // A run like that is thrown away and repeated, so a result always comes from a clean run.
    let dom,err;
    for(let i=0;i<4&&dom===undefined;i++){
      try{dom=execFileSync(chrome,args.concat('file://'+page),{encoding:'utf8',maxBuffer:1<<28,timeout:120000,stdio:['ignore','pipe','ignore']});}
      catch(e){err=e;fs.rmSync(path.join(dir,'profile'),{recursive:true,force:true});}
    }
    if(dom===undefined)throw new Error('Chrome failed 4 times in a row (exit '+err.status+')');
    if(opts&&opts.screenshot)return '';
    const m=/<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
    return m?m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'):'';
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
module.exports={run,find,ROOT};
