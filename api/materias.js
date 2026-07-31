const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");
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

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const groupJid = pickTargetGroupJid();
  if (!groupJid) {
    return res.status(200).json({
      materias: [],
      members: [],
      groupJid: null,
      warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
    });
  }

  try {
    const supabase = getClient();
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
      const { materias, warning } = await listMaterias(supabase, groupJid);
      return res.status(200).json({ groupJid, materias, warning: warning || undefined });
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
      // Toggle engajamento por matéria
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

      // Renomear / reordenar matéria
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
  } catch (e) {
    console.error("[materias]", e);
    return res.status(500).json({ error: e.message || "Erro interno" });
  }
};
