# 🎻 ORQUESTA — compositor automático de 5 minutos

Elige un estilo, pulsa **CREAR MÚSICA** y la aplicación arma una canción original de 5:00 usando
solo tus audios. Todo funciona en tu computador, sin internet y sin volver a consultar a nadie.

## 1. Cómo abrirla (VS Code)
1. Extrae el ZIP y abre la carpeta `orquesta` en VS Code (**File → Open Folder**).
2. Instala **FFmpeg** (solo hace falta para analizar audios nuevos): en una terminal de Windows `winget install Gyan.FFmpeg`, y reinicia VS Code.
3. En la terminal de VS Code: `pip install -r requirements.txt` (instala numpy; solo se hace una vez).
4. Para abrir la aplicación: doble clic en **iniciar.bat** (o `python servidor.py`). Se abre en http://127.0.0.1:8000
   *(No abras `index.html` con doble clic: el navegador bloquea la lectura de audios; hay que usar el servidor.)*

## 2. Cómo se usa
1. Elige un estilo (o déjalo sin elegir = sorpresa 🎲).
2. Marca las mejoras que quieras: **Eco**, **Reverb**, **Retro**, **Autotune**, **Sonido HD**.
3. **Instrumentos (nuevo):** deja «La orquesta decide» o pulsa **🎛 Elijo yo** para escoger tú: *solo* un instrumento (por ejemplo «Solo Tambores»), o una combinación (Tambores + Flauta, Piano + Trompeta + Guitarra…) hasta con todos los instrumentos que tengan audios. **Todos los que marques suenan**; el ⭐ principal lleva la melodía. Los botones «acompañado por 1, 2, 3… todos» escogen los acompañantes al azar (púlsalos de nuevo para otra combinación). Un instrumento solo toca dos capas (principal + contracanto) para que no suene vacío. Los instrumentos «próximamente» se activan solos cuando metas sus audios.
4. Pulsa **CREAR MÚSICA**. Puedes pausar, saltar en la barra, 💾 guardar, ⬇ descargar (WAV, MP3, receta o memoria) y votar 👍/👎.
5. La sección **Memoria** muestra la estructura, el compás/ritmo matemático y la numeración de audios usada en cada casilla.

## 3. Cómo agregar audios (hasta 2.500 por instrumento)
- Cada instrumento es una carpeta y sus audios van numerados con un prefijo: `p1.mp3, p2.mp3 …` (piano), `t1…` (trompeta), `tim1…`, `tam1…`, `guit1…`, `electri1…`, `f1…`.
- Ya están creadas, vacías y listas: `xilofonos/` (xil1, xil2…), `marimbas/` (mar1…), `acordeones/` (acor1…), `redoblantes/` (redo1…), `joropo/` (jor1…), `electronicos/` (elec1…).
- Copia los audios nuevos a su carpeta y pulsa **🔄 Buscar audios nuevos** (o ejecuta `python analizar.py`). Solo se analizan los nuevos. Acepta mp3, wav, ogg, m4a, flac.
- Para un instrumento que no existe: crea una carpeta con su nombre (p. ej. `violines/`), mete los audios y analiza; se detecta sola.
- Los números pueden saltarse (t33, t35…): no importa. Los repetidos, vacíos o casi iguales se descartan solos y se listan en `reporte_analisis.txt` (no se borra nada; con `python analizar.py --mover` se pasan a `_descartados/`).

## 4. Qué hace el análisis (`analizar.py`)
Para cada audio mide: duración, inicio del golpe, volumen, intensidad (suave/media/fuerte dentro de su instrumento), cantidad y regularidad de golpes (ritmo), velocidad, brillo, graves, ruido, tono y notas (chroma), y una huella para detectar copias. Con eso calcula un puntaje 0-9 de compatibilidad con cada estilo. Todo queda en `catalogo.json`.

## 5. Cómo compone (`js/motor.js`)
- Cada audio es una **frase de ~1 s**. Tempo: `r = BPM/120`, `casilla = 1/r` segundos, compás 4/4 = 2 casillas.
- Estructura por estilo (intro, versos, estribillos, puente, solo, final) con curva de energía; las capas (ritmo, base, armonía, melodía, adorno) entran según la energía.
- Cada capa usa una **paleta** de audios compatibles con el estilo, la intensidad de la sección y las notas de la armonía; arma un motivo y lo repite con variaciones (A, A′, A…), con relleno antes de cada cambio.
- Semilla aleatoria = canciones distintas siempre; con la misma semilla se repite exactamente la misma.
- 👍/👎 refuerzan o debilitan combinaciones de instrumentos y audios por estilo (se guarda en el navegador).

## 6. Personalizar
- `config/estilos.json`: tempo, estructura, energía, instrumentos favoritos, patrones y perfil acústico de cada estilo. Tras cambiarlo, ejecuta `python analizar.py --forzar`.
- `config/instrumentos.json`: carpetas, prefijos y roles de cada instrumento.
- Colores: `css/estilo.css` (variables en `:root`).

## 7. Cosas que conviene saber
- Los puntajes de estilo salen de **medidas del sonido**, no de escucharlo: son una buena guía, no una verdad. Si un audio no encaja con su estilo, ajusta `config/estilos.json` o vota 👎.
- **Autotune** solo corrige audios con un tono claro (la mayoría de los percusivos no lo tienen) y como máximo ±60 centésimas.
- **Retro** = golpe invertido (reversa) que anuncia cada cambio de sección. **Reverb** = sala. Si por «retro» querías otra cosa, se cambia en `js/audio.js`.
- Con pocos audios por instrumento (hoy 13 a 214) las canciones se parecen más entre sí; con 2.500 por instrumento habrá mucha más variedad.
- La carpeta `flautas/flautas/` es copia en parte de `flautas/`: las repetidas exactas se descartan solas.
