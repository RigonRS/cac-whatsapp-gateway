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
let handlers = { onMessage: () => {}, onStatus: () => {}, onRefresh: () => {}, onRead: () => {} };
let meuNome = null;   // nome do próprio número conectado (para não usá-lo como nome de contato)

// Mapa LID (identificador de privacidade) -> telefone real, montado a partir dos contatos
const LID_PN = {};
// Nomes dos contatos (o que está salvo na agenda / pushName), por jid e por telefone (8 dígitos)
const NOMES = {};
function guardarNome(chave, nome) {
  if (chave && nome && !NOMES[chave]) NOMES[chave] = nome;
}
function registrarContatos(arr) {
  for (const c of (arr || [])) {
    try {
      const id = String(c.id || '');
      const lid = String(c.lid || '');
      if (lid.endsWith('@lid') && id.endsWith('@s.whatsapp.net')) LID_PN[lid] = id.split('@')[0].replace(/\D/g, '');
      if (id.endsWith('@lid') && String(c.jid || '').endsWith('@s.whatsapp.net')) LID_PN[id] = String(c.jid).split('@')[0].replace(/\D/g, '');
      // Nome salvo do contato (prioriza o nome da agenda, depois o pushName/verificado)
      const nome = c.name || c.notify || c.verifiedName || null;
      const phone = id.endsWith('@s.whatsapp.net') ? id.split('@')[0].replace(/\D/g, '') : (LID_PN[id] || null);
      if (nome) {
        guardarNome(id, nome);
        const dig = (phone || id.split('@')[0]).replace(/\D/g, '');
        if (dig.length >= 8) guardarNome(dig.slice(-8), nome);
        db.salvarContato(id, phone, nome);   // persiste no banco (sobrevive a reinícios)
      }
    } catch (e) {}
  }
}
// Carrega os contatos já salvos no banco para a memória (nomes por jid e telefone)
function carregarContatosSalvos() {
  try {
    for (const c of db.listarContatos()) {
      if (c.jid) guardarNome(c.jid, c.nome);
      const dig = String(c.phone || c.jid || '').replace(/\D/g, '');
      if (dig.length >= 8) guardarNome(dig.slice(-8), c.nome);
    }
  } catch (e) {}
}
// Descobre o melhor nome conhecido para um contato (agenda/pushName), por jid ou telefone
function nomeSalvo(jid, phone) {
  if (NOMES[jid]) return NOMES[jid];
  const dig = String(phone || jid || '').replace(/\D/g, '');
  if (dig.length >= 8 && NOMES[dig.slice(-8)]) return NOMES[dig.slice(-8)];
  return null;
}
function phoneDoLid(jid) {
  if (LID_PN[jid]) return LID_PN[jid];
  try { const m = sock?.signalRepository?.lidMapping; if (m?.getPNForLIDSync) { const pn = m.getPNForLIDSync(jid); if (pn) return String(pn).split('@')[0].replace(/\D/g, ''); } } catch (e) {}
  return null;
}

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

// Desembrulha mensagens aninhadas (efêmeras, ver-uma-vez, documento-com-legenda, editadas)
function desembrulhar(message) {
  let msg = message || {};
  for (let i = 0; i < 5; i++) {
    if (msg.ephemeralMessage?.message) { msg = msg.ephemeralMessage.message; continue; }
    if (msg.viewOnceMessage?.message) { msg = msg.viewOnceMessage.message; continue; }
    if (msg.viewOnceMessageV2?.message) { msg = msg.viewOnceMessageV2.message; continue; }
    if (msg.viewOnceMessageV2Extension?.message) { msg = msg.viewOnceMessageV2Extension.message; continue; }
    if (msg.documentWithCaptionMessage?.message) { msg = msg.documentWithCaptionMessage.message; continue; }
    if (msg.editedMessage?.message) { msg = msg.editedMessage.message; continue; }
    break;
  }
  return msg;
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
    const mapped = phoneDoLid(jid);
    if (mapped) return mapped;
    try {
      const map = sock?.signalRepository?.lidMapping;
      if (map?.getPNForLID) { const pn = await map.getPNForLID(jid); if (pn) return String(pn).split('@')[0].replace(/\D/g, ''); }
    } catch (e) {}
  }
  return null;
}

// Cache de nomes de grupos (assunto/subject do grupo)
const GRUPOS = {};
async function nomeGrupo(jid) {
  if (GRUPOS[jid]) return GRUPOS[jid];
  try { const md = await sock.groupMetadata(jid); if (md?.subject) { GRUPOS[jid] = md.subject; return md.subject; } } catch (e) {}
  return null;
}

// Apaga as credenciais salvas (usado ao deslogar, para gerar um QR novo do zero)
function limparAuth() {
  try { for (const f of fs.readdirSync(AUTH_DIR)) fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true }); }
  catch (e) {}
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger, syncFullHistory: true });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', registrarContatos);
  sock.ev.on('contacts.update', registrarContatos);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { estado.qr = await QRCode.toDataURL(qr); estado.conectado = false; handlers.onStatus(estado); }
    if (connection === 'open') {
      estado.conectado = true; estado.qr = null;
      estado.numero = sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      handlers.onStatus(estado);
      console.log('[wa] conectado como', estado.numero);
      // Corrige conversas cujo nome ficou com o nome do próprio número (bug antigo)
      meuNome = sock?.user?.name || sock?.user?.verifiedName || meuNome;
      if (meuNome) { try { const n = db.limparNomeDono(meuNome); if (n) console.log(`[wa] ${n} nome(s) contaminado(s) corrigido(s)`); } catch (e) {} }
    }
    if (connection === 'close') {
      estado.conectado = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      handlers.onStatus(estado);
      if (code === DisconnectReason.loggedOut) { console.log('[wa] deslogado — limpando sessão e gerando novo QR.'); limparAuth(); sock = null; setTimeout(conectar, 2000); }
      else { console.log('[wa] reconectando...'); setTimeout(conectar, 3000); }
    }
  });

  // Importa histórico enviado pelo WhatsApp ao conectar
  sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
    registrarContatos(contacts);
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

  // Conversa lida em outro aparelho/WhatsApp Web -> sincroniza como lida aqui
  sock.ev.on('chats.update', (updates) => {
    for (const u of (updates || [])) {
      try { if (u.id && u.unreadCount === 0) handlers.onRead(u.id); } catch (e) {}
    }
  });
}

