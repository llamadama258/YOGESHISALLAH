# Implementation Plan: AI-Powered Legal Analysis

## Overview

This implementation plan converts the heuristic-based legal case analysis system into an AI-powered system. The approach is to build the core AI Engine abstraction layer first, then integrate it into existing endpoints, and finally add comprehensive testing. Each task builds incrementally, ensuring the system remains functional throughout development.

## Tasks

- [x] 1. Set up AI Engine core infrastructure
  - [x] 1.1 Create AI Engine module structure and data models
    - Create `ai_engine/` directory with `__init__.py`, `models.py`, `engine.py`
    - Define data classes: `AIConfig`, `CaseContext`, `StrengthAnalysis`, `Message`, `DocumentType`
    - Define exception classes: `AIEngineError`, `ModelUnavailableError`, `RateLimitError`, `InvalidResponseError`, `ConfigurationError`
    - _Requirements: 1.4, 7.1, 7.2_

  - [x] 1.2 Write property test for data model validation
    - **Property 6: Score Bounds Validation**
    - **Validates: Requirements 2.3**

  - [x] 1.3 Implement configuration loader
    - Create `ConfigLoader` class that reads from environment variables
    - Support USE_LOCAL, MODEL_NAME, API_KEY, LOCAL_MODEL_PATH, MAX_TOKENS, TEMPERATURE
    - Validate required fields based on mode (API key for cloud, model path for local)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 1.4 Write property test for configuration loading
    - **Property 12: Configuration Loading**
    - **Validates: Requirements 6.1**

  - [x] 1.5 Write property test for startup validation
    - **Property 13: Startup Configuration Validation**
    - **Validates: Requirements 6.4**

- [x] 2. Implement Model Router and client interfaces
  - [x] 2.1 Create abstract base client interface
    - Define `BaseModelClient` abstract class with `complete()` method
    - Ensure consistent interface for both local and cloud implementations
    - _Requirements: 1.3_

  - [x] 2.2 Implement Claude API client
    - Create `ClaudeAPIClient` class using Anthropic SDK
    - Implement `complete()` method with error handling for rate limits, auth failures, connection errors
    - Add retry logic for transient failures (up to 3 retries with 1-second delays)
    - _Requirements: 1.1, 7.1, 7.2_

  - [x] 2.3 Write unit tests for Claude API error handling
    - Test rate limit errors return RateLimitError
    - Test connection failures return ModelUnavailableError
    - Test authentication errors return appropriate messages
    - _Requirements: 1.4, 7.1, 7.2_

  - [x] 2.4 Implement Local Model client
    - Create `LocalModelClient` class supporting both llama.cpp and transformers
    - Detect model format (.gguf for llama.cpp, otherwise transformers)
    - Implement `complete()` method with appropriate error handling
    - _Requirements: 1.2, 7.1_

  - [x] 2.5 Implement Model Router
    - Create `ModelRouter` class that selects client based on USE_LOCAL flag
    - Instantiate appropriate client (LocalModelClient or ClaudeAPIClient)
    - Delegate `complete()` calls to selected client
    - _Requirements: 1.1, 1.2, 1.5_

  - [-] 2.6 Write property test for model router mode selection
    - **Property 1: Model Router Mode Selection**
    - **Validates: Requirements 1.1, 1.2**

  - [ ] 2.7 Write property test for interface consistency
    - **Property 2: Interface Consistency Across Modes**
    - **Validates: Requirements 1.3**

- [ ] 3. Checkpoint - Ensure configuration and routing work
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Prompt Builder
  - [ ] 4.1 Create PromptBuilder class with context formatting
    - Implement methods: `build_strength_analysis_prompt()`, `build_document_generation_prompt()`, `build_chat_prompt()`
    - Include case context fields (facts, evidence, jurisdiction, legal theories) in all prompts
    - Add system prompts establishing AI role as legal analysis assistant
    - Implement token limit checking to stay within max_tokens
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 4.2 Write property test for complete context passing
    - **Property 5: Complete Context Passing**
    - **Validates: Requirements 2.2, 3.1, 8.1**

  - [ ] 4.3 Write property test for strength analysis prompt structure
    - **Property 16: Prompt Structure for Strength Analysis**
    - **Validates: Requirements 8.2**

  - [ ] 4.4 Write property test for document generation prompt structure
    - **Property 17: Prompt Structure for Document Generation**
    - **Validates: Requirements 8.3**

  - [ ] 4.5 Write property test for token limit compliance
    - **Property 18: Token Limit Compliance**
    - **Validates: Requirements 8.4**

  - [ ] 4.6 Write property test for system prompt inclusion
    - **Property 19: System Prompt Inclusion**
    - **Validates: Requirements 8.5**

- [ ] 5. Implement Response Parser
  - [ ] 5.1 Create ResponseParser class
    - Implement `parse_strength_analysis()` with JSON parsing and natural language fallback
    - Use regex patterns to extract scores from natural language responses
    - Validate extracted scores are between 0-100
    - Ensure all required fields are present (scores, reasoning, strengths, weaknesses)
    - _Requirements: 2.3, 2.4_

  - [ ] 5.2 Write unit tests for response parsing
    - Test JSON parsing with well-formed responses
    - Test natural language fallback with various formats
    - Test score extraction with different patterns
    - Test handling of unparseable responses
    - _Requirements: 2.3, 2.4, 7.4_

  - [ ] 5.3 Write property test for analysis completeness
    - **Property 7: Analysis Completeness**
    - **Validates: Requirements 2.4**

