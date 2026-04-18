"""Configuration for the Gatekeeper Council using GitHub Copilot SDK."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Council members - list of Copilot SDK supported models
# Available models: gpt-4.1, gpt-4o, gpt-4o-mini, claude-sonnet-4, etc.
COUNCIL_MODELS = [
    "gpt-4.1",
    "claude-sonnet-4",
    "gpt-5-mini",
]

# Chairman model - synthesizes final response
CHAIRMAN_MODEL = "gpt-4.1"

# Model for title generation (fast model)
TITLE_MODEL = "gpt-4o"

