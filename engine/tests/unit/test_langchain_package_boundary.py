from __future__ import annotations

import os
import subprocess
import sys
from importlib import import_module
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SDK_ROOT = PROJECT_ROOT / "sdk" / "python"


def test_server_distribution_does_not_depend_on_standalone_integration():
    root_pyproject = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    root_lock = (PROJECT_ROOT / "uv.lock").read_text(encoding="utf-8")

    assert "langchain-openviking" not in root_pyproject
    assert 'name = "langchain-openviking"' not in root_lock


def test_legacy_namespace_remains_importable_without_standalone_package(tmp_path):
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join((str(PROJECT_ROOT), str(SDK_ROOT)))
    probe = """
import importlib.abc
import importlib
import sys


class BlockStandalonePackage(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "langchain_openviking" or fullname.startswith("langchain_openviking."):
            raise ModuleNotFoundError(
                "No module named 'langchain_openviking'",
                name="langchain_openviking",
            )
        return None


sys.meta_path.insert(0, BlockStandalonePackage())

import openviking.integrations.langchain as legacy

assert "OpenVikingRetriever" in legacy.__all__
assert isinstance(legacy.has_request_actor_peer_support(), bool)

try:
    legacy.OpenVikingRetriever
except ImportError as exc:
    message = str(exc)
    assert "langchain-openviking" in message
    assert "openviking[langchain]" not in message
else:
    raise AssertionError("missing standalone package should produce an installation error")

for submodule in (
    "actor_peer",
    "client",
    "context",
    "history",
    "messages",
    "middleware",
    "recording",
    "retrievers",
    "store",
    "testing",
    "tools",
):
    try:
        importlib.import_module(f"openviking.integrations.langchain.{submodule}")
    except ImportError as exc:
        assert not isinstance(exc, ModuleNotFoundError)
        message = str(exc)
        assert "langchain-openviking" in message
        assert "openviking[langchain]" not in message
    else:
        raise AssertionError(f"legacy {submodule} import should produce an installation error")
"""

    subprocess.run(
        [sys.executable, "-c", probe],
        cwd=tmp_path,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def test_legacy_imports_resolve_to_canonical_objects():
    pytest.importorskip("langchain_core")
    pytest.importorskip("langchain_openviking")
    canonical = import_module("langchain_openviking")
    legacy = import_module("openviking.integrations.langchain")

    for name in canonical.__all__:
        assert getattr(legacy, name) is getattr(canonical, name)

    for submodule in (
        "actor_peer",
        "client",
        "context",
        "history",
        "messages",
        "middleware",
        "recording",
        "retrievers",
        "store",
        "testing",
        "tools",
    ):
        legacy_module = import_module(f"openviking.integrations.langchain.{submodule}")
        canonical_module = import_module(f"langchain_openviking.{submodule}")
        legacy_public = {name for name in vars(legacy_module) if not name.startswith("_")}
        canonical_public = {name for name in vars(canonical_module) if not name.startswith("_")}

        assert legacy_public == canonical_public
        for name in sorted(canonical_public):
            assert getattr(legacy_module, name) is getattr(canonical_module, name)


@pytest.mark.parametrize(
    ("uri", "expected_parts", "expected_scope", "expected_content_index"),
    [
        (
            "viking://~/memories/store/data/users/ada.json",
            ("~", "memories", "store", "data", "users", "ada.json"),
            "user",
            1,
        ),
        # Legacy uid-less roots may still sit in older store configs; keep classifying them.
        (
            "viking://user/memories/store/data/users/ada.json",
            ("user", "memories", "store", "data", "users", "ada.json"),
            "user",
            1,
        ),
        (
            "viking://user/default/memories/store/index/users/ada.md",
            ("user", "default", "memories", "store", "index", "users", "ada.md"),
            "user",
            2,
        ),
        (
            "viking://user/default/peers/assistant/resources/store/data.json",
            ("user", "default", "peers", "assistant", "resources", "store", "data.json"),
            "user",
            4,
        ),
        (
            "viking://~/peers/assistant/memories/store/index.md",
            ("~", "peers", "assistant", "memories", "store", "index.md"),
            "user",
            3,
        ),
        (
            "viking://user/peers/assistant/memories/store/index.md",
            ("user", "peers", "assistant", "memories", "store", "index.md"),
            "user",
            3,
        ),
        (
            "viking://agent/default/skills/review/SKILL.md",
            ("agent", "default", "skills", "review", "SKILL.md"),
            "agent",
            2,
        ),
        (
            "viking://resources/shared.md",
            ("resources", "shared.md"),
            "resources",
            None,
        ),
        (
            "viking://user/default/sessions/thread-1",
            ("user", "default", "sessions", "thread-1"),
            "user",
            None,
        ),
        (
            "/user/default/memories/store/data.json?profile=1",
            ("user", "default", "memories", "store", "data.json"),
            "user",
            2,
        ),
    ],
)
def test_private_uri_classification_preserves_server_namespace_shapes(
    uri,
    expected_parts,
    expected_scope,
    expected_content_index,
):
    pytest.importorskip("langchain_openviking")
    from langchain_openviking._uri import classify_uri

    classification = classify_uri(uri)

    assert classification.parts == expected_parts
    assert classification.scope == expected_scope
    assert classification.content_index == expected_content_index
