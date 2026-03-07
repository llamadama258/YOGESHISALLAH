"""Data models and exceptions for AI Engine."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional


# Exception classes
class AIEngineError(Exception):
    """Base exception for AI Engine errors."""
    pass


class ModelUnavailableError(AIEngineError):
    """Raised when AI model cannot be accessed."""
    pass


class RateLimitError(AIEngineError):
    """Raised when API rate limits are exceeded."""
    pass


class InvalidResponseError(AIEngineError):
    """Raised when AI response cannot be parsed."""
    pass


class ConfigurationError(AIEngineError):
    """Raised when configuration is invalid or incomplete."""
    pass


# Enums
class DocumentType(Enum):
    """Types of legal documents that can be generated."""
    DEMAND_LETTER = "demand_letter"
    COMPLAINT = "complaint"
    EMAIL_SEQUENCE = "email_sequence"


# Data classes
@dataclass
class TimelineEvent:
    """Event in case timeline."""
    date: str
    description: str


@dataclass
class CaseContext:
    """Complete case information for AI analysis."""
    facts: str
    evidence: List[str]
    jurisdiction: str
    legal_theories: List[str]
    defendant: str
    damages_sought: Optional[str] = None
    timeline: Optional[List[TimelineEvent]] = None


@dataclass
class StrengthAnalysis:
    """Result of case strength analysis."""
    overall_score: float  # 0-100
    evidence_strength: float  # 0-100
    legal_merit: float  # 0-100
    win_probability: float  # 0-100
    reasoning: str
    strengths: List[str]
    weaknesses: List[str]


@dataclass
class AIConfig:
    """Configuration for AI Engine."""
    use_local: bool
    model_name: str  # e.g., "claude-3-5-sonnet" or "llama-3-70b"
    api_key: Optional[str] = None
    local_model_path: Optional[str] = None
    max_tokens: int = 4096
    temperature: float = 0.7


@dataclass
class Message:
    """Chat message."""
    role: str  # "user" or "assistant"
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
