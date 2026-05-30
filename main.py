import json
import uuid
import base64
import urllib.request
import urllib.parse
import urllib.error
import os
import sys

# 嵌入式 Python 运行时需手动加入项目根目录，否则无法 import 同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import re
import random
import time
import shutil
import asyncio
import logging
import requests
import zipfile
import mimetypes
from typing import List, Dict, Any, Optional
from threading import Lock
import httpx
from PIL import Image
from io import BytesIO
import database as db
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, Header, Request, Query
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

QUIET_ACCESS_PATHS = {
    "/api/queue_status",
    "/api/canvases",
    "/api/canvases/trash",
}
QUIET_ACCESS_PREFIXES = (
    "/api/canvases/",
)

class QuietAccessLogFilter(logging.Filter):
    def filter(self, record):
        args = record.args if isinstance(record.args, tuple) else ()
        if len(args) >= 3:
            path = str(args[2]).split("?", 1)[0]
            status = int(args[4]) if len(args) >= 5 and str(args[4]).isdigit() else 0
            quiet_dynamic = any(path.startswith(prefix) and path.endswith("/meta") for prefix in QUIET_ACCESS_PREFIXES)
            if (path in QUIET_ACCESS_PATHS or quiet_dynamic) and status < 400:
                return False
        message = record.getMessage()
        if any(f'"GET {path}' in message and '" 200' in message for path in QUIET_ACCESS_PATHS):
            return False
        if 'GET /api/canvases/' in message and '/meta' in message and '" 200' in message:
            return False
        return True

logging.getLogger("uvicorn.access").addFilter(QuietAccessLogFilter())

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- WebSocket 状态管理器 ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.user_connections: Dict[str, WebSocket] = {}
        self.connection_clients: Dict[WebSocket, str] = {}

    async def connect(self, websocket: WebSocket, client_id: str = None):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.connection_clients[websocket] = client_id or f"anon-{id(websocket)}"
        if client_id:
            self.user_connections[client_id] = websocket
        print(f"WS Connected. Total: {len(self.active_connections)}, Online: {self.online_count()}")
        await self.broadcast_count()

    async def disconnect(self, websocket: WebSocket, client_id: str = None):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        self.connection_clients.pop(websocket, None)
        if client_id and self.user_connections.get(client_id) is websocket:
            del self.user_connections[client_id]
        print(f"WS Disconnected. Total: {len(self.active_connections)}, Online: {self.online_count()}")
        await self.broadcast_count()

    def online_count(self):
        visible_clients = {
            client_id for client_id in self.connection_clients.values()
            if client_id and not str(client_id).startswith("canvas_")
        }
        return len(visible_clients)

    async def broadcast_count(self):
        count = self.online_count()
        data = json.dumps({"type": "stats", "online_count": count})
        for connection in self.active_connections[:]:
            try:
                await connection.send_text(data)
            except Exception as e:
                print(f"Broadcast error: {e}")
                self.active_connections.remove(connection)

    async def broadcast_new_image(self, image_data: dict):
        data = json.dumps({"type": "new_image", "data": image_data})
        for connection in self.active_connections[:]:
            try:
                await connection.send_text(data)
            except Exception as e:
                print(f"Broadcast image error: {e}")
                self.active_connections.remove(connection)

    async def broadcast_canvas_updated(self, canvas_id: str, updated_at: int, client_id: str = ""):
        data = json.dumps({
            "type": "canvas_updated",
            "canvas_id": canvas_id,
            "updated_at": updated_at,
            "client_id": client_id or "",
        })
        for connection in self.active_connections[:]:
            try:
                await connection.send_text(data)
            except Exception as e:
                print(f"Broadcast canvas error: {e}")
                self.active_connections.remove(connection)

    async def send_personal_message(self, message: dict, client_id: str):
        ws = self.user_connections.get(client_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception as e:
                print(f"Personal message error for {client_id}: {e}")

manager = ConnectionManager()
GLOBAL_LOOP = None
APP_VERSION = "2026.05.19"
GITHUB_REPO_URL = "https://github.com/gyx85542-dot/gongju"
GITHUB_VERSION_URL = "https://raw.githubusercontent.com/gyx85542-dot/gongju/main/VERSION"

@app.on_event("startup")
async def startup_event():
    global GLOBAL_LOOP
    GLOBAL_LOOP = asyncio.get_running_loop()
    ensure_runtime_config_files()
    db.init_database(
        BASE_DIR,
        DATA_DIR,
        HISTORY_FILE,
        API_PROVIDERS_FILE,
        CANVAS_DIR,
        CONVERSATION_DIR,
    )

@app.websocket("/ws/stats")
async def websocket_endpoint(websocket: WebSocket, client_id: str = None):
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        await manager.disconnect(websocket, client_id)
    except Exception as e:
        print(f"WS Error: {e}")
        await manager.disconnect(websocket, client_id)

# --- 配置区域 ---

CLIENT_ID = str(uuid.uuid4())
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORKFLOW_DIR = os.path.join(BASE_DIR, "workflows")
WORKFLOW_PATH = os.path.join(WORKFLOW_DIR, "Z-Image.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
ASSETS_DIR = os.path.join(BASE_DIR, "assets")
OUTPUT_INPUT_DIR = os.path.join(ASSETS_DIR, "input")
OUTPUT_OUTPUT_DIR = os.path.join(ASSETS_DIR, "output")
HISTORY_FILE = os.path.join(BASE_DIR, "history.json")
API_ENV_FILE = os.path.join(BASE_DIR, "API", ".env")
DATA_DIR = os.path.join(BASE_DIR, "data")
CONVERSATION_DIR = os.path.join(DATA_DIR, "conversations")
CANVAS_DIR = os.path.join(DATA_DIR, "canvases")
API_PROVIDERS_FILE = os.path.join(DATA_DIR, "api_providers.json")
GLOBAL_CONFIG_FILE = os.path.join(BASE_DIR, "global_config.json")
CANVAS_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

QUEUE = []
QUEUE_LOCK = Lock()
ACTIVE_PENDING_JOBS = []
ACTIVE_PENDING_JOBS_LOCK = Lock()
HISTORY_LOCK = Lock()
GLOBAL_CONFIG_LOCK = Lock()
CONVERSATION_LOCK = Lock()
CANVAS_LOCK = Lock()
LOAD_LOCK = Lock()
NEXT_TASK_ID = 1

PROVIDER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{2,40}$")

def ensure_runtime_config_files():
    """首次运行时提前创建配置目录，避免第一次保存 API Key 时才创建目录/文件。"""
    try:
        os.makedirs(os.path.dirname(API_ENV_FILE), exist_ok=True)
        os.makedirs(DATA_DIR, exist_ok=True)
        if not os.path.exists(API_ENV_FILE):
            with open(API_ENV_FILE, "a", encoding="utf-8"):
                pass
    except Exception as e:
        print(f"初始化 API 配置目录失败: {e}")

def load_env_file():
    if not os.path.exists(API_ENV_FILE):
        return
    try:
        with open(API_ENV_FILE, 'r', encoding='utf-8-sig') as f:
            for raw_line in f.read().splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                os.environ.setdefault(key, value)
    except Exception as e:
        print(f"加载 API/.env 失败: {e}")
ensure_runtime_config_files()
load_env_file()

COMFYUI_INSTANCES = [s.strip() for s in os.getenv("COMFYUI_INSTANCES", "127.0.0.1:8188").split(",") if s.strip()]
COMFYUI_ADDRESS = COMFYUI_INSTANCES[0]

AI_BASE_URL = os.getenv("COMFLY_BASE_URL", "https://ai.comfly.chat").rstrip("/")
AI_API_KEY = os.getenv("COMFLY_API_KEY", "")
CHAT_MODEL = os.getenv("CHAT_MODEL", "gpt-4o-mini")
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "gpt-image-2")
SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "You are a helpful assistant.")
MAX_HISTORY_MESSAGES = int(os.getenv("MAX_HISTORY_MESSAGES", "30"))
AI_REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "120"))
IMAGE_POLL_INTERVAL = float(os.getenv("IMAGE_POLL_INTERVAL", "2"))
IMAGE_TASK_TIMEOUT = float(os.getenv("IMAGE_TASK_TIMEOUT", str(AI_REQUEST_TIMEOUT)))
COMFYUI_HISTORY_TIMEOUT = int(float(os.getenv("COMFYUI_HISTORY_TIMEOUT", "1800")))
APIMART_IMAGE_TASK_TIMEOUT = float(os.getenv("APIMART_IMAGE_TASK_TIMEOUT", "1800"))
APIMART_IMAGE_POLL_INTERVAL = float(os.getenv("APIMART_IMAGE_POLL_INTERVAL", "5"))
APIMART_IMAGE_INITIAL_POLL_DELAY = float(os.getenv("APIMART_IMAGE_INITIAL_POLL_DELAY", "10"))
VIDEO_POLL_TIMEOUT = float(os.getenv("VIDEO_POLL_TIMEOUT", "1800"))
ONLINE_IMAGE_PROMPT_MAX_LENGTH = int(os.getenv("ONLINE_IMAGE_PROMPT_MAX_LENGTH", "20000"))
VIDEO_PROMPT_MAX_LENGTH = int(os.getenv("VIDEO_PROMPT_MAX_LENGTH", "4000"))
LLM_MESSAGE_MAX_LENGTH = int(os.getenv("LLM_MESSAGE_MAX_LENGTH", "20000"))

FIELD_LABELS = {
    "prompt": "提示词",
    "message": "文本",
    "system_prompt": "系统提示词",
}

def friendly_validation_error(errors):
    parts = []
    for err in errors or []:
        loc = [str(item) for item in err.get("loc", []) if item != "body"]
        field = loc[-1] if loc else ""
        label = FIELD_LABELS.get(field, field or "请求参数")
        ctx = err.get("ctx") or {}
        limit = ctx.get("limit_value") or ctx.get("max_length") or ctx.get("min_length")
        err_type = str(err.get("type") or "")
        msg = str(err.get("msg") or "")
        if "max_length" in err_type or "at most" in msg:
            parts.append(f"{label}过长：当前内容超过后端上限 {limit} 个字符。请拆分为多个提示词节点，或先用 LLM 节点压缩后再生成。")
        elif "min_length" in err_type:
            parts.append(f"{label}不能为空。")
        else:
            parts.append(f"{label}格式不正确：{msg}")
    return "\n".join(parts) or "请求参数不正确。"

@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"detail": friendly_validation_error(exc.errors()), "errors": exc.errors()},
    )

def model_list(env_name, primary, defaults):
    configured = os.getenv(env_name, "")
    configured_values = [item.strip() for item in configured.split(",") if item.strip()]
    values = configured_values or [primary, *defaults]
    deduped = []
    for value in values:
        if value and value not in deduped:
            deduped.append(value)
    return deduped

def reload_env_globals():
    """保存 API 设置后，将 os.environ 里最新的值同步回模块级全局变量，
    避免保存后需要重启才能生效。"""
    global AI_API_KEY, AI_BASE_URL
    global IMAGE_MODELS, CHAT_MODELS, VIDEO_MODELS
    AI_API_KEY = os.getenv("COMFLY_API_KEY", "")
    AI_BASE_URL = os.getenv("COMFLY_BASE_URL", "https://ai.comfly.chat").rstrip("/")
    IMAGE_MODELS = model_list("IMAGE_MODELS", os.getenv("IMAGE_MODEL", IMAGE_MODEL), ["nano-banana-pro"])
    CHAT_MODELS = model_list("CHAT_MODELS", os.getenv("CHAT_MODEL", CHAT_MODEL), ["gpt-4o-mini", "gemini-3.1-flash-image-preview-2k"])
    VIDEO_MODELS = model_list("VIDEO_MODELS", "veo3-fast", [
        "veo2", "veo2-fast", "veo2-pro",
        "veo3", "veo3-fast", "veo3-pro",
        "veo3.1", "veo3.1-fast", "veo3.1-quality", "veo3.1-lite",
        "sora-2", "sora-2-pro",
        "wan2.6-t2v", "wan2.6-i2v",
        "wan2.5-t2v-preview", "wan2.5-i2v-preview",
        "wan2.2-t2v-plus", "wan2.2-i2v-plus", "wan2.2-i2v-flash",
        "doubao-seedance-2.0",
        "doubao-seedance-2.0-fast",
        "doubao-seedance-2-0-260128",
        "doubao-seedance-2-0-fast-260128",
        "doubao-seedance-1-5-pro",
        "doubao-seedance-1-5-pro-251215",
        "doubao-seedance-1-0-pro-250528",
        "doubao-seedance-1-0-lite-t2v-250428",
        "doubao-seedance-1-0-lite-i2v-250428",
    ])
CHAT_MODELS = model_list("CHAT_MODELS", CHAT_MODEL, ["gpt-4o-mini", "gemini-3.1-flash-image-preview-2k"])
IMAGE_MODELS = model_list("IMAGE_MODELS", IMAGE_MODEL, ["nano-banana-pro"])
VIDEO_MODELS = model_list("VIDEO_MODELS", "veo3-fast", [
    # —— Veo 系列 ——
    "veo2", "veo2-fast", "veo2-pro",
    "veo3", "veo3-fast", "veo3-pro",
    "veo3.1", "veo3.1-fast", "veo3.1-quality", "veo3.1-lite",
    # —— Sora ——
    "sora-2", "sora-2-pro",
    # —— 阿里 通义万相 ——
    "wan2.6-t2v", "wan2.6-i2v",
    "wan2.5-t2v-preview", "wan2.5-i2v-preview",
    "wan2.2-t2v-plus", "wan2.2-i2v-plus", "wan2.2-i2v-flash",
    # —— 火山 豆包 Seedance ——
    "doubao-seedance-2.0",
    "doubao-seedance-2.0-fast",
    "doubao-seedance-2-0-260128",
    "doubao-seedance-2-0-fast-260128",
    "doubao-seedance-1-5-pro",
    "doubao-seedance-1-5-pro-251215",
    "doubao-seedance-1-0-pro-250528",
    "doubao-seedance-1-0-lite-t2v-250428",
    "doubao-seedance-1-0-lite-i2v-250428",
])

def provider_key_env(provider_id):
    if provider_id == "comfly":
        return "COMFLY_API_KEY"
    return f"API_PROVIDER_{re.sub(r'[^A-Za-z0-9]', '_', provider_id).upper()}_KEY"

def migrate_apimart_provider_key():
    new_env = provider_key_env(BUILTIN_APIMART_ID)
    legacy_env = "API_PROVIDER_CUSTOM_API_KEY"
    if not os.getenv(new_env) and os.getenv(legacy_env):
        os.environ[new_env] = os.getenv(legacy_env)

def mask_secret(value):
    if not value:
        return ""
    tail = value[-4:] if len(value) > 4 else value
    return f"••••••••{tail}"

BUILTIN_APIMART_ID = "apimart"
BUILTIN_APIMART_LOCKED_IMAGE_MODELS = [
    "gpt-image-2",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
]
BUILTIN_APIMART_LOCKED_CHAT_MODELS = [
    "gemini-3-flash-preview",
    "gemini-3-flash-preview-nothinking",
    "gemini-3-pro-preview",
]
BUILTIN_APIMART_LOCKED_VIDEO_MODELS = [
    "doubao-seedance-2.0",
    "kling-v2-6",
    "veo3.1-fast",
]

migrate_apimart_provider_key()

def merge_locked_apimart_models(saved_values, locked_values):
    locked = []
    for value in locked_values or []:
        item = str(value or "").strip()
        if item and item not in locked:
            locked.append(item)
    locked_set = set(locked)
    extras = []
    for value in saved_values or []:
        item = str(value or "").strip()
        if item and item not in locked_set and item not in extras:
            extras.append(item)
    return locked + extras

def builtin_apimart_provider():
    return {
        "id": BUILTIN_APIMART_ID,
        "name": "APIMart",
        "base_url": "https://api.apimart.ai",
        "protocol": "apimart",
        "image_generation_endpoint": "",
        "image_edit_endpoint": "",
        "enabled": True,
        "primary": True,
        "image_models": list(BUILTIN_APIMART_LOCKED_IMAGE_MODELS),
        "chat_models": list(BUILTIN_APIMART_LOCKED_CHAT_MODELS),
        "video_models": list(BUILTIN_APIMART_LOCKED_VIDEO_MODELS),
    }

def is_builtin_apimart_id(provider_id):
    return str(provider_id or "").strip().lower() in {BUILTIN_APIMART_ID, "custom-api"}

def apply_builtin_apimart_lock(provider):
    if not is_builtin_apimart_id((provider or {}).get("id")):
        return dict(provider or {})
    locked = builtin_apimart_provider()
    merged = dict(provider or {})
    merged.update({
        "id": locked["id"],
        "name": locked["name"],
        "base_url": locked["base_url"],
        "protocol": locked["protocol"],
        "image_generation_endpoint": locked["image_generation_endpoint"],
        "image_edit_endpoint": locked["image_edit_endpoint"],
        "image_models": merge_locked_apimart_models(merged.get("image_models"), locked["image_models"]),
        "chat_models": merge_locked_apimart_models(merged.get("chat_models"), locked["chat_models"]),
        "video_models": merge_locked_apimart_models(merged.get("video_models"), locked["video_models"]),
        "primary": True,
    })
    return merged

def default_api_providers():
    return [builtin_apimart_provider()]

def merge_default_api_providers(providers):
    if not providers:
        return [builtin_apimart_provider()]
    result = []
    apimart_added = False
    for item in providers:
        item = dict(item)
        if is_builtin_apimart_id(item.get("id")):
            if apimart_added:
                continue
            result.append(apply_builtin_apimart_lock(item))
            apimart_added = True
        else:
            result.append(item)
    if not apimart_added:
        result.insert(0, builtin_apimart_provider())
    return result

def normalize_model_list(values):
    return model_list_from_values(values)

def model_list_from_values(values):
    deduped = []
    for value in values or []:
        item = str(value or "").strip()
        if item and item not in deduped:
            selected_model(item, item)
            deduped.append(item)
    return deduped

def normalize_endpoint_override(value, label):
    endpoint = str(value or "").strip()
    if not endpoint:
        return ""
    if len(endpoint) > 300 or re.search(r"\s", endpoint):
        raise HTTPException(status_code=400, detail=f"{label} 不合法，请填写类似 /v1/images/edits 的路径")
    if re.match(r"^https?://", endpoint, re.I):
        return endpoint.rstrip("/")
    if not endpoint.startswith("/"):
        raise HTTPException(status_code=400, detail=f"{label} 需要以 /v1/... 开头，或填写完整 http(s) 地址")
    return endpoint

def provider_endpoint_url(provider, key, default_path):
    base_url = str((provider or {}).get("base_url") or AI_BASE_URL).strip().rstrip("/")
    override = str((provider or {}).get(key) or "").strip()
    if override:
        if re.match(r"^https?://", override, re.I):
            return override.rstrip("/")
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}{override}"
        return override
    if base_url.endswith("/v1") and default_path.startswith("/v1/"):
        return f"{base_url}{default_path[3:]}"
    return f"{base_url}{default_path}"

def normalize_provider(item):
    provider_id = str(item.get("id") or "").strip().lower()
    if not PROVIDER_ID_RE.fullmatch(provider_id):
        raise HTTPException(status_code=400, detail=f"API 平台 ID 不合法：{provider_id or '(empty)'}")
    name = re.sub(r"\s+", " ", str(item.get("name") or provider_id).strip())[:60] or provider_id
    base_url = str(item.get("base_url") or "").strip().rstrip("/")
    if base_url and not re.match(r"^https?://", base_url):
        raise HTTPException(status_code=400, detail=f"{name} 的 Base URL 需要以 http:// 或 https:// 开头")
    protocol = str(item.get("protocol") or "openai").strip().lower()
    if protocol not in {"openai", "apimart"}:
        protocol = "openai"
    image_generation_endpoint = normalize_endpoint_override(item.get("image_generation_endpoint"), "文生图端口")
    image_edit_endpoint = normalize_endpoint_override(item.get("image_edit_endpoint"), "图生图/编辑端口")
    provider = {
        "id": provider_id,
        "name": name,
        "base_url": base_url,
        "protocol": protocol,
        "image_generation_endpoint": image_generation_endpoint,
        "image_edit_endpoint": image_edit_endpoint,
        "enabled": bool(item.get("enabled", True)),
        "primary": bool(item.get("primary", False)),
        "image_models": model_list_from_values(item.get("image_models") or []),
        "chat_models": model_list_from_values(item.get("chat_models") or []),
        "video_models": model_list_from_values(item.get("video_models") or []),
    }
    return apply_builtin_apimart_lock(provider)

def load_api_providers():
    defaults = default_api_providers()
    raw = db.load_api_providers_raw()
    if raw is None:
        if os.path.exists(API_PROVIDERS_FILE):
            try:
                with open(API_PROVIDERS_FILE, "r", encoding="utf-8") as f:
                    raw = json.load(f)
            except Exception as e:
                print(f"加载 API 平台配置失败: {e}")
                return defaults
        else:
            return defaults
    try:
        providers = [
            normalize_provider(item) for item in raw
            if isinstance(item, dict) and str(item.get("id") or "").strip().lower() != "modelscope"
        ]
        return merge_default_api_providers(providers or defaults)
    except Exception as e:
        print(f"加载 API 平台配置失败: {e}")
        return defaults

def save_api_providers(providers):
    db.save_api_providers_raw(providers)

def public_provider(provider):
    key = os.getenv(provider_key_env(provider["id"]), "")
    return {
        **provider,
        "has_key": bool(key),
        "key_preview": mask_secret(key),
        "key_env": provider_key_env(provider["id"]),
    }

def get_primary_provider_id(providers=None):
    """返回当前首选 provider 的 id；优先 primary=True 的，否则取第一个已启用平台。"""
    providers = providers if providers is not None else load_api_providers()
    primary = next((p for p in providers if p.get("primary") and p.get("enabled", True)), None)
    if primary:
        return primary["id"]
    enabled = next((p for p in providers if p.get("enabled", True)), None)
    if enabled:
        return enabled["id"]
    return providers[0]["id"] if providers else BUILTIN_APIMART_ID

def get_api_provider(provider_id="comfly"):
    providers = load_api_providers()
    target = (provider_id or "").strip().lower()
    # 兼容旧的 "comfly" 硬编码：若 comfly 不存在或未指定，回退到首选 provider
    if not target or not any(p["id"] == target for p in providers):
        target = get_primary_provider_id(providers)
    provider = next((p for p in providers if p["id"] == target), None)
    if not provider:
        raise HTTPException(status_code=400, detail=f"未找到 API 平台：{target}")
    if not provider.get("enabled", True):
        raise HTTPException(status_code=400, detail=f"API 平台已禁用：{provider.get('name') or target}")
    return provider

