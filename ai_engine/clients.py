"""Model client interfaces and implementations."""

from abc import ABC, abstractmethod
from typing import Optional
import time
from .models import (
    AIConfig,
    AIEngineError,
    ModelUnavailableError,
    RateLimitError,
)


class BaseModelClient(ABC):
    """Abstract base class for AI model clients."""
    
    @abstractmethod
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        Get completion from AI model.
        
        Args:
            prompt: User prompt
            system_prompt: Optional system instructions
            
        Returns:
            Model response text
            
        Raises:
            AIEngineError: If model call fails
        """
        pass


class ClaudeAPIClient(BaseModelClient):
    """Client for Anthropic Claude API."""
    
    def __init__(self, config: AIConfig):
        """
        Initialize Claude API client.
        
        Args:
            config: AI configuration with API key and model settings
        """
        self.config = config
        try:
            from anthropic import Anthropic
            self.client = Anthropic(api_key=config.api_key)
        except ImportError:
            raise ModelUnavailableError(
                "Anthropic SDK not installed. Install with: pip install anthropic"
            )
        except Exception as e:
            raise ModelUnavailableError(f"Failed to initialize Claude client: {str(e)}")
    
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        Generate completion using Claude API with retry logic.
        
        Args:
            prompt: User prompt
            system_prompt: Optional system instructions
            
        Returns:
            Model response text
            
        Raises:
            RateLimitError: If API rate limits are exceeded
            ModelUnavailableError: If model is unavailable or authentication fails
            AIEngineError: For other API errors
        """
        max_retries = 3
        retry_delay = 1  # seconds
        
        for attempt in range(max_retries):
            try:
                message = self.client.messages.create(
                    model=self.config.model_name,
                    max_tokens=self.config.max_tokens,
                    temperature=self.config.temperature,
                    system=system_prompt or "You are a helpful legal analysis assistant.",
                    messages=[
                        {"role": "user", "content": prompt}
                    ]
                )
                return message.content[0].text
                
            except Exception as e:
                error_str = str(e).lower()
                
                # Check for rate limit errors
                if "rate limit" in error_str or "429" in error_str:
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                        continue
                    raise RateLimitError(
                        "API rate limit exceeded. Please try again later."
                    )
                
                # Check for authentication errors
                if "authentication" in error_str or "401" in error_str or "api key" in error_str:
                    raise ModelUnavailableError(
                        "Invalid API credentials. Please check your ANTHROPIC_API_KEY."
                    )
                
                # Check for connection/timeout errors
                if any(keyword in error_str for keyword in ["connection", "timeout", "network"]):
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                        continue
                    raise ModelUnavailableError(
                        "AI model is currently unavailable. Please try again later."
                    )
                
                # For other errors, retry transient failures
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    continue
                
                # Final attempt failed
                raise AIEngineError(f"Claude API error: {str(e)}")



class LocalModelClient(BaseModelClient):
    """Client for locally-hosted AI models."""
    
    def __init__(self, config: AIConfig):
        """
        Initialize local model client.
        
        Supports both llama.cpp (.gguf files) and transformers library.
        
        Args:
            config: AI configuration with model path and settings
        """
        self.config = config
        self.model = None
        self.tokenizer = None
        
        try:
            # Option 1: llama.cpp for efficient inference with GGUF models
            if config.local_model_path and config.local_model_path.endswith(".gguf"):
                try:
                    from llama_cpp import Llama
                    self.model = Llama(
                        model_path=config.local_model_path,
                        n_ctx=config.max_tokens,
                        n_threads=8
                    )
                    self.model_type = "llama_cpp"
                except ImportError:
                    raise ModelUnavailableError(
                        "llama-cpp-python not installed. Install with: pip install llama-cpp-python"
                    )
            
            # Option 2: transformers for broader model support
            else:
                try:
                    from transformers import AutoModelForCausalLM, AutoTokenizer
                    self.tokenizer = AutoTokenizer.from_pretrained(config.model_name)
                    self.model = AutoModelForCausalLM.from_pretrained(
                        config.model_name,
                        device_map="auto"
                    )
                    self.model_type = "transformers"
                except ImportError:
                    raise ModelUnavailableError(
                        "transformers not installed. Install with: pip install transformers torch"
                    )
                    
        except Exception as e:
            if isinstance(e, ModelUnavailableError):
                raise
            raise ModelUnavailableError(f"Failed to initialize local model: {str(e)}")
    
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        Generate completion using local model.
        
        Args:
            prompt: User prompt
            system_prompt: Optional system instructions
            
        Returns:
            Model response text
            
        Raises:
            ModelUnavailableError: If model is unavailable
            AIEngineError: For other errors
        """
        try:
            full_prompt = self._format_prompt(prompt, system_prompt)
            
            if self.model_type == "llama_cpp":
                # llama.cpp path
                response = self.model(
                    full_prompt,
                    max_tokens=self.config.max_tokens,
                    temperature=self.config.temperature
                )
                return response["choices"][0]["text"]
            
            elif self.model_type == "transformers":
                # transformers path
                inputs = self.tokenizer(full_prompt, return_tensors="pt")
                outputs = self.model.generate(
                    **inputs,
                    max_new_tokens=self.config.max_tokens,
                    temperature=self.config.temperature,
                    do_sample=True
                )
                response = self.tokenizer.decode(outputs[0], skip_special_tokens=True)
                # Remove the prompt from the response
                return response[len(full_prompt):].strip()
            
            else:
                raise AIEngineError("Unknown model type")
                
        except Exception as e:
            if isinstance(e, (ModelUnavailableError, AIEngineError)):
                raise
            raise AIEngineError(f"Local model error: {str(e)}")
    
    def _format_prompt(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        Format prompt with system instructions.
        
        Args:
            prompt: User prompt
            system_prompt: Optional system instructions
            
        Returns:
            Formatted prompt string
        """
        if system_prompt:
            return f"{system_prompt}\n\n{prompt}"
        return prompt


