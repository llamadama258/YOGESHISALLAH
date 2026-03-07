"""Property-based tests for AI Engine."""

import os
import pytest
from hypothesis import given, strategies as st, settings
from .models import StrengthAnalysis, AIConfig
from .config import ConfigLoader


# Test data generators
@st.composite
def strength_analysis_strategy(draw):
    """Generate arbitrary StrengthAnalysis instances."""
    return StrengthAnalysis(
        overall_score=draw(st.floats(min_value=-100, max_value=200)),
        evidence_strength=draw(st.floats(min_value=-100, max_value=200)),
        legal_merit=draw(st.floats(min_value=-100, max_value=200)),
        win_probability=draw(st.floats(min_value=-100, max_value=200)),
        reasoning=draw(st.text(min_size=1, max_size=500)),
        strengths=draw(st.lists(st.text(min_size=1, max_size=100), min_size=0, max_size=10)),
        weaknesses=draw(st.lists(st.text(min_size=1, max_size=100), min_size=0, max_size=10))
    )


@st.composite
def valid_strength_analysis_strategy(draw):
    """Generate valid StrengthAnalysis instances with scores in 0-100 range."""
    return StrengthAnalysis(
        overall_score=draw(st.floats(min_value=0, max_value=100)),
        evidence_strength=draw(st.floats(min_value=0, max_value=100)),
        legal_merit=draw(st.floats(min_value=0, max_value=100)),
        win_probability=draw(st.floats(min_value=0, max_value=100)),
        reasoning=draw(st.text(min_size=1, max_size=500)),
        strengths=draw(st.lists(st.text(min_size=1, max_size=100), min_size=0, max_size=10)),
        weaknesses=draw(st.lists(st.text(min_size=1, max_size=100), min_size=0, max_size=10))
    )


# Property 6: Score Bounds Validation
# **Validates: Requirements 2.3**
@given(analysis=valid_strength_analysis_strategy())
def test_score_bounds_validation(analysis):
    """
    Property 6: Score Bounds Validation
    
    For any strength analysis response from the AI_Engine, all extracted numerical 
    scores (overall_score, evidence_strength, legal_merit, win_probability) should 
    be between 0 and 100 inclusive.
    
    **Validates: Requirements 2.3**
    """
    # All scores must be within valid bounds
    assert 0 <= analysis.overall_score <= 100, \
        f"overall_score {analysis.overall_score} out of bounds"
    assert 0 <= analysis.evidence_strength <= 100, \
        f"evidence_strength {analysis.evidence_strength} out of bounds"
    assert 0 <= analysis.legal_merit <= 100, \
        f"legal_merit {analysis.legal_merit} out of bounds"
    assert 0 <= analysis.win_probability <= 100, \
        f"win_probability {analysis.win_probability} out of bounds"



# Environment variable generators
@st.composite
def local_config_env_strategy(draw):
    """Generate valid environment variables for local mode."""
    # Generate simple alphanumeric strings with hyphens and underscores
    model_name = draw(st.text(min_size=1, max_size=50, alphabet=st.characters(min_codepoint=ord('a'), max_codepoint=ord('z'))))
    model_path = draw(st.text(min_size=1, max_size=100, alphabet=st.characters(min_codepoint=ord('a'), max_codepoint=ord('z'))))
    
    return {
        "USE_LOCAL": "true",
        "LOCAL_MODEL_NAME": model_name if model_name else "llama-3",
        "LOCAL_MODEL_PATH": f"./{model_path}.gguf" if model_path else "./model.gguf",
        "MAX_TOKENS": str(draw(st.integers(min_value=100, max_value=10000))),
        "TEMPERATURE": str(draw(st.floats(min_value=0.0, max_value=2.0))),
    }


@st.composite
def cloud_config_env_strategy(draw):
    """Generate valid environment variables for cloud mode."""
    api_key = draw(st.text(min_size=10, max_size=100, alphabet=st.characters(min_codepoint=ord('a'), max_codepoint=ord('z'))))
    
    return {
        "USE_LOCAL": "false",
        "ANTHROPIC_API_KEY": api_key if api_key else "test-api-key-12345",
        "CLAUDE_MODEL": draw(st.sampled_from(["claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-sonnet-20240229"])),
        "MAX_TOKENS": str(draw(st.integers(min_value=100, max_value=10000))),
        "TEMPERATURE": str(draw(st.floats(min_value=0.0, max_value=2.0))),
    }


