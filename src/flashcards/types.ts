export type FlashcardSide = {
  text: string | null;
  image_url: string | null;
};

export type FlashcardCard = {
  card_id: string;
  type: string;
  deck_name: string | null;
  front: FlashcardSide;
  on_reveal: FlashcardSide;
};

export type FlashcardPendingResponse = {
  should_remind: boolean;
  message_template?: string;
  card_ids?: string[];
};

export type FlashcardSession = {
  id: string;
  status?: string;
};

export type FlashcardDispatchDueItem = {
  dispatch_id: string;
  card: FlashcardCard | null;
};

export type FlashcardBotSettings = {
  start_hour?: number;
  end_hour?: number;
  timezone?: string;
  whatsapp_jid?: string | null;
  user_whatsapp_jid?: string | null;
  enabled?: boolean;
};
