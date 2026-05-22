# Flashcards + WhatsApp — guia completo de setup

Checklist para ligar o **app Flashcards (Vercel)** ao **bot WhatsApp (VPS)** sem misturar com quiz/caderno.

---

## Visão geral (quem fala com quem)

```
┌─────────────────────┐         fc_ API key          ┌──────────────────────┐
│  App Flashcards     │ ◄────────────────────────── │  Bot (VPS)           │
│  (Vercel)           │   pending, sessions,        │  chatbot-quizz       │
│                     │   dispatch, settings        │  npm start           │
└─────────┬───────────┘                             └──────────┬───────────┘
          │                                                    │
          │  GET /api/flashcards-whatsapp-users                  │ WhatsApp
          │  (lista nomes do grupo)                              │ privado
          ▼                                                    ▼
┌─────────────────────┐                             ┌──────────────────────┐
│  Site Papa Vagas    │                             │  Seu celular /       │
│  (Vercel — quiz)    │                             │  contatos @lid       │
└─────────────────────┘                             └──────────────────────┘
```

- O **bot na VPS** só precisa falar com o **app Flashcards** (`FLASHCARDS_API_URL`).
- O **app Flashcards** busca a lista de pessoas no **site do quiz no Vercel** (`/api/flashcards-whatsapp-users`), não na VPS diretamente (a menos que você aponte a URL para a VPS com reverse proxy — o padrão é usar o mesmo deploy Vercel do quiz).

---

## Várias pessoas (sem repetir config na VPS)

Cada pessoa usa **só o app Flashcards**. Na VPS ficam **só**:

```env
FLASHCARDS_API_URL=https://seu-app-flashcards.vercel.app
FLASHCARDS_POLL_MS=90000
```

**Não** precisa `FLASHCARDS_API_KEY` por pessoa no `.env` da VPS.

### Fluxo por pessoa

1. No app: escolhe o nome na lista (`/api/flashcards-whatsapp-users`) e salva `whatsapp_jid` + gera `fc_...` na conta dela.  
2. App chama (logo após vincular):

```http
POST https://papa-vagas.vercel.app/api/flashcards-link-request
Authorization: Bearer <FLASHCARDS_BOT_INBOUND_SECRET>
Content-Type: application/json

{
  "userJid": "176518911234135@lid",
  "apiKey": "fc_...",
  "displayLabel": "Daniel Ranna"
}
```

3. Bot manda no **privado** dessa pessoa:

> O app Flashcards quer enviar cards neste WhatsApp (Daniel Ranna).  
> Responda **SIM** para autorizar ou **NAO** para recusar.

4. **SIM** → vínculo ativo; cards e lembretes usam a `fc_` key dela.  
5. **NAO** → recusado; nada é enviado.

A pessoa **não digita** a API key no WhatsApp — só confirma identidade.

**Supabase (quiz):** rode `supabase-migration-flashcards-whatsapp-links.sql` no projeto do Papa Vagas.

---

## Ordem recomendada (faça nesta sequência)

| # | Onde | O quê |
|---|------|--------|
| 1 | Supabase (Flashcards) | Rodar `sql-flashcards.sql` + bucket `flashcard-images` |
| 2 | Vercel — app Flashcards | Env + gerar API key `fc_...` |
| 3 | Vercel — site Quiz (Papa Vagas) | Env `FLASHCARDS_BOT_INBOUND_SECRET` + redeploy |
| 4 | VPS — bot | Env flashcards + build + restart |
| 5 | WhatsApp | `/sync-membros` no grupo |
| 6 | App Flashcards | Vincular WhatsApp (escolher nome na lista) |
| 7 | Teste | Lembrete SIM + um card |

---

## Parte A — App Flashcards (Vercel)

### A1. Supabase do Flashcards

1. Abra o projeto Supabase **do app Flashcards** (não precisa ser o mesmo do quiz).
2. SQL Editor → execute o script **`sql-flashcards.sql`** do seu repositório Flashcards.
3. Storage → crie bucket **`flashcard-images`** (público), se o script não criar sozinho.

### A2. Variáveis de ambiente no Vercel (projeto Flashcards)

Em **Settings → Environment Variables** do projeto **Flashcards**:

| Variável | Obrigatório | Exemplo / nota |
|----------|-------------|----------------|
| `SUPABASE_URL` | Sim | URL do projeto Flashcards |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim | service role do Flashcards |
| `NEXTAUTH_*` / auth do app | Sim | Conforme seu app já usa |
| Demais vars do Flashcards | Sim | O que seu app já documenta |

