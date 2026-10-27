"""Tests for the openviking-server init setup wizard."""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

from openviking_cli.setup_wizard import (
    _CUSTOM_SETUP,
    _DEFAULT_KIMI_MODEL,
    _GO_BACK,
    _SKIP_VLM,
    BYTEPLUS_PLANS,
    CLOUD_PROVIDERS,
    LOCAL_GGUF_PRESETS,
    VOLCENGINE_PLANS,
    _config_path,
    _is_llamacpp_installed,
    _mask_secret,
    _masked_input,
    _next_backup_path,
    _parse_size_gb,
    _prompt_api_key,
    _prompt_api_key_with_env,
    _prompt_required_input,
    _prompt_required_int,
    _update_existing_config,
    _wizard_server,
    _wizard_two_step,
    _workspace_path,
    _write_config,
    run_init,
)

# ---------------------------------------------------------------------------
# Model configuration
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Model availability
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Config building
# ---------------------------------------------------------------------------


class TestConfigBuilding:

    def test_prompt_required_input_uses_default_on_empty(self):
        with patch("builtins.input", return_value=""):
            value = _prompt_required_input("Model", default=_DEFAULT_KIMI_MODEL)

        assert value == _DEFAULT_KIMI_MODEL

    def test_prompt_required_int_uses_default_on_empty(self):
        with patch("builtins.input", return_value=""):
            value = _prompt_required_int("Dimension", default=1024)

        assert value == 1024



# ---------------------------------------------------------------------------
# Query planner
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# RAM-based recommendations
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Config writing
# ---------------------------------------------------------------------------


