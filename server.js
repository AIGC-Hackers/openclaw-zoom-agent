/**
 * OpenClaw Voice Bridge
 * 
 * WebSocket server that bridges Retell AI (voice) with OpenClaw (brain).
 * Handles Zoom IVR navigation via DTMF and meeting conversation.
 */

import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import OpenAI from 'openai';
import { createServer } from 'http';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 8080;

// Use OpenRouter for model access (GPT-4o, Claude, etc.)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'openai/gpt-4o';

// Initialize OpenAI client pointed at OpenRouter
const openai = new OpenAI({ 
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

// IVR Detection patterns
const IVR_PATTERNS = {
  MEETING_ID: /enter.*(meeting|conference).*(id|number)|meeting id followed by/i,
  PARTICIPANT_ID: /participant.*(id|number)|attendee.*(id|number)/i,
  PASSCODE: /passcode|password|pin/i,
  CONNECTED: /entering the meeting|host has started|please wait|you are now|joining/i,
  INVALID: /does not exist|invalid|incorrect/i,
  WELCOME: /welcome to zoom/i
};

// System prompt for meeting participation
const SYSTEM_PROMPT = `You are Marcus, an AI assistant participating in a Zoom meeting on behalf of your human colleague.

## Your Role
- You joined this meeting to listen, contribute, and help where needed
- You represent {{human_name}} who couldn't attend in person
- Be helpful, concise, and professional

## Conversation Style
- Be concise - meetings have limited time
- Speak naturally, like a human colleague
- Use short responses (1-3 sentences usually)
- Don't be verbose or overly formal
- It's okay to use filler words occasionally ("well", "so", "I think")
- Ask clarifying questions when needed
- Acknowledge when you don't know something

## Important
- Listen actively and respond to what was actually said
- Don't repeat yourself
- If the audio is unclear, say something like "sorry, didn't catch that"
- End with a question or next step when appropriate

## What You Can Do
- Discuss topics and share perspectives
- Answer questions with your knowledge
- Summarize discussions if asked
- Provide analysis or suggestions
- Help move discussions forward`;

const GREETING = "Hi everyone, this is Marcus, an AI assistant joining on behalf of {{human_name}}. I'm here to listen and participate. Please go ahead.";

/**
 * IVR State Machine
 */
class IVRHandler {
  constructor(meetingId, passcode) {
    this.meetingId = meetingId || '';
    this.passcode = passcode || '';
    this.state = 'WAITING'; // WAITING, ENTERING_ID, ENTERING_PASSCODE, CONNECTED
    this.digitIndex = 0;
    this.retryCount = 0;
  }

  /**
   * Check if we should handle IVR (return DTMF digits) or pass to LLM
   */
  handleTranscript(transcript) {
    const lastUtterance = transcript[transcript.length - 1];
    if (!lastUtterance || lastUtterance.role !== 'user') return null;
    
    const text = lastUtterance.content.toLowerCase();
    
    // Check if we're connected to the meeting
    if (IVR_PATTERNS.CONNECTED.test(text)) {
      this.state = 'CONNECTED';
      return null; // Let LLM handle from here
    }
    
    // Detect IVR prompts
    if (IVR_PATTERNS.WELCOME.test(text)) {
      this.state = 'WAITING';
      return { action: 'wait' }; // Wait for next prompt
    }
    
    if (IVR_PATTERNS.MEETING_ID.test(text)) {
      this.state = 'ENTERING_ID';
      this.digitIndex = 0;
      return this.getNextDigits(this.meetingId);
    }
    
    if (IVR_PATTERNS.PARTICIPANT_ID.test(text)) {
      // Skip participant ID by pressing #
      return { action: 'dtmf', digits: ['#'] };
    }
    
    if (IVR_PATTERNS.PASSCODE.test(text)) {
      this.state = 'ENTERING_PASSCODE';
      this.digitIndex = 0;
      if (this.passcode) {
        return this.getNextDigits(this.passcode);
      } else {
        // No passcode, just press #
        return { action: 'dtmf', digits: ['#'] };
      }
    }
    
    if (IVR_PATTERNS.INVALID.test(text)) {
      this.retryCount++;
      if (this.retryCount > 2) {
        return { action: 'hangup', reason: 'IVR navigation failed' };
      }
      // Retry current state
      if (this.state === 'ENTERING_ID') {
        this.digitIndex = 0;
        return this.getNextDigits(this.meetingId);
      }
    }
    
    // If in IVR state but no pattern matched, stay silent
    if (this.state !== 'CONNECTED' && this.state !== 'WAITING') {
      return { action: 'wait' };
    }
    
    return null; // Pass to LLM
  }
  
  getNextDigits(number) {
    const digits = number.replace(/\D/g, '').split('');
    // Return all digits plus #
    return { action: 'dtmf', digits: [...digits, '#'] };
  }
  
  isConnected() {
    return this.state === 'CONNECTED';
  }
}

/**
 * Handle WebSocket connection from Retell
 */
function handleRetellConnection(ws, callId, metadata) {
  console.log(`[${callId}] New connection`, metadata);
  
  const humanName = metadata?.human_name || 'Kai';
  const meetingId = metadata?.meeting_id || '';
  const passcode = metadata?.passcode || '';
  
  // Initialize IVR handler
  const ivr = new IVRHandler(meetingId, passcode);
  
  // Prepare prompts with metadata
  const systemPrompt = SYSTEM_PROMPT
    .replace(/\{\{human_name\}\}/g, humanName);
  
  const greeting = GREETING.replace(/\{\{human_name\}\}/g, humanName);
  
  // Don't send greeting during IVR - wait until connected
  let greetingSent = false;
  
  // Handle messages from Retell
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      const responseId = message.response_id;
      
      if (message.interaction_type === 'update_only') {
        // Just a transcript update, no response needed
        const lastContent = message.transcript?.slice(-1)[0]?.content || '';
        console.log(`[${callId}] Update: "${lastContent.substring(0, 50)}..."`);
        return;
      }
      
      if (message.interaction_type === 'response_required' || 
          message.interaction_type === 'reminder_required') {
        
        // Check IVR handling first
        const ivrAction = ivr.handleTranscript(message.transcript || []);
        
        if (ivrAction) {
          console.log(`[${callId}] IVR action:`, ivrAction);
          
          if (ivrAction.action === 'dtmf') {
            // Send DTMF digits via tool call
            for (const digit of ivrAction.digits) {
              const dtmfResponse = {
                response_id: responseId,
                content: '',
                content_complete: false,
                end_call: false,
                tool_calls: [{
                  id: `dtmf_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'press_digit',
                    arguments: JSON.stringify({ digit })
                  }
                }]
              };
              ws.send(JSON.stringify(dtmfResponse));
              // Small delay between digits
              await new Promise(r => setTimeout(r, 200));
            }
            // Send completion
            ws.send(JSON.stringify({
              response_id: responseId,
              content: '',
              content_complete: true,
              end_call: false
            }));
            return;
          }
          
          if (ivrAction.action === 'wait') {
            // Stay silent during IVR
            ws.send(JSON.stringify({
              response_id: responseId,
              content: '',
              content_complete: true,
              end_call: false
            }));
            return;
          }
          
          if (ivrAction.action === 'hangup') {
            ws.send(JSON.stringify({
              response_id: responseId,
              content: "I'm sorry, I wasn't able to join the meeting.",
              content_complete: true,
              end_call: true
            }));
            return;
          }
        }
        
        // If IVR just became connected, send greeting
        if (ivr.isConnected() && !greetingSent) {
          greetingSent = true;
          ws.send(JSON.stringify({
            response_id: responseId,
            content: greeting,
            content_complete: true,
            end_call: false
          }));
          console.log(`[${callId}] Connected to meeting, sent greeting`);
          return;
        }
        
        // Normal conversation - use LLM
        console.log(`[${callId}] LLM response required`);
        
        // Build conversation for OpenAI
        const messages = [
          { role: 'system', content: systemPrompt }
        ];
        
        // Add conversation history (skip IVR parts)
        if (message.transcript) {
          for (const turn of message.transcript) {
            // Skip IVR-like messages
            const content = turn.content.toLowerCase();
            if (IVR_PATTERNS.MEETING_ID.test(content) ||
                IVR_PATTERNS.WELCOME.test(content) ||
                IVR_PATTERNS.PARTICIPANT_ID.test(content) ||
                IVR_PATTERNS.PASSCODE.test(content)) {
              continue;
            }
            messages.push({
              role: turn.role === 'agent' ? 'assistant' : 'user',
              content: turn.content
            });
          }
        }
        
        // If reminder, add a nudge
        if (message.interaction_type === 'reminder_required') {
          messages.push({
            role: 'user',
            content: '(The meeting has been quiet. Check if anyone needs anything or has questions.)'
          });
        }
        
        // Stream response from LLM
        try {
          const stream = await openai.chat.completions.create({
            model: MODEL,
            messages: messages,
            max_tokens: 150,
            temperature: 0.7,
            stream: true
          });
          
          let fullResponse = '';
          
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              fullResponse += content;
              
              // Send chunk to Retell
              ws.send(JSON.stringify({
                response_id: responseId,
                content: content,
                content_complete: false,
                end_call: false
              }));
            }
          }
          
          // Send completion signal
          ws.send(JSON.stringify({
            response_id: responseId,
            content: '',
            content_complete: true,
            end_call: false
          }));
          
          console.log(`[${callId}] Response: "${fullResponse.substring(0, 80)}..."`);
          
        } catch (err) {
          console.error(`[${callId}] LLM error:`, err.message);
          
          // Send error recovery response
          ws.send(JSON.stringify({
            response_id: responseId,
            content: "Sorry, I had a brief technical issue. Could you repeat that?",
            content_complete: true,
            end_call: false
          }));
        }
      }
      
    } catch (err) {
      console.error(`[${callId}] Message parse error:`, err);
    }
  });
  
  ws.on('close', () => {
    console.log(`[${callId}] Connection closed`);
  });
  
  ws.on('error', (err) => {
    console.error(`[${callId}] WebSocket error:`, err);
  });
}

// Create Express app for health checks
const app = express();

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'openclaw-voice-bridge',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Create HTTP server
const server = createServer(app);

// Create WebSocket server on /llm-websocket path
const wss = new WebSocketServer({ server, path: '/llm-websocket' });

wss.on('connection', (ws, req) => {
  // Extract call_id and metadata from URL params
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callId = url.searchParams.get('call_id') || `call_${Date.now()}`;
  
  let metadata = {};
  try {
    // Metadata can come from query param or be sent in first message
    const metaParam = url.searchParams.get('metadata');
    if (metaParam) {
      metadata = JSON.parse(decodeURIComponent(metaParam));
    }
  } catch (e) {
    // Ignore metadata parse errors
  }
  
  // Also check for individual params
  metadata.meeting_id = metadata.meeting_id || url.searchParams.get('meeting_id');
  metadata.passcode = metadata.passcode || url.searchParams.get('passcode');
  metadata.human_name = metadata.human_name || url.searchParams.get('human_name') || 'Kai';
  
  handleRetellConnection(ws, callId, metadata);
});

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║       OpenClaw Voice Bridge v1.0.0                ║
╠═══════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${PORT}                 ║
║  WebSocket: ws://localhost:${PORT}/llm-websocket     ║
║  Model:     ${MODEL.padEnd(35)}║
╚═══════════════════════════════════════════════════╝
`);
});
