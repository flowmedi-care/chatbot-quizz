/**
 * Helpers de categorias pessoais (user_categories + answer_categories).
 */

function normalizeCategoryName(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function displayCategoryName(raw) {
  return String(raw || "")
    .trim()
    .replace(/;+\s*$/g, "")
    .trim();
}

async function listUserCategories(supabase, userJid) {
  const { data, error } = await supabase
    .from("user_categories")
    .select("id, name, name_normalized, created_at")
    .eq("user_jid", userJid)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    nameNormalized: String(row.name_normalized),
    createdAt: row.created_at
  }));
}

async function createUserCategory(supabase, userJid, rawName) {
  const name = displayCategoryName(rawName);
  if (!name) {
    const err = new Error("Informe o nome da categoria");
    err.code = "EMPTY_NAME";
    throw err;
  }
  const nameNormalized = normalizeCategoryName(name);
  if (!nameNormalized) {
    const err = new Error("Nome de categoria invalido");
    err.code = "EMPTY_NAME";
    throw err;
  }

  const { data, error } = await supabase
    .from("user_categories")
    .insert({
      user_jid: userJid,
      name,
      name_normalized: nameNormalized
    })
    .select("id, name, name_normalized, created_at")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const { data: existing, error: findErr } = await supabase
        .from("user_categories")
        .select("id, name, name_normalized, created_at")
        .eq("user_jid", userJid)
        .eq("name_normalized", nameNormalized)
        .maybeSingle();
      if (findErr) throw findErr;
      if (existing) {
        return {
          id: Number(existing.id),
          name: String(existing.name),
          nameNormalized: String(existing.name_normalized),
          createdAt: existing.created_at,
          alreadyExisted: true
        };
      }
    }
    throw error;
  }

  return {
    id: Number(data.id),
    name: String(data.name),
    nameNormalized: String(data.name_normalized),
    createdAt: data.created_at,
    alreadyExisted: false
  };
}

/**
 * Resolve nomes digitados contra o catálogo do usuário.
 * @returns {{ known: { id: number, name: string }[], unknown: string[] }}
 */
async function resolveCategoryNames(supabase, userJid, names) {
  const catalog = await listUserCategories(supabase, userJid);
  const byNorm = new Map(catalog.map((c) => [c.nameNormalized, c]));
  const known = [];
  const knownIds = new Set();
  const unknown = [];
  const seenUnknown = new Set();

  for (const raw of names || []) {
    const display = displayCategoryName(raw);
    if (!display) continue;
    const norm = normalizeCategoryName(display);
    if (!norm) continue;
    const hit = byNorm.get(norm);
    if (hit) {
      if (!knownIds.has(hit.id)) {
        knownIds.add(hit.id);
        known.push({ id: hit.id, name: hit.name });
      }
    } else if (!seenUnknown.has(norm)) {
      seenUnknown.add(norm);
      unknown.push(display);
    }
  }

  return { known, unknown, catalog };
}

async function getAnswerRow(supabase, questionShortId, userJid) {
  const shortId = String(questionShortId || "")
    .trim()
    .toUpperCase();
  const { data: rows, error } = await supabase
    .from("answers")
    .select("id, question_id, question_short_id, answer_letter, answer_comment, user_jid")
    .eq("question_short_id", shortId);
  if (error) throw error;
  const want = String(userJid || "")
    .trim()
    .toLowerCase();
  const wantKey = (() => {
    const at = want.indexOf("@");
    if (at < 0) return want;
    return `${want.slice(0, at).split(":")[0]}@${want.slice(at + 1)}`;
  })();
  const hit =
    (rows || []).find((r) => {
      const j = String(r.user_jid || "").toLowerCase();
      const at = j.indexOf("@");
      const key = at < 0 ? j : `${j.slice(0, at).split(":")[0]}@${j.slice(at + 1)}`;
      return key === wantKey;
    }) || null;
  return hit;
}

async function listCategoriesForAnswer(supabase, answerId) {
  const { data, error } = await supabase
    .from("answer_categories")
    .select("category_id, user_categories(id, name)")
    .eq("answer_id", answerId);
  if (error) throw error;
  const out = [];
  for (const row of data || []) {
    const raw = row.user_categories;
    const cat = Array.isArray(raw) ? raw[0] : raw;
    if (!cat) continue;
    out.push({ id: Number(cat.id), name: String(cat.name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return out;
}

/** Substitui o conjunto de categorias da resposta (lista de category ids). */
async function setAnswerCategories(supabase, answerId, categoryIds) {
  const ids = [
    ...new Set(
      (categoryIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ];

  const { error: delErr } = await supabase.from("answer_categories").delete().eq("answer_id", answerId);
  if (delErr) throw delErr;

  if (!ids.length) return [];

  const rows = ids.map((category_id) => ({ answer_id: answerId, category_id }));
  const { error: insErr } = await supabase.from("answer_categories").insert(rows);
  if (insErr) throw insErr;

  return listCategoriesForAnswer(supabase, answerId);
}

async function clearAnswerCategories(supabase, answerId) {
  return setAnswerCategories(supabase, answerId, []);
}

/**
 * Carrega categorias para várias respostas de uma vez.
 * @returns {Map<number, { id: number, name: string }[]>}
 */
async function mapCategoriesByAnswerIds(supabase, answerIds) {
  const map = new Map();
  const ids = [...new Set((answerIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)))];
  if (!ids.length) return map;

  const { data, error } = await supabase
    .from("answer_categories")
    .select("answer_id, user_categories(id, name)")
    .in("answer_id", ids);
  if (error) throw error;

  for (const row of data || []) {
    const aid = Number(row.answer_id);
    const raw = row.user_categories;
    const cat = Array.isArray(raw) ? raw[0] : raw;
    if (!Number.isFinite(aid) || !cat) continue;
    if (!map.has(aid)) map.set(aid, []);
    map.get(aid).push({ id: Number(cat.id), name: String(cat.name) });
  }
  for (const [, list] of map) {
    list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }
  return map;
}

module.exports = {
  normalizeCategoryName,
  displayCategoryName,
  listUserCategories,
  createUserCategory,
  resolveCategoryNames,
  getAnswerRow,
  listCategoriesForAnswer,
  setAnswerCategories,
  clearAnswerCategories,
  mapCategoriesByAnswerIds
};
