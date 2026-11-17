#!/usr/bin/env node
/* Builds the site: every page, the sitemap, robots.txt, the web manifest and the icons.

     node tools/build.js          writes into docs/, which Vercel serves at https://zalgoart.com/ and GitHub Pages
                                  serves at /ZalgoArt/
     node tools/build.js <dir>    writes the same files somewhere else, which is how the tests check the build

   Pages come from src/pages/: a line of JSON in a comment (address, title, description and so on), then the
   copy as HTML. A tool page is the app in src/site.html, opened in that page's mode, with the copy under it.
   Every other page is the copy alone in src/page.html.

   One tree is served from two base paths, so links and files inside a page are relative, and what a search
   engine reads (canonical, Open Graph, sitemap, JSON-LD) is absolute on zalgoart.com. The copy writes links
   from the root ("/draw/") and the build makes them relative, and stops if one points nowhere.

   Numbers in the copy are not typed by hand. {{limit:x}} is X's limit from the core, {{ui:cols.max}} is the
   Columns slider's maximum from the app, and the build stops if a name it is given does not exist. Each is
   wrapped in a tagged span, which is what lets the tests check the copy against the tool.

   The same sources give the same bytes: nothing here reads the clock or the machine. */
'use strict';
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const ROOT=path.join(__dirname,'..'),SRC=path.join(ROOT,'src');
const Z=require(path.join(SRC,'zalgo-core.js')),PKG=require(path.join(ROOT,'package.json')),CONFIG=require(path.join(ROOT,'site.config.json'));
const ORIGIN='https://zalgoart.com',OLD_HOST='jackulau.github.io',OLD_BASE='/ZalgoArt',NAME='Zalgo Art',REPO='https://github.com/jackulau/ZalgoArt';
const OG={file:'og.png',w:1200,h:630,alt:'The words Introducing ZalgoArt drawn as big letters with stacked combining marks'};
const THEME={light:'#ffffff',dark:'#121212'};
// site.config.json holds the two values that belong to whoever hosts the site. Both are public by design (each
// is served to every visitor) and neither is a secret, but they are this site's, so a copy hosted elsewhere
// clears them: with "adsense" empty no page loads anything from another site and no ads.txt is written, and
// with "indexnow" empty no key file is written.
const ADS=CONFIG.adsense||'',ADS_HOST='pagead2.googlesyndication.com',ADS_SRC=ADS&&'https://'+ADS_HOST+'/pagead/js/adsbygoogle.js?client='+ADS,INDEXNOW=CONFIG.indexnow||'';
if(ADS&&!/^ca-pub-[0-9]{16}$/.test(ADS))throw new Error('site.config.json: "adsense" is not a publisher id (ca-pub- and 16 digits)');
if(INDEXNOW&&!/^[0-9a-f]{32}$/.test(INDEXNOW))throw new Error('site.config.json: "indexnow" is not 32 hex characters');
// Files in docs/ that the build does not write (tools/readme.js draws og.png, tools/demo.js records the clips) but pages may point at.
const KEPT=['og.png','demo/image.mp4','demo/text.mp4','demo/draw.mp4','demo/glitch.mp4'];
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
// The words the tool's own badge uses beside the delivery check.
const HOW={measured:'Measured on the live site',font:'Measured in its font',documented:'From documentation',unverified:'Not verified'};

const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const num=n=>String(n).replace(/\B(?=(\d{3})+$)/g,',');
const plain=h=>h.replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const fileOf=p=>p.path==='/'?'index.html':p.path.endsWith('/')?p.path.slice(1)+'index.html':p.path.slice(1);
const urlOf=p=>ORIGIN+p.path;
const platform=id=>{const P=Z.PLATFORMS.find(p=>p.id===id);if(!P)throw new Error('no platform "'+id+'" in src/zalgo-core.js');return P;};
const day=d=>{const m=/^(\d{4})-(\d\d)-(\d\d)$/.exec(d);if(!m)throw new Error('bad date "'+d+'"');return '<time datetime="'+d+'">'+(+m[3])+' '+MONTHS[m[2]-1]+' '+m[1]+'</time>';};
const tag=(attr,key,value)=>'<span data-'+attr+'="'+key+'">'+esc(value)+'</span>';

