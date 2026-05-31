"""SQLite persistence layer for Infinite Canvas Studio."""
from __future__ import annotations

import json
import math
import os
import shutil
import sqlite3
import time
from threading import Lock
from typing import Any, Dict, List, Optional

DB_LOCK = Lock()
_CONN: Optional[sqlite3.Connection] = None
DB_PATH = ""
HISTORY_MAX = 5000
SCHEMA_VERSION = 1

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS history_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp REAL NOT NULL,
    record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history_records(timestamp DESC);

CREATE TABLE IF NOT EXISTS canvases (
    id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

CREATE TABLE IF NOT EXISTS api_providers_store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_jobs (
    job_id TEXT PRIMARY KEY,
    prompt TEXT,
    media_kind TEXT,
    error TEXT,
    timestamp REAL NOT NULL,
    expires_at REAL
);

CREATE TABLE IF NOT EXISTS history_user_meta (
    scope TEXT PRIMARY KEY,
    meta_json TEXT NOT NULL,
    updated_at REAL NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    global _CONN
    if _CONN is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _CONN = sqlite3.connect(DB_PATH, check_same_thread=False)
        _CONN.row_factory = sqlite3.Row
        _CONN.execute("PRAGMA journal_mode=WAL")
        _CONN.execute("PRAGMA synchronous=NORMAL")
        _CONN.execute("PRAGMA foreign_keys=ON")
    return _CONN


def init_database(
    base_dir: str,
    data_dir: str,
    history_file: str,
    api_providers_file: str,
    conversation_dir: str,
) -> None:
    global DB_PATH
    DB_PATH = os.path.join(data_dir, "studio.db")
    with DB_LOCK:
        conn = _connect()
        conn.executescript(_SCHEMA_SQL)
        current = conn.execute(
            "SELECT MAX(version) AS v FROM schema_migrations"
        ).fetchone()
        version = int(current["v"] or 0)
        if version < SCHEMA_VERSION:
            _migrate_from_json(
                conn,
                history_file=history_file,
                api_providers_file=api_providers_file,
                conversation_dir=conversation_dir,
            )
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, time.time()),
            )
            conn.commit()
        else:
            _migrate_from_json_if_empty(
                conn,
                history_file=history_file,
                api_providers_file=api_providers_file,
                conversation_dir=conversation_dir,
            )
            conn.commit()


def _backup_path(path: str) -> str:
    if not path or not os.path.exists(path):
        return ""
    backup = path + ".bak"
    if os.path.exists(backup):
        backup = f"{path}.bak.{int(time.time())}"
    try:
        if os.path.isdir(path):
            if not os.path.exists(backup):
                shutil.copytree(path, backup)
        else:
            shutil.copy2(path, backup)
        return backup
    except Exception as exc:
        print(f"[db] 备份 {path} 失败: {exc}")
        return ""


def _migrate_from_json_if_empty(
    conn: sqlite3.Connection,
    *,
    history_file: str,
    api_providers_file: str,
    conversation_dir: str,
) -> None:
    history_count = conn.execute("SELECT COUNT(*) AS c FROM history_records").fetchone()["c"]
    if history_count == 0 and os.path.isfile(history_file):
        _import_history_json(conn, history_file)
        _backup_path(history_file)

    provider_count = conn.execute("SELECT COUNT(*) AS c FROM api_providers_store").fetchone()["c"]
    if provider_count == 0 and os.path.isfile(api_providers_file):
        _import_api_providers_json(conn, api_providers_file)
        _backup_path(api_providers_file)

    conv_count = conn.execute("SELECT COUNT(*) AS c FROM conversations").fetchone()["c"]
    if conv_count == 0 and os.path.isdir(conversation_dir):
        imported = _import_conversation_dir(conn, conversation_dir)
        if imported:
            _backup_path(conversation_dir)


def _migrate_from_json(
    conn: sqlite3.Connection,
    *,
    history_file: str,
    api_providers_file: str,
    conversation_dir: str,
) -> None:
    _migrate_from_json_if_empty(
        conn,
        history_file=history_file,
        api_providers_file=api_providers_file,
        conversation_dir=conversation_dir,
    )


def _import_history_json(conn: sqlite3.Connection, history_file: str) -> None:
    try:
        with open(history_file, "r", encoding="utf-8") as f:
            items = json.load(f)
    except Exception as exc:
        print(f"[db] 读取 history.json 失败: {exc}")
        return
    if not isinstance(items, list):
        return
    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        ts = float(item.get("timestamp") or time.time())
        rows.append((ts, json.dumps(item, ensure_ascii=False)))
    if rows:
        conn.executemany(
            "INSERT INTO history_records(timestamp, record_json) VALUES (?, ?)",
            rows,
        )
        print(f"[db] 已迁移 {len(rows)} 条历史记录")


def _import_api_providers_json(conn: sqlite3.Connection, path: str) -> None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print(f"[db] 读取 api_providers.json 失败: {exc}")
        return
    if not isinstance(data, list):
        return
    conn.execute(
        "INSERT OR REPLACE INTO api_providers_store(id, record_json) VALUES (1, ?)",
        (json.dumps(data, ensure_ascii=False),),
    )
    print(f"[db] 已迁移 API 平台配置 ({len(data)} 项)")


