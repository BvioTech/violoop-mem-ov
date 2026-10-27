# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""ovcli.conf stays loadable by every reader that claims to read it."""

import json
import sys
from pathlib import Path

import pytest

from openviking_cli.utils.config.ovcli_config import load_ovcli_config as load_cli_config

REPO_ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(REPO_ROOT / "sdk" / "python"))
from openviking_sdk.config import load_ovcli_config as load_sdk_config  # noqa: E402

LOADERS = pytest.mark.parametrize("load", [load_cli_config, load_sdk_config], ids=["cli", "sdk"])


@LOADERS
def test_client_config_loads_common_fields(load, tmp_path):
    """Both readers accept the same config without a removed example file."""
    values = {
        "url": "http://localhost:1933",
        "api_key": "test-api-key",
        "root_api_key": None,
        "gateway_token": "test-gateway-token",
        "account": "test-account",
        "user": "test-user",
        "timeout": 60.0,
        "output": "table",
        "echo_command": True,
        "extra_headers": {"X-Test": "shared-config"},
        "plugin": {"recallCompress": "auto"},
    }
    path = tmp_path / "ovcli.conf"
    path.write_text(json.dumps(values), encoding="utf-8")

    config = load(str(path))

    assert config is not None
    for field in ("url", "api_key", "gateway_token", "account", "user", "timeout", "extra_headers"):
        assert getattr(config, field) == values[field]


@LOADERS
def test_plugin_section_is_accepted(load, tmp_path):
    path = tmp_path / "ovcli.conf"
    path.write_text(
        json.dumps({"url": "http://localhost:1933", "plugin": {"recallCompress": "off"}})
    )

    assert load(str(path)) is not None


@LOADERS
def test_unknown_field_is_still_rejected(load, tmp_path):
    path = tmp_path / "ovcli.conf"
    path.write_text(json.dumps({"url": "http://localhost:1933", "nonsense": 1}))

    with pytest.raises(ValueError):
        load(str(path))
