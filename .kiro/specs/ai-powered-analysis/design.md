# Design Document: AI-Powered Legal Analysis

## Overview

This design replaces the current heuristic-based legal case analysis system with production-grade AI capabilities. The existing system uses GPT-2 and flan-t5-base models with simple arithmetic calculations (base 50 + adjustments) for strength scores. This design integrates Anthropic Claude API (cloud mode) or better open-source models (local mode) to provide intelligent legal analysis, accurate strength assessments, contextual chat responses, and high-quality document generation.

The design maintains the existing FastAPI backend structure and React frontend API contract while replacing the internal implementation with AI-powered analysis. Users can toggle between free local inference and paid cloud API usage via the USE_LOCAL configuration flag.

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    React Frontend                        │
│  (Intake Wizard, Analysis View, Chat, Documents)        │
└─────────────────┬───────────────────────────────────────┘
                  │ HTTP/JSON
                  │ (/analyze, /generate, /generate-letter, etc.)
                  ▼
┌─────────────────────────────────────────────────────────┐
│              FastAPI Backend Server                      │
│  ┌─────────────────────────────────────────────────┐   │
│  │         API Route Handlers                       │   │
│  │  /analyze  /generate  /generate-letter  /chat   │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │                                    │
│  ┌──────────────────▼──────────────────────────────┐   │
│  │        Business Logic Layer                      │   │
│  │  ┌──────────────┐  ┌─────────────────────────┐ │   │
│  │  │  Strength    │  │   Document              │ │   │
│  │  │  Calculator  │  │   Generator             │ │   │
│  │  └──────┬───────┘  └──────┬──────────────────┘ │   │
│  │         │                  │                     │   │
│  │  ┌──────▼──────────────────▼──────────────────┐ │   │
│  │  │         Chat Handler                        │ │   │
│  │  └──────────────────┬──────────────────────────┘ │   │
│  └─────────────────────┼──────────────────────────┘   │
│                        │                               │
│  ┌─────────────────────▼──────────────────────────┐   │
│  │            AI Engine (Core)                     │   │
│  │  ┌──────────────────────────────────────────┐  │   │
│  │  │  Prompt Builder & Context Manager        │  │   │
│  │  └──────────────┬───────────────────────────┘  │   │
│  │                 │                               │   │
│  │  ┌──────────────▼───────────────────────────┐  │   │
│  │  │     Model Router (USE_LOCAL flag)        │  │   │
│  │  └──────┬───────────────────────┬───────────┘  │   │
│  │         │                       │               │   │
│  │  ┌──────▼────────┐      ┌──────▼────────────┐ │   │
│  │  │ Local Model   │      │  Claude API       │ │   │
│  │  │ (llama.cpp or │      │  Client           │ │   │
│  │  │  transformers)│      │  (anthropic SDK)  │ │   │
│  │  └───────────────┘      └───────────────────┘ │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Component Responsibilities

**API Route Handlers**: Receive HTTP requests, validate inputs, delegate to business logic, return JSON responses

**Strength Calculator**: Analyzes case strength using AI, extracts numerical scores, provides reasoning

**Document Generator**: Creates demand letters, complaints, and email sequences using AI with proper formatting

**Chat Handler**: Manages conversation state, provides context to AI, handles multi-turn dialogues

**AI Engine**: Core abstraction layer that handles all AI interactions, prompt construction, and response parsing

**Prompt Builder**: Constructs effective prompts with case context, formatting instructions, and role definitions

**Model Router**: Selects between local inference and cloud API based on USE_LOCAL configuration

**Local Model Client**: Interfaces with locally-hosted models (llama.cpp or transformers library)

**Claude API Client**: Interfaces with Anthropic Claude API using official SDK

## Components and Interfaces

### AI Engine Interface

The AI Engine provides a unified interface for all AI operations:

