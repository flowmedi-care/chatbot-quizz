const { getMembersForGroup, getNameHintsForGroup, pickDisplayLabel } = require("./_group-members.js");

function parseMateriaId(raw) {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function mapMateria(row) {
  return {
    id: Number(row.id),
    name: String(row.name || "").trim(),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at ? String(row.created_at) : null
  };
}

async function listMaterias(supabase, groupJid) {
  const { data, error } = await supabase
    .from("materias")
    .select("id, name, sort_order, created_at")
    .eq("group_jid", groupJid)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      return {
        materias: [],
        warning: "Rode a migration supabase-migration-materias.sql no Supabase."
      };
    }
    throw error;
  }
  return { materias: (data || []).map(mapMateria) };
}

/** Lista matérias com contagens + flag de participação do usuário (opcional). */
async function listMateriasCatalog(supabase, groupJid, userJid) {
  const { materias, warning } = await listMaterias(supabase, groupJid);
  if (!materias.length) {
    const { members, warning: memWarn } = await getMembersForGroup(supabase, groupJid);
    return { materias: [], members: members || [], warning: warning || memWarn };
  }

  const ids = materias.map((m) => m.id);

  const engagedByMateria = new Map();
  const activityByMateria = new Map();
  for (const id of ids) {
    engagedByMateria.set(id, 0);
    activityByMateria.set(id, { questionCount: 0, lastActivityAt: null });
  }

  const { data: engRows, error: engErr } = await supabase
    .from("materia_engagement")
    .select("materia_id, user_jid, engaged, updated_at")
    .in("materia_id", ids)
    .eq("engaged", true);

  if (engErr) {
    const msg = String(engErr.message || "").toLowerCase();
    if (!(msg.includes("relation") && msg.includes("does not exist"))) throw engErr;
  } else {
    for (const row of engRows || []) {
      const mid = Number(row.materia_id);
      if (!engagedByMateria.has(mid)) continue;
      engagedByMateria.set(mid, (engagedByMateria.get(mid) || 0) + 1);
      const act = activityByMateria.get(mid);
      const upd = row.updated_at ? String(row.updated_at) : null;
      if (act && upd && (!act.lastActivityAt || upd > act.lastActivityAt)) {
        act.lastActivityAt = upd;
      }
    }
  }

  const participatingIds = new Set();
  if (userJid) {
    const userKey = String(userJid).trim();
    for (const row of engRows || []) {
      if (!row.engaged) continue;
      if (String(row.user_jid) === userKey) {
        participatingIds.add(Number(row.materia_id));
      }
    }
  }

  const { data: qRows, error: qErr } = await supabase
    .from("questions")
    .select("materia_id, created_at")
    .eq("target_group_jid", groupJid)
    .in("materia_id", ids);

  if (qErr) {
    const msg = String(qErr.message || "").toLowerCase();
    if (!(msg.includes("column") && msg.includes("materia_id")) &&
        !(msg.includes("relation") && msg.includes("does not exist"))) {
      // coluna pode não existir ainda — ignora atividade por questão
      if (!msg.includes("materia_id")) throw qErr;
    }
  } else {
    for (const row of qRows || []) {
      const mid = Number(row.materia_id);
      const act = activityByMateria.get(mid);
      if (!act) continue;
      act.questionCount += 1;
      const created = row.created_at ? String(row.created_at) : null;
      if (created && (!act.lastActivityAt || created > act.lastActivityAt)) {
        act.lastActivityAt = created;
      }
    }
  }

  const { members, warning: memWarn } = await getMembersForGroup(supabase, groupJid);

  const enriched = materias.map((m) => {
    const act = activityByMateria.get(m.id) || { questionCount: 0, lastActivityAt: null };
    return {
      ...m,
      engagedCount: engagedByMateria.get(m.id) || 0,
      questionCount: act.questionCount,
      lastActivityAt: act.lastActivityAt || m.createdAt,
      participating: userJid ? participatingIds.has(m.id) : false
    };
  });

  return {
    materias: enriched,
    members: members || [],
    warning: warning || memWarn || undefined
  };
}