class FeatherlessClient(BaseModelClient):
    """Client for Featherless API inference."""
    
    BASE_URL = "https://api.featherless.ai/v1"
    
    def __init__(self, config: AIConfig):
        """
        Initialize Featherless API client.
        
        Args:
            config: AI configuration with API key and model settings
        """
        self.config = config
        try:
            from openai import OpenAI
            self.client = OpenAI(
                api_key=config.api_key,
                base_url=self.BASE_URL
            )
        except ImportError:
            raise ModelUnavailableError(
                "OpenAI SDK not installed. Install with: pip install openai"
            )
        except Exception as e:
            raise ModelUnavailableError(f"Failed to initialize Featherless client: {str(e)}")
    
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        Generate completion using Featherless API with retry logic.
        
        Args:
            prompt: User prompt
            system_prompt: Optional system instructions
            
        Returns:
            Model response text
            
        Raises:
            RateLimitError: If API rate limits are exceeded
            ModelUnavailableError: If model is unavailable or authentication fails
            AIEngineError: For other API errors
        """
        max_retries = 3
        retry_delay = 1  # seconds
        
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        
        for attempt in range(max_retries):
            try:
                response = self.client.chat.completions.create(
                    model=self.config.model_name,
                    messages=messages,
                    max_tokens=self.config.max_tokens,
                    temperature=self.config.temperature
                )
                return response.choices[0].message.content
                
            except Exception as e:
                error_str = str(e).lower()
                
                # Check for rate limit errors
                if "rate limit" in error_str or "429" in error_str:
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                        continue
                    raise RateLimitError(
                        "Featherless API rate limit exceeded. Please try again later."
                    )
                
                # Check for authentication errors
                if "authentication" in error_str or "401" in error_str or "api key" in error_str:
                    raise ModelUnavailableError(
                        "Invalid Featherless API credentials. Please check your FEATHERLESS_API_KEY."
                    )
                
                # Check for connection/timeout errors
                if any(keyword in error_str for keyword in ["connection", "timeout", "network"]):
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                        continue
                    raise ModelUnavailableError(
                        "Featherless API is currently unavailable. Please try again later."
                    )
                
                # For other errors, retry transient failures
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    continue
                
                # Final attempt failed
                raise AIEngineError(f"Featherless API error: {str(e)}")


class ModelRouter:
    """Routes AI requests to appropriate model client based on configuration."""
    
    def __init__(self, config: AIConfig):
        """
        Initialize model router with configuration.
        
        Selects and instantiates the appropriate client based on configuration:
        - Featherless API if use_featherless=True
        - Local model if use_local=True
        - Anthropic Claude otherwise
        
        Args:
            config: AI configuration specifying mode and model settings
        """
        self.config = config
        
        if config.use_featherless:
            self.client = FeatherlessClient(config)
        elif config.use_local:
            self.client = LocalModelClient(config)
        else:
            self.client = ClaudeAPIClient(config)
    
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        Get completion from configured model.
        
        Delegates to the selected client (local or cloud) based on configuration.
        
        Args:
            prompt: User prompt
            system_prompt: Optional system instructions
            
        Returns:
            Model response text
            
        Raises:
            AIEngineError: If model call fails
        """
        return self.client.complete(prompt, system_prompt)
