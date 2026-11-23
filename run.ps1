# McConnell Meshes Launcher
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  McConnell Meshes: 3D Shoe & Last Generative Studio" -ForegroundColor Yellow
Write-Host "  Designed for 3D Printing Footwear (TPU/Resin/PLA)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Opening http://127.0.0.1:8000 in your browser..." -ForegroundColor Green
Start-Process "http://127.0.0.1:8000/"
Set-Location $PSScriptRoot
node server.js
