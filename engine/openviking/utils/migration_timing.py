"""Metadata-only migration timing; no prompt, content, credentials or URI is logged.

Durations are inclusive and may overlap. JSONL start/end events retain failures
and interrupted stages. Telemetry ids reconnect persistent embedding consumers
to their producing migration task; ordinary sessions are a no-op.
"""
from __future__ import annotations

import contextvars
import functools
import json
import logging
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

_active = contextvars.ContextVar("violoop_migration_timing", default=None)
_stage = contextvars.ContextVar("violoop_migration_timing_stage", default=None)
_by_telemetry = {}
_by_run = {}
_override = contextvars.ContextVar("violoop_migration_timing_override", default=None)
_warned = False


def current_trace():
    override = _override.get()
    if override is not None:
        return override
    # Queue workers may retain a producer's ContextVar after that producer ends.
    # Prefer the collector explicitly rebound for the current queue delivery.
    if _by_telemetry:
        from openviking.telemetry import get_current_telemetry
        trace = _by_telemetry.get(get_current_telemetry().telemetry_id)
        if trace is not None:
            return trace
    trace = _active.get()
    return trace if trace is not None and not trace.get("closed") else None


def link_telemetry(telemetry_id):
    trace = _active.get()
    if trace is not None:
        _by_telemetry[telemetry_id] = trace


def emit_for_telemetry(telemetry_id, event, **fields):
    trace = _by_telemetry.get(telemetry_id)
    if trace is not None:
        emit(event, trace, **fields)


def emit(event, trace=None, **fields):
    global _warned
    trace = trace or current_trace()
    if trace is None:
        return
    try:
        path = Path(trace["dir"])
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        record = {"version": 1, "component": "native", "event": event,
                  "taskId": trace["taskId"], "runId": trace["runId"],
                  "at": datetime.now(timezone.utc).isoformat(), **fields}
        fd = os.open(path / (trace["taskId"] + "-native.jsonl"),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (json.dumps(record, ensure_ascii=False) + "\n").encode())
        finally:
            os.close(fd)
    except Exception:
        if not _warned:
            _warned = True
            logging.getLogger(__name__).warning("Migration timing write failed; continuing work")


@contextmanager
def stage(name, **fields):
    trace = current_trace()
    if trace is None:
        yield
        return
    event_id = uuid4().hex
    parent = _stage.get()
    token = _stage.set({"name": name, "eventId": event_id})
    started = time.perf_counter()
    emit("stage.start", trace, stage=name, eventId=event_id,
         parentId=parent["eventId"] if parent else None, **fields)
    status = "returned"
    try:
        yield
    except BaseException as exc:
        status = type(exc).__name__
        raise
    finally:
        emit("stage.end", trace, stage=name, eventId=event_id,
             durationMs=(time.perf_counter() - started) * 1000, status=status, **fields)
        _stage.reset(token)


def timed(name):
    def decorate(fn):
        @functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            with stage(name):
                return await fn(*args, **kwargs)
        return wrapped
    return decorate


async def timed_await(name, awaitable, **fields):
    with stage(name, **fields):
        return await awaitable


def migration_process(fn):
    @functools.wraps(fn)
    async def wrapped(self, msg, ctx):
        directory = os.environ.get("VIOLOOP_MIGRATION_TIMING_DIR")
        if not directory or not msg.session_id.startswith("vm-legacy-") or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", msg.task_id):
            return await fn(self, msg, ctx)
        trace = {"dir": directory, "taskId": msg.task_id, "runId": uuid4().hex}
        _by_run[trace["runId"]] = trace
        token = _active.set(trace)
        try:
            with stage("batch.native"):
                return await fn(self, msg, ctx)
        finally:
            for key in [key for key, value in _by_telemetry.items() if value is trace]:
                del _by_telemetry[key]
            # A queue delivery can finish after its producer returns (or times out).
            # Retain only this tiny metadata record for the finite migration run;
            # explicit queue tags may still write it, stale worker contexts may not.
            trace["closed"] = True
            _active.reset(token)
    return wrapped


def headers(purpose=None):
    trace = current_trace()
    if trace is None:
        return {}
    return {"x-violoop-timing-task": trace["taskId"],
            "x-violoop-timing-run": trace["runId"],
            "x-violoop-timing-purpose": purpose or (_stage.get() or {}).get("name", "unknown")}


def trace_tag():
    trace = current_trace()
    return {"runId": trace["runId"]} if trace else None


@contextmanager
def bind_tag(tag):
    trace = _by_run.get((tag or {}).get("runId")) if isinstance(tag, dict) else None
    token = _override.set(trace)
    try:
        yield
    finally:
        _override.reset(token)


def emit_for_tag(tag, event, **fields):
    trace = _by_run.get((tag or {}).get("runId")) if isinstance(tag, dict) else None
    if trace:
        emit(event, trace, **fields)


def tag_request(request):
    tag = trace_tag()
    if tag:
        request.metadata["_violoop_timing"] = tag


def timed_requests(fn):
    @functools.wraps(fn)
    async def wrapped(self, group_key, requests, reason):
        tags = [r.metadata.get("_violoop_timing") for r in requests]
        runs = {t["runId"] for t in tags if isinstance(t, dict) and t.get("runId")}
        # Sequential legacy migration has a single owner. Do not misattribute
        # a future cross-task coalesced batch to just one participating task.
        tag = {"runId": next(iter(runs))} if len(runs) == 1 else None
        with bind_tag(tag):
            return await fn(self, group_key, requests, reason)
    return wrapped