**Para vincular WhatsApp sem digitar telefone** (adicione):

| Variável | Obrigatório | Valor |
|----------|-------------|--------|
| `QUIZ_BOT_USERS_URL` | Sim | `https://SEU-DOMINIO-QUIZ.vercel.app/api/flashcards-whatsapp-users` |
| `QUIZ_BOT_USERS_SECRET` | Sim | Mesmo token que você vai criar no passo B2 (ex.: `a8f3...64chars`) |

> Troque `SEU-DOMINIO-QUIZ` pelo domínio real do Papa Vagas (onde está o `public/` + pasta `api/` deste repo).

**Não** coloque `FLASHCARDS_API_KEY` aqui para o bot — a key `fc_...` é gerada **dentro** do app (Configurações) e vai na **VPS**.

### A3. Gerar API key do bot (`fc_...`)

1. Deploy do app Flashcards com Supabase ok.
2. Login no app → **Flashcards → Configurações**.
3. **Gerar API key** → copie algo como `fc_xxxxxxxx`.
4. Guarde: essa key vai no `.env` da **VPS** como `FLASHCARDS_API_KEY`.

### A4. Configurar horários e usuário no app

1. Defina **início/fim** do dia (`start_hour`, `end_hour`) e fuso — via UI ou `PUT /api/flashcards/bot/settings`.
2. Botão **“Buscar contas do WhatsApp”** (você implementa chamando `QUIZ_BOT_USERS_URL`):
   - Header: `Authorization: Bearer ${QUIZ_BOT_USERS_SECRET}`
   - Mostra `displayLabel` (nome) e salva o `userJid` escolhido.
3. Salve em settings o campo que sua API aceita, por exemplo:
   - `whatsapp_jid` ou `user_whatsapp_jid` = JID retornado (ex. `5511...@s.whatsapp.net` ou `...@lid`).

Sem JID salvo, o bot **não sabe** para qual privado enviar cards.

### A5. Exemplo de chamada no front (Flashcards)

```javascript
const res = await fetch(process.env.QUIZ_BOT_USERS_URL, {
  headers: { Authorization: `Bearer ${process.env.QUIZ_BOT_USERS_SECRET}` },
});
const { users, warning, hint } = await res.json();
// users: [{ userJid, displayLabel, engaged }, ...]
```

Depois, ao salvar settings:

```javascript
await fetch("/api/flashcards/bot/settings", {
  method: "PUT",
  headers: { Authorization: `Bearer ${fcApiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ whatsapp_jid: selectedUserJid, start_hour: 7, end_hour: 22 }),
});
```

(Ajuste campos ao contrato exato da sua API Flashcards.)

### A6. Redeploy

Depois de alterar env no Vercel → **Redeploy** do projeto Flashcards.

---

## Parte B — Site Quiz / Papa Vagas (Vercel)

A rota `api/flashcards-whatsapp-users.js` já está neste repositório. Ela lê membros do grupo igual ao **Engajamento**.

### B1. Variáveis no Vercel (projeto Quiz — Papa Vagas)

Além das que você já tem (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TARGET_GROUP_JIDS`, …), adicione:

| Variável | Obrigatório | Valor |
|----------|-------------|--------|
| `FLASHCARDS_BOT_INBOUND_SECRET` | Sim | Token longo e aleatório (ex. 32+ caracteres) |

**Deve ser idêntico** a `QUIZ_BOT_USERS_SECRET` no app Flashcards.

Você **não** precisa de `FLASHCARDS_API_URL` nem `FLASHCARDS_API_KEY` no Vercel do quiz — isso é só na VPS.

### B2. Redeploy do site Quiz

1. **Push obrigatório:** a rota só existe no Vercel depois que o GitHub receber o commit com `api/flashcards-whatsapp-users.js`. No PC:

```powershell
cd "C:\Users\Daniel Ranna\Desktop\Concurso\chatbot quizz"
git push origin main
```

2. Aguarde o deploy automático no Vercel (ou **Deployments → Redeploy**).
3. Confirme que `FLASHCARDS_BOT_INBOUND_SECRET` está em **Environment Variables** do projeto Papa Vagas (Production).

### B3. Testar a rota (PowerShell no Windows)

