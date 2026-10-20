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

module.exports = { relProcessosAProtocolar, relDocumentosVencendo, relDeferidosDoDia };
