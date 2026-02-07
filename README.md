# 🦞 OpenClaw Zoom Agent

AI voice agent that joins Zoom meetings via PSTN dial-in. Listens, transcribes, and speaks with AI-generated responses.

## How It Works

```
You → "Join my Zoom" → Agent dials Zoom PSTN → DTMF joins meeting
                      → Live transcription via Telnyx webhooks
                      → AI responses via GPT-4o-mini → Telnyx TTS
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in your credentials
cp .env.example .env

# 3. Join a meeting
node m3-voice-agent.js -m 83914076399 -p 953856
```

## CLI Options

```
node m3-voice-agent.js [options]

  -m, --meeting-id <id>     Zoom meeting ID (required)
  -p, --passcode <code>     Meeting passcode
  -d <seconds>              Max duration (default: 600)
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELNYX_API_KEY` | ✅ | Telnyx API key |
| `TELNYX_DID` | ✅ | Your Telnyx phone number |
| `TELNYX_CONNECTION_ID` | ✅ | Call control application ID |
| `OPENAI_API_KEY` | ✅ | OpenAI API key (for GPT responses) |
| `ZOOM_DIAL_IN` | | Zoom dial-in number (default: +16699009128) |
| `AGENT_NAME` | | Display name (default: "AI Assistant") |
| `AGENT_ROLE` | | Role description |
| `AGENT_INSTRUCTIONS` | | Custom system prompt |
| `BUFFER_DELAY` | | Ms to wait before responding (default: 1500) |
| `NO_SPEAK` | | Set to "true" for listen-only mode |
| `TRANSCRIPT_FILE` | | Path to save transcript after call |

## Architecture

### Files

| File | Purpose |
|------|---------|
| `m3-voice-agent.js` | **Main agent** — full voice loop (transcribe + respond + speak) |
| `m2-live-transcribe.js` | Transcription-only mode (no AI responses) |
| `bridge.js` | WebSocket bridge (requires public URL for media streaming) |
| `server.js` | Legacy Retell AI integration |

### Flow

1. **Dial** — Telnyx PSTN call to Zoom dial-in number
2. **Join** — DTMF sequence: meeting ID → skip participant ID → passcode
3. **Tunnel** — ngrok exposes local webhook server for Telnyx events
4. **Transcribe** — Telnyx real-time transcription (Engine B)
5. **Think** — GPT-4o-mini generates response from transcript
6. **Speak** — Telnyx TTS speaks response into the call

### Timing

- ~15s for Zoom IVR greeting
- ~13s for DTMF sequence (meeting ID + passcode)
- ~1.5s buffer before responding (configurable)
- Total join time: ~30s

## Requirements

- Node.js 18+
- [ngrok](https://ngrok.com/) installed and authenticated
- Telnyx account with:
  - A phone number (DID)
  - Call control application (outbound channel limit ≥ 2)
- OpenAI API key

## Telnyx Setup

1. Create a [Call Control Application](https://portal.telnyx.com/#/app/call-control/applications)
2. Set outbound channel limit to at least 2
3. Assign your phone number to the application
4. Note the connection ID — that's your `TELNYX_CONNECTION_ID`

The webhook URL is set dynamically at runtime via the API (no manual config needed).

## Language Support

The agent responds in the same language the speaker uses:
- English → English response
- Chinese (Mandarin) → Chinese response
- Mixed → dominant language

Telnyx TTS supports `en-US` and `cmn-CN` voices.

## Limitations

- **Voice quality**: Telnyx basic TTS (robotic). Upgrade path: OpenAI TTS → audio streaming.
- **Latency**: ~2-4s round-trip (transcription + GPT + TTS). Reducible with streaming.
- **One call per instance**: Run multiple instances for concurrent meetings.
- **PSTN only**: No Zoom SDK integration (yet). Phone audio quality.

## License

MIT
