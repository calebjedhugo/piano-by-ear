@echo off
title Piano by Ear - free play
cd /d "%~dp0app"
echo.
echo   Free play: your keys play the computer's grand piano (run "Download pianos"
echo   first). Nothing is graded or recorded. Close this window to stop.
echo.
"%~dp0node\node.exe" src\free.js
pause