def get_api_provider_exact(provider_id: str):
    providers = load_api_providers()
    target = (provider_id or "").strip().lower()
    provider = next((p for p in providers if p["id"] == target), None)
    if not provider:
        raise HTTPException(status_code=400, detail=f"未找到 API 平台：{target or '(empty)'}。新增平台未保存时请使用当前表单拉取模型。")
    if not provider.get("enabled", True):
        raise HTTPException(status_code=400, detail=f"API 平台已禁用：{provider.get('name') or target}")
    return provider

def env_quote(value):
    text = str(value or "")
    if not text or re.search(r"\s|#|['\"]", text):
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text

def update_env_values(updates):
    os.makedirs(os.path.dirname(API_ENV_FILE), exist_ok=True)
    lines = []
    if os.path.exists(API_ENV_FILE):
        with open(API_ENV_FILE, "r", encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    seen = set()
    next_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            next_lines.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in updates:
            next_lines.append(f"{key}={env_quote(updates[key])}")
            os.environ[key] = str(updates[key] or "")
            seen.add(key)
        else:
            next_lines.append(line)
    for key, value in updates.items():
        if key not in seen:
            next_lines.append(f"{key}={env_quote(value)}")
            os.environ[key] = str(value or "")
    with open(API_ENV_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(next_lines).rstrip() + "\n")

BACKEND_LOCAL_LOAD = {addr: 0 for addr in COMFYUI_INSTANCES}

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(ASSETS_DIR, exist_ok=True)
os.makedirs(OUTPUT_INPUT_DIR, exist_ok=True)
os.makedirs(OUTPUT_OUTPUT_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(WORKFLOW_DIR, exist_ok=True)
os.makedirs(CONVERSATION_DIR, exist_ok=True)
os.makedirs(CANVAS_DIR, exist_ok=True)

def send_bytes_range_requests(file_obj, start: int, end: int, chunk_size: int = 10000):
    """Send a file in chunks using Range Requests specification RFC7233"""
    with file_obj as f:
        f.seek(start)
        while (pos := f.tell()) <= end:
            read_size = min(chunk_size, end + 1 - pos)
            yield f.read(read_size)

def _get_range_header(range_header: str, file_size: int) -> tuple[int, int]:
    try:
        h = range_header.replace("bytes=", "").split("-")
        start = int(h[0]) if h[0] != "" else 0
        end = int(h[1]) if h[1] != "" else file_size - 1
    except ValueError:
        raise HTTPException(
            status_code=416,
            detail=f"Invalid request range (Range:{range_header!r})",
        )

    if start > end or start < 0 or end > file_size - 1:
        raise HTTPException(
            status_code=416,
            detail=f"Invalid request range (Range:{range_header!r})",
        )
    return start, end

def range_requests_response(request: Request, file_path: str, content_type: str):
    """Returns StreamingResponse using Range Requests of a given file"""
    file_size = os.stat(file_path).st_size
    range_header = request.headers.get("range")

    headers = {
        "content-type": content_type,
        "accept-ranges": "bytes",
        "content-encoding": "identity",
        "content-length": str(file_size),
        "access-control-expose-headers": (
            "content-type, accept-ranges, content-length, "
            "content-range, content-encoding"
        ),
    }
    start = 0
    end = file_size - 1
    status_code = 200

    if range_header is not None:
        start, end = _get_range_header(range_header, file_size)
        size = end - start + 1
        headers["content-length"] = str(size)
        headers["content-range"] = f"bytes {start}-{end}/{file_size}"
        status_code = 206

    return StreamingResponse(
        send_bytes_range_requests(open(file_path, mode="rb"), start, end),
        headers=headers,
        status_code=status_code,
    )

@app.get("/output/{filename:path}")
async def serve_output_file(filename: str, request: Request):
    file_path = os.path.join(OUTPUT_DIR, filename)
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")
    
    ext = os.path.splitext(filename)[1].lower()
    is_media = ext in {".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".weba"}
    
    content_type, _ = mimetypes.guess_type(file_path)
    if not content_type:
        content_type = "application/octet-stream"
        
    if is_media:
        return range_requests_response(request, file_path, content_type)
    return FileResponse(file_path, media_type=content_type)

@app.get("/assets/{filename:path}")
async def serve_assets_file(filename: str, request: Request):
    file_path = os.path.join(ASSETS_DIR, filename)
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    ext = os.path.splitext(filename)[1].lower()
    is_media = ext in {".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".weba"}
    
    content_type, _ = mimetypes.guess_type(file_path)
    if not content_type:
        content_type = "application/octet-stream"
        
    if is_media:
        return range_requests_response(request, file_path, content_type)
    return FileResponse(file_path, media_type=content_type)

@app.get("/static/{filename:path}")
async def serve_static_file(filename: str, request: Request):
    file_path = os.path.join(STATIC_DIR, filename)
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    ext = os.path.splitext(filename)[1].lower()
    is_media = ext in {".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".weba"}
    
    content_type, _ = mimetypes.guess_type(file_path)
    if not content_type:
        content_type = "application/octet-stream"
        
    if is_media:
        return range_requests_response(request, file_path, content_type)
    headers = {}
    if ext in {".html", ".js"}:
        headers = {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        }
    return FileResponse(file_path, media_type=content_type, headers=headers)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/output", StaticFiles(directory=OUTPUT_DIR), name="output")
app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")

# --- Pydantic 模型 ---

@app.get("/api/app-info")
def app_info():
    version = APP_VERSION
    version_file = os.path.join(BASE_DIR, "VERSION")
    try:
        if os.path.exists(version_file):
            with open(version_file, "r", encoding="utf-8") as f:
                version = (f.read().strip().splitlines() or [APP_VERSION])[0].strip() or APP_VERSION
    except Exception:
        version = APP_VERSION
    return {
        "version": version,
        "repo_url": GITHUB_REPO_URL,
        "version_url": GITHUB_VERSION_URL,
    }

class GenerateRequest(BaseModel):
    prompt: str = ""
    width: int = 1024
    height: int = 1024
    workflow_json: str = "Z-Image.json"
    params: Dict[str, Any] = {}
    type: str = "zimage"
    client_id: str = ""
    convert_to_jpg: bool = False
    reference_images: List[Dict[str, Any]] = Field(default_factory=list)

class DeleteHistoryRequest(BaseModel):
    timestamp: float

class DeleteHistoryBatchRequest(BaseModel):
    timestamps: List[float]

class HistoryUserMetaPayload(BaseModel):
    scope: str = "studio"
    pinned: List[str] = Field(default_factory=list)
    favorites: List[str] = Field(default_factory=list)
    order: List[str] = Field(default_factory=list)

class OnlinePendingJob(BaseModel):
    id: str
    prompt: str
    mediaKind: str
    timestamp: float
    error: Optional[str] = None

class TokenRequest(BaseModel):
    token: str

class CloudGenRequest(BaseModel):
    prompt: str
    api_key: str = ""
    model: str = ""
    resolution: str = "1024x1024"
    type: str = "zimage"
    image_urls: List[str] = []
    loras: Optional[Any] = None
    client_id: Optional[str] = None

class CloudPollRequest(BaseModel):
    task_id: str
    api_key: str = ""
    client_id: Optional[str] = None

class AIReference(BaseModel):
    url: str = ""
    name: str = ""
    role: str = ""

class OnlineImageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=ONLINE_IMAGE_PROMPT_MAX_LENGTH)
    provider_id: str = "comfly"
    model: str = ""
    size: str = "1024x1024"
    quality: str = "auto"
    reference_images: List[AIReference] = []
    job_id: Optional[str] = None

class OnlineVideoRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=VIDEO_PROMPT_MAX_LENGTH)
    provider_id: str = "comfly"
    model: str = ""
    duration: int = 5
    aspect_ratio: str = "16:9"
    resolution: str = "720p"
    reference_images: List[AIReference] = []
    enhance_prompt: bool = False
    enable_upsample: bool = False
    watermark: bool = False
    generate_audio: bool = False
    job_id: Optional[str] = None

STUDIO_HISTORY_TYPES = {"online", "local-comfy", "online-video", "online-audio", "runninghub"}

def history_has_media(item):
    images = item.get("images") or []
    videos = item.get("videos") or []
    audios = item.get("audios") or []
    return bool(images) or bool(videos) or bool(audios)

CANVAS_TASKS: Dict[str, Dict[str, Any]] = {}
CANVAS_TASK_LOCK = Lock()

class CanvasVideoRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=VIDEO_PROMPT_MAX_LENGTH)
    provider_id: str = "comfly"
    model: str = "veo3-fast"
    duration: int = 5
    aspect_ratio: str = "16:9"
    resolution: str = ""
    size: str = ""
    images: List[AIReference] = []
    videos: List[str] = []
    enhance_prompt: bool = False
    enable_upsample: bool = False
    watermark: bool = False
    seed: Optional[int] = None
    camerafixed: bool = False
    return_last_frame: bool = False
    generate_audio: bool = False

class ApiProviderPayload(BaseModel):
    id: str = ""
    name: str = ""
    base_url: str = ""
    protocol: str = "openai"
    image_generation_endpoint: str = ""
    image_edit_endpoint: str = ""
    enabled: bool = True
    primary: bool = False
    image_models: List[str] = []
    chat_models: List[str] = []
    video_models: List[str] = []
    api_key: Optional[str] = None
    clear_key: bool = False

class ChatRequest(BaseModel):
    conversation_id: str = ""
    message: str = Field(min_length=1, max_length=LLM_MESSAGE_MAX_LENGTH)
    model: str = ""
    image_model: str = ""
    mode: str = "chat"
    size: str = "1024x1024"
    quality: str = "auto"
    reference_images: List[AIReference] = []
    provider: str = "comfly"

class CanvasLLMRequest(BaseModel):
    message: str = Field(min_length=1, max_length=LLM_MESSAGE_MAX_LENGTH)
    system_prompt: str = "You are a helpful assistant."
    model: str = ""
    messages: List[Dict[str, Any]] = []
    provider: str = "comfly"
    images: List[str] = []   # 可以是 /output/*.png、/assets/*.png 本地路径 或 http(s) URL 或 data URL

class ConversationCreateRequest(BaseModel):
    title: str = "新对话"

class CanvasCreateRequest(BaseModel):
    title: str = "未命名画布"
    icon: str = "🧩"

class CanvasSaveRequest(BaseModel):
    title: str = "未命名画布"
    icon: str = "🧩"
    nodes: List[Dict[str, Any]] = []
    connections: List[Dict[str, Any]] = []
    viewport: Dict[str, Any] = {}
    logs: List[Dict[str, Any]] = []
    client_id: str = ""
    base_updated_at: int = 0

class CanvasAssetCheckRequest(BaseModel):
    urls: List[str] = []

class CanvasAssetDownloadRequest(BaseModel):
    urls: List[str] = []
    filename: str = "canvas-output-images.zip"

# --- 负载均衡 ---

def check_images_exist(backend_addr, images):
    if not images: return True
    for img in images:
        try:
            url = f"http://{backend_addr}/view?filename={urllib.parse.quote(img)}&type=input"
            r = requests.get(url, stream=True, timeout=0.5)
            r.close()
            if r.status_code != 200: return False
        except: return False
    return True

def get_best_backend(required_images: List[str] = None):
    best_backend = COMFYUI_INSTANCES[0]
    min_queue_size = float('inf')
    candidates_with_images = []
    candidates_others = []
    backend_stats = {}

    for addr in COMFYUI_INSTANCES:
        try:
            with urllib.request.urlopen(f"http://{addr}/queue", timeout=1) as response:
                data = json.loads(response.read())
                remote_load = len(data.get('queue_running', [])) + len(data.get('queue_pending', []))
                with LOAD_LOCK:
                    local_load = BACKEND_LOCAL_LOAD.get(addr, 0)
                effective_load = max(remote_load, local_load)
                has_images = check_images_exist(addr, required_images)
                backend_stats[addr] = {"load": effective_load, "has_images": has_images}
                if has_images:
                    candidates_with_images.append(addr)
                else:
                    candidates_others.append(addr)
        except Exception as e:
            print(f"Backend {addr} unreachable: {e}")
            continue

    target_candidates = candidates_with_images if candidates_with_images else candidates_others
    if not target_candidates:
        if candidates_others:
            target_candidates = candidates_others
        else:
            return COMFYUI_INSTANCES[0]

    for addr in target_candidates:
        load = backend_stats[addr]["load"]
        if load < min_queue_size:
            min_queue_size = load
            best_backend = addr

    return best_backend

# --- 辅助工具 ---

def download_image(comfy_address, comfy_url_path, prefix="studio_"):
    filename = f"{prefix}{uuid.uuid4().hex[:10]}.png"
    local_path = output_path_for(filename, "output")
    full_url = f"http://{comfy_address}{comfy_url_path}"
    try:
        with urllib.request.urlopen(full_url) as response, open(local_path, 'wb') as out_file:
            shutil.copyfileobj(response, out_file)
        return output_url_for(filename, "output")
    except Exception as e:
        print(f"下载图片失败: {e}")
        if comfy_url_path.startswith("/view"):
            return comfy_url_path.replace("/view", "/api/view", 1)
        return full_url

def comfy_output_extension(item):
    filename = str((item or {}).get("filename") or "")
    ext = os.path.splitext(filename)[1].lower()
    if ext in {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".m4v", ".gif"}:
        return ext
    fmt = str((item or {}).get("format") or "").lower()
    if "webm" in fmt:
        return ".webm"
    if "quicktime" in fmt or "mov" in fmt:
        return ".mov"
    if "mp4" in fmt or "h264" in fmt or "video" in fmt:
        return ".mp4"
    return ".png"

def is_video_output_item(item):
    ext = comfy_output_extension(item)
    fmt = str((item or {}).get("format") or "").lower()
    return ext in {".mp4", ".webm", ".mov", ".m4v"} or "video" in fmt

def download_comfy_output(comfy_address, item, prefix="studio_"):
    ext = comfy_output_extension(item)
    filename = f"{prefix}{uuid.uuid4().hex[:10]}{ext}"
    local_path = output_path_for(filename, "output")
    subfolder = urllib.parse.quote(str(item.get("subfolder") or ""))
    file_type = urllib.parse.quote(str(item.get("type") or "output"))
    comfy_url_path = f"/view?filename={urllib.parse.quote(str(item['filename']))}&subfolder={subfolder}&type={file_type}"
    full_url = f"http://{comfy_address}{comfy_url_path}"
    try:
        with urllib.request.urlopen(full_url) as response, open(local_path, 'wb') as out_file:
            shutil.copyfileobj(response, out_file)
        return output_url_for(filename, "output")
    except Exception as e:
        print(f"下载 ComfyUI 输出失败: {e}")
        if comfy_url_path.startswith("/view"):
            return comfy_url_path.replace("/view", "/api/view", 1)
        return full_url

def save_to_history(record):
    with HISTORY_LOCK:
        db.insert_history(record)

def get_comfy_history(comfy_address, prompt_id):
    try:
        with urllib.request.urlopen(f"http://{comfy_address}/history/{prompt_id}") as response:
            return json.loads(response.read())
    except Exception as e:
        return {}

def safe_user_id(user_id, request: Request):
    candidate = (user_id or "").strip()
    if not candidate and request.client:
        candidate = f"ip-{request.client.host}"
    if not candidate:
        candidate = "anonymous"
    candidate = re.sub(r"[^a-zA-Z0-9_.-]", "-", candidate)[:80].strip(".-")
    return candidate or "anonymous"

def user_dir(user_id):
    path = os.path.join(CONVERSATION_DIR, user_id)
    os.makedirs(path, exist_ok=True)
    return path

def conversation_path(user_id, conversation_id):
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", conversation_id or "")
    if not cleaned:
        raise HTTPException(status_code=400, detail="无效的对话 ID")
    return os.path.join(user_dir(user_id), f"{cleaned}.json")

def now_ms():
    return int(time.time() * 1000)

def save_conversation(user_id, conversation):
    with CONVERSATION_LOCK:
        db.save_conversation_record(user_id, conversation)

def new_conversation(user_id, title="新对话"):
    timestamp = now_ms()
    conversation = {
        "id": uuid.uuid4().hex,
        "title": (title or "新对话")[:80],
        "created_at": timestamp,
        "updated_at": timestamp,
        "messages": [],
    }
    save_conversation(user_id, conversation)
    return conversation

def load_conversation(user_id, conversation_id):
    conversation = db.load_conversation_record(user_id, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="对话不存在")
    return conversation

def list_conversations(user_id):
    return db.list_conversation_summaries(user_id)

def canvas_path(canvas_id):
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", canvas_id or "")
    if not cleaned:
        raise HTTPException(status_code=400, detail="无效的画布 ID")
    return os.path.join(CANVAS_DIR, f"{cleaned}.json")

def save_canvas(canvas):
    canvas["updated_at"] = now_ms()
    with CANVAS_LOCK:
        db.save_canvas_record(canvas)

def new_canvas(title="未命名画布", icon="layers"):
    timestamp = now_ms()
    canvas = {
        "id": uuid.uuid4().hex,
        "title": (title or "未命名画布")[:80],
        "icon": (icon or "🧩")[:4],
        "created_at": timestamp,
        "updated_at": timestamp,
        "nodes": [],
        "connections": [],
        "viewport": {"x": 0, "y": 0, "scale": 1},
    }
    save_canvas(canvas)
    return canvas

def load_canvas(canvas_id):
    canvas = db.load_canvas_record(canvas_id)
    if not canvas:
        raise HTTPException(status_code=404, detail="画布不存在")
    if canvas.get("deleted_at"):
        raise HTTPException(status_code=404, detail="画布已在回收站")
    return canvas

def load_canvas_any(canvas_id):
    canvas = db.load_canvas_record(canvas_id)
    if not canvas:
        raise HTTPException(status_code=404, detail="画布不存在")
    return canvas

def canvas_record(data):
    return {
        "id": data.get("id"),
        "title": data.get("title", "未命名画布"),
        "icon": data.get("icon", "🧩"),
        "created_at": data.get("created_at", 0),
        "updated_at": data.get("updated_at", 0),
        "deleted_at": data.get("deleted_at", 0),
        "node_count": len(data.get("nodes", [])),
    }

def cleanup_expired_canvas_trash():
    cutoff = now_ms() - CANVAS_TRASH_RETENTION_MS
    with CANVAS_LOCK:
        db.purge_expired_canvas_trash(cutoff)

def iter_canvas_records(include_deleted=False):
    cleanup_expired_canvas_trash()
    records = []
    for data in db.list_all_canvas_records():
        is_deleted = bool(data.get("deleted_at"))
        if include_deleted != is_deleted:
            continue
        records.append(canvas_record(data))
    return records

def list_canvases():
    records = iter_canvas_records(include_deleted=False)
    return sorted(records, key=lambda item: item["updated_at"], reverse=True)

def list_deleted_canvases():
    records = iter_canvas_records(include_deleted=True)
    return sorted(records, key=lambda item: item["deleted_at"], reverse=True)

def display_title(text):
    title = re.sub(r"\s+", " ", text or "").strip()
    return title[:24] or "新对话"

def resolve_chat_provider(provider: str, model: str):
    api_provider = get_api_provider(provider or "")
    base_root = (api_provider.get("base_url") or AI_BASE_URL).rstrip("/")
    if not base_root:
        raise HTTPException(status_code=400, detail=f"{api_provider.get('name') or api_provider['id']} 未配置 Base URL")
    base = base_root if base_root.endswith("/v1") else base_root + "/v1"
    hdrs = api_headers(provider=api_provider)
    default_model = (api_provider.get("chat_models") or [CHAT_MODEL])[0]
    mdl = selected_model(model, default_model)
    return base, hdrs, mdl

def api_headers(json_body=True, provider=None):
    if provider:
        key_env = provider_key_env(provider["id"])
        api_key = os.getenv(key_env, "")
        provider_name = provider.get("name") or provider["id"]
        if not api_key:
            raise HTTPException(status_code=400, detail=f"未配置 {provider_name} 的 API Key，请在 API 平台管理中填写。")
    else:
        api_key = AI_API_KEY
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 COMFLY_API_KEY，请在 API/.env 中填写。")
    headers = {"Accept": "application/json", "Authorization": f"Bearer {api_key}"}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers

def selected_model(requested, fallback):
    model = (requested or fallback).strip()
    if not model:
        raise HTTPException(status_code=400, detail="模型名称不能为空")
    if len(model) > 240 or any(ord(ch) < 32 or ord(ch) == 127 for ch in model):
        raise HTTPException(status_code=400, detail=f"模型名称不合法：{model}")
    return model

def unwrap_apimart_response(raw):
    """APIMart 将标准 OpenAI 响应包在 {"code":200,"data":{...}} 里；如果检测到就解包。"""
    if isinstance(raw, dict) and "data" in raw and isinstance(raw.get("data"), dict) and "choices" not in raw:
        return raw["data"]
    return raw

def text_from_chat_response(data):
    data = unwrap_apimart_response(data)
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(item.get("text") or item.get("content") or "")
        return "\n".join(part for part in parts if part)
    return str(content)

def text_delta_from_chat_chunk(data):
    choices = data.get("choices") or []
    if not choices:
        return ""
    delta = choices[0].get("delta") or {}
    content = delta.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(item.get("text") or item.get("content") or "")
        return "".join(parts)
    return str(content) if content else ""

def sse_event(data):
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

def extract_image(data):
    if isinstance(data.get("data"), dict) and isinstance(data["data"].get("result"), dict):
        data = data["data"]
    if isinstance(data.get("result"), dict):
        result_images = data["result"].get("images") or []
        if result_images:
            first = result_images[0]
            url = first.get("url")
            if isinstance(url, list) and url:
                return {"type": "url", "value": url[0]}
            if isinstance(url, str) and url:
                return {"type": "url", "value": url}
    if isinstance(data.get("data"), dict) and isinstance(data["data"].get("data"), dict):
        data = data["data"]["data"]
    images = data.get("data") or []
    if not isinstance(images, list) or not images:
        raise HTTPException(status_code=502, detail="生图接口没有返回图片数据")
    first = images[0]
    if first.get("url"):
        return {"type": "url", "value": first["url"]}
    if first.get("b64_json"):
        return {"type": "b64", "value": first["b64_json"]}
    raise HTTPException(status_code=502, detail="无法识别生图接口返回格式")

def extract_task_id(data):
    if data.get("task_id"):
        return str(data["task_id"])
    if data.get("id") and str(data.get("id", "")).startswith("task"):
        return str(data["id"])
    nested = data.get("data")
    if isinstance(nested, list) and nested:
        first = nested[0]
        if isinstance(first, dict):
            return extract_task_id(first)
    if isinstance(nested, dict):
        return extract_task_id(nested)
    return None

def images_api_unsupported(response):
    text = str(getattr(response, "text", "") or "").lower()
    return "images api is not supported" in text or "not supported for this platform" in text

def provider_protocol(provider):
    return str((provider or {}).get("protocol") or "openai").strip().lower()

def is_apimart_provider(provider):
    base_url = str((provider or {}).get("base_url") or "").lower()
    return provider_protocol(provider) == "apimart" or "apimart.ai" in base_url

async def wait_for_image_task(client, task_id, provider=None):
    base_url = (provider.get("base_url") if provider else AI_BASE_URL).rstrip("/")
    is_apimart = is_apimart_provider(provider)
    if is_apimart:
        task_url = f"{base_url}/tasks/{task_id}" if base_url.endswith("/v1") else f"{base_url}/v1/tasks/{task_id}"
    else:
        task_url = f"{base_url}/images/tasks/{task_id}" if base_url.endswith("/v1") else f"{base_url}/v1/images/tasks/{task_id}"
    timeout = APIMART_IMAGE_TASK_TIMEOUT if is_apimart else IMAGE_TASK_TIMEOUT
    interval = APIMART_IMAGE_POLL_INTERVAL if is_apimart else IMAGE_POLL_INTERVAL
    initial_delay = APIMART_IMAGE_INITIAL_POLL_DELAY if is_apimart else 0
    deadline = time.monotonic() + timeout
    last_payload = {}
    while time.monotonic() < deadline:
        if initial_delay:
            await asyncio.sleep(min(initial_delay, max(0.0, deadline - time.monotonic())))
            initial_delay = 0
            if time.monotonic() >= deadline:
                break
        response = await client.get(task_url, headers=api_headers(provider=provider))
        response.raise_for_status()
        last_payload = response.json()
        task_data = last_payload.get("data") if isinstance(last_payload.get("data"), dict) else last_payload
        status = str(task_data.get("status") or task_data.get("task_status") or "").upper()
        if status in {"SUCCESS", "SUCCEED", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE", "FINISHED", "OK", "READY"}:
            return last_payload
        if status in {"FAILURE", "FAILED", "FAIL", "ERROR", "ERRORED", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED", "EXPIRED"}:
            error = task_data.get("error") if isinstance(task_data.get("error"), dict) else {}
            reason = task_data.get("fail_reason") or task_data.get("message") or error.get("message") or last_payload.get("message") or "生图任务失败"
            raise HTTPException(status_code=502, detail=f"生图任务失败：{reason}")
        await asyncio.sleep(min(interval, max(0.0, deadline - time.monotonic())))
    raise HTTPException(status_code=504, detail=f"生图任务超时（已等待 {int(timeout)} 秒），task_id={task_id}")

def output_storage(category="output"):
    return (OUTPUT_INPUT_DIR, "input") if category == "input" else (OUTPUT_OUTPUT_DIR, "output")

def output_url_for(filename, category="output"):
    _, subdir = output_storage(category)
    return f"/assets/{subdir}/{filename}"

def output_path_for(filename, category="output"):
    folder, _ = output_storage(category)
    return os.path.join(folder, filename)

def output_file_from_url(url):
    if isinstance(url, dict):
        url = url.get("url", "")
    if not url or not (url.startswith("/output/") or url.startswith("/assets/")):
        return None
    clean = urllib.parse.unquote(url.split("?", 1)[0]).replace("\\", "/")
    if clean.startswith("/assets/"):
        root = ASSETS_DIR
        rel = clean[len("/assets/"):]
    else:
        root = OUTPUT_DIR
        rel = clean[len("/output/"):]
    rel = rel.lstrip("/")
    if not rel:
        return None
    path = os.path.abspath(os.path.join(root, rel))
    output_root = os.path.abspath(root)
    if os.path.commonpath([output_root, path]) != output_root or not os.path.exists(path):
        return None
    return path

def content_type_for_path(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in [".mp4", ".m4v"]:
        return "video/mp4"
    if ext == ".webm":
        return "video/webm"
    if ext == ".mov":
        return "video/quicktime"
    if ext in [".jpg", ".jpeg"]:
        return "image/jpeg"
    if ext == ".webp":
        return "image/webp"
    return "image/png"

def convert_output_to_jpg(url, quality=88):
    path = output_file_from_url(url)
    if not path:
        return url
    root, ext = os.path.splitext(path)
    if ext.lower() in [".jpg", ".jpeg"]:
        return url
    jpg_path = f"{root}.jpg"
    try:
        with Image.open(path) as img:
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                bg = Image.new("RGB", img.size, (255, 255, 255))
                bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
                img = bg
            else:
                img = img.convert("RGB")
            img.save(jpg_path, "JPEG", quality=quality, optimize=True)
        try:
            root = ASSETS_DIR if os.path.commonpath([os.path.abspath(ASSETS_DIR), os.path.abspath(jpg_path)]) == os.path.abspath(ASSETS_DIR) else OUTPUT_DIR
        except ValueError:
            root = OUTPUT_DIR
        rel = os.path.relpath(jpg_path, root).replace("\\", "/")
        prefix = "/assets" if root == ASSETS_DIR else "/output"
        return f"{prefix}/{rel}"
    except Exception as e:
        print(f"转换 JPG 失败: {e}")
        return url

def reference_to_data_url(ref, max_size=None):
    """把本地输出文件转为 data URL（base64）。max_size 限制最长边像素，避免 payload 过大。"""
    path = output_file_from_url(ref.get("url", ""))
    if not path:
        return ref.get("url", "")
    if max_size:
        try:
            with Image.open(path) as img:
                img.load()
                w, h = img.size
                if max(w, h) > max_size:
                    img.thumbnail((max_size, max_size), Image.LANCZOS)
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGB")
                buf = BytesIO()
                fmt = "PNG" if img.mode == "RGBA" else "JPEG"
                img.save(buf, format=fmt, quality=88 if fmt == "JPEG" else None)
                encoded = base64.b64encode(buf.getvalue()).decode("ascii")
                mime = "image/png" if fmt == "PNG" else "image/jpeg"
                return f"data:{mime};base64,{encoded}"
        except Exception as e:
            print(f"reference resize failed, fallback to raw: {e}")
    with open(path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("ascii")
    return f"data:{content_type_for_path(path)};base64,{encoded}"

def compress_data_url_image(value, max_size=1536, jpeg_quality=88):
    if not isinstance(value, str) or not value.startswith("data:image/") or ";base64," not in value:
        return value
    header, encoded = value.split(";base64,", 1)
    try:
        raw = base64.b64decode(encoded)
        with Image.open(BytesIO(raw)) as img:
            img.load()
            if max_size and max(img.size) > max_size:
                img.thumbnail((max_size, max_size), Image.LANCZOS)
            has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
            if has_alpha:
                if img.mode != "RGBA":
                    img = img.convert("RGBA")
                fmt, mime = "PNG", "image/png"
            else:
                if img.mode != "RGB":
                    img = img.convert("RGB")
                fmt, mime = "JPEG", "image/jpeg"
            buf = BytesIO()
            if fmt == "JPEG":
                img.save(buf, format=fmt, quality=jpeg_quality, optimize=True)
            else:
                img.save(buf, format=fmt, optimize=True)
            return f"data:{mime};base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"
    except Exception as e:
        print(f"data url image compress failed, fallback to raw: {e}")
        return value

def valid_video_image_input(value: str) -> bool:
    if not isinstance(value, str):
        return False
    value = value.strip()
    return (
        value.startswith("http://") or
        value.startswith("https://") or
        value.startswith("asset://") or
        (value.startswith("data:image/") and ";base64," in value)
    )

def valid_apimart_video_image_input(value: str) -> bool:
    if not isinstance(value, str):
        return False
    value = value.strip()
    return value.startswith("http://") or value.startswith("https://") or value.startswith("asset://")

def is_apimart_veo31_model(model: str) -> bool:
    return str(model or "").strip().lower().startswith("veo3.1")

def apimart_veo31_model(model: str) -> str:
    value = str(model or "").strip().lower()
    aliases = {
        "veo3.1": "veo3.1-fast",
        "veo3.1-pro": "veo3.1-quality",
        "veo3.1-preview": "veo3.1-fast",
    }
    value = aliases.get(value, value or "veo3.1-fast")
    allowed = {"veo3.1-fast", "veo3.1-quality", "veo3.1-lite"}
    return value if value in allowed else "veo3.1-fast"

def apimart_veo31_aspect(aspect: str) -> str:
    value = str(aspect or "16:9").strip()
    return value if value in {"16:9", "9:16"} else "16:9"

def apimart_veo31_resolution(resolution: str) -> str:
    value = str(resolution or "").strip().lower()
    aliases = {"": "720p", "auto": "720p", "480p": "720p", "780p": "720p", "1080": "1080p", "4k": "4k"}
    value = aliases.get(value, value)
    return value if value in {"720p", "1080p", "4k"} else "720p"

APIMART_VIDEO_MODEL_ALIASES = {
    "doubao-seedance-2-0-260128": "doubao-seedance-2.0",
    "doubao-seedance-2-0-fast-260128": "doubao-seedance-2.0-fast",
    "doubao-seedance-1-5-pro-251215": "doubao-seedance-1-5-pro",
    "doubao-seedance-1-0-pro-250528": "doubao-seedance-1-0-pro-quality",
    "doubao-seedance-1-0-lite-t2v-250428": "doubao-seedance-1-0-pro-fast",
    "doubao-seedance-1-0-lite-i2v-250428": "doubao-seedance-1-0-pro-fast",
}

def apimart_video_model(model: str) -> str:
    value = str(model or "").strip()
    if not value:
        return "doubao-seedance-2.0"
    return APIMART_VIDEO_MODEL_ALIASES.get(value.lower(), value)

def is_apimart_seedance_20_model(model: str) -> bool:
    normalized = apimart_video_model(model).lower()
    return normalized.startswith("doubao-seedance-2.0") or normalized.startswith("doubao-seedance-2-0")

def is_apimart_seedance_15_model(model: str) -> bool:
    normalized = apimart_video_model(model).lower()
    return "seedance-1-5-pro" in normalized or "seedance-1.5" in normalized

def apimart_video_aspect_ratio(aspect: str) -> str:
    value = str(aspect or "16:9").strip()
    if value == "keep_ratio":
        value = "16:9"
    allowed = {"16:9", "9:16", "1:1", "4:3", "3:4", "21:9"}
    return value if value in allowed else "16:9"

def apimart_seedance_20_resolution(model: str, resolution: str) -> str:
    res = str(resolution or "480p").strip().lower()
    if res == "1080p" and "-face" not in apimart_video_model(model).lower():
        return "720p"
    return res if res in {"480p", "720p", "1080p"} else "480p"

def build_apimart_video_body(payload, model, image_with_roles, image_payload):
    """按 APIMart 文档构造 /v1/videos/generations 请求体（Seedance 2.0 / 1.5 / 其他）。"""
    body = {
        "prompt": payload.prompt,
        "model": model,
        "duration": payload.duration,
    }
    if is_apimart_seedance_20_model(model):
        body["size"] = apimart_video_size(payload.aspect_ratio or payload.size)
        body["resolution"] = apimart_seedance_20_resolution(model, payload.resolution or "480p")
        if payload.generate_audio:
            body["generate_audio"] = True
    else:
        body["aspect_ratio"] = apimart_video_aspect_ratio(payload.aspect_ratio or payload.size)
        res = str(payload.resolution or "").strip().lower()
        default_res = "720p" if is_apimart_seedance_15_model(model) else "1080p"
        body["resolution"] = res if res in {"480p", "720p", "1080p"} else default_res
        if payload.generate_audio:
            if is_apimart_seedance_15_model(model):
                body["audio"] = True
            else:
                body["generate_audio"] = True
        if payload.camerafixed:
            body["camerafixed"] = True
    if image_with_roles:
        body["image_with_roles"] = image_with_roles
    elif image_payload:
        body["image_urls"] = image_payload[:9]
    if payload.videos:
        body["video_urls"] = [v for v in payload.videos if v][:3]
    if payload.seed is not None:
        body["seed"] = payload.seed
    if payload.return_last_frame and is_apimart_seedance_20_model(model):
        body["return_last_frame"] = True
    return body

def apimart_upload_file_payload(path: str):
    """Return (filename, bytes, content_type), keeping APIMart VEO images under the documented 10MB limit."""
    max_bytes = 9_500_000
    size = os.path.getsize(path)
    if size <= max_bytes:
        with open(path, "rb") as fh:
            return os.path.basename(path), fh.read(), content_type_for_path(path)
    with Image.open(path) as img:
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        quality = 92
        while quality >= 62:
            buf = BytesIO()
            bg.save(buf, format="JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            if len(data) <= max_bytes:
                name = os.path.splitext(os.path.basename(path))[0] + ".jpg"
                return name, data, "image/jpeg"
            quality -= 8
    raise ValueError("图片超过 10MB，且压缩后仍无法满足 VEO3.1 图片限制")

def invalid_video_image_preview(value: str) -> str:
    text = str(value or "")
    if text.startswith("data:"):
        return text.split(";base64,", 1)[0] + ";base64,..."
    return text[:120]

def extract_apimart_asset_url(payload):
    if isinstance(payload, list):
        for item in payload:
            found = extract_apimart_asset_url(item)
            if found:
                return found
        return ""
    if not isinstance(payload, dict):
        return ""
    url_keys = ("url", "asset_url", "assetUrl", "uri", "file_url", "fileUrl")
    for key in url_keys:
        value = str(payload.get(key) or "").strip()
        if valid_apimart_video_image_input(value):
            return value
    id_keys = ("asset_id", "assetId", "file_id", "fileId", "id")
    for key in id_keys:
        value = str(payload.get(key) or "").strip()
        if value:
            return value if value.startswith("asset://") else f"asset://{value}"
    for key in ("data", "file", "asset", "result"):
        found = extract_apimart_asset_url(payload.get(key))
        if found:
            return found
    return ""

def apimart_upload_payload_from_bytes(data: bytes, mime: str, name_hint: str = "image"):
    """把内存中的图片字节按 APIMart 的 10MB 限制压缩为可上传 payload。"""
    max_bytes = 9_500_000
    ext = mimetypes.guess_extension(mime or "image/png") or ".png"
    if len(data) <= max_bytes and (mime or "").lower() in ("image/png", "image/jpeg", "image/webp"):
        return f"{name_hint}{ext}", data, (mime or "image/png")
    with Image.open(BytesIO(data)) as img:
        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        if has_alpha:
            base = img.convert("RGBA")
            bg = Image.new("RGB", base.size, (255, 255, 255))
            bg.paste(base, mask=base.split()[-1])
            target = bg
        else:
            target = img.convert("RGB")
        quality = 92
        while quality >= 62:
            buf = BytesIO()
            target.save(buf, format="JPEG", quality=quality, optimize=True)
            payload = buf.getvalue()
            if len(payload) <= max_bytes:
                return f"{name_hint}.jpg", payload, "image/jpeg"
            quality -= 8
    raise ValueError("data URL 图片超过 10MB，且压缩后仍无法满足 APIMart 限制")

async def upload_image_for_apimart(client, provider, ref_url: str) -> str:
    """把本地图片转成上游可接受的输入。
    按 APIMart 文档上传到 /v1/uploads/images，拿到可用于生成接口的 http/https URL。
    绝不把 /output/* 或 /assets/* 这类本地路径直接传给上游。
    返回上游可用 URL；返回值以 "ERR:" 开头表示具体失败原因（供前端展示）。"""
    ref_url = str(ref_url or "").strip()
    if not ref_url:
        return "ERR:空地址"
    # 已经是网络 URL 或 asset:// → 直接可用，无需上传
    if ref_url.startswith("http://") or ref_url.startswith("https://") or ref_url.startswith("asset://"):
        return ref_url
    base_url = video_api_root(provider)
    upload_url = f"{base_url}/v1/uploads/images"
    # data URL: 解码后直接上传到 APIMart
    if ref_url.startswith("data:"):
        try:
            if ";base64," not in ref_url:
                return "ERR:不支持的 data URL（缺少 base64 段）"
            header, encoded = ref_url.split(";base64,", 1)
            mime = header.split(":", 1)[1].split(";", 1)[0] if ":" in header else "image/png"
            raw = base64.b64decode(encoded)
            filename, content, ct = apimart_upload_payload_from_bytes(raw, mime, name_hint="canvas_image")
            files = {"file": (filename, content, ct)}
            resp = await client.post(upload_url, headers=api_headers(json_body=False, provider=provider), files=files, timeout=60)
            if resp.status_code in (200, 201):
                rj = resp.json()
                url = extract_apimart_asset_url(rj)
                if valid_apimart_video_image_input(url):
                    return url
                print(f"APIMart 上传 data URL 返回中未找到可用 asset/url: {str(rj)[:300]}")
                return "ERR:APIMart 上传响应未包含可用 URL"
            print(f"APIMart 上传 data URL 失败 ({resp.status_code}): {resp.text[:300]}")
            return f"ERR:APIMart 上传失败({resp.status_code})"
        except ValueError as e:
            return f"ERR:{e}"
        except Exception as e:
            print(f"APIMart 上传 data URL 异常: {e}")
            return f"ERR:上传异常 {e}"
    # 本地 /output/ 或 /assets/ 路径：先确认文件存在再上传
    if ref_url.startswith("/output/") or ref_url.startswith("/assets/"):
        path = output_file_from_url(ref_url)
        if not path:
            print(f"APIMart 上传跳过：本地文件不存在 {ref_url}")
            return "ERR:本地文件不存在或已被删除"
        try:
            filename, content, ct = apimart_upload_file_payload(path)
            files = {"file": (filename, content, ct)}
            resp = await client.post(upload_url, headers=api_headers(json_body=False, provider=provider), files=files, timeout=60)
            if resp.status_code in (200, 201):
                rj = resp.json()
                url = extract_apimart_asset_url(rj)
                if valid_apimart_video_image_input(url):
                    return url
                print(f"APIMart 文件上传返回中未找到可用 asset/url: {str(rj)[:300]}")
                return "ERR:APIMart 上传响应未包含可用 URL"
            print(f"APIMart 文件上传失败 ({resp.status_code}): {resp.text[:300]}")
            return f"ERR:APIMart 上传失败({resp.status_code})"
        except ValueError as e:
            return f"ERR:{e}"
        except Exception as e:
            print(f"APIMart 文件上传异常: {e}")
            return f"ERR:上传异常 {e}"
    return "ERR:不支持的图片来源（仅支持 http/https/asset/data 或本地 /output/ /assets/ 路径）"

async def save_ai_image_to_output(image_data, prefix="online_", category="output"):
    filename = f"{prefix}{uuid.uuid4().hex[:10]}.png"
    path = output_path_for(filename, category)
    if image_data["type"] == "b64":
        with open(path, "wb") as f:
            f.write(base64.b64decode(image_data["value"]))
        return output_url_for(filename, category)
    value = image_data["value"]
    if value.startswith("/output/") or value.startswith("/assets/"):
        return value
    try:
        timeout = httpx.Timeout(connect=20.0, read=300.0, write=60.0, pool=20.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(value)
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "")
            if "jpeg" in content_type or "jpg" in content_type:
                filename = filename[:-4] + ".jpg"
                path = output_path_for(filename, category)
            elif "webp" in content_type:
                filename = filename[:-4] + ".webp"
                path = output_path_for(filename, category)
            with open(path, "wb") as f:
                f.write(response.content)
            return output_url_for(filename, category)
    except Exception as e:
        print(f"保存上游图片失败: {e}")
        return value

async def save_remote_video_to_output(url, prefix="video_", category="output"):
    if not url:
        return ""
    if url.startswith("/output/") or url.startswith("/assets/"):
        return url
    filename = f"{prefix}{uuid.uuid4().hex[:10]}.mp4"
    path = output_path_for(filename, category)
    try:
        async with httpx.AsyncClient(timeout=VIDEO_POLL_TIMEOUT) as client:
            response = await client.get(url)
            response.raise_for_status()
            content_type = (response.headers.get("Content-Type") or "").lower()
            clean_path = urllib.parse.urlparse(url).path
            ext = os.path.splitext(clean_path)[1].lower()
            if ext in {".mp4", ".webm", ".mov"}:
                filename = filename[:-4] + ext
                path = output_path_for(filename, category)
            elif "webm" in content_type:
                filename = filename[:-4] + ".webm"
                path = output_path_for(filename, category)
            elif "quicktime" in content_type or "mov" in content_type:
                filename = filename[:-4] + ".mov"
                path = output_path_for(filename, category)
            with open(path, "wb") as f:
                f.write(response.content)
            return output_url_for(filename, category)
    except Exception as e:
        print(f"保存上游视频失败: {e}")
        return url

def parse_size_pair(size):
    match = re.fullmatch(r"\s*(\d+)\s*[xX*]\s*(\d+)\s*", str(size or ""))
    if not match:
        return 0, 0
    return int(match.group(1)), int(match.group(2))

GPT_IMAGE2_MAX_EDGE = 3840
GPT_IMAGE2_MAX_PIXELS = 8_294_400
GPT_IMAGE2_MIN_PIXELS = 655_360

def is_gpt_image_2_model(model):
    return str(model or "").strip().lower() == "gpt-image-2"

def normalize_gpt_image_2_size(size):
    width, height = parse_size_pair(size)
    if not width or not height:
        return size or "auto"
    if width == height and (width > 2048 or width * height > 4_194_304):
        return "3840x2160"
    ratio = width / height
    if ratio > 3:
        width = height * 3
    elif ratio < 1 / 3:
        height = width * 3
    scale = min(
        1.0,
        GPT_IMAGE2_MAX_EDGE / max(width, height),
        (GPT_IMAGE2_MAX_PIXELS / max(1, width * height)) ** 0.5,
    )
    width = max(16, int((width * scale) // 16) * 16)
    height = max(16, int((height * scale) // 16) * 16)
    if width * height < GPT_IMAGE2_MIN_PIXELS:
        grow = (GPT_IMAGE2_MIN_PIXELS / max(1, width * height)) ** 0.5
        width = int((width * grow + 15) // 16) * 16
        height = int((height * grow + 15) // 16) * 16
    return f"{width}x{height}"

def apimart_size_resolution(size):
    width, height = parse_size_pair(size)
    if not width or not height:
        raw = str(size or "").strip().lower().replace(" ", "")
        auto_res = re.fullmatch(r"auto:(1k|2k|4k)", raw)
        if auto_res:
            return "auto", auto_res.group(1)
        if raw == "auto":
            return "auto", "1k"
        if raw in {"1k", "2k", "4k"}:
            return "1:1", raw
        if re.fullmatch(r"(auto|\d+:\d+)", raw):
            return raw.replace(" ", ""), "1k"
        return "1:1", "1k"
    long_edge = max(width, height)
    pixels = width * height
    if long_edge >= 3000 or pixels > 4_500_000:
        resolution = "4k"
    elif long_edge >= 1800 or pixels > 1_800_000:
        resolution = "2k"
    else:
        resolution = "1k"
    common = [
        (1, 1, "1:1"), (3, 2, "3:2"), (2, 3, "2:3"), (4, 3, "4:3"), (3, 4, "3:4"),
        (5, 4, "5:4"), (4, 5, "4:5"), (16, 9, "16:9"), (9, 16, "9:16"),
        (2, 1, "2:1"), (1, 2, "1:2"), (3, 1, "3:1"), (1, 3, "1:3"),
        (21, 9, "21:9"), (9, 21, "9:21"),
    ]
    ratio = width / height
    best = min(common, key=lambda item: abs(ratio - item[0] / item[1]))
    return best[2], resolution

async def generate_ai_image(prompt, size, quality, model, reference_images=None, provider_id="comfly"):
    provider = get_api_provider(provider_id)
    is_gpt2 = is_gpt_image_2_model(model)
    is_apimart = is_apimart_provider(provider)
    quality = str(quality or "").strip().lower()
    if quality not in {"low", "medium", "high"}:
        quality = ""
    if is_gpt_image_2_model(model) and not is_apimart:
        size = normalize_gpt_image_2_size(size)
    base_url = (provider.get("base_url") or AI_BASE_URL).rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail=f"{provider.get('name') or provider['id']} 未配置 Base URL")
    gen_url = provider_endpoint_url(provider, "image_generation_endpoint", "/v1/images/generations")
    edit_url = provider_endpoint_url(provider, "image_edit_endpoint", "/v1/images/edits")
    refs = [ref for ref in (reference_images or []) if ref.get("url")]
    mask_refs = [ref for ref in refs if str(ref.get("role") or "").strip().lower() == "mask" or str(ref.get("name") or "").lower().endswith("_mask.png")]
    image_refs = [ref for ref in refs if ref not in mask_refs]
    request_timeout = httpx.Timeout(connect=20.0, read=600.0, write=120.0, pool=20.0) if (is_gpt2 or is_apimart) else AI_REQUEST_TIMEOUT
    async with httpx.AsyncClient(timeout=request_timeout) as client:
        response = None
        async def post_openai_edits(edit_files=None):
            data = {"model": model, "prompt": prompt, "size": size}
            if quality:
                data["quality"] = quality
            return await client.post(
                edit_url,
                headers=api_headers(json_body=False, provider=provider),
                data=data,
                files=edit_files if edit_files is not None else {},
            )

        if is_apimart:
            apimart_size, resolution = apimart_size_resolution(size)
            # APIMart 的 GPT-Image-2 图生图仍走 /images/generations，
            # 通过 image_urls 传参考图，不使用 OpenAI multipart /images/edits。
            body = {
                "model": model,
                "prompt": prompt,
                "n": 1,
                "size": apimart_size,
                "resolution": resolution,
                "official_fallback": False,
            }
            if image_refs:
                body["image_urls"] = [reference_to_data_url(ref, max_size=1536) for ref in image_refs[:16]]
            response = await client.post(gen_url, headers=api_headers(provider=provider), json=body)
        elif is_gpt2 and not image_refs and not mask_refs:
            body = {"model": model, "prompt": prompt, "size": size}
            if quality:
                body["quality"] = quality
            response = await client.post(gen_url, headers=api_headers(provider=provider), json=body)
            if response.status_code >= 400 and images_api_unsupported(response):
                response = await post_openai_edits()
        elif image_refs:
            # 1) OpenAI 协议的图生图/编辑用 multipart 提交到 /images/edits；
            # GPT-Image-2 参考图不能走 /images/generations JSON，否则部分平台会忽略原图或报 Images API unsupported。
            files = []
            opened = []
            edit_failed_status = None
            edit_failed_text = ""
            try:
                for ref in image_refs[:13]:
                    path = output_file_from_url(ref.get("url", ""))
                    if not path:
                        continue
                    fh = open(path, "rb")
                    opened.append(fh)
                    files.append(("image", (os.path.basename(path), fh, content_type_for_path(path))))
                if mask_refs:
                    mask_path = output_file_from_url(mask_refs[0].get("url", ""))
                    if mask_path:
                        fh = open(mask_path, "rb")
                        opened.append(fh)
                        files.append(("mask", (os.path.basename(mask_path), fh, content_type_for_path(mask_path))))
                try:
                    response = await post_openai_edits(files)
                    if response.status_code >= 400:
                        edit_failed_status = response.status_code
                        edit_failed_text = response.text[:500]
                        response = None
                except httpx.HTTPError as e:
                    edit_failed_status = -1
                    edit_failed_text = str(e)
                    response = None
            finally:
                for fh in opened:
                    fh.close()
            # 2) edits 失败 → 非 GPT-Image-2 可回退到 /images/generations + JSON image:[urls/base64]（grsai 风格）
            if response is None:
                if is_gpt2:
                    raise HTTPException(
                        status_code=502,
                        detail=f"GPT-Image-2 编辑接口 /images/edits 调用失败：{edit_failed_text[:300] or edit_failed_status}"
                    )
                print(f"/images/edits failed ({edit_failed_status}): {edit_failed_text[:200]} → 回退到 /images/generations + image:[] JSON")
                image_payload = [reference_to_data_url(ref, max_size=1536) for ref in image_refs[:13]]
                body = {
                    "model": model, "prompt": prompt, "size": size,
                    "response_format": "url", "n": 1,
                    "image": image_payload,
                }
                if quality:
                    body["quality"] = quality
                response = await client.post(gen_url, headers=api_headers(provider=provider), json=body)
                if response.status_code >= 400 and images_api_unsupported(response):
                    raise HTTPException(
                        status_code=502,
                        detail=f"编辑接口 /images/edits 调用失败，且该平台不支持 /images/generations：{edit_failed_text[:300] or edit_failed_status}"
                    )
        else:
            body = {"model": model, "prompt": prompt, "size": size, "response_format": "url", "n": 1}
            if quality:
                body["quality"] = quality
            response = await client.post(
                gen_url,
                headers=api_headers(provider=provider),
                json=body,
            )
            if response.status_code >= 400 and images_api_unsupported(response):
                response = await post_openai_edits()
        response.raise_for_status()
        raw = response.json()
        try:
            return extract_image(raw), raw
        except HTTPException:
            task_id = extract_task_id(raw)
            if not task_id:
                raise
        task_result = await wait_for_image_task(client, task_id, provider)
        return extract_image(task_result), task_result

def upstream_message_from_record(item):
    role = item.get("role")
    if role not in {"user", "assistant"} or item.get("type") == "image":
        return None
    refs = item.get("attachments") or []
    if refs and role == "user":
        content = [{"type": "text", "text": item.get("content", "")}]
        for ref in refs[:4]:
            url = reference_to_data_url(ref)
            if url:
                content.append({"type": "image_url", "image_url": {"url": url}})
        return {"role": role, "content": content}
    return {"role": role, "content": item.get("content", "")}

# --- 路由接口 ---

@app.get("/")
async def index():
    return FileResponse(
        os.path.join(STATIC_DIR, "index.html"),
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )

@app.get("/api/view")
def view_image(filename: str, type: str = "input", subfolder: str = ""):
    # 先按原逻辑去各 ComfyUI 后端找
    for addr in COMFYUI_INSTANCES:
        try:
            url = f"http://{addr}/view"
            params = {"filename": filename, "type": type, "subfolder": subfolder}
            r = requests.get(url, params=params, timeout=1)
            if r.status_code == 200:
                return Response(content=r.content, media_type=r.headers.get('Content-Type'))
        except Exception:
            continue
    # 后端都拿不到时回退本地 assets/<input|output>/
    # 适用场景：画布通过 /api/ai/upload 把参考图直接落到本地 assets/input/，
    # 但 ComfyUI 的 input 可能因为重启/清理而丢失，导致 enhance/klein 等页面预览对比图 404
    if not subfolder and type in ("input", "output"):
        safe_name = os.path.basename(filename or "")
        if safe_name:
            local_path = output_path_for(safe_name, "input" if type == "input" else "output")
            if os.path.isfile(local_path):
                return FileResponse(local_path, media_type=content_type_for_path(local_path))
    raise HTTPException(status_code=404, detail="Image not found on any available backend")

@app.get("/api/download-output")
def download_output(url: str, name: str = ""):
    path = output_file_from_url(url)
    if not path:
        raise HTTPException(status_code=404, detail="文件不存在")
    filename = os.path.basename(name) if name else os.path.basename(path)
    return FileResponse(path, media_type=content_type_for_path(path), filename=filename)

@app.post("/api/upload")
async def upload_image(files: List[UploadFile] = File(...)):
    uploaded_files = []
    files_content = []
    for file in files:
        content = await file.read()
        files_content.append((file, content))

    for file, content in files_content:
        success_count = 0
        last_result = None
        for addr in COMFYUI_INSTANCES:
            try:
                files_data = {'image': (file.filename, content, file.content_type)}
                response = requests.post(f"http://{addr}/upload/image", files=files_data, timeout=5)
                if response.status_code == 200:
                    last_result = response.json()
                    success_count += 1
            except Exception as e:
                print(f"Upload error for {addr}: {e}")

        if success_count > 0 and last_result:
            ext = os.path.splitext(file.filename or "")[1].lower()
            if ext not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
                content_type = (file.content_type or "").lower()
                ext = ".jpg" if "jpeg" in content_type else ".webp" if "webp" in content_type else ".png"
            local_filename = f"comfy_ref_{uuid.uuid4().hex[:12]}{ext}"
            local_path = output_path_for(local_filename, "input")
            with open(local_path, "wb") as f:
                f.write(content)
            uploaded_files.append({
                "comfy_name": last_result.get("name", file.filename),
                "url": output_url_for(local_filename, "input"),
                "name": file.filename or local_filename,
            })
        else:
            raise HTTPException(status_code=500, detail="Failed to upload to any backend")

    return {"files": uploaded_files}

@app.post("/api/ai/upload")
async def upload_ai_reference(files: List[UploadFile] = File(...)):
    uploaded = []
    for file in files:
        content = await file.read()
        if not content:
            continue
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext not in [".png", ".jpg", ".jpeg", ".webp"]:
            content_type = (file.content_type or "").lower()
            ext = ".jpg" if "jpeg" in content_type else ".webp" if "webp" in content_type else ".png"
        filename = f"ai_ref_{uuid.uuid4().hex[:12]}{ext}"
        path = output_path_for(filename, "input")
        with open(path, "wb") as f:
            f.write(content)
        uploaded.append({"url": output_url_for(filename, "input"), "name": file.filename or filename})
    return {"files": uploaded}

@app.get("/api/config")
async def ai_config():
    preferred_chat_model = next((m for m in CHAT_MODELS if m == "gpt-5.5"), CHAT_MODELS[0] if CHAT_MODELS else CHAT_MODEL)
    providers = [public_provider(p) for p in load_api_providers()]
    return {
        "base_url": AI_BASE_URL,
        "chat_model": preferred_chat_model,
        "image_model": IMAGE_MODEL,
        "chat_models": CHAT_MODELS,
        "image_models": IMAGE_MODELS,
        "video_models": VIDEO_MODELS,
        "comfy_instances": COMFYUI_INSTANCES,
        "api_providers": providers,
        "primary_provider_id": get_primary_provider_id(providers),
        "has_api_key": bool(AI_API_KEY),
    }

@app.get("/api/models")
async def ai_models():
    return {"chat_models": CHAT_MODELS, "image_models": IMAGE_MODELS, "video_models": VIDEO_MODELS}

@app.get("/api/providers")
async def api_providers():
    return {"providers": [public_provider(p) for p in load_api_providers()]}

@app.put("/api/providers")
async def save_providers(payload: List[ApiProviderPayload]):
    providers = []
    env_updates = {}
    # 收集每个 item 的 primary 字段
    raw_primary_flags = [bool(getattr(item, "primary", False)) for item in payload]
    for item in payload:
        if str(item.id or "").strip().lower() == "modelscope":
            continue
        provider = normalize_provider(item.dict(exclude={"api_key"}))
        if any(existing["id"] == provider["id"] for existing in providers):
            raise HTTPException(status_code=400, detail=f"API 平台 ID 重复：{provider['id']}")
        providers.append(provider)
        key_env = provider_key_env(provider["id"])
        if item.clear_key:
            env_updates[key_env] = ""
        elif item.api_key is not None and item.api_key.strip():
            env_updates[key_env] = item.api_key.strip()
        if provider["id"] == "comfly":
            env_updates["COMFLY_BASE_URL"] = provider["base_url"]
            env_updates["IMAGE_MODELS"] = ",".join(provider["image_models"])
            env_updates["CHAT_MODELS"] = ",".join(provider["chat_models"])
            env_updates["VIDEO_MODELS"] = ",".join(provider.get("video_models") or [])
    if not providers:
        raise HTTPException(status_code=400, detail="至少保留一个 API 平台")
    # 强制最多一个 primary（取最后被标记的；都没标记则保持原样不强制）
    primary_indices = [i for i, flag in enumerate(raw_primary_flags) if flag]
    if primary_indices:
        winner = primary_indices[-1]
        for i, p in enumerate(providers):
            p["primary"] = (i == winner)
    save_api_providers(providers)
    if env_updates:
        update_env_values(env_updates)
        reload_env_globals()   # 立即将最新 env 值同步回模块全局变量，无需重启
    return {"providers": [public_provider(p) for p in providers]}

@app.get("/api/config/token")
async def get_global_token():
    if os.path.exists(GLOBAL_CONFIG_FILE):
        try:
            with open(GLOBAL_CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
                return {"token": config.get("api_token", "")}
        except Exception:
            pass
    return {"token": ""}

# --- 在线生图 (COMFLY) ---

class TestConnectionPayload(BaseModel):
    base_url: str = ""
    api_key: str = ""
    provider_id: str = ""

@app.post("/api/providers/test-connection")
async def test_provider_connection(payload: TestConnectionPayload):
    """测试请求地址是否可用：调上游 /v1/models。验证通过时同时把模型清单按类别返回，避免再调一次拉取接口。"""
    base_url = (payload.base_url or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="请先填写请求地址")
    if not re.match(r"^https?://", base_url):
        raise HTTPException(status_code=400, detail="请求地址必须以 http:// 或 https:// 开头")
    api_key = (payload.api_key or "").strip()
    if not api_key and payload.provider_id:
        api_key = os.getenv(provider_key_env(payload.provider_id), "")
    if not api_key:
        raise HTTPException(status_code=400, detail="请先填写或保存 API Key")
    url = f"{base_url}/models" if base_url.endswith("/v1") else f"{base_url}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"})
        if resp.status_code >= 400:
            return {"ok": False, "status": resp.status_code, "message": resp.text[:300]}
        data = resp.json() if resp.text else {}
        items = (data.get("data") if isinstance(data, dict) else None) or []
        # 抽取模型 id
        ids = []
        for it in items:
            if isinstance(it, str):
                ids.append(it)
            elif isinstance(it, dict):
                mid = it.get("id") or it.get("name") or it.get("model")
                if mid:
                    ids.append(str(mid))
        ids = sorted(set(ids))
        # 关键字分类
        def classify(mid):
            lc = mid.lower()
            video_keys = ["veo", "sora", "wan2", "wanx", "doubao-seedance", "doubao-1", "kling", "hailuo", "video", "t2v-", "i2v-", "s2v"]
            if any(k in lc for k in video_keys):
                return "video"
            image_keys = ["image", "dalle", "dall-e", "imagen", "flux", "stable", "sdxl", "midjourney", "nano-banana", "ideogram", "fal-ai", "z-image", "qwen-image", "klein"]
            if any(k in lc for k in image_keys):
                return "image"
            return "chat"
        grouped = {"image": [], "chat": [], "video": []}
        for mid in ids:
            grouped[classify(mid)].append(mid)
        return {"ok": True, "status": resp.status_code, "model_count": len(ids), "image_models": grouped["image"], "chat_models": grouped["chat"], "video_models": grouped["video"], "all": ids}
    except httpx.HTTPError as e:
        return {"ok": False, "status": 0, "message": str(e)[:300]}

@app.post("/api/providers/probe-async")
async def probe_async_endpoint(payload: TestConnectionPayload):
    """验证异步协议：用假 task_id 请求 GET /v1/tasks/{fake_id}。
    收到 400 Invalid task ID = 端点存在且 Key 有效；401/403 = Key 无效；404/连接失败 = 不支持异步端点。"""
    base_url = (payload.base_url or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="请先填写请求地址")
    api_key = (payload.api_key or "").strip()
    if not api_key and payload.provider_id:
        api_key = os.getenv(provider_key_env(payload.provider_id), "")
    if not api_key:
        raise HTTPException(status_code=400, detail="请先填写或保存 API Key")
    tasks_base = base_url if base_url.endswith("/v1") else f"{base_url}/v1"
    probe_url = f"{tasks_base}/tasks/healthcheck_probe_do_not_submit"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(probe_url, headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"})
        try:
            body = resp.json()
        except Exception:
            body = resp.text[:500]
        sc = resp.status_code
        # 判断结果
        err_msg = ""
        if isinstance(body, dict):
            err = body.get("error") or {}
            if isinstance(err, dict):
                err_msg = str(err.get("message") or "").lower()
            else:
                err_msg = str(err).lower()
        # 400 + "invalid task id" → 端点存在，Key 有效
        if sc == 400 and "invalid task id" in err_msg:
            return {"ok": True, "status_code": sc, "message": "异步任务端点可用，API Key 已通过认证", "raw": body}
        # 401 / 403 → Key 无效
        if sc in (401, 403):
            return {"ok": False, "status_code": sc, "message": "API Key 无效或无权限", "raw": body}
        # 404 + 没有结构化错误 → 平台不支持此端点
        if sc == 404:
            return {"ok": False, "status_code": sc, "message": "平台不支持 /v1/tasks/ 端点，可能不是 APIMart 异步协议", "raw": body}
        # 其他 400 系 → 返回原始信息供参考
        if 400 <= sc < 500:
            return {"ok": None, "status_code": sc, "message": f"端点返回 {sc}，请查看原始响应判断", "raw": body}
        # 2xx → 意外成功（不太可能）
        if sc < 300:
            return {"ok": True, "status_code": sc, "message": f"端点返回 {sc}（意外成功）", "raw": body}
        return {"ok": False, "status_code": sc, "message": f"服务端错误 {sc}", "raw": body}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

async def fetch_models_from_upstream(base_url: str, api_key: str):
    """从 OpenAI 兼容 /v1/models 端点拉取模型，并按名称做轻量分类。"""
    base_url = (base_url or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="请先填写请求地址")
    if not re.match(r"^https?://", base_url):
        raise HTTPException(status_code=400, detail="请求地址必须以 http:// 或 https:// 开头")
    api_key = (api_key or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="请先填写或保存 API Key")
    url = f"{base_url}/models" if base_url.endswith("/v1") else f"{base_url}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"})
            if resp.status_code >= 400:
                raise HTTPException(status_code=resp.status_code, detail=f"上游 /v1/models 失败：{resp.text[:300]}")
            raw = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"请求上游模型列表失败：{e}")
    # 兼容多种返回结构：{data:[{id:...},...]} 或 {models:[...]}
    items = raw.get("data") if isinstance(raw, dict) else None
    if not items and isinstance(raw, dict):
        items = raw.get("models") or raw.get("list") or []
    if not isinstance(items, list):
        items = []
    ids = []
    for it in items:
        if isinstance(it, str):
            ids.append(it)
        elif isinstance(it, dict):
            mid = it.get("id") or it.get("name") or it.get("model")
            if mid:
                ids.append(str(mid))
    ids = sorted(set(ids))
    # 分类规则（按关键字）
    def classify(mid):
        lc = mid.lower()
        video_keys = ["veo", "sora", "wan2", "wanx", "doubao-seedance", "doubao-1", "kling", "hailuo", "video", "t2v-", "i2v-", "s2v"]
        if any(k in lc for k in video_keys):
            return "video"
        image_keys = ["image", "dalle", "dall-e", "imagen", "flux", "stable", "sdxl", "midjourney", "nano-banana", "ideogram", "fal-ai", "z-image", "qwen-image", "klein"]
        if any(k in lc for k in image_keys):
            return "image"
        return "chat"
    grouped = {"image": [], "chat": [], "video": []}
    for mid in ids:
        grouped[classify(mid)].append(mid)
    return {"total": len(ids), "image_models": grouped["image"], "chat_models": grouped["chat"], "video_models": grouped["video"], "all": ids}

@app.post("/api/providers/fetch-models")
async def fetch_upstream_models_from_payload(payload: TestConnectionPayload):
    """按页面当前表单值拉取模型，支持新增平台未保存时直接使用临时 Base URL / Key。"""
    api_key = (payload.api_key or "").strip()
    if not api_key and payload.provider_id:
        api_key = os.getenv(provider_key_env(payload.provider_id), "")
    return await fetch_models_from_upstream(payload.base_url, api_key)

@app.get("/api/providers/{provider_id}/fetch-models")
async def fetch_upstream_models(provider_id: str):
    """从已保存的上游 OpenAI 兼容接口拉取 /v1/models 列表，按名称智能分类为 image/chat/video。"""
    provider = get_api_provider_exact(provider_id)
    api_key = os.getenv(provider_key_env(provider["id"]), "")
    if not api_key:
        raise HTTPException(status_code=400, detail=f"{provider.get('name') or provider_id} 未配置 API Key")
    return await fetch_models_from_upstream(provider.get("base_url") or "", api_key)

async def build_online_image_result(payload: OnlineImageRequest):
    provider = get_api_provider(payload.provider_id)
    default_model = (provider.get("image_models") or [IMAGE_MODEL])[0]
    model = selected_model(payload.model, default_model)
    refs = [ref.dict() for ref in payload.reference_images if ref.url]
    try:
        image_data, raw = await generate_ai_image(payload.prompt, payload.size, payload.quality, model, refs, provider["id"])
        local_url = await save_ai_image_to_output(image_data, prefix="online_")
    except httpx.HTTPStatusError as exc:
        text = exc.response.text or ''
        # 把上游英文错误转成中文友好提示
        friendly = None
        m = re.search(r"longest edge must be less than or equal to (\d+)", text)
        if m:
            limit = m.group(1)
            friendly = f"该模型不支持当前分辨率：最长边超过 {limit}px。请把图片分辨率调低（例如换到 2K 或更小），或更换支持高分辨率的模型。"
        elif "Invalid size" in text or "invalid_value" in text:
            friendly = f"该模型不支持当前尺寸：{payload.size}。请尝试更换分辨率或模型。"
        elif "rate limit" in text.lower() or "429" in text:
            friendly = "请求过于频繁，已被上游限流，请稍后再试。"
        elif "Unauthorized" in text or "401" in text:
            friendly = "API Key 无效或已过期，请到「API 设置」检查 Key。"
        elif "model_not_found" in text or "channel not found" in text:
            friendly = f"上游平台找不到模型「{model}」可用通道。可能该模型未在此账号开通，请换一个已开通的模型。"
        detail = friendly or f"上游生图接口错误：{text[:300]}"
        raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"请求上游生图接口失败：{exc}") from exc

    result = {
        "prompt": payload.prompt,
        "images": [local_url],
        "timestamp": time.time(),
        "type": "online",
        "model": model,
        "provider_id": provider["id"],
        "provider_name": provider.get("name") or provider["id"],
        "task_id": extract_task_id(raw) if isinstance(raw, dict) else None,
        "request_id": raw.get("id") if isinstance(raw, dict) else None,
        "params": {"provider_id": provider["id"], "model": model, "size": payload.size, "quality": payload.quality, "reference_images": refs, "job_id": payload.job_id},
        "raw_usage": raw.get("usage") if isinstance(raw, dict) else None,
    }
    save_to_history(result)
    if GLOBAL_LOOP:
        asyncio.run_coroutine_threadsafe(manager.broadcast_new_image(result), GLOBAL_LOOP)
    return result

@app.post("/api/online-image")
async def online_image(payload: OnlineImageRequest):
    return await build_online_image_result(payload)

@app.post("/api/online-import")
async def online_import(files: List[UploadFile] = File(...)):
    items = []
    base_ts = time.time()
    for i, file in enumerate(files):
        content = await file.read()
        if not content:
            continue
        ext = os.path.splitext(file.filename or "")[1].lower()
        content_type = (file.content_type or "").lower()
        
        video_exts = {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".flv", ".3gp", ".wmv", ".asf", ".mpeg", ".mpg", ".f4v", ".ogv", ".ts"}
        audio_exts = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".weba", ".mid", ".midi", ".wma"}
        image_exts = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".svg", ".ico", ".heic", ".heif"}
        
        allowed_exts = image_exts | video_exts | audio_exts
        if ext not in allowed_exts:
            if "jpeg" in content_type:
                ext = ".jpg"
            elif "webp" in content_type:
                ext = ".webp"
            elif "gif" in content_type:
                ext = ".gif"
            elif "video" in content_type:
                ext = ".mp4"
            elif "audio" in content_type:
                ext = ".mp3"
            else:
                ext = ".png"
                
        is_video = ext in video_exts or "video" in content_type
        is_audio = ext in audio_exts or ("audio" in content_type and not is_video)
        
        if is_video and ext not in video_exts:
            ext = ".mp4"
        elif is_audio and ext not in audio_exts:
            ext = ".mp3"
            
        filename = f"online_import_{uuid.uuid4().hex[:10]}{ext}"
        path = output_path_for(filename, "output")
        with open(path, "wb") as f:
            f.write(content)
        url = output_url_for(filename, "output")
        record = {
            "prompt": "",
            "images": [] if (is_video or is_audio) else [url],
            "videos": [url] if is_video else [],
            "audios": [url] if is_audio else [],
            "timestamp": base_ts + i * 0.001,
            "type": "online-audio" if is_audio else "online-video" if is_video else "online",
            "model": "",
            "provider_id": "",
            "provider_name": "",
            "params": {"imported": True, "reference_images": []},
        }
        save_to_history(record)
        items.append(record)
    return {"items": items}

async def run_canvas_image_task(task_id: str, payload: OnlineImageRequest):
    with CANVAS_TASK_LOCK:
        if task_id in CANVAS_TASKS:
            CANVAS_TASKS[task_id]["status"] = "running"
            CANVAS_TASKS[task_id]["updated_at"] = time.time()
    try:
        result = await build_online_image_result(payload)
        with CANVAS_TASK_LOCK:
            CANVAS_TASKS[task_id].update({
                "status": "succeeded",
                "result": result,
                "error": "",
                "updated_at": time.time(),
            })
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        status_code = getattr(exc, "status_code", 500)
        with CANVAS_TASK_LOCK:
            CANVAS_TASKS[task_id].update({
                "status": "failed",
                "error": str(detail),
                "status_code": status_code,
                "updated_at": time.time(),
            })

@app.post("/api/canvas-image-tasks")
async def create_canvas_image_task(payload: OnlineImageRequest):
    task_id = f"canvas_img_{uuid.uuid4().hex}"
    with CANVAS_TASK_LOCK:
        CANVAS_TASKS[task_id] = {
            "id": task_id,
            "type": "online-image",
            "status": "queued",
            "created_at": time.time(),
            "updated_at": time.time(),
            "result": None,
            "error": "",
        }
    asyncio.create_task(run_canvas_image_task(task_id, payload))
    return {"task_id": task_id, "status": "queued"}

@app.get("/api/canvas-image-tasks/{task_id}")
async def get_canvas_image_task(task_id: str):
    with CANVAS_TASK_LOCK:
        task = dict(CANVAS_TASKS.get(task_id) or {})
    if not task:
        raise HTTPException(status_code=404, detail="画布任务不存在，可能服务已重启或任务已过期")
    return task

# --- Canvas Video ---

VIDEO_URL_KEYS = (
    "url", "video_url", "videoUrl", "mp4_url", "mp4Url",
    "output", "output_url", "outputUrl", "download_url", "downloadUrl",
    "video", "src", "uri", "preview_url", "previewUrl",
)

def _collect_video_url(value, urls):
    if not value:
        return
    if isinstance(value, str):
        if value.startswith("http://") or value.startswith("https://") or value.startswith("/output/") or value.startswith("/assets/"):
            urls.append(value)
        return
    if isinstance(value, list):
        for item in value:
            _collect_video_url(item, urls)
        return
    if isinstance(value, dict):
        for key in VIDEO_URL_KEYS:
            if key in value:
                _collect_video_url(value.get(key), urls)

def video_output_urls(raw):
    urls = []
    if not isinstance(raw, dict):
        return urls
    candidates = [raw]
    data = raw.get("data")
    if isinstance(data, dict):
        candidates.append(data)
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                candidates.append(item)
    for node in list(candidates):
        result = node.get("result") if isinstance(node, dict) else None
        if isinstance(result, dict):
            candidates.append(result)
        elif isinstance(result, list):
            for item in result:
                if isinstance(item, dict):
                    candidates.append(item)
    for node in candidates:
        if not isinstance(node, dict):
            continue
        for key in ("videos", "outputs"):
            value = node.get(key)
            if value:
                _collect_video_url(value, urls)
        for key in VIDEO_URL_KEYS:
            if key in node:
                _collect_video_url(node.get(key), urls)
    deduped = []
    for url in urls:
        if isinstance(url, str) and url and url not in deduped:
            deduped.append(url)
    return deduped

def video_api_root(provider):
    base_url = (provider.get("base_url") or AI_BASE_URL).rstrip("/")
    if base_url.endswith("/v1") or base_url.endswith("/v2"):
        base_url = base_url.rsplit("/", 1)[0]
    return base_url

VIDEO_TASK_SUCCESS_STATUSES = {
    "SUCCESS", "SUCCEED", "SUCCEEDED", "COMPLETED", "COMPLETE",
    "DONE", "FINISHED", "FINISH", "OK", "READY",
}
VIDEO_TASK_FAILURE_STATUSES = {
    "FAILURE", "FAILED", "FAIL", "ERROR", "ERRORED",
    "CANCELED", "CANCELLED", "TIMEOUT", "TIMEDOUT", "REJECTED", "EXPIRED",
}

async def wait_for_video_task(client, provider, task_id):
    base_url = video_api_root(provider)
    if not base_url:
        raise HTTPException(status_code=400, detail=f"{provider.get('name') or provider['id']} 未配置 Base URL")
    if is_apimart_provider(provider):
        task_path = f"{base_url}/tasks/{task_id}" if base_url.endswith("/v1") else f"{base_url}/v1/tasks/{task_id}"
        task_url = f"{task_path}?language=zh"
    else:
        task_url = f"{base_url}/v2/videos/generations/{task_id}"
    deadline = time.monotonic() + VIDEO_POLL_TIMEOUT
    delay = max(2.0, IMAGE_POLL_INTERVAL)
    last_payload = {}
    while time.monotonic() < deadline:
        await asyncio.sleep(delay)
        response = await client.get(task_url, headers=api_headers(provider=provider))
        response.raise_for_status()
        raw = response.json()
        last_payload = raw
        task_data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        status = str(task_data.get("status") or task_data.get("task_status") or raw.get("status") or raw.get("task_status") or "").upper()
        if status in VIDEO_TASK_SUCCESS_STATUSES:
            return raw
        if video_output_urls(raw):
            return raw
        if status in VIDEO_TASK_FAILURE_STATUSES:
            error = task_data.get("error") if isinstance(task_data.get("error"), dict) else {}
            reason = task_data.get("fail_reason") or task_data.get("message") or error.get("message") or raw.get("error") or raw.get("message") or str(raw)
            raise HTTPException(status_code=502, detail=f"视频生成任务失败：{reason}")
        delay = min(delay * 1.6, 12)
    raise HTTPException(status_code=504, detail=f"视频生成任务超时：{last_payload or task_id}")

def apimart_video_size(size):
    value = str(size or "16:9").strip()
    if value == "keep_ratio":
        return "adaptive"
    allowed = {"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"}
    return value if value in allowed else "16:9"

@app.post("/api/canvas-video")
async def canvas_video(payload: CanvasVideoRequest):
    provider = get_api_provider(payload.provider_id)
    base_url = video_api_root(provider)
    if not base_url:
        raise HTTPException(status_code=400, detail=f"{provider.get('name') or provider['id']} 未配置 Base URL")
    api_key = os.getenv(provider_key_env(provider["id"]), "")
    if not api_key:
        raise HTTPException(status_code=400, detail=f"未配置 {provider.get('name') or provider['id']} 的 API Key，请在 API 设置中填写。")
    is_apimart = is_apimart_provider(provider)
    submit_url = f"{base_url}/videos/generations" if is_apimart and base_url.endswith("/v1") else f"{base_url}/v1/videos/generations" if is_apimart else f"{base_url}/v2/videos/generations"
    requested_model = selected_model(payload.model, "veo3-fast")
    is_veo31 = is_apimart and is_apimart_veo31_model(requested_model)
    try:
        async with httpx.AsyncClient(timeout=VIDEO_POLL_TIMEOUT) as client:
            # --- 构造图片载荷 ---
            if is_apimart:
                # APIMart 只接受 http/https 或 asset:// URL，先上传本地图片取回网络 URL
                image_with_roles = []
                invalid_images = []  # 每项为 (原始 URL, 失败原因)
                apimart_model = apimart_veo31_model(requested_model) if is_veo31 else ""
                if apimart_model == "veo3.1-lite" and payload.images:
                    raise HTTPException(status_code=400, detail="veo3.1-lite 不支持图片输入，请改用 veo3.1-fast 或 veo3.1-quality。")
                image_limit = 0 if apimart_model == "veo3.1-lite" else (3 if is_veo31 else 9)
                for ref in payload.images[:image_limit]:
                    if not ref.url:
                        continue
                    role = str(ref.role or "").strip()
                    if not is_veo31 and role in {"first_frame", "last_frame", "reference_image"}:
                        up_url = await upload_image_for_apimart(client, provider, ref.url)
                        if valid_apimart_video_image_input(up_url):
                            image_with_roles.append({"url": up_url, "role": role})
                        else:
                            reason = up_url[4:] if isinstance(up_url, str) and up_url.startswith("ERR:") else "未知错误"
                            invalid_images.append((ref.url, reason))
                image_payload = []
                if not image_with_roles:
                    for ref in payload.images[:image_limit]:
                        if not ref.url:
                            continue
                        up_url = await upload_image_for_apimart(client, provider, ref.url)
                        if valid_apimart_video_image_input(up_url):
                            image_payload.append(up_url)
                        else:
                            reason = up_url[4:] if isinstance(up_url, str) and up_url.startswith("ERR:") else "未知错误"
                            invalid_images.append((ref.url, reason))
                if payload.images and not image_with_roles and not image_payload:
                    first_url, first_reason = invalid_images[0] if invalid_images else ("", "未知错误")
                    sample = invalid_video_image_preview(first_url)
                    raise HTTPException(status_code=400, detail=f"输入图片无法转换为视频接口支持的格式：{sample}\n原因：{first_reason}\n请确认本地文件存在且不超过 10MB；VEO3.1 需要图片是 APIMart 可访问的 http/https / asset:// / data URL。")
                # --- APIMart 请求体 ---
                if is_veo31:
                    model = apimart_model
                    body = {
                        "prompt": payload.prompt,
                        "model": model,
                        "duration": 8,
                        "aspect_ratio": apimart_veo31_aspect(payload.aspect_ratio),
                        "resolution": apimart_veo31_resolution(payload.resolution),
                    }
                    if image_payload and model != "veo3.1-lite":
                        video_images = image_payload[:3]
                        if model == "veo3.1-quality" and len(video_images) > 2:
                            video_images = video_images[:2]
                        body["image_urls"] = video_images
                        if len(video_images) == 2:
                            body["generation_type"] = "frame"
                        elif len(video_images) >= 3 and model != "veo3.1-quality":
                            body["generation_type"] = "reference"
                    if model != "veo3.1-lite":
                        body["official_fallback"] = False
                else:
                    apimart_model = apimart_video_model(selected_model(payload.model, "doubao-seedance-2.0"))
                    body = build_apimart_video_body(payload, apimart_model, image_with_roles, image_payload)
            else:
                # 非 APIMart：data URL 方式（OpenAI / ComflyAI 接口）
                image_payload = []
                for ref in payload.images[:4]:
                    if ref.url:
                        image_payload.append(reference_to_data_url(ref.dict(), max_size=1536))
                body = {
                    "prompt": payload.prompt,
                    "model": selected_model(payload.model, "veo3-fast"),
                    "duration": payload.duration,
                    "watermark": payload.watermark,
                }
                if payload.aspect_ratio:
                    body["aspect_ratio"] = payload.aspect_ratio
                    body["ratio"] = payload.aspect_ratio
                if payload.size:
                    body["size"] = payload.size
                if payload.resolution:
                    body["resolution"] = payload.resolution
                if image_payload:
                    body["images"] = image_payload
                if payload.videos:
                    body["videos"] = [v for v in payload.videos if v]
                if payload.enhance_prompt:
                    body["enhance_prompt"] = True
                if payload.enable_upsample:
                    body["enable_upsample"] = True
                if payload.seed is not None:
                    body["seed"] = payload.seed
                if payload.camerafixed:
                    body["camerafixed"] = True
                if payload.return_last_frame:
                    body["return_last_frame"] = True
                if payload.generate_audio:
                    body["generate_audio"] = True
            # --- 发起视频生成请求 ---
            response = await client.post(submit_url, headers=api_headers(provider=provider), json=body)
            response.raise_for_status()
            try:
                raw = response.json()
            except Exception:
                # 上游返回了 HTML 错误页面或非 JSON 响应
                resp_text = response.text[:500]
                raise HTTPException(status_code=502, detail=f"上游视频接口返回非 JSON 响应（状态 {response.status_code}）：{resp_text}")
            task_id = extract_task_id(raw) or raw.get("task_id") or raw.get("id")
            result = raw
            if task_id and not video_output_urls(raw):
                result = await wait_for_video_task(client, provider, task_id)
            urls = video_output_urls(result)
            if not urls:
                raise HTTPException(status_code=502, detail=f"视频生成成功但没有返回视频：{result}")
            local_urls = [await save_remote_video_to_output(url) for url in urls]
            return {"videos": local_urls, "task_id": task_id, "raw": result}
    except httpx.HTTPStatusError as exc:
        text = exc.response.text
        try:
            requested_model = body.get("model", "") or payload.model or ""
        except NameError:
            requested_model = payload.model or ""
        provider_name = provider.get('name') or provider['id']
        # 1) 模型名不在上游支持范围 → 从错误信息里抽取合法列表展示
        valid_models_match = re.search(r"not in\s*\[([^\]]+)\]", text)
        if valid_models_match:
            valid_models = [m.strip() for m in valid_models_match.group(1).split(",") if m.strip()]
            sample = valid_models[:30]
            more = f"（共 {len(valid_models)} 个，仅显示前 {len(sample)} 个）" if len(valid_models) > len(sample) else ""
            hint = (
                f"上游「{provider_name}」不识别模型「{requested_model}」。\n\n"
                f"上游支持的视频模型清单{more}：\n  {', '.join(sample)}\n\n"
                f"请到「API 设置」里把视频模型改成上面列表中的一个。"
            )
            raise HTTPException(status_code=exc.response.status_code, detail=hint) from exc
        # 2) 模型名合法但账号没开通通道
        if "channel not found" in text or "model_not_found" in text:
            hint = (
                f"上游「{provider_name}」识别了模型「{requested_model}」，但你的 API Key 账号下**没有该模型的可用通道**。\n\n"
                f"原因：你的账号没开通这个模型的访问权限（付费/订阅相关）。\n\n"
                f"解决方法：\n"
                f"  1. 登录 {provider.get('base_url') or '上游平台'} 控制台，开通该模型 / 充值；\n"
                f"  2. 或在「API 设置」里把视频模型改成你账号已开通的型号（如 veo3-fast / veo2-fast / sora-2 等）。"
            )
            raise HTTPException(status_code=exc.response.status_code, detail=hint) from exc
        raise HTTPException(status_code=exc.response.status_code, detail=f"上游视频接口错误：{text}") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"请求上游视频接口失败：{exc}") from exc

@app.post("/api/online-video")
async def online_video(payload: OnlineVideoRequest):
    canvas_payload = CanvasVideoRequest(
        prompt=payload.prompt,
        provider_id=payload.provider_id,
        model=payload.model,
        duration=payload.duration,
        aspect_ratio=payload.aspect_ratio,
        resolution=payload.resolution,
        images=payload.reference_images,
        enhance_prompt=payload.enhance_prompt,
        enable_upsample=payload.enable_upsample,
        watermark=payload.watermark,
        generate_audio=payload.generate_audio,
    )
    provider = get_api_provider(payload.provider_id)
    result = await canvas_video(canvas_payload)
    videos = result.get("videos") or []
    record = {
        "prompt": payload.prompt,
        "videos": videos,
        "images": [],
        "timestamp": time.time(),
        "type": "online-video",
        "model": payload.model or "",
        "provider_id": provider["id"],
        "provider_name": provider.get("name") or provider["id"],
        "task_id": result.get("task_id"),
        "params": {
            "provider_id": provider["id"],
            "model": payload.model,
            "duration": payload.duration,
            "aspect_ratio": payload.aspect_ratio,
            "resolution": payload.resolution,
            "reference_images": [ref.dict() for ref in payload.reference_images],
            "job_id": payload.job_id,
        },
    }
    save_to_history(record)
    if GLOBAL_LOOP:
        asyncio.run_coroutine_threadsafe(manager.broadcast_new_image(record), GLOBAL_LOOP)
    return record

# --- Canvas LLM ---

@app.post("/api/canvas-llm")
async def canvas_llm(payload: CanvasLLMRequest):
    chat_base, chat_hdrs, model = resolve_chat_provider(payload.provider, payload.model)
    # 判断协议：APIMart 异步 vs 标准 OpenAI
    _llm_provider = get_api_provider(payload.provider)
    _is_apimart = is_apimart_provider(_llm_provider)
    upstream_messages = [{"role": "system", "content": payload.system_prompt or SYSTEM_PROMPT}]
    for item in payload.messages[-MAX_HISTORY_MESSAGES:]:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and content:
            upstream_messages.append({"role": role, "content": content})
    # 构造用户消息：有图片时用 OpenAI vision 多模态格式
    if payload.images:
        content_parts = [{"type": "text", "text": payload.message}]
        ok_imgs = 0
        for img in payload.images[:8]:
            if not img or not isinstance(img, str):
                continue
            # 本地 /output/* 或 /assets/* 路径转为 data URL；http(s) 或 data URL 直接用
            if img.startswith("/output/") or img.startswith("/assets/"):
                ref_url = reference_to_data_url({"url": img}, max_size=1024)
            else:
                ref_url = img
            if not ref_url:
                continue
            content_parts.append({"type": "image_url", "image_url": {"url": ref_url}})
            ok_imgs += 1
        print(f"[canvas-llm] model={model} provider={payload.provider} text_len={len(payload.message)} images={ok_imgs}/{len(payload.images)}")
        upstream_messages.append({"role": "user", "content": content_parts})
    else:
        upstream_messages.append({"role": "user", "content": payload.message})
    raw = None
    try:
        async with httpx.AsyncClient(timeout=AI_REQUEST_TIMEOUT) as client:
            req_body = {"model": model, "messages": upstream_messages}
            if _is_apimart:
                req_body["stream"] = False   # APIMart 默认流式，强制关闭
            response = await client.post(
                f"{chat_base}/chat/completions",
                headers=chat_hdrs,
                json=req_body,
            )
            response.raise_for_status()
            if not response.content:
                raise HTTPException(status_code=502, detail="上游接口返回了空响应")
            raw = response.json()
    except httpx.HTTPStatusError as exc:
        body = exc.response.text or ""
        raise HTTPException(status_code=exc.response.status_code, detail=f"上游接口错误：{body}") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"请求上游接口失败：{exc}") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"解析上游响应失败：{exc}") from exc
    try:
        text = text_from_chat_response(raw).strip() if isinstance(raw, dict) else ""
        text = text or "接口返回了空回复。"
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"解析回复内容失败：{exc}") from exc
    raw_data = unwrap_apimart_response(raw) if isinstance(raw, dict) else {}
    return {"text": text, "model": model, "raw_usage": raw_data.get("usage")}

# --- 对话管理 ---

@app.get("/api/conversations")
async def conversations(request: Request, x_user_id: str = Header(default="")):
    user_id = safe_user_id(x_user_id, request)
    return {"user_id": user_id, "conversations": list_conversations(user_id)}

@app.post("/api/conversations")
async def create_conversation(payload: ConversationCreateRequest, request: Request, x_user_id: str = Header(default="")):
    user_id = safe_user_id(x_user_id, request)
    return {"conversation": new_conversation(user_id, payload.title)}

@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request, x_user_id: str = Header(default="")):
    user_id = safe_user_id(x_user_id, request)
    return {"conversation": load_conversation(user_id, conversation_id)}

@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, request: Request, x_user_id: str = Header(default="")):
    user_id = safe_user_id(x_user_id, request)
    db.delete_conversation_record(user_id, conversation_id)
    return {"ok": True}

