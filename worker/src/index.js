// Retell Custom LLM WebSocket Server for Cloudflare Workers
// Uses Durable Objects for persistent WebSocket connections

const SYSTEM_PROMPT = `You are an AI assistant joining a Zoom meeting on behalf of Kai.

## Your Role
- You are Kai's AI representative attending this meeting
- Be professional, helpful, and concise
- Take notes on important points discussed
- Ask clarifying questions when needed
- If asked who you are, explain you're Kai's AI assistant joining on their behalf

## Guidelines
- Keep responses brief (1-2 sentences for casual chat, more for substantive topics)
- Be natural and conversational
- If you don't know something, say so
- Summarize key points when the meeting ends`;

// Durable Object for handling WebSocket connections
export class WebSocketServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data.interaction_type);
      
      switch (data.interaction_type) {
        case 'call_details':
          console.log('Call started:', data.call?.call_id);
          break;

        case 'ping_pong':
          if (data.ping_pong?.ping_id) {
            ws.send(JSON.stringify({
              response_type: 'ping_pong',
              ping_pong: { ping_id: data.ping_pong.ping_id }
            }));
          }
          break;

        case 'update_only':
          // Just an update, no response needed
          break;

        case 'response_required':
          const history = [];
          if (data.transcript) {
            for (const item of data.transcript) {
              if (item.content) {
                history.push({
                  role: item.role === 'agent' ? 'assistant' : 'user',
                  content: item.content
                });
              }
            }
          }

          const response = await this.generateResponse(history);
          
          ws.send(JSON.stringify({
            response_type: 'response',
            response_id: data.response_id || 0,
            content: response,
            content_complete: true,
            end_call: false
          }));
          break;

        case 'reminder_required':
          ws.send(JSON.stringify({
            response_type: 'response',
            response_id: data.response_id || 0,
            content: "I'm still here. Is there anything you'd like to discuss?",
            content_complete: true,
            end_call: false
          }));
          break;

        default:
          console.log('Unknown interaction type:', data.interaction_type);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  }

  async webSocketClose(ws, code, reason) {
    console.log('WebSocket closed:', code, reason);
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  async generateResponse(history) {
    const apiKey = this.env.OPENROUTER_API_KEY;
    const model = this.env.OPENROUTER_MODEL || 'openai/gpt-4o';

    if (!apiKey) {
      return "I'm having trouble connecting. Please check the API configuration.";
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://openclaw.ai',
          'X-Title': 'OpenClaw Zoom Agent'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history
          ],
          max_tokens: 150,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        console.error('OpenRouter error:', response.status);
        return "I'm having trouble thinking right now. Could you repeat that?";
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || "I didn't catch that. Could you say it again?";
    } catch (error) {
      console.error('LLM error:', error);
      return "I'm experiencing some technical difficulties.";
    }
  }
}

// Main worker entry point
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'retell-llm-server' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // WebSocket endpoint - route to Durable Object
    if (url.pathname === '/llm-websocket') {
      // Use a consistent ID for the Durable Object (could be call-specific)
      const id = env.WEBSOCKET_SERVER.idFromName('default');
      const stub = env.WEBSOCKET_SERVER.get(id);
      return stub.fetch(request);
    }

    return new Response('Retell LLM Server\nWebSocket: wss://retell-llm-server.k-xshar.workers.dev/llm-websocket', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};