```python
class AIEngine:
    def __init__(self, config: AIConfig):
        """Initialize with configuration specifying local vs cloud mode"""
        
    def analyze_case_strength(self, case_context: CaseContext) -> StrengthAnalysis:
        """
        Analyze case strength and return scores with reasoning
        
        Args:
            case_context: Complete case information
            
        Returns:
            StrengthAnalysis with scores (0-100) and reasoning
        """
        
    def generate_document(self, doc_type: DocumentType, 
                         case_context: CaseContext,
                         template_hints: Optional[str] = None) -> str:
        """
        Generate legal document using AI
        
        Args:
            doc_type: Type of document (demand_letter, complaint, email)
            case_context: Complete case information
            template_hints: Optional formatting guidance
            
        Returns:
            Generated document text
        """
        
    def chat(self, message: str, 
            case_context: CaseContext,
            conversation_history: List[Message]) -> str:
        """
        Process chat message with context
        
        Args:
            message: User's question
            case_context: Complete case information
            conversation_history: Previous messages in conversation
            
        Returns:
            AI response text
        """
```

### Data Models

```python
@dataclass
class CaseContext:
    """Complete case information for AI analysis"""
    facts: str
    evidence: List[str]
    jurisdiction: str
    legal_theories: List[str]
    defendant: str
    damages_sought: Optional[str]
    timeline: Optional[List[TimelineEvent]]
    
@dataclass
class StrengthAnalysis:
    """Result of case strength analysis"""
    overall_score: float  # 0-100
    evidence_strength: float  # 0-100
    legal_merit: float  # 0-100
    win_probability: float  # 0-100
    reasoning: str
    strengths: List[str]
    weaknesses: List[str]
    
@dataclass
class AIConfig:
    """Configuration for AI Engine"""
    use_local: bool
    model_name: str  # e.g., "claude-3-5-sonnet" or "llama-3-70b"
    api_key: Optional[str]
    local_model_path: Optional[str]
    max_tokens: int = 4096
    temperature: float = 0.7
    
@dataclass
class Message:
    """Chat message"""
    role: str  # "user" or "assistant"
    content: str
    timestamp: datetime

class DocumentType(Enum):
    DEMAND_LETTER = "demand_letter"
    COMPLAINT = "complaint"
    EMAIL_SEQUENCE = "email_sequence"
```

### Model Router Implementation

The Model Router selects the appropriate AI backend:

```python
class ModelRouter:
    def __init__(self, config: AIConfig):
        self.config = config
        if config.use_local:
            self.client = LocalModelClient(config)
        else:
            self.client = ClaudeAPIClient(config)
    
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        Get completion from configured model
        
        Args:
            prompt: User prompt
            system_prompt: Optional system instructions
            
        Returns:
            Model response text
        """
        return self.client.complete(prompt, system_prompt)
```

### Prompt Builder Strategies

The Prompt Builder constructs effective prompts for different tasks:

**Strength Analysis Prompt Structure**:
```
System: You are a legal analysis assistant. Analyze the case and provide numerical scores.

User: Analyze this case for strength:

Facts: {case_context.facts}
Evidence: {case_context.evidence}
Jurisdiction: {case_context.jurisdiction}
Legal Theories: {case_context.legal_theories}

Provide:
1. Overall case strength (0-100)
2. Evidence strength (0-100)
3. Legal merit (0-100)
4. Win probability (0-100)
5. Detailed reasoning
6. Key strengths (bullet points)
7. Key weaknesses (bullet points)

Format your response as JSON.
```

**Document Generation Prompt Structure**:
```
System: You are a legal document drafting assistant. Create professional legal documents.

User: Generate a {doc_type} for this case:

Case Details:
- Defendant: {case_context.defendant}
- Facts: {case_context.facts}
- Evidence: {case_context.evidence}
- Legal Theories: {case_context.legal_theories}
- Damages: {case_context.damages_sought}

Requirements:
- Professional legal tone
- Proper formatting
- Reference specific facts and evidence
- Include all relevant legal theories
```

**Chat Prompt Structure**:
```
System: You are a legal assistant helping a user build their case. Provide helpful, 
contextual guidance based on their specific situation.

Context about the user's case:
{case_context summary}

Conversation history:
{previous messages}

User: {current question}

```

