"""Configuration loader for AI Engine."""

import os
from pathlib import Path
from .models import AIConfig, ConfigurationError


class ConfigLoader:
    """Loads AI Engine configuration from environment variables and .env file."""
    
    @staticmethod
    def _load_env_file():
        """Load .env file if it exists."""
        env_path = Path(".env")
        if env_path.exists():
            try:
                from dotenv import load_dotenv
                load_dotenv(env_path)
            except ImportError:
                # If python-dotenv is not installed, fall back to manual parsing
                with open(env_path) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key, value = line.split("=", 1)
                            os.environ.setdefault(key.strip(), value.strip())
    
    @staticmethod
    def load_config() -> AIConfig:
        """
        Load AI configuration from .env file and environment variables.
        
        Environment variables:
        - USE_FEATHERLESS: "true" for Featherless API, "false" otherwise
        - FEATHERLESS_API_KEY: API key for Featherless (required if USE_FEATHERLESS=true)
        - FEATHERLESS_MODEL: Model name for Featherless (default: "llama-3-8b-instruct")
        - USE_LOCAL: "true" for local mode, "false" for cloud mode
        - LOCAL_MODEL_NAME: Name of local model (e.g., "llama-3-70b")
        - LOCAL_MODEL_PATH: Path to local model file (e.g., "./models/model.gguf")
        - ANTHROPIC_API_KEY: API key for Claude (required if not using Featherless/local)
        - CLAUDE_MODEL: Claude model name (default: "claude-3-5-sonnet-20241022")
        - MAX_TOKENS: Maximum tokens for generation (default: 4096)
        - TEMPERATURE: Temperature for generation (default: 0.7)
        
        Returns:
            AIConfig object with loaded configuration
            
        Raises:
            ConfigurationError: If required configuration is missing or invalid
        """
        # Load .env file first
        ConfigLoader._load_env_file()
        
        # Check for Featherless first
        use_featherless_str = os.getenv("USE_FEATHERLESS", "false").lower()
        use_featherless = use_featherless_str == "true"
        
        use_local_str = os.getenv("USE_LOCAL", "false").lower()
        use_local = use_local_str == "true"
        
        # Load common configuration
        try:
            max_tokens = int(os.getenv("MAX_TOKENS", "4096"))
        except ValueError:
            raise ConfigurationError("MAX_TOKENS must be a valid integer")
        
        try:
            temperature = float(os.getenv("TEMPERATURE", "0.7"))
        except ValueError:
            raise ConfigurationError("TEMPERATURE must be a valid float")
        
        # Priority: Featherless > Local > Anthropic Claude
        if use_featherless:
            # Featherless API mode configuration
            api_key = os.getenv("FEATHERLESS_API_KEY")
            if not api_key:
                raise ConfigurationError(
                    "FEATHERLESS_API_KEY is required when USE_FEATHERLESS is true. "
                    "Please set the FEATHERLESS_API_KEY environment variable in .env file."
                )
            
            model_name = os.getenv("FEATHERLESS_MODEL", "llama-3-8b-instruct")
            
            return AIConfig(
                use_featherless=True,
                use_local=False,
                model_name=model_name,
                api_key=api_key,
                local_model_path=None,
                max_tokens=max_tokens,
                temperature=temperature
            )
        
        elif use_local:
            # Local inference mode configuration
            model_name = os.getenv("LOCAL_MODEL_NAME", "llama-3-70b")
            local_model_path = os.getenv("LOCAL_MODEL_PATH", "./models/model.gguf")
            
            return AIConfig(
                use_featherless=False,
                use_local=True,
                model_name=model_name,
                api_key=None,
                local_model_path=local_model_path,
                max_tokens=max_tokens,
                temperature=temperature
            )
        else:
            # Cloud API mode configuration (Anthropic Claude)
            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                raise ConfigurationError(
                    "ANTHROPIC_API_KEY is required when USE_FEATHERLESS and USE_LOCAL are false. "
                    "Please set the ANTHROPIC_API_KEY environment variable."
                )
            
            model_name = os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-20241022")
            
            return AIConfig(
                use_featherless=False,
                use_local=False,
                model_name=model_name,
                api_key=api_key,
                local_model_path=None,
                max_tokens=max_tokens,
                temperature=temperature
            )
