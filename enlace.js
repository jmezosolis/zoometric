// Celular como cámara de la computadora (igual que en Entometría y Fitometría).
//
// La computadora muestra un QR con la dirección de la app y un código; el celular que lo abre
// manda su video en vivo. Las fotos se toman a la máxima resolución del celular y llegan a la
// lista como si se hubieran cargado: se piden desde la computadora («Tomar foto») o se disparan
// desde el celular («Tomar foto y mandar»), útil junto al animal con la compu lejos.
// La conexión es directa entre los dos (WebRTC); el servidor gratuito de PeerJS solo sirve para
// que se encuentren. PeerJS (MIT) y el generador de QR (MIT) van en vendor/ para usarse sin internet.

const PREFIJO = 'zoometric-';

let cargaPeerJS = null;
function cargarPeerJS() {
  cargaPeerJS ??= new Promise((ok, mal) => {
    if (window.Peer) return ok(window.Peer);
    const s = document.createElement('script');
    s.src = './vendor/peerjs-1.5.5/peerjs.min.js';
    s.onload = () => ok(window.Peer || window.peerjs?.Peer);
    s.onerror = () => { cargaPeerJS = null; mal(new Error('No se pudo cargar PeerJS')); };
    document.head.appendChild(s);
  });
  return cargaPeerJS;
}

async function crearPeer(id) {
  const Peer = await cargarPeerJS();
  return new Promise((ok, mal) => {
    const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
    peer.once('open', () => ok(peer));
    peer.once('error', mal);
  });
}

function nuevoCodigo() {
  const letras = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(8))].map((v) => letras[v % letras.length]).join('');
}

const TEXTO_CONEXION = {
  'misma-red': 'Conexión directa en la misma red: la más rápida.',
  internet: 'Conexión directa por internet.',
  servidor: 'Conexión por un servidor de paso: más lenta. Conecte los dos al mismo WiFi para que sea directa.',
};

/** Qué camino tomó el video: directo en la misma red, directo por internet o por un servidor de paso. */
async function tipoDeConexion(pc) {
  if (!pc) return null;
  for (let intento = 0; intento < 10; intento++) {
    const stats = await pc.getStats();
    let local = null;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) local = stats.get(r.selectedCandidatePairId)?.localCandidateId ?? local;
    });
    if (!local) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && !local) local = r.localCandidateId; });
    const c = local && stats.get(local);
    if (c) return c.candidateType === 'relay' ? 'servidor' : c.candidateType === 'host' ? 'misma-red' : 'internet';
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return null;
}

function nombreDeFoto() {
  const t = new Date(), dd = (n) => String(n).padStart(2, '0');
  return `foto_celular_${t.getFullYear()}${dd(t.getMonth() + 1)}${dd(t.getDate())}_${dd(t.getHours())}${dd(t.getMinutes())}${dd(t.getSeconds())}.jpg`;
}

const ESTILO = `
.enl-fondo { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.6); }
.enl-tarjeta { width: min(420px, 100%); max-height: calc(100% - 24px); overflow: auto; display: grid; gap: 10px; padding: 18px; background: var(--panel); border-radius: 10px; }
.enl-tarjeta h2 { margin: 0; font-size: 17px; color: var(--accent); text-transform: none; letter-spacing: 0; }
.enl-tarjeta ol { margin: 0; padding-left: 20px; line-height: 1.5; }
.enl-qr { justify-self: center; width: min(260px, 70vw); padding: 8px; background: #fff; border-radius: 8px; }
.enl-qr svg { display: block; width: 100%; height: auto; }
.enl-aviso { margin: 0; padding: 8px 10px; border-radius: 6px; background: #e6f2eb; color: #155724; font-size: 13px; }
.enl-aviso.alerta { background: #fff3cd; color: #6b4a00; }
.enl-botones { display: flex; flex-wrap: wrap; gap: 6px; }
.enl-botones > * { flex: 1; text-align: center; text-decoration: none; }
.enl-vista { position: fixed; right: 12px; bottom: 12px; z-index: 900; width: min(320px, 70vw); display: grid; gap: 6px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
.enl-vista video { width: 100%; border-radius: 6px; background: #000; }
.enl-vista small { color: var(--muted); }
.enl-camara { position: fixed; inset: 0; z-index: 2000; display: flex; flex-direction: column; background: #000; }
.enl-camara video { flex: 1; min-height: 0; width: 100%; object-fit: contain; }
.enl-camara .enl-barra { display: grid; gap: 8px; padding: 10px 12px calc(12px + env(safe-area-inset-bottom)); background: var(--panel); }
.enl-camara .grande { min-height: 52px; font-size: 18px; }
`;

