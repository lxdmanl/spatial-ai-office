import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { stageSchema, taskInput } from '../shared/contracts.ts';
import type { Scene } from '../shared/contracts.ts';
import { markdown } from './artifacts.ts';
import { Conflict, Missing } from './office.ts';
import type { Office } from './office.ts';

const version = z.strictObject({ seq: z.number().int().positive() });

export function createHttp(office: Office, scene: Scene, root: string) {
  const app = express();
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true });
  const host = () => `127.0.0.1:${(server.address() as AddressInfo | null)?.port}`;
  const origin = () => `http://${host()}`;

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.headers.host !== host() || (req.headers.origin && req.headers.origin !== origin())) {
      res.status(403).json({ error: '請透過工作室的本機網址開啟。' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:");
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', express.json({ limit: '160kb' }));
  app.get('/api/scene', (_req, res) => { res.json(scene); });
  app.get('/api/status', (_req, res) => { res.json(office.status()); });
  app.get('/api/tasks', (_req, res) => { res.json(office.list()); });
  app.get('/api/tasks/:id', (req, res) => { res.json(office.get(req.params.id)); });
  app.post('/api/tasks', (req, res) => { res.status(201).json(office.create(taskInput.parse(req.body), scene.id)); });
  app.post('/api/tasks/:id/cancel', (req, res) => { res.json(office.cancel(req.params.id, version.parse(req.body).seq)); });
  app.post('/api/tasks/:id/retry', (req, res) => { res.json(office.retry(req.params.id, version.parse(req.body).seq)); });
  app.get('/api/tasks/:id/artifacts/:stage', (req, res) => {
    const task = office.get(req.params.id);
    const stage = stageSchema.parse(req.params.stage);
    const content = markdown(task, stage);
    if (!content) throw new Missing('此成果尚未完成。');
    res.attachment(`${stage}.md`).type('text/markdown; charset=utf-8').send(content);
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: '找不到這個工作室介面。' }); });
  app.use('/assets', express.static(join(root, '.local', 'assets'), { index: false }));
  app.use('/assets', express.static(join(root, 'assets'), { index: false }));
  app.use(express.static(join(root, 'dist')));
  app.get('/', (_req, res) => { res.status(503).type('text').send('請先執行 npm run build。'); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0]?.message ?? '輸入格式不正確。' });
    } else if (error instanceof Conflict || error instanceof Missing) {
      res.status(error instanceof Conflict ? 409 : 404).json({ error: error.message });
    } else if (error instanceof SyntaxError) {
      res.status(400).json({ error: '請求格式不正確。' });
    } else if (error && typeof error === 'object' && 'status' in error && error.status === 413) {
      res.status(413).json({ error: '請求太大，請縮短原文後再試。' });
    } else {
      res.status(500).json({ error: '工作室發生本機錯誤。' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/events' || req.headers.host !== host() || req.headers.origin !== origin()) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (client) => {
      client.on('error', () => client.terminate());
      client.send(JSON.stringify({ kind: 'connected' }));
    });
  });
  const unsubscribe = office.subscribe((event) => {
    const message = JSON.stringify(event);
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  });
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    unsubscribe();
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.close();
    office.close();
  }
  return { server, close };
}

export const projectRoot = resolve(import.meta.dirname, '..');
