"""
AgentRouter: a Pipecat FrameProcessor that inspects transcribed speech
and decides which ClaudeClaw agent should handle the message.

Routing rules (in priority order):
  1. Broadcast triggers: "everyone, status update" -> round-robin all agents
  2. Name prefix detection: "Research, what's the latest on X" -> research agent
  3. Pinned agent (from /tmp/warroom-pin.json, set by the dashboard
     click-to-pin UI) -> pinned agent
  4. Default fallback: routes to the main agent
"""

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from pipecat.frames.frames import (
    DataFrame,
    InterimTranscriptionFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection


logger = logging.getLogger("warroom.router")

# Shared state with the dashboard (src/dashboard.ts POST /api/warroom/pin).
# Writing via the dashboard; reading here. The Pipecat server and the Hono
# dashboard are separate processes, so we use this tiny file as IPC.
PIN_PATH = Path("/tmp/warroom-pin.json")

# Live roster snapshot written by Node-side refreshWarRoomRoster(). Pipecat
# used to hardcode AGENT_NAMES which silently broke name-prefix routing for
# user-created agents. We now mtime-cache the roster file and rebuild the
# regex when the roster changes, so a new agent in the dashboard immediately
# becomes addressable by voice prefix ("hey analytics, ...").
ROSTER_PATH = Path("/tmp/warroom-agents.json")

# Default fallback if the roster file is missing/unreadable. Matches the
# bundled built-in agents so a fresh install still routes correctly.
_DEFAULT_AGENT_NAMES = frozenset({"main", "research", "comms", "content", "ops"})

# Module-level mutable set, kept for back-compat with agent_bridge.py which
# imports AGENT_NAMES directly. _refresh_agent_names_from_roster mutates
# this set in place so importers see the live roster.
AGENT_NAMES: set = set(_DEFAULT_AGENT_NAMES)

# Phrases that trigger a broadcast to all agents
BROADCAST_TRIGGERS = {
    "everyone", "all", "team", "standup",
    "status update", "status report",
}

# Common casual prefixes people use before an agent name
_GREETING_PREFIXES = r"(?:hey|yo|ok|okay|alright)?\s*"

# Build a pattern for broadcast triggers (the trigger words are stable, no
# need to make this dynamic).
_broadcast_pattern = re.compile(
    rf"\b({'|'.join(BROADCAST_TRIGGERS)})\b",
    re.IGNORECASE,
)

# Roster mtime cache + lazily-rebuilt agent-prefix regex.
_roster_mtime: float = 0.0
_agent_pattern: Optional[re.Pattern] = None


def _build_agent_pattern(names: set) -> re.Pattern:
    safe = sorted((re.escape(n) for n in names if n), key=len, reverse=True)
    return re.compile(
        rf"^\s*{_GREETING_PREFIXES}({'|'.join(safe)})[,:\s]+(.+)",
        re.IGNORECASE | re.DOTALL,
    )


def _refresh_agent_names_from_roster() -> None:
    """Re-read /tmp/warroom-agents.json if the file's mtime changed.
    Updates AGENT_NAMES in place and invalidates the compiled regex.
    Falls back to last-good values on any error."""
    global _roster_mtime, _agent_pattern
    try:
        st = os.stat(ROSTER_PATH)
    except (FileNotFoundError, OSError):
        return
    if st.st_mtime == _roster_mtime:
        return
    try:
        with open(ROSTER_PATH, "r") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        logger.warning("roster read failed, keeping cached AGENT_NAMES: %s", exc)
        return
    if not isinstance(data, list):
        logger.warning("roster JSON is not a list; ignoring")
        return
    new_names = {
        entry["id"] for entry in data
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]
    }
    if not new_names:
        return
    # Always include "main" — it's the implicit default route target.
    new_names.add("main")
    if new_names != AGENT_NAMES:
        AGENT_NAMES.clear()
        AGENT_NAMES.update(new_names)
        _agent_pattern = None  # force rebuild on next access
        logger.info("agent roster refreshed: %s", sorted(AGENT_NAMES))
    _roster_mtime = st.st_mtime


def _get_agent_pattern() -> re.Pattern:
    global _agent_pattern
    _refresh_agent_names_from_roster()
    if _agent_pattern is None:
        _agent_pattern = _build_agent_pattern(AGENT_NAMES)
    return _agent_pattern


# Initialize once at import so AGENT_NAMES reflects the on-disk roster
# even before the first utterance arrives.
_refresh_agent_names_from_roster()