### API Endpoint Implementations

**POST /analyze**:
```python
@app.post("/analyze")
async def analyze_case(request: AnalyzeRequest):
    """Analyze case strength using AI"""
    case_context = build_case_context(request)
    
    try:
        analysis = ai_engine.analyze_case_strength(case_context)
        return {
            "strength": analysis.overall_score,
            "evidence_strength": analysis.evidence_strength,
            "legal_merit": analysis.legal_merit,
            "win_probability": analysis.win_probability,
            "reasoning": analysis.reasoning,
            "strengths": analysis.strengths,
            "weaknesses": analysis.weaknesses
        }
    except AIEngineError as e:
        raise HTTPException(status_code=500, detail=str(e))
```

**POST /generate-letter**:
```python
@app.post("/generate-letter")
async def generate_letter(request: GenerateLetterRequest):
    """Generate demand letter using AI"""
    case_context = build_case_context(request)
    
    try:
        letter = ai_engine.generate_document(
            DocumentType.DEMAND_LETTER,
            case_context
        )
        return {"letter": letter}
    except AIEngineError as e:
        raise HTTPException(status_code=500, detail=str(e))
```

**POST /chat**:
```python
@app.post("/chat")
async def chat(request: ChatRequest):
    """Handle AI chat interaction"""
    case_context = build_case_context(request)
    conversation_history = request.conversation_history or []
    
    try:
        response = ai_engine.chat(
            request.message,
            case_context,
            conversation_history
        )
        return {"response": response}
    except AIEngineError as e:
        raise HTTPException(status_code=500, detail=str(e))
```

## Data Models

### Case Context Construction

The system constructs CaseContext from frontend requests:

```python
def build_case_context(request: Union[AnalyzeRequest, GenerateRequest]) -> CaseContext:
    """
    Extract case context from API request
    
    Handles various request formats and normalizes into CaseContext
    """
    return CaseContext(
        facts=request.facts or "",
        evidence=request.evidence or [],
        jurisdiction=request.jurisdiction or "Unknown",
        legal_theories=request.legal_theories or [],
        defendant=request.defendant or "",
        damages_sought=request.damages,
        timeline=parse_timeline(request.timeline) if request.timeline else None
    )
```

### Response Parsing

The AI Engine parses structured responses from AI models:

```python
class ResponseParser:
    @staticmethod
    def parse_strength_analysis(raw_response: str) -> StrengthAnalysis:
        """
        Parse AI response into StrengthAnalysis
        
        Handles both JSON and natural language responses
        Extracts numerical scores and reasoning
        """
        # Try JSON parsing first
        try:
            data = json.loads(raw_response)
            return StrengthAnalysis(
                overall_score=float(data["overall_score"]),
                evidence_strength=float(data["evidence_strength"]),
                legal_merit=float(data["legal_merit"]),
                win_probability=float(data["win_probability"]),
                reasoning=data["reasoning"],
                strengths=data["strengths"],
                weaknesses=data["weaknesses"]
            )
        except (json.JSONDecodeError, KeyError):
            # Fall back to regex extraction
            return parse_natural_language_analysis(raw_response)
    
    @staticmethod
    def parse_natural_language_analysis(text: str) -> StrengthAnalysis:
        """
        Extract scores from natural language response
        
        Uses regex patterns to find numerical scores
        """
        # Extract scores using patterns like "Overall: 75/100" or "Score: 75"
        overall = extract_score(text, r"overall.*?(\d+)")
        evidence = extract_score(text, r"evidence.*?(\d+)")
        legal = extract_score(text, r"legal.*?(\d+)")
        win_prob = extract_score(text, r"win.*?(\d+)")
        
        return StrengthAnalysis(
            overall_score=overall or 50.0,
            evidence_strength=evidence or 50.0,
            legal_merit=legal or 50.0,
            win_probability=win_prob or 50.0,
            reasoning=text,
            strengths=[],
            weaknesses=[]
        )
```

