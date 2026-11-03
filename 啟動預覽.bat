@echo off
rem Double-click to preview ykvs-ask locally at http://localhost:8080/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port 8080 -Open
pause
