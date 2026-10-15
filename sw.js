// Zoometric sin internet.
// - APP: página, manifiesto e íconos. Primero la red (para recibir versiones nuevas); sin internet, lo guardado.
// - RECURSOS: modelos y librerías (~40 MB). Se descargan una sola vez en segundo plano al instalar y se usan
//   desde el teléfono aunque haya internet. Si un modelo cambia, cambiar también el nombre de RECURSOS.
// - EXTRA: lo que se pide a otros servidores (SAM y su librería): se guarda al usarlo por primera vez.
const APP = 'zoometric-app-v5';
const RECURSOS = 'zoometric-recursos-v2';
const EXTRA = 'zoometric-extra-v1';
const LISTA_APP = ['./', './worker-yolo.js', './manifest.webmanifest', './icono-192.png', './icono-512.png', './icono-512-adaptable.png', './icono-apple.png'];
const LISTA_RECURSOS = [
  './modelos/cerdo_regla.onnx',
  './modelos/animales_coco.onnx',
  './vendor/onnxruntime-web-1.20.1/ort.min.js',
  './vendor/onnxruntime-web-1.20.1/ort-wasm-simd-threaded.mjs',
  './vendor/onnxruntime-web-1.20.1/ort-wasm-simd-threaded.wasm',
  './vendor/xlsx-0.18.5/xlsx.full.min.js',
];
const abs = (r) => new URL(r, self.location.href).href;

async function avisar(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

// descarga lo que falte de los recursos, avisando el avance a la página
let completando = null;
function completar() {
  completando ??= (async () => {
    const cache = await caches.open(RECURSOS);
    let hechos = 0;
    for (const r of LISTA_RECURSOS) {
      if (!(await cache.match(abs(r)))) {
        await avisar({ tipo: 'progreso', hechos, total: LISTA_RECURSOS.length });
        const resp = await fetch(abs(r), { cache: 'no-cache' });
        if (!resp.ok) throw new Error(r + ' ' + resp.status);
        await cache.put(abs(r), resp);
      }
      hechos++;
    }
    await avisar({ tipo: 'listo' });
  })().catch(async () => { await avisar({ tipo: 'error' }); }).finally(() => { completando = null; });
  return completando;
}

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(APP).then((c) => c.addAll(LISTA_APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (evento) => {
  const vigentes = [APP, RECURSOS, EXTRA];
  const limpiar = caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('zoometric') && !vigentes.includes(k)).map((k) => caches.delete(k))));
  evento.waitUntil(limpiar.then(() => self.clients.claim()).then(() => { completar(); }));
});

self.addEventListener('message', (evento) => {
  if (evento.data?.tipo === 'estado') evento.waitUntil(completar());
});

function guardar(nombre, clave, resp) {
  if (!resp || !(resp.ok || resp.type === 'opaque')) return;
  const copia = resp.clone();
  caches.open(nombre).then((c) => c.put(clave, copia));
}

const EXTERNOS = ['cdn.jsdelivr.net', 'huggingface.co', 'hf.co', 'xethub.hf.co'];

self.addEventListener('fetch', (evento) => {
  const pedido = evento.request;
  if (pedido.method !== 'GET') return;
  const url = new URL(pedido.url);
  const propio = url.origin === self.location.origin;

  if (propio && (url.pathname.includes('/modelos/') || url.pathname.includes('/vendor/'))) {
    evento.respondWith(
      caches.match(pedido, { ignoreSearch: true }).then((g) => g ?? fetch(pedido).then((r) => { guardar(RECURSOS, url.origin + url.pathname, r); return r; })),
    );
    return;
  }
  if (!propio) {
    if (EXTERNOS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
      evento.respondWith(caches.match(pedido).then((g) => g ?? fetch(pedido).then((r) => { guardar(EXTRA, pedido, r); return r; })));
    }
    return;
  }
  // página e íconos: primero la red; sin internet, lo guardado
  const clave = pedido.mode === 'navigate' ? abs('./') : url.origin + url.pathname;
  evento.respondWith(
    fetch(pedido, { cache: 'no-cache' })
      .then((r) => { if (pedido.mode === 'navigate' || LISTA_APP.some((a) => abs(a) === clave)) guardar(APP, clave, r); return r; })
      .catch(() => caches.match(clave, { ignoreSearch: true }).then((g) => g ?? Response.error())),
  );
});
