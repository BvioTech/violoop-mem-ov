# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0

"""Tests for session commit race condition fix (#580)."""

import asyncio

from openviking.message import TextPart


class TestCommitRace:
    """Test concurrent commit safety."""

    async def test_concurrent_commit_no_duplicate(
        self, client, commit_models, wait_for_completed_commit
    ):
        """Two concurrent commits on the same session: only one should archive."""
        session = client(session_id="race_test_dedup")
        await session.ensure_exists()
        session.add_message("user", [TextPart("Hello")])
        session.add_message("assistant", [TextPart("Hi there")])

        results = await asyncio.gather(
            session.commit_async(),
            session.commit_async(),
        )

        archived_count = sum(1 for r in results if r.get("archived") is True)
        assert archived_count == 1, f"Expected exactly 1 archived commit, got {archived_count}"

        # Messages should be cleared after commit
        assert len(session.messages) == 0

        # Compression index should have incremented exactly once
        assert session._compression.compression_index == 1
        await wait_for_completed_commit(
            next(result for result in results if result.get("archived"))
        )

    async def test_message_added_during_commit_not_lost(
        self,
        client,
        monkeypatch,
        commit_models,
        wait_for_completed_commit,
    ):
        """Messages added while commit is running should not be lost."""
        session = client(session_id="race_test_msg_safety")
        await session.ensure_exists()
        session.add_message("user", [TextPart("Original message")])

        # Use an Event for deterministic synchronization instead of sleeps
        phase1_done = asyncio.Event()
        message_added = asyncio.Event()
        original_release = session._viking_fs._async_agfs.pathlock_release

        async def release_phase1_lock(lease):
            await original_release(lease)
            if not phase1_done.is_set():
                # Signal only after physical release, so the synchronous append
                # can acquire the same path without blocking its event loop.
                phase1_done.set()
                await message_added.wait()

        monkeypatch.setattr(session._viking_fs._async_agfs, "pathlock_release", release_phase1_lock)

        async def commit_and_add():
            """Start commit, then add a message after Phase 1 completes."""
            commit_task = asyncio.create_task(session.commit_async())
            # Wait until Phase 1 is done (lock released, messages cleared)
            await asyncio.wait_for(phase1_done.wait(), timeout=5)
            # Add message while commit is in Phase 2 (after lock released)
            try:
                session.add_message("user", [TextPart("New message during commit")])
            finally:
                message_added.set()
            return await commit_task

        result = await commit_and_add()

        assert result.get("archived") is True
        # The new message should still be in the session
        assert len(session.messages) == 1
        assert session.messages[0].content == "New message during commit"
        await wait_for_completed_commit(result)
