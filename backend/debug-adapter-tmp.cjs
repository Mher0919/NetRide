require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const { io: clientIo } = require('C:/Users/mmkrt/OneDrive/Desktop/NetRide/apps/admin_dashboard/node_modules/socket.io-client');

const redisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
  enableOfflineQueue: false,
  lazyConnect: true,
  retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2000)),
};
const pubClient = new Redis('redis://127.0.0.1:6379', redisOptions);
const subClient = new Redis('redis://127.0.0.1:6379', redisOptions);
pubClient.on('error', (e) => console.log('[PUB err]', e.message));
subClient.on('error', (e) => console.log('[SUB err]', e.message));

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
io.adapter(createAdapter(pubClient, subClient));

io.on('connection', (socket) => {
  console.log('[server] client connected', socket.id);
  socket.join('driver:test-user-123');
  console.log('[server] joined room driver:test-user-123');
});

httpServer.listen(3999, async () => {
  console.log('[server] listening on 3999');
  const client = clientIo('http://localhost:3999', { transports: ['websocket'] });
  client.on('connect', async () => {
    console.log('[client] connected', client.id);
    await new Promise((r) => setTimeout(r, 500));
    io.to('driver:test-user-123').emit('newTripRequest', { id: 'trip-1' });
    console.log('[server] emitted newTripRequest to room');
    await new Promise((r) => setTimeout(r, 1500));
    const got = client.received ? client.received.length : 0;
    console.log(got > 0 ? '✅ CLIENT RECEIVED EVENT' : '❌ CLIENT GOT NOTHING');
    process.exit(got > 0 ? 0 : 1);
  });
  client.on('newTripRequest', (d) => {
    console.log('[client] newTripRequest received:', JSON.stringify(d));
    client.received = client.received || [];
    client.received.push(d);
  });
});