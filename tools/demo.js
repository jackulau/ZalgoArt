#!/usr/bin/env node
/* Records the README demos, one clip for each source: image, text, draw and glitch.
   Each clip drives docs/index.html in headless Chromium with real mouse and keyboard input from a fresh
   page load, captures the screen, and is written twice with ffmpeg: a looping GIF and an MP4.
   Usage: node tools/demo.js [image|text|draw|glitch ...]     (default: all four)
   Output: assets/demo-<name>.gif and assets/demo-<name>.mp4
   PLAYWRIGHT=/path/to/node_modules/playwright picks a Playwright install, FFMPEG=/path/to/ffmpeg an ffmpeg. */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),{pathToFileURL}=require('url'),{execFileSync}=require('child_process');
let pw;try{pw=require(process.env.PLAYWRIGHT||'playwright');}catch(_){console.error('Playwright not found. Run npm i -D playwright, or set PLAYWRIGHT=/path/to/node_modules/playwright.');process.exit(1);}
const ROOT=path.join(__dirname,'..'),ASSETS=path.join(ROOT,'assets');
const W=1000,H=960,FPS=12,GIF_W=840,ARGS=['--use-mock-keychain','--password-store=basic'];
const PW=232,PH=66;                                   // the drawing pad's grid, as in src/site.html
// A pointer drawn into the page, since a screen capture has none. It follows the real mouse events.
const CURSOR=()=>addEventListener('DOMContentLoaded',()=>{
  const c=document.createElement('div');
  c.innerHTML='<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l0 16 4.3-4 2.9 6.4 2.9-1.3-2.9-6.3 5.9-.3z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:22px;height:22px;margin:-3px 0 0 -4px;transform:translate(-99px,-99px)';
  const r=document.createElement('i');
  r.style.cssText='position:absolute;left:-10px;top:-9px;width:28px;height:28px;border-radius:50%;background:rgba(37,99,235,.28);transform:scale(.3);opacity:0;transition:transform .12s,opacity .12s';
  c.prepend(r);document.body.append(c);
  addEventListener('pointermove',e=>{c.style.transform='translate('+e.clientX+'px,'+e.clientY+'px)';},true);
  addEventListener('pointerdown',()=>{r.style.opacity=1;r.style.transform='scale(1)';},true);
  addEventListener('pointerup',()=>{r.style.opacity=0;r.style.transform='scale(.3)';},true);
});

/* What each clip does. `h` holds the hands: click, type, slide, stroke, and so on. */
const SCENES={
  // The sample picture, then a platform with more room (a bigger picture), then how a dark-theme reader sees it.
  async image(h){
    await h.wait(1500);
    await h.platform('discord');await h.wait(1500);
    await h.click('.seg[data-for=paper] [data-v=dark]',{ms:450});await h.wait(1300);
  },
  // Words in big letters, then a platform with more room.
  async text(h){
    await h.wait(500);
    await h.click('.seg[data-for=mode] [data-v=text]');await h.wait(700);
    await h.type('#ttext','hello');await h.wait(1500);
    await h.platform('discord');await h.wait(1400);
  },
  // A house, a tree and the ground, drawn by hand.
  async draw(h){
    await h.wait(500);
    await h.click('.seg[data-for=mode] [data-v=draw]');await h.wait(300);
    await h.click('#clearBtn');await h.wait(200);
    await h.tool('rect');await h.stroke([[36,45],[92,22]],400);                      // the house
    await h.tool('brush');await h.stroke([[33,23],[64,3],[95,23]],350);              // its roof
    await h.tool('fill');await h.stroke([[64,14]]);
    await h.tool('oval');await h.stroke([[132,6],[176,34]],400);                     // a tree
    await h.tool('brush');await h.stroke([[154,45],[154,30]],300);
    await h.stroke([[12,49],[60,54],[110,50],[160,55],[214,49]],250);                // the ground
    await h.away();await h.wait(1400);
  },
  // Classic glitch text on Bluesky: new words, taller piles above and shorter ones below (30 marks a column is
  // what Safari stacks), then a fresh roll of the marks.
  async glitch(h){
    await h.wait(500);
    await h.click('.seg[data-for=mode] [data-v=glitch]');await h.wait(700);
    await h.platform('bluesky');await h.wait(900);
    await h.type('#gtext','zalgo art');await h.wait(900);
    await h.slide('#gup',18);await h.wait(500);
    await h.slide('#gdn',9);await h.wait(700);
    await h.click('#reroll',{ms:400});await h.wait(700);
    await h.click('#reroll',{ms:200});await h.wait(1100);
  }
};

