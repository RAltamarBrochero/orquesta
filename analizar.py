#!/usr/bin/env python3
"""
ORQUESTA · analizador de audios
================================
Recorre las carpetas de instrumentos, analiza cada audio con matemática de señal
(sin internet, sin IA externa) y genera:

    catalogo.json          -> lo que lee la aplicación para componer
    reporte_analisis.txt   -> resumen legible: faltantes, descartados, mejores por estilo

Qué calcula por audio:
    duración · inicio del ataque · volumen (RMS y pico) · intensidad (suave/media/fuerte)
    · golpes (onsets) y ritmo (sostenido / golpe / regular / sincopado / denso) · velocidad
    · brillo (centroide espectral) · graves/agudos · ruido · ataque/caída/sostenimiento
    · tono (YIN) y huella de notas (chroma) · huella digital para detectar copias
    · compatibilidad 0-9 con cada estilo (rock, pop, balada, cumbia, ...)

Descarta (sin borrar nada, solo los marca): vacíos, casi mudos, ilegibles, copias exactas
y casi idénticas dentro de cada instrumento. Con --mover los guarda en _descartados/.

Uso:
    python analizar.py                 analiza (solo lo nuevo o modificado)
    python analizar.py --forzar        vuelve a analizar todo
    python analizar.py --mover         además mueve los descartados a _descartados/
"""
import argparse
import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

SR = 22050                                   # frecuencia de análisis
EXT = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"}
RAIZ = Path(__file__).resolve().parent
IGNORAR = {"js", "css", "lib", "config", "node_modules", "venv", ".venv", "__pycache__", "static",
           "img", "assets", "docs", ".git", ".vscode"}
UMBRAL_MUDO_RMS = 0.004                      # por debajo, el audio "no suena"
UMBRAL_COPIA = 0.997                         # similitud de huella para "casi idéntico"
VERSION = 2

RITMOS = ["sostenido", "golpe", "regular", "sincopado", "denso"]
VELS = ["lenta", "media", "rapida"]
ESTILOS_ORDEN = ["rock", "pop", "balada", "cumbia", "merengue", "charanga", "clasica", "jazz", "salsa", "cristiana"]
CAMPOS = ["id", "ruta", "dur", "ini", "rms", "pico", "int", "rit", "vel", "bril", "bajo", "alto", "plano",
          "ataque", "caida", "sost", "non", "reg", "dens", "tono", "conf", "cents", "chroma", "est"]


def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    return re.sub(r"[^a-z0-9]+", "_", "".join(c for c in s if unicodedata.category(c) != "Mn")).strip("_")


# ───────────────────────── lectura y análisis de un audio ─────────────────────────
def decodificar(ruta):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(ruta), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def stft(x, n, hop):
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    v = np.lib.stride_tricks.sliding_window_view(x, n)[::hop]
    return np.abs(np.fft.rfft(v * np.hanning(n), axis=1))


def yin(x, sr, fmin=70, fmax=1500):
    """Tono por diferencia normalizada (YIN) en la ventana más fuerte. Devuelve (f0, confianza)."""
    W, tmax = 1536, int(sr / fmin)
    if len(x) < W + tmax + 10:
        return 0.0, 0.0
    e = np.convolve(x * x, np.ones(W) / W, "valid")[: len(x) - W - tmax]
    if len(e) == 0 or e.max() < 1e-7:
        return 0.0, 0.0
    i = int(np.argmax(e))
    s = x[i: i + W + tmax].astype(np.float64)
    a = s[:W]
    nfft = 1 << int(math.ceil(math.log2(W + tmax)) + 1)
    cc = np.fft.irfft(np.conj(np.fft.rfft(a, nfft)) * np.fft.rfft(s, nfft), nfft)[: tmax + 1]
    cs = np.concatenate([[0], np.cumsum(s * s)])
    d = np.array([cs[W] + (cs[W + t] - cs[t]) - 2 * cc[t] for t in range(tmax + 1)])
    cm = np.ones_like(d)
    cm[1:] = d[1:] * np.arange(1, tmax + 1) / np.maximum(np.cumsum(d[1:]), 1e-12)
    tmin = max(2, int(sr / fmax))
    t = -1
    for k in range(tmin, tmax):
        if cm[k] < 0.15:
            while k + 1 < tmax and cm[k + 1] < cm[k]:
                k += 1
            t = k
            break
    if t < 0:
        k = tmin + int(np.argmin(cm[tmin:tmax]))
        if cm[k] < 0.3:
            t = k
    if t < 0:
        return 0.0, float(max(0, 1 - cm[tmin:tmax].min()))
    tt = float(t)
    if 1 < t < tmax - 1:
        a1, b1, c1 = cm[t - 1], cm[t], cm[t + 1]
        den = a1 - 2 * b1 + c1
        if den > 1e-9:
            tt += (a1 - c1) / (2 * den)
    return sr / tt, float(1 - cm[t])


