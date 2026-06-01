#!/bin/bash
# gongju macOS 一键启动（含权限修复、依赖安装、服务启动）

cd "$(dirname "$0")"

echo "🚀 gongju macOS 启动中..."
echo ""

# 解除 macOS 下载隔离 & 执行权限
xattr -r -d com.apple.quarantine . 2>/dev/null
chmod +x mac-启动.command 2>/dev/null

# 检查 Python
if ! command -v python3 &>/dev/null; then
    echo "❌ 未检测到 Python3，请先安装：https://www.python.org/downloads/"
    read -p "按回车键退出..."
    exit 1
fi
echo "✅ $(python3 -V)"

# 安装依赖（缺失时：先离线 packages/，再联网）
install_deps() {
    if [ -d "packages" ]; then
        echo "📦 正在从 packages/ 离线安装依赖..."
        python3 -m pip install --no-index --find-links=packages -r requirements.txt && return 0
    fi
    echo "📦 正在联网安装依赖..."
    python3 -m pip install -r requirements.txt \
        -i https://pypi.tuna.tsinghua.edu.cn/simple 2>/dev/null \
        || python3 -m pip install -r requirements.txt
}

python3 -c "import fastapi, uvicorn, requests, pydantic, PIL, httpx, multipart, websockets" &>/dev/null \
    || install_deps || { echo "❌ 依赖安装失败"; read -p "按回车键退出..."; exit 1; }

# 释放 3000 端口
PORT_PID=$(lsof -t -i:3000 -sTCP:LISTEN 2>/dev/null)
[ -n "$PORT_PID" ] && kill -9 $PORT_PID 2>/dev/null && sleep 1

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"
LAN_IP="${LAN_IP:-127.0.0.1}"

echo ""
echo "----------------------------------------------------------"
echo "💻 本机: http://127.0.0.1:3000"
echo "📱 局域网: http://${LAN_IP}:3000"
echo "💡 关闭窗口或 Ctrl+C 停止服务"
echo "----------------------------------------------------------"
echo ""

(sleep 1.5 && open "http://127.0.0.1:3000") &
python3 main.py
