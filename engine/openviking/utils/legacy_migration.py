# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Task-local routing flag for the VioLoop legacy-memory bridge."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

legacy_migration_active: ContextVar[bool] = ContextVar("legacy_migration_active", default=False)
LEGACY_MIGRATION_KEY = "_violoop_legacy_migration"


def tag_legacy_migration(metadata):
    """Carry routing across buffered writes and durable embedding deliveries."""
    if legacy_migration_active.get():
        metadata[LEGACY_MIGRATION_KEY] = True
    else:
        metadata.pop(LEGACY_MIGRATION_KEY, None)


@contextmanager
def bind_legacy_migration(active):
    # Explicit false prevents a reused worker from inheriting a producer's flag.
    token = legacy_migration_active.set(active is True)
    try:
        yield
    finally:
        legacy_migration_active.reset(token)


def embedding_headers():
    return {"x-violoop-legacy-migration": "1"} if legacy_migration_active.get() else {}


def migration_batch(fn):
    """Restore the owner of a buffered merge independently of timer context."""
    @wraps(fn)
    async def wrapped(self, group_key, requests, reason):
        with bind_legacy_migration(group_key.legacy_migration):
            return await fn(self, group_key, requests, reason)
    return wrapped