**Não cole** as linhas com ` ``` ` do Markdown no terminal — isso gera erro `The term '``' is not recognized`.

Use **uma** destas opções (troque `SEU_SECRET` pelo valor real do Vercel):

**Opção A — `curl.exe`** (recomendado; no PowerShell `curl` sozinho é outro comando):

```powershell
curl.exe -s -H "Authorization: Bearer SEU_SECRET" "https://papa-vagas.vercel.app/api/flashcards-whatsapp-users"
```

**Opção B — `Invoke-RestMethod`:**

```powershell
$headers = @{ Authorization = "Bearer SEU_SECRET" }
Invoke-RestMethod -Uri "https://papa-vagas.vercel.app/api/flashcards-whatsapp-users" -Headers $headers
```

**Respostas possíveis:**

| Resposta | Significado |
|----------|-------------|
| `{"users":[...],"groupJid":"..."}` | OK |
| `{"error":"Unauthorized"}` | Secret errado ou header sem `Bearer ` |
| `{"error":"FLASHCARDS_BOT_INBOUND_SECRET nao configurado..."}` | Falta a env no Vercel + redeploy |
| `The page could not be found` / **NOT_FOUND** | Deploy antigo — faça `git push` e espere o Vercel terminar |

**Sanidade:** `/api/engagement` no mesmo domínio deve dar 200 (não pede Bearer). Se engagement funciona e flashcards dá NOT_FOUND, falta push/deploy do commit novo.

```powershell
curl.exe -s "https://papa-vagas.vercel.app/api/engagement"
```

---

## Parte C — Bot WhatsApp (VPS)

> **Não sabe Linux?** Use o guia linha a linha: [`VPS-ENV-FLASHCARDS-LINUX.md`](./VPS-ENV-FLASHCARDS-LINUX.md) (nano, `cd`, `git pull`, pm2, o que colar no `.env`).

### C1. Variáveis no `.env` da VPS

Arquivo `.env` na pasta do projeto **chatbot quizz** (mesmo do quiz).

**Já existentes (quiz)** — mantenha:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
TARGET_GROUP_JIDS=1203630XXXXXXXX@g.us
```

**Novas (flashcards)** — adicione:

```env
# URL base do APP FLASHCARDS (sem barra no final)
FLASHCARDS_API_URL=https://seu-app-flashcards.vercel.app

# Key gerada no app Flashcards (Configurações → Gerar API key)
FLASHCARDS_API_KEY=fc_xxxxxxxxxxxxxxxx

# Opcional: intervalo do poller (ms). Padrão 90000 (90s)
FLASHCARDS_POLL_MS=90000
```

**Não** é obrigatório na VPS:

- `FLASHCARDS_BOT_INBOUND_SECRET` — só o **Vercel do quiz** usa (rota de listar usuários). A VPS não lê essa variável.

Resumo:

| Variável | VPS | Vercel Quiz | Vercel Flashcards |
|----------|-----|-------------|-------------------|
| `SUPABASE_*` (quiz) | Sim | Sim | — |
| `TARGET_GROUP_JIDS` | Sim | Sim | — |
| `FLASHCARDS_API_URL` | Sim | Não | Não |
| `FLASHCARDS_API_KEY` | Sim | Não | Não |
| `FLASHCARDS_POLL_MS` | Opcional | Não | Não |
| `FLASHCARDS_BOT_INBOUND_SECRET` | Não | Sim | como `QUIZ_BOT_USERS_SECRET` |
| `QUIZ_BOT_USERS_URL` | Não | Não | Sim |

### C2. Atualizar código e reiniciar

Na VPS:

```bash
cd /caminho/chatbot-quizz
git pull
npm install
npm run build
# reinicie o processo (pm2, systemd, etc.)
npm start
# ou: pm2 restart chatbot-quizz
```

### C3. Conferir log ao conectar WhatsApp

Com QR escaneado, deve aparecer algo como:

```
Bot conectado no WhatsApp.
[caderno-scheduler] iniciado ...
[flashcards] ativo — API https://seu-app-flashcards.vercel.app, poll a cada 90s
```

Se aparecer:

```
[flashcards] desligado (defina FLASHCARDS_API_URL e FLASHCARDS_API_KEY no .env).
```

→ faltou env ou o processo não recarregou o `.env`.

---

## Parte D — WhatsApp (uma vez)

1. Bot conectado no grupo configurado em `TARGET_GROUP_JIDS`.
2. No **grupo**, envie: **`/sync-membros`**
3. Confirme resposta “Sincronizados N membros”.
4. (Opcional) No site Papa Vagas → **Engajamento** — deve listar nomes.

