# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Tests for ``openviking-server doctor`` diagnostic checks."""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from openviking_cli.doctor import (
    _probe_embedding_provider,
    check_agfs,
    check_config,
    check_disk,
    check_embedding,
    check_native_engine,
    check_python,
    check_vlm,
    run_doctor,
)


class TestCheckConfig:
    def test_pass_with_valid_config(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(json.dumps({"embedding": {"dense": {}}}))
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_config()
        assert ok
        assert str(config) in detail

    def test_pass_with_utf8_bom_config(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text("\ufeff" + json.dumps({"embedding": {"dense": {}}}))
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_config()
        assert ok
        assert str(config) in detail

    def test_fail_missing_config(self):
        with patch("openviking_cli.doctor._find_config", return_value=None):
            ok, detail, fix = check_config()
        assert not ok
        assert "not found" in detail
        assert fix is not None

    def test_fail_invalid_json(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text("{bad json")
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_config()
        assert not ok
        assert "Invalid JSON" in detail

    def test_pass_without_embedding_section(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(json.dumps({"server": {}}))
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_config()
        assert ok
        assert str(config) in detail


class TestCheckPython:
    def test_pass_current_python(self):
        ok, detail, fix = check_python()
        assert ok  # Tests run on Python >= 3.10

    def test_fail_old_python(self):
        with patch.object(sys, "version_info", (3, 9, 0, "final", 0)):
            ok, detail, fix = check_python()
        assert not ok
        assert "3.9.0" in detail


class TestCheckNativeEngine:
    def test_pass_when_available(self):
        with patch(
            "openviking_cli.doctor.ENGINE_VARIANT",
            "native",
            create=True,
        ):
            # Need to patch the import itself
            import openviking.storage.vectordb.engine as engine_mod

            original_variant = engine_mod.ENGINE_VARIANT
            engine_mod.ENGINE_VARIANT = "native"
            try:
                ok, detail, fix = check_native_engine()
                assert ok
                assert "native" in detail
            finally:
                engine_mod.ENGINE_VARIANT = original_variant

    def test_fail_when_unavailable(self):
        import openviking.storage.vectordb.engine as engine_mod

        original_variant = engine_mod.ENGINE_VARIANT
        original_available = engine_mod.AVAILABLE_ENGINE_VARIANTS
        engine_mod.ENGINE_VARIANT = "unavailable"
        engine_mod.AVAILABLE_ENGINE_VARIANTS = ()
        try:
            ok, detail, fix = check_native_engine()
            assert not ok
            assert "No compatible" in detail
            assert fix is not None
        finally:
            engine_mod.ENGINE_VARIANT = original_variant
            engine_mod.AVAILABLE_ENGINE_VARIANTS = original_available


class TestCheckAgfs:
    def test_pass_when_importable(self):
        # pyagfs may not load cleanly in all envs (e.g. dev source checkout)
        ok, detail, fix = check_agfs()
        # Just verify it returns a valid tuple - pass/fail depends on environment
        assert isinstance(ok, bool)
        assert isinstance(detail, str)

    def test_pass_when_only_vendored_openviking_pyagfs_is_available(self):
        real_import = __import__

        def import_side_effect(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "pyagfs":
                raise ImportError("No module named 'pyagfs'")
            return real_import(name, globals, locals, fromlist, level)

        with patch("builtins.__import__", side_effect=import_side_effect):
            ok, detail, fix = check_agfs()

        assert ok
        assert "AGFS" in detail
        assert fix is None

    def test_fail_when_missing(self):
        with patch(
            "openviking_cli.doctor.importlib.import_module",
            side_effect=ImportError("No module named 'openviking.pyagfs'"),
        ):
            ok, detail, fix = check_agfs()
        assert not ok
        assert "Bundled AGFS client not found" in detail
        assert fix is not None


class TestCheckEmbedding:
    def test_fail_local_default_when_optional_dependency_missing(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(json.dumps({}))

        real_import_module = importlib.import_module

        def import_module_side_effect(name: str, *args, **kwargs):
            if name == "llama_cpp":
                raise ImportError("No module named 'llama_cpp'")
            return real_import_module(name, *args, **kwargs)

        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch(
                "openviking_cli.doctor.importlib.import_module",
                side_effect=import_module_side_effect,
            ):
                ok, detail, fix = check_embedding()

        assert not ok
        assert "missing llama-cpp-python" in detail
        assert "openviking[local-embed]" in fix

    def test_pass_local_default_with_cached_model(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(json.dumps({}))
        cached_model = (
            Path.home() / ".cache" / "openviking" / "models" / "bge-small-zh-v1.5-f16.gguf"
        )
        real_import = __import__

        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch(
                "openviking.models.embedder.local_embedders.get_local_model_cache_path",
                return_value=cached_model,
            ):
                with patch.object(Path, "exists", autospec=True, return_value=True):
                    with patch(
                        "openviking_cli.doctor.importlib.import_module",
                        side_effect=lambda name: (
                            object() if name == "llama_cpp" else real_import(name)
                        ),
                    ):
                        ok, detail, fix = check_embedding()

        assert ok
        assert "local/bge-small-zh-v1.5-f16" in detail
        assert fix is None

    def test_pass_local_default_reports_startup_download_when_cache_missing(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(json.dumps({}))
        real_import = __import__

        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch.object(Path, "exists", autospec=True, return_value=False):
                with patch(
                    "openviking_cli.doctor.importlib.import_module",
                    side_effect=lambda name: object() if name == "llama_cpp" else real_import(name),
                ):
                    ok, detail, fix = check_embedding()

        assert ok
        assert "startup initialization" in detail
        assert fix is None

    def test_fail_local_unknown_model(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps(
                {
                    "embedding": {
                        "dense": {
                            "provider": "local",
                            "model": "unknown-local-model",
                        }
                    }
                }
            )
        )

        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_embedding()

        assert not ok
        assert "unsupported local model" in detail
        assert "Unknown local embedding model" in fix

    def test_pass_with_api_key(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps(
                {
                    "embedding": {
                        "dense": {
                            "provider": "openai",
                            "model": "text-embedding-3-small",
                            "api_key": "sk-test123",
                        }
                    }
                }
            )
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch(
                "openviking_cli.doctor._probe_embedding_provider",
                return_value=(True, "openai/text-embedding-3-small probe ok", None),
            ):
                ok, detail, fix = check_embedding()
        assert ok
        assert "openai" in detail
        assert fix is None


    def test_pass_with_api_key_from_environment_variable(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps(
                {
                    "embedding": {
                        "dense": {
                            "provider": "openai",
                            "model": "text-embedding-3-small",
                            "api_key": "${OPENAI_API_KEY}",
                        }
                    }
                }
            )
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-env-123"}, clear=False):
                with patch(
                    "openviking_cli.doctor._probe_embedding_provider",
                    return_value=(True, "openai/text-embedding-3-small probe ok", None),
                ):
                    ok, detail, fix = check_embedding()
        assert ok
        assert "openai" in detail

    def test_fail_no_api_key(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps(
                {
                    "embedding": {
                        "dense": {
                            "provider": "openai",
                            "model": "text-embedding-3-small",
                            "api_key": "{your-api-key}",
                        }
                    }
                }
            )
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("OPENAI_API_KEY", None)
                ok, detail, fix = check_embedding()
        assert not ok
        assert "no API key" in detail

    def test_fail_invalid_json(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text("{not valid json")
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_embedding()
        assert not ok
        assert "unreadable" in detail

    def test_embedding_probe_fails_on_provider_error(self):
        with patch(
            "openviking_cli.utils.config.embedding_config.EmbeddingConfig.get_embedder",
            return_value=object(),
        ):
            with patch(
                "openviking.models.embedder.base.embed_compat",
                side_effect=RuntimeError("model not found"),
            ):
                ok, detail, fix = _probe_embedding_provider(
                    {"max_retries": 0},
                    {
                        "provider": "openai",
                        "model": "missing-model",
                        "api_base": "http://localhost:8080/v1",
                        "api_key": "test-key",
                        "dimension": 1024,
                    },
                )

        assert not ok
        assert "probe failed" in detail
        assert "model not found" in detail
        assert "model name" in fix

    def test_embedding_probe_fails_on_empty_dense_vector(self):
        class FakeEmbedder:
            pass

        async def fake_embed_compat(*args, **kwargs):
            return type("Result", (), {"dense_vector": []})()

        with patch(
            "openviking_cli.utils.config.embedding_config.EmbeddingConfig.get_embedder",
            return_value=FakeEmbedder(),
        ):
            with patch(
                "openviking.models.embedder.base.embed_compat",
                side_effect=fake_embed_compat,
            ):
                ok, detail, fix = _probe_embedding_provider(
                    {},
                    {
                        "provider": "openai",
                        "model": "custom-embed",
                        "api_base": "http://localhost:11434/v1",
                        "dimension": 3,
                    },
                )

        assert not ok
        assert "no dense vector" in detail
        assert "embedding.dense" in fix

    def test_embedding_probe_fails_on_dimension_mismatch(self):
        class FakeEmbedder:
            def get_dimension(self):
                return 2

        async def fake_embed_compat(*args, **kwargs):
            return type("Result", (), {"dense_vector": [0.1, 0.2]})()

        with patch(
            "openviking_cli.utils.config.embedding_config.EmbeddingConfig.get_embedder",
            return_value=FakeEmbedder(),
        ):
            with patch(
                "openviking.models.embedder.base.embed_compat",
                side_effect=fake_embed_compat,
            ):
                ok, detail, fix = _probe_embedding_provider(
                    {},
                    {
                        "provider": "openai",
                        "model": "custom-embed",
                        "api_base": "http://localhost:11434/v1",
                        "dimension": 3,
                    },
                )

        assert not ok
        assert "dimension mismatch" in detail
        assert "expected 3, got 2" in detail
        assert "embedding.dense.dimension" in fix

    def test_embedding_probe_uses_embedder_dimension_when_config_omits_dimension(self):
        class FakeEmbedder:
            def get_dimension(self):
                return 2

        async def fake_embed_compat(*args, **kwargs):
            return type("Result", (), {"dense_vector": [0.1, 0.2]})()

        with patch(
            "openviking_cli.utils.config.embedding_config.EmbeddingConfig.get_embedder",
            return_value=FakeEmbedder(),
        ):
            with patch(
                "openviking.models.embedder.base.embed_compat",
                side_effect=fake_embed_compat,
            ):
                ok, detail, fix = _probe_embedding_provider(
                    {},
                    {
                        "provider": "openai",
                        "model": "custom-embed",
                        "api_base": "http://localhost:11434/v1",
                    },
                )

        assert ok
        assert "dimension=2" in detail
        assert fix is None

    def test_embedding_probe_fails_when_inferred_dimension_mismatches_probe(self):
        class FakeEmbedder:
            def get_dimension(self):
                return 3

        async def fake_embed_compat(*args, **kwargs):
            return type("Result", (), {"dense_vector": [0.1, 0.2]})()

        with patch(
            "openviking_cli.utils.config.embedding_config.EmbeddingConfig.get_embedder",
            return_value=FakeEmbedder(),
        ):
            with patch(
                "openviking.models.embedder.base.embed_compat",
                side_effect=fake_embed_compat,
            ):
                ok, detail, fix = _probe_embedding_provider(
                    {},
                    {
                        "provider": "openai",
                        "model": "custom-embed",
                        "api_base": "http://localhost:11434/v1",
                    },
                )

        assert not ok
        assert "dimension mismatch" in detail
        assert "expected 3, got 2" in detail
        assert "embedding.dense.dimension" in fix


class TestCheckVlm:
    def test_pass_with_config(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps(
                {"vlm": {"provider": "openai", "model": "gpt-4o-mini", "api_key": "sk-test"}}
            )
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_vlm()
        assert ok

    def test_pass_with_credentials_config(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps(
                {
                    "vlm": {
                        "provider": "openai",
                        "model": "gpt-4o-mini",
                        "credentials": [
                            {"api_key": "sk-primary"},
                            {"api_key": "sk-backup"},
                        ],
                    }
                }
            )
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_vlm()
        assert ok
        assert "openai/gpt-4o-mini" in detail
        assert fix is None

    def test_fail_no_provider(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(json.dumps({"vlm": {}}))
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_vlm()
        assert not ok

    def test_fail_invalid_json(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text("{not valid json")
        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_vlm()
        assert not ok
        assert "unreadable" in detail

    def test_pass_with_codex_oauth(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps({"vlm": {"provider": "openai-codex", "model": "gpt-5.3-codex"}})
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch(
                "openviking.models.vlm.backends.codex_auth.resolve_codex_runtime_credentials",
                return_value={"source": "openviking"},
            ):
                ok, detail, fix = check_vlm()
        assert ok
        assert "oauth via openviking" in detail

    def test_codex_oauth_path_still_validates_other_fields(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(json.dumps({"vlm": {"provider": "openai-codex"}}))

        with patch("openviking_cli.doctor._find_config", return_value=config):
            ok, detail, fix = check_vlm()

        assert not ok
        assert "requires 'model'" in detail
        assert fix == "Fix vlm section in ov.conf"

    def test_fail_with_codex_oauth_missing_auth(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps({"vlm": {"provider": "openai-codex", "model": "gpt-5.3-codex"}})
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch(
                "openviking.models.vlm.backends.codex_auth.resolve_codex_runtime_credentials",
                side_effect=RuntimeError("missing auth"),
            ):
                with patch(
                    "openviking.models.vlm.backends.codex_auth.get_codex_auth_status",
                    return_value={
                        "store_path": "/tmp/ov-codex.json",
                        "bootstrap_path": "/tmp/codex/auth.json",
                    },
                ):
                    ok, detail, fix = check_vlm()
        assert not ok
        assert "missing auth" in detail
        assert "openviking-server init" in fix

    def test_pass_with_default_provider_codex_oauth(self, tmp_path: Path):
        config = tmp_path / "ov.conf"
        config.write_text(
            json.dumps(
                {
                    "vlm": {
                        "model": "gpt-5.3-codex",
                        "default_provider": "openai-codex",
                        "providers": {"openai": {"api_key": "sk-test"}, "openai-codex": {}},
                    }
                }
            )
        )
        with patch("openviking_cli.doctor._find_config", return_value=config):
            with patch(
                "openviking.models.vlm.backends.codex_auth.resolve_codex_runtime_credentials",
                return_value={"source": "openviking"},
            ):
                ok, detail, fix = check_vlm()
        assert ok
        assert "openai-codex/gpt-5.3-codex" in detail
        assert "oauth via openviking" in detail