### Local Model Implementation

For local inference, the system uses llama.cpp or transformers:

```python
class LocalModelClient:
    def __init__(self, config: AIConfig):
        self.config = config
        # Option 1: llama.cpp for efficient inference
        if config.local_model_path.endswith(".gguf"):
            from llama_cpp import Llama
            self.model = Llama(
                model_path=config.local_model_path,
                n_ctx=config.max_tokens,
                n_threads=8
            )
        # Option 2: transformers for broader model support
        else:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            self.tokenizer = AutoTokenizer.from_pretrained(config.model_name)
            self.model = AutoModelForCausalLM.from_pretrained(
                config.model_name,
                device_map="auto"
            )
    
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """Generate completion using local model"""
        full_prompt = self._format_prompt(prompt, system_prompt)
        
        if hasattr(self, 'tokenizer'):
            # transformers path
            inputs = self.tokenizer(full_prompt, return_tensors="pt")
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=self.config.max_tokens,
                temperature=self.config.temperature
            )
            return self.tokenizer.decode(outputs[0], skip_special_tokens=True)
        else:
            # llama.cpp path
            response = self.model(
                full_prompt,
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature
            )
            return response["choices"][0]["text"]
```

### Claude API Implementation

For cloud mode, the system uses the Anthropic SDK:

```python
class ClaudeAPIClient:
    def __init__(self, config: AIConfig):
        self.config = config
        from anthropic import Anthropic
        self.client = Anthropic(api_key=config.api_key)
    
    def complete(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """Generate completion using Claude API"""
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
            raise AIEngineError(f"Claude API error: {str(e)}")
```

### Configuration Management

The system loads configuration from environment variables:

```python
class ConfigLoader:
    @staticmethod
    def load_config() -> AIConfig:
        """Load AI configuration from environment"""
        use_local = os.getenv("USE_LOCAL", "false").lower() == "true"
        
        if use_local:
            return AIConfig(
                use_local=True,
                model_name=os.getenv("LOCAL_MODEL_NAME", "llama-3-70b"),
                local_model_path=os.getenv("LOCAL_MODEL_PATH", "./models/model.gguf"),
                api_key=None,
                max_tokens=int(os.getenv("MAX_TOKENS", "4096")),
                temperature=float(os.getenv("TEMPERATURE", "0.7"))
            )
        else:
            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                raise ConfigurationError("ANTHROPIC_API_KEY required for cloud mode")
            
            return AIConfig(
                use_local=False,
                model_name=os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
                api_key=api_key,
                local_model_path=None,
                max_tokens=int(os.getenv("MAX_TOKENS", "4096")),
                temperature=float(os.getenv("TEMPERATURE", "0.7"))
            )
```

### Error Handling Strategy

The system implements comprehensive error handling:

```python
class AIEngineError(Exception):
    """Base exception for AI Engine errors"""
    pass

class ModelUnavailableError(AIEngineError):
    """Raised when AI model cannot be accessed"""
    pass

class RateLimitError(AIEngineError):
    """Raised when API rate limits are exceeded"""
    pass

class InvalidResponseError(AIEngineError):
    """Raised when AI response cannot be parsed"""
    pass

class AIEngine:
    def _handle_error(self, e: Exception) -> None:
        """Convert exceptions to appropriate AIEngineError types"""
        if "rate limit" in str(e).lower():
            raise RateLimitError("API rate limit exceeded. Please try again later.")
        elif "connection" in str(e).lower() or "timeout" in str(e).lower():
            raise ModelUnavailableError("AI model is currently unavailable.")
        elif "authentication" in str(e).lower():
            raise ModelUnavailableError("Invalid API credentials.")
        else:
            raise AIEngineError(f"AI processing error: {str(e)}")
```


## Correctness Properties

A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.

### Property Reflection

After analyzing all acceptance criteria, I identified several areas of redundancy:

