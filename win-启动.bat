@echo off
chcp 65001 >nul
title gongju (Windows)
cd /d "%~dp0"

echo 🚀 gongju Windows 启动中...
echo.

:: 检测 Python（优先项目内置 python/）
set "PYEXE="
if exist "%~dp0python\python.exe" (
    set "PYEXE=%~dp0python\python.exe"
) else if exist "%~dp0python\pythonw.exe" (
    set "PYEXE=%~dp0python\pythonw.exe"
) else (
    where python >nul 2>nul && set "PYEXE=python"
    if "%PYEXE%"=="" where python3 >nul 2>nul && set "PYEXE=python3"
)

if "%PYEXE%"=="" (
    echo ❌ 未检测到 Python，请先安装：https://www.python.org/downloads/
    pause
    exit /b 1
)
"%PYEXE%" -V

:: 安装依赖（缺失时：先离线 packages/，再联网）
"%PYEXE%" -c "import fastapi, uvicorn, requests, pydantic, PIL, httpx, multipart, websockets" >nul 2>nul
if %errorlevel% neq 0 (
    echo 📦 正在安装依赖...
    if exist "packages" (
        "%PYEXE%" -m pip install --no-index --find-links=packages -r requirements.txt
    )
    if %errorlevel% neq 0 (
        "%PYEXE%" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
    )
    if %errorlevel% neq 0 (
        "%PYEXE%" -m pip install -r requirements.txt
    )
    if %errorlevel% neq 0 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
)

:: 释放 3000 端口
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
)

echo.
echo ----------------------------------------------------------
echo 💻 本机: http://127.0.0.1:3000
echo 💡 关闭窗口或 Ctrl+C 停止服务
echo ----------------------------------------------------------
echo.

start /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:3000/"
"%PYEXE%" main.py

echo.
echo 服务已停止。
pause
