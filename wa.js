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

// ============================================================
// SAÚDE DA CONEXÃO — detecta sessão corrompida (Bad MAC / falha de
// descriptografia / init queries travado) e tenta se recuperar sozinho.
// ============================================================
const saude = {
  badMacTimestamps: [],   // horários dos erros de sessão recentes
  ultimaMsgRecebida: null,
  ultimoErroDecrypt: null,
  reconexoesAuto: [],     // horários das reconexões automáticas (janela de 30 min)
  precisaReparear: false, // true = erros persistem mesmo após reconectar -> precisa QR
  ultimaConexao: null,
};
const _RE_ERRO_SESSAO = /Bad MAC|failed to decrypt|No matching sessions|init queries|closed session/i;
function _textoLog(args) {
  try {
    return (args || []).map(a => {
      if (a == null) return '';
      if (typeof a === 'string') return a;
      if (a instanceof Error) return (a.message || '') + ' ' + (a.stack || '');
      if (a.err && a.err.message) return a.err.message;
      if (a.message) return a.message;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
  } catch (e) { return ''; }
}
function contarErroSessao(args) {
  try {
    if (_RE_ERRO_SESSAO.test(_textoLog(args))) {
      const now = Date.now();
      saude.badMacTimestamps.push(now);
      saude.ultimoErroDecrypt = now;
      if (saude.badMacTimestamps.length > 500) saude.badMacTimestamps = saude.badMacTimestamps.slice(-500);
    }
  } catch (e) {}
}
function _badMacRecentes(janelaMs) {
  const now = Date.now();
  return saude.badMacTimestamps.filter(t => now - t < janelaMs).length;
}

// Logger pino que conta os erros de sessão (para o watchdog de saúde)
const _basePino = pino({ level: process.env.LOG_LEVEL || 'warn' });
function _wrapLogger(inst) {
  const mk = (name) => (...args) => { if (name === 'error' || name === 'warn' || name === 'fatal') contarErroSessao(args); return inst[name](...args); };
  const w = {
    silent: (...a) => (inst.silent ? inst.silent(...a) : undefined),
    trace: mk('trace'), debug: mk('debug'), info: mk('info'),
    warn: mk('warn'), error: mk('error'), fatal: mk('fatal'),
    child: (b) => _wrapLogger(inst.child(b)),
  };
  Object.defineProperty(w, 'level', { get: () => inst.level, set: (v) => { try { inst.level = v; } catch (e) {} }, enumerable: true, configurable: true });
  return w;
}
const logger = _wrapLogger(_basePino);

// Também captura os "Bad MAC" que o libsignal imprime direto no console.error
const _origConsoleError = console.error.bind(console);
console.error = (...args) => { try { contarErroSessao(args); } catch (e) {} return _origConsoleError(...args); };

// Watchdog: reinicia a conexão se houver surto de erros de sessão sem receber
// mensagens; após 3 tentativas sem sucesso, marca que precisa re-parear (QR).
let _watchdogAtivo = false;
function iniciarWatchdogSaude() {
  if (_watchdogAtivo) return;
  _watchdogAtivo = true;
  setInterval(() => { try { verificarSaudeConexao(); } catch (e) {} }, 60 * 1000);
}
function verificarSaudeConexao() {
  const now = Date.now();
  saude.reconexoesAuto = saude.reconexoesAuto.filter(t => now - t < 30 * 60 * 1000);
  const recentes = _badMacRecentes(3 * 60 * 1000);
  const recebendoOk = saude.ultimaMsgRecebida && (now - saude.ultimaMsgRecebida < 3 * 60 * 1000);
  if (recentes < 15 || recebendoOk || saude.precisaReparear) return;
  if (saude.reconexoesAuto.length < 3) {
    console.log(`[wa][saude] surto de ${recentes} erros de sessao em 3min sem receber mensagens — reiniciando a conexao (tentativa ${saude.reconexoesAuto.length + 1}/3).`);
    saude.reconexoesAuto.push(now);
    saude.badMacTimestamps = [];
    try { sock && sock.end && sock.end(new Error('reinicio-automatico-saude')); } catch (e) {}
  } else {
    console.error('[wa][saude] erros de sessao persistentes apos 3 reconexoes — sessao corrompida. E NECESSARIO RE-PAREAR (desconectar + escanear o QR).');
    saude.precisaReparear = true;
  }
}
function getSaude() {
  const now = Date.now();
  return {
    precisaReparear: saude.precisaReparear,
    badMac3min: _badMacRecentes(3 * 60 * 1000),
    badMac10min: _badMacRecentes(10 * 60 * 1000),
    ultimaMsgRecebida: saude.ultimaMsgRecebida,
    minutosSemReceber: saude.ultimaMsgRecebida ? Math.round((now - saude.ultimaMsgRecebida) / 60000) : null,
    reconexoesAuto30min: saude.reconexoesAuto.length,
  };
}

let sock = null;
let estado = { conectado: false, qr: null, numero: null, sincronizando: false, syncProgress: null };
let handlers = { onMessage: () => {}, onStatus: () => {}, onRefresh: () => {}, onRead: () => {}, onReaction: () => {}, onSync: () => {} };

// ---- Controle da sincronização de histórico (barra de progresso no front) ----
let syncTimer = null;
function marcarSyncAtivo(progress) {
  estado.sincronizando = true;
  if (typeof progress === 'number') estado.syncProgress = progress;
  handlers.onSync({ sincronizando: true, progress: estado.syncProgress });
  // Segurança: se nenhum lote novo chegar em 45s, considera a sincronização concluída.
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(marcarSyncFim, 45000);
}
function marcarSyncFim() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (!estado.sincronizando) return;
  estado.sincronizando = false; estado.syncProgress = null;
  handlers.onSync({ sincronizando: false, progress: 100 });
}
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

function nomeArquivoPadrao(tipo, mime, ts, id) {
  const ext = EXT_POR_MIME[mime] || (mime && mime.split('/')[1]) || 'bin';
  const data = new Date(ts * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Sufixo único (parte do id da mensagem) para não sobrescrever quando várias
  // mídias chegam no mesmo segundo (ex.: várias imagens enviadas juntas)
  const uniq = id ? '-' + String(id).replace(/[^a-zA-Z0-9]/g, '').slice(-6) : '';
  return `${tipo}-${data}${uniq}.${ext}`;
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

// Texto legível de uma mensagem (para exibir citações/respostas)
function textoDeMensagem(message) {
  const msg = desembrulhar(message || {});
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || (msg.imageMessage ? '[imagem]' : '')
    || (msg.videoMessage ? '[vídeo]' : '')
    || (msg.audioMessage ? '[áudio]' : '')
    || (msg.documentMessage ? '[documento]' : '')
    || (msg.stickerMessage ? '[figurinha]' : '')
    || '';
}
// Serializa {key,message} com segurança (evita quebrar o salvamento se houver algo não serializável)
function rawJSON(key, message) {
  try { return JSON.stringify({ key, message }); } catch (e) { return null; }
}
// contextInfo da mensagem (traz a citação/resposta)
function getContextInfo(message) {
  const msg = message || {};
  for (const k of Object.keys(msg)) {
    if (msg[k] && typeof msg[k] === 'object' && msg[k].contextInfo) return msg[k].contextInfo;
  }
  return null;
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

// Reconexão centralizada (evita reconexões duplicadas concorrentes)
let _logoutIntencional = false;
let _reconectAgendado = false;
function agendarReconexao(ms, limpar) {
  if (_reconectAgendado) return;
  _reconectAgendado = true;
  setTimeout(() => {
    _reconectAgendado = false;
    try { sock && sock.end && sock.end(new Error('reconnect')); } catch (_) {}
    sock = null;
    if (limpar) limparAuth();
    conectar().catch((e) => console.error('[wa] reconectar:', e.message));
  }, ms);
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // syncFullHistory:false -> conexão leve e confiável (evita o "init queries timed out" que
  // corrompia a sessão e deixava o ENVIO quebrado / "Aguardando mensagem"). O histórico recente
  // ainda é sincronizado normalmente. markOnlineOnConnect:false -> número aparece offline (gateway).
  // getMessage -> quando o destinatário não consegue decodificar e pede o reenvio, o Baileys
  // busca aqui o conteúdo original (guardado no banco) e reenvia — evita "Aguardando mensagem".
  sock = makeWASocket({
    version, auth: state, printQRInTerminal: false, logger,
    syncFullHistory: false, markOnlineOnConnect: false,
    getMessage: async (key) => {
      try {
        const m = db.getMensagem(key && key.id);
        if (m && m.raw) { const p = JSON.parse(m.raw); if (p && p.message) return p.message; }
      } catch (e) {}
      return undefined;
    },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', registrarContatos);
  sock.ev.on('contacts.update', registrarContatos);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { estado.qr = await QRCode.toDataURL(qr); estado.conectado = false; handlers.onStatus(estado); }
    if (connection === 'open') {
      estado.conectado = true; estado.qr = null;
      estado.numero = sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      saude.ultimaConexao = Date.now();
      handlers.onStatus(estado);
      console.log('[wa] conectado como', estado.numero);
      // Corrige conversas cujo nome ficou com o nome do próprio número (bug antigo)
      meuNome = sock?.user?.name || sock?.user?.verifiedName || meuNome;
      if (meuNome) { try { const n = db.limparNomeDono(meuNome); if (n) console.log(`[wa] ${n} nome(s) contaminado(s) corrigido(s)`); } catch (e) {} }
    }
    if (connection === 'close') {
      estado.conectado = false;
      marcarSyncFim();
      const code = lastDisconnect?.error?.output?.statusCode;
      handlers.onStatus(estado);
      if (code === DisconnectReason.loggedOut || _logoutIntencional) {
        _logoutIntencional = false;
        console.log('[wa] deslogado — limpando sessão e gerando novo QR.');
        agendarReconexao(2000, true);
      } else {
        console.log('[wa] reconectando...');
        agendarReconexao(3000, false);
      }
    }
  });

  // Importa histórico enviado pelo WhatsApp ao conectar
  sock.ev.on('messaging-history.set', async ({ messages, contacts, progress, isLatest }) => {
    registrarContatos(contacts);
    marcarSyncAtivo(progress);
    let n = 0;
    for (const m of (messages || [])) {
      try { if (await processarMensagem(m, false)) n++; } catch (e) {}
    }
    if (n) { console.log(`[wa] histórico importado: ${n} mensagens${typeof progress === 'number' ? ` (${progress}%)` : ''}`); handlers.onRefresh(); }
    if (isLatest) marcarSyncFim();
  });

  // type 'notify' = mensagem nova; type 'append' = mensagem adicionada ao histórico,
  // normalmente enviada/recebida por OUTRO aparelho do mesmo número. Ambos precisam
  // aparecer aqui (senão "mensagens enviadas por outros dispositivos" somem).
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      try { await processarMensagem(m, true); } catch (e) { console.error('[wa] processar:', e.message); }
    }
  });

  // Conversa lida em outro aparelho/WhatsApp Web -> sincroniza como lida aqui
  const marcarLidoUpdate = (u) => {
    try {
      if (!u || !u.id) return;
      const uc = u.unreadCount;
      if (uc === 0 || uc === '0') handlers.onRead(u.id);
    } catch (e) {}
  };
  sock.ev.on('chats.update', (updates) => { for (const u of (updates || [])) marcarLidoUpdate(u); });
  sock.ev.on('chats.upsert', (chats) => { for (const u of (chats || [])) marcarLidoUpdate(u); });

  // Reações às mensagens (emoji)
  sock.ev.on('messages.reaction', (reactions) => {
    for (const r of (reactions || [])) {
      try {
        const id = r.key?.id; const jid = r.key?.remoteJid;
        if (!id) continue;
        const emoji = r.reaction?.text || '';
        db.setReacao(id, emoji);
        handlers.onReaction({ id, jid, emoji });
      } catch (e) {}
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
    // Baixa a mídia. Arquivos ENCAMINHADOS costumam falhar na 1ª tentativa
    // (o WhatsApp precisa re-hospedar a mídia original), então tentamos algumas vezes.
    let buffer = null;
    for (let tent = 1; tent <= 3 && !buffer; tent++) {
      try {
        buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      } catch (e) {
        console.error(`[wa] download mídia (tentativa ${tent}/3):`, e.message);
        if (tent < 3) await new Promise(r => setTimeout(r, 1500 * tent));
      }
    }
    if (buffer) {
      try {
        if (!mediaName) mediaName = nomeArquivoPadrao(conteudo.type, conteudo.mime, ts, m.key.id);
        mediaUrl = salvarMediaLocal(m.key.id, mediaName, buffer);
        // Só arquiva na pasta do cliente em conversas 1-a-1 (grupo não tem um único cliente).
        // Áudios não são arquivados (a pedido) — ficam só no histórico da conversa.
        if (!fromMe && !ehGrupo && phone && conteudo.type !== 'audio') {
          const cliente = await clientes.acharPorTelefone(phone);
          if (cliente) {
            await graph.salvarArquivoCliente(cliente.Title, mediaName, buffer);
            savedPath = `${graph.DOCS_PATH}/${cliente.Title}/${graph.SUBPASTA_RECEBIDOS}/${mediaName}`;
            console.log(`[wa] arquivo "${mediaName}" salvo na pasta de ${cliente.Title}`);
          } else {
            console.warn(`[wa] mídia recebida de ${phone} sem cliente correspondente — não arquivada.`);
          }
        }
      } catch (e) { console.error('[wa] arquivar mídia:', e.message); }
    } else {
      console.error(`[wa] não foi possível baixar a mídia (${conteudo.type}) da mensagem ${m.key.id}.`);
    }
  }

  // Citação/resposta a outra mensagem
  const ctx = getContextInfo(m.message);
  let replyId = null, replyBody = null;
  if (ctx && ctx.quotedMessage) {
    replyId = ctx.stanzaId || null;
    replyBody = textoDeMensagem(ctx.quotedMessage).slice(0, 140) || null;
  }

  const registro = {
    id: m.key.id, jid, phone, fromMe,
    body: conteudo.body, type: conteudo.type,
    mediaName, mediaUrl, savedPath, ts,
    author: fromMe ? 'sistema' : (ehGrupo ? pushName : null), nomeContato,
    raw: rawJSON(m.key, m.message),
    replyId, replyBody,
  };
  db.registrarMensagem(registro);
  // Recebeu/processou uma mensagem de verdade: a conexão está saudável.
  saude.ultimaMsgRecebida = Date.now();
  if (saude.precisaReparear) saude.precisaReparear = false;
  if (live) handlers.onMessage(registro);
  return true;
}

async function sendText(jid, texto, quoted) {
  if (!sock || !estado.conectado) throw new Error('WhatsApp não está conectado.');
  const alvo = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  const opts = quoted ? { quoted } : {};
  const r = await sock.sendMessage(alvo, { text: texto }, opts);
  return { id: r.key.id, jid: alvo, phone: alvo.endsWith('@s.whatsapp.net') ? alvo.split('@')[0] : null, fromMe: true, body: texto, type: 'text', ts: Math.floor(Date.now() / 1000), author: 'sistema', raw: rawJSON(r.key, r.message) };
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
  return { id: r.key.id, jid: alvo, phone: alvo.endsWith('@s.whatsapp.net') ? alvo.split('@')[0] : null, fromMe: true, body: caption || '', type: tipo, mediaName: filename, mediaUrl, ts: Math.floor(Date.now() / 1000), author: 'sistema', raw: rawJSON(r.key, r.message) };
}

// Desconecta o número (desloga a sessão). O WhatsApp volta a pedir um novo QR.
// NÃO depende do sock.logout() concluir — a sessão pode estar travada/corrompida.
async function logout() {
  estado.conectado = false; estado.numero = null; estado.qr = null;
  saude.precisaReparear = false; saude.badMacTimestamps = []; saude.reconexoesAuto = [];
  handlers.onStatus(estado);
  _logoutIntencional = true;
  // Tenta deslogar direito (fire-and-forget, com timeout implícito pela rede de segurança abaixo)
  try { if (sock && sock.logout) sock.logout().catch(() => {}); } catch (e) {}
  // Rede de segurança: limpa as credenciais e reconecta em ~1,5s, gerando um QR novo,
  // mesmo que o logout normal trave por causa da sessão corrompida.
  agendarReconexao(1500, true);
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

function getEstado() { return { conectado: estado.conectado, qr: estado.qr, numero: estado.numero, sincronizando: estado.sincronizando, syncProgress: estado.syncProgress }; }

function initWA(h) {
  handlers = { ...handlers, ...h };
  carregarContatosSalvos();
  iniciarWatchdogSaude();
  conectar().catch((e) => console.error('[wa] erro ao conectar:', e.message));
}

module.exports = { initWA, sendText, sendMedia, forward, avatarUrl, getEstado, getSaude, logout };
