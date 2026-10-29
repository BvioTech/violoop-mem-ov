"""Migration events contain readable source sections; ordinary events are unchanged."""
from types import SimpleNamespace

import pytest
from openviking.message import Message, TextPart
from openviking.session.memory.dataclass import MemoryFile, MemoryOperationSource, ResolvedOperation, ResolvedOperations
from openviking.session.memory.memory_updater import ExtractContext
from openviking.session.memory.streaming_memory_updater import MemoryUpdateRequest, attach_source_to_request_operations
from openviking.session.memory.utils.memory_file_utils import MemoryFileUtils

ARCHIVE = "viking://user/test/sessions/vm-legacy-abc/history/archive_001"
URI = "viking://user/test/memories/events/2026/09/10/test.md"


def request_for(messages, ranges="0", kind="events"):
    op = ResolvedOperation(memory_type=kind, uris=[URI], memory_fields={"summary": "保留原来的摘要。", "ranges": ranges})
    request = SimpleNamespace(messages=messages, operations=ResolvedOperations(upsert_operations=[op], delete_file_contents=[], errors=[]),
                              metadata={"source_extraction_id": "extract1", "archive_uri": ARCHIVE, "session_id": "vm-legacy-abc"})
    return request, op


def message(mid="message1", migration=True, body='旧材料\n{"entry":{"title":"旧记忆","content":"原文"}}'):
    return Message(id=mid, role="user", parts=[TextPart(body)], source_message_ids=["violoop-legacy-migration:abc"] if migration else None)


def test_reference_uses_original_archive_message_id_even_for_partial_json_chunks():
    original = message(body="旧材料\n" + "句子。" * 12000)
    context = ExtractContext([original])
    assert len(context.messages) > 1
    req, op = request_for([original], "1-2")
    attach_source_to_request_operations(req)
    assert op.memory_fields["migration_source"] == {"version": 1, "archive_uri": ARCHIVE, "message_ids": [original.id]}
    assert original.parts[0].text == "旧材料\n" + "句子。" * 12000


@pytest.mark.parametrize("kind,migration,ranges", [("entities",True,"0"), ("events",False,"0"), ("events",True,""), ("events",True,"nonsense")])
def test_only_verified_migration_events_with_sources_are_marked(kind, migration, ranges):
    req, op = request_for([message(migration=migration)], ranges, kind)
    attach_source_to_request_operations(req)
    assert "migration_source" not in op.memory_fields


def test_mixed_inputs_are_not_misclassified_and_noncontiguous_ranges_do_not_add_other_records():
    req, op = request_for([message(), message("ordinary", False)])
    attach_source_to_request_operations(req)
    assert "migration_source" not in op.memory_fields
    req, op = request_for([message("a"), message("b"), message("c")], "0,2")
    attach_source_to_request_operations(req)
    assert op.memory_fields["migration_source"]["message_ids"] == ["a", "c"]


def test_migration_preserves_summary_formats_sources_and_manual_edits_survive():
    m = message()
    req, op = request_for([m])
    attach_source_to_request_operations(req)
    template = "# Summary\n{{ summary }}\n# ChatLog:\n{{ extract_context.get_event_content(ranges, summary, 0) }}"
    mf = MemoryFile.from_parsed(uri=URI, parsed={**op.memory_fields, "memory_type": "events"})
    raw = MemoryFileUtils.write(mf, content_template=template, extract_context=ExtractContext([m]))
    body = raw.split("<!-- MEMORY_FIELDS")[0].rstrip()
    assert body == "# Summary\n保留原来的摘要。\n\n# 迁移来源\n## 旧记忆：旧记忆\n\n原文"
    assert "ChatLog" not in body and "旧材料" not in body and '{"entry"' not in body
    restored = MemoryFileUtils.read(raw, uri=URI)
    assert restored.extra_fields["migration_source"]["message_ids"] == ["message1"]
    restored.content = "手动修改的正文"
    assert MemoryFileUtils.write(restored).startswith("手动修改的正文")
    # Same content template and same source body still render ChatLog for ordinary events.
    mf.extra_fields.pop("migration_source")
    ordinary = MemoryFileUtils.write(mf, content_template=template, extract_context=ExtractContext([m]))
    assert "# ChatLog:" in ordinary and "原文" in ordinary


