// ============================================================
// SERVIDOR — API HTTP + tempo real (Socket.IO) da central de WhatsApp.
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { requireAuth, verifyIdToken, nomeAtendente } = require('./auth');
const db = require('./db');
const wa = require('./wa');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FRONT_ORIGIN = (process.env.FRONT_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const corsOrigin = FRONT_ORIGIN.length ? FRONT_ORIGIN : true;

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(cors({ origin: corsOrigin }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

// ---- Autenticação do Socket.IO (mesmo id_token do CAC Gestão) ----
io.use(async (socket, next) => {
  try {
    const decoded = await verifyIdToken(socket.handshake.auth?.token);
    socket.atendente = nomeAtendente(decoded);
    next();
  } catch (e) { next(new Error('Não autorizado')); }
});

io.on('connection', (socket) => {
  console.log('[io] atendente conectado:', socket.atendente);
  socket.emit('status', wa.getEstado());
});

// ---- Arquivos de mídia (fotos/documentos) servidos para o front ----
app.use('/media', cors({ origin: corsOrigin }), express.static(path.join(DATA_DIR, 'media')));

// ---- Rotas ----
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

app.post('/logout', requireAuth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Apenas administradores podem desconectar o número.' });
  try { await wa.logout(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/read-all', requireAuth, (req, res) => { db.marcarTodosLidos(); res.json({ ok: true }); });

app.get('/chats', requireAuth, (req, res) => res.json({ chats: db.listarChats() }));

app.get('/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ resultados: [] });
  res.json({ resultados: db.buscarMensagens(q) });
});

app.get('/contatos', requireAuth, (req, res) => {
  const arr = db.listarContatos().map(c => {
    let phone = c.phone;
    if (!phone && String(c.jid || '').endsWith('@s.whatsapp.net')) phone = String(c.jid).split('@')[0].replace(/\D/g, '');
    return { phone: phone || null, nome: c.nome };
  }).filter(c => c.phone);
  res.json({ contatos: arr });
});

app.get('/messages', requireAuth, (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid é obrigatório' });
  db.marcarLido(jid);
  res.json({ messages: db.listarMensagens(jid) });
});

app.get('/avatar', requireAuth, async (req, res) => {
  try { res.json({ url: await wa.avatarUrl(req.query.jid) }); }
  catch (e) { res.json({ url: null }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/send-media', requireAuth, async (req, res) => {
  try {
    const { jid, filename, mimetype, dataBase64, caption } = req.body || {};
    if (!jid || !dataBase64) return res.status(400).json({ error: 'jid e arquivo são obrigatórios' });
    const buffer = Buffer.from(dataBase64, 'base64');
    const enviado = await wa.sendMedia(jid, filename || 'arquivo', mimetype || 'application/octet-stream', buffer, caption);
    enviado.author = req.atendente;
    db.registrarMensagem({ ...enviado, nomeContato: null });
    io.emit('message', enviado);
    res.json({ ok: true, message: enviado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/forward', requireAuth, async (req, res) => {
  try {
    const { toJid, messageId } = req.body || {};
    if (!toJid || !messageId) return res.status(400).json({ error: 'toJid e messageId são obrigatórios' });
    const msg = db.getMensagem(messageId);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    const enviado = await wa.forward(toJid, msg);
    enviado.author = req.atendente;
    db.registrarMensagem({ ...enviado, nomeContato: null });
    io.emit('message', enviado);
    res.json({ ok: true, message: enviado });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  onMessage: (registro) => { db.registrarMensagem(registro); io.emit('message', registro); },
  onStatus: (estado) => io.emit('status', { conectado: estado.conectado, qr: estado.qr, numero: estado.numero }),
  onRefresh: () => io.emit('refresh'),
});

server.listen(PORT, () => console.log(`[server] ouvindo na porta ${PORT}`));
