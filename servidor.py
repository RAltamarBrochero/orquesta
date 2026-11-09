#!/usr/bin/env python3
"""
ORQUESTA · servidor local
-------------------------
Sirve la aplicación en http://127.0.0.1:8000 y permite el botón «Buscar audios nuevos»
(analiza las carpetas y regenera catalogo.json sin salir del navegador).

Uso:  python servidor.py          (o doble clic en iniciar.bat)
Solo usa la librería estándar de Python; para analizar audios nuevos necesita numpy y FFmpeg.
"""
import json
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
PUERTO = 8000
CANDADO = threading.Lock()


class Manejador(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mp3": "audio/mpeg", ".json": "application/json", ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):          # consola limpia
        pass

    def responder(self, codigo, datos):
        cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_POST(self):
        if self.path != "/api/escanear":
            return self.responder(404, {"ok": False, "error": "ruta desconocida"})
        if not CANDADO.acquire(blocking=False):
            return self.responder(409, {"ok": False, "error": "ya hay un análisis en curso"})
        try:
            sys.path.insert(0, str(RAIZ))
            import analizar                      # se importa aquí para que el servidor arranque aunque falte numpy
            log = []
            analizar.principal(False, False, log=lambda t: (log.append(t), print(t)))
            self.responder(200, {"ok": True, "log": log})
        except SystemExit as e:
            self.responder(500, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            self.responder(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
        finally:
            CANDADO.release()


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PUERTO), partial(Manejador, directory=str(RAIZ)))
    url = f"http://127.0.0.1:{PUERTO}"
    print(f"ORQUESTA lista en {url}   (Ctrl+C para cerrar)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nCerrado.")
