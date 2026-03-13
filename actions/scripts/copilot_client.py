"""GitHub Copilot SDK client for making LLM requests."""

import asyncio
from typing import List, Dict, Any, Optional
from copilot import CopilotClient, PermissionHandler


# Global client instance (managed lifecycle)
_client: Optional[CopilotClient] = None
_client_lock = asyncio.Lock()


async def get_client() -> CopilotClient:
    """Get or create the global Copilot client instance."""
    global _client
    async with _client_lock:
        if _client is None:
            _client = CopilotClient()
            await _client.start()
        return _client


async def shutdown_client():
    """Shutdown the global Copilot client."""
    global _client
    async with _client_lock:
        if _client is not None:
            await _client.stop()
            _client = None


async def query_model(
    model: str,
    messages: List[Dict[str, str]]
) -> Optional[Dict[str, Any]]:
    """
    Query a single model via GitHub Copilot SDK.

    Args:
        model: Copilot SDK model identifier (e.g., "gpt-4.1", "claude-sonnet-4")
        messages: List of message dicts with 'role' and 'content'

    Returns:
        Response dict with 'content' and optional 'reasoning_details', or None if failed
    """
    try:
        client = await get_client()
        
        # Create a session with the specified model
        session = await client.create_session({
            "model": model,
            "on_permission_request": PermissionHandler.approve_all,
        })
        
        # Build the prompt from messages
        # For now, we'll concatenate messages into a single prompt
        # The Copilot SDK handles conversation context internally
        prompt = ""
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                prompt = f"System: {content}\n\n" + prompt
            elif role == "user":
                prompt += f"{content}\n"
            elif role == "assistant":
                prompt += f"Assistant: {content}\n"
        
        prompt = prompt.strip()
        
        # Send the prompt and wait for response (timeout in ms: 3000s = 3000000ms)
        response = await session.send_and_wait({"prompt": prompt}, timeout=3000000)
        
        if response and response.data:
            return {
                'content': response.data.content,
                'reasoning_details': None  # Copilot SDK may not provide this directly
            }
        
        return None

    except Exception as e:
        print(f"Error querying model {model}: {e}")
        return None


async def query_models_parallel(
    models: List[str],
    messages: List[Dict[str, str]]
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Query multiple models in parallel.

    Args:
        models: List of Copilot SDK model identifiers
        messages: List of message dicts to send to each model

    Returns:
        Dict mapping model identifier to response dict (or None if failed)
    """
    # Create tasks for all models
    tasks = [query_model(model, messages) for model in models]

    # Wait for all to complete
    responses = await asyncio.gather(*tasks)

    # Map models to their responses
    return {model: response for model, response in zip(models, responses)}
