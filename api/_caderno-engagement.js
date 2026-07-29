const { getNameHintsForGroup, pickDisplayLabel } = require("./_group-members.js");

function engagementDisplayLabel(row) {
  if (row.quizDisplayName && String(row.quizDisplayName).trim()) return String(row.quizDisplayName).trim();
  if (row.userLabel && String(row.userLabel).trim()) return String(row.userLabel).trim();
  const jid = String(row.userJid || "");
  const at = jid.indexOf("@");
  return at > 0 ? jid.slice(0, at) : jid;
}

async function listCadernoEngagementMembers(supabase, cadernoId, groupJid) {
  const { data: groupRows, error: gErr } = await supabase
    .from("group_member_engagement")
    .select("user_jid, user_label, quiz_display_name, engaged, updated_at")
    .eq("group_jid", groupJid)
    .order("user_label", { ascending: true, nullsFirst: false });

  if (gErr) {
    const msg = String(gErr.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      return { members: [], warning: "Rode /sync-membros no grupo para popular a lista." };
    }
    throw gErr;
  }

  let cadernoRows = [];
  let hasPassive = true;
  let { data: ce, error: ceErr } = await supabase
    .from("caderno_engagement")
    .select("user_jid, user_label, quiz_display_name, engaged, passive, engaged_since, updated_at")
    .eq("caderno_id", cadernoId);

  if (ceErr) {
    const msg = String(ceErr.message || "").toLowerCase();
    if (msg.includes("column") && msg.includes("passive")) {
      hasPassive = false;
      const fb = await supabase
        .from("caderno_engagement")
        .select("user_jid, user_label, quiz_display_name, engaged, engaged_since, updated_at")
        .eq("caderno_id", cadernoId);
      if (fb.error) {
        const m2 = String(fb.error.message || "").toLowerCase();
        if (!(m2.includes("relation") && m2.includes("does not exist"))) throw fb.error;
      } else {
        ce = fb.data;
        ceErr = null;
      }
    } else if (!(msg.includes("relation") && msg.includes("does not exist"))) {
      throw ceErr;
    }
  }
  if (!ceErr) {
    cadernoRows = ce || [];
  }

  const byJid = new Map(
    cadernoRows.map((r) => [
      String(r.user_jid),
      {
        userJid: String(r.user_jid),
        userLabel: r.user_label ? String(r.user_label) : null,
        quizDisplayName: r.quiz_display_name != null ? String(r.quiz_display_name) : null,
        engaged: Boolean(r.engaged),
        passive: hasPassive ? Boolean(r.passive) : false,
        updatedAt: r.updated_at ? String(r.updated_at) : null
      }
    ])
  );

  const hints = await getNameHintsForGroup(supabase, groupJid);
  const members = [];
  const seen = new Set();

  for (const r of groupRows || []) {
    const userJid = String(r.user_jid);
    seen.add(userJid);
    const ceRow = byJid.get(userJid);
    const userLabel = r.user_label ? String(r.user_label) : null;
    const quizDisplayName = r.quiz_display_name != null ? String(r.quiz_display_name) : null;
    const base = ceRow || {
      userJid,
      userLabel,
      quizDisplayName,
      engaged: false,
      passive: false,
      updatedAt: null
    };
    members.push({
      userJid: base.userJid,
      userLabel: base.userLabel,
      quizDisplayName: base.quizDisplayName,
      displayLabel: pickDisplayLabel({
        userJid: base.userJid,
        userLabel: base.userLabel,
        quizDisplayName: base.quizDisplayName,
        nameFromQuiz: hints.get(base.userJid) || null
      }),
      engaged: Boolean(base.engaged),
      passive: Boolean(base.passive),
      updatedAt: base.updatedAt
    });
  }

  for (const [jid, ceRow] of byJid) {
    if (seen.has(jid)) continue;
    members.push({
      userJid: ceRow.userJid,
      userLabel: ceRow.userLabel,
      quizDisplayName: ceRow.quizDisplayName,
      displayLabel: pickDisplayLabel({
        userJid: ceRow.userJid,
        userLabel: ceRow.userLabel,
        quizDisplayName: ceRow.quizDisplayName,
        nameFromQuiz: hints.get(ceRow.userJid) || null
      }),
      engaged: Boolean(ceRow.engaged),
      passive: Boolean(ceRow.passive),
      updatedAt: ceRow.updatedAt
    });
  }

  members.sort((a, b) =>
    engagementDisplayLabel(a).localeCompare(engagementDisplayLabel(b), "pt-BR")
  );

  return { members };
}

