# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Regression tests for reindexing single-file URIs under tree locks."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from openviking.server.identity import RequestContext, Role
from openviking.service import reindex_executor as reindex_module
from openviking.service.reindex_executor import ReindexExecutor
from openviking_cli.session.user_id import UserIdentifier


async def test_reindex_single_file_uri_acquires_tree_lock_without_not_a_directory(
    agfs_client, monkeypatch, caplog
):
    from openviking.storage.viking_fs import VikingFS

    uri = "viking://resources/profile.md"
    ctx = RequestContext(user=UserIdentifier("acc1", "test_user"), role=Role.ROOT)
    viking_fs = VikingFS(agfs=agfs_client)
    await viking_fs.write_file(uri, "# Profile\nSingle file reindex source.\n", ctx=ctx)
    manager = SimpleNamespace(
        has_queue_manager=True,
        get_incremental_inventory_under_uri=AsyncMock(return_value={}),
    )
    enqueue = AsyncMock(return_value=1)
    service = SimpleNamespace(
        viking_fs=viking_fs,
        vikingdb_manager=manager,
        _resource_processor=SimpleNamespace(_enqueue_index_actions=enqueue),
    )
    monkeypatch.setattr(reindex_module, "get_service", lambda: service)
    monkeypatch.setattr(reindex_module, "get_viking_fs", lambda: viking_fs)

    result = await ReindexExecutor()._run(
        uri=uri, object_type="resource", mode="vectors_only", ctx=ctx
    )

    assert result["status"] == "completed"
    assert result["uri"] == uri
    assert result["scanned_records"] == 1
    assert result["rebuilt_records"] == 1
    enqueue.assert_awaited_once()
    assert "Not a directory" not in caplog.text
    assert "Failed to create lock file" not in caplog.text