class TestConfigWriting:
    def test_write_new_config(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config = _build_test_config(str(tmp_path / "data"))

        assert _write_config(config, config_path) is True
        assert config_path.exists()
        assert config_path.stat().st_mode & 0o777 == 0o600

        loaded = json.loads(config_path.read_text(encoding="utf-8"))
        assert loaded["embedding"]["dense"]["provider"] == "local"

    def test_backup_existing(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text('{"old": true}', encoding="utf-8")

        config = _build_test_config(str(tmp_path / "data"))
        assert _write_config(config, config_path) is True

        backup = tmp_path / "ov.conf.bak"
        assert backup.exists()
        assert backup.stat().st_mode & 0o777 == 0o600
        assert json.loads(backup.read_text())["old"] is True

    def test_creates_parent_dirs(self, tmp_path):
        config_path = tmp_path / "subdir" / "ov.conf"
        config = _build_test_config("/tmp/data")

        assert _write_config(config, config_path) is True
        assert config_path.exists()

    def test_replace_failure_preserves_existing_config(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text('{"old": true}', encoding="utf-8")

        with patch("openviking_cli.setup_wizard.os.replace", side_effect=OSError("replace")):
            assert _write_config({"new": True}, config_path) is False

        assert json.loads(config_path.read_text()) == {"old": True}
        assert not list(tmp_path.glob(".ov.conf.*"))

    def test_backup_copy_failure_leaves_no_public_backup(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text('{"secret": true}', encoding="utf-8")

        def fail_after_partial_copy(source, target):
            target.write(source.read(1))
            raise OSError("copy")

        with patch("openviking_cli.setup_wizard.shutil.copyfileobj", fail_after_partial_copy):
            assert _write_config({"new": True}, config_path) is False

        assert json.loads(config_path.read_text()) == {"secret": True}
        assert not (tmp_path / "ov.conf.bak").exists()
        assert not list(tmp_path.glob(".ov.conf*.*"))

    def test_run_init_redacts_summary_output(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config = {
            "embedding": {
                "dense": {
                    "provider": "local",
                    "model": "secret-model",
                    "dimension": 1024,
                    "model_path": "/very/secret/model.gguf",
                }
            },
            "vlm": {
                "provider": "openai",
                "model": "secret-vlm",
            },
            "storage": {
                "workspace": "/very/secret/workspace",
            },
        }

        with (
            patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False),
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=1),
            patch("openviking_cli.setup_wizard._wizard_two_step", return_value=(config, None)),
            patch(
                "openviking_cli.setup_wizard._wizard_server",
                return_value={"host": "127.0.0.1"},
            ),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._write_config", return_value=True),
            patch("openviking_cli.setup_wizard._post_save_actions", return_value=None),
            patch("builtins.print") as mock_print,
        ):
            assert run_init() == 0

        output = "\n".join(
            " ".join(str(arg) for arg in call.args) for call in mock_print.call_args_list
        )
        assert "/very/secret/model.gguf" not in output
        assert "/very/secret/workspace" not in output
        assert str(config_path) not in output
        assert "custom local model (hidden)" in output
        assert "default config location" in output

    def test_env_overrides_config_path_and_derives_workspace(self, tmp_path):
        config_path = tmp_path / "runtime" / "ov.conf"
        with patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False):
            assert _config_path() == config_path
            assert _workspace_path() == str(config_path.parent / "data")

    def test_run_init_writes_to_env_config_path(self, tmp_path):
        config_path = tmp_path / "runtime" / "ov.conf"
        config = {
            "embedding": {"dense": {"provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512}},
            "storage": {"workspace": str(config_path.parent / "data")},
        }
        with (
            patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False),
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=1),
            patch("openviking_cli.setup_wizard._wizard_two_step", return_value=(config, None)),
            patch(
                "openviking_cli.setup_wizard._wizard_server",
                return_value={"host": "127.0.0.1"},
            ),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._write_config", return_value=True) as mock_write,
            patch("openviking_cli.setup_wizard._post_save_actions", return_value=None),
            patch("builtins.print"),
        ):
            assert run_init() == 0

        expected = dict(config)
        expected["server"] = {"host": "127.0.0.1"}
        mock_write.assert_called_once_with(expected, config_path)


# ---------------------------------------------------------------------------
# llama.cpp local embedding config
# ---------------------------------------------------------------------------


class TestLlamaCppDetection:
    def test_llamacpp_installed(self):
        with patch.dict("sys.modules", {"llama_cpp": MagicMock()}):
            assert _is_llamacpp_installed() is True

    def test_llamacpp_not_installed(self):
        import importlib

        with patch.object(importlib, "import_module", side_effect=ImportError("no module")):
            assert _is_llamacpp_installed() is False


class TestLocalGGUFPresets:
    def test_presets_have_valid_dimensions(self):
        for preset in LOCAL_GGUF_PRESETS:
            assert preset.dimension > 0
            assert preset.model_name
            assert preset.label


class TestCloudProviderOrdering:
    def test_volcengine_is_first_and_default(self):
        assert CLOUD_PROVIDERS[0].label == "VolcEngine (火山引擎)"
        assert CLOUD_PROVIDERS[0].provider == "volcengine"

    def test_byteplus_is_second(self):
        assert CLOUD_PROVIDERS[1].label == "BytePlus"
        assert CLOUD_PROVIDERS[1].default_api_base == (
            "https://ark.ap-southeast.bytepluses.com/api/v3"
        )

    def test_openai_is_third(self):
        assert CLOUD_PROVIDERS[2].label == "OpenAI"
        assert CLOUD_PROVIDERS[2].provider == "openai"


class TestVolcenginePlans:
    def test_plan_endpoints_and_defaults(self):
        agent, coding, payg = VOLCENGINE_PLANS
        assert agent.api_base == "https://ark.cn-beijing.volces.com/api/plan/v3"
        assert coding.api_base == "https://ark.cn-beijing.volces.com/api/coding/v3"
        assert payg.api_base == "https://ark.cn-beijing.volces.com/api/v3"
        for plan in (agent, coding):
            assert plan.default_vlm_model == "doubao-seed-2.0-lite"
            assert plan.default_embedding_model == "doubao-embedding-vision"
            assert plan.default_embedding_dim == 1024

    def test_plan_menu_defaults_to_current_endpoint(self):
        from openviking_cli.setup_wizard import _select_access_plan

        with patch("openviking_cli.setup_wizard._prompt_choice", return_value=2) as mock_choice:
            plan = _select_access_plan(
                "VolcEngine (火山引擎)", VOLCENGINE_PLANS, VOLCENGINE_PLANS[1].api_base
            )
        assert plan is VOLCENGINE_PLANS[1]
        assert mock_choice.call_args.kwargs.get("default") == 2

    def test_plan_menu_offers_keep_for_custom_endpoint(self):
        from openviking_cli.setup_wizard import _select_access_plan

        custom = "https://proxy.volces.com/custom/v3"
        with patch("openviking_cli.setup_wizard._prompt_choice", return_value=4) as mock_choice:
            plan = _select_access_plan("VolcEngine (火山引擎)", VOLCENGINE_PLANS, custom)
        assert plan.api_base == custom
        options = mock_choice.call_args.args[1]
        assert len(options) == len(VOLCENGINE_PLANS) + 1
        assert mock_choice.call_args.kwargs.get("default") == len(options)

    def test_plan_menu_back_returns_sentinel(self):
        from openviking_cli.setup_wizard import _select_access_plan

        with patch("openviking_cli.setup_wizard._prompt_choice", return_value=0):
            assert (
                _select_access_plan("VolcEngine (火山引擎)", VOLCENGINE_PLANS, allow_back=True)
                is _GO_BACK
            )

    def test_byteplus_plan_endpoints_and_defaults(self):
        coding, payg = BYTEPLUS_PLANS
        assert coding.label == "ModelArk Coding Plan"
        assert coding.api_base == "https://ark.ap-southeast.bytepluses.com/api/coding/v3"
        assert coding.default_vlm_model == "dola-seed-2.0-lite"
        assert coding.default_embedding_model == "skylark-embedding-vision"
        assert coding.default_embedding_dim == 1024
        assert payg.api_base == "https://ark.ap-southeast.bytepluses.com/api/v3"

    def test_vlm_flow_byteplus_coding_plan(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        with (
            # VLM provider -> BytePlus, plan menu -> ModelArk Coding Plan
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[2, 1]),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="bp-key"),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default,
            ),
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm()

        assert vlm_config["provider"] == "volcengine"
        assert vlm_config["model"] == "dola-seed-2.0-lite"
        assert vlm_config["api_base"] == "https://ark.ap-southeast.bytepluses.com/api/coding/v3"

    def test_embedding_flow_byteplus_coding_plan(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        with (
            # Provider menu -> BytePlus, plan menu -> ModelArk Coding Plan
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[2, 1]),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="bp-key"),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default,
            ),
            patch("builtins.print"),
        ):
            dense = _prompt_cloud_embedding()

        assert dense["provider"] == "volcengine"
        assert dense["model"] == "skylark-embedding-vision"
        assert dense["api_base"] == "https://ark.ap-southeast.bytepluses.com/api/coding/v3"
        assert dense["dimension"] == 1024

    def test_provider_index_distinguishes_byteplus_plan_endpoint(self):
        from openviking_cli.setup_wizard import _cloud_provider_index_for

        byteplus_plan = {
            "provider": "volcengine",
            "api_base": "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
        }
        volc_plan = {
            "provider": "volcengine",
            "api_base": "https://ark.cn-beijing.volces.com/api/plan/v3",
        }
        assert _cloud_provider_index_for(byteplus_plan) == 2
        assert _cloud_provider_index_for(volc_plan) == 1

    def test_embedding_flow_uses_selected_plan(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        with (
            # Provider menu -> VolcEngine, plan menu -> Agent Plan
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[1, 1]),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="ark-key"),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default,
            ),
            patch("builtins.print"),
        ):
            dense = _prompt_cloud_embedding()

        assert dense == {
            "provider": "volcengine",
            "model": "doubao-embedding-vision",
            "api_key": "ark-key",
            "api_base": "https://ark.cn-beijing.volces.com/api/plan/v3",
            "dimension": 1024,
        }

    def test_embedding_flow_plan_back_returns_to_provider_menu(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        with (
            # VolcEngine -> plan menu back -> provider menu -> OpenAI
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[1, 0, 3]),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="sk-x"),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default,
            ),
            patch("builtins.print"),
        ):
            dense = _prompt_cloud_embedding()

        assert dense["provider"] == "openai"
        assert dense["api_base"] == "https://api.openai.com/v1"

    def test_vlm_flow_uses_selected_plan(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        with (
            # VLM provider -> VolcEngine, plan menu -> Coding Plan
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[1, 2]),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="ark-key"),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default,
            ),
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm()

        assert vlm_config["provider"] == "volcengine"
        assert vlm_config["model"] == "doubao-seed-2.0-lite"
        assert vlm_config["api_base"] == "https://ark.cn-beijing.volces.com/api/coding/v3"
        assert vlm_config["api_key"] == "ark-key"

    def test_vlm_flow_plan_back_returns_to_provider_menu(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        with (
            # VolcEngine -> plan menu back -> provider menu -> GLM
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[1, 0, 6]),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="glm-key"),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default,
            ),
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm()

        assert vlm_config["provider"] == "glm"

    def test_two_step_seeds_vlm_plan_from_embedding(self):
        dense = {
            "provider": "volcengine",
            "model": "doubao-embedding-vision",
            "api_key": "ark-key",
            "api_base": "https://ark.cn-beijing.volces.com/api/coding/v3",
            "dimension": 1024,
        }
        with (
            patch(
                "openviking_cli.setup_wizard._prompt_embedding_flow",
                return_value=(dense, None),
            ),
            patch(
                "openviking_cli.setup_wizard._prompt_cloud_vlm",
                return_value=(_SKIP_VLM, None),
            ) as mock_vlm,
            patch("builtins.print"),
        ):
            config, _ = _wizard_two_step()

        assert "vlm" not in config
        assert (
            mock_vlm.call_args.kwargs.get("plan_seed")
            == "https://ark.cn-beijing.volces.com/api/coding/v3"
        )


