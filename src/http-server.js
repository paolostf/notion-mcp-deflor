#!/usr/bin/env node
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;

// --- Global crash guards: a production MCP server must NEVER die from a single
// bad request or an unhandled rejection in a tool handler. Log and keep serving. ---
process.on('unhandledRejection', (reason) => {
  console.error('unhandled_rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught_exception:', err?.stack || err);
  // Do not exit — Express isolates per-request faults; keep the server alive.
});

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Optional bearer auth. If MCP_AUTH_TOKEN is unset, auth is DISABLED
// (migration mode — back-compat with the current connector). When set,
// every /mcp request must send `Authorization: Bearer <token>`. ---
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  next();
}

const sessions = new Map();
let serverReady = false;

// Liveness — always 200, no auth.
app.get('/live', (_req, res) => res.status(200).json({ status: 'alive' }));

// Readiness — no auth.
app.get('/ready', (_req, res) => {
  res.status(serverReady ? 200 : 503).json({ status: serverReady ? 'ready' : 'not_ready' });
});

// Health — detailed, no auth.
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'Notion Unlocked',
    version: VERSION,
    api: '@notionhq/client v5 · Notion-Version 2026-03-11 (data sources)',
    authEnabled: !!AUTH_TOKEN,
    sessions: sessions.size,
    uptime: Math.floor(process.uptime()),
    capabilities: [
      'multi-workspace', 'data-sources', 'surgical-editing', 'batch-ops',
      'block-control', 'operation-locking', 'idempotency', 'unicode-normalization',
    ],
  });
});

app.post('/mcp', authMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res, req.body);
      return;
    }
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
  } catch (error) {
    console.error('mcp_post_error:', error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/mcp', authMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    await sessions.get(sessionId).transport.handleRequest(req, res);
  } catch (error) {
    console.error('mcp_get_error:', error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/mcp', authMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ status: 'session closed' });
  } catch (error) {
    console.error('mcp_delete_error:', error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// Express terminal error handler — last line of defense for sync throws.
app.use((err, _req, res, _next) => {
  console.error('express_error:', err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  serverReady = true;
  console.log(`Notion Unlocked v${VERSION} on port ${PORT} (auth ${AUTH_TOKEN ? 'ON' : 'OFF'})`);
});

// --- Graceful shutdown ---
function gracefulShutdown(signal) {
  console.log(`shutdown_initiated: ${signal}`);
  serverReady = false;
  httpServer.close(() => { console.log('shutdown_complete'); process.exit(0); });
  setTimeout(() => { console.warn('shutdown_forced'); process.exit(1); }, 30_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
