# OpenClaw Zoom Voice Agent — Design Spec

## Architecture

```
┌─────────────┐     PSTN      ┌─────────┐     WebSocket     ┌──────────────┐
│   Zoom      │◄─────────────►│ Telnyx  │◄──────────────────►│   Bridge     │
│   Meeting   │   Audio Call   │  PSTN   │   Audio Frames    │   Service    │
└─────────────┘               └─────────┘                    └──────┬───────┘
                                                                    │
                                                    ┌───────────────┼───────────────┐
                                                    │               │               │
                                                    ▼               ▼               ▼
                                              ┌──────────┐  ┌──────────┐  ┌──────────────┐
                                              │ OpenAI   │  │ OpenAI   │  │  OpenClaw    │
                                              │ STT API  │  │ TTS API  │  │  (Brain)     │
                                              └──────────┘  └──────────┘  └──────────────┘
```

## Components

### 1. OpenClaw (Agent Brain)
- Owns workflow, policies, decisions
- Controls call via voice_call interface
- Meeting etiquette: wake word, address-only, 10% talk cap

### 2. Telnyx (Telephony)
- Outbound PSTN call to Zoom
- DTMF for meeting ID/passcode
- Bidirectional audio streaming via WebSocket

### 3. Bridge Service (Media Gateway)
- Telnyx WS ↔ OpenAI STT/TTS ↔ OpenClaw
- VAD + chunking
- Barge-in support
- Stateless, restart-safe

### 4. OpenAI (Speech Only)
- STT: v1/audio/transcriptions
- TTS: v1/audio/speech (tts-1)

## MVP Milestones

1. ✅ Dial Zoom and join via DTMF (no speech)
2. Add STT transcript feed (silent mode)
3. Add TTS speaking (manual trigger)
4. Wake word + barge-in + rate limiting
5. Production hardening

## ZoomDialer States

DIALING → ANSWERED → ENTER_MEETING_ID → ENTER_PASSCODE → CONFIRM_JOINED → IN_MEETING
Failure: BUSY | NO_ANSWER | BAD_PASSCODE | WAITING_ROOM_TIMEOUT | IVR_LOOP

## Required Credentials

- TELNYX_API_KEY
- TELNYX_DID (phone number)
- TELNYX_CONNECTION_ID (SIP connection)
- OPENAI_API_KEY (for STT/TTS)