# --- 画布管理 ---

@app.get("/api/canvases")
async def canvases():
    return {"canvases": list_canvases()}

@app.get("/api/canvases/trash")
async def trashed_canvases():
    return {"canvases": list_deleted_canvases(), "retention_days": 30}

@app.post("/api/canvases")
async def create_canvas(payload: CanvasCreateRequest):
    return {"canvas": new_canvas(payload.title, payload.icon)}

@app.get("/api/canvases/{canvas_id}/meta")
async def get_canvas_meta(canvas_id: str):
    canvas = load_canvas(canvas_id)
    return {
        "id": canvas.get("id"),
        "updated_at": canvas.get("updated_at", 0),
        "title": canvas.get("title", "未命名画布"),
        "icon": canvas.get("icon", "layers"),
    }

@app.get("/api/canvases/{canvas_id}")
async def get_canvas(canvas_id: str):
    return {"canvas": load_canvas(canvas_id)}

@app.post("/api/canvas-assets/check")
async def check_canvas_assets(payload: CanvasAssetCheckRequest):
    result = {}
    for url in payload.urls[:3000]:
        text = str(url or "").strip()
        if not text:
            continue
        if text.startswith("/output/") or text.startswith("/assets/"):
            result[text] = bool(output_file_from_url(text))
        else:
            result[text] = True
    return {"exists": result}

