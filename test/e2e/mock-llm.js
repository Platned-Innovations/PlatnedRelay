// Minimal mock of OpenAI chat completions + Anthropic messages for smoke tests.
const http = require('http');
let calls = 0;
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      calls++;
      const j = body ? JSON.parse(body) : {};
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }] }));
      if (req.url.startsWith('/fail')) { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: 'overloaded' } })); }
      if (req.url.endsWith('/v1/messages')) {
        const text = 'Hello from mock claude. You said: ' + JSON.stringify(j.messages).slice(0, 120);
        if (j.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
          ev('message_start', { message: { usage: { input_tokens: 11, cache_read_input_tokens: 5 } } });
          for (const w of text.split(' ')) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: w + ' ' } }); await new Promise((r) => setTimeout(r, 5)); }
          ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
          ev('message_stop', {});
          return res.end();
        }
        return res.end(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 9 } }));
      }
      const last = (j.messages || []).filter((m) => m.role === 'user').pop();
      const text = 'Echo: ' + (typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content));
      if (j.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: j.model };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        for (const w of text.split(/(?<= )/)) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      await new Promise((r) => setTimeout(r, 50));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }));
    });
  })
  .listen(18080, () => console.log('mock on 18080'));
