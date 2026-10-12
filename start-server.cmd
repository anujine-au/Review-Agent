@echo off
chcp 65001 >nul
title Audit Report Reviewer - Web Server
rem This computer only:        start-server.cmd
rem Local network (HTTPS):     start-server.cmd --lan
rem New login code:            start-server.cmd --rotate-code
set "NODE=node"
where node >nul 2>nul || set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
"%NODE%" "%~dp0server\server.js" %*
pause
