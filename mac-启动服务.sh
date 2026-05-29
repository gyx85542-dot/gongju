#!/bin/bash
# ============================================
#   无限画布 AI Studio - macOS 启动服务
#   双击运行即可，系统会自动检查环境并启动
# ============================================

cd "$(dirname "$0")"

clear
echo "=========================================================="
echo "          🚀 无限画布 AI Studio - macOS 启动器 🚀"
echo "=========================================================="
echo ""

# 1. 自动解除 macOS 安全隔离并修复文件权限
echo "🔧 [1/4] 正在修复本地运行权限并解除系统安全限制..."
xattr -r -d com.apple.quarantine *.command *.sh *.py 2>/dev/null
chmod +x *.command *.sh 2>/dev/null
echo "   ✅ 权限修复完成！"
echo ""

# 2. 检查 Python3 环境
echo "🔍 [2/4] 正在检测 Python 环境..."
if ! command -v python3 &>/dev/null; then
    echo "❌ 错误：未检测到 Python3，请先安装 Python！"
    echo "   推荐访问 https://www.python.org/ 下载并安装最新版。"
    read -p "按回车键退出..."
    exit 1
fi
PY_VERSION=$(python3 -V)
echo "   ✅ 检测到 $PY_VERSION"
echo ""

# 3. 自动检测并安装缺失的 Python 依赖包
echo "📦 [3/4] 正在检测运行依赖环境..."
python3 -c "import fastapi, uvicorn, requests, pydantic, PIL, httpx, multipart" &>/dev/null
if [ $? -ne 0 ]; then
    echo "   ⚠️  检测到缺失必要依赖，正在为您自动安装（仅首次或有更新时执行）..."
    if [ -f "requirements.txt" ]; then
        python3 -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple 2>/dev/null || python3 -m pip install --upgrade pip
        python3 -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        if [ $? -ne 0 ]; then
            echo "   ⚠️  使用镜像源安装失败，尝试官方源安装..."
            python3 -m pip install -r requirements.txt
        fi
    else
        echo "❌ 错误：未找到 requirements.txt，无法自动安装依赖！"
        read -p "按回车键退出..."
        exit 1
    fi
fi
echo "   ✅ 运行依赖包检测完成！"
echo ""

# 4. 端口防占锁及网络检测
echo "🔌 [4/4] 正在检查端口占用并启动服务..."
# 释放 3000 端口
PORT_PID=$(lsof -t -i:3000 2>/dev/null)
if [ ! -z "$PORT_PID" ]; then
    echo "   ⚠️  检测到 3000 端口已被进程 ($PORT_PID) 占用，正在自动释放..."
    kill -9 $PORT_PID 2>/dev/null
    sleep 1
fi

# 自动获取局域网 IP (供同局域网设备如手机访问)
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"
if [ -z "$LAN_IP" ]; then
  LAN_IP="127.0.0.1"
fi

echo ""
echo "=========================================================="
echo "🎉 启动成功！"
echo "----------------------------------------------------------"
echo "💻 本地访问地址: http://127.0.0.1:3000"
echo "📱 局域网访问（手机/平板）: http://${LAN_IP}:3000"
echo "💡 提示: 保持本窗口开启即可。如需关闭服务，直接关闭本窗口 or 按 Ctrl+C"
echo "=========================================================="
echo ""

# 自动在默认浏览器中打开页面
(sleep 1.5 && open "http://127.0.0.1:3000") &

# 启动 FastAPI 服务
python3 main.py
