# OpenClaw Zoom Agent

An AI-powered meeting participant that joins Zoom calls via phone and participates conversationally, with OpenClaw as the brain.

## Architecture

```
┌──────────────┐     ┌─────────────┐     ┌─────────────┐     ┌──────────┐
│     Zoom     │◀───▶│   Retell    │◀───▶│  This App   │◀───▶│ LLM API  │
│   Meeting    │     │ (voice I/O) │     │ (brain)     │     │(GPT-4/etc)│
└──────────────┘     └─────────────┘     └─────────────┘     └──────────┘
      PSTN            STT + TTS          WebSocket Server      OpenRouter
```

**How it works:**
1. Retell AI dials into Zoom's PSTN number
2. This server handles conversation logic (IVR navigation + meeting participation)
3. The LLM (via OpenRouter) provides intelligent responses
4. Retell converts text to speech and speaks in the meeting

## Features

- 🎯 **IVR Navigation**: Automatically enters meeting ID and passcode via DTMF
- 🧠 **OpenClaw-powered**: Uses GPT-4o (or any OpenRouter model) as the brain
- 🗣️ **Natural conversation**: Participates like a human colleague
- 📞 **Phone dial-in**: Works with any Zoom meeting that has PSTN dial-in

## Prerequisites

1. **Retell AI Account** - [Sign up](https://retellai.com)
   - API key
   - Phone number (via Telnyx or Twilio)

2. **OpenRouter API Key** - [Get one](https://openrouter.ai)
   - For LLM access (GPT-4o, Claude, etc.)

3. **Public URL** - For Retell to connect to your WebSocket server
   - ngrok, localtunnel, or deploy to cloud

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your keys
```

### 3. Start the server

```bash
npm start
```

### 4. Expose publicly (for local development)

```bash
# Using localtunnel
npx localtunnel --port 8080

# Or using ngrok
ngrok http 8080
```

### 5. Configure Retell Agent

Create an agent in Retell dashboard with:
- **Response Engine**: Custom LLM
- **LLM WebSocket URL**: `wss://your-tunnel-url.com/llm-websocket`

### 6. Join a meeting

```bash
./cli.sh join --meeting-id 12345678901 --passcode 123456
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for LLM access |
| `MODEL` | No | LLM model (default: `openai/gpt-4o`) |
| `PORT` | No | Server port (default: `8080`) |

## CLI Usage

```bash
# Join a meeting
./cli.sh join --meeting-id 12345678901 --passcode 123456

# Join from Zoom link
./cli.sh join --link "https://zoom.us/j/12345678901" --passcode 654321

# Specify who the agent represents
./cli.sh join -m 12345678901 -p 123456 --name "John"

# Check call status
./cli.sh status <call_id>

# End a call
./cli.sh end <call_id>
```

## Configuration

### Retell Agent Settings

Recommended settings for the Retell agent:

```json
{
  "voice_id": "11labs-Adrian",
  "voice_temperature": 0.8,
  "voice_speed": 1.0,
  "responsiveness": 0.8,
  "interruption_sensitivity": 0.7,
  "enable_backchannel": true,
  "backchannel_words": ["uh-huh", "I see", "right", "okay", "got it"],
  "max_call_duration_ms": 7200000
}
```

### Supported LLM Models

Via OpenRouter, you can use:
- `openai/gpt-4o` (default, recommended)
- `openai/gpt-4o-mini` (faster, cheaper)
- `anthropic/claude-3.5-sonnet` (alternative)
- Any model on [OpenRouter](https://openrouter.ai/models)

## Costs

| Component | Cost |
|-----------|------|
| Retell (voice + STT/TTS) | ~$0.10-0.15/min |
| OpenRouter (GPT-4o) | ~$0.01-0.03/min |
| **Total** | **~$0.12-0.18/min** |

For a 1-hour meeting: ~$7-11

## Limitations

1. **Audio only** - Cannot see screen shares or video
2. **Zoom dial-in required** - Meeting must have PSTN dial-in enabled
3. **Host must be present** - Or waiting room must be disabled
4. **English focused** - IVR detection optimized for English Zoom prompts

## Development

```bash
# Start with auto-reload
npm run dev

# Test WebSocket locally
wscat -c ws://localhost:8080/llm-websocket
```

## License

MIT

## Credits

Built with:
- [Retell AI](https://retellai.com) - Voice infrastructure
- [OpenRouter](https://openrouter.ai) - LLM routing
- [OpenClaw](https://openclaw.ai) - AI agent framework
