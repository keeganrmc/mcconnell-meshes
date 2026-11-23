/* LastFirst service worker — install + offline, same architecture as
   Rendre/Glisten's own sw.js (network-first HTML so an online PWA always
   picks up a new deploy, cache-first everything else) — with one guard: a
   fetched html of another build is not served under this worker's cache
   (see the navigate branch). PRECACHE the app
   shell (three.js, manifest, icons, modules) and the reference last's .bin
   files under the URL the app asks for them by (?v=<build>), so an installed
   app boots offline. */
/* MUST match __LF_BUILD in the app. activate() purges every lastfirst-v cache
   whose key is not this one, so a forgotten bump here means the old assets survive a deploy
   while the app reports the new version — checked by
   tools/verify/build_version_2026-08-13.mjs. */
const CACHE = 'lastfirst-v00000-284';
const BUILD = CACHE.slice('lastfirst-'.length);
const SHELL = [
  './index.html',   // the page itself, so a worker always has its OWN html to serve
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-512-maskable.png',
  `./assets/base_last_verts.bin?v=${BUILD}`,
  `./assets/base_last_faces.bin?v=${BUILD}`,
  `./assets/base_last_fine_verts.bin?v=${BUILD}`,
  './vendor/three/three.module.js',
  './vendor/font/ibm-plex-mono-400.woff2',
  './vendor/font/ibm-plex-mono-600.woff2',
  './vendor/font/renato-symbols-400.woff2',
  './vendor/font/renato-symbols-600.woff2',
  // the page's modules, its workers and their imports (rhino3dm, loaded only for a .3dm, and the banked
  // foot model are cached when first used)
  './generators/blocks.mjs',
  './patterns/forme.mjs',
  './persistcore/persistcore.v00000-001.js',
  './shoe/meshcut.mjs',
  './shoe/shell.mjs',
  './shoe/floor.mjs',
  './shoe/ground.mjs',
  './shoe/footie.mjs',
  './shoe/relief.mjs',
  './shoe/paint.mjs',
  './shoe/zones.mjs',
  './shoe/terrain.mjs',
  './shoe/curvefit.mjs',
  './lift/masq/terrain.js',
  './shoe/lattice.mjs',
  './shoe/lattice.worker.js',
  './shoe/union.mjs',
  './shoe/zcheck.mjs',
  './shoe/zcheck.worker.js',
  './shoe/print.mjs',
  './shoe/print.worker.js',
  './lift/masq/print/estimate.js',
  './lift/masq/print/mesh.js',
  './lift/masq/print/orient.js',
  './lift/masq/print/profile.js',
  './lift/masq/print/slice.js',
  './lift/masq/print/support.js',
  './lift/masq/print/threemf.js',
  './lift/masq/print/time.js',
  './vendor/print/printers.json',
  './vendor/print/materials.json',
  './shoe/superb.mjs',
  './shoe/superb.worker.js',
  './shoe/export.mjs',
  './lift/masq/tosuperb.js',
  './lift/masq/superbsolid.js',
  './lift/masq/exporters.js',
  './lift/masq/export3dm.js',
  './lift/masq/decimate.js',
  './lift/masq/levelset.js',
  './lift/masq/centina/basis.mjs',
  './lift/masq/centina/subd.mjs',
  './lift/masq/centina/subdconvert.mjs',
  './lift/masq/centina/subdlimit.mjs',
  './lift/masq/centina/subdsimplify.mjs',
  './lift/masq/centina/surface.mjs',
  './lift/masq/centina/vec3.mjs',
  './lift/masq/remesh/quadriflow_engine.js',
  './lift/masq/remesh/quadriflow.js',
  './lift/masq/remesh/quadriflow.wasm',
  './lift/masq/remesh/quadriflow.worker.js',
  './shoe/plate.mjs',
  './shoe/perforate.mjs',
  './shoe/infillgrade.mjs',
  './shoe/grade.mjs',
  './shoe/tex.mjs',
  './shoe/outline.mjs',
  './shoe/pipe.mjs',
  './shoe/thickness.mjs',
  './shoe/cageedit.mjs',
  './shoe/places.mjs',
  './shoe/placepicker.mjs',
  './shoe/rimline.mjs',
  './shoe/plate.worker.js',
  './lift/masq/plate.js',
  './lift/masq/edgepattern.js',
  './lift/masq/lift/alphas/alphas.v00000-001.js',
  './lift/masq/lift/cell/cell.v00000-001.js',
  './lift/masq/lift/deform/lattice.v00000-001.js',
  './lift/masq/lift/deform/maskops.v00000-001.js',
  './lift/masq/lift/deform/noise.v00000-001.js',
  './lift/masq/lift/lift/lift.v00000-001.js',
  './lift/masq/lift/meshkernel/meshkernel.v00000-002.js',
  './lift/masq/lift/outline/outline.v00000-001.js',
  './kernel/basis.mjs',
  './kernel/bvh.mjs',
  './kernel/refit.mjs',
  './kernel/solidwrap.mjs',
  './kernel/subd.mjs',
  './kernel/subdlimit.mjs',
  './kernel/subdprimitives.mjs',
  './kernel/subdsimplify.mjs',
  './kernel/surface.mjs',
  './kernel/vec3.mjs',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // only this app's older caches: the site's other apps (and this app's terrain tile cache) keep theirs
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('lastfirst-v') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    /* Network-first for the page, and the page's modules cache-first: a
       new page under an old worker imports old modules. The html is fetched
       from the network but the response is NOT handed to the page when its
       build does not match this worker's CACHE — this worker's own cached
       html is served instead, one version through, and the new worker
       (already installing) takes over and reloads the page. */
    e.respondWith(
      fetch(req).then(async (res) => {
        if (!(res && res.ok && res.type === 'basic')) return res;
        const text = await res.clone().text();
        const m = text.match(/__LF_BUILD = '([^']+)'/);
        if (m && 'lastfirst-' + m[1] !== CACHE) {
          const own = await caches.match(req) || await caches.match('./index.html');
          if (own) return own;
        }
        caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then((h) => h || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      });
    })
  );
});
