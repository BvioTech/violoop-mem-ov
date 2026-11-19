import json
from datetime import datetime, timedelta, timezone

import pytest

from openviking.session.memory.tools import add_tool_call_pair_to_messages
from openviking.session.memory.utils.memory_file_utils import MemoryFileUtils


def test_read_memory_dates_round_trip_into_extraction_context():
    fields = {
        "created_at": "2026-11-19T09:00:00+08:00",
        "updated_at": "2026-11-19T10:00:00.123456+08:00",
        "memory_type": "profile",
    }
    raw = "用户资料\n\n<!-- MEMORY_FIELDS\n" + json.dumps(fields) + "\n-->"
    memory = MemoryFileUtils.read(raw, uri="viking://user/default/memories/profile.md")
    result = memory.to_metadata()
    assert isinstance(result["created_at"], datetime)
    messages = []
    add_tool_call_pair_to_messages(messages, 0, "read", {"uri": memory.uri}, result)
    payload = json.loads(messages[0]["content"])
    assert payload["result"]["created_at"] == fields["created_at"]
    assert payload["result"]["updated_at"] == fields["updated_at"]
    assert payload["result"]["content"] == "用户资料"
    assert isinstance(result["updated_at"], datetime)


def test_nested_dates_preserve_timezone_and_other_json_types():
    stamp = datetime(2026, 11, 19, 10, 30, tzinfo=timezone(timedelta(hours=8)))
    result = {"records": [{"at": stamp, "count": 2, "ok": True, "missing": None}]}
    messages = []
    add_tool_call_pair_to_messages(messages, 1, "read", {}, result)
    assert json.loads(messages[0]["content"])["result"] == {
        "records": [{"at": stamp.isoformat(), "count": 2, "ok": True, "missing": None}]
    }


def test_unknown_objects_still_fail_instead_of_becoming_arbitrary_strings():
    messages = []
    with pytest.raises(TypeError, match="not JSON serializable"):
        add_tool_call_pair_to_messages(messages, 2, "read", {}, {"bad": object()})
    assert messages == []
