@echo off
title Piano by Ear - download pianos
cd /d "%~dp0app"
echo.
echo   For a keyboard with no sound of its own: this downloads two pianos
echo   (about 75 MB) and makes the computer play them.
echo.
"%~dp0node\node.exe" src\download-pianos.js
echo.
pause
