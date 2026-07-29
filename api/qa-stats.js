const {
  getClient,
  pickTargetGroupJid,
  applyCors,
  fetchQuestionsForGroup,
  fetchPublishedCadernoQuestionIdsForGroup,
  isBotCreatorJid
} = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const groupJid = pickTargetGroupJid();
    if (!groupJid) {
      return res.status(200).json({
        groupJid: null,
        participants: [],
        botCreatedCount: 0,
        totals: { questionsCreated: 0, answersRecorded: 0 },
        warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
      });
    }

    const supabase = getClient();
    const [questions, publishedCadernoIds] = await Promise.all([
      fetchQuestionsForGroup(supabase, groupJid, {
        extended: true,
        includeCreatorJid: true
      }),
      fetchPublishedCadernoQuestionIdsForGroup(supabase, groupJid)
    ]);

    const botCreatedCount = publishedCadernoIds.size;
    const questionIds = questions.map((q) => q.id);
    let answersRaw = [];
    if (questionIds.length) {
      const { data: ans, error: aErr } = await supabase
        .from("answers")
        .select("question_id, user_jid, user_name")
        .in("question_id", questionIds);
      if (aErr) throw aErr;
      answersRaw = ans || [];
    }

    const byUser = new Map();

    function touch(jid, label) {
      const key = jid || label;
      if (!byUser.has(key)) {
        byUser.set(key, { userJid: jid || key, userLabel: label, createdCount: 0, answeredCount: 0 });
      }
      return byUser.get(key);
    }

    for (const q of questions) {
      if (isBotCreatorJid(q.creator_jid)) continue;
      const label = (q.creator_name && String(q.creator_name).trim()) || q.creator_jid || "Autor";
      touch(q.creator_jid, label).createdCount += 1;
    }

    for (const a of answersRaw) {
      const label = (a.user_name && String(a.user_name).trim()) || a.user_jid;
      touch(a.user_jid, label).answeredCount += 1;
    }

    const participants = Array.from(byUser.values()).sort((a, b) => {
      if (b.answeredCount !== a.answeredCount) return b.answeredCount - a.answeredCount;
      if (b.createdCount !== a.createdCount) return b.createdCount - a.createdCount;
      return a.userLabel.localeCompare(b.userLabel, "pt-BR");
    });

    const jids = participants.map((p) => p.userJid).filter(Boolean);
    let cosmeticsByJid = {};
    if (jids.length) {
      try {
        const { data: ecos } = await supabase
          .from("user_economy")
          .select("user_jid, active_title, aura")
          .in("user_jid", jids);
        const { data: inv } = await supabase
          .from("user_inventory")
          .select("user_jid, item_key, equipped")
          .in("user_jid", jids)
          .eq("equipped", true);
        const { data: catalog } = await supabase.from("shop_catalog").select("item_key, metadata");
        const metaByKey = new Map((catalog || []).map((c) => [c.item_key, c.metadata || {}]));
        const map = {};
        for (const e of ecos || []) {
          map[e.user_jid] = {
            title: e.active_title || null,
            aura: e.aura || 0,
            css: [],
            emoji: null
          };
        }
        for (const row of inv || []) {
          const slot = map[row.user_jid] || { title: null, aura: 0, css: [], emoji: null };
          const meta = metaByKey.get(row.item_key) || {};
          if (meta.css) slot.css.push(meta.css);
          if (meta.emoji) slot.emoji = meta.emoji;
          map[row.user_jid] = slot;
        }
        cosmeticsByJid = map;
      } catch (_) {
        /* tabelas de economia ainda nao migradas */
      }
    }

    const enriched = participants.map((p) => ({
      ...p,
      cosmetics: cosmeticsByJid[p.userJid] || null
    }));

    return res.status(200).json({
      groupJid,
      participants: enriched,
      botCreatedCount,
      totals: {
        questionsCreated: questions.length,
        answersRecorded: answersRaw.length
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao carregar Q&A" });
  }
};