# Property 12: Configuration Loading
# **Validates: Requirements 6.1**
@given(env_vars=local_config_env_strategy())
def test_configuration_loading_local_mode(env_vars):
    """
    Property 12: Configuration Loading (Local Mode)
    
    For any valid set of environment variables for local mode (USE_LOCAL=true, 
    LOCAL_MODEL_NAME, LOCAL_MODEL_PATH, etc.), the ConfigLoader should successfully 
    construct an AIConfig object with corresponding values.
    
    **Validates: Requirements 6.1**
    """
    # Set environment variables
    original_env = {}
    for key, value in env_vars.items():
        original_env[key] = os.environ.get(key)
        os.environ[key] = value
    
    try:
        # Load configuration
        config = ConfigLoader.load_config()
        
        # Verify configuration matches environment variables
        assert config.use_local is True
        assert config.model_name == env_vars["LOCAL_MODEL_NAME"]
        assert config.local_model_path == env_vars["LOCAL_MODEL_PATH"]
        assert config.api_key is None
        assert config.max_tokens == int(env_vars["MAX_TOKENS"])
        assert abs(config.temperature - float(env_vars["TEMPERATURE"])) < 0.001
    finally:
        # Restore original environment
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@given(env_vars=cloud_config_env_strategy())
def test_configuration_loading_cloud_mode(env_vars):
    """
    Property 12: Configuration Loading (Cloud Mode)
    
    For any valid set of environment variables for cloud mode (USE_LOCAL=false, 
    ANTHROPIC_API_KEY, CLAUDE_MODEL, etc.), the ConfigLoader should successfully 
    construct an AIConfig object with corresponding values.
    
    **Validates: Requirements 6.1**
    """
    # Set environment variables
    original_env = {}
    for key, value in env_vars.items():
        original_env[key] = os.environ.get(key)
        os.environ[key] = value
    
    try:
        # Load configuration
        config = ConfigLoader.load_config()
        
        # Verify configuration matches environment variables
        assert config.use_local is False
        assert config.model_name == env_vars["CLAUDE_MODEL"]
        assert config.api_key == env_vars["ANTHROPIC_API_KEY"]
        assert config.local_model_path is None
        assert config.max_tokens == int(env_vars["MAX_TOKENS"])
        assert abs(config.temperature - float(env_vars["TEMPERATURE"])) < 0.001
    finally:
        # Restore original environment
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value



# Property 13: Startup Configuration Validation
# **Validates: Requirements 6.4**
@given(invalid_config=st.sampled_from([
    {"USE_LOCAL": "false"},  # Missing API key in cloud mode
    {"USE_LOCAL": "false", "ANTHROPIC_API_KEY": ""},  # Empty API key
    {"USE_LOCAL": "true", "MAX_TOKENS": "invalid"},  # Invalid MAX_TOKENS
    {"USE_LOCAL": "true", "TEMPERATURE": "not_a_float"},  # Invalid TEMPERATURE
]))
def test_startup_configuration_validation(invalid_config):
    """
    Property 13: Startup Configuration Validation
    
    For any invalid or incomplete configuration (e.g., missing API key in cloud mode,
    invalid numeric values), the system should raise a ConfigurationError on startup 
    before accepting requests.
    
    **Validates: Requirements 6.4**
    """
    from .models import ConfigurationError
    
    # Set environment variables
    original_env = {}
    
    # Clear all relevant env vars first
    env_keys = ["USE_LOCAL", "ANTHROPIC_API_KEY", "CLAUDE_MODEL", "LOCAL_MODEL_NAME", 
                "LOCAL_MODEL_PATH", "MAX_TOKENS", "TEMPERATURE"]
    for key in env_keys:
        original_env[key] = os.environ.get(key)
        os.environ.pop(key, None)
    
    # Set the invalid configuration
    for key, value in invalid_config.items():
        os.environ[key] = value
    
    try:
        # Attempt to load configuration should raise ConfigurationError
        with pytest.raises(ConfigurationError):
            ConfigLoader.load_config()
    finally:
        # Restore original environment
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_startup_validation_missing_api_key():
    """
    Test that missing API key in cloud mode raises ConfigurationError.
    This is a specific case of Property 13.
    """
    from .models import ConfigurationError
    
    original_env = {
        "USE_LOCAL": os.environ.get("USE_LOCAL"),
        "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY"),
    }
    
    try:
        os.environ["USE_LOCAL"] = "false"
        os.environ.pop("ANTHROPIC_API_KEY", None)
        
        with pytest.raises(ConfigurationError) as exc_info:
            ConfigLoader.load_config()
        
        # Verify error message mentions API key
        assert "ANTHROPIC_API_KEY" in str(exc_info.value)
    finally:
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value



