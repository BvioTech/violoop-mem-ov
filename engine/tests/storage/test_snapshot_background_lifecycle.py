"""Snapshot work must settle before its service closes queues and storage."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from openviking.core.context import ContextLevel
from openviking.server.identity import RequestContext, Role
from openviking.storage.viking_fs import VikingFS
from openviking_cli.session.user_id import UserIdentifier

pytestmark = pytest.mark.asyncio


def make_fs():
    fs = VikingFS.__new__(VikingFS)
    fs._background_tasks = set()
    fs._vlm_resolver = None
    fs._vector_config_resolver = None
    return fs


@pytest.mark.parametrize("tracked", [True, False])
async def test_close_cancels_and_joins_both_snapshot_scheduling_paths(monkeypatch, tracked):
    fs = make_fs()
    started = asyncio.Event()
    cleaned = asyncio.Event()

    async def worker(*_args):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            cleaned.set()

    tasks = {("reindex_file", "viking://resources/example.md", ContextLevel.DETAIL)}
    monkeypatch.setattr(fs, "_collect_restore_vector_tasks", lambda *_args: tasks)
    monkeypatch.setattr(fs, "_run_restore_rebuild_tracked", worker)
    monkeypatch.setattr(fs, "_run_vector_rebuild", worker)
    monkeypatch.setattr(
        "openviking.service.reindex_executor.ReindexExecutor", lambda **_kwargs: object()
    )
    monkeypatch.setattr(
        "openviking.service.task_tracker.get_task_tracker",
        lambda: SimpleNamespace(
            create=AsyncMock(return_value=SimpleNamespace(task_id="restore-task")),
            update_stage=AsyncMock(),
        ),
    )
    ctx = RequestContext(user=UserIdentifier.the_default_user(), role=Role.ROOT)
    if tracked:
        await fs._schedule_restore_reindex_for_paths(
            written_paths=["/example.md"], deleted_paths=[], project_dir=None, real_ctx=ctx
        )
    else:
        fs._schedule_vector_rebuild(written=["/example.md"], deleted=[], ctx=ctx)

    await asyncio.wait_for(started.wait(), 1)
    assert len(fs._background_tasks) == 1
    task = next(iter(fs._background_tasks))
    await asyncio.wait_for(fs.close_background_tasks(), 1)
    assert task.cancelled()
    assert cleaned.is_set()
    assert not fs._background_tasks
    await fs.close_background_tasks()


async def test_cancelled_close_still_waits_for_snapshot_cleanup():
    fs = make_fs()
    started = asyncio.Event()
    cleanup_started = asyncio.Event()
    cleanup_release = asyncio.Event()
    cleaned = asyncio.Event()

    async def worker():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup_started.set()
            await cleanup_release.wait()
            cleaned.set()

    task = asyncio.create_task(worker())
    fs._background_tasks.add(task)
    await asyncio.wait_for(started.wait(), 1)
    closing = asyncio.create_task(fs.close_background_tasks())
    await asyncio.wait_for(cleanup_started.wait(), 1)
    closing.cancel()
    await asyncio.sleep(0)
    assert not closing.done()
    cleanup_release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(closing, 1)
    assert cleaned.is_set()
    assert task.done()
    assert not fs._background_tasks