class TestCustomEmbedding:
    def test_interactive_openai_compatible(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        answers = {"API Base URL": "https://my.proxy/v1", "Model": "text-embedding-3-large"}
        with (
            # Provider menu -> Custom / manual, custom menu -> interactive
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[4, 1]),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: answers.get(prompt, default),
            ),
            patch(
                "openviking_cli.setup_wizard._prompt_api_key_with_env",
                return_value="sk-proxy",
            ),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=3072),
            patch("builtins.print"),
        ):
            dense = _prompt_cloud_embedding()

        assert dense == {
            "provider": "openai",
            "model": "text-embedding-3-large",
            "api_key": "sk-proxy",
            "api_base": "https://my.proxy/v1",
            "dimension": 3072,
        }

    def test_manual_edit_returns_custom_sentinel(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        with (
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[4, 2]),
            patch("openviking_cli.setup_wizard._wizard_custom") as mock_custom,
            patch("builtins.print"),
        ):
            assert _prompt_cloud_embedding() is _CUSTOM_SETUP
        mock_custom.assert_called_once()

    def test_custom_back_returns_to_provider_menu(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        with (
            # Custom / manual -> back -> provider menu -> back
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[4, 0, 0]),
            patch("builtins.print"),
        ):
            assert _prompt_cloud_embedding(allow_back=True) is _GO_BACK

    def test_back_token_at_dimension_returns_to_provider_menu(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        with (
            # Custom / manual -> interactive, then !back at the dimension prompt,
            # provider menu -> back
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[4, 1, 0]),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default or "value",
            ),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="sk-x"),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=_GO_BACK),
            patch("builtins.print"),
        ):
            assert _prompt_cloud_embedding(allow_back=True) is _GO_BACK


