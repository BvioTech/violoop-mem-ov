# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0

"""Regression for pending work leaking between direct MCP tool tests."""

from openviking.server.identity import RequestContext, Role
from openviking.service.task_tracker import get_task_tracker
from openviking.telemetry import OperationTelemetry, bind_telemetry, get_current_telemetry
from openviking.telemetry.request_wait_tracker import get_request_wait_tracker
from openviking_cli.session.user_id import UserIdentifier
from tests.server.mcp_test_helpers import mcp_request_scope


async def test_mcp_scope_drains_background_work_without_clearing_other_requests(
    service, sample_markdown_file
):
    tracker = get_request_wait_tracker()
    outer = OperationTelemetry(operation="test.unrelated", enabled=False)
    tracker.register_request(outer.telemetry_id)
    tracker.register_embedding_root(outer.telemetry_id, "unrelated-pending-root")
    ctx = RequestContext(UserIdentifier.the_default_user("test_user"), Role.ROOT)
    try:
        with bind_telemetry(outer):
            async with mcp_request_scope(service) as first:
                assert get_current_telemetry() is first
                assert first.telemetry_id != outer.telemetry_id
                # Leave this real Skill job non-waiting, just like the MCP tool.
                result = await service.resources.add_skill(
                    data="---\nname: isolation-skill\ndescription: Test isolation\n---\n# Skill\nSteps.\n",
                    ctx=ctx,
                    wait=False,
                )
                assert result["task_id"]
            assert get_current_telemetry() is outer
            assert not tracker.has_request(first.telemetry_id)
            task = await get_task_tracker().get(
                result["task_id"], account_id=ctx.account_id, user_id=ctx.user.user_id
            )
            assert task is not None
            assert task.status.value == "completed", task.error
            assert not tracker.is_complete(outer.telemetry_id)

            # The next request can finish although the unrelated one is pending.
            async with mcp_request_scope(service) as second:
                assert second.telemetry_id not in (first.telemetry_id, outer.telemetry_id)
                await service.resources.add_resource(
                    path=str(sample_markdown_file),
                    ctx=ctx,
                    wait=True,
                )
                assert tracker.has_request(second.telemetry_id)
                # Synchronous resource completion cannot drop later write work.
                await service.fs.write(
                    "viking://user/test_user/memories/preferences/after_resource.md",
                    "likes: tea\n",
                    ctx=ctx,
                )
            assert not tracker.has_request(second.telemetry_id)
            assert not tracker.is_complete(outer.telemetry_id)
    finally:
        tracker.mark_embedding_done(outer.telemetry_id, "unrelated-pending-root")
        tracker.cleanup(outer.telemetry_id)
