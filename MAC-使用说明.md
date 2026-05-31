# macOS 使用说明

## 启动

双击 **`mac-启动.command`** 即可。脚本会自动：

- 解除 macOS 安全限制
- 检测并安装 Python 依赖
- 启动服务并打开浏览器

访问地址：http://127.0.0.1:3000

## 系统要求

- macOS 10.14+
- Python 3.10+（未安装时访问 https://www.python.org/downloads/）

## 常见问题

### 提示「无法验证开发者」

右键 `mac-启动.command` → 选择「打开」→ 点击「打开」。

或到：系统设置 → 隐私与安全性 → 点击「仍要打开」。

### 依赖安装失败

```bash
pip3 install -r requirements.txt
```

### 停止服务

在终端窗口按 `Ctrl+C`，或直接关闭窗口。