class TestCustomVlm:
    def test_interactive_custom_vlm(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        answers = {"API Base URL": "https://my.proxy/v1", "Model": "my-vlm"}
        with (
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=7),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: answers.get(prompt, default),
            ),
            patch(
                "openviking_cli.setup_wizard._prompt_api_key_with_env",
                return_value="sk-proxy",
            ),
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm()

        assert vlm_config["provider"] == "openai"
        assert vlm_config["model"] == "my-vlm"
        assert vlm_config["api_base"] == "https://my.proxy/v1"
        assert vlm_config["api_key"] == "sk-proxy"

    def test_back_token_in_custom_vlm_returns_to_provider_menu(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        with (
            # Custom -> !back at the URL prompt -> provider menu -> GLM
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[7, 6]),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: (
                    _GO_BACK if prompt == "API Base URL" else default
                ),
            ),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env", return_value="glm-key"),
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm()

        assert vlm_config["provider"] == "glm"

    def test_required_input_back_token(self):
        with patch("builtins.input", return_value="!back"):
            assert _prompt_required_input("Model", allow_back=True) is _GO_BACK
        with patch("builtins.input", return_value="!back"):
            assert _prompt_required_input("Model") == "!back"  # literal without allow_back

    def test_required_int_back_token(self):
        with patch("builtins.input", return_value="!back"):
            assert _prompt_required_int("Dimension", allow_back=True) is _GO_BACK


class TestBackupRotation:
    def test_first_backup_uses_bak_suffix(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        assert _next_backup_path(config_path) == tmp_path / "ov.conf.bak"

    def test_rotates_when_bak_exists(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        (tmp_path / "ov.conf.bak").write_text("old", encoding="utf-8")
        assert _next_backup_path(config_path) == tmp_path / "ov.conf.bak.1"

    def test_skips_existing_numbered_backups(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        (tmp_path / "ov.conf.bak").write_text("0", encoding="utf-8")
        (tmp_path / "ov.conf.bak.1").write_text("1", encoding="utf-8")
        (tmp_path / "ov.conf.bak.2").write_text("2", encoding="utf-8")
        assert _next_backup_path(config_path) == tmp_path / "ov.conf.bak.3"

    def test_write_config_rotates_existing_backup(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text('{"v":1}', encoding="utf-8")
        (tmp_path / "ov.conf.bak").write_text('{"old":true}', encoding="utf-8")

        config = _build_test_config(str(tmp_path / "data"))
        assert _write_config(config, config_path) is True

        # Original backup preserved, new one rotated to .bak.1
        assert (tmp_path / "ov.conf.bak").read_text() == '{"old":true}'
        assert (tmp_path / "ov.conf.bak.1").read_text() == '{"v":1}'


class TestApiKeyMasking:
    def test_mask_short_secret_is_fully_starred(self):
        assert _mask_secret("abc") == "***"
        assert _mask_secret("a" * 11) == "*" * 11

    def test_mask_long_secret_keeps_prefix_and_suffix(self):
        value = "sk-proj-1234567890ABCDEF"
        masked = _mask_secret(value)
        assert masked.startswith("sk-proj")
        assert masked.endswith("CDEF")
        assert "1234567890AB" not in masked
        assert len(masked) == len(value)

    def test_mask_empty(self):
        assert _mask_secret("") == ""

    def test_prompt_api_key_uses_masked_input(self):
        with patch(
            "openviking_cli.setup_wizard._masked_input",
            return_value="sk-proj-1234567890ABCDEF",
        ) as masked:
            value = _prompt_api_key("API Key")
        assert value == "sk-proj-1234567890ABCDEF"
        masked.assert_called_once()

    def test_prompt_api_key_does_not_print_extra_preview_line(self, capsys):
        with patch(
            "openviking_cli.setup_wizard._masked_input",
            return_value="sk-proj-1234567890ABCDEF",
        ):
            _prompt_api_key("API Key")
        # No extra "Using ..." confirmation line — the inline rewrite in
        # _masked_input is the only place the masked preview should appear.
        assert "Using API Key" not in capsys.readouterr().out

    def test_masked_input_falls_back_to_input_for_non_tty(self):
        with patch("builtins.input", return_value="paste-me") as plain:
            assert _masked_input("API Key: ") == "paste-me"
        plain.assert_called_once_with("API Key: ")

    def test_prompt_required_input_with_mask_routes_through_masked_input(self):
        with patch(
            "openviking_cli.setup_wizard._masked_input",
            return_value="hunter2",
        ) as masked:
            value = _prompt_required_input("API Key", mask=True)
        assert value == "hunter2"
        masked.assert_called_once()


class TestServerWizard:
    def test_local_mode_returns_loopback_host_and_port(self):
        with (
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=1),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=1933),
            patch("builtins.print"),
        ):
            assert _wizard_server() == {"host": "127.0.0.1", "port": 1933}

    def test_local_mode_custom_port(self):
        with (
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=1),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=8080),
            patch("builtins.print"),
        ):
            assert _wizard_server() == {"host": "127.0.0.1", "port": 8080}

    def test_remote_mode_manual_root_api_key(self):
        with (
            # bind=Remote, key source=Enter my own
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[2, 2]),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=1933),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                return_value="my-secret-key",
            ),
            patch("builtins.print"),
        ):
            assert _wizard_server() == {
                "host": "0.0.0.0",
                "port": 1933,
                "root_api_key": "my-secret-key",
            }

    def test_remote_mode_generates_and_displays_root_api_key(self):
        with (
            # bind=Remote, key source=Generate one for me
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[2, 1]),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=1933),
            patch("builtins.print") as mock_print,
        ):
            result = _wizard_server()

        assert result is not None
        key = result["root_api_key"]
        # 64-char hex, matching the repo's root-key convention (token_hex(32)).
        assert len(key) == 64
        int(key, 16)  # raises if not hex
        assert result == {"host": "0.0.0.0", "port": 1933, "root_api_key": key}
        # The full key must be displayed to the user exactly once.
        output = "\n".join(
            " ".join(str(arg) for arg in call.args) for call in mock_print.call_args_list
        )
        assert key in output

    def test_remote_mode_empty_manual_key_cancels(self):
        with (
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[2, 2]),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=1933),
            patch("openviking_cli.setup_wizard._prompt_required_input", return_value=""),
            patch("builtins.print"),
        ):
            assert _wizard_server() is None


