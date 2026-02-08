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

// --- AI client (OpenAI or OpenClaw gateway) ---
const USE_OPENCLAW_BRAIN = process.env.USE_OPENCLAW_BRAIN === 'true';
const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://localhost:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || 'main';

const openai = USE_OPENCLAW_BRAIN
  ? new OpenAI({
      apiKey: OPENCLAW_TOKEN,
      baseURL: `${OPENCLAW_GATEWAY}/v1`,
    })
  : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (USE_OPENCLAW_BRAIN) {
  console.log(`🧠 Using OpenClaw brain (agent: ${OPENCLAW_AGENT}) at ${OPENCLAW_GATEWAY}`);
} else {
  console.log('🧠 Using GPT-4o-mini (standalone)');
}

// --- Telnyx REST (with retry) ---
async function api(method, path, body, retries = 5) {
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

const systemPrompt = AGENT_INSTRUCTIONS || `You are ${AGENT_NAME}, ${AGENT_ROLE}, participating in a Zoom meeting via phone.

CORE RULES:
- Keep responses to 1-3 sentences max. You're speaking on a phone call — be concise.
- ALWAYS respond in the SAME LANGUAGE the speaker used (English → English, Chinese → Chinese).
- Be conversational and natural. Don't sound robotic.
- NEVER use markdown formatting (no **, *, #, bullets, numbered lists, code blocks). Your output goes directly to TTS.
- NEVER use emojis. Plain text only.
- If someone greets you or asks who you are, introduce yourself briefly as ${AGENT_NAME}.

ABOUT OPENCLAW (your knowledge):
- OpenClaw is an open-source AI personal assistant platform (24/7, self-hosted).
- It connects to WhatsApp, Telegram, Discord, Slack, iMessage, Signal, and more.
- It runs locally on your own hardware (Mac, Linux, Raspberry Pi) — your data stays private.
- Key features: multi-agent system, voice calls, scheduled automations (cron), skills ecosystem, memory system.
- Website: openclawai.io | Docs: docs.openclaw.ai | GitHub: github.com/openclaw
- Founded by Kai. Community on Discord.
- Pricing: Free and open-source. Users bring their own API keys.
- Competitors: ChatGPT (cloud-only), Lindy AI (cloud SaaS), custom GPTs (limited).
- Unique value: runs locally, connects to real messaging apps, multi-agent collaboration, voice integration.

If asked about topics you don't know, say so honestly. Don't make things up.`;

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

// --- Hybrid routing: classify if question needs tools ---
const BRAIN_PATTERNS = [
  // Real-time data
  /天气|weather|forecast|温度/i,
  /最新|latest|recent|新闻|news|trending/i,
  /搜索|search|查[一找]|look up|google/i,
  // Tool access
  /project|项目|kanban|workspace|agent|marcus|alex|ethan|leo|noah|monk|pica/i,
  /calendar|日历|日程|schedule|meeting/i,
  /email|邮件|inbox/i,
  /notion|github|slack|discord/i,
  /网站|website|openclawai|fansite/i,
  // Complex reasoning that benefits from full agent
  /分析|analyze|compare|对比|评估|assess/i,
  /帮我|help me|can you.*find|能不能.*找/i,
];

function needsBrain(text) {
  return USE_OPENCLAW_BRAIN && BRAIN_PATTERNS.some(p => p.test(text));
}

// --- Fast GPT-4o-mini client (always available) ---
const fastLLM = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Process accumulated transcript and generate response ---
async function processAndRespond() {
  if (!transcriptBuffer.trim() || !isInMeeting || isSpeaking) return;
  
  const userText = transcriptBuffer.trim();
  transcriptBuffer = '';
  
  // Skip very short fragments or noise
  if (userText.length < 5) return;
  
  const useBrain = needsBrain(userText);
  console.log(`\n🧠 Processing: "${userText}" [${useBrain ? 'BRAIN' : 'FAST'}]`);
  
  try {
    if (useBrain) {
      // Route to OpenClaw Brain for complex queries needing tools
      const brainMessage = `[ZOOM MEETING VOICE CALL] Someone said: "${userText}"\n\nRespond in 1-2 sentences. Plain text only — NO markdown, NO emojis, NO formatting. This goes directly to text-to-speech. Respond in the same language they used.`;
      conversationHistory.push({ role: 'user', content: brainMessage });
    } else {
      conversationHistory.push({ role: 'user', content: userText });
    }
    
    // Keep history manageable
    if (conversationHistory.length > 20) {
      conversationHistory.splice(1, conversationHistory.length - 11);
    }
    
    const timeoutMs = useBrain ? 25000 : 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    
    let response;
    try {
      if (useBrain) {
        // OpenClaw Brain (Claude Opus + tools)
        const completion = await openai.chat.completions.create({
          model: `openclaw:${OPENCLAW_AGENT}`,
          messages: conversationHistory,
          max_tokens: 200,
          temperature: 0.7,
          user: 'zoom-meeting-agent',
        }, { signal: controller.signal });
        response = completion.choices[0]?.message?.content;
      } else {
        // Fast path: GPT-4o-mini (no tools, ~1-2s)
        const completion = await fastLLM.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: conversationHistory,
          max_tokens: 150,
          temperature: 0.7,
        }, { signal: controller.signal });
        response = completion.choices[0]?.message?.content;
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        console.log(`⏱️ ${useBrain ? 'Brain' : 'Fast'} timeout, falling back to GPT-4o-mini`);
        const completion = await fastLLM.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: conversationHistory,
          max_tokens: 150,
          temperature: 0.7,
        });
        response = completion.choices[0]?.message?.content;
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
    
    if (response && !response.includes('No response from OpenClaw')) {
      conversationHistory.push({ role: 'assistant', content: response });
      console.log(`💬 Response: "${response}"`);
      await speakText(response);
    } else {
      console.log(`💬 Response: "${response || '(empty)'}"`);
    }
  } catch (err) {
    console.error('🧠 AI error:', err.message);
  }
}

