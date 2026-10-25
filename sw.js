// Zoometric sin internet.
// - APP: página, manifiesto e íconos. Lo guardado se entrega de inmediato y la versión nueva se baja por
//   detrás para la próxima vez: así abre igual sin red, con mala señal o cuando la red se queda colgada
//   (algunas redes móviles con github.io), en vez de esperar a la red antes de mostrar nada.
// - RECURSOS: modelos y librerías (~40 MB). Se descargan una sola vez en segundo plano al instalar y se usan
//   desde el teléfono aunque haya internet. Si un modelo cambia, cambiar también el nombre de RECURSOS.
// - EXTRA: lo que se pide a otros servidores (SAM y su librería): se guarda al usarlo por primera vez.
const APP = 'zoometric-app-v7';
const RECURSOS = 'zoometric-recursos-v2';
const EXTRA = 'zoometric-extra-v1';
const LISTA_APP = ['./', './worker-yolo.js', './manifest.webmanifest'];
const LISTA_RECURSOS = [
  './modelos/cerdo_regla.onnx',
  './modelos/animales_coco.onnx',
  './vendor/onnxruntime-web-1.20.1/ort.min.js',
  './vendor/onnxruntime-web-1.20.1/ort-wasm-simd-threaded.mjs',
  './vendor/onnxruntime-web-1.20.1/ort-wasm-simd-threaded.wasm',
  './vendor/xlsx-0.18.5/xlsx.full.min.js',
  './ejemplo/cerdo-ejemplo-1.jpg',
  './ejemplo/cerdo-ejemplo-2.jpg',
  './ejemplo/cerdo-ejemplo-3.jpg',
];
const abs = (r) => new URL(r, self.location.href).href;
/** Sin nada guardado (la primera visita), se espera a la red solo este tiempo. */
const ESPERA_MS = 8000;

function conLimite(promesa, ms) {
  return Promise.race([promesa, new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('La red no respondió')), ms))]);
}

// Baja juntas la página y lo demás de la app, para que la próxima visita no mezcle versiones.
let actualizando = null;
function actualizarApp() {
  actualizando ??= (async () => {
    const nuevos = await Promise.all(LISTA_APP.map(async (a) => {
      const r = await fetch(abs(a), { cache: 'no-cache' });
      if (!r.ok) throw new Error(a + ' ' + r.status);
      return [abs(a), r];
    }));
    const cache = await caches.open(APP);
    for (const [clave, r] of nuevos) await cache.put(clave, r);
  })().catch(() => {}).finally(() => { actualizando = null; });
  return actualizando;
}

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

  if (propio && (url.pathname.includes('/modelos/') || url.pathname.includes('/vendor/') || url.pathname.includes('/ejemplo/'))) {
    evento.respondWith(
      caches.match(pedido, { ignoreSearch: true, ignoreVary: true }).then((g) => g ?? fetch(pedido).then((r) => { guardar(RECURSOS, url.origin + url.pathname, r); return r; })),
    );
    return;
  }
  if (!propio) {
    if (EXTERNOS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
      evento.respondWith(caches.match(pedido).then((g) => g ?? fetch(pedido).then((r) => { guardar(EXTRA, pedido, r); return r; })));
    }
    return;
  }
  // página e íconos: lo guardado primero y la versión nueva por detrás; sin nada guardado, la red con límite
  const clave = pedido.mode === 'navigate' ? abs('./') : url.origin + url.pathname;
  const deLaApp = pedido.mode === 'navigate' || LISTA_APP.some((a) => abs(a) === clave);
  evento.respondWith(
    caches.match(clave, { ignoreSearch: true, ignoreVary: true }).then((g) => {
      if (g) {
        if (deLaApp) evento.waitUntil(actualizarApp());
        return g;
      }
      return conLimite(fetch(pedido, { cache: 'no-cache' }), ESPERA_MS)
        .then((r) => { if (deLaApp) guardar(APP, clave, r); return r; })
        .catch(() => Response.error());
    }),
  );
});
