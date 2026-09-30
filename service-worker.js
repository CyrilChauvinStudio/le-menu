const CACHE = "mon-frigo-v5";
const STATIC = ["./icon-180.png","./icon-192.png","./icon-512.png","./icon-512-maskable.png","./icon-1024.png","./manifest.webmanifest"];
const CORE = ["./","./index.html","./app.js"];
self.addEventListener("install",(e)=>{e.waitUntil(caches.open(CACHE).then((c)=>c.addAll([...CORE,...STATIC])));self.skipWaiting();});
self.addEventListener("activate",(e)=>{e.waitUntil(caches.keys().then((ks)=>Promise.all(ks.filter((k)=>k!==CACHE).map((k)=>caches.delete(k)))));self.clients.claim();});
self.addEventListener("fetch",(e)=>{
  const req=e.request; if(req.method!=="GET") return;
  const url=new URL(req.url); if(url.hostname.includes("api.anthropic.com")) return;
  const core = req.mode==="navigate" || url.pathname.endsWith("/app.js") || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/");
  if(core){
    e.respondWith(fetch(req).then((res)=>{const c=res.clone();caches.open(CACHE).then((k)=>k.put(req,c));return res;}).catch(()=>caches.match(req).then((r)=>r||caches.match("./index.html"))));
  } else {
    e.respondWith(caches.match(req).then((r)=>r||fetch(req)));
  }
});