// Processa uma mensagem. live=true: baixa mídia, arquiva e emite em tempo real.
// live=false: só grava (usado na importação de histórico). Retorna true se gravou.
async function processarMensagem(m, live = true) {
  const jid = m.key.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return false;
  if (!m.message) return false;
  m.message = desembrulhar(m.message);   // trata documento-com-legenda, efêmeras, etc.
  const ehGrupo = jid.endsWith('@g.us');

  const fromMe = !!m.key.fromMe;
  const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
  const pushName = m.pushName || null;
  const conteudo = extrairConteudo(m);
  if (conteudo.type === 'other') return false;
  const phone = ehGrupo ? null : await resolverPhone(jid, m);
  // Em conversa 1-a-1, o pushName de uma mensagem NOSSA é o nome do próprio número.
  // Aprende esse nome e limpa conversas que ficaram com ele (correção do bug antigo).
  if (fromMe && !ehGrupo && pushName && pushName !== meuNome) {
    meuNome = pushName;
    try { const n = db.limparNomeDono(meuNome); if (n) console.log(`[wa] ${n} nome(s) contaminado(s) corrigido(s)`); } catch (e) {}
  }
  // Guarda o pushName para reaproveitar em mensagens futuras deste contato
  if (pushName && !fromMe) { guardarNome(jid, pushName); if (phone) guardarNome(phone.slice(-8), pushName); }
  // Em grupo, o "contato" da conversa é o próprio grupo; quem enviou vai no campo author.
  // Em mensagens enviadas por nós (fromMe), o pushName é o NOSSO nome — nunca usar como nome do contato.
  const nomeContato = ehGrupo
    ? await nomeGrupo(jid)
    : (fromMe ? nomeSalvo(jid, phone) : (pushName || nomeSalvo(jid, phone)));

  let savedPath = null, mediaName = conteudo.mediaName || null, mediaUrl = null;
  const ehMidia = ['image', 'video', 'audio', 'document', 'sticker'].includes(conteudo.type);

  if (ehMidia && live) {
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (!mediaName) mediaName = nomeArquivoPadrao(conteudo.type, conteudo.mime, ts);
      mediaUrl = salvarMediaLocal(m.key.id, mediaName, buffer);
      // Só arquiva na pasta do cliente em conversas 1-a-1 (grupo não tem um único cliente).
      // Áudios não são arquivados (a pedido) — ficam só no histórico da conversa.
      if (!fromMe && !ehGrupo && phone && conteudo.type !== 'audio') {
        const cliente = await clientes.acharPorTelefone(phone);
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
    author: fromMe ? 'sistema' : (ehGrupo ? pushName : null), nomeContato,
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

// Desconecta o número (desloga a sessão). O WhatsApp volta a pedir um novo QR.
async function logout() {
  estado.conectado = false; estado.numero = null; estado.qr = null;
  handlers.onStatus(estado);
  try {
    if (sock) await sock.logout();          // dispara connection.close(loggedOut) -> limpa sessão e gera QR novo
    else { limparAuth(); setTimeout(conectar, 1000); }
  } catch (e) {
    console.error('[wa] logout:', e.message);
    limparAuth();                           // fallback: limpa e reconecta manualmente
    try { sock?.end?.(new Error('logout')); } catch (_) {}
    sock = null;
    setTimeout(conectar, 1500);
  }
  return true;
}

// Encaminha uma mensagem já registrada (texto ou mídia) para outro contato
const MIME_POR_TIPO = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg', sticker: 'image/webp' };
async function forward(toJid, msg) {
  const tipo = msg.type || 'text';
  if (tipo === 'text' || tipo === 'other' || !msg.media_url) {
    return sendText(toJid, msg.body || '');
  }
  const stored = String(msg.media_url).replace('/media/', '');
  const buffer = fs.readFileSync(path.join(MEDIA_DIR, stored));
  const ext = (msg.media_name || '').split('.').pop().toLowerCase();
  const mime = MIME_POR_TIPO[tipo]
    || Object.keys(EXT_POR_MIME).find(k => EXT_POR_MIME[k] === ext)
    || 'application/octet-stream';
  return sendMedia(toJid, msg.media_name || 'arquivo', mime, buffer, msg.body || undefined);
}

async function avatarUrl(jid) {
  if (!sock) return null;
  let alvo = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  try { const u = await sock.profilePictureUrl(alvo, 'image'); if (u) return u; } catch (e) {}
  // Se for @lid, tenta pelo telefone real
  if (String(jid).endsWith('@lid')) {
    const pn = phoneDoLid(jid);
    if (pn) { try { return await sock.profilePictureUrl(`${pn}@s.whatsapp.net`, 'image'); } catch (e) {} }
  }
  return null;
}

function getEstado() { return { conectado: estado.conectado, qr: estado.qr, numero: estado.numero }; }

function initWA(h) {
  handlers = { ...handlers, ...h };
  carregarContatosSalvos();
  conectar().catch((e) => console.error('[wa] erro ao conectar:', e.message));
}

module.exports = { initWA, sendText, sendMedia, forward, avatarUrl, getEstado, logout };