@app.post("/api/canvas-assets/download")
async def download_canvas_assets(payload: CanvasAssetDownloadRequest):
    buffer = BytesIO()
    used_names = set()
    count = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for url in payload.urls[:1000]:
            text = str(url or "").strip()
            if not text or not (text.startswith("/output/") or text.startswith("/assets/")):
                continue
            path = output_file_from_url(text)
            if not path or not os.path.isfile(path):
                continue
            base = os.path.basename(path) or f"image-{count + 1}.png"
            name, ext = os.path.splitext(base)
            archive_name = base
            suffix = 2
            while archive_name in used_names:
                archive_name = f"{name}-{suffix}{ext}"
                suffix += 1
            used_names.add(archive_name)
            zf.write(path, archive_name)
            count += 1
    if count <= 0:
        raise HTTPException(status_code=404, detail="没有可下载的本地图片")
    buffer.seek(0)
    filename = re.sub(r'[\\/:*?"<>|]+', "_", payload.filename or "canvas-output-images.zip")
    if not filename.lower().endswith(".zip"):
        filename += ".zip"
    encoded = urllib.parse.quote(filename)
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"}
    return Response(buffer.getvalue(), media_type="application/zip", headers=headers)

@app.put("/api/canvases/{canvas_id}")
async def update_canvas(canvas_id: str, payload: CanvasSaveRequest):
    canvas = load_canvas(canvas_id)
    current_updated_at = int(canvas.get("updated_at") or 0)
    if payload.base_updated_at and current_updated_at and int(payload.base_updated_at) < current_updated_at:
        raise HTTPException(status_code=409, detail={
            "message": "画布已被其他页面更新，已拒绝旧版本覆盖。",
            "canvas": canvas,
            "updated_at": current_updated_at,
        })
    canvas["title"] = (payload.title or canvas.get("title") or "未命名画布")[:80]
    canvas["icon"] = (payload.icon or canvas.get("icon") or "layers")[:32]
    canvas["nodes"] = payload.nodes
    canvas["connections"] = payload.connections
    canvas["viewport"] = payload.viewport
    canvas["logs"] = payload.logs[-500:]
    save_canvas(canvas)
    await manager.broadcast_canvas_updated(canvas_id, int(canvas.get("updated_at") or now_ms()), payload.client_id)
    return {"canvas": canvas}

