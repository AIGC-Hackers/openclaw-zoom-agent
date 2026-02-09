/**
 * Gemini Live Voice Agent for Zoom
 * 
 * Architecture:
 *   Zoom → Telnyx PSTN → [this bridge] → Gemini Live API (STT + TTS)
 *                                              ↕ function calling
 *                                         OpenClaw agent (brain)
 *
 * Gemini handles audio I/O natively. When it needs the "brain",
 * it calls the `ask_assistant` function → we route to OpenClaw.
 * 
 * Audio format bridge:
 *   Telnyx: µ-law 8kHz mono (PCMU)
 *   Gemini: Linear PCM 16kHz mono (16-bit LE)
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 8181;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_BASE = 'https://api.telnyx.com/v2';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-latest';

const args = process.argv.slice(2);
const meetingId = args.find((_, i) => args[i - 1] === '-m');
const passcode = args.find((_, i) => args[i - 1] === '-p');
const duration = parseInt(args.find((_, i) => args[i - 1] === '-d') || '600');

if (!meetingId) {
  console.error('Usage: node gemini-live-agent.js -m MEETING_ID -p PASSCODE [-d DURATION]');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error('Error: GEMINI_API_KEY or GOOGLE_API_KEY required');
  process.exit(1);
}

const AGENT_NAME = process.env.AGENT_NAME || 'AI Assistant';
const AGENT_ROLE = process.env.AGENT_ROLE || "Kai's AI assistant";

// --- Telnyx REST (with retry) ---
async function telnyxApi(method, path, body, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${TELNYX_BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Telnyx ${res.status}: ${JSON.stringify(data.errors || data)}`);
      return data;
    } catch (err) {
      if (attempt < retries && (err.cause?.code === 'ECONNRESET' || err.message.includes('fetch failed'))) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }

// --- µ-law ↔ PCM conversion ---
// µ-law decode table
const ULAW_DECODE = new Int16Array(256);
(function buildTable() {
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xFF;
    let sign = u & 0x80;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0F;
    let sample = (mantissa << 3) + 0x84;
    sample <<= exponent;
    sample -= 0x84;
    ULAW_DECODE[i] = sign ? -sample : sample;
  }
})();

// PCM encode to µ-law table
function pcmToUlaw(sample) {
  const BIAS = 0x84;
  const MAX = 32635;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MAX) sample = MAX;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Convert µ-law 8kHz buffer to PCM 16kHz (linear interpolation with cross-chunk carry)
let _lastSample = 0; // carry last sample across chunks to avoid boundary clicks

function ulawToPcm16k(ulawBuf) {
  const n = ulawBuf.length;
  const pcm16k = Buffer.alloc(n * 4); // 2x samples, 2 bytes each
  
  for (let i = 0; i < n; i++) {
    const s1 = ULAW_DECODE[ulawBuf[i]];
    // For interpolated sample: use previous sample (cross-chunk for i=0)
    const prev = (i > 0) ? ULAW_DECODE[ulawBuf[i - 1]] : _lastSample;
    // Interpolated sample between prev and current
    pcm16k.writeInt16LE(((prev + s1) >> 1), i * 4);
    // Original sample
    pcm16k.writeInt16LE(s1, i * 4 + 2);
  }
  _lastSample = ULAW_DECODE[ulawBuf[n - 1]];
  return pcm16k;
}

// Convert PCM 24kHz to µ-law 8kHz (downsample 3:1)
function pcm24kToUlaw8k(pcmBuf) {
  const totalSamples = pcmBuf.length / 2;
  const outLen = Math.floor(totalSamples / 3);
  const ulaw = Buffer.alloc(outLen);
  
  for (let i = 0; i < outLen; i++) {
    const sample = pcmBuf.readInt16LE(i * 6); // Take every 3rd sample
    ulaw[i] = pcmToUlaw(sample);
  }
  return ulaw;
}

// --- Gemini Live API WebSocket ---
class GeminiLiveSession {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model;
    this.ws = null;
    this.ready = false;
    this.onAudioOut = null;  // callback(pcmBuffer)
    this.onTextResponse = null; // callback(text) — full text response to speak
    this.onTranscript = null; // callback(text, role)
    this.onFunctionCall = null; // callback(name, args) → returns result
    this._textBuffer = '';
  }

  async connect() {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      
      this.ws.on('open', () => {
        console.log('🔗 Gemini Live WebSocket connected');
        this.sendSetup();
      });

      this.ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          await this.handleMessage(msg);
          if (msg.setupComplete && !this.ready) {
            this.ready = true;
            resolve();
          }
        } catch (err) {
          console.error('Gemini parse error:', err.message);
        }
      });

      this.ws.on('error', (err) => {
        console.error('Gemini WS error:', err.message);
        if (!this.ready) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`Gemini WS closed: ${code} ${reason}`);
        this.ready = false;
      });

      setTimeout(() => {
        if (!this.ready) reject(new Error('Gemini setup timeout'));
      }, 15000);
    });
  }

  sendSetup() {
    const setup = {
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore'
              }
            }
          }
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false
          }
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: {
          parts: [{
            text: `You are ${AGENT_NAME}, ${AGENT_ROLE}, participating in a Zoom meeting via phone.

CRITICAL RULES:
- You are ALREADY in the meeting. Do NOT simulate joining or describe actions.
- Just listen and respond naturally to what people say.
- Keep responses concise (1-3 sentences max)
- ALWAYS respond in English, even if the speaker uses another language. The TTS system only supports English.
- Be natural and conversational
- Introduce yourself briefly only when someone asks who you are
- Do NOT narrate your actions or thoughts. Just speak naturally.`
          }]
        }
      }
    };

    this.ws.send(JSON.stringify(setup));
  }

  async handleMessage(msg) {
    // Skip noisy debug logging

    // Audio output from Gemini
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.includes('audio') && part.inlineData.data) {
          // Audio generated by Gemini — skip sending via WebSocket (using Telnyx speak instead)
        }
        if (part.text && !part.thought) {
          this._textBuffer += part.text;
          console.log(`💬 Gemini: ${part.text.slice(0, 200)}`);
        }
      }
    }

    // Turn complete — fire text response
    if (msg.serverContent?.turnComplete || msg.serverContent?.interruptedTurn) {
      if (this._textBuffer.trim() && this.onTextResponse) {
        console.log(`↩️ Turn complete, speaking: "${this._textBuffer.trim().slice(0, 80)}..."`);
        this.onTextResponse(this._textBuffer.trim());
      }
      this._textBuffer = '';
    }

    // Transcription
    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text;
      console.log(`🎤 [${ts()}] ${text}`);
      if (this.onTranscript) this.onTranscript(text, 'user');
    }
    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text;
      console.log(`🔊 [${ts()}] ${text}`);
      if (this.onTranscript) this.onTranscript(text, 'assistant');
      // Accumulate output text for Telnyx speak
      this._textBuffer += text;
    }

    // Function calling
    if (msg.toolCall?.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        console.log(`🧠 Function call: ${fc.name}(${JSON.stringify(fc.args)})`);
        if (this.onFunctionCall) {
          const result = await this.onFunctionCall(fc.name, fc.args);
          // Send function response back to Gemini
          this.ws.send(JSON.stringify({
            toolResponse: {
              functionResponses: [{
                id: fc.id,
                name: fc.name,
                response: { result: result }
              }]
            }
          }));
        }
      }
    }
  }

  // Send audio to Gemini (PCM 16kHz 16-bit mono, base64)
  sendAudio(pcm16kBuffer) {
    if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data: pcm16kBuffer.toString('base64')
        }]
      }
    }));
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// --- ngrok tunnel ---
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    const timeout = setTimeout(() => { if (!resolved) { proc.kill(); reject(new Error('Tunnel timeout')); } }, 15000);

    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line);
          if (j.url?.startsWith('https://') && !resolved) {
            resolved = true; clearTimeout(timeout); resolve({ url: j.url, process: proc });
          }
        } catch {}
      }
    });
    proc.on('error', (e) => { if (!resolved) reject(e); });
    
    setTimeout(async () => {
      if (resolved) return;
      try {
        const r = await fetch('http://127.0.0.1:4040/api/tunnels');
        const d = await r.json();
        const t = d.tunnels?.find(t => t.proto === 'https');
        if (t && !resolved) { resolved = true; clearTimeout(timeout); resolve({ url: t.public_url, process: proc }); }
      } catch {}
    }, 4000);
  });
}

// --- Main ---
async function main() {
  // Express for Telnyx webhooks
  const app = express();
  app.use(express.json());
  
  let callControlId = null;
  const transcripts = [];
  
  // Telnyx media WebSocket server
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/media' });
  
  // Gemini session
  const gemini = new GeminiLiveSession(GEMINI_API_KEY, GEMINI_MODEL);
  
  // Handle function calls → route to OpenClaw
  gemini.onFunctionCall = async (name, args) => {
    if (name === 'ask_assistant') {
      console.log(`🧠 Asking OpenClaw: "${args.query}"`);
      const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://localhost:18789';
      const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
      try {
        const res = await fetch(`${OPENCLAW_GATEWAY}/api/sessions/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(OPENCLAW_TOKEN ? { 'Authorization': `Bearer ${OPENCLAW_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            message: args.query,
            label: 'zoom-agent-brain',
            timeoutSeconds: 15,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const reply = data?.reply || data?.message || 'No response from brain.';
          console.log(`🧠 OpenClaw replied: "${reply.slice(0, 80)}..."`);
          return reply;
        }
        console.log(`⚠️ OpenClaw HTTP ${res.status}`);
      } catch (err) {
        console.log(`⚠️ OpenClaw brain error: ${err.message}`);
      }
      return `I'm not sure about that right now. Let me get back to you.`;
    }
    return 'Unknown function';
  };
  
  // Store transcripts
  gemini.onTranscript = (text, role) => {
    transcripts.push({ time: ts(), role, text });
  };

  // Speak via Telnyx when Gemini generates text response
  let isSpeaking = false;
  let speakSafetyTimer = null;
  gemini.onTextResponse = async (text) => {
    if (!callControlId || isSpeaking) return;
    isSpeaking = true;
    if (speakSafetyTimer) clearTimeout(speakSafetyTimer);
    // Safety timeout: auto-reset isSpeaking if webhook is missed
    const wordCount = text.split(/\s+/).length;
    const estimatedMs = wordCount * 400 + 5000;
    speakSafetyTimer = setTimeout(() => {
      if (isSpeaking) {
        console.log('⚠️ Speaking safety timeout — resetting isSpeaking');
        isSpeaking = false;
      }
    }, estimatedMs);
    const isChinese = /[\u4e00-\u9fff]/.test(text);
    try {
      await telnyxApi('POST', `/calls/${callControlId}/actions/speak`, {
        payload: text,
        voice: 'male',
        language: 'en-US',
      });
      console.log(`🔊 Speaking: "${text.slice(0, 60)}..."`);
    } catch (err) {
      console.error('🔊 Speak failed:', err.message.slice(0, 100));
      if (speakSafetyTimer) clearTimeout(speakSafetyTimer);
      isSpeaking = false;
    }
  };
  
  // Gate: only forward audio to Gemini after meeting is joined
  let inMeeting = false;
  
  // Telnyx media WebSocket — bridge audio to/from Gemini
  wss.on('connection', (ws) => {
    console.log('🔌 Telnyx media stream connected');
    
    // Audio from Gemini → Telnyx (convert PCM 24kHz → PCM 8kHz 16-bit, send as raw binary)
    gemini.onAudioOut = (pcmBuf) => {
      try {
        // Gemini outputs PCM 24kHz 16-bit mono
        // Telnyx expects raw binary PCM 8kHz 16-bit mono (no JSON wrapper)
        // Downsample 24kHz → 8kHz (take every 3rd sample)
        const totalSamples = pcmBuf.length / 2;
        const outSamples = Math.floor(totalSamples / 3);
        const pcm8k = Buffer.alloc(outSamples * 2);
        
        for (let i = 0; i < outSamples; i++) {
          const sample = pcmBuf.readInt16LE(i * 6);
          pcm8k.writeInt16LE(sample, i * 2);
        }
        
        // Send as raw binary frame
        ws.send(pcm8k, { binary: true });
      } catch (err) {
        console.error('Audio out error:', err.message);
      }
    };
    
    let audioChunks = 0;
    let peakLevel = 0;
    // Audio diagnostic: dump first 10s of PCM to WAV for inspection
    const diagBufs = [];
    let diagSamples = 0;
    const DIAG_MAX = 16000 * 10; // 10 seconds at 16kHz
    let diagSaved = false;
    
    let levelLogTimer = setInterval(() => {
      if (audioChunks > 0) {
        console.log(`🎚️ Audio: ${audioChunks} chunks, peak=${peakLevel}, ${peakLevel < 500 ? '⚠️ LOW' : '✅ OK'}`);
        audioChunks = 0;
        peakLevel = 0;
      }
      // Save diagnostic WAV after collecting enough samples
      if (!diagSaved && diagSamples >= DIAG_MAX) {
        diagSaved = true;
        const pcmData = Buffer.concat(diagBufs);
        const wavHeader = Buffer.alloc(44);
        const dataSize = pcmData.length;
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(36 + dataSize, 4);
        wavHeader.write('WAVE', 8);
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16); // chunk size
        wavHeader.writeUInt16LE(1, 20); // PCM
        wavHeader.writeUInt16LE(1, 22); // mono
        wavHeader.writeUInt32LE(16000, 24); // sample rate
        wavHeader.writeUInt32LE(32000, 28); // byte rate
        wavHeader.writeUInt16LE(2, 32); // block align
        wavHeader.writeUInt16LE(16, 34); // bits per sample
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(dataSize, 40);
        writeFileSync('diag-gemini-input.wav', Buffer.concat([wavHeader, pcmData]));
        console.log(`🔬 DIAGNOSTIC: Saved ${(dataSize/32000).toFixed(1)}s of audio to diag-gemini-input.wav`);
        diagBufs.length = 0; // free memory
      }
    }, 5000);
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.event === 'media' && msg.media?.track === 'inbound') {
          // Log first media message structure
          if (audioChunks === 0) {
            console.log(`🔬 First media msg: track=${msg.media.track} chunk=${msg.media.chunk} encoding=${msg.media.encoding || 'unknown'} payload_len=${msg.media.payload?.length || 0}`);
          }
          // Audio from Zoom → convert µ-law 8kHz to PCM 16kHz → Gemini
          const ulawBuf = Buffer.from(msg.media.payload, 'base64');
          const pcm16k = ulawToPcm16k(ulawBuf);
          
          // Track audio levels for debugging
          audioChunks++;
          for (let i = 0; i < pcm16k.length; i += 2) {
            const s = Math.abs(pcm16k.readInt16LE(i));
            if (s > peakLevel) peakLevel = s;
          }
          
          // Only send audio to Gemini after we've joined the meeting
          if (!inMeeting) return;
          
          // Echo suppression: don't feed Gemini while agent is speaking (its own TTS loops back)
          if (isSpeaking) return;
          
          // Collect diagnostic audio
          if (diagSamples < DIAG_MAX) {
            diagBufs.push(Buffer.from(pcm16k));
            diagSamples += pcm16k.length / 2;
          }
          
          gemini.sendAudio(pcm16k);
        } else if (msg.event === 'start') {
          console.log('🎵 Media stream started');
        } else if (msg.event === 'stop') {
          console.log('🎵 Media stream stopped');
          clearInterval(levelLogTimer);
        }
      } catch {}
    });
    
    ws.on('close', () => console.log('🔌 Telnyx media stream closed'));
  });
  
  // Telnyx webhook handler
  app.post('/webhook', (req, res) => {
    res.sendStatus(200);
    const event = req.body?.data || req.body;
    const eventType = event?.event_type;
    if (eventType === 'call.speak.ended') {
      if (speakSafetyTimer) clearTimeout(speakSafetyTimer);
      isSpeaking = false;
      console.log('🔊 Speaking ended');
    } else if (eventType === 'call.speak.started') {
      console.log('🔊 Speaking started');
    } else if (eventType) {
      console.log(`📡 ${eventType}`);
    }
  });
  
  app.get('/health', (req, res) => res.json({ ok: true, transcripts: transcripts.length }));
  
  // Start server
  await new Promise(r => server.listen(PORT, r));
  console.log(`🌐 Server on port ${PORT}`);
  
  // Start tunnel
  console.log('🔧 Starting ngrok...');
  const tunnel = await startTunnel(PORT);
  console.log(`🚇 Tunnel: ${tunnel.url}`);
  
  // Update Telnyx webhook + start Gemini
  const appId = process.env.TELNYX_CONNECTION_ID;
  if (appId) {
    await telnyxApi('PATCH', `/call_control_applications/${appId}`, {
      webhook_event_url: `${tunnel.url}/webhook`,
    });
  }
  
  // Connect to Gemini with retry (WS can fail on first attempt)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔗 Connecting to Gemini Live API (attempt ${attempt})...`);
      await gemini.connect();
      console.log('✅ Gemini Live ready');
      break;
    } catch (err) {
      console.log(`⚠️ Gemini connect failed: ${err.message}`);
      if (attempt === 3) { console.log('❌ Giving up'); cleanup(tunnel, gemini); return; }
      await sleep(3000);
    }
  }
  
  // Dial Zoom
  console.log(`\n📞 Dialing Zoom ${meetingId}...`);
  const call = await telnyxApi('POST', '/calls', {
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to: process.env.ZOOM_DIAL_IN || '+16699009128',
    from: process.env.TELNYX_DID,
    timeout_secs: 60,
    webhook_url: `${tunnel.url}/webhook`,
    stream_url: `wss://${tunnel.url.replace('https://', '')}/media`,
    stream_track: 'both_tracks',
  });
  
  callControlId = call.data.call_control_id;
  console.log(`📞 Call: ${callControlId.slice(0, 20)}...`);
  
  // DTMF join sequence
  console.log('⏳ Waiting 15s for IVR...');
  await sleep(15000);
  
  let s = await telnyxApi('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }
  
  console.log('✅ Sending meeting ID');
  await telnyxApi('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: `${meetingId}#`, duration_millis: 300 });
  await sleep(8000);
  
  s = await telnyxApi('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }
  
  console.log('✅ Skip participant ID');
  await telnyxApi('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: '#', duration_millis: 300 });
  await sleep(5000);
  
  if (passcode) {
    s = await telnyxApi('GET', `/calls/${callControlId}`);
    if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }
    console.log('✅ Sending passcode');
    await telnyxApi('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: `${passcode}#`, duration_millis: 300 });
    await sleep(8000);
  }
  
  s = await telnyxApi('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }
  
  inMeeting = true;
  console.log('🎉 IN THE MEETING — Gemini Live handling audio (audio gate OPEN)\n');
  
  // Restart media streaming (it often closes during DTMF/IVR phase)
  try {
    await telnyxApi('POST', `/calls/${callControlId}/actions/streaming_start`, {
      stream_url: `wss://${tunnel.url.replace('https://', '')}/media`,
      stream_track: 'both_tracks',
    });
    console.log('🎵 Media streaming restarted');
  } catch (err) {
    console.log('⚠️ Streaming restart:', err.message.slice(0, 100));
  }
  
  // Keep alive
  const endTime = Date.now() + duration * 1000;
  while (Date.now() < endTime) {
    await sleep(15000);
    try {
      s = await telnyxApi('GET', `/calls/${callControlId}`);
      if (!s.data?.is_alive) { console.log('\n📞 Call ended'); break; }
    } catch {}
  }
  
  // Hangup
  try { await telnyxApi('POST', `/calls/${callControlId}/actions/hangup`, {}); } catch {}
  
  console.log('\n📝 ═══ TRANSCRIPT ═══');
  for (const t of transcripts) {
    console.log(`[${t.time}] ${t.role}: ${t.text}`);
  }
  
  cleanup(tunnel, gemini);
}

function cleanup(tunnel, gemini) {
  gemini?.close();
  tunnel?.process?.kill();
  setTimeout(() => process.exit(0), 2000);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
