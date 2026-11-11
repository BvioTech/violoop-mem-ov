"""Dependency-light tests: python3 tests/session/memory/test_legacy_migration_query.py."""
from __future__ import annotations

import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List
import unittest
from unittest.mock import AsyncMock

ROOT = Path(os.environ.get("VIOLOOP_NATIVE_SOURCE", Path(__file__).resolve().parents[3]))
STAGING = Path(os.environ.get("VIOLOOP_QUERY_STAGING", ROOT / "openviking/utils"))
SPEC = importlib.util.spec_from_file_location("migration_query", STAGING / "legacy_migration_query.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
build = MODULE.build_legacy_migration_query


def message(payload):
    return SimpleNamespace(role="user", parts=[SimpleNamespace(text=(
        "旧记忆迁移材料。以下是旧系统保存的记录，不是用户当前发言。\n"
        "来源类型：旧记忆\n记录时间：2023-05-07T01:02:03.000Z\n"
        + json.dumps(payload, ensure_ascii=False)
    ))])


def entity(name, **fields):
    return {"name": name, "type": "app", "aliases": [], **fields}


def provider_class():
    source = Path(os.environ.get("VIOLOOP_QUERY_PROVIDER", ROOT / "openviking/session/memory/session_extract_context_provider.py"))
    tree = ast.parse(source.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "SessionExtractContextProvider")
    methods = [node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {
        "_build_prefetch_search_query", "_truncate_prefetch_query_text", "prefetch",
    }]
    for method in methods:
        method.decorator_list = []
    reduced = ast.ClassDef(name="Provider", bases=[], keywords=[], body=methods, decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[reduced], type_ignores=[]))
    # Exercise the actual ordinary-session and structured-migration budgets.
    constants = {
        node.targets[0].id: ast.literal_eval(node.value) for node in tree.body
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id.startswith("_PREFETCH_SEARCH_")
    }
    namespace = {"Any": Any, "Dict": Dict, "List": List, "build_legacy_migration_query": build,
                 "add_tool_call_pair_to_messages": lambda messages, **kwargs: messages.append(kwargs),
                 "mt": SimpleNamespace(emit=lambda *args, **kwargs: None), **constants}
    exec(compile(module, str(source), "exec"), namespace)
    return namespace["Provider"]