@app.delete("/api/canvases/{canvas_id}")
async def delete_canvas(canvas_id: str):
    canvas = load_canvas_any(canvas_id)
    if not canvas.get("deleted_at"):
        canvas["deleted_at"] = now_ms()
        save_canvas(canvas)
    return {"ok": True}

@app.post("/api/canvases/{canvas_id}/restore")
async def restore_canvas(canvas_id: str):
    canvas = load_canvas_any(canvas_id)
    if canvas.get("deleted_at"):
        canvas.pop("deleted_at", None)
        save_canvas(canvas)
    return {"canvas": canvas}

@app.delete("/api/canvases/{canvas_id}/purge")
async def purge_canvas(canvas_id: str):
    db.delete_canvas_record(canvas_id)
    return {"ok": True}

# --- GPT 对话 ---

@app.post("/api/chat")
async def chat(payload: ChatRequest, request: Request, x_user_id: str = Header(default="")):
    user_id = safe_user_id(x_user_id, request)
    conversation = (
        load_conversation(user_id, payload.conversation_id)
        if payload.conversation_id
        else new_conversation(user_id, display_title(payload.message))
    )
    if not conversation.get("messages"):
        conversation["title"] = display_title(payload.message)

    refs = [ref.dict() for ref in payload.reference_images if ref.url]
    user_message = {
        "id": uuid.uuid4().hex,
        "role": "user",
        "content": payload.message,
        "created_at": now_ms(),
        "attachments": refs,
        "mode": payload.mode,
    }
    conversation["messages"].append(user_message)
    conversation["updated_at"] = now_ms()
    save_conversation(user_id, conversation)

    if payload.mode == "image":
        image_provider_id = payload.provider or get_primary_provider_id()
        provider = get_api_provider(image_provider_id)
        default_model = (provider.get("image_models") or [IMAGE_MODEL])[0]
        model = selected_model(payload.image_model or payload.model, default_model)
        try:
            image_data, raw = await generate_ai_image(payload.message, payload.size, payload.quality, model, refs, provider["id"])
            local_url = await save_ai_image_to_output(image_data, prefix="chat_")
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=exc.response.status_code, detail=f"上游生图接口错误：{exc.response.text}") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"请求上游生图接口失败：{exc}") from exc
        assistant_message = {
            "id": uuid.uuid4().hex,
            "role": "assistant",
            "type": "image",
            "content": payload.message,
            "image_url": local_url,
            "created_at": now_ms(),
            "model": model,
            "raw_usage": raw.get("usage") if isinstance(raw, dict) else None,
        }
    else:
        chat_base, chat_hdrs, model = resolve_chat_provider(payload.provider, payload.model)
        _conv_provider = get_api_provider(payload.provider)
        _conv_is_apimart = is_apimart_provider(_conv_provider)
        history = conversation["messages"][-MAX_HISTORY_MESSAGES:]
        upstream_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for item in history:
            msg = upstream_message_from_record(item)
            if msg:
                upstream_messages.append(msg)
        try:
            async with httpx.AsyncClient(timeout=AI_REQUEST_TIMEOUT) as client:
                conv_req_body = {"model": model, "messages": upstream_messages}
                if _conv_is_apimart:
                    conv_req_body["stream"] = False
                response = await client.post(
                    f"{chat_base}/chat/completions",
                    headers=chat_hdrs,
                    json=conv_req_body,
                )
                response.raise_for_status()
                raw = response.json()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=exc.response.status_code, detail=f"上游接口错误：{exc.response.text}") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"请求上游接口失败：{exc}") from exc
        raw_data = unwrap_apimart_response(raw) if isinstance(raw, dict) else raw
        assistant_message = {
            "id": uuid.uuid4().hex,
            "role": "assistant",
            "content": text_from_chat_response(raw).strip() or "接口返回了空回复。",
            "created_at": now_ms(),
            "model": model,
            "raw_usage": raw_data.get("usage") if isinstance(raw_data, dict) else None,
        }

    conversation["messages"].append(assistant_message)
    conversation["updated_at"] = now_ms()
    save_conversation(user_id, conversation)
    return {"conversation": conversation, "message": assistant_message}

