"""Run with stdlib unittest; exercise production routing without native DB dependencies."""
import ast
import asyncio
import contextvars
from dataclasses import dataclass
from enum import IntEnum
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('migration_embedding_flags', ROOT / 'openviking/utils/legacy_migration.py')
FLAGS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FLAGS)


def load_node(file, name, namespace):
    tree = ast.parse((ROOT / file).read_text())
    node = next(n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name)
    if not isinstance(node, ast.ClassDef):
        node.decorator_list = []
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), node], type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(ROOT / file), 'exec'), namespace)
    return namespace[name]


class Level(IntEnum):
    ABSTRACT = 0
    OVERVIEW = 1
    DETAIL = 2


class RoutingTest(unittest.TestCase):
    def test_embedding_header_is_model_scoped_and_independent_of_timing(self):
        build = load_node('openviking/models/embedder/openai_embedders.py', '_build_kwargs', {
            'mt': SimpleNamespace(headers=lambda: {}), 'embedding_headers': FLAGS.embedding_headers,
        })
        model = SimpleNamespace(model_name='bge-m3', dimension=None, encoding_format='float',
                                _build_extra_body=lambda **kw: None)
        self.assertNotIn('extra_headers', build(model, 'query'))
        with FLAGS.bind_legacy_migration(True):
            self.assertEqual(build(model, 'query')['extra_headers'], {'x-violoop-legacy-migration': '1'})
            model.model_name = 'another-model'
            self.assertNotIn('extra_headers', build(model, 'query'))
        self.assertEqual(FLAGS.embedding_headers(), {})

    def test_memory_and_directory_queue_tags_survive_serialization_and_fresh_context(self):
        converter = load_node('openviking/storage/queuefs/embedding_msg_converter.py', 'from_context', {
            'tag_legacy_migration': FLAGS.tag_legacy_migration,
            'mt': SimpleNamespace(trace_tag=lambda: None),
            'ContextLevel': Level, 'IndexAction': SimpleNamespace(MERGE='merge'),
            'EmbeddingMsg': SimpleNamespace(for_embed=lambda **kw: SimpleNamespace(**kw)),
            'get_current_telemetry': lambda: SimpleNamespace(telemetry_id='none'),
        })
        for level in [Level.ABSTRACT, Level.OVERVIEW, Level.DETAIL]:
            context = SimpleNamespace(get_vectorization_text=lambda: 'complete text',
                                      get_vectorization_images=lambda: [],
                                      to_dict=lambda: {'account_id': 'test', 'level': int(level)},
                                      level=level, meta={})
            with FLAGS.bind_legacy_migration(True):
                msg = converter(context)
            self.assertEqual(msg.message, 'complete text')
            payload = json.loads(json.dumps(msg.context_data))
            def consume():
                self.assertEqual(FLAGS.embedding_headers(), {})
                with FLAGS.bind_legacy_migration(payload.get(FLAGS.LEGACY_MIGRATION_KEY)):
                    self.assertIn('x-violoop-legacy-migration', FLAGS.embedding_headers())
                self.assertEqual(FLAGS.embedding_headers(), {})
            contextvars.Context().run(consume)
            ordinary = converter(context)
            self.assertNotIn(FLAGS.LEGACY_MIGRATION_KEY, ordinary.context_data)

    def test_queue_consumer_filters_tags_without_mutating_retry_message(self):
        # Execute the actual dequeue metadata extraction statements. No native DB is involved.
        tree = ast.parse((ROOT / 'openviking/storage/collection_schemas.py').read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == 'on_dequeue')
        names = {'inserted_data', 'timing_tag', 'is_migration'}
        assignments = [n for n in ast.walk(method) if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id in names for t in n.targets)]
        start = next(n.lineno for n in assignments
                     if any(isinstance(t, ast.Name) and t.id == 'inserted_data' for t in n.targets))
        selected = {}
        for node in sorted(assignments, key=lambda n: n.lineno):
            if node.lineno >= start:
                selected.setdefault(node.targets[0].id, node)
        assignments = list(selected.values())
        namespace = {'LEGACY_MIGRATION_KEY': FLAGS.LEGACY_MIGRATION_KEY,
                     'embedding_msg': SimpleNamespace(context_data={FLAGS.LEGACY_MIGRATION_KEY: True,
                         '_violoop_timing': {'runId': 'previous-process'}, 'account_id': 'test'})}
        module = ast.Module(body=sorted(assignments, key=lambda n: n.lineno), type_ignores=[])
        ast.fix_missing_locations(module)
        exec(compile(module, 'dequeue_metadata', 'exec'), namespace)
        self.assertTrue(namespace['is_migration'])
        self.assertNotIn(FLAGS.LEGACY_MIGRATION_KEY, namespace['inserted_data'])
        self.assertNotIn('_violoop_timing', namespace['inserted_data'])
        self.assertTrue(namespace['embedding_msg'].context_data[FLAGS.LEGACY_MIGRATION_KEY])
        self.assertIn('_violoop_timing', namespace['embedding_msg'].context_data)

    def test_migration_and_ordinary_writes_use_different_merge_groups(self):
        namespace = {'dataclass': dataclass, 'LEGACY_MIGRATION_KEY': FLAGS.LEGACY_MIGRATION_KEY,
                     'ResolvedOperations': lambda **kw: SimpleNamespace(**kw),
                     '_peer_id_for_operation': lambda op: None,
                     '_peer_id_for_memory_file': lambda file: None,
                     'clone_operation_for_uri': lambda op, uri: SimpleNamespace(memory_type=op.memory_type, uris=[uri]),
                     'clone_memory_update_request': lambda req, **kw: SimpleNamespace(**{**vars(req), **kw})}
        file = 'openviking/session/memory/streaming_memory_updater.py'
        group_type = load_node(file, 'MemoryMergeGroupKey', namespace)
        split = load_node(file, 'split_request_by_merge_group', namespace)
        for uris in [['viking://same-target'], []]:
            operation = SimpleNamespace(memory_type='entities', uris=uris)
            request = SimpleNamespace(metadata={}, operations=SimpleNamespace(
                upsert_operations=[operation], delete_file_contents=[], errors=[]))
            ordinary_key = split(request)[0][0]
            with FLAGS.bind_legacy_migration(True):
                FLAGS.tag_legacy_migration(request.metadata)
            migration_key = split(request)[0][0]
            self.assertNotEqual(ordinary_key, migration_key)
            self.assertFalse(ordinary_key.legacy_migration)
            self.assertTrue(migration_key.legacy_migration)
        self.assertEqual(group_type(None, 'entities'), group_type(None, 'entities', False))

    def test_split_routing_batches_preserve_existing_merge_serialization(self):
        create = load_node('openviking/session/memory/streaming_memory_updater.py', '_create_group_batcher', {
            'asyncio': asyncio, 'StreamingBatcher': lambda **kw: SimpleNamespace(**kw),
            'StreamingBatcherConfig': lambda **kw: SimpleNamespace(**kw),
        })
        async def run():
            active = 0
            peak = 0
            async def process(*args):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0)
                active -= 1
            owner = SimpleNamespace(_group_processing_locks={}, _process_batch=process,
                                    config=SimpleNamespace(max_operations_per_update=8,
                                        max_wait_seconds=10, timer_check_interval_seconds=1))
            ordinary = create(owner, SimpleNamespace(peer_id=None, memory_type='entities', legacy_migration=False))
            migration = create(owner, SimpleNamespace(peer_id=None, memory_type='entities', legacy_migration=True))
            await asyncio.gather(ordinary.process_batch([], 'test'), migration.process_batch([], 'test'))
            self.assertEqual(peak, 1)
            other_type = create(owner, SimpleNamespace(peer_id=None, memory_type='preferences', legacy_migration=False))
            peak = 0
            await asyncio.gather(ordinary.process_batch([], 'test'), other_type.process_batch([], 'test'))
            self.assertEqual(peak, 2)
        asyncio.run(run())

    def test_reused_batch_context_cannot_leak_migration_route(self):
        @FLAGS.migration_batch
        async def process(_receiver, group, requests, reason):
            await asyncio.sleep(0)
            return FLAGS.embedding_headers()
        async def run():
            with FLAGS.bind_legacy_migration(True):
                ordinary = await process(None, SimpleNamespace(legacy_migration=False), [], 'timer')
                self.assertEqual(ordinary, {})
            migration = await process(None, SimpleNamespace(legacy_migration=True), [], 'timer')
            self.assertIn('x-violoop-legacy-migration', migration)
            self.assertEqual(FLAGS.embedding_headers(), {})
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
