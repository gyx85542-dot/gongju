# gongju

gongju 是一个面向 AI 创作的工作流工具，把图像生成、视频生成、对话和 RunningHub / ComfyUI 工作流整合在同一套环境里。

## 项目简介

通过侧边栏可在「AI 生图」「ComfyUI」「AI 视频」「AI 对话」等模块间切换，并在设置页配置 API Key、模型与工作流。适合需要批量出图、多步骤自动化、或把多种模型服务组合在一起使用的场景。

## 主要能力

- **AI 图像生成**：对接多种 API 服务，支持文生图、图生图及参考图输入
- **AI 视频生成**：支持视频相关生成与处理流程
- **ComfyUI 工作流**：可导入并调用自定义 ComfyUI 工作流
- **RunningHub**：配置云端 ComfyUI 工作流与 API Key
- **网页内配置**：API Key、模型列表、工作流等可在界面中设置，无需改代码
- **中英文界面**：内置多语言切换

## 运行环境

- Python 3（项目提供 Windows / macOS 启动脚本）
- 依赖见 `requirements.txt`，首次启动时会自动安装

## 目录说明

| 目录/文件 | 说明 |
|-----------|------|
| `mac-启动.command` | macOS 一键启动（双击运行） |
| `win-启动.bat` | Windows 一键启动（双击运行） |
| `main.py` | 后端服务入口 |
| `static/` | 前端页面与脚本 |
| `workflows/` | ComfyUI 工作流定义 |
| `API/.env` | API 密钥等本地配置（需自行创建，不会纳入版本库） |
| `assets/` | 运行时上传与生成的资源（启动后自动创建） |
| `data/` | 本地配置与历史数据 |

## 快速开始

1. 在 `API/.env` 中配置所需的 API 密钥
2. 双击 `win-启动.bat`（Windows）或 `mac-启动.command`（macOS）启动服务
3. 在浏览器中打开本地服务（默认端口 3000），从侧边栏进入各功能模块

## 说明

- `assets/`、`history.json`、`python/` 等目录为本地运行数据或环境，默认不纳入 Git 仓库
- 克隆仓库后首次启动会自动创建 `assets/input`、`assets/output` 等空目录