@app.post("/api/chat/stream")
async def chat_stream(payload: ChatRequest, request: Request, x_user_id: str = Header(default="")):
    if payload.mode == "image":
        raise HTTPException(status_code=400, detail="图片模式请使用 /api/chat")

    user_id = safe_user_id(x_user_id, request)
    conversation = (
        load_conversation(user_id, payload.conversation_id)
        if payload.conversation_id
        else new_conversation(user_id, display_title(payload.message))
    )
    if not conversation.get("messages"):
        conversation["title"] = display_title(payload.message)

    refs = [ref.dict() for ref in payload.reference_images if ref.url]
    user_message = {
        "id": uuid.uuid4().hex,
        "role": "user",
        "content": payload.message,
        "created_at": now_ms(),
        "attachments": refs,
        "mode": payload.mode,
    }
    conversation["messages"].append(user_message)
    conversation["updated_at"] = now_ms()
    save_conversation(user_id, conversation)

    chat_base, chat_hdrs, model = resolve_chat_provider(payload.provider, payload.model)
    history = conversation["messages"][-MAX_HISTORY_MESSAGES:]
    upstream_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for item in history:
        msg = upstream_message_from_record(item)
        if msg:
            upstream_messages.append(msg)

    async def stream():
        content_parts = []
        raw_usage = None
        yield sse_event({"type": "meta", "conversation": conversation})
        try:
            async with httpx.AsyncClient(timeout=AI_REQUEST_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{chat_base}/chat/completions",
                    headers=chat_hdrs,
                    json={"model": model, "messages": upstream_messages, "stream": True},
                ) as response:
                    if response.status_code >= 400:
                        detail = await response.aread()
                        yield sse_event({"type": "error", "detail": f"上游接口错误：{detail.decode('utf-8', errors='ignore')}"})
                        return
                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        if line.startswith("data:"):
                            line = line[5:].strip()
                        if line == "[DONE]":
                            break
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(chunk, dict) and chunk.get("usage"):
                            raw_usage = chunk.get("usage")
                        delta = text_delta_from_chat_chunk(chunk)
                        if delta:
                            content_parts.append(delta)
                            yield sse_event({"type": "delta", "delta": delta})
        except httpx.HTTPError as exc:
            yield sse_event({"type": "error", "detail": f"请求上游接口失败：{exc}"})
            return

        assistant_message = {
            "id": uuid.uuid4().hex,
            "role": "assistant",
            "content": "".join(content_parts).strip() or "接口返回了空回复。",
            "created_at": now_ms(),
            "model": model,
            "raw_usage": raw_usage,
        }
        conversation["messages"].append(assistant_message)
        conversation["updated_at"] = now_ms()
        save_conversation(user_id, conversation)
        yield sse_event({"type": "done", "conversation": conversation, "message": assistant_message})

    return StreamingResponse(stream(), media_type="text/event-stream")

# --- 历史记录 ---

@app.get("/api/history")
async def get_history_api(history_type: str = Query(None, alias="type")):
    try:
        data = db.list_history_records()
        if history_type == "studio":
            data = [item for item in data if item.get("type") in STUDIO_HISTORY_TYPES]
        elif history_type:
            data = [item for item in data if item.get("type", "zimage") == history_type]
        data = [item for item in data if history_has_media(item)]

        def sort_key(item):
            ts = item.get("timestamp", 0)
            if isinstance(ts, (int, float)):
                return float(ts)
            return 0

        data.sort(key=sort_key, reverse=True)
        return data
    except Exception as e:
        print(f"读取历史记录失败: {e}")
        return []

@app.get("/api/history/user-meta")
async def get_history_user_meta(scope: str = Query("studio")):
    return db.load_history_user_meta(scope)

@app.put("/api/history/user-meta")
async def put_history_user_meta(payload: HistoryUserMetaPayload):
    return db.save_history_user_meta(
        payload.scope,
        {
            "pinned": payload.pinned or [],
            "favorites": payload.favorites or [],
            "order": payload.order or [],
        },
    )

@app.get("/api/queue_status")
async def get_queue_status(client_id: str):
    with QUEUE_LOCK:
        total = len(QUEUE)
        positions = [i + 1 for i, t in enumerate(QUEUE) if t["client_id"] == client_id]
        position = positions[0] if positions else 0
    return {"total": total, "position": position}

@app.post("/api/history/delete")
async def delete_history(req: DeleteHistoryRequest):
    try:
        with HISTORY_LOCK:
            target_record = db.delete_history_by_timestamp(req.timestamp)
        if target_record:
            for img_url in target_record.get("images", []):
                file_path = output_file_from_url(img_url)
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"Failed to delete file {file_path}: {e}")
            for vid_url in target_record.get("videos", []):
                file_path = output_file_from_url(vid_url)
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"Failed to delete video {file_path}: {e}")
            for aud_url in target_record.get("audios", []):
                file_path = output_file_from_url(aud_url)
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"Failed to delete audio {file_path}: {e}")
            return {"success": True}
        return {"success": False, "message": "Record not found"}
    except Exception as e:
        print(f"Delete history error: {e}")
        return {"success": False, "message": str(e)}

@app.post("/api/history/delete-batch")
async def delete_history_batch(req: DeleteHistoryBatchRequest):
    try:
        with HISTORY_LOCK:
            target_records = db.delete_history_batch(req.timestamps)

        for target_record in target_records:
            for img_url in target_record.get("images", []):
                file_path = output_file_from_url(img_url)
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"Failed to delete file {file_path}: {e}")
            for vid_url in target_record.get("videos", []):
                file_path = output_file_from_url(vid_url)
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"Failed to delete video {file_path}: {e}")
            for aud_url in target_record.get("audios", []):
                file_path = output_file_from_url(aud_url)
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"Failed to delete audio {file_path}: {e}")
        return {"success": True, "count": len(target_records)}
    except Exception as e:
        print(f"Delete batch history error: {e}")
        return {"success": False, "message": str(e)}

@app.get("/api/online-pending")
async def get_online_pending():
    now = time.time()
    with ACTIVE_PENDING_JOBS_LOCK:
        global ACTIVE_PENDING_JOBS
        ACTIVE_PENDING_JOBS = [job for job in ACTIVE_PENDING_JOBS if now - job.get("timestamp", 0) < 600]
        return ACTIVE_PENDING_JOBS

@app.post("/api/online-pending")
async def create_online_pending(job: OnlinePendingJob):
    with ACTIVE_PENDING_JOBS_LOCK:
        if not any(j["id"] == job.id for j in ACTIVE_PENDING_JOBS):
            ACTIVE_PENDING_JOBS.append(job.dict())
    return {"success": True}

@app.delete("/api/online-pending/{job_id}")
async def delete_online_pending(job_id: str):
    with ACTIVE_PENDING_JOBS_LOCK:
        global ACTIVE_PENDING_JOBS
        ACTIVE_PENDING_JOBS = [job for job in ACTIVE_PENDING_JOBS if job["id"] != job_id]
    return {"success": True}

# --- 本地 ComfyUI 生图 ---

@app.post("/api/generate")
def generate(req: GenerateRequest):
    global NEXT_TASK_ID
    current_task = None
    target_backend = None
    with QUEUE_LOCK:
        task_id = NEXT_TASK_ID
        NEXT_TASK_ID += 1
        current_task = {"task_id": task_id, "client_id": req.client_id}
        QUEUE.append(current_task)

    try:
        required_images = []
        for node_id, node_inputs in req.params.items():
            if isinstance(node_inputs, dict) and "image" in node_inputs:
                image_name = node_inputs["image"]
                if isinstance(image_name, str) and image_name:
                    required_images.append(image_name)

        target_backend = get_best_backend(required_images)
        with LOAD_LOCK:
            BACKEND_LOCAL_LOAD[target_backend] += 1

        for image_name in required_images:
            need_sync = False
            try:
                check_url = f"http://{target_backend}/view?filename={urllib.parse.quote(image_name)}&type=input"
                resp = requests.get(check_url, stream=True, timeout=0.5)
                resp.close()
                if resp.status_code != 200:
                    need_sync = True
            except:
                need_sync = True

            if need_sync:
                image_content = None
                image_type = "image/png"
                for addr in COMFYUI_INSTANCES:
                    if addr == target_backend: continue
                    try:
                        src_url = f"http://{addr}/view?filename={urllib.parse.quote(image_name)}&type=input"
                        r = requests.get(src_url, timeout=5)
                        if r.status_code == 200:
                            image_content = r.content
                            image_type = r.headers.get("Content-Type", "image/png")
                            break
                    except: continue

                if image_content:
                    try:
                        files = {'image': (image_name, image_content, image_type)}
                        requests.post(f"http://{target_backend}/upload/image", files=files, timeout=10)
                    except Exception as e:
                        print(f"Sync upload failed: {e}")

        workflow_path = os.path.join(WORKFLOW_DIR, req.workflow_json)
        if not os.path.exists(workflow_path) and req.workflow_json == "Z-Image.json":
            workflow_path = WORKFLOW_PATH
        if not os.path.exists(workflow_path):
            raise Exception(f"Workflow file not found: {req.workflow_json}")

        with open(workflow_path, 'r', encoding='utf-8') as f:
            workflow = json.load(f)

        seed = random.randint(1, 10**15)

        if "23" in workflow and req.prompt:
            workflow["23"]["inputs"]["text"] = req.prompt
        if "144" in workflow:
            workflow["144"]["inputs"]["width"] = req.width
            workflow["144"]["inputs"]["height"] = req.height
        if "22" in workflow:
            workflow["22"]["inputs"]["seed"] = seed
        if "158" in workflow:
            workflow["158"]["inputs"]["noise_seed"] = seed
        for node_id in ["146", "181"]:
            if node_id in workflow and "inputs" in workflow[node_id] and "seed" in workflow[node_id]["inputs"]:
                workflow[node_id]["inputs"]["seed"] = seed
        if "184" in workflow and "inputs" in workflow["184"] and "seed" in workflow["184"]["inputs"]:
            workflow["184"]["inputs"]["seed"] = seed
        if "172" in workflow and "inputs" in workflow["172"] and "seed" in workflow["172"]["inputs"]:
            workflow["172"]["inputs"]["seed"] = seed % 4294967295
        if "14" in workflow and "inputs" in workflow["14"] and "seed" in workflow["14"]["inputs"]:
            workflow["14"]["inputs"]["seed"] = seed

        for node_id, node_inputs in req.params.items():
            if node_id in workflow:
                if "inputs" not in workflow[node_id]:
                    workflow[node_id]["inputs"] = {}
                for input_name, value in node_inputs.items():
                    workflow[node_id]["inputs"][input_name] = value

        p = {"prompt": workflow, "client_id": CLIENT_ID}
        data = json.dumps(p).encode('utf-8')
        try:
            post_req = urllib.request.Request(f"http://{target_backend}/prompt", data=data)
            prompt_id = json.loads(urllib.request.urlopen(post_req, timeout=10).read())['prompt_id']
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            raise Exception(f"HTTP Error {e.code}: {error_body}")

        history_data = None
        for i in range(COMFYUI_HISTORY_TIMEOUT):
            try:
                res = get_comfy_history(target_backend, prompt_id)
                if prompt_id in res:
                    history_data = res[prompt_id]
                    break
            except Exception:
                pass
            time.sleep(1)

        if not history_data:
            raise Exception("ComfyUI 渲染超时")

        local_images = []
        local_videos = []
        local_urls = []
        current_timestamp = time.time()
        if 'outputs' in history_data:
            for node_id in history_data['outputs']:
                node_output = history_data['outputs'][node_id]
                if 'images' in node_output:
                    for img in node_output['images']:
                        prefix = f"{req.type}_{int(current_timestamp)}_"
                        local_path = download_comfy_output(target_backend, img, prefix=prefix)
                        if req.convert_to_jpg:
                            local_path = convert_output_to_jpg(local_path)
                        local_images.append(local_path)
                        local_urls.append(local_path)
                for output_key in ("videos", "gifs", "animated"):
                    for video in node_output.get(output_key, []) or []:
                        if not isinstance(video, dict) or not video.get("filename"):
                            continue
                        prefix = f"{req.type}_{int(current_timestamp)}_"
                        local_path = download_comfy_output(target_backend, video, prefix=prefix)
                        local_videos.append(local_path)
                        local_urls.append(local_path)

        result = {
            "prompt": resolve_generate_history_prompt(req),
            "images": local_images,
            "videos": local_videos,
            "outputs": local_urls,
            "seed": seed,
            "timestamp": current_timestamp,
            "type": req.type,
            "workflow_json": req.workflow_json,
            "task_id": task_id,
            "prompt_id": prompt_id,
            "backend": target_backend,
            "params": dict(req.params or {}),
        }
        if req.reference_images:
            result["params"]["reference_images"] = req.reference_images
        save_to_history(result)
        if GLOBAL_LOOP:
            asyncio.run_coroutine_threadsafe(manager.broadcast_new_image(result), GLOBAL_LOOP)
        return result

    except Exception as e:
        return {"images": [], "error": str(e)}
    finally:
        if target_backend:
            with LOAD_LOCK:
                if BACKEND_LOCAL_LOAD.get(target_backend, 0) > 0:
                    BACKEND_LOCAL_LOAD[target_backend] -= 1
        if current_task:
            with QUEUE_LOCK:
                if current_task in QUEUE:
                    QUEUE.remove(current_task)

# --- ComfyUI 工作流管理 ---

BUILTIN_WORKFLOWS = {"Z-Image.json", "Z-Image-Enhance.json", "2511.json", "klein-enhance.json", "Flux2-Klein.json", "upscale.json"}
CUSTOM_WORKFLOW_FOLDER = "custom"
LEGACY_CUSTOM_WORKFLOW_FOLDER = "自定义"
WORKFLOW_NAME_RE = re.compile(rf"^(?:(?:{CUSTOM_WORKFLOW_FOLDER}|{LEGACY_CUSTOM_WORKFLOW_FOLDER})/)?[a-zA-Z0-9_一-龥\.\-]+\.json$")

class WorkflowField(BaseModel):
    id: str
    node: str = ""
    input: str = ""
    name: str = ""
    type: str = "text"
    default: Any = None
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    options: List[str] = []
    random_enabled: bool = False

class WorkflowConfig(BaseModel):
    title: str = ""
    fields: List[WorkflowField] = []
    mini_cards: Dict[str, Any] = {}

class WorkflowUploadRequest(BaseModel):
    name: str
    workflow: Dict[str, Any]

WORKFLOW_PROMPT_INPUT_RE = re.compile(r"prompt|text|提示词|正向|负向|caption|description", re.I)

def is_workflow_prompt_field(field: WorkflowField) -> bool:
    if field.type == "textarea":
        return True
    key = f"{field.input or ''} {field.name or ''}"
    return bool(WORKFLOW_PROMPT_INPUT_RE.search(key))

def extract_workflow_prompt(config: WorkflowConfig, fields: Dict[str, Any]) -> str:
    positive: List[str] = []
    negative: List[str] = []
    for field in config.fields or []:
        if field.id not in fields:
            continue
        value = fields.get(field.id)
        if not isinstance(value, str) or not value.strip():
            continue
        if not is_workflow_prompt_field(field):
            continue
        key = f"{field.input or ''} {field.name or ''}".lower()
        if "负向" in key or "negative" in key:
            negative.append(value.strip())
        else:
            positive.append(value.strip())
    if positive and negative:
        return f"{positive[0]}\n\n[negative prompt]\n{negative[0]}"
    if positive:
        return positive[0]
    if negative:
        return negative[0]
    return ""

def resolve_generate_history_prompt(req: GenerateRequest) -> str:
    text = str(req.prompt or "").strip()
    if text:
        return text
    parts: List[str] = []
    for node_inputs in (req.params or {}).values():
        if not isinstance(node_inputs, dict):
            continue
        for key, value in node_inputs.items():
            if not isinstance(value, str) or not value.strip():
                continue
            key_lc = str(key).lower()
            if WORKFLOW_PROMPT_INPUT_RE.search(key_lc) or len(value.strip()) > 60:
                parts.append(value.strip())
    if parts:
        return parts[0]
    workflow = str(req.workflow_json or "").strip()
    return workflow or "Detail Enhance"

