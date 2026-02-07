/**
 * M3 — Zoom Voice Agent: Transcription + TTS Speaking
 * 
 * 1. Dials Zoom via Telnyx PSTN, joins with DTMF
 * 2. Live transcription (bilingual EN/ZH)
 * 3. TTS speaking via Telnyx speak command
 * 4. Interactive: responds to speech via OpenAI GPT
 */

import express from 'express';
import { createServer } from 'http';
import { spawn } from 'child_process';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 8181;
const KEY = process.env.TELNYX_API_KEY;
const BASE = 'https://api.telnyx.com/v2';

const args = process.argv.slice(2);
const meetingId = args.find((_, i) => args[i - 1] === '-m') || args.find((_, i) => args[i - 1] === '--meeting-id');
const passcode = args.find((_, i) => args[i - 1] === '-p') || args.find((_, i) => args[i - 1] === '--passcode');
const duration = parseInt(args.find((_, i) => args[i - 1] === '-d') || '600');

if (!meetingId) {
  console.error('Usage: node m3-voice-agent.js -m MEETING_ID -p PASSCODE [-d DURATION_SECS]');
  process.exit(1);
}

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- OpenClaw brain integration ---
const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://localhost:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
const USE_OPENCLAW_BRAIN = process.env.USE_OPENCLAW_BRAIN === 'true';

