# CAC WhatsApp Gateway (Fase 1)

Servidor que conecta o **CAC Gestão** ao WhatsApp por **QR Code** (biblioteca Baileys).
Ele fica ligado 24h numa VPS, mantém a conexão, guarda o histórico das conversas e
**salva automaticamente** os arquivos que os clientes enviam na pasta do cliente no OneDrive
(subpasta **"Recebidos Whatsapp"**).

> ⚠️ **Aviso:** esta é a conexão **não-oficial** do WhatsApp. Existe **risco de banimento** do número.
> Use um **número dedicado** (não o número principal do escritório), evite disparos em massa e
> respeite quem pedir para parar de receber mensagens.

---

## O que você precisa antes de começar

1. **Uma VPS** (servidor na nuvem) com Linux — recomendo Ubuntu 22.04/24.04.
   Sugestões baratas: Hetzner (CX22, ~€4/mês), Contabo ou DigitalOcean (~US$5–6/mês).
2. **Um subdomínio** apontando para o IP da VPS. Ex.: `wa.prbelico.com.br`
   (crie um registro **A** no seu provedor de domínio apontando para o IP da VPS).
3. **Um número de WhatsApp dedicado** (um chip novo/separado) para ler o QR.
4. **O segredo do app do Azure** (`AZURE_CLIENT_SECRET`) — o mesmo tipo usado no worker do portal.
   (Se não tiver mais o valor guardado, gere um novo em portal.azure.com → App Registrations →
   Certificados e segredos → Novo segredo do cliente.)

Não é preciso mexer em redirecionamentos do Azure: o gateway só **valida** o login que o
CAC Gestão já faz (ele confere o token com as chaves públicas da Microsoft).

---

## Instalação na VPS (passo a passo)

### 1. Instalar o Docker
```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Enviar o código para a VPS
Copie a pasta `cac-whatsapp-gateway` para a VPS (via `git clone` do seu repositório
ou `scp`). Entre na pasta:
```bash
cd cac-whatsapp-gateway
```

### 3. Configurar o `.env`
```bash
cp .env.example .env
nano .env      # preencha AZURE_CLIENT_SECRET, DOMAIN e confira os demais
```

### 4. Subir tudo
```bash
docker compose up -d --build
```
O Caddy vai pegar o certificado HTTPS automaticamente (leva ~1 min).
Teste no navegador: `https://SEU_DOMINIO/health` deve mostrar `{"ok":true}`.

### 5. Parear o WhatsApp (ler o QR)
- Abra o **CAC Gestão** → menu **Atendimento WhatsApp** (como Matheus ou Simone).
- Vai aparecer o **QR Code**. No celular do **número dedicado**:
  WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o QR.
- O status deve mudar para **Conectado**.

Pronto: mensagens recebidas aparecem na caixa de entrada em tempo real, e os arquivos
enviados pelos clientes vão automaticamente para a pasta deles no OneDrive.

---

## Comandos úteis

```bash
docker compose logs -f gateway   # ver o que está acontecendo
docker compose restart gateway   # reiniciar
docker compose down              # parar
docker compose up -d --build     # subir de novo / atualizar
```

A sessão do WhatsApp e o histórico ficam na pasta `data/` (volume persistente),
então sobrevivem a reinícios. Faça backup dessa pasta de vez em quando.

---

## Como funciona (resumo técnico)

- `server.js` — API HTTP + tempo real (Socket.IO). Valida o **id_token** do Azure AD.
- `wa.js` — conexão Baileys: QR, receber/enviar, baixar mídia.
- `graph.js` — token de app (client_credentials) + upload dos arquivos no SharePoint
  (`PRISCILA, ANDRIELI E MATHEUS/CR'S/{cliente}/Recebidos Whatsapp`).
- `clientes.js` — casa o número do WhatsApp com o cliente (campo `Celular`).
- `db.js` — SQLite com o histórico (pasta `data/`).

### Rotas
- `GET /health` — teste rápido (sem login)
- `GET /status` — conectado? qual número?
- `GET /qr` — QR para parear (só admin)
- `GET /chats` — lista de conversas
- `GET /messages?jid=...` — mensagens de uma conversa
- `POST /send` — enviar texto `{ jid, text }`
- `POST /assign` — assumir a conversa (usado na Fase 2)

---

## Fase 1 x próximas fases

**Esta Fase 1 entrega:** conectar por QR, receber texto e mídia, enviar texto,
histórico, vínculo com o cliente e **arquivamento automático dos arquivos recebidos**.

**Fase 2:** multi-atendente (assumir/transferir, ver quem atende), etiquetas, notas,
respostas rápidas. **Fase 3:** robô (boas-vindas, menu, palavras-chave, horário) e
disparos automáticos ligados aos processos.
