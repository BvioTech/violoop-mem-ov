# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Real native checkpoints: interrupted commits, corruption, and pruned WAL."""

import json
import os
import stat
from pathlib import Path

import pytest

from openviking.storage.vectordb.collection.local_collection import get_or_create_local_collection
from openviking.storage.vectordb.index import snapshot
from openviking.storage.vectordb.index.local_index import IndexEngineProxy, PersistentIndex

META = {
    "CollectionName": "snapshot_recovery",
    "Fields": [
        {"FieldName": "id", "FieldType": "string", "IsPrimaryKey": True},
        {"FieldName": "vector", "FieldType": "vector", "Dim": 4},
        {"FieldName": "data", "FieldType": "string"},
    ],
}
INDEX = {"IndexName": "main", "VectorIndex": {"IndexType": "flat", "Distance": "l2"}}


def row(key, text):
    return {"id": key, "vector": [0.1, 0.2, 0.3, 0.4], "data": text}


@pytest.fixture
def collection(tmp_path):
    col = get_or_create_local_collection(
        path=str(tmp_path / "db"),
        meta_data=META,
        config={"index_maintenance_seconds": 3600},
    )
    col.create_index("main", INDEX)
    yield col
    col.close()


def inner(col):
    return col._Collection__collection


def assert_records(col):
    result = col.search_by_vector("main", [0.1, 0.2, 0.3, 0.4], limit=10)
    assert {item.id: item.fields["data"] for item in result.data} == {
        "first": "updated",
        "second": "new record",
    }
    assert col.fetch_data(["deleted"]).items == []


@pytest.mark.parametrize(
    "damage", ["empty", "all_empty", "json", "vector", "checksum", "marker", "missing_marker"]
)
def test_corrupt_latest_rebuilds_all_records_after_delta_pruning(collection, tmp_path, damage):
    col = collection
    index = col.get_index("main")
    col.upsert_data([row("first", "old value"), row("deleted", "remove me")])
    index.persist()
    col.update_data([{"id": "first", "data": "updated"}])
    col.delete_data(["deleted"])
    col.upsert_data([row("second", "new record")])
    newest = index.persist()
    # This is why falling back to the older checkpoint alone is unsafe.
    inner(col)._delete_expire_delta_record()
    assert list(inner(col).store_mgr.get_delta_data_after_ts(0)) == []
    versions = Path(index.version_dir)
    col.close()
    checkpoint = versions / str(newest)
    marker = versions / f"{newest}.write_done"
    if damage in {"empty", "all_empty"}:
        for name in [
            "manager_meta.json",
            "vector_index/index_flat.data",
            "scalar_index/scalar_index.data",
        ]:
            (checkpoint / name).write_bytes(b"")
        marker.write_text("")  # Exact legacy-device failure, including its empty marker.
        if damage == "all_empty":
            for file in versions.rglob("manager_meta.json"):
                file.write_bytes(b"")
    elif damage == "json":
        (checkpoint / "manager_meta.json").write_text("{")
    elif damage == "vector":
        file = checkpoint / "vector_index/index_flat.data"
        file.write_bytes(file.read_bytes()[:8])
    elif damage == "checksum":
        file = checkpoint / "vector_index/index_flat.data"
        content = bytearray(file.read_bytes())
        content[-1] ^= 1
        file.write_bytes(content)
    elif damage == "marker":
        marker.write_text("{")
    else:
        marker.unlink()

    recovered = get_or_create_local_collection(
        path=str(tmp_path / "db"),
        config={"index_maintenance_seconds": 3600},
    )
    try:
        assert_records(recovered)
        archives = list(versions.parent.glob("snapshot-recovery-*/versions"))
        assert len(archives) == 1
        assert (archives[0] / str(newest)).is_dir()
    finally:
        recovered.close()
    # Recovery is durable too; it must not depend on the first process's RAM.
    reopened = get_or_create_local_collection(path=str(tmp_path / "db"))
    try:
        assert_records(reopened)
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "boundary", ["data_fsync", "directory_fsync", "marker_fsync", "commit_fsync"]
)
def test_failed_commit_keeps_previous_checkpoint_and_deltas(collection, monkeypatch, boundary):
    index = collection.get_index("main")
    previous = index.get_newest_version()
    collection.upsert_data([row("first", "uncheckpointed")])
    update = index.engine_proxy.get_update_ts()
    version_dir = Path(index.version_dir)
    real_fsync = os.fsync
    real_sync_dir = snapshot.sync_directory

    def fsync(fd):
        if stat.S_ISREG(os.fstat(fd).st_mode):
            # A manifest is the only .commit-* file; no need to recover fd paths.
            writing_marker = any(version_dir.glob(".commit-*"))
            if (boundary == "data_fsync" and not writing_marker) or (
                boundary == "marker_fsync" and writing_marker
            ):
                raise OSError("injected flush failure")
        return real_fsync(fd)

    def sync_dir(path):
        if path == version_dir and (version_dir / str(update)).exists():
            marker_exists = (version_dir / f"{update}.write_done").exists()
            if (boundary == "directory_fsync" and not marker_exists) or (
                boundary == "commit_fsync" and marker_exists
            ):
                raise OSError("injected flush failure")
        return real_sync_dir(path)

    with monkeypatch.context() as patch:
        patch.setattr(snapshot.os, "fsync", fsync)
        patch.setattr(snapshot, "sync_directory", sync_dir)
        with pytest.raises(OSError, match="injected flush failure"):
            index.persist()
    assert index.get_newest_version() == previous
    assert (version_dir / f"{previous}.write_done").exists()
    assert not (version_dir / f"{update}.write_done").exists()
    assert not list(version_dir.glob(".pending-*"))
    inner(collection)._delete_expire_delta_record()
    assert list(inner(collection).store_mgr.get_delta_data_after_ts(previous))
    # A failed rename/flush must not block a retry of the same update timestamp.
    assert index.persist() == update
    manifest = json.loads((version_dir / f"{update}.write_done").read_text())
    assert manifest["format"] == 1
    assert set(manifest["files"]) >= {
        "manager_meta.json",
        "vector_index/index_flat.data",
        "scalar_index/scalar_index.data",
    }