Sem sync, a lista do app Flashcards vem vazia.

---

## Parte E — Vincular você (sem número manual)

1. App Flashcards → Configurações → **Buscar contas do WhatsApp**.
2. Escolha seu nome (ex. “Daniel Ranna”).
3. Salve — o app grava seu `userJid` nas settings do bot (`whatsapp_jid`).
4. Confirme no app que `start_hour` / `end_hour` / timezone estão corretos.

O bot envia mensagens só para o JID salvo. Use o mesmo WhatsApp que você usa para falar com o bot no privado.

---

## Parte F — Testes

### F1. API Flashcards (da VPS)

Na VPS (substitua valores):

```bash
curl -s -H "Authorization: Bearer fc_SUA_KEY" \
  "https://seu-app-flashcards.vercel.app/api/flashcards/bot/settings"
```

Deve retornar JSON com `whatsapp_jid` preenchido.

### F2. Lista de usuários (Vercel quiz)

```powershell
curl.exe -s -H "Authorization: Bearer SEU_SECRET" "https://papa-vagas.vercel.app/api/flashcards-whatsapp-users"
```

### F3. Fluxo real

| Passo | Ação | Resultado esperado |
|-------|------|-------------------|
| 1 | Esperar `start_hour` ou ajustar hora nas settings para “agora” | Lembrete no **privado** |
| 2 | Responder **SIM** | “Ok! Vou enviar os cards…” |
| 3 | Esperar poll (até ~90s) ou ter card `due` | Pergunta (texto/imagem) |
| 4 | Qualquer mensagem | Verso + pedido 1–4 |
| 5 | Enviar **3** | “Avaliacao registrada (3)” |

### F4. Quiz continua separado

- Grupo: caderno / questões normais.
- Privado com `/quiz`: criação de questões.
- Flashcards só “toma” o privado quando há lembrete SIM pendente ou card aberto.

---

## Problemas comuns

| Sintoma | Causa provável | Correção |
|---------|----------------|----------|
| `[flashcards] desligado` | Env na VPS | `FLASHCARDS_API_URL` + `FLASHCARDS_API_KEY` + restart |
| Lista WhatsApp vazia | Sem membros sync | `/sync-membros` no grupo |
| 401 na lista de usuários | Secrets diferentes | `FLASHCARDS_BOT_INBOUND_SECRET` = `QUIZ_BOT_USERS_SECRET` |
| NOT_FOUND na URL flashcards | Código não deployado | `git push origin main` + redeploy Vercel |
| Erro `` ` `` no PowerShell | Colou markdown | Use só o comando dentro do bloco, sem backticks |
| Bot não manda no privado | JID errado / vazio | Salvar `whatsapp_jid` no app Flashcards |
| Cards não saem | Fora da janela ou sem `due` | `end_hour`, cards agendados, sessão confirmada com SIM |
| SIM não funciona | Outro fluxo (omissas) | Responda só quando for mensagem do lembrete flashcards |

---

## Resumo “preciso editar .env?”

| Local | Editar? |
|-------|---------|
| **VPS** `.env` | **Sim** — `FLASHCARDS_API_URL`, `FLASHCARDS_API_KEY` (+ opcional `FLASHCARDS_POLL_MS`) |
| **Vercel Quiz** | **Sim** — `FLASHCARDS_BOT_INBOUND_SECRET` (e redeploy) |
| **Vercel Flashcards** | **Sim** — `QUIZ_BOT_USERS_URL`, `QUIZ_BOT_USERS_SECRET` (+ Supabase do app) |
| **App Flashcards (código)** | Botão que chama a URL do quiz e salva `userJid` nas settings |

Não use o mesmo `fc_...` no Vercel Flashcards como “secret do quiz” — são papéis diferentes:

- `fc_...` = bot VPS → API Flashcards  
- `FLASHCARDS_BOT_INBOUND_SECRET` = app Flashcards → API lista usuários no site Quiz  

---

## Arquivos úteis neste repo

| Arquivo | Função |
|---------|--------|
| `src/flashcards/bot.ts` | Scheduler + mensagens privadas |
| `src/flashcards/client.ts` | Chamadas à API Flashcards |
| `api/flashcards-whatsapp-users.js` | Lista nomes/JIDs para o app |
| `docs/flashcards-bot.md` | Referência técnica curta |

---

*Última atualização: integração flashcards separada do quiz/caderno.*
