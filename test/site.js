/* Checks on the built site. problems(files) takes what tools/build.js makes (a Map of path to Buffer) and returns
   a list of sentences, one for each thing that is wrong; an empty list is a pass. test/run.js runs it on the real
   build, and again on copies with one mistake put in, to show each mistake is caught.
   Expected values are read here from the sources (the core, src/site.html, package.json), not from the builder. */
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.join(__dirname,'..');
const Z=require(path.join(ROOT,'src','zalgo-core.js'));
const ORIGIN='https://zalgoart.com',OLD_HOST='jackulau.github.io';
// The one thing a page may load from another site: Google's advertising script, for the publisher named in
// site.config.json, and only while the privacy page names the host it comes from.
const ADS=JSON.parse(fs.readFileSync(path.join(ROOT,'site.config.json'),'utf8')).adsense||'',ADS_HOST='pagead2.googlesyndication.com';
const ADS_TAG='<script async src="https://'+ADS_HOST+'/pagead/js/adsbygoogle.js?client='+ADS+'" crossorigin="anonymous"></script>';
// Files the pages point to that the build does not make.
const KEPT=['og.png','demo/image.mp4','demo/text.mp4','demo/draw.mp4','demo/glitch.mp4'];
const HOW={measured:'Measured on the live site',font:'Measured in its font',documented:'From documentation',unverified:'Not verified'};

const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const plain=s=>decode(s.replace(/<[^>]*>/g,'')).replace(/\s+/g,' ').trim();
const group=n=>String(n).replace(/\B(?=(\d{3})+$)/g,',');
const one=(html,re)=>{const m=re.exec(html);return m?decode(m[1]):null;};
const fileOf=url=>{const p=url.slice(ORIGIN.length+1);return p===''||p.endsWith('/')?p+'index.html':p;};

// The controls of the tool, read from the template: {cols:{min:'6',max:'160',...},...}
function controls(){
  const out={},html=fs.readFileSync(path.join(ROOT,'src','site.html'),'utf8');
  for(const m of html.matchAll(/<input\b[^>]*>/g)){
    const a={};for(const k of m[0].matchAll(/([a-z-]+)="([^"]*)"/g))a[k[1]]=k[2];
    if(a.id)out[a.id]=a;
  }
  return out;
}
const UNIT=P=>Z.UNIT[P.unit]+(P.second?' and '+group(P.second.limit)+' '+Z.UNIT[P.second.unit]:'');
const NOTE=P=>[P.note,P.fold&&P.fold.msg].filter(Boolean).join(' ');