async function launch(){
  try{return await pw.chromium.launch({args:ARGS});}
  catch(_){return await pw.chromium.launch({channel:'chrome',args:ARGS});}   // no matching Playwright Chromium: use Chrome
}
async function record(browser,name){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zalgo-demo-')),errors=[];
  const ctx=await browser.newContext({viewport:{width:W,height:H},deviceScaleFactor:2,colorScheme:'light'});
  try{
    await ctx.grantPermissions(['clipboard-read','clipboard-write']);
    await ctx.addInitScript(CURSOR);
    const page=await ctx.newPage(),mouse=page.mouse,wait=ms=>page.waitForTimeout(ms);
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(path.join(ROOT,'docs','index.html')).href);
    await page.waitForFunction(()=>window.zalgo&&window.zalgo.ready,null,{timeout:30000});
    const HOME={x:W*.68,y:H*.62};
    let at=HOME;
    await mouse.move(at.x,at.y);await wait(400);
    // Moves along an eased path in small steps, timed by the clock, so the pointer is seen travelling.
    async function glide(x,y,ms){
      const a=at,d=ms||350,t0=Date.now();
      for(let t=0;t<1;){t=Math.min(1,(Date.now()-t0)/d);const k=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;await mouse.move(a.x+(x-a.x)*k,a.y+(y-a.y)*k);if(t<1)await wait(12);}
      at={x,y};
    }
    const box=async sel=>{const l=page.locator(sel);await l.scrollIntoViewIfNeeded();return l.boundingBox();};
    const centre=async sel=>{const b=await box(sel);return {x:b.x+b.width/2,y:b.y+b.height/2};};
    const h={
      wait,
      away:()=>glide(HOME.x,HOME.y,350),
      async click(sel,o){const p=await centre(sel);await glide(p.x,p.y,o&&o.ms);await wait(100);await mouse.down();await wait(100);await mouse.up();await wait(120);},
      // Selects what is in a field and types over it.
      async type(sel,words){const p=await centre(sel);await glide(p.x,p.y,300);await mouse.click(p.x,p.y,{clickCount:3,delay:60});await wait(250);await page.keyboard.type(words,{delay:150});},
      // Drags a slider's handle to a value, then settles any last step with the arrow keys.
      async slide(sel,v){
        const l=page.locator(sel),b=await box(sel),R=8,y=b.y+b.height/2;
        const {min,max,val}=await l.evaluate(e=>({min:+e.min,max:+e.max,val:+e.value}));
        const x=u=>b.x+R+(u-min)/(max-min)*(b.width-2*R);
        await glide(x(val),y,300);await mouse.down();await glide(x(v),y,700);await mouse.up();
        for(let i=0;i<80;i++){const now=+(await l.inputValue());if(now===v)break;await page.keyboard.press(now<v?'ArrowRight':'ArrowLeft');}
        await wait(150);
      },
      // The platform list is a native menu, which a screen capture of a headless page does not show:
      // the pointer goes to it and the choice is made by script.
      async platform(id){const p=await centre('#platform');await glide(p.x,p.y,400);await wait(250);await page.selectOption('#platform',id);},
      // Drawing: points are in pad cells, a stroke is a press, a run of moves, a release.
      async stroke(pts,ms){
        const b=await box('#sketch'),xy=([x,y])=>({x:b.x+x/PW*b.width,y:b.y+y/PH*b.height});
        const p0=xy(pts[0]);await glide(p0.x,p0.y,250);await mouse.down();
        for(const q of pts.slice(1)){const p=xy(q);await glide(p.x,p.y,ms||260);}
        await mouse.up();await wait(120);
      },
      tool:v=>h.click('.seg[data-for=tool] [data-v='+v+']',{ms:300})
    };

    const cdp=await ctx.newCDPSession(page),frames=[];
    cdp.on('Page.screencastFrame',f=>{
      const file=path.join(dir,String(frames.length).padStart(5,'0')+'.jpg');
      fs.writeFileSync(file,Buffer.from(f.data,'base64'));frames.push({t:f.metadata.timestamp,off:f.metadata.timestamp-Date.now()/1000,file});
      cdp.send('Page.screencastFrameAck',{sessionId:f.sessionId}).catch(()=>{});
    });
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:95,maxWidth:W*2,maxHeight:H*2,everyNthFrame:1});
    await mouse.move(at.x+1,at.y);
    await SCENES[name](h);
    await h.click('#copyBtn',{ms:400});await glide(at.x-30,at.y+60,250);await wait(1000);   // every clip ends on Copy
    const done=await page.locator('#copyDone').textContent();
    await cdp.send('Page.stopScreencast');
    const last=frames[frames.length-1],end=Math.max(last.t,Date.now()/1000+last.off)+.6;   // the stop on the frames' clock, plus a hold
    if(done!=='Copied')errors.push('Copy button said: '+done);
    const verdict=await page.locator('#verdict').textContent();
    if(/^Will|^Nothing/.test(verdict))errors.push('The clip ends on a post that fails: '+verdict);

    // Frames arrive only when the screen changes: each stays up until the next one.
    const list=frames.map((f,i)=>"file '"+f.file+"'\nduration "+Math.max(.001,(i+1<frames.length?frames[i+1].t:end)-f.t).toFixed(4)).join('\n')+"\nfile '"+last.file+"'\n";
    fs.writeFileSync(path.join(dir,'list.txt'),list);
    fs.mkdirSync(ASSETS,{recursive:true});
    const ff=process.env.FFMPEG||'ffmpeg',src=['-y','-loglevel','error','-f','concat','-safe','0','-i',path.join(dir,'list.txt')];
    const gif=path.join(ASSETS,'demo-'+name+'.gif'),mp4=path.join(ASSETS,'demo-'+name+'.mp4');
    execFileSync(ff,[...src,'-vf',
      'fps='+FPS+',scale='+GIF_W+':-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop','0',gif],{stdio:'inherit'});
    execFileSync(ff,[...src,'-vf','fps=30,scale='+W+':-2:flags=lanczos:in_range=full:out_range=tv,format=yuv420p','-an','-c:v','libx264','-preset','slow','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',mp4],{stdio:'inherit'});
    console.log(name+': '+verdict+', '+(end-frames[0].t).toFixed(1)+' s, gif '+fs.statSync(gif).size+' bytes, mp4 '+fs.statSync(mp4).size+' bytes');
  }finally{
    await ctx.close();fs.rmSync(dir,{recursive:true,force:true});
    if(errors.length){console.error(name+': page errors:\n  '+errors.join('\n  '));process.exitCode=1;}
  }
}
(async()=>{
  const names=process.argv.slice(2).length?process.argv.slice(2):Object.keys(SCENES);
  for(const n of names)if(!SCENES[n]){console.error('No clip called '+n+'. Clips: '+Object.keys(SCENES).join(', '));process.exit(1);}
  const browser=await launch();
  try{for(const n of names)await record(browser,n);}
  finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exit(1);});
