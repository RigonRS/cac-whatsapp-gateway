// ============================================================
// CLIENTES — cache de clientes.json e casamento por telefone
// Usado para vincular a conversa ao cliente e arquivar arquivos na pasta dele.
// ============================================================
const { getClientes } = require('./graph');

let _cache = [];
let _ts = 0;
const TTL = 5 * 60 * 1000; // 5 min

// Só dígitos; devolve os últimos 8 (núcleo do número, ignorando país/DDD/nono dígito).
function chaveTelefone(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : d;
}

// jid do WhatsApp: "5554999999999@s.whatsapp.net" -> últimos 8 dígitos
function chaveDeJid(jid) {
  return chaveTelefone(String(jid || '').split('@')[0]);
}

async function atualizarCache(force = false) {
  if (!force && Date.now() - _ts < TTL && _cache.length) return _cache;
  try {
    _cache = (await getClientes()) || [];
    _ts = Date.now();
  } catch (e) {
    console.error('[clientes] erro ao ler clientes.json:', e.message);
  }
  return _cache;
}

// Devolve { id, Title, Celular } do cliente cujo Celular casa com o jid, ou null.
async function acharPorJid(jid) {
  const alvo = chaveDeJid(jid);
  if (!alvo) return null;
  const lista = await atualizarCache();
  const c = lista.find((cli) => chaveTelefone(cli.Celular) === alvo);
  return c ? { id: c.id, Title: c.Title, Celular: c.Celular } : null;
}

module.exports = { acharPorJid, atualizarCache };
