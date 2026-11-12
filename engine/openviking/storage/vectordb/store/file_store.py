# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
from pathlib import Path
from typing import Optional

from openviking.storage.vectordb.store.store import IKVStore
from openviking.storage.vectordb.utils.file_utils import atomic_write_bytes
from openviking_cli.utils.logger import default_logger as logger


class FileStore(IKVStore):
    def __init__(self, base_path: Optional[str] = None):
        """
        Initialize file storage

        Args:
            base_path: Base path for security validation. If None, no path restriction
        """
        super().__init__()
        self.base_path = Path(base_path).resolve() if base_path else None

    def _validate_path(self, key: str) -> Path:
        """
        Validate path security

        Args:
            key: File path

        Returns:
            Path: Resolved safe path

        Raises:
            ValueError: If path is unsafe (path traversal attack)
        """
        if self.base_path is not None:
            # Join key with base_path if base_path is set
            path = (self.base_path / key).resolve()
            # print(f"DEBUG: base_path={self.base_path}, key={key}, resolved_path={path}")
        else:
            path = Path(key).resolve()

        # If base path is set, ensure requested path is within base path
        if self.base_path is not None:
            try:
                path.relative_to(self.base_path)
            except ValueError:
                logger.error(f"Path traversal attempt detected: {key}")
                raise ValueError(f"Invalid path: {key} is outside base directory")

        return path

    def get(self, key: str) -> Optional[bytes]:
        """
        Read file content

        Args:
            key: File path

        Returns:
            Optional[bytes]: File content, returns None if file doesn't exist or read fails
        """
        try:
            path = self._validate_path(key)
            # Open file in binary read-only mode
            with open(path, "rb") as f:
                # Read all binary data (returns bytes type)
                binary_data = f.read()
            return binary_data
        except FileNotFoundError:
            # logger.warning(f"File not found: {key}")
            return None
        except PermissionError:
            logger.error(f"Permission denied reading file: {key}")
            return None
        except ValueError as e:
            # Path validation failed
            logger.error(str(e))
            return None
        except Exception as e:
            logger.error(f"Unexpected error reading file {key}: {e}")
            return None

    def put(self, key: str, value: bytes) -> bool:
        """
        Write file content

        Args:
            key: File path
            value: Binary data to write

        Returns:
            bool: Returns True on success, False on failure
        """
        try:
            path = self._validate_path(key)
            # Ensure parent directory exists
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(path, value)
            return True
        except PermissionError:
            logger.error(f"Permission denied writing file: {key}")
            return False
        except OSError as e:
            # Handle disk full, path too long, and other system errors
            logger.error(f"OS error writing file {key}: {e}")
            return False
        except ValueError as e:
            # Path validation failed
            logger.error(str(e))
            return False
        except Exception as e:
            logger.error(f"Unexpected error writing file {key}: {e}")
            return False

    def delete(self, key: str) -> bool:
        """
        Delete file

        Args:
            key: File path

        Returns:
            bool: Returns True on success, False on failure
        """
        try:
            path = self._validate_path(key)
            # Delete file
            path.unlink()
            return True
        except FileNotFoundError:
            # Idempotency: deleting a non-existent file is a success
            # logger.debug(f"File not found for deletion (ignored): {key}")
            return True
        except PermissionError:
            logger.error(f"Permission denied deleting file: {key}")
            return False
        except ValueError as e:
            # Path validation failed
            logger.error(str(e))
            return False
        except Exception as e:
            logger.error(f"Unexpected error deleting file {key}: {e}")
            return False
