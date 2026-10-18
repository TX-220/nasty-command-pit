#!/usr/bin/env python3
"""Nasty Command Pit — local one-click command runner for Vesper tools."""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
COMMANDS_PATH = Path(os.environ.get("VESPER_COMMANDS_PATH", ROOT / "commands.json")).expanduser()
RUN_TIMEOUT_SEC = 30
HOST = "127.0.0.1"
PORT = 7421

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("vesper-launcher")
_write_lock = threading.RLock()
_ID_SAFE = re.compile(r"[^a-z0-9]+")

app = FastAPI(
    title="Nasty Command Pit",
    version="0.3.0",
    description="Local GUI for whitelisted Vesper commands (Nasty Command Pit)",
)


class RunRequest(BaseModel):
    command_id: str = Field(..., min_length=1)


class CommandBody(BaseModel):
    """Create or replace the editable fields of one whitelist entry."""

    label: str = Field(..., min_length=1, max_length=80)
    command: str = Field(..., min_length=1, max_length=2000)
    category_id: str | None = Field(None, max_length=48)
    new_category: str | None = Field(None, max_length=40)
    cwd: str | None = Field(None, max_length=500)
    description: str | None = Field(None, max_length=400)
    detach: bool = False
    open_url: str | None = Field(None, max_length=500)


class CategoryBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)


class CommandPatch(BaseModel):
    """Rename, or edit fields the client actually sent."""

    label: str | None = Field(None, min_length=1, max_length=80)
    command: str | None = Field(None, max_length=2000)
    category_id: str | None = Field(None, max_length=48)
    new_category: str | None = Field(None, max_length=40)
    cwd: str | None = Field(None, max_length=500)
    description: str | None = Field(None, max_length=400)
    detach: bool | None = None
    open_url: str | None = Field(None, max_length=500)


class RunResponse(BaseModel):
    ok: bool
    command_id: str
    command: list[str]
    cwd: str | None = None
    returncode: int | None = None
    stdout: str = ""
    stderr: str = ""
    error: str | None = None
    open_url: str | None = None
    open_delay_ms: int = 0


def _client_host(request: Request) -> str:
    if request.client is None:
        return ""
    return request.client.host or ""


@app.middleware("http")
async def localhost_only(request: Request, call_next):
    host = _client_host(request)
    # Allow loopback only (IPv4 and IPv6).
    if host not in ("127.0.0.1", "::1", "localhost"):
        logger.warning("Rejected non-localhost request from %s", host or "(unknown)")
        return JSONResponse(
            status_code=403,
            content={"detail": "Access denied: only 127.0.0.1 is allowed"},
        )
    return await call_next(request)


