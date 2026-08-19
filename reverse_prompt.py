"""Prompt reverse workbench — constants and request helpers."""

from __future__ import annotations

from typing import Any, Dict, List

DEFAULT_MODEL = "gemini-3.5-flash"

MODEL_OPTIONS = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
]

EMPTY_IMAGE_USER_TEXT = "请根据图片进行反推。"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGES = 12
ALLOWED_MIMES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})


def can_start_run(*, user_text: str, image_count: int) -> bool:
    return bool((user_text or "").strip() or image_count > 0)


def card_matches_query(card: Dict[str, Any], query: str) -> bool:
    needle = str(query or "").strip().lower()
    if not needle:
        return True
    hay = "\n".join(
        str(card.get(key) or "").lower()
        for key in ("user_text", "system_prompt", "output")
    )
    return needle in hay


def validate_image(*, mime: str, size: int) -> Dict[str, Any]:
    if mime not in ALLOWED_MIMES:
        return {"ok": False, "error": "仅支持 jpg / png / webp / gif"}
    if size > MAX_IMAGE_BYTES:
        return {"ok": False, "error": "单张图片不能超过 10MB"}
    return {"ok": True}


def ext_of(mime: str, original: str = "") -> str:
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    if mime in mapping:
        return mapping[mime]
    name = str(original or "")
    dot = name.rfind(".")
    return name[dot:].lower() if dot >= 0 else ".bin"


def build_messages(*, system_prompt: str, user_text: str, images: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    sys_text = str(system_prompt or "").strip()
    if sys_text:
        messages.append({"role": "system", "content": sys_text})

    has_images = bool(images)
    text = str(user_text or "").strip() or (EMPTY_IMAGE_USER_TEXT if has_images else "")
    content: List[Dict[str, Any]] = []
    if text:
        content.append({"type": "text", "text": text})
    for img in images or []:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{img['mime']};base64,{img['base64']}"},
        })
    messages.append({"role": "user", "content": content})
    return messages
