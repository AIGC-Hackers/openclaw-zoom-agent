/**
 * Gemini Hybrid Voice Agent
 * 
 * Gemini Live API for STT (natural understanding)
 * + Telnyx speak for TTS (proven reliable)
 * 
 * Audio: Telnyx media stream → µ-law→PCM → Gemini Live (input)
 * Voice: Gemini text response → Telnyx speak command (output)
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 8181;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_BASE = 'https://api.telnyx.com/v2';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const USE_GEMINI_AUDIO = false; // false = Gemini STT + Telnyx TTS (reliable), true = full Gemini audio (experimental)
const GEMINI_MODEL = process.env.GEMINI_MODEL || (USE_GEMINI_AUDIO ? 'gemini-2.5-flash-native-audio-preview-12-2025' : 'gemini-2.0-flash-exp-image-generation');

const args = process.argv.slice(2);
const meetingId = args.find((_, i) => args[i - 1] === '-m');
const passcode = args.find((_, i) => args[i - 1] === '-p');
const duration = parseInt(args.find((_, i) => args[i - 1] === '-d') || '600');

if (!meetingId || !GEMINI_API_KEY) {
  console.error('Usage: node gemini-hybrid-agent.js -m MEETING_ID -p PASSCODE');
  console.error('Requires: GEMINI_API_KEY, TELNYX_API_KEY in .env');
  process.exit(1);
}

const AGENT_NAME = process.env.AGENT_NAME || 'AI Assistant';
const AGENT_ROLE = process.env.AGENT_ROLE || "Kai's AI assistant";

// --- Telnyx REST ---
async function tAPI(method, path, body, retries = 3) {
  for (let i = 0; i <= retries; i++) {
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
      if (i < retries && (err.cause?.code === 'ECONNRESET' || err.message.includes('fetch failed'))) {
        await sleep(2000 * (i + 1)); continue;
      }
      throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }

// --- µ-law → PCM 16kHz ---
const ULAW_DECODE = new Int16Array(256);
(function() {
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xFF;
    let sign = u & 0x80;
    let exp = (u >> 4) & 0x07;
    let man = u & 0x0F;
    let s = (man << 3) + 0x84;
    s <<= exp;
    s -= 0x84;
    ULAW_DECODE[i] = sign ? -s : s;
  }
})();

// PCM encode to µ-law
function pcmToUlaw(sample) {
  const BIAS = 0x84, MAX = 32635;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MAX) sample = MAX;
  sample += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  return ~(sign | (exp << 4) | ((sample >> (exp + 3)) & 0x0F)) & 0xFF;
}

// PCM 24kHz → µ-law 8kHz (downsample 3:1)
function pcm24kToUlaw8k(pcmBuf) {
  const total = pcmBuf.length / 2;
  const outLen = Math.floor(total / 3);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = pcmToUlaw(pcmBuf.readInt16LE(i * 6));
  }
  return out;
}

function ulawToPcm16k(ulawBuf) {
  const n = ulawBuf.length;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s1 = ULAW_DECODE[ulawBuf[i]];
    const s2 = (i < n - 1) ? ULAW_DECODE[ulawBuf[i + 1]] : s1;
    out.writeInt16LE(s1, i * 4);
    out.writeInt16LE((s1 + s2) >> 1, i * 4 + 2);
  }
  return out;
}

// --- State ---
let callControlId = null;
let isSpeaking = false;
const transcripts = [];

// --- Gemini Live (STT + conversation, TEXT output) ---
class GeminiSession {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.onResponse = null; // callback(text)
    this.onTranscript = null; // callback(text)
    this.onAudioOut = null; // callback(base64pcm)
  }

  async connect() {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      
      this.ws.on('open', () => {
        console.log('🔗 Gemini connected');
        this.ws.send(JSON.stringify({
          setup: {
            model: `models/${GEMINI_MODEL}`,
            generationConfig: {
              responseModalities: USE_GEMINI_AUDIO ? ['AUDIO'] : ['TEXT'],
              ...(USE_GEMINI_AUDIO && {
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: 'Kore' }
                  }
                }
              }),
            },
            systemInstruction: {
              parts: [{
                text: `You are ${AGENT_NAME}, ${AGENT_ROLE}, in a Zoom meeting via phone.

CRITICAL RULES:
- Keep ALL responses to 1-2 sentences MAX. Be very concise.
- ALWAYS respond in the SAME LANGUAGE the speaker uses.
- If they speak Chinese/Mandarin, respond in Chinese.
- If they speak English, respond in English.
- Be natural and conversational.
- When you first join, briefly introduce yourself.
- You are hearing audio from a phone call into Zoom.`
              }]
            }
          }
        }));
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.setupComplete) {
            this.ready = true;
            console.log('✅ Gemini ready');
            resolve();
            return;
          }

          // Response from Gemini (text or audio)
          if (msg.serverContent?.modelTurn?.parts) {
            for (const part of msg.serverContent.modelTurn.parts) {
              if (part.text) {
                console.log(`💬 Gemini: ${part.text}`);
                if (this.onResponse) this.onResponse(part.text);
              }
              if (part.inlineData?.data && part.inlineData?.mimeType?.includes('audio')) {
                if (this.onAudioOut) this.onAudioOut(part.inlineData.data);
              }
            }
          }

          // Input transcription
          if (msg.serverContent?.inputTranscription?.text) {
            const t = msg.serverContent.inputTranscription.text;
            if (t.trim()) {
              console.log(`🎤 [${ts()}] ${t}`);
              if (this.onTranscript) this.onTranscript(t);
            }
          }

          // Turn complete
          if (msg.serverContent?.turnComplete) {
            console.log('  ↩️ Turn complete');
          }
        } catch (err) {
          console.error('Gemini msg error:', err.message);
        }
      });

      this.ws.on('error', (e) => { console.error('Gemini error:', e.message); if (!this.ready) reject(e); });
      this.ws.on('close', (c) => { console.log(`Gemini closed: ${c}`); this.ready = false; });
      setTimeout(() => { if (!this.ready) reject(new Error('Gemini timeout')); }, 15000);
    });
  }

  sendAudio(pcm16kBuf) {
    if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data: pcm16kBuf.toString('base64')
        }]
      }
    }));
  }

  close() { if (this.ws) this.ws.close(); }
}

// --- Speak via Telnyx ---
let speakSafetyTimer = null;
async function speak(text) {
  if (!callControlId || isSpeaking || !text?.trim()) return;
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
    // Telnyx speak: for Chinese, use 'female' voice (male not supported for cmn-CN)
    await tAPI('POST', `/calls/${callControlId}/actions/speak`, {
      payload: text,
      voice: isChinese ? 'female' : 'male',
      language: isChinese ? 'cmn-CN' : 'en-US',
    });
    console.log(`🔊 Speaking: "${text.slice(0, 60)}"`);
  } catch (err) {
    console.error('Speak error:', err.message.slice(0, 100));
    if (speakSafetyTimer) clearTimeout(speakSafetyTimer);
    isSpeaking = false;
  }
}

// --- ngrok ---
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const p = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const t = setTimeout(() => { if (!done) { p.kill(); reject(new Error('timeout')); } }, 15000);
    p.stdout.on('data', (d) => {
      for (const l of d.toString().split('\n').filter(Boolean)) {
        try { const j = JSON.parse(l); if (j.url?.startsWith('https://') && !done) { done = true; clearTimeout(t); resolve({ url: j.url, process: p }); } } catch {}
      }
    });
    p.on('error', (e) => { if (!done) reject(e); });
    setTimeout(async () => {
      if (done) return;
      try { const r = await fetch('http://127.0.0.1:4040/api/tunnels'); const d = await r.json(); const x = d.tunnels?.find(t => t.proto === 'https'); if (x && !done) { done = true; clearTimeout(t); resolve({ url: x.public_url, process: p }); } } catch {}
    }, 4000);
  });
}

// --- Main ---
async function main() {
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/media' });

  let responseBuffer = '';
  let telnyxMediaWs = null; // Reference to Telnyx media WS for audio output
  
  const gemini = new GeminiSession();
  
  gemini.onResponse = (text) => {
    responseBuffer += text;
  };
  
  // Handle Gemini audio output → send to Telnyx
  gemini.onAudioOut = (pcm24kBase64) => {
    if (!telnyxMediaWs) return;
    try {
      const pcmBuf = Buffer.from(pcm24kBase64, 'base64');
      const ulaw = pcm24kToUlaw8k(pcmBuf);
      // Send as base64 in Telnyx media format
      telnyxMediaWs.send(JSON.stringify({
        event: 'media',
        media: {
          track: 'outbound',
          chunk: 1,
          payload: ulaw.toString('base64'),
        }
      }));
    } catch (err) {
      // Silent - audio conversion errors are noisy
    }
  };

  gemini.onTranscript = (text) => {
    transcripts.push({ time: ts(), role: 'user', text });
  };

  // Telnyx media stream → Gemini
  wss.on('connection', (ws) => {
    console.log('🔌 Media stream connected');
    telnyxMediaWs = ws;
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.event === 'media' && msg.media?.track === 'inbound') {
          const ulaw = Buffer.from(msg.media.payload, 'base64');
          const pcm = ulawToPcm16k(ulaw);
          gemini.sendAudio(pcm);
        } else if (msg.event === 'start') {
          console.log('🎵 Stream started', msg.start?.streamId || '');
        }
      } catch {}
    });
    ws.on('close', () => console.log('🔌 Stream closed'));
  });

  // Webhook handler
  app.post('/webhook', (req, res) => {
    res.sendStatus(200);
    const evt = req.body?.data?.event_type || req.body?.event_type;
    if (evt === 'call.speak.ended') {
      if (speakSafetyTimer) clearTimeout(speakSafetyTimer);
      isSpeaking = false;
      console.log('🔊 Speak ended');
    } else if (evt) {
      console.log(`📡 ${evt}`);
    }
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  await new Promise(r => server.listen(PORT, r));
  console.log(`🌐 Port ${PORT}`);

  const tunnel = await startTunnel(PORT);
  console.log(`🚇 ${tunnel.url}`);

  // Update webhook
  const appId = process.env.TELNYX_CONNECTION_ID;
  if (appId) await tAPI('PATCH', `/call_control_applications/${appId}`, { webhook_event_url: `${tunnel.url}/webhook` });

  // Connect Gemini (with retry)
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await gemini.connect(); break; } catch (err) {
      console.log(`⚠️ Gemini connect attempt ${attempt + 1} failed: ${err.message.slice(0, 60)}`);
      if (attempt === 2) throw err;
      await sleep(3000);
    }
  }

  // Poll for Gemini turn completion → speak (only for TEXT mode)
  if (!USE_GEMINI_AUDIO) {
    setInterval(() => {
      if (responseBuffer.trim() && !isSpeaking) {
        const text = responseBuffer.trim();
        responseBuffer = '';
        transcripts.push({ time: ts(), role: 'assistant', text });
        speak(text);
      }
    }, 500);
  }

  // Dial Zoom
  console.log(`\n📞 Dialing ${meetingId}...`);
  const call = await tAPI('POST', '/calls', {
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to: process.env.ZOOM_DIAL_IN || '+16699009128',
    from: process.env.TELNYX_DID,
    timeout_secs: 60,
    webhook_url: `${tunnel.url}/webhook`,
  });

  callControlId = call.data.call_control_id;
  console.log(`📞 ${callControlId.slice(0, 20)}...`);

  // DTMF
  console.log('⏳ 15s IVR wait...');
  await sleep(15000);
  let s = await tAPI('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }

  await tAPI('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: `${meetingId}#`, duration_millis: 300 });
  await sleep(8000);
  s = await tAPI('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }

  await tAPI('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: '#', duration_millis: 300 });
  await sleep(5000);

  if (passcode) {
    s = await tAPI('GET', `/calls/${callControlId}`);
    if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }
    await tAPI('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: `${passcode}#`, duration_millis: 300 });
    await sleep(8000);
  }

  s = await tAPI('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead'); cleanup(tunnel, gemini); return; }

  console.log('🎉 IN THE MEETING\n');

  // Try enabling streaming explicitly
  try {
    await tAPI('POST', `/calls/${callControlId}/actions/streaming_start`, {
      stream_url: `wss://${tunnel.url.replace('https://', '')}/media`,
      stream_track: 'inbound_track',
    });
    console.log('🎵 Streaming enabled');
  } catch (e) {
    console.log('⚠️ Stream start:', e.message.slice(0, 80));
  }

  // Greet (Gemini will greet via audio naturally, or use Telnyx speak as fallback)
  if (!USE_GEMINI_AUDIO) {
    await sleep(2000);
    await speak(`Hi, this is ${AGENT_NAME}. I can hear everyone. Feel free to talk to me.`);
  }

  // Keep alive
  const end = Date.now() + duration * 1000;
  while (Date.now() < end) {
    await sleep(15000);
    try {
      s = await tAPI('GET', `/calls/${callControlId}`);
      if (!s.data?.is_alive) { console.log('\n📞 Ended'); break; }
    } catch {}
  }

  try { await tAPI('POST', `/calls/${callControlId}/actions/hangup`, {}); } catch {}
  
  console.log('\n📝 TRANSCRIPT');
  for (const t of transcripts) console.log(`[${t.time}] ${t.role}: ${t.text}`);
  
  cleanup(tunnel, gemini);
}

function cleanup(tunnel, gemini) {
  gemini?.close();
  tunnel?.process?.kill();
  setTimeout(() => process.exit(0), 2000);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