@pytest.mark.asyncio
async def test_actual_streaming_write_keeps_summary_and_archive_reference(monkeypatch):
    from tests.session.memory.test_streaming_memory_updater import InMemoryVikingFS, _ctx
    from openviking.session.memory.dataclass import MemoryField, MemoryTypeSchema
    from openviking.session.memory.memory_type_registry import MemoryTypeRegistry
    from openviking.session.memory.merge_op.base import FieldType, MergeOp
    from openviking.session.memory.streaming_memory_updater import StreamingMemoryUpdater

    fs = InMemoryVikingFS({})
    monkeypatch.setattr("openviking.session.memory.streaming_memory_updater.get_viking_fs", lambda: fs)
    monkeypatch.setattr("openviking.session.memory.memory_updater.get_viking_fs", lambda: fs)
    registry = MemoryTypeRegistry(load_schemas=False)
    registry.register(MemoryTypeSchema(memory_type="events", description="event", directory="viking://user/{{ user_space }}/memories/events", filename_template="{{ event_name }}.md", operation_mode="add_only", peer_enabled=False,
        fields=[MemoryField(name=name, field_type=FieldType.STRING, merge_op=MergeOp.IMMUTABLE) for name in ["event_name", "summary", "ranges"]],
        content_template="# Summary\n{{ summary }}\n# ChatLog:\n{{ extract_context.get_event_content(ranges, summary, 0) }}"))
    updater = StreamingMemoryUpdater(registry=registry)
    req, op = request_for([message()])
    op.uris = ["viking://user/u/memories/events/test.md"]
    op.memory_fields["event_name"] = "test"
    result = await updater.submit(MemoryUpdateRequest(operations=req.operations, messages=req.messages, ctx=_ctx(), metadata=req.metadata))
    await updater.close()
    assert result.apply_result.written_uris == op.uris
    stored = fs.files[op.uris[0]]
    assert "ChatLog" not in stored and "# 迁移来源" in stored and "原文" in stored
    saved = MemoryFileUtils.read(stored, uri=op.uris[0])
    assert saved.extra_fields["migration_source"]["archive_uri"] == ARCHIVE
    assert saved.extra_fields["summary"] == "保留原来的摘要。"


def test_full_json_is_parsed_before_chunk_formatting_and_only_referenced_records_are_used():
    import json
    from openviking.session.memory.utils.migration_sources import render_migration_sources
    payload = {"entry": {"id": "secret-entry-id", "key": "secret-key", "title": "核价记录", "content": "完整原文。" * 5000},
               "entities": [{"id": "secret-entity-id", "name": "徐文彬", "observations": ["需查实时页面"], "properties": {"id": "secret-prop-id", "empty": {}, "职业": "工程师"}}],
               "relations": [{"id": "secret-link-id", "source": {"name": "徐文彬"}, "target": {"name": "携程"}, "relationType": "使用", "confidence": 0.8, "properties": {}}]}
    original = message(body="旧材料\n" + json.dumps(payload, ensure_ascii=False))
    req, op = request_for([original, message("unrelated", body='旧材料\n{"entry":{"title":"无关","content":"不要附上"}}')], "1")
    attach_source_to_request_operations(req)
    assert op.memory_fields["migration_source"]["message_ids"] == [original.id]
    text = render_migration_sources([original], op.memory_fields["migration_source"]["message_ids"])
    assert payload["entry"]["content"] in text
    assert "需查实时页面" in text and "职业：工程师" in text
    assert "徐文彬 → 使用 → 携程" in text and "置信度：0.8" in text
    assert "secret" not in text and "empty" not in text and "不要附上" not in text
    assert render_migration_sources([original], [original.id, original.id]) == text


def test_missing_or_unverified_sources_are_not_silently_fabricated():
    from openviking.session.memory.utils.migration_sources import render_migration_sources
    with pytest.raises(ValueError, match="missing"):
        render_migration_sources([message()], ["unknown"])
    with pytest.raises(ValueError, match="verified"):
        render_migration_sources([message(migration=False)], ["message1"])
    with pytest.raises(ValueError, match="structured"):
        render_migration_sources([message(body="plain")], ["message1"])


def test_residual_entity_and_relation_sources_are_readable_without_ids():
    import json
    from openviking.session.memory.utils.migration_sources import render_migration_sources
    entity = message(body='旧材料\n'+json.dumps({"id":"hidden", "name":"人物", "observations":["喜欢简洁"], "properties":{}}))
    relation = message("rel", body='旧材料\n'+json.dumps({"id":"hidden", "source":{"name":"甲"}, "target":{"name":"乙"}, "relationType":"参与", "properties":{"职责":"开发"}}))
    result = render_migration_sources([entity, relation], ["message1", "rel"])
    assert "实体：人物" in result and "喜欢简洁" in result
    assert "关系：甲 → 参与 → 乙" in result and "职责：开发" in result
    assert "hidden" not in result