def test_valid_legacy_snapshot_still_loads_without_rebuilding(collection, tmp_path):
    collection.upsert_data([row("first", "legacy")])
    index = collection.get_index("main")
    index.persist()
    versions = Path(index.version_dir)
    collection.close()
    for marker in versions.glob("*.write_done"):
        marker.write_text("")
    recovered = get_or_create_local_collection(path=str(tmp_path / "db"))
    try:
        assert (
            recovered.search_by_vector("main", [0.1, 0.2, 0.3, 0.4]).data[0].fields["data"]
            == "legacy"
        )
        assert not list(versions.parent.glob("snapshot-recovery-*"))
    finally:
        recovered.close()


def test_corrupt_snapshot_without_record_source_fails_closed(collection):
    index = collection.get_index("main")
    version = index.get_newest_version()
    meta = index.meta
    version_dir = Path(index.version_dir)
    file = version_dir / str(version) / "manager_meta.json"
    original = file.read_bytes()
    try:
        file.write_bytes(b"")
        with pytest.raises(RuntimeError, match="authoritative record store"):
            PersistentIndex("main", meta, str(version_dir.parent.parent))
        assert (version_dir / str(version)).exists()
    finally:
        file.write_bytes(original)


def test_empty_recovered_checkpoint_with_version_zero_is_loadable(collection, tmp_path):
    collection.close()
    versions = tmp_path / "db/index/main/versions"
    for file in versions.rglob("manager_meta.json"):
        file.write_bytes(b"")
    recovered = get_or_create_local_collection(path=str(tmp_path / "db"))
    try:
        assert recovered.get_index("main").now_version == "0"
    finally:
        recovered.close()
    reopened = get_or_create_local_collection(path=str(tmp_path / "db"))
    reopened.close()


def test_rebuild_streams_records_without_materializing_the_store(collection, tmp_path, monkeypatch):
    collection.upsert_data([row(str(i), f"record {i}") for i in range(2101)])
    consumed = inserted = 0
    real_add = IndexEngineProxy.add_data

    def candidates():
        nonlocal consumed
        for candidate in inner(collection).store_mgr.iter_all_cands_data():
            assert consumed - inserted < 1000, "Recovery buffered the entire record store"
            consumed += 1
            yield candidate

    def add(self, batch):
        nonlocal inserted
        result = real_add(self, batch)
        inserted += len(batch)
        return result

    monkeypatch.setattr(IndexEngineProxy, "add_data", add)
    rebuilt = PersistentIndex(
        "main",
        collection.get_index("main").meta,
        str(tmp_path / "streamed"),
        cands_list=candidates(),
    )
    try:
        labels, scores = rebuilt.search([0.1, 0.2, 0.3, 0.4], limit=2200)
        assert consumed == inserted == len(labels) == len(scores) == 2101
        assert len(set(labels)) == 2101
    finally:
        rebuilt.close()
