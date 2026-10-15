// Detectores YOLOv8n-seg: el entrenado para cerdos (clases 0 = cerdo, 1 = regla) y el general COCO para otras
// especies (vaca, oveja, caballo, perro…); la regla se mide además por color a resolución completa.
// La librería va incluida en la app (vendor/) para funcionar sin internet. Este worker es un archivo propio
// (no un blob) para que el service worker atienda todas sus descargas, también el .mjs y el .wasm.
importScripts('vendor/onnxruntime-web-1.20.1/ort.min.js');
ort.env.wasm.wasmPaths = new URL('vendor/onnxruntime-web-1.20.1/', self.location.href).href;
ort.env.wasm.numThreads = 1;
const S = 640;
const sesiones = new Map();
const load = (url) => { if (!sesiones.has(url)) sesiones.set(url, ort.InferenceSession.create(url, { executionProviders: ['wasm'] })); return sesiones.get(url); };

self.onmessage = async ({ data }) => {
  const { id, blob, url, clases, claseRegla, nombre } = data;
  try {
    const session = await load(url);
    const t0 = performance.now();
    const bmp = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height;
    const fctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    fctx.drawImage(bmp, 0, 0);
    const px = fctx.getImageData(0, 0, W, H).data;

    // letterbox a 640 × 640 como en el entrenamiento
    const r = Math.min(S / W, S / H), nw = Math.round(W * r), nh = Math.round(H * r);
    const dx = Math.round((S - nw) / 2), dy = Math.round((S - nh) / 2);
    const lctx = new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true });
    lctx.fillStyle = 'rgb(114,114,114)'; lctx.fillRect(0, 0, S, S);
    lctx.drawImage(bmp, dx, dy, nw, nh);
    const d = lctx.getImageData(0, 0, S, S).data, inp = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++) { inp[i] = d[i * 4] / 255; inp[i + S * S] = d[i * 4 + 1] / 255; inp[i + 2 * S * S] = d[i * 4 + 2] / 255; }
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, S, S]) });
    const o0 = out[session.outputNames[0]], o1 = out[session.outputNames[1]];
    const N = o0.dims[2], nc = o0.dims[1] - 36, p = o0.data;
    const MH = o1.dims[2], MW = o1.dims[3], proto = o1.data;

    const best = (c) => { let j = -1, s = 0; for (let k = 0; k < N; k++) { const v = p[(4 + c) * N + k]; if (v > s) { s = v; j = k; } } return { j, score: s }; };
    const boxL = (j) => { const cx = p[j], cy = p[N + j], w = p[2 * N + j], h = p[3 * N + j]; return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]; };
    const toOrig = (b) => [(b[0] - dx) / r, (b[1] - dy) / r, (b[2] - dx) / r, (b[3] - dy) / r];

    // máscara: coeficientes · prototipos, interpolación bilineal a resolución original, recortada a la caja
    function maskFor(j) {
      const L = new Float32Array(MH * MW);
      for (let k = 0; k < 32; k++) {
        const c = p[(4 + nc + k) * N + j], off = k * MH * MW;
        for (let i = 0; i < MH * MW; i++) L[i] += c * proto[off + i];
      }
      const b = boxL(j), m = new Uint8Array(W * H), sc = MW / S;
      const x0 = Math.max(0, Math.floor((b[0] - dx) / r)), x1 = Math.min(W - 1, Math.ceil((b[2] - dx) / r));
      const y0 = Math.max(0, Math.floor((b[1] - dy) / r)), y1 = Math.min(H - 1, Math.ceil((b[3] - dy) / r));
      for (let y = y0; y <= y1; y++) {
        const ly = (y + 0.5) * r + dy;
        if (ly < b[1] || ly > b[3]) continue;
        const v = Math.min(MH - 1, Math.max(0, ly * sc - 0.5)), v0 = Math.floor(v), v1 = Math.min(MH - 1, v0 + 1), fv = v - v0;
        for (let x = x0; x <= x1; x++) {
          const lx = (x + 0.5) * r + dx;
          if (lx < b[0] || lx > b[2]) continue;
          const u = Math.min(MW - 1, Math.max(0, lx * sc - 0.5)), u0 = Math.floor(u), u1 = Math.min(MW - 1, u0 + 1), fu = u - u0;
          const val = (L[v0 * MW + u0] * (1 - fu) + L[v0 * MW + u1] * fu) * (1 - fv) + (L[v1 * MW + u0] * (1 - fu) + L[v1 * MW + u1] * fu) * fv;
          if (val > 0) m[y * W + x] = 1;
        }
      }
      return m;
    }

    // la detección con mayor puntaje entre las clases de la especie
    let pc = { j: -1, score: 0 };
    for (const c of clases) { const b = best(c); if (b.score > pc.score) pc = b; }
    if (pc.score < 0.25) { postMessage({ type: 'auto', id, ok: false, reason: `No se detectó ${nombre} en la foto: corrige con SAM (clic sobre el animal)` }); return; }
    const pig = maskFor(pc.j);
    const rc = claseRegla != null ? best(claseRegla) : { j: -1, score: 0 };
    const ruler = medirRegla(px, W, H, pig, rc.score >= 0.2 ? toOrig(boxL(rc.j)) : null, rc.score >= 0.2 ? maskFor(rc.j) : null);
    postMessage({ type: 'auto', id, ok: true, pig, pigScore: pc.score, rulerScore: rc.score, ruler, secs: (performance.now() - t0) / 1000 }, [pig.buffer]);
  } catch (e) {
    postMessage({ type: 'auto', id, ok: false, reason: e?.message ?? String(e) });
  }
};

