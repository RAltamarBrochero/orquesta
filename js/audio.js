/* =====================================================================
   ORQUESTA · MOTOR DE AUDIO (Web Audio)
   ---------------------------------------------------------------------
   · Carga solo los audios que usa la canción (con caché) y los decodifica.
   · Programa cada frase en su casilla alineando el golpe inicial a la rejilla.
   · Cadena de mezcla:  pista → pan → bus → [eco] [reverb] → ecualizador
                        → compresor → limitador → fundido final → salida
   · Efectos: eco, reverb, retro (reversa en las transiciones), autotune
     (ajuste fino de tono a la escala), sonido HD (EQ + compresión + límite).
   · Reproducción en vivo (con pausa y salto) y render completo (WAV / MP3).
   ===================================================================== */
(function (G) {
  "use strict";

  const OBJ_RMS = 0.12;                           // volumen objetivo de cada frase (iguala todos los audios)
  const ENVIOS = {                                // [eco, reverb] por rol
    ritmo: [0.04, 0.08], base: [0.03, 0.06], armonia: [0.12, 0.2], melodia: [0.3, 0.25], adorno: [0.35, 0.3]
  };

  /* ───────────── utilidades ───────────── */
  function crearIR(ctx, seg, decay) {                                     // respuesta de impulso sintética para la reverb
    const n = Math.floor(ctx.sampleRate * seg), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      for (let i = 0; i < n; i++) { lp += 0.35 * ((Math.random() * 2 - 1) - lp); d[i] = lp * Math.pow(1 - i / n, decay); }
    }
    return b;
  }
  function invertir(ctx, buf) {                                           // copia del audio al revés (efecto retro)
    const o = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) o.getChannelData(c).set(Array.from(buf.getChannelData(c)).reverse());
    return o;
  }
  /* Autotune: lleva el tono efectivo del audio a la nota más cercana de la escala (máx. ±60 centésimas) */
  function centsAutotune(clip, r, escala) {
    if (!(clip.tono > 0) || clip.conf < 70) return 0;                     // solo audios con tono claro
    const eff = clip.tono + 12 * Math.log2(r);
    let mejor = null;
    for (let k = -2; k <= 2; k++) {
      const m = Math.round(eff) + k;
      if (escala.includes(((m % 12) + 12) % 12)) { const d = m - eff; if (mejor === null || Math.abs(d) < Math.abs(mejor)) mejor = d; }
    }
    return mejor === null ? 0 : Math.max(-60, Math.min(60, mejor * 100));
  }
  const pasos = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ───────────── cadena de mezcla ───────────── */
  function montarGrafo(ctx, c, opt) {
    const g = { pistas: [] };
    const nodo = (t, f) => { const n = ctx.createBiquadFilter(); n.type = t; n.frequency.value = f; return n; };
    g.master = ctx.createGain(); g.master.gain.value = 0.62;
    g.hp = nodo("highpass", 30); g.low = nodo("lowshelf", 120); g.mud = nodo("peaking", 280); g.mud.Q.value = 1;
    g.pres = nodo("peaking", 3200); g.pres.Q.value = 0.9; g.air = nodo("highshelf", 9000);
    g.comp = ctx.createDynamicsCompressor(); g.comp.threshold.value = -18; g.comp.knee.value = 14; g.comp.attack.value = 0.012; g.comp.release.value = 0.22;
    g.make = ctx.createGain();
    g.lim = ctx.createDynamicsCompressor(); g.lim.threshold.value = -3; g.lim.knee.value = 0; g.lim.ratio.value = 20; g.lim.attack.value = 0.002; g.lim.release.value = 0.08;
    g.soft = ctx.createWaveShaper(); g.soft.oversample = "2x";                 // recorte suave: nunca pasa de ±1 (sin chasquidos)
    { const n = 2048, cur = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 4 - 2, a = Math.abs(x); cur[i] = a <= 0.75 ? x : Math.sign(x) * (0.75 + 0.25 * Math.tanh((a - 0.75) / 0.25)); }
      g.soft.curve = cur; }
    g.fade = ctx.createGain();
    [g.master, g.hp, g.low, g.mud, g.pres, g.air, g.comp, g.make, g.lim, g.soft, g.fade, ctx.destination].reduce((a, b) => (a.connect(b), b));
    // eco sincronizado con el tempo (corchea con puntillo) y reverb
    const beat = 60 / c.bpm;
    g.ecoIn = ctx.createGain(); g.eco = ctx.createDelay(2); g.eco.delayTime.value = Math.min(1.9, 0.75 * beat);
    const fb = ctx.createGain(); fb.gain.value = 0.38; const fl = nodo("lowpass", 3000);
    g.ecoOut = ctx.createGain();
    g.ecoIn.connect(g.eco); g.eco.connect(fl); fl.connect(fb); fb.connect(g.eco); g.eco.connect(g.ecoOut); g.ecoOut.connect(g.master);
    g.revIn = ctx.createGain(); g.rev = ctx.createConvolver(); g.rev.buffer = crearIR(ctx, 2.2, 3.2); g.revOut = ctx.createGain();
    g.revIn.connect(g.rev); g.rev.connect(g.revOut); g.revOut.connect(g.master);
    // pistas
    c.pistas.forEach((p) => {
      const inn = ctx.createGain(); inn.gain.value = p.nivel;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = p.pan; inn.connect(pan); }
      const bus = pan || inn;
      bus.connect(g.master);
      const se = ctx.createGain(), sr = ctx.createGain(), e = ENVIOS[p.rol] || [0.1, 0.1];
      se.gain.value = e[0]; sr.gain.value = e[1];
      bus.connect(se); se.connect(g.ecoIn); bus.connect(sr); sr.connect(g.revIn);
      g.pistas.push({ in: inn });
    });
    aplicarOpciones(g, opt);
    return g;
  }
  function aplicarOpciones(g, opt) {                                       // se puede llamar en vivo
    const hd = !!opt.hd;
    g.hp.frequency.value = hd ? 35 : 10;
    g.low.gain.value = hd ? 1.5 : 0; g.mud.gain.value = hd ? -1.5 : 0; g.pres.gain.value = hd ? 2 : 0; g.air.gain.value = hd ? 2 : 0;
    g.comp.ratio.value = hd ? 3.5 : 2; g.make.gain.value = hd ? 1.25 : 1.05;
    g.ecoOut.gain.value = opt.eco ? 0.9 : 0; g.revOut.gain.value = opt.reverb ? 0.55 : 0;
  }

  /* ───────────── lista de eventos (cuándo suena cada frase) ───────────── */
  function construirEventos(c, bib, opt, buffers) {
    const ev = [], r = c.r;
    c.pistas.forEach((p, pi) => {
      const idxs = []; p.slots.forEach((x, s) => { if (x && buffers.has(x)) idxs.push(s); });
      idxs.forEach((s, n) => {
        const ruta = p.slots[s], clip = bib.porRuta[ruta]; if (!clip) return;
        const rate = r * (opt.autotune ? Math.pow(2, centsAutotune(clip, r, c.tonalidad.escala) / 1200) : 1);
        const adel = Math.min(clip.ini / rate, 0.12);                       // el golpe inicial cae justo en la casilla
        let t = s * c.slot - adel, off = 0;
        if (t < 0) { off = -t * rate; t = 0; }
        const dur = clip.dur / rate - off / rate;
        const sig = n + 1 < idxs.length ? idxs[n + 1] * c.slot - Math.min(bib.porRuta[p.slots[idxs[n + 1]]].ini / rate, 0.12) : Infinity;
        const fin = Math.min(t + dur, sig + 0.012);                          // una pista suena de a una frase: la nueva corta la anterior
        const norm = Math.max(0.35, Math.min(2.2, OBJ_RMS / Math.max(clip.rms, 1e-4)));
        const vol = Math.min(norm, 1.2 / Math.max(clip.pico, 0.05)) * (0.55 + 0.45 * c.energia[s]);
        ev.push({ t, off, fin, rate, vol, ruta, pista: pi, rev: false });
      });
    });
    if (opt.retro) {                                                         // retro: golpe invertido que «absorbe» hacia el cambio de sección
      c.secciones.forEach((sec) => {
        if (!sec.transicion) return;
        const fin = sec.slot0 + sec.slots - 1;
        for (const rol of ["melodia", "armonia", "ritmo", "base"]) {
          const pi = c.pistas.findIndex((p) => p.rol === rol); if (pi < 0) continue;
          let s = fin; while (s >= sec.slot0 && !(c.pistas[pi].slots[s] && buffers.has(c.pistas[pi].slots[s]))) s--;
          if (s < sec.slot0) continue;
          const ruta = c.pistas[pi].slots[s], clip = bib.porRuta[ruta], d = Math.min(clip.dur / c.r, c.slot);
          const tb = (sec.slot0 + sec.slots) * c.slot;
          ev.push({ t: Math.max(0, tb - d), off: 0, fin: tb, rate: c.r, vol: 0.55 * Math.min(1.2 / Math.max(clip.pico, 0.05), OBJ_RMS / Math.max(clip.rms, 1e-4)), ruta, pista: pi, rev: true, reversa: true });
          break;
        }
      });
    }
    return ev.sort((a, b) => a.t - b.t);
  }

  function programar(ctx, g, e, buffers, revCache, t0ctx) {                   // crea y agenda una fuente de audio
    let buf = buffers.get(e.ruta);
    if (e.reversa) { if (!revCache.has(e.ruta)) revCache.set(e.ruta, invertir(ctx, buf)); buf = revCache.get(e.ruta); }
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = e.rate;
    const gn = ctx.createGain(), a = t0ctx + e.t, b = t0ctx + e.fin;
    gn.gain.setValueAtTime(0, a); gn.gain.linearRampToValueAtTime(e.vol, a + 0.004);
    gn.gain.setValueAtTime(e.vol, Math.max(a + 0.005, b - 0.014)); gn.gain.linearRampToValueAtTime(0, b);
    src.connect(gn); gn.connect(g.pistas[e.pista].in);
    src.start(a, e.reversa ? Math.max(0, buf.duration - (e.fin - e.t) * e.rate) : e.off); src.stop(b + 0.02);
    return src;
  }
  function fundir(g, dur, ahora, origen, desde) {                            // fundido de salida de los últimos 5 s
    const f = g.fade.gain, fin = origen + dur, ini = fin - 5;
    f.cancelScheduledValues(0);
    if (desde >= dur - 5) { f.setValueAtTime(Math.max(0, (dur - desde) / 5), ahora); }
    else { f.setValueAtTime(1, ahora); f.setValueAtTime(1, ini); }
    f.linearRampToValueAtTime(0, fin);
  }

  /* ───────────── carga de audios ───────────── */
  async function cargarBuffers(ctx, rutas, cache, onProg) {
    const pend = [...new Set(rutas)].filter((r) => !cache.has(r)); let hechos = 0, fallos = 0;
    const cola = pend.slice();
    async function obrero() {
      while (cola.length) {
        const r = cola.shift();
        try {
          const resp = await fetch(encodeURI(r)); if (!resp.ok) throw new Error(resp.status);
          cache.set(r, await ctx.decodeAudioData(await resp.arrayBuffer()));
        } catch (e) { fallos++; }
        hechos++; onProg && onProg(hechos, pend.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, obrero));
    return fallos;
  }

  /* ───────────── reproductor en vivo ───────────── */
  class Reproductor {
    constructor() { this.ctx = null; this.buffers = new Map(); this.revCache = new Map(); this.estado = "parado"; this.fuentes = []; this.onFin = null; this.opt = {}; }
    async iniciar() {
      if (!this.ctx) this.ctx = new (G.AudioContext || G.webkitAudioContext)({ latencyHint: "playback" });
      if (this.ctx.state === "suspended") await this.ctx.resume();
    }
    async cargar(c, onProg) {
      await this.iniciar();
      const rutas = c.pistas.flatMap((p) => p.slots.filter(Boolean));
      return cargarBuffers(this.ctx, rutas, this.buffers, onProg);
    }
    poner(c, bib, opt) { this.c = c; this.bib = bib; this.opt = Object.assign({}, opt); }
    reproducir(desde) {
      desde = desde || 0; this.parar(false);
      const ctx = this.ctx, c = this.c;
      this.g = montarGrafo(ctx, c, this.opt);
      this.ev = construirEventos(c, this.bib, this.opt, this.buffers);
      this.origen = ctx.currentTime + 0.15 - desde;
      this.i = this.ev.findIndex((e) => e.t >= desde); if (this.i < 0) this.i = this.ev.length;
      fundir(this.g, c.duracion, ctx.currentTime, this.origen, desde);
      this.estado = "sonando";
      this.timer = setInterval(() => this.tick(), 100); this.tick();
    }
    tick() {
      const ctx = this.ctx, ahora = ctx.currentTime - this.origen;
      while (this.i < this.ev.length && this.ev[this.i].t <= ahora + 2.5) {
        const e = this.ev[this.i++];
        if (e.t + 0.02 < ahora) continue;
        const s = programar(ctx, this.g, e, this.buffers, this.revCache, this.origen);
        this.fuentes.push(s); s.onended = () => { const k = this.fuentes.indexOf(s); if (k >= 0) this.fuentes.splice(k, 1); };
      }
      if (ahora >= this.c.duracion + 0.3) { this.parar(true); }
    }
    pausar() { if (this.estado === "sonando") { this.ctx.suspend(); this.estado = "pausa"; } }
    async reanudar() { if (this.estado === "pausa") { await this.ctx.resume(); this.estado = "sonando"; } }
    parar(fin) {
      clearInterval(this.timer);
      this.fuentes.forEach((s) => { try { s.stop(); } catch (e) { /* ya terminó */ } }); this.fuentes = [];
      if (this.g) { try { this.g.master.disconnect(); this.g.ecoOut.disconnect(); this.g.revOut.disconnect(); this.g.fade.disconnect(); } catch (e) { /* nada */ } this.g = null; }
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
      const antes = this.estado; this.estado = "parado";
      if (fin && antes !== "parado" && this.onFin) this.onFin();
    }
    tiempo() { return this.estado === "parado" || !this.ctx ? 0 : Math.max(0, Math.min(this.c.duracion, this.ctx.currentTime - this.origen)); }
    saltar(t) { if (this.estado === "parado") return; const pausado = this.estado === "pausa"; if (pausado) this.ctx.resume(); this.reproducir(t); }
    opciones(opt) {                                                         // eco, reverb y HD cambian en vivo; retro/autotune reprograman
      const cambia = this.opt.retro !== opt.retro || this.opt.autotune !== opt.autotune;
      this.opt = Object.assign({}, opt);
      if (this.g) aplicarOpciones(this.g, this.opt);
      if (cambia && this.estado !== "parado") this.saltar(this.tiempo());
    }
  }

  /* ───────────── render completo y exportación ───────────── */
  async function renderizar(c, bib, opt, buffers, onProg) {
    const OAC = G.OfflineAudioContext || G.webkitOfflineAudioContext, sr = 44100;
    const ctx = new OAC(2, Math.round(sr * c.duracion), sr);
    const g = montarGrafo(ctx, c, opt), rc = new Map();
    construirEventos(c, bib, opt, buffers).forEach((e) => programar(ctx, g, e, buffers, rc, 0));
    fundir(g, c.duracion, 0, 0, 0);
    onProg && onProg("Mezclando 5 minutos de audio…");
    const out = await ctx.startRendering();
    let pk = 0, ss = 0, nn = 0;                                              // normaliza: volumen cómodo (≈ -15 dBFS RMS) sin pasar de 0.95 de pico
    for (let ch = 0; ch < out.numberOfChannels; ch++) { const d = out.getChannelData(ch); for (let i = 0; i < d.length; i++) { const v = d[i], a = Math.abs(v); if (a > pk) pk = a; ss += v * v; nn++; } }
    const rms = Math.sqrt(ss / Math.max(1, nn));
    if (pk > 0.01) { const k = Math.min(0.95 / pk, 0.18 / Math.max(rms, 1e-4)); for (let ch = 0; ch < out.numberOfChannels; ch++) { const d = out.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= k; } }
    return out;
  }
  function aWav(buf) {
    const n = buf.length, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const dv = new DataView(new ArrayBuffer(44 + n * 4)), w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
    w(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true); dv.setUint32(24, buf.sampleRate, true); dv.setUint32(28, buf.sampleRate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    w(36, "data"); dv.setUint32(40, n * 4, true);
    for (let i = 0, o = 44; i < n; i++, o += 4) {
      dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); dv.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    return new Blob([dv], { type: "audio/wav" });
  }
  function cargarScript(src) {
    return new Promise((ok, mal) => { if (G.lamejs) return ok(); const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => mal(new Error("No se encontró " + src)); document.head.appendChild(s); });
  }
  async function aMp3(buf, onProg) {
    await cargarScript("lib/lame.min.js");
    const enc = new G.lamejs.Mp3Encoder(2, buf.sampleRate, 192), out = [], B = 1152 * 20;
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = buf.length;
    const i16 = (a, s, e) => { const o = new Int16Array(e - s); for (let i = s; i < e; i++) o[i - s] = Math.max(-1, Math.min(1, a[i])) * 32767; return o; };
    for (let s = 0, k = 0; s < n; s += B, k++) {
      const e = Math.min(n, s + B), d = enc.encodeBuffer(i16(L, s, e), i16(R, s, e)); if (d.length) out.push(new Uint8Array(d));
      if (k % 20 === 0) { onProg && onProg(s / n); await pasos(0); }
    }
    const f = enc.flush(); if (f.length) out.push(new Uint8Array(f));
    return new Blob(out, { type: "audio/mpeg" });
  }

  G.Orquesta = G.Orquesta || {};
  Object.assign(G.Orquesta, { Reproductor, renderizar, aWav, aMp3, cargarBuffers, construirEventos, montarGrafo, centsAutotune });
  if (typeof module !== "undefined") module.exports = G.Orquesta;
})(typeof window !== "undefined" ? window : globalThis);