def _import_conversation_dir(conn: sqlite3.Connection, conversation_dir: str) -> int:
    count = 0
    if not os.path.isdir(conversation_dir):
        return 0
    for user_id in os.listdir(conversation_dir):
        user_path = os.path.join(conversation_dir, user_id)
        if not os.path.isdir(user_path):
            continue
        for filename in os.listdir(user_path):
            if not filename.endswith(".json"):
                continue
            path = os.path.join(user_path, filename)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                continue
            conv_id = str(data.get("id") or filename[:-5])
            conn.execute(
                "INSERT OR REPLACE INTO conversations(user_id, id, record_json) VALUES (?, ?, ?)",
                (user_id, conv_id, json.dumps(data, ensure_ascii=False)),
            )
            count += 1
    if count:
        print(f"[db] 已迁移 {count} 个对话")
    return count


def _trim_history(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        DELETE FROM history_records
        WHERE id NOT IN (
            SELECT id FROM history_records ORDER BY timestamp DESC LIMIT ?
        )
        """,
        (HISTORY_MAX,),
    )


# --- History ---

def insert_history(record: Dict[str, Any]) -> None:
    if "timestamp" not in record:
        record["timestamp"] = time.time()
    payload = json.dumps(record, ensure_ascii=False)
    ts = float(record["timestamp"])
    with DB_LOCK:
        conn = _connect()
        conn.execute(
            "INSERT INTO history_records(timestamp, record_json) VALUES (?, ?)",
            (ts, payload),
        )
        _trim_history(conn)
        conn.commit()


def list_history_records() -> List[Dict[str, Any]]:
    with DB_LOCK:
        conn = _connect()
        rows = conn.execute(
            "SELECT record_json FROM history_records ORDER BY timestamp DESC"
        ).fetchall()
    out: List[Dict[str, Any]] = []
    for row in rows:
        try:
            out.append(json.loads(row["record_json"]))
        except Exception:
            continue
    return out


def _timestamp_matches(item_ts: Any, req_ts: Any) -> bool:
    if isinstance(req_ts, (int, float)) and isinstance(item_ts, (int, float)):
        return abs(float(item_ts) - float(req_ts)) < 0.001
    return str(item_ts) == str(req_ts)


def delete_history_by_timestamp(timestamp: Any) -> Optional[Dict[str, Any]]:
    with DB_LOCK:
        conn = _connect()
        rows = conn.execute("SELECT id, timestamp, record_json FROM history_records").fetchall()
        target = None
        target_id = None
        for row in rows:
            item = json.loads(row["record_json"])
            if _timestamp_matches(item.get("timestamp", 0), timestamp):
                target = item
                target_id = row["id"]
                break
        if target_id is not None:
            conn.execute("DELETE FROM history_records WHERE id = ?", (target_id,))
            conn.commit()
        return target


def delete_history_batch(timestamps: List[Any]) -> List[Dict[str, Any]]:
    req_ts = [float(t) for t in timestamps]
    deleted: List[Dict[str, Any]] = []
    with DB_LOCK:
        conn = _connect()
        rows = conn.execute("SELECT id, record_json FROM history_records").fetchall()
        delete_ids = []
        for row in rows:
            item = json.loads(row["record_json"])
            item_ts = item.get("timestamp", 0)
            matched = False
            for t in req_ts:
                if _timestamp_matches(item_ts, t):
                    matched = True
                    break
            if matched:
                deleted.append(item)
                delete_ids.append(row["id"])
        if delete_ids:
            conn.executemany("DELETE FROM history_records WHERE id = ?", [(i,) for i in delete_ids])
            conn.commit()
    return deleted


# --- History user meta (pin / favorite / order) ---

def _default_history_user_meta() -> Dict[str, Any]:
    return {"pinned": [], "favorites": [], "order": []}


def _sanitize_history_meta_id(raw: Any) -> str:
    if raw is None:
        return ""
    text = str(raw).strip()
    if not text or text in ("Infinity", "-Infinity", "NaN"):
        return ""
    if "e" in text.lower():
        return ""
    try:
        n = float(text)
    except (TypeError, ValueError):
        return ""
    if not math.isfinite(n):
        return ""
    if n >= 1e12:
        key = str(int(round(n)))
    elif n >= 1e9:
        key = str(int(round(n * 1000)))
    else:
        return ""
    if not (10 <= len(key) <= 16):
        return ""
    return key


def _sanitize_history_meta_list(ids: Any) -> List[str]:
    if not isinstance(ids, list):
        return []
    seen = set()
    out: List[str] = []
    for raw in ids:
        key = _sanitize_history_meta_id(raw)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def _sanitize_history_user_meta(data: Dict[str, Any]) -> Dict[str, Any]:
    base = _default_history_user_meta()
    if not isinstance(data, dict):
        return base
    return {
        "pinned": _sanitize_history_meta_list(data.get("pinned")),
        "favorites": _sanitize_history_meta_list(data.get("favorites")),
        "order": _sanitize_history_meta_list(data.get("order")),
    }


def _history_meta_needs_heal(data: Dict[str, Any]) -> bool:
    if not isinstance(data, dict):
        return True
    for key in ("pinned", "favorites", "order"):
        raw = data.get(key)
        if not isinstance(raw, list):
            return True
        for item in raw:
            sid = _sanitize_history_meta_id(item)
            if not sid or sid != str(item).strip():
                return True
    return False


def _persist_history_user_meta(scope: str, payload: Dict[str, Any]) -> None:
    with DB_LOCK:
        conn = _connect()
        conn.execute(
            "INSERT INTO history_user_meta(scope, meta_json, updated_at) VALUES (?, ?, ?)"
            " ON CONFLICT(scope) DO UPDATE SET meta_json = excluded.meta_json, updated_at = excluded.updated_at",
            (scope, json.dumps(payload, ensure_ascii=False), time.time()),
        )
        conn.commit()


def load_history_user_meta(scope: str) -> Dict[str, Any]:
    scope = str(scope or "studio").strip() or "studio"
    with DB_LOCK:
        conn = _connect()
        row = conn.execute(
            "SELECT meta_json FROM history_user_meta WHERE scope = ?",
            (scope,),
        ).fetchone()
    if not row:
        return {**_default_history_user_meta(), "scope": scope}
    try:
        data = json.loads(row["meta_json"])
    except Exception:
        data = _default_history_user_meta()
    if not isinstance(data, dict):
        data = _default_history_user_meta()
    clean = _sanitize_history_user_meta(data)
    if _history_meta_needs_heal(data):
        _persist_history_user_meta(scope, clean)
    return {
        "scope": scope,
        "pinned": clean["pinned"],
        "favorites": clean["favorites"],
        "order": clean["order"],
    }


def save_history_user_meta(scope: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    scope = str(scope or "studio").strip() or "studio"
    clean = _sanitize_history_user_meta(meta if isinstance(meta, dict) else {})
    payload = {
        "pinned": clean["pinned"],
        "favorites": clean["favorites"],
        "order": clean["order"],
    }
    _persist_history_user_meta(scope, payload)
    return {
        "scope": scope,
        **payload,
    }


# --- API providers ---

def load_api_providers_raw() -> Optional[List[Any]]:
    with DB_LOCK:
        conn = _connect()
        row = conn.execute(
            "SELECT record_json FROM api_providers_store WHERE id = 1"
        ).fetchone()
    if not row:
        return None
    try:
        data = json.loads(row["record_json"])
        return data if isinstance(data, list) else None
    except Exception:
        return None


def save_api_providers_raw(providers: List[Any]) -> None:
    payload = json.dumps(providers, ensure_ascii=False, indent=2)
    with DB_LOCK:
        conn = _connect()
        conn.execute(
            "INSERT OR REPLACE INTO api_providers_store(id, record_json) VALUES (1, ?)",
            (payload,),
        )
        conn.commit()


# --- Conversations ---

def save_conversation_record(user_id: str, conversation: Dict[str, Any]) -> None:
    conv_id = str(conversation["id"])
    payload = json.dumps(conversation, ensure_ascii=False, indent=2)
    with DB_LOCK:
        conn = _connect()
        conn.execute(
            "INSERT OR REPLACE INTO conversations(user_id, id, record_json) VALUES (?, ?, ?)",
            (user_id, conv_id, payload),
        )
        conn.commit()


def load_conversation_record(user_id: str, conversation_id: str) -> Optional[Dict[str, Any]]:
    with DB_LOCK:
        conn = _connect()
        row = conn.execute(
            "SELECT record_json FROM conversations WHERE user_id = ? AND id = ?",
            (user_id, conversation_id),
        ).fetchone()
    if not row:
        return None
    return json.loads(row["record_json"])


def delete_conversation_record(user_id: str, conversation_id: str) -> None:
    with DB_LOCK:
        conn = _connect()
        conn.execute(
            "DELETE FROM conversations WHERE user_id = ? AND id = ?",
            (user_id, conversation_id),
        )
        conn.commit()


def list_conversation_summaries(user_id: str) -> List[Dict[str, Any]]:
    with DB_LOCK:
        conn = _connect()
        rows = conn.execute(
            "SELECT record_json FROM conversations WHERE user_id = ?",
            (user_id,),
        ).fetchall()
    records = []
    for row in rows:
        try:
            data = json.loads(row["record_json"])
        except Exception:
            continue
        messages = data.get("messages", [])
        last_message = next((m for m in reversed(messages) if m.get("role") != "system"), None)
        records.append({
            "id": data.get("id"),
            "title": data.get("title", "新对话"),
            "created_at": data.get("created_at", 0),
            "updated_at": data.get("updated_at", 0),
            "last_message": (last_message or {}).get("content", ""),
        })
    return sorted(records, key=lambda item: item["updated_at"], reverse=True)