// --- TTS via Telnyx speak command ---
// Strip markdown/emoji for clean TTS
function cleanForTTS(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')        // *italic* → italic
    .replace(/__([^_]+)__/g, '$1')        // __underline__
    .replace(/_([^_]+)_/g, '$1')          // _italic_
    .replace(/~~([^~]+)~~/g, '$1')        // ~~strikethrough~~
    .replace(/`([^`]+)`/g, '$1')          // `code`
    .replace(/```[\s\S]*?```/g, '')       // code blocks
    .replace(/^#{1,6}\s+/gm, '')          // # headers
    .replace(/^[-*+]\s+/gm, '')           // bullet points
    .replace(/^\d+\.\s+/gm, '')           // numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link](url) → link
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '') // all emojis
    .replace(/\n{3,}/g, '\n\n')           // collapse multiple newlines
    .trim();
}

async function speakText(text) {
  if (!callControlId || isSpeaking) return;
  
  text = cleanForTTS(text);
  if (!text) return;
  
  isSpeaking = true;
  
  // Detect language for voice selection
  const isChinese = /[\u4e00-\u9fff]/.test(text);
  
  try {
    await api('POST', `/calls/${callControlId}/actions/speak`, {
      payload: text,
      voice: isChinese ? 'female' : 'male',
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

  // Start transcription
  // STT_LANGUAGE env: 'en' for English, 'zh' for Chinese, default 'en'
  const sttLang = process.env.STT_LANGUAGE || 'en';
  console.log(`🎤 Starting transcription (language: ${sttLang})...`);
  try {
    await api('POST', `/calls/${callControlId}/actions/transcription_start`, {
      language: sttLang,
      transcription_engine: 'B',
      transcription_tracks: 'inbound',
    });
    console.log(`🎤 Transcription active (Engine B/Whisper, lang=${sttLang})\n`);
  } catch (err) {
    console.error('⚠️ Engine B failed, trying A:', err.message);
    try {
      await api('POST', `/calls/${callControlId}/actions/transcription_start`, {
        language: sttLang,
        transcription_engine: 'A',
        transcription_tracks: 'inbound',
      });
      console.log(`🎤 Transcription active (Engine A/Google, lang=${sttLang})\n`);
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
