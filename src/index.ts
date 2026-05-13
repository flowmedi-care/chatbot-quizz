import makeWASocket, {
  downloadMediaMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
  WAMessage,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import P from "pino";
import qrcode from "qrcode-terminal";
import {
  buildDistributionKeys,
  buildOptionsLabel,
  extractText,
  hasSupportedMedia,
  isSlashSessionCommand,
  isSkipCommand,
  isValidUserAnswer,
  normalizeInput,
  parseAnswerKeyByType,
  parseCadernoCommand,
  parsePrivateCommand,
  parseGabaritoCommand,
  parseOmissasCommand,
  parseProgressoCommand,
  parseRepeatQuestionCommand,
  parseRespondentsCommand,
  parseSlashSessionCommand,
  parseSyncMembrosCommand,
  parseTypeSelection
} from "./message-utils";
import { buildQuizFullGuide, buildPrivateInvalidFallback } from "./help-text";
import { config } from "./config";
import {
  createQuestion,
  formatRankingMessage,
  getCadernoById,
  getCadernoProgress,
  getQuestionResult,
  getRankingForGroup,
  getQuestionForRepeat,
  getEngagedUserJidsForGroup,
  getQuestionCreatorAndGroup,
  getQuestionTargetGroupJid,
  getQuizModePrivate,
  insertAnswer,
  getUserAnswer,
  listAnswerUserJidsForQuestion,
  listCadernosForOwner,
  listUnansweredShortIdsForUser,
  resetCadernoPublishedQuestions,
  setCadernoStatus,
  setQuizModePrivate,
  updateUserAnswer,
  upsertGroupMembersFromSync
} from "./supabase";
import { computeNextRunAt, formatNextRunPretty } from "./schedule";
import { forceRunCaderno, startCadernoScheduler, stopCadernoScheduler } from "./caderno-scheduler";
import { MediaPayload, QuestionDraft, QuestionType } from "./types";

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "bigint") {
    return new Date(Number(value) * 1000).toISOString();
  }
  if (value && typeof value === "object" && "toNumber" in value) {
    const numeric = (value as { toNumber: () => number }).toNumber();
    return new Date(numeric * 1000).toISOString();
  }
  return new Date().toISOString();
}

function isPrivateChatJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

/**
 * JID do usuario que enviou a mensagem.
 * - No privado: sempre `remoteJid` (participant em DM pode ser lixo e une varias pessoas).
 * - No grupo: tenta `participantAlt` / `remoteJidAlt` (WhatsApp multi-device) e depois `participant`.
 *   Se faltar tudo, cai em `remoteJid` (id do grupo — nao e pessoa; comandos podem falhar).
 */
function resolveActorJid(remoteJid: string, key: WAMessage["key"]): string {
  if (!remoteJid.endsWith("@g.us")) {
    return remoteJid;
  }

  const ext = key as WAMessage["key"] & {
    participantAlt?: string;
    remoteJidAlt?: string;
  };

  const candidates = [ext.participantAlt, ext.remoteJidAlt, key.participant];
  for (const c of candidates) {
    if (c && typeof c === "string" && !c.endsWith("@g.us")) {
      return c;
    }
  }

  return remoteJid;
}

type CreationSession =
  | { stage: "awaiting_type" }
  | { stage: "awaiting_statement"; questionType: QuestionType }
  | { stage: "awaiting_answer_key"; draft: Omit<QuestionDraft, "answerKey" | "explanationText" | "explanationMedia"> }
  | { stage: "awaiting_explanation"; draft: Omit<QuestionDraft, "explanationText" | "explanationMedia"> };

const creationSessions = new Map<string, CreationSession>();
let isStarting = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let activeSocketInstance = 0;
type PendingChange = {
  questionId: string;
  newAnswerLetter: string;
};
const pendingAnswerChanges = new Map<string, PendingChange>();

/** Privado: lista de short_ids apos /omissas; usuario confirma sim para receber enunciados. */
const omissasOfferByUser = new Map<string, string[]>();

const autoGabaritoPostedQuestionIds = new Set<string>();

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jidComparableKey(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) return jid.toLowerCase().trim();
  const userPart = jid.slice(0, at);
  const userNoDevice = userPart.includes(":") ? userPart.split(":")[0]! : userPart;
  const domain = jid.slice(at + 1).toLowerCase();
  return `${userNoDevice}@${domain}`;
}

function participantHasMatchingAnswer(memberJid: string, answeredUserJids: string[]): boolean {
  const pk = jidComparableKey(memberJid);
  for (const a of answeredUserJids) {
    if (a === memberJid) return true;
    if (jidComparableKey(a) === pk) return true;
  }
  return false;
}

function getBotJidComparable(sock: WASocket): string | null {
  const ext = sock as WASocket & {
    user?: { id?: string };
    authState?: { creds?: { me?: { id?: string } } };
  };
  const rawId = ext.user?.id ?? ext.authState?.creds?.me?.id ?? "";
  return rawId ? jidComparableKey(String(rawId)) : null;
}

