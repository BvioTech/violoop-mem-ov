"""OpenAI embedding configuration and request regression checks."""

from unittest.mock import MagicMock, patch

from openviking_cli.utils.config.embedding_config import EmbeddingConfig, EmbeddingModelConfig


@patch("openai.OpenAI")
def test_openai_factory_preserves_input_limit_without_sending_output_token_parameter(mock_openai):
    client = mock_openai.return_value
    client.embeddings.create.return_value = MagicMock(
        data=[MagicMock(embedding=[0.1] * 8)], usage=None
    )
    config = EmbeddingConfig(
        dense=EmbeddingModelConfig(
            provider="openai",
            model="text-embedding-3-small",
            api_key="sk-test",
            dimension=1536,
        ),
        max_input_tokens=1000,
    )
    embedder = config.get_embedder()
    assert embedder.config["max_input_tokens"] == 1000
    embedder.embed("hello")
    sent = client.embeddings.create.call_args.kwargs
    assert sent["model"] == "text-embedding-3-small"
    assert sent["input"] == "hello"
    assert "max_tokens" not in sent
