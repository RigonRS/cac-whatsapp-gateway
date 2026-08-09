// ============================================================
// CLIENTES — cache de clientes.json e casamento por telefone
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

// Aceita telefone (dígitos) ou jid ("5554...@s.whatsapp.net")
function chaveDe(v) {
  const s = String(v || '');
  const num = s.includes('@') ? s.split('@')[0] : s;
  return chaveTelefone(num);
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

// Devolve { id, Title, Celular } do cliente cujo Celular casa, ou null.
async function acharPorTelefone(v) {
  const alvo = chaveDe(v);
  if (!alvo || alvo.length < 8) return null;
  const lista = await atualizarCache();
  const c = lista.find((cli) => chaveTelefone(cli.Celular) === alvo);
  return c ? { id: c.id, Title: c.Title, Celular: c.Celular } : null;
}

module.exports = { acharPorTelefone, atualizarCache };
