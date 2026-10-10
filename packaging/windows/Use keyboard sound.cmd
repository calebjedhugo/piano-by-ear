@echo off
title Piano by Ear - keyboard sound
cd /d "%~dp0app"
echo.
"%~dp0node\node.exe" src\download-pianos.js --keyboard
echo.
pause
