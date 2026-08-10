// ============================================================
// BANCO DE DADOS — SQLite (histórico de conversas e mensagens)
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cac-wa.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    last_message TEXT,
    last_ts INTEGER,
    unread INTEGER DEFAULT 0,
    assigned_to TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    jid TEXT,
    phone TEXT,
    from_me INTEGER,
    body TEXT,
    type TEXT,
    media_name TEXT,
    media_url TEXT,
    saved_path TEXT,
    ts INTEGER,
    author TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, ts);
  CREATE TABLE IF NOT EXISTS contatos (
    jid TEXT PRIMARY KEY,
    phone TEXT,
    nome TEXT
  );
`);

// Migração: adiciona colunas novas em bancos já existentes
function addCol(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
addCol('chats', 'phone', 'TEXT');
addCol('messages', 'phone', 'TEXT');
addCol('messages', 'media_url', 'TEXT');

const stmtUpsertChat = db.prepare(`
  INSERT INTO chats (jid, name, phone, last_message, last_ts, unread)
  VALUES (@jid, @name, @phone, @last_message, @last_ts, @unread)
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    phone = COALESCE(excluded.phone, chats.phone),
    last_message = excluded.last_message,
    last_ts = excluded.last_ts,
    unread = chats.unread + excluded.unread
`);

const stmtInsertMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (id, jid, phone, from_me, body, type, media_name, media_url, saved_path, ts, author)
  VALUES (@id, @jid, @phone, @from_me, @body, @type, @media_name, @media_url, @saved_path, @ts, @author)
`);

function registrarMensagem(msg) {
  stmtInsertMsg.run({
    id: msg.id,
    jid: msg.jid,
    phone: msg.phone || null,
    from_me: msg.fromMe ? 1 : 0,
    body: msg.body || '',
    type: msg.type || 'text',
    media_name: msg.mediaName || null,
    media_url: msg.mediaUrl || null,
    saved_path: msg.savedPath || null,
    ts: msg.ts,
    author: msg.author || null,
  });
  const resumo = (msg.type && msg.type !== 'text' && msg.type !== 'other')
    ? `[${msg.type}] ${msg.body || msg.mediaName || ''}`.trim()
    : (msg.body || '');
  stmtUpsertChat.run({
    jid: msg.jid,
    name: msg.nomeContato || null,
    phone: msg.phone || null,
    last_message: resumo,
    last_ts: msg.ts,
    unread: msg.fromMe ? 0 : 1,
  });
}

function listarChats() {
  return db.prepare(`SELECT * FROM chats ORDER BY last_ts DESC`).all();
}

function listarMensagens(jid, limite = 500) {
  return db.prepare(`SELECT * FROM messages WHERE jid = ? ORDER BY ts ASC LIMIT ?`).all(jid, limite);
}

function getMensagem(id) {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
}

const stmtUpsertContato = db.prepare(`
  INSERT INTO contatos (jid, phone, nome) VALUES (@jid, @phone, @nome)
  ON CONFLICT(jid) DO UPDATE SET
    phone = COALESCE(excluded.phone, contatos.phone),
    nome  = COALESCE(excluded.nome, contatos.nome)
`);
function salvarContato(jid, phone, nome) {
  if (!jid && !phone) return;
  try { stmtUpsertContato.run({ jid: jid || phone, phone: phone || null, nome: nome || null }); } catch (e) {}
}
function listarContatos() {
  return db.prepare(`SELECT jid, phone, nome FROM contatos WHERE nome IS NOT NULL AND nome != ''`).all();
}

// Zera nomes de conversa que ficaram iguais ao nome do próprio número conectado
function limparNomeDono(nome) {
  const r = db.prepare(`UPDATE chats SET name = NULL WHERE name = ?`).run(nome);
  return r.changes || 0;
}

// Busca por conteúdo das mensagens; devolve a mais recente por conversa
function buscarMensagens(termo, limite = 40) {
  const rows = db.prepare(`SELECT jid, body, ts FROM messages WHERE body LIKE ? ORDER BY ts DESC LIMIT 500`).all(`%${termo}%`);
  const vistos = new Set(); const out = [];
  for (const r of rows) { if (vistos.has(r.jid)) continue; vistos.add(r.jid); out.push(r); if (out.length >= limite) break; }
  return out;
}

function marcarLido(jid) {
  db.prepare(`UPDATE chats SET unread = 0 WHERE jid = ?`).run(jid);
}

function marcarTodosLidos() {
  db.prepare(`UPDATE chats SET unread = 0 WHERE unread > 0`).run();
}

function definirAtendente(jid, atendente) {
  db.prepare(`UPDATE chats SET assigned_to = ? WHERE jid = ?`).run(atendente, jid);
}

module.exports = { registrarMensagem, listarChats, listarMensagens, getMensagem, marcarLido, marcarTodosLidos, definirAtendente, salvarContato, listarContatos, limparNomeDono, buscarMensagens };
