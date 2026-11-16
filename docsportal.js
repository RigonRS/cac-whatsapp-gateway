// ============================================================
// IMPORTAÇÃO DE DOCUMENTOS — lê os PDFs da pasta "DOCUMENTOS PORTAL" de cada
// cliente (CRAF, Guia de Tráfego, SIMAF) com o extrator Python e confere se o
// nome do arquivo segue o padrão do renomeador. O Gestão compara com o cadastro.
// ============================================================
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const graph = require('./graph');
const db = require('./db');

const PYTHON = process.env.PYTHON_BIN || 'python3';
const EXTRATOR = path.join(__dirname, 'extrator', 'extrair_documentos.py');
// Mude quando o extrator mudar: invalida o cache das leituras antigas.
const VERSAO_EXTRATOR = '2';
const PDFS_POR_LOTE = 15;

const ehPdf = (nome) => /\.pdf$/i.test(nome || '');
// O conteúdo define a chave (renomear não muda o hash nem o cTag).
const chaveCache = (it) => `${VERSAO_EXTRATOR}:${(it.file && it.file.hashes && it.file.hashes.quickXorHash) || it.cTag || it.eTag || it.lastModifiedDateTime}`;

function rodarExtrator(caminhos) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [EXTRATOR, ...caminhos], { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('extrator: ' + err.message));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('extrator devolveu uma resposta inválida')); }
    });
  });
}