def load_commands() -> dict[str, Any]:
    if not COMMANDS_PATH.is_file():
        raise HTTPException(status_code=500, detail=f"commands.json not found: {COMMANDS_PATH}")
    try:
        data = json.loads(COMMANDS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse commands.json: %s", exc)
        raise HTTPException(status_code=500, detail=f"Invalid commands.json: {exc}") from exc
    if not isinstance(data, dict) or "categories" not in data:
        raise HTTPException(status_code=500, detail="commands.json must have a 'categories' key")
    if not isinstance(data["categories"], list):
        raise HTTPException(status_code=500, detail="commands.json 'categories' must be a list")
    return data


def _save_commands_locked(data: dict[str, Any]) -> None:
    """Write commands.json atomically. Caller must hold _write_lock."""
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    tmp = COMMANDS_PATH.with_name(COMMANDS_PATH.name + ".tmp")
    bak = COMMANDS_PATH.with_suffix(".json.bak")
    COMMANDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if COMMANDS_PATH.is_file():
        bak.write_bytes(COMMANDS_PATH.read_bytes())
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(COMMANDS_PATH)


def _slug(text: str) -> str:
    raw = _ID_SAFE.sub("-", text.strip().lower()).strip("-")
    return (raw or "app")[:48]


def _command_ids(data: dict[str, Any]) -> set[str]:
    used: set[str] = set()
    for category in data.get("categories", []):
        for cmd in category.get("commands") or []:
            cid = cmd.get("id")
            if isinstance(cid, str):
                used.add(cid)
    return used


def _unique_command_id(data: dict[str, Any], base: str) -> str:
    used = _command_ids(data)
    if base not in used:
        return base
    for n in range(2, 100):
        cand = f"{base}-{n}"[:48].strip("-")
        if cand and cand not in used:
            return cand
    raise HTTPException(status_code=400, detail="Could not allocate a command id")


def _clean_text(value: str | None, *, limit: int, field: str) -> str:
    text = (value or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail=f"{field} is required")
    if len(text) > limit or any(ord(ch) < 32 for ch in text):
        raise HTTPException(status_code=400, detail=f"{field} is invalid")
    return text


def _clean_optional(value: str | None, *, limit: int, field: str) -> str:
    text = (value or "").strip()
    if len(text) > limit or any(ord(ch) < 32 for ch in text):
        raise HTTPException(status_code=400, detail=f"{field} is invalid")
    return text


def _parse_argv(text: str) -> list[str]:
    try:
        parts = shlex.split(text, posix=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Command could not be parsed: {exc}") from exc
    if not parts or len(parts) > 32:
        raise HTTPException(status_code=400, detail="Command must be 1–32 arguments (no shell)")
    if any(len(part) > 500 or "\x00" in part for part in parts):
        raise HTTPException(status_code=400, detail="A command argument is too long")
    return parts


def _clean_cwd(value: str | None) -> str | None:
    text = _clean_optional(value, limit=500, field="Working directory")
    return text or None


def _clean_url(value: str | None) -> str | None:
    text = _clean_optional(value, limit=500, field="Open URL")
    if not text:
        return None
    if not (text.startswith("http://") or text.startswith("https://")):
        raise HTTPException(status_code=400, detail="Open URL must start with http:// or https://")
    return text


def _category_by_id(data: dict[str, Any], category_id: str) -> dict[str, Any] | None:
    for category in data["categories"]:
        if category.get("id") == category_id:
            return category
    return None


def _resolve_category(data: dict[str, Any], category_id: str | None, new_category: str | None) -> dict[str, Any]:
    name = _clean_optional(new_category, limit=40, field="Category")
    if name:
        wanted = _slug(name)
        for category in data["categories"]:
            existing = category.get("name") or ""
            if existing.lower() == name.lower() or category.get("id") == wanted:
                return category
        used_ids = {c.get("id") for c in data["categories"]}
        cid = wanted
        n = 2
        while cid in used_ids:
            cid = f"{wanted}-{n}"[:48].strip("-")
            n += 1
        category = {"id": cid, "name": name, "commands": []}
        data["categories"].append(category)
        return category
    if category_id:
        category = _category_by_id(data, category_id.strip())
        if category is None:
            raise HTTPException(status_code=400, detail="Unknown category")
        return category
    if data["categories"]:
        return data["categories"][0]
    category = {"id": "custom", "name": "Custom", "commands": []}
    data["categories"].append(category)
    return category


def _locate(data: dict[str, Any], command_id: str) -> tuple[dict[str, Any], int, dict[str, Any]] | None:
    for category in data.get("categories", []):
        commands = category.get("commands")
        if not isinstance(commands, list):
            continue
        for index, cmd in enumerate(commands):
            if isinstance(cmd, dict) and cmd.get("id") == command_id:
                return category, index, cmd
    return None


def _apply_entry_fields(entry: dict[str, Any], *, label: str, argv: list[str] | None, cwd: str | None, description: str, detach: bool, open_url: str | None, set_command: bool) -> None:
    entry["label"] = label
    entry["description"] = description
    if set_command and argv is not None:
        entry["command"] = argv
    entry["cwd"] = cwd
    if detach:
        entry["detach"] = True
    elif "detach" in entry:
        entry["detach"] = False
    if open_url:
        entry["open_url"] = open_url
        if "open_delay_ms" not in entry:
            entry["open_delay_ms"] = 800
    else:
        entry.pop("open_url", None)
        entry.pop("open_delay_ms", None)


def find_command(command_id: str) -> dict[str, Any] | None:
    data = load_commands()
    for category in data.get("categories", []):
        for cmd in category.get("commands", []):
            if cmd.get("id") == command_id:
                return cmd
    return None


def resolve_cwd(cwd: str | None) -> str | None:
    if cwd is None or cwd == "":
        return None
    return str(Path(cwd).expanduser().resolve())


def expand_argv(argv: list[str]) -> list[str]:
    """Expand ~ in argv entries (still no shell)."""
    return [str(Path(part).expanduser()) if part.startswith("~") else part for part in argv]


def open_meta(entry: dict[str, Any]) -> tuple[str | None, int]:
    """Optional browser auto-open after a successful run."""
    url = entry.get("open_url")
    if not isinstance(url, str) or not url.strip():
        return None, 0
    delay = entry.get("open_delay_ms", 0)
    try:
        delay_ms = max(0, int(delay))
    except (TypeError, ValueError):
        delay_ms = 0
    return url.strip(), delay_ms


def run_env() -> dict[str, str]:
    """Ensure ~/bin is on PATH for whitelisted launcher scripts."""
    env = os.environ.copy()
    home_bin = str(Path.home() / "bin")
    path = env.get("PATH", "")
    parts = path.split(":") if path else []
    if home_bin not in parts:
        env["PATH"] = f"{home_bin}:{path}" if path else home_bin
    return env


@app.get("/api/commands")
def get_commands() -> dict[str, Any]:
    """Return commands.json (re-read from disk every time)."""
    return load_commands()


@app.post("/api/commands", status_code=201)
def create_command(body: CommandBody) -> dict[str, Any]:
    """Append a whitelist entry and persist it in commands.json."""
    label = _clean_text(body.label, limit=80, field="Display name")
    argv = _parse_argv(body.command)
    cwd = _clean_cwd(body.cwd)
    description = _clean_optional(body.description, limit=400, field="Description")
    open_url = _clean_url(body.open_url)
    with _write_lock:
        data = load_commands()
        category = _resolve_category(data, body.category_id, body.new_category)
        commands = category.setdefault("commands", [])
        if not isinstance(commands, list):
            raise HTTPException(status_code=500, detail="Category commands must be a list")
        entry: dict[str, Any] = {"id": _unique_command_id(data, _slug(label))}
        _apply_entry_fields(
            entry,
            label=label,
            argv=argv,
            cwd=cwd,
            description=description,
            detach=body.detach,
            open_url=open_url,
            set_command=True,
        )
        commands.append(entry)
        _save_commands_locked(data)
    logger.info("Registered command_id=%s label=%s", entry["id"], label)
    return {"ok": True, "command": entry}


@app.patch("/api/commands/{command_id}")
def update_command(command_id: str, body: CommandPatch) -> dict[str, Any]:
    """Rename or edit one entry. Omitted command text leaves the argv untouched."""
    sent = body.model_fields_set
    if not sent:
        raise HTTPException(status_code=400, detail="No changes")
    with _write_lock:
        data = load_commands()
        found = _locate(data, command_id)
        if found is None:
            raise HTTPException(status_code=404, detail=f"Unknown command_id: {command_id}")
        category, index, entry = found
        label = _clean_text(body.label, limit=80, field="Display name") if "label" in sent and body.label is not None else str(entry.get("label") or command_id)
        description = (
            _clean_optional(body.description, limit=400, field="Description")
            if "description" in sent
            else str(entry.get("description") or "")
        )
        cwd = _clean_cwd(body.cwd) if "cwd" in sent else entry.get("cwd")
        if cwd == "":
            cwd = None
        detach = body.detach if "detach" in sent and body.detach is not None else bool(entry.get("detach", False))
        open_url = _clean_url(body.open_url) if "open_url" in sent else entry.get("open_url")
        argv = _parse_argv(body.command) if "command" in sent and body.command is not None else None
        if "command" in sent and not (body.command or "").strip():
            raise HTTPException(status_code=400, detail="Command is required")
        move = "category_id" in sent or "new_category" in sent
        if move:
            target = _resolve_category(data, body.category_id, body.new_category)
        else:
            target = category
        _apply_entry_fields(
            entry,
            label=label,
            argv=argv,
            cwd=cwd if isinstance(cwd, str) or cwd is None else str(cwd),
            description=description,
            detach=detach,
            open_url=open_url if isinstance(open_url, str) or open_url is None else None,
            set_command=argv is not None,
        )
        if target is not category:
            category["commands"].pop(index)
            target.setdefault("commands", []).append(entry)
        _save_commands_locked(data)
    logger.info("Updated command_id=%s label=%s command_changed=%s", command_id, entry.get("label"), argv is not None)
    return {"ok": True, "command": entry}


@app.delete("/api/commands/{command_id}")
def delete_command(command_id: str) -> dict[str, Any]:
    """Remove one whitelist entry. The previous file is kept as commands.json.bak."""
    with _write_lock:
        data = load_commands()
        found = _locate(data, command_id)
        if found is None:
            raise HTTPException(status_code=404, detail=f"Unknown command_id: {command_id}")
        category, index, entry = found
        category["commands"].pop(index)
        _save_commands_locked(data)
    logger.info("Deleted command_id=%s", command_id)
    return {"ok": True, "command_id": command_id, "label": entry.get("label")}


def _new_category_id(data: dict[str, Any], name: str) -> str:
    used_ids = {c.get("id") for c in data["categories"]}
    cid = _slug(name)
    n = 2
    while cid in used_ids:
        cid = f"{_slug(name)}-{n}"[:48].strip("-")
        n += 1
        if n > 100:
            raise HTTPException(status_code=400, detail="Could not allocate a category id")
    return cid


@app.post("/api/categories", status_code=201)
def create_category(body: CategoryBody) -> dict[str, Any]:
    """Add an empty category folder."""
    name = _clean_text(body.name, limit=40, field="Category")
    with _write_lock:
        data = load_commands()
        for category in data["categories"]:
            if (category.get("name") or "").lower() == name.lower():
                raise HTTPException(status_code=400, detail="That category already exists")
        category = {"id": _new_category_id(data, name), "name": name, "commands": []}
        data["categories"].append(category)
        _save_commands_locked(data)
    logger.info("Created category id=%s name=%s", category["id"], name)
    return {"ok": True, "category": {"id": category["id"], "name": category["name"]}}


@app.patch("/api/categories/{category_id}")
def rename_category(category_id: str, body: CategoryBody) -> dict[str, Any]:
    """Rename a category. The id and the commands inside stay put."""
    name = _clean_text(body.name, limit=40, field="Category")
    with _write_lock:
        data = load_commands()
        target = _category_by_id(data, category_id)
        if target is None:
            raise HTTPException(status_code=404, detail="Unknown category")
        for category in data["categories"]:
            if category is target:
                continue
            if (category.get("name") or "").lower() == name.lower():
                raise HTTPException(status_code=400, detail="That category already exists")
        target["name"] = name
        _save_commands_locked(data)
    logger.info("Renamed category id=%s name=%s", category_id, name)
    return {"ok": True, "category": {"id": category_id, "name": name}}


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: str) -> dict[str, Any]:
    """Remove a category and the apps inside it. Previous file kept as commands.json.bak."""
    with _write_lock:
        data = load_commands()
        for index, category in enumerate(data["categories"]):
            if category.get("id") != category_id:
                continue
            commands = category.get("commands") or []
            removed = len(commands) if isinstance(commands, list) else 0
            data["categories"].pop(index)
            _save_commands_locked(data)
            logger.info("Deleted category id=%s removed_commands=%s", category_id, removed)
            return {"ok": True, "category_id": category_id, "removed_commands": removed}
    raise HTTPException(status_code=404, detail="Unknown category")


@app.post("/api/run", response_model=RunResponse)
def run_command(body: RunRequest) -> RunResponse:
    """Run a whitelisted command by id via subprocess (no shell)."""
    entry = find_command(body.command_id)
    if entry is None:
        logger.warning("Rejected unknown command_id=%s", body.command_id)
        raise HTTPException(
            status_code=404,
            detail=f"Unknown command_id: {body.command_id} (not in whitelist)",
        )

    raw_argv = entry.get("command")
    if not isinstance(raw_argv, list) or not raw_argv or not all(isinstance(x, str) for x in raw_argv):
        logger.error("Invalid command entry for id=%s: command must be a non-empty string list", body.command_id)
        raise HTTPException(
            status_code=500,
            detail="Invalid command definition: 'command' must be a non-empty list of strings",
        )

    argv = expand_argv(raw_argv)
    cwd = resolve_cwd(entry.get("cwd"))
    detach = bool(entry.get("detach", False))
    open_url, open_delay_ms = open_meta(entry)

    if cwd is not None and not Path(cwd).is_dir():
        msg = f"Working directory does not exist: {cwd}"
        logger.error("%s (command_id=%s)", msg, body.command_id)
        return RunResponse(
            ok=False,
            command_id=body.command_id,
            command=argv,
            cwd=cwd,
            error=msg,
        )

    env = run_env()

    # Long-running apps (GUI / servers): start detached, do not wait.
    if detach:
        log_path = Path(f"/tmp/vesper-launcher-{body.command_id}.log")
        logger.info(
            "Detaching command_id=%s argv=%s cwd=%s log=%s",
            body.command_id,
            argv,
            cwd,
            log_path,
        )
        try:
            log_file = open(log_path, "ab", buffering=0)
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                shell=False,
                env=env,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            msg = f"Executable not found: {exc.filename or argv[0]}"
            logger.error("%s (command_id=%s)", msg, body.command_id)
            return RunResponse(
                ok=False,
                command_id=body.command_id,
                command=argv,
                cwd=cwd,
                error=msg,
            )
        except OSError as exc:
            msg = f"OS error: {exc}"
            logger.error("%s (command_id=%s)", msg, body.command_id)
            return RunResponse(
                ok=False,
                command_id=body.command_id,
                command=argv,
                cwd=cwd,
                error=msg,
            )

        msg = f"Started in background (pid {proc.pid})\nLog: {log_path}\n"
        if open_url:
            msg += f"Open: {open_url}\n"
        logger.info("command_id=%s detached pid=%s open_url=%s", body.command_id, proc.pid, open_url)
        return RunResponse(
            ok=True,
            command_id=body.command_id,
            command=argv,
            cwd=cwd,
            returncode=None,
            stdout=msg,
            stderr="",
            error=None,
            open_url=open_url,
            open_delay_ms=open_delay_ms,
        )

    logger.info("Running command_id=%s argv=%s cwd=%s timeout=%ss", body.command_id, argv, cwd, RUN_TIMEOUT_SEC)

    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT_SEC,
            shell=False,
            check=False,
            env=env,
        )
    except FileNotFoundError as exc:
        msg = f"Executable not found: {exc.filename or argv[0]}"
        logger.error("%s (command_id=%s)", msg, body.command_id)
        return RunResponse(
            ok=False,
            command_id=body.command_id,
            command=argv,
            cwd=cwd,
            error=msg,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else (exc.stdout or b"").decode("utf-8", errors="replace")
        stderr = (exc.stderr or "") if isinstance(exc.stderr, str) else (exc.stderr or b"").decode("utf-8", errors="replace")
        msg = f"Timed out after {RUN_TIMEOUT_SEC}s"
        logger.error("%s (command_id=%s)", msg, body.command_id)
        return RunResponse(
            ok=False,
            command_id=body.command_id,
            command=argv,
            cwd=cwd,
            returncode=None,
            stdout=stdout,
            stderr=stderr,
            error=msg,
        )
    except OSError as exc:
        msg = f"OS error: {exc}"
        logger.error("%s (command_id=%s)", msg, body.command_id)
        return RunResponse(
            ok=False,
            command_id=body.command_id,
            command=argv,
            cwd=cwd,
            error=msg,
        )

    ok = completed.returncode == 0
    if ok:
        logger.info("command_id=%s finished returncode=0", body.command_id)
    else:
        logger.warning(
            "command_id=%s finished returncode=%s stderr_len=%s",
            body.command_id,
            completed.returncode,
            len(completed.stderr or ""),
        )

    return RunResponse(
        ok=ok,
        command_id=body.command_id,
        command=argv,
        cwd=cwd,
        returncode=completed.returncode,
        stdout=completed.stdout or "",
        stderr=completed.stderr or "",
        error=None if ok else f"Exit code {completed.returncode}",
        open_url=open_url if ok else None,
        open_delay_ms=open_delay_ms if ok else 0,
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.ico")


@app.get("/favicon.svg")
def favicon_svg() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def main() -> None:
    import uvicorn

    port = int(os.environ.get("VESPER_LAUNCHER_PORT", PORT))
    uvicorn.run(app, host=HOST, port=port, log_level="info")


if __name__ == "__main__":
    main()
