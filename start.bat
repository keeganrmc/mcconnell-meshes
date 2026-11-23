@echo off
title McConnell Meshes - Generative 3D Footwear Studio
echo ========================================================
echo   McConnell Meshes: 3D Shoe & Last Generative Studio
echo   Designed for 3D Printing Footwear (TPU/Resin/PLA)
echo ========================================================
echo.
echo Starting local web server on http://127.0.0.1:8000 ...
start "" http://127.0.0.1:8000/
node server.js
pause
