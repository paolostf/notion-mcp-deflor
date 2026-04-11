#!/usr/bin/env node
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '10mb' }));

const sessions = new Map();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'Notion Unlocked', version: '2.5.0', capabilities: ['multi-workspace', 'diff-editing', 'batch-ops', 'block-control', 'parallel-deletes', 'unicode-normalization'] });
});

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      await session.transport.handleRequest(req, res, req.body);
    } else {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      const server = createServer();
      await server.connect(transport);
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server });
      }
    }
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const session = sessions.get(sessionId);
  await session.transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    await session.transport.close();
    sessions.delete(sessionId);
  }
  res.status(200).json({ status: 'session closed' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Notion Unlocked v2.5.0 running on port ${PORT}`);
});
