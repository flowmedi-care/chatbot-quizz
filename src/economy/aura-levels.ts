import { AURA_LEVELS, type AuraLevelDef } from "./constants";

export type AuraLevelInfo = {
  level: AuraLevelDef;
  aura: number;
  progressPct: number;
  nextLevelAura: number | null;
  remainingToNext: number | null;
  label: string;
  shortLabel: string;
};

export function getAuraLevel(auraRaw: number): AuraLevelInfo {
  const aura = Math.max(0, Math.floor(auraRaw || 0));
  let level = AURA_LEVELS[0];
  for (const l of AURA_LEVELS) {
    if (aura >= l.min) level = l;
  }
  const next = AURA_LEVELS.find((l) => l.min > level.min) || null;
  const spanStart = level.min;
  const spanEnd = level.max != null ? level.max + 1 : spanStart + 1000;
  const progressPct =
    level.max == null
      ? 100
      : Math.min(100, Math.max(0, Math.round(((aura - spanStart) / (spanEnd - spanStart)) * 100)));
  const remainingToNext = next ? Math.max(0, next.min - aura) : null;
  return {
    level,
    aura,
    progressPct,
    nextLevelAura: next ? next.min : null,
    remainingToNext,
    label: `${level.emoji} ${level.title}`,
    shortLabel: level.title.replace(/^Aura\s+/i, "")
  };
}

export function formatAuraBar(pct: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatAuraBlock(aura: number): string {
  const info = getAuraLevel(aura);
  const lines = [`✨ Aura: ${info.aura}`, `Nível: ${info.label}`, formatAuraBar(info.progressPct)];
  if (info.remainingToNext != null) {
    lines.push(`Próximo nível: +${info.remainingToNext}`);
  }
  return lines.join("\n");
}
