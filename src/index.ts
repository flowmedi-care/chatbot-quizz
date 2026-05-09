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
  parsePrivateCommand,
  parseGabaritoCommand,
  parseRepeatQuestionCommand,
  parseRespondentsCommand,
  parseSlashSessionCommand,
  parseTypeSelection
} from "./message-utils";
import { buildQuizFullGuide, buildPrivateInvalidFallback } from "./help-text";
import { config } from "./config";
import {
  createQuestion,
  formatRankingMessage,
  getQuestionResult,
  getRankingForGroup,
  getQuestionForRepeat,
  getQuestionTargetGroupJid,
  getQuizModePrivate,
  insertAnswer,
  getUserAnswer,
  listAnswerUserJidsForQuestion,
  setQuizModePrivate,
  updateUserAnswer
} from "./supabase";
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

const autoGabaritoPostedQuestionIds = new Set<string>();

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

    const groupJid = await getQuestionTargetGroupJid(shortUp);
    if (!groupJid) return;

    const answered = await listAnswerUserJidsForQuestion(shortUp);
    let memberIds: string[];
    try {
      memberIds = await fetchGroupParticipantIds(sock, groupJid);
    } catch (e) {
      console.warn("[auto-gabarito] grupo metadata falhou:", (e as Error).message);
      return;
    }

    const botComp = getBotJidComparable(sock);
    const expectAnswer = botComp ? memberIds.filter((jid) => jidComparableKey(jid) !== botComp) : memberIds;

    if (expectAnswer.length === 0) return;
    const allAnswered = expectAnswer.every((m) => participantHasMatchingAnswer(m, answered));
    if (!allAnswered) return;

    autoGabaritoPostedQuestionIds.add(shortUp);

    const result = await getQuestionResult(shortUp);
    const header = "[Todos responderam]\nResultado enviado automaticamente.\n";
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
        const sender = resolveActorJid(remoteJid, msg.key);
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

        if (fromPrivate) {
          const quizEnabled = await getQuizModePrivate(sender);
          if (!quizEnabled) {
            if (parseSlashSessionCommand(text) === "quiz") {
              await setQuizModePrivate(sender, true);
              await sock.sendMessage(remoteJid, { text: buildQuizFullGuide() });
            }
            continue;
          }

          const sessionCmd = parseSlashSessionCommand(text);
          if (sessionCmd === "quizoff") {
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
          if (sessionCmd === "help") {
            await sock.sendMessage(remoteJid, { text: buildQuizFullGuide() });
            continue;
          }
          if (sessionCmd === "quiz") {
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

        if (fromPrivate) {
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
