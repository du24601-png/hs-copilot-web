@echo off
chcp 65001 >nul
cd /d %~dp0
echo HS Copilot 正在启动...
echo 启动后在浏览器打开: http://127.0.0.1:7100/
echo 关闭本窗口即停止服务
start "" http://127.0.0.1:7100/
node server.js
pause
