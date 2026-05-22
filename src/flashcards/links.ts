import { createClient } from "@supabase/supabase-js";
import { config } from "../config";

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

export type FlashcardsLinkStatus = "pending_confirm" | "active" | "rejected";

export type FlashcardsWhatsappLink = {
  id: number;
  userJid: string;
  apiKey: string;
  displayLabel: string | null;
  status: FlashcardsLinkStatus;
  confirmationSentAt: string | null;
  confirmedAt: string | null;
};

function mapRow(row: Record<string, unknown>): FlashcardsWhatsappLink {
  return {
    id: Number(row.id),
    userJid: String(row.user_jid),
    apiKey: String(row.api_key),
    displayLabel: row.display_label != null ? String(row.display_label) : null,
    status: String(row.status) as FlashcardsLinkStatus,
    confirmationSentAt: row.confirmation_sent_at ? String(row.confirmation_sent_at) : null,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null
  };
}

export async function upsertFlashcardsLinkRequest(
  userJid: string,
  apiKey: string,
  displayLabel: string | null
): Promise<FlashcardsWhatsappLink> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("flashcards_whatsapp_links")
    .upsert(
      {
        user_jid: userJid,
        api_key: apiKey,
        display_label: displayLabel,
        status: "pending_confirm",
        confirmation_sent_at: null,
        confirmed_at: null,
        updated_at: now
      },
      { onConflict: "user_jid" }
    )
    .select("id, user_jid, api_key, display_label, status, confirmation_sent_at, confirmed_at")
    .single();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      throw new Error(
        "Tabela flashcards_whatsapp_links inexistente. Rode supabase-migration-flashcards-whatsapp-links.sql"
      );
    }
    throw new Error(`Erro ao gravar vinculo flashcards: ${error.message}`);
  }
  return mapRow(data as Record<string, unknown>);
}

export async function listFlashcardsLinksPendingConfirmationSend(): Promise<
  FlashcardsWhatsappLink[]
> {
  const { data, error } = await supabase
    .from("flashcards_whatsapp_links")
    .select("id, user_jid, api_key, display_label, status, confirmation_sent_at, confirmed_at")
    .eq("status", "pending_confirm")
    .is("confirmation_sent_at", null);

  if (error) throw new Error(`Erro ao listar vinculos pendentes: ${error.message}`);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

export async function markFlashcardsLinkConfirmationSent(id: number): Promise<void> {
  const { error } = await supabase
    .from("flashcards_whatsapp_links")
    .update({
      confirmation_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", id);
  if (error) throw new Error(`Erro ao marcar confirmacao enviada: ${error.message}`);
}

export async function setFlashcardsLinkStatus(
  userJid: string,
  status: FlashcardsLinkStatus
): Promise<FlashcardsWhatsappLink | null> {
  const patch: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString()
  };
  if (status === "active") patch.confirmed_at = new Date().toISOString();
  if (status === "rejected") patch.confirmed_at = null;

  const { data, error } = await supabase
    .from("flashcards_whatsapp_links")
    .update(patch)
    .eq("user_jid", userJid)
    .select("id, user_jid, api_key, display_label, status, confirmation_sent_at, confirmed_at")
    .maybeSingle();

  if (error) throw new Error(`Erro ao atualizar vinculo: ${error.message}`);
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function getFlashcardsLinkByUserJid(
  userJid: string
): Promise<FlashcardsWhatsappLink | null> {
  const { data, error } = await supabase
    .from("flashcards_whatsapp_links")
    .select("id, user_jid, api_key, display_label, status, confirmation_sent_at, confirmed_at")
    .eq("user_jid", userJid)
    .maybeSingle();

  if (error) throw new Error(`Erro ao buscar vinculo: ${error.message}`);
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function listActiveFlashcardsLinks(): Promise<FlashcardsWhatsappLink[]> {
  const { data, error } = await supabase
    .from("flashcards_whatsapp_links")
    .select("id, user_jid, api_key, display_label, status, confirmation_sent_at, confirmed_at")
    .eq("status", "active");

  if (error) throw new Error(`Erro ao listar vinculos ativos: ${error.message}`);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}
