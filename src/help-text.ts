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
    "- Comentario opcional apos virgula (ex: b 139, acho que e prazo decadencial)",
    "- Ou entre colchetes: [139 b, acho que e prazo decadencial]",
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
    "No **grupo**, envie **/sync-membros** uma vez (ou quando entrar gente nova) para o bot salvar a lista de participantes.",
    "No **site** Papa Vagas:",
    "- **Engajamento** (por matéria): no site, abra **/engajamento** — escolha quem você é e entre nas matérias com um clique.",
    "- **Cadernos > Editar**: marque engajados e/ou passivos de cada caderno.",
    "  Engajados: fecham o gabarito automatico e o ritmo (esperar resposta).",
    "  Passivos: recebem no /omissas so as questoes do dia (nao influenciam o ritmo).",
    "No wizard de nova questao, depois do tipo, escolha a matéria pelo número.",
    "Questoes de caderno nao vao mais com enunciado no grupo — o grupo recebe o **Diário Oficial** diario; enunciados via /omissas.",
    "Quando **todos os engajados da matéria** (exceto quem criou a questao) tiverem respondido, o bot posta o gabarito no grupo.",
    "Lista o que falta responder (privado): **/omissas** — engajados veem desde o dia em que entraram no caderno; passivos so o dia; depois **sim** ou **nao** para receber os enunciados.",
    "Adiantar dias (privado, engajados): **adiantar 2** — reserva as questoes dos proximos 2 dias na sua lista (max. 7).",
    "(Desligue o auto-gabarito com AUTO_GABARITO_WHEN_ALL=false no servidor se nao quiser.)",
    "",
    "Gamificação (Aura + Créditos Orçamentários):",
    "- /perfil ou /aura — sua carteira, nível de Aura, streak, conquistas",
    "- /auras (ou /aura todos) — Aura de todo mundo numa mensagem",
    "- /loja — Portal de compras · /comprar <item> · /equipar <item>",
    "- /eliminar 123 — usa assistência (elimina 1 alternativa errada)",
    "- /aplicar 500 — Aplicação Orçamentária (10 dias de streak)",
    "- /intimar Nome 50 123 — Mandado de Intimação (stake 20–200; taxa 10%)",
    "- /ranking aura|producao|disciplina|duelo",
    "- /diario — quadro enxuto do dia",
    "Hub no site: https://papa-vagas.vercel.app/hub (manual + mandado explicado)",
    "Compras pelo site pedem *sim* no WhatsApp para confirmar.",
    "",
    "Estatisticas do grupo (Q&A):",
    "- /q&a — questoes criadas e respondidas por pessoa + total do bot (cadernos)",
    '- ranking — redireciona ao ranking de Aura (use /q&a para atividade)',
    "",
    "Ajuda e saida:",
    "- Guia completo: /ajuda",
    "- Mais informacoes no front-end: https://papa-vagas.vercel.app/ e Hub: https://papa-vagas.vercel.app/hub",
    "- Sair do modo quiz e voltar ao chat normal: /quizoff"
  ].join("\n");
}

export function buildQuizQuickReference(): string {
  return [
    "Referencia rapida:",
    '- nova questao — criar questao',
    "- a 5 / c 5 — responder (# da questao)",
    "- b 5, seu comentario — responder com comentario opcional",
    "- /questao 5 — repetir enunciado desta questao",
    "- /gabarito 5 — resultado completo",
    "- quem respondeu 5 — lista de quem ja respondeu",
    "- /omissas — questoes em aberto (engajado/passivo) no privado",
    "- adiantar 2 — reservar questoes dos proximos 2 dias (engajado)",
    "- /perfil · /auras · /loja · /comprar · /aplicar · /intimar · /ranking · /diario",
    "- /q&a — estatisticas do grupo (criadas | respondidas)",
    "",
    "Guia completo: envie /ajuda",
    "Mais informacoes no front-end: https://papa-vagas.vercel.app/ · Hub: https://papa-vagas.vercel.app/hub",
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
