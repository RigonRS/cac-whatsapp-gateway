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

module.exports = { getMsToken, getClientes, salvarArquivoCliente, DOCS_PATH, SUBPASTA_RECEBIDOS };
