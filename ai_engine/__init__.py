"""AI Engine module for legal case analysis."""

from .models import (
    AIConfig,
    CaseContext,
    StrengthAnalysis,
    Message,
    DocumentType,
    AIEngineError,
    ModelUnavailableError,
    RateLimitError,
    InvalidResponseError,
    ConfigurationError,
)
from .engine import AIEngine
from .config import ConfigLoader
from .clients import BaseModelClient, ClaudeAPIClient, LocalModelClient, FeatherlessClient, ModelRouter

__all__ = [
    "AIConfig",
    "CaseContext",
    "StrengthAnalysis",
    "Message",
    "DocumentType",
    "AIEngineError",
    "ModelUnavailableError",
    "RateLimitError",
    "InvalidResponseError",
    "ConfigurationError",
    "AIEngine",
    "ConfigLoader",
    "BaseModelClient",
    "ClaudeAPIClient",
    "FeatherlessClient",
    "LocalModelClient",
    "ModelRouter",
]