class TestServerWizardCurrentDefaults:
    CURRENT = {"host": "0.0.0.0", "port": 2044, "root_api_key": "k" * 64}

    def test_current_port_seeds_default(self):
        with (
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[1]),
            patch(
                "openviking_cli.setup_wizard._prompt_required_int", return_value=2044
            ) as mock_int,
            patch("builtins.print"),
        ):
            result = _wizard_server(current={"host": "127.0.0.1", "port": 2044})
        assert result == {"host": "127.0.0.1", "port": 2044}
        mock_int.assert_called_once_with("Port", default=2044)

    def test_remote_current_defaults_to_remote_and_keeps_key(self):
        with (
            # bind menu (defaults to Remote), key menu option 1 = Keep existing
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[2, 1]) as mock_choice,
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=2044),
            patch("builtins.print"),
        ):
            result = _wizard_server(current=self.CURRENT)

        assert result == self.CURRENT
        # Bind menu default seeded to Remote (2) because current host is 0.0.0.0.
        bind_call = mock_choice.call_args_list[0]
        assert bind_call.kwargs.get("default") == 2
        # Key menu offers "Keep existing key" as the first, default option.
        key_call = mock_choice.call_args_list[1]
        assert key_call.args[1][0][0] == "Keep existing key"

    def test_remote_current_can_rotate_key(self):
        with (
            # bind=Remote, key menu option 2 = Generate one for me (after Keep)
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[2, 2]),
            patch("openviking_cli.setup_wizard._prompt_required_int", return_value=2044),
            patch("builtins.print"),
        ):
            result = _wizard_server(current=self.CURRENT)

        assert result is not None
        assert result["root_api_key"] != self.CURRENT["root_api_key"]
        assert len(result["root_api_key"]) == 64


