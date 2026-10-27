"""Dependency-light tests of task-local migration routing.

Run directly with Python as well as under pytest. Compile the real parameter
builder method in isolation so this test needs no native vector DB or SDK.
"""
import ast
import asyncio
import importlib.util
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("openviking.utils.legacy_migration", ROOT / "openviking/utils/legacy_migration.py")
FLAGS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FLAGS)


def parameter_builder():
    source = ROOT / "openviking/models/vlm/backends/openai_vlm.py"
    tree = ast.parse(source.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and any(isinstance(m, ast.FunctionDef) and m.name == "_apply_completion_params" for m in n.body))
    method = next(m for m in cls.body if isinstance(m, ast.FunctionDef) and m.name == "_apply_completion_params")
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), method], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {
        "_OPENAI_REASONING_MODEL_PATTERN": re.compile("^o[1-9]"),
        # Timing is tested separately; this harness isolates model routing.
        "mt": SimpleNamespace(headers=lambda: {}),
    }
    exec(compile(module, str(source), "exec"), namespace)
    return namespace["_apply_completion_params"]


class TestLegacyMigrationRouting(unittest.TestCase):
    def test_only_bridge_requests_in_migration_scope_are_tagged(self):
        previous = sys.modules.get(SPEC.name)
        sys.modules[SPEC.name] = FLAGS
        try:
            build = parameter_builder()
            model = SimpleNamespace(temperature=0, max_tokens=4096, reasoning_effort=None,
                                    extra_request_body={}, _supports_enable_thinking=lambda: False)
            ordinary = {"model": "violoop-memory"}
            build(model, ordinary, False)
            self.assertNotIn("extra_body", ordinary)
            token = FLAGS.legacy_migration_active.set(True)
            try:
                migration = {"model": "violoop-memory"}
                build(model, migration, False)
                self.assertTrue(migration["extra_body"]["violoop_legacy_migration"])
                vendor = {"model": "other-vendor-model"}
                build(model, vendor, False)
                self.assertNotIn("extra_body", vendor)
            finally:
                FLAGS.legacy_migration_active.reset(token)
            after = {"model": "violoop-memory"}
            build(model, after, False)
            self.assertNotIn("extra_body", after)
        finally:
            if previous is None:
                del sys.modules[SPEC.name]
            else:
                sys.modules[SPEC.name] = previous

    def test_concurrent_tasks_do_not_leak_migration_flag(self):
        async def run():
            async def migration():
                token = FLAGS.legacy_migration_active.set(True)
                try:
                    await asyncio.sleep(0)
                    self.assertTrue(FLAGS.legacy_migration_active.get())
                finally:
                    FLAGS.legacy_migration_active.reset(token)
            async def ordinary():
                await asyncio.sleep(0)
                self.assertFalse(FLAGS.legacy_migration_active.get())
            await asyncio.gather(migration(), ordinary())
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
