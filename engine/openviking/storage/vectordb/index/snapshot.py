# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Publish durable native checkpoints and validate them before native loading."""

import hashlib
import json
import os
import shutil
import struct
import tempfile
from pathlib import Path

from openviking.storage.vectordb.utils.file_utils import atomic_write_bytes


class InvalidSnapshot(ValueError):
    pass


def sync_directory(path: Path) -> None:
    # Windows does not expose directory fsync through Python. File fsync still
    # applies there; Linux devices must persist directory entries as well.
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def snapshot_files(path: Path) -> dict[str, Path]:
    if path.is_symlink():
        raise InvalidSnapshot(f"Snapshot is a symbolic link: {path}")
    files = {}
    for child in path.rglob("*"):
        if child.is_symlink():
            raise InvalidSnapshot(f"Snapshot contains a symbolic link: {child}")
        if child.is_file():
            files[child.relative_to(path).as_posix()] = child
    return files


def validate_native_files(path: Path) -> None:
    """Also protect legacy empty-marker snapshots before passing bytes to C++."""
    try:
        meta = json.loads((path / "manager_meta.json").read_text())
        vector = meta["VectorIndex"]
        if not isinstance(meta["ScalarIndex"], list) or vector["IndexType"] != "flat":
            raise ValueError("Unsupported index metadata")
        if not isinstance(vector["Dimension"], int) or vector["Dimension"] <= 0:
            raise ValueError("Invalid vector dimension")
        flat = path / "vector_index/index_flat.data"
        header = struct.Struct("@NNN")
        with flat.open("rb") as stream:
            capacity, element_size, count = header.unpack(stream.read(header.size))
        if capacity < 1 or element_size <= 12 or count > capacity:
            raise ValueError("Invalid vector header")
        if vector["MaxElementCount"] != capacity or vector["ElementCount"] != count:
            raise ValueError("Vector header does not match metadata")
        minimum = header.size + capacity * element_size
        if flat.stat().st_size not in (minimum, minimum + struct.calcsize("@N")):
            raise ValueError("Truncated vector index")
        scalar = path / "scalar_index/scalar_index.data"
        with scalar.open("rb") as stream:
            version, groups, elements = struct.unpack("@iii", stream.read(12))
        if version != 1 or groups < 0 or elements < 0:
            raise ValueError("Invalid scalar header")
        if groups and scalar.stat().st_size <= 12:
            raise ValueError("Truncated scalar index")
    except (OSError, ValueError, KeyError, TypeError, struct.error) as exc:
        raise InvalidSnapshot(f"Invalid native snapshot {path}: {exc}") from exc


def file_digest(path: Path, *, sync: bool = False) -> dict:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
        if sync:
            os.fsync(stream.fileno())
    return {"size": path.stat().st_size, "sha256": digest.hexdigest()}


def validate_snapshot(path: Path, marker: Path, cache: dict) -> None:
    """Cache by stat identity: immutable checkpoints need hashing only once."""
    try:
        files = snapshot_files(path)
        signature = tuple(
            (name, item.stat().st_size, item.stat().st_mtime_ns, item.stat().st_ctime_ns)
            for name, item in sorted({**files, ".write_done": marker}.items())
        )
        if cache.get(path) == signature:
            return
        validate_native_files(path)
        # Existing releases used an empty completion marker. Keep reading those
        # after structural validation; new markers cover every file by checksum.
        content = marker.read_text()
        if content:
            manifest = json.loads(content)
            if manifest.get("format") != 1 or set(manifest["files"]) != set(files):
                raise InvalidSnapshot("Invalid snapshot manifest")
            for name, file in files.items():
                if manifest["files"][name] != file_digest(file):
                    raise InvalidSnapshot(f"Snapshot checksum mismatch: {file}")
        cache[path] = signature
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise InvalidSnapshot(f"Invalid checkpoint {path}: {exc}") from exc


def cleanup_orphaned_staging(version_dir: Path) -> None:
    """Remove staging artifacts left behind by a publish_snapshot that never finished.

    A ".pending-*" directory or ".commit-*" file only exists while publish_snapshot
    is running and is removed before it returns (success or failure), so any found
    on disk belong to an attempt interrupted by a crash and are safe to discard.
    """
    for entry in version_dir.iterdir():
        if entry.name.startswith(".pending-"):
            shutil.rmtree(entry, ignore_errors=True)
        elif entry.name.startswith(".commit-"):
            entry.unlink(missing_ok=True)


def publish_snapshot(engine, version_dir: Path) -> int:
    """Data fsync -> directory fsync -> rename -> durable completion manifest.

    A failed dump/flush never publishes a marker or replaces an existing
    checkpoint. No caller may prune the delta log before this returns.
    """
    staging = Path(tempfile.mkdtemp(prefix=".pending-", dir=version_dir))
    marker = None
    published_directory = None
    try:
        version = engine.dump(str(staging))
        if version < 0:
            raise OSError("Native index dump failed")
        validate_native_files(staging)
        files = snapshot_files(staging)
        manifest = {
            "format": 1,
            "files": {name: file_digest(file, sync=True) for name, file in sorted(files.items())},
        }
        for directory in sorted(
            (p for p in staging.rglob("*") if p.is_dir()),
            key=lambda p: len(p.parts),
            reverse=True,
        ):
            sync_directory(directory)
        sync_directory(staging)
        destination = version_dir / str(version)
        if destination.exists():
            raise FileExistsError(f"Checkpoint already exists: {destination}")
        os.rename(staging, destination)
        published_directory = destination
        sync_directory(version_dir)
        marker = version_dir / f"{version}.write_done"
        atomic_write_bytes(
            marker,
            json.dumps(manifest, sort_keys=True).encode(),
            tmp_dir=version_dir,
            tmp_prefix=".commit-",
        )
        sync_directory(version_dir)
        sync_directory(version_dir.parent)
        sync_directory(version_dir.parent.parent)
        return version
    except BaseException:
        # In particular, a failed marker-directory fsync must not let a later
        # scan treat this attempt as a successful checkpoint and prune deltas.
        if marker is not None:
            marker.unlink(missing_ok=True)
        if published_directory is not None:
            shutil.rmtree(published_directory)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)