def analizar_audio(x):
    """Todas las características de un audio (array float32 mono a SR)."""
    dur = len(x) / SR
    out = {"dur": round(dur, 3)}
    if len(x) < int(0.02 * SR):
        return {**out, "ilegible": True}
    pico = float(np.abs(x).max())
    rms = float(np.sqrt(np.mean(x ** 2)))
    out["pico"], out["rms"] = round(pico, 4), round(rms, 5)
    # envolvente (10 ms, paso 5 ms)
    w, h = int(SR * .010), int(SR * .005)
    env = np.sqrt(np.mean(np.lib.stride_tricks.sliding_window_view(np.pad(x, (0, w)), w)[::h] ** 2, axis=1))
    emax = float(env.max())
    activo = float((env > 10 ** (-50 / 20)).sum() * .005)
    out["activo"] = round(activo, 3)
    if pico < 0.003 or emax < 1e-4:
        return {**out, "mudo": True}
    ini = int(np.argmax(env > 0.1 * emax))
    pk = int(np.argmax(env))
    post = np.where(env[pk:] < 0.1 * emax)[0]
    out["ini"] = round(ini * .005, 3)
    out["ataque"] = round(max(0, pk - ini) * .005 * 1000)
    out["caida"] = round((post[0] if len(post) else len(env) - pk) * .005 * 1000)
    seg = env[ini:]
    out["sost"] = round(float((seg > 0.3 * emax).mean()) * 99)
    # espectro por ventanas (n=1024) → golpes y color
    mag = stft(x, 1024, 256)
    lm = np.log1p(10 * mag)
    flux = np.maximum(0, np.diff(lm, axis=0)).sum(axis=1)
    flux = np.convolve(flux, np.ones(2) / 2, "same")
    thr = 0.3 * flux.max() if flux.max() > 0 else 1
    picos = [i for i in range(1, len(flux) - 1)
             if flux[i] > thr and flux[i] >= flux[i - 1] and flux[i] > flux[i + 1]]
    ons = []
    for i in picos:
        if not ons or (i - ons[-1]) * 256 / SR > 0.06:
            ons.append(i)
    tons = [round((i + 1) * 256 / SR, 3) for i in ons] or [out["ini"]]
    out["onsets"] = tons[:16]
    ioi = np.diff(tons)
    out["reg"] = round(float(max(0, 1 - np.std(ioi) / (np.mean(ioi) + 1e-9)) * 99)) if len(ioi) >= 2 else 50
    out["ioi"] = round(float(np.median(ioi)), 3) if len(ioi) else 0
    # color del sonido (zona activa)
    fr = np.fft.rfftfreq(1024, 1 / SR)
    ms = (np.arange(len(mag)) * 256 + 512) / SR
    sel = np.array([env[min(len(env) - 1, int(t / .005))] > 0.1 * emax for t in ms])
    esp = (mag[sel] if sel.any() else mag).mean(axis=0)
    pw = esp ** 2 + 1e-12
    tot = pw.sum()
    out["bril"] = round(float((fr * esp).sum() / (esp.sum() + 1e-12)))
    out["bajo"] = round(float(pw[fr < 250].sum() / tot) * 99)
    out["alto"] = round(float(pw[fr > 2000].sum() / tot) * 99)
    b = (fr >= 100) & (fr <= 8000)
    out["plano"] = round(float(np.exp(np.mean(np.log(pw[b]))) / np.mean(pw[b])) * 99)
    # tono y notas (chroma)
    f0, conf = yin(x, SR)
    out["tono"] = round(69 + 12 * math.log2(f0 / 440), 2) if f0 > 0 else -1
    out["conf"] = round(conf * 99)
    out["cents"] = round(((out["tono"] - round(out["tono"])) * 100)) if f0 > 0 else 0
    big = stft(x, 4096, 2048).mean(axis=0)
    fb = np.fft.rfftfreq(4096, 1 / SR)
    ch = np.zeros(12)
    mx = big.max() + 1e-12
    for k in range(1, len(big) - 1):
        if 55 < fb[k] < 2200 and big[k] > 0.08 * mx and big[k] >= big[k - 1] and big[k] > big[k + 1]:
            a1, b1, c1 = big[k - 1], big[k], big[k + 1]
            den = a1 - 2 * b1 + c1
            fk = fb[k] + (0.5 * (a1 - c1) / den if abs(den) > 1e-12 else 0) * (fb[1] - fb[0])
            pc = int(round(69 + 12 * math.log2(fk / 440))) % 12
            ch[pc] += (b1 / mx) ** 2
    if ch.sum() > 0:
        ch = ch / ch.max()
    out["chroma"] = "".join(str(min(9, int(v * 9.99))) for v in ch)
    # huella digital: 8 tramos × 16 bandas
    bordes = np.geomspace(100, 8000, 17)
    sub = stft(x[int(out["ini"] * SR):], 1024, 128)
    if len(sub) < 8:
        sub = np.pad(sub, ((0, 8 - len(sub)), (0, 0)))
    tr = np.array_split(sub, 8)
    v = np.array([[np.log1p(100 * (t[:, (fr >= bordes[j]) & (fr < bordes[j + 1])] ** 2).mean()) for j in range(16)] for t in tr])
    v = (v - v.mean()).ravel()
    v = v / (np.linalg.norm(v) + 1e-9)
    out["fp"] = base64.b64encode(np.round(v * 127).astype(np.int8).tobytes()).decode()
    return out


