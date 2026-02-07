/**
 * OpenClaw Zoom Voice Agent — Bridge Service
 * 
 * Connects Telnyx PSTN audio ↔ OpenAI STT/TTS ↔ OpenClaw brain.
 * 
 * MVP Milestone 1: Dial Zoom + join via DTMF
 * MVP Milestone 2: STT transcript feed (silent mode)  
 * MVP Milestone 3: TTS speaking on command
 * MVP Milestone 4: Wake word + barge-in + rate limiting
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import OpenAI from 'openai';
import { EventEmitter } from 'events';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 8080;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_BASE = 'https://api.telnyx.com/v2';

// --- Telnyx REST helper ---
async function telnyxAPI(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${TELNYX_BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`Telnyx ${method} ${path}: ${res.status} ${JSON.stringify(data.errors || data)}`);
  return data;
}

// --- Clients ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Logger ---
function log(level, msg, data = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= levels[LOG_LEVEL]) {
    const ts = new Date().toISOString();
    const dataStr = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}${dataStr}`);
  }
}

// ============================================================
// ZoomDialer — State machine for joining Zoom via DTMF
// ============================================================
class ZoomDialer extends EventEmitter {
  constructor(config) {
    super();
    this.meetingId = config.meetingId;
    this.passcode = config.passcode || '';
    this.dialInNumber = config.dialInNumber || process.env.ZOOM_DIAL_IN || '+16699009128';
    this.fromNumber = config.fromNumber || process.env.TELNYX_DID;
    this.connectionId = process.env.TELNYX_CONNECTION_ID;
    
    this.state = 'IDLE';
    this.callControlId = null;
    this.callLegId = null;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.dtmfQueue = [];
    this.dtmfTimer = null;
    
    // Timeouts (ms)
    this.timeouts = {
      answer: 30000,
      dtmfDelay: 2000,      // Wait before sending DTMF after answer
      dtmfPacing: 500,       // Between individual digits
      dtmfGroupDelay: 3000,  // Between meeting ID and passcode
      joinConfirm: 15000,    // Wait for "joined" confirmation
      ivrRetry: 5000,        // Retry DTMF if no progress
    };

    log('info', 'ZoomDialer initialized', { 
      meetingId: this.meetingId.replace(/./g, '*'),
      dialIn: this.dialInNumber 
    });
  }

  // State transitions
  setState(newState) {
    const oldState = this.state;
    this.state = newState;
    log('info', `State: ${oldState} → ${newState}`);
    this.emit('state', { from: oldState, to: newState });
  }

  // Start the dial sequence
  async dial() {
    if (this.state !== 'IDLE' && this.state !== 'FAILED') {
      log('warn', `Cannot dial in state ${this.state}`);
      return;
    }

    this.setState('DIALING');

    try {
      const callBody = {
        connection_id: this.connectionId,
        to: this.dialInNumber,
        from: this.fromNumber,
        timeout_secs: 30,
      };
      
      // Add media streaming if bridge host is configured
      if (process.env.BRIDGE_HOST) {
        callBody.stream_url = `wss://${process.env.BRIDGE_HOST}/media`;
        callBody.stream_track = 'both_tracks';
      }

      const result = await telnyxAPI('POST', '/calls', callBody);
      this.callControlId = result.data.call_control_id;
      this.callLegId = result.data.call_leg_id;
      log('info', 'Call initiated', { callControlId: this.callControlId });

      // Set answer timeout
      this._answerTimeout = setTimeout(() => {
        if (this.state === 'DIALING') {
          log('warn', 'Answer timeout');
          this.handleFailure('NO_ANSWER');
        }
      }, this.timeouts.answer);

    } catch (err) {
      log('error', 'Dial failed', { error: err.message });
      this.handleFailure('DIAL_ERROR');
    }
  }

  // Handle Telnyx webhook events
  async handleEvent(event) {
    const eventType = event.event_type || event.data?.event_type;
    log('debug', `Telnyx event: ${eventType}`, { state: this.state });

    switch (eventType) {
      case 'call.answered':
        clearTimeout(this._answerTimeout);
        this.setState('ANSWERED');
        // Wait for Zoom IVR greeting, then send DTMF
        setTimeout(() => this.enterMeetingId(), this.timeouts.dtmfDelay);
        break;

      case 'call.dtmf.received':
        // Zoom may echo DTMF — ignore
        break;

      case 'call.hangup':
        log('info', 'Call ended', { reason: event.data?.hangup_cause });
        this.setState('ENDED');
        this.emit('ended', { reason: event.data?.hangup_cause });
        break;

      case 'call.bridged':
      case 'call.speak.ended':
        // Could indicate joined
        break;

      case 'streaming.started':
        log('info', 'Media streaming started');
        this.emit('streaming', true);
        break;

      case 'streaming.stopped':
        log('info', 'Media streaming stopped');
        this.emit('streaming', false);
        break;

      default:
        log('debug', `Unhandled event: ${eventType}`);
    }
  }

  // Send meeting ID via DTMF
  async enterMeetingId() {
    this.setState('ENTER_MEETING_ID');
    const digits = this.meetingId.replace(/\s/g, '') + '#';
    log('info', 'Sending meeting ID DTMF', { length: digits.length });
    await this.sendDTMF(digits);

    // After sending meeting ID, wait then send passcode
    setTimeout(() => {
      if (this.state === 'ENTER_MEETING_ID') {
        this.enterPasscode();
      }
    }, this.timeouts.dtmfGroupDelay);
  }

  // Send passcode via DTMF  
  async enterPasscode() {
    this.setState('ENTER_PASSCODE');
    
    if (this.passcode) {
      const digits = this.passcode + '#';
      log('info', 'Sending passcode DTMF');
      await this.sendDTMF(digits);
    } else {
      // No passcode — just send # to skip
      log('info', 'No passcode, sending # to skip');
      await this.sendDTMF('#');
    }

    // Wait for join confirmation
    setTimeout(() => {
      if (this.state === 'ENTER_PASSCODE') {
        // Assume joined if no error after timeout
        this.confirmJoined();
      }
    }, this.timeouts.joinConfirm);
  }

  // Confirm joined meeting
  confirmJoined() {
    this.setState('IN_MEETING');
    log('info', '✅ Joined Zoom meeting');
    this.emit('joined');
  }

  // Send DTMF digits with pacing
  async sendDTMF(digits) {
    try {
      await telnyxAPI('POST', `/calls/${this.callControlId}/actions/send_dtmf`, {
        digits: digits,
        duration_millis: 250,
      });
      log('debug', 'DTMF sent', { digits: digits.replace(/\d/g, '*') });
    } catch (err) {
      log('error', 'DTMF send failed', { error: err.message });
    }
  }

  // Handle failures
  handleFailure(reason) {
    log('warn', `Failure: ${reason}`, { retry: this.retryCount });
    
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      this.setState('IDLE');
      const delay = Math.min(2000 * Math.pow(2, this.retryCount), 30000);
      log('info', `Retrying in ${delay}ms (attempt ${this.retryCount}/${this.maxRetries})`);
      setTimeout(() => this.dial(), delay);
    } else {
      this.setState('FAILED');
      this.emit('failed', { reason, retries: this.retryCount });
    }
  }

  // Hangup
  async hangup() {
    if (this.callControlId) {
      try {
        await telnyxAPI('POST', `/calls/${this.callControlId}/actions/hangup`, {});
        log('info', 'Call hung up');
      } catch (err) {
        log('error', 'Hangup failed', { error: err.message });
      }
    }
    this.setState('ENDED');
  }
}

// ============================================================
// MediaBridge — Audio streaming + STT/TTS (Milestone 2+)
// ============================================================
class MediaBridge extends EventEmitter {
  constructor() {
    super();
    this.audioBuffer = [];
    this.isSpeaking = false;
    this.ttsAbortController = null;
  }

  // Handle incoming audio from Telnyx WS
  handleAudio(audioData, track) {
    if (track === 'inbound') {
      // Audio from Zoom participants
      this.audioBuffer.push(audioData);
      this.emit('audio_in', audioData);
      
      // TODO Milestone 2: VAD + chunking → OpenAI STT
      // TODO Milestone 4: Barge-in detection during TTS playback
    }
  }

  // TODO Milestone 3: Generate TTS and stream back
  async speak(text, ws) {
    if (!text) return;
    
    log('info', 'TTS requested', { text: text.slice(0, 50) });
    this.isSpeaking = true;
    this.ttsAbortController = new AbortController();

    try {
      const response = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'onyx',
        input: text,
        response_format: 'pcm', // Raw PCM for streaming
      });

      // Stream audio back to Telnyx WS
      const buffer = Buffer.from(await response.arrayBuffer());
      // TODO: Chunk and pace the audio frames to Telnyx
      
      log('info', 'TTS complete', { bytes: buffer.length });
    } catch (err) {
      log('error', 'TTS failed', { error: err.message });
    } finally {
      this.isSpeaking = false;
    }
  }

  // Cancel current TTS (barge-in)
  cancelSpeech() {
    if (this.isSpeaking && this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.isSpeaking = false;
      log('info', 'TTS cancelled (barge-in)');
    }
  }
}

// ============================================================
// HTTP Server + WebSocket + Webhook endpoints
// ============================================================
const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

// Active sessions
const sessions = new Map();

// --- Telnyx Webhook endpoint ---
app.post('/webhook/telnyx', async (req, res) => {
  const event = req.body?.data || req.body;
  const eventType = event?.event_type;
  const payload = event?.payload || event;
  const callControlId = payload?.call_control_id;

  log('debug', `Webhook: ${eventType}`, { callControlId: callControlId?.slice(0, 20) });

  // Find the session for this call
  for (const [id, session] of sessions) {
    if (session.dialer.callControlId === callControlId) {
      session.dialer.handleEvent({ data: payload, event_type: eventType });
      break;
    }
  }

  res.sendStatus(200);
});

// --- API: Start a call ---
app.post('/api/call', async (req, res) => {
  const { meetingId, passcode, dialInNumber } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'meetingId is required' });
  }

  const sessionId = crypto.randomUUID();
  const dialer = new ZoomDialer({ meetingId, passcode, dialInNumber });
  const bridge = new MediaBridge();

  const session = { id: sessionId, dialer, bridge, createdAt: new Date() };
  sessions.set(sessionId, session);

  dialer.on('state', ({ from, to }) => {
    log('info', `[${sessionId.slice(0, 8)}] ${from} → ${to}`);
  });

  dialer.on('joined', () => {
    log('info', `[${sessionId.slice(0, 8)}] ✅ IN MEETING`);
  });

  dialer.on('failed', ({ reason }) => {
    log('error', `[${sessionId.slice(0, 8)}] ❌ FAILED: ${reason}`);
    sessions.delete(sessionId);
  });

  dialer.on('ended', () => {
    sessions.delete(sessionId);
  });

  await dialer.dial();

  res.json({ 
    sessionId, 
    state: dialer.state,
    message: 'Dialing Zoom...' 
  });
});

// --- API: Get session status ---
app.get('/api/call/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    sessionId: session.id,
    state: session.dialer.state,
    createdAt: session.createdAt,
  });
});

// --- API: Hangup ---
app.post('/api/call/:id/hangup', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  await session.dialer.hangup();
  sessions.delete(req.params.id);
  res.json({ message: 'Call ended' });
});

// --- API: Speak (Milestone 3) ---
app.post('/api/call/:id/speak', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  // TODO: Wire to MediaBridge TTS
  res.json({ message: 'TTS queued', text: text.slice(0, 50) });
});

// --- WebSocket: Telnyx media stream ---
wss.on('connection', (ws, req) => {
  log('info', 'Telnyx media WebSocket connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.event === 'media') {
        // Audio frame from Telnyx
        const audioData = Buffer.from(msg.media.payload, 'base64');
        const track = msg.media.track; // 'inbound' or 'outbound'
        
        // Route to the appropriate session's bridge
        for (const [id, session] of sessions) {
          session.bridge.handleAudio(audioData, track);
        }
      } else if (msg.event === 'start') {
        log('info', 'Media stream started', { 
          streamId: msg.stream_id,
          callControlId: msg.start?.call_control_id 
        });
      } else if (msg.event === 'stop') {
        log('info', 'Media stream stopped');
      }
    } catch (err) {
      log('error', 'WS message parse error', { error: err.message });
    }
  });

  ws.on('close', () => {
    log('info', 'Telnyx media WebSocket closed');
  });

  ws.on('error', (err) => {
    log('error', 'Telnyx media WebSocket error', { error: err.message });
  });
});

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    sessions: sessions.size,
    uptime: process.uptime() 
  });
});

// --- Start server ---
server.listen(PORT, () => {
  log('info', `🦞 OpenClaw Zoom Bridge running on port ${PORT}`);
  log('info', `Endpoints:`);
  log('info', `  POST /api/call          — Start a call`);
  log('info', `  GET  /api/call/:id      — Get status`);
  log('info', `  POST /api/call/:id/hangup — Hangup`);
  log('info', `  POST /api/call/:id/speak  — TTS (M3)`);
  log('info', `  POST /webhook/telnyx    — Telnyx webhooks`);
  log('info', `  WS   /media             — Telnyx media stream`);
});