function problems(files){
  const bad=[],say=(f,m)=>bad.push(f+': '+m);
  const text=f=>files.get(f).toString('utf8'),has=f=>files.has(f)||KEPT.includes(f);
  const pages=[...files.keys()].filter(f=>f.endsWith('.html')).sort();
  const platforms=Z.PLATFORMS.filter(P=>P.id!=='custom'),byId=id=>Z.PLATFORMS.find(P=>P.id===id);
  const UI=controls(),engines=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).engines.node;
  const N={stack:String(Z.STACK),platforms:String(platforms.length),node:/\d+/.exec(engines)[0]};

  /* ---- the sitemap and robots.txt ---- */
  const locs=files.has('sitemap.xml')?[...text('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map(m=>decode(m[1])):[];
  if(!files.has('sitemap.xml'))say('sitemap.xml','missing');
  for(const u of locs){
    if(!u.startsWith(ORIGIN+'/')){say('sitemap.xml',u+' is not on '+ORIGIN);continue;}
    // With clean addresses and a trailing slash on, anything else is answered with a redirect.
    if(!u.endsWith('/'))say('sitemap.xml',u+' does not end in a slash, so it would redirect');
    if(!files.has(fileOf(u)))say('sitemap.xml',u+' has no file ('+fileOf(u)+')');
  }
  if(new Set(locs).size!==locs.length)say('sitemap.xml','an address is listed twice');
  const robots=files.has('robots.txt')?text('robots.txt'):'';
  if(!/^User-agent: \*$/m.test(robots)||!/^Allow: \/$/m.test(robots)||/^Disallow:\s*\S/m.test(robots))say('robots.txt','does not allow everything');
  if(!robots.split('\n').includes('Sitemap: '+ORIGIN+'/sitemap.xml'))say('robots.txt','does not name '+ORIGIN+'/sitemap.xml');

  /* ---- advertising ---- */
  const privacy=files.has('privacy/index.html')?text('privacy/index.html'):'';
  if(ADS){
    if(!privacy.includes('<code>'+ADS_HOST+'</code>'))say('privacy/index.html','pages load a script from '+ADS_HOST+', which the privacy page does not name');
    if(!/Google AdSense/.test(privacy))say('privacy/index.html','does not say the advertising is Google AdSense');
    if(!files.has('ads.txt')||text('ads.txt')!=='google.com, '+ADS.replace(/^ca-/,'')+', DIRECT, f08c47fec0942fa0\n')say('ads.txt','does not name Google as the direct seller for '+ADS);
  }else{
    if(files.has('ads.txt'))say('ads.txt','written with no publisher id in site.config.json');
    if(privacy.includes(ADS_HOST))say('privacy/index.html','names '+ADS_HOST+', which no page loads');
  }

  /* ---- every page ---- */
  const titles=new Map(),descs=new Map();
  for(const f of pages){
    const html=text(f),dir=path.posix.dirname(f),error=f==='404.html';
    const head=html.slice(0,html.indexOf('<style>'));
    const leftover=/__[A-Z][A-Z0-9]*__|\{\{[^}]*\}\}/.exec(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
    if(leftover)say(f,'an unfilled slot, '+leftover[0]);
    // The advertising script is in the head of every page a reader can land on, once, and nowhere else.
    const tags=ADS?html.split(ADS_TAG).length-1:0,due=ADS&&!error?1:0;
    if(tags!==due||(due&&!head.includes(ADS_TAG)))say(f,'the advertising script is there '+tags+' times'+(due?', or outside the head':'')+', and should be there '+due);

    // One h1.
    const h1=(html.match(/<h1[\s>]/g)||[]).length;
    if(h1!==1)say(f,h1+' h1 headings, expected one');

    // Title and description, each its own.
    const title=one(head,/<title>([^<]*)<\/title>/),desc=one(head,/<meta name="description" content="([^"]*)">/);
    if(!title)say(f,'no title');
    else{
      if(title.length>60)say(f,'the title is '+title.length+' characters, over 60');
      if(titles.has(title))say(f,'the same title as '+titles.get(title));else titles.set(title,f);
    }
    if(!desc)say(f,'no description');
    else{
      if(!error&&(desc.length<120||desc.length>160))say(f,'the description is '+desc.length+' characters, outside 120 to 160');
      if(descs.has(desc))say(f,'the same description as '+descs.get(desc));else descs.set(desc,f);
    }

    // The canonical is the sitemap entry, exactly. The error page has neither and asks not to be indexed.
    const canon=one(head,/<link rel="canonical" href="([^"]*)">/);
    const want=ORIGIN+'/'+(f==='index.html'?'':f.replace(/index\.html$/,''));
    if(error){
      if(canon)say(f,'the error page has a canonical');
      if(!/<meta name="robots" content="noindex">/.test(head))say(f,'the error page does not say noindex');
      if(locs.some(u=>fileOf(u)===f))say(f,'the error page is in the sitemap');
    }else{
      if(canon!==want)say(f,'the canonical is '+canon+', expected '+want);
      if(!locs.includes(want))say(f,'not in the sitemap as '+want);
      else if(canon&&!locs.includes(canon))say(f,'the canonical '+canon+' is not its sitemap entry');
      if(/name="robots"/.test(head))say(f,'a robots tag on a page meant to be indexed');
    }

    // Sharing tags, theme colours, icons.
    const meta=k=>one(head,new RegExp('<meta (?:property|name)="'+k+'" content="([^"]*)"'));
    if(error){if(/property="og:|name="twitter:/.test(head))say(f,'sharing tags on the error page');}
    else{
      if(meta('og:url')!==canon)say(f,'og:url is not the canonical');
      if(meta('og:title')!==title||meta('twitter:title')!==title)say(f,'og:title or twitter:title is not the title');
      if(meta('og:description')!==desc||meta('twitter:description')!==desc)say(f,'og:description or twitter:description is not the description');
      if(meta('og:image')!==ORIGIN+'/og.png'||meta('twitter:image')!==ORIGIN+'/og.png')say(f,'og:image or twitter:image is not '+ORIGIN+'/og.png');
      if(meta('twitter:card')!=='summary_large_image')say(f,'no large twitter card');
    }
    for(const scheme of ['light','dark'])if(!new RegExp('<meta name="theme-color" content="#[0-9a-f]{6}" media="\\(prefers-color-scheme: '+scheme+'\\)">').test(head))say(f,'no theme-color for '+scheme);
    for(const rel of ['icon','apple-touch-icon','manifest'])if(!new RegExp('<link rel="'+rel+'" ').test(head))say(f,'no '+rel+' link');
    if(!/<html lang="en"/.test(html))say(f,'no lang on html');
    // The whole tag, so nothing that stops a reader zooming can be added to it. viewport-fit lets the bar at the foot
    // of a phone's screen keep clear of the home indicator.
    if(!/<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/.test(head))say(f,'no viewport tag');

    // A visitor on the old address is sent to the same path on the new one, and nobody else is sent anywhere.
    const hop=/<script>(if\(location\.hostname[^<]*)<\/script>/.exec(head);
    if(!hop)say(f,'no redirect from the old address');
    else{
      const go=(hostname,pathname)=>{let to=null;vm.runInNewContext(hop[1],{location:{hostname,pathname,search:'?mode=draw',hash:'#top',replace(u){to=u;}}});return to;};
      const tail=f==='index.html'?'':f.replace(/index\.html$/,'');
      if(go(OLD_HOST,'/ZalgoArt/'+tail)!==ORIGIN+'/'+tail+'?mode=draw#top')say(f,'the old address goes to '+go(OLD_HOST,'/ZalgoArt/'+tail));
      if(go('zalgoart.com','/'+tail)!==null||go('localhost','/ZalgoArt/'+tail)!==null)say(f,'the redirect fires away from the old address');
    }

    // Links. Inside the site they are relative, so the pages work under / and under /ZalgoArt/ alike, and each
    // one leads to a file. Whole addresses on the new origin must lead to a file too.
    for(const m of html.replace(/(<script\b(?![^>]*ld\+json)[^>]*>)[\s\S]*?<\/script>/g,'$1').matchAll(/<(a|link|img|script|source|video|iframe)\b[^>]*?\s(?:href|src)="([^"]*)"/g)){
      const tag=m[1],to=decode(m[2]);
      if(/^(data:|#|mailto:)/.test(to))continue;
      if(to.startsWith('/')){say(f,'the link '+to+' starts at the root, which breaks under /ZalgoArt/');continue;}
      if(/^[a-z][a-z0-9+.-]*:/i.test(to)){
        if(to===ORIGIN||to.startsWith(ORIGIN+'/')){if(!has(fileOf(to.split(/[?#]/)[0]+(to===ORIGIN?'/':''))))say(f,'the link '+to+' leads to no file');}
        else if(tag!=='a'){if(!(ADS&&tag==='script'&&m[0]===ADS_TAG.slice(0,m[0].length)))say(f,'loads '+to+' from another site');}
        else if(!to.startsWith('https://'))say(f,'the outside link '+to+' is not https');
        continue;
      }
      if(error){say(f,'the relative link '+to+' on the error page, which is served at any depth');continue;}
      let target=path.posix.normalize(path.posix.join(dir,to.split(/[?#]/)[0]));
      if(target==='.'||target==='./')target='';
      if(target.startsWith('..')){say(f,'the link '+to+' leaves the site');continue;}
      if(target===''||target.endsWith('/'))target+='index.html';
      else if(!path.posix.extname(target)){say(f,'the link '+to+' has no trailing slash, so it would redirect');continue;}
      if(/(^|\/)index\.html$/.test(to.split(/[?#]/)[0]))say(f,'the link '+to+' names index.html, which redirects');
      if(!has(target))say(f,'the link '+to+' leads to no file ('+target+')');
    }
    if(/@import|url\(\s*["']?(?:https?:)?\/\//.test(html))say(f,'a stylesheet loads from another site');

    // Structured data.
    const ld=[...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    let graph=[];
    try{for(const m of ld)graph=graph.concat(JSON.parse(m[1])['@graph']||[]);}catch(e){say(f,'JSON-LD does not parse');}
    const node=t=>graph.find(n=>n['@type']===t),json=JSON.stringify(graph);
    if(/aggregateRating|"review"|ratingValue|reviewCount/i.test(json))say(f,'JSON-LD holds a rating or a review');
    for(const m of json.matchAll(/"(https:\/\/zalgoart\.com[^"]*)"/g)){const u=m[1].split('#')[0];if(!has(fileOf(u)))say(f,'JSON-LD names '+m[1]+', which is no file');}
    const guide=/property="og:type" content="article"/.test(head);
    if(f==='index.html'){
      const app=node('WebApplication');
      if(!node('WebSite'))say(f,'no WebSite in JSON-LD');
      if(!app)say(f,'no WebApplication in JSON-LD');
      else{
        if(!app.offers||app.offers.price!=='0')say(f,'WebApplication is not offered at price 0');
        if(app.url!==ORIGIN+'/')say(f,'WebApplication url is '+app.url);
      }
    }else if(!error){
      const crumbs=node('BreadcrumbList'),items=crumbs?crumbs.itemListElement:[];
      if(!crumbs)say(f,'no BreadcrumbList in JSON-LD');
      else if(items[0].item!==ORIGIN+'/'||items[items.length-1].item!==canon)say(f,'the breadcrumbs do not run from the home page to this page');
    }else if(graph.length)say(f,'JSON-LD on the error page');
    if(guide){
      const art=node('TechArticle')||node('Article');
      if(!art)say(f,'a guide with no Article in JSON-LD');
      else if(art.url!==canon||art.headline!==plain(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1]))say(f,'the Article is not this page');
    }else if(node('TechArticle')||node('Article'))say(f,'an Article on a page that is not a guide');

    // A FAQ in the data is the FAQ a reader sees, question for question.
    const doc=(/<article class="doc">([\s\S]*?)<\/article>/.exec(html)||[,''])[1];
    const seen=[];
    for(const s of doc.matchAll(/<h2 data-faq[^>]*>[\s\S]*?<div class="body[^"]*">([\s\S]*?)<\/div>\s*<\/section>/g)){
      const parts=s[1].split(/<h3[^>]*>/).slice(1);
      for(const p of parts){const cut=p.indexOf('</h3>');seen.push([plain(p.slice(0,cut)),plain(p.slice(cut+5))]);}
    }
    const faq=node('FAQPage'),told=faq?faq.mainEntity.map(q=>[q.name,q.acceptedAnswer.text]):[];
    if(JSON.stringify(told)!==JSON.stringify(seen)){
      const lost=told.find(q=>!seen.some(v=>v[0]===q[0]&&v[1]===q[1]));
      say(f,lost?'the FAQ data has "'+lost[0]+'", which the page does not show with that answer':'the page shows questions the FAQ data lacks');
    }

    // Numbers. Every figure in the copy is tagged with where it comes from, and matches it.
    for(const m of doc.matchAll(/<span data-limit="([^"]*)">([^<]*)<\/span>/g)){
      const [id,second]=m[1].split('.'),P=byId(id),v=P&&(second?P.second&&P.second.limit:P.limit);
      if(v==null)say(f,'a limit for '+m[1]+', which the core does not have');
      else if(m[2]!==group(v))say(f,'the limit for '+m[1]+' reads '+m[2]+', the core says '+group(v));
    }
    for(const m of doc.matchAll(/<span data-n="([^"]*)">([^<]*)<\/span>/g)){
      if(!(m[1] in N))say(f,'a number called '+m[1]+', which has no source');
      else if(m[2]!==N[m[1]])say(f,'the number '+m[1]+' reads '+m[2]+', the source says '+N[m[1]]);
    }
    for(const m of doc.matchAll(/<span data-ui="([^"]*)">([^<]*)<\/span>/g)){
      const [id,attr]=m[1].split('.'),v=UI[id]&&UI[id][attr];
      if(v==null)say(f,'a figure for the control '+m[1]+', which the tool does not have');
      else if(m[2]!==v)say(f,'the control '+m[1]+' reads '+m[2]+', the tool says '+v);
    }
    const rows=[...doc.matchAll(/<tr data-platform="([^"]*)">([\s\S]*?)<\/tr>/g)];
    for(const m of rows){
      const P=byId(m[1]),cells=[...m[2].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c=>plain(c[1]));
      if(!P){say(f,'a table row for '+m[1]+', which the core does not have');continue;}
      const want=[P.name,group(P.limit),UNIT(P),HOW[P.src]];
      want.forEach((w,i)=>{if(cells[i]!==w)say(f,'the row for '+P.id+' reads "'+cells[i]+'", the core says "'+w+'"');});
    }
    if(rows.length&&rows.map(m=>m[1]).join()!==platforms.map(P=>P.id).join())say(f,'the limits table does not list the platforms of the core, in its order');
    for(const m of doc.matchAll(/<dt>([^<]*)<\/dt>\s*<dd data-note="([^"]*)">/g)){
      const P=byId(m[2]);
      if(P&&decode(m[1])!==P.name)say(f,'the note for '+m[2]+' is headed "'+decode(m[1])+'", the core says "'+P.name+'"');
    }
    for(const m of doc.matchAll(/<span data-flat="([^"]*)">([^<]*)<\/span>/g)){
      const P=byId(m[1]);
      if(!P||!P.flat)say(f,'a warning for '+m[1]+', which the core does not have');
      else if(decode(m[2])!==P.flat)say(f,'the warning for '+m[1]+' is not the warning in the core');
    }
    for(const m of doc.matchAll(/<(dd|span) data-note="([^"]*)">([\s\S]*?)<\/\1>/g)){m.splice(1,1);
      const P=byId(m[1]);
      if(!P||!NOTE(P))say(f,'a note for '+m[1]+', which the core does not have');
      else if(plain(m[2])!==NOTE(P).replace(/\s+/g,' ').trim())say(f,'the note for '+m[1]+' is not the note in the core');
    }
    // What is left may hold no figure of two digits or more: one typed by hand would go stale unseen.
    const copy=doc.replace(/<(pre|code|time|figure)\b[\s\S]*?<\/\1>/g,' ').replace(/<span data-(?:limit|n|ui|note|flat)="[^"]*">[^<]*<\/span>/g,' ')
      .replace(/<tr data-platform[\s\S]*?<\/tr>/g,' ').replace(/<dt>[^<]*<\/dt>(?=\s*<dd data-note)/g,' ').replace(/<dd data-note[\s\S]*?<\/dd>/g,' ');
    for(const [where,s] of [['the copy',plain(copy)],['the title',title||''],['the description',desc||'']]){
      const typed=/\d[\d,.]*\d/.exec(s.replace(/UTF-(?:16|8)\b/g,''));
      if(typed)say(f,'the figure '+typed[0]+' in '+where+' is typed by hand, not taken from a source');
    }
  }

  /* ---- the manifest ---- */
  if(!files.has('site.webmanifest'))say('site.webmanifest','missing');
  else try{
    const man=JSON.parse(text('site.webmanifest'));
    for(const icon of man.icons||[])if(!files.has(icon.src))say('site.webmanifest','the icon '+icon.src+' is no file');
    if(!(man.icons||[]).length)say('site.webmanifest','no icons');
  }catch(e){say('site.webmanifest','does not parse');}
  for(const f of ['favicon.svg','favicon.ico','favicon-96x96.png','apple-touch-icon.png'])if(!files.has(f))bad.push(f+': missing');
  return bad;
}

module.exports={problems,ORIGIN,KEPT,ADS,ADS_HOST,ADS_TAG};
