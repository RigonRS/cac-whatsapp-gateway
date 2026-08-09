// ============================================================
// WHATSAPP (Baileys) — conexão via QR, receber/enviar (texto e mídia),
// foto de perfil, importação de histórico e arquivamento na pasta do cliente.
// ============================================================
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const clientes = require('./clientes');
const graph = require('./graph');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let sock = null;
let estado = { conectado: false, qr: null, numero: null };
let handlers = { onMessage: () => {}, onStatus: () => {}, onRefresh: () => {} };

const EXT_POR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'video/mp4': 'mp4', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function nomeArquivoPadrao(tipo, mime, ts) {
  const ext = EXT_POR_MIME[mime] || (mime && mime.split('/')[1]) || 'bin';
  const data = new Date(ts * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${tipo}-${data}.${ext}`;
}

function salvarMediaLocal(id, filename, buffer) {
  const safe = String(filename || 'arquivo').replace(/[^\w.\-]/g, '_');
  const stored = `${String(id).replace(/[^\w.\-]/g, '_')}-${safe}`.slice(-140);
  fs.writeFileSync(path.join(MEDIA_DIR, stored), buffer);
  return `/media/${stored}`;
}

function extrairConteudo(m) {
  const msg = m.message || {};
  if (msg.conversation) return { type: 'text', body: msg.conversation };
  if (msg.extendedTextMessage) return { type: 'text', body: msg.extendedTextMessage.text || '' };
  if (msg.imageMessage) return { type: 'image', body: msg.imageMessage.caption || '', mime: msg.imageMessage.mimetype };
  if (msg.videoMessage) return { type: 'video', body: msg.videoMessage.caption || '', mime: msg.videoMessage.mimetype };
  if (msg.audioMessage) return { type: 'audio', body: '', mime: msg.audioMessage.mimetype };
  if (msg.documentMessage)
    return { type: 'document', body: msg.documentMessage.caption || '', mime: msg.documentMessage.mimetype, mediaName: msg.documentMessage.fileName };
  if (msg.stickerMessage) return { type: 'sticker', body: '', mime: msg.stickerMessage.mimetype };
  return { type: 'other', body: '' };
}

// Descobre o telefone real. Para jid @lid (privacidade), tenta o número alternativo.
async function resolverPhone(jid, m) {
  if (jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0].replace(/\D/g, '');
  if (jid.endsWith('@lid')) {
    const alt = m.key?.senderPn || m.key?.participantPn || m.key?.remoteJidAlt || null;
    if (alt) return String(alt).split('@')[0].replace(/\D/g, '');
    try {
      const map = sock?.signalRepository?.lidMapping;
      if (map?.getPNForLID) { const pn = await map.getPNForLID(jid); if (pn) return String(pn).split('@')[0].replace(/\D/g, ''); }
    } catch (e) {}
  }
  return null;
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger, syncFullHistory: true });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { estado.qr = await QRCode.toDataURL(qr); estado.conectado = false; handlers.onStatus(estado); }
    if (connection === 'open') {
      estado.conectado = true; estado.qr = null;
      estado.numero = sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      handlers.onStatus(estado);
      console.log('[wa] conectado como', estado.numero);
    }
    if (connection === 'close') {
      estado.conectado = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      handlers.onStatus(estado);
      if (code === DisconnectReason.loggedOut) { console.log('[wa] deslogado — novo QR.'); setTimeout(conectar, 2000); }
      else { console.log('[wa] reconectando...'); setTimeout(conectar, 3000); }
    }
  });

  // Importa histórico enviado pelo WhatsApp ao conectar
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    let n = 0;
    for (const m of (messages || [])) {
      try { if (await processarMensagem(m, false)) n++; } catch (e) {}
    }
    if (n) { console.log(`[wa] histórico importado: ${n} mensagens`); handlers.onRefresh(); }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try { await processarMensagem(m, true); } catch (e) { console.error('[wa] processar:', e.message); }
    }
  });
}

// Processa uma mensagem. live=true: baixa mídia, arquiva e emite em tempo real.
// live=false: só grava (usado na importação de histórico). Retorna true se gravou.
async function processarMensagem(m, live = true) {
  const jid = m.key.remoteJid || '';
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return false;
  if (!m.message) return false;

  const fromMe = !!m.key.fromMe;
  const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
  const nomeContato = m.pushName || null;
  const conteudo = extrairConteudo(m);
  if (conteudo.type === 'other') return false;
  const phone = await resolverPhone(jid, m);

  let savedPath = null, mediaName = conteudo.mediaName || null, mediaUrl = null;
  const ehMidia = ['image', 'video', 'audio', 'document', 'sticker'].includes(conteudo.type);

  if (ehMidia && live) {
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (!mediaName) mediaName = nomeArquivoPadrao(conteudo.type, conteudo.mime, ts);
      mediaUrl = salvarMediaLocal(m.key.id, mediaName, buffer);
      if (!fromMe) {
        const cliente = await clientes.acharPorTelefone(phone || jid);
        if (cliente) {
          await graph.salvarArquivoCliente(cliente.Title, mediaName, buffer);
          savedPath = `${graph.DOCS_PATH}/${cliente.Title}/${graph.SUBPASTA_RECEBIDOS}/${mediaName}`;
          console.log(`[wa] arquivo "${mediaName}" salvo na pasta de ${cliente.Title}`);
        }
      }
    } catch (e) { console.error('[wa] mídia:', e.message); }
  }

  const registro = {
    id: m.key.id, jid, phone, fromMe,
    body: conteudo.body, type: conteudo.type,
    mediaName, mediaUrl, savedPath, ts,
    author: fromMe ? 'sistema' : null, nomeContato,
  };
  db.registrarMensagem(registro);
  if (live) handlers.onMessage(registro);
  return true;
}

async function sendText(jid, texto) {
  if (!sock || !estado.conectado) throw new Error('WhatsApp não está conectado.');
  const alvo = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  const r = await sock.sendMessage(alvo, { text: texto });
  return { id: r.key.id, jid: alvo, phone: alvo.endsWith('@s.whatsapp.net') ? alvo.split('@')[0] : null, fromMe: true, body: texto, type: 'text', ts: Math.floor(Date.now() / 1000), author: 'sistema' };
}

async function sendMedia(jid, filename, mimetype, buffer, caption) {
  if (!sock || !estado.conectado) throw new Error('WhatsApp não está conectado.');
  const alvo = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  const mt = mimetype || 'application/octet-stream';
  let content, tipo;
  if (mt.startsWith('image/')) { content = { image: buffer, caption: caption || undefined, mimetype: mt }; tipo = 'image'; }
  else if (mt.startsWith('video/')) { content = { video: buffer, caption: caption || undefined, mimetype: mt }; tipo = 'video'; }
  else if (mt.startsWith('audio/')) { content = { audio: buffer, mimetype: mt }; tipo = 'audio'; }
  else { content = { document: buffer, fileName: filename, mimetype: mt, caption: caption || undefined }; tipo = 'document'; }
  const r = await sock.sendMessage(alvo, content);
  const mediaUrl = salvarMediaLocal(r.key.id, filename, buffer);
  return { id: r.key.id, jid: alvo, phone: alvo.endsWith('@s.whatsapp.net') ? alvo.split('@')[0] : null, fromMe: true, body: caption || '', type: tipo, mediaName: filename, mediaUrl, ts: Math.floor(Date.now() / 1000), author: 'sistema' };
}

async function avatarUrl(jid) {
  if (!sock) return null;
  const alvo = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  try { return await sock.profilePictureUrl(alvo, 'image'); } catch (e) { return null; }
}

function getEstado() { return { conectado: estado.conectado, qr: estado.qr, numero: estado.numero }; }

function initWA(h) {
  handlers = { ...handlers, ...h };
  conectar().catch((e) => console.error('[wa] erro ao conectar:', e.message));
}

module.exports = { initWA, sendText, sendMedia, avatarUrl, getEstado };
