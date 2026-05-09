/** Textos do guia do bot (privado /quiz). Uma fonte para welcome e /ajuda. */

export function buildQuizFullGuide(): string {
  return [
    "Modo quiz ativado no seu chat.",
    "",
    "No grupo: envie /ajuda a qualquer momento para ver este guia aqui tambem.",
    "",
    "Aqui o bot entende comandos de questoes. No privado, fora do modo (com /quizoff), suas mensagens normais nao sao interpretadas.",
    "",
    "Criar uma questao:",
    'Envie: nova questao',
    "- Escolha 1 (multipla escolha) ou 2 (certo ou errado)",
    "- Envie enunciado (texto, imagem ou PDF)",
    "- Envie o gabarito (A-E ou C/E no certo-errado)",
    '- Comentario opcional ou "pular"',
    "",
    "Responder uma questao publicada:",
    "- Multipla escolha: letra + espaco + numero (ex: c 5)",
    "- Certo/errado: c 5 ou e 5",
    "",
    "Ver enunciado de novo:",
    "- /questao 5 (repete texto/imagem/PDF salvos; no grupo ou aqui)",
    "",
    "Ver resultado:",
    "- /gabarito 5 (no grupo ou aqui no privado)",
    "",
    "Ver quem ja respondeu (lista no grupo ou no privado):",
    '- quem respondeu 5 — ou: respondentes 5, /responderam 5',
    "",
    "Quando **todo mundo** que esta no grupo (exceto o bot) responder no privado, o bot pode postar o gabarito sozinho no grupo.",
    '(Desligue com AUTO_GABARITO_WHEN_ALL=false no servidor se nao quiser.)',
    "",
    "Ranking:",
    '- ranking (no grupo ou aqui; no privado usa o grupo configurado no bot)',
    "",
    "Ajuda e saida:",
    "- Guia completo: /ajuda",
    "- Mais informacoes no front-end: https://papa-vagas.vercel.app/",
    "- Sair do modo quiz e voltar ao chat normal: /quizoff"
  ].join("\n");
}

export function buildQuizQuickReference(): string {
  return [
    "Referencia rapida:",
    '- nova questao — criar questao',
    "- a 5 / c 5 — responder (# da questao)",
    "- /questao 5 — repetir enunciado desta questao",
    "- /gabarito 5 — resultado completo",
    "- quem respondeu 5 — lista de quem ja respondeu",
    "- ranking — ranking de acertos",
    "",
    "Guia completo: envie /ajuda",
    "Mais informacoes no front-end: https://papa-vagas.vercel.app/",
    "Para sair do bot e voltar a conversa normal: /quizoff"
  ].join("\n");
}

export function buildPrivateInvalidFallback(hint?: string): string {
  const lines = [
    hint ? `Nao entendi: ${hint}` : "Nao entendi esse comando.",
    "",
    buildQuizQuickReference()
  ];
  return lines.join("\n");
}