def tarea(args):
    rel, ruta = args
    try:
        x = decodificar(ruta)
        d = analizar_audio(x) if len(x) else {"ilegible": True, "dur": 0}
        d["md5"] = hashlib.md5(Path(ruta).read_bytes()).hexdigest()
        return rel, d
    except Exception as e:  # noqa: BLE001
        return rel, {"ilegible": True, "error": str(e)}


# ───────────────────────── escaneo de carpetas ─────────────────────────
def cargar_json(ruta, defecto):
    try:
        return json.loads(Path(ruta).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return defecto


def numero(stem):
    m = re.search(r"(\d+)$", stem)
    return int(m.group(1)) if m else None


def prefijo(stem):
    return re.sub(r"[\s_\-]*\d+$", "", stem).lower()


def escanear(cfg):
    """Devuelve {clave_instrumento: {info, archivos:[(rel, abs)]}} y crea carpetas de instrumentos pendientes."""
    reg = cfg["instrumentos"]
    mapa = {norm(c): k for k, v in reg.items() for c in v.get("carpetas", []) + [k]}
    res = {}
    for k, v in reg.items():                              # estructura lista para instrumentos futuros
        carpeta = RAIZ / v["carpetas"][0]
        if not carpeta.exists():
            carpeta.mkdir(parents=True, exist_ok=True)
            (carpeta / "LEEME.txt").write_text(
                f"Carpeta de {v['nombre']}.\nMete aquí los audios numerados: {v['prefijos'][0]}1.mp3, {v['prefijos'][0]}2.mp3, "
                f"{v['prefijos'][0]}3.mp3 ... hasta {cfg.get('capacidad', 2500)}.\nLuego ejecuta:  python analizar.py\n", encoding="utf-8")
    for d in sorted(p for p in RAIZ.iterdir() if p.is_dir()):
        if d.name.startswith(("_", ".")) or d.name in IGNORAR:
            continue
        archivos = sorted(f for f in d.rglob("*") if f.is_file() and f.suffix.lower() in EXT)
        k = mapa.get(norm(d.name))
        if not k and not archivos:
            continue
        if not k:
            k = norm(d.name)
            reg[k] = {"nombre": d.name.replace("_", " ").title(), "carpetas": [d.name], "prefijos": [], "roles": [], "detectado": True}
        info = res.setdefault(k, {"archivos": [], "carpetas": []})
        info["carpetas"].append(d.name)
        info["archivos"] += [(f.relative_to(RAIZ).as_posix(), f) for f in archivos]
    for k in reg:
        res.setdefault(k, {"archivos": [], "carpetas": [reg[k]["carpetas"][0]]})
    return res


# ───────────────────────── compatibilidad con estilos ─────────────────────────
def ajuste(x, mu, sd):
    return math.exp(-0.5 * ((x - mu) / max(sd, 1e-6)) ** 2)


def puntuar_estilos(c, inst, estilos):
    """Puntaje 0-9 por estilo = afinidad del instrumento × cercanía del audio al perfil acústico del estilo."""
    out = []
    dens = c["non"] / max(c["activo"], 0.2)
    caract = {"int": c["int"] / 99, "bril": c["bril"], "dens": dens, "reg": c["reg"] / 99,
              "tono": max(0, c["conf"] / 99) if c["tono"] > 0 else 0, "sost": c["sost"] / 99, "bajo": c["bajo"] / 99}
    for e in ESTILOS_ORDEN:
        s = estilos.get(e)
        if not s:
            out.append(0)
            continue
        prior = s.get("instrumentos", {}).get(inst, s.get("instrumento_otro", 0.35))
        perfil = s.get("perfil", {})
        num = den = 0
        for campo, (mu, sd, peso) in perfil.items():
            num += peso * ajuste(caract[campo], mu, sd)
            den += peso
        fit = num / den if den else 0.5
        out.append(min(9, int(round(9 * prior * (0.35 + 0.65 * fit)))))
    return "".join(map(str, out))


# ───────────────────────── programa principal ─────────────────────────
def rangos(nums):
    nums = sorted(nums)
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}-{nums[j]}")
        i = j + 1
    return ", ".join(out) if out else "ninguno"


