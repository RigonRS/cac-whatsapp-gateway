// ============================================================
// RELATÓRIOS AUTOMÁTICOS — monta os textos enviados ao grupo de WhatsApp.
// Reproduz a mesma lógica do sistema (app.js) lendo os mesmos arquivos JSON.
// ============================================================

// Status que contam como "a protocolar" (igual ao app.js)
const STATUS_A_PROTOCOLAR = [
  'Parado', 'Aguardando Documentos', 'Aguardando Pagamento GRU',
  'Aguardando Assinatura', 'Aguardando Protocolo (email)', 'Restituído',
];

// ---- Helpers de data ----
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('T')[0].split('-');
  return `${d}/${m}/${y}`;
}
function brParaIso(br) {
  if (!br) return '';
  const p = String(br).split('/');
  if (p.length !== 3) return '';
  return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
}
function daysBetween(iso, hojeIso) {
  if (!iso) return null;
  const a = new Date(String(iso).split('T')[0] + 'T00:00:00Z');
  const b = new Date(hojeIso + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}

// ---- Helpers de processo (espelham o app.js) ----
function histArray(p) {
  try { const h = JSON.parse((p && p.HistoricoStatus) || '[]'); return Array.isArray(h) ? h : []; }
  catch (e) { return []; }
}
function processoTemProtocolo(p) {
  if (p && p.NumeroProtocolo && String(p.NumeroProtocolo).trim()) return true;
  return histArray(p).some(h => /Protocolo no Sistema/i.test((h && h.status) || ''));
}
// Movimentação mais recente do histórico: maior data+hora; empate => a última na ordem.
function ultimaMovimentacao(p) {
  const h = histArray(p);
  if (!h.length) return { iso: '', br: '', status: '' };
  let best = null, bestKey = '';
  h.forEach((e, i) => {
    const iso = brParaIso(e.data || '');
    const key = (iso || '0000-00-00') + ' ' + (e.hora || '00:00') + ' ' + String(i).padStart(4, '0');
    if (!best || key > bestKey) { best = e; bestKey = key; }
  });
  const iso = brParaIso(best.data || '');
  return { iso, br: best.data || (iso ? fmtDate(iso) : ''), status: best.status || '' };
}
function getDataDeferido(p) {
  const entry = [...histArray(p)].reverse().find(x => x.status === 'Deferido');
  if (entry && entry.data) { const iso = brParaIso(entry.data); if (iso) return iso; }
  if (p.DataDeferimento) return String(p.DataDeferimento).split('T')[0];
  return null;
}
// Tempo decorrido do protocolo até o deferimento (ou hoje). Ex.: "15D" ou "3M + 05D".
function tempoDecorrido(p, hojeIso) {
  const ini = p.DataProtocoloSistema ? String(p.DataProtocoloSistema).split('T')[0] : '';
  if (!ini) return '—';
  const fim = getDataDeferido(p) || hojeIso;
  let dias = Math.floor((new Date(fim + 'T00:00:00Z') - new Date(ini + 'T00:00:00Z')) / 86400000);
  if (!Number.isFinite(dias)) return '—';
  if (dias < 0) dias = 0;
  if (dias <= 30) return `${dias}D`;
  const meses = Math.floor(dias / 30), rest = dias % 30;
  return `${meses}M + ${String(rest).padStart(2, '0')}D`;
}

// ---- Helpers de documento (espelham o app.js) ----
function guiaDesconsiderada(d) {
  return d && d.TipoDocumento === 'Guia de Tráfego' && d.Desconsiderada === 'sim';
}
function descricaoDocVenc(d, armaMap) {
  const arma = armaMap[String(d.ArmaVinculadaId)] || null;
  const marcaModelo = arma ? `${arma.Marca || ''} ${arma.Modelo || ''}`.trim() : String(d.ArmaVinculadaDesc || '').trim();
  const venc = d.DataValidade ? fmtDate(String(d.DataValidade).split('T')[0]) : '';
  if (d.TipoDocumento === 'Guia de Tráfego') {
    const tg = d.TipoGuia || '';
    let local = '';
    if (tg === 'Tiro Esportivo' || tg === 'Caça-Treinamento Tiro') local = d.NomeClubeTiro || '';
    else if (tg === 'Caça') local = [d.CidadeGuia, d.UFGuia].filter(Boolean).join('/');
    const endOrigem = d.EnderecoGuia || '';
    const partes = ['GT', tg, marcaModelo, local, endOrigem ? `End. Origem ${endOrigem}` : ''].filter(Boolean);
    return partes.join(' - ') + (venc ? ` (vence em ${venc})` : '');
  }
  if (d.TipoDocumento === 'CRAF') {
    return ['CRAF', marcaModelo].filter(Boolean).join(' - ') + (venc ? ` (vence em ${venc})` : '');
  }
  return [d.TipoDocumento || 'Documento', marcaModelo].filter(Boolean).join(' - ') + (venc ? ` (vence em ${venc})` : '');
}

// ---- Mapas auxiliares ----
function mapaPorId(arr) {
  const m = {};
  (arr || []).forEach(x => { m[String(x.id)] = x; });
  return m;
}
const nomeCliente = (cMap, id) => (cMap[String(id)] && cMap[String(id)].Title) || 'Cliente';

// ============================================================
// RELATÓRIO 1 — Processos a protocolar, agrupados por operador (Seg–Sex 18h)
// ============================================================
function relProcessosAProtocolar(dados, hojeIso) {
  const { processos, clientes } = dados;
  const cMap = mapaPorId(clientes);
  const lista = (processos || []).filter(p => STATUS_A_PROTOCOLAR.includes(p.Status) && !processoTemProtocolo(p));
  if (!lista.length) return null;

  // operador -> clienteId -> tipoProcesso -> { qtd, mov, status }
  const porOp = {};
  lista.forEach(p => {
    const op = ((p.Responsavel || '').trim()) || 'Sem operador definido';
    const cid = String(p.ClienteId || '');
    const tipo = p.TipoProcesso || 'Processo';
    porOp[op] = porOp[op] || {};
    porOp[op][cid] = porOp[op][cid] || {};
    const slot = porOp[op][cid][tipo] = porOp[op][cid][tipo] || { qtd: 0, mov: { iso: '', br: '' }, status: '' };
    slot.qtd++;
    const mov = ultimaMovimentacao(p);
    // Quando há mais de um processo do mesmo tipo, mantém a movimentação mais recente.
    if (!slot.mov.iso || (mov.iso && mov.iso > slot.mov.iso)) { slot.mov = mov; slot.status = p.Status || ''; }
    if (!slot.status) slot.status = p.Status || '';
  });

  const linhas = [`📋 *PROCESSOS A PROTOCOLAR* — ${fmtDate(hojeIso)}`, ''];
  Object.keys(porOp).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(op => {
    linhas.push(`👤 *${op}*`);
    const clientesOp = porOp[op];
    Object.keys(clientesOp)
      .sort((a, b) => nomeCliente(cMap, a).localeCompare(nomeCliente(cMap, b), 'pt-BR'))
      .forEach(cid => {
        linhas.push(`  • *${nomeCliente(cMap, cid)}*`);
        const tipos = clientesOp[cid];
        Object.keys(tipos).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(tipo => {
          const s = tipos[tipo];
          const qtd = s.qtd > 1 ? ` (x${s.qtd})` : '';
          const mov = s.mov.iso ? fmtDate(s.mov.iso) : (s.mov.br || '—');
          linhas.push(`     - ${tipo}${qtd} — ${s.status || '—'} · últ. mov. ${mov}`);
        });
      });
    linhas.push('');
  });
  linhas.push(`_Total: ${lista.length} processo(s) a protocolar._`);
  return linhas.join('\n').trim();
}

// ============================================================
// RELATÓRIO 2 — Documentos a vencer nos próximos N dias (Seg 08h)
// ============================================================
function relDocumentosVencendo(dados, hojeIso, diasAntecedencia) {
  const { documentos, clientes, armas } = dados;
  const dias = Number(diasAntecedencia) || 21;
  const cMap = mapaPorId(clientes), aMap = mapaPorId(armas);
  const lista = (documentos || []).filter(d => {
    if (!d.DataValidade || guiaDesconsiderada(d)) return false;
    const n = daysBetween(String(d.DataValidade).split('T')[0], hojeIso);
    return n !== null && n >= 0 && n <= dias;
  }).sort((a, b) => String(a.DataValidade).localeCompare(String(b.DataValidade)));
  if (!lista.length) return null;

  const porCli = {};
  lista.forEach(d => { const cid = String(d.ClienteId || ''); (porCli[cid] = porCli[cid] || []).push(d); });

  const linhas = [`⏰ *DOCUMENTOS A VENCER* (próximos ${dias} dias) — ${fmtDate(hojeIso)}`, ''];
  Object.keys(porCli)
    .sort((a, b) => nomeCliente(cMap, a).localeCompare(nomeCliente(cMap, b), 'pt-BR'))
    .forEach(cid => {
      linhas.push(`*${nomeCliente(cMap, cid)}*`);
      porCli[cid].forEach(d => { linhas.push(`  - ${descricaoDocVenc(d, aMap)}`); });
      linhas.push('');
    });
  linhas.push(`_Total: ${lista.length} documento(s)._`);
  return linhas.join('\n').trim();
}

// ============================================================
// RELATÓRIO 3 — Processos deferidos no dia (Qui 19h)
// ============================================================
function relDeferidosDoDia(dados, hojeIso) {
  const { processos, clientes } = dados;
  const cMap = mapaPorId(clientes);
  const lista = (processos || []).filter(p => getDataDeferido(p) === hojeIso);
  if (!lista.length) return null;

  lista.sort((a, b) => nomeCliente(cMap, a.ClienteId).localeCompare(nomeCliente(cMap, b.ClienteId), 'pt-BR'));
  const linhas = [`✅ *PROCESSOS DEFERIDOS HOJE* — ${fmtDate(hojeIso)}`, ''];
  lista.forEach(p => {
    linhas.push(`  - *${nomeCliente(cMap, p.ClienteId)}* — ${p.TipoProcesso || 'Processo'} (deferimento em ${tempoDecorrido(p, hojeIso)})`);
  });
  linhas.push('');
  linhas.push(`_Total: ${lista.length} processo(s) deferido(s) hoje._`);
  return linhas.join('\n').trim();
}

// ============================================================
// RELATÓRIO 4 — Conversas sem resposta (atendimento do WhatsApp)
// Lê o banco SQLite (db) diretamente, pois trata de mensagens, não dos JSON.
// ============================================================

// Só os dígitos de um telefone/jid
function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }

