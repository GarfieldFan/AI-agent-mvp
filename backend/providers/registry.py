"""Provider selection — the one place that knows how to turn a provider
name into a live `ChatProvider`/`EmbeddingProvider` instance. Callers
(backend/apis/chat.py, rag.py, agent.py's vision call) should go through
`get_chat_provider`/`get_embedding_provider`, never import a concrete
provider class directly, so switching the default is a one-line env var
change rather than a code change anywhere that uses it.
"""

import os

from providers.anthropic import AnthropicChatProvider
from providers.base import ChatProvider, EmbeddingProvider, ProviderNotConfigured
from providers.gemini import GeminiChatProvider, GeminiEmbeddingProvider
from providers.ollama import OllamaChatProvider, OllamaEmbeddingProvider
from providers.openai import OpenAIChatProvider, OpenAIEmbeddingProvider

DEFAULT_CHAT_PROVIDER = os.environ.get("CHAT_PROVIDER", "ollama")
DEFAULT_EMBEDDING_PROVIDER = os.environ.get("EMBEDDING_PROVIDER", "ollama")

_CHAT_PROVIDERS = {
    "ollama": OllamaChatProvider,
    "openai": OpenAIChatProvider,
    "anthropic": AnthropicChatProvider,
    "gemini": GeminiChatProvider,
}

_EMBEDDING_PROVIDERS = {
    "ollama": OllamaEmbeddingProvider,
    "openai": OpenAIEmbeddingProvider,
    "gemini": GeminiEmbeddingProvider,
    # No "anthropic" here on purpose — see providers/anthropic.py's
    # docstring, they don't offer an embeddings API to wrap.
}


def get_chat_provider(name: str | None = None, model: str | None = None) -> ChatProvider:
    key = name or DEFAULT_CHAT_PROVIDER
    try:
        cls = _CHAT_PROVIDERS[key]
    except KeyError:
        raise ValueError(f"Unknown chat provider {key!r}. Valid: {sorted(_CHAT_PROVIDERS)}")
    return cls(model=model) if model else cls()


def default_chat_model(name: str | None = None) -> str:
    """The model a provider falls back to when no explicit model override
    is given — i.e. its own env-var-driven default. Used by
    apis/model_settings.py to show what's currently active before an
    owner has picked anything explicitly."""
    return get_chat_provider(name).model  # type: ignore[attr-defined]


def get_embedding_provider(name: str | None = None, model: str | None = None) -> EmbeddingProvider:
    key = name or DEFAULT_EMBEDDING_PROVIDER
    try:
        cls = _EMBEDDING_PROVIDERS[key]
    except KeyError:
        raise ValueError(
            f"Unknown or unsupported embedding provider {key!r}. "
            f"Valid: {sorted(_EMBEDDING_PROVIDERS)} (anthropic has no embeddings API)."
        )
    return cls(model=model) if model else cls()


def default_embedding_model(name: str | None = None) -> str:
    """Same idea as default_chat_model, for the embedding side."""
    return get_embedding_provider(name).model  # type: ignore[attr-defined]


__all__ = [
    "get_chat_provider",
    "get_embedding_provider",
    "default_chat_model",
    "default_embedding_model",
    "ProviderNotConfigured",
]