async function fetchGroupParticipantIds(sock: WASocket, groupJid: string): Promise<string[]> {
  const meta = await sock.groupMetadata(groupJid);
  const parts = meta.participants as { id?: string }[];
  return parts.map((p) => String(p.id || "")).filter(Boolean);
}

async function maybePostAutoGabaritoToGroup(sock: WASocket, rawShortId: string): Promise<void> {
  const shortUp = rawShortId.toUpperCase();

  try {
    if (!config.autoGabaritoWhenAllReply) return;
    if (autoGabaritoPostedQuestionIds.has(shortUp)) return;

    const meta = await getQuestionCreatorAndGroup(shortUp);
    if (!meta) return;

    const { targetGroupJid: groupJid, creatorJid } = meta;
    const isPrivateQuizTarget =
      groupJid.endsWith("@s.whatsapp.net") || groupJid.endsWith("@lid");

    if (isPrivateQuizTarget) {
      const answered = await listAnswerUserJidsForQuestion(shortUp);
      const expectJid = groupJid;
      const pk = jidComparableKey(expectJid);
      const answeredComparable = answered.map((j) => jidComparableKey(j));
      const selfAnswered = answeredComparable.some((jc) => jc === pk);
      if (!selfAnswered) return;

      autoGabaritoPostedQuestionIds.add(shortUp);
      const result = await getQuestionResult(shortUp);
      const header = "[Resposta registrada]\nResultado enviado automaticamente (caderno privado).\n";
      await sock.sendMessage(groupJid, {
        text: `${header}${buildResultMessage(result)}`
      });
      await sendExplanationMedia(sock, groupJid, result);
      return;
    }

    const engaged = await getEngagedUserJidsForGroup(groupJid);
    if (engaged.length === 0) {
      console.log(
        "[auto-gabarito] Nenhum membro engajado no grupo. Rode /sync-membros no grupo e marque engajados no site."
      );
      return;
    }

    const answered = await listAnswerUserJidsForQuestion(shortUp);
    const botComp = getBotJidComparable(sock);
    const creatorComp = jidComparableKey(creatorJid);

    const expectAnswer = engaged.filter((jid) => {
      const jc = jidComparableKey(jid);
      if (botComp && jc === botComp) return false;
      if (jc === creatorComp) return false;
      return true;
    });

    if (expectAnswer.length === 0) {
      console.log(
        "[auto-gabarito] Só o criador (ou só o bot) entre os engajados; não há 'outros' para fechar — use /gabarito manual se quiser."
      );
      return;
    }

    const allAnswered = expectAnswer.every((m) => participantHasMatchingAnswer(m, answered));
    if (!allAnswered) return;

    autoGabaritoPostedQuestionIds.add(shortUp);

    const result = await getQuestionResult(shortUp);
    const header = "[Engajados responderam]\nResultado enviado automaticamente.\n";
    await sock.sendMessage(groupJid, {
      text: `${header}${buildResultMessage(result)}`
    });
    await sendExplanationMedia(sock, groupJid, result);
  } catch (e) {
    console.warn("[auto-gabarito]", (e as Error).message);
  }
}

async function buildRespondentsReport(sock: WASocket, rawShortId: string): Promise<string> {
  const result = await getQuestionResult(rawShortId);
  const namesOrdered = [...result.correctUsers, ...result.wrongUsers];

  let totalEligible = 0;
  try {
    const gj = await getQuestionTargetGroupJid(result.shortId);
    if (gj) {
      const memberIds = await fetchGroupParticipantIds(sock, gj);
      const botComp = getBotJidComparable(sock);
      totalEligible = botComp
        ? memberIds.filter((jid) => jidComparableKey(jid) !== botComp).length
        : memberIds.length;
    }
  } catch {
    // sem total do grupo — ainda assim mostra lista
  }

  if (namesOrdered.length === 0) {
    const extra =
      totalEligible > 0 ? ` (~${totalEligible} pessoas no grupo com o bot)` : "";
    return `Ninguem respondeu a questao #${result.shortId} ainda.${extra}\nResponderam no privado com: a ${result.shortId} (ou outra letra).`;
  }

  const countPart =
    totalEligible > 0
      ? ` (${namesOrdered.length}/${totalEligible} no grupo responderam)`
      : ` (${namesOrdered.length} resposta/s registrada/s)`;

  const lines = [
    `Respondentes da questao #${result.shortId}${countPart}`,
    "",
    ...namesOrdered.map((name, idx) => `${idx + 1}. ${name}`),
    "",
    `Resultado completo: /gabarito ${result.shortId}`
  ];
  return lines.join("\n");
}

function getDisplayName(msg: WAMessage, fallbackJid: string): string {
  return (msg.pushName && msg.pushName.trim()) || fallbackJid.split("@")[0];
}

/**
 * Grupo do quiz (publicar no grupo + gravar `target_group_jid` no Supabase).
 * Se houver **dois ou mais** JIDs em `TARGET_GROUP_JIDS`, usa o **segundo** —
 * o primeiro pode ficar na env para outro uso (reservado).
 * Com apenas um JID, usa esse (comportamento antigo).
 */