class TestCurrentConfigSeeding:
    def test_cloud_embedding_keeps_existing_key_and_model(self):
        from openviking_cli.setup_wizard import _prompt_cloud_embedding

        current = {
            "provider": "volcengine",
            "model": "doubao-embedding-vision-240000",
            "api_key": "old-key-1234567890",
            "api_base": CLOUD_PROVIDERS[0].default_api_base,
            "dimension": 2048,
        }
        with (
            # Provider menu -> VolcEngine, plan menu -> pay-as-you-go (matches current api_base)
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[1, 3]) as mock_choice,
            # Keep the existing API key? -> yes
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            # Model prompt returns its default (the current model)
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                side_effect=lambda prompt, default=None, **kw: default,
            ),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env") as mock_env_key,
            patch("builtins.print"),
        ):
            dense = _prompt_cloud_embedding(current=current)

        assert dense == current
        mock_env_key.assert_not_called()  # key kept, never re-prompted
        # Provider menu default seeded to the current provider, plan menu to
        # the plan matching the current endpoint.
        assert mock_choice.call_args_list[0].kwargs.get("default") == 1
        assert mock_choice.call_args_list[1].kwargs.get("default") == 3

    def test_vlm_option_index_mapping(self):
        from openviking_cli.setup_wizard import _vlm_option_index_for

        assert _vlm_option_index_for({"provider": "volcengine", "api_base": "https://ark.cn"}) == 1
        assert (
            _vlm_option_index_for(
                {"provider": "volcengine", "api_base": "https://ark.ap-southeast.bytepluses.com"}
            )
            == 2
        )
        assert (
            _vlm_option_index_for({"provider": "openai", "api_base": "https://api.openai.com/v1"})
            == 3
        )
        assert _vlm_option_index_for({"provider": "openai-codex"}) == 4
        assert _vlm_option_index_for({"provider": "kimi"}) == 5
        assert _vlm_option_index_for({"provider": "glm"}) == 6
        assert _vlm_option_index_for({"provider": "openai", "api_base": "https://my.proxy"}) == 7

    def test_run_init_menu_shows_current_values(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text(json.dumps(_existing_config()), encoding="utf-8")
        with (
            patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False),
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=5) as mock_choice,
            patch("builtins.print") as mock_print,
        ):
            assert run_init() == 0

        # Action menu descriptions carry the current values.
        options = mock_choice.call_args.args[1]
        labels = dict(options)
        assert "openai · old-vlm" in labels["Update VLM"]
        assert "local · bge-small-zh-v1.5-f16" in labels["Update embedding"]
        assert "127.0.0.1" in labels["Update server & auth"]
        # And the current-configuration block is printed above the menu.
        output = "\n".join(
            " ".join(str(arg) for arg in call.args) for call in mock_print.call_args_list
        )
        assert "Current configuration" in output

    def test_update_section_shows_change_diff(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text(json.dumps(_existing_config()), encoding="utf-8")
        new_vlm = {"provider": "kimi", "model": "kimi-code", "api_base": "https://new"}
        with (
            patch("openviking_cli.setup_wizard._prompt_cloud_vlm", return_value=(new_vlm, None)),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._post_save_actions", return_value=None),
            patch("builtins.print") as mock_print,
        ):
            assert _update_existing_config(config_path, "vlm") == 0

        output = "\n".join(
            " ".join(str(arg) for arg in call.args) for call in mock_print.call_args_list
        )
        assert "Change:" in output
        assert "openai · old-vlm" in output
        assert "kimi · kimi-code" in output


# ---------------------------------------------------------------------------
# VLM presets (qwen3.6 replaces qwen3.5 27B/35B)
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Size-hint parsing
# ---------------------------------------------------------------------------


class TestSizeParsing:
    def test_parses_gb(self):
        assert _parse_size_gb("~4.7 GB") == 4.7
        assert _parse_size_gb("~17 GB, 256K ctx") == 17.0

    def test_parses_mb(self):
        assert abs(_parse_size_gb("~639 MB") - 639 / 1024) < 1e-9

    def test_unparseable_returns_zero(self):
        assert _parse_size_gb("~0.8B, recommended") == 0.0
        assert _parse_size_gb("") == 0.0


# ---------------------------------------------------------------------------
# Setup navigation
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Query planner: skip when already configured
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Cloud "Other (manual)" routes to custom instead of cancelling
# ---------------------------------------------------------------------------


class TestCloudOtherRoutesToCustom:
    def test_run_init_exits_cleanly_on_custom_sentinel(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        with (
            patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False),
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=1),
            patch(
                "openviking_cli.setup_wizard._wizard_two_step",
                return_value=(_CUSTOM_SETUP, None),
            ),
            patch("openviking_cli.setup_wizard._write_config") as mock_write,
            patch("builtins.print"),
        ):
            assert run_init() == 0
        mock_write.assert_not_called()


# ---------------------------------------------------------------------------
# API key from environment variables
# ---------------------------------------------------------------------------


class TestEnvApiKey:
    def test_uses_env_var_when_confirmed_on_tty(self):
        with (
            patch.dict(os.environ, {"ARK_API_KEY": "env-key-1234567890"}, clear=False),
            patch("openviking_cli.setup_wizard._stdin_stdout_tty", return_value=True),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._prompt_api_key") as mock_prompt,
        ):
            value = _prompt_api_key_with_env(["ARK_API_KEY"])
        assert value == "env-key-1234567890"
        mock_prompt.assert_not_called()

    def test_falls_back_to_prompt_when_declined(self):
        with (
            patch.dict(os.environ, {"ARK_API_KEY": "env-key-1234567890"}, clear=False),
            patch("openviking_cli.setup_wizard._stdin_stdout_tty", return_value=True),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=False),
            patch("openviking_cli.setup_wizard._prompt_api_key", return_value="typed-key"),
        ):
            assert _prompt_api_key_with_env(["ARK_API_KEY"]) == "typed-key"

    def test_skips_env_shortcut_when_not_tty(self):
        with (
            patch.dict(os.environ, {"ARK_API_KEY": "env-key-1234567890"}, clear=False),
            patch("openviking_cli.setup_wizard._stdin_stdout_tty", return_value=False),
            patch("openviking_cli.setup_wizard._prompt_confirm") as mock_confirm,
            patch("openviking_cli.setup_wizard._prompt_api_key", return_value="typed-key"),
        ):
            assert _prompt_api_key_with_env(["ARK_API_KEY"]) == "typed-key"
        mock_confirm.assert_not_called()


# ---------------------------------------------------------------------------
# Partial reconfiguration of an existing config
# ---------------------------------------------------------------------------