async function assertMateriaInGroup(supabase, materiaId, groupJid) {
  const { data, error } = await supabase
    .from("materias")
    .select("id, name")
    .eq("id", materiaId)
    .eq("group_jid", groupJid)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listMateriaEngagementMembers(supabase, materiaId, groupJid) {
  const { members: groupMembers, warning } = await getMembersForGroup(supabase, groupJid);

  let meRows = [];
  const { data: me, error: meErr } = await supabase
    .from("materia_engagement")
    .select("user_jid, user_label, quiz_display_name, engaged, engaged_since, updated_at")
    .eq("materia_id", materiaId);

  if (meErr) {
    const msg = String(meErr.message || "").toLowerCase();
    if (!(msg.includes("relation") && msg.includes("does not exist"))) throw meErr;
  } else {
    meRows = me || [];
  }

  const byJid = new Map(
    meRows.map((r) => [
      String(r.user_jid),
      {
        engaged: Boolean(r.engaged),
        userLabel: r.user_label ? String(r.user_label) : null,
        quizDisplayName: r.quiz_display_name != null ? String(r.quiz_display_name) : null,
        updatedAt: r.updated_at ? String(r.updated_at) : null
      }
    ])
  );

  const hints = await getNameHintsForGroup(supabase, groupJid);
  const members = (groupMembers || []).map((m) => {
    const jid = String(m.userJid);
    const meRow = byJid.get(jid);
    const userLabel = m.userLabel || (meRow && meRow.userLabel) || null;
    const quizDisplayName = m.quizDisplayName || (meRow && meRow.quizDisplayName) || null;
    return {
      userJid: jid,
      userLabel,
      quizDisplayName,
      displayLabel: pickDisplayLabel({
        userJid: jid,
        userLabel,
        quizDisplayName,
        nameFromQuiz: hints.get(jid) || null
      }),
      engaged: Boolean(meRow && meRow.engaged),
      updatedAt: meRow ? meRow.updatedAt : null
    };
  });

  return { members, warning };
}

/** Handler de matérias (montado em engagement.js para não criar 13ª Serverless Function). */
async function handleMateriasRequest(req, res, supabase, groupJid) {
  if (!groupJid) {
    return res.status(200).json({
      materias: [],
      members: [],
      groupJid: null,
      warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
    });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const materiaIdQuery = parseMateriaId(req.query?.materiaId ?? body.materiaId);

  if (req.method === "GET") {
    if (materiaIdQuery != null) {
      const mat = await assertMateriaInGroup(supabase, materiaIdQuery, groupJid);
      if (!mat) return res.status(404).json({ error: "Matéria não encontrada." });
      const { members, warning } = await listMateriaEngagementMembers(
        supabase,
        materiaIdQuery,
        groupJid
      );
      return res.status(200).json({
        groupJid,
        materiaId: materiaIdQuery,
        materiaName: String(mat.name || ""),
        members,
        warning: warning || undefined
      });
    }
    const userJid =
      req.query?.userJid != null && String(req.query.userJid).trim()
        ? String(req.query.userJid).trim()
        : null;
    const catalog = await listMateriasCatalog(supabase, groupJid, userJid);
    return res.status(200).json({
      groupJid,
      materias: catalog.materias,
      members: catalog.members,
      warning: catalog.warning || undefined
    });
  }

  if (req.method === "POST") {
    const name = body.name != null ? String(body.name).trim() : "";
    if (!name) return res.status(400).json({ error: "Campo name é obrigatório." });
    if (name.length > 80) return res.status(400).json({ error: "Nome muito longo (máx. 80)." });

    const { materias: existing } = await listMaterias(supabase, groupJid);
    const nextOrder =
      existing.length === 0 ? 1 : Math.max(...existing.map((m) => m.sortOrder || 0)) + 1;

    const { data, error } = await supabase
      .from("materias")
      .insert({ group_jid: groupJid, name, sort_order: nextOrder })
      .select("id, name, sort_order, created_at")
      .single();
    if (error) throw error;
    return res.status(201).json({ materia: mapMateria(data) });
  }

  if (req.method === "PATCH") {
    if (materiaIdQuery != null && body.userJid != null) {
      const mat = await assertMateriaInGroup(supabase, materiaIdQuery, groupJid);
      if (!mat) return res.status(404).json({ error: "Matéria não encontrada." });

      const userJid = String(body.userJid).trim();
      if (!userJid) return res.status(400).json({ error: "Campo userJid é obrigatório." });
      const engaged = Boolean(body.engaged);
      const nowIso = new Date().toISOString();

      let userLabel = null;
      let quizDisplayName = null;
      const { data: gme } = await supabase
        .from("group_member_engagement")
        .select("user_label, quiz_display_name")
        .eq("group_jid", groupJid)
        .eq("user_jid", userJid)
        .maybeSingle();
      if (gme) {
        userLabel = gme.user_label ? String(gme.user_label) : null;
        quizDisplayName =
          gme.quiz_display_name != null ? String(gme.quiz_display_name) : null;
      }

      const patch = {
        materia_id: materiaIdQuery,
        user_jid: userJid,
        user_label: userLabel,
        quiz_display_name: quizDisplayName,
        engaged,
        updated_at: nowIso,
        engaged_since: engaged ? nowIso : null
      };

      if (engaged) {
        const { data: prev } = await supabase
          .from("materia_engagement")
          .select("engaged, engaged_since")
          .eq("materia_id", materiaIdQuery)
          .eq("user_jid", userJid)
          .maybeSingle();
        if (prev && prev.engaged && prev.engaged_since) {
          patch.engaged_since = prev.engaged_since;
        }
      }

      const { data, error } = await supabase
        .from("materia_engagement")
        .upsert(patch, { onConflict: "materia_id,user_jid" })
        .select("user_jid, engaged, updated_at")
        .single();
      if (error) throw error;
      return res.status(200).json({
        ok: true,
        userJid: String(data.user_jid),
        engaged: Boolean(data.engaged)
      });
    }

    const id = parseMateriaId(body.id ?? body.materiaId);
    if (!id) return res.status(400).json({ error: "Campo id é obrigatório." });
    const mat = await assertMateriaInGroup(supabase, id, groupJid);
    if (!mat) return res.status(404).json({ error: "Matéria não encontrada." });

    const upd = {};
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name) return res.status(400).json({ error: "Nome inválido." });
      if (name.length > 80) return res.status(400).json({ error: "Nome muito longo (máx. 80)." });
      upd.name = name;
    }
    if (body.sortOrder != null) {
      const so = Number(body.sortOrder);
      if (!Number.isFinite(so)) return res.status(400).json({ error: "sortOrder inválido." });
      upd.sort_order = Math.trunc(so);
    }
    if (!Object.keys(upd).length) {
      return res.status(400).json({ error: "Nada para atualizar." });
    }

    const { data, error } = await supabase
      .from("materias")
      .update(upd)
      .eq("id", id)
      .eq("group_jid", groupJid)
      .select("id, name, sort_order, created_at")
      .single();
    if (error) throw error;
    return res.status(200).json({ materia: mapMateria(data) });
  }

  if (req.method === "DELETE") {
    const id = parseMateriaId(req.query?.id ?? body.id ?? body.materiaId);
    if (!id) return res.status(400).json({ error: "Campo id é obrigatório." });
    const mat = await assertMateriaInGroup(supabase, id, groupJid);
    if (!mat) return res.status(404).json({ error: "Matéria não encontrada." });

    const { error } = await supabase.from("materias").delete().eq("id", id).eq("group_jid", groupJid);
    if (error) throw error;
    return res.status(200).json({ ok: true, deletedId: id });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

module.exports = { handleMateriasRequest };