- Properties 1.1 and 1.2 (cloud/local routing) can be combined into a single property about mode selection
- Properties 4.1, 4.2, and 4.3 (document generation using AI) are essentially the same pattern applied to different document types - can be unified
- Property 2.6 (schema compatibility) subsumes aspects of response structure validation
- Properties 8.1, 8.2, 8.3, 8.5 (prompt construction) can be consolidated into fewer comprehensive properties
- Property 5.2 (response schema) and 2.6 (structured data) test the same concept

The following properties represent the unique, non-redundant validation requirements:

### Property 1: Model Router Mode Selection
*For any* AI_Engine configuration, when USE_LOCAL is true, all AI operations should use the LocalModelClient, and when USE_LOCAL is false, all AI operations should use the ClaudeAPIClient.

**Validates: Requirements 1.1, 1.2**

### Property 2: Interface Consistency Across Modes
*For any* valid case context and AI operation (analyze, generate, chat), the AI_Engine should return compatible response types regardless of whether Local_Inference_Mode or Cloud_API_Mode is active.

**Validates: Requirements 1.3**

### Property 3: Error Message Descriptiveness
*For any* AI model failure (connection error, timeout, authentication failure), the AI_Engine should return an error message that describes the specific issue type.

**Validates: Requirements 1.4**

### Property 4: AI Engine Integration
*For any* request to /analyze, /generate-letter, /generate, or /generate-emails endpoints, the corresponding handler should invoke AI_Engine methods rather than using heuristic calculations.

**Validates: Requirements 2.1, 2.5, 4.1, 4.2, 4.3**

### Property 5: Complete Context Passing
*For any* case context with facts, evidence, jurisdiction, and legal theories, when passed to the AI_Engine, all non-empty fields should be included in the constructed prompt.

**Validates: Requirements 2.2, 3.1, 8.1**

### Property 6: Score Bounds Validation
*For any* strength analysis response from the AI_Engine, all extracted numerical scores (overall_score, evidence_strength, legal_merit, win_probability) should be between 0 and 100 inclusive.

**Validates: Requirements 2.3**

### Property 7: Analysis Completeness
*For any* strength analysis result, the response should include all required fields: numerical scores, reasoning text, strengths list, and weaknesses list.

**Validates: Requirements 2.4**

### Property 8: Response Schema Compatibility
*For any* API endpoint response (/analyze, /generate, /generate-letter, /generate-emails), the JSON structure should match the schema expected by the existing frontend application.

**Validates: Requirements 2.6, 5.2**

### Property 9: Conversation History Accumulation
*For any* sequence of chat messages within a session, each subsequent call to Chat_Handler should include all previous messages in the conversation history.

**Validates: Requirements 3.2**

### Property 10: History Inclusion in Prompts
*For any* chat request with non-empty conversation history, the prompt constructed by the AI_Engine should include the previous conversation turns.

**Validates: Requirements 3.3**

### Property 11: Request Parameter Compatibility
*For any* valid request that worked with the old heuristic-based system, the new AI-powered system should accept the same parameters without errors.

**Validates: Requirements 5.3**

### Property 12: Configuration Loading
*For any* valid set of environment variables (USE_LOCAL, MODEL_NAME, API_KEY, etc.), the ConfigLoader should successfully construct an AIConfig object with corresponding values.

**Validates: Requirements 6.1**

### Property 13: Startup Configuration Validation
*For any* invalid or incomplete configuration (e.g., missing API key in cloud mode), the system should raise a ConfigurationError on startup before accepting requests.

**Validates: Requirements 6.4**

### Property 14: Invalid Input Rejection
*For any* case context with invalid or missing required fields, the Legal_Analysis_System should return a validation error with a specific message indicating which fields are problematic.

**Validates: Requirements 7.3**

### Property 15: Fault Isolation
*For any* request that causes an error, subsequent requests with valid inputs should still be processed successfully without system-wide failure.

**Validates: Requirements 7.5**

### Property 16: Prompt Structure for Strength Analysis
*For any* strength analysis request, the constructed prompt should include instructions requesting numerical scores (0-100) and reasoning text.

**Validates: Requirements 8.2**