function loadPages(){
  const dir=path.join(SRC,'pages');
  return fs.readdirSync(dir).filter(f=>f.endsWith('.html')).sort().map(f=>{
    const s=fs.readFileSync(path.join(dir,f),'utf8'),m=/^<!--\s*(\{[\s\S]*?\})\s*-->\n?/.exec(s);
    if(!m)throw new Error('src/pages/'+f+' must start with its settings as JSON in a comment');
    const p=Object.assign(JSON.parse(m[1]),{src:'src/pages/'+f,body:s.slice(m[0].length)});
    for(const k of ['path','kind','title','description','h1','label','date','order'])if(p[k]==null)throw new Error(p.src+': "'+k+'" is missing');
    if(p.kind==='tool'&&!['image','text','draw','glitch'].includes(p.mode))throw new Error(p.src+': a tool page needs "mode"');
    return p;
  }).sort((a,b)=>a.order-b.order);
}

// The zalgo command's own words: its help, its table of platforms, and lines of its output.
function cli(args,summary){
  const r=spawnSync(process.execPath,[path.join(ROOT,'bin','zalgo'),...args],{cwd:ROOT,encoding:'utf8',env:Object.assign({},process.env,{NO_COLOR:'1'})});
  if(r.error||(r.status!==0&&r.status!==1))throw new Error('zalgo '+args.join(' ')+' failed: '+(r.error||r.stderr));
  return (summary?r.stderr:r.stdout).replace(/\n+$/,'');
}
const words=s=>(s.match(/"[^"]*"|\S+/g)||[]).map(w=>w.replace(/^"|"$/g,''));

function limitsTable(){
  const rows=Z.PLATFORMS.filter(P=>P.id!=='custom').map(P=>{
    const more=P.second?' and <span data-limit="'+P.id+'.second">'+num(P.second.limit)+'</span> '+esc(Z.UNIT[P.second.unit]):'';
    return '<tr data-platform="'+P.id+'"><th scope="row">'+esc(P.name)+'</th><td class="n">'+num(P.limit)+'</td><td>'+esc(Z.UNIT[P.unit])+more+'</td><td>'+esc(HOW[P.src])+'</td></tr>';
  });
  for(const P of Z.PLATFORMS)if(!HOW[P.src])throw new Error('no wording for source "'+P.src+'"');
  return '<div class="scroll"><table><thead><tr><th scope="col">Platform</th><th scope="col" class="n">Limit</th><th scope="col">Counted in</th><th scope="col">Where the figure comes from</th></tr></thead>\n<tbody>\n'+rows.join('\n')+'\n</tbody></table></div>';
}
// What the tool itself says about each platform, word for word from the core.
function limitNotes(){
  const out=[];
  for(const P of Z.PLATFORMS){
    const said=[P.note,P.fold&&P.fold.msg].filter(Boolean).join(' ');
    if(P.id!=='custom'&&said)out.push('<dt>'+esc(P.name)+'</dt><dd data-note="'+P.id+'">'+esc(said)+'</dd>');
  }
  return '<dl>\n'+out.join('\n')+'\n</dl>';
}

function build(){
  const pages=loadPages(),app=read('src/site.html'),sheet=read('src/site.css').trim();
  const page=read('src/page.html'),core=read('src/zalgo-core.js'),cal=read('src/zalgo-cal.js');
  const burger='data:image/jpeg;base64,'+fs.readFileSync(path.join(ROOT,'examples','burger.jpg')).toString('base64');
  // Pictures to try, all drawn for this project: the burger first, then src/samples/ in name order. Each goes into
  // the page as a data URL, so trying one asks the network for nothing.
  const sampleFiles=[path.join(ROOT,'examples','burger.svg'),...fs.readdirSync(path.join(SRC,'samples')).filter(f=>f.endsWith('.svg')).sort().map(f=>path.join(SRC,'samples',f))];
  const samples=sampleFiles.map(f=>{const name=path.basename(f,'.svg');
    return '<button type="button" class="sample" data-name="'+esc(name)+'" aria-label="Try the '+esc(name)+'" title="'+esc(name[0].toUpperCase()+name.slice(1))+'"><img alt="" width="40" height="40" src="data:image/svg+xml;base64,'+fs.readFileSync(f).toString('base64')+'"></button>';}).join('');
  const icons=fs.readdirSync(path.join(SRC,'icons')).filter(f=>!f.startsWith('.')).sort();
  const out=new Map(),listed=pages.filter(p=>p.kind!=='error'),home=pages.find(p=>p.path==='/');
  const known=new Set([...pages.map(p=>p.path),...icons.map(f=>'/'+f),...KEPT.map(f=>'/'+f),'/site.webmanifest','/sitemap.xml','/robots.txt']);
  if(!home)throw new Error('no page has the path "/"');
  const author=/^(.*?)\s*\((.*)\)$/.exec(PKG.author||'');
  const person=author?{'@type':'Person',name:author[1],url:author[2]}:undefined;
  const ui=key=>{
    const [id,attr]=key.split('.'),el=new RegExp('<input\\b[^>]*\\bid="'+id+'"[^>]*>').exec(app),v=el&&new RegExp('\\b'+attr+'="([^"]*)"').exec(el[0]);
    if(!v)throw new Error('no '+attr+' on #'+id+' in src/site.html');
    return v[1];
  };

  for(const p of pages){
    const error=p.kind==='error',up=p.path==='/'?'':'../';
    // A link written from the root, as this page must write it. The error page can be served at any depth, so it alone uses whole addresses.
    const link=t=>{
      const [to,hash]=t.split('#'),at=hash==null?'':'#'+hash;
      if(!known.has(to))throw new Error(p.src+': link to "'+t+'", which the site does not have');
      return error?ORIGIN+to+at:(to==='/'?up||'./':up+to.slice(1))+at;
    };
    const list=kind=>'<ul class="links">\n'+listed.filter(o=>o.kind===kind&&o!==p&&o!==home).map(o=>'<li><a href="'+link(o.path)+'">'+esc(o.label)+'</a><span>'+esc(o.blurb||'')+'</span></li>').join('\n')+'\n</ul>';
    const token=(m,name,arg)=>{
      arg=(arg||'').trim();
      switch(name){
        case 'limit':{const [id,second]=arg.split('.'),P=platform(id);if(second&&!P.second)throw new Error(p.src+': '+id+' has no second limit');return tag('limit',arg,num(second?P.second.limit:P.limit));}
        case 'unit':{const [id,second]=arg.split('.'),P=platform(id);return esc(Z.UNIT[second?P.second.unit:P.unit]);}
        case 'stack':return tag('n','stack',Z.STACK);
        case 'platforms':return tag('n','platforms',Z.PLATFORMS.filter(P=>P.id!=='custom').length);
        case 'node':return tag('n','node',/\d+/.exec(PKG.engines.node)[0]);
        case 'ui':return tag('ui',arg,ui(arg));
        case 'limits-table':return limitsTable();
        case 'limit-notes':return limitNotes();
        // One platform's note, or its warning about piles that come out flat, word for word from the core.
        case 'note':{const P=platform(arg),said=[P.note,P.fold&&P.fold.msg].filter(Boolean).join(' ');if(!said)throw new Error(p.src+': '+arg+' has no note');return '<span data-note="'+arg+'">'+esc(said)+'</span>';}
        case 'flat':{const P=platform(arg);if(!P.flat)throw new Error(p.src+': '+arg+' has no warning about flat piles');return '<span data-flat="'+arg+'">'+esc(P.flat)+'</span>';}
        // {{cli:help}} is what the command prints, {{cli:count file|6}} its first six lines, {{cli-summary:...}} what it reports beside the text.
        case 'cli':case 'cli-summary':{const [cmd,n]=arg.split('|'),t=cli(words(cmd),name==='cli-summary');return esc(n?t.split('\n').slice(0,+n).join('\n'):t);}
        // The command's output set as a post would be: in the font it was sized for, on its platform's line height.
        case 'sample':{const w=words(arg),at=w.indexOf('-p');return '<div class="zalgo" style="line-height:'+platform(at<0?'x':w[at+1]).lh+'">'+esc(cli(w))+'</div>';}
        case 'links':return list(arg);
        case 'date':return day(p.date);
        case 'repo':return REPO;
      }
      throw new Error(p.src+': unknown {{'+name+'}}');
    };
    const body=p.body.replace(/\{\{([a-z-]+)(?::([^}]*))?\}\}/g,token).replace(/\b(href|src)="(\/[^"]*)"/g,(m,a,t)=>a+'="'+link(t)+'"').trim();
    if(/\{\{|\}\}/.test(body))throw new Error(p.src+': a {{...}} was left unfilled');

    // Copy: what comes before the first h2 is the introduction, and each h2 starts a section.
    const parts=body.split(/(?=<h2[\s>])/),intro=/^<h2[\s>]/.test(parts[0])?'':parts.shift().trim(),faq=[];
    const sections=parts.map(s=>{
      const m=/^(<h2[^>]*>[\s\S]*?<\/h2>)([\s\S]*)$/.exec(s);
      if(!m)throw new Error(p.src+': an h2 is not closed');
      if(/^<h2[^>]*\bdata-faq\b/.test(m[1]))for(const q of m[2].matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[\s>]|$)/g))faq.push({q:plain(q[1]),a:plain(q[2])});
      return '<section>\n'+m[1]+'\n<div class="body'+(/class="(scroll|links)"/.test(m[2])?' wide':'')+'">\n'+m[2].trim()+'\n</div>\n</section>';
    });
    const tool=p.kind==='tool';
    if(tool&&intro)throw new Error(p.src+': a tool page\'s copy starts with an h2 (its h1 is in the header)');
    if(/<h1[\s>]/.test(body))throw new Error(p.src+': the h1 comes from "h1" in the settings, not from the copy');
    const crumb=error||p===home?'':'<nav class="crumb" aria-label="Breadcrumb"><a href="'+link('/')+'">'+NAME+'</a> / '+esc(p.label)+'</nav>';
    const lead=tool?'':'<div class="lead">\n<div>'+crumb+(p.kind==='guide'||p.kind==='legal'?'<p class="crumb">Updated '+day(p.date)+'</p>':'')+'</div>\n<div class="body">\n<h1>'+esc(p.h1)+'</h1>\n'+intro+'\n</div>\n</div>\n';
    const doc='<article class="doc">\n'+lead+sections.join('\n')+'\n</article>';

    // What search engines and link previews read.
    const url=urlOf(p),image=ORIGIN+'/'+OG.file,asset=f=>error?ORIGIN+'/'+f:up+f;
    if(p.title.length>60)throw new Error(p.src+': the title is '+p.title.length+' characters, over 60');
    if(!error&&(p.description.length<120||p.description.length>160))throw new Error(p.src+': the description is '+p.description.length+' characters, outside 120 to 160');
    const crumbs={'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:NAME,item:ORIGIN+'/'},{'@type':'ListItem',position:2,name:p.label,item:url}]};
    const graph=[];
    if(p===home)graph.push(
      {'@type':'WebSite','@id':ORIGIN+'/#website',url:ORIGIN+'/',name:NAME,description:p.description,inLanguage:'en'},
      {'@type':'WebApplication','@id':ORIGIN+'/#app',name:NAME,url:ORIGIN+'/',description:p.description,applicationCategory:'UtilitiesApplication',operatingSystem:'Any',
        browserRequirements:'Requires JavaScript',isAccessibleForFree:true,offers:{'@type':'Offer',price:'0',priceCurrency:'USD'},image,author:person,license:'https://opensource.org/license/mit'});
    else if(!error)graph.push(crumbs);
    if(p.kind==='guide')graph.push({'@type':'TechArticle',headline:p.h1,description:p.description,url,mainEntityOfPage:url,image,inLanguage:'en',datePublished:p.date,dateModified:p.date,author:person,publisher:person});
    if(faq.length)graph.push({'@type':'FAQPage',mainEntity:faq.map(f=>({'@type':'Question',name:f.q,acceptedAnswer:{'@type':'Answer',text:f.a}}))});
    const head=[
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
      '<title>'+esc(p.title)+'</title>',
      '<meta name="description" content="'+esc(p.description)+'">',
      error?'<meta name="robots" content="noindex">':'<link rel="canonical" href="'+url+'">',
      // The site used to live on GitHub Pages. A visitor who lands there is sent to the same page here.
      '<script>if(location.hostname===\''+OLD_HOST+'\')location.replace(\''+ORIGIN+'\'+location.pathname.replace(/^\\'+OLD_BASE+'(?=\\/|$)/i,\'\')+location.search+location.hash)</script>',
      // Google's advertising script, as AdSense hands it out. Not on the error page, which has nothing to read.
      ...(ADS&&!error?['<script async src="'+ADS_SRC+'" crossorigin="anonymous"></script>']:[]),
      '<meta name="theme-color" content="'+THEME.light+'" media="(prefers-color-scheme: light)">',
      '<meta name="theme-color" content="'+THEME.dark+'" media="(prefers-color-scheme: dark)">',
      ...(error?[]:[
        '<meta property="og:type" content="'+(p.kind==='guide'?'article':'website')+'">',
        '<meta property="og:site_name" content="'+NAME+'">',
        '<meta property="og:title" content="'+esc(p.title)+'">',
        '<meta property="og:description" content="'+esc(p.description)+'">',
        '<meta property="og:url" content="'+url+'">',
        '<meta property="og:image" content="'+image+'">',
        '<meta property="og:image:width" content="'+OG.w+'">',
        '<meta property="og:image:height" content="'+OG.h+'">',
        '<meta property="og:image:alt" content="'+esc(OG.alt)+'">',
        '<meta name="twitter:card" content="summary_large_image">',
        '<meta name="twitter:title" content="'+esc(p.title)+'">',
        '<meta name="twitter:description" content="'+esc(p.description)+'">',
        '<meta name="twitter:image" content="'+image+'">',
      ]),
      '<link rel="icon" href="'+asset('favicon.ico')+'" sizes="48x48">',
      '<link rel="icon" href="'+asset('favicon.svg')+'" type="image/svg+xml">',
      '<link rel="icon" href="'+asset('favicon-96x96.png')+'" type="image/png" sizes="96x96">',
      '<link rel="apple-touch-icon" href="'+asset('apple-touch-icon.png')+'">',
      '<link rel="manifest" href="'+asset('site.webmanifest')+'">',
      ...(graph.length?['<script type="application/ld+json">'+JSON.stringify({'@context':'https://schema.org','@graph':graph}).replace(/</g,'\\u003c')+'</script>']:[]),
    ].join('\n');
    const foot='  <footer class="foot"><nav aria-label="Site">'+listed.map(o=>'<a href="'+link(o.path)+'"'+(o===p?' aria-current="page"':'')+'>'+esc(o===home?NAME:o.label)+'</a>').join('')+'</nav>'
      +'<span>Open source under the MIT licence. <a href="'+REPO+'">Source and CLI on GitHub</a></span></footer>\n'
      // Opened from a folder, there is no server to turn "draw/" into "draw/index.html".
      +'  <script>if(location.protocol===\'file:\')for(const a of document.querySelectorAll(\'a[href]\')){const h=a.getAttribute(\'href\');if(!/^[a-z][a-z0-9+.-]*:/i.test(h)&&/\\/(#.*)?$/.test(h))a.setAttribute(\'href\',h.replace(/\\/(#.*)?$/,\'/index.html$1\'))}</script>';
    const inline=js=>js.replace(/<\/script/g,'<\\/script');
    const slots={HEAD:head,CSS:sheet,HOME:link('/'),H1:esc(p.h1),TAGLINE:esc(p.tagline||''),MODE:p.mode||'',DOC:doc,FOOT:foot,CORE:inline(core),CAL:inline(cal),BURGER:burger,SAMPLES:samples};
    const html=(tool?app:page).replace(/__([A-Z][A-Z0-9]*)__/g,(m,k)=>{if(!(k in slots))throw new Error('unknown slot '+m);return slots[k];});
    out.set(fileOf(p),Buffer.from(html));
  }

  out.set('sitemap.xml',Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    +listed.map(p=>'  <url><loc>'+urlOf(p)+'</loc><lastmod>'+p.date+'</lastmod></url>').join('\n')+'\n</urlset>\n'));
  out.set('robots.txt',Buffer.from('User-agent: *\nAllow: /\n\nSitemap: '+ORIGIN+'/sitemap.xml\n'));
  // Who may sell advertising on this site: Google, for this publisher, directly. The last field is Google's own id.
  if(ADS)out.set('ads.txt',Buffer.from('google.com, '+ADS.replace(/^ca-/,'')+', DIRECT, f08c47fec0942fa0\n'));
  // IndexNow (Bing, Yandex and others) accepts a list of changed addresses from whoever can serve this key.
  if(INDEXNOW)out.set(INDEXNOW+'.txt',Buffer.from(INDEXNOW));
  out.set('site.webmanifest',Buffer.from(JSON.stringify({name:NAME,short_name:NAME,description:home.description,start_url:'./',scope:'./',display:'browser',
    background_color:THEME.light,theme_color:THEME.light,
    icons:[{src:'icon-192.png',sizes:'192x192',type:'image/png'},{src:'icon-512.png',sizes:'512x512',type:'image/png'}]},null,2)+'\n'));
  for(const f of icons)out.set(f,fs.readFileSync(path.join(SRC,'icons',f)));
  return out;
}

module.exports={build,loadPages,fileOf,urlOf,ORIGIN,OLD_HOST,KEPT,OG,ROOT,ADS,ADS_HOST,ADS_SRC,INDEXNOW};

if(require.main===module){
  let files;
  try{files=build();}catch(e){console.error('build: '+e.message);process.exit(1);}
  const dir=path.resolve(process.argv[2]||path.join(ROOT,'docs'));
  for(const [name,data] of files){
    const to=path.join(dir,name);
    fs.mkdirSync(path.dirname(to),{recursive:true});
    fs.writeFileSync(to,data);
  }
  // A page the site no longer has would stay in docs/ and stay live. Say so; removing it is for whoever dropped the page.
  const stale=[];
  (function walk(d,rel){
    for(const e of fs.readdirSync(d,{withFileTypes:true})){
      if(e.name.startsWith('.'))continue;
      if(e.isDirectory())walk(path.join(d,e.name),rel+e.name+'/');
      else if(e.name.endsWith('.html')&&!files.has(rel+e.name))stale.push(rel+e.name);
    }
  })(dir,'');
  console.log('built '+files.size+' files in '+path.relative(process.cwd(),dir)+(stale.length?'\nnot made by this build, remove if the page is gone: '+stale.join(', '):''));
}
