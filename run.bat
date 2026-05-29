@echo off
:: ============================================
::   无限画布 AI Studio - Windows 启动服务
::   双击运行即可，系统会自动检查环境并启动
:: ============================================
chcp 65001 >nul
title 无限画布 AI Studio 启动器

cd /d "%~dp0"

cls
echo ==========================================================
echo           🚀 无限画布 AI Studio - Windows 启动器 🚀
echo ==========================================================
echo.

:: 1. 检测 Python 环境与嵌入式 Python 目录
echo 🔍 [1/3] 正在检测 Python 运行环境...
set "PYEXE="

:: 优先检测本地嵌入式 Python 目录
if exist "%~dp0python\python.exe" (
    set "PYEXE=%~dp0python\python.exe"
    echo    ✅ 使用项目内置嵌入式 Python 环境
) else (
    :: 检测系统全局 Python3
    where python >nul 2>nul
    if %errorlevel% equ 0 (
        set "PYEXE=python"
        echo    ✅ 使用系统全局 Python 环境
    ) else (
        where python3 >nul 2>nul
        if %errorlevel% equ 0 (
            set "PYEXE=python3"
            echo    ✅ 使用系统全局 Python3 环境
        )
    )
)

if "%PYEXE%"=="" (
    echo ❌ 错误：未在系统或当前目录下检测到 Python！
    echo    请先安装 Python 并将其勾选“Add Python to PATH”（添加到系统变量）。
    echo    推荐访问 https://www.python.org/ 下载安装最新版。
    echo.
    pause
    exit /b 1
)

:: 显示 Python 版本
"%PYEXE%" -V
echo.

:: 2. 自动检测并安装缺失的 Python 依赖包
echo 📦 [2/3] 正在检测运行依赖环境...
"%PYEXE%" -c "import fastapi, uvicorn, requests, pydantic, PIL, httpx, multipart" >nul 2>nul
if %errorlevel% neq 0 (
    echo    ⚠️ 检测到缺失必要运行依赖，正在为您自动安装（仅首次或有更新时执行）...
    if exist "requirements.txt" (
        :: 升级 pip 并使用清华镜像源加速安装
        "%PYEXE%" -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple >nul 2>nul || "%PYEXE%" -m pip install --upgrade pip >nul 2>nul
        "%PYEXE%" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        if %errorlevel% neq 0 (
            echo    ⚠️ 使用镜像源安装失败，尝试官方源安装...
            "%PYEXE%" -m pip install -r requirements.txt
        )
    ) else (
        echo ❌ 错误：未找到 requirements.txt，无法自动安装依赖！
        pause
        exit /b 1
    )
)
echo    ✅ 运行依赖包检测完成！
echo.

:: 3. 端口防占锁及启动
echo 🔌 [3/3] 正在检查端口占用并启动服务...

:: 释放 3000 端口 (Windows 命令行)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    if not "%%a"=="" (
        echo    ⚠️ 检测到 3000 端口已被进程 %%a 占用，正在自动释放...
        taskkill /f /pid %%a >nul 2>nul
        timeout /t 1 /nobreak >nul
    )
)

:: 获取局域网 IP
set "LAN_IP=127.0.0.1"
for /f "tokens=4" %%a in ('route print ^| findstr "0.0.0.0" ^| findstr "Active"') do (
    if not "%%a"=="" set "LAN_IP=%%a"
)

echo.
echo ==========================================================
echo 🎉 启动成功！
echo ----------------------------------------------------------
echo 💻 本地访问地址: http://127.0.0.1:3000
echo 📱 局域网访问（手机/平板）: http://%LAN_IP%:3000
echo 💡 提示: 保持本窗口开启即可。如需关闭服务，直接关闭本窗口或按 Ctrl+C
echo ==========================================================
echo.

:: 自动在默认浏览器中打开页面
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:3000/?build=20260525-comfyui"

:: 启动 FastAPI 服务
"%PYEXE%" main.py

echo.
echo 服务已停止。
pause
