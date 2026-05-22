# Flashcards × Bot WhatsApp (integração separada do quiz)

O módulo **não** usa tabelas de questões/cadernos do Papa Vagas. Ele só:

1. Chama a API do seu app Flashcards (`FLASHCARDS_API_URL` + `FLASHCARDS_API_KEY`)
2. Envia mensagens no **privado** do WhatsApp vinculado em `settings.whatsapp_jid`

## Variáveis no `.env` do bot (VPS)

```env
# App Flashcards (Vercel)
FLASHCARDS_API_URL=https://seu-app-flashcards.vercel.app
FLASHCARDS_API_KEY=fc_xxxxxxxx

# Poll de cards (ms, padrão 90000)
FLASHCARDS_POLL_MS=90000

# Segredo para o app Flashcards listar usuários do grupo (sem digitar telefone)
FLASHCARDS_BOT_INBOUND_SECRET=gere_um_token_longo_aleatorio
```

Sem `FLASHCARDS_API_URL` + `FLASHCARDS_API_KEY`, o bot ignora flashcards (quiz segue normal).

## Vincular usuário (sem número manual)

No app Flashcards, botão **“Buscar contas do WhatsApp”**:

```http
GET https://SEU-BOT.vercel.app/api/flashcards-whatsapp-users
Authorization: Bearer <FLASHCARDS_BOT_INBOUND_SECRET>
```

Resposta:

```json
{
  "groupJid": "1203630…@g.us",
  "users": [
    { "userJid": "5511999…@s.whatsapp.net", "displayLabel": "Daniel Ranna", "engaged": true },
    { "userJid": "176518…@lid", "displayLabel": "Caio L.", "engaged": false }
  ],
  "hint": "Rode /sync-membros no grupo do WhatsApp se a lista estiver vazia."
}
```

Salve o `userJid` escolhido no app (campo `whatsapp_jid` / `user_whatsapp_jid` em `PUT /api/flashcards/bot/settings`).

Lista = mesma base do **Engajamento** (`group_member_engagement` + nomes de respostas/questões).

## Fluxo no privado

| Etapa | Bot |
|--------|-----|
| `start_hour` | `GET /pending` → mensagem + `POST /sessions` → aguarda **SIM** / **NÃO** |
| SIM | `POST /sessions/:id/confirm` |
| Janela do dia | `GET /dispatch/due` → envia frente do card → `POST /dispatch/:id/sent` |
| Qualquer texto | Mostra verso + pede nota **1–4** |
| 1–4 | `POST /dispatch/:id/answer` |

Comandos do quiz (`/quiz`, `nova questao`, etc.) não são afetados; flashcards tem prioridade só quando há sessão/card ativo ou SIM/NÃO pendente.

## Deploy

- **Bot:** VPS com `npm run build && npm start` (este repositório).
- **API de usuários:** mesma URL do site Vercel do quiz (`/api/flashcards-whatsapp-users`) ou proxy para o mesmo projeto.

No app Flashcards, configure também:

```env
QUIZ_BOT_USERS_URL=https://seu-quiz.vercel.app/api/flashcards-whatsapp-users
QUIZ_BOT_USERS_SECRET=<mesmo FLASHCARDS_BOT_INBOUND_SECRET>
```
