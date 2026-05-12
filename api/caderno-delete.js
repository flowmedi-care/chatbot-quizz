const { getClient, applyCors } = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = {};
  try {
    if (req.method === "POST") {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    } else {
      body = { id: req.query && req.query.id };
    }
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Informe id do caderno." });
  }

  try {
    const supabase = getClient();
    const { error } = await supabase.from("cadernos").delete().eq("id", id);
    if (error) throw error;
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("[caderno-delete]", e);
    return res.status(500).json({ error: e.message || "Erro ao excluir caderno" });
  }
};
