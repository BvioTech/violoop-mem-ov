import asyncio
import contextvars
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

NATIVE = Path(os.environ.get('VIOLOOP_NATIVE_SOURCE', Path(__file__).resolve().parents[2] / 'engine'))
spec = importlib.util.spec_from_file_location('migration_timing_test_target', NATIVE / 'openviking/utils/migration_timing.py')
mt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mt)
collector = contextvars.ContextVar('test_collector', default=types.SimpleNamespace(telemetry_id='none'))
fake_telemetry = types.ModuleType('openviking.telemetry')
fake_telemetry.get_current_telemetry = collector.get


class TimingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        mt._by_run.clear()

    async def test_reused_batch_worker_and_queue_tag_use_new_producer(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'VIOLOOP_MIGRATION_TIMING_DIR': directory}), patch.dict(sys.modules, {'openviking.telemetry': fake_telemetry}):
            saved = []
            @mt.timed_requests
            async def flush(_receiver, group, requests, reason):
                self.assertEqual(mt.headers()['x-violoop-timing-task'], 'second')
                return mt.trace_tag()
            @mt.migration_process
            async def process(_receiver, msg, ctx):
                if msg.task_id == 'first':
                    saved.append(contextvars.copy_context())
                else:
                    request = types.SimpleNamespace(metadata={})
                    mt.tag_request(request)
                    clone = types.SimpleNamespace(metadata=json.loads(json.dumps(request.metadata)))
                    tag = await saved[0].run(asyncio.create_task, flush(None, None, [clone], 'time'))
                    async def queue_consumer():
                        with mt.bind_tag(tag):
                            self.assertEqual(mt.headers()['x-violoop-timing-task'], 'second')
                            mt.emit('queue-verified')
                    await contextvars.Context().run(asyncio.create_task, queue_consumer())
            await process(None, types.SimpleNamespace(session_id='vm-legacy-a', task_id='first'), None)
            await process(None, types.SimpleNamespace(session_id='vm-legacy-b', task_id='second'), None)
            self.assertIn('queue-verified', (Path(directory)/'second-native.jsonl').read_text())
            self.assertNotIn('queue-verified', (Path(directory)/'first-native.jsonl').read_text())
            self.assertTrue(all(t['closed'] for t in mt._by_run.values()))
            # A delayed embedding retains only an explicit serialized queue tag.
            last = next(t for t in mt._by_run.values() if t['taskId'] == 'second')
            with mt.bind_tag({'runId': last['runId']}):
                self.assertEqual(mt.headers()['x-violoop-timing-task'], 'second')
            self.assertEqual(mt.headers(), {})

    async def test_queue_attribution_and_no_content(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'VIOLOOP_MIGRATION_TIMING_DIR': directory}), patch.dict(sys.modules, {'openviking.telemetry': fake_telemetry}):
            @mt.migration_process
            async def process(_receiver, msg, ctx):
                mt.link_telemetry('collector-a')
                # A real persistent queue consumer has a fresh context.
                async def consumer():
                    token = collector.set(types.SimpleNamespace(telemetry_id='collector-a'))
                    try:
                        with mt.stage('index.embedding_memory'):
                            self.assertEqual(mt.headers()['x-violoop-timing-task'], 'task-a')
                            mt.emit('index.queue', queueWaitMs=12)
                    finally:
                        collector.reset(token)
                await contextvars.Context().run(asyncio.create_task, consumer())
                with mt.stage('extraction.llm'):
                    self.assertEqual(mt.headers()['x-violoop-timing-purpose'], 'extraction.llm')
                return 'unchanged-result'

            msg = types.SimpleNamespace(session_id='vm-legacy-test', task_id='task-a')
            self.assertEqual(await process(None, msg, None), 'unchanged-result')
            self.assertEqual(mt.headers(), {})
            self.assertEqual(mt._by_telemetry, {})
            events = [json.loads(line) for line in (Path(directory)/'task-a-native.jsonl').read_text().splitlines()]
            self.assertTrue(all(e['taskId'] == 'task-a' for e in events))
            self.assertEqual(len({e['runId'] for e in events}), 1)
            self.assertEqual(len([e for e in events if e['event'] == 'stage.start']), 3)
            self.assertEqual(len([e for e in events if e['event'] == 'stage.end']), 3)

    async def test_normal_session_noop_and_failure_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'VIOLOOP_MIGRATION_TIMING_DIR': directory}):
            @mt.migration_process
            async def process(_receiver, msg, ctx):
                with mt.stage('example'):
                    raise ValueError('PRIVATE_EXCEPTION_CONTENT')
            for session, task in [('normal', 'normal-task'), ('vm-legacy-test', 'failed-task')]:
                with self.assertRaises(ValueError):
                    await process(None, types.SimpleNamespace(session_id=session, task_id=task), None)
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['failed-task-native.jsonl'])
            raw = (Path(directory)/'failed-task-native.jsonl').read_text()
            self.assertNotIn('PRIVATE_EXCEPTION_CONTENT', raw)
            self.assertIn('ValueError', raw)
            self.assertIsNone(mt.current_trace())

    async def test_write_error_does_not_fail_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory)/'file'; bad.write_text('not a directory')
            with patch.dict(os.environ, {'VIOLOOP_MIGRATION_TIMING_DIR': str(bad)}):
                @mt.migration_process
                async def process(_receiver, msg, ctx):
                    return 123
                self.assertEqual(await process(None, types.SimpleNamespace(session_id='vm-legacy-test', task_id='task-ok'), None), 123)


if __name__ == '__main__':
    unittest.main()
