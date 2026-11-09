/* =====================================================================
   ORQUESTA · MOTOR DE COMPOSICIÓN AUTOMÁTICA
   ---------------------------------------------------------------------
   Idea central: cada audio es una FRASE de ~1 s (≈ 2 tiempos a 120 BPM).
   El motor las coloca en una cuadrícula de «casillas» (1 casilla = 1 frase):

       r        = BPM / 120          (velocidad relativa de reproducción)
       casilla  = 1 / r  segundos    (duración de una frase)
       compás   = 2 casillas (4/4)   ·   patrón = 4 casillas = 2 compases

   Con eso todas las pistas quedan sincronizadas matemáticamente, y el golpe
   inicial de cada audio (campo «ini» del catálogo) se alinea con la rejilla.

   Pasos de componer():
     1. tempo y casilla según el estilo        4. paletas de audios por pista y sección
     2. estructura (intro, verso, estribillo…) 5. frases (motivo + variaciones + relleno)
     3. instrumentos por pista (afinidad)      6. tonalidad, memoria y huella (hash)
   ===================================================================== */
(function (G) {
  "use strict";

  const NOMBRES_NOTAS = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
  const ESC_MAYOR = [0, 2, 4, 5, 7, 9, 11], ESC_MENOR = [0, 2, 3, 5, 7, 8, 10];
  const ENTRADA = { ritmo: 0, base: 0.3, armonia: 0.25, melodia: 0.5, adorno: 0.65 };   // energía mínima para que entre cada capa
  const PAN_BASE = { ritmo: 0, base: -0.12, armonia: 0.28, melodia: -0.2, adorno: 0.38 };
  const ORDEN_PALETA = ["armonia", "base", "ritmo", "melodia", "adorno"];                 // la armonía se decide antes (ancla)
  const TAM_PALETA = { ritmo: 4, base: 3, armonia: 3, melodia: 5, adorno: 3 };
  const ROLES_NOMBRE = { ritmo: "Ritmo", base: "Base", armonia: "Armonía", melodia: "Melodía", adorno: "Adorno" };

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const gauss = (x, mu, sd) => Math.exp(-0.5 * Math.pow((x - mu) / sd, 2));
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* ───────────── Biblioteca: convierte el catálogo en objetos listos para usar ───────────── */
  class Biblioteca {
    constructor(cat, cfg) {
      this.cat = cat; this.cfg = cfg; this.estilos = cfg.estilos; this.duracion = cfg.duracion_segundos || 300;
      this.estiloIdx = {}; cat.estilos.forEach((e, i) => (this.estiloIdx[e] = i));
      this.clips = {}; this.porRuta = {}; this.inst = cat.instrumentos;
      for (const [k, rows] of Object.entries(cat.clips)) {
        this.clips[k] = rows.map((r) => {
          const c = { inst: k };
          cat.campos.forEach((n, i) => (c[n] = r[i]));
          c.chromaV = [...c.chroma].map((d) => +d / 9);
          c.estV = [...c.est].map((d) => +d / 9);
          c.num = +((/(\d+)$/.exec(c.id) || [])[1] || 0);
          this.porRuta[c.ruta] = c;
          return c;
        });
      }
    }
    activos() { return Object.keys(this.clips).filter((k) => this.clips[k].length > 0); }
  }

  /* ───────────── Compatibilidad entre notas de dos audios (chroma) ───────────── */
  function compatChroma(a, b) {
    let d = 0, na = 0, nb = 0, ch = 0;
    for (let i = 0; i < 12; i++) {
      d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
      ch += a[i] * b[(i + 1) % 12] + a[i] * b[(i + 11) % 12];            // choques de semitono
    }
    const n = Math.sqrt(na * nb) || 1;
    return clamp(d / n - 0.6 * (ch / n / 2) + 0.15, 0, 1);
  }

  /* ───────────── Puntaje de un audio para un rol/sección ───────────── */
  function puntuar(c, x) {
    let s = Math.max(0.05, c.estV[x.eIdx]);                              // compatibilidad con el estilo
    s *= 0.35 + 0.65 * gauss(c.int / 99, x.energia, 0.35);               // intensidad ↔ energía de la sección
    switch (x.rol) {
      case "ritmo": s *= 0.4 + 0.6 * (c.reg / 99) * Math.min(1, c.dens / 60); break;
      case "base": s *= 0.35 + 0.65 * Math.min(1, c.bajo / 70); break;
      case "armonia": s *= 0.4 + 0.6 * ((c.sost / 99) * 0.5 + (c.conf / 99) * 0.5); break;
      case "melodia": s *= 0.4 + 0.6 * (c.conf / 99); break;
      default: s *= 0.5 + 0.5 * (1 - clamp(c.non / 10, 0, 1));
    }
    if (c.dur < 0.5) s *= 0.6;
    s *= x.apr.clips[c.ruta] || 1;                                       // lo aprendido (👍/👎)
    if (x.anchor && (x.rol === "melodia" || x.rol === "adorno")) s *= 0.6 + 0.4 * compatChroma(c.chromaV, x.anchor);
    return s;
  }

  function muestreo(lista, k, rnd, pot) {                                // k elementos sin repetir, ponderado por puntaje^pot
    const pool = lista.map((o) => ({ o, w: Math.pow(o.s, pot) + 1e-9 })), out = [];
    while (out.length < k && pool.length) {
      let tot = pool.reduce((a, p) => a + p.w, 0), u = rnd() * tot, i = 0;
      while (i < pool.length - 1 && (u -= pool[i].w) > 0) i++;
      out.push(pool.splice(i, 1)[0].o);
    }
    return out;
  }

  /* ───────────── Frases: motivo + variaciones ───────────── */
  function generarFrase(pal, patron, rol, rnd) {
    const idx = []; let prev = -1;
    for (let i = 0; i < 4; i++) {
      if (patron[i] !== "X") { idx.push(-1); continue; }
      let k;
      if (prev < 0) k = 0;                                               // la primera casilla activa lleva el motivo principal
      else {
        const u = rnd(), rep = rol === "ritmo" ? 0.6 : 0.4;
        k = u < rep ? prev : u < rep + 0.35 ? clamp(prev + (rnd() < 0.5 ? -1 : 1), 0, pal.length - 1) : (rnd() * pal.length) | 0;
      }
      idx.push(k); prev = k;
    }
    return idx;
  }
  function mutar(frase, pal, m, rol, rnd) {
    return frase.map((k) => {
      if (k < 0 || m <= 0) return k;
      const u = rnd();
      if (u < m) return clamp(k + (rnd() < 0.5 ? -1 : 1), 0, pal.length - 1);
      if (u < m * 1.4 && (rol === "melodia" || rol === "adorno")) return -1;
      return k;
    });
  }

  /* ───────────── Estructura de la canción ───────────── */
  function planSecciones(est, total, slot, rnd) {
    const un = est.estructura, suma = un.reduce((a, s) => a + s[2], 0);
    let largos = un.map((s) => Math.max(4, Math.round((total * s[2] / suma) / 4) * 4));
    let resto = total - largos.reduce((a, b) => a + b, 0), i = 0;
    while (resto >= 4) { if (un[i % un.length][1] === "estribillo" || un[i % un.length][1] === "verso") { largos[i % un.length] += 4; resto -= 4; } i++; if (i > 400) break; }
    while (resto <= -4) { const j = largos.indexOf(Math.max(...largos)); largos[j] -= 4; resto += 4; }
    largos[largos.length - 1] += resto;                                  // el sobrante (0-3 casillas) va al final
    let s0 = 0;
    const out = un.map((s, n) => {
      const e = clamp((est.energia[s[1]] ?? 0.6) + (rnd() - 0.5) * 0.06, 0.1, 1);
      const sec = { nombre: s[0], tipo: s[1], slot0: s0, slots: largos[n], energia: e, t0: s0 * slot, t1: (s0 + largos[n]) * slot };
      s0 += largos[n]; return sec;
    });
    out.forEach((s, n) => { const sig = out[n + 1]; s.transicion = !!sig && sig.energia > s.energia + 0.12; });
    return out;
  }

  /* ───────────── Elección de instrumentos por pista ───────────── */
  function elegirInstrumentos(bib, est, estiloKey, plantillas, disponibles, apr, rnd) {
    const elegidos = [], usados = {};
    for (const pl of plantillas) {
      let cand = disponibles.filter((k) => (bib.inst[k].roles || []).includes(pl.rol));
      let penal = 1;
      if (!cand.length) { cand = disponibles.slice(); penal = 0.3; }     // si no hay instrumento con ese rol, usa cualquiera
      const pesos = cand.map((k) => {
        let w = (est.instrumentos[k] ?? est.instrumento_otro ?? 0.35) * penal;
        w *= apr.inst[estiloKey + "|" + k] || 1;
        elegidos.forEach((o) => { w *= apr.pares[[estiloKey, ...[k, o.k].sort()].join("|")] || 1; });
        w *= usados[k] ? (elegidos.some((o) => o.k === k && o.pl.rol === pl.rol) ? 0.2 : 0.5) : 1;
        return Math.pow(Math.max(w, 0.01) * (0.8 + 0.4 * rnd()), 2);
      });
      let tot = pesos.reduce((a, b) => a + b, 0), u = rnd() * tot, i = 0;
      while (i < cand.length - 1 && (u -= pesos[i]) > 0) i++;
      usados[cand[i]] = (usados[cand[i]] || 0) + 1;
      elegidos.push({ k: cand[i], pl });
    }
    return elegidos;
  }

  /* ───────────── Conjunto elegido por el usuario («Solo tambor», «piano + flauta», hasta todos) ─────────────
     Todos los instrumentos elegidos suenan. El instrumento principal (⭐) lleva la melodía y está presente
     desde la intro; los demás lo acompañan con el rol que mejor les va (ritmo, base, armonía, adorno).
     Un instrumento solo toca dos capas (principal + contracanto) para que no suene vacío. */
  const mkP = (rol, p1, p2, p3, nivel) => ({ rol, n: 1, nivel, patrones: { "1": p1, "2": p2, "3": p3 } });
  const DEF_PLANTILLA = { ritmo: mkP("ritmo", "X.X.", "XXXX", "XXXX", 1), base: mkP("base", "X...", "X.X.", "XXXX", 0.85), armonia: mkP("armonia", "X...", "X.X.", "X.XX", 0.85), melodia: mkP("melodia", "....", "XX..", "X.XX", 0.85), adorno: mkP("adorno", "....", "...X", "..XX", 0.6) };
  function asignarConjunto(bib, est, conjunto, principal) {
    const ORD = ["ritmo", "base", "armonia", "melodia", "adorno"];
    const rolesDe = (k) => { const r = (bib.inst[k].roles || []).filter((x) => ORD.includes(x)); return r.length ? r : ["armonia", "melodia"]; };
    const lead = principal && conjunto.includes(principal) ? principal : (conjunto.find((k) => rolesDe(k).includes("melodia")) || conjunto[0]);
    const orden = [lead].concat(conjunto.filter((k) => k !== lead).sort((a, b) => rolesDe(a).length - rolesDe(b).length));
    const cuenta = {}, out = [];
    const plantilla = (rol, esLead, aporte) => {
      const pl = JSON.parse(JSON.stringify(est.pistas.find((p) => p.rol === rol) || DEF_PLANTILLA[rol]));
      if (esLead) { pl.patrones = { "1": "X.X.", "2": "XXX.", "3": "XXXX" }; pl.nivel = 1; pl.entrada = 0; }
      else { pl.nivel = Math.min(pl.nivel, 0.9) * (aporte ? 0.8 : 1); pl.entrada = Math.min(ENTRADA[rol] ?? 0.3, 0.35); }
      return pl;
    };
    orden.forEach((k) => {
      const esLead = k === lead, rs = rolesDe(k);
      const rol = esLead && rs.includes("melodia") ? "melodia" : rs.slice().sort((a, b) => (cuenta[a] || 0) - (cuenta[b] || 0) || rs.indexOf(a) - rs.indexOf(b))[0];
      cuenta[rol] = (cuenta[rol] || 0) + 1;
      out.push({ k, pl: plantilla(rol, esLead, false) });
    });
    if (conjunto.length === 1) {                                         // solo: segunda capa de contracanto
      const k = conjunto[0], rs = rolesDe(k), otro = rs.find((r) => r !== out[0].pl.rol) || "adorno";
      out.push({ k, pl: plantilla(otro, false, true) });
    }
    return out;
  }

  /* ───────────── COMPONER ───────────── */
  function componer(bib, estiloKey, opts) {
    opts = opts || {};
    const est = bib.estilos[estiloKey];
    if (!est) throw new Error("Estilo desconocido: " + estiloKey);
    const apr = Object.assign({ clips: {}, pares: {}, inst: {} }, opts.aprendizaje || {});
    const semilla = (opts.semilla >>> 0) || ((Math.random() * 4294967295) >>> 0);
    const rnd = mulberry32(semilla), eIdx = bib.estiloIdx[estiloKey];
    const permitidos = opts.instrumentos && opts.instrumentos.length ? opts.instrumentos : null;
    const conjunto = (opts.conjunto || []).filter((k, i, a) => bib.activos().includes(k) && a.indexOf(k) === i);
    const exacto = conjunto.length > 0;                                  // «Elijo yo»: todos los elegidos suenan
    if ((opts.conjunto || []).length && !exacto) throw new Error("Los instrumentos elegidos no tienen audios todavía.");
    const disponibles = exacto ? conjunto : bib.activos().filter((k) => !permitidos || permitidos.includes(k));
    if (!disponibles.length) throw new Error("No hay audios disponibles para componer. Revisa las carpetas y ejecuta analizar.py.");

    // 1. tempo → casilla
    const bpm = Math.round(est.bpm[0] + (est.bpm[1] - est.bpm[0]) * rnd());
    const r = bpm / 120, slot = 1 / r, total = Math.floor(bib.duracion / slot);

    // 2. estructura
    const secciones = planSecciones(est, total, slot, rnd);

    // 3. instrumentos
    const elegidos = exacto ? asignarConjunto(bib, est, conjunto, opts.principal) : elegirInstrumentos(bib, est, estiloKey, est.pistas, disponibles, apr, rnd);
    const pistas = elegidos.map((e, i) => ({
      id: i, rol: e.pl.rol, instrumento: e.k, nombreInst: bib.inst[e.k].nombre, nivel: e.pl.nivel,
      pan: clamp((PAN_BASE[e.pl.rol] || 0) * (i % 2 ? -1 : 1) + (rnd() - 0.5) * 0.2, -0.8, 0.8),
      plantilla: e.pl, slots: new Array(total).fill(null), _pal: {}, _fr: {}, _n: {}
    }));

    // 4-5. paletas y frases, sección por sección
    function paleta(p, tipo, energia, anchor) {
      if (p._pal[tipo]) return p._pal[tipo];
      const x = { eIdx, energia, rol: p.rol, apr, anchor };
      const lista = bib.clips[p.instrumento].map((c) => ({ c, s: puntuar(c, x) }));
      const pal = muestreo(lista, Math.min(TAM_PALETA[p.rol] || 3, lista.length), rnd, 2).map((o) => o.c);
      return (p._pal[tipo] = pal);
    }
    const orden = pistas.slice().sort((a, b) => ORDEN_PALETA.indexOf(a.rol) - ORDEN_PALETA.indexOf(b.rol));
    const energiaSlot = new Array(total).fill(0.5);
    let anclaTono = null;
    secciones.forEach((sec) => {
      for (let s = sec.slot0; s < sec.slot0 + sec.slots && s < total; s++) energiaSlot[s] = sec.energia;
      const arm = orden.find((p) => p.rol === "armonia" && sec.energia >= ENTRADA.armonia);
      const anchor = arm ? paleta(arm, sec.tipo, sec.energia, null)[0].chromaV : null;
      if (!anclaTono && arm) anclaTono = paleta(arm, sec.tipo, sec.energia, null)[0];
      orden.forEach((p) => {
        if (sec.energia < (p.plantilla.entrada ?? ENTRADA[p.rol])) return;
        const lvl = sec.energia < 0.45 ? "1" : sec.energia < 0.8 ? "2" : "3";
        const patron = p.plantilla.patrones[lvl];
        const pal = paleta(p, sec.tipo, sec.energia, anchor);
        const key = sec.tipo + "|" + lvl;
        p._n[key] = (p._n[key] || 0) + 1;
        if (!p._fr[key]) p._fr[key] = generarFrase(pal, patron, p.rol, rnd);
        const base = p._fr[key].map((k) => Math.min(k, pal.length - 1));
        const frase = mutar(base, pal, p._n[key] > 1 ? 0.12 : 0, p.rol, rnd);       // verso 2 ≈ verso 1 con variaciones
        const bloques = Math.ceil(sec.slots / 4);
        for (let b = 0; b < bloques; b++) {
          const fb = b === 0 ? frase : mutar(frase, pal, b % 2 ? 0.18 : 0.06, p.rol, rnd);   // A, A', A, A'…
          for (let i = 0; i < 4; i++) {
            const s = sec.slot0 + b * 4 + i;
            if (s >= sec.slot0 + sec.slots || s >= total) break;
            const k = fb[i];
            if (k >= 0) p.slots[s] = pal[k].ruta;
          }
        }
        if (sec.transicion) {                                                          // relleno y silencio antes del cambio
          const fin = Math.min(sec.slot0 + sec.slots, total) - 1;
          if (p.rol === "ritmo") {
            const dens = bib.clips[p.instrumento].filter((c) => c.estV[eIdx] > 0.3).sort((a, b) => b.non - a.non);
            const rel = muestreo(dens.slice(0, 5).map((c) => ({ c, s: 1 })), 1, rnd, 1)[0];
            if (rel) p.slots[fin] = rel.c.ruta;
          } else if (p.rol !== "adorno" && rnd() < 0.75) p.slots[fin] = null;
        }
      });
    });

    // final: acorde/golpe de cierre en la última casilla
    const ult = total - 1;
    pistas.forEach((p) => (p.slots[ult] = null));
    const cierre = orden.find((p) => p.rol === "armonia") || orden.find((p) => p.rol === "base") || pistas[0];
    const palC = Object.values(cierre._pal)[0];
    if (palC && palC.length) cierre.slots[ult] = palC[0].ruta;
    const rit = pistas.find((p) => p.rol === "ritmo");
    if (rit && Object.values(rit._pal)[0]) rit.slots[ult] = Object.values(rit._pal)[0][0].ruta;

    // 6. tonalidad (derivada del audio ancla) y huella
    const menor = rnd() < (est.menor ?? 0.3);
    let raiz = (rnd() * 12) | 0;
    if (anclaTono && anclaTono.tono > 0 && anclaTono.conf >= 60) raiz = ((Math.round(anclaTono.tono + 12 * Math.log2(r)) % 12) + 12) % 12;
    const escala = (menor ? ESC_MENOR : ESC_MAYOR).map((n) => (n + raiz) % 12);
    const hash = hash32(pistas.map((p) => p.slots.map((x) => x || "-").join(",")).join("|") + bpm);

    pistas.forEach((p) => { delete p._pal; delete p._fr; delete p._n; });
    return {
      version: 2, semilla, estilo: estiloKey, estiloNombre: est.nombre, bpm, r, slot, totalSlots: total, duracion: bib.duracion,
      compas: "4/4", tonalidad: { raiz: NOMBRES_NOTAS[raiz], modo: menor ? "menor" : "mayor", escala },
      secciones, energia: energiaSlot, hash,
      combo: exacto ? { principal: elegidos[0].k, instrumentos: conjunto } : null,
      pistas: pistas.map((p) => ({ id: p.id, rol: p.rol, instrumento: p.instrumento, nombreInst: p.nombreInst, nivel: p.nivel, pan: p.pan, patrones: p.plantilla.patrones, slots: p.slots }))
    };
  }

  /* Genera hasta 6 intentos para no repetir una canción ya creada (historial de huellas) */
  function componerNueva(bib, estiloKey, opts, historial) {
    let c = null;
    for (let i = 0; i < 6; i++) {
      c = componer(bib, estiloKey, Object.assign({}, opts, { semilla: i === 0 ? opts.semilla : 0 }));
      if (!historial || !historial.includes(c.hash)) break;
    }
    return c;
  }

  /* ───────────── Aprendizaje: 👍 / 👎 refuerzan o debilitan combinaciones ───────────── */
  function aprender(apr, cancion, voto) {
    const f = 1 + voto * 0.15, e = cancion.estilo;
    const insts = [...new Set(cancion.pistas.map((p) => p.instrumento))];
    insts.forEach((a) => { apr.inst[e + "|" + a] = clamp((apr.inst[e + "|" + a] || 1) * f, 0.4, 2.5); });
    for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) {
      const k = [e, ...[insts[i], insts[j]].sort()].join("|");
      apr.pares[k] = clamp((apr.pares[k] || 1) * f, 0.4, 2.5);
    }
    const g = 1 + voto * 0.06;
    new Set(cancion.pistas.flatMap((p) => p.slots.filter(Boolean))).forEach((r) => { apr.clips[r] = clamp((apr.clips[r] || 1) * g, 0.5, 2); });
    return apr;
  }

  /* ───────────── Memoria: numeraciones, compás y ritmo matemático ───────────── */
  const mmss = (t) => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
  function memoria(c, bib) {
    const L = [];
    const cas = (c.slot).toFixed(3);
    L.push(`ORQUESTA · MEMORIA DE LA MELODÍA`, `Estilo: ${c.estiloNombre}   Semilla: ${c.semilla}   Huella: ${c.hash.toString(16)}`, "");
    if (c.combo) L.push(`Instrumentos elegidos (todos suenan): ${c.combo.instrumentos.map((k) => (bib.inst[k] || {}).nombre || k).join(" + ")} · principal: ${(bib.inst[c.combo.principal] || {}).nombre || c.combo.principal}`, "");
    L.push("RITMO MATEMÁTICO");
    L.push(`  Tempo: ${c.bpm} BPM  →  r = BPM/120 = ${c.r.toFixed(3)} (velocidad relativa de los audios)`);
    L.push(`  1 casilla = 1 frase de audio = 2 tiempos = 1/r = ${cas} s`);
    L.push(`  Compás ${c.compas}: 1 compás = 2 casillas = ${(2 * c.slot).toFixed(3)} s · patrón = 4 casillas = 2 compases`);
    L.push(`  Duración: ${c.totalSlots} casillas × ${cas} s = ${(c.totalSlots * c.slot).toFixed(1)} s (se recorta a ${mmss(c.duracion)})`);
    L.push(`  Tonalidad de referencia: ${c.tonalidad.raiz} ${c.tonalidad.modo}`, "");
    L.push("ESTRUCTURA");
    c.secciones.forEach((s) => L.push(`  ${mmss(s.t0).padStart(4)} – ${mmss(Math.min(s.t1, c.duracion)).padEnd(4)} ${s.nombre.padEnd(18)} ${String(s.slots / 2).padStart(5)} compases · energía ${Math.round(s.energia * 100)}%${s.transicion ? " · relleno final" : ""}`));
    L.push("", "PISTAS");
    c.pistas.forEach((p) => {
      const inf = bib.inst[p.instrumento] || {};
      L.push(`  ${ROLES_NOMBRE[p.rol]} · ${p.nombreInst} (prefijo ${inf.prefijo || "?"}) · nivel ${p.nivel} · pan ${p.pan.toFixed(2)} · patrones ${p.patrones["1"]}/${p.patrones["2"]}/${p.patrones["3"]}`);
    });
    L.push("", "NUMERACIÓN USADA (por casilla; - = silencio; | separa compases)");
    c.secciones.forEach((s) => {
      L.push(`  ▸ ${s.nombre} (casillas ${s.slot0 + 1}–${s.slot0 + s.slots})`);
      c.pistas.forEach((p) => {
        const nums = [];
        for (let i = s.slot0; i < s.slot0 + s.slots && i < c.totalSlots; i++) {
          const cl = p.slots[i] && bib.porRuta[p.slots[i]];
          nums.push(cl ? cl.id : "-");
          if ((i - s.slot0) % 2 === 1) nums.push("|");
        }
        L.push(`      ${(ROLES_NOMBRE[p.rol] + " " + p.nombreInst).padEnd(24)} ${nums.join(" ")}`);
      });
    });
    L.push("", "AUDIOS MÁS USADOS");
    c.pistas.forEach((p) => {
      const cuenta = {};
      p.slots.filter(Boolean).forEach((r) => { const id = (bib.porRuta[r] || {}).id || r; cuenta[id] = (cuenta[id] || 0) + 1; });
      const top = Object.entries(cuenta).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}×${n}`);
      L.push(`  ${(ROLES_NOMBRE[p.rol] + " " + p.nombreInst).padEnd(24)} ${top.length} audios distintos: ${top.slice(0, 14).join(", ")}${top.length > 14 ? " …" : ""}`);
    });
    return L.join("\n");
  }

  G.Orquesta = G.Orquesta || {};
  Object.assign(G.Orquesta, { Biblioteca, componer, asignarConjunto, componerNueva, aprender, memoria, compatChroma, mmss, NOMBRES_NOTAS, ROLES_NOMBRE });
  if (typeof module !== "undefined") module.exports = G.Orquesta;
})(typeof window !== "undefined" ? window : globalThis);
