# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional


def touch_file(file_path: str) -> None:
    try:
        with open(file_path, "a"):
            pass
    except Exception as e:
        logging.error("touch file failed: {}, file_path: {}".format(e, file_path))


def atomic_write_bytes(
    path: Path, data: bytes, *, tmp_dir: Optional[Path] = None, tmp_prefix: str = ".tmp-"
) -> None:
    """Write `data` to `path` atomically: tmp file, fsync, then rename over the target.

    Raises on any failure. The caller decides whether that failure is fatal or
    should be logged and swallowed; this only guarantees `path` is never left
    holding a partial write.
    """
    directory = tmp_dir if tmp_dir is not None else path.parent
    fd, name = tempfile.mkstemp(prefix=tmp_prefix, dir=directory)
    tmp_path = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
