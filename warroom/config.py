"""
Configuration loader for the War Room voice server.

Resolves the project root, loads agent voice mappings from voices.json,
and exposes environment variable helpers.
"""

import json
import os
import subprocess
from pathlib import Path


def get_project_root() -> Path:
    """Resolve the ClaudeClaw project root via git or file path fallback."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
            cwd=Path(__file__).parent,
        )
        return Path(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Fallback: warroom/ sits one level below project root
        return Path(__file__).resolve().parent.parent


PROJECT_ROOT = get_project_root()
WARROOM_DIR = PROJECT_ROOT / "warroom"
VOICES_FILE = WARROOM_DIR / "voices.json"


def load_voices() -> dict:
    """Load agent voice configs from voices.json.

    Returns a dict mapping agent_id to {voice_id, name}.
    """
    if not VOICES_FILE.exists():
        raise FileNotFoundError(f"Voice config not found at {VOICES_FILE}")

    with open(VOICES_FILE, "r") as f:
        return json.load(f)


# Pre-load at import time so other modules can use it directly
AGENT_VOICES = load_voices()

# Default agent if routing can't determine who should respond
DEFAULT_AGENT = "main"