// Brasil não tem horário de verão desde 2019 -> fuso fixo UTC-3.
const SP_OFFSET_MS = 3 * 3600 * 1000;
// Decompõe um instante (epoch em segundos) na hora "de parede" de Brasília.
function spParts(epochSec) {
  const d = new Date(epochSec * 1000 - SP_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
// Epoch (segundos) de um dia de Brasília (y/mo/da) + hora "HH:MM".
function spEpoch(y, mo, da, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const asUtc = Date.UTC(y, mo, da, h || 0, m || 0, 0);
  return Math.floor((asUtc + SP_OFFSET_MS) / 1000);
}

// Minutos dentro do horário comercial (Seg–Sex, janela inicio–fim) entre dois instantes.
function minutosComerciais(tsIni, tsFim, janela) {
  if (!tsIni || !tsFim || tsFim <= tsIni) return 0;
  const inicio = (janela && janela.inicio) || '08:00';
  const fim = (janela && janela.fim) || '18:00';
  let total = 0;
  let p = spParts(tsIni);
  for (let i = 0; i < 120; i++) {
    const diaIni = spEpoch(p.y, p.mo, p.da, '00:00');
    const dow = spParts(diaIni).dow;
    if (dow >= 1 && dow <= 5) { // segunda a sexta
      const aberto = spEpoch(p.y, p.mo, p.da, inicio);
      const fechado = spEpoch(p.y, p.mo, p.da, fim);
      const lo = Math.max(tsIni, aberto);
      const hi = Math.min(tsFim, fechado);
      if (hi > lo) total += (hi - lo);
    }
    const prox = diaIni + 24 * 3600;
    if (prox > tsFim) break;
    p = spParts(prox);
  }
  return Math.floor(total / 60);
}

// "há 45 min" / "há 4h10" / (acima de 24h) "há 2d 5h"
function fmtEspera(min) {
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) { const m = min % 60; return m ? `há ${h}h${String(m).padStart(2, '0')}` : `há ${h}h`; }
  const d = Math.floor(h / 24), hr = h % 24;
  return hr ? `há ${d}d ${hr}h` : `há ${d}d`;
}

// Normaliza texto: minúsculas, sem acento, sem pontuação/emoji, espaços colapsados.
function normStr(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Formata telefone brasileiro para exibição.
function fmtTelefone(digits) {
  let d = soDigitos(digits);
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

// A última mensagem do cliente é só um agradecimento/encerramento (ou auto-resposta,
// figurinha)? Se sim, não conta como "sem resposta".
function ehEncerramento(body, type) {
  if (type === 'sticker') return true;          // figurinha sozinha não requer resposta
  if (type && type !== 'text') return false;    // imagem/documento/áudio podem precisar de resposta
  const raw = String(body || '').trim();
  if (!raw) return false;
  const t = normStr(raw);
  if (!t) return true;                          // só emojis/símbolos -> encerramento

  // Trechos que, se aparecerem em qualquer parte, indicam encerramento/auto-resposta.
  const CONTEM = [
    'disponha', 'de nada', 'denada', 'por nada', 'imagina', 'magina', 'nada a agradecer',
    'as ordens', 'a disposicao', 'estamos a disposicao', 'ficamos a disposicao', 'qualquer coisa',
    'encerr', 'foi resolvid', 'ja resolvid', 'assunto resolvid', 'ja foi atendid',
    'agradecemos seu contato', 'agradecemos o contato', 'agradecemos a mensagem',
    'nao estamos disponiveis', 'fora do horario', 'horario de atendimento', 'horario de funcionamento',
    'retornaremos', 'responderemos', 'mensagem automatica', 'atendimento automatico', 'resposta automatica',
  ];
  for (const c of CONTEM) if (t.includes(c)) return true;

  // Remove saudação inicial ("bom dia", "boa tarde"...) e intensificador ("muito") e reavalia o resto.
  let resto = t.replace(/^(bom dia|boa tarde|boa noite|boa|ola|oi|opa|eai|e ai)\b\s*/, '').trim();
  resto = resto.replace(/^(muito|mto|mt)\s+/, '').trim();

  const FECHA = new Set([
    'ok', 'okay', 'ok obrigado', 'ok entao', 'ok entendi', 'blz', 'beleza', 'ta', 'ta ok', 'ta bom',
    'tabom', 'ta certo', 'ta otimo', 'ta joia', 'certo', 'combinado', 'isso', 'isso mesmo', 'isso ai',
    'perfeito', 'show', 'show de bola', 'valeu', 'vlw', 'obrigado', 'obrigada', 'obg', 'obgd', 'obgada',
    'joia', 'maravilha', 'top', 'entendi', 'entendido', 'ciente', 'grato', 'grata', 'gratidao',
    'agradecido', 'agradecida', 'agradeco', 'otimo', 'merece', 'esperamos', 'aguardo', 'aguardamos',
    'fico no aguardo', 'amem',
  ]);
  if (FECHA.has(resto) || FECHA.has(t)) return true;

  // Agradecimentos por extenso (começam com obrigado/agradeço/grato/disponha) são encerramento,
  // mesmo em frases maiores ("obrigado por tudo", "grato pela atenção"). Palavras como "ok", "ta",
  // "perfeito" só contam quando são a mensagem inteira (acima), para não esconder perguntas reais
  // do tipo "Perfeito, mas e o prazo?".
  if (/^(obrigad|agradec|grat|disponha)/.test(resto)) return true;
  return false;
}

function relConversasSemResposta(db, agoraEpoch, cfg, opcoes = {}) {
  cfg = cfg || {};
  const limiteMin = Number(cfg.limiteMin) || 60;
  const maxAparicoes = (cfg.maxAparicoes === 0 || cfg.maxAparicoes) ? Number(cfg.maxAparicoes) : 4;
  const maxDias = (cfg.maxDiasSemResposta === 0 || cfg.maxDiasSemResposta) ? Number(cfg.maxDiasSemResposta) : 5;
  const janela = cfg.janela || { inicio: '08:00', fim: '18:00' };
  const ignorados = new Set((cfg.ignorados || []).map(soDigitos).filter(Boolean));
  const persistir = !!opcoes.persistir;

  const chats = db.listarChats() || [];
  const pendentes = [];

  for (const chat of chats) {
    const jid = chat.jid || '';
    if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) continue; // só conversas individuais

    let fone = soDigitos(chat.phone);
    if (!fone && jid.endsWith('@s.whatsapp.net')) fone = soDigitos(jid.split('@')[0]);

    // (0) contato ignorado (compara com e sem o 55 do país)
    if (fone) {
      let f2 = fone; if (f2.startsWith('55') && f2.length > 11) f2 = f2.slice(2);
      if (ignorados.has(fone) || ignorados.has(f2) || ignorados.has('55' + f2)) continue;
    }

    const msgs = db.listarMensagens(jid, 1) || [];
    const ultima = msgs[msgs.length - 1];
    if (!ultima || ultima.from_me) continue;                             // (1) a bola está conosco?
    if (chat.resolved_ts && ultima.ts <= chat.resolved_ts) continue;     // (2) resolvida e sem msg nova
    if (ehEncerramento(ultima.body, ultima.type)) continue;              // (3) agradecimento/encerramento/auto-resposta

    if (minutosComerciais(ultima.ts, agoraEpoch, janela) < limiteMin) continue; // (4) tempo mínimo (horário comercial)

    const esperaSeg = Math.max(0, agoraEpoch - Number(ultima.ts));       // tempo real decorrido (calendário)
    if (maxDias > 0 && esperaSeg > maxDias * 86400) continue;            // (5) corta conversas muito antigas

    let count = Number(chat.report_count) || 0;                          // (6) auto-saída após N aparições
    if (Number(chat.report_count_ts) !== Number(ultima.ts)) count = 0;   // cliente mandou algo novo -> zera
    if (maxAparicoes > 0 && count >= maxAparicoes) continue;

    pendentes.push({ jid, fone, nome: chat.name, espera: Math.floor(esperaSeg / 60), body: ultima.body, type: ultima.type, novoCount: count + 1, ts: ultima.ts });
  }

  if (!pendentes.length) return null;
  pendentes.sort((a, b) => b.espera - a.espera);

  if (persistir) {
    for (const p of pendentes) { try { db.setContadorRelatorio(p.jid, p.novoCount, p.ts); } catch (e) {} }
  }

  const pn = spParts(agoraEpoch);
  const dataHora = `${String(pn.da).padStart(2, '0')}/${String(pn.mo + 1).padStart(2, '0')}/${pn.y} ${String(pn.h).padStart(2, '0')}:${String(pn.mi).padStart(2, '0')}`;

  const linhas = [`📨 *CONVERSAS SEM RESPOSTA* — ${dataHora}`, ''];
  linhas.push(`Clientes aguardando retorno (sem resposta há mais de ${limiteMin} min no horário comercial):`, '');
  pendentes.forEach((p, i) => {
    const temNome = p.nome && p.nome.trim();
    const nomeLinha = temNome ? `${p.nome.trim()}${p.fone ? ` (${fmtTelefone(p.fone)})` : ''}` : fmtTelefone(p.fone);
    let previa = (p.type && p.type !== 'text') ? `[${p.type}] ${p.body || ''}`.trim() : (p.body || '');
    previa = previa.replace(/\s+/g, ' ').trim();
    if (previa.length > 90) previa = previa.slice(0, 90) + '…';
    linhas.push(`${i + 1}. ${nomeLinha} — ${fmtEspera(p.espera)}`);
    if (previa) linhas.push(`   "${previa}"`);
  });
  linhas.push('');
  linhas.push(`_Total: ${pendentes.length} conversa(s) aguardando resposta._`);
  if (maxAparicoes > 0) linhas.push(`_Obs.: conversa que aparecer ${maxAparicoes} vezes sem nenhuma resposta sai automaticamente da lista._`);
  return linhas.join('\n').trim();
}

module.exports = { relProcessosAProtocolar, relDocumentosVencendo, relDeferidosDoDia, relConversasSemResposta };
