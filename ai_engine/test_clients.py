"""Unit tests for model clients."""

import pytest
import sys
from unittest.mock import Mock, patch, MagicMock
from ai_engine.models import (
    AIConfig,
    RateLimitError,
    ModelUnavailableError,
    AIEngineError,
)


@pytest.fixture
def claude_config():
    """Create test configuration for Claude API."""
    return AIConfig(
        use_local=False,
        model_name="claude-3-5-sonnet-20241022",
        api_key="test-api-key",
        max_tokens=1024,
        temperature=0.7
    )


@pytest.fixture
def mock_anthropic():
    """Mock the anthropic module."""
    mock_module = MagicMock()
    sys.modules['anthropic'] = mock_module
    yield mock_module
    # Cleanup
    if 'anthropic' in sys.modules:
        del sys.modules['anthropic']
    # Also clean up the imported client if it exists
    if 'ai_engine.clients' in sys.modules:
        del sys.modules['ai_engine.clients']


class TestClaudeAPIClient:
    """Test suite for Claude API client."""
    
    def test_rate_limit_error(self, claude_config, mock_anthropic):
        """Test that rate limit errors are properly handled."""
        # Import after mocking
        from ai_engine.clients import ClaudeAPIClient
        
        # Setup mock to raise rate limit error
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("rate limit exceeded")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(RateLimitError) as exc_info:
            client.complete("test prompt")
        
        assert "rate limit" in str(exc_info.value).lower()
        assert "try again later" in str(exc_info.value).lower()
    
    def test_rate_limit_with_429_status(self, claude_config, mock_anthropic):
        """Test that 429 status code is recognized as rate limit."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("Error 429: Too many requests")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(RateLimitError):
            client.complete("test prompt")
    
    def test_authentication_error(self, claude_config, mock_anthropic):
        """Test that authentication errors return appropriate messages."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("authentication failed")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(ModelUnavailableError) as exc_info:
            client.complete("test prompt")
        
        assert "credentials" in str(exc_info.value).lower()
    
    def test_authentication_error_401(self, claude_config, mock_anthropic):
        """Test that 401 status code is recognized as authentication error."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("Error 401: Unauthorized")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(ModelUnavailableError) as exc_info:
            client.complete("test prompt")
        
        assert "credentials" in str(exc_info.value).lower()
    
    def test_connection_error(self, claude_config, mock_anthropic):
        """Test that connection failures return ModelUnavailableError."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("connection timeout")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(ModelUnavailableError) as exc_info:
            client.complete("test prompt")
        
        assert "unavailable" in str(exc_info.value).lower()
    
    def test_timeout_error(self, claude_config, mock_anthropic):
        """Test that timeout errors return ModelUnavailableError."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("request timeout")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(ModelUnavailableError) as exc_info:
            client.complete("test prompt")
        
        assert "unavailable" in str(exc_info.value).lower()
    
    def test_network_error(self, claude_config, mock_anthropic):
        """Test that network errors return ModelUnavailableError."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("network error occurred")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(ModelUnavailableError):
            client.complete("test prompt")
    
    def test_retry_logic_for_transient_errors(self, claude_config, mock_anthropic):
        """Test that transient errors trigger retry logic."""
        from ai_engine.clients import ClaudeAPIClient
        
        with patch('ai_engine.clients.time.sleep'):  # Mock sleep to speed up test
            mock_client = Mock()
            mock_anthropic.Anthropic.return_value = mock_client
            
            # First two calls fail, third succeeds
            mock_response = Mock()
            mock_response.content = [Mock(text="Success")]
            mock_client.messages.create.side_effect = [
                Exception("connection timeout"),
                Exception("connection timeout"),
                mock_response
            ]
            
            client = ClaudeAPIClient(claude_config)
            result = client.complete("test prompt")
            
            assert result == "Success"
            assert mock_client.messages.create.call_count == 3
    
    def test_successful_completion(self, claude_config, mock_anthropic):
        """Test successful API call returns response text."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        
        mock_response = Mock()
        mock_response.content = [Mock(text="This is the AI response")]
        mock_client.messages.create.return_value = mock_response
        
        client = ClaudeAPIClient(claude_config)
        result = client.complete("test prompt", "test system prompt")
        
        assert result == "This is the AI response"
        
        # Verify correct parameters were passed
        call_args = mock_client.messages.create.call_args
        assert call_args[1]["model"] == claude_config.model_name
        assert call_args[1]["max_tokens"] == claude_config.max_tokens
        assert call_args[1]["temperature"] == claude_config.temperature
        assert call_args[1]["system"] == "test system prompt"
        assert call_args[1]["messages"][0]["content"] == "test prompt"
    
    def test_default_system_prompt(self, claude_config, mock_anthropic):
        """Test that default system prompt is used when none provided."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        
        mock_response = Mock()
        mock_response.content = [Mock(text="Response")]
        mock_client.messages.create.return_value = mock_response
        
        client = ClaudeAPIClient(claude_config)
        client.complete("test prompt")
        
        call_args = mock_client.messages.create.call_args
        assert "legal analysis assistant" in call_args[1]["system"].lower()
    
    def test_generic_error_handling(self, claude_config, mock_anthropic):
        """Test that unrecognized errors are wrapped in AIEngineError."""
        from ai_engine.clients import ClaudeAPIClient
        
        mock_client = Mock()
        mock_anthropic.Anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("Unknown error occurred")
        
        client = ClaudeAPIClient(claude_config)
        
        with pytest.raises(AIEngineError) as exc_info:
            client.complete("test prompt")
        
        assert "Claude API error" in str(exc_info.value)
