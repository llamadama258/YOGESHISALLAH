"""Configuration loader for AI Engine."""

import os
from .models import AIConfig, ConfigurationError


class ConfigLoader:
    """Loads AI Engine configuration from environment variables."""
    
    @staticmethod
    def load_config() -> AIConfig:
        """
        Load AI configuration from environment variables.
        
        Environment variables:
        - USE_LOCAL: "true" for local mode, "false" for cloud mode
        - LOCAL_MODEL_NAME: Name of local model (e.g., "llama-3-70b")
        - LOCAL_MODEL_PATH: Path to local model file (e.g., "./models/model.gguf")
        - ANTHROPIC_API_KEY: API key for Claude (required in cloud mode)
        - CLAUDE_MODEL: Claude model name (default: "claude-3-5-sonnet-20241022")
        - MAX_TOKENS: Maximum tokens for generation (default: 4096)
        - TEMPERATURE: Temperature for generation (default: 0.7)
        
        Returns:
            AIConfig object with loaded configuration
            
        Raises:
            ConfigurationError: If required configuration is missing or invalid
        """
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
        
        if use_local:
            # Local inference mode configuration
            model_name = os.getenv("LOCAL_MODEL_NAME", "llama-3-70b")
            local_model_path = os.getenv("LOCAL_MODEL_PATH", "./models/model.gguf")
            
            return AIConfig(
                use_local=True,
                model_name=model_name,
                api_key=None,
                local_model_path=local_model_path,
                max_tokens=max_tokens,
                temperature=temperature
            )
        else:
            # Cloud API mode configuration
            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                raise ConfigurationError(
                    "ANTHROPIC_API_KEY is required when USE_LOCAL is false. "
                    "Please set the ANTHROPIC_API_KEY environment variable."
                )
            
            model_name = os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-20241022")
            
            return AIConfig(
                use_local=False,
                model_name=model_name,
                api_key=api_key,
                local_model_path=None,
                max_tokens=max_tokens,
                temperature=temperature
            )
