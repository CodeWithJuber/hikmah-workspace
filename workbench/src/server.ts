/** The workbench service.
 *
 * Two entry points, with different callers and different credentials:
 *
 *  - A WebSocket upgrade from the browser, carrying a single-use ticket the app
 *    signed. This is the interactive terminal.
 *  - HTTP from the app over the private network, carrying the shared token.
 *    This is how the assistant's tools run commands.
 *
 * The workbench authorises nothing on its own. It has no session store and no
 * view of who is signed in; it executes what the app has already approved. That
 * keeps the policy in one place instead of drifting across two services.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { TicketError, pruneSeen, verifyTicket } from './ticket.ts';
import { createTerminal as defaultCreateTerminal, type TerminalSession } from './terminal.ts';
import { RunRequestError, parseRunRequest, readJsonBody, writeRunStream } from './runs.ts';
import type { sshExec } from './ssh.ts';

const PORT = Number(process.env.HIKMAH_WORKBENCH_PORT ?? 3001);
const TOKEN = process.env.HIKMAH_WORKBENCH_TOKEN ?? '';
const APP_ORIGIN = process.env.HIKMAH_APP_ORIGIN ?? '';
const WORKSPACE = process.env.HIKMAH_WORKSPACE_DIR ?? '/workspace';
/** Dead sockets are dropped rather than left holding a shell open. */
const HEARTBEAT_MS = 30_000;
/** One browser tab should not be able to start shells until the box is full. */
const MAX_SESSIONS = 8;

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type WorkbenchOptions = {
  token: string;
  appOrigin: string;
  workspace: string;
  heartbeatMs?: number;
  /** Injected by the tests so they do not spawn real shells. */
  createTerminal?: typeof defaultCreateTerminal;
  /** Injected by the tests so they do not need a real SSH server. */
  exec?: typeof sshExec;
};

export function createWorkbench(options: WorkbenchOptions) {
  const createTerminal = options.createTerminal ?? defaultCreateTerminal;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const sessions = new Map<WebSocket, TerminalSession>();
  /** Nonce to expiry, so a ticket cannot be replayed inside its lifetime. */
  const spentTickets = new Map<string, number>();

  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: object) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    // Only the app talks HTTP here, and only over the private network.
    if (!constantTimeEquals(request.headers.authorization ?? '', `Bearer ${options.token}`)) {
      return send(401, { error: 'Unauthorized.' });
    }
    if (request.url === '/health') return send(200, { status: 'ok', sessions: sessions.size });
    if (request.url === '/runs' && request.method === 'POST') {
      // The socket closing is how the app cancels a run: a stopped run must
      // actually end the command, not leave it going on someone's server.
      const controller = new AbortController();
      response.on('close', () => controller.abort());
      void (async () => {
        let parsed;
        try {
          parsed = parseRunRequest(await readJsonBody(request));
        } catch (error) {
          if (error instanceof RunRequestError) return send(error.status, { error: error.message });
          return send(400, { error: 'Could not read the request.' });
        }
        await writeRunStream(response, parsed, {
          signal: controller.signal,
          exec: options.exec,
          workspace: options.workspace,
        });
      })();
      return;
    }
    return send(404, { error: 'Not found.' });
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const reject = (code: number, reason: string) => {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
      socket.destroy();
    };

    // The browser reaches this through Caddy, so Origin is the only signal that
    // the page asking for a shell is actually ours.
    if (options.appOrigin && request.headers.origin !== options.appOrigin)
      return reject(403, 'Forbidden');

    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://workbench.invalid');
    } catch {
      return reject(400, 'Bad Request');
    }
    if (url.pathname !== '/terminal') return reject(404, 'Not Found');
    if (sessions.size >= MAX_SESSIONS) return reject(503, 'Too Many Sessions');

    pruneSeen(spentTickets);
    // The spent nonces live in a Map keyed by expiry so they can be pruned;
    // verifyTicket only needs membership, so it gets a view of the keys.
    const seen = new Set(spentTickets.keys());
    let payload;
    try {
      payload = verifyTicket(url.searchParams.get('ticket') ?? '', options.token, { seen });
    } catch (error) {
      if (!(error instanceof TicketError)) throw error;
      return reject(401, 'Unauthorized');
    }
    if (payload.scope !== 'terminal') return reject(403, 'Forbidden');
    spentTickets.set(payload.nonce, payload.expiresAt);

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws: WebSocket) => {
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });

    const session = createTerminal({
      cwd: options.workspace,
      onData: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      onExit: (code) => {
        if (ws.readyState === ws.OPEN) ws.send(`\r\n[process exited with code ${code}]\r\n`);
        ws.close();
      },
    });
    sessions.set(ws, session);

    // Keystrokes arrive as binary frames and control frames as text, so a
    // pasted JSON document can never be mistaken for a resize. A text frame
    // that is not a control frame is still typed, so a plain client works.
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const text = raw.toString();
      if (!isBinary && text.startsWith('{')) {
        try {
          const message = JSON.parse(text);
          if (message?.type === 'resize') {
            session.resize(Number(message.cols), Number(message.rows));
            return;
          }
        } catch {
          /* not a control frame; fall through and treat it as input */
        }
      }
      session.write(text);
    });

    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, heartbeatMs);
    heartbeat.unref?.();

    ws.on('close', () => {
      clearInterval(heartbeat);
      sessions.get(ws)?.kill();
      sessions.delete(ws);
    });
  });

  return {
    httpServer,
    get sessionCount() {
      return sessions.size;
    },
    listen: (port: number) =>
      new Promise<number>((resolve) =>
        httpServer.listen(port, '0.0.0.0', () => {
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        }),
      ),
    close: async () => {
      for (const session of sessions.values()) session.kill();
      sessions.clear();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// Started directly rather than imported: the tests build their own instance.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  if (TOKEN.length < 32) {
    console.error('Set HIKMAH_WORKBENCH_TOKEN to at least 32 characters.');
    process.exit(1);
  }
  if (!APP_ORIGIN.startsWith('https://') && !APP_ORIGIN.startsWith('http://localhost')) {
    console.error('Set HIKMAH_APP_ORIGIN to the exact origin of the app.');
    process.exit(1);
  }
  const workbench = createWorkbench({ token: TOKEN, appOrigin: APP_ORIGIN, workspace: WORKSPACE });
  await workbench.listen(PORT);
  console.info(`[workbench] listening on ${PORT}, workspace ${WORKSPACE}`);
  const shutdown = () => {
    void workbench.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