@dataclass
class AgentRouteFrame(DataFrame):
    """Custom frame carrying routing metadata alongside the user message.

    Inherits from DataFrame so it picks up the standard Pipecat frame
    attributes (id, name, pts, metadata). Without this, observers like
    IdleFrameObserver crash when they try to read frame.id.
    """
    agent_id: str = ""
    message: str = ""
    mode: str = "single"  # "single" or "broadcast"


class AgentRouter(FrameProcessor):
    """Receives TextFrames from STT, determines routing, and pushes
    AgentRouteFrames downstream to the ClaudeAgentBridge."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # mtime-cached read of /tmp/warroom-pin.json so we don't stat+parse
        # on every single utterance; only re-read when the file changes.
        self._pin_mtime: float = 0.0
        self._pin_agent: Optional[str] = None

    def _get_pinned_agent(self) -> Optional[str]:
        """Return the currently pinned agent id, or None. Reads the pin
        file only when its mtime has changed since the last read."""
        try:
            st = os.stat(PIN_PATH)
        except FileNotFoundError:
            if self._pin_agent is not None:
                logger.info("pin cleared (file removed)")
            self._pin_mtime = 0.0
            self._pin_agent = None
            return None
        except OSError as exc:
            logger.debug("pin stat failed: %s", exc)
            return self._pin_agent

        if st.st_mtime != self._pin_mtime:
            self._pin_mtime = st.st_mtime
            try:
                with open(PIN_PATH, "r") as f:
                    data = json.load(f)
                # The pin file is written by the Hono dashboard, but an
                # attacker or a buggy process could drop arbitrary JSON
                # into /tmp/warroom-pin.json. Defend against non-dict
                # top-level values (strings, lists, numbers) that would
                # otherwise crash .get() with AttributeError.
                _refresh_agent_names_from_roster()
                agent = data.get("agent") if isinstance(data, dict) else None
                if isinstance(agent, str) and agent in AGENT_NAMES:
                    if agent != self._pin_agent:
                        logger.info("pin now: %s", agent)
                    self._pin_agent = agent
                else:
                    self._pin_agent = None
            except (OSError, json.JSONDecodeError, ValueError) as exc:
                logger.debug("pin read failed: %s", exc)
                self._pin_agent = None

        return self._pin_agent

    async def process_frame(self, frame, direction: FrameDirection):
        # CRITICAL: Must call super first so the parent registers StartFrame and
        # initializes the processor's started state. Without this, system frames
        # (StartFrame, EndFrame, MetricsFrame) cause "not received yet" errors.
        await super().process_frame(frame, direction)

        # Drop interim (non-final) transcription frames. Deepgram emits
        # InterimTranscriptionFrame for every partial like "What", "What is",
        # "What is the", then a final TranscriptionFrame. Without this filter,
        # each partial was triggering a separate Claude SDK call AND each new
        # partial's TTS was cancelling the previous one (allow_interruptions=True),
        # which meant users could speak once and rack up 5+ bridge calls while
        # receiving ~zero audio back.
        if isinstance(frame, InterimTranscriptionFrame):
            return

        # Only process final transcriptions for routing. Any other TextFrame
        # subclass passes through unchanged (e.g. TTS-generated TextFrames
        # flowing downstream to Cartesia).
        if direction != FrameDirection.DOWNSTREAM or not isinstance(frame, TranscriptionFrame):
            await self.push_frame(frame, direction)
            return

        text = frame.text.strip()
        if not text:
            return

        # Check for broadcast triggers first
        if _broadcast_pattern.search(text):
            cleaned = _broadcast_pattern.sub("", text).strip(" ,:")
            message = cleaned if cleaned else text
            route = AgentRouteFrame(
                agent_id="all",
                message=message,
                mode="broadcast",
            )
            await self.push_frame(route)
            return

        # Check for agent name prefix (regex rebuilt lazily when the
        # /tmp/warroom-agents.json roster file changes)
        match = _get_agent_pattern().match(text)
        if match:
            agent_id = match.group(1).lower()
            message = match.group(2).strip()
            route = AgentRouteFrame(
                agent_id=agent_id,
                message=message,
                mode="single",
            )
            await self.push_frame(route)
            return

        # Pinned agent (set via /api/warroom/pin, e.g. by clicking an
        # agent card on the dashboard). Only affects the default route —
        # explicit spoken prefixes and broadcasts above still win.
        pinned = self._get_pinned_agent()
        if pinned:
            route = AgentRouteFrame(
                agent_id=pinned,
                message=text,
                mode="single",
            )
            await self.push_frame(route)
            return

        # Default: route to main agent
        route = AgentRouteFrame(
            agent_id="main",
            message=text,
            mode="single",
        )
        await self.push_frame(route)
