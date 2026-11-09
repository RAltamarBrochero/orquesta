/* =====================================================================
   ORQUESTA · INTERFAZ
   Une el catálogo (catalogo.json), el motor de composición (motor.js)
   y el motor de audio (audio.js). No usa internet.
   ===================================================================== */
(function () {
  "use strict";
  const O = window.Orquesta, $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  const EFECTOS = [
    ["eco", "Eco", "Repeticiones suaves, sincronizadas con el tempo"],
    ["reverb", "Reverb", "Sensación de sala"],
    ["retro", "Retro", "Golpe invertido que anuncia cada cambio de sección"],
    ["autotune", "Autotune", "Afina los audios con tono claro a la escala de la canción"],
    ["hd", "Sonido HD", "Ecualizador, compresión y límite para un sonido claro y limpio"]
  ];

  let bib = null, cfg = null, cat = null, cancion = null, estilo = null, ocupado = false, ultimoRender = null;
  const rep = new O.Reproductor();
  let opts = Object.assign({ eco: false, reverb: true, retro: false, autotune: false, hd: true }, LS.get("orq_opts", {}));
  const apr = Object.assign({ clips: {}, pares: {}, inst: {} }, LS.get("orq_apr", {}));
  let historial = LS.get("orq_hist", []);
  const instOff = new Set(LS.get("orq_instoff", []));
  let mio = Object.assign({ activo: false, sel: [], principal: null }, LS.get("orq_combo", {}));      // modo «Elijo yo»

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function estado(t, tipo) { const e = $("estado"); e.textContent = t; e.className = tipo || ""; }
  function bajar(blob, nombre) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nombre; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  const nombreArchivo = () => `orquesta_${cancion.estilo}_${cancion.bpm}bpm_${cancion.semilla}`;

  /* ───────────── arranque ───────────── */
  async function iniciar() {
    if (location.protocol === "file:") $("avisoServidor").hidden = false;
    try {
      const [c, f] = await Promise.all([
        fetch("catalogo.json?" + Date.now()).then((r) => { if (!r.ok) throw new Error("catalogo.json"); return r.json(); }),
        fetch("config/estilos.json").then((r) => r.json())
      ]);
      cat = c; cfg = f; bib = new O.Biblioteca(cat, cfg);
    } catch (e) {
      $("resumenBib").textContent = "No se pudo leer catalogo.json. Ejecuta primero: python analizar.py (y abre la app con iniciar.bat).";
      return;
    }
    pintarTodo();
    $("crear").disabled = false;
  }
  function pintarTodo() { resumen(); pintarEstilos(); pintarEfectos(); pintarInstrumentos(); pintarCombo(); pintarBiblioteca(); pintarMelodias(); }
  function resumen() {
    const act = Object.values(cat.instrumentos).filter((i) => i.activos > 0), tot = act.reduce((a, i) => a + i.activos, 0);
    $("resumenBib").textContent = `${act.length} instrumentos con audios · ${tot} sonidos activos · ${cat.descartados.length} descartados · capacidad ${cat.capacidad} por instrumento`;
  }

  /* ───────────── estilo, efectos, instrumentos ───────────── */
  function pintarEstilos() {
    const box = $("chipsEstilo"); box.innerHTML = "";
    const mk = (k, txt) => { const b = document.createElement("button"); b.className = "chip" + (estilo === k ? " on" : ""); b.textContent = txt; b.onclick = () => { estilo = estilo === k ? null : k; pintarEstilos(); }; box.appendChild(b); };
    Object.entries(cfg.estilos).forEach(([k, s]) => mk(k, s.nombre));
    const sor = document.createElement("span"); sor.className = "sub"; sor.style.alignSelf = "center";
    sor.textContent = estilo ? "" : "(sin elegir = estilo sorpresa 🎲)"; box.appendChild(sor);
  }
  function pintarEfectos() {
    $("efectos").innerHTML = EFECTOS.map(([k, n, d]) => `<label title="${esc(d)}"><input type="checkbox" data-k="${k}" ${opts[k] ? "checked" : ""}> ${n}</label>`).join("");
  }
  $("efectos").onchange = (e) => {
    const k = e.target.dataset.k; if (!k) return;
    opts[k] = e.target.checked; LS.set("orq_opts", opts); ultimoRender = null;
    if (cancion) rep.opciones(opts);
  };
  function pintarInstrumentos() {
    const box = $("chipsInst"); box.innerHTML = "";
    Object.entries(cat.instrumentos).forEach(([k, i]) => {
      const b = document.createElement("button"), vivo = i.activos > 0;
      b.className = "chip" + (vivo && !instOff.has(k) ? " on" : "") + (vivo ? "" : " vacio");
      b.textContent = i.nombre + (vivo ? ` (${i.activos})` : " · sin audios");
      b.onclick = () => { if (!vivo) return; instOff.has(k) ? instOff.delete(k) : instOff.add(k); LS.set("orq_instoff", [...instOff]); pintarInstrumentos(); };
      box.appendChild(b);
    });
  }
  /* ───────────── solo o combinación de instrumentos ───────────── */
  const vivos = () => Object.entries(cat.instrumentos).filter(([, i]) => i.activos > 0).map(([k]) => k);
  const nombreInst = (k) => (cat.instrumentos[k] || {}).nombre || k;
  const guardarMio = () => LS.set("orq_combo", mio);
  function pintarCombo() {
    const v = vivos();
    mio.sel = mio.sel.filter((k) => v.includes(k));
    if (!mio.sel.includes(mio.principal)) mio.principal = mio.sel[0] || null;
    $("modoAuto").classList.toggle("on", !mio.activo); $("modoMio").classList.toggle("on", mio.activo);
    $("panelAuto").hidden = mio.activo; $("panelMio").hidden = !mio.activo;
    const grid = $("gridMio"); grid.innerHTML = "";
    Object.entries(cat.instrumentos).forEach(([k, i]) => {
      const b = document.createElement("button"), vivo = i.activos > 0, on = mio.sel.includes(k);
      b.className = "chip" + (on ? " on" : "") + (vivo ? "" : " vacio") + (on && k === mio.principal ? " lead" : "");
      b.textContent = (on && k === mio.principal ? "⭐ " : on ? "✓ " : "") + i.nombre + (vivo ? "" : " · próximamente");
      b.onclick = () => {
        if (!vivo) return;
        on ? (mio.sel = mio.sel.filter((x) => x !== k)) : mio.sel.push(k);
        guardarMio(); pintarCombo();
      };
      grid.appendChild(b);
    });
    const solo = $("soloBtns"); solo.innerHTML = "";
    v.forEach((k) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = nombreInst(k); b.onclick = () => { mio.sel = [k]; mio.principal = k; guardarMio(); pintarCombo(); }; solo.appendChild(b); });
    const sp = $("selPrincipal");
    sp.innerHTML = mio.sel.length ? mio.sel.map((k) => `<option value="${k}" ${k === mio.principal ? "selected" : ""}>${esc(nombreInst(k))}</option>`).join("") : '<option value="">(elige instrumentos)</option>';
    const ac = $("acompBtns"); ac.innerHTML = "";
    for (let n = 1; n <= v.length - 1; n++) {
      const b = document.createElement("button"); b.className = "chip"; b.textContent = n === v.length - 1 ? `todos (${n})` : String(n);
      b.onclick = () => {
        const p = mio.principal && v.includes(mio.principal) ? mio.principal : v[(Math.random() * v.length) | 0];
        const otros = v.filter((k) => k !== p).sort(() => Math.random() - 0.5).slice(0, n);
        mio.sel = [p, ...otros]; mio.principal = p; guardarMio(); pintarCombo();
      };
      ac.appendChild(b);
    }
    $("resumenCombo").textContent = mio.sel.length
      ? "Combinación: " + mio.sel.map((k) => (k === mio.principal ? "⭐ " : "") + nombreInst(k)).join(" + ") + ` (${mio.sel.length} de ${v.length})`
      : "Aún no elegiste instrumentos.";
  }
  $("modoAuto").onclick = () => { mio.activo = false; guardarMio(); pintarCombo(); };
  $("modoMio").onclick = () => { mio.activo = true; guardarMio(); pintarCombo(); };
  $("selPrincipal").onchange = (e) => { if (e.target.value) { mio.principal = e.target.value; guardarMio(); pintarCombo(); } };

  const instSel = () => { const v = Object.entries(cat.instrumentos).filter(([k, i]) => i.activos > 0 && !instOff.has(k)).map(([k]) => k); return v; };

  /* ───────────── CREAR MÚSICA ───────────── */
  $("crear").onclick = crear;
  async function crear() {
    if (ocupado) return; ocupado = true; $("crear").disabled = true;
    try {
      rep.parar(false); ultimoRender = null;
      const sel = instSel();
      if (mio.activo && !mio.sel.length) throw new Error("Toca al menos un instrumento en «Elijo yo», o vuelve a «La orquesta decide».");
      if (!mio.activo && !sel.length) throw new Error("Activa al menos un instrumento con audios.");
      const k = estilo || Object.keys(cfg.estilos)[(Math.random() * Object.keys(cfg.estilos).length) | 0];
      const semilla = +$("semilla").value || 0;
      estado("Componiendo la estructura…");
      await new Promise((r) => setTimeout(r, 30));
      const pedido = mio.activo ? { semilla, conjunto: mio.sel.slice(), principal: mio.principal, aprendizaje: apr } : { semilla, instrumentos: sel, aprendizaje: apr };
      cancion = O.componerNueva(bib, k, pedido, semilla ? null : historial);
      historial.push(cancion.hash); historial = historial.slice(-300); LS.set("orq_hist", historial);
      await prepararYSonar();
    } catch (e) { estado("✖ " + e.message, "err"); }
    ocupado = false; $("crear").disabled = false;
  }
  async function prepararYSonar(sonar = true) {
    mostrarCancion();
    estado("Cargando sonidos…");
    const fallos = await rep.cargar(cancion, (h, t) => estado(`Cargando sonidos ${h}/${t}…`));
    rep.poner(cancion, bib, opts);
    estado(fallos ? `Lista (${fallos} audios no se pudieron cargar y quedan en silencio).` : "✔ Melodía lista: 5:00 de música original.", fallos ? "" : "ok");
    if (sonar) { rep.reproducir(0); bucle(); }
    refrescarBotones();
  }
  function mostrarCancion() {
    $("reproductor").hidden = false; $("cardMemoria").hidden = false;
    $("tituloCancion").textContent = `${cancion.estiloNombre} · ${cancion.bpm} BPM · ${cancion.tonalidad.raiz} ${cancion.tonalidad.modo} · ${cancion.compas}`;
    $("subCancion").textContent = `Semilla ${cancion.semilla} · ${cancion.combo ? "Combinación elegida: " : ""}${cancion.pistas.map((p) => p.nombreInst).filter((v, i, a) => a.indexOf(v) === i).join(" + ")}`;
    $("memoria").textContent = O.memoria(cancion, bib);
    $("barra").max = cancion.duracion; $("barra").value = 0;
  }

  /* ───────────── reproductor ───────────── */
  function refrescarBotones() { const e = rep.estado; $("btnPlay").textContent = e === "sonando" ? "⏸ Pausa" : e === "pausa" ? "▶ Continuar" : "▶ Reproducir"; }
  $("btnPlay").onclick = async () => {
    if (!cancion) return;
    if (rep.estado === "sonando") rep.pausar();
    else if (rep.estado === "pausa") await rep.reanudar();
    else { await rep.iniciar(); rep.poner(cancion, bib, opts); rep.reproducir(0); bucle(); }
    refrescarBotones();
  };
  $("btnStop").onclick = () => { rep.parar(false); $("barra").value = 0; $("tiempo").textContent = "0:00 / 5:00"; refrescarBotones(); };
  rep.onFin = () => { $("barra").value = 0; refrescarBotones(); estado("Fin de la melodía.", "ok"); };
  let arrastrando = false;
  $("barra").oninput = () => { arrastrando = true; $("tiempo").textContent = O.mmss(+$("barra").value) + " / " + O.mmss(cancion.duracion); };
  $("barra").onchange = () => { arrastrando = false; if (rep.estado !== "parado") rep.saltar(+$("barra").value); };
  function bucle() {
    if (rep.estado === "parado") return;
    if (!arrastrando) { const t = rep.tiempo(); $("barra").value = t; $("tiempo").textContent = O.mmss(t) + " / " + O.mmss(cancion.duracion); }
    requestAnimationFrame(bucle);
  }

  /* ───────────── aprendizaje ───────────── */
  function votar(v) {
    if (!cancion) return;
    O.aprender(apr, cancion, v); LS.set("orq_apr", apr);
    estado(v > 0 ? "👍 Aprendido: la orquesta usará más estas combinaciones." : "👎 Aprendido: la orquesta evitará más estas combinaciones.", "ok");
  }
  $("btnLike").onclick = () => votar(1);
  $("btnDislike").onclick = () => votar(-1);

  /* ───────────── guardar / descargar ───────────── */
  const empaquetar = (c) => {
    const tabla = [...new Set(c.pistas.flatMap((p) => p.slots.filter(Boolean)))];
    return Object.assign({}, c, { energia: undefined, tabla, pistas: c.pistas.map((p) => Object.assign({}, p, { slots: p.slots.map((x) => (x ? tabla.indexOf(x) : -1)) })) });
  };
  const desempaquetar = (p) => {
    const c = Object.assign({}, p, { pistas: p.pistas.map((q) => Object.assign({}, q, { slots: q.slots.map((i) => (i >= 0 ? p.tabla[i] : null)) })) });
    c.energia = new Array(c.totalSlots).fill(0.5);
    c.secciones.forEach((s) => { for (let i = s.slot0; i < s.slot0 + s.slots && i < c.totalSlots; i++) c.energia[i] = s.energia; });
    delete c.tabla; return c;
  };
  $("btnGuardar").onclick = () => {
    if (!cancion) return;
    const lista = LS.get("orq_melodias", []), f = new Date();
    lista.unshift({ id: Date.now(), nombre: `${cancion.estiloNombre} · ${cancion.bpm} BPM · ${f.toLocaleDateString()} ${f.toLocaleTimeString().slice(0, 5)}`, datos: empaquetar(cancion) });
    if (!LS.set("orq_melodias", lista.slice(0, 60))) { estado("No hay espacio en el navegador: descarga la receta (.json).", "err"); return; }
    pintarMelodias(); estado("💾 Melodía guardada en «Mis melodías guardadas».", "ok");
  };
  $("btnRepetir").onclick = () => { if (cancion) { $("semilla").value = cancion.semilla; estado("Semilla copiada: pulsa CREAR MÚSICA para repetir esta canción.", "ok"); } };
  $("btnDescargar").onclick = async () => {
    if (!cancion) return;
    const f = $("formato").value, n = nombreArchivo(), pr = $("progDesc");
    try {
      if (f === "memoria") return bajar(new Blob([O.memoria(cancion, bib)], { type: "text/plain" }), n + "_memoria.txt");
      if (f === "receta") return bajar(new Blob([JSON.stringify(empaquetar(cancion))], { type: "application/json" }), n + "_receta.json");
      $("btnDescargar").disabled = true; pr.hidden = false; pr.firstElementChild.style.width = "10%";
      await rep.cargar(cancion);
      const clave = cancion.hash + JSON.stringify(opts);
      if (!ultimoRender || ultimoRender.clave !== clave) {
        estado("Mezclando 5 minutos de audio con tus efectos…");
        await new Promise((r) => setTimeout(r, 30));
        ultimoRender = { clave, buf: await O.renderizar(cancion, bib, opts, rep.buffers, estado) };
      }
      pr.firstElementChild.style.width = "55%";
      if (f === "wav") bajar(O.aWav(ultimoRender.buf), n + ".wav");
      else { estado("Codificando MP3…"); bajar(await O.aMp3(ultimoRender.buf, (p) => (pr.firstElementChild.style.width = 55 + p * 45 + "%")), n + ".mp3"); }
      estado("⬇ Descarga lista.", "ok");
    } catch (e) { estado("✖ No se pudo generar el audio: " + e.message, "err"); }
    $("btnDescargar").disabled = false; pr.hidden = true;
  };
  $("copiarMem").onclick = () => { navigator.clipboard && navigator.clipboard.writeText($("memoria").textContent); estado("Memoria copiada.", "ok"); };
  $("bajarMem").onclick = () => cancion && bajar(new Blob([O.memoria(cancion, bib)], { type: "text/plain" }), nombreArchivo() + "_memoria.txt");

  /* ───────────── mis melodías ───────────── */
  function pintarMelodias() {
    const lista = LS.get("orq_melodias", []), box = $("misMelodias");
    box.innerHTML = lista.length ? lista.map((m) => `<div class="mel"><b>${esc(m.nombre)}</b><button data-a="play" data-id="${m.id}">▶ Abrir</button><button data-a="json" data-id="${m.id}">Receta</button><button data-a="del" data-id="${m.id}">🗑</button></div>`).join("")
      : '<p class="sub">Aún no hay melodías guardadas. Crea una y pulsa «Guardar melodía».</p>';
  }
  $("misMelodias").onclick = async (e) => {
    const a = e.target.dataset.a; if (!a) return;
    let lista = LS.get("orq_melodias", []); const m = lista.find((x) => String(x.id) === e.target.dataset.id); if (!m) return;
    if (a === "del") { lista = lista.filter((x) => x !== m); LS.set("orq_melodias", lista); pintarMelodias(); }
    else if (a === "json") bajar(new Blob([JSON.stringify(m.datos)], { type: "application/json" }), "orquesta_receta.json");
    else if (!ocupado) { ocupado = true; try { rep.parar(false); cancion = desempaquetar(m.datos); ultimoRender = null; await prepararYSonar(); } catch (er) { estado("✖ " + er.message, "err"); } ocupado = false; }
  };

  /* ───────────── biblioteca ───────────── */
  function pintarBiblioteca() {
    const ins = Object.entries(cat.instrumentos).sort((a, b) => (b[1].activos > 0) - (a[1].activos > 0) || a[1].nombre.localeCompare(b[1].nombre));
    $("biblioteca").innerHTML = ins.map(([k, i]) => {
      const pct = Math.min(100, (100 * i.activos) / i.capacidad);
      const det = i.activos > 0
        ? `${i.activos}/${i.capacidad} activos${i.descartados ? ` · ${i.descartados} descartados` : ""}${i.faltantes ? ` · faltan ${i.faltantes} números` : ""}`
        : `esperando audios: ${i.prefijo || (i.carpeta || "")}1, ${i.prefijo || ""}2, …`;
      return `<div class="inst ${i.activos ? "" : "pend"}"><div><b>${esc(i.nombre)}</b><br><small>carpeta ${esc(i.carpeta)}/ · prefijo ${esc(i.prefijo || "—")}</small></div><div class="bar"><i style="width:${Math.max(pct, i.activos ? 1.5 : 0)}%"></i></div><small>${det}</small></div>`;
    }).join("");
    const d = cat.descartados;
    $("descartados").innerHTML = d.length ? `<table><tr><th>Instrumento</th><th>Archivo</th><th>Motivo</th></tr>${d.slice(0, 300).map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])} · ${esc(r[3])}</td></tr>`).join("")}</table>${d.length > 300 ? `<p class="sub">…y ${d.length - 300} más (ver reporte_analisis.txt)</p>` : ""}` : '<p class="sub">Ninguno.</p>';
  }
  $("btnActualizar").onclick = async () => {
    const m = $("msgActualizar"); m.textContent = "Analizando audios nuevos… (puede tardar)"; $("btnActualizar").disabled = true;
    try {
      const r = await fetch("/api/escanear", { method: "POST" }); if (!r.ok) throw new Error("sin servidor");
      const j = await r.json(); m.textContent = j.ok ? "✔ " + j.log.slice(-1)[0] : "✖ " + j.error;
      if (j.ok) { cat = await (await fetch("catalogo.json?" + Date.now())).json(); bib = new O.Biblioteca(cat, cfg); pintarTodo(); }
    } catch (e) { m.textContent = "Abre la app con iniciar.bat (servidor) o ejecuta: python analizar.py"; }
    $("btnActualizar").disabled = false;
  };

  iniciar();
})();
