// ============================================================
// AGENDADOR — dispara os relatórios automáticos no horário certo.
// Confere a cada minuto (fuso America/Sao_Paulo) e, quando bate o dia+hora
// de um relatório ativo que ainda não foi enviado hoje, monta e envia ao grupo.
// A configuração (o que/quando enviar) vem do arquivo relatorios_whatsapp.json,
// editável pela página de Configurações do sistema.
// ============================================================
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const graph = require('./graph');
const wa = require('./wa');
const rel = require('./relatorios');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ESTADO_PATH = path.join(DATA_DIR, 'relatorios-estado.json');

const TIPOS = ['processosAProtocolar', 'documentosVencendo', 'deferidosDoDia'];

// Padrões iniciais (usados enquanto o admin não salvar nada no sistema).
// dias: 0=Dom, 1=Seg, ... 6=Sáb.
const CONFIG_PADRAO = {
  grupoNome: 'P&R - Informativos de Processos',
  processosAProtocolar: { ativo: true, dias: [1, 2, 3, 4, 5], hora: '18:00' },
  documentosVencendo:   { ativo: true, dias: [1], hora: '08:00', diasAntecedencia: 21 },
  deferidosDoDia:       { ativo: true, dias: [4], hora: '19:00' },
};

// ---- Estado persistido (evita enviar o mesmo relatório duas vezes no dia) ----
function lerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function salvarEstado(e) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ESTADO_PATH, JSON.stringify(e, null, 2)); }
  catch (err) { console.error('[agendador] salvar estado:', err.message); }
}

// ---- Data/hora "agora" no fuso de Brasília ----
function agoraSP() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  const iso = `${p.year}-${p.month}-${p.day}`;
  const hhmm = `${p.hour}:${p.minute}`;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { iso, hhmm, dow };
}

// ---- Configuração (cache de 2 min para não bater no Graph a cada minuto) ----
let _cfgCache = null, _cfgCacheAt = 0;
function mesclar(base, over) {
  const out = JSON.parse(JSON.stringify(base));
  if (over && over.grupoNome) out.grupoNome = over.grupoNome;
  TIPOS.forEach(k => { if (over && over[k]) out[k] = { ...out[k], ...over[k] }; });
  return out;
}
async function carregarConfig(force) {
  if (!force && _cfgCache && (Date.now() - _cfgCacheAt < 120000)) return _cfgCache;
  let cfg = null;
  try { cfg = await graph.getConfigRelatorios(); }
  catch (e) { console.error('[agendador] ler config:', e.message); }
  // O arquivo pode vir como [] (404) — nesse caso usa só os padrões.
  cfg = mesclar(CONFIG_PADRAO, (cfg && !Array.isArray(cfg)) ? cfg : {});
  _cfgCache = cfg; _cfgCacheAt = Date.now();
  return cfg;
}

async function carregarDados() {
  const [processos, documentos, clientes, armas] = await Promise.all([
    graph.getProcessos(), graph.getDocumentos(), graph.getClientes(), graph.getArmas(),
  ]);
  return { processos, documentos, clientes, armas };
}

async function construir(tipo, cfg, hojeIso, dados) {
  dados = dados || await carregarDados();
  if (tipo === 'processosAProtocolar') return rel.relProcessosAProtocolar(dados, hojeIso);
  if (tipo === 'documentosVencendo')   return rel.relDocumentosVencendo(dados, hojeIso, cfg.documentosVencendo.diasAntecedencia);
  if (tipo === 'deferidosDoDia')       return rel.relDeferidosDoDia(dados, hojeIso);
  return null;
}

async function enviarRelatorio(tipo, cfg, hojeIso, { forcar, dados } = {}) {
  const texto = await construir(tipo, cfg, hojeIso, dados);
  if (!texto) {
    if (forcar) throw new Error('Nada a enviar: nenhum item para esse relatório hoje.');
    console.log(`[agendador] ${tipo}: nada a enviar hoje.`);
    return { enviado: false, vazio: true };
  }
  await wa.enviarParaGrupo(cfg.grupoNome, texto);
  console.log(`[agendador] ${tipo}: enviado ao grupo "${cfg.grupoNome}".`);
  return { enviado: true };
}

// ---- Verificação de minuto em minuto ----
async function tick() {
  let cfg;
  try { cfg = await carregarConfig(); } catch (e) { console.error('[agendador] tick config:', e.message); return; }
  const { iso, hhmm, dow } = agoraSP();
  const estado = lerEstado();
  for (const tipo of TIPOS) {
    const r = cfg[tipo];
    if (!r || !r.ativo) continue;
    if (!Array.isArray(r.dias) || !r.dias.includes(dow)) continue;
    // Dispara a partir do horário marcado (se o gateway estava fora do ar na hora
    // exata, recupera assim que voltar, desde que ainda seja o mesmo dia).
    if (hhmm < (r.hora || '99:99')) continue;
    if (estado[tipo] === iso) continue; // já enviado hoje
    try {
      await enviarRelatorio(tipo, cfg, iso);
    } catch (e) {
      console.error(`[agendador] erro ao enviar ${tipo}:`, e.message);
    }
    // Marca como concluído hoje mesmo quando não havia itens, para não reprocessar o dia inteiro.
    estado[tipo] = iso; salvarEstado(estado);
  }
}

function iniciar() {
  cron.schedule('* * * * *', () => { tick().catch(e => console.error('[agendador] tick:', e.message)); });
  console.log('[agendador] relatórios automáticos ativos (checagem a cada minuto, fuso America/Sao_Paulo).');
}

// ---- Usado pelos botões de teste no painel de Configurações ----
async function enviarAgora(tipo) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de relatório inválido.');
  const cfg = await carregarConfig(true);
  const { iso } = agoraSP();
  return enviarRelatorio(tipo, cfg, iso, { forcar: true });
}
// Envia os três de uma vez (teste/análise visual). Reaproveita os dados numa leitura só.
async function enviarTodosAgora() {
  const cfg = await carregarConfig(true);
  const { iso } = agoraSP();
  const dados = await carregarDados();
  const out = {};
  for (const tipo of TIPOS) {
    try { out[tipo] = await enviarRelatorio(tipo, cfg, iso, { forcar: true, dados }); }
    catch (e) { out[tipo] = { enviado: false, erro: e.message }; }
  }
  return out;
}

async function listarGruposDisponiveis() { return wa.listarGrupos(); }

module.exports = { iniciar, enviarAgora, enviarTodosAgora, carregarConfig, listarGruposDisponiveis };