async function askOpenClawBrain(text) {
  if (!USE_OPENCLAW_BRAIN) return null;
  try {
    const res = await fetch(`${OPENCLAW_GATEWAY}/api/sessions/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OPENCLAW_TOKEN ? { 'Authorization': `Bearer ${OPENCLAW_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        message: `[Zoom Meeting Context] Someone in the meeting said: "${text}"\n\nProvide a brief, helpful response (1-2 sentences max). Respond in the same language they used.`,
        label: 'zoom-agent-brain',
        timeoutSeconds: 15,
      }),
    });
    if (!res.ok) {
      console.log(`⚠️ OpenClaw brain HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data?.reply || data?.message || null;
  } catch (err) {
    console.log(`⚠️ OpenClaw brain error: ${err.message}`);
    return null;
  }
}

// --- Telnyx REST (with retry) ---
async function api(method, path, body, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Telnyx ${method} ${path}: ${res.status} ${JSON.stringify(data.errors || data)}`);
      return data;
    } catch (err) {
      if (attempt < retries && (err.cause?.code === 'ECONNRESET' || err.message.includes('fetch failed'))) {
        console.log(`  ⚠️ API retry ${attempt + 1}/${retries}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }

// --- State ---
let callControlId = null;
let isInMeeting = false;
let isSpeaking = false;
const transcripts = [];
// Agent persona (configurable via env vars)
const AGENT_NAME = process.env.AGENT_NAME || 'AI Assistant';
const AGENT_ROLE = process.env.AGENT_ROLE || "Kai's AI assistant";
const AGENT_INSTRUCTIONS = process.env.AGENT_INSTRUCTIONS || '';
const NO_SPEAK = process.env.NO_SPEAK === 'true';
const TRANSCRIPT_FILE = process.env.TRANSCRIPT_FILE || '';

const systemPrompt = AGENT_INSTRUCTIONS || `You are ${AGENT_NAME}, ${AGENT_ROLE}, joining a Zoom meeting.
You are professional, helpful, and concise. Keep responses to 1-2 sentences max.
You MUST respond in the SAME LANGUAGE the speaker used:
- If they speak Chinese (Mandarin), respond in Chinese.
- If they speak English, respond in English.
- If they mix, use the dominant language of their last message.
This is critical — never respond in English when the speaker used Chinese, and vice versa.
If someone greets you or asks who you are, introduce yourself as ${AGENT_NAME}, ${AGENT_ROLE}.
If asked to do something, acknowledge and be helpful.`;

const conversationHistory = [
  { role: 'system', content: systemPrompt }
];

// Buffer for accumulating transcript before responding
let transcriptBuffer = '';
let bufferTimer = null;
const BUFFER_DELAY = parseInt(process.env.BUFFER_DELAY || '1500'); // Wait for silence before responding

// --- Express for webhooks ---
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  
  const event = req.body?.data || req.body;
  const eventType = event?.event_type;
  const payload = event?.payload || event;

  switch (eventType) {
    case 'call.transcription': {
      const text = payload?.transcription_data?.transcript;
      const isFinal = payload?.transcription_data?.is_final;
      const confidence = payload?.transcription_data?.confidence;
      
      if (text && text.trim() && isFinal) {
        const entry = { time: ts(), text: text.trim(), confidence };
        transcripts.push(entry);
        console.log(`\n🎤 [${entry.time}] ${entry.text}`);
        
        // Accumulate transcript and set response timer
        if (isInMeeting && !isSpeaking && !NO_SPEAK) {
          transcriptBuffer += (transcriptBuffer ? ' ' : '') + text.trim();
          
          // Reset the buffer timer
          if (bufferTimer) clearTimeout(bufferTimer);
          bufferTimer = setTimeout(() => processAndRespond(), BUFFER_DELAY);
        }
      } else if (text && text.trim() && !isFinal) {
        process.stdout.write(`\r  💭 ${text.trim().slice(0, 80)}...`);
      }
      break;
    }
    
    case 'call.speak.started':
      console.log('🔊 Speaking started');
      break;
      
    case 'call.speak.ended':
      console.log('🔊 Speaking ended');
      isSpeaking = false;
      break;
      
    case 'call.hangup':
      console.log(`\n📞 Call ended: ${payload?.hangup_cause}`);
      isInMeeting = false;
      break;
      
    case 'call.initiated':
    case 'call.answered':
      console.log(`📡 ${eventType}`);
      break;
      
    default:
      console.log(`📡 Event: ${eventType}`);
  }
});

app.get('/health', (req, res) => res.json({ ok: true, transcripts: transcripts.length, speaking: isSpeaking }));

// --- Speak endpoint (for manual testing) ---
app.post('/speak', async (req, res) => {
  const { text } = req.body;
  if (!text || !callControlId) return res.status(400).json({ error: 'text required and must be in call' });
  await speakText(text);
  res.json({ ok: true });
});

const server = createServer(app);

// --- Process accumulated transcript and generate response ---
async function processAndRespond() {
  if (!transcriptBuffer.trim() || !isInMeeting || isSpeaking) return;
  
  const userText = transcriptBuffer.trim();
  transcriptBuffer = '';
  
  // Skip very short fragments or noise
  if (userText.length < 5) return;
  
  console.log(`\n🧠 Processing: "${userText}"`);
  
  try {
    conversationHistory.push({ role: 'user', content: userText });
    
    // Keep history manageable
    if (conversationHistory.length > 20) {
      conversationHistory.splice(1, conversationHistory.length - 11);
    }
    
    let response = null;
    
    // Try OpenClaw brain first (if enabled)
    if (USE_OPENCLAW_BRAIN) {
      console.log('🧠 Asking OpenClaw brain...');
      response = await askOpenClawBrain(userText);
      if (response) console.log('🧠 OpenClaw brain responded');
    }
    
    // Fall back to GPT-4o-mini
    if (!response) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: conversationHistory,
        max_tokens: 150,
        temperature: 0.7,
      });
      response = completion.choices[0]?.message?.content;
    }
    
    if (response) {
      conversationHistory.push({ role: 'assistant', content: response });
      console.log(`💬 Response: "${response}"`);
      await speakText(response);
    }
  } catch (err) {
    console.error('🧠 AI error:', err.message);
  }
}

// --- TTS via Telnyx speak command ---
async function speakText(text) {
  if (!callControlId || isSpeaking) return;
  
  isSpeaking = true;
  
  // Detect language for voice selection
  const isChinese = /[\u4e00-\u9fff]/.test(text);
  
  try {
    await api('POST', `/calls/${callControlId}/actions/speak`, {
      payload: text,
      voice: 'male',
      language: isChinese ? 'cmn-CN' : 'en-US',
    });
    console.log(`🔊 Speaking: "${text.slice(0, 60)}..."`);
  } catch (err) {
    console.error('🔊 Speak failed:', err.message);
    isSpeaking = false;
  }
}

// --- Tunnel (ngrok) ---
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { proc.kill(); reject(new Error('Tunnel timeout')); }
    }, 15000);

    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line);
          if (j.url && j.url.startsWith('https://') && !resolved) {
            resolved = true; clearTimeout(timeout);
            resolve({ url: j.url, process: proc });
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (d) => { if (!resolved) console.log('  ngrok:', d.toString().trim()); });
    proc.on('error', (e) => { if (!resolved) reject(e); });
    proc.on('exit', (c) => { if (!resolved) reject(new Error(`ngrok exited ${c}`)); });

    // Fallback: poll ngrok API
    setTimeout(async () => {
      if (resolved) return;
      try {
        const res = await fetch('http://127.0.0.1:4040/api/tunnels');
        const data = await res.json();
        const t = data.tunnels?.find(t => t.proto === 'https');
        if (t && !resolved) { resolved = true; clearTimeout(timeout); resolve({ url: t.public_url, process: proc }); }
      } catch {}
    }, 4000);
  });
}

// --- Main ---
async function main() {
  await new Promise(r => server.listen(PORT, r));
  console.log(`🌐 Server on port ${PORT}`);

  console.log('🔧 Starting ngrok tunnel...');
  const tunnel = await startTunnel(PORT);
  const webhookUrl = `${tunnel.url}/webhook`;
  console.log(`🚇 Tunnel: ${tunnel.url}`);

  // Update call control app webhook
  const appId = process.env.TELNYX_CONNECTION_ID;
  if (appId) {
    await api('PATCH', `/call_control_applications/${appId}`, { webhook_event_url: webhookUrl });
    console.log('✅ Webhook URL updated');
  }

  // Dial Zoom
  console.log(`\n📞 Dialing Zoom meeting ${meetingId}...`);
  const call = await api('POST', '/calls', {
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to: process.env.ZOOM_DIAL_IN || '+16699009128',
    from: process.env.TELNYX_DID,
    timeout_secs: 60,
    webhook_url: webhookUrl,
    webhook_url_method: 'POST',
  });

  callControlId = call.data.call_control_id;
  console.log(`📞 Call: ${callControlId.slice(0, 20)}...`);

  // DTMF sequence
  console.log('⏳ Waiting 15s for IVR...');
  await sleep(15000);

  let s = await api('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead during IVR'); cleanup(tunnel); return; }
  console.log('✅ Alive — sending meeting ID');

  await api('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: `${meetingId}#`, duration_millis: 300 });
  await sleep(8000);

  s = await api('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead after meeting ID'); cleanup(tunnel); return; }
  console.log('✅ Skipping participant ID');
  await api('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: '#', duration_millis: 300 });
  await sleep(5000);

  s = await api('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead after skip'); cleanup(tunnel); return; }

  if (passcode) {
    console.log('✅ Sending passcode');
    await api('POST', `/calls/${callControlId}/actions/send_dtmf`, { digits: `${passcode}#`, duration_millis: 300 });
    await sleep(8000);
  }

  s = await api('GET', `/calls/${callControlId}`);
  if (!s.data?.is_alive) { console.log('❌ Dead after passcode'); cleanup(tunnel); return; }

  isInMeeting = true;
  console.log('🎉 IN THE MEETING!');

  // Start transcription (bilingual)
  console.log('🎤 Starting transcription...');
  try {
    await api('POST', `/calls/${callControlId}/actions/transcription_start`, {
      language: 'en',
      transcription_engine: 'B',
      transcription_tracks: 'inbound',
    });
    console.log('🎤 Transcription active\n');
  } catch (err) {
    console.error('⚠️ Engine B failed, trying A:', err.message);
    try {
      await api('POST', `/calls/${callControlId}/actions/transcription_start`, {
        language: 'en',
        transcription_engine: 'A',
        transcription_tracks: 'inbound',
        interim_results: false,
      });
      console.log('🎤 Transcription active (engine A)\n');
    } catch (err2) {
      console.error('❌ Both engines failed:', err2.message);
    }
  }

  // Greet the meeting
  await sleep(2000);
  if (!NO_SPEAK) {
    await speakText(`Hi, this is ${AGENT_NAME}. I'm here to help. Feel free to talk to me in English or Chinese.`);
  }

  // Keep alive
  const endTime = Date.now() + duration * 1000;
  while (Date.now() < endTime && isInMeeting) {
    await sleep(15000);
    try {
      s = await api('GET', `/calls/${callControlId}`);
      if (!s.data?.is_alive) {
        console.log('\n📞 Call ended');
        isInMeeting = false;
        break;
      }
    } catch {}
  }

  // Cleanup
  if (isInMeeting) {
    try {
      await speakText("I need to go now. Goodbye!");
      await sleep(3000);
      await api('POST', `/calls/${callControlId}/actions/hangup`, {});
    } catch {}
  }

  console.log('\n\n📝 ═══ FULL TRANSCRIPT ═══');
  for (const t of transcripts) {
    console.log(`[${t.time}] ${t.text}`);
  }
  console.log(`Total: ${transcripts.length} segments`);

  // Save transcript file if requested
  if (TRANSCRIPT_FILE) {
    const { writeFileSync } = await import('fs');
    const content = transcripts.map(t => `[${t.time}] ${t.text}`).join('\n');
    writeFileSync(TRANSCRIPT_FILE, content, 'utf-8');
    console.log(`📄 Transcript saved to ${TRANSCRIPT_FILE}`);
  }

  cleanup(tunnel);
}

function cleanup(tunnel) {
  tunnel.process.kill();
  server.close();
  setTimeout(() => process.exit(0), 2000);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
