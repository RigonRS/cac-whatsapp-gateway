// ============================================================
// MICROSOFT GRAPH — token de app (client_credentials), leitura de clientes.json
// e ARQUIVAMENTO dos arquivos recebidos na pasta do cliente no SharePoint.
// Mesmos parâmetros do worker do portal (cac-portal/worker.js).
// ============================================================
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DATA_FOLDER = 'cac-gestao-dados';
const DOCS_SITE = 'simonebpegoraro.sharepoint.com:/sites/SimonePegoraro';
const DOCS_PATH = "PRISCILA, ANDRIELI E MATHEUS/CR'S";
const SUBPASTA_RECEBIDOS = 'Recebidos Whatsapp';

const UPN = process.env.ONEDRIVE_UPN; // matheus@simonebpegoraro.onmicrosoft.com (dados JSON)

let _token = null;
let _tokenExp = 0;

async function getMsToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  if (!res.ok) throw new Error('Azure token: ' + (await res.text()));
  const j = await res.json();
  _token = j.access_token;
  _tokenExp = Date.now() + j.expires_in * 1000;
  return _token;
}

async function readJson(path) {
  const t = await getMsToken();
  const url = `${GRAPH}/users/${encodeURIComponent(UPN)}/drive/root:/${path}:/content`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`readJson ${path}: HTTP ${res.status}`);
  return res.json();
}

// Lê clientes.json do OneDrive de dados.
async function getClientes() {
  return (await readJson(`${DATA_FOLDER}/clientes.json`)) || [];
}
// Demais arquivos de dados do sistema (usados pelos relatórios automáticos).
async function getProcessos() {
  return (await readJson(`${DATA_FOLDER}/processos.json`)) || [];
}
async function getDocumentos() {
  return (await readJson(`${DATA_FOLDER}/documentos.json`)) || [];
}
async function getArmas() {
  return (await readJson(`${DATA_FOLDER}/armas.json`)) || [];
}
async function getOrcamentos() {
  return (await readJson(`${DATA_FOLDER}/orcamentos.json`)) || [];
}
// Cadastro de clubes de tiro (usado pelo renomeador para achar o clube pelo endereço da guia).
async function getClubes() {
  return (await readJson(`${DATA_FOLDER}/clubes.json`)) || [];
}
async function getDemandas() {
  return (await readJson(`${DATA_FOLDER}/demandas.json`)) || [];
}
// Lê um arquivo de dados "extra" (log de movimentações, acessos do portal, config de
// extras, etc.) pelo nome. SÓ é usado pelo endpoint do assistente, que tem a sua própria
// lista branca; mesmo assim validamos o nome aqui (nunca permite "../" nem clientes).
const ARQUIVOS_PERMITIDOS = new Set([
  'movimentacoes', 'acessos_portal', 'config_extras',
  'extras_avulsos', 'extras_pagos_mes', 'extras_ajustes',
  'valores_padrao', 'taxas_padrao',
]);
async function getArquivoDados(nome) {
  if (!ARQUIVOS_PERMITIDOS.has(String(nome))) throw new Error('Arquivo não liberado para o assistente.');
  return await readJson(`${DATA_FOLDER}/${nome}.json`); // pode ser array, objeto ou null
}
// Configuração dos relatórios automáticos (editada pela página de Configurações).
async function getConfigRelatorios() {
  return await readJson(`${DATA_FOLDER}/relatorios_whatsapp.json`);
}

