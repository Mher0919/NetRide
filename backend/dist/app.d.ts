import { Server } from 'socket.io';
declare const io: Server<import("socket.io").DefaultEventsMap, import("socket.io").DefaultEventsMap, import("socket.io").DefaultEventsMap, any>;
/**
 * Boot the HTTP/Socket.IO listener and all background jobs. Deliberately
 * NOT executed at module load: worker processes (matchWorker, cronWorker)
 * import this module via `io` and must never bind the port — an accidental
 * second `listen` is exactly what produced `EADDRINUSE` and crashed a
 * deployment when a job module pulled in ride.service → app.ts.
 */
export declare function startServer(): void;
export { io };
