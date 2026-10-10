@echo off
title Piano by Ear
cd /d "%~dp0app"
echo.
echo   Piano by Ear is running. Everything happens at your keyboard.
echo   Play one note to start, or a chord of your own to keep a history.
echo   Close this window to stop.
echo.
"%~dp0node\node.exe" src\main.js
echo.
echo   Piano by Ear has stopped.
pause
