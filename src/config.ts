import dotenv from "dotenv";

dotenv.config();

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }

  const normalized = value.trim();
  const looksLikePlaceholder =
    normalized.includes("SEU-PROJETO") ||
    normalized.includes("COLE_AQUI") ||
    normalized.includes("XXXXXXXX");

  if (looksLikePlaceholder) {
    throw new Error(`Variavel ${name} ainda esta com valor de exemplo. Preencha com valor real no .env.`);
  }
  return normalized;
}

export const config = {
  supabaseUrl: getEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  targetGroupJids: String(process.env.TARGET_GROUP_JIDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
};