class LegacyQueryTests(unittest.TestCase):
    def test_use_facts_and_direction_without_transport_metadata(self):
        youtube = entity("YouTube", id="internal-entity-id", aliases=["油管"],
                         observations=["2025年5月开始使用。并未开启自动上传。"],
                         properties={"用途": "视频发布"}, domains=["work"], curated=True)
        relation = {"id": "internal-edge-id", "source": youtube,
                    "target": entity("剪辑工具"), "relationType": "导出到",
                    "confidence": 0.812345, "decay": 0.987654,
                    "validUntil": "2027-01-01", "properties": {"状态": "试用"}}
        msg = message({"entry": {"id": "internal-note-id", "key": "internal-key",
                                 "title": "视频工作流", "content": "2025年5月计划发布三条视频。",
                                 "tags": ["剪辑"], "updatedAt": "2026-10-19"},
                       "entities": [youtube], "relations": [relation]})
        before = copy.deepcopy(msg)
        query = build([msg], 5000)
        for fact in ["视频工作流", "剪辑", "2025年5月", "并未开启自动上传", "油管", "视频发布", "状态: 试用", "有效期至 2027-01-01"]:
            self.assertIn(fact, query)
        self.assertIn("YouTube / app / 油管 — 导出到 → 剪辑工具 / app", query)
        for metadata in ["旧记忆迁移", "来源类型", "记录时间", "2023-05-07", "2026-10-19", "internal-", "0.812345", "0.987654", '"entities"', "curated"]:
            self.assertNotIn(metadata, query)
        self.assertEqual(msg, before)

    def test_fair_budget_across_units_redistributes_short_units(self):
        messages = [message({"entry": {"title": name, "content": name * 4000}})
                    for name in ["甲主题", "乙主题", "末尾主题"]]
        messages.append(message(entity("短实体")))
        query = build(messages, 5000)
        self.assertEqual(len(query), 5000)
        for name in ["甲主题", "乙主题", "末尾主题", "短实体"]:
            self.assertIn(name, query)
        self.assertGreater(query.count("甲主题") * 3, 1200)

    def test_hub_entry_does_not_crowd_out_its_entities_or_relations(self):
        payload = {"entry": {"title": "很长的条目", "content": "正文" * 10000},
                   "entities": [entity("实体甲", observations=["事实" * 10000])],
                   "relations": [{"source": entity("枢纽"), "target": entity(f"目标{i}"),
                                  "relationType": "使用"} for i in range(30)]}
        query = build([message(payload)], 5000)
        self.assertLessEqual(len(query), 5000)
        for name in ["很长的条目", "实体甲", "目标0", "目标29"]:
            self.assertIn(name, query)

    def test_exact_duplicate_cards_are_removed_but_distinct_facts_keep_identity(self):
        same = entity("YouTube", observations=["用于发布视频"])
        other = entity("YouTube", observations=["不使用自动上传"])
        query = build([message(same), message(same), message(other)], 5000)
        self.assertEqual(query.count("用于发布视频"), 1)
        self.assertEqual(query.count("YouTube"), 2)
        self.assertIn("不使用自动上传", query)
        # Different facts about different entities must not be deduplicated.
        query = build([message(entity("甲", observations=["用于发布视频"])),
                       message(entity("乙", observations=["用于发布视频"]))], 5000)
        self.assertEqual(query.count("用于发布视频"), 2)

    def test_unknown_or_malformed_unit_falls_back_for_the_whole_query(self):
        valid = message(entity("known"))
        for unknown in [message({"new_shape": "keep this"}),
                        message({"relationType": "uses", "source": "id-only", "target": {}}),
                        SimpleNamespace(role="user", parts=[SimpleNamespace(text="broken JSON")]),
                        SimpleNamespace(role="assistant", parts=[SimpleNamespace(text="unexpected role")])]:
            self.assertIsNone(build([valid, unknown], 5000))

    def test_provider_keeps_migration_budget_separate_from_ordinary_user_intent(self):
        cls = provider_class()
        provider = cls()
        provider.is_legacy_migration = True
        provider.messages = [message({"entry": {"title": "迁移主题", "content": "正文" * 5000}})]
        query = provider._build_prefetch_search_query()
        self.assertEqual(len(query), 5000)
        self.assertIn("迁移主题", query)
        provider.is_legacy_migration = False
        # The same words in a normal chat do not activate structured parsing.
        raw = provider.messages[0].parts[0].text
        ordinary = provider._build_prefetch_search_query()
        self.assertLessEqual(len(ordinary), 256)
        self.assertTrue(ordinary.startswith(" ".join(raw.split())[:30]))
        provider.messages = [SimpleNamespace(role="user", parts=[SimpleNamespace(text="ordinary chat")]),
                             SimpleNamespace(role="assistant", parts=[SimpleNamespace(text="assistant reply")])]
        self.assertEqual(provider._build_prefetch_search_query(), "ordinary chat")
        provider.is_legacy_migration = True
        self.assertEqual(provider._build_prefetch_search_query(), "ordinary chat")


