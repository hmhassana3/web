/* My Digital Universe - service worker
   1) App shell: cached so the app itself opens offline (same behaviour as before).
   2) Offline websites: a website opened through the app's mirror path (./_off/<id>/) is saved per website in its own
      cache (dus-off-<id>). Deleting one website's cache never touches another website's cache, and never touches
      the website's own localStorage / IndexedDB data (calculator history etc. lives there, not here).
   3) Cover photos: every cover that loaded once is kept (dus-img) and shown offline too.
   Offline caches are never wiped by app updates (only old dus-v* shell caches are removed). */
const V='dus-v5',F=['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png','./hero-d.webp','./hero-m.webp'];
const IMG='dus-img',META='dus-meta',OFF='dus-off-',MAX=25*1024*1024;
const BASE=new URL('./',self.registration.scope).pathname,MIR=BASE+'_off/';
const CFGK=new Request(location.origin+BASE+'_cfg.json');
const STATIC=new Set(['script','style','image','font','audio','video','track','manifest']);
const noCors=new Set(),fresh=new Set();
let cfg=null;

self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(F)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x.indexOf('dus-v')===0&&x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});

/* settings pushed from the page: {on:boolean, sites:{id:{u:url,en:boolean}}} */
async function getCfg(){
 if(cfg)return cfg;
 try{const c=await caches.open(META),m=await c.match(CFGK);cfg=m?await m.json():{on:false,sites:{}}}catch(x){cfg={on:false,sites:{}}}
 if(!cfg||typeof cfg!=='object')cfg={on:false,sites:{}};
 if(!cfg.sites)cfg.sites={};
 return cfg;
}
async function setCfg(n){
 cfg={on:!!(n&&n.on),sites:(n&&typeof n.sites==='object'&&n.sites)||{}};
 try{const c=await caches.open(META);await c.put(CFGK,new Response(JSON.stringify(cfg),{headers:{'content-type':'application/json'}}))}catch(x){}
}
self.addEventListener('message',e=>{
 const d=e.data||{};
 if(d.t==='cfg'){const p=setCfg(d.cfg).then(()=>{try{e.ports&&e.ports[0]&&e.ports[0].postMessage(1)}catch(x){}});e.waitUntil(p)}
});
function enabled(c,id){const s=c.on&&c.sites&&c.sites[id];return !!(s&&s.en)}
function wu(e,p){try{e.waitUntil(p)}catch(x){}}
function mirId(url){
 try{const p=new URL(url,location.href);if(p.origin!==location.origin||p.pathname.indexOf(MIR)!==0)return null;
  const r=p.pathname.slice(MIR.length),i=r.indexOf('/');return decodeURIComponent(i<0?r:r.slice(0,i))}catch(x){return null}
}

/* keep a copy (only complete 200 answers, never huge files) and hand the page a clean response */
async function keep(e,res,id,key){
 if(res.status!==200||res.type==='opaque')return res;
 if((+res.headers.get('content-length')||0)>MAX)return res;
 const blob=await res.blob(),h=new Headers(res.headers);
 ['content-encoding','content-length','transfer-encoding'].forEach(k=>h.delete(k));
 if(blob.size<=MAX){
  wu(e,(async()=>{
   if(!enabled(await getCfg(),id))return;
   const st=new Headers(h);st.set('x-dus-bytes',String(blob.size));
   try{const c=await caches.open(OFF+id);if(enabled(await getCfg(),id))await c.put(key,new Response(blob,{status:200,statusText:'OK',headers:st}))}catch(x){}
  })());
 }
 return new Response(blob,{status:200,statusText:'OK',headers:h});
}
async function ranged(r,m){
 const g=/bytes=(\d*)-(\d*)/.exec(r.headers.get('range')||'');
 if(!g)return m;
 const b=await m.blob(),n=b.size;let s,t;
 if(g[1]===''){s=Math.max(0,n-(+g[2]));t=n-1}else{s=+g[1];t=g[2]===''?n-1:Math.min(+g[2],n-1)}
 if(s>=n||s>t)return new Response(null,{status:416,headers:{'content-range':'bytes */'+n}});
 const h=new Headers(m.headers);h.set('content-range','bytes '+s+'-'+t+'/'+n);h.set('content-length',String(t-s+1));h.delete('x-dus-bytes');
 return new Response(b.slice(s,t+1),{status:206,statusText:'Partial Content',headers:h});
}