async function handleCadernoEngagementGet(req, res, supabase, groupJid, cadernoId) {
  const { data: caderno, error: cErr } = await supabase
    .from("cadernos")
    .select("id")
    .eq("id", cadernoId)
    .maybeSingle();

  if (cErr) throw cErr;
  if (!caderno) return res.status(404).json({ error: "Caderno nao encontrado." });

  const { members, warning } = await listCadernoEngagementMembers(supabase, cadernoId, groupJid);
  return res.status(200).json({ members, cadernoId, groupJid, warning: warning || undefined });
}

async function handleCadernoEngagementPatch(req, res, supabase, groupJid, cadernoId) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const userJid = body.userJid != null ? String(body.userJid).trim() : "";
  if (!userJid) {
    return res.status(400).json({ error: "Campo userJid e obrigatorio." });
  }

  let engaged = body.engaged != null ? Boolean(body.engaged) : null;
  let passive = body.passive != null ? Boolean(body.passive) : null;

  const { data: prev } = await supabase
    .from("caderno_engagement")
    .select("engaged, passive, engaged_since")
    .eq("caderno_id", cadernoId)
    .eq("user_jid", userJid)
    .maybeSingle();

  if (engaged == null) engaged = Boolean(prev && prev.engaged);
  if (passive == null) {
    passive = prev && prev.passive != null ? Boolean(prev.passive) : false;
  }

  // Mutuamente exclusivos
  if (body.engaged === true) passive = false;
  if (body.passive === true) engaged = false;
  if (engaged && passive) passive = false;

  const nowIso = new Date().toISOString();

  const { data: caderno, error: cErr } = await supabase
    .from("cadernos")
    .select("id")
    .eq("id", cadernoId)
    .maybeSingle();

  if (cErr) throw cErr;
  if (!caderno) return res.status(404).json({ error: "Caderno nao encontrado." });

  const { data: groupRow } = await supabase
    .from("group_member_engagement")
    .select("user_label, quiz_display_name")
    .eq("group_jid", groupJid)
    .eq("user_jid", userJid)
    .maybeSingle();

  const userLabel = groupRow?.user_label ? String(groupRow.user_label) : null;
  const quizDisplayName =
    groupRow?.quiz_display_name != null ? String(groupRow.quiz_display_name) : null;

  const patch = {
    caderno_id: cadernoId,
    user_jid: userJid,
    user_label: userLabel,
    quiz_display_name: quizDisplayName,
    engaged,
    passive,
    updated_at: nowIso
  };

  if (engaged) {
    const wasEngaged = Boolean(prev && prev.engaged);
    const hadSince = Boolean(prev && prev.engaged_since);
    if (!wasEngaged || !hadSince) {
      patch.engaged_since = nowIso;
    } else if (prev?.engaged_since) {
      patch.engaged_since = prev.engaged_since;
    }
  } else {
    patch.engaged_since = null;
  }

  let upd = await supabase
    .from("caderno_engagement")
    .upsert(patch, { onConflict: "caderno_id,user_jid" })
    .select("user_jid, user_label, quiz_display_name, engaged, passive, updated_at");

  if (upd.error) {
    const msg = String(upd.error.message || "").toLowerCase();
    if (msg.includes("column") && msg.includes("passive")) {
      const fallback = { ...patch };
      delete fallback.passive;
      upd = await supabase
        .from("caderno_engagement")
        .upsert(fallback, { onConflict: "caderno_id,user_jid" })
        .select("user_jid, user_label, quiz_display_name, engaged, updated_at");
    } else if (msg.includes("engaged_since")) {
      const fallback = { ...patch };
      delete fallback.engaged_since;
      upd = await supabase
        .from("caderno_engagement")
        .upsert(fallback, { onConflict: "caderno_id,user_jid" })
        .select("user_jid, user_label, quiz_display_name, engaged, passive, updated_at");
    }
  }

  if (upd.error) throw upd.error;
  const r = upd.data && upd.data[0];
  if (!r) return res.status(500).json({ error: "Falha ao salvar engajamento." });

  const hints = await getNameHintsForGroup(supabase, groupJid);
  const memberJid = String(r.user_jid);
  const memberLabel = r.user_label ? String(r.user_label) : null;
  const memberQuizName = r.quiz_display_name != null ? String(r.quiz_display_name) : null;

  return res.status(200).json({
    member: {
      userJid: memberJid,
      userLabel: memberLabel,
      quizDisplayName: memberQuizName,
      displayLabel: pickDisplayLabel({
        userJid: memberJid,
        userLabel: memberLabel,
        quizDisplayName: memberQuizName,
        nameFromQuiz: hints.get(memberJid) || null
      }),
      engaged: Boolean(r.engaged),
      passive: Boolean(r.passive),
      updatedAt: r.updated_at ? String(r.updated_at) : null
    }
  });
}

module.exports = {
  handleCadernoEngagementGet,
  handleCadernoEngagementPatch
};
