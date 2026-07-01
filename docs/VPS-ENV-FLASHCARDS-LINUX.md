# VPS (Linux) — configurar `.env` do Flashcards passo a passo

Guia para quem **não mexe em Linux**. Você já conectou no servidor (tela `root@srv1656178:~#`). O WhatsApp no app Flashcards **já funcionou** — falta só o bot na VPS saber falar com o app.

---

## O que você vai fazer (resumo)

1. Achar a pasta do bot no servidor  
2. Abrir o arquivo `.env` com o editor **nano**  
3. **Não apagar** o que já existe — só **adicionar 2 ou 3 linhas** no final  
4. Salvar, atualizar o código (`git pull`), reiniciar o bot  
5. Ver no log se aparece `[flashcards] ativo`

---

## Passo 1 — Achar a pasta do projeto

No terminal (onde está `root@srv1656178:~#`), copie e cole **uma linha por vez**, Enter após cada uma.

### 1.1 Listar o que tem na pasta atual

```bash
ls
```

Procure um nome parecido com: `chatbot-quizz`, `chatbot`, `papa-vagas`, `quiz`.

### 1.2 Se não achar, procurar no servidor

```bash
find /root /home -maxdepth 4 -name "package.json" 2>/dev/null | head -20
```

Vai listar caminhos. O do bot costuma ser algo como:

- `/root/chatbot-quizz/package.json`  
- `/home/ubuntu/chatbot-quizz/package.json`

A **pasta do projeto** é onde está o `package.json` (sem incluir o nome `package.json`).

**Exemplo:** se apareceu `/root/chatbot-quizz/package.json`, a pasta é:

```bash
cd /root/chatbot-quizz
```

(Troque pelo caminho que o `find` mostrou.)

### 1.3 Confirmar que é o bot certo

```bash
pwd
ls
```

Deve ver coisas como: `package.json`, `src`, `api`, `public`, talvez `auth`, `dist`.

```bash
ls -la .env
```

- Se aparecer `.env` → ótimo, é aqui que edita.  
- Se disser "No such file" → veja o Passo 1.4.

### 1.4 Se não existir `.env`

```bash
ls -la .env.example
```

Se existir `.env.example`:

```bash
cp .env.example .env
nano .env
```

E preencha **tudo** (Supabase + grupo + flashcards). Se já rodava o quiz antes, o `.env` quase certeza existe em outra pasta — volte ao `find`.

---

## Passo 2 — Ver o que já tem no `.env` (não apague)

```bash
cat .env
```

Vai aparecer texto. Anote mentalmente que **já deve ter** algo assim (valores reais seus):

```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
TARGET_GROUP_JIDS=120363430266595679@g.us
```

**Não remova essas linhas.** O quiz e o caderno dependem delas.

---

## Passo 3 — Editar o `.env` com nano

```bash
nano .env
```

### Como usar o nano (só isso)

| Tecla | O que faz |
|-------|-----------|
| Setas | Mover o cursor |
| Digitar | Escrever normalmente |
| **Ctrl + O** | Salvar (vai pedir Enter para confirmar o nome do arquivo) |
| **Enter** | Confirmar o nome `.env` ao salvar |
| **Ctrl + X** | Sair do nano |

---

## Passo 4 — O que ADICIONAR no final do arquivo

Role até o **final** do `.env` (seta para baixo).

Adicione **linhas novas** (copie o modelo e **substitua** pelos seus valores reais):

```env

# ========== FLASHCARDS (app separado do quiz) ==========
# URL do SEU app Flashcards no Vercel — SEM barra no final da URL
FLASHCARDS_API_URL=https://COLOQUE-AQUI-SEU-APP-FLASHCARDS.vercel.app

# Opcional: a cada quantos ms o bot verifica cards / vinculos (90000 = 90 segundos)
FLASHCARDS_POLL_MS=90000

# NAO precisa mais FLASHCARDS_API_KEY na VPS para cada pessoa.
# Cada usuario vincula no app; o bot pede SIM no WhatsApp e guarda a fc_ key no Supabase.
```

### De onde tirar cada valor

| Linha | Onde pegar |
|-------|------------|
| `FLASHCARDS_API_URL` | Domínio do **app Flashcards** no Vercel. Ex.: `https://meu-flashcards.vercel.app` — abra o site no navegador e copie só o início até `.app` (sem `/` no final). |
| `FLASHCARDS_API_KEY` | No app Flashcards → **Configurações** → **Gerar API key** → copia algo que começa com `fc_`. |
| `FLASHCARDS_POLL_MS` | Pode deixar `90000` ou apagar a linha (usa padrão 90s). |

### O que **NÃO** colocar na VPS

Estas ficam no **Vercel**, não no servidor Linux:

- `FLASHCARDS_BOT_INBOUND_SECRET` → só no projeto **Papa Vagas** (Vercel)  
- `QUIZ_BOT_USERS_URL` / `QUIZ_BOT_USERS_SECRET` → só no projeto **Flashcards** (Vercel)

Na VPS: `FLASHCARDS_API_URL` + `FLASHCARDS_POLL_MS`. Para o app Flashcards sair de **pendente** após o SIM no WhatsApp, adicione também `FLASHCARDS_BOT_INBOUND_SECRET` (mesmo token do Vercel Papa Vagas / `QUIZ_BOT_USERS_SECRET` no app Flashcards).