function getQuizTargetGroupJid(): string {
  if (config.targetGroupJids.length === 0) {
    throw new Error("Configure TARGET_GROUP_JIDS no .env para publicar as questoes.");
  }
  if (config.targetGroupJids.length >= 2) {
    return config.targetGroupJids[1];
  }
  return config.targetGroupJids[0];
}

function extractFileExtension(mimeType: string): string {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("webp")) return "webp";
  return "bin";
}

async function extractMediaPayload(sock: WASocket, msg: WAMessage): Promise<MediaPayload | null> {
  if (!hasSupportedMedia(msg)) return null;
  const mimeType = msg.message?.imageMessage?.mimetype ?? msg.message?.documentMessage?.mimetype;
  if (!mimeType) return null;
  const stream = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    { logger: P({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
  );
  const data = Buffer.isBuffer(stream) ? stream : Buffer.from(stream as ArrayBuffer);
  return {
    data,
    mimeType,
    fileExt: extractFileExtension(mimeType)
  };
}

async function publishQuestionToGroup(
  sock: WASocket,
  groupJid: string,
  shortId: string,
  draft: QuestionDraft
): Promise<void> {
  const intro = `Nova questao #${shortId} enviada por ${draft.creatorName}`;
  const options =
    draft.questionType === "true_false"
      ? `Responda no privado do bot:\nc ${shortId}\ne ${shortId}`
      : `Responda no privado do bot:\na ${shortId}\nb ${shortId}\nc ${shortId}\nd ${shortId}\ne ${shortId}`;

  const statementText = draft.statementText ? `\n\n${draft.statementText}` : "";

  if (draft.statementMedia) {
    if (draft.statementMedia.mimeType.startsWith("image/")) {
      await sock.sendMessage(groupJid, {
        image: draft.statementMedia.data,
        caption: `${intro}${statementText}\n\n${options}`
      });
      return;
    }

    await sock.sendMessage(groupJid, {
      document: draft.statementMedia.data,
      mimetype: draft.statementMedia.mimeType,
      fileName: `questao-${shortId}.${draft.statementMedia.fileExt}`,
      caption: `${intro}${statementText}\n\n${options}`
    });
    return;
  }

  await sock.sendMessage(groupJid, {
    text: `${intro}${statementText}\n\n${options}`
  });
}

function buildResultMessage(result: Awaited<ReturnType<typeof getQuestionResult>>): string {
  const keys = buildDistributionKeys(result.questionType);
  const distributionLines = keys.map((key) => `${key} - ${result.distribution[key] ?? 0}`);
  const correct = result.correctUsers.length ? result.correctUsers.join(", ") : "Ninguem";
  const wrong = result.wrongUsers.length ? result.wrongUsers.join(", ") : "Ninguem";

  const hasExplanation = Boolean(result.explanationText && result.explanationText.trim().length > 0);
  const hasExplanationMedia = Boolean(result.explanationMediaUrl && result.explanationMediaMimeType);
  let explanationBlock = "Sem comentario.";
  if (hasExplanation) {
    explanationBlock = result.explanationText ?? "Sem comentario.";
  } else if (hasExplanationMedia) {
    explanationBlock = "(veja a midia abaixo)";
  }

  return [
    `Resultado da Questao #${result.shortId}`,
    "",
    `Gabarito: ${result.answerKey}`,
    "",
    "Distribuicao:",
    ...distributionLines,
    "",
    "Acertaram:",
    correct,
    "",
    "Erraram:",
    wrong,
    "",
    "Comentario do autor:",
    explanationBlock
  ].join("\n");
}

async function sendExplanationMedia(
  sock: WASocket,
  jid: string,
  result: Awaited<ReturnType<typeof getQuestionResult>>
): Promise<void> {
  if (!result.explanationMediaUrl || !result.explanationMediaMimeType) return;

  if (result.explanationMediaMimeType.startsWith("image/")) {
    await sock.sendMessage(jid, { image: { url: result.explanationMediaUrl } });
    return;
  }

  await sock.sendMessage(jid, {
    document: { url: result.explanationMediaUrl },
    mimetype: result.explanationMediaMimeType,
    fileName: "comentario-questao"
  });
}

function mimeToStatementFileExt(mimeType: string): string {
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "bin";
}

async function repeatQuestionStatement(sock: WASocket, jid: string, shortId: string): Promise<void> {
  const row = await getQuestionForRepeat(shortId);
  if (!row) {
    await sock.sendMessage(jid, { text: `Questao #${shortId.toUpperCase()} nao encontrada.` });
    return;
  }

  const header = `Questao #${row.shortId} (repeticao)\nPor: ${row.creatorName}`;
  const body = row.statementText?.trim() ?? "";

  if (row.statementMediaUrl && row.statementMediaMimeType) {
    const caption = [header, body].filter(Boolean).join("\n\n");
    if (row.statementMediaMimeType.startsWith("image/")) {
      await sock.sendMessage(jid, {
        image: { url: row.statementMediaUrl },
        caption
      });
      return;
    }

    await sock.sendMessage(jid, {
      document: { url: row.statementMediaUrl },
      mimetype: row.statementMediaMimeType,
      fileName: `questao-${row.shortId}.${mimeToStatementFileExt(row.statementMediaMimeType)}`,
      caption
    });
    return;
  }

  if (body) {
    await sock.sendMessage(jid, { text: `${header}\n\n${body}` });
    return;
  }

  await sock.sendMessage(jid, {
    text: `${header}\n(Sem enunciado armazenado para esta questao.)`
  });
}

async function buildCadernoProgressMessage(cadernoId: number): Promise<string> {
  const progress = await getCadernoProgress(cadernoId);
  if (!progress) {
    return `Caderno #${cadernoId} nao encontrado.`;
  }
  const { caderno, totalQuestions, publishedCount, resolvedByEngaged, withAnyAnswer, engagedCount } =
    progress;

  const pct = publishedCount === 0 ? 0 : Math.round((resolvedByEngaged / publishedCount) * 100);
  const pctLine =
    engagedCount > 0
      ? `Resolvidas pelos engajados: ${resolvedByEngaged}/${publishedCount} (${pct}%)`
      : `Resolvidas pelos engajados: — (nenhum engajado cadastrado, rode /sync-membros e marque no site)`;

  const lines = [
    `Progresso do Caderno #${caderno.id} — "${caderno.name}"`,
    "",
    `Status: ${caderno.status}`,
    `Modo: ${caderno.randomOrder ? "ordem aleatória" : "ordem do PDF"}`,
    "",
    `Total no caderno: ${totalQuestions}`,
    `Enviadas: ${publishedCount}/${totalQuestions}`,
    pctLine,
    `Com pelo menos 1 resposta: ${withAnyAnswer}/${publishedCount}`,
    `Engajados no grupo: ${engagedCount}`,
    "",
    `Próximo envio: ${formatNextRunPretty(caderno.nextRunAt, caderno.timezone)}`,
    `Último envio: ${formatNextRunPretty(caderno.lastRunAt, caderno.timezone)}`
  ];
  return lines.join("\n");
}

type CadernoCommandArg = ReturnType<typeof parseCadernoCommand>;

async function handleCadernoCommand(
  sock: WASocket,
  remoteJid: string,
  senderJid: string,
  cmd: NonNullable<CadernoCommandArg>
): Promise<void> {
  if (cmd.kind === "list") {
    const cadernos = await listCadernosForOwner(senderJid);
    if (cadernos.length === 0) {
      await sock.sendMessage(remoteJid, {
        text:
          "Voce nao tem cadernos cadastrados.\n" +
          "Abra o site Papa Vagas e use o botao 'Cadernos' para enviar um PDF do Tec Concursos."
      });
      return;
    }
    const lines = ["Seus cadernos:", ""];
    for (const c of cadernos) {
      const next = c.status === "active" ? formatNextRunPretty(c.nextRunAt, c.timezone) : "—";
      lines.push(
        `#${c.id} ${c.name}`,
        `  status: ${c.status}`,
        `  envio: ${c.questionsPerRun} questao(oes) a cada ${c.intervalDays} dia(s), ${pad2(c.sendHour)}:${pad2(c.sendMinute)} (${c.timezone})`,
        `  proximo: ${next}`,
        `  progresso: cursor ${c.cursor}`,
        ""
      );
    }
    lines.push(
      "Comandos:",
      "  /caderno pause <id>    /caderno resume <id>",
      "  /caderno next <id>     /caderno delete <id>",
      "  reciclar caderno <id>  desativar caderno <id>"
    );
    await sock.sendMessage(remoteJid, { text: lines.join("\n") });
    return;
  }

  const caderno = await getCadernoById(cmd.id);
  if (!caderno) {
    await sock.sendMessage(remoteJid, { text: `Caderno #${cmd.id} nao encontrado.` });
    return;
  }
  if (caderno.createdByJid && caderno.createdByJid !== senderJid) {
    await sock.sendMessage(remoteJid, {
      text: `Voce nao e o dono do caderno #${cmd.id}.`
    });
    return;
  }

  switch (cmd.kind) {
    case "pause": {
      await setCadernoStatus(caderno.id, "inactive", { nextRunAt: null });
      await sock.sendMessage(remoteJid, {
        text: `Caderno #${caderno.id} ("${caderno.name}") pausado. Use /caderno resume ${caderno.id} para retomar.`
      });
      return;
    }
    case "resume": {
      const nextIso = computeNextRunAt(
        new Date(),
        caderno.sendHour,
        caderno.sendMinute,
        caderno.timezone,
        0
      ).toISOString();
      await setCadernoStatus(caderno.id, "active", { nextRunAt: nextIso });
      await sock.sendMessage(remoteJid, {
        text: `Caderno #${caderno.id} retomado. Proximo envio: ${formatNextRunPretty(nextIso, caderno.timezone)}.`
      });
      return;
    }
    case "next": {
      await sock.sendMessage(remoteJid, {
        text: `Forçando envio agora do caderno #${caderno.id}…`
      });
      const fresh = await getCadernoById(caderno.id);
      if (fresh) await forceRunCaderno(sock, fresh);
      return;
    }
    case "recycle": {
      await resetCadernoPublishedQuestions(caderno.id);
      const nextIso = computeNextRunAt(
        new Date(),
        caderno.sendHour,
        caderno.sendMinute,
        caderno.timezone,
        0
      ).toISOString();
      await setCadernoStatus(caderno.id, "active", { nextRunAt: nextIso, cursor: 0 });
      await sock.sendMessage(remoteJid, {
        text: `Caderno #${caderno.id} reiniciado do começo. Próximo envio: ${formatNextRunPretty(nextIso, caderno.timezone)}.`
      });
      return;
    }
    case "deactivate": {
      await setCadernoStatus(caderno.id, "finished", { nextRunAt: null });
      await sock.sendMessage(remoteJid, {
        text: `Caderno #${caderno.id} encerrado.`
      });
      return;
    }
    case "delete": {
      await sock.sendMessage(remoteJid, {
        text:
          `Para excluir o caderno #${caderno.id}, use o site Papa Vagas (botao "Excluir").\n` +
          "O bot nao apaga cadernos pelo chat por seguranca."
      });
      return;
    }
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

async function startBot(): Promise<void> {
  if (isStarting) return;
  isStarting = true;
  activeSocketInstance += 1;
  const instanceId = activeSocketInstance;

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (instanceId !== activeSocketInstance) {
      return;
    }

    if (qr) {
      console.log("QR recebido. Escaneie no WhatsApp.");
      qrcode.generate(qr, { small: true });
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qr)}`;
      console.log("Se nao visualizar o QR no terminal, abra este link:");
      console.log(qrUrl);
    }

    if (connection === "close") {
      stopCadernoScheduler();
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
        ?.statusCode;
      const reason = (lastDisconnect?.error as Error | undefined)?.message ?? "sem motivo";
      const nonReconnectStatuses = new Set<number>([
        DisconnectReason.loggedOut,
        DisconnectReason.connectionReplaced,
        DisconnectReason.badSession,
        440 /** Stream erro (conflict): outra instancia usando a mesma sessao WhatsApp */
      ]);
      const shouldReconnect = statusCode ? !nonReconnectStatuses.has(statusCode) : true;
      console.log(
        `Conexao fechada (instancia ${instanceId}). status=${statusCode ?? "n/a"} motivo=${reason}. Reconectar: ${shouldReconnect}`
      );
      isStarting = false;

      if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
        console.log(
          "Conflito de sessao detectado (440). Feche outras sessoes do bot, apague a pasta auth e pareie novamente."
        );
      }

      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void startBot();
        }, 1500);
      }
    }

    if (connection === "open") {
      console.log(`Bot conectado no WhatsApp. (instancia ${instanceId})`);
      isStarting = false;
      startCadernoScheduler(sock);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.key.remoteJid || !msg.message) continue;

        const text = extractText(msg);
        const repeatQuestionCmd = parseRepeatQuestionCommand(text);
        if (
          msg.key.fromMe &&
          !isSlashSessionCommand(text) &&
          !repeatQuestionCmd &&
          !parseGabaritoCommand(text)
        ) {
          continue;
        }

        const remoteJid = msg.key.remoteJid;
        const fromGroup = remoteJid.endsWith("@g.us");
        const fromPrivate = isPrivateChatJid(remoteJid);
        const messageId = msg.key.id ?? "sem_id";
        const resolvedActor = resolveActorJid(remoteJid, msg.key);
        /** Evita \"\" com participant vazio ou edge cases LID (`??` não substitui string vazia). */
        const sender = resolvedActor.trim().length > 0 ? resolvedActor : remoteJid;
        if (fromGroup && sender.endsWith("@g.us")) {
          console.warn(
            "[msg] Grupo sem participant resolvido para este evento; comandos podem ser ignorados. id=",
            messageId
          );
        }
        const sentAt = toIsoTimestamp(msg.messageTimestamp);
        const messageKind = fromGroup ? "grupo" : fromPrivate ? "privado" : "outro";

        console.log(
          `[msg] tipo=${messageKind} remote=${remoteJid} sender=${sender} id=${messageId} texto="${text || "(sem texto)"}"`
        );

        if (repeatQuestionCmd && (fromGroup || fromPrivate)) {
          await repeatQuestionStatement(sock, remoteJid, repeatQuestionCmd.shortId);
          continue;
        }

        if (fromGroup && parseSyncMembrosCommand(text)) {
          try {
            const metaGm = await sock.groupMetadata(remoteJid);
            const parts = metaGm.participants as { id?: string; name?: string; notify?: string }[];
            const members = parts
              .map((p) => {
                const id = String(p.id || "");
                if (!id || id.endsWith("@g.us")) return null;
                const label =
                  (p.name && String(p.name).trim()) ||
                  (p.notify && String(p.notify).trim()) ||
                  id.split("@")[0] ||
                  id;
                return { userJid: id, userLabel: label };
              })
              .filter(Boolean) as { userJid: string; userLabel: string }[];
            await upsertGroupMembersFromSync(remoteJid, members);
            await sock.sendMessage(remoteJid, {
              text: [
                `Sincronizados ${members.length} membros.`,
                "No site Papa Vagas, abra Engajamento e marque quem participa do fechamento automático do gabarito.",
                "O bot posta o resultado quando todos os engajados (exceto quem criou a questão) responderem."
              ].join("\n")
            });
          } catch (syncErr) {
            await sock.sendMessage(remoteJid, {
              text: `Erro ao sincronizar: ${(syncErr as Error).message}`
            });
          }
          continue;
        }

        let quizModePrivateEnabled = false;
        if (fromPrivate) {
          const omissasWaitingEarly = omissasOfferByUser.get(sender);
          if (omissasWaitingEarly) {
            const normalizedOm = normalizeInput(text);
            if (normalizedOm === "sim" || normalizedOm === "s") {
              omissasOfferByUser.delete(sender);
              for (const sid of omissasWaitingEarly) {
                await repeatQuestionStatement(sock, remoteJid, sid);
                await delayMs(650);
              }
              await sock.sendMessage(remoteJid, {
                text: "Responda com letra + número (ex: c 12). Use /gabarito 12 para ver o resultado completo."
              });
              continue;
            }
            if (normalizedOm === "nao" || normalizedOm === "não" || normalizedOm === "n") {
              omissasOfferByUser.delete(sender);
              await sock.sendMessage(remoteJid, { text: "Ok." });
              continue;
            }
            await sock.sendMessage(remoteJid, {
              text: 'Responda "sim" para receber os enunciados aqui ou "nao" para cancelar.'
            });
            continue;
          }

          quizModePrivateEnabled = await getQuizModePrivate(sender);
          const slashPriv = parseSlashSessionCommand(text);

          if (!quizModePrivateEnabled) {
            if (slashPriv === "quiz") {
              await setQuizModePrivate(sender, true);
              quizModePrivateEnabled = true;
              await sock.sendMessage(remoteJid, { text: buildQuizFullGuide() });
              continue;
            }
            if (slashPriv === "help") {
              await sock.sendMessage(remoteJid, {
                text: [
                  "Para usar comandos aqui no privado (criar/responder questoes), ative:",
                  "",
                  "/quiz",
                  "",
                  "Sem modo quiz, só lemos aqui comandos neutros: gabarito, ranking, quem respondeu e /omissas."
                ].join("\n")
              });
              continue;
            }
            if (slashPriv === "quizoff") {
              await sock.sendMessage(remoteJid, {
                text: 'O modo quiz no privado ja esta desligado. Para ativar: envie /quiz.'
              });
              continue;
            }

            const passiveProbe = parsePrivateCommand(text);
            const respondentIdProbe = parseRespondentsCommand(text);
            const passiveReadOnly =
              passiveProbe.kind === "ranking" ||
              passiveProbe.kind === "answer_key" ||
              Boolean(respondentIdProbe) ||
              parseOmissasCommand(text);

            if (!passiveReadOnly) {
              continue;
            }
          } else {
            if (slashPriv === "quizoff") {
              await setQuizModePrivate(sender, false);
              creationSessions.delete(sender);
              pendingAnswerChanges.delete(sender);
              await sock.sendMessage(remoteJid, {
                text: [
                  "Modo quiz desligado.",
                  "Suas mensagens normais nao serao mais interpretadas como comandos.",
                  "Para ativar de novo no privado: /quiz"
                ].join("\n")
              });
              continue;
            }
            if (slashPriv === "help") {
              await sock.sendMessage(remoteJid, { text: buildQuizFullGuide() });
              continue;
            }
            if (slashPriv === "quiz") {
              await sock.sendMessage(remoteJid, {
                text: [
                  "Modo quiz ja esta ligado.",
                  "Guia completo: /ajuda",
                  "Para sair: /quizoff"
                ].join("\n")
              });
              continue;
            }
          }
        }

        if (fromGroup || fromPrivate) {
          if (parseSlashSessionCommand(text) === "help") {
            await sock.sendMessage(remoteJid, { text: buildQuizFullGuide() });
            continue;
          }

          const respondentQuestionId = parseRespondentsCommand(text);
          if (respondentQuestionId) {
            try {
              await sock.sendMessage(remoteJid, {
                text: await buildRespondentsReport(sock, respondentQuestionId)
              });
            } catch (respondErr) {
              await sock.sendMessage(remoteJid, {
                text: `Nao foi possivel listar respondentes: ${(respondErr as Error).message}`
              });
            }
            continue;
          }

          const progressoCmd = parseProgressoCommand(text);
          if (progressoCmd) {
            try {
              await sock.sendMessage(remoteJid, {
                text: await buildCadernoProgressMessage(progressoCmd.cadernoId)
              });
            } catch (progErr) {
              await sock.sendMessage(remoteJid, {
                text: `Erro ao consultar progresso: ${(progErr as Error).message}`
              });
            }
            continue;
          }

          if (fromPrivate) {
            const cadernoCmd = parseCadernoCommand(text);
            if (cadernoCmd) {
              try {
                await handleCadernoCommand(sock, remoteJid, sender, cadernoCmd);
              } catch (cadErr) {
                await sock.sendMessage(remoteJid, {
                  text: `Erro no comando de caderno: ${(cadErr as Error).message}`
                });
              }
              continue;
            }
          }

          if (fromPrivate && parseOmissasCommand(text)) {
            try {
              const gj = getQuizTargetGroupJid();
              const openIds = await listUnansweredShortIdsForUser(sender, gj, 30);
              if (openIds.length === 0) {
                await sock.sendMessage(remoteJid, {
                  text: "Voce nao tem questoes em aberto neste grupo (ou ja respondeu a todas)."
                });
                continue;
              }
              omissasOfferByUser.set(sender, openIds);
              const lines = [
                "Questoes que voce ainda nao respondeu:",
                "",
                ...openIds.map((id, i) => `${i + 1}. #${id}`),
                "",
                "Deseja receber os enunciados aqui? Responda sim ou nao."
              ];
              await sock.sendMessage(remoteJid, { text: lines.join("\n") });
            } catch (omErr) {
              await sock.sendMessage(remoteJid, {
                text: `Erro ao listar omissas: ${(omErr as Error).message}`
              });
            }
            continue;
          }

          const groupCommand = parsePrivateCommand(text);
          if (groupCommand.kind !== "unknown") {
            console.log(`[cmd] comando detectado em ${messageKind}:`, groupCommand);
          }
          if (groupCommand.kind === "answer_key") {
            const result = await getQuestionResult(groupCommand.questionId);
            await sock.sendMessage(remoteJid, { text: buildResultMessage(result) });
            await sendExplanationMedia(sock, remoteJid, result);
            continue;
          }

          if (groupCommand.kind === "ranking") {
            const groupJidForRanking = fromGroup ? remoteJid : getQuizTargetGroupJid();
            const entries = await getRankingForGroup(groupJidForRanking);
            await sock.sendMessage(remoteJid, { text: formatRankingMessage(entries) });
            continue;
          }
        }

        if (fromPrivate && quizModePrivateEnabled) {
          const pending = pendingAnswerChanges.get(sender);
          if (pending) {
            const normalized = normalizeInput(text);
            if (normalized === "sim" || normalized === "s") {
              await updateUserAnswer({
                questionShortId: pending.questionId,
                userJid: sender,
                userName: getDisplayName(msg, sender),
                answerLetter: pending.newAnswerLetter,
                sentAt,
                sourceMessageId: messageId
              });
              pendingAnswerChanges.delete(sender);
              await sock.sendMessage(remoteJid, { text: "Resposta atualizada ✅" });
              await maybePostAutoGabaritoToGroup(sock, pending.questionId);
              continue;
            }

            if (normalized === "nao" || normalized === "não" || normalized === "n") {
              pendingAnswerChanges.delete(sender);
              await sock.sendMessage(remoteJid, { text: "Ok, mantendo sua resposta anterior." });
              continue;
            }

            await sock.sendMessage(remoteJid, {
              text: 'Voce ja respondeu essa questao. Deseja alterar? Responda "sim" ou "nao".'
            });
            continue;
          }

          const activeSession = creationSessions.get(sender);

          if (activeSession?.stage === "awaiting_type") {
            const selectedType = parseTypeSelection(text);
            if (!selectedType) {
              await sock.sendMessage(remoteJid, { text: "Resposta invalida. Envie 1 ou 2." });
              continue;
            }
            creationSessions.set(sender, { stage: "awaiting_statement", questionType: selectedType });
            await sock.sendMessage(remoteJid, {
              text: [
                "Envie o enunciado da questao.",
                "Pode ser texto, imagem, print ou PDF."
              ].join("\n")
            });
            continue;
          }

          if (activeSession?.stage === "awaiting_statement") {
            const statementText = text || null;
            const statementMedia = await extractMediaPayload(sock, msg);
            if (!statementText && !statementMedia) {
              await sock.sendMessage(remoteJid, {
                text: "Envie um enunciado com texto, imagem ou PDF."
              });
              continue;
            }

            creationSessions.set(sender, {
              stage: "awaiting_answer_key",
              draft: {
                creatorJid: sender,
                creatorName: getDisplayName(msg, sender),
                questionType: activeSession.questionType,
                statementText,
                statementMedia
              }
            });

            const answerTip =
              activeSession.questionType === "true_false"
                ? 'Agora envie o gabarito: "C" (certo) ou "E" (errado).'
                : 'Agora envie o gabarito. Exemplo: "A".';
            await sock.sendMessage(remoteJid, { text: answerTip });
            continue;
          }

          if (activeSession?.stage === "awaiting_answer_key") {
            const answerKey = parseAnswerKeyByType(text, activeSession.draft.questionType);
            if (!answerKey) {
              const explain =
                activeSession.draft.questionType === "true_false"
                  ? "Envie apenas C (certo) ou E (errado). Voce pode escrever so a letra, ou palavras: certo / errado."
                  : 'Envie uma letra sozinha de A ate E (ex: "b" ou "B"). Sem numeros nem simbolos a mais.';
              await sock.sendMessage(remoteJid, {
                text: [
                  "Nao entendi o gabarito.",
                  "",
                  explain,
                  "",
                  "Tente novamente."
                ].join("\n")
              });
              continue;
            }

            creationSessions.set(sender, {
              stage: "awaiting_explanation",
              draft: { ...activeSession.draft, answerKey }
            });
            await sock.sendMessage(remoteJid, {
              text: [
                "Quer adicionar explicacao/comentario da questao?",
                "Pode enviar texto, imagem ou ambos.",
                'Se nao quiser, envie: "pular".'
              ].join("\n")
            });
            continue;
          }

          if (activeSession?.stage === "awaiting_explanation") {
            const shouldSkip = isSkipCommand(text);
            const explanationText = shouldSkip ? null : text || null;
            const explanationMedia = shouldSkip ? null : await extractMediaPayload(sock, msg);
            if (!shouldSkip && !explanationText && !explanationMedia) {
              await sock.sendMessage(remoteJid, {
                text: 'Envie comentario em texto/imagem ou "pular".'
              });
              continue;
            }

            const draft: QuestionDraft = {
              ...activeSession.draft,
              explanationText,
              explanationMedia
            };

            try {
              const quizGroupJid = getQuizTargetGroupJid();
              const created = await createQuestion({
                creatorJid: draft.creatorJid,
                creatorName: draft.creatorName,
                questionType: draft.questionType,
                statementText: draft.statementText,
                statementMedia: draft.statementMedia,
                answerKey: draft.answerKey,
                explanationText: draft.explanationText,
                explanationMedia: draft.explanationMedia,
                targetGroupJid: quizGroupJid
              });

              await publishQuestionToGroup(sock, quizGroupJid, created.shortId, draft);
              creationSessions.delete(sender);

              await sock.sendMessage(remoteJid, {
                text: `Questao #${created.shortId} criada e publicada no grupo.`
              });
            } catch (createError) {
              creationSessions.delete(sender);
              const message = (createError as Error).message;
              await sock.sendMessage(remoteJid, {
                text: `Falha ao criar a questao: ${message}\nEnvie "nova questao" para tentar novamente.`
              });
              console.error("[wizard] falha na criacao da questao:", message);
            }
            continue;
          }

          const command = parsePrivateCommand(text);
          console.log("[cmd] comando privado interpretado:", command);

          if (command.kind === "new_question") {
            pendingAnswerChanges.delete(sender);
            creationSessions.set(sender, { stage: "awaiting_type" });
            console.log(`[wizard] sessao iniciada para ${sender}`);
            await sock.sendMessage(remoteJid, {
              text: [
                "Qual o tipo da questao?",
                "1 - Multipla escolha",
                "2 - Certo ou errado"
              ].join("\n")
            });
            continue;
          }

          if (command.kind === "answer") {
            const result = await getQuestionResult(command.questionId);
            if (!isValidUserAnswer(command.answer, result.questionType)) {
              await sock.sendMessage(remoteJid, {
                text: `Resposta invalida para a questao #${command.questionId}. Use ${buildOptionsLabel(result.questionType)}.`
              });
              continue;
            }

            const existing = await getUserAnswer(command.questionId, sender);
            if (existing) {
              pendingAnswerChanges.set(sender, {
                questionId: command.questionId,
                newAnswerLetter: command.answer
              });

              await sock.sendMessage(remoteJid, {
                text: `Voce ja respondeu essa questao.\nDeseja alterar sua ultima resposta para ${command.answer.toUpperCase()}?\nResponda "sim" ou "nao".`
              });
              continue;
            }

            await insertAnswer({
              questionShortId: command.questionId,
              userJid: sender,
              userName: getDisplayName(msg, sender),
              answerLetter: command.answer,
              sentAt,
              sourceMessageId: messageId
            });

            await sock.sendMessage(remoteJid, {
              text: "Resposta salva."
            });
            await maybePostAutoGabaritoToGroup(sock, command.questionId);
            continue;
          }

          await sock.sendMessage(remoteJid, {
            text: buildPrivateInvalidFallback()
          });
        }
      } catch (error) {
        const err = error as Error;
        const targetJid = msg.key.remoteJid;
        console.error("Erro ao processar mensagem:", err.message);
        if (targetJid) {
          await sock.sendMessage(targetJid, {
            text: `Erro: ${err.message}`
          });
        }
      }
    }
  });
}

void startBot();
