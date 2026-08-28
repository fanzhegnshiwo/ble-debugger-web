@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BLE 调试助手（网页版）
echo ================================================
echo   BLE 调试助手（网页版）本地启动
echo   目录: %cd%
echo   地址: http://localhost:8000
echo   手机同一局域网访问: http://本机IP:8000
echo   （注意: Web Bluetooth 需 HTTPS 或 localhost，
echo    局域网 IP 属非安全上下文，仅供桌面 Chrome 调试）
echo   按 Ctrl+C 停止服务
echo ================================================
start "" "http://localhost:8000"
python -m http.server 8000
