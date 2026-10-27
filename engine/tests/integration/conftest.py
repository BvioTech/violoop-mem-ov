# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0

"""Shared fixtures for integration tests.

Automatically starts an OpenViking server in a background thread so that
AsyncHTTPClient integration tests can run without a manually started server process.
"""

import copy
import math
import os
import shutil
import socket
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
import uvicorn

from openviking.server.app import create_app
from openviking.server.config import ServerConfig
from openviking.server.identity import RequestContext, Role
from openviking.service.core import OpenVikingService
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton

PROJECT_ROOT = Path(__file__).parent.parent.parent
TEST_TMP_DIR = PROJECT_ROOT / "test_data" / "tmp_integration"

# ── Gemini integration test helpers ──────────────────────────────────────────

# ── Vault integration test helpers ──────────────────────────────────────────
VAULT_ADDR = os.environ.get("VAULT_ADDR", "http://127.0.0.1:8200")
VAULT_TOKEN = os.environ.get("VAULT_TOKEN", "")
requires_vault = pytest.mark.skipif(not VAULT_TOKEN, reason="VAULT_TOKEN not set")

# ── Volcengine KMS integration test helpers ──────────────────────────────────────────
VOLCENGINE_ACCESS_KEY = os.environ.get("VOLCENGINE_ACCESS_KEY", "")
VOLCENGINE_SECRET_KEY = os.environ.get("VOLCENGINE_SECRET_KEY", "")
VOLCENGINE_KMS_KEY_ID = os.environ.get("VOLCENGINE_KMS_KEY_ID", "")
VOLCENGINE_KMS_REGION = os.environ.get("VOLCENGINE_KMS_REGION", "cn-beijing")
requires_volcengine_kms = pytest.mark.skipif(
    not (VOLCENGINE_ACCESS_KEY and VOLCENGINE_SECRET_KEY and VOLCENGINE_KMS_KEY_ID),
    reason="VOLCENGINE_ACCESS_KEY, VOLCENGINE_SECRET_KEY, or VOLCENGINE_KMS_KEY_ID not set",
)

# (model_name, default_dimension, token_limit)


def _local_engine_available() -> bool:
    try:
        from openviking.storage.vectordb.engine import ENGINE_VARIANT
    except Exception:
        return False
    return ENGINE_VARIANT != "unavailable"


requires_engine = pytest.mark.skipif(
    not _local_engine_available(),
    reason="local vectordb engine unavailable",
)


def sample_markdown(base_dir: Path, slug: str, content: str) -> Path:
    path = base_dir / f"{slug}.md"
    path.write_text(content, encoding="utf-8")
    return path


@pytest.fixture(scope="session")
def temp_dir():
    """Create temp directory for the whole test session."""
    shutil.rmtree(TEST_TMP_DIR, ignore_errors=True)
    TEST_TMP_DIR.mkdir(parents=True, exist_ok=True)
    yield TEST_TMP_DIR


@pytest.fixture(scope="function")
def server_url(tmp_path, monkeypatch):
    """Start a real uvicorn server in a background thread.

    Returns the base URL (e.g. ``http://127.0.0.1:<port>``).
    The server is automatically shut down after the test session.
    """
    from tests.server.conftest import _install_fake_embedder, _install_fake_vlm

    @asynccontextmanager
    async def _noop_mcp_lifespan():
        yield

    # MCP has its own lifecycle tests; each HTTP fixture needs independent lifetime.
    monkeypatch.setattr("openviking.server.mcp_endpoint.mcp_lifespan", _noop_mcp_lifespan)
    _install_fake_embedder(monkeypatch)
    _install_fake_vlm(monkeypatch)
    OpenVikingConfigSingleton.reset_instance()
    OpenVikingConfigSingleton.initialize(
        config_dict={
            "storage": {
                "workspace": str(tmp_path / "server"),
                "agfs": {"backend": "local"},
                "vectordb": {"backend": "local"},
            },
            "embedding": {
                "dense": {
                    "provider": "openai",
                    "model": "test",
                    "api_key": "test",
                    "dimension": 2048,
                }
            },
            "vlm": {"provider": "openai", "model": "test", "api_key": "test"},
            "server": {"auth_mode": "dev"},
        }
    )
    config = ServerConfig(auth_mode="dev")
    fastapi_app = create_app(config=config)

    # Find a free port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    uvi_config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(uvi_config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Wait for server ready
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            r = httpx.get(f"{url}/health", timeout=1)
            if r.status_code == 200:
                break
        except Exception:
            time.sleep(0.1)

    else:
        server.should_exit = True
        thread.join(timeout=5)
        raise RuntimeError("Test HTTP server did not become ready")

    yield url

    server.should_exit = True
    thread.join(timeout=5)
    if thread.is_alive():
        raise RuntimeError("Test HTTP server failed to shut down")
    OpenVikingConfigSingleton.reset_instance()


def l2_norm(vec: list[float]) -> float:
    """Compute L2 norm of a vector."""
    return math.sqrt(sum(v * v for v in vec))