- [ ] 6. Implement core AI Engine
  - [ ] 6.1 Create AIEngine class with main methods
    - Implement `analyze_case_strength()` using PromptBuilder and ResponseParser
    - Implement `generate_document()` for demand letters, complaints, and emails
    - Implement `chat()` with conversation history support
    - Add comprehensive error handling that converts exceptions to appropriate AIEngineError types
    - _Requirements: 2.1, 2.5, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_

  - [ ] 6.2 Write property test for error message descriptiveness
    - **Property 3: Error Message Descriptiveness**
    - **Validates: Requirements 1.4**

  - [ ] 6.3 Write property test for conversation history accumulation
    - **Property 9: Conversation History Accumulation**
    - **Validates: Requirements 3.2**

  - [ ] 6.4 Write property test for history inclusion in prompts
    - **Property 10: History Inclusion in Prompts**
    - **Validates: Requirements 3.3**

- [ ] 7. Checkpoint - Ensure AI Engine core functionality works
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Integrate AI Engine into existing endpoints
  - [ ] 8.1 Update /analyze endpoint
    - Replace heuristic calculations with `ai_engine.analyze_case_strength()`
    - Build CaseContext from request parameters
    - Return response matching existing JSON schema
    - Add error handling for AIEngineError exceptions
    - _Requirements: 2.1, 2.5, 2.6, 5.2_

  - [ ] 8.2 Write property test for AI Engine integration
    - **Property 4: AI Engine Integration**
    - **Validates: Requirements 2.1, 2.5, 4.1, 4.2, 4.3**

  - [ ] 8.3 Write property test for response schema compatibility
    - **Property 8: Response Schema Compatibility**
    - **Validates: Requirements 2.6, 5.2**

  - [ ] 8.4 Update /generate-letter endpoint
    - Replace placeholder generation with `ai_engine.generate_document(DocumentType.DEMAND_LETTER)`
    - Build CaseContext from request parameters
    - Return response matching existing JSON schema
    - _Requirements: 4.1, 5.2_

  - [ ] 8.5 Update /generate endpoint (complaints)
    - Replace placeholder generation with `ai_engine.generate_document(DocumentType.COMPLAINT)`
    - Build CaseContext from request parameters
    - Return response matching existing JSON schema
    - _Requirements: 4.2, 5.2_

  - [ ] 8.6 Update /generate-emails endpoint
    - Replace placeholder generation with `ai_engine.generate_document(DocumentType.EMAIL_SEQUENCE)`
    - Build CaseContext from request parameters
    - Return response matching existing JSON schema
    - _Requirements: 4.3, 5.2_

  - [ ] 8.7 Create or update /chat endpoint for "Ask AI" tab
    - Implement endpoint that calls `ai_engine.chat()`
    - Maintain conversation history in session or request
    - Build CaseContext from request parameters
    - Return AI response in JSON format
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 8.8 Write property test for request parameter compatibility
    - **Property 11: Request Parameter Compatibility**
    - **Validates: Requirements 5.3**

- [ ] 9. Implement input validation and error handling
  - [ ] 9.1 Add request validation for all endpoints
    - Validate required fields in CaseContext (facts, legal_theories, etc.)
    - Return 400 Bad Request with specific field errors for invalid inputs
    - Ensure validation errors don't crash the server
    - _Requirements: 7.3_

  - [ ] 9.2 Write property test for invalid input rejection
    - **Property 14: Invalid Input Rejection**
    - **Validates: Requirements 7.3**

  - [ ] 9.3 Add fault isolation and error recovery
    - Ensure individual request failures don't affect subsequent requests
    - Add proper exception handling in all endpoint handlers
    - Log errors without exposing sensitive information
    - _Requirements: 7.5_

  - [ ] 9.4 Write property test for fault isolation
    - **Property 15: Fault Isolation**
    - **Validates: Requirements 7.5**

- [ ] 10. Add logging and monitoring
  - [ ] 10.1 Implement logging strategy
    - Log all exceptions with stack traces
    - Log AI model responses when parsing fails
    - Log configuration errors on startup
    - Log endpoint access with timestamps and response times
    - Log AI interactions (prompt construction, model selection, token usage)
    - Sanitize logs to remove PII
    - _Requirements: 7.4_

  - [ ] 10.2 Write unit tests for logging
    - Test that errors are logged with appropriate levels
    - Test that PII is sanitized from logs
    - Test that AI interactions are logged correctly

- [ ] 11. Create integration tests
  - [ ] 11.1 Write end-to-end tests for all endpoints
    - Test /analyze with mocked AI responses
    - Test /generate-letter with mocked AI responses
    - Test /generate with mocked AI responses
    - Test /generate-emails with mocked AI responses
    - Test /chat with mocked AI responses and conversation history
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ] 11.2 Write integration tests for error scenarios
    - Test model unavailable scenarios
    - Test rate limit scenarios
    - Test invalid configuration scenarios
    - Test malformed AI responses

- [ ] 12. Update documentation and configuration
  - [ ] 12.1 Create configuration documentation
    - Document all environment variables (USE_LOCAL, MODEL_NAME, API_KEY, etc.)
    - Provide examples for local mode configuration
    - Provide examples for cloud mode configuration
    - Document model recommendations for local mode
    - _Requirements: 6.5_

  - [ ] 12.2 Update README with setup instructions
    - Add installation instructions for dependencies (anthropic SDK, llama.cpp or transformers)
    - Add configuration examples
    - Add troubleshooting guide for common errors

- [ ] 13. Final checkpoint - Comprehensive testing
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Each task references specific requirements for traceability
- The implementation follows an incremental approach: core infrastructure → AI integration → endpoint updates → testing
- Property tests validate universal correctness properties across all inputs
- Unit tests validate specific examples, edge cases, and error conditions
- Integration tests validate end-to-end flows with mocked AI responses
