"""Behavioral boundaries for the device-oriented memory service."""
from pathlib import Path

import pytest

from openviking_cli.utils.config.embedding_config import EmbeddingConfig, EmbeddingModelConfig
from openviking_cli.utils.config.vectordb_config import VectorDBBackendConfig
from openviking.models.vlm.backends.litellm_vlm import LiteLLMVLMProvider


@pytest.mark.parametrize("provider", ["gemini", "ollama"])
def test_removed_direct_embedding_providers_are_rejected(provider):
    with pytest.raises(ValueError):
        EmbeddingModelConfig(provider=provider, model="test", dimension=1024, api_key="test")


@pytest.mark.parametrize("model", ["ollama/test", "ollama_chat/test", "gemini/test"])
def test_removed_litellm_embedding_routes_are_rejected(model):
    config = EmbeddingModelConfig(provider="litellm", model=model, dimension=1024, api_key="test")
    with pytest.raises(ValueError, match="not supported"):
        EmbeddingConfig(dense=config).get_embedder()


def test_removed_gpu_backend_is_rejected():
    with pytest.raises(ValueError, match="Invalid VectorDB backend"):
        VectorDBBackendConfig(backend="cuvs")


@pytest.mark.parametrize("config", [
    {"provider": "ollama", "model": "test"},
    {"provider": "litellm", "model": "ollama/test"},
    {"provider": "litellm", "model": "ollama_chat/test"},
])
def test_removed_ollama_vlm_routes_are_rejected(config):
    with pytest.raises(ValueError, match="not supported"):
        provider = LiteLLMVLMProvider(config)
        provider._resolve_model(config["model"])


def test_memory_training_and_link_utilities_remain_importable():
    from openviking.session.memory.utils.memory_file_utils import MemoryFileUtils
    from openviking.session.memory.utils.link_renderer import LinkRenderer
    from openviking.session.train.components.snapshotter import ContentHashPolicySnapshotter
    from openviking.eval.recorder import IORecord

    assert all((MemoryFileUtils, LinkRenderer, ContentHashPolicySnapshotter, IORecord))