def principal(forzar=False, mover=False, log=print):
    t0 = time.time()
    if not shutil.which("ffmpeg"):
        raise SystemExit("Falta FFmpeg. Instálalo (winget install Gyan.FFmpeg) y vuelve a ejecutar.")
    cfg = cargar_json(RAIZ / "config" / "instrumentos.json", {"capacidad": 2500, "instrumentos": {}})
    estilos = cargar_json(RAIZ / "config" / "estilos.json", {}).get("estilos", {})
    cap = cfg.get("capacidad", 2500)
    esc = escanear(cfg)
    reg = cfg["instrumentos"]
    cache_p = RAIZ / "_cache_analisis.json"
    cache = {} if forzar else cargar_json(cache_p, {})
    pend = []
    for k, info in esc.items():
        for rel, ab in info["archivos"]:
            st = ab.stat()
            firma = [st.st_size, st.st_mtime_ns, VERSION]
            if cache.get(rel, {}).get("firma") != firma:
                pend.append((rel, ab))
    log(f"Audios encontrados: {sum(len(i['archivos']) for i in esc.values())} · por analizar: {len(pend)}")
    if pend:
        with ProcessPoolExecutor() as ex:
            for n, (rel, d) in enumerate(ex.map(tarea, pend, chunksize=8), 1):
                st = (RAIZ / rel).stat()
                cache[rel] = {"firma": [st.st_size, st.st_mtime_ns, VERSION], "d": d}
                if n % 50 == 0 or n == len(pend):
                    log(f"  analizados {n}/{len(pend)}")
        cache_p.write_text(json.dumps(cache), encoding="utf-8")

    catalogo = {"version": VERSION, "generado": time.strftime("%Y-%m-%d %H:%M:%S"), "capacidad": cap,
                "campos": CAMPOS, "estilos": ESTILOS_ORDEN, "instrumentos": {}, "clips": {}, "descartados": []}
    lineas = []
    mejores = {e: [] for e in ESTILOS_ORDEN}
    avisos = []
    md5_global = {}

    for k in sorted(esc, key=lambda z: (not esc[z]["archivos"], z)):
        info, v = esc[k], reg[k]
        filas = []
        for rel, ab in info["archivos"]:
            d = cache[rel]["d"]
            stem = Path(rel).stem
            filas.append({"rel": rel, "stem": stem, "n": numero(stem), "prof": rel.count("/"), "d": d, "md5": d.get("md5")})
        filas.sort(key=lambda r: (r["prof"], r["n"] if r["n"] is not None else 10 ** 9, r["rel"]))
        desc = []
        vistos = {}
        for r in filas:
            d = r["d"]
            if d.get("ilegible"):
                desc.append((r, "ilegible", "no se pudo leer o dura menos de 20 ms"))
            elif d.get("mudo") or d.get("rms", 1) < UMBRAL_MUDO_RMS:
                desc.append((r, "mudo", "vacío o casi sin sonido"))
            elif r["md5"] in vistos:
                desc.append((r, "copia_exacta", f"idéntico a {vistos[r['md5']]}"))
            else:
                vistos[r["md5"]] = r["rel"]
                if r["md5"] in md5_global and md5_global[r["md5"]][0] != k:
                    avisos.append(f"{r['rel']} es idéntico a {md5_global[r['md5']][1]} (otro instrumento)")
                md5_global.setdefault(r["md5"], (k, r["rel"]))
        malos = {id(r) for r, _, _ in desc}
        buenos = [r for r in filas if id(r) not in malos]
        # casi idénticos (huella digital)
        if len(buenos) > 1:
            V = np.array([np.frombuffer(base64.b64decode(r["d"]["fp"]), dtype=np.int8) / 127 for r in buenos])
            V /= np.linalg.norm(V, axis=1, keepdims=True) + 1e-9
            S = V @ V.T
            fuera = set()
            for i in range(len(buenos)):
                if i in fuera:
                    continue
                for j in range(i + 1, len(buenos)):
                    if j not in fuera and S[i, j] > UMBRAL_COPIA and abs(buenos[i]["d"]["dur"] - buenos[j]["d"]["dur"]) < 0.04:
                        fuera.add(j)
                        desc.append((buenos[j], "casi_identico", f"suena igual que {buenos[i]['rel']} ({S[i, j]:.4f})"))
            buenos = [r for i, r in enumerate(buenos) if i not in fuera]
        # intensidad relativa dentro del instrumento
        if buenos:
            db = np.array([20 * math.log10(max(r["d"]["rms"], 1e-6)) for r in buenos])
            rango = np.argsort(np.argsort(db)) / max(1, len(db) - 1)
        rows = []
        for idx, r in enumerate(buenos):
            d = r["d"]
            d["int"] = int(round(rango[idx] * 99))
            dens = len(d["onsets"]) / max(d["activo"], 0.2)
            d["non"] = len(d["onsets"])
            ritmo = (0 if (d["non"] <= 1 and d["sost"] > 55) else 1 if d["non"] <= 1 else
                     2 if d["reg"] >= 70 else 3 if d["reg"] >= 40 else 4)
            vel = 0 if dens < 1.5 else 1 if dens < 4 else 2
            d["dens"] = round(dens * 10)
            d["est"] = puntuar_estilos(d, k, estilos)
            for ei, e in enumerate(ESTILOS_ORDEN):
                mejores[e].append((int(d["est"][ei]), r["stem"], k))
            rows.append([r["stem"], r["rel"], d["dur"], d["ini"], d["rms"], d["pico"], d["int"], ritmo, vel, d["bril"],
                         d["bajo"], d["alto"], d["plano"], d["ataque"], d["caida"], d["sost"], d["non"], d["reg"],
                         d["dens"], d["tono"], d["conf"], d["cents"], d["chroma"], d["est"]])
        nums = [r["n"] for r in filas if r["n"] is not None]
        faltan = sorted(set(range(1, max(nums) + 1)) - set(nums)) if nums else []
        pref = {}
        for r in filas:
            pref[prefijo(r["stem"])] = pref.get(prefijo(r["stem"]), 0) + 1
        pref_real = max(pref, key=pref.get) if pref else (v.get("prefijos") or [""])[0]
        dups_id = {}
        for r in filas:
            dups_id.setdefault(r["stem"], []).append(r)
        for stem, lst in dups_id.items():
            if len(lst) > 1 and len({x["md5"] for x in lst}) > 1:
                avisos.append(f"Nombre repetido con sonido distinto: {stem} en {', '.join(x['rel'] for x in lst)}")
        catalogo["instrumentos"][k] = {
            "nombre": v["nombre"], "carpeta": info["carpetas"][0], "prefijo": pref_real, "roles": v.get("roles", []),
            "total": len(filas), "activos": len(rows), "descartados": len(desc), "capacidad": cap,
            "estado": "activo" if rows else "pendiente", "faltantes": len(faltan)}
        catalogo["clips"][k] = rows
        for r, motivo, det in desc:
            catalogo["descartados"].append([k, r["rel"], motivo, det])
        lineas.append((k, v, len(filas), len(rows), desc, faltan, pref_real, info["carpetas"]))

    # reporte
    R = ["ORQUESTA · REPORTE DE ANÁLISIS", f"Generado: {catalogo['generado']}", "=" * 64, ""]
    tot_a = sum(x[3] for x in lineas)
    tot_d = sum(len(x[4]) for x in lineas)
    R += [f"Sonidos activos: {tot_a}   Descartados: {tot_d}   Capacidad por instrumento: {cap}", ""]
    for k, v, tot, act, desc, faltan, pref, carp in lineas:
        R.append(f"■ {v['nombre'].upper()}  (carpeta: {', '.join(carp)} · prefijo: {pref or '—'})")
        if not tot:
            R += [f"   Pendiente: crea/llena la carpeta con {(v.get('prefijos') or ['x'])[0]}1, {(v.get('prefijos') or ['x'])[0]}2 ... y ejecuta analizar.py", ""]
            continue
        R.append(f"   Archivos: {tot} · activos: {act} · descartados: {len(desc)} · capacidad: {act}/{cap} ({100 * act / cap:.1f}%)")
        R.append(f"   Números que faltan (1 al último): {rangos(faltan)}")
        for r, motivo, det in desc:
            R.append(f"   × {r['rel']}  [{motivo}] {det}")
        R.append("")
    if avisos:
        R += ["AVISOS", *[f" - {a}" for a in avisos], ""]
    R += ["MEJORES AUDIOS POR ESTILO (puntaje 0-9)", "-" * 64]
    for e in ESTILOS_ORDEN:
        top = sorted(mejores[e], key=lambda z: -z[0])[:10]
        R.append(f"{e:10s}: " + ", ".join(f"{s}({p})" for p, s, _ in top))
    (RAIZ / "reporte_analisis.txt").write_text("\n".join(R), encoding="utf-8")
    (RAIZ / "catalogo.json").write_text(json.dumps(catalogo, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"Listo en {time.time() - t0:.1f} s · activos {tot_a} · descartados {tot_d} · catalogo.json y reporte_analisis.txt")

    if mover and catalogo["descartados"]:
        reg_mov = []
        for k, rel, motivo, det in catalogo["descartados"]:
            origen = RAIZ / rel
            if origen.exists():
                dest = RAIZ / "_descartados" / k / motivo / Path(rel).name
                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.exists():
                    dest = dest.with_name(f"{origen.parent.name}_{dest.name}")
                shutil.move(str(origen), str(dest))
                reg_mov.append([rel, dest.relative_to(RAIZ).as_posix()])
        (RAIZ / "_descartados").mkdir(exist_ok=True)
        (RAIZ / "_descartados" / "registro_movimientos.json").write_text(json.dumps(reg_mov, indent=1), encoding="utf-8")
        log(f"Movidos {len(reg_mov)} archivos a _descartados/ (el registro permite devolverlos).")
        principal(False, False, log)                       # regenerar catálogo sin ellos
    return catalogo


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Analiza los audios de ORQUESTA y genera catalogo.json")
    ap.add_argument("--forzar", action="store_true", help="re-analiza todos los audios")
    ap.add_argument("--mover", action="store_true", help="mueve los audios descartados a _descartados/")
    a = ap.parse_args()
    principal(a.forzar, a.mover)
