// backend/src/gateway/io-handle.ts
//
// Lazy Socket.IO handle. Breaks the historical circular dependency where
// service modules did `import { io } from '../../app'` — which evaluated the
// ENTIRE Express app (including the HTTP listener and every route import)
// in any process that loaded such a module (workers, tests, tools). That
// transitive app-evaluation is what once made a worker process bind
// port 3000 and crash the whole container with EADDRINUSE.
//
// Services now depend on this tiny module and resolve the handle at CALL
// time: importing a service can never evaluate app.ts again.
//
// When no server has been bound (worker processes, unit tests), getIo()
// returns a detached no-op Socket.IO server whose emits are silently
// dropped — the same behavior service code historically had when it
// emitted through an app-created server that was never listening. Workers
// never crash on broadcasts; the DB remains the source of truth and apps
// resync via getCurrentTrip on their next connect.
import { createServer } from 'http';
import type { Server } from 'socket.io';

let active: Server | null = null;
let detached: Server | null = null;

/** Bind the authoritative Socket.IO server (called once from app.ts). */
export function bindIo(server: Server): void {
  active = server;
}

/**
 * The authoritative server handle. Only call at request/emit time — never
 * at module top level — so modules stay import-safe outside the API server.
 */
export function getIo(): Server {
  if (active) return active;
  if (!detached) {
    try {
      const httpServer = createServer();
      detached = new (require('socket.io').Server)(httpServer, {
        serveClient: false,
        path: '/__netride_detached__',
      });
    } catch {
      detached = null as any;
    }
  }
  return detached as Server;
}

/** True once the API server has bound its Socket.IO handle. */
export function isIoBound(): boolean {
  return active !== null;
}