def _existing_config() -> dict:
    return {
        "storage": {"workspace": "/tmp/ov"},
        "embedding": {"dense": {"provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512}},
        "vlm": {"provider": "openai", "model": "old-vlm", "api_base": "https://old"},
        "server": {"host": "127.0.0.1"},
    }


class TestPartialUpdate:
    def test_update_vlm_only(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text(json.dumps(_existing_config()), encoding="utf-8")
        new_vlm = {"provider": "kimi", "model": "kimi-code", "api_base": "https://new"}

        with (
            patch("openviking_cli.setup_wizard._prompt_cloud_vlm", return_value=(new_vlm, None)),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._post_save_actions", return_value=None),
            patch("builtins.print"),
        ):
            assert _update_existing_config(config_path, "vlm") == 0

        data = json.loads(config_path.read_text(encoding="utf-8"))
        assert data["vlm"] == new_vlm
        assert data["embedding"] == _existing_config()["embedding"]  # untouched
        assert (tmp_path / "ov.conf.bak").exists()  # old config backed up

    def test_update_server_only(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        original = _existing_config()
        original["server"].update(
            {"auth_mode": "trusted", "workers": 4, "temp_upload": {"default_mode": "shared"}}
        )
        config_path.write_text(json.dumps(original), encoding="utf-8")

        with (
            patch(
                "openviking_cli.setup_wizard._wizard_server",
                return_value={"host": "0.0.0.0", "root_api_key": "rk"},
            ),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._post_save_actions", return_value=None),
            patch("builtins.print"),
        ):
            assert _update_existing_config(config_path, "server") == 0

        data = json.loads(config_path.read_text(encoding="utf-8"))
        assert data["server"] == {
            "host": "0.0.0.0",
            "root_api_key": "rk",
            "auth_mode": "trusted",
            "workers": 4,
            "temp_upload": {"default_mode": "shared"},
        }
        assert data["vlm"] == _existing_config()["vlm"]

    def test_update_server_local_removes_root_key_only(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        original = _existing_config()
        original["server"].update({"auth_mode": "api_key", "root_api_key": "rk", "workers": 4})
        config_path.write_text(json.dumps(original), encoding="utf-8")

        with (
            patch(
                "openviking_cli.setup_wizard._wizard_server",
                return_value={"host": "127.0.0.1", "port": 1933},
            ),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._post_save_actions", return_value=None),
            patch("builtins.print"),
        ):
            assert _update_existing_config(config_path, "server") == 0

        assert json.loads(config_path.read_text())["server"] == {
            "host": "127.0.0.1",
            "port": 1933,
            "workers": 4,
        }

    def test_embedding_dimension_change_requires_confirmation(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        original = _existing_config()
        config_path.write_text(json.dumps(original), encoding="utf-8")
        new_dense = {"provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512}

        with (
            patch(
                "openviking_cli.setup_wizard._prompt_embedding_flow",
                return_value=(new_dense, None),
            ),
            # Decline the dimension-change warning → nothing written.
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=False),
            patch("builtins.print"),
        ):
            assert _update_existing_config(config_path, "embedding") == 0

        assert json.loads(config_path.read_text(encoding="utf-8")) == original

    def test_unreadable_config_returns_error(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text("{not json", encoding="utf-8")
        with patch("builtins.print"):
            assert _update_existing_config(config_path, "vlm") == 1


class TestRunInitExistingConfigMenu:
    def test_dispatches_partial_update(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config_path.write_text(json.dumps(_existing_config()), encoding="utf-8")
        with (
            patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False),
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=2),
            patch(
                "openviking_cli.setup_wizard._update_existing_config", return_value=0
            ) as mock_update,
            patch("builtins.print"),
        ):
            assert run_init() == 0
        mock_update.assert_called_once_with(config_path, "vlm")

    def test_cancel_leaves_config_untouched(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        original = json.dumps(_existing_config())
        config_path.write_text(original, encoding="utf-8")
        with (
            patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False),
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=5),
            patch("builtins.print"),
        ):
            assert run_init() == 0
        assert config_path.read_text(encoding="utf-8") == original


# ---------------------------------------------------------------------------
# Two-step setup: embedding and VLM chosen independently
# ---------------------------------------------------------------------------


class TestTwoStepWizard:
    def test_mixed_local_embedding_codex_vlm(self):
        dense = {"provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512}
        with (
            patch(
                "openviking_cli.setup_wizard._prompt_embedding_flow",
                return_value=(dense, None),
            ),
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=4),
            patch("openviking_cli.setup_wizard._ensure_codex_auth", return_value=True),
            patch("builtins.input", return_value=""),
            patch("builtins.print"),
        ):
            config, local_ready = _wizard_two_step()

        assert config is not None
        assert config["embedding"]["dense"] == dense
        assert config["vlm"] == {
            "provider": "openai-codex",
            "model": "gpt-5.6-terra",
            "api_base": "https://chatgpt.com/backend-api/codex",
            "temperature": 0.0,
            "max_retries": 2,
        }
        assert config["storage"]["workspace"] == _workspace_path()
        assert local_ready is None

    def test_skip_vlm_produces_embedding_only_config(self):
        dense = {"provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512}
        with (
            patch(
                "openviking_cli.setup_wizard._prompt_embedding_flow",
                return_value=(dense, None),
            ),
            patch(
                "openviking_cli.setup_wizard._prompt_cloud_vlm",
                return_value=(_SKIP_VLM, None),
            ),
            patch("builtins.print"),
        ):
            config, _ = _wizard_two_step()

        assert config is not None
        assert config["embedding"]["dense"] == dense
        assert "vlm" not in config

    def test_embedding_key_offered_for_vlm_reuse(self):
        dense = {
            "provider": "volcengine",
            "model": "doubao-embedding-vision-251215",
            "api_key": "ve-key",
            "dimension": 1024,
        }
        with (
            patch(
                "openviking_cli.setup_wizard._prompt_embedding_flow",
                return_value=(dense, None),
            ),
            patch(
                "openviking_cli.setup_wizard._prompt_cloud_vlm",
                return_value=({"provider": "volcengine", "model": "m"}, None),
            ) as mock_vlm,
            patch("builtins.print"),
        ):
            _wizard_two_step()

        mock_vlm.assert_called_once_with(
            allow_skip=True, reuse_key=("volcengine", "ve-key"), allow_back=True, plan_seed=None
        )

    def test_cancel_in_vlm_step_cancels_setup(self):
        dense = {"provider": "openai", "model": "text-embedding-3-small", "dimension": 1536}
        with (
            patch(
                "openviking_cli.setup_wizard._prompt_embedding_flow",
                return_value=(dense, None),
            ),
            patch("openviking_cli.setup_wizard._prompt_cloud_vlm", return_value=(None, None)),
            patch("builtins.print"),
        ):
            config, _ = _wizard_two_step()
        assert config is None


class TestVLMKeyReuse:
    def test_reuse_accepted_skips_key_prompt(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        with (
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=3),  # OpenAI
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                return_value="gpt-5.4",
            ),
            patch("openviking_cli.setup_wizard._prompt_api_key_with_env") as mock_key,
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm(reuse_key=("openai", "shared-key"))

        assert vlm_config["api_key"] == "shared-key"
        mock_key.assert_not_called()

    def test_different_provider_prompts_normally(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        with (
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=3),  # OpenAI
            patch("openviking_cli.setup_wizard._prompt_confirm") as mock_confirm,
            patch(
                "openviking_cli.setup_wizard._prompt_required_input",
                return_value="gpt-5.4",
            ),
            patch(
                "openviking_cli.setup_wizard._prompt_api_key_with_env",
                return_value="typed-key",
            ),
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm(reuse_key=("volcengine", "other-key"))

        assert vlm_config["api_key"] == "typed-key"
        mock_confirm.assert_not_called()


# ---------------------------------------------------------------------------
# Back navigation (← / [0] Back)
# ---------------------------------------------------------------------------


class TestBackNavigation:
    def test_numbered_fallback_accepts_zero_as_back(self):
        from openviking_cli.setup_wizard import _prompt_choice_numbered

        with patch("builtins.input", return_value="0"), patch("builtins.print"):
            assert _prompt_choice_numbered("Q:", [("A", ""), ("B", "")], allow_back=True) == 0

    def test_numbered_fallback_rejects_zero_without_back(self):
        with patch("builtins.input", side_effect=["0", "2"]), patch("builtins.print"):
            from openviking_cli.setup_wizard import _prompt_choice_numbered

            assert _prompt_choice_numbered("Q:", [("A", ""), ("B", "")]) == 2

    def test_embedding_flow_backs_out_of_backend_menu(self):
        with (
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=0),
            patch("builtins.print"),
        ):
            from openviking_cli.setup_wizard import _prompt_embedding_flow

            dense, _ = _prompt_embedding_flow(allow_back=True)
        assert dense is _GO_BACK

    def test_vlm_menu_backs_out(self):
        from openviking_cli.setup_wizard import _prompt_cloud_vlm

        with (
            patch("openviking_cli.setup_wizard._prompt_choice", return_value=0),
            patch("builtins.print"),
        ):
            vlm_config, _ = _prompt_cloud_vlm(allow_back=True)
        assert vlm_config is _GO_BACK

    def test_two_step_back_from_vlm_reruns_embedding(self):
        dense1 = {"provider": "local", "model": "first", "dimension": 1024}
        dense2 = {"provider": "local", "model": "second", "dimension": 1024}
        with (
            patch(
                "openviking_cli.setup_wizard._prompt_embedding_flow",
                side_effect=[(dense1, None), (dense2, None)],
            ),
            patch(
                "openviking_cli.setup_wizard._prompt_cloud_vlm",
                side_effect=[(_GO_BACK, None), (_SKIP_VLM, None)],
            ),
            patch("builtins.print"),
        ):
            config, _ = _wizard_two_step()

        assert config is not None
        assert config["embedding"]["dense"] == dense2

    def test_run_init_back_from_two_step_reshows_mode_menu(self, tmp_path):
        config_path = tmp_path / "ov.conf"
        config = _build_test_config(str(tmp_path / "data"))
        with (
            patch.dict(os.environ, {"OPENVIKING_CONFIG_FILE": str(config_path)}, clear=False),
            patch("openviking_cli.setup_wizard._prompt_choice", side_effect=[1, 1]),
            patch("openviking_cli.setup_wizard._wizard_two_step",
                  side_effect=[(_GO_BACK, None), (config, None)]),
            patch("openviking_cli.setup_wizard._wizard_server", return_value={"host": "127.0.0.1"}),
            patch("openviking_cli.setup_wizard._prompt_confirm", return_value=True),
            patch("openviking_cli.setup_wizard._write_config", return_value=True) as mock_write,
            patch("openviking_cli.setup_wizard._post_save_actions", return_value=None),
            patch("builtins.print"),
        ):
            assert run_init() == 0
        mock_write.assert_called_once()


def _build_test_config(workspace):
    return {
        "storage": {"workspace": workspace},
        "embedding": {"dense": {"provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512}},
        "vlm": {"provider": "openai", "model": "test-model", "api_base": "http://localhost:8080/v1", "api_key": "test-key"},
    }
