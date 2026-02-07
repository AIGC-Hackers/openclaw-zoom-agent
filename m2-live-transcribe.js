/**
 * M2 — Live Zoom Transcription via Telnyx
 * 
 * 1. Starts cloudflared tunnel for webhook delivery
 * 2. Dials Zoom via Telnyx PSTN
 * 3. Joins meeting with DTMF (stepped pattern)
 * 4. Starts Telnyx real-time transcription
 * 5. Receives transcripts via webhook, prints live
 */

import express from 'express';
import { createServer } from 'http';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 8181;
const KEY = process.env.TELNYX_API_KEY;
const BASE = 'https://api.telnyx.com/v2';

// CLI args
const args = process.argv.slice(2);
const meetingId = args.find((_, i) => args[i - 1] === '-m') || args.find((_, i) => args[i - 1] === '--meeting-id');
const passcode = args.find((_, i) => args[i - 1] === '-p') || args.find((_, i) => args[i - 1] === '--passcode');
const duration = parseInt(args.find((_, i) => args[i - 1] === '-d') || '300');

if (!meetingId) {
  console.error('Usage: node m2-live-transcribe.js -m MEETING_ID -p PASSCODE [-d DURATION_SECS]');
  process.exit(1);
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
        console.log(`  ⚠️ API retry ${attempt + 1}/${retries} (${err.cause?.code || 'network error'})`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }

// --- Transcript storage ---
const transcripts = [];

// --- Express for webhooks ---
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  
  const event = req.body?.data || req.body;
  const eventType = event?.event_type;
  const payload = event?.payload || event;

  if (eventType === 'call.transcription') {
    const text = payload?.transcription_data?.transcript;
    const isFinal = payload?.transcription_data?.is_final;
    const confidence = payload?.transcription_data?.confidence;
    const track = payload?.transcription_data?.track;
    
    if (text && text.trim()) {
      const entry = { 
        time: ts(), 
        track, 
        text: text.trim(), 
        final: isFinal, 
        confidence: confidence?.toFixed(2) 
      };
      
      if (isFinal) {
        transcripts.push(entry);
        console.log(`\n🎤 [${entry.time}] ${entry.text}`);
        if (confidence) console.log(`   confidence: ${confidence.toFixed(2)}`);
      } else {
        process.stdout.write(`\r  💭 ${text.trim().slice(0, 80)}...`);
      }
    }
  } else if (eventType === 'call.hangup') {
    console.log(`\n📞 Call ended: ${payload?.hangup_cause}`);
  } else if (eventType === 'call.answered') {
    console.log(`📞 Call answered`);
  } else {
    console.log(`📡 Event: ${eventType}`);
  }
});

app.get('/health', (req, res) => res.json({ ok: true, transcripts: transcripts.length }));

const server = createServer(app);

// --- Tunnel (ngrok preferred, cloudflared fallback) ---
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    // Try ngrok first
    const proc = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Tunnel start timeout'));
      }
    }, 15000);

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          if (j.url && j.url.startsWith('https://') && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({ url: j.url, process: proc });
          }
        } catch {
          // Also check for plain text URL
          const match = line.match(/https:\/\/[a-z0-9-]+\.ngrok[a-z.-]*\.(?:io|app)\S*/i);
          if (match && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({ url: match[0], process: proc });
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      if (!resolved) console.log('  ngrok:', data.toString().trim());
    });

    proc.on('error', (err) => {
      if (!resolved) reject(err);
    });
    proc.on('exit', (code) => {
      if (!resolved) reject(new Error(`ngrok exited with code ${code}`));
    });

    // Fallback: poll ngrok API after 3s
    setTimeout(async () => {
      if (resolved) return;
      try {
        const res = await fetch('http://127.0.0.1:4040/api/tunnels');
        const data = await res.json();
        const tunnel = data.tunnels?.find(t => t.proto === 'https');
        if (tunnel && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ url: tunnel.public_url, process: proc });
        }
      } catch { /* ngrok API not ready yet */ }
    }, 4000);
  });
}

