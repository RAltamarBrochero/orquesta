@echo off
cd /d "%~dp0"
echo Iniciando ORQUESTA...
where py >nul 2>nul && (py servidor.py) || (python servidor.py)
pause
