// ============================================================
// AUTENTICAÇÃO — valida o id_token do Azure AD (mesmo login do CAC Gestão)
// Não cria senha nova: reaproveita o login Microsoft que os atendentes já usam.
// ============================================================
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const TENANT = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;

const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
  cache: true,
  rateLimit: true,
});

function getKey(header, cb) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return cb(err);
    cb(null, key.getPublicKey());
  });
}

// Verifica o id_token e devolve o payload (ou rejeita).
function verifyIdToken(token) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('Token ausente'));
    jwt.verify(
      token,
      getKey,
      {
        audience: CLIENT_ID,
        issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      }
    );
  });
}

// Mapeia o e-mail do login para o nome do atendente (mesma lógica do getCurrentUserName no app).
function nomeAtendente(decoded) {
  const email = String(decoded.preferred_username || decoded.email || '').toLowerCase();
  // Só a parte antes do @ (o domínio simonebpegoraro contém "simone" e confundia todos)
  const local = email.split('@')[0];
  if (local.includes('recepcao')) return 'Andrieli';
  if (local.includes('geison')) return 'Geison';
  if (local.includes('janaina')) return 'Janaína';
  if (local.includes('priscila')) return 'Priscila';
  if (local.includes('matheus')) return 'Matheus';
  if (local.includes('simone')) return 'Simone';
  return decoded.name || email || 'Atendente';
}

const ADMINS = ['Matheus', 'Simone'];
function isAdmin(nome) {
  return ADMINS.includes(nome);
}

// Allowlist de quem pode usar a Central de WhatsApp (e-mails/UPN autorizados).
// Mesmo com um token válido do tenant, só estes e-mails têm acesso.
const ATENDENTES_AUTORIZADOS = new Set([
  'simone@simonebpegoraro.onmicrosoft.com',
  'priscila@simonebpegoraro.onmicrosoft.com',
  'matheus@simonebpegoraro.onmicrosoft.com',
  'recepcao@simonebpegoraro.onmicrosoft.com',
  'geison@simonebpegoraro.onmicrosoft.com',
  'janaina@simonebpegoraro.onmicrosoft.com',
]);
function emailDoToken(decoded) {
  return String(decoded.preferred_username || decoded.email || '').toLowerCase().trim();
}
function atendenteAutorizado(decoded) {
  return ATENDENTES_AUTORIZADOS.has(emailDoToken(decoded));
}

// Middleware Express: exige um id_token válido em Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    const decoded = await verifyIdToken(token);
    if (!atendenteAutorizado(decoded)) {
      return res.status(403).json({ error: 'Acesso não autorizado à Central de WhatsApp.' });
    }
    req.atendente = nomeAtendente(decoded);
    req.isAdmin = isAdmin(req.atendente);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Não autorizado: ' + e.message });
  }
}

module.exports = { verifyIdToken, nomeAtendente, isAdmin, requireAuth, atendenteAutorizado };
