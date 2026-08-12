@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-tunnel.ps1"
pause