function ponerEstilo() {
  if (document.getElementById('enlaceEstilo')) return;
  const s = document.createElement('style');
  s.id = 'enlaceEstilo';
  s.textContent = ESTILO;
  document.head.appendChild(s);
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- computadora ----------

let pc = null; // el enlace activo de esta computadora

/** Abre (o vuelve a mostrar) el enlace. `alRecibir(file)` recibe cada foto del celular. */
export async function abrirEnlace({ alRecibir, avisar }) {
  ponerEstilo();
  if (pc) { pc.mostrarPanel(); return; }
  pc = crearEnlacePC(alRecibir, avisar);
  await pc.iniciar();
}

function crearEnlacePC(alRecibir, avisar) {
  let peer = null, datos = null, llamada = null, codigo = null, panel = null, vista = null;
  const estado = { mensaje: 'Preparando el enlace…', alerta: false, conexion: null };

  function pintarPanel() {
    if (!panel) return;
    panel.querySelector('.enl-mensaje').textContent = estado.mensaje;
    panel.querySelector('.enl-mensaje').className = 'enl-aviso enl-mensaje' + (estado.alerta ? ' alerta' : '');
    const c = panel.querySelector('.enl-conexion');
    c.hidden = !estado.conexion;
    if (estado.conexion) { c.textContent = TEXTO_CONEXION[estado.conexion]; c.className = 'enl-aviso enl-conexion' + (estado.conexion === 'servidor' ? ' alerta' : ''); }
  }
  function decir(mensaje, alerta = false) {
    estado.mensaje = mensaje; estado.alerta = alerta;
    pintarPanel();
    if (vista) vista.querySelector('small').textContent = mensaje;
    avisar?.(mensaje);
  }

  async function mostrarPanel() {
    if (panel) return;
    const url = `${location.origin}${location.pathname}?enlace=${codigo}`;
    let qr = '';
    try {
      const { default: qrcode } = await import('./vendor/qrcode-generator-2.0.4/qrcode.js');
      const q = qrcode(0, 'M'); q.addData(url); q.make();
      qr = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch { qr = ''; }
    panel = el(`<div class="enl-fondo" role="dialog" aria-label="Enlazar el celular">
      <div class="enl-tarjeta">
        <h2>Celular como cámara</h2>
        <div class="enl-qr"></div>
        <ol>
          <li>Abra la cámara del celular (o Google Lens) y escanee el código.</li>
          <li>Abra el enlace y permita la cámara.</li>
          <li>Tome las fotos desde aquí o desde el celular: llegan a la lista.</li>
        </ol>
        <p class="hint">Código: <strong class="enl-codigo"></strong> · Los dos necesitan internet; en la misma red WiFi el video va directo y más rápido.</p>
        <p class="enl-aviso enl-mensaje"></p>
        <p class="enl-aviso enl-conexion" hidden></p>
        <div class="enl-botones"><button class="enl-cerrar">Cerrar</button><button class="enl-desenlazar">Desenlazar</button></div>
      </div></div>`);
    panel.querySelector('.enl-qr').innerHTML = qr;
    panel.querySelector('.enl-codigo').textContent = codigo;
    panel.addEventListener('click', (e) => { if (e.target === panel) cerrarPanel(); });
    panel.querySelector('.enl-cerrar').onclick = cerrarPanel;
    panel.querySelector('.enl-desenlazar').onclick = () => { cerrarPanel(); terminar(); };
    document.body.appendChild(panel);
    pintarPanel();
  }
  function cerrarPanel() { panel?.remove(); panel = null; }

  function mostrarVista(flujo) {
    vista?.remove();
    vista = el(`<div class="enl-vista">
      <video autoplay muted playsinline></video>
      <small></small>
      <div class="enl-botones"><button class="primary enl-foto">Tomar foto</button><button class="enl-fin">Desenlazar</button></div>
    </div>`);
    vista.querySelector('video').srcObject = flujo;
    vista.querySelector('small').textContent = estado.mensaje;
    vista.querySelector('.enl-foto').onclick = () => {
      if (!datos?.open) return decir('El celular no está enlazado.', true);
      decir('El celular está tomando la foto en alta resolución…');
      datos.send({ tipo: 'pedirFoto', n: 1 });
    };
    vista.querySelector('.enl-fin').onclick = terminar;
    document.body.appendChild(vista);
  }

  function celularPerdido() {
    llamada?.close(); datos?.close(); llamada = datos = null;
    vista?.remove(); vista = null;
    estado.conexion = null;
    decir('El celular se desconectó. Puede volver a escanear el código («Celular como cámara»).', true);
  }

  function terminar() {
    llamada?.close(); datos?.close(); peer?.destroy();
    vista?.remove(); cerrarPanel();
    peer = datos = llamada = vista = null;
    pc = null;
    avisar?.('');
  }

  async function iniciar() {
    codigo = nuevoCodigo();
    try {
      peer = await crearPeer(PREFIJO + codigo);
    } catch (e) {
      pc = null;
      avisar?.(`No se pudo preparar el enlace: ${e.message || e}. Necesita internet.`);
      return;
    }
    await mostrarPanel();
    decir('Escanee el código con el celular.');
    peer.on('connection', (conn) => {
      if (datos?.open) { conn.close(); return; }
      datos = conn;
      conn.on('data', (m) => {
        if (m?.tipo === 'foto') {
          alRecibir(new File([m.datos], nombreDeFoto(), { type: 'image/jpeg' }));
          decir(`Foto del celular recibida (${m.ancho} × ${m.alto}).`);
        } else if (m?.tipo === 'error') decir(`El celular no pudo tomar la foto: ${m.texto}`, true);
      });
      conn.on('close', () => { if (datos === conn) celularPerdido(); });
    });
    peer.on('call', (l) => {
      llamada?.close();
      llamada = l;
      l.answer();
      l.on('stream', (flujo) => {
        cerrarPanel();
        mostrarVista(flujo);
        decir('Celular enlazado: tome las fotos aquí o desde el celular.');
        tipoDeConexion(l.peerConnection).then((t) => {
          if (llamada !== l || !t) return;
          estado.conexion = t;
          decir(`Celular enlazado. ${TEXTO_CONEXION[t]}`, t === 'servidor');
        });
      });
      // El aviso de cierre puede no llegar (el celular se apagó o perdió la red): se vigila la conexión.
      let espera;
      l.peerConnection?.addEventListener('connectionstatechange', () => {
        const estadoPc = l.peerConnection.connectionState;
        if (llamada !== l) return;
        clearTimeout(espera);
        if (estadoPc === 'failed' || estadoPc === 'closed') celularPerdido();
        else if (estadoPc === 'disconnected') espera = setTimeout(() => { if (llamada === l && l.peerConnection.connectionState !== 'connected') celularPerdido(); }, 4000);
      });
    });
    peer.on('disconnected', () => peer.reconnect());
    peer.on('error', (e) => {
      if (datos?.open) return decir(`Aviso del enlace: ${e.message}. La conexión con el celular sigue.`);
      decir(`El enlace falló: ${e.message}. Revise que la computadora tenga internet.`, true);
    });
  }

  return { iniciar, mostrarPanel, terminar };
}

// ---------- celular ----------

/** Toma la foto más grande que dé la cámara: con ImageCapture si existe, si no, el cuadro del video. */
async function fotoDe(pista, video) {
  if (window.ImageCapture) {
    try {
      const blob = await new ImageCapture(pista).takePhoto();
      const img = await createImageBitmap(blob);
      const r = { blob, ancho: img.width, alto: img.height };
      img.close();
      return r;
    } catch { /* algunas cámaras no dejan tomar foto mientras transmiten: se usa el cuadro del video */ }
  }
  const l = document.createElement('canvas');
  l.width = video.videoWidth; l.height = video.videoHeight;
  l.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((ok, mal) => l.toBlob((b) => (b ? ok(b) : mal(new Error('Sin foto'))), 'image/jpeg', 0.92));
  return { blob, ancho: l.width, alto: l.height };
}

/** La app abierta desde el QR: solo la cámara del celular, a pantalla completa. */
export function modoCamara(codigo) {
  ponerEstilo();
  const ui = el(`<div class="enl-camara">
    <video muted playsinline></video>
    <div class="enl-barra">
      <p class="enl-aviso alerta enl-estado" role="status">Abriendo la cámara…</p>
      <small class="hint enl-conexion" hidden></small>
      <label class="enl-zoom" hidden>Zoom <output></output><input type="range"></label>
      <button class="primary grande enl-mandar" disabled>Tomar foto y mandar</button>
      <div class="enl-botones">
        <button class="enl-cambiar">Cambiar cámara</button>
        <button class="enl-reintentar" hidden>Reintentar</button>
        <a class="btn" href="${location.pathname}">Salir del modo cámara</a>
      </div>
      <small class="hint">Deje el celular quieto, apoyado o en un soporte. Las fotos llegan a la lista de la computadora.</small>
    </div></div>`);
  document.body.appendChild(ui);
  const video = ui.querySelector('video');
  const $e = (s) => ui.querySelector(s);
  let flujo = null, llamada = null, datos = null, lado = 'environment', fotos = 0;
  const estado = (texto, bien = false) => { $e('.enl-estado').textContent = texto + (fotos ? ` · ${fotos} foto${fotos === 1 ? '' : 's'}` : ''); $e('.enl-estado').className = 'enl-aviso enl-estado' + (bien ? '' : ' alerta'); };

  async function abrirCamara() {
    flujo?.getTracks().forEach((p) => p.stop());
    flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: lado }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false });
    video.srcObject = flujo;
    await video.play().catch(() => {});
    const pista = flujo.getVideoTracks()[0];
    const z = (pista.getCapabilities?.() ?? {}).zoom;
    const control = $e('.enl-zoom');
    control.hidden = !(z && z.max > z.min);
    if (!control.hidden) {
      const r = control.querySelector('input');
      r.min = z.min; r.max = z.max; r.step = z.step || 0.1; r.value = z.min;
      control.querySelector('output').textContent = Number(z.min).toFixed(1) + '×';
      r.oninput = async () => {
        try { await pista.applyConstraints({ advanced: [{ zoom: Number(r.value) }] }); control.querySelector('output').textContent = Number(r.value).toFixed(1) + '×'; } catch { /* la cámara no aceptó ese zoom */ }
      };
    }
    const emisor = llamada?.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
    if (emisor) await emisor.replaceTrack(pista);
  }

  async function mandarFoto(n) {
    if (!datos?.open) return;
    estado('Tomando la foto…', true);
    try {
      const { blob, ancho, alto } = await fotoDe(flujo.getVideoTracks()[0], video);
      datos.send({ tipo: 'foto', n, datos: await blob.arrayBuffer(), ancho, alto });
      fotos++;
      estado(`Foto enviada (${ancho} × ${alto}).`, true);
    } catch (e) {
      datos.send({ tipo: 'error', n, texto: e.message || String(e) });
      estado('No se pudo tomar la foto.');
    }
  }

  async function arrancar() {
    try {
      await abrirCamara();
    } catch (e) {
      $e('.enl-reintentar').hidden = false;
      return estado(`No se pudo abrir la cámara: ${e.message || e}. Permita la cámara y presione Reintentar.`);
    }
    $e('.enl-reintentar').hidden = true;
    navigator.wakeLock?.request('screen').catch(() => {});
    estado('Conectando con la computadora…');
    try {
      const peer = await crearPeer();
      const destino = PREFIJO + codigo;
      datos = peer.connect(destino, { reliable: true, serialization: 'binary' });
      peer.on('disconnected', () => peer.reconnect());
      // Al cerrar la app o la pestaña se avisa a la computadora en vez de dejarla esperando.
      window.addEventListener('pagehide', () => { datos?.close(); peer.destroy(); });
      datos.on('open', () => {
        llamada = peer.call(destino, flujo);
        $e('.enl-mandar').disabled = false;
        estado('Enlazado: la computadora ve esta cámara.', true);
        llamada.peerConnection?.addEventListener('connectionstatechange', () => {
          if (llamada.peerConnection.connectionState !== 'connected') return;
          tipoDeConexion(llamada.peerConnection).then((t) => { if (t) { $e('.enl-conexion').hidden = false; $e('.enl-conexion').textContent = TEXTO_CONEXION[t]; } });
        });
      });
      datos.on('data', (m) => { if (m?.tipo === 'pedirFoto') mandarFoto(m.n); });
      datos.on('close', () => { $e('.enl-mandar').disabled = true; estado('La computadora cerró el enlace.'); });
      peer.on('error', (e) => {
        $e('.enl-mandar').disabled = true;
        estado(e.type === 'peer-unavailable' ? 'No se encontró la computadora: vuelva a escanear el código que muestra ahora.' : `El enlace falló: ${e.message}`);
      });
    } catch (e) {
      estado(`No se pudo conectar: ${e.message || e}. Revise el internet del celular.`);
    }
  }

  $e('.enl-mandar').onclick = () => mandarFoto(0);
  $e('.enl-reintentar').onclick = arrancar;
  $e('.enl-cambiar').onclick = () => {
    lado = lado === 'environment' ? 'user' : 'environment';
    abrirCamara().catch(() => estado('No se pudo cambiar de cámara.'));
  };
  arrancar();
}