### Property 17: Prompt Structure for Document Generation
*For any* document generation request, the constructed prompt should include the document type, case details, and formatting guidelines.

**Validates: Requirements 8.3**

### Property 18: Token Limit Compliance
*For any* case context, the constructed prompt should not exceed the configured max_tokens limit for the selected model.

**Validates: Requirements 8.4**

### Property 19: System Prompt Inclusion
*For any* AI model call, the request should include a system prompt that establishes the AI's role as a legal analysis assistant.

**Validates: Requirements 8.5**

## Error Handling

### Error Categories

**Configuration Errors**:
- Missing API keys in cloud mode
- Invalid model paths in local mode
- Malformed configuration values
- Action: Fail fast on startup with clear error messages

**Runtime Errors**:
- AI model unavailable (connection failures, timeouts)
- API rate limits exceeded
- Invalid or unparseable AI responses
- Action: Return user-friendly error messages, log details, continue serving other requests

**Validation Errors**:
- Missing required case context fields
- Invalid parameter types
- Malformed request bodies
- Action: Return 400 Bad Request with specific field errors

### Error Response Format

All errors follow a consistent format:

```json
{
  "error": {
    "type": "ModelUnavailableError",
    "message": "AI model is currently unavailable. Please try again later.",
    "details": "Connection timeout after 30 seconds",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

### Retry Strategy

**Rate Limit Errors**: Client should implement exponential backoff
**Transient Failures**: Automatic retry up to 3 times with 1-second delays
**Configuration Errors**: No retry, requires manual intervention
**Validation Errors**: No retry, requires request correction

### Logging Strategy

**Error Logging**:
- All exceptions logged with full stack traces
- AI model responses logged when parsing fails
- Configuration errors logged on startup

**Request Logging**:
- Endpoint access with timestamps
- Request parameters (sanitized, no PII)
- Response times and status codes

**AI Interaction Logging**:
- Prompt construction (truncated if > 1000 chars)
- Model selection (local vs cloud)
- Token usage and costs (cloud mode)

## Testing Strategy

### Dual Testing Approach

This system requires both unit tests and property-based tests for comprehensive coverage:

**Unit Tests** focus on:
- Specific examples of case analysis with known inputs
- Edge cases (empty contexts, missing fields, malformed responses)
- Error conditions (model unavailable, rate limits, parse failures)
- Integration points (endpoint handlers, configuration loading)
- Mock AI responses to test parsing logic

**Property-Based Tests** focus on:
- Universal properties that hold for all inputs
- Comprehensive input coverage through randomization
- Interface consistency across different modes
- Schema validation across all possible responses
- Prompt construction correctness for arbitrary case contexts

### Property-Based Testing Configuration

**Framework**: Use `hypothesis` (Python) for property-based testing
**Iterations**: Minimum 100 iterations per property test
**Tagging**: Each property test must reference its design document property

Tag format: `# Feature: ai-powered-analysis, Property {number}: {property_text}`

Example:
```python
@given(case_context=case_context_strategy())
def test_complete_context_passing(case_context):
    # Feature: ai-powered-analysis, Property 5: Complete Context Passing
    prompt = ai_engine.build_prompt(case_context)
    
    if case_context.facts:
        assert case_context.facts in prompt
    if case_context.evidence:
        assert all(e in prompt for e in case_context.evidence)
    if case_context.jurisdiction:
        assert case_context.jurisdiction in prompt
```

### Test Data Generators

**Case Context Generator**:
```python
from hypothesis import strategies as st

@st.composite
def case_context_strategy(draw):
    return CaseContext(
        facts=draw(st.text(min_size=10, max_size=500)),
        evidence=draw(st.lists(st.text(min_size=5, max_size=100), min_size=0, max_size=10)),
        jurisdiction=draw(st.sampled_from(["Federal", "California", "New York", "Texas"])),
        legal_theories=draw(st.lists(st.text(min_size=5, max_size=50), min_size=1, max_size=5)),
        defendant=draw(st.text(min_size=3, max_size=100)),
        damages_sought=draw(st.one_of(st.none(), st.text(min_size=5, max_size=100))),
        timeline=draw(st.one_of(st.none(), st.lists(timeline_event_strategy(), min_size=1, max_size=10)))
    )
```