// --- Main ---
async function main() {
  // 1. Start webhook server
  await new Promise(r => server.listen(PORT, r));
  console.log(`🌐 Webhook server on port ${PORT}`);

  // 2. Start tunnel
  console.log('🔧 Starting Cloudflare tunnel...');
  const tunnel = await startTunnel(PORT);
  const webhookUrl = `${tunnel.url}/webhook`;
  console.log(`🚇 Tunnel: ${tunnel.url}`);
  console.log(`📡 Webhook: ${webhookUrl}`);

  // 2b. Update call control app webhook URL to tunnel
  const appId = process.env.TELNYX_CONNECTION_ID;
  if (appId) {
    console.log('🔗 Updating call control app webhook URL...');
    await api('PATCH', `/call_control_applications/${appId}`, {
      webhook_event_url: webhookUrl,
    });
    console.log('✅ App webhook URL updated');
  }

  // 3. Dial Zoom
  console.log(`\n📞 Dialing Zoom meeting ${meetingId}...`);
  const call = await api('POST', '/calls', {
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to: process.env.ZOOM_DIAL_IN || '+16699009128',
    from: process.env.TELNYX_DID,
    timeout_secs: 60,
    webhook_url: webhookUrl,
    webhook_url_method: 'POST',
  });

  const ccid = call.data.call_control_id;
  console.log(`📞 Call placed: ${ccid.slice(0, 20)}...`);

  // 4. DTMF sequence (stepped pattern — proven reliable)
  console.log('⏳ Waiting 15s for IVR...');
  await sleep(15000);

  let s = await api('GET', `/calls/${ccid}`);
  if (!s.data?.is_alive) { console.log('❌ Call died during IVR wait'); cleanup(tunnel); return; }
  console.log('✅ Alive — sending meeting ID');

  await api('POST', `/calls/${ccid}/actions/send_dtmf`, { digits: `${meetingId}#`, duration_millis: 300 });
  await sleep(8000);

  s = await api('GET', `/calls/${ccid}`);
  if (!s.data?.is_alive) { console.log('❌ Died after meeting ID'); cleanup(tunnel); return; }
  console.log('✅ Alive — skipping participant ID');

  await api('POST', `/calls/${ccid}/actions/send_dtmf`, { digits: '#', duration_millis: 300 });
  await sleep(5000);

  s = await api('GET', `/calls/${ccid}`);
  if (!s.data?.is_alive) { console.log('❌ Died after skip'); cleanup(tunnel); return; }

  if (passcode) {
    console.log('✅ Alive — sending passcode');
    await api('POST', `/calls/${ccid}/actions/send_dtmf`, { digits: `${passcode}#`, duration_millis: 300 });
    await sleep(8000);
  }

  s = await api('GET', `/calls/${ccid}`);
  if (!s.data?.is_alive) { console.log('❌ Died after passcode'); cleanup(tunnel); return; }

  console.log('🎉 IN THE MEETING!');

  // 5. Start transcription
  console.log('🎤 Starting live transcription...');
  try {
    await api('POST', `/calls/${ccid}/actions/transcription_start`, {
      language: 'en',
      transcription_engine: 'B',  // Telnyx engine (more accurate, cheaper)
      transcription_tracks: 'inbound',  // Audio from Zoom participants
    });
    console.log('🎤 Transcription started! Listening...\n');
  } catch (err) {
    console.error('⚠️ Transcription start failed:', err.message);
    console.log('Trying engine A (Google)...');
    try {
      await api('POST', `/calls/${ccid}/actions/transcription_start`, {
        language: 'en',
        transcription_engine: 'A',
        transcription_tracks: 'inbound',
        interim_results: false,
      });
      console.log('🎤 Transcription started (Google engine)! Listening...\n');
    } catch (err2) {
      console.error('❌ Both engines failed:', err2.message);
    }
  }

  // 6. Keep alive for duration
  const endTime = Date.now() + duration * 1000;
  while (Date.now() < endTime) {
    await sleep(15000);
    try {
      s = await api('GET', `/calls/${ccid}`);
      if (!s.data?.is_alive) {
        console.log('\n📞 Call ended');
        break;
      }
    } catch {
      // Ignore transient API errors
    }
  }

  // 7. Hangup & summary
  try {
    await api('POST', `/calls/${ccid}/actions/hangup`, {});
  } catch { /* already ended */ }

  console.log('\n\n📝 ═══ TRANSCRIPT SUMMARY ═══');
  if (transcripts.length === 0) {
    console.log('No transcripts captured.');
  } else {
    for (const t of transcripts) {
      console.log(`[${t.time}] ${t.text}`);
    }
  }
  console.log(`Total segments: ${transcripts.length}`);

  cleanup(tunnel);
}

function cleanup(tunnel) {
  tunnel.process.kill();
  server.close();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
