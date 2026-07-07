#!/usr/bin/env python3
"""Local Paper + Codex reader.

Run with:
    python app.py

The server intentionally uses Python's standard library for the web layer so
the packaged app stays lightweight and easy to run.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import mimetypes
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, List, Optional, Tuple


APP_DIR = pathlib.Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DEFAULT_MODEL = "gpt-5.5"


def default_home() -> pathlib.Path:
    env_home = os.environ.get("PAPER_CODEX_READER_HOME")
    if env_home:
        return pathlib.Path(env_home).expanduser()
    legacy = pathlib.Path.home() / ".paper_codex_reader"
    if legacy.exists():
        return legacy
    if sys.platform.startswith("win"):
        base = pathlib.Path(os.environ.get("LOCALAPPDATA") or pathlib.Path.home() / "AppData" / "Local")
        return base / "PaperCodexReader"
    if sys.platform == "darwin":
        return pathlib.Path.home() / "Library" / "Application Support" / "PaperCodexReader"
    base = pathlib.Path(os.environ.get("XDG_DATA_HOME") or pathlib.Path.home() / ".local" / "share")
    return base / "paper-codex-reader"


DEFAULT_HOME = default_home()


def codex_candidates() -> List[str]:
    candidates = [
        os.environ.get("PAPER_CODEX_READER_CODEX") or "",
    ]
    if sys.platform.startswith("win"):
        candidates += [
            shutil.which("codex.cmd") or "",
            shutil.which("codex.bat") or "",
            shutil.which("codex.exe") or "",
            shutil.which("codex") or "",
        ]
        app_data = pathlib.Path(os.environ.get("APPDATA") or pathlib.Path.home() / "AppData" / "Roaming")
        local_app_data = pathlib.Path(os.environ.get("LOCALAPPDATA") or pathlib.Path.home() / "AppData" / "Local")
        candidates += [
            str(app_data / "npm" / "codex.cmd"),
            str(local_app_data / "pnpm" / "codex.cmd"),
        ]
    else:
        candidates += [
            shutil.which("codex") or "",
        ]
    if sys.platform == "darwin":
        candidates += [
            "/Applications/Codex.app/Contents/Resources/codex",
            str(pathlib.Path.home() / "Applications" / "Codex.app" / "Contents" / "Resources" / "codex"),
        ]
    if sys.platform.startswith("win"):
        local_app_data = pathlib.Path(os.environ.get("LOCALAPPDATA") or pathlib.Path.home() / "AppData" / "Local")
        program_files = [os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")]
        candidates += [
            str(local_app_data / "Programs" / "Codex" / "codex.exe"),
            str(local_app_data / "Programs" / "Codex" / "resources" / "codex.exe"),
        ]
        for root in program_files:
            if root:
                candidates += [
                    str(pathlib.Path(root) / "Codex" / "codex.exe"),
                    str(pathlib.Path(root) / "OpenAI" / "Codex" / "codex.exe"),
                ]
    unique: List[str] = []
    seen = set()
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def slugify(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    return value.strip("-") or "paper"


def clean_local_path(value: str) -> pathlib.Path:
    raw = (value or "").strip().strip('"').strip("'")
    if raw.startswith("file://"):
        parsed = urllib.parse.urlparse(raw)
        raw = urllib.request.url2pathname(parsed.path)
        if sys.platform.startswith("win") and parsed.netloc:
            raw = f"//{parsed.netloc}{raw}"
    return pathlib.Path(raw).expanduser().resolve()


def path_exists_or_command(value: str) -> bool:
    if not value:
        return False
    return bool(shutil.which(value) or pathlib.Path(value).expanduser().exists())


def codex_unavailable_message(path: str, detail: str) -> str:
    message = f"Codex CLI is not usable at {path}: {detail}"
    if sys.platform.startswith("win"):
        message += (
            " On Windows, a Codex path under WindowsApps can exist but still be blocked "
            "from subprocesses. Install a runnable CLI such as `npm install -g @openai/codex`, "
            "then set the Codex path to codex.cmd if needed."
        )
    return message


def probe_codex_cli(path: str, timeout: int = 10) -> Tuple[bool, str]:
    if not path_exists_or_command(path):
        return False, f"Codex CLI not found: {path}"
    try:
        result = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, codex_unavailable_message(path, "timed out while running --version")
    except Exception as exc:
        return False, codex_unavailable_message(path, str(exc))
    output = (result.stdout or result.stderr).strip()
    if result.returncode == 0:
        return True, output
    return False, codex_unavailable_message(path, output or f"exit code {result.returncode}")


def codex_home() -> pathlib.Path:
    return pathlib.Path(os.environ.get("CODEX_HOME") or pathlib.Path.home() / ".codex").expanduser()


def utc_iso_from_epoch(value: Any) -> Optional[str]:
    try:
        return dt.datetime.fromtimestamp(float(value), dt.timezone.utc).isoformat()
    except Exception:
        return None


def sanitize_rate_limit(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    used = value.get("used_percent")
    try:
        used_float = float(used)
    except Exception:
        used_float = None
    limit = {
        "used_percent": used_float,
        "remaining_percent": round(max(0.0, 100.0 - used_float), 1) if used_float is not None else None,
        "window_minutes": value.get("window_minutes"),
        "resets_at": value.get("resets_at"),
        "resets_at_iso": utc_iso_from_epoch(value.get("resets_at")),
    }
    return limit


def latest_codex_usage() -> Dict[str, Any]:
    sessions_dir = codex_home() / "sessions"
    if not sessions_dir.exists():
        return {"available": False, "message": "No local Codex session telemetry found."}
    try:
        files = sorted(
            sessions_dir.glob("**/*.jsonl"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
    except Exception as exc:
        return {"available": False, "message": f"Unable to scan Codex usage telemetry: {exc}"}

    for path in files[:40]:
        try:
            size = path.stat().st_size
            with path.open("rb") as handle:
                handle.seek(max(0, size - 2_000_000))
                lines = handle.read().decode("utf-8", errors="ignore").splitlines()
        except Exception:
            continue
        for line in reversed(lines):
            if "token_count" not in line:
                continue
            try:
                event = json.loads(line)
            except Exception:
                continue
            payload = event.get("payload") or {}
            if payload.get("type") != "token_count":
                continue
            info = payload.get("info") or {}
            rate_limits = payload.get("rate_limits") or {}
            return {
                "available": True,
                "source": "local_codex_session_telemetry",
                "updated_at": event.get("timestamp"),
                "plan_type": rate_limits.get("plan_type"),
                "credits": rate_limits.get("credits"),
                "individual_limit": rate_limits.get("individual_limit"),
                "rate_limit_reached_type": rate_limits.get("rate_limit_reached_type"),
                "primary": sanitize_rate_limit(rate_limits.get("primary")),
                "secondary": sanitize_rate_limit(rate_limits.get("secondary")),
                "total_token_usage": info.get("total_token_usage") or {},
                "last_token_usage": info.get("last_token_usage") or {},
                "model_context_window": info.get("model_context_window"),
            }
    return {"available": False, "message": "No recent Codex token usage event found."}


SENSITIVE_AUTH_KEY_PARTS = ("token", "secret", "key", "credential", "authorization", "cookie")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SAFE_ACCOUNT_FIELDS = {
    "email": "email",
    "user_email": "email",
    "account_email": "email",
    "name": "name",
    "display_name": "name",
    "account_name": "name",
    "account_id": "account_id",
    "user_id": "user_id",
    "organization_id": "organization_id",
    "org_id": "organization_id",
}


def mask_email(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    email = value.strip()
    if not EMAIL_PATTERN.match(email):
        return None
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        masked_local = "*"
    elif len(local) <= 3:
        masked_local = f"{local[0]}***"
    else:
        masked_local = f"{local[:2]}***{local[-1]}"
    if "." in domain:
        first, rest = domain.split(".", 1)
        masked_domain = f"{first[:1]}***.{rest}" if first else f"***.{rest}"
    else:
        masked_domain = f"{domain[:1]}***" if domain else "***"
    return f"{masked_local}@{masked_domain}"


def decode_jwt_payload(value: str) -> Optional[Dict[str, Any]]:
    parts = value.split(".")
    if len(parts) < 2:
        return None
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("utf-8")).decode("utf-8")
        result = json.loads(decoded)
    except Exception:
        return None
    return result if isinstance(result, dict) else None


def find_email_in_claims(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        for key in ("email", "user_email", "account_email", "preferred_username", "upn"):
            item = value.get(key)
            if isinstance(item, str) and EMAIL_PATTERN.match(item.strip()):
                return item.strip()
        for item in value.values():
            found = find_email_in_claims(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_email_in_claims(item)
            if found:
                return found
    elif isinstance(value, str) and EMAIL_PATTERN.match(value.strip()):
        return value.strip()
    return None


def find_email_in_auth_tokens(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        for item in value.values():
            found = find_email_in_auth_tokens(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_email_in_auth_tokens(item)
            if found:
                return found
    elif isinstance(value, str):
        claims = decode_jwt_payload(value)
        if claims:
            return find_email_in_claims(claims)
    return None


def auth_mode_label(value: Any) -> Optional[str]:
    if not value:
        return None
    mode = str(value).strip()
    normalized = mode.lower().replace("-", "_")
    if normalized == "chatgpt":
        return "ChatGPT 账号"
    if "api" in normalized:
        return "API Key"
    return mode


def safe_codex_account_info() -> Dict[str, Any]:
    auth_path = codex_home() / "auth.json"
    if not auth_path.exists():
        return {"available": False, "message": "No local Codex auth metadata found."}
    try:
        data = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"available": False, "message": f"Unable to read Codex auth metadata: {exc}"}
    if not isinstance(data, dict):
        return {"available": False, "message": "Codex auth metadata has an unexpected shape."}

    found: Dict[str, str] = {}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for raw_key, raw_value in value.items():
                key = str(raw_key).lower()
                if any(part in key for part in SENSITIVE_AUTH_KEY_PARTS):
                    continue
                canonical = SAFE_ACCOUNT_FIELDS.get(key)
                if canonical and isinstance(raw_value, (str, int, float)):
                    text = str(raw_value).strip()
                    if text and len(text) <= 160:
                        found.setdefault(canonical, text)
                if isinstance(raw_value, (dict, list)):
                    visit(raw_value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, (dict, list)):
                    visit(item)

    visit(data)
    email = found.get("email") or find_email_in_auth_tokens(data)
    masked_email = mask_email(email)
    auth_mode = str(data.get("auth_mode") or "").strip() or None
    last_refresh = data.get("last_refresh") if isinstance(data.get("last_refresh"), str) else None
    display = (
        masked_email
        or found.get("name")
        or found.get("account_id")
        or auth_mode_label(auth_mode)
    )
    return {
        "available": True,
        "source": "local_codex_auth_metadata",
        "display": display,
        "masked_email": masked_email,
        "auth_mode": auth_mode,
        "auth_label": auth_mode_label(auth_mode),
        "name": found.get("name"),
        "account_id": found.get("account_id"),
        "user_id": found.get("user_id"),
        "organization_id": found.get("organization_id"),
        "last_refresh": last_refresh,
    }


def json_response(handler: SimpleHTTPRequestHandler, payload: Any, status: int = 200) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def read_json(handler: SimpleHTTPRequestHandler) -> Dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


class Store:
    def __init__(self, home: pathlib.Path):
        self.home = home
        self.papers_dir = home / "papers"
        self.db_path = home / "reader.sqlite"
        self.lock = threading.Lock()
        self.home.mkdir(parents=True, exist_ok=True)
        self.papers_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    def _init_db(self) -> None:
        with self.connect() as con:
            con.executescript(
                """
                create table if not exists papers (
                    id text primary key,
                    title text not null,
                    path text not null,
                    source text,
                    created_at text not null
                );

                create table if not exists conversations (
                    id text primary key,
                    title text not null,
                    paper_id text,
                    codex_session_id text,
                    created_at text not null,
                    updated_at text not null,
                    initialized_at text,
                    foreign key (paper_id) references papers(id)
                );

                create table if not exists messages (
                    id text primary key,
                    conversation_id text not null,
                    role text not null,
                    content text not null,
                    created_at text not null,
                    foreign key (conversation_id) references conversations(id)
                );

                create table if not exists settings (
                    key text primary key,
                    value text not null
                );
                """
            )
            defaults = {
                "codex_path": self.find_codex_path(),
                "model": DEFAULT_MODEL,
                "reasoning_effort": "high",
                "verbosity": "medium",
                "paper_chunk_chars": "18000",
                "codex_timeout_seconds": "600",
            }
            for key, value in defaults.items():
                con.execute("insert or ignore into settings(key, value) values (?, ?)", (key, value))

    def find_codex_path(self) -> str:
        for path in codex_candidates():
            ok, _message = probe_codex_cli(path)
            if ok:
                return path
        return "codex"

    def settings(self) -> Dict[str, str]:
        with self.connect() as con:
            data = {row["key"]: row["value"] for row in con.execute("select key, value from settings")}
            if not data.get("model"):
                data["model"] = DEFAULT_MODEL
            return data

    def update_settings(self, data: Dict[str, Any]) -> Dict[str, str]:
        allowed = {"codex_path", "model", "reasoning_effort", "verbosity", "paper_chunk_chars", "codex_timeout_seconds"}
        with self.connect() as con:
            for key, value in data.items():
                if key in allowed:
                    con.execute(
                        "insert into settings(key, value) values (?, ?) on conflict(key) do update set value=excluded.value",
                        (key, str(value)),
                    )
        return self.settings()

    def json_setting(self, key: str) -> Dict[str, Any]:
        with self.connect() as con:
            row = con.execute("select value from settings where key = ?", (key,)).fetchone()
        if not row:
            return {}
        try:
            value = json.loads(row["value"])
        except Exception:
            return {}
        return value if isinstance(value, dict) else {}

    def save_json_setting(self, key: str, value: Dict[str, Any]) -> None:
        with self.connect() as con:
            con.execute(
                "insert into settings(key, value) values (?, ?) on conflict(key) do update set value=excluded.value",
                (key, json.dumps(value, ensure_ascii=False)),
            )

    def list_papers(self) -> List[Dict[str, Any]]:
        with self.connect() as con:
            rows = con.execute("select * from papers order by created_at desc").fetchall()
            return [dict(row) for row in rows]

    def get_paper(self, paper_id: str) -> Optional[Dict[str, Any]]:
        with self.connect() as con:
            row = con.execute("select * from papers where id = ?", (paper_id,)).fetchone()
            return dict(row) if row else None

    def update_paper_title(self, paper_id: str, title: str) -> Dict[str, Any]:
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("Paper title cannot be empty.")
        with self.connect() as con:
            cur = con.execute("update papers set title = ? where id = ?", (clean_title, paper_id))
            if cur.rowcount == 0:
                raise ValueError("Paper not found.")
        paper = self.get_paper(paper_id)
        if not paper:
            raise ValueError("Paper not found.")
        return paper

    def delete_paper(self, paper_id: str) -> Dict[str, Any]:
        paper = self.get_paper(paper_id)
        if not paper:
            raise ValueError("Paper not found.")
        path = pathlib.Path(paper["path"]).expanduser()
        deleted_file = False
        try:
            resolved_path = path.resolve()
            resolved_papers_dir = self.papers_dir.resolve()
            if resolved_path.exists() and resolved_papers_dir in resolved_path.parents:
                resolved_path.unlink()
                deleted_file = True
        except FileNotFoundError:
            pass
        except Exception as exc:
            raise ValueError(f"Could not delete local PDF copy: {exc}") from exc
        with self.connect() as con:
            con.execute("delete from papers where id = ?", (paper_id,))
        return {"id": paper_id, "title": paper["title"], "deleted": True, "deleted_file": deleted_file}

    def add_paper_from_path(self, source_path: str, title: Optional[str] = None) -> Dict[str, Any]:
        src = clean_local_path(source_path)
        if not src.exists():
            raise ValueError(f"File does not exist: {src}")
        if src.suffix.lower() != ".pdf":
            raise ValueError("Only PDF files are supported.")
        paper_id = str(uuid.uuid4())
        name = title or src.stem
        dest = self.papers_dir / f"{paper_id}-{slugify(src.name)}"
        shutil.copy2(src, dest)
        return self._insert_paper(paper_id, name, dest, str(src))

    def add_paper_from_url(self, url: str, title: Optional[str] = None) -> Dict[str, Any]:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("PDF link must start with http:// or https://")
        paper_id = str(uuid.uuid4())
        basename = pathlib.Path(parsed.path).name or "paper.pdf"
        if not basename.lower().endswith(".pdf"):
            basename = f"{basename}.pdf"
        dest = self.papers_dir / f"{paper_id}-{slugify(basename)}"
        request = urllib.request.Request(url, headers={"User-Agent": "PaperCodexReader/0.1"})
        with urllib.request.urlopen(request, timeout=60) as response:
            content_type = response.headers.get("Content-Type", "")
            data = response.read()
        if not data.startswith(b"%PDF") and "pdf" not in content_type.lower():
            raise ValueError("The URL did not return a PDF file.")
        dest.write_bytes(data)
        name = title or pathlib.Path(basename).stem
        return self._insert_paper(paper_id, name, dest, url)

    def add_paper_from_upload(self, filename: str, data_base64: str, title: Optional[str] = None) -> Dict[str, Any]:
        if not filename.lower().endswith(".pdf"):
            raise ValueError("Only PDF files are supported.")
        try:
            data = base64.b64decode(data_base64, validate=True)
        except Exception as exc:
            raise ValueError("Uploaded PDF data is invalid.") from exc
        if not data.startswith(b"%PDF"):
            raise ValueError("Uploaded file is not a valid PDF.")
        paper_id = str(uuid.uuid4())
        dest = self.papers_dir / f"{paper_id}-{slugify(filename)}"
        dest.write_bytes(data)
        name = title or pathlib.Path(filename).stem
        return self._insert_paper(paper_id, name, dest, f"upload:{filename}")

    def _insert_paper(self, paper_id: str, title: str, path: pathlib.Path, source: str) -> Dict[str, Any]:
        created = now_iso()
        with self.connect() as con:
            con.execute(
                "insert into papers(id, title, path, source, created_at) values (?, ?, ?, ?, ?)",
                (paper_id, title, str(path), source, created),
            )
        return {"id": paper_id, "title": title, "path": str(path), "source": source, "created_at": created}

    def list_conversations(self) -> List[Dict[str, Any]]:
        folder_order = self.json_setting("conversation_folder_order")
        conversation_order = self.json_setting("conversation_order")
        with self.connect() as con:
            rows = con.execute(
                """
                select c.*, p.title as paper_title
                from conversations c
                left join papers p on p.id = c.paper_id
                order by c.updated_at desc
                """
            ).fetchall()
        conversations = []
        for row in rows:
            item = dict(row)
            folder_key = f"paper:{item['paper_id']}" if item.get("paper_id") else "paper:none"
            item["folder_key"] = folder_key
            item["folder_order"] = folder_order.get(folder_key)
            item["conversation_order"] = conversation_order.get(item["id"])
            conversations.append(item)
        return conversations

    def reorder_conversation_folders(self, group_keys: List[str]) -> List[Dict[str, Any]]:
        if not isinstance(group_keys, list):
            raise ValueError("Provide group_keys as a list.")
        clean_keys = [str(key) for key in group_keys if str(key)]
        order = self.json_setting("conversation_folder_order")
        for index, key in enumerate(clean_keys):
            order[key] = index
        self.save_json_setting("conversation_folder_order", order)
        return self.list_conversations()

    def reorder_conversations(self, conversation_ids: List[str]) -> List[Dict[str, Any]]:
        if not isinstance(conversation_ids, list):
            raise ValueError("Provide conversation_ids as a list.")
        clean_ids = [str(conv_id) for conv_id in conversation_ids if str(conv_id)]
        if clean_ids:
            placeholders = ",".join("?" for _ in clean_ids)
            with self.connect() as con:
                rows = con.execute(f"select id from conversations where id in ({placeholders})", clean_ids).fetchall()
            found = {row["id"] for row in rows}
            missing = [conv_id for conv_id in clean_ids if conv_id not in found]
            if missing:
                raise ValueError("Conversation not found.")
        order = self.json_setting("conversation_order")
        for index, conv_id in enumerate(clean_ids):
            order[conv_id] = index
        self.save_json_setting("conversation_order", order)
        return self.list_conversations()

    def create_conversation(self, paper_id: Optional[str], title: Optional[str] = None) -> Dict[str, Any]:
        conv_id = str(uuid.uuid4())
        conv_title = title.strip() if title and title.strip() else self.next_conversation_title(paper_id)
        stamp = now_iso()
        with self.connect() as con:
            con.execute(
                "insert into conversations(id, title, paper_id, created_at, updated_at) values (?, ?, ?, ?, ?)",
                (conv_id, conv_title, paper_id, stamp, stamp),
            )
        return self.get_conversation(conv_id) or {"id": conv_id, "title": conv_title, "paper_id": paper_id}

    def next_conversation_title(self, paper_id: Optional[str]) -> str:
        paper = self.get_paper(paper_id) if paper_id else None
        base_title = f"阅读 {paper['title']}" if paper else "空对话"
        with self.connect() as con:
            if paper_id:
                row = con.execute("select count(*) as count from conversations where paper_id = ?", (paper_id,)).fetchone()
            else:
                row = con.execute("select count(*) as count from conversations where paper_id is null").fetchone()
            index = int(row["count"]) + 1 if row else 1
            while True:
                candidate = f"{base_title} · {index:02d}"
                exists = con.execute("select 1 from conversations where title = ? limit 1", (candidate,)).fetchone()
                if not exists:
                    return candidate
                index += 1

    def get_conversation(self, conv_id: str) -> Optional[Dict[str, Any]]:
        with self.connect() as con:
            row = con.execute("select * from conversations where id = ?", (conv_id,)).fetchone()
            return dict(row) if row else None

    def update_conversation_title(self, conv_id: str, title: str) -> Dict[str, Any]:
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("Conversation title cannot be empty.")
        stamp = now_iso()
        with self.connect() as con:
            cur = con.execute(
                "update conversations set title = ?, updated_at = ? where id = ?",
                (clean_title, stamp, conv_id),
            )
            if cur.rowcount == 0:
                raise ValueError("Conversation not found.")
        conversation = self.get_conversation(conv_id)
        if not conversation:
            raise ValueError("Conversation not found.")
        return conversation

    def delete_conversation(self, conv_id: str) -> Dict[str, Any]:
        with self.connect() as con:
            conversation = con.execute("select id, title from conversations where id = ?", (conv_id,)).fetchone()
            if not conversation:
                raise ValueError("Conversation not found.")
            con.execute("delete from messages where conversation_id = ?", (conv_id,))
            con.execute("delete from conversations where id = ?", (conv_id,))
        return {"id": conv_id, "title": conversation["title"], "deleted": True}

    def update_conversation_session(self, conv_id: str, session_id: Optional[str], initialized: bool = False) -> None:
        stamp = now_iso()
        with self.connect() as con:
            if initialized:
                con.execute(
                    "update conversations set codex_session_id = ?, initialized_at = ?, updated_at = ? where id = ?",
                    (session_id, stamp, stamp, conv_id),
                )
            else:
                con.execute(
                    "update conversations set codex_session_id = ?, updated_at = ? where id = ?",
                    (session_id, stamp, conv_id),
                )

    def add_message(self, conv_id: str, role: str, content: str) -> Dict[str, Any]:
        msg_id = str(uuid.uuid4())
        stamp = now_iso()
        with self.connect() as con:
            con.execute(
                "insert into messages(id, conversation_id, role, content, created_at) values (?, ?, ?, ?, ?)",
                (msg_id, conv_id, role, content, stamp),
            )
            con.execute("update conversations set updated_at = ? where id = ?", (stamp, conv_id))
        return {"id": msg_id, "conversation_id": conv_id, "role": role, "content": content, "created_at": stamp}

    def update_message_content(self, conv_id: str, msg_id: str, content: str) -> Dict[str, Any]:
        clean_content = content.strip()
        if not clean_content:
            raise ValueError("Message is empty.")
        stamp = now_iso()
        with self.connect() as con:
            cur = con.execute(
                "update messages set content = ? where id = ? and conversation_id = ? and role = 'user'",
                (clean_content, msg_id, conv_id),
            )
            if cur.rowcount == 0:
                raise ValueError("Message not found.")
            con.execute("update conversations set updated_at = ? where id = ?", (stamp, conv_id))
        return {
            "id": msg_id,
            "conversation_id": conv_id,
            "role": "user",
            "content": clean_content,
            "updated_at": stamp,
        }

    def list_messages(self, conv_id: str) -> List[Dict[str, Any]]:
        with self.connect() as con:
            rows = con.execute(
                "select * from messages where conversation_id = ? order by created_at asc", (conv_id,)
            ).fetchall()
            return [dict(row) for row in rows]

    def auto_import_workspace_papers(self, workspace: pathlib.Path) -> None:
        with self.connect() as con:
            count = con.execute("select count(*) as n from papers").fetchone()["n"]
        if count:
            return
        papers_dir = workspace / "papers"
        if not papers_dir.exists():
            return
        for pdf in sorted(papers_dir.rglob("*.pdf")):
            try:
                self.add_paper_from_path(str(pdf), title=pdf.stem)
            except Exception:
                continue


class CodexRunner:
    def __init__(self, store: Store):
        self.store = store

    def _configured_path(self) -> str:
        settings = self.store.settings()
        return settings.get("codex_path") or "codex"

    def _ensure_cli(self, path: str) -> None:
        ok, message = probe_codex_cli(path)
        if not ok:
            raise ValueError(message)

    def status(self) -> Dict[str, Any]:
        path = self._configured_path()
        path_exists = path_exists_or_command(path)
        version_ok, version_message = probe_codex_cli(path)
        result = {
            "path": path,
            "exists": version_ok,
            "path_exists": path_exists,
            "usable": version_ok,
            "platform": sys.platform,
            "data_home": str(self.store.home),
        }
        if version_ok:
            result["version"] = version_message
            try:
                login = subprocess.run([path, "login", "status"], capture_output=True, text=True, timeout=20)
                result["login_status"] = (login.stdout or login.stderr).strip()
                result["login_ok"] = login.returncode == 0
            except Exception as exc:
                result["login_status"] = str(exc)
                result["login_ok"] = False
        else:
            result["version_error"] = version_message
            result["login_status"] = version_message
            result["login_ok"] = False
        result["account"] = safe_codex_account_info()
        result["usage"] = latest_codex_usage()
        return result

    def login(self) -> Dict[str, Any]:
        path = self._configured_path()
        self._ensure_cli(path)
        popen_kwargs: Dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if sys.platform.startswith("win"):
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            popen_kwargs["start_new_session"] = True
        process = subprocess.Popen([path, "login"], **popen_kwargs)
        return {
            "started": True,
            "pid": process.pid,
            "message": "Codex login started. Complete the login flow in the browser or Codex window, then refresh status.",
        }

    def logout(self) -> Dict[str, Any]:
        path = self._configured_path()
        self._ensure_cli(path)
        result = subprocess.run([path, "logout"], capture_output=True, text=True, timeout=30)
        output = (result.stdout or result.stderr).strip()
        if result.returncode != 0:
            raise ValueError(output or f"Codex logout failed with exit code {result.returncode}")
        return {
            "ok": True,
            "message": output or "Codex credentials removed.",
        }

    def send(self, conv: Dict[str, Any], prompt: str, cancel_event: Optional[threading.Event] = None) -> Tuple[str, Optional[str]]:
        session_id = conv.get("codex_session_id")
        if session_id:
            return self._run_resume(session_id, prompt, cancel_event)
        return self._run_new(prompt, cancel_event)

    def _base_options(self) -> Tuple[str, List[str], int]:
        settings = self.store.settings()
        path = settings.get("codex_path") or "codex"
        self._ensure_cli(path)
        model = (settings.get("model") or DEFAULT_MODEL).strip()
        effort = settings.get("reasoning_effort", "high").strip()
        verbosity = settings.get("verbosity", "medium").strip()
        timeout = int(settings.get("codex_timeout_seconds", "600") or "600")
        opts: List[str] = ['-c', 'approval_policy="never"']
        if model:
            opts += ["-m", model]
        if effort:
            opts += ["-c", f'model_reasoning_effort="{effort}"']
        if verbosity:
            opts += ["-c", f'model_verbosity="{verbosity}"']
        return path, opts, timeout

    def _run_new(self, prompt: str, cancel_event: Optional[threading.Event] = None) -> Tuple[str, Optional[str]]:
        path, opts, timeout = self._base_options()
        with tempfile.NamedTemporaryFile("w+", delete=False, encoding="utf-8") as out:
            out_path = out.name
        cmd = [
            path,
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-C",
            str(self.store.home),
            "--json",
            "-o",
            out_path,
        ] + opts + ["-"]
        answer, thread_id = self._run_command(cmd, prompt, timeout, out_path, cancel_event)
        return answer, thread_id or latest_codex_session_id()

    def _run_resume(
        self, session_id: str, prompt: str, cancel_event: Optional[threading.Event] = None
    ) -> Tuple[str, Optional[str]]:
        path, opts, timeout = self._base_options()
        with tempfile.NamedTemporaryFile("w+", delete=False, encoding="utf-8") as out:
            out_path = out.name
        cmd = [
            path,
            "exec",
            "resume",
            session_id,
            "--skip-git-repo-check",
            "--json",
            "-o",
            out_path,
        ] + opts + ["-"]
        try:
            answer, thread_id = self._run_command(cmd, prompt, timeout, out_path, cancel_event)
            return answer, thread_id or session_id
        except RuntimeError as exc:
            if (cancel_event and cancel_event.is_set()) or str(exc) == "Canceled.":
                raise
            fallback_prompt = (
                "The previous Codex CLI session could not be resumed, so continue from this local app prompt.\n\n"
                + prompt
            )
            answer, new_session = self._run_new(fallback_prompt, cancel_event)
            return f"[Codex session resume failed; started a new session.]\n\n{answer}", new_session

    def _run_command(
        self,
        cmd: List[str],
        prompt: str,
        timeout: int,
        out_path: str,
        cancel_event: Optional[threading.Event] = None,
    ) -> Tuple[str, Optional[str]]:
        stdout_file = tempfile.NamedTemporaryFile("w+", delete=False, encoding="utf-8")
        stderr_file = tempfile.NamedTemporaryFile("w+", delete=False, encoding="utf-8")
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=stdout_file,
                stderr=stderr_file,
                text=True,
            )
            assert proc.stdin is not None
            proc.stdin.write(prompt)
            proc.stdin.close()
            started = time.monotonic()
            while proc.poll() is None:
                if cancel_event and cancel_event.is_set():
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                    raise RuntimeError("Canceled.")
                if time.monotonic() - started > timeout:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                    raise RuntimeError(f"Codex timed out after {timeout} seconds.")
                time.sleep(0.2)
        finally:
            stdout_file.close()
            stderr_file.close()
        stdout = pathlib.Path(stdout_file.name).read_text(encoding="utf-8", errors="replace")
        stderr = pathlib.Path(stderr_file.name).read_text(encoding="utf-8", errors="replace")
        pathlib.Path(stdout_file.name).unlink(missing_ok=True)
        pathlib.Path(stderr_file.name).unlink(missing_ok=True)
        output = pathlib.Path(out_path).read_text(encoding="utf-8", errors="replace").strip()
        try:
            pathlib.Path(out_path).unlink(missing_ok=True)
        except Exception:
            pass
        if proc.returncode != 0:
            details = (stderr or stdout or "").strip()
            raise RuntimeError(f"Codex failed with exit code {proc.returncode}.\n{details}")
        thread_id = parse_thread_id(stdout)
        return output or parse_last_agent_message(stdout) or stdout.strip(), thread_id

    def initialize_with_paper(
        self, conv: Dict[str, Any], paper: Dict[str, Any], cancel_event: Optional[threading.Event] = None
    ) -> Tuple[str, Optional[str]]:
        pdf_path = pathlib.Path(paper["path"]).expanduser().resolve()
        if not pdf_path.exists():
            raise RuntimeError("PDF file not found.")
        prompt = init_pdf_path_prompt(paper["title"], str(pdf_path))
        return self.send(conv, prompt, cancel_event)


class TaskManager:
    def __init__(self, store: Store, codex: CodexRunner):
        self.store = store
        self.codex = codex
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.cancel_events: Dict[str, threading.Event] = {}
        self.next_queue_order = 0

    def list_tasks(self) -> List[Dict[str, Any]]:
        with self.lock:
            return [self._public_task(task) for task in sorted(self.tasks.values(), key=self._task_sort_key)]

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            task = self.tasks.get(task_id)
            return self._public_task(task) if task else None

    def has_active_conversation_tasks(self, conversation_id: str) -> bool:
        with self.lock:
            return any(
                task["conversation_id"] == conversation_id and task["status"] in {"queued", "running", "canceling"}
                for task in self.tasks.values()
            )

    def cancel(self, task_id: str) -> Dict[str, Any]:
        with self.lock:
            task = self.tasks.get(task_id)
            if not task:
                raise ValueError("Task not found.")
            event = self.cancel_events.get(task_id)
            if task["status"] in {"done", "error", "canceled"}:
                return self._public_task(task)
            task["status"] = "canceling"
            task["updated_at"] = now_iso()
            if event:
                event.set()
            self.condition.notify_all()
            return self._public_task(task)

    def reorder(self, task_ids: List[str]) -> List[Dict[str, Any]]:
        if not isinstance(task_ids, list):
            raise ValueError("Provide task_ids as a list.")
        ordered_ids = [str(task_id) for task_id in task_ids]
        with self.condition:
            for task_id in ordered_ids:
                task = self.tasks.get(task_id)
                if not task:
                    raise ValueError("Task not found.")
            for index, task_id in enumerate(ordered_ids):
                task = self.tasks[task_id]
                if task["status"] == "queued":
                    task["queue_order"] = index
                    task["updated_at"] = now_iso()
            trailing_order = len(task_ids)
            for task in sorted(self.tasks.values(), key=self._task_sort_key):
                if task["status"] == "queued" and task["id"] not in ordered_ids:
                    task["queue_order"] = trailing_order
                    trailing_order += 1
            self.next_queue_order = max(
                [self.next_queue_order] + [int(task.get("queue_order", 0)) + 1 for task in self.tasks.values()]
            )
            self.condition.notify_all()
            return [self._public_task(task) for task in sorted(self.tasks.values(), key=self._task_sort_key)]

    def edit(self, task_id: str, prompt: str) -> Dict[str, Any]:
        clean_prompt = prompt.strip()
        if not clean_prompt:
            raise ValueError("Message is empty.")
        with self.condition:
            task = self.tasks.get(task_id)
            if not task:
                raise ValueError("Task not found.")
            if task["status"] != "queued" or task["kind"] != "message":
                raise ValueError("Only queued message tasks can be edited.")
            task["prompt"] = clean_prompt
            task["editable_content"] = clean_prompt
            task["label"] = (clean_prompt.splitlines()[0] or "向 Codex 提问").strip()[:80]
            task["updated_at"] = now_iso()
            conversation_id = task["conversation_id"]
            user_message_id = task.get("user_message_id")
            public = self._public_task(task)
            self.condition.notify_all()
        if user_message_id:
            self.store.update_message_content(conversation_id, user_message_id, clean_prompt)
        return public

    def enqueue_message(
        self,
        conversation_id: str,
        prompt: str,
        label: str,
        user_message_id: Optional[str] = None,
        editable_content: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._enqueue(
            conversation_id,
            "message",
            label,
            {
                "prompt": prompt,
                "editable_content": editable_content or prompt,
                "user_message_id": user_message_id,
            },
        )

    def enqueue_initialize(self, conversation_id: str, paper_id: str, label: str) -> Dict[str, Any]:
        return self._enqueue(conversation_id, "initialize", label, {"paper_id": paper_id})

    def _enqueue(self, conversation_id: str, kind: str, label: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        task_id = str(uuid.uuid4())
        event = threading.Event()
        task = {
            "id": task_id,
            "conversation_id": conversation_id,
            "kind": kind,
            "label": label,
            "status": "queued",
            "queue_order": 0,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "error": None,
            **payload,
        }
        with self.condition:
            task["queue_order"] = self.next_queue_order
            self.next_queue_order += 1
            self.tasks[task_id] = task
            self.cancel_events[task_id] = event
            self.condition.notify_all()
        thread = threading.Thread(target=self._thread_main, args=(task_id, event), daemon=True)
        thread.start()
        return self._public_task(task)

    def _thread_main(self, task_id: str, event: threading.Event) -> None:
        with self.condition:
            while True:
                task = self.tasks.get(task_id)
                if not task:
                    return
                if event.is_set() or task["status"] == "canceling":
                    self._finish_locked(task_id, "canceled")
                    return
                if self._is_next_for_conversation_locked(task_id):
                    task["status"] = "running"
                    task["updated_at"] = now_iso()
                    self.condition.notify_all()
                    break
                self.condition.wait(timeout=0.5)
        try:
            self._run_task(task_id, event)
            if event.is_set():
                self._finish(task_id, "canceled")
            else:
                self._finish(task_id, "done")
        except Exception as exc:
            if str(exc) == "Canceled.":
                self._finish(task_id, "canceled")
            else:
                self._finish(task_id, "error", str(exc))

    def _run_task(self, task_id: str, event: threading.Event) -> None:
        with self.lock:
            task = dict(self.tasks.get(task_id) or {})
        kind = task.get("kind")
        if kind == "message":
            self._run_message(task["conversation_id"], task.get("prompt") or "", event)
        elif kind == "initialize":
            self._run_initialize(task["conversation_id"], task.get("paper_id") or "", event)
        else:
            raise RuntimeError("Unknown task type.")

    def _run_message(self, conversation_id: str, prompt: str, event: threading.Event) -> None:
        conv = self.store.get_conversation(conversation_id)
        if not conv:
            raise RuntimeError("Conversation not found.")
        if not prompt.strip():
            raise RuntimeError("Message is empty.")
        answer, session_id = self.codex.send(conv, prompt, event)
        self.store.update_conversation_session(conversation_id, session_id, initialized=False)
        self.store.add_message(conversation_id, "assistant", answer)

    def _run_initialize(self, conversation_id: str, paper_id: str, event: threading.Event) -> None:
        conv = self.store.get_conversation(conversation_id)
        paper = self.store.get_paper(paper_id)
        if not conv or not paper:
            raise RuntimeError("Conversation or paper not found.")
        answer, session_id = self.codex.initialize_with_paper(conv, paper, event)
        self.store.update_conversation_session(conversation_id, session_id, initialized=True)
        self.store.add_message(conversation_id, "assistant", answer)

    def _mark(self, task_id: str, status: str) -> None:
        with self.condition:
            self.tasks[task_id]["status"] = status
            self.tasks[task_id]["updated_at"] = now_iso()
            self.condition.notify_all()

    def _finish(self, task_id: str, status: str, error: Optional[str] = None) -> None:
        with self.condition:
            self._finish_locked(task_id, status, error)

    def _finish_locked(self, task_id: str, status: str, error: Optional[str] = None) -> None:
        task = self.tasks[task_id]
        task["status"] = status
        task["updated_at"] = now_iso()
        task["error"] = error
        self.cancel_events.pop(task_id, None)
        self.condition.notify_all()

    def _is_next_for_conversation_locked(self, task_id: str) -> bool:
        task = self.tasks[task_id]
        if task["status"] != "queued":
            return False
        conversation_id = task["conversation_id"]
        if any(
            item["conversation_id"] == conversation_id and item["status"] in {"running", "canceling"}
            for item in self.tasks.values()
        ):
            return False
        queued = sorted(
            [
                item
                for item in self.tasks.values()
                if item["conversation_id"] == conversation_id and item["status"] == "queued"
            ],
            key=self._task_sort_key,
        )
        return bool(queued) and queued[0]["id"] == task_id

    def _task_sort_key(self, task: Dict[str, Any]) -> Tuple[int, int, str]:
        status_order = {"running": 0, "canceling": 1, "queued": 2, "error": 3, "canceled": 4, "done": 5}
        return (
            status_order.get(task.get("status"), 9),
            int(task.get("queue_order", 0)),
            str(task.get("created_at", "")),
        )

    def _public_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        public = dict(task)
        public["can_reorder"] = task.get("status") == "queued"
        public["can_edit"] = task.get("status") == "queued" and task.get("kind") == "message"
        if public["can_edit"]:
            public["editable_content"] = task.get("editable_content") or task.get("prompt") or ""
        else:
            public.pop("editable_content", None)
        public.pop("prompt", None)
        public.pop("user_message_id", None)
        public.pop("paper_id", None)
        return public


def init_pdf_path_prompt(title: str, pdf_path: str) -> str:
    return (
        "你正在读全文模式下读取论文。请直接读取下面这个本地 PDF 文件，"
        "必要时可以使用 Python 或系统工具解析 PDF 内容。\n"
        "请阅读并记住它，后续用户会直接提问或选中文本提问。"
        "请不要生成独立的 Paper Brief，不要做代码索引。"
        "读完后只用中文简短回复：你已经读完这篇论文，可以开始提问；"
        "如果 PDF 无法读取或内容太长，请说明原因和你已尽力保留的主要上下文。"
        f"\n\n论文标题：{title}\n\nPDF 本地路径：\n{pdf_path}"
    )


def selected_text_prompt(title: str, selected_text: str, user_note: str = "") -> str:
    note = f"\n\n用户补充问题：\n{user_note.strip()}" if user_note.strip() else ""
    return (
        "请基于当前论文对话上下文处理我添加到对话的论文选区。"
        "如果只有一个选区，输出严格限制为两段：第一段只做忠实中文翻译；第二段做简短分析，说明这段话的核心意思和在论文中的作用。"
        "如果有多个选区，请按选区顺序处理，每个选区仍然只保留“翻译”和“简短分析”两段。"
        "除非用户补充问题明确要求更多细节，否则不要展开成长篇解释。"
        f"\n\n论文：{title}\n\n论文选区：\n{selected_text.strip()}{note}"
    )


def latest_codex_session_id() -> Optional[str]:
    index_path = pathlib.Path.home() / ".codex" / "session_index.jsonl"
    if not index_path.exists():
        return None
    last: Optional[Dict[str, Any]] = None
    try:
        for line in index_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip():
                last = json.loads(line)
    except Exception:
        return None
    if not last:
        return None
    value = last.get("id")
    return str(value) if value else None


def parse_thread_id(stdout: str) -> Optional[str]:
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        thread_id = event.get("thread_id")
        if thread_id:
            return str(thread_id)
    return None


def parse_last_agent_message(stdout: str) -> str:
    message = ""
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        item = event.get("item") or {}
        if event.get("type") == "item.completed" and item.get("type") == "agent_message":
            message = item.get("text") or message
    return message


class AppHandler(SimpleHTTPRequestHandler):
    store: Store
    codex: CodexRunner
    tasks: TaskManager

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), format % args))

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/":
                self.serve_static("index.html")
            elif path.startswith("/static/"):
                self.serve_static(path.removeprefix("/static/"))
            elif path == "/api/status":
                json_response(self, self.codex.status())
            elif path == "/api/settings":
                json_response(self, self.store.settings())
            elif path == "/api/papers":
                json_response(self, self.store.list_papers())
            elif path.startswith("/api/papers/") and path.endswith("/file"):
                paper_id = path.split("/")[3]
                self.serve_paper_file(paper_id)
            elif path == "/api/conversations":
                json_response(self, self.store.list_conversations())
            elif path.startswith("/api/conversations/") and path.endswith("/messages"):
                conv_id = path.split("/")[3]
                json_response(self, self.store.list_messages(conv_id))
            elif path == "/api/tasks":
                json_response(self, self.tasks.list_tasks())
            elif path.startswith("/api/tasks/"):
                task_id = path.split("/")[3]
                task = self.tasks.get_task(task_id)
                if not task:
                    json_response(self, {"error": "Task not found"}, 404)
                else:
                    json_response(self, task)
            else:
                json_response(self, {"error": "Not found"}, 404)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/settings":
                json_response(self, self.store.update_settings(read_json(self)))
            elif path == "/api/codex/login":
                json_response(self, self.codex.login())
            elif path == "/api/codex/logout":
                json_response(self, self.codex.logout())
            elif path == "/api/papers/import":
                data = read_json(self)
                if data.get("data_base64") and data.get("filename"):
                    paper = self.store.add_paper_from_upload(data["filename"], data["data_base64"], data.get("title"))
                elif data.get("url"):
                    paper = self.store.add_paper_from_url(data["url"], data.get("title"))
                elif data.get("path"):
                    paper = self.store.add_paper_from_path(data["path"], data.get("title"))
                else:
                    raise ValueError("Provide either a local PDF path or a PDF URL.")
                json_response(self, paper)
            elif path.startswith("/api/papers/") and path.count("/") == 3:
                paper_id = path.split("/")[3]
                data = read_json(self)
                json_response(self, self.store.update_paper_title(paper_id, data.get("title") or ""))
            elif path == "/api/conversations":
                data = read_json(self)
                conv = self.store.create_conversation(data.get("paper_id"), data.get("title"))
                json_response(self, conv)
            elif path == "/api/conversations/reorder":
                data = read_json(self)
                json_response(self, self.store.reorder_conversations(data.get("conversation_ids") or []))
            elif path == "/api/conversation-folders/reorder":
                data = read_json(self)
                json_response(self, self.store.reorder_conversation_folders(data.get("group_keys") or []))
            elif path.startswith("/api/conversations/") and path.count("/") == 3:
                conv_id = path.split("/")[3]
                data = read_json(self)
                json_response(self, self.store.update_conversation_title(conv_id, data.get("title") or ""))
            elif path.startswith("/api/conversations/") and path.endswith("/initialize"):
                conv_id = path.split("/")[3]
                self.handle_initialize(conv_id)
            elif path.startswith("/api/conversations/") and path.endswith("/messages"):
                conv_id = path.split("/")[3]
                self.handle_message(conv_id)
            elif path.startswith("/api/tasks/") and path.endswith("/cancel"):
                task_id = path.split("/")[3]
                json_response(self, self.tasks.cancel(task_id))
            elif path.startswith("/api/tasks/") and path.count("/") == 3:
                task_id = path.split("/")[3]
                data = read_json(self)
                json_response(self, self.tasks.edit(task_id, data.get("content") or ""))
            elif path == "/api/tasks/reorder":
                data = read_json(self)
                json_response(self, self.tasks.reorder(data.get("task_ids") or []))
            else:
                json_response(self, {"error": "Not found"}, 404)
        except ValueError as exc:
            json_response(self, {"error": str(exc)}, 400)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/papers/") and path.count("/") == 3:
                paper_id = path.split("/")[3]
                json_response(self, self.store.delete_paper(paper_id))
            elif path.startswith("/api/conversations/") and path.count("/") == 3:
                conv_id = path.split("/")[3]
                if self.tasks.has_active_conversation_tasks(conv_id):
                    json_response(self, {"error": "This conversation still has running or queued tasks. Cancel them first."}, 409)
                    return
                json_response(self, self.store.delete_conversation(conv_id))
            else:
                json_response(self, {"error": "Not found"}, 404)
        except ValueError as exc:
            json_response(self, {"error": str(exc)}, 404)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def serve_static(self, rel: str) -> None:
        target = (STATIC_DIR / rel).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.exists() or target.is_dir():
            json_response(self, {"error": "Not found"}, 404)
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_paper_file(self, paper_id: str) -> None:
        paper = self.store.get_paper(paper_id)
        if not paper:
            json_response(self, {"error": "Paper not found"}, 404)
            return
        path = pathlib.Path(paper["path"])
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Disposition", f'inline; filename="{path.name}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_initialize(self, conv_id: str) -> None:
        conv = self.store.get_conversation(conv_id)
        if not conv:
            json_response(self, {"error": "Conversation not found"}, 404)
            return
        data = read_json(self)
        paper_id = data.get("paper_id") or conv.get("paper_id")
        if not paper_id:
            raise ValueError("Choose a paper before initializing this conversation.")
        paper = self.store.get_paper(paper_id)
        if not paper:
            raise ValueError("Paper not found.")
        user_msg = self.store.add_message(conv_id, "user", f"读全文：{paper['title']}")
        task = self.tasks.enqueue_initialize(conv_id, paper["id"], f"读全文：{paper['title']}")
        json_response(self, {"user": user_msg, "task": task})

    def handle_message(self, conv_id: str) -> None:
        conv = self.store.get_conversation(conv_id)
        if not conv:
            json_response(self, {"error": "Conversation not found"}, 404)
            return
        data = read_json(self)
        content = (data.get("content") or "").strip()
        selected = (data.get("selected_text") or "").strip()
        paper_title = ""
        paper_id = data.get("paper_id") or conv.get("paper_id")
        if paper_id:
            paper = self.store.get_paper(paper_id)
            paper_title = paper["title"] if paper else ""
        if selected:
            prompt = selected_text_prompt(paper_title or "当前论文", selected, content)
            visible = f"{content}\n\n> 选中文本：\n{selected}" if content else f"解释选中文本：\n{selected}"
        else:
            prompt = content
            visible = content
        if not prompt.strip():
            raise ValueError("Message is empty.")
        user_msg = self.store.add_message(conv_id, "user", visible)
        label = (visible.splitlines()[0] or "向 Codex 提问").strip()
        task = self.tasks.enqueue_message(conv_id, prompt, label[:80], user_msg["id"], visible)
        json_response(self, {"user": user_msg, "task": task})


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Paper Codex Reader app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--home", default=str(DEFAULT_HOME))
    parser.add_argument("--no-auto-import", action="store_true")
    parser.add_argument("--open", action="store_true", help="Open the app in the default browser after startup.")
    args = parser.parse_args()

    store = Store(pathlib.Path(args.home).expanduser())
    if not args.no_auto_import:
        store.auto_import_workspace_papers(pathlib.Path.cwd())
        store.auto_import_workspace_papers(APP_DIR.parent)
    handler = AppHandler
    handler.store = store
    handler.codex = CodexRunner(store)
    handler.tasks = TaskManager(store, handler.codex)

    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}"
    print(f"Paper Codex Reader running at {url}")
    print(f"Data directory: {store.home}")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")


if __name__ == "__main__":
    main()