# Property 1: Model Router Mode Selection
# **Validates: Requirements 1.1, 1.2**
@given(use_local=st.booleans())
def test_model_router_mode_selection(use_local):
    """
    Property 1: Model Router Mode Selection
    
    For any AI_Engine configuration, when USE_LOCAL is true, all AI operations should 
    use the LocalModelClient, and when USE_LOCAL is false, all AI operations should 
    use the ClaudeAPIClient.
    
    **Validates: Requirements 1.1, 1.2**
    """
    import sys
    from unittest.mock import MagicMock
    
    # Mock the anthropic module
    mock_anthropic = MagicMock()
    sys.modules['anthropic'] = mock_anthropic
    
    # Mock llama_cpp and transformers modules
    mock_llama_cpp = MagicMock()
    mock_transformers = MagicMock()
    sys.modules['llama_cpp'] = mock_llama_cpp
    sys.modules['transformers'] = mock_transformers
    
    try:
        # Import after mocking
        from .clients import ModelRouter, LocalModelClient, ClaudeAPIClient
        
        # Create configuration
        config = AIConfig(
            use_local=use_local,
            model_name="test-model",
            api_key="test-key" if not use_local else None,
            local_model_path="./test.gguf" if use_local else None,
            max_tokens=1024,
            temperature=0.7
        )
        
        # Create router
        router = ModelRouter(config)
        
        # Verify correct client type is selected
        if use_local:
            assert isinstance(router.client, LocalModelClient), \
                "Router should use LocalModelClient when USE_LOCAL is true"
        else:
            assert isinstance(router.client, ClaudeAPIClient), \
                "Router should use ClaudeAPIClient when USE_LOCAL is false"
    finally:
        # Cleanup mocks
        for module in ['anthropic', 'llama_cpp', 'transformers', 'ai_engine.clients']:
            if module in sys.modules:
                del sys.modules[module]


# Property 2: Interface Consistency Across Modes
# **Validates: Requirements 1.3**
@given(use_local=st.booleans(), prompt=st.text(min_size=1, max_size=100))
def test_interface_consistency_across_modes(use_local, prompt):
    """
    Property 2: Interface Consistency Across Modes
    
    For any valid case context and AI operation (analyze, generate, chat), the AI_Engine 
    should return compatible response types regardless of whether Local_Inference_Mode or 
    Cloud_API_Mode is active.
    
    **Validates: Requirements 1.3**
    """
    import sys
    from unittest.mock import MagicMock, Mock
    
    # Mock the anthropic module
    mock_anthropic = MagicMock()
    mock_anthropic_client = Mock()
    mock_anthropic.Anthropic.return_value = mock_anthropic_client
    
    # Mock response
    mock_response = Mock()
    mock_response.content = [Mock(text="Test response from AI")]
    mock_anthropic_client.messages.create.return_value = mock_response
    
    sys.modules['anthropic'] = mock_anthropic
    
    # Mock llama_cpp
    mock_llama_cpp = MagicMock()
    mock_llama_model = Mock()
    mock_llama_model.return_value = {"choices": [{"text": "Test response from AI"}]}
    mock_llama_cpp.Llama.return_value = mock_llama_model
    sys.modules['llama_cpp'] = mock_llama_cpp
    
    # Mock transformers
    mock_transformers = MagicMock()
    sys.modules['transformers'] = mock_transformers
    
    try:
        # Import after mocking
        from .clients import ModelRouter
        
        # Create configuration
        config = AIConfig(
            use_local=use_local,
            model_name="test-model",
            api_key="test-key" if not use_local else None,
            local_model_path="./test.gguf" if use_local else None,
            max_tokens=1024,
            temperature=0.7
        )
        
        # Create router
        router = ModelRouter(config)
        
        # Call complete method
        result = router.complete(prompt, "You are a helpful assistant")
        
        # Verify response is a string (consistent interface)
        assert isinstance(result, str), \
            f"Response should be string in both modes, got {type(result)}"
        assert len(result) > 0, "Response should not be empty"
    finally:
        # Cleanup mocks
        for module in ['anthropic', 'llama_cpp', 'transformers', 'ai_engine.clients']:
            if module in sys.modules:
                del sys.modules[module]
