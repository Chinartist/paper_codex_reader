#!/usr/bin/env python3
"""Local Paper + Codex reader.

Run with:
    python app.py

The server intentionally uses Python's standard library for the web layer so
the packaged app only needs one runtime dependency: pypdf for text extraction.
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
        shutil.which("codex") or "",
        shutil.which("codex.cmd") or "",
        shutil.which("codex.exe") or "",
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
            if path_exists_or_command(path):
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
        with self.connect() as con:
            rows = con.execute(
                """
                select c.*, p.title as paper_title
                from conversations c
                left join papers p on p.id = c.paper_id
                order by c.updated_at desc
                """
            ).fetchall()
            return [dict(row) for row in rows]

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


def extract_pdf_text(pdf_path: str) -> str:
    try:
        from pypdf import PdfReader
    except Exception as exc:
        raise RuntimeError("Missing dependency pypdf. Run ./run.sh or pip install -r requirements.txt.") from exc

    reader = PdfReader(pdf_path)
    parts: List[str] = []
    for idx, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:
            text = f"[Page {idx} text extraction failed: {exc}]"
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if text:
            parts.append(f"\n\n--- Page {idx} ---\n{text}")
    return "\n".join(parts).strip()


def chunk_text(text: str, chunk_chars: int) -> List[str]:
    if len(text) <= chunk_chars:
        return [text]
    chunks: List[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_chars, len(text))
        if end < len(text):
            boundary = text.rfind("\n--- Page ", start, end)
            if boundary > start + chunk_chars // 2:
                end = boundary
        chunks.append(text[start:end].strip())
        start = end
    return [chunk for chunk in chunks if chunk]


class CodexRunner:
    def __init__(self, store: Store):
        self.store = store

    def status(self) -> Dict[str, Any]:
        settings = self.store.settings()
        path = settings.get("codex_path") or "codex"
        result = {
            "path": path,
            "exists": path_exists_or_command(path),
            "platform": sys.platform,
            "data_home": str(self.store.home),
        }
        try:
            version = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10)
            result["version"] = (version.stdout or version.stderr).strip()
        except Exception as exc:
            result["version_error"] = str(exc)
        try:
            login = subprocess.run([path, "login", "status"], capture_output=True, text=True, timeout=20)
            result["login_status"] = (login.stdout or login.stderr).strip()
            result["login_ok"] = login.returncode == 0
        except Exception as exc:
            result["login_status"] = str(exc)
            result["login_ok"] = False
        return result

    def send(self, conv: Dict[str, Any], prompt: str, cancel_event: Optional[threading.Event] = None) -> Tuple[str, Optional[str]]:
        session_id = conv.get("codex_session_id")
        if session_id:
            return self._run_resume(session_id, prompt, cancel_event)
        return self._run_new(prompt, cancel_event)

    def _base_options(self) -> Tuple[str, List[str], int]:
        settings = self.store.settings()
        path = settings.get("codex_path") or "codex"
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
        settings = self.store.settings()
        chunk_chars = max(4000, int(settings.get("paper_chunk_chars", "18000") or "18000"))
        text = extract_pdf_text(paper["path"])
        if not text:
            raise RuntimeError("No extractable text was found in this PDF.")
        chunks = chunk_text(text, chunk_chars)
        total = len(chunks)
        session_id = conv.get("codex_session_id")
        last_answer = ""
        for idx, chunk in enumerate(chunks, start=1):
            if total == 1:
                prompt = init_prompt(paper["title"], chunk, idx, total, final=True)
            elif idx < total:
                prompt = init_prompt(paper["title"], chunk, idx, total, final=False)
            else:
                prompt = init_prompt(paper["title"], chunk, idx, total, final=True)
            current = dict(conv)
            current["codex_session_id"] = session_id
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("Canceled.")
            last_answer, new_session = self.send(current, prompt, cancel_event)
            session_id = new_session or session_id
        return last_answer, session_id


class TaskManager:
    def __init__(self, store: Store, codex: CodexRunner):
        self.store = store
        self.codex = codex
        self.lock = threading.Lock()
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.cancel_events: Dict[str, threading.Event] = {}
        self.conversation_locks: Dict[str, threading.Lock] = {}

    def list_tasks(self) -> List[Dict[str, Any]]:
        with self.lock:
            return [self._public_task(task) for task in sorted(self.tasks.values(), key=lambda item: item["created_at"])]

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
            return self._public_task(task)

    def enqueue_message(self, conversation_id: str, prompt: str, label: str) -> Dict[str, Any]:
        return self._enqueue(conversation_id, "message", label, lambda event: self._run_message(conversation_id, prompt, event))

    def enqueue_initialize(self, conversation_id: str, paper_id: str, label: str) -> Dict[str, Any]:
        return self._enqueue(
            conversation_id, "initialize", label, lambda event: self._run_initialize(conversation_id, paper_id, event)
        )

    def _enqueue(self, conversation_id: str, kind: str, label: str, runner: Any) -> Dict[str, Any]:
        task_id = str(uuid.uuid4())
        event = threading.Event()
        task = {
            "id": task_id,
            "conversation_id": conversation_id,
            "kind": kind,
            "label": label,
            "status": "queued",
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "error": None,
        }
        with self.lock:
            self.tasks[task_id] = task
            self.cancel_events[task_id] = event
            self.conversation_locks.setdefault(conversation_id, threading.Lock())
        thread = threading.Thread(target=self._thread_main, args=(task_id, runner, event), daemon=True)
        thread.start()
        return self._public_task(task)

    def _thread_main(self, task_id: str, runner: Any, event: threading.Event) -> None:
        task = self.tasks[task_id]
        conv_id = task["conversation_id"]
        conv_lock = self.conversation_locks[conv_id]
        with conv_lock:
            if event.is_set():
                self._finish(task_id, "canceled")
                return
            self._mark(task_id, "running")
            try:
                runner(event)
                if event.is_set():
                    self._finish(task_id, "canceled")
                else:
                    self._finish(task_id, "done")
            except Exception as exc:
                if str(exc) == "Canceled.":
                    self._finish(task_id, "canceled")
                else:
                    self._finish(task_id, "error", str(exc))

    def _run_message(self, conversation_id: str, prompt: str, event: threading.Event) -> None:
        conv = self.store.get_conversation(conversation_id)
        if not conv:
            raise RuntimeError("Conversation not found.")
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
        with self.lock:
            self.tasks[task_id]["status"] = status
            self.tasks[task_id]["updated_at"] = now_iso()

    def _finish(self, task_id: str, status: str, error: Optional[str] = None) -> None:
        with self.lock:
            task = self.tasks[task_id]
            task["status"] = status
            task["updated_at"] = now_iso()
            task["error"] = error
            self.cancel_events.pop(task_id, None)

    def _public_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        return dict(task)


def init_prompt(title: str, content: str, index: int, total: int, final: bool) -> str:
    if final:
        instruction = (
            "你正在初始化一个读论文对话。下面是论文内容"
            f"（第 {index}/{total} 块）。请阅读并记住它，后续用户会直接提问或选中文本提问。\n"
            "请不要生成独立的 Paper Brief，不要做代码索引。读完后只用中文简短回复："
            "你已经读完这篇论文，可以开始提问；如果内容太长，请说明你已尽力保留主要上下文。"
        )
    else:
        instruction = (
            "你正在初始化一个读论文对话。下面是论文内容"
            f"（第 {index}/{total} 块）。请阅读并保留上下文，等待后续块。"
            "请只用一句中文确认已读取本块，不要总结。"
        )
    return f"{instruction}\n\n论文标题：{title}\n\n论文内容：\n{content}"


def selected_text_prompt(title: str, selected_text: str, user_note: str = "") -> str:
    note = f"\n\n用户补充问题：\n{user_note.strip()}" if user_note.strip() else ""
    return (
        "请基于当前论文对话上下文处理我选中的这段内容。"
        "输出严格限制为两段：第一段只做忠实中文翻译；第二段做简短分析，说明这段话的核心意思和在论文中的作用。"
        "除非用户补充问题明确要求更多细节，否则不要展开成长篇解释、不要列项目符号。"
        f"\n\n论文：{title}\n\n选中文本：\n{selected_text.strip()}{note}"
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
            if path.startswith("/api/conversations/") and path.count("/") == 3:
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
        user_msg = self.store.add_message(conv_id, "user", f"重新读取论文：{paper['title']}")
        task = self.tasks.enqueue_initialize(conv_id, paper["id"], f"重新读取论文：{paper['title']}")
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
        task = self.tasks.enqueue_message(conv_id, prompt, label[:80])
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
