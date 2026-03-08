#!/usr/bin/env python3
"""
Example usage of the AI Engine with Featherless API.

Make sure to:
1. Create a .env file with your FEATHERLESS_API_KEY
2. Install dependencies: pip install -r requirements.txt
"""

from ai_engine import AIEngine, ConfigLoader

def main():
    # Load configuration from .env file
    try:
        config = ConfigLoader.load_config()
        print(f"Configuration loaded:")
        print(f"  - Mode: {'Featherless' if config.use_featherless else 'Local' if config.use_local else 'Anthropic Claude'}")
        print(f"  - Model: {config.model_name}")
    except Exception as e:
        print(f"Error loading configuration: {e}")
        return
    
    # Initialize the AI Engine
    engine = AIEngine(config)
    print(f"\nAI Engine initialized successfully!")
    
    # Test with a simple prompt
    test_prompt = "What are the key elements of a strong legal case?"
    system_prompt = "You are a legal expert. Provide clear, concise answers."
    
    print(f"\nTest prompt: {test_prompt}")
    print("Generating response...")
    
    try:
        response = engine.router.complete(test_prompt, system_prompt)
        print(f"\nResponse:\n{response}")
    except Exception as e:
        print(f"Error during inference: {e}")

if __name__ == "__main__":
    main()
