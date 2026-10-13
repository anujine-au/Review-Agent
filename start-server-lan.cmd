@echo off
chcp 65001 >nul
title Audit Report Reviewer - Web Server (LAN)
set "NODE=node"
where node >nul 2>nul || set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
"%NODE%" "%~dp0server\server.js" --lan
pause
