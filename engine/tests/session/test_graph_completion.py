"""Programmatic URI tracking; no model, prompt, or graph generation is involved."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from openviking.session.memory.memory_updater import MemoryUpdater, MemoryUpdateResult
from openviking.session.memory.dataclass import StoredLink, ResolvedOperations
from openviking.session.compressor_v3 import (
    SessionCompressorV3, _make_memory_diff, _merge_memory_diffs, _memory_diff_has_changes,
)

A = "viking://user/u/memories/entities/a.md"
B = "viking://user/u/memories/entities/b.md"


class GraphCompletionTests(unittest.IsolatedAsyncioTestCase):
    async def test_link_only_writes_report_both_successful_files(self):
        updater = MemoryUpdater()
        updater._viking_fs = SimpleNamespace()
        result = MemoryUpdateResult()
        with patch("openviking.session.memory.memory_updater.write_stored_links", new=AsyncMock(return_value=[A, B])):
            await updater._apply_links_to_existing_files(
                [StoredLink(from_uri=A, to_uri=B)], result, SimpleNamespace())
        self.assertEqual(result.link_edited_uris, [A, B])
        self.assertEqual(result.written_uris, [])
        self.assertEqual(result.edited_uris, [])

    async def test_failed_link_write_is_not_reported_as_success(self):
        updater = MemoryUpdater()
        updater._viking_fs = SimpleNamespace()
        result = MemoryUpdateResult()
        with patch("openviking.session.memory.memory_updater.write_stored_links", new=AsyncMock(return_value=[A])):
            await updater._apply_links_to_existing_files(
                [StoredLink(from_uri=A, to_uri=B)], result, SimpleNamespace())
        self.assertEqual(result.link_edited_uris, [A])

    async def test_link_only_diff_has_uri_list_without_invented_content_edits(self):
        result = MemoryUpdateResult()
        result.link_edited_uris = [A, B, A]
        diff = await SessionCompressorV3._build_memory_diff(
            None, result, ResolvedOperations(upsert_operations=[], delete_file_contents=[], errors=[]),
            SimpleNamespace(), SimpleNamespace(), "viking://user/u/sessions/s/archive_1")
        self.assertEqual(diff["changed_uris"], [A, B])
        self.assertEqual(diff["operations"], {"adds": [], "updates": [], "deletes": []})
        self.assertTrue(_memory_diff_has_changes(diff))
        merged = _merge_memory_diffs([diff, diff], archive_uri=diff["archive_uri"])
        self.assertEqual(merged["changed_uris"], [A, B])
        self.assertEqual(merged["summary"]["total_updates"], 0)

    async def test_normal_operations_and_link_changes_merge(self):
        base = _make_memory_diff(archive_uri="archive", adds=[{"uri": A}], updates=[], deletes=[])
        links = _make_memory_diff(archive_uri="archive", adds=[], updates=[], deletes=[], changed_uris=[B])
        merged = _merge_memory_diffs([base, links], archive_uri="archive")
        self.assertEqual(set(merged["changed_uris"]), {A, B})

if __name__ == "__main__":
    unittest.main()
