"""The managed service can publish language changes without restarting the engine."""
from types import SimpleNamespace

import pytest

from openviking.config.binding import manager_over_source
from openviking.config.scope import ConfigScope
from openviking.config.source import MemoryConfigSource
from openviking.config.validate import ConfigPatchError, validate_patch
from openviking.message import TextPart
from openviking.session.memory.session_extract_context_provider import SessionExtractContextProvider
from openviking.session.memory.utils.language import resolve_output_language_from_text
from openviking_cli.utils.config import get_openviking_config
from openviking_cli.utils.config.open_viking_config import OpenVikingConfig, OpenVikingConfigSingleton


@pytest.mark.asyncio
async def test_runtime_language_overrides_conversation_and_survives_manager_reload(monkeypatch):
    base = OpenVikingConfig.from_dict({})
    source = MemoryConfigSource()
    monkeypatch.setattr(OpenVikingConfigSingleton, "_instance", base)
    manager = manager_over_source(source, base_config=base)
    await manager.initialize()
    try:
        await manager.patch_cluster({"output_language_override": "en"})
        assert resolve_output_language_from_text("请记住我喜欢简短的回答") == "en"
        english = SessionExtractContextProvider([
            SimpleNamespace(role="user", parts=[TextPart("请记住我喜欢简短的回答")])
        ])
        assert "All memory content MUST be written in en." in english.instruction()

        await manager.patch_cluster({"output_language_override": "ja-JP"})
        japanese = SessionExtractContextProvider([
            SimpleNamespace(role="user", parts=[TextPart("I prefer short answers.")])
        ])
        assert "All memory content MUST be written in ja-JP." in japanese.instruction()
        # A provider already created for an extraction keeps its language.
        assert "All memory content MUST be written in en." in english.instruction()
        assert (await source.load(ConfigScope.cluster()))["output_language_override"] == "ja-JP"

        await manager.stop_refresh_loop()
        manager = manager_over_source(source, base_config=base)
        await manager.initialize()
        assert get_openviking_config().output_language_override == "ja-JP"
        await manager.patch_cluster({"output_language_override": ""})
        assert resolve_output_language_from_text("请记住我喜欢简短的回答") == "zh-CN"
        # Runtime language support must not accidentally open model credentials.
        with pytest.raises(ConfigPatchError):
            validate_patch(OpenVikingConfig, {"vlm": {"api_key": "not-allowed"}})
    finally:
        await manager.stop_refresh_loop()
