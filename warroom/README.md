# War Room - ClaudeClaw Voice Meeting Server

Real-time voice conversations with ClaudeClaw's AI agents. Each agent has a distinct voice. You speak, the right agent responds.

## Prerequisites

- Python 3.10+
- A Google AI API key (for Gemini Live native audio)
- A Daily.co account (only required for the `meet` video-meeting flow; the local voice WebSocket transport doesn't need it)
- The ClaudeClaw Node.js project built (`npm run build`)

## Setup

1. Install Python dependencies:

```bash
pip install -r warroom/requirements.txt
```

2. Set your API keys in the project `.env` (or export them):

```
GOOGLE_API_KEY=your_google_ai_key
DAILY_API_KEY=your_daily_key   # optional, only for `meet` mode
```

3. (Optional) Configure agent voices in `warroom/voices.json`. Each agent maps to a Gemini Live voice name (e.g. `Charon`, `Kore`, `Puck`). The dashboard's Voices page edits this file live.

## Running

```bash
python warroom/server.py
```

The server defaults to `WARROOM_MODE=live` and starts a local WebSocket transport that the browser-side war room client connects to. Open the war room in the dashboard to talk to your agents.

## How it works (live mode, default)

```
Microphone -> Browser WebSocket -> Gemini Live (speech-to-speech) -> Tool calls -> Browser
```

- Gemini Live handles speech-to-speech natively. There's no separate STT or TTS step in the pipeline.
- Tool calls hand off to sub-agents via `mission-cli` (async) or run inline (synchronous, for fast answers like "what time is it").
- The `answer_as_agent` tool routes a question to a specific agent and returns its reply for Gemini to speak in that agent's voice.

## Voice Routing

Address agents by name in your speech:

- "Main, what's on my schedule?"
- "Hey research, look into competitor pricing"
- "Ops, restart the service"
- "Everyone, give me a status update" (broadcasts to all agents)

If no agent name is detected, the message routes to the main agent.

## Customizing Voices

Edit `warroom/voices.json` to map each agent to a Gemini Live voice name. Available names live in `warroom/config.py` under `AGENT_VOICES`. The dashboard's Voices page is the easiest way to edit and apply changes without restarting manually.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_API_KEY` | Yes (live mode) | Google AI key for Gemini Live |
| `WARROOM_MODE` | No | `live` (default) or `legacy` |
| `WARROOM_PORT` | No | WebSocket port (default: 7860) |
| `WARROOM_LIVE_MODEL` | No | Gemini Live model id |
| `WARROOM_LIVE_VOICE` | No | Default Gemini voice name (default: `Charon`) |
| `DAILY_API_KEY` | Only for `meet` flow | Daily.co API key for video meetings |
| `WARROOM_DAILY_ROOM_URL` | No | Use an existing Daily room instead of creating one |

## Legacy mode (deprecated)

`WARROOM_MODE=legacy` keeps the original stitched STT → router → Claude bridge → TTS chain (Deepgram + Cartesia). Higher latency, but every utterance goes through the full Claude Code stack with skills/MCP. Set `DEEPGRAM_API_KEY` and `CARTESIA_API_KEY` only if you need this path. Default is `live` and most users should not touch it.
