// ============================================================
// WHATSAPP (Baileys) — conexão via QR, receber/enviar mensagens,
// e arquivamento automático dos arquivos recebidos na pasta do cliente.
// ============================================================
const path = require('path');
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

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'data', 'auth');
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let sock = null;
let estado = { conectado: false, qr: null, numero: null };
let handlers = { onMessage: () => {}, onStatus: () => {} };

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

// Extrai conteúdo da mensagem: { type, body, mediaFn?, mediaName?, mime? }
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

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger, syncFullHistory: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      estado.qr = await QRCode.toDataURL(qr);
      estado.conectado = false;
      handlers.onStatus(estado);
    }
    if (connection === 'open') {
      estado.conectado = true;
      estado.qr = null;
      estado.numero = sock?.user?.id ? sock.user.id.split(':')[0] : null;
      handlers.onStatus(estado);
      console.log('[wa] conectado como', estado.numero);
    }
    if (connection === 'close') {
      estado.conectado = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      handlers.onStatus(estado);
      if (code === DisconnectReason.loggedOut) {
        console.log('[wa] deslogado — é preciso ler o QR novamente.');
        // creds inválidas: reinicia para gerar novo QR
        setTimeout(conectar, 2000);
      } else {
        console.log('[wa] conexão caiu, reconectando...');
        setTimeout(conectar, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await processarMensagem(m);
      } catch (e) {
        console.error('[wa] erro ao processar mensagem:', e.message);
      }
    }
  });
}

async function processarMensagem(m) {
  const jid = m.key.remoteJid || '';
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return; // Fase 1: só conversas 1:1
  if (!m.message) return;

  const fromMe = !!m.key.fromMe;
  const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
  const nomeContato = m.pushName || null;
  const conteudo = extrairConteudo(m);

  let savedPath = null;
  let mediaName = conteudo.mediaName || null;

  const ehMidia = ['image', 'video', 'audio', 'document', 'sticker'].includes(conteudo.type);

  // Arquiva o arquivo recebido (só de mensagens recebidas, não das nossas) na pasta do cliente.
  if (ehMidia && !fromMe) {
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (!mediaName) mediaName = nomeArquivoPadrao(conteudo.type, conteudo.mime, ts);
      const cliente = await clientes.acharPorJid(jid);
      if (cliente) {
        await graph.salvarArquivoCliente(cliente.Title, mediaName, buffer);
        savedPath = `${graph.DOCS_PATH}/${cliente.Title}/${graph.SUBPASTA_RECEBIDOS}/${mediaName}`;
        console.log(`[wa] arquivo "${mediaName}" salvo em ${cliente.Title}/${graph.SUBPASTA_RECEBIDOS}`);
      } else {
        console.log(`[wa] arquivo "${mediaName}" recebido de ${jid} sem cliente cadastrado — mantido só no histórico.`);
      }
    } catch (e) {
      console.error('[wa] falha ao baixar/arquivar mídia:', e.message);
    }
  }

  const registro = {
    id: m.key.id,
    jid,
    fromMe,
    body: conteudo.body,
    type: conteudo.type,
    mediaName,
    savedPath,
    ts,
    author: fromMe ? 'sistema' : null,
    nomeContato,
  };
  handlers.onMessage(registro);
}

async function sendText(jid, texto) {
  if (!sock || !estado.conectado) throw new Error('WhatsApp não está conectado.');
  const alvo = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  const r = await sock.sendMessage(alvo, { text: texto });
  return {
    id: r.key.id,
    jid: alvo,
    fromMe: true,
    body: texto,
    type: 'text',
    ts: Math.floor(Date.now() / 1000),
    author: 'sistema',
  };
}

function getEstado() {
  return { conectado: estado.conectado, qr: estado.qr, numero: estado.numero };
}

function initWA(h) {
  handlers = { ...handlers, ...h };
  conectar().catch((e) => console.error('[wa] erro ao conectar:', e.message));
}

module.exports = { initWA, sendText, getEstado };
