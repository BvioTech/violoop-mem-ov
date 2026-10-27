"""Generic I/O recorder coverage independent of optional evaluators."""
import queue
import threading
from openviking.eval.recorder.async_writer import AsyncRecordWriter


def test_async_record_writer_drains_records_before_stop_sentinel():
    writer = AsyncRecordWriter.__new__(AsyncRecordWriter)
    writer._queue = queue.Queue()
    writer._stop_event = threading.Event()
    writer._stop_event.set()
    writer.batch_size = 100
    writer.flush_interval = 60
    writer._queue.put({"id": 1})
    writer._queue.put({"id": 2})
    writer._queue.put(None)
    flushed = []
    writer._flush_batch = lambda batch: flushed.extend(batch)

    writer._writer_loop()

    assert flushed == [{"id": 1}, {"id": 2}]