### Unit Test Examples

**Strength Analysis Parsing**:
```python
def test_parse_json_strength_analysis():
    """Test parsing well-formed JSON response"""
    response = '''
    {
        "overall_score": 75,
        "evidence_strength": 80,
        "legal_merit": 70,
        "win_probability": 65,
        "reasoning": "Strong evidence but moderate legal precedent",
        "strengths": ["Clear documentation", "Multiple witnesses"],
        "weaknesses": ["Jurisdiction uncertainty"]
    }
    '''
    analysis = ResponseParser.parse_strength_analysis(response)
    assert analysis.overall_score == 75
    assert analysis.evidence_strength == 80
    assert len(analysis.strengths) == 2

def test_parse_natural_language_fallback():
    """Test fallback parsing for natural language response"""
    response = "Overall case strength: 75/100. Evidence is strong at 80/100."
    analysis = ResponseParser.parse_strength_analysis(response)
    assert 70 <= analysis.overall_score <= 80
    assert 75 <= analysis.evidence_strength <= 85
```

**Error Handling**:
```python
def test_model_unavailable_error():
    """Test handling of connection failures"""
    with patch('anthropic.Anthropic') as mock_client:
        mock_client.side_effect = ConnectionError("Connection timeout")
        
        with pytest.raises(ModelUnavailableError) as exc_info:
            ai_engine.analyze_case_strength(sample_case_context)
        
        assert "unavailable" in str(exc_info.value).lower()

def test_rate_limit_error():
    """Test handling of rate limit errors"""
    with patch('anthropic.Anthropic') as mock_client:
        mock_client.side_effect = Exception("rate limit exceeded")
        
        with pytest.raises(RateLimitError) as exc_info:
            ai_engine.analyze_case_strength(sample_case_context)
        
        assert "retry later" in str(exc_info.value).lower()
```

**Configuration**:
```python
def test_local_mode_configuration():
    """Test configuration for local inference mode"""
    os.environ["USE_LOCAL"] = "true"
    os.environ["LOCAL_MODEL_PATH"] = "./models/test.gguf"
    
    config = ConfigLoader.load_config()
    assert config.use_local is True
    assert config.api_key is None
    assert config.local_model_path == "./models/test.gguf"

def test_cloud_mode_requires_api_key():
    """Test that cloud mode validates API key presence"""
    os.environ["USE_LOCAL"] = "false"
    os.environ.pop("ANTHROPIC_API_KEY", None)
    
    with pytest.raises(ConfigurationError) as exc_info:
        ConfigLoader.load_config()
    
    assert "API_KEY" in str(exc_info.value)
```

### Integration Testing

**End-to-End Endpoint Tests**:
```python
def test_analyze_endpoint_integration():
    """Test /analyze endpoint with mocked AI"""
    with patch.object(ai_engine, 'analyze_case_strength') as mock_analyze:
        mock_analyze.return_value = StrengthAnalysis(
            overall_score=75.0,
            evidence_strength=80.0,
            legal_merit=70.0,
            win_probability=65.0,
            reasoning="Test reasoning",
            strengths=["Strength 1"],
            weaknesses=["Weakness 1"]
        )
        
        response = client.post("/analyze", json={
            "facts": "Test facts",
            "evidence": ["Evidence 1"],
            "jurisdiction": "Federal",
            "legal_theories": ["Theory 1"]
        })
        
        assert response.status_code == 200
        data = response.json()
        assert data["strength"] == 75.0
        assert "reasoning" in data
```

### Test Coverage Goals

- Unit test coverage: > 85% of code lines
- Property test coverage: All 19 correctness properties
- Integration test coverage: All 4 API endpoints
- Error path coverage: All error types (configuration, runtime, validation)
- Edge case coverage: Empty inputs, malformed responses, missing fields