### Exemplo preenchido (fictício)

```env
FLASHCARDS_API_URL=https://app-concurso.vercel.app
FLASHCARDS_BOT_INBOUND_SECRET=mesmo_token_do_VERCEL_PAPA_VAGAS_e_do_app_Flashcards
FLASHCARDS_API_KEY=fc_a1b2c3d4e5f6789012345678901234567890
FLASHCARDS_POLL_MS=90000
```

**Cuidado:**

- Sem espaços antes/depois do `=`  
- Sem aspas em volta dos valores  
- URL **sem** barra no final (`...vercel.app` e não `...vercel.app/`)  
- A key `fc_...` em **uma linha só** (não quebrar no meio)

Salvar: **Ctrl+O**, Enter, **Ctrl+X**.

---

## Passo 5 — Conferir se salvou certo

```bash
grep FLASHCARDS .env
```

Deve mostrar as 2 ou 3 linhas que você colocou. Se não mostrar nada, o nano não salvou — repita o Passo 3.

---

## Passo 6 — Atualizar o código do bot no servidor

Ainda na pasta do projeto (`pwd` deve ser a pasta do chatbot):

```bash
git pull origin main
```

Se pedir usuário/senha do GitHub, use seu token ou SSH como você já fazia.

Depois:

```bash
npm install
npm run build
```

Espere terminar sem erro vermelho grande.

---

## Passo 7 — Reiniciar o bot

Depende de como você ligou o bot. Tente **na ordem**:

### Opção A — PM2 (mais comum)

```bash
pm2 list
```

Se aparecer uma tabela com `chatbot`, `quiz`, `bot` ou similar:

```bash
pm2 restart all
pm2 logs --lines 30
```

(ou `pm2 restart NOME_DO_PROCESSO` em vez de `all`)

### Opção B — systemd (serviço)

```bash
systemctl list-units | grep -i bot
systemctl list-units | grep -i quiz
```

Se achar um nome, por exemplo `chatbot.service`:

```bash
systemctl restart chatbot
journalctl -u chatbot -n 40 --no-pager
```

### Opção C — Rodando na mão (screen/tmux)

Se você só deixou `npm start` aberto numa sessão, precisa **parar** (Ctrl+C naquela janela) e subir de novo:

```bash
cd /root/chatbot-quizz
npm start
```

(Use o caminho certo da sua pasta.)

---

## Passo 8 — Como saber se deu certo

No log, depois de conectar o WhatsApp, procure:

```
Bot conectado no WhatsApp.
[flashcards] ativo — API https://seu-app.vercel.app, poll a cada 90s
```

**Bom** = flashcards ligado.

Se aparecer:

```
[flashcards] desligado (defina FLASHCARDS_API_URL e FLASHCARDS_API_KEY no .env).
```

**Ruim** = falta env, typo na URL/key, ou o bot não foi reiniciado depois de salvar o `.env`.

---

## Passo 9 — Checklist rápido (você já fez o app)

| Item | Você |
|------|------|
| Vinculou WhatsApp no app Flashcards (nome na lista) | Sim |
| `whatsapp_jid` salvo nas settings do app | Confira no app |
| `FLASHCARDS_API_URL` no `.env` da VPS | Fazer agora |
| `FLASHCARDS_API_KEY` (`fc_...`) no `.env` da VPS | Fazer agora |
| `git pull` + `npm run build` + restart | Fazer agora |
| Log `[flashcards] ativo` | Conferir depois do restart |

---

## Erros comuns no Linux

| Problema | Solução |
|----------|---------|
| `nano: command not found` | `apt update && apt install -y nano` |
| `git pull` diz "not a git repository" | Você está na pasta errada — use o `find` do Passo 1.2 |
| Apagou linha do Supabase por acidente | Restaure do backup ou copie de novo do Vercel/local |
| Bot não lê env novo | Sempre **restart** pm2/systemd depois de editar `.env` |
| URL com barra final | Remova o `/` no fim de `FLASHCARDS_API_URL` |

---

## Teste rápido na VPS (opcional)

Com a key `fc_...` que está no `.env`:

```bash
curl -s -H "Authorization: Bearer SUA_FC_KEY_AQUI" "https://SEU-APP-FLASHCARDS.vercel.app/api/flashcards/bot/settings"
```

Deve voltar JSON com `whatsapp_jid` preenchido (o mesmo que você escolheu no app).

---

## Lembrete: reinício do servidor

Sua tela mostrou `*** System restart required ***`. Isso **não** é urgente para o `.env`, mas depois de tudo funcionando, em um horário tranquilo:

```bash
reboot
```

O bot volta se estiver no **pm2** com startup automático (`pm2 startup`). Se só rodava `npm start` manual, terá que subir de novo após o reboot.

---

## Ajuda: copiar e colar no SSH

- Clique direito no terminal SSH costuma **colar** (ou Shift+Insert).  
- **Ctrl+C** no Linux terminal = interrompe programa (não é “copiar”).  
- Copiar do Windows: Ctrl+C no texto; colar no SSH: botão direito.

---

*Depois disso, no horário do `start_hour` do app, o bot manda o lembrete no seu privado; você responde SIM e os cards começam a sair na janela do dia.*