// Busca la etiqueta blanca: recorre umbrales de brillo y elige la mancha clara más rectangular
// y alargada (no el lomo con reflejo). El largo se mide sobre el eje principal (PCA) e incluye
// las esquinas de cinta café.
function medirRegla(px, W, H, pig, box, yoloMask) {
  const N = W * H, V = new Uint8Array(N), Sat = new Uint8Array(N), Hue = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), dd = mx - mn;
    V[i] = mx; Sat[i] = mx ? Math.round(dd * 255 / mx) : 0;
    let h = 0;
    if (dd) h = mx === R ? ((G - B) / dd) % 6 : mx === G ? (B - R) / dd + 2 : (R - G) / dd + 4;
    Hue[i] = Math.round(((h * 30) + 180) % 180);
  }
  const hist = new Uint32Array(256); let tot = 0;
  for (let i = 0; i < N; i++) if (pig[i]) { hist[V[i]]++; tot++; }
  let acc = 0, vBody = 0; for (; vBody < 255 && acc < tot / 2; vBody++) acc += hist[vBody];

  // región de búsqueda: caja de la regla (ampliada) o todo el cuerpo
  let rx0 = 0, ry0 = 0, rx1 = W - 1, ry1 = H - 1;
  if (box) {
    const ew = (box[2] - box[0]) * 0.35, eh = (box[3] - box[1]) * 0.6;
    rx0 = Math.max(0, Math.floor(box[0] - ew)); rx1 = Math.min(W - 1, Math.ceil(box[2] + ew));
    ry0 = Math.max(0, Math.floor(box[1] - eh)); ry1 = Math.min(H - 1, Math.ceil(box[3] + eh));
  }
  const k = (W * H) / 1920000, minArea = 800 * k, refArea = 4000 * k;
  const lab = new Int32Array(N), stack = new Int32Array(N);
  let best = null, bestScore = 0;
  for (let t = 235; t >= Math.max(130, vBody + 40); t -= 10) {
    lab.fill(0); let nlab = 0;
    const on = (i) => V[i] > t && Sat[i] < 60 && (pig[i] || (box && yoloMask && yoloMask[i]));
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
      const s = y * W + x;
      if (lab[s] || !on(s)) continue;
      const pts = []; let sp = 0; stack[sp++] = s; lab[s] = ++nlab;
      while (sp) {
        const q = stack[--sp]; pts.push(q);
        const qx = q % W, qy = (q / W) | 0;
        for (const [nx, ny] of [[qx - 1, qy], [qx + 1, qy], [qx, qy - 1], [qx, qy + 1]]) {
          if (nx < rx0 || nx > rx1 || ny < ry0 || ny > ry1) continue;
          const nq = ny * W + nx;
          if (!lab[nq] && on(nq)) { lab[nq] = nlab; stack[sp++] = nq; }
        }
      }
      if (pts.length < minArea) continue;
      const g = geometria(pts, W);
      const prop = g.len / Math.max(1, g.wid), fill = pts.length / (g.len * g.wid);
      if (prop < 2.3 || prop > 7.5 || fill < 0.7) continue;
      const score = Math.min(fill, 1) * Math.min(1, pts.length / refArea);
      if (score > bestScore) { bestScore = score; best = g; }
    }
  }
  let g = best, metodo = 'color';
  if (!g && yoloMask) {
    const pts = []; for (let i = 0; i < N; i++) if (yoloMask[i]) pts.push(i);
    if (pts.length > minArea / 4) { g = geometria(pts, W); metodo = 'yolo'; }
  }
  if (!g) return null;

  // extiende el largo con las esquinas de cinta café dentro de la franja de la regla
  if (metodo === 'color') {
    const ext = [];
    const xs = [g.cx + g.ax * g.lo, g.cx + g.ax * g.hi], ys = [g.cy + g.ay * g.lo, g.cy + g.ay * g.hi];
    const bx0 = Math.max(0, Math.floor(Math.min(...xs) - 0.2 * g.len)), bx1 = Math.min(W - 1, Math.ceil(Math.max(...xs) + 0.2 * g.len));
    const by0 = Math.max(0, Math.floor(Math.min(...ys) - g.wid)), by1 = Math.min(H - 1, Math.ceil(Math.max(...ys) + g.wid));
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * W + x;
      if (!(Hue[i] < 30 && Sat[i] > 50 && V[i] > vBody + 25)) continue;
      const a = (x - g.cx) * g.ax + (y - g.cy) * g.ay, b = -(x - g.cx) * g.ay + (y - g.cy) * g.ax;
      if (Math.abs(b) <= g.wid * 0.55 && a > g.lo - 0.15 * g.len && a < g.hi + 0.15 * g.len) ext.push(a);
    }
    if (ext.length > 20) {
      ext.sort((a, b) => a - b);
      g.lo = Math.min(g.lo, ext[Math.floor(ext.length * 0.02)]);
      g.hi = Math.max(g.hi, ext[Math.floor(ext.length * 0.98)]);
      g.len = g.hi - g.lo;
    }
  }
  const ends = [[g.cx + g.ax * g.lo, g.cy + g.ay * g.lo], [g.cx + g.ax * g.hi, g.cy + g.ay * g.hi]];
  return { ends, lenPx: g.len, widPx: g.wid, metodo };
}

// eje principal por PCA; largo = extensión de las proyecciones, ancho = percentiles 0.5–99.5
function geometria(pts, W) {
  let sx = 0, sy = 0;
  for (const q of pts) { sx += q % W; sy += (q / W) | 0; }
  const cx = sx / pts.length, cy = sy / pts.length;
  let xx = 0, yy = 0, xy = 0;
  for (const q of pts) { const x = q % W - cx, y = ((q / W) | 0) - cy; xx += x * x; yy += y * y; xy += x * y; }
  const th = 0.5 * Math.atan2(2 * xy, xx - yy), ax = Math.cos(th), ay = Math.sin(th);
  const A = new Float32Array(pts.length), B = new Float32Array(pts.length);
  pts.forEach((q, i) => { const x = q % W - cx, y = ((q / W) | 0) - cy; A[i] = x * ax + y * ay; B[i] = -x * ay + y * ax; });
  A.sort(); B.sort();
  const pct = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];
  const lo = A[0] - 0.5, hi = A[A.length - 1] + 0.5; // extensión completa: la mancha es conexa
  return { cx, cy, ax, ay, lo, hi, len: hi - lo, wid: pct(B, 0.995) - pct(B, 0.005) + 1 };
}