// ---- SharePoint (site de documentos) ----
let _siteId = null;
async function getDocsSiteId() {
  if (_siteId) return _siteId;
  const t = await getMsToken();
  const res = await fetch(`${GRAPH}/sites/${DOCS_SITE}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`site: HTTP ${res.status}`);
  _siteId = (await res.json()).id;
  return _siteId;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Cria uma subpasta (ignora se já existe). parentPath deve existir.
async function ensureFolderSite(parentPath, name) {
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  const url = `${GRAPH}/sites/${siteId}/drive/root:/${encPath(parentPath)}:/children`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
  if (res.ok || res.status === 409) return true; // 409 = já existe
  throw new Error(`ensureFolder "${name}" em "${parentPath}": HTTP ${res.status} ${await res.text()}`);
}

// Salva um arquivo recebido na subpasta "Recebidos Whatsapp" da pasta do cliente.
// title = cliente.Title (nome exato da pasta). Retorna o item criado no Graph.
async function salvarArquivoCliente(title, filename, buffer) {
  await ensureFolderSite(DOCS_PATH, title);
  await ensureFolderSite(`${DOCS_PATH}/${title}`, SUBPASTA_RECEBIDOS);
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  const fullPath = `${DOCS_PATH}/${title}/${SUBPASTA_RECEBIDOS}/${filename}`;
  const url = `${GRAPH}/sites/${siteId}/drive/root:/${encPath(fullPath)}:/content`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  if (!res.ok) throw new Error(`upload "${filename}": HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// Grava (ou substitui) um arquivo num caminho do site (as pastas já precisam existir).
async function salvarArquivoSite(caminho, buffer, tipo = 'application/octet-stream') {
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  const res = await fetch(`${GRAPH}/sites/${siteId}/drive/root:/${encPath(caminho)}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': tipo },
    body: buffer,
  });
  if (!res.ok) throw new Error(`upload "${caminho}": HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- Pasta "DOCUMENTOS PORTAL" do cliente (importação de documentos no Gestão) ----
const SUBPASTA_PORTAL = 'DOCUMENTOS PORTAL';

// Arquivos (sem subpastas) de uma pasta do site. null = pasta não existe.
async function listarPastaSite(folderPath) {
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  let url = `${GRAPH}/sites/${siteId}/drive/root:/${encPath(folderPath)}:/children`
    + '?$select=id,name,size,eTag,cTag,webUrl,lastModifiedDateTime,file&$top=999';
  const itens = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`listar "${folderPath}": HTTP ${res.status}`);
    const j = await res.json();
    itens.push(...(j.value || []).filter((i) => i.file));
    url = j['@odata.nextLink'] || null;
  }
  return itens;
}

// Nome da pasta = cliente.Title. Tenta as formas NFC e NFD do nome (acentos),
// como o worker do portal (cac-portal/worker.js, listFolderSite).
async function listarDocumentosPortal(title) {
  const tentadas = new Set();
  for (const nome of [title, title.normalize('NFC'), title.normalize('NFD')]) {
    if (tentadas.has(nome)) continue;
    tentadas.add(nome);
    const pasta = `${DOCS_PATH}/${nome}/${SUBPASTA_PORTAL}`;
    const itens = await listarPastaSite(pasta);
    if (itens !== null) return { pasta, itens };
  }
  return null;
}

async function baixarArquivo(itemId) {
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  const res = await fetch(`${GRAPH}/sites/${siteId}/drive/items/${encodeURIComponent(itemId)}/content`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`baixar arquivo: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Renomeia um arquivo do site. Se já existir outro com o mesmo nome, o Graph recusa (409).
async function renomearArquivo(itemId, novoNome) {
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  const res = await fetch(`${GRAPH}/sites/${siteId}/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: novoNome }),
  });
  if (res.status === 409) throw new Error('já existe outro arquivo com esse nome na pasta');
  if (!res.ok) throw new Error(`renomear: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// Pasta "Docs Vencidos" na pasta principal do cliente (ao lado de DOCUMENTOS PORTAL).
const SUBPASTA_VENCIDOS = 'Docs Vencidos';

// Id de uma pasta do site pelo caminho (cria a última parte se não existir).
async function idPastaSite(parentPath, nome) {
  await ensureFolderSite(parentPath, nome);
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  const res = await fetch(`${GRAPH}/sites/${siteId}/drive/root:/${encPath(`${parentPath}/${nome}`)}?$select=id`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`pasta "${nome}": HTTP ${res.status}`);
  return (await res.json()).id;
}

// Move um arquivo para outra pasta (pelo id). Se já existir um arquivo com o mesmo nome lá,
// o Graph renomeia o que chega (ex.: "arquivo 1.pdf").
async function moverArquivo(itemId, pastaDestinoId) {
  const t = await getMsToken();
  const siteId = await getDocsSiteId();
  const res = await fetch(`${GRAPH}/sites/${siteId}/drive/items/${encodeURIComponent(itemId)}?@microsoft.graph.conflictBehavior=rename`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentReference: { id: pastaDestinoId } }),
  });
  if (!res.ok) throw new Error(`mover: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { idPastaSite, moverArquivo, SUBPASTA_VENCIDOS, getClubes, salvarArquivoSite, getMsToken, getClientes, getProcessos, getDocumentos, getArmas, getOrcamentos, getDemandas, getArquivoDados, getConfigRelatorios, salvarArquivoCliente, listarDocumentosPortal, baixarArquivo, renomearArquivo, DOCS_PATH, SUBPASTA_RECEBIDOS, SUBPASTA_PORTAL };