/* same-origin file of a saved website. returns a Response, or null when nothing can be served */
async function serve(e,r,real,id){
 const cache=await caches.open(OFF+id),hit=await cache.match(real,{ignoreVary:true});
 if(r.headers.has('range')){
  if(hit)return ranged(r,hit);
  try{
   const res=await fetch(real,{credentials:'same-origin'});
   if(res.status===200&&(+res.headers.get('content-length')||0)<=MAX)return ranged(r,await keep(e,res,id,real));
   try{res.body&&res.body.cancel()}catch(x){}
   return await fetch(real,{headers:{range:r.headers.get('range')},credentials:'same-origin'});
  }catch(x){return null}
 }
 const net=()=>fetch(real,{credentials:'same-origin'}).then(res=>keep(e,res,id,real));
 if(STATIC.has(r.destination)){
  if(hit){wu(e,net().catch(()=>{}));return hit}
  return net().catch(()=>null);
 }
 /* pages and data requests: network first, saved copy when offline or very slow */
 if(!hit)return net().catch(()=>null);
 return Promise.race([net().then(x=>x.ok?x:hit,()=>hit),new Promise(ok=>setTimeout(()=>ok(hit),4000))]);
}
/* cross-origin static file (script, style, font, picture, audio, video) used by a saved website */
async function xo(e,r,id){
 const cache=await caches.open(OFF+id),key=r.url,hit=await cache.match(key,{ignoreVary:true});
 if(r.headers.has('range'))return hit?ranged(r,hit):fetch(r);
 const org=new URL(key).origin;
 const net=async()=>{if(noCors.has(org))throw 0;return keep(e,await fetch(key,{mode:'cors',credentials:'omit'}),id,key)};
 if(hit){wu(e,net().catch(()=>{}));return hit}
 try{return await net()}catch(x){const p=await fetch(r);noCors.add(org);return p}
}
function gone(t){
 return new Response('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Not saved offline</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0620;color:#fff;font:16px system-ui,sans-serif;text-align:center;padding:24px"><div><h2 style="margin:0 0 10px">'+(t||'This website is not saved for offline use yet')+'</h2><p style="color:#b9b0d8;margin:0 0 22px">Connect to the internet and open it once from My Digital Universe. After that it will work offline.</p><a href="'+BASE+'index.html" style="color:#fff;background:#7c3aed;padding:12px 22px;border-radius:30px;text-decoration:none;font-weight:600">Back to My Digital Universe</a></div>',{status:503,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}
async function mirror(e,r,u){
 if(r.method!=='GET'&&r.method!=='HEAD')return new Response(null,{status:405});
 const rest=u.pathname.slice(MIR.length),i=rest.indexOf('/');
 if(i<0)return Response.redirect(new URL(u.pathname+'/'+u.search,u.origin).href,302);
 const id=decodeURIComponent(rest.slice(0,i)),sub=rest.slice(i+1),cf=await getCfg(),s=cf.sites[id];
 if(!s||!s.u)return gone();
 let real;
 try{
  const dir=new URL('./',s.u).href;
  real=sub===''?s.u:new URL(sub+u.search,dir).href;
  if(new URL(real).origin!==new URL(s.u).origin)return new Response(null,{status:403});
 }catch(x){return new Response(null,{status:400})}
 if(!enabled(cf,id))return Response.redirect(real,302);   /* setting OFF or this website is online-only: behave like the normal website */
 const res=await serve(e,r,real,id);
 if(res)return res;
 return(r.mode==='navigate'||r.destination==='document'||r.destination==='iframe')?gone():Response.error();
}
/* cover photos of the app: once loaded, always shown (works offline) */
async function pic(e,r){
 const c=await caches.open(IMG),hit=await c.match(r.url,{ignoreVary:true});
 const net=async()=>{
  let res;
  try{res=await fetch(r.url,{mode:'cors',credentials:'omit',referrerPolicy:'no-referrer'})}catch(x){res=await fetch(r)}
  if(res.type==='opaque'||res.status===200){
   if(res.type!=='opaque'&&(+res.headers.get('content-length')||0)>MAX)return res;
   try{await c.put(r.url,res.clone())}catch(x){}
  }
  return res;
 };
 if(hit){if(!fresh.has(r.url)){fresh.add(r.url);wu(e,net().catch(()=>{}))}return hit}
 return net();
}
function legacy(r,u){
 if(u.pathname.endsWith('sites.json'))return null;
 if(r.mode==='navigate')return fetch(r).then(res=>{const cp=res.clone();caches.open(V).then(c=>c.put('./index.html',cp));return res}).catch(()=>caches.open(V).then(c=>c.match('./index.html')));
 return caches.open(V).then(c=>c.match(r)).then(m=>{const n=fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res}).catch(()=>m);return m||n});
}
/* everything that is not the app itself: files of a saved website, or photos */
async function other(e,r,u,same){
 let id=null;
 try{const c=r.clientId?await self.clients.get(r.clientId):null;id=mirId(c?c.url:r.referrer)}catch(x){}
 if(id!==null){
  const cf=await getCfg();
  if(!enabled(cf,id))return fetch(r);
  if(same){u.hash='';return(await serve(e,r,u.href,id))||Response.error()}
  if(STATIC.has(r.destination))return xo(e,r,id);
  return fetch(r);
 }
 if(r.destination==='image')return pic(e,r);
 if(same){const p=legacy(r,u);return p?p:fetch(r)}
 return fetch(r);
}
self.addEventListener('fetch',e=>{
 const r=e.request;
 if(r.method!=='GET')return;
 const u=new URL(r.url),same=u.origin===location.origin;
 if(same&&u.pathname.indexOf(MIR)===0){e.respondWith(mirror(e,r,u));return}
 if(same&&u.pathname.indexOf(BASE)===0){const p=legacy(r,u);if(p)e.respondWith(p);return}
 if(r.mode==='navigate')return;
 e.respondWith(other(e,r,u,same));
});
