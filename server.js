// ============================================================
// SERVIDOR — API HTTP + tempo real (Socket.IO) da central de WhatsApp.
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { requireAuth, verifyIdToken, nomeAtendente } = require('./auth');
const db = require('./db');
const wa = require('./wa');

const PORT = process.env.PORT || 3000;
const FRONT_ORIGIN = (process.env.FRONT_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: FRONT_ORIGIN.length ? FRONT_ORIGIN : true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: FRONT_ORIGIN.length ? FRONT_ORIGIN : true } });

// ---- Autenticação do Socket.IO (mesmo id_token do CAC Gestão) ----
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const decoded = await verifyIdToken(token);
    socket.atendente = nomeAtendente(decoded);
    next();
  } catch (e) {
    next(new Error('Não autorizado'));
  }
});

io.on('connection', (socket) => {
  console.log('[io] atendente conectado:', socket.atendente);
  socket.emit('status', wa.getEstado());
});

// ---- Rotas HTTP ----
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/status', requireAuth, (req, res) => {
  const e = wa.getEstado();
  res.json({ conectado: e.conectado, numero: e.numero });
});

app.get('/qr', requireAuth, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Apenas administradores podem parear o número.' });
  const e = wa.getEstado();
  res.json({ conectado: e.conectado, qr: e.qr });
});

app.get('/chats', requireAuth, (req, res) => {
  res.json({ chats: db.listarChats() });
});

app.get('/messages', requireAuth, (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid é obrigatório' });
  db.marcarLido(jid);
  res.json({ messages: db.listarMensagens(jid) });
});

app.post('/send', requireAuth, async (req, res) => {
  try {
    const { jid, text } = req.body || {};
    if (!jid || !text) return res.status(400).json({ error: 'jid e text são obrigatórios' });
    const enviado = await wa.sendText(jid, text);
    enviado.author = req.atendente;
    db.registrarMensagem({ ...enviado, nomeContato: null });
    io.emit('message', enviado);
    res.json({ ok: true, message: enviado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/assign', requireAuth, (req, res) => {
  const { jid } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'jid é obrigatório' });
  db.definirAtendente(jid, req.atendente);
  io.emit('assigned', { jid, atendente: req.atendente });
  res.json({ ok: true });
});

// ---- WhatsApp: liga os eventos ao banco e ao tempo real ----
wa.initWA({
  onMessage: (registro) => {
    db.registrarMensagem(registro);
    io.emit('message', registro);
  },
  onStatus: (estado) => {
    io.emit('status', { conectado: estado.conectado, qr: estado.qr, numero: estado.numero });
  },
});

server.listen(PORT, () => console.log(`[server] ouvindo na porta ${PORT}`));
