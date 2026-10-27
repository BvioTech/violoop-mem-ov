# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0

"""Request lifetime for tests calling MCP tools without the ASGI middleware."""

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import patch

from openviking.telemetry import OperationTelemetry, bind_telemetry, unregister_telemetry
from openviking.telemetry.request_wait_tracker import get_request_wait_tracker


@asynccontextmanager
async def mcp_request_scope(service, *, timeout=10):
    """Own a request's accounting until its indexing and task monitor finish.

    Direct tool calls bypass the HTTP request scope. Give them a fresh ID and
    register even non-waiting writes, then drain while their service is alive.
    Never reset global state: other requests may legitimately still be pending.
    """
    telemetry = OperationTelemetry(operation="test.mcp", enabled=False)
    tracker = get_request_wait_tracker()
    tracker.register_request(telemetry.telemetry_id)
    monitors = set()
    original_monitor = service.resources._monitor_queue_processing
    original_cleanup = tracker.cleanup

    def cleanup(telemetry_id):
        # Several direct calls share this test scope. A wait=True call or a
        # Skill monitor must not discard accounting for later non-waiting writes.
        if telemetry_id != telemetry.telemetry_id:
            original_cleanup(telemetry_id)

    async def monitor(*args, **kwargs):
        monitors.add(asyncio.current_task())
        return await original_monitor(*args, **kwargs)

    with (
        bind_telemetry(telemetry),
        patch.object(service.resources, "_monitor_queue_processing", monitor),
        patch.object(tracker, "cleanup", cleanup),
    ):
        try:
            yield telemetry
        finally:
            # A newly scheduled monitor must enter before we snapshot the set.
            await asyncio.sleep(0)
            await tracker.wait_for_request(telemetry.telemetry_id, timeout=timeout)
            if monitors:
                await asyncio.wait_for(asyncio.gather(*monitors), timeout=timeout)
            original_cleanup(telemetry.telemetry_id)
            unregister_telemetry(telemetry.telemetry_id)
