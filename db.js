// ============================================================
// BANCO DE DADOS — SQLite (histórico de conversas e mensagens)
// Fica em disco (volume persistente), então sobrevive a reinícios.
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
    last_message TEXT,
    last_ts INTEGER,
    unread INTEGER DEFAULT 0,
    assigned_to TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    jid TEXT,
    from_me INTEGER,
    body TEXT,
    type TEXT,
    media_name TEXT,
    saved_path TEXT,
    ts INTEGER,
    author TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, ts);
`);

const stmtUpsertChat = db.prepare(`
  INSERT INTO chats (jid, name, last_message, last_ts, unread)
  VALUES (@jid, @name, @last_message, @last_ts, @unread)
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    last_message = excluded.last_message,
    last_ts = excluded.last_ts,
    unread = chats.unread + excluded.unread
`);

const stmtInsertMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (id, jid, from_me, body, type, media_name, saved_path, ts, author)
  VALUES (@id, @jid, @from_me, @body, @type, @media_name, @saved_path, @ts, @author)
`);

function registrarMensagem(msg) {
  // msg: { id, jid, fromMe, body, type, mediaName, savedPath, ts, author, nomeContato }
  stmtInsertMsg.run({
    id: msg.id,
    jid: msg.jid,
    from_me: msg.fromMe ? 1 : 0,
    body: msg.body || '',
    type: msg.type || 'text',
    media_name: msg.mediaName || null,
    saved_path: msg.savedPath || null,
    ts: msg.ts,
    author: msg.author || null,
  });
  stmtUpsertChat.run({
    jid: msg.jid,
    name: msg.nomeContato || null,
    last_message: (msg.type && msg.type !== 'text') ? `[${msg.type}] ${msg.body || msg.mediaName || ''}`.trim() : (msg.body || ''),
    last_ts: msg.ts,
    unread: msg.fromMe ? 0 : 1,
  });
}

function listarChats() {
  return db.prepare(`SELECT * FROM chats ORDER BY last_ts DESC`).all();
}

function listarMensagens(jid, limite = 200) {
  return db
    .prepare(`SELECT * FROM messages WHERE jid = ? ORDER BY ts ASC LIMIT ?`)
    .all(jid, limite);
}

function marcarLido(jid) {
  db.prepare(`UPDATE chats SET unread = 0 WHERE jid = ?`).run(jid);
}

function definirAtendente(jid, atendente) {
  db.prepare(`UPDATE chats SET assigned_to = ? WHERE jid = ?`).run(atendente, jid);
}

module.exports = { registrarMensagem, listarChats, listarMensagens, marcarLido, definirAtendente };
