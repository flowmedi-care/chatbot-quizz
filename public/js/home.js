(function () {
  "use strict";

  var STORAGE_USER = "papaVagasHubUser";

  function $(id) {
    return document.getElementById(id);
  }

  function greetWord() {
    var h = new Date().getHours();
    if (h < 12) return "Bom dia";
    if (h < 18) return "Boa tarde";
    return "Boa noite";
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function applyDemoStats() {
    setText("stat-omissas", "32");
    setText("stat-materias", "4");
    setText("stat-xp", "980");
    setText("stat-rank", "#14");
    setText("stat-level", "Nível 17");
    setText("stat-streak", "21 dias de sequência");
    setText("pulse-streak", "21");
    setText("pulse-xp", "+120");
    setText("pulse-rank", "#14");
    setText("pulse-qs", "18k");
    var fill = $("xp-fill");
    if (fill) fill.style.width = "62%";
    var bubble = $("mascot-bubble");
    if (bubble) bubble.textContent = "Bora zerar as omissas de hoje?";
    var cta = $("cta-main");
    if (cta) cta.textContent = "Começar atividades";
  }

  function firstName(label) {
    var t = String(label || "").trim();
    if (!t) return "";
    return t.split(/\s+/)[0];
  }

  async function loadMembers(sel) {
    try {
      var res = await fetch("/api/economy?view=members");
      var data = await res.json();
      var members = data.members || [];
      var saved = localStorage.getItem(STORAGE_USER) || "";
      members.forEach(function (m) {
        var jid = m.userJid || m.jid || m.user_jid || "";
        if (!jid) return;
        var label =
          m.displayLabel ||
          m.displayName ||
          m.quizDisplayName ||
          m.userLabel ||
          m.name ||
          "Participante";
        var opt = document.createElement("option");
        opt.value = jid;
        opt.textContent = label;
        if (jid === saved) opt.selected = true;
        sel.appendChild(opt);
      });
      return members;
    } catch (e) {
      return [];
    }
  }

  async function hydrateProfile(userJid, displayName) {
    setText("greet-time", greetWord());
    var nameEl = $("greet-name");
    if (nameEl) {
      var n = firstName(displayName);
      nameEl.textContent = n ? ", " + n : "";
    }

    if (!userJid) {
      applyDemoStats();
      return;
    }

    try {
      var [profileRes, dayRes] = await Promise.all([
        fetch("/api/economy?view=profile&userJid=" + encodeURIComponent(userJid)),
        fetch("/api/atividades?view=day&userJid=" + encodeURIComponent(userJid))
      ]);
      var profile = profileRes.ok ? await profileRes.json() : null;
      var day = dayRes.ok ? await dayRes.json() : null;

      var eco = (profile && profile.economy) || {};
      var streak = (profile && profile.streak) || {};
      var aura = (profile && profile.aura) || {};
      var auraVal = eco.aura != null ? Number(eco.aura) : Number(aura.total || 0);
      var streakDays = streak.current != null ? Number(streak.current) : Number(streak.current_streak || 0);
      var level = aura.level != null ? Number(aura.level) : Math.max(1, Math.floor(auraVal / 100) + 1);
      var omissas = day && Array.isArray(day.shortIds) ? day.shortIds.length : 0;
      var materias =
        day && Array.isArray(day.engaged)
          ? day.engaged.length
          : day && Array.isArray(day.byCaderno)
            ? day.byCaderno.length
            : 0;

      setText("stat-omissas", String(omissas || 0));
      setText("stat-materias", String(materias || 0));
      setText("stat-xp", String(auraVal || 0));
      setText("stat-rank", eco.rank != null ? "#" + eco.rank : "#—");
      setText("stat-level", "Nível " + level);
      setText("stat-streak", (streakDays || 0) + " dias de sequência");
      setText("pulse-streak", String(streakDays || 0));
      setText("pulse-xp", auraVal ? "+" + Math.min(200, Math.round(auraVal % 200) || 40) : "+0");
      setText("pulse-rank", eco.rank != null ? "#" + eco.rank : "#—");

      var fill = $("xp-fill");
      if (fill) fill.style.width = Math.min(96, 18 + (auraVal % 100)) + "%";

      var bubble = $("mascot-bubble");
      var cta = $("cta-main");
      if (omissas > 0) {
        if (bubble) bubble.textContent = "Hoje temos " + omissas + " omissas. Continua de onde parou.";
        if (cta) cta.textContent = "Continuar estudando";
      } else {
        if (bubble) bubble.textContent = "Omissas em dia. Que tal adiantar a semana?";
        if (cta) cta.textContent = "Abrir atividades";
      }
    } catch (e) {
      applyDemoStats();
    }
  }

  async function init() {
    setText("greet-time", greetWord());
    applyDemoStats();

    var toggle = $("nav-toggle");
    var links = $("site-nav-links");
    if (toggle && links) {
      toggle.addEventListener("click", function () {
        var open = links.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
      });
      links.querySelectorAll("a, button").forEach(function (el) {
        el.addEventListener("click", function () {
          links.classList.remove("is-open");
          toggle.setAttribute("aria-expanded", "false");
          toggle.setAttribute("aria-label", "Abrir menu");
        });
      });
    }

    var sel = $("home-user");
    if (!sel) return;
    var members = await loadMembers(sel);
    var saved = localStorage.getItem(STORAGE_USER) || "";
    if (saved) {
      var m = members.find(function (x) {
        return (x.userJid || x.jid || x.user_jid) === saved;
      });
      var label =
        (m &&
          (m.displayLabel ||
            m.displayName ||
            m.quizDisplayName ||
            m.userLabel ||
            m.name)) ||
        "";
      await hydrateProfile(saved, label);
    }

    sel.addEventListener("change", function () {
      var jid = sel.value || "";
      if (jid) localStorage.setItem(STORAGE_USER, jid);
      else localStorage.removeItem(STORAGE_USER);
      var label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "";
      void hydrateProfile(jid, jid ? label : "");
    });
  }

  void init();
})();