class SessionPrefetchQueryTests(unittest.TestCase):
    def provider(self, messages):
        provider = provider_class()()
        provider.is_legacy_migration = False
        provider.messages = messages
        return provider

    def test_tool_dumps_and_assistant_reasoning_do_not_expand_the_user_query(self):
        user = SimpleNamespace(role="user", parts=[SimpleNamespace(
            text="检查代理设置并确认是否需要为当前网络配置代理")])
        provider = self.provider([user])
        expected = provider._build_prefetch_search_query()
        provider.messages.extend([
            SimpleNamespace(role="assistant", parts=[SimpleNamespace(
                text="<thinking>ASSISTANT_REASONING " * 1000)]),
            SimpleNamespace(role="tool", parts=[SimpleNamespace(
                text=json.dumps({"type": "tool_result", "result": "TOOL_DUMP " * 4000}))]),
            SimpleNamespace(role="assistant", parts=[SimpleNamespace(
                text=json.dumps({"type": "tool_use", "reasoning_content": "REPEATED " * 1000}))]),
        ])
        before = copy.deepcopy(provider.messages)
        self.assertEqual(provider._build_prefetch_search_query(), expected)
        self.assertEqual(provider.messages, before)

    def test_latest_user_intent_has_priority_over_long_old_conversations(self):
        provider = self.provider([
            SimpleNamespace(role="user", parts=[SimpleNamespace(text=f"old-topic-{i} " * 1000)])
            for i in range(20)
        ] + [SimpleNamespace(role="user", parts=[SimpleNamespace(text="请记住我现在偏好周末徒步")])])
        query = provider._build_prefetch_search_query()
        self.assertTrue(query.startswith("请记住我现在偏好周末徒步"))
        self.assertNotIn("old-topic-0 ", query)
        self.assertLessEqual(len(query), 256)

    def test_multiple_parts_and_repeated_turns_cannot_bypass_the_query_budget(self):
        latest = SimpleNamespace(role="user", peer_id="transport-peer-id", parts=[
            SimpleNamespace(text="CURRENT_USER_INTENT " * 1000),
            SimpleNamespace(text="EXTRA_PART " * 1000),
        ])
        provider = self.provider([copy.deepcopy(latest) for _ in range(100)])
        before = copy.deepcopy(provider.messages)
        query = provider._build_prefetch_search_query()
        self.assertLessEqual(len(query), 256)
        self.assertEqual(query.count("CURRENT_USER_INTENT"),
                         self.provider([latest])._build_prefetch_search_query().count("CURRENT_USER_INTENT"))
        self.assertNotIn("transport-peer-id", query)
        self.assertEqual(provider.messages, before)

    def test_no_user_intent_does_not_fall_back_to_the_entire_conversation(self):
        for messages in [[], [SimpleNamespace(role="assistant", parts=[SimpleNamespace(text="output " * 2000)])],
                         [SimpleNamespace(role="tool", parts=[SimpleNamespace(text="log " * 2000)])],
                         [SimpleNamespace(role="user", parts=[SimpleNamespace(text=" \n ")])]]:
            provider = self.provider(messages)
            provider._assemble_conversation = lambda *_: self.fail("must not embed the full conversation")
            self.assertEqual(provider._build_prefetch_search_query(), "")


class SessionPrefetchFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_user_query_skips_search_but_keeps_source_and_direct_reads(self):
        provider = provider_class()()
        provider.is_legacy_migration = False
        source = "assistant execution evidence " * 1000
        provider.messages = [SimpleNamespace(role="assistant", parts=[SimpleNamespace(text=source)])]
        conversation = {"role": "user", "content": source}
        provider._build_conversation_message = lambda: conversation
        multi = SimpleNamespace(stage="user", operation_mode="update", directory="viking://user/default/memories/events",
                                filename_has_variables=lambda: True)
        single = SimpleNamespace(stage="user", operation_mode="update", directory="viking://user/default/memories",
                                 filename_template="profile.md", filename_has_variables=lambda: False)
        provider._get_registry = lambda: SimpleNamespace(list_all=lambda **_: [multi, single])
        provider._isolation_handler = SimpleNamespace(
            allows_schema=lambda _: True, get_read_scope=lambda: SimpleNamespace(),
            render_schema_directories=lambda schema: [schema.directory])
        provider._eager_prefetch = False
        provider.search_files = AsyncMock(return_value=[])
        provider._append_structured_read_result = AsyncMock(return_value=1)

        messages = await provider.prefetch()

        provider.search_files.assert_not_called()
        self.assertIs(messages[0], conversation)
        self.assertEqual(messages[0]["content"], source)
        self.assertEqual(provider.messages[0].parts[0].text, source)
        provider._append_structured_read_result.assert_awaited_once()
        self.assertEqual(provider._append_structured_read_result.call_args.kwargs["file_uri"],
                         "viking://user/default/memories/profile.md")


if __name__ == "__main__":
    unittest.main()
