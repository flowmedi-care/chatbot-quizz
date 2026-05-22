-- Vínculo WhatsApp ↔ conta Flashcards (API key por pessoa, confirmação SIM/NÃO no privado).
-- URL/poll do app ficam no .env da VPS; cada usuário traz sua fc_ key ao vincular no app.

create table if not exists public.flashcards_whatsapp_links (
  id bigserial primary key,
  user_jid text not null,
  api_key text not null,
  display_label text,
  status text not null default 'pending_confirm'
    check (status in ('pending_confirm', 'active', 'rejected')),
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists flashcards_whatsapp_links_user_jid_key
  on public.flashcards_whatsapp_links (user_jid);

create index if not exists flashcards_whatsapp_links_status_idx
  on public.flashcards_whatsapp_links (status);
