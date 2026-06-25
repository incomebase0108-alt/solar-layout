@echo off
chcp 932 >nul
title ソーラーレイアウト
cd /d %~dp0
echo ================================================
echo   ソーラーレイアウト 起動中...
echo   ブラウザが自動で開きます。
echo   この窓は閉じないでください（閉じると止まります）
echo ================================================
echo.
echo 前回の起動の残り（ポート5173）を整理しています...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*solar-layout*vite*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo.
call npx vite --open --port 5173 --strictPort
pause
