@echo off
chcp 65001 >nul
title MAX Bridge — установка
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 pause