class WorkflowRunRequest(BaseModel):
    fields: Dict[str, Any] = {}
    config: WorkflowConfig
    client_id: str = ""
    history_type: str = "workflow-test"
    reference_images: List[AIReference] = Field(default_factory=list)
    prompt: str = ""

def workflow_path_from_name(name: str) -> str:
    if not WORKFLOW_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid workflow name")
    path = os.path.abspath(os.path.join(WORKFLOW_DIR, *name.split("/")))
    workflow_root = os.path.abspath(WORKFLOW_DIR)
    if os.path.commonpath([workflow_root, path]) != workflow_root:
        raise HTTPException(status_code=400, detail="Invalid workflow name")
    return path

def workflow_config_path(name: str) -> str:
    return workflow_path_from_name(name).replace(".json", ".config.json")

def is_builtin_workflow(name: str) -> bool:
    return "/" not in name and os.path.basename(name) in BUILTIN_WORKFLOWS

class ComfyInstancesPayload(BaseModel):
    instances: List[str] = []

@app.get("/api/comfyui/instances")
def get_comfyui_instances():
    return {"instances": COMFYUI_INSTANCES}

@app.put("/api/comfyui/instances")
def save_comfyui_instances(payload: ComfyInstancesPayload):
    # 宽容校验：去前后空白、去 http(s):// 前缀、去尾部斜杠；要求形如 host:port
    cleaned = []
    for item in payload.instances:
        s = str(item or "").strip()
        if not s:
            continue
        s = re.sub(r"^https?://", "", s)
        s = s.rstrip("/")
        if ":" not in s:
            raise HTTPException(status_code=400, detail=f"地址缺少端口号：{item}（应为 host:port，例如 127.0.0.1:8188）")
        host, _, port = s.rpartition(":")
        if not host or not port.isdigit():
            raise HTTPException(status_code=400, detail=f"地址不合法：{item}（应为 host:port，例如 127.0.0.1:8188）")
        if s in cleaned:
            continue
        cleaned.append(s)
    if not cleaned:
        raise HTTPException(status_code=400, detail="至少保留一个 ComfyUI 后端地址")
    # 写入 env 文件
    try:
        update_env_values({"COMFYUI_INSTANCES": ",".join(cleaned)})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"写入 env 失败：{e}")
    # 更新进程中的全局变量
    global COMFYUI_INSTANCES, COMFYUI_ADDRESS, BACKEND_LOCAL_LOAD
    COMFYUI_INSTANCES = cleaned
    COMFYUI_ADDRESS = cleaned[0]
    new_load = {addr: 0 for addr in cleaned}
    for addr, n in (BACKEND_LOCAL_LOAD or {}).items():
        if addr in new_load:
            new_load[addr] = n
    BACKEND_LOCAL_LOAD = new_load
    return {"instances": COMFYUI_INSTANCES}

@app.get("/api/workflows")
def list_workflows():
    if not os.path.isdir(WORKFLOW_DIR):
        return {"workflows": []}
    items = []
    for root, dirs, files in os.walk(WORKFLOW_DIR):
        if os.path.abspath(root) == os.path.abspath(WORKFLOW_DIR):
            dirs[:] = [d for d in dirs if d in {CUSTOM_WORKFLOW_FOLDER, LEGACY_CUSTOM_WORKFLOW_FOLDER}]
        for fn in sorted(files):
            if not fn.endswith(".json") or fn.endswith(".config.json"):
                continue
            rel = os.path.relpath(os.path.join(root, fn), WORKFLOW_DIR).replace("\\", "/")
            if is_builtin_workflow(rel):
                continue
            cfg = {}
            cfg_path = workflow_config_path(rel)
            if os.path.exists(cfg_path):
                try:
                    with open(cfg_path, "r", encoding="utf-8") as f:
                        cfg = json.load(f) or {}
                except Exception:
                    cfg = {}
            items.append({
                "name": rel,
                "title": cfg.get("title") or fn.replace(".json", ""),
                "builtin": False,
                "field_count": len(cfg.get("fields") or []),
            })
    items.sort(key=lambda item: (0 if item["name"].startswith(f"{CUSTOM_WORKFLOW_FOLDER}/") else 1, item["title"]))
    return {"workflows": items}

@app.get("/api/workflows/{name:path}")
def get_workflow(name: str):
    if not WORKFLOW_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid workflow name")
    workflow_path = workflow_path_from_name(name)
    if not os.path.exists(workflow_path):
        raise HTTPException(status_code=404, detail="Workflow not found")
    with open(workflow_path, "r", encoding="utf-8") as f:
        workflow = json.load(f)
    cfg = {"title": name.replace(".json", ""), "fields": []}
    cfg_path = workflow_config_path(name)
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f) or cfg
        except Exception:
            pass
    return {"name": name, "workflow": workflow, "config": cfg, "builtin": is_builtin_workflow(name)}

@app.post("/api/workflows")
def upload_workflow(payload: WorkflowUploadRequest):
    name = os.path.basename(payload.name.strip())
    if not name.endswith(".json"):
        name = name + ".json"
    if not WORKFLOW_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="工作流名称不合法，请使用中文/英文/数字/_-.")
    if not isinstance(payload.workflow, dict) or not payload.workflow:
        raise HTTPException(status_code=400, detail="工作流 JSON 为空")
    # 简单校验：是 API 格式（节点 id 为 key，含 class_type）
    sample = next(iter(payload.workflow.values()), None)
    if not isinstance(sample, dict) or "class_type" not in sample:
        raise HTTPException(status_code=400, detail="不是有效的 ComfyUI API 工作流 JSON（需包含 class_type）")
    custom_dir = os.path.join(WORKFLOW_DIR, CUSTOM_WORKFLOW_FOLDER)
    os.makedirs(custom_dir, exist_ok=True)
    stored_name = f"{CUSTOM_WORKFLOW_FOLDER}/{name}"
    path = workflow_path_from_name(stored_name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload.workflow, f, ensure_ascii=False, indent=2)
    return {"name": stored_name}

@app.put("/api/workflows/{name:path}/config")
def save_workflow_config(name: str, payload: WorkflowConfig):
    if not WORKFLOW_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid workflow name")
    workflow_path = workflow_path_from_name(name)
    if not os.path.exists(workflow_path):
        raise HTTPException(status_code=404, detail="Workflow not found")
    cfg_path = workflow_config_path(name)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(payload.dict(), f, ensure_ascii=False, indent=2)
    return {"config": payload.dict()}

@app.delete("/api/workflows/{name:path}")
def delete_workflow(name: str):
    if not WORKFLOW_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid workflow name")
    if is_builtin_workflow(name):
        raise HTTPException(status_code=400, detail="内置工作流不可删除")
    workflow_path = workflow_path_from_name(name)
    cfg_path = workflow_config_path(name)
    if not os.path.exists(workflow_path):
        raise HTTPException(status_code=404, detail="Workflow not found")
    os.remove(workflow_path)
    if os.path.exists(cfg_path):
        os.remove(cfg_path)
    return {"ok": True}

@app.post("/api/workflows/{name:path}/run")
def run_workflow(name: str, payload: WorkflowRunRequest):
    if not WORKFLOW_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid workflow name")
    if not os.path.exists(workflow_path_from_name(name)):
        raise HTTPException(status_code=404, detail="Workflow not found")
    # 根据 config 的字段把值映射成 params 节点覆盖
    params: Dict[str, Dict[str, Any]] = {}
    for field in payload.config.fields:
        if not field.node or not field.input:
            continue
        if field.id in payload.fields:
            value = payload.fields[field.id]
            # 类型转换
            if field.type in ("number", "slider"):
                try:
                    value = float(value) if (field.step and field.step < 1) else int(float(value))
                except Exception:
                    pass
            elif field.type == "boolean":
                value = bool(value)
            elif field.type == "dropdown":
                # 下拉值如果看起来是数字（如 "1024" / "2048" / "0.8"），自动转成 int/float
                if isinstance(value, str):
                    s = value.strip()
                    try:
                        if s and ('.' in s or 'e' in s.lower()):
                            value = float(s)
                        elif s and (s.lstrip('-').isdigit()):
                            value = int(s)
                    except (ValueError, TypeError):
                        pass
            params.setdefault(field.node, {})[field.input] = value
    prompt_text = (payload.prompt or "").strip() or extract_workflow_prompt(payload.config, payload.fields)
    req = GenerateRequest(
        prompt=prompt_text,
        workflow_json=name,
        params=params,
        type=payload.history_type or "workflow-test",
        client_id=payload.client_id or str(uuid.uuid4()),
        reference_images=[ref.dict() for ref in payload.reference_images if ref.url],
    )
    return generate(req)

# --- RunningHub API ---
RUNNINGHUB_BASE_URL = "https://www.runninghub.cn"
RUNNINGHUB_API_KEY_ENV = "RUNNINGHUB_API_KEY"
RUNNINGHUB_CONFIG_FILE = os.path.join(DATA_DIR, "runninghub.json")
RUNNINGHUB_LOCK = Lock()
RUNNINGHUB_FIELD_TYPES = {"text", "textarea", "number", "image", "boolean", "select"}
RUNNINGHUB_DATA_TYPES = {"text", "textarea", "number", "image"}
RUNNINGHUB_INPUT_METHODS = {"manual", "dropdown"}

class RunningHubField(BaseModel):
    id: str = ""
    name: str = ""
    nodeId: str = ""
    fieldName: str = ""
    type: str = "text"
    dataType: str = "text"
    inputMethod: str = "manual"
    default: Any = ""
    options: List[str] = []
    apiValue: Any = None  # 工作流 JSON 中的原始值（COMBO 须原样提交，如 dimensions 的空格）

class RunningHubWorkflow(BaseModel):
    id: str = ""
    name: str = ""
    workflow_id: str = ""
    fields: List[RunningHubField] = []

class RunningHubConfigPayload(BaseModel):
    api_key: Optional[str] = None
    workflows: Optional[List[RunningHubWorkflow]] = None

class RunningHubRunRequest(BaseModel):
    workflow_id: str
    fields: Dict[str, Any] = {}
    prompt: str = ""
    reference_images: List[Dict[str, Any]] = []
    client_id: str = ""

def runninghub_sync_field_schema(field: dict) -> dict:
    if not isinstance(field, dict):
        return field
    legacy = str(field.get("type") or "text").strip().lower()
    dt = str(field.get("dataType") or "").strip().lower()
    im = str(field.get("inputMethod") or "").strip().lower()
    if not dt or not im:
        if legacy == "select":
            dt = dt or "text"
            im = im or "dropdown"
        elif legacy == "textarea":
            dt, im = "textarea", "manual"
        elif legacy in ("number", "image", "text", "boolean"):
            dt = dt or ("text" if legacy == "boolean" else legacy)
            im = im or "manual"
        else:
            dt, im = "text", "manual"
    if dt not in RUNNINGHUB_DATA_TYPES:
        dt = "text"
    if im not in RUNNINGHUB_INPUT_METHODS:
        im = "manual"
    field["dataType"] = dt
    field["inputMethod"] = im
    field["type"] = "select" if im == "dropdown" else dt
    return field

def runninghub_build_field_item(field: dict) -> dict:
    item = runninghub_sync_field_schema(dict(field))
    ftype = str(item.get("type") or "text").strip().lower()
    if ftype not in RUNNINGHUB_FIELD_TYPES:
        ftype = "text"
        item["type"] = ftype
    options = [str(o) for o in (item.get("options") or []) if str(o).strip()]
    field_item = {
        "id": str(item.get("id") or "").strip() or f"f-{uuid.uuid4().hex[:6]}",
        "name": str(item.get("name") or "").strip(),
        "nodeId": str(item.get("nodeId") or "").strip(),
        "fieldName": str(item.get("fieldName") or "").strip(),
        "type": ftype,
        "dataType": str(item.get("dataType") or "text").strip().lower(),
        "inputMethod": str(item.get("inputMethod") or "manual").strip().lower(),
        "default": item.get("default", ""),
        "options": options,
    }
    if item.get("apiValue") is not None:
        field_item["apiValue"] = item.get("apiValue")
    return field_item

class RunningHubFetchJsonRequest(BaseModel):
    workflow_id: str = ""

def runninghub_default_config():
    return {"workflows": []}

def load_runninghub_config():
    with RUNNINGHUB_LOCK:
        if not os.path.exists(RUNNINGHUB_CONFIG_FILE):
            return runninghub_default_config()
        try:
            with open(RUNNINGHUB_CONFIG_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f) or {}
        except Exception:
            return runninghub_default_config()
    workflows = []
    for wf_item in raw.get("workflows") or []:
        if not isinstance(wf_item, dict):
            continue
        wf_id = str(wf_item.get("id") or "").strip() or f"rh-{uuid.uuid4().hex[:8]}"
        fields = []
        for field in wf_item.get("fields") or []:
            if not isinstance(field, dict):
                continue
            fields.append(runninghub_build_field_item(field))
        workflows.append({
            "id": wf_id,
            "name": str(wf_item.get("name") or "").strip() or wf_id,
            "workflow_id": str(wf_item.get("workflow_id") or "").strip(),
            "fields": runninghub_normalize_workflow_fields(fields),
        })
    return {"workflows": workflows}

def save_runninghub_config(payload: RunningHubConfigPayload):
    data = load_runninghub_config()
    if payload.workflows is None:
        workflows = data.get("workflows") or []
    else:
        workflows = []
    for wf in payload.workflows or []:
        wf_id = str(wf.id or "").strip() or f"rh-{uuid.uuid4().hex[:8]}"
        fields = []
        for field in wf.fields or []:
            if hasattr(field, "model_dump"):
                raw = field.model_dump()
            elif hasattr(field, "dict"):
                raw = field.dict()
            else:
                raw = dict(field)
            fields.append(runninghub_build_field_item(raw))
        workflows.append({
            "id": wf_id,
            "name": str(wf.name or "").strip() or wf_id,
            "workflow_id": str(wf.workflow_id or "").strip(),
            "fields": runninghub_normalize_workflow_fields(fields),
        })
    data["workflows"] = workflows
    os.makedirs(DATA_DIR, exist_ok=True)
    with RUNNINGHUB_LOCK:
        with open(RUNNINGHUB_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    env_updates = {}
    if payload.api_key is not None:
        env_updates[RUNNINGHUB_API_KEY_ENV] = str(payload.api_key or "").strip()
    if env_updates:
        update_env_values(env_updates)
        reload_env_globals()
    return data

def runninghub_api_key():
    return str(os.getenv(RUNNINGHUB_API_KEY_ENV, "") or "").strip()

def runninghub_public_config():
    key = runninghub_api_key()
    return {
        "has_key": bool(key),
        "key_preview": f"{key[:4]}...{key[-4:]}" if len(key) >= 8 else "",
        "key_env": RUNNINGHUB_API_KEY_ENV,
        "workflows": load_runninghub_config().get("workflows") or [],
    }

def runninghub_post(path: str, payload: dict, timeout=120):
    url = f"{RUNNINGHUB_BASE_URL}{path}"
    headers = {"Content-Type": "application/json", "Host": "www.runninghub.cn"}
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"RunningHub 请求失败：{exc}") from exc
    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail=f"RunningHub 返回非 JSON：{resp.text[:200]}")
    return data

def runninghub_parse_workflow_prompt(data: Any) -> Dict[str, Any]:
    if isinstance(data, dict):
        return data
    if isinstance(data, str):
        text = data.strip()
        if not text:
            raise HTTPException(status_code=502, detail="工作流 JSON 为空")
        try:
            parsed = json.loads(text)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"工作流 JSON 解析失败：{exc}") from exc
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=502, detail="工作流 JSON 格式无效")
        return parsed
    raise HTTPException(status_code=502, detail="未返回有效的工作流 prompt")

def runninghub_fetch_workflow_json(workflow_id: str) -> Dict[str, Any]:
    workflow_id = str(workflow_id or "").strip()
    if not workflow_id:
        raise HTTPException(status_code=400, detail="请填写 Workflow ID")
    api_key = runninghub_api_key()
    if not api_key:
        raise HTTPException(status_code=400, detail="请先在 RunningHub 设置中配置 API Key")
    body = runninghub_post(
        "/api/openapi/getJsonApiFormat",
        {"apiKey": api_key, "workflowId": workflow_id},
        timeout=60,
    )
    if body.get("code") != 0:
        raise HTTPException(status_code=400, detail=body.get("msg") or "获取工作流 JSON 失败")
    payload = body.get("data") or {}
    prompt_raw = payload.get("prompt") if isinstance(payload, dict) else payload
    workflow = runninghub_parse_workflow_prompt(prompt_raw)
    return {"workflow_id": workflow_id, "workflow": workflow, "node_count": len(workflow)}

def runninghub_is_link_input(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int)

def runninghub_norm_spaces(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip())

def runninghub_parse_dimension_combo(text: Any) -> Optional[tuple]:
    s = str(text or "").strip()
    m = re.search(r"(\d+)\s*x\s*(\d+)(?:\s*\(([^)]+)\))?", s, re.I)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), str(m.group(3) or "").strip().lower()

def runninghub_combo_format_reference(reference: str, selected: str) -> str:
    """将选中的分辨率/COMBO 值按工作流 JSON 原值的空格与后缀格式重写后提交。"""
    ref = str(reference or "")
    sel = str(selected or "")
    if not ref or not sel:
        return sel or ref
    if runninghub_norm_spaces(ref) == runninghub_norm_spaces(sel):
        return ref
    parsed = runninghub_parse_dimension_combo(sel)
    if not parsed:
        return sel
    w, h, orient = parsed
    m = re.search(r"(\d+)(.*?)[xX](.*?)(\d+)", ref)
    if not m:
        return sel
    core = f"{w}{m.group(2)}x{m.group(3)}{h}"
    if re.search(r"\([^)]+\)\s*$", ref):
        if orient:
            return f"{core} ({orient})"
        sel_suffix = re.search(r"\(([^)]+)\)\s*$", sel)
        if sel_suffix:
            return f"{core} ({sel_suffix.group(1)})"
    return core

def runninghub_get_select_reference(
    field: dict,
    node_id: str,
    field_name: str,
    workflow_prompt: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    api_value = field.get("apiValue")
    if isinstance(api_value, str) and api_value.strip():
        return api_value
    if workflow_prompt:
        node = workflow_prompt.get(str(node_id))
        if isinstance(node, dict):
            inputs = node.get("inputs") or {}
            if isinstance(inputs, dict):
                original = inputs.get(field_name)
                if isinstance(original, str) and original.strip():
                    return original
    default = field.get("default")
    if isinstance(default, str) and default.strip():
        return default
    return None

def runninghub_finalize_select_value(
    field: dict,
    value: Any,
    node_id: str,
    field_name: str,
    workflow_prompt: Optional[Dict[str, Any]] = None,
) -> Any:
    ftype = str(field.get("type") or "text").strip().lower()
    if ftype != "select" or not isinstance(value, str):
        return value
    reference = runninghub_get_select_reference(field, node_id, field_name, workflow_prompt)
    if not reference:
        return value
    if runninghub_norm_spaces(value) == runninghub_norm_spaces(reference):
        return reference
    if runninghub_parse_dimension_combo(value) and runninghub_parse_dimension_combo(reference):
        return runninghub_combo_format_reference(reference, value)
    return value

RUNNINGHUB_SDXL_DIMENSIONS = [
    "1536 x 640 (landscape)",
    "1344 x 768 (landscape)",
    "1216 x 832 (landscape)",
    "1152 x 896 (landscape)",
    "1024 x 1024 (square)",
    "896 x 1152 (portrait)",
    "832 x 1216 (portrait)",
    "768 x 1344 (portrait)",
    "640 x 1536 (portrait)",
]

RUNNINGHUB_SAMPLER_NAMES = [
    "euler", "euler_ancestral", "heun", "heunpp2", "dpm_2", "dpm_2_ancestral", "lms",
    "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_2m",
    "dpmpp_sde_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm", "uni_pc",
    "uni_pc_bh2",
]

RUNNINGHUB_SCHEDULERS = [
    "normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta",
]

RUNNINGHUB_SELECT_PRESETS: Dict[str, List[str]] = {
    "dimensions": RUNNINGHUB_SDXL_DIMENSIONS,
    "resolution": RUNNINGHUB_SDXL_DIMENSIONS,
    "preset": RUNNINGHUB_SDXL_DIMENSIONS,
    "sampler_name": RUNNINGHUB_SAMPLER_NAMES,
    "scheduler": RUNNINGHUB_SCHEDULERS,
}

def runninghub_canonical_option(options: List[str], value: Any) -> Any:
    if value is None or value == "":
        return value
    sv = str(value)
    if sv in options:
        return sv
    norm_val = runninghub_norm_spaces(sv)
    for opt in options:
        if runninghub_norm_spaces(opt) == norm_val:
            return opt
    return value

def runninghub_ensure_option_in_list(options: List[str], value: Any) -> List[str]:
    opts = [str(o) for o in options if str(o).strip()]
    if value is None or value == "":
        return opts
    canonical = runninghub_canonical_option(opts, value)
    if canonical in opts:
        return opts
    return [str(canonical)] + opts

def runninghub_infer_select_options(class_type: str, field_name: str, value: Any) -> Optional[List[str]]:
    if runninghub_is_link_input(value) or isinstance(value, (dict, list)):
        return None
    if not isinstance(value, str):
        return None
    fn = str(field_name or "").strip().lower()
    if re.search(r"prompt|text|description|caption|提示|正向|负向", fn) or len(value) > 120:
        return None
    if re.search(r"image|filename|path", fn):
        return None
    presets = RUNNINGHUB_SELECT_PRESETS.get(fn)
    if presets:
        return runninghub_ensure_option_in_list(presets, value)
    if re.search(r"\d+\s*x\s*\d+", value, re.I):
        return runninghub_ensure_option_in_list(RUNNINGHUB_SDXL_DIMENSIONS, value)
    return None

def runninghub_resolve_field_meta(
    value: Any,
    input_name: str,
    class_type: str = "",
) -> Dict[str, Any]:
    select_options = runninghub_infer_select_options(class_type, input_name, value)
    if select_options:
        default = runninghub_canonical_option(select_options, value)
        return {"type": "select", "options": select_options, "default": default}
    lc = str(input_name or "").lower()
    if isinstance(value, bool):
        return {"type": "text", "options": [], "default": value}
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return {"type": "number", "options": [], "default": value}
    if isinstance(value, str):
        if re.search(r"prompt|text|description|caption|提示|正向|负向", lc) or len(value) > 80:
            ftype = "textarea" if len(value) > 80 or "prompt" in lc else "text"
            return {"type": ftype, "options": [], "default": value}
        if re.search(r"image|filename|path", lc):
            return {"type": "image", "options": [], "default": value}
        return {"type": "text", "options": [], "default": value}
    return {"type": "text", "options": [], "default": value if not isinstance(value, (dict, list)) else ""}

def runninghub_guess_field_type(value: Any, input_name: str, class_type: str = "") -> str:
    return runninghub_resolve_field_meta(value, input_name, class_type).get("type") or "text"

def runninghub_build_input_meta(workflow: Dict[str, Any]) -> Dict[str, Dict[str, Dict[str, Any]]]:
    meta: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for node_id, node in (workflow or {}).items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        node_meta: Dict[str, Dict[str, Any]] = {}
        for input_name, raw_value in inputs.items():
            if runninghub_is_link_input(raw_value):
                continue
            resolved = runninghub_resolve_field_meta(raw_value, input_name, class_type)
            if resolved.get("type") == "select":
                node_meta[str(input_name)] = {
                    "type": "select",
                    "options": resolved.get("options") or [],
                }
        if node_meta:
            meta[str(node_id)] = node_meta
    return meta

def runninghub_should_auto_expose(input_name: str, value: Any) -> bool:
    if runninghub_is_link_input(value):
        return False
    if isinstance(value, (dict, list)):
        return False
    lc = str(input_name or "").lower()
    if re.search(r"seed|noise|latent|model|clip|vae|ckpt|checkpoint|unet|lora|control|mask|cond|guidance", lc):
        return False
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return False
    return True

def runninghub_suggest_fields(workflow: Dict[str, Any]) -> List[Dict[str, Any]]:
    suggested = []
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        title = str((node.get("_meta") or {}).get("title") or node.get("class_type") or node_id)
        class_type = str(node.get("class_type") or "")
        for input_name, raw_value in inputs.items():
            if not runninghub_should_auto_expose(input_name, raw_value):
                continue
            resolved = runninghub_resolve_field_meta(raw_value, input_name, class_type)
            ftype = resolved.get("type") or "text"
            if ftype == "image":
                continue
            default = resolved.get("default")
            if default is None and not isinstance(raw_value, (dict, list)):
                default = raw_value
            if default is None:
                default = ""
            label = str(input_name or "").strip()
            if title and label:
                display = f"{title} · {label}"
            else:
                display = title or label
            field_name = str(input_name or "").strip()
            if ftype in ("text", "textarea") and not field_name:
                field_name = "text"
            item = {
                "nodeId": str(node_id),
                "fieldName": field_name,
                "name": display,
                "type": ftype,
                "default": default,
            }
            if ftype == "select":
                item["options"] = resolved.get("options") or []
                if isinstance(raw_value, str):
                    item["apiValue"] = raw_value
            suggested.append(item)
    return suggested

def runninghub_upload_file(path: str, api_key: str):
    url = f"{RUNNINGHUB_BASE_URL}/task/openapi/upload"
    with open(path, "rb") as f:
        files = {"file": (os.path.basename(path), f, content_type_for_path(path))}
        data = {"apiKey": api_key, "fileType": "input"}
        resp = requests.post(url, files=files, data=data, headers={"Host": "www.runninghub.cn"}, timeout=120)
    try:
        body = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail=f"RunningHub 上传失败：{resp.text[:200]}")
    if body.get("code") != 0:
        raise HTTPException(status_code=400, detail=body.get("msg") or "RunningHub 上传失败")
    file_name = (body.get("data") or {}).get("fileName")
    if not file_name:
        raise HTTPException(status_code=502, detail="RunningHub 上传未返回 fileName")
    return file_name

