# MVP Bot WhatsApp Quiz (Node.js + TypeScript + Baileys + Supabase)

Este bot roda em WhatsApp com fluxo guiado no privado para criar questoes e publicar no grupo automaticamente.

Fluxo MVP implementado:
- No **privado**, por padrao o bot **nao** interpreta comandos (evita misturar com conversas normais). Envie `/quiz` para ativar o modo (persistente no banco), `/quizoff` para desligar, `/ajuda` para o guia.
- Usuario envia no privado (com modo quiz ativo): `nova questao`
- Bot guia criacao (tipo, enunciado, gabarito, comentario opcional)
- Bot salva no Supabase, gera ID curto e publica no grupo configurado
- Usuarios respondem no privado (`a 182`, `c 182` etc.)
- Apenas 1 resposta por usuario por questao
- Comando `gabarito 182` funciona no grupo e no privado

## 1) Requisitos

- Node.js 20+
- Conta no Supabase
- WhatsApp no celular para escanear QR

## 2) Instalar dependencias

```bash
npm install
```

## 3) Configurar Supabase

1. Abra seu projeto no Supabase.
2. Vá em `SQL Editor`.
3. Execute o arquivo `supabase-schema.sql`.
   - Se voce ja tinha criado as tabelas na versao antiga, execute `supabase-migration-v2.sql` em vez do schema completo.
   - Para o modo `/quiz` no privado, a tabela `bot_user_quiz_mode` esta no schema; em banco ja existente rode tambem `supabase-migration-bot-user-quiz-mode.sql` se ainda nao existir.
4. Em `Project Settings > API`, copie:
   - `Project URL`
   - `service_role key`

## 4) Variaveis de ambiente

1. Copie `.env.example` para `.env`.
2. Preencha:

```env
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=COLE_AQUI_A_SERVICE_ROLE_KEY
TARGET_GROUP_JIDS=1203630XXXXXXXXX@g.us
```

Notas:
- `TARGET_GROUP_JIDS` aceita lista separada por virgula.
- Hoje o bot publica no primeiro grupo da lista.

## 5) Rodar em desenvolvimento

```bash
npm run dev
```

No primeiro start:
- o terminal mostrara QR;
- escaneie com o WhatsApp;
- a sessao sera salva localmente na pasta `auth/`.

## 6) Comandos do bot

### Modo quiz no privado (recomendado em numero pessoal)

| Comando | Efeito |
|---------|--------|
| `/quiz` | Liga o modo quiz **para este contato**, salva no Supabase e envia o **guia** de uso. |
| `/quizoff` | Desliga o modo; mensagens normais deixam de ser interpretadas como comandos. |
| `/ajuda` ou `guia` | Mostra o guia completo de novo (com modo ligado). |

| Onde | `/ajuda` |
|------|--------|
| **Grupo** | Mostra o **mesmo guia** no chat do grupo. |
| **Privado** (modo ligado) | Guia completo. |

Com o modo **desligado**, no privado o bot **nao responde** a nada exceto `/quiz`. No grupo, `gabarito`, `ranking` e `/ajuda` estao sempre disponiveis.

### Criar questao (privado, com modo quiz ativo)

1. `nova questao`
2. Tipo:
   - `1` = multipla escolha
   - `2` = certo ou errado
3. Enunciado (texto/imagem/print/PDF)
4. Gabarito:
   - multipla escolha: `A/B/C/D/E`
   - certo ou errado: `C` (certo) ou `E` (errado)
5. Comentario opcional (texto/imagem/PDF) ou `pular`

### Responder questao (privado)

- Multipla escolha: `a 182`, `b 182`, `c 182`, `d 182`, `e 182`
- Certo/Errado: `c 182` ou `e 182`
- Se tentar responder de novo, o bot pergunta se você quer alterar sua última resposta:
  - `sim` altera
  - `nao` mantém

### Ranking (grupo ou privado)

- Envie: `ranking`
- No grupo: conta acertos nas questoes daquele grupo.
- No privado: usa o grupo configurado em `TARGET_GROUP_JIDS`.
- Ordena por quantidade de acertos (maior primeiro).

### Resultado completo (grupo ou privado)

- `gabarito 182`
- Retorna:
  - gabarito correto
  - distribuicao de respostas
  - lista de quem acertou e errou
  - comentario do autor
  - reenvio da midia do comentario, se existir

## 7) Estrutura do projeto

```text
src/
  config.ts          # env + grupos de destino
  help-text.ts       # guia /quiz e referencia rapida
  index.ts           # fluxo principal e wizard de criacao
  message-utils.ts   # parser de comandos e validacoes
  supabase.ts        # DB + upload em Supabase Storage
  types.ts           # tipos do dominio
supabase-schema.sql  # schema completo
supabase-migration-bot-user-quiz-mode.sql  # apenas tabela modo quiz (legado)
TUTORIAL_GRUPO.md        # texto para colar no grupo (tutorial usuarios)
```

## 8) Proximos passos recomendados

- Criar endpoint/script para ranking por usuario.
- Adicionar fechamento de questao e prazo de resposta.
- Publicar em multiplos grupos simultaneamente.
- Deploy (Railway/Render) com volume para pasta `auth`.

## 9) Troubleshooting rapido

- **Erro de variavel de ambiente ausente**: confira `.env`.
- **Bot nao conecta**: delete `auth/` e escaneie QR novamente.
- **Nao salva no banco**: valide `SUPABASE_URL` e `SERVICE_ROLE_KEY`.
- **Nao publica no grupo**: confira `TARGET_GROUP_JIDS` e se o bot esta no grupo.
