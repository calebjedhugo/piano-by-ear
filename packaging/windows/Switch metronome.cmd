@echo off
title Piano by Ear - metronome
cd /d "%~dp0app"
echo.
echo   Where the metronome comes from when your keyboard makes the sound.
echo   Use the computer if the click plays as a piano note, or not at all.
echo.
<nul set /p "=  The metronome now comes from: "
"%~dp0node\node.exe" src\metronome.js toggle
echo   Restart Piano by Ear to hear the change.
echo.
pause
