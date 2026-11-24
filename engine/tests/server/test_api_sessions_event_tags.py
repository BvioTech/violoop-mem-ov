# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx

from openviking.session.memory.dataclass import ResolvedOperation, ResolvedOperations
from tests.server.test_api_sessions import _wait_for_task


def _event_tags(response: httpx.Response) -> list[str]:
    return response.json()["result"]["memory_extraction_config"]["events"]["tags"]


async def test_session_config_updates_event_tags_and_auto_commit_policy(
    client: httpx.AsyncClient,
):
    created = await client.post(
        "/api/v1/sessions",
        json={
            "memory_extraction_config": {
                "events": {"tags": [" Team=Search ", "team=search", "channel=web"]}
            },
            "auto_commit_policy": {
                "pending_token_threshold": 8000,
                "message_count_threshold": 40,
            },
        },
    )
    assert created.status_code == 200
    assert _event_tags(created) == ["team=search", "channel=web"]
    session_id = created.json()["result"]["session_id"]

    fetched = await client.get(f"/api/v1/sessions/{session_id}")
    assert _event_tags(fetched) == ["team=search", "channel=web"]
    assert "event_search_tags" not in fetched.json()["result"]

    updated = await client.patch(
        f"/api/v1/sessions/{session_id}/config",
        json={
            "memory_extraction_config": {"events": {"tags": ["channel=app"]}},
            "auto_commit_policy": {"message_count_threshold": 25},
        },
    )
    result = updated.json()["result"]
    assert updated.status_code == 200
    assert _event_tags(updated) == ["channel=app"]
    assert result["auto_commit_policy"]["pending_token_threshold"] == 8000
    assert result["auto_commit_policy"]["message_count_threshold"] == 25

    cleared = await client.patch(
        f"/api/v1/sessions/{session_id}/config",
        json={"memory_extraction_config": {"events": {"tags": []}}},
    )
    assert _event_tags(cleared) == []
    assert cleared.json()["result"]["auto_commit_policy"]["message_count_threshold"] == 25

    disabled = await client.patch(
        f"/api/v1/sessions/{session_id}/config",
        json={"auto_commit_policy": None},
    )
    assert disabled.status_code == 200
    assert disabled.json()["result"]["auto_commit_policy"] is None


async def test_session_event_tags_discard_invalid_values(client: httpx.AsyncClient):
    response = await client.post(
        "/api/v1/sessions",
        json={
            "memory_extraction_config": {
                "events": {"tags": ["missing-equals", "channel=web"]}
            }
        },
    )

    assert response.status_code == 200
    assert _event_tags(response) == ["channel=web"]


async def test_create_session_duplicate_event_tag_keys_keep_last_value(
    client: httpx.AsyncClient,
):
    response = await client.post(
        "/api/v1/sessions",
        json={
            "memory_extraction_config": {
                "events": {"tags": ["channel=web", "channel=app"]}
            }
        },
    )

    assert response.status_code == 200
    assert _event_tags(response) == ["channel=app"]


async def test_patch_session_config_duplicate_event_tag_keys_keep_last_value(
    client: httpx.AsyncClient,
):
    created = await client.post("/api/v1/sessions", json={})
    session_id = created.json()["result"]["session_id"]

    response = await client.patch(
        f"/api/v1/sessions/{session_id}/config",
        json={
            "memory_extraction_config": {
                "events": {"tags": ["channel=web", "channel=app"]}
            }
        },
    )

    assert response.status_code == 200
    assert _event_tags(response) == ["channel=app"]


async def test_commit_duplicate_event_tag_keys_keep_last_value(client: httpx.AsyncClient):
    created = await client.post("/api/v1/sessions", json={})
    session_id = created.json()["result"]["session_id"]
    await client.post(
        f"/api/v1/sessions/{session_id}/messages",
        json={"role": "user", "content": "I want a refund"},
    )

    response = await client.post(
        f"/api/v1/sessions/{session_id}/commit",
        json={
            "extraction_metadata": {
                "event": {"tags": ["channel=web", "channel=app"]}
            }
        },
    )

    assert response.status_code == 200


async def test_commit_indexes_app_tags_on_an_entity(client, service, monkeypatch):
    def orchestrator(**kwargs):
        user = kwargs["ctx"].user.user_space_name()
        operation = ResolvedOperation(
            memory_type="entities",
            uris=[f"viking://user/{user}/memories/entities/products/example.md"],
            memory_fields={
                "category": "products",
                "name": "example",
                "content": "Example is a document editor.",
            },
        )
        return SimpleNamespace(run=AsyncMock(return_value=(
            ResolvedOperations(upsert_operations=[operation], delete_file_contents=[], errors=[]),
            [],
        )))

    monkeypatch.setattr(service.sessions._session_compressor, "_get_or_create_react", orchestrator)
    created = await client.post("/api/v1/sessions", json={"memory_policy": {"memory_types": ["entities"]}})
    assert created.status_code == 200, created.text
    session = created.json()["result"]["session_id"]
    await client.post(
        f"/api/v1/sessions/{session}/messages",
        json={"role": "user", "content": "Example is a document editor."},
    )
    tags = ["source_app=macos:com.example.editor", "source_app_name=Example Editor"]
    response = await client.post(
        f"/api/v1/sessions/{session}/commit",
        json={"extraction_metadata": {"tags": tags}},
    )
    assert response.status_code == 200, response.text
    task = await _wait_for_task(client, response.json()["result"]["task_id"], timeout=20)
    assert task["status"] == "completed", task
    found = await client.post(
        "/api/v1/search/find",
        json={"target_uri": "viking://~/memories", "level": 2, "tags": [tags[0]]},
    )
    assert found.status_code == 200, found.text
    memories = found.json()["result"]["memories"]
    assert len(memories) == 1
    assert set(memories[0]["tags"]) == {"memory_type=entities", tags[0], tags[1].lower()}