def runninghub_is_text_field(field_type: str) -> bool:
    return str(field_type or "").lower() in ("text", "textarea")

def runninghub_normalize_field_name(field: dict) -> str:
    """ComfyUI 文本节点常见字段名为 text；配置留空时自动补全，避免 nodeInfoList 漏传提示词。"""
    field_name = str(field.get("fieldName") or "").strip()
    if field_name:
        return field_name
    ftype = str(field.get("type") or "text").strip().lower()
    if runninghub_is_text_field(ftype):
        return "text"
    if ftype == "image":
        return "image"
    label = f"{field.get('name') or ''} {field.get('fieldName') or ''}".lower()
    if any(k in label for k in ("prompt", "提示", "caption", "positive", "negative")):
        return "text"
    return ""

def runninghub_fill_select_options(field: dict) -> dict:
    ftype = str(field.get("type") or "text").strip().lower()
    if ftype != "select":
        return field
    field_name = str(field.get("fieldName") or "").strip()
    default = field.get("default", "")
    opts = [str(o) for o in (field.get("options") or []) if str(o).strip()]
    if len(opts) <= 1:
        inferred = runninghub_infer_select_options("", field_name, default)
        if inferred and len(inferred) > len(opts):
            opts = inferred
    if not opts and default not in (None, ""):
        opts = [str(default)]
    field["options"] = opts
    if opts:
        field["default"] = runninghub_canonical_option(opts, default)
    return field

def runninghub_normalize_workflow_fields(fields: list) -> list:
    normalized = []
    for field in fields or []:
        if not isinstance(field, dict):
            continue
        item = runninghub_sync_field_schema(dict(field))
        item["fieldName"] = runninghub_normalize_field_name(item)
        ftype = str(item.get("type") or "text").strip().lower()
        if ftype == "select":
            runninghub_fill_select_options(item)
        else:
            item.pop("options", None)
        normalized.append(item)
    return normalized

def runninghub_value_is_empty(field_type: str, value: Any) -> bool:
    ftype = str(field_type or "").lower()
    if ftype == "boolean":
        return False
    if ftype == "number":
        return value is None or value == ""
    if ftype == "image":
        return not str(value or "").strip()
    return not str(value if value is not None else "").strip()

def runninghub_resolve_select_raw(field: dict, incoming_value: Any) -> Any:
    """select/COMBO 字段：空值回退 default/apiValue；非空值保留用户选择（格式对齐在 finalize 阶段）。"""
    ftype = str(field.get("type") or "text").strip().lower()
    if ftype != "select":
        return incoming_value
    api_value = field.get("apiValue")
    if api_value is None or api_value == "":
        if isinstance(field.get("default"), str):
            api_value = field.get("default")
    if incoming_value is None or incoming_value == "":
        return api_value if api_value is not None else ""
    return incoming_value

def runninghub_align_field_value(
    node_id: str,
    field_name: str,
    value: Any,
    workflow_prompt: Optional[Dict[str, Any]] = None,
) -> Any:
    """下拉/文本值在归一化空格后若与工作流默认值等价，则提交工作流 JSON 中的原始字符串。"""
    if workflow_prompt is None or value is None:
        return value
    node = workflow_prompt.get(str(node_id))
    if not isinstance(node, dict):
        return value
    inputs = node.get("inputs") or {}
    if not isinstance(inputs, dict):
        return value
    original = inputs.get(field_name)
    if isinstance(value, str) and isinstance(original, str):
        if runninghub_norm_spaces(value) == runninghub_norm_spaces(original):
            return original
        if runninghub_parse_dimension_combo(value) and runninghub_parse_dimension_combo(original):
            return runninghub_combo_format_reference(original, value)
    if isinstance(value, (int, float)) and isinstance(original, (int, float)) and not isinstance(original, bool):
        try:
            if float(value) == float(original):
                return original
        except Exception:
            pass
    return value

def build_runninghub_node_info_list(
    workflow: dict,
    payload: RunningHubRunRequest,
    api_key: str,
    workflow_prompt: Optional[Dict[str, Any]] = None,
):
    """按 RunningHub openapi create 文档组装 nodeInfoList，避免空值覆盖工作流默认提示词。"""
    refs = []
    for ref in payload.reference_images or []:
        url = ref.get("url") if isinstance(ref, dict) else ref
        if url:
            refs.append(str(url))
    incoming = {str(k): v for k, v in (payload.fields or {}).items()}
    global_prompt = (payload.prompt or "").strip()
    resolved = []
    for field in workflow.get("fields") or []:
        fid = str(field.get("id") or "").strip()
        node_id = str(field.get("nodeId") or "").strip()
        field_name = runninghub_normalize_field_name(field)
        if not node_id or not field_name:
            continue
        ftype = str(field.get("type") or "text").lower()
        raw_value = incoming.get(fid)
        if raw_value is None:
            raw_value = field.get("default", "")
        raw_value = runninghub_resolve_select_raw(field, raw_value)
        resolved.append({
            "fid": fid,
            "node_id": node_id,
            "field_name": field_name,
            "ftype": ftype,
            "raw": raw_value,
            "field": field,
        })
    text_items = [item for item in resolved if runninghub_is_text_field(item["ftype"])]
    if global_prompt:
        if len(text_items) == 1:
            text_items[0]["raw"] = global_prompt
        else:
            for item in text_items:
                if runninghub_value_is_empty(item["ftype"], item["raw"]):
                    item["raw"] = global_prompt
    node_info_list = []
    seen = set()
    for item in resolved:
        value = runninghub_field_value(api_key, item["ftype"], item["raw"], refs)
        if item["ftype"] == "image" and runninghub_value_is_empty("image", value):
            continue
        if runninghub_value_is_empty(item["ftype"], value):
            continue
        dedupe_key = (item["node_id"], item["field_name"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        field_value = runninghub_align_field_value(
            item["node_id"],
            item["field_name"],
            value,
            workflow_prompt,
        )
        if item["ftype"] == "select":
            field_value = runninghub_finalize_select_value(
                item["field"],
                field_value,
                item["node_id"],
                item["field_name"],
                workflow_prompt,
            )
        if item["ftype"] in ("select", "text", "textarea"):
            field_value = str(field_value if field_value is not None else "")
        node_info_list.append({
            "nodeId": item["node_id"],
            "fieldName": item["field_name"],
            "fieldValue": field_value,
        })
    return node_info_list, global_prompt

def runninghub_field_value(api_key: str, field_type: str, value: Any, references: List[str]):
    if value is None:
        value = ""
    if field_type == "image":
        ref = ""
        if isinstance(value, str) and value.strip():
            ref = value.strip()
        elif references:
            ref = references.pop(0)
        if not ref:
            return ""
        if ref.startswith("http://") or ref.startswith("https://"):
            return ref
        local_path = output_file_from_url(ref)
        if local_path:
            return runninghub_upload_file(local_path, api_key)
        return ref
    if field_type in ("number",):
        try:
            if isinstance(value, str) and value.strip():
                if "." in value or "e" in value.lower():
                    return float(value)
                return int(value)
        except Exception:
            pass
        return value
    if field_type == "boolean":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}
    if field_type == "select":
        return str(value if value is not None else "")
    return str(value if value is not None else "").strip()

def runninghub_download_output(url: str):
    parsed = urllib.parse.urlparse(url)
    ext = os.path.splitext(parsed.path)[1].lower() or ".png"
    if ext not in [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"]:
        ext = ".png"
    filename = f"rh_{uuid.uuid4().hex[:12]}{ext}"
    folder, _ = output_storage("output")
    path = os.path.join(folder, filename)
    with requests.get(url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 64):
                if chunk:
                    f.write(chunk)
    rel = os.path.relpath(path, OUTPUT_DIR).replace("\\", "/")
    return f"/output/{rel}"

def runninghub_format_task_failure(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    failed = data.get("failedReason") if isinstance(data.get("failedReason"), dict) else data
    if not isinstance(failed, dict):
        return str(data.get("exception_message") or data.get("msg") or "").strip()
    parts = []
    node_name = str(failed.get("node_name") or failed.get("nodeName") or "").strip()
    if node_name:
        parts.append(f"节点 {node_name}")
    exc = str(failed.get("exception_message") or failed.get("message") or "").strip()
    if exc:
        parts.append(exc)
    trace = str(failed.get("traceback") or "").strip()
    if trace:
        parts.append(trace[:800])
    return " — ".join(parts) if parts else ""

def runninghub_collect_output_urls(outputs_body: dict) -> List[str]:
    data = outputs_body.get("data")
    urls: List[str] = []
    seen = set()

    def add_url(raw: Any):
        u = str(raw or "").strip()
        if u and u not in seen:
            seen.add(u)
            urls.append(u)

    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            add_url(item.get("fileUrl") or item.get("url"))
    elif isinstance(data, dict):
        add_url(data.get("fileUrl") or data.get("url"))
        for item in data.get("results") or data.get("outputs") or []:
            if isinstance(item, dict):
                add_url(item.get("fileUrl") or item.get("url"))
    for item in outputs_body.get("results") or []:
        if isinstance(item, dict):
            add_url(item.get("url") or item.get("fileUrl"))
    return urls

def runninghub_query_v2_task(api_key: str, task_id: str) -> dict:
    url = f"{RUNNINGHUB_BASE_URL}/openapi/v2/query"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    try:
        resp = requests.post(url, json={"taskId": task_id}, headers=headers, timeout=120)
    except requests.RequestException as exc:
        print(f"RunningHub v2 query 失败: {exc}")
        return {}
    try:
        return resp.json() or {}
    except Exception:
        print(f"RunningHub v2 query 非 JSON：{resp.text[:200]}")
        return {}

def runninghub_v2_task_status(body: dict) -> str:
    return str(body.get("status") or "").strip().upper()

def runninghub_v2_is_terminal_success(body: dict) -> bool:
    status = runninghub_v2_task_status(body)
    return status in {"SUCCESS", "SUCCEED", "FINISHED", "COMPLETE", "COMPLETED"}

def runninghub_v2_is_failed(body: dict) -> bool:
    status = runninghub_v2_task_status(body)
    if status in {"FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED"}:
        return True
    error_code = str(body.get("errorCode") or "").strip()
    return bool(error_code and error_code not in {"0", "200"})

def runninghub_download_outputs(urls: List[str]) -> List[str]:
    local_urls = []
    for remote in urls:
        try:
            local_urls.append(runninghub_download_output(remote))
        except Exception as e:
            print(f"RunningHub 下载输出失败: {e}")
            local_urls.append(remote)
    return local_urls

def runninghub_wait_outputs(api_key: str, task_id: str, timeout_sec=600):
    """轮询 openapi/outputs，并在必要时回退到 v2/query 获取 results.url。"""
    deadline = time.time() + timeout_sec
    last_code = None
    last_msg = ""
    poll_interval = 3
    empty_success_hits = 0
    max_empty_success_hits = 20
    while time.time() < deadline:
        outputs_body = runninghub_post("/task/openapi/outputs", {"apiKey": api_key, "taskId": task_id})
        code = outputs_body.get("code")
        last_code = code
        last_msg = str(outputs_body.get("msg") or "")

        v2_body = runninghub_query_v2_task(api_key, task_id)
        urls = runninghub_collect_output_urls(outputs_body)
        if not urls:
            urls = runninghub_collect_output_urls(v2_body)

        if runninghub_v2_is_failed(v2_body):
            detail = runninghub_format_task_failure(v2_body)
            if not detail:
                detail = str(v2_body.get("errorMessage") or last_msg or "RunningHub 任务执行失败")
            raise HTTPException(status_code=400, detail=f"{detail}（taskId={task_id}）")

        if urls:
            return {
                "status": "SUCCESS",
                "outputs": runninghub_download_outputs(urls),
                "remote_outputs": urls,
            }

        v2_status = runninghub_v2_task_status(v2_body)
        still_running = (
            code in (804, 813)
            or v2_status in {"RUNNING", "QUEUED", "PENDING", "WAITING", "PROCESSING"}
        )
        if still_running:
            empty_success_hits = 0
            time.sleep(poll_interval)
            continue

        if code == 805:
            detail = runninghub_format_task_failure(outputs_body.get("data"))
            if not detail:
                detail = runninghub_format_task_failure(outputs_body)
            if not detail:
                detail = str(v2_body.get("errorMessage") or last_msg or "RunningHub 任务执行失败")
            raise HTTPException(status_code=400, detail=f"{detail}（taskId={task_id}）")

        if code == 0 or runninghub_v2_is_terminal_success(v2_body):
            empty_success_hits += 1
            if empty_success_hits >= max_empty_success_hits:
                if runninghub_v2_is_terminal_success(v2_body):
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "RunningHub 任务显示成功，但未返回任何图片/视频文件。"
                            "通常原因是工作流缺少 SaveImage / PreviewImage 等输出节点，"
                            "或该工作流需要上传参考图/视频作为输入但未提供。"
                            "请在 RunningHub 网页端用相同参数运行一次，确认能产出文件后再暴露参数。"
                            f"（taskId={task_id}）"
                        ),
                    )
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "RunningHub 任务已结束但未返回图片，通常是 nodeInfoList 参数与工作流不匹配，"
                        "或输出文件尚未就绪。请检查 dimensions 等参数是否与工作流 JSON 完全一致。"
                        f"（taskId={task_id}）"
                    ),
                )
            time.sleep(poll_interval)
            continue

        if code not in (None, 0, 804, 813, 805):
            raise HTTPException(
                status_code=400,
                detail=f"RunningHub 查询失败（code={code}，{last_msg or 'unknown'}，taskId={task_id}）",
            )

        time.sleep(poll_interval)
    raise HTTPException(
        status_code=408,
        detail=f"RunningHub 任务超时（已等待 {int(timeout_sec)} 秒，最后 code={last_code}，{last_msg or '无输出'}，taskId={task_id}）",
    )

@app.get("/api/runninghub/config")
async def get_runninghub_config():
    return runninghub_public_config()

@app.put("/api/runninghub/config")
async def put_runninghub_config(payload: RunningHubConfigPayload):
    data = save_runninghub_config(payload)
    return runninghub_public_config()

@app.post("/api/runninghub/fetch-workflow-json")
async def fetch_runninghub_workflow_json(payload: RunningHubFetchJsonRequest):
    result = runninghub_fetch_workflow_json(payload.workflow_id)
    workflow = result["workflow"]
    return {
        **result,
        "suggested_fields": runninghub_suggest_fields(workflow),
        "input_meta": runninghub_build_input_meta(workflow),
    }

@app.get("/api/runninghub/workflows")
async def list_runninghub_workflows():
    return {"workflows": load_runninghub_config().get("workflows") or []}

@app.get("/api/runninghub/workflows/{workflow_key}")
async def get_runninghub_workflow(workflow_key: str):
    cfg = load_runninghub_config()
    workflow = next((w for w in cfg.get("workflows") or [] if w.get("id") == workflow_key), None)
    if not workflow:
        raise HTTPException(status_code=404, detail="RunningHub 工作流不存在")
    return {"workflow": workflow}

@app.post("/api/runninghub/run")
async def run_runninghub_workflow(payload: RunningHubRunRequest):
    try:
        return _run_runninghub_workflow(payload)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"RunningHub run 未捕获异常: {exc}")
        raise HTTPException(status_code=500, detail=f"RunningHub 生成失败：{exc}") from exc

def _run_runninghub_workflow(payload: RunningHubRunRequest):
    api_key = runninghub_api_key()
    if not api_key:
        raise HTTPException(status_code=400, detail="请先在 RunningHub 设置中配置 API Key")
    cfg = load_runninghub_config()
    workflow = next((w for w in cfg.get("workflows") or [] if w.get("id") == payload.workflow_id), None)
    if not workflow:
        raise HTTPException(status_code=404, detail="RunningHub 工作流不存在")
    rh_workflow_id = str(workflow.get("workflow_id") or "").strip()
    if not rh_workflow_id:
        raise HTTPException(status_code=400, detail="该工作流未配置 RunningHub Workflow ID")
    workflow_prompt = None
    try:
        workflow_prompt = runninghub_fetch_workflow_json(rh_workflow_id).get("workflow")
    except Exception as exc:
        print(f"RunningHub 拉取工作流 JSON 用于参数对齐失败: {exc}")
    node_info_list, global_prompt = build_runninghub_node_info_list(
        workflow, payload, api_key, workflow_prompt=workflow_prompt,
    )
    if global_prompt and not node_info_list:
        missing = [
            str(f.get("id") or "")
            for f in (workflow.get("fields") or [])
            if str(f.get("nodeId") or "").strip() and not runninghub_normalize_field_name(f)
        ]
        hint = "请在 RunningHub 设置中为每个参数填写 nodeId 与 fieldName（文本节点常用 fieldName=text，例如 nodeId=6、fieldName=text）。"
        if missing:
            hint = f"参数 {', '.join(missing)} 缺少 fieldName。{hint}"
        raise HTTPException(status_code=400, detail=f"已填写提示词，但无法写入 nodeInfoList。{hint}")
    create_payload = {
        "apiKey": api_key,
        "workflowId": rh_workflow_id,
        "nodeInfoList": node_info_list,
    }
    for item in node_info_list:
        fv = item.get("fieldValue")
        print(
            f"RunningHub param nodeId={item.get('nodeId')} fieldName={item.get('fieldName')} "
            f"type={type(fv).__name__} value={json.dumps(fv, ensure_ascii=False)}"
        )
    create_body = runninghub_post("/task/openapi/create", create_payload)
    if create_body.get("code") != 0:
        raise HTTPException(
            status_code=400,
            detail=create_body.get("msg") or f"RunningHub 创建任务失败：{json.dumps(node_info_list, ensure_ascii=False)}",
        )
    task_id = str((create_body.get("data") or {}).get("taskId") or "")
    if not task_id:
        raise HTTPException(status_code=502, detail="RunningHub 未返回 taskId")
    result = runninghub_wait_outputs(api_key, task_id)
    outputs = result.get("outputs") or []
    images = [u for u in outputs if str(u).startswith("/output/") or str(u).startswith("/assets/") or (str(u).startswith("http") and not str(u).lower().endswith((".mp4", ".webm", ".mov")))]
    videos = [u for u in outputs if str(u).lower().endswith((".mp4", ".webm", ".mov"))]
    if not images and outputs:
        images = [u for u in outputs if not str(u).lower().endswith((".mp4", ".webm", ".mov"))]
    prompt_text = global_prompt
    if not prompt_text:
        incoming = {str(k): v for k, v in (payload.fields or {}).items()}
        for field in workflow.get("fields") or []:
            if runninghub_is_text_field(str(field.get("type") or "")):
                fid = str(field.get("id") or "")
                val = str(incoming.get(fid) or field.get("default") or "").strip()
                if val:
                    prompt_text = val
                    break
    if not prompt_text:
        prompt_text = str(workflow.get("name") or payload.workflow_id)
    current_timestamp = time.time()
    record = {
        "prompt": prompt_text,
        "images": images,
        "videos": videos,
        "outputs": outputs,
        "timestamp": current_timestamp,
        "type": "runninghub",
        "workflow_id": payload.workflow_id,
        "workflow_name": workflow.get("name") or payload.workflow_id,
        "params": {
            "fields": payload.fields or {},
            "reference_images": [ref if isinstance(ref, dict) else {"url": ref} for ref in (payload.reference_images or [])],
            "nodeInfoList": node_info_list,
        },
        "task_id": task_id,
    }
    save_to_history(record)
    if GLOBAL_LOOP:
        asyncio.run_coroutine_threadsafe(manager.broadcast_new_image(record), GLOBAL_LOOP)
    return {
        "task_id": task_id,
        "images": images,
        "videos": videos,
        "outputs": outputs,
        "remote_outputs": result.get("remote_outputs") or [],
        "timestamp": current_timestamp,
        "type": "runninghub",
        "prompt": prompt_text,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