// Lê os PDFs (usando o cache quando o arquivo não mudou). Devolve Map itemId -> dados.
async function extrairItens(itens) {
  const resultado = new Map();
  const faltando = [];
  for (const it of itens.filter((i) => ehPdf(i.name))) {
    const cache = db.getExtracaoDoc(it.id, chaveCache(it));
    if (cache) resultado.set(it.id, cache);
    else faltando.push(it);
  }
  for (let i = 0; i < faltando.length; i += PDFS_POR_LOTE) {
    const lote = faltando.slice(i, i + PDFS_POR_LOTE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsportal-'));
    try {
      const baixados = [];
      for (const it of lote) {
        try {
          const caminho = path.join(dir, `${baixados.length}${path.extname(it.name) || '.pdf'}`);
          fs.writeFileSync(caminho, await graph.baixarArquivo(it.id));
          baixados.push({ it, caminho });
        } catch (e) {
          resultado.set(it.id, { tipo: null, campos: {}, avisos: ['Não consegui baixar o arquivo: ' + e.message], nome_sugerido_base: null });
        }
      }
      if (!baixados.length) continue;
      const saida = await rodarExtrator(baixados.map((b) => b.caminho));
      saida.forEach((r, k) => {
        const { it } = baixados[k];
        const dados = { tipo: r.tipo, campos: r.campos || {}, avisos: r.avisos || [], nome_sugerido_base: r.nome_sugerido_base || null, motivo_nome: r.motivo_nome || null };
        db.salvarExtracaoDoc(it.id, chaveCache(it), dados);
        resultado.set(it.id, dados);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return resultado;
}

// Mesma regra do renomeador (unique_target): percorre os PDFs em ordem de nome;
// o nome padrão é usado se estiver livre (ou se já for o do próprio arquivo),
// senão ganha " (2)", " (3)"... Comparação sem diferenciar maiúsculas, como no Windows/SharePoint.
function conferirNomes(itens, extraidos) {
  const lc = (s) => s.toLowerCase();
  const pdfs = itens.filter((i) => ehPdf(i.name)).sort((a, b) => (lc(a.name) < lc(b.name) ? -1 : lc(a.name) > lc(b.name) ? 1 : 0));
  const existentes = new Set(itens.map((i) => lc(i.name)));
  const reservados = new Set();
  const out = new Map();
  for (const it of pdfs) {
    const base = extraidos.get(it.id)?.nome_sugerido_base;
    if (!base) { out.set(it.id, { nome_ok: null, nome_final: null }); continue; }
    const ext = path.extname(it.name);
    const livre = (n) => !reservados.has(lc(n)) && (!existentes.has(lc(n)) || lc(n) === lc(it.name));
    let candidato = base + ext;
    for (let k = 2; !livre(candidato); k++) candidato = `${base} (${k})${ext}`;
    reservados.add(lc(candidato));
    out.set(it.id, { nome_ok: candidato === it.name, nome_final: candidato });
  }
  return out;
}

async function lerPastaCliente(cliente) {
  const lista = await graph.listarDocumentosPortal(String(cliente.Title || '').trim());
  if (!lista) return { pasta: null, arquivos: [] };
  const extraidos = await extrairItens(lista.itens);
  const nomes = conferirNomes(lista.itens, extraidos);
  const arquivos = lista.itens.filter((i) => ehPdf(i.name)).map((it) => {
    const x = extraidos.get(it.id) || {};
    const n = nomes.get(it.id) || {};
    return {
      id: it.id, nome: it.name, webUrl: it.webUrl, modificado: it.lastModifiedDateTime,
      tipo: x.tipo || null, campos: x.campos || {}, avisos: x.avisos || [],
      nome_ok: n.nome_ok ?? null, nome_final: n.nome_final || null, motivo_nome: x.motivo_nome || null,
    };
  });
  return { pasta: lista.pasta, arquivos };
}

async function clientePorId(id) {
  const c = (await graph.getClientes()).find((x) => String(x.id) === String(id));
  if (!c) throw Object.assign(new Error('Cliente não encontrado'), { status: 404 });
  return c;
}

const NOME_INVALIDO = /[<>:"/\\|?*\u0000-\u001f]/;

// Renomeia arquivos da pasta DOCUMENTOS PORTAL de um cliente. Só aceita arquivos
// que estão de fato nessa pasta e nomes .pdf sem caracteres proibidos.
async function renomear(clienteId, itens, atendente) {
  const cliente = await clientePorId(clienteId);
  const lista = await graph.listarDocumentosPortal(String(cliente.Title || '').trim());
  if (!lista) throw Object.assign(new Error('Pasta DOCUMENTOS PORTAL do cliente não encontrada'), { status: 404 });
  const daPasta = new Map(lista.itens.map((i) => [i.id, i]));
  const resultados = [];
  for (const { itemId, novoNome } of itens || []) {
    const nome = String(novoNome || '').trim();
    const atual = daPasta.get(itemId);
    if (!atual) { resultados.push({ itemId, ok: false, erro: 'arquivo não pertence à pasta do cliente' }); continue; }
    if (!ehPdf(nome) || NOME_INVALIDO.test(nome) || nome.length > 200) {
      resultados.push({ itemId, ok: false, erro: 'nome inválido' }); continue;
    }
    try {
      const item = await graph.renomearArquivo(itemId, nome);
      console.log(`[docs-portal] ${atendente} renomeou "${atual.name}" -> "${nome}" (${cliente.Title})`);
      resultados.push({ itemId, ok: true, nome: item.name, webUrl: item.webUrl });
    } catch (e) {
      resultados.push({ itemId, ok: false, erro: e.message });
    }
  }
  return resultados;
}

// ---- Varredura de todos os clientes (em segundo plano) ----
let varredura = null;

function iniciarVarredura(atendente) {
  if (varredura && varredura.rodando) return varredura;
  varredura = { rodando: true, iniciadoPor: atendente, inicio: Date.now(), fim: null, feitos: 0, total: 0, resultados: {}, erros: [] };
  const v = varredura;
  (async () => {
    try {
      const clientes = (await graph.getClientes()).filter((c) => c.Title);
      v.total = clientes.length;
      for (const c of clientes) {
        try {
          const r = await lerPastaCliente(c);
          if (r.arquivos.length) v.resultados[c.id] = r;
        } catch (e) {
          v.erros.push({ clienteId: c.id, nome: c.Title, erro: e.message });
        }
        v.feitos++;
      }
    } catch (e) {
      v.erros.push({ erro: e.message });
    }
    v.rodando = false;
    v.fim = Date.now();
    console.log(`[docs-portal] varredura concluída: ${v.feitos}/${v.total} clientes, ${v.erros.length} erro(s)`);
  })();
  return v;
}

// Enquanto roda, devolve só o progresso; ao terminar, devolve também os resultados.
function estadoVarredura() {
  if (!varredura) return { rodando: false, feitos: 0, total: 0, resultados: null, erros: [] };
  const { resultados, ...resto } = varredura;
  return varredura.rodando ? { ...resto, resultados: null } : { ...resto, resultados };
}

module.exports = { lerPastaCliente, clientePorId, renomear, iniciarVarredura, estadoVarredura, conferirNomes };
