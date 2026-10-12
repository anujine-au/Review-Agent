@echo off
chcp 65001 >nul
title Audit Report Reviewer - Restart
echo Stopping the running server (port 8443 / 8080)...
powershell -NoProfile -Command "foreach ($p in 8443,8080) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
timeout /t 2 /nobreak >nul
echo Starting the server (LAN, HTTPS 8443)...
start "Audit Report Reviewer - Web Server (LAN)" "%~dp0start-server-lan.cmd"
timeout /t 3 /nobreak >nul
exit