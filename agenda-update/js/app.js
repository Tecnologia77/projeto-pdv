/**
 * UI — rede de barbearias (localStorage ou Firebase).
 */
(function () {
  "use strict";

  var C = function () {
    return window.SalaoCore;
  };
  var B = function () {
    return window.SalaoBackend;
  };

  function applySettingsToDom(settings) {
    var nameEl = document.getElementById("brandName") || document.getElementById("publicName");
    if (nameEl) nameEl.textContent = settings.salonName || "Barbearia";
    document.title = (settings.salonName || "Barbearia") + " — Agendamento";
    var hex = settings.accentHex || "#d4a853";
    if (hex.charAt(0) !== "#") hex = "#" + hex;
    if (hex.length === 7) {
      document.documentElement.style.setProperty("--salon-accent", hex);
      document.documentElement.style.setProperty(
        "--salon-accent-soft",
        "rgba(" +
          parseInt(hex.slice(1, 3), 16) +
          "," +
          parseInt(hex.slice(3, 5), 16) +
          "," +
          parseInt(hex.slice(5, 7), 16) +
          ",0.18)"
      );
    }
    var cover = document.getElementById("publicCover");
    if (cover && settings.coverUrl) {
      cover.style.backgroundImage = "url(" + settings.coverUrl + ")";
      cover.classList.remove("hidden");
    }
    var logo = document.getElementById("publicLogo");
    if (logo && settings.logoUrl) {
      logo.src = settings.logoUrl;
      logo.alt = settings.salonName;
      logo.classList.remove("hidden");
    }
  }

  function formatMoney(cents) {
    return ((cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  var PAYMENT_METHODS = [
    { id: "pix", label: "PIX" },
    { id: "cash", label: "Dinheiro" },
    { id: "credit", label: "Crédito" },
    { id: "debit", label: "Débito" },
  ];

  function paymentMethodLabel(id) {
    if (id === "subscription") return "Assinatura";
    var found = PAYMENT_METHODS.find(function (p) {
      return p.id === id;
    });
    return found ? found.label : "";
  }

  function appointmentSubscriberBadge(a, liveMatch) {
    var state = liveMatch ? C().subscriberState(liveMatch) : a && a.subscriberStatus ? a.subscriberStatus : "";
    if (!state && a && C().isSubscriptionAppointment(a)) state = "active";
    if (!state) return "";
    var plan = (liveMatch && liveMatch.planName) || (a && a.membershipPlanName) || "";
    if (state === "active") {
      return '<span class="badge badge-subscription">Assinante' + (plan ? " · " + plan : "") + "</span>";
    }
    if (state === "expired") return '<span class="badge badge-cancelled">Assinatura vencida</span>';
    if (state === "no_cuts") return '<span class="badge badge-warn">Assinatura sem cortes</span>';
    return "";
  }

  function attachSubscriber(ap, match) {
    if (!ap || !match) return ap;
    var state = C().subscriberState(match);
    ap.membershipId = match.id;
    ap.membershipPlanName = match.planName || "";
    ap.subscriberStatus = state;
    ap.clientPhone = ap.clientPhone || match.clientPhone || "";
    if (state === "active") {
      ap.coveredByMembership = true;
      ap.paymentMethod = "subscription";
    } else {
      ap.coveredByMembership = false;
    }
    return ap;
  }

  function subscriberBookingText(match) {
    if (!match) return "";
    var state = C().subscriberState(match);
    var plan = match.planName || "plano";
    if (state === "active") {
      return "Assinatura ativa (" + plan + "). Este horário entra como corte do plano, sem cobrança avulsa.";
    }
    if (state === "expired") return "Encontramos sua assinatura (" + plan + "), mas ela está vencida.";
    if (state === "no_cuts") return "Encontramos sua assinatura (" + plan + "), mas os cortes deste período acabaram.";
    return "";
  }

  var CASH_CATEGORIES = {
    in: [
      { id: "supply", label: "Suprimento / reforço de troco" },
      { id: "product_sale", label: "Venda de produto" },
      { id: "service_extra", label: "Serviço avulso" },
      { id: "other_in", label: "Outra entrada" },
    ],
    out: [
      { id: "expense", label: "Despesa (contas, aluguel…)" },
      { id: "purchase", label: "Compra de produtos / material" },
      { id: "other_out", label: "Outra saída" },
    ],
    sangria: [{ id: "sangria", label: "Sangria (retirada para cofre/banco)" }],
    pro: [
      { id: "pro_payment", label: "Pagamento / comissão" },
      { id: "pro_advance", label: "Vale / adiantamento" },
      { id: "pro_other", label: "Outro pagamento ao profissional" },
    ],
  };

  function cashCategoryLabel(id) {
    var found = null;
    Object.keys(CASH_CATEGORIES).forEach(function (k) {
      CASH_CATEGORIES[k].forEach(function (c) {
        if (c.id === id) found = c;
      });
    });
    return found ? found.label : "Movimento";
  }

  /* Modal de forma de pagamento (compartilhado: painel do dono e do profissional). */
  var payMethodPickerCallback = null;
  var payMethodModalBound = false;

  function closePayMethodModal() {
    payMethodPickerCallback = null;
    var modal = document.getElementById("payMethodModal");
    if (modal) modal.classList.add("hidden");
  }

  function bindPayMethodModal() {
    if (payMethodModalBound) return;
    payMethodModalBound = true;
    document.querySelectorAll(".pay-method-btn").forEach(function (btn) {
      btn.onclick = function () {
        var method = btn.getAttribute("data-pay");
        var cb = payMethodPickerCallback;
        closePayMethodModal();
        if (cb && method) cb(method);
      };
    });
    var cancel = document.getElementById("payMethodCancel");
    if (cancel) cancel.onclick = closePayMethodModal;
    var modal = document.getElementById("payMethodModal");
    if (modal) {
      modal.onclick = function (ev) {
        if (ev.target === modal) closePayMethodModal();
      };
    }
  }

  function openPayMethodModal(title, currentId, onPick) {
    bindPayMethodModal();
    var titleEl = document.getElementById("payMethodTitle");
    if (titleEl) titleEl.textContent = title || "Forma de pagamento";
    payMethodPickerCallback = onPick;
    document.querySelectorAll(".pay-method-btn").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-pay") === currentId);
    });
    var modal = document.getElementById("payMethodModal");
    if (modal) modal.classList.remove("hidden");
  }

  function randomPassword() {
    var chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    var out = "";
    for (var i = 0; i < 8; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  function formatRange(iso) {
    return new Date(iso).toLocaleString("pt-BR", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function badgeClass(st) {
    if (st === "PENDING") return "badge badge-pending";
    if (st === "CONFIRMED") return "badge badge-confirmed";
    if (st === "DONE") return "badge badge-done";
    return "badge badge-cancelled";
  }

  function statusLabel(st) {
    var s = String(st || "").toUpperCase();
    if (s === "PENDING") return "Aguardando confirmação";
    if (s === "CONFIRMED") return "Confirmado";
    if (s === "DONE") return "Concluído";
    if (s === "CANCELLED") return "Cancelado";
    return st || "—";
  }

  function sessionRole(sess) {
    return sess && sess.role ? String(sess.role).toUpperCase() : "";
  }

  function setHidden(id, hidden) {
    var node = document.getElementById(id);
    if (node) node.classList.toggle("hidden", !!hidden);
  }

  function proInitials(name) {
    var parts = (name || "?")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function createProAvatarEl(pro, imgClass) {
    var cls = imgClass || "pro-avatar";
    if (pro && pro.photoUrl) {
      var img = document.createElement("img");
      img.className = cls;
      img.src = pro.photoUrl;
      img.alt = pro.name || "Profissional";
      img.onerror = function () {
        var ph = document.createElement("div");
        ph.className = "pro-avatar-placeholder";
        ph.textContent = proInitials(pro.name);
        if (img.parentNode) img.parentNode.replaceChild(ph, img);
      };
      return img;
    }
    var ph = document.createElement("div");
    ph.className = "pro-avatar-placeholder";
    ph.textContent = proInitials(pro ? pro.name : "");
    return ph;
  }

  function showMsg(text, type) {
    var el = document.getElementById("msg");
    if (!el) return;
    if (!text) {
      el.innerHTML = "";
      el.className = "";
      return;
    }
    el.className = "msg " + (type === "ok" ? "msg-ok" : "msg-error");
    el.textContent = text;
  }

  var appointmentAlertSeen = null;
  var appointmentAlertCtx = null;
  var appointmentAlertTimer = null;

  function ensureAlertAudio() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!appointmentAlertCtx) appointmentAlertCtx = new Ctx();
    return appointmentAlertCtx;
  }

  var appointmentAlertHint = "Clique em qualquer lugar para ativar o aviso sonoro de novos agendamentos.";

  function unlockAlertAudio() {
    var ctx = ensureAlertAudio();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(function () {});
    var el = document.getElementById("apptAlert");
    if (el && el.textContent === appointmentAlertHint) el.classList.add("hidden");
  }

  function promptAppointmentSound() {
    if (window.SALAO_PAGE !== "barbeiro") return;
    setTimeout(function () {
      var ctx = ensureAlertAudio();
      if (!ctx || ctx.state !== "suspended") return;
      var el = document.getElementById("apptAlert");
      if (!el || !el.classList.contains("hidden")) return;
      el.textContent = appointmentAlertHint;
      el.classList.remove("hidden");
    }, 800);
  }

  document.addEventListener("pointerdown", unlockAlertAudio);
  document.addEventListener("keydown", unlockAlertAudio);

  function playNewAppointmentSound() {
    var ctx = ensureAlertAudio();
    if (!ctx) return;
    var start = function () {
      var now = ctx.currentTime;
      [784, 1174].forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        var t0 = now + i * 0.16;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      });
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(start).catch(function () {});
      return;
    }
    start();
  }

  function showAppointmentAlert(text) {
    playNewAppointmentSound();
    var el = document.getElementById("apptAlert");
    if (!el) {
      el = document.createElement("div");
      el.id = "apptAlert";
      el.className = "appt-alert";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.remove("hidden");
    if (appointmentAlertTimer) clearTimeout(appointmentAlertTimer);
    appointmentAlertTimer = setTimeout(function () {
      el.classList.add("hidden");
    }, 8000);
    if (!document.documentElement.getAttribute("data-alert-title")) {
      document.documentElement.setAttribute("data-alert-title", document.title);
    }
    document.title = "Novo agendamento";
    setTimeout(function () {
      var base = document.documentElement.getAttribute("data-alert-title");
      if (base) document.title = base;
    }, 8000);
  }

  function watchNewAppointments(list) {
    var ids = {};
    (list || []).forEach(function (a) {
      if (!a || !a.id) return;
      if (a.status !== "PENDING" && a.status !== "CONFIRMED") return;
      ids[a.id] = a;
    });
    if (!appointmentAlertSeen) {
      appointmentAlertSeen = {};
      Object.keys(ids).forEach(function (id) {
        appointmentAlertSeen[id] = true;
      });
      return;
    }
    var fresh = [];
    Object.keys(ids).forEach(function (id) {
      if (!appointmentAlertSeen[id]) fresh.push(ids[id]);
      appointmentAlertSeen[id] = true;
    });
    if (!fresh.length) return;
    var first = fresh[0];
    var when = "";
    try {
      if (first.startAt) {
        when =
          " · " +
          new Date(first.startAt).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
      }
    } catch (e) {}
    var text =
      fresh.length === 1
        ? "Novo agendamento: " +
          (first.clientName || "Cliente") +
          (first.serviceName ? " · " + first.serviceName : "") +
          when
        : fresh.length + " novos agendamentos chegaram.";
    showAppointmentAlert(text);
  }

  function friendlyAuthError(e) {
    var code = (e && e.code) || "";
    if (code === "auth/configuration-not-found") {
      return (
        "Authentication não está ativo no Firebase. No Console: Authentication → Começar → ative E-mail/senha, depois tente de novo."
      );
    }
    if (code === "auth/email-already-in-use") return "Este e-mail já está cadastrado.";
    if (code === "auth/weak-password") return "Senha muito fraca. Use pelo menos 6 caracteres.";
    if (code === "auth/invalid-email") return "E-mail inválido.";
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
      return "E-mail ou senha incorretos.";
    }
    if (code === "auth/user-not-found") return "Conta não encontrada.";
    if (code === "permission-denied") {
      return "Não foi possível concluir a operação. Saia, entre de novo ou tente em alguns segundos.";
    }
    if (((e && e.message) || "").indexOf("Perfil não encontrado") >= 0) {
      return "Perfil não encontrado no Firestore (coleção users). Veja instruções no Console ou contate o suporte.";
    }
    return (e && e.message) || "Erro de autenticação.";
  }

  function slugFromInput(val) {
    return C().slugify(val || "");
  }

  var WEEKLY_CATEGORIES = [
    { id: "weekdays", label: "Segunda a Sexta", keys: ["mon", "tue", "wed", "thu", "fri"] },
    { id: "saturday", label: "Sábado", keys: ["sat"] },
    { id: "sunday", label: "Domingo", keys: ["sun"] },
  ];

  function dayHoursLabel(key) {
    var k = String(key || "");
    if (k === "sun" || k === "sat") return C().DAY_LABELS[k];
    return C().DAY_LABELS[k] + "-feira";
  }

  function formatHourClock(hour, minute) {
    var hrs = typeof hour === "number" ? hour : parseInt(hour, 10) || 0;
    var mins =
      typeof minute === "number"
        ? minute
        : Math.round((hrs - Math.floor(hrs)) * 60);
    hrs = Math.floor(hrs);
    if (mins < 0) mins = 0;
    if (mins > 59) mins = 59;
    return String(hrs).padStart(2, "0") + ":" + String(mins).padStart(2, "0");
  }

  function dayHoursSummary(h) {
    var day = C().normalizeDayHours(h);
    if (day.closed) return "Fechado";
    var text =
      formatHourClock(day.open, day.openMinute) +
      " – " +
      formatHourClock(day.close, day.closeMinute);
    if (day.lunchEnabled) {
      text +=
        " · Almoço " +
        formatHourClock(day.lunchStart) +
        "–" +
        formatHourClock(day.lunchEnd);
    }
    return text;
  }

  function timeInputValue(hour, minute) {
    return formatHourClock(hour, minute || 0);
  }

  function parseTimeInput(value, fallbackHour, fallbackMinute) {
    var raw = String(value || "").trim();
    var m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      return {
        hour: typeof fallbackHour === "number" ? fallbackHour : 9,
        minute: typeof fallbackMinute === "number" ? fallbackMinute : 0,
      };
    }
    return {
      hour: Math.min(23, Math.max(0, parseInt(m[1], 10))),
      minute: Math.min(59, Math.max(0, parseInt(m[2], 10))),
    };
  }

  function buildWeeklyHoursForm(container, weeklyHours) {
    if (!container) return;
    container.innerHTML = "";
    container._whData = {};
    C().DAY_KEYS.forEach(function (key) {
      container._whData[key] = C().normalizeDayHours(
        (weeklyHours && weeklyHours[key]) || { closed: key === "sun", open: 9, close: 19 }
      );
    });

    var activeKey = null;
    var editor = document.createElement("div");
    editor.className = "weekly-day-editor hidden";
    editor.id = "weeklyDayEditor";
    editor.innerHTML =
      '<div class="weekly-editor-head">' +
      '<h4 class="weekly-editor-title" id="weeklyEditorTitle">Configurar dia</h4>' +
      '<button type="button" class="salon-btn-ghost weekly-editor-close" id="weeklyEditorClose">Fechar</button>' +
      "</div>" +
      '<label class="weekly-open-toggle payment-option">' +
      '<input type="checkbox" id="weeklyEditorOpen" checked /> Aberto para atendimento' +
      "</label>" +
      '<div class="weekly-editor-fields" id="weeklyEditorFields">' +
      '<div class="grid-2">' +
      '<div class="field"><label for="weeklyEditorOpenHour">Abertura</label>' +
      '<input class="salon-input" type="time" id="weeklyEditorOpenHour" step="1800" /></div>' +
      '<div class="field"><label for="weeklyEditorCloseHour">Último horário</label>' +
      '<input class="salon-input" type="time" id="weeklyEditorCloseHour" step="1800" /></div>' +
      "</div>" +
      '<p class="muted" style="margin:0.35rem 0 0;font-size:0.8rem">O fechamento é o último horário que o cliente pode escolher (ex.: 18:30).</p>' +
      '<label class="weekly-lunch-toggle payment-option">' +
      '<input type="checkbox" id="weeklyEditorLunch" /> Intervalo de almoço' +
      "</label>" +
      '<div class="grid-2 weekly-lunch-fields hidden" id="weeklyLunchFields">' +
      '<div class="field"><label for="weeklyEditorLunchStart">Início do almoço</label>' +
      '<input class="salon-input" type="number" id="weeklyEditorLunchStart" min="0" max="23" step="1" /></div>' +
      '<div class="field"><label for="weeklyEditorLunchEnd">Fim do almoço</label>' +
      '<input class="salon-input" type="number" id="weeklyEditorLunchEnd" min="1" max="24" step="1" /></div>' +
      "</div></div>";

    function updateChip(key) {
      var chip = container.querySelector('[data-wh-day="' + key + '"]');
      if (!chip) return;
      var summary = chip.querySelector(".weekly-day-chip-summary");
      if (summary) summary.textContent = dayHoursSummary(container._whData[key]);
      chip.classList.toggle("is-closed", !!container._whData[key].closed);
    }

    function saveEditorToActive() {
      if (!activeKey) return;
      var openToggle = document.getElementById("weeklyEditorOpen");
      var openHour = document.getElementById("weeklyEditorOpenHour");
      var closeHour = document.getElementById("weeklyEditorCloseHour");
      var lunchToggle = document.getElementById("weeklyEditorLunch");
      var lunchStart = document.getElementById("weeklyEditorLunchStart");
      var lunchEnd = document.getElementById("weeklyEditorLunchEnd");
      var openT = parseTimeInput(openHour ? openHour.value : "", 9, 0);
      var closeT = parseTimeInput(closeHour ? closeHour.value : "", 18, 30);
      container._whData[activeKey] = C().normalizeDayHours({
        closed: openToggle ? !openToggle.checked : false,
        open: openT.hour,
        openMinute: openT.minute,
        close: closeT.hour,
        closeMinute: closeT.minute,
        lunchEnabled: lunchToggle ? lunchToggle.checked : false,
        lunchStart: lunchStart ? parseInt(lunchStart.value, 10) : 12,
        lunchEnd: lunchEnd ? parseInt(lunchEnd.value, 10) : 13,
      });
      updateChip(activeKey);
    }

    function syncEditorFieldsState() {
      var openToggle = document.getElementById("weeklyEditorOpen");
      var fields = document.getElementById("weeklyEditorFields");
      var lunchToggle = document.getElementById("weeklyEditorLunch");
      var lunchFields = document.getElementById("weeklyLunchFields");
      if (fields) fields.classList.toggle("hidden", openToggle && !openToggle.checked);
      if (lunchFields) lunchFields.classList.toggle("hidden", !lunchToggle || !lunchToggle.checked);
    }

    function openDayEditor(key) {
      if (activeKey && activeKey !== key) saveEditorToActive();
      activeKey = key;
      container.querySelectorAll(".weekly-day-chip").forEach(function (chip) {
        chip.classList.toggle("is-active", chip.getAttribute("data-wh-day") === key);
      });
      var day = container._whData[key];
      document.getElementById("weeklyEditorTitle").textContent = "Configurar — " + dayHoursLabel(key);
      document.getElementById("weeklyEditorOpen").checked = !day.closed;
      document.getElementById("weeklyEditorOpenHour").value = timeInputValue(day.open, day.openMinute);
      document.getElementById("weeklyEditorCloseHour").value = timeInputValue(day.close, day.closeMinute);
      document.getElementById("weeklyEditorLunch").checked = !!day.lunchEnabled;
      document.getElementById("weeklyEditorLunchStart").value = day.lunchStart;
      document.getElementById("weeklyEditorLunchEnd").value = day.lunchEnd;
      syncEditorFieldsState();
      editor.classList.remove("hidden");
    }

    function closeDayEditor() {
      saveEditorToActive();
      activeKey = null;
      editor.classList.add("hidden");
      container.querySelectorAll(".weekly-day-chip").forEach(function (chip) {
        chip.classList.remove("is-active");
      });
    }

    WEEKLY_CATEGORIES.forEach(function (cat) {
      var section = document.createElement("section");
      section.className = "weekly-category";
      section.innerHTML = '<h4 class="weekly-category-title">' + cat.label + "</h4>";
      var list = document.createElement("div");
      list.className = "weekly-day-list";
      cat.keys.forEach(function (key) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "weekly-day-chip" + (container._whData[key].closed ? " is-closed" : "");
        chip.setAttribute("data-wh-day", key);
        chip.innerHTML =
          '<span class="weekly-day-chip-name">' +
          dayHoursLabel(key) +
          '</span><span class="weekly-day-chip-summary">' +
          dayHoursSummary(container._whData[key]) +
          "</span>";
        chip.onclick = function () {
          if (activeKey === key && !editor.classList.contains("hidden")) {
            closeDayEditor();
            return;
          }
          openDayEditor(key);
        };
        list.appendChild(chip);
      });
      section.appendChild(list);
      container.appendChild(section);
    });

    container.appendChild(editor);

    ["weeklyEditorOpen", "weeklyEditorLunch"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.onchange = syncEditorFieldsState;
    });
    ["weeklyEditorOpenHour", "weeklyEditorCloseHour", "weeklyEditorLunchStart", "weeklyEditorLunchEnd"].forEach(
      function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.onchange = function () {
            saveEditorToActive();
          };
        }
      }
    );
    document.getElementById("weeklyEditorOpen").onchange = function () {
      syncEditorFieldsState();
      saveEditorToActive();
    };
    document.getElementById("weeklyEditorLunch").onchange = function () {
      syncEditorFieldsState();
      saveEditorToActive();
    };
    document.getElementById("weeklyEditorClose").onclick = closeDayEditor;
  }

  function readWeeklyHoursFromForm(container) {
    if (!container || !container._whData) {
      var wh = {};
      C().DAY_KEYS.forEach(function (key) {
        wh[key] = C().normalizeDayHours({ closed: false, open: 9, close: 19 });
      });
      return wh;
    }
    var editor = document.getElementById("weeklyDayEditor");
    if (editor && !editor.classList.contains("hidden")) {
      var activeChip = container.querySelector(".weekly-day-chip.is-active");
      if (activeChip) {
        var key = activeChip.getAttribute("data-wh-day");
        var openToggle = document.getElementById("weeklyEditorOpen");
        var openT = parseTimeInput(document.getElementById("weeklyEditorOpenHour").value, 9, 0);
        var closeT = parseTimeInput(document.getElementById("weeklyEditorCloseHour").value, 18, 30);
        container._whData[key] = C().normalizeDayHours({
          closed: openToggle ? !openToggle.checked : false,
          open: openT.hour,
          openMinute: openT.minute,
          close: closeT.hour,
          closeMinute: closeT.minute,
          lunchEnabled: document.getElementById("weeklyEditorLunch").checked,
          lunchStart: parseInt(document.getElementById("weeklyEditorLunchStart").value, 10),
          lunchEnd: parseInt(document.getElementById("weeklyEditorLunchEnd").value, 10),
        });
      }
    }
    var out = {};
    C().DAY_KEYS.forEach(function (key) {
      out[key] = C().normalizeDayHours(container._whData[key]);
    });
    return out;
  }

  function fullSalonAddress(salon) {
    var parts = [salon.address, salon.city, salon.state, salon.zipCode].filter(Boolean);
    return parts.join(" — ");
  }

  function salonWhatsAppGreeting(salon) {
    return (
      "Olá! Vi a barbearia " +
      (salon.salonName || "") +
      " no App Barber e gostaria de mais informações."
    );
  }

  function buildBookingWhatsAppMessage(salon, client, appt, service, professional) {
    var lines = [
      "Olá! Acabei de agendar pelo App Barber.",
      "",
      "Barbearia: " + (salon.salonName || ""),
      "Cliente: " + (client.name || ""),
      "Serviço: " + (appt.serviceName || (service && service.name) || ""),
    ];
    if (professional && professional.name) lines.push("Profissional: " + professional.name);
    else if (appt.professionalName) lines.push("Profissional: " + appt.professionalName);
    lines.push("Data/hora: " + formatRange(appt.startAt));
    lines.push("Status: Aguardando confirmação");
    return lines.join("\n");
  }

  function sendBookingWhatsApp(salon, client, appt, service, professional) {
    var phone = C().salonWhatsAppNumber(salon);
    if (!phone) return;
    var msg = buildBookingWhatsAppMessage(salon, client, appt, service, professional);
    if (!C().openWhatsAppChat(phone, msg)) {
      showMsg("Não foi possível abrir o WhatsApp. Verifique se a barbearia cadastrou o número.");
    }
  }

  function instagramLink(raw) {
    var v = (raw || "").trim();
    if (!v) return "";
    if (v.indexOf("http") === 0) return v;
    if (v.charAt(0) === "@") v = v.slice(1);
    return "https://instagram.com/" + encodeURIComponent(v.replace(/^@/, ""));
  }

  function facebookLink(raw) {
    var v = (raw || "").trim();
    if (!v) return "";
    if (v.indexOf("http") === 0) return v;
    if (v.indexOf("facebook.com") >= 0 || v.indexOf("fb.com") >= 0) {
      return v.indexOf("http") === 0 ? v : "https://" + v.replace(/^\/\//, "");
    }
    return "https://facebook.com/" + encodeURIComponent(v.replace(/^@/, ""));
  }

  var SOCIAL_SVG = {
    whatsapp:
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
    instagram:
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>',
    facebook:
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
  };

  function socialIconEl(network, extraClass) {
    var span = document.createElement("span");
    span.className = "social-icon-svg" + (extraClass ? " " + extraClass : "");
    span.innerHTML = SOCIAL_SVG[network] || "";
    return span;
  }

  function salonSocialActions(salon) {
    var actions = [];
    var waPhone = C().salonWhatsAppNumber(salon);
    var ig = instagramLink(salon.instagram);
    var fb = facebookLink(salon.facebook);
    if (waPhone) {
      actions.push({
        network: "whatsapp",
        label: "WhatsApp",
        sub: "Conversar com a barbearia",
        brandClass: "social-btn-wa",
        onClick: function () {
          if (!C().openWhatsAppChat(waPhone, salonWhatsAppGreeting(salon))) {
            showMsg("WhatsApp não disponível para esta barbearia.");
          }
        },
      });
    }
    if (ig) {
      actions.push({
        network: "instagram",
        label: "Instagram",
        sub: "Ver perfil",
        brandClass: "social-btn-ig",
        href: ig,
      });
    }
    if (fb) {
      actions.push({
        network: "facebook",
        label: "Facebook",
        sub: "Ver página",
        brandClass: "social-btn-fb",
        href: fb,
      });
    }
    return actions;
  }

  function renderBarberDashboard(salon) {
    var cover = document.getElementById("barberCover");
    if (cover) {
      if (salon && salon.coverUrl) {
        cover.style.backgroundImage = "url(" + salon.coverUrl + ")";
        cover.classList.remove("hidden");
      } else {
        cover.style.backgroundImage = "";
        cover.classList.add("hidden");
      }
    }

    var logo = document.getElementById("barberSalonLogo");
    var logoPh = document.getElementById("barberSalonLogoPh");
    var accent = salon && salon.accentHex ? salon.accentHex : "#c9a227";
    if (logo && logoPh) {
      if (salon && salon.logoUrl) {
        logo.src = salon.logoUrl;
        logo.alt = salon.salonName || "Logo";
        logo.classList.remove("hidden");
        logoPh.classList.add("hidden");
      } else {
        logo.classList.add("hidden");
        logoPh.classList.remove("hidden");
        logoPh.textContent = ((salon && salon.salonName) || "B").charAt(0).toUpperCase();
        logoPh.style.background = accent + "22";
        logoPh.style.color = accent;
      }
    }

    var nameEl = document.getElementById("barberSalonName");
    var metaEl = document.getElementById("barberSalonMeta");
    if (nameEl) nameEl.textContent = (salon && salon.salonName) || "Barbearia";
    if (metaEl) {
      metaEl.textContent =
        salon && salon.slug ? "Agendamento online · /b/" + salon.slug : "Painel administrativo";
    }

    if (salon) applySettingsToDom(salon);
  }

  function renderSocialCards(container, actions) {
    if (!container) return;
    container.innerHTML = "";
    actions.forEach(function (item) {
      var el = item.href ? document.createElement("a") : document.createElement("button");
      el.type = item.href ? undefined : "button";
      el.className = "social-link-card";
      if (item.href) {
        el.href = item.href;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
      } else if (item.onClick) {
        el.onclick = item.onClick;
      }
      var iconWrap = document.createElement("span");
      iconWrap.className = "social-btn " + (item.brandClass || "");
      iconWrap.appendChild(socialIconEl(item.network));
      el.appendChild(iconWrap);
      var text = document.createElement("span");
      text.className = "social-link-text";
      text.innerHTML = "<strong>" + item.label + '</strong><span class="muted">' + item.sub + "</span>";
      el.appendChild(text);
      container.appendChild(el);
    });
  }

  function paymentMethodsList(salon) {
    return (salon.paymentMethods || "")
      .split(/[,;|]/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function readPaymentOptionsForm(container) {
    if (!container) return "";
    var picked = [];
    container.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      picked.push(cb.value);
    });
    return picked.join(", ");
  }

  function fillPaymentOptionsForm(container, value) {
    if (!container) return;
    var lower = (value || "").toLowerCase();
    container.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.checked = lower.indexOf(cb.value.toLowerCase()) >= 0;
    });
  }

  function copyContactText(text, btn) {
    if (!text) return;
    var done = function () {
      var old = btn.textContent;
      btn.textContent = "Copiado!";
      setTimeout(function () {
        btn.textContent = old;
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        done();
      });
    } else {
      done();
    }
  }

  function salonAmenitiesList(salon) {
    var list = [];
    if (salon.hasWifi) {
      list.push({ icon: "📶", title: "Wi-Fi", detail: salon.wifiInfo || "Disponível para clientes" });
    }
    if (salon.hasParking) {
      list.push({ icon: "🅿️", title: "Estacionamento", detail: salon.parkingInfo || "Disponível" });
    }
    if (salon.hasKidsHaircut) {
      list.push({ icon: "👦", title: "Corte de criança", detail: "Atendemos crianças" });
    }
    if (salon.hasWheelchairAccess) {
      list.push({ icon: "♿", title: "Acesso para cadeirantes", detail: "Acesso facilitado" });
    }
    return list;
  }

  function createSalonLogoEl(salon, className) {
    var cls = className || "service-list-logo";
    if (salon && salon.logoUrl) {
      var img = document.createElement("img");
      img.className = cls;
      img.src = salon.logoUrl;
      img.alt = salon.salonName || "Logo";
      return img;
    }
    var ph = document.createElement("div");
    ph.className = cls + " service-list-logo-ph";
    ph.textContent = (salon && salon.salonName ? salon.salonName.charAt(0) : "B").toUpperCase();
    return ph;
  }

  function renderPublicInfo(salon) {
    var waPhone = C().salonWhatsAppNumber(salon);
    var addr = fullSalonAddress(salon);
    var locBlock = document.getElementById("pubLocationBlock");
    var locEl = document.getElementById("pubLocation");
    var maps = document.getElementById("pubMapsLink");
    if (locBlock && locEl) {
      if (addr) {
        locEl.textContent = addr;
        locBlock.classList.remove("hidden");
        if (maps) maps.href = "https://maps.google.com/?q=" + encodeURIComponent(addr);
      } else {
        locBlock.classList.add("hidden");
      }
    }

    var hoursEl = document.getElementById("pubHours");
    if (hoursEl) {
      hoursEl.innerHTML = "";
      var todayKey = C().dayKeyFromDate(new Date());
      C().DAY_KEYS.forEach(function (key) {
        var h = C().normalizeDayHours(
          (salon.weeklyHours && salon.weeklyHours[key]) || { closed: false, open: 9, close: 19 }
        );
        if (key === todayKey) {
          var todayH = C().getHoursForDay(salon, new Date());
          if (todayH.override) {
            h = Object.assign({}, h, {
              closed: todayH.closed,
              open: todayH.openHour,
              openMinute: todayH.openMinute,
              close: todayH.closeHour,
              closeMinute: todayH.closeMinute,
            });
          }
        }
        var li = document.createElement("li");
        li.className = "hours-row";
        var label = document.createElement("span");
        label.className = "hours-day";
        label.textContent = dayHoursLabel(key);
        var time = document.createElement("span");
        time.className = "hours-time";
        time.textContent = dayHoursSummary(h);
        li.appendChild(label);
        if (key === todayKey && !h.closed) {
          var badge = document.createElement("span");
          badge.className = "badge badge-confirmed hours-today";
          badge.textContent = "Hoje";
          li.appendChild(badge);
        }
        li.appendChild(time);
        hoursEl.appendChild(li);
      });
    }

    var payments = paymentMethodsList(salon);
    var payBlock = document.getElementById("pubPaymentBlock");
    var payEl = document.getElementById("pubPayment");
    if (payBlock && payEl) {
      payEl.innerHTML = "";
      if (payments.length) {
        payments.forEach(function (p) {
          var chip = document.createElement("span");
          chip.className = "payment-chip";
          chip.textContent = p;
          payEl.appendChild(chip);
        });
        payBlock.classList.remove("hidden");
      } else {
        payBlock.classList.add("hidden");
      }
    }

    var amenities = salonAmenitiesList(salon);
    var amenBlock = document.getElementById("pubAmenitiesBlock");
    var amenEl = document.getElementById("pubAmenities");
    if (amenBlock && amenEl) {
      amenEl.innerHTML = "";
      if (amenities.length) {
        amenities.forEach(function (a) {
          var card = document.createElement("div");
          card.className = "amenity-card";
          card.innerHTML =
            '<span class="amenity-icon">' +
            a.icon +
            '</span><div class="amenity-body"><strong>' +
            a.title +
            "</strong>" +
            (a.detail ? '<span class="amenity-detail">' + a.detail + "</span>" : "") +
            "</div>";
          amenEl.appendChild(card);
        });
        amenBlock.classList.remove("hidden");
      } else {
        amenBlock.classList.add("hidden");
      }
    }

    var socialBlock = document.getElementById("pubSocialBlock");
    var socialEl = document.getElementById("pubSocial");
    if (socialBlock && socialEl) {
      var socialActions = salonSocialActions(salon);
      renderSocialCards(socialEl, socialActions);
      if (socialActions.length) socialBlock.classList.remove("hidden");
      else socialBlock.classList.add("hidden");
    }

    var contactBlock = document.getElementById("pubContactBlock");
    var contactEl = document.getElementById("pubContact");
    if (contactBlock && contactEl) {
      contactEl.innerHTML = "";
      function addContact(icon, label, display, link) {
        if (!display) return;
        var href = link || "tel:" + String(display).replace(/\D/g, "");
        var ext = href.indexOf("http") === 0 ? ' target="_blank" rel="noopener"' : "";
        var row = document.createElement("div");
        row.className = "contact-row";
        row.innerHTML =
          '<span class="contact-icon">' +
          icon +
          "</span>" +
          '<div class="contact-info"><span class="contact-label">' +
          label +
          '</span><a class="contact-number" href="' +
          href +
          '"' +
          ext +
          ">" +
          display +
          "</a></div>";
        var copy = document.createElement("button");
        copy.type = "button";
        copy.className = "salon-btn-ghost contact-copy";
        copy.textContent = "Copiar";
        copy.onclick = function () {
          copyContactText(display, copy);
        };
        row.appendChild(copy);
        contactEl.appendChild(row);
      }
      addContact("📱", "Celular / WhatsApp", salon.phone, salon.phone ? "tel:" + salon.phone.replace(/\D/g, "") : null);
      addContact("☎", "Telefone fixo", salon.phone2, salon.phone2 ? "tel:" + salon.phone2.replace(/\D/g, "") : null);
      if (waPhone) {
        var waRow = document.createElement("div");
        waRow.className = "contact-row";
        waRow.innerHTML =
          '<span class="contact-icon">💬</span><div class="contact-info"><span class="contact-label">WhatsApp</span><span class="contact-number">' +
          (salon.whatsapp || salon.phone || "") +
          "</span></div>";
        var waOpen = document.createElement("button");
        waOpen.type = "button";
        waOpen.className = "salon-btn-primary contact-copy";
        waOpen.textContent = "Abrir WhatsApp";
        waOpen.onclick = function () {
          C().openWhatsAppChat(waPhone, salonWhatsAppGreeting(salon));
        };
        waRow.appendChild(waOpen);
        contactEl.appendChild(waRow);
      }
      if (contactEl.children.length) contactBlock.classList.remove("hidden");
      else contactBlock.classList.add("hidden");
    }

    var gal = document.getElementById("photoGallery");
    if (gal) {
      gal.innerHTML = "";
      var photos = (salon.photoUrls || []).filter(Boolean);
      if (photos.length) {
        var heading = document.createElement("h3");
        heading.className = "detail-heading";
        heading.textContent = "Galeria";
        gal.appendChild(heading);
        var grid = document.createElement("div");
        grid.className = "photo-gallery-grid";
        photos.forEach(function (url) {
          var img = document.createElement("img");
          img.src = url;
          img.alt = salon.salonName;
          img.className = "gallery-img";
          grid.appendChild(img);
        });
        gal.appendChild(grid);
      }
    }
  }

  function renderPublicServicesList(salon, list, selectedIds, canSelect, onToggle) {
    var box = document.getElementById("publicServicesList");
    if (!box) return;
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<p class="muted">Nenhum serviço cadastrado ainda.</p>';
      return;
    }
    var selected = selectedIds || [];
    list.forEach(function (s) {
      var row = document.createElement(canSelect ? "button" : "div");
      row.type = canSelect ? "button" : undefined;
      var isOn = canSelect && selected.indexOf(s.id) >= 0;
      row.className = "service-card-public" + (isOn ? " is-selected" : "");
      row.dataset.svcId = s.id;
      row.appendChild(createSalonLogoEl(salon, "service-list-logo"));
      var body = document.createElement("div");
      body.className = "service-card-body";
      body.innerHTML =
        "<strong>" +
        s.name +
        '</strong><span class="service-card-meta">' +
        s.durationMin +
        " min · " +
        formatMoney(s.priceCents) +
        "</span>";
      row.appendChild(body);
      if (canSelect) {
        var mark = document.createElement("span");
        mark.className = "service-check" + (isOn ? " is-on" : "");
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = isOn ? "✓" : "";
        row.appendChild(mark);
      }
      if (canSelect) {
        row.onclick = function () {
          if (onToggle) onToggle(s.id);
        };
      }
      box.appendChild(row);
    });
  }

  async function initHome() {
    var sess = await B().getSession().catch(function () {
      return null;
    });
    if (sessionRole(sess) === "BARBER" || sessionRole(sess) === "PROFESSIONAL") {
      location.replace("barbeiro.html");
      return;
    }

    function setHomeAuthTab(tab) {
      var loginPanel = document.getElementById("homeLoginPanel");
      var registerPanel = document.getElementById("homeRegisterPanel");
      document.querySelectorAll("#homeAuthTabs [data-home-tab]").forEach(function (btn) {
        var active = btn.getAttribute("data-home-tab") === tab;
        btn.classList.toggle("is-active", active);
      });
      if (loginPanel) loginPanel.classList.toggle("hidden", tab !== "login");
      if (registerPanel) registerPanel.classList.toggle("hidden", tab !== "register");
    }

    document.querySelectorAll("#homeAuthTabs [data-home-tab]").forEach(function (btn) {
      btn.onclick = function () {
        setHomeAuthTab(btn.getAttribute("data-home-tab"));
        showMsg("");
      };
    });

    if (new URLSearchParams(location.search).get("cadastro") === "1") {
      setHomeAuthTab("register");
    }

    var regSalon = document.getElementById("regSalon");
    var regSlug = document.getElementById("regSlug");
    if (regSalon && regSlug) {
      regSalon.oninput = function () {
        if (!regSlug.dataset.touched) regSlug.value = slugFromInput(regSalon.value);
      };
      regSlug.oninput = function () {
        regSlug.dataset.touched = "1";
        regSlug.value = slugFromInput(regSlug.value);
      };
    }

    var formReg = document.getElementById("formRegister");
    if (formReg) {
      formReg.onsubmit = function (ev) {
        ev.preventDefault();
        showMsg("");
        var payload = {
          salonName: document.getElementById("regSalon").value.trim(),
          slug:
            document.getElementById("regSlug").value.trim() ||
            slugFromInput(document.getElementById("regSalon").value),
          phone: document.getElementById("regPhone").value.trim(),
        };
        B()
          .registerBarber(
            document.getElementById("regName").value.trim(),
            payload.phone,
            document.getElementById("regEmail").value.trim(),
            document.getElementById("regPass").value,
            payload
          )
          .then(function () {
            showMsg(
              "Cadastro recebido! Aguarde a liberação do plano para usar o painel.",
              "ok"
            );
            setTimeout(function () {
              location.href = "barbeiro.html";
            }, 2000);
          })
          .catch(function (e) {
            showMsg(friendlyAuthError(e));
          });
      };
    }

    document.getElementById("formLogin").onsubmit = function (ev) {
      ev.preventDefault();
      showMsg("");
      B()
        .loginBarber(document.getElementById("logEmail").value, document.getElementById("logPass").value)
        .then(function () {
          location.href = "barbeiro.html";
        })
        .catch(function (e) {
          showMsg(friendlyAuthError(e));
        });
    };

    if (window.SalaoInstall) window.SalaoInstall.init({ app: "admin" });
  }

  async function initApp() {
    var boundSlug = B().getClientBoundSlug();
    if (boundSlug) {
      location.replace("/b/" + encodeURIComponent(boundSlug));
      return;
    }

    await B().waitForAuth();
    var clientPos = null;
    var salons = [];

    var sess = await B().getSession().catch(function () {
      return null;
    });
    if (sessionRole(sess) === "BARBER" || sessionRole(sess) === "PROFESSIONAL") {
      location.replace("/index.html");
      return;
    }

    function setClientAuthTab(tab) {
      document.querySelectorAll("#clientAuthTabs [data-client-tab]").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.getAttribute("data-client-tab") === tab);
      });
      document.getElementById("formAppClientLogin").classList.toggle("hidden", tab !== "login");
      document.getElementById("formAppClientRegister").classList.toggle("hidden", tab !== "register");
    }

    document.querySelectorAll("#clientAuthTabs [data-client-tab]").forEach(function (btn) {
      btn.onclick = function () {
        setClientAuthTab(btn.getAttribute("data-client-tab"));
        showMsg("");
      };
    });
    setClientAuthTab("login");

    async function refreshClientAuth() {
      await B().waitForAuth();
      var session = await B().getSession().catch(function () {
        return null;
      });
      var role = sessionRole(session);
      if (role === "BARBER" || role === "PROFESSIONAL") {
        location.replace("/index.html");
        return;
      }
      var profile =
        role === "CLIENT"
          ? await B().getProfile().catch(function () {
              return null;
            })
          : null;
      var guestBar = document.getElementById("clientGuestBar");
      var userBar = document.getElementById("clientUserBar");
      if (profile) {
        guestBar.classList.add("hidden");
        userBar.classList.remove("hidden");
        document.getElementById("appClientGreeting").textContent = profile.name || "Cliente";
      } else {
        guestBar.classList.remove("hidden");
        userBar.classList.add("hidden");
        setClientAuthTab("login");
      }
      setHidden("clientSalonDirectory", false);
      await loadSalons();
    }

    document.getElementById("formAppClientLogin").onsubmit = function (ev) {
      ev.preventDefault();
      showMsg("");
      B()
        .loginClient(document.getElementById("appClientEmail").value, document.getElementById("appClientPass").value)
        .then(function () {
          return refreshClientAuth();
        })
        .then(function () {
          showMsg("Bem-vindo! Escolha uma barbearia para agendar.", "ok");
        })
        .catch(function (e) {
          showMsg(friendlyAuthError(e));
        });
    };

    document.getElementById("formAppClientRegister").onsubmit = function (ev) {
      ev.preventDefault();
      showMsg("");
      B()
        .registerClient(
          document.getElementById("appClientName").value.trim(),
          document.getElementById("appClientPhone").value.trim(),
          document.getElementById("appClientRegEmail").value.trim(),
          document.getElementById("appClientRegPass").value,
          null
        )
        .then(function () {
          return refreshClientAuth();
        })
        .then(function () {
          showMsg("Conta criada! Escolha uma barbearia para agendar.", "ok");
        })
        .catch(function (e) {
          showMsg(friendlyAuthError(e));
        });
    };

    document.getElementById("btnAppClientLogout").onclick = function () {
      B()
        .logout()
        .then(function () {
          location.replace("/app.html");
        })
        .catch(function (e) {
          console.error(e);
          location.replace("/app.html");
        });
    };

    function sortSalons(list) {
      var rows = list.slice();
      if (clientPos) {
        rows.forEach(function (s) {
          s._distanceKm =
            s.latitude != null && s.longitude != null
              ? C().haversineKm(clientPos.lat, clientPos.lng, s.latitude, s.longitude)
              : null;
        });
        rows.sort(function (a, b) {
          if (a._distanceKm == null && b._distanceKm == null) {
            return (a.salonName || "").localeCompare(b.salonName || "", "pt-BR");
          }
          if (a._distanceKm == null) return 1;
          if (b._distanceKm == null) return -1;
          return a._distanceKm - b._distanceKm;
        });
      } else {
        rows.sort(function (a, b) {
          return (a.salonName || "").localeCompare(b.salonName || "", "pt-BR");
        });
      }
      return rows;
    }

    function renderSalonDirectory() {
      var box = document.getElementById("salonDirectory");
      var hint = document.getElementById("salonDirectoryHint");
      if (!box) return;
      box.innerHTML = "";
      var rows = sortSalons(salons);
      if (!rows.length) {
        box.innerHTML = '<p class="muted">Nenhuma barbearia cadastrada ainda.</p>';
        if (hint) hint.textContent = "Volte em breve — novas barbearias aparecem aqui.";
        return;
      }
      if (hint) {
        hint.textContent = clientPos
          ? "Ordenado pela distância da sua localização."
          : "Toque em «Perto de mim» para ver os salões mais próximos.";
      }
      rows.forEach(function (s) {
        var card = document.createElement("article");
        card.className = "salon-directory-card";
        var addr = fullSalonAddress(s);
        var maps = C().salonMapsUrl(s);
        var dist =
          s._distanceKm != null ? '<span class="salon-directory-distance">' + C().formatDistanceKm(s._distanceKm) + "</span>" : "";
        var logoHtml = s.logoUrl
          ? '<img class="salon-directory-logo" src="' + s.logoUrl + '" alt="" />'
          : '<div class="salon-directory-logo salon-directory-logo-ph" style="background:' +
            (s.accentHex || "#c9a227") +
            '22"></div>';
        var statusBadge = s.subscriptionActive
          ? '<span class="badge badge-confirmed">Agendamento aberto</span>'
          : '<span class="badge badge-warn">Em breve</span>';
        card.innerHTML =
          '<div class="salon-directory-top">' +
          logoHtml +
          '<div class="salon-directory-info">' +
          '<div class="salon-directory-title-row">' +
          "<h3>" +
          (s.salonName || "Barbearia") +
          "</h3>" +
          dist +
          "</div>" +
          (addr ? '<p class="salon-directory-address">' + addr + "</p>" : '<p class="muted">Endereço não informado</p>') +
          '<div class="salon-directory-meta">' +
          statusBadge +
          "</div>" +
          "</div></div>" +
          '<div class="salon-directory-actions">' +
          (maps
            ? '<a class="salon-btn-outline" href="' +
              maps +
              '" target="_blank" rel="noopener noreferrer">Ver no mapa</a>'
            : "") +
          '<a class="salon-btn-primary" href="/b/' +
          encodeURIComponent(s.slug) +
          '">Agendar</a>' +
          "</div>";
        box.appendChild(card);
      });
    }

    async function loadSalons() {
      try {
        salons = await B().listPublicSalons();
      } catch (e) {
        console.error("Salões:", e);
        salons = [];
        showMsg("Não foi possível carregar as barbearias.");
      }
      renderSalonDirectory();
    }

    document.getElementById("btnUseLocation").onclick = function () {
      if (!navigator.geolocation) {
        showMsg("Seu dispositivo não suporta localização.");
        return;
      }
      showMsg("Obtendo localização…");
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          clientPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          showMsg("");
          renderSalonDirectory();
        },
        function () {
          showMsg("Permita o acesso à localização para ordenar por proximidade.");
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }
      );
    };

    await refreshClientAuth();

    if (window.SalaoInstall) window.SalaoInstall.init({ app: "cliente" });
  }

  async function initPublic() {
    await B().waitForAuth();
    // Sempre respeita o slug da URL do barbeiro (não redireciona para outro salão).
    var slug = C().slugify(C().parseSlugFromLocation() || "demo");
    B().bindClientSalon(slug);
    B().setCtxSlug(slug);

    var salon = await B().getSalonBySlug(slug);
    if (!salon) {
      document.getElementById("publicName").textContent = "Barbearia não encontrada";
      showMsg("Link inválido ou barbearia removida.");
      return;
    }

    applySettingsToDom(salon);
    renderPublicInfo(salon);
    if (window.SalaoInstall) {
      window.SalaoInstall.setClientManifest(salon);
      window.SalaoInstall.init({ app: "cliente" });
    }

    var salonId = salon.id;
    var services = [];
    var professionals = [];
    var me = null;
    var selectedIso = null;
    var selectedServiceIds = [];
    var pendingBooking = false;

    function getSelectedServices() {
      return services.filter(function (s) {
        return selectedServiceIds.indexOf(s.id) >= 0;
      });
    }

    function getBookingTotals() {
      var picked = getSelectedServices();
      var durationMin = 0;
      var priceCents = 0;
      picked.forEach(function (s) {
        durationMin += s.durationMin || 0;
        priceCents += s.priceCents || 0;
      });
      return { durationMin: durationMin, priceCents: priceCents, count: picked.length };
    }

    function updateServiceSelectionLabel() {
      var picked = getSelectedServices();
      var totals = getBookingTotals();
      var summary = document.getElementById("svcSelectedSummary");
      if (summary) {
        summary.textContent =
          totals.count +
          (totals.count === 1 ? " selecionado" : " selecionados") +
          " · " +
          formatMoney(totals.priceCents) +
          " · " +
          totals.durationMin +
          " min";
      }
      var label = document.getElementById("svcSelectedLabel");
      if (label) {
        label.textContent = picked.length
          ? "Serviços: " + picked.map(function (s) { return s.name; }).join(", ")
          : "Serviços: escolha na lista acima.";
      }
      var hidden = document.getElementById("svcSelect");
      if (hidden) hidden.value = selectedServiceIds.join(",");
    }

    function toggleService(svcId) {
      if (!svcId) return;
      var idx = selectedServiceIds.indexOf(svcId);
      if (idx >= 0) selectedServiceIds.splice(idx, 1);
      else selectedServiceIds.push(svcId);
      updateServiceSelectionLabel();
      renderPublicServicesList(salon, services, selectedServiceIds, true, toggleService);
      renderSlots();
    }

    function showBrowseUI() {
      setHidden("publicSalonHeader", false);
      setHidden("publicServicesSection", false);
      setHidden("publicInfo", false);
      setHidden("bookingPanel", false);
      if (salon.coverUrl) setHidden("publicCover", false);
    }

    function showAccountForBooking() {
      setHidden("publicAccountSection", false);
      var title = document.getElementById("publicAccountTitle");
      var desc = document.getElementById("publicAccountDesc");
      if (title) title.textContent = "Finalize seu agendamento";
      if (desc) {
        desc.textContent = "Entre ou crie sua conta para confirmar o horário escolhido.";
      }
      var acc = document.getElementById("publicAccountSection");
      if (acc) acc.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function selectService(svcId) {
      toggleService(svcId);
    }

    function setPublicAuthTab(tab) {
      document.querySelectorAll("#publicAuthTabs [data-public-tab]").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.getAttribute("data-public-tab") === tab);
      });
      setHidden("formPublicLogin", tab !== "login");
      setHidden("formPublicRegister", tab !== "register");
    }

    var hasNewPublicLayout = !!document.getElementById("publicAccountSection");

    if (!hasNewPublicLayout) {
      location.replace("/b/" + encodeURIComponent(salon.slug) + "?v=" + Date.now());
      return;
    }

    if (!B().isSalonActive(salon)) {
      showMsg("Esta barbearia ainda não está ativa. Agendamentos indisponíveis.", "ok");
      showBrowseUI();
      setHidden("bookingPanel", true);
      setHidden("publicAccountSection", true);
      return;
    }

    async function refreshSubscriberNote() {
      var note = document.getElementById("subscriberBookingNote");
      if (!note) return;
      if (!me || !C().phoneKey(me.phone)) {
        note.classList.add("hidden");
        note.textContent = "";
        return;
      }
      var match = null;
      try {
        match = await B().findMembershipForClient(salonId, me.name, me.phone);
      } catch (e) {
        match = null;
      }
      var text = subscriberBookingText(match);
      if (!text) {
        note.classList.add("hidden");
        note.textContent = "";
        return;
      }
      note.textContent = text;
      note.classList.remove("hidden");
    }

    async function refreshAuth() {
      await B().waitForAuth();
      var sess = await B().getSession();
      var role = sessionRole(sess);
      me = role === "CLIENT" ? await B().getProfile() : null;

      showBrowseUI();

      if (me) {
        setHidden("publicAccountSection", true);
        setHidden("publicUserBar", false);
        setHidden("historyPanel", false);
        setHidden("notifPanel", false);
        var greeting = document.getElementById("publicGreeting");
        if (greeting) greeting.textContent = "Olá, " + me.name;
        await loadBooking();
        await renderHistory();
        await renderNotifs();
        await refreshSubscriberNote();
      } else {
        setHidden("publicAccountSection", !pendingBooking);
        setHidden("publicUserBar", true);
        setHidden("historyPanel", true);
        setHidden("notifPanel", true);
        await loadBooking();
      }
    }

    async function afterAuthSuccess() {
      await refreshAuth();
      if (pendingBooking && me) {
        pendingBooking = false;
        setHidden("publicAccountSection", true);
        await confirmBooking();
      }
    }

    document.querySelectorAll("#publicAuthTabs [data-public-tab]").forEach(function (btn) {
      btn.onclick = function () {
        setPublicAuthTab(btn.getAttribute("data-public-tab"));
        showMsg("");
      };
    });
    setPublicAuthTab("login");

    var btnLogout = document.getElementById("btnPublicLogout");
    if (!btnLogout) {
      showMsg("Página desatualizada. Atualize o navegador.", "ok");
      return;
    }

    btnLogout.onclick = function () {
      var slug = salon.slug;
      B()
        .logout()
        .then(function () {
          location.replace("/b/" + encodeURIComponent(slug));
        })
        .catch(function (e) {
          console.error(e);
          location.replace("/b/" + encodeURIComponent(slug));
        });
    };

    document.getElementById("formPublicLogin").onsubmit = function (ev) {
      ev.preventDefault();
      showMsg("");
      pendingBooking = true;
      B()
        .loginClient(document.getElementById("pubEmail").value, document.getElementById("pubPass").value)
        .then(function () {
          return afterAuthSuccess();
        })
        .catch(function (e) {
          showMsg(friendlyAuthError(e));
        });
    };

    document.getElementById("formPublicRegister").onsubmit = function (ev) {
      ev.preventDefault();
      showMsg("");
      pendingBooking = true;
      B()
        .registerClient(
          document.getElementById("pubName").value.trim(),
          document.getElementById("pubPhone").value.trim(),
          document.getElementById("pubRegEmail").value.trim(),
          document.getElementById("pubRegPass").value,
          salonId
        )
        .then(function () {
          return afterAuthSuccess();
        })
        .catch(function (e) {
          showMsg(friendlyAuthError(e));
        });
    };

    function getSelectedProId() {
      return document.getElementById("proSelect").value || "";
    }

    function selectProfessional(proId) {
      document.getElementById("proSelect").value = proId || "";
      document.querySelectorAll("#proPicker .pro-card").forEach(function (card) {
        card.classList.toggle("is-selected", card.dataset.proId === proId);
      });
    }

    function renderProPicker() {
      var picker = document.getElementById("proPicker");
      var hidden = document.getElementById("proSelect");
      if (!picker) return;
      picker.innerHTML = "";
      if (!professionals.length) {
        picker.innerHTML = '<p class="muted">Nenhum profissional disponível no momento.</p>';
        if (hidden) hidden.value = "";
        return;
      }
      professionals.forEach(function (p, idx) {
        var card = document.createElement("button");
        card.type = "button";
        card.className = "pro-card" + (idx === 0 ? " is-selected" : "");
        card.dataset.proId = p.id;
        card.appendChild(createProAvatarEl(p, "pro-card-photo"));
        var nm = document.createElement("span");
        nm.className = "pro-card-name";
        nm.textContent = p.name || "Profissional";
        card.appendChild(nm);
        card.onclick = function () {
          selectProfessional(p.id);
          renderSlots();
        };
        picker.appendChild(card);
      });
      if (hidden) hidden.value = professionals[0].id;
    }

    async function loadBooking() {
      try {
        services = (await B().listServices(salonId)).filter(function (s) {
          return s.active !== false;
        });
        professionals = await B().listProfessionals(salonId);
      } catch (e) {
        console.error("Agendamento:", e);
        showMsg(friendlyAuthError(e));
        return;
      }
      updateServiceSelectionLabel();
      renderPublicServicesList(salon, services, selectedServiceIds, true, toggleService);
      renderProPicker();
      var dayInput = document.getElementById("dayInput");
      var today = C().startOfDay(new Date());
      dayInput.min = today.toISOString().slice(0, 10);
      dayInput.value = today.toISOString().slice(0, 10);
      dayInput.onchange = renderSlots;
      await renderSlots();
    }

    var slotsRenderToken = 0;

    async function renderSlots() {
      var renderId = ++slotsRenderToken;
      var grid = document.getElementById("slotGrid");
      var hint = document.getElementById("slotHint");
      if (grid) grid.innerHTML = "";
      selectedIso = null;
      var btnBook = document.getElementById("btnBook");
      if (btnBook) btnBook.disabled = true;

      salon = await B().getSalonById(salonId);
      if (renderId !== slotsRenderToken) return;
      var pid = getSelectedProId();
      var picked = getSelectedServices();
      var totals = getBookingTotals();
      if (!pid) {
        if (hint) {
          hint.textContent = professionals.length
            ? "Escolha o profissional."
            : "Nenhum profissional cadastrado nesta barbearia.";
        }
        return;
      }
      if (!picked.length || totals.durationMin < 5) {
        if (hint) {
          hint.textContent = services.length
            ? "Selecione um ou mais serviços acima."
            : "Nenhum serviço cadastrado nesta barbearia.";
        }
        return;
      }
      var active = [];
      var blocked = [];
      try {
        active = await B().listActiveAppointments(salonId);
        if (renderId !== slotsRenderToken) return;
        blocked = await B().listBlockedSlots(salonId);
        if (renderId !== slotsRenderToken) return;
      } catch (e) {
        if (renderId !== slotsRenderToken) return;
        console.error("Horários:", e);
        if (hint) hint.textContent = "Não foi possível carregar os horários.";
        showMsg(friendlyAuthError(e));
        return;
      }
      var dayInput = document.getElementById("dayInput");
      var day = new Date((dayInput ? dayInput.value : "") + "T12:00:00");
      var hours = C().getHoursForDay(salon, day);
      if (hours.closed) {
        if (hint) hint.textContent = "Fechado neste dia.";
        return;
      }
      var slotStates = C().getDaySlotStates(day, totals.durationMin, salon, active, blocked, pid);
      var visible = [];
      var seenTimes = {};
      slotStates.forEach(function (s) {
        if (s.status === "past") return;
        var key = s.start.getHours() + ":" + s.start.getMinutes();
        if (seenTimes[key]) return;
        seenTimes[key] = true;
        visible.push(s);
      });
      if (renderId !== slotsRenderToken) return;
      if (!visible.length) {
        if (hint) hint.textContent = "Sem horários neste dia.";
        return;
      }
      var availableCount = visible.filter(function (s) {
        return s.status === "available";
      }).length;
      if (hint) {
        hint.textContent = availableCount
          ? "Toque em um horário livre. Horários ocupados ficam apagados."
          : "Todos os horários deste dia estão ocupados. Tente outra data.";
      }
      if (grid) grid.innerHTML = "";
      visible.forEach(function (slot) {
        var b = document.createElement("button");
        b.type = "button";
        var timeLabel = slot.start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        if (slot.status === "available") {
          b.className = "slot-chip";
          b.textContent = timeLabel;
          b.dataset.iso = slot.start.toISOString();
          b.onclick = function () {
            grid.querySelectorAll(".slot-chip:not(.slot-chip-busy)").forEach(function (x) {
              x.classList.remove("is-selected");
            });
            b.classList.add("is-selected");
            selectedIso = b.dataset.iso;
            document.getElementById("btnBook").disabled = false;
          };
        } else {
          b.className = "slot-chip slot-chip-busy";
          b.disabled = true;
          b.setAttribute("aria-label", timeLabel + " ocupado");
          b.innerHTML =
            '<span class="slot-busy-time">' +
            timeLabel +
            '</span><span class="slot-busy-label">Ocupado</span>';
        }
        grid.appendChild(b);
      });
    }

    async function confirmBooking() {
      if (!me) return;
      var pid = getSelectedProId();
      var pro = professionals.find(function (p) {
        return p.id === pid;
      });
      var picked = getSelectedServices();
      var totals = getBookingTotals();
      if (!picked.length || !pid || !selectedIso) {
        showMsg("Escolha serviços, profissional e horário.");
        return;
      }
      var active = await B().listActiveAppointments(salonId);
      var startAt = new Date(selectedIso);
      var endAt = C().addMinutes(startAt, totals.durationMin);
      try {
        C().assertSlotFree(startAt, endAt, undefined, active, pid);
      } catch (e) {
        showMsg(e.message);
        renderSlots();
        return;
      }
      var serviceNames = picked.map(function (s) { return s.name; }).join(" + ");
      var subscriber = null;
      try {
        subscriber = await B().findMembershipForClient(salonId, me.name, me.phone || "");
      } catch (e) {
        subscriber = null;
      }
      var ap = {
        clientId: me.id,
        clientName: me.name,
        clientPhone: me.phone || "",
        professionalId: pid,
        professionalName: pro ? pro.name : "",
        serviceId: picked[0].id,
        serviceIds: picked.map(function (s) { return s.id; }),
        serviceName: serviceNames,
        priceCents: totals.priceCents,
        durationMin: totals.durationMin,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        status: "PENDING",
      };
      attachSubscriber(ap, subscriber);
      try {
        await B().createAppointment(salonId, ap);
        if (salon.notifyBarberUid || salon.ownerId) {
          try {
            await B().addNotification(
              salonId,
              salon.notifyBarberUid || salon.ownerId,
              "Novo agendamento: " + me.name + " — " + serviceNames + " em " + formatRange(ap.startAt)
            );
          } catch (notifyErr) {
            console.warn("Notificação ao barbeiro:", notifyErr);
          }
        }
        var hasWhats = !!C().salonWhatsAppNumber(salon);
        var subText = subscriberBookingText(subscriber);
        showMsg(
          (hasWhats
            ? "Agendamento enviado! Abrindo o WhatsApp da barbearia — toque em Enviar para avisar o barbeiro."
            : "Agendamento enviado! Aguarde confirmação.") + (subText ? " " + subText : ""),
          "ok"
        );
        sendBookingWhatsApp(salon, me, ap, { name: serviceNames }, pro);
      } catch (e) {
        showMsg(e.message || "Erro ao agendar.");
        return;
      }
      renderSlots();
      renderHistory();
    }

    document.getElementById("btnBook").onclick = async function () {
      var pid = getSelectedProId();
      var picked = getSelectedServices();
      if (!picked.length || !pid || !selectedIso) {
        showMsg("Escolha serviços, profissional e horário.");
        return;
      }
      if (!me) {
        pendingBooking = true;
        setPublicAuthTab("register");
        showAccountForBooking();
        showMsg("Entre ou crie sua conta para confirmar o agendamento.", "ok");
        return;
      }
      await confirmBooking();
    };

    async function renderHistory() {
      if (!me) return;
      var list = document.getElementById("historyList");
      list.innerHTML = "";
      var mine = await B().listMyAppointments(salonId, me.id);
      if (!mine.length) {
        list.innerHTML = '<p class="muted">Nenhum agendamento ainda.</p>';
        return;
      }
      mine.forEach(function (a) {
        var row = document.createElement("div");
        row.className = "appt-row";
        row.innerHTML =
          "<div><strong>" +
          (a.serviceName || "") +
          "</strong>" +
          (a.professionalName ? " · " + a.professionalName : "") +
          '<div class="appt-meta">' +
          formatRange(a.startAt) +
          '</div><span class="' +
          badgeClass(a.status) +
          '">' +
          statusLabel(a.status) +
          "</span> " +
          appointmentSubscriberBadge(a) +
          "</div>";
        if (a.status === "PENDING" || a.status === "CONFIRMED") {
          var cx = document.createElement("button");
          cx.type = "button";
          cx.className = "salon-btn-ghost";
          cx.textContent = "Cancelar";
          cx.onclick = function () {
            B()
              .clientCancelAppointment(salonId, a.id, me.id)
              .then(function () {
                renderHistory();
                renderSlots();
              });
          };
          row.appendChild(cx);
        }
        list.appendChild(row);
      });
    }

    async function renderNotifs() {
      if (!me) return;
      var box = document.getElementById("notifList");
      box.innerHTML = "";
      var mine = await B().listNotifications(salonId, me.id);
      if (!mine.length) {
        box.innerHTML = '<p class="muted">Sem notificações.</p>';
        return;
      }
      mine.forEach(function (n) {
        var d = document.createElement("div");
        d.className = "notif-item" + (n.read ? "" : " unread");
        d.textContent = n.message;
        d.onclick = function () {
          B().markNotificationRead(salonId, n.id).then(function () {
            d.classList.remove("unread");
          });
        };
        box.appendChild(d);
      });
    }

    await refreshAuth();
  }

  async function initProfessionalApp() {
    var ctx;
    try {
      ctx = await B().getStaffContext();
    } catch (e) {
      await B().logout();
      alert((e && e.message) || "Acesso indisponível.");
      location.href = "/index.html";
      return;
    }
    var salon = ctx.salon;
    var pro = ctx.professional;
    var salonId = salon.id;

    if (window.SalaoInstall) window.SalaoInstall.init({ app: "admin" });

    document.getElementById("barberApp").classList.add("hidden");
    if (!B().isSalonActive(salon)) {
      document.getElementById("pendingAccess").classList.remove("hidden");
      document.getElementById("pendingSalonName").textContent = "Barbearia: " + (salon.salonName || "");
      document.getElementById("btnPendingLogout").onclick = function () {
        B()
          .logout()
          .then(function () {
            location.href = "/index.html";
          });
      };
      return;
    }
    document.getElementById("pendingAccess").classList.add("hidden");
    document.getElementById("proApp").classList.remove("hidden");
    document.title = (pro.name || "Profissional") + " — " + (salon.salonName || "Painel");

    document.getElementById("proAppName").textContent = pro.name || "Profissional";
    document.getElementById("proAppSalon").textContent = (salon.salonName || "Barbearia") + " · Profissional";
    var avatar = document.getElementById("proAppAvatar");
    var avatarPh = document.getElementById("proAppAvatarPh");
    if (pro.photoUrl) {
      avatar.src = pro.photoUrl;
      avatar.classList.remove("hidden");
      avatarPh.classList.add("hidden");
    } else {
      avatarPh.textContent = proInitials(pro.name);
    }

    document.getElementById("btnProLogout").onclick = function () {
      B()
        .logout()
        .then(function () {
          location.href = "/index.html";
        });
    };

    var services = [];
    try {
      services = await B().listServices(salonId);
    } catch (e) {
      services = [];
    }

    function priceOf(a) {
      if (a.priceCents != null) return a.priceCents;
      var s = services.find(function (x) {
        return x.id === a.serviceId;
      });
      return s ? s.priceCents || 0 : 0;
    }

    function monthNow() {
      var n = new Date();
      return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
    }

    function monthRange(val) {
      var p = String(val || "").split("-");
      var y = parseInt(p[0], 10);
      var m = parseInt(p[1], 10);
      if (!y || !m) {
        var n = new Date();
        y = n.getFullYear();
        m = n.getMonth() + 1;
      }
      return {
        start: new Date(y, m - 1, 1),
        end: new Date(y, m, 1),
        label: new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }),
      };
    }

    function doneIn(a, range) {
      if (a.status !== "DONE") return false;
      var d = new Date(a.completedAt || a.startAt);
      return d >= range.start && d < range.end;
    }

    var finMonth = document.getElementById("proFinanceMonth");
    var repMonth = document.getElementById("proReportMonth");
    finMonth.value = monthNow();
    repMonth.value = monthNow();

    var mine = [];
    var paidMine = [];
    var agendaRange = "upcoming";
    var activeTab = "agenda";

    async function loadMine() {
      try {
        mine = await B().listAppointmentsForProfessional(salonId, pro.id);
      } catch (e) {
        showMsg(friendlyAuthError(e) || e.message || "Erro ao carregar seus agendamentos.");
        mine = [];
      }
      try {
        paidMine = await B().listCashMovementsForProfessional(salonId, pro.id);
      } catch (e) {
        paidMine = [];
      }
    }

    function renderStats() {
      var today = C().startOfDay(new Date());
      var tomorrow = C().addMinutes(today, 24 * 60);
      var month = monthRange(monthNow());
      document.getElementById("proStatPending").textContent = String(
        mine.filter(function (a) {
          return a.status === "PENDING";
        }).length
      );
      document.getElementById("proStatToday").textContent = String(
        mine.filter(function (a) {
          var s = new Date(a.startAt);
          return a.status === "CONFIRMED" && s >= today && s < tomorrow;
        }).length
      );
      document.getElementById("proStatDone").textContent = String(
        mine.filter(function (a) {
          return doneIn(a, month);
        }).length
      );
    }

    function updateAppt(a, status, extra, notifyMsg) {
      return B()
        .updateAppointmentStatus(salonId, a.id, status, extra || {})
        .then(async function () {
          if (notifyMsg && a.clientId) {
            try {
              await B().addNotification(salonId, a.clientId, notifyMsg);
            } catch (e) {}
          }
          await refreshAll();
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao atualizar o agendamento.");
        });
    }

    function pickPayment(a, finishing) {
      if (finishing && (C().isSubscriptionAppointment(a) || a.subscriberStatus === "active")) {
        var subExtra = {
          paymentMethod: "subscription",
          coveredByMembership: true,
          completedAt: new Date().toISOString(),
          subscriberStatus: "active",
        };
        if (a.membershipId) subExtra.membershipId = a.membershipId;
        if (a.membershipPlanName) subExtra.membershipPlanName = a.membershipPlanName;
        updateAppt(a, "DONE", subExtra, "Serviço finalizado. Corte da assinatura.");
        showMsg("Finalizado como assinatura. O corte entra no plano do cliente.", "ok");
        return;
      }
      openPayMethodModal(
        finishing ? "Como " + (a.clientName || "o cliente") + " pagou?" : "Forma de pagamento",
        a.paymentMethod || "",
        function (method) {
          if (finishing) {
            var extra = { paymentMethod: method, completedAt: new Date().toISOString() };
            if (a.priceCents == null) {
              var cents = priceOf(a);
              if (cents) extra.priceCents = cents;
            }
            updateAppt(a, "DONE", extra, "Serviço finalizado. Obrigado!");
          } else {
            updateAppt(a, a.status, { paymentMethod: method }).then(function () {
              showMsg("Pagamento registrado: " + paymentMethodLabel(method) + ".", "ok");
            });
          }
        }
      );
    }

    function renderAgenda() {
      var list = document.getElementById("proAgendaList");
      list.innerHTML = "";
      var today = C().startOfDay(new Date());
      var tomorrow = C().addMinutes(today, 24 * 60);
      var items = mine.filter(function (a) {
        var s = new Date(a.startAt);
        if (agendaRange === "today") {
          return s >= today && s < tomorrow && a.status !== "CANCELLED";
        }
        if (agendaRange === "done") return a.status === "DONE";
        return (a.status === "PENDING" || a.status === "CONFIRMED") && s >= today;
      });
      items.sort(function (a, b) {
        return agendaRange === "done"
          ? new Date(b.completedAt || b.startAt) - new Date(a.completedAt || a.startAt)
          : new Date(a.startAt) - new Date(b.startAt);
      });
      if (agendaRange === "done") items = items.slice(0, 60);
      if (!items.length) {
        list.innerHTML = '<p class="muted">Nenhum agendamento neste filtro.</p>';
        return;
      }
      items.forEach(function (a) {
        var row = document.createElement("div");
        row.className = "appt-row";
        var left = document.createElement("div");
        left.innerHTML =
          "<strong>" +
          (a.clientName || "Cliente") +
          "</strong> — " +
          (a.serviceName || "") +
          '<div class="appt-meta">' +
          formatRange(a.startAt) +
          (a.status === "DONE" && !C().isSubscriptionAppointment(a) ? " · " + formatMoney(priceOf(a)) : "") +
          (a.status === "DONE" && C().isSubscriptionAppointment(a) ? " · Assinatura" : "") +
          (a.paymentMethod && a.paymentMethod !== "subscription" ? " · " + paymentMethodLabel(a.paymentMethod) : "") +
          '</div><span class="' +
          badgeClass(a.status) +
          '">' +
          statusLabel(a.status) +
          "</span> " +
          appointmentSubscriberBadge(a);
        var actions = document.createElement("div");
        actions.className = "appt-actions";
        function addBtn(label, cls, fn) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = cls;
          b.textContent = label;
          b.onclick = fn;
          actions.appendChild(b);
        }
        if (a.status === "PENDING") {
          addBtn("Confirmar", "salon-btn-outline", function () {
            updateAppt(a, "CONFIRMED", {}, "Seu horário foi confirmado.");
          });
        }
        if (a.status === "PENDING" || a.status === "CONFIRMED") {
          addBtn("Finalizar", "salon-btn-outline", function () {
            pickPayment(a, true);
          });
          addBtn("Cancelar", "salon-btn-ghost", function () {
            if (!confirm("Cancelar o agendamento de " + (a.clientName || "cliente") + "?")) return;
            updateAppt(a, "CANCELLED", {}, "Seu agendamento foi cancelado pela barbearia.");
          });
        }
        if (a.status === "DONE") {
          addBtn(a.paymentMethod ? "Alterar pagamento" : "Informar pagamento", "salon-btn-ghost", function () {
            pickPayment(a, false);
          });
        }
        row.appendChild(left);
        row.appendChild(actions);
        list.appendChild(row);
      });
    }

    function renderPayCards(boxId, rows) {
      var box = document.getElementById(boxId);
      if (!box) return;
      box.innerHTML = "";
      var map = {};
      PAYMENT_METHODS.forEach(function (p) {
        map[p.id] = { id: p.id, label: p.label, count: 0, cents: 0 };
      });
      var unset = { id: "", label: "Não informado", count: 0, cents: 0 };
      var subscription = { id: "subscription", label: "Assinatura", count: 0, cents: 0, subscription: true };
      rows.forEach(function (a) {
        if (C().isSubscriptionAppointment(a)) {
          subscription.count++;
          return;
        }
        var t = map[a.paymentMethod] || unset;
        t.count++;
        t.cents += priceOf(a);
      });
      var list = PAYMENT_METHODS.map(function (p) {
        return map[p.id];
      });
      if (unset.count) list.push(unset);
      if (subscription.count) list.push(subscription);
      list.forEach(function (s) {
        var card = document.createElement(s.id && s.id !== "subscription" ? "button" : "div");
        if (card.tagName === "BUTTON") card.type = "button";
        card.className = "finance-pay-card";
        if (proPaySelection && s.id && proPaySelection[s.id]) card.classList.add("is-active");
        card.innerHTML =
          "<span>" +
          s.label +
          "</span><strong>" +
          (s.subscription ? "Incluso" : formatMoney(s.cents)) +
          "</strong><small>" +
          s.count +
          (s.count === 1 ? " atendimento" : " atendimentos") +
          "</small>";
        if (s.id && s.id !== "subscription") {
          card.onclick = function () {
            toggleProPay(s.id);
          };
        }
        box.appendChild(card);
      });
    }

    function renderFinance() {
      var range = proViewRange();
      var periodRows = mine
        .filter(function (a) {
          return doneIn(a, range);
        })
        .sort(function (a, b) {
          return new Date(b.completedAt || b.startAt) - new Date(a.completedAt || a.startAt);
        });
      var rows = periodRows.filter(function (a) {
        return proMatchesPay(a);
      });
      var receivedRows = rows.filter(function (a) {
        return !C().isSubscriptionAppointment(a);
      });
      var subRows = rows.filter(function (a) {
        return C().isSubscriptionAppointment(a);
      });
      var total = receivedRows.reduce(function (sum, a) {
        return sum + priceOf(a);
      }, 0);
      var shopPct = pro.isOwner ? 100 : typeof pro.shopPercent === "number" ? pro.shopPercent : 40;
      var shopPart = Math.round((total * shopPct) / 100);
      var myPart = total - shopPart;
      var paidRows = paidMine.filter(function (m) {
        var d = new Date(m.createdAt);
        return m.direction === "out" && d >= range.start && d < range.end;
      });
      var paidTotal = paidRows.reduce(function (sum, m) {
        return sum + (m.amountCents || 0);
      }, 0);
      var balance = myPart - paidTotal;
      var balanceLabel = balance > 0 ? "Saldo a receber" : balance < 0 ? "Recebido a mais" : "Tudo recebido";
      var paidBox = document.getElementById("proFinancePaid");
      paidBox.innerHTML = "";
      if (!paidRows.length) {
        paidBox.innerHTML = '<p class="muted">Nenhum pagamento recebido em ' + range.label + ".</p>";
      } else {
        paidRows.forEach(function (m) {
          var r = document.createElement("div");
          r.className = "finance-row";
          r.innerHTML =
            '<div class="finance-row-main"><strong>' +
            cashCategoryLabel(m.category) +
            '</strong><span class="finance-row-meta">' +
            new Date(m.createdAt).toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            }) +
            " · " +
            (paymentMethodLabel(m.method) || "Dinheiro") +
            (m.description ? " · " + m.description : "") +
            '</span></div><div class="finance-row-value">' +
            formatMoney(m.amountCents || 0) +
            "</div>";
          paidBox.appendChild(r);
        });
      }
      document.getElementById("proFinanceKpis").innerHTML =
        '<div class="finance-stat-card"><span class="finance-stat-label">Meu faturamento</span><strong class="finance-stat-value">' +
        formatMoney(total) +
        '</strong><span class="finance-stat-hint">' +
        receivedRows.length +
        (receivedRows.length === 1 ? " atendimento pago" : " atendimentos pagos") +
        (subRows.length ? " · " + subRows.length + " de assinatura" : "") +
        "</span></div>" +
        '<div class="finance-stat-card"><span class="finance-stat-label">Parte da barbearia (' +
        String(shopPct).replace(".", ",") +
        '%)</span><strong class="finance-stat-value">' +
        formatMoney(shopPart) +
        '</strong></div><div class="finance-stat-card finance-stat-highlight"><span class="finance-stat-label">Minha parte (' +
        String(100 - shopPct).replace(".", ",") +
        '%)</span><strong class="finance-stat-value">' +
        formatMoney(myPart) +
        '</strong></div><div class="finance-stat-card"><span class="finance-stat-label">' +
        balanceLabel +
        '</span><strong class="finance-stat-value">' +
        formatMoney(Math.abs(balance)) +
        '</strong><span class="finance-stat-hint">Já recebi ' +
        formatMoney(paidTotal) +
        " do caixa</span></div>";
      var proTotalEl = document.getElementById("proFinancePayTotal");
      if (proTotalEl) {
        var proNames = paySelectionLabel(proPaySelection);
        proTotalEl.textContent = proNames
          ? "Total " + proNames + " · " + range.label + ": " + formatMoney(total)
          : "Total de todas as formas · " + range.label + ": " + formatMoney(total);
      }
      renderPayCards("proFinancePay", periodRows);
      var list = document.getElementById("proFinanceList");
      list.innerHTML = "";
      if (!rows.length) {
        var emptyNames = paySelectionLabel(proPaySelection);
        list.innerHTML =
          '<p class="muted">Nenhum atendimento concluído' +
          (emptyNames ? " em " + emptyNames : "") +
          " em " +
          range.label +
          ".</p>";
        return;
      }
      rows.forEach(function (a) {
        var row = document.createElement("div");
        row.className = "finance-row";
        row.innerHTML =
          '<div class="finance-row-main"><strong>' +
          (a.serviceName || "Serviço") +
          '</strong><span class="finance-row-meta">' +
          formatRange(a.completedAt || a.startAt) +
          (a.clientName ? " · " + a.clientName : "") +
          " · " +
          (C().isSubscriptionAppointment(a) ? "Assinatura" : paymentMethodLabel(a.paymentMethod) || "Pagamento não informado") +
          '</span></div><div class="finance-row-value">' +
          (C().isSubscriptionAppointment(a) ? "Incluso" : formatMoney(priceOf(a))) +
          "</div>";
        list.appendChild(row);
      });
    }

    function renderReport() {
      var range = monthRange(repMonth.value);
      var rows = mine.filter(function (a) {
        return doneIn(a, range);
      });
      var map = {};
      rows.forEach(function (a) {
        var key = a.serviceName || "Serviço";
        if (!map[key]) map[key] = { name: key, count: 0, cents: 0 };
        map[key].count++;
        map[key].cents += priceOf(a);
      });
      var stats = Object.keys(map)
        .map(function (k) {
          return map[k];
        })
        .sort(function (a, b) {
          return b.count - a.count || b.cents - a.cents;
        });
      var box = document.getElementById("proReportRank");
      box.innerHTML = "";
      if (!stats.length) {
        box.innerHTML = '<p class="muted">Nenhum serviço concluído em ' + range.label + ".</p>";
        return;
      }
      var total = stats.reduce(function (s, x) {
        return s + x.cents;
      }, 0);
      stats.forEach(function (s, idx) {
        var share = total ? Math.round((s.cents / total) * 100) : 0;
        var row = document.createElement("div");
        row.className = "finance-service-row";
        row.innerHTML =
          '<div class="finance-service-badge">' +
          (idx + 1) +
          'º</div><div class="finance-service-body"><strong>' +
          s.name +
          '</strong><span class="finance-row-meta">' +
          s.count +
          (s.count === 1 ? " atendimento" : " atendimentos") +
          " · " +
          formatMoney(s.cents) +
          (share ? " · " + share + "% da sua receita" : "") +
          "</span></div>";
        box.appendChild(row);
      });
    }

    async function refreshAll() {
      await loadMine();
      watchNewAppointments(mine);
      renderStats();
      renderAgenda();
      if (activeTab === "finance") renderFinance();
      if (activeTab === "report") renderReport();
    }

    document.querySelectorAll("#proAppTabs [data-pro-tab]").forEach(function (btn) {
      btn.onclick = function () {
        activeTab = btn.getAttribute("data-pro-tab");
        document.querySelectorAll("#proAppTabs [data-pro-tab]").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        setHidden("proPanelAgenda", activeTab !== "agenda");
        setHidden("proPanelFinance", activeTab !== "finance");
        setHidden("proPanelReport", activeTab !== "report");
        if (activeTab === "agenda") renderAgenda();
        if (activeTab === "finance") renderFinance();
        if (activeTab === "report") renderReport();
      };
    });
    document.querySelectorAll("#proAgendaFilter [data-pro-range]").forEach(function (btn) {
      btn.onclick = function () {
        agendaRange = btn.getAttribute("data-pro-range");
        document.querySelectorAll("#proAgendaFilter [data-pro-range]").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        renderAgenda();
      };
    });
    var proFinanceDayEl = document.getElementById("proFinanceDay");
    var proPaySelection = null;

    function paySelectionLabel(selection) {
      if (!selection) return "";
      return PAYMENT_METHODS.filter(function (p) {
        return selection[p.id];
      })
        .map(function (p) {
          return p.label;
        })
        .join(" + ");
    }

    function proViewRange() {
      var range = monthRange(finMonth.value);
      if (proFinanceDayEl && proFinanceDayEl.value) {
        var bits = String(proFinanceDayEl.value).split("-");
        var y = parseInt(bits[0], 10);
        var m = parseInt(bits[1], 10);
        var d = parseInt(bits[2], 10);
        if (y && m && d) {
          var day = new Date(y, m - 1, d);
          return {
            start: day,
            end: new Date(y, m - 1, d + 1),
            label: day.toLocaleDateString("pt-BR"),
          };
        }
      }
      return range;
    }

    function proMatchesPay(a) {
      if (!proPaySelection) return true;
      if (C().isSubscriptionAppointment(a)) return false;
      return !!proPaySelection[a.paymentMethod || ""];
    }

    function syncProPayButtons() {
      document.querySelectorAll("#proFinancePayFilter [data-pro-pay-filter]").forEach(function (b) {
        var id = b.getAttribute("data-pro-pay-filter");
        var on = id === "all" ? !proPaySelection : !!(proPaySelection && proPaySelection[id]);
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function toggleProPay(id) {
      if (!id || id === "all") proPaySelection = null;
      else {
        if (!proPaySelection) proPaySelection = {};
        if (proPaySelection[id]) delete proPaySelection[id];
        else proPaySelection[id] = true;
        if (!Object.keys(proPaySelection).length) proPaySelection = null;
      }
      syncProPayButtons();
      renderFinance();
    }

    document.querySelectorAll("#proFinancePayFilter [data-pro-pay-filter]").forEach(function (btn) {
      btn.onclick = function () {
        toggleProPay(btn.getAttribute("data-pro-pay-filter"));
      };
    });
    if (proFinanceDayEl) proFinanceDayEl.onchange = renderFinance;
    var btnProFinanceClearDay = document.getElementById("btnProFinanceClearDay");
    if (btnProFinanceClearDay) {
      btnProFinanceClearDay.onclick = function () {
        if (proFinanceDayEl) proFinanceDayEl.value = "";
        renderFinance();
      };
    }
    finMonth.onchange = renderFinance;
    repMonth.onchange = renderReport;

    await refreshAll();
    promptAppointmentSound();
    setInterval(refreshAll, 15000);
  }

  async function initBarbeiro() {
    await B().waitForAuth();
    var sess = await B().getSession();
    if (sessionRole(sess) === "PROFESSIONAL") {
      await initProfessionalApp();
      return;
    }
    if (sessionRole(sess) !== "BARBER") {
      location.href = "/index.html";
      return;
    }
    var me = await B().getProfile();
    if (!me) {
      await B().logout();
      location.href = "/index.html";
      return;
    }

    var salon = await B().getOwnerSalon(me.id);
    if (!salon && B().isFirebase()) {
      showMsg("Complete o cadastro da barbearia.");
      location.href = "/index.html";
      return;
    }
    if (!salon) salon = await B().getSalonBySlug("demo");

    if (window.SalaoInstall) window.SalaoInstall.init({ app: "admin" });

    if (!B().isSalonActive(salon)) {
      document.getElementById("pendingAccess").classList.remove("hidden");
      document.getElementById("barberApp").classList.add("hidden");
      document.getElementById("pendingSalonName").textContent = salon.salonName
        ? "Barbearia: " + salon.salonName
        : "";
      document.getElementById("btnPendingLogout").onclick = function () {
        B()
          .logout()
          .then(function () {
            location.href = "/index.html";
          });
      };
      return;
    }

    document.getElementById("pendingAccess").classList.add("hidden");
    document.getElementById("barberApp").classList.remove("hidden");

    var salonId = salon.id;
    renderBarberDashboard(salon);

    function refreshPublicLink() {
      var url = B().publicSalonUrl(salon.slug);
      var input = document.getElementById("publicLink");
      var preview = document.getElementById("previewLink");
      if (input) input.value = url;
      if (preview) preview.href = url;
      return url;
    }

    refreshPublicLink();
    document.getElementById("btnCopyLink").onclick = function () {
      var url = refreshPublicLink();
      navigator.clipboard.writeText(url).then(function () {
        showMsg("Link copiado!", "ok");
        setTimeout(function () {
          showMsg("");
        }, 2000);
      });
    };

    document.getElementById("btnLogout").onclick = function () {
      B()
        .logout()
        .then(function () {
          location.href = "/index.html";
        });
    };

    document.querySelectorAll("#adminTabs [data-tab]").forEach(function (btn) {
      btn.onclick = function () {
        switchBarberTab(btn.getAttribute("data-tab"));
      };
    });

    function switchBarberTab(tab) {
      if (!tab) return;
      document.querySelectorAll("#adminTabs [data-tab]").forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-tab") === tab);
      });
      document.querySelectorAll(".tab-panel").forEach(function (p) {
        p.classList.add("hidden");
      });
      var panel = document.getElementById("tab" + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (panel) panel.classList.remove("hidden");
      if (tab === "services") renderServices();
      if (tab === "pros") renderPros();
      if (tab === "blocks") renderBlocks();
      if (tab === "finance") {
        financeSubTab = financeSubTab || "billing";
        renderFinance();
      }
      if (tab === "memberships") renderMembershipsTab();
      if (tab === "cash") renderCash();
      if (tab === "prodesk") renderProDesk();
      if (tab === "settings") fillSettings();
      syncProDeskTabButtons(tab);
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    var btnGoEditServices = document.getElementById("btnGoEditServices");
    if (btnGoEditServices) {
      btnGoEditServices.onclick = function () {
        switchBarberTab("services");
      };
    }
    var btnGoEditSettings = document.getElementById("btnGoEditSettings");
    if (btnGoEditSettings) {
      btnGoEditSettings.onclick = function () {
        switchBarberTab("settings");
      };
    }

    var barberServices = [];
    var financeSubTab = "billing";
    var selectedProDeskId = "";
    var proDeskSubTab = "cuts";
    var proDeskProsCache = [];
    var financeMonthEl = document.getElementById("financeMonth");
    var financeDayEl = document.getElementById("financeDay");
    var financePaySelection = null;
    var financeRenderToken = 0;
    if (financeMonthEl) {
      var now = new Date();
      financeMonthEl.value =
        now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      financeMonthEl.onchange = function () {
        renderFinance();
      };
    }
    if (financeDayEl) {
      financeDayEl.onchange = function () {
        renderFinance();
      };
    }
    var btnFinanceClearDay = document.getElementById("btnFinanceClearDay");
    if (btnFinanceClearDay) {
      btnFinanceClearDay.onclick = function () {
        if (financeDayEl) financeDayEl.value = "";
        renderFinance();
      };
    }

    function financePayLabel(selection) {
      if (!selection) return "";
      return PAYMENT_METHODS.filter(function (p) {
        return selection[p.id];
      })
        .map(function (p) {
          return p.label;
        })
        .join(" + ");
    }

    function syncFinancePayButtons() {
      document.querySelectorAll("#financePayFilter [data-pay-filter]").forEach(function (b) {
        var id = b.getAttribute("data-pay-filter");
        var on = id === "all" ? !financePaySelection : !!(financePaySelection && financePaySelection[id]);
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function toggleFinancePay(id) {
      if (!id || id === "all") financePaySelection = null;
      else {
        if (!financePaySelection) financePaySelection = {};
        if (financePaySelection[id]) delete financePaySelection[id];
        else financePaySelection[id] = true;
        if (!Object.keys(financePaySelection).length) financePaySelection = null;
      }
      syncFinancePayButtons();
      renderFinance();
    }

    document.querySelectorAll("#financePayFilter [data-pay-filter]").forEach(function (btn) {
      btn.onclick = function () {
        toggleFinancePay(btn.getAttribute("data-pay-filter"));
      };
    });
    var financeProFilterEl = document.getElementById("financeProFilter");
    if (financeProFilterEl) {
      financeProFilterEl.onchange = function () {
        renderFinance();
      };
    }
    var proDeskMonthEl = document.getElementById("proDeskMonth");
    if (proDeskMonthEl) {
      var proDeskNow = new Date();
      proDeskMonthEl.value =
        proDeskNow.getFullYear() + "-" + String(proDeskNow.getMonth() + 1).padStart(2, "0");
      proDeskMonthEl.onchange = function () {
        if (selectedProDeskId) renderProDesk();
      };
    }

    document.querySelectorAll("#financeSubTabs [data-finance-tab]").forEach(function (btn) {
      btn.onclick = function () {
        financeSubTab = btn.getAttribute("data-finance-tab") || "billing";
        document.querySelectorAll("#financeSubTabs [data-finance-tab]").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        setHidden("financeTabBilling", financeSubTab !== "billing");
        setHidden("financeTabIn", financeSubTab !== "in");
        setHidden("financeTabOut", financeSubTab !== "out");
        setHidden("financeTabPros", financeSubTab !== "pros");
        renderFinance();
      };
    });

    document.querySelectorAll("#proDeskSubTabs [data-prodesk-tab]").forEach(function (btn) {
      btn.onclick = function () {
        proDeskSubTab = btn.getAttribute("data-prodesk-tab") || "cuts";
        document.querySelectorAll("#proDeskSubTabs [data-prodesk-tab]").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        setHidden("proDeskTabCuts", proDeskSubTab !== "cuts");
        setHidden("proDeskTabFinance", proDeskSubTab !== "finance");
      };
    });

    document.getElementById("btnClearFinance").onclick = async function () {
      if (!financeMonthEl) return;
      var parts = parseFinanceMonthValue(financeMonthEl.value);
      if (!parts) {
        showMsg("Selecione um mês válido.");
        return;
      }
      var label = financeMonthLabel(parts.year, parts.month);
      if (
        !confirm(
          "Arquivar o relatório de " +
            label +
            "?\n\nOs atendimentos permanecem na agenda, mas deixam de aparecer neste painel financeiro."
        )
      ) {
        return;
      }
      try {
        var n = await B().archiveFinanceMonth(salonId, me.id, parts.year, parts.month);
        showMsg(
          n
            ? "Relatório de " + label + " arquivado (" + n + " registro(s))."
            : "Nenhum registro para arquivar neste período.",
          "ok"
        );
        renderFinance();
      } catch (e) {
        showMsg(e.message || "Erro ao limpar relatório.");
      }
    };

    var subscriptionCutAttempted = {};
    var membershipSubTab = "members";
    var membershipPlansCache = [];
    var membershipsCache = [];

    function addDaysIso(isoDate, days) {
      var d = new Date(isoDate + "T12:00:00");
      d.setDate(d.getDate() + (days || 0));
      return d.toISOString().slice(0, 10);
    }

    function todayIso() {
      return C().localDateKey(new Date());
    }

    function membershipStatusOf(m) {
      return C().subscriberState(m) || "active";
    }

    function membershipStatusBadge(status) {
      if (status === "expired") return '<span class="badge badge-cancelled">Vencido</span>';
      if (status === "no_cuts") return '<span class="badge badge-warn">Sem cortes</span>';
      return '<span class="badge badge-confirmed">Ativo</span>';
    }

    function planTypeLabel(type) {
      if (type === "annual") return "Anual";
      if (type === "monthly") return "Mensal";
      return "Personalizado";
    }

    function syncPlanDurationDefaults() {
      var type = document.getElementById("planType").value;
      var days = document.getElementById("planDays");
      if (!days || days.dataset.touched === "1") return;
      if (type === "annual") days.value = "365";
      else if (type === "monthly") days.value = "30";
    }

    function fillMemberPlanSelect(selectedId) {
      var sel = document.getElementById("memberPlan");
      if (!sel) return;
      sel.innerHTML = "";
      var active = membershipPlansCache.filter(function (p) {
        return p.active !== false;
      });
      if (!active.length) {
        var o = document.createElement("option");
        o.value = "";
        o.textContent = "Cadastre um plano primeiro";
        sel.appendChild(o);
        return;
      }
      active.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent =
          p.name +
          " · " +
          (p.cutsIncluded || 0) +
          " cortes · " +
          formatMoney(p.priceCents || 0);
        sel.appendChild(o);
      });
      if (selectedId) sel.value = selectedId;
      applySelectedPlanToMemberForm();
    }

    function applySelectedPlanToMemberForm() {
      var planId = document.getElementById("memberPlan").value;
      var plan = membershipPlansCache.find(function (p) {
        return p.id === planId;
      });
      if (!plan) return;
      var starts = document.getElementById("memberStarts");
      var expires = document.getElementById("memberExpires");
      var cuts = document.getElementById("memberCutsIncluded");
      if (!starts.value) starts.value = todayIso();
      if (cuts && document.getElementById("memberEditId").value === "") {
        cuts.value = plan.cutsIncluded || 1;
      }
      if (expires && document.getElementById("memberEditId").value === "") {
        expires.value = addDaysIso(starts.value || todayIso(), plan.durationDays || 30);
      }
    }

    function resetPlanForm() {
      document.getElementById("formMembershipPlan").reset();
      document.getElementById("planEditId").value = "";
      document.getElementById("planCuts").value = "4";
      document.getElementById("planDays").value = "30";
      document.getElementById("planDays").dataset.touched = "";
      document.getElementById("btnPlanSubmit").textContent = "Salvar plano";
      document.getElementById("btnPlanCancel").classList.add("hidden");
      var title = document.getElementById("planFormTitle");
      if (title) title.textContent = "Novo plano";
    }

    function resetMemberForm() {
      document.getElementById("formMembership").reset();
      document.getElementById("memberEditId").value = "";
      document.getElementById("memberStarts").value = todayIso();
      document.getElementById("memberCutsUsed").value = "0";
      document.getElementById("btnMemberSubmit").textContent = "Salvar assinante";
      document.getElementById("btnMemberCancel").classList.add("hidden");
      var title = document.getElementById("memberFormTitle");
      if (title) title.textContent = "Novo assinante";
      fillMemberPlanSelect();
    }

    function renderMembershipStats() {
      var box = document.getElementById("membershipStats");
      if (!box) return;
      var active = 0;
      var expired = 0;
      var noCuts = 0;
      membershipsCache.forEach(function (m) {
        var st = membershipStatusOf(m);
        if (st === "active") active++;
        else if (st === "expired") expired++;
        else noCuts++;
      });
      box.innerHTML =
        '<div class="membership-stat-pill"><strong>' +
        membershipsCache.length +
        "</strong><span>Assinantes</span></div>" +
        '<div class="membership-stat-pill membership-stat-ok"><strong>' +
        active +
        "</strong><span>Ativos</span></div>" +
        '<div class="membership-stat-pill membership-stat-warn"><strong>' +
        noCuts +
        "</strong><span>Sem cortes</span></div>" +
        '<div class="membership-stat-pill membership-stat-bad"><strong>' +
        expired +
        "</strong><span>Vencidos</span></div>";
    }

    function renderMembershipPlansList() {
      var box = document.getElementById("membershipPlansList");
      if (!box) return;
      box.innerHTML = "";
      if (!membershipPlansCache.length) {
        box.innerHTML = '<p class="muted">Nenhum plano cadastrado ainda.</p>';
        return;
      }
      membershipPlansCache.forEach(function (p) {
        var row = document.createElement("div");
        row.className = "appt-row membership-card";
        row.innerHTML =
          "<div><strong>" +
          (p.name || "Plano") +
          "</strong>" +
          (p.active === false ? ' <span class="badge badge-cancelled">Inativo</span>' : "") +
          '<div class="appt-meta">' +
          planTypeLabel(p.type) +
          " · " +
          (p.cutsIncluded || 0) +
          " cortes · " +
          (p.durationDays || 0) +
          " dias · " +
          formatMoney(p.priceCents || 0) +
          "</div></div>";
        var actions = document.createElement("div");
        actions.className = "appt-actions";
        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "salon-btn-outline";
        edit.textContent = "Editar";
        edit.onclick = function () {
          document.getElementById("planEditId").value = p.id;
          document.getElementById("planName").value = p.name || "";
          document.getElementById("planType").value = p.type || "custom";
          document.getElementById("planPrice").value = ((p.priceCents || 0) / 100).toFixed(2);
          document.getElementById("planCuts").value = p.cutsIncluded || 1;
          document.getElementById("planDays").value = p.durationDays || 30;
          document.getElementById("planDays").dataset.touched = "1";
          document.getElementById("btnPlanSubmit").textContent = "Atualizar plano";
          document.getElementById("btnPlanCancel").classList.remove("hidden");
          var title = document.getElementById("planFormTitle");
          if (title) title.textContent = "Editar plano";
          document.getElementById("formMembershipPlan").scrollIntoView({ behavior: "smooth", block: "start" });
        };
        actions.appendChild(edit);
        var del = document.createElement("button");
        del.type = "button";
        del.className = "salon-btn-ghost btn-danger-ghost";
        del.textContent = "Excluir";
        del.onclick = function () {
          if (!confirm('Excluir o plano "' + (p.name || "") + '"?')) return;
          B()
            .deleteMembershipPlan(salonId, me.id, p.id)
            .then(function () {
              showMsg("Plano excluído.", "ok");
              return renderMembershipsTab();
            })
            .catch(function (e) {
              showMsg(e.message || "Erro ao excluir plano.");
            });
        };
        actions.appendChild(del);
        row.appendChild(actions);
        box.appendChild(row);
      });
    }

    function renderMembershipsList() {
      var box = document.getElementById("membershipsList");
      if (!box) return;
      box.innerHTML = "";
      if (!membershipsCache.length) {
        box.innerHTML = '<p class="muted">Nenhum assinante cadastrado ainda.</p>';
        return;
      }
      membershipsCache.forEach(function (m) {
        var status = membershipStatusOf(m);
        var row = document.createElement("div");
        row.className = "appt-row membership-card";
        var used = typeof m.cutsUsed === "number" ? m.cutsUsed : 0;
        var included = typeof m.cutsIncluded === "number" ? m.cutsIncluded : 0;
        var lastCut =
          m.cutLog && m.cutLog[0]
            ? new Date(m.cutLog[0].at).toLocaleString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "—";
        row.innerHTML =
          "<div><strong>" +
          (m.clientName || "Cliente") +
          "</strong> " +
          membershipStatusBadge(status) +
          '<div class="appt-meta">' +
          (m.planName || "Plano") +
          (m.clientPhone ? " · " + m.clientPhone : "") +
          "</div>" +
          '<div class="appt-meta">Vence: ' +
          (m.expiresAt
            ? new Date(m.expiresAt + "T12:00:00").toLocaleDateString("pt-BR")
            : "—") +
          " · Cortes: " +
          used +
          "/" +
          included +
          " · Último corte: " +
          lastCut +
          "</div></div>";
        var actions = document.createElement("div");
        actions.className = "appt-actions";

        var cutBtn = document.createElement("button");
        cutBtn.type = "button";
        cutBtn.className = "salon-btn-primary";
        cutBtn.textContent = "Registrar corte";
        cutBtn.disabled = status !== "active";
        cutBtn.onclick = function () {
          var note = prompt("Observação do corte (opcional):", "") || "";
          B()
            .registerMembershipCut(salonId, me.id, m.id, note)
            .then(function () {
              showMsg("Corte registrado.", "ok");
              return renderMembershipsTab();
            })
            .catch(function (e) {
              showMsg(e.message || "Erro ao registrar corte.");
            });
        };
        actions.appendChild(cutBtn);

        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "salon-btn-outline";
        edit.textContent = "Editar";
        edit.onclick = function () {
          document.getElementById("memberEditId").value = m.id;
          document.getElementById("memberName").value = m.clientName || "";
          document.getElementById("memberPhone").value = m.clientPhone || "";
          document.getElementById("memberEmail").value = m.clientEmail || "";
          fillMemberPlanSelect(m.planId);
          document.getElementById("memberStarts").value = m.startsAt || todayIso();
          document.getElementById("memberExpires").value = m.expiresAt || "";
          document.getElementById("memberCutsIncluded").value = m.cutsIncluded || 0;
          document.getElementById("memberCutsUsed").value = m.cutsUsed || 0;
          document.getElementById("memberNotes").value = m.notes || "";
          document.getElementById("btnMemberSubmit").textContent = "Atualizar assinante";
          document.getElementById("btnMemberCancel").classList.remove("hidden");
          var title = document.getElementById("memberFormTitle");
          if (title) title.textContent = "Editar assinante";
          document.getElementById("formMembership").scrollIntoView({ behavior: "smooth", block: "start" });
        };
        actions.appendChild(edit);

        var hist = document.createElement("button");
        hist.type = "button";
        hist.className = "salon-btn-ghost";
        hist.textContent = "Histórico";
        hist.onclick = function () {
          var log = Array.isArray(m.cutLog) ? m.cutLog : [];
          if (!log.length) {
            alert("Nenhum corte registrado ainda.");
            return;
          }
          alert(
            log
              .slice(0, 15)
              .map(function (c, i) {
                return (
                  i +
                  1 +
                  ". " +
                  new Date(c.at).toLocaleString("pt-BR") +
                  (c.note ? " — " + c.note : "")
                );
              })
              .join("\n")
          );
        };
        actions.appendChild(hist);

        var del = document.createElement("button");
        del.type = "button";
        del.className = "salon-btn-ghost btn-danger-ghost";
        del.textContent = "Excluir";
        del.onclick = function () {
          if (!confirm('Excluir assinatura de "' + (m.clientName || "") + '"?')) return;
          B()
            .deleteMembership(salonId, me.id, m.id)
            .then(function () {
              showMsg("Assinante excluído.", "ok");
              return renderMembershipsTab();
            })
            .catch(function (e) {
              showMsg(e.message || "Erro ao excluir.");
            });
        };
        actions.appendChild(del);
        row.appendChild(actions);
        box.appendChild(row);
      });
    }

    async function renderMembershipsTab() {
      try {
        membershipPlansCache = await B().listMembershipPlans(salonId);
        membershipsCache = await B().listMemberships(salonId);
      } catch (e) {
        showMsg(friendlyAuthError(e) || e.message || "Erro ao carregar assinaturas.");
        membershipPlansCache = [];
        membershipsCache = [];
      }
      renderMembershipStats();
      renderMembershipPlansList();
      renderMembershipsList();
      fillMemberPlanSelect(document.getElementById("memberPlan").value);
      setHidden("membershipTabMembers", membershipSubTab !== "members");
      setHidden("membershipTabPlans", membershipSubTab !== "plans");
    }

    document.querySelectorAll("#membershipSubTabs [data-membership-tab]").forEach(function (btn) {
      btn.onclick = function () {
        membershipSubTab = btn.getAttribute("data-membership-tab") || "members";
        document.querySelectorAll("#membershipSubTabs [data-membership-tab]").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        setHidden("membershipTabMembers", membershipSubTab !== "members");
        setHidden("membershipTabPlans", membershipSubTab !== "plans");
      };
    });

    var planTypeEl = document.getElementById("planType");
    if (planTypeEl) {
      planTypeEl.onchange = syncPlanDurationDefaults;
    }
    var planDaysEl = document.getElementById("planDays");
    if (planDaysEl) {
      planDaysEl.oninput = function () {
        planDaysEl.dataset.touched = "1";
      };
    }

    document.getElementById("btnPlanCancel").onclick = resetPlanForm;
    document.getElementById("btnMemberCancel").onclick = resetMemberForm;

    var memberPlanEl = document.getElementById("memberPlan");
    if (memberPlanEl) {
      memberPlanEl.onchange = applySelectedPlanToMemberForm;
    }
    var memberStartsEl = document.getElementById("memberStarts");
    if (memberStartsEl) {
      memberStartsEl.onchange = function () {
        if (document.getElementById("memberEditId").value) return;
        applySelectedPlanToMemberForm();
      };
    }

    document.getElementById("formMembershipPlan").onsubmit = function (ev) {
      ev.preventDefault();
      var editId = document.getElementById("planEditId").value.trim();
      var name = document.getElementById("planName").value.trim();
      var type = document.getElementById("planType").value;
      var priceVal = parseFloat(String(document.getElementById("planPrice").value).replace(",", "."));
      var cuts = parseInt(document.getElementById("planCuts").value, 10);
      var days = parseInt(document.getElementById("planDays").value, 10);
      if (!name) {
        showMsg("Informe o nome do plano.");
        return;
      }
      if (isNaN(priceVal) || priceVal < 0) {
        showMsg("Informe um preço válido.");
        return;
      }
      if (!cuts || cuts < 1) {
        showMsg("Informe a quantidade de cortes.");
        return;
      }
      if (!days || days < 1) {
        showMsg("Informe a duração em dias.");
        return;
      }
      var payload = {
        name: name,
        type: type,
        priceCents: Math.round(priceVal * 100),
        cutsIncluded: cuts,
        durationDays: days,
        active: true,
      };
      if (editId) payload.id = editId;
      B()
        .saveMembershipPlan(salonId, me.id, payload)
        .then(function () {
          resetPlanForm();
          showMsg(editId ? "Plano atualizado." : "Plano cadastrado.", "ok");
          return renderMembershipsTab();
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao salvar plano.");
        });
    };

    document.getElementById("formMembership").onsubmit = function (ev) {
      ev.preventDefault();
      var editId = document.getElementById("memberEditId").value.trim();
      var planId = document.getElementById("memberPlan").value;
      var plan = membershipPlansCache.find(function (p) {
        return p.id === planId;
      });
      if (!planId || !plan) {
        showMsg("Cadastre e selecione um plano.");
        return;
      }
      var name = document.getElementById("memberName").value.trim();
      var phone = document.getElementById("memberPhone").value.trim();
      if (!name) {
        showMsg("Informe o nome do cliente.");
        return;
      }
      if (!C().phoneKey(phone)) {
        showMsg("Informe o telefone com DDD. Ele identifica o cliente no link de agendamento.");
        return;
      }
      var starts = document.getElementById("memberStarts").value;
      var expires = document.getElementById("memberExpires").value;
      var cutsIncluded = parseInt(document.getElementById("memberCutsIncluded").value, 10);
      var cutsUsed = parseInt(document.getElementById("memberCutsUsed").value, 10) || 0;
      if (!starts || !expires) {
        showMsg("Informe início e vencimento.");
        return;
      }
      if (!cutsIncluded || cutsIncluded < 1) {
        showMsg("Informe os cortes inclusos.");
        return;
      }
      var payload = {
        clientName: name,
        clientPhone: phone,
        clientEmail: document.getElementById("memberEmail").value.trim(),
        planId: plan.id,
        planName: plan.name,
        startsAt: starts,
        expiresAt: expires,
        cutsIncluded: cutsIncluded,
        cutsUsed: cutsUsed,
        notes: document.getElementById("memberNotes").value.trim(),
        status: "active",
      };
      if (editId) {
        payload.id = editId;
        var existing = membershipsCache.find(function (x) {
          return x.id === editId;
        });
        if (existing && existing.cutLog) payload.cutLog = existing.cutLog;
      }
      var st = membershipStatusOf(payload);
      payload.status = st;
      B()
        .saveMembership(salonId, me.id, payload)
        .then(function () {
          resetMemberForm();
          showMsg(editId ? "Assinante atualizado." : "Assinante cadastrado.", "ok");
          return renderMembershipsTab();
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao salvar assinante.");
        });
    };

    if (document.getElementById("memberStarts") && !document.getElementById("memberStarts").value) {
      document.getElementById("memberStarts").value = todayIso();
    }

    function parseFinanceMonthValue(val) {
      var p = (val || "").split("-");
      if (p.length !== 2) return null;
      var year = parseInt(p[0], 10);
      var month = parseInt(p[1], 10);
      if (!year || month < 1 || month > 12) return null;
      return { year: year, month: month };
    }

    function financeMonthLabel(year, month) {
      return new Date(year, month - 1, 1).toLocaleDateString("pt-BR", {
        month: "long",
        year: "numeric",
      });
    }

    function financeMonthRange(year, month) {
      return {
        start: new Date(year, month - 1, 1),
        end: new Date(year, month, 1),
      };
    }

    function financeViewRange(parts) {
      if (financeDayEl && financeDayEl.value) {
        var bits = String(financeDayEl.value).split("-");
        var y = parseInt(bits[0], 10);
        var m = parseInt(bits[1], 10);
        var d = parseInt(bits[2], 10);
        if (y && m && d) {
          var day = new Date(y, m - 1, d);
          return {
            start: day,
            end: new Date(y, m - 1, d + 1),
            dayLabel: day.toLocaleDateString("pt-BR"),
          };
        }
      }
      var range = financeMonthRange(parts.year, parts.month);
      range.dayLabel = "";
      return range;
    }

    function appointmentMatchesPayFilter(a, selection) {
      if (!selection) return true;
      if (C().isSubscriptionAppointment(a)) return false;
      return !!selection[a.paymentMethod || ""];
    }

    function movementMatchesPayFilter(m, selection) {
      if (!selection) return true;
      return !!selection[m.method || "cash"];
    }

    function resolveApptPriceCents(appointment, services) {
      if (appointment.priceCents != null) return appointment.priceCents;
      var s = services.find(function (x) {
        return x.id === appointment.serviceId;
      });
      return s ? s.priceCents || 0 : 0;
    }

    function isInFinanceReport(appointment, start, end) {
      if (appointment.status !== "DONE" || appointment.financeArchived) return false;
      var d = new Date(appointment.completedAt || appointment.startAt);
      return d >= start && d < end;
    }

    async function loadBarberServices() {
      try {
        barberServices = await B().listServices(salonId);
      } catch (e) {
        barberServices = [];
      }
      return barberServices;
    }

    function matchesProfessional(appointment, pro) {
      if (!pro) return true;
      if (appointment.professionalId && appointment.professionalId === pro.id) return true;
      if (!appointment.professionalId && pro.name && appointment.professionalName === pro.name) {
        return true;
      }
      return false;
    }

    var DEFAULT_SHOP_PERCENT = 40;

    function proShopPercent(p) {
      if (!p) return DEFAULT_SHOP_PERCENT;
      if (p.isOwner) return 100;
      return typeof p.shopPercent === "number" ? p.shopPercent : DEFAULT_SHOP_PERCENT;
    }

    /** Produção do mês, desconto da barbearia, parte do profissional e o que já foi pago pelo caixa. */
    function computeProSettlement(p, appointments, movements, range) {
      var produced = 0;
      var count = 0;
      var subCount = 0;
      (appointments || []).forEach(function (a) {
        if (a.status !== "DONE" || !matchesProfessional(a, p)) return;
        var d = new Date(a.completedAt || a.startAt);
        if (d < range.start || d >= range.end) return;
        if (C().isSubscriptionAppointment(a)) {
          subCount++;
          return;
        }
        produced += resolveApptPriceCents(a, barberServices);
        count++;
      });
      var paid = 0;
      var payCount = 0;
      (movements || []).forEach(function (m) {
        if (m.professionalId !== p.id || m.direction !== "out") return;
        var d = new Date(m.createdAt);
        if (d < range.start || d >= range.end) return;
        paid += m.amountCents || 0;
        payCount++;
      });
      var pct = proShopPercent(p);
      var shopCents = Math.round((produced * pct) / 100);
      var proCents = produced - shopCents;
      return {
        percent: pct,
        produced: produced,
        count: count,
        shopCents: shopCents,
        proCents: proCents,
        paid: paid,
        payCount: payCount,
        balance: proCents - paid,
        subCount: subCount,
      };
    }

    function settlementHtml(s, p) {
      if (p && p.isOwner) {
        return (
          '<div class="settlement-grid">' +
          '<div><span>Produção</span><strong>' +
          formatMoney(s.produced) +
          "</strong><small>" +
          s.count +
          (s.count === 1 ? " atendimento pago" : " atendimentos pagos") +
          (s.subCount ? " · " + s.subCount + " de assinatura" : "") +
          '</small></div><div><span>Repasse</span><strong>—</strong><small>Barbeiro admin: tudo fica com a casa</small></div></div>'
        );
      }
      var balanceLabel =
        s.balance > 0 ? "Saldo a pagar" : s.balance < 0 ? "Pago a mais (adiantado)" : "Tudo pago";
      return (
        '<div class="settlement-grid">' +
        "<div><span>Produção</span><strong>" +
        formatMoney(s.produced) +
        "</strong><small>" +
        s.count +
        (s.count === 1 ? " atendimento pago" : " atendimentos pagos") +
        (s.subCount ? " · " + s.subCount + " de assinatura" : "") +
        "</small></div>" +
        "<div><span>Barbearia (" +
        String(s.percent).replace(".", ",") +
        "%)</span><strong>− " +
        formatMoney(s.shopCents) +
        "</strong><small>Desconto da casa</small></div>" +
        "<div><span>Parte do profissional (" +
        String(100 - s.percent).replace(".", ",") +
        "%)</span><strong>" +
        formatMoney(s.proCents) +
        "</strong><small>Valor a receber no período</small></div>" +
        "<div><span>Já pago pelo caixa</span><strong>− " +
        formatMoney(s.paid) +
        "</strong><small>" +
        s.payCount +
        (s.payCount === 1 ? " pagamento/vale" : " pagamentos/vales") +
        "</small></div>" +
        '<div class="settlement-balance' +
        (s.balance < 0 ? " is-negative" : s.balance === 0 ? " is-zero" : "") +
        '"><span>' +
        balanceLabel +
        "</span><strong>" +
        formatMoney(Math.abs(s.balance)) +
        "</strong></div></div>"
      );
    }

    function fillProfessionalSelect(selectEl, includeAll) {
      if (!selectEl) return;
      var current = selectEl.value;
      selectEl.innerHTML = "";
      if (includeAll) {
        var allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "Todos os profissionais";
        selectEl.appendChild(allOpt);
      }
      proDeskProsCache.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name + (p.active === false ? " (inativo)" : "");
        selectEl.appendChild(o);
      });
      if (current && Array.prototype.some.call(selectEl.options, function (opt) {
        return opt.value === current;
      })) {
        selectEl.value = current;
      }
    }

    function syncProDeskTabButtons(activeTab) {
      document.querySelectorAll("#proDeskTabs [data-pro-id]").forEach(function (b) {
        b.classList.toggle(
          "is-active",
          activeTab === "prodesk" && b.getAttribute("data-pro-id") === selectedProDeskId
        );
      });
    }

    async function refreshProDeskTabs() {
      var wrap = document.getElementById("proDeskTabs");
      if (!wrap) return;
      try {
        proDeskProsCache = await B().listAllProfessionals(salonId);
      } catch (e) {
        proDeskProsCache = [];
      }
      wrap.innerHTML = "";
      if (!proDeskProsCache.length) {
        wrap.classList.add("hidden");
        fillProfessionalSelect(financeProFilterEl, true);
        return;
      }
      wrap.classList.remove("hidden");
      var label = document.createElement("span");
      label.className = "pro-desk-label";
      label.textContent = "Painel do profissional";
      wrap.appendChild(label);
      proDeskProsCache.forEach(function (p) {
        if (p.active === false) return;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "salon-btn-outline";
        btn.setAttribute("data-pro-id", p.id);
        btn.textContent = p.name || "Profissional";
        btn.onclick = function () {
          selectedProDeskId = p.id;
          switchBarberTab("prodesk");
        };
        wrap.appendChild(btn);
      });
      fillProfessionalSelect(financeProFilterEl, true);
      syncProDeskTabButtons(
        document.querySelector("#adminTabs [data-tab].is-active")
          ? document.querySelector("#adminTabs [data-tab].is-active").getAttribute("data-tab")
          : ""
      );
    }

    function buildPayBreakdown(rows) {
      var map = {};
      PAYMENT_METHODS.forEach(function (p) {
        map[p.id] = { id: p.id, label: p.label, count: 0, cents: 0 };
      });
      var unset = { id: "", label: "Não informado", count: 0, cents: 0 };
      var subscription = { id: "subscription", label: "Assinatura", count: 0, cents: 0, subscription: true };
      rows.forEach(function (a) {
        if (C().isSubscriptionAppointment(a)) {
          subscription.count++;
          return;
        }
        var cents = resolveApptPriceCents(a, barberServices);
        if (map[a.paymentMethod]) {
          map[a.paymentMethod].count++;
          map[a.paymentMethod].cents += cents;
        } else {
          unset.count++;
          unset.cents += cents;
        }
      });
      var list = PAYMENT_METHODS.map(function (p) {
        return map[p.id];
      });
      if (unset.count) list.push(unset);
      if (subscription.count) list.push(subscription);
      return list;
    }

    function renderPayBreakdown(containerId, rows) {
      var box = document.getElementById(containerId);
      if (!box) return;
      box.innerHTML = "";
      var stats = buildPayBreakdown(rows);
      stats.forEach(function (s) {
        var clickable = s.id && s.id !== "subscription";
        var card = document.createElement(clickable ? "button" : "div");
        if (clickable) card.type = "button";
        card.className = "finance-pay-card";
        if (clickable && financePaySelection && financePaySelection[s.id]) card.classList.add("is-active");
        card.innerHTML =
          "<span>" +
          s.label +
          "</span><strong>" +
          (s.subscription ? "Incluso" : formatMoney(s.cents)) +
          "</strong><small>" +
          s.count +
          (s.count === 1 ? " atendimento" : " atendimentos") +
          "</small>";
        if (clickable) {
          card.onclick = function () {
            toggleFinancePay(s.id);
          };
        }
        box.appendChild(card);
      });
    }

    function changeAppointmentPayment(appointment) {
      openPayMethodModal(
        "Forma de pagamento — " + (appointment.clientName || "cliente"),
        appointment.paymentMethod || "",
        function (method) {
          B()
            .updateAppointmentStatus(salonId, appointment.id, appointment.status || "DONE", {
              paymentMethod: method,
              coveredByMembership: false,
            })
            .then(function () {
              showMsg("Pagamento registrado: " + paymentMethodLabel(method) + ".", "ok");
              renderBarber();
              renderFinance();
              if (selectedProDeskId) renderProDesk();
            })
            .catch(function (e) {
              showMsg(e.message || "Erro ao salvar pagamento.");
            });
        }
      );
    }

    function buildServiceStats(rows) {
      var map = {};
      rows.forEach(function (a) {
        var key = a.serviceName || "Serviço";
        if (!map[key]) map[key] = { name: key, count: 0, cents: 0 };
        map[key].count++;
        map[key].cents += resolveApptPriceCents(a, barberServices);
      });
      return Object.keys(map)
        .map(function (k) {
          return map[k];
        })
        .sort(function (a, b) {
          return b.count - a.count || b.cents - a.cents;
        });
    }

    function financePersonTitle(p) {
      if (p && p.isOwner) return (p.name || "Dono") + " · barbeiro admin";
      return (p && p.name) || "Profissional";
    }

    function appendMovementRows(box, movements) {
      if (!box) return;
      box.innerHTML = "";
      if (!movements.length) {
        box.innerHTML = '<p class="muted">Nenhum lançamento neste período.</p>';
        return;
      }
      movements
        .slice()
        .sort(function (a, b) {
          return new Date(b.createdAt) - new Date(a.createdAt);
        })
        .forEach(function (m) {
          box.appendChild(renderCashMovementRow(m, false));
        });
    }

    function renderFinanceAppointments(rows, parts) {
      var listEl = document.getElementById("financeList");
      if (!listEl) return;
      listEl.innerHTML = "";
      if (!rows.length) {
        var emptyPay = parts.payLabel ? " em " + parts.payLabel : "";
        listEl.innerHTML =
          '<p class="muted">Nenhum atendimento concluído' +
          emptyPay +
          " em " +
          (parts.periodLabel || financeMonthLabel(parts.year, parts.month)) +
          ".</p>";
        return;
      }
      rows.forEach(function (a) {
        var covered = C().isSubscriptionAppointment(a);
        var cents = resolveApptPriceCents(a, barberServices);
        var row = document.createElement("div");
        row.className = "finance-row";
        row.innerHTML =
          '<div class="finance-row-main"><strong>' +
          (a.serviceName || "Serviço") +
          '</strong><span class="finance-row-meta">' +
          formatRange(a.completedAt || a.startAt) +
          (a.clientName ? " · " + a.clientName : "") +
          (a.professionalName ? " · " + a.professionalName : "") +
          " · " +
          (covered ? "Assinatura" : paymentMethodLabel(a.paymentMethod) || "Pagamento não informado") +
          "</span></div>";
        var valueWrap = document.createElement("div");
        valueWrap.className = "finance-row-side";
        var value = document.createElement("div");
        value.className = "finance-row-value";
        value.textContent = covered ? "Incluso" : formatMoney(cents);
        valueWrap.appendChild(value);
        if (!covered) {
          var payBtn = document.createElement("button");
          payBtn.type = "button";
          payBtn.className = "salon-btn-ghost finance-pay-edit";
          payBtn.textContent = a.paymentMethod ? "Alterar pagamento" : "Informar pagamento";
          payBtn.onclick = function () {
            changeAppointmentPayment(a);
          };
          valueWrap.appendChild(payBtn);
        }
        row.appendChild(valueWrap);
        listEl.appendChild(row);
      });
    }

    function renderFinancePeopleCards(targetId, pros, appointments, movements, range, withPay) {
      var box = document.getElementById(targetId);
      if (!box) return;
      box.innerHTML = "";
      var people = (pros || []).filter(function (p) {
        return p.active !== false;
      });
      if (!people.length) {
        box.innerHTML = '<p class="muted">Nenhum profissional cadastrado.</p>';
        return;
      }
      people.forEach(function (p) {
        var s = computeProSettlement(p, appointments, movements, range);
        var card = document.createElement("div");
        card.className = "cash-pro-card";
        card.innerHTML = '<div class="cash-pro-head"><strong>' + financePersonTitle(p) + "</strong></div>" + settlementHtml(s, p);
        if (withPay && !p.isOwner) {
          var actions = document.createElement("div");
          actions.className = "appt-actions";
          var pay = document.createElement("button");
          pay.type = "button";
          pay.className = "salon-btn-primary";
          pay.textContent = s.balance > 0 ? "Pagar saldo (" + formatMoney(s.balance) + ")" : "Pagar / dar vale";
          pay.onclick = function () {
            startProPayment(p, s.balance, parseFinanceMonthValue(financeMonthEl && financeMonthEl.value));
          };
          actions.appendChild(pay);
          card.appendChild(actions);
        }
        box.appendChild(card);
      });
    }

    function renderFinanceSummary(rows, parts) {
      var countEl = document.getElementById("financeKpiCount");
      var revenueEl = document.getElementById("financeKpiRevenue");
      var topEl = document.getElementById("financeKpiTopService");
      var topMetaEl = document.getElementById("financeKpiTopServiceMeta");
      var avgEl = document.getElementById("financeKpiAvg");
      var totalCents = 0;
      rows.forEach(function (a) {
        totalCents += resolveApptPriceCents(a, barberServices);
      });
      var stats = buildServiceStats(rows);
      var top = stats[0];

      if (countEl) countEl.textContent = String(rows.length);
      if (revenueEl) revenueEl.textContent = formatMoney(totalCents);
      if (avgEl) {
        avgEl.textContent = rows.length ? formatMoney(Math.round(totalCents / rows.length)) : formatMoney(0);
      }
      if (topEl) topEl.textContent = top ? top.name : "—";
      if (topMetaEl) {
        topMetaEl.textContent = top
          ? top.count + (top.count === 1 ? " atendimento realizado" : " atendimentos realizados")
          : "Nenhum atendimento registrado em " + financeMonthLabel(parts.year, parts.month);
      }
      renderPayBreakdown("financePayBreakdown", rows);
    }

    function renderFinanceDetail(rows, parts) {
      var listEl = document.getElementById("financeList");
      if (!listEl) return;
      listEl.innerHTML = "";
      if (!rows.length) {
        listEl.innerHTML =
          '<p class="muted">Nenhum atendimento concluído em ' +
          financeMonthLabel(parts.year, parts.month) +
          ".</p>";
        return;
      }
      rows.forEach(function (a) {
        var cents = resolveApptPriceCents(a, barberServices);
        var row = document.createElement("div");
        row.className = "finance-row";
        row.innerHTML =
          '<div class="finance-row-main">' +
          "<strong>" +
          (a.serviceName || "Serviço") +
          "</strong>" +
          '<span class="finance-row-meta">' +
          formatRange(a.completedAt || a.startAt) +
          (a.clientName ? " · Cliente: " + a.clientName : "") +
          (a.professionalName ? " · Profissional: " + a.professionalName : "") +
          " · " +
          (paymentMethodLabel(a.paymentMethod) || "Pagamento não informado") +
          "</span>" +
          "</div>";
        var valueWrap = document.createElement("div");
        valueWrap.className = "finance-row-side";
        var value = document.createElement("div");
        value.className = "finance-row-value";
        value.textContent = formatMoney(cents);
        valueWrap.appendChild(value);
        var payBtn = document.createElement("button");
        payBtn.type = "button";
        payBtn.className = "salon-btn-ghost finance-pay-edit";
        payBtn.textContent = a.paymentMethod ? "Alterar pagamento" : "Informar pagamento";
        payBtn.onclick = function () {
          changeAppointmentPayment(a);
        };
        valueWrap.appendChild(payBtn);
        row.appendChild(valueWrap);
        listEl.appendChild(row);
      });
    }

    function renderFinanceServiceRank(rows, parts) {
      var box = document.getElementById("financeServiceRank");
      if (!box) return;
      box.innerHTML = "";
      var stats = buildServiceStats(rows);
      if (!stats.length) {
        box.innerHTML =
          '<p class="muted">Nenhum serviço concluído em ' +
          financeMonthLabel(parts.year, parts.month) +
          ".</p>";
        return;
      }
      var totalCents = stats.reduce(function (sum, s) {
        return sum + s.cents;
      }, 0);
      stats.forEach(function (s, idx) {
        var share = totalCents ? Math.round((s.cents / totalCents) * 100) : 0;
        var row = document.createElement("div");
        row.className = "finance-service-row";
        row.innerHTML =
          '<div class="finance-service-badge">' +
          (idx + 1) +
          "º</div>" +
          '<div class="finance-service-body">' +
          "<strong>" +
          s.name +
          "</strong>" +
          '<span class="finance-row-meta">' +
          s.count +
          (s.count === 1 ? " atendimento" : " atendimentos") +
          " · " +
          formatMoney(s.cents) +
          (share ? " · " + share + "% da receita" : "") +
          "</span>" +
          "</div>";
        box.appendChild(row);
      });
    }

    async function renderFinance() {
      if (!financeMonthEl && !(financeDayEl && financeDayEl.value)) return;
      var token = ++financeRenderToken;
      var parts = financeMonthEl ? parseFinanceMonthValue(financeMonthEl.value) : null;
      if (!parts) {
        var financeNow = new Date();
        parts = { year: financeNow.getFullYear(), month: financeNow.getMonth() + 1 };
      }
      var range = financeViewRange(parts);
      parts.periodLabel = range.dayLabel || financeMonthLabel(parts.year, parts.month);
      parts.payLabel = financePayLabel(financePaySelection);
      var all = [];
      var movements = [];
      try {
        all = await B().listAppointmentsBarberView(salonId);
        await loadBarberServices();
        movements = await B().listCashMovements(salonId);
        if (!proDeskProsCache.length) proDeskProsCache = await B().listAllProfessionals(salonId);
      } catch (e) {
        if (token !== financeRenderToken) return;
        showMsg(e.message || "Erro ao carregar o painel financeiro.");
        return;
      }
      if (token !== financeRenderToken) return;

      var periodRows = all
        .filter(function (a) {
          return isInFinanceReport(a, range.start, range.end);
        })
        .sort(function (a, b) {
          return new Date(b.completedAt || b.startAt) - new Date(a.completedAt || a.startAt);
        });
      var rows = periodRows.filter(function (a) {
        return appointmentMatchesPayFilter(a, financePaySelection);
      });
      var paidRows = rows.filter(function (a) {
        return !C().isSubscriptionAppointment(a);
      });
      var subCount = rows.length - paidRows.length;
      var billed = 0;
      paidRows.forEach(function (a) {
        billed += resolveApptPriceCents(a, barberServices);
      });

      var monthMoves = movements.filter(function (m) {
        var d = new Date(m.createdAt);
        return d >= range.start && d < range.end;
      });
      var inMoves = monthMoves.filter(function (m) {
        return m.direction === "in" && movementMatchesPayFilter(m, financePaySelection);
      });
      var outMoves = monthMoves.filter(function (m) {
        return m.direction !== "in";
      });
      var otherIn = 0;
      inMoves.forEach(function (m) {
        otherIn += m.amountCents || 0;
      });
      var expenseOut = 0;
      var proOut = 0;
      var sangriaOut = 0;
      outMoves.forEach(function (m) {
        var cents = m.amountCents || 0;
        if (m.professionalId || String(m.category || "").indexOf("pro_") === 0) proOut += cents;
        else if (m.category === "sangria") sangriaOut += cents;
        else expenseOut += cents;
      });
      var entries = billed + otherIn;
      var exits = expenseOut + proOut;

      var adminPart = 0;
      var prosPart = 0;
      proDeskProsCache.forEach(function (p) {
        if (p.active === false) return;
        var s = computeProSettlement(p, rows, movements, range);
        if (p.isOwner) adminPart += s.produced;
        else {
          adminPart += s.shopCents;
          prosPart += s.proCents;
        }
      });
      if (billed > adminPart + prosPart) adminPart += billed - adminPart - prosPart;

      var billingKpis = document.getElementById("financeBillingKpis");
      if (billingKpis) {
        billingKpis.innerHTML =
          kpiCard(
            "Faturamento",
            formatMoney(billed),
            paidRows.length +
              (paidRows.length === 1 ? " atendimento pago" : " atendimentos pagos") +
              (subCount ? " · " + subCount + " cortes de assinatura fora deste valor" : ""),
            true
          ) +
          kpiCard("Barbeiro admin", formatMoney(adminPart), "Parte que fica com a casa") +
          kpiCard("Profissionais", formatMoney(prosPart), "Comissão a repassar") +
          kpiCard("Assinaturas", String(subCount), "Cortes inclusos no plano, sem nova cobrança");
      }
      var resultEl = document.getElementById("financeResultLine");
      var totalEl = document.getElementById("financePayTotal");
      if (totalEl) {
        totalEl.textContent = parts.payLabel
          ? "Total " + parts.payLabel + " · " + parts.periodLabel + ": " + formatMoney(billed)
          : "Total de todas as formas · " + parts.periodLabel + ": " + formatMoney(billed);
      }
      if (resultEl) {
        resultEl.innerHTML =
          "<span>" +
          (financePaySelection ? "Receita filtrada" : "Entradas") +
          " <strong>" +
          formatMoney(entries) +
          "</strong></span><span>Saídas <strong>" +
          formatMoney(exits) +
          "</strong></span>" +
          (sangriaOut ? "<span>Sangrias <strong>" + formatMoney(sangriaOut) + "</strong></span>" : "") +
          "<span>Resultado <strong>" +
          formatMoney(entries - exits) +
          "</strong></span>";
      }

      renderFinancePeopleCards("financePeople", proDeskProsCache, rows, movements, range, false);
      renderFinanceAppointments(rows, parts);

      var inKpis = document.getElementById("financeInKpis");
      if (inKpis) {
        inKpis.innerHTML =
          kpiCard("Total de entradas", formatMoney(entries), "Atendimentos pagos + outras entradas", true) +
          kpiCard(
            "Atendimentos",
            formatMoney(billed),
            paidRows.length + (paidRows.length === 1 ? " pagamento" : " pagamentos")
          ) +
          kpiCard(
            "Outras entradas",
            formatMoney(otherIn),
            inMoves.length + (inMoves.length === 1 ? " lançamento" : " lançamentos")
          );
      }
      renderPayBreakdown("financeInServices", periodRows.filter(function (a) {
        return !C().isSubscriptionAppointment(a);
      }));
      appendMovementRows(document.getElementById("financeInMoves"), inMoves);

      var outKpis = document.getElementById("financeOutKpis");
      if (outKpis) {
        outKpis.innerHTML =
          kpiCard("Total de saídas", formatMoney(exits + sangriaOut), "Despesas, pagamentos e sangrias", true) +
          kpiCard("Despesas e compras", formatMoney(expenseOut), "Contas, material e outras saídas") +
          kpiCard("Pagamentos a profissionais", formatMoney(proOut), "Comissão, vales e adiantamentos") +
          kpiCard("Sangrias", formatMoney(sangriaOut), "Retirada para cofre ou banco");
      }
      appendMovementRows(document.getElementById("financeOutMoves"), outMoves);
      renderFinancePeopleCards("financeProsList", proDeskProsCache, rows, movements, range, true);
    }

    async function renderProDesk() {
      var pro =
        proDeskProsCache.find(function (p) {
          return p.id === selectedProDeskId;
        }) || proDeskProsCache.filter(function (p) {
          return p.active !== false;
        })[0];
      if (!pro) {
        var emptyCuts = document.getElementById("proDeskCutsList");
        if (emptyCuts) emptyCuts.innerHTML = '<p class="muted">Cadastre um profissional para abrir o painel.</p>';
        return;
      }
      selectedProDeskId = pro.id;
      syncProDeskTabButtons("prodesk");
      var title = document.getElementById("proDeskTitle");
      var subtitle = document.getElementById("proDeskSubtitle");
      if (title) title.textContent = pro.name || "Profissional";
      if (subtitle) {
        subtitle.textContent = "Cortes e financeiro de " + (pro.name || "profissional") + ".";
      }
      setHidden("proDeskTabCuts", proDeskSubTab !== "cuts");
      setHidden("proDeskTabFinance", proDeskSubTab !== "finance");

      var parts = parseFinanceMonthValue(proDeskMonthEl && proDeskMonthEl.value);
      if (!parts) {
        var nowP = new Date();
        parts = { year: nowP.getFullYear(), month: nowP.getMonth() + 1 };
      }
      var range = financeMonthRange(parts.year, parts.month);
      var all = [];
      try {
        all = await B().listAppointmentsBarberView(salonId);
        await loadBarberServices();
      } catch (e) {
        showMsg(e.message || "Erro ao carregar o painel do profissional.");
        return;
      }
      var mine = all.filter(function (a) {
        return matchesProfessional(a, pro);
      });
      var today = C().startOfDay(new Date());
      var tomorrow = C().addMinutes(today, 24 * 60);
      var pending = mine.filter(function (a) {
        return a.status === "PENDING";
      }).length;
      var todayConf = mine.filter(function (a) {
        var s = new Date(a.startAt);
        return a.status === "CONFIRMED" && s >= today && s < tomorrow;
      }).length;
      var doneRows = mine.filter(function (a) {
        return isInFinanceReport(a, range.start, range.end);
      });
      var revenue = 0;
      var subCuts = 0;
      doneRows.forEach(function (a) {
        if (C().isSubscriptionAppointment(a)) subCuts++;
        else revenue += resolveApptPriceCents(a, barberServices);
      });
      var statsEl = document.getElementById("proDeskStats");
      if (statsEl) {
        statsEl.innerHTML =
          '<div class="barber-stat-pill"><span class="barber-stat-num">' +
          pending +
          "</span><small>Aguardando</small></div>" +
          '<div class="barber-stat-pill barber-stat-pill-accent"><span class="barber-stat-num">' +
          todayConf +
          "</span><small>Confirmados hoje</small></div>" +
          '<div class="barber-stat-pill"><span class="barber-stat-num">' +
          doneRows.length +
          "</span><small>Cortes no período</small></div>" +
          '<div class="barber-stat-pill"><span class="barber-stat-num">' +
          formatMoney(revenue) +
          "</span><small>Faturamento" +
          (subCuts ? " · " + subCuts + " assinatura" : "") +
          "</small></div>";
      }

      var kpiEl = document.getElementById("proDeskFinanceKpis");
      if (kpiEl) {
        kpiEl.innerHTML =
          '<div class="finance-stat-card"><span class="finance-stat-label">Atendimentos</span><strong class="finance-stat-value">' +
          doneRows.length +
          '</strong></div>' +
          '<div class="finance-stat-card finance-stat-highlight"><span class="finance-stat-label">Faturamento</span><strong class="finance-stat-value">' +
          formatMoney(revenue) +
          '</strong><span class="finance-stat-hint">' +
          (subCuts ? subCuts + " cortes de assinatura não entram neste valor" : "Sem cortes de assinatura no período") +
          "</span></div>" +
          '<div class="finance-stat-card"><span class="finance-stat-label">Ticket médio</span><strong class="finance-stat-value">' +
          formatMoney(doneRows.length - subCuts > 0 ? Math.round(revenue / (doneRows.length - subCuts)) : 0) +
          "</strong></div>";
      }
      renderPayBreakdown("proDeskPayBreakdown", doneRows);

      var settleBox = document.getElementById("proDeskSettlement");
      if (settleBox) {
        var proMovs = [];
        try {
          proMovs = await B().listCashMovements(salonId);
        } catch (e) {
          proMovs = [];
        }
        var settle = computeProSettlement(pro, all, proMovs, range);
        settleBox.innerHTML =
          '<p class="muted finance-panel-intro">' +
          financeMonthLabel(parts.year, parts.month) +
          " · a barbearia desconta " +
          String(settle.percent).replace(".", ",") +
          "% da produção. Pagamentos e vales lançados no Caixa são abatidos do saldo.</p>" +
          settlementHtml(settle, pro);
        if (!pro.isOwner) {
          var settleActions = document.createElement("div");
          settleActions.className = "appt-actions";
          settleActions.style.marginTop = "0.65rem";
          var payBtn = document.createElement("button");
          payBtn.type = "button";
          payBtn.className = "salon-btn-primary";
          payBtn.textContent =
            settle.balance > 0 ? "Pagar saldo (" + formatMoney(settle.balance) + ") pelo caixa" : "Lançar pagamento / vale";
          payBtn.onclick = function () {
            startProPayment(pro, settle.balance, parts);
          };
          settleActions.appendChild(payBtn);
          settleBox.appendChild(settleActions);
        }
      }

      var finList = document.getElementById("proDeskFinanceList");
      if (finList) {
        finList.innerHTML = "";
        if (!doneRows.length) {
          finList.innerHTML =
            '<p class="muted">Nenhum corte concluído em ' +
            financeMonthLabel(parts.year, parts.month) +
            ".</p>";
        } else {
          doneRows
            .slice()
            .sort(function (a, b) {
              return new Date(b.completedAt || b.startAt) - new Date(a.completedAt || a.startAt);
            })
            .forEach(function (a) {
              var row = document.createElement("div");
              row.className = "finance-row";
              row.innerHTML =
                '<div class="finance-row-main"><strong>' +
                (a.serviceName || "Serviço") +
                '</strong><span class="finance-row-meta">' +
                formatRange(a.completedAt || a.startAt) +
                (a.clientName ? " · " + a.clientName : "") +
                " · " +
                (C().isSubscriptionAppointment(a)
                  ? "Assinatura"
                  : paymentMethodLabel(a.paymentMethod) || "Pagamento não informado") +
                "</span></div>";
              var side = document.createElement("div");
              side.className = "finance-row-side";
              var val = document.createElement("div");
              val.className = "finance-row-value";
              val.textContent = C().isSubscriptionAppointment(a)
                ? "Incluso"
                : formatMoney(resolveApptPriceCents(a, barberServices));
              side.appendChild(val);
              var payBtn = document.createElement("button");
              payBtn.type = "button";
              payBtn.className = "salon-btn-ghost finance-pay-edit";
              payBtn.textContent = a.paymentMethod ? "Alterar" : "Pagamento";
              payBtn.onclick = function () {
                changeAppointmentPayment(a);
              };
              side.appendChild(payBtn);
              row.appendChild(side);
              finList.appendChild(row);
            });
        }
      }

      await renderBarber({
        listId: "proDeskCutsList",
        filterFn: function (a) {
          if (!matchesProfessional(a, pro)) return false;
          if (a.status === "PENDING" || a.status === "CONFIRMED") return true;
          if (a.status === "DONE") return isInFinanceReport(a, range.start, range.end);
          return false;
        },
        emptyText: "Nenhum corte deste profissional neste período.",
      });
    }

    /* ---------- Caixa ---------- */
    var cashSubTab = "current";
    var cashKind = "in";
    var cashOpenSession = null;
    var cashSessionsCache = [];
    var cashMovementsCache = [];
    var cashAppointmentsCache = [];
    var cashPros = [];
    var cashExpectedCents = 0;
    var cashProDetailId = "";

    var cashProMonthEl = document.getElementById("cashProMonth");
    if (cashProMonthEl) {
      var cashNow = new Date();
      cashProMonthEl.value = cashNow.getFullYear() + "-" + String(cashNow.getMonth() + 1).padStart(2, "0");
      cashProMonthEl.onchange = function () {
        renderCashPros();
      };
    }

    function parseMoneyInput(id) {
      var v = parseFloat(String(document.getElementById(id).value || "").replace(",", "."));
      return isNaN(v) ? NaN : Math.round(v * 100);
    }

    function fillSelect(sel, items, selected) {
      sel.innerHTML = "";
      items.forEach(function (it) {
        var o = document.createElement("option");
        o.value = it.id;
        o.textContent = it.label;
        sel.appendChild(o);
      });
      if (selected) sel.value = selected;
    }

    function setCashKind(kind) {
      cashKind = kind;
      document.querySelectorAll("#cashKindGrid [data-cash-kind]").forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-cash-kind") === kind);
      });
      fillSelect(document.getElementById("cashMoveCategory"), CASH_CATEGORIES[kind] || []);
      var methods =
        kind === "in"
          ? PAYMENT_METHODS
          : PAYMENT_METHODS.filter(function (p) {
              return p.id === "cash" || p.id === "pix";
            });
      fillSelect(document.getElementById("cashMoveMethod"), methods, "cash");
      setHidden("cashMoveMethodField", kind === "sangria");
      setHidden("cashMoveProField", kind !== "pro");
      var labels = {
        in: "Lançar entrada",
        out: "Lançar saída",
        sangria: "Registrar sangria",
        pro: "Registrar pagamento",
      };
      document.getElementById("btnCashMove").textContent = labels[kind] || "Lançar";
    }

    document.querySelectorAll("#cashKindGrid [data-cash-kind]").forEach(function (btn) {
      btn.onclick = function () {
        setCashKind(btn.getAttribute("data-cash-kind"));
      };
    });

    var cashPaySelection = null;

    function syncCashPayButtons() {
      document.querySelectorAll("#cashPayFilter [data-cash-pay-filter]").forEach(function (b) {
        var id = b.getAttribute("data-cash-pay-filter");
        var on = id === "all" ? !cashPaySelection : !!(cashPaySelection && cashPaySelection[id]);
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function toggleCashPay(id) {
      if (!id || id === "all") cashPaySelection = null;
      else {
        if (!cashPaySelection) cashPaySelection = {};
        if (cashPaySelection[id]) delete cashPaySelection[id];
        else cashPaySelection[id] = true;
        if (!Object.keys(cashPaySelection).length) cashPaySelection = null;
      }
      syncCashPayButtons();
      renderCashCurrent();
    }

    document.querySelectorAll("#cashPayFilter [data-cash-pay-filter]").forEach(function (btn) {
      btn.onclick = function () {
        toggleCashPay(btn.getAttribute("data-cash-pay-filter"));
      };
    });

    document.querySelectorAll("#cashSubTabs [data-cash-tab]").forEach(function (btn) {
      btn.onclick = function () {
        setCashSubTab(btn.getAttribute("data-cash-tab"));
      };
    });

    function setCashSubTab(tab) {
      cashSubTab = tab || "current";
      document.querySelectorAll("#cashSubTabs [data-cash-tab]").forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-cash-tab") === cashSubTab);
      });
      setHidden("cashTabCurrent", cashSubTab !== "current");
      setHidden("cashTabPros", cashSubTab !== "pros");
      setHidden("cashTabHistory", cashSubTab !== "history");
      if (cashSubTab === "pros") renderCashPros();
      if (cashSubTab === "history") renderCashHistory();
    }

    function sessionServiceAppointments(session) {
      if (!session) return [];
      var start = new Date(session.openedAt);
      var end = session.closedAt ? new Date(session.closedAt) : new Date(8640000000000000);
      return cashAppointmentsCache.filter(function (a) {
        if (a.status !== "DONE") return false;
        var d = new Date(a.completedAt || a.startAt);
        return d >= start && d <= end;
      });
    }

    function computeCashSummary(session) {
      var movs = cashMovementsCache.filter(function (m) {
        return m.sessionId === session.id;
      });
      var appts = sessionServiceAppointments(session);
      var byMethod = {};
      PAYMENT_METHODS.forEach(function (p) {
        byMethod[p.id] = 0;
      });
      byMethod.unset = 0;
      var servicesCash = 0;
      var servicesTotal = 0;
      var servicesCount = 0;
      appts.forEach(function (a) {
        if (C().isSubscriptionAppointment(a)) return;
        servicesCount++;
        var cents = resolveApptPriceCents(a, barberServices);
        servicesTotal += cents;
        if (byMethod[a.paymentMethod] != null && a.paymentMethod) byMethod[a.paymentMethod] += cents;
        else byMethod.unset += cents;
        if (a.paymentMethod === "cash") servicesCash += cents;
      });
      var cashIn = 0;
      var cashOut = 0;
      var inTotal = 0;
      var outTotal = 0;
      var proPaid = 0;
      movs.forEach(function (m) {
        var isCash = (m.method || "cash") === "cash";
        if (m.direction === "in") {
          inTotal += m.amountCents || 0;
          if (byMethod[m.method] != null) byMethod[m.method] += m.amountCents || 0;
          if (isCash) cashIn += m.amountCents || 0;
        } else {
          outTotal += m.amountCents || 0;
          if (isCash) cashOut += m.amountCents || 0;
          if (m.professionalId) proPaid += m.amountCents || 0;
        }
      });
      var opening = session.openingCents || 0;
      return {
        opening: opening,
        servicesCash: servicesCash,
        servicesTotal: servicesTotal,
        servicesCount: servicesCount,
        cashIn: cashIn,
        cashOut: cashOut,
        inTotal: inTotal,
        outTotal: outTotal,
        proPaid: proPaid,
        byMethod: byMethod,
        expected: opening + servicesCash + cashIn - cashOut,
        movements: movs,
      };
    }

    function kpiCard(label, value, hint, highlight) {
      return (
        '<div class="finance-stat-card' +
        (highlight ? " finance-stat-highlight" : "") +
        '"><span class="finance-stat-label">' +
        label +
        '</span><strong class="finance-stat-value">' +
        value +
        "</strong>" +
        (hint ? '<span class="finance-stat-hint">' + hint + "</span>" : "") +
        "</div>"
      );
    }

    function renderCashMovementRow(m, canDelete) {
      var row = document.createElement("div");
      row.className = "finance-row cash-mov-row cash-mov-" + (m.direction === "in" ? "in" : "out");
      var when = new Date(m.createdAt).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      row.innerHTML =
        '<div class="finance-row-main"><strong>' +
        cashCategoryLabel(m.category) +
        (m.professionalName ? " · " + m.professionalName : "") +
        '</strong><span class="finance-row-meta">' +
        when +
        " · " +
        (paymentMethodLabel(m.method) || "Dinheiro") +
        (m.description ? " · " + m.description : "") +
        "</span></div>";
      var side = document.createElement("div");
      side.className = "finance-row-side";
      var val = document.createElement("div");
      val.className = "finance-row-value cash-mov-value";
      val.textContent = (m.direction === "in" ? "+ " : "− ") + formatMoney(m.amountCents || 0);
      side.appendChild(val);
      if (canDelete) {
        var del = document.createElement("button");
        del.type = "button";
        del.className = "salon-btn-ghost finance-pay-edit";
        del.textContent = "Excluir";
        del.onclick = function () {
          if (!confirm("Excluir este movimento de " + formatMoney(m.amountCents || 0) + "?")) return;
          B()
            .deleteCashMovement(salonId, me.id, m.id)
            .then(function () {
              showMsg("Movimento excluído.", "ok");
              renderCash();
            })
            .catch(function (e) {
              showMsg(e.message || "Erro ao excluir movimento.");
            });
        };
        side.appendChild(del);
      }
      row.appendChild(side);
      return row;
    }

    function updateCashCloseDiff() {
      var el = document.getElementById("cashCloseDiff");
      if (!el) return;
      var counted = parseMoneyInput("cashCloseCounted");
      if (isNaN(counted)) {
        el.textContent = "Saldo esperado na gaveta: " + formatMoney(cashExpectedCents) + ".";
        return;
      }
      var diff = counted - cashExpectedCents;
      el.textContent =
        "Esperado: " +
        formatMoney(cashExpectedCents) +
        " · Contado: " +
        formatMoney(counted) +
        " · " +
        (diff === 0 ? "Caixa batendo." : diff > 0 ? "Sobra de " + formatMoney(diff) + "." : "Falta de " + formatMoney(-diff) + ".");
    }

    var cashCountedEl = document.getElementById("cashCloseCounted");
    if (cashCountedEl) cashCountedEl.oninput = updateCashCloseDiff;

    function hhmm(h, m) {
      return String(h || 0).padStart(2, "0") + ":" + String(m || 0).padStart(2, "0");
    }

    function parseHHMM(val) {
      var p = String(val || "").split(":");
      var h = parseInt(p[0], 10);
      var m = parseInt(p[1], 10) || 0;
      if (isNaN(h)) return null;
      return { h: h, m: m };
    }

    function todayHoursDescription() {
      var h = C().getHoursForDay(salon, new Date());
      if (h.closed) return "Fechada hoje — clientes não veem horários de hoje.";
      return (
        "Atendendo hoje das " +
        hhmm(h.openHour, h.openMinute) +
        " até " +
        hhmm(h.closeHour, h.closeMinute) +
        (h.override ? " (horário do dia)" : " (horário semanal)")
      );
    }

    function fillTodayHoursInputs(fromId, untilId, onlyIfEmpty) {
      var h = C().getHoursForDay(salon, new Date());
      var weekly = C().getWeeklyHoursForDay(salon, new Date());
      var fromEl = document.getElementById(fromId);
      var untilEl = document.getElementById(untilId);
      if (!fromEl || !untilEl) return;
      if (onlyIfEmpty && fromEl.value && untilEl.value) return;
      var src = h.closed ? weekly : h;
      var openH = src.openHour;
      var openM = src.openMinute || 0;
      if (weekly.closed && h.closed) {
        var now = new Date();
        openH = now.getHours();
        openM = now.getMinutes() - (now.getMinutes() % 5);
      }
      fromEl.value = hhmm(openH, openM);
      untilEl.value = hhmm(src.closeHour != null ? src.closeHour : 19, src.closeMinute || 0);
    }

    async function saveTodayHours(fromVal, untilVal) {
      var from = parseHHMM(fromVal);
      var until = parseHHMM(untilVal);
      if (!from || !until) throw new Error("Informe os horários de hoje.");
      if (until.h * 60 + until.m < from.h * 60 + from.m) {
        throw new Error("O horário final precisa ser depois do inicial.");
      }
      salon.dayOverrides = await B().setDayOverride(salonId, me.id, C().localDateKey(new Date()), {
        closed: false,
        open: from.h,
        openMinute: from.m,
        close: until.h,
        closeMinute: until.m,
      });
    }

    var formTodayHours = document.getElementById("formTodayHours");
    if (formTodayHours) {
      formTodayHours.onsubmit = function (ev) {
        ev.preventDefault();
        saveTodayHours(
          document.getElementById("todayHoursFrom").value,
          document.getElementById("todayHoursUntil").value
        )
          .then(function () {
            showMsg("Horário de hoje atualizado.", "ok");
            renderCashCurrent();
          })
          .catch(function (e) {
            showMsg(e.message || "Erro ao salvar o horário de hoje.");
          });
      };
    }

    function renderCashCurrent() {
      var badge = document.getElementById("cashStatusBadge");
      var statusText = document.getElementById("cashStatusText");
      if (!cashOpenSession) {
        badge.className = "badge badge-cancelled";
        badge.textContent = "Fechado";
        statusText.textContent =
          "Nenhum caixa aberto. Abra a barbearia e o caixa para lançar entradas e saídas. " +
          todayHoursDescription();
        setHidden("cashClosedBox", false);
        setHidden("cashOpenBox", true);
        fillTodayHoursInputs("cashOpenFrom", "cashOpenUntil", true);
        return;
      }
      document.getElementById("todayHoursText").textContent = todayHoursDescription();
      fillTodayHoursInputs("todayHoursFrom", "todayHoursUntil", false);
      badge.className = "badge badge-confirmed";
      badge.textContent = "Aberto";
      statusText.textContent =
        "Aberto em " +
        new Date(cashOpenSession.openedAt).toLocaleString("pt-BR") +
        (cashOpenSession.openNotes ? " · " + cashOpenSession.openNotes : "");
      setHidden("cashClosedBox", true);
      setHidden("cashOpenBox", false);

      var s = computeCashSummary(cashOpenSession);
      cashExpectedCents = s.expected;
      document.getElementById("cashKpis").innerHTML =
        kpiCard("Saldo inicial", formatMoney(s.opening), "Troco na abertura") +
        kpiCard(
          "Atendimentos em dinheiro",
          formatMoney(s.servicesCash),
          s.servicesCount + (s.servicesCount === 1 ? " atendimento" : " atendimentos") + " finalizados (" + formatMoney(s.servicesTotal) + " no total)"
        ) +
        kpiCard("Entradas em dinheiro", formatMoney(s.cashIn), "Lançadas no caixa") +
        kpiCard("Saídas em dinheiro", formatMoney(s.cashOut), "Inclui sangrias e pagamentos (" + formatMoney(s.proPaid) + " a profissionais)") +
        kpiCard("Saldo esperado na gaveta", formatMoney(s.expected), "Inicial + dinheiro recebido − saídas em dinheiro", true);

      var byBox = document.getElementById("cashByMethod");
      byBox.innerHTML = "";
      var methods = PAYMENT_METHODS.map(function (p) {
        return { id: p.id, label: p.label, cents: s.byMethod[p.id] || 0 };
      });
      if (s.byMethod.unset) methods.push({ id: "", label: "Não informado", cents: s.byMethod.unset });
      var allMethodCents = 0;
      var selectedCents = 0;
      methods.forEach(function (m) {
        allMethodCents += m.cents;
        if (!cashPaySelection || (m.id && cashPaySelection[m.id])) selectedCents += m.cents;
        var card = document.createElement(m.id ? "button" : "div");
        if (m.id) card.type = "button";
        card.className = "finance-pay-card";
        if (m.id && cashPaySelection && cashPaySelection[m.id]) card.classList.add("is-active");
        card.innerHTML = "<span>" + m.label + "</span><strong>" + formatMoney(m.cents) + "</strong>";
        if (m.id) {
          card.onclick = function () {
            toggleCashPay(m.id);
          };
        }
        byBox.appendChild(card);
      });
      var cashTotalEl = document.getElementById("cashPayTotal");
      if (cashTotalEl) {
        var cashNames = financePayLabel(cashPaySelection);
        cashTotalEl.textContent = cashNames
          ? "Total " + cashNames + ": " + formatMoney(selectedCents)
          : "Total de todas as formas: " + formatMoney(allMethodCents);
      }

      var inList = document.getElementById("cashMovInList");
      var outList = document.getElementById("cashMovOutList");
      if (inList) inList.innerHTML = "";
      if (outList) outList.innerHTML = "";
      var ins = s.movements.filter(function (m) {
        return m.direction === "in" && movementMatchesPayFilter(m, cashPaySelection);
      });
      var outs = s.movements.filter(function (m) {
        return m.direction !== "in";
      });
      if (inList) {
        if (!ins.length) inList.innerHTML = '<p class="muted">Nenhuma entrada lançada neste caixa.</p>';
        else ins.forEach(function (m) {
          inList.appendChild(renderCashMovementRow(m, true));
        });
      }
      if (outList) {
        if (!outs.length) outList.innerHTML = '<p class="muted">Nenhuma saída lançada neste caixa.</p>';
        else outs.forEach(function (m) {
          outList.appendChild(renderCashMovementRow(m, true));
        });
      }
      updateCashCloseDiff();
    }

    function fillCashProSelect(selectedId) {
      var sel = document.getElementById("cashMovePro");
      if (!sel) return;
      fillSelect(
        sel,
        cashPros.map(function (p) {
          return { id: p.id, label: (p.name || "Profissional") + (p.active === false ? " (bloqueado)" : "") };
        }),
        selectedId
      );
    }

    function renderCashPros() {
      var box = document.getElementById("cashProList");
      if (!box) return;
      box.innerHTML = "";
      var parts = parseFinanceMonthValue(cashProMonthEl && cashProMonthEl.value);
      if (!parts) return;
      var range = financeMonthRange(parts.year, parts.month);
      if (!cashPros.length) {
        box.innerHTML = '<p class="muted">Nenhum profissional cadastrado.</p>';
        return;
      }
      cashPros.forEach(function (p) {
        var s = computeProSettlement(p, cashAppointmentsCache, cashMovementsCache, range);
        var card = document.createElement("div");
        card.className = "cash-pro-card";
        card.innerHTML =
          '<div class="cash-pro-head"><strong>' +
          (p.name || "Profissional") +
          "</strong>" +
          (p.isOwner ? ' <span class="muted">· barbeiro admin</span>' : "") +
          "</div>" +
          settlementHtml(s, p);
        var actions = document.createElement("div");
        actions.className = "appt-actions";
        if (!p.isOwner) {
          var pay = document.createElement("button");
          pay.type = "button";
          pay.className = "salon-btn-primary";
          pay.textContent = s.balance > 0 ? "Pagar saldo (" + formatMoney(s.balance) + ")" : "Pagar / dar vale";
          pay.onclick = function () {
            startProPayment(p, s.balance, parts);
          };
          actions.appendChild(pay);
        }
        var ext = document.createElement("button");
        ext.type = "button";
        ext.className = "salon-btn-outline";
        ext.textContent = "Extrato";
        ext.onclick = function () {
          cashProDetailId = p.id;
          renderCashProDetail(p, range, parts);
        };
        actions.appendChild(ext);
        card.appendChild(actions);
        box.appendChild(card);
      });
      var current = cashPros.find(function (p) {
        return p.id === cashProDetailId;
      });
      if (current) renderCashProDetail(current, range, parts);
    }

    /** Abre o lançamento de pagamento no caixa já com o profissional e o saldo a pagar. */
    async function startProPayment(p, balanceCents, parts) {
      switchBarberTab("cash");
      await renderCash();
      if (!cashOpenSession) {
        showMsg("Abra o caixa antes de registrar um pagamento.");
        setCashSubTab("current");
        return;
      }
      setCashSubTab("current");
      setCashKind("pro");
      fillCashProSelect(p.id);
      document.getElementById("cashMoveCategory").value = "pro_payment";
      document.getElementById("cashMoveAmount").value =
        balanceCents > 0 ? (balanceCents / 100).toFixed(2) : "";
      document.getElementById("cashMoveDesc").value =
        "Pagamento " +
        (p.name || "") +
        " — " +
        (100 - proShopPercent(p)) +
        "% de " +
        (parts ? financeMonthLabel(parts.year, parts.month) : "período");
      document.getElementById("formCashMove").scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("cashMoveAmount").focus();
    }

    function renderCashProDetail(p, range, parts) {
      setHidden("cashProDetail", false);
      document.getElementById("cashProDetailTitle").textContent =
        "Extrato de " + (p.name || "profissional") + " — " + financeMonthLabel(parts.year, parts.month);
      var list = document.getElementById("cashProDetailList");
      list.innerHTML = "";
      var items = [];
      cashAppointmentsCache.forEach(function (a) {
        if (a.status !== "DONE" || !matchesProfessional(a, p)) return;
        var d = new Date(a.completedAt || a.startAt);
        if (d < range.start || d >= range.end) return;
        items.push({ kind: "service", date: d, a: a });
      });
      cashMovementsCache.forEach(function (m) {
        if (m.professionalId !== p.id) return;
        var d = new Date(m.createdAt);
        if (d < range.start || d >= range.end) return;
        items.push({ kind: "mov", date: d, m: m });
      });
      items.sort(function (x, y) {
        return y.date - x.date;
      });
      if (!items.length) {
        list.innerHTML = '<p class="muted">Nenhuma movimentação neste período.</p>';
        return;
      }
      items.forEach(function (it) {
        if (it.kind === "mov") {
          list.appendChild(renderCashMovementRow(it.m, false));
          return;
        }
        var a = it.a;
        var row = document.createElement("div");
        row.className = "finance-row";
        row.innerHTML =
          '<div class="finance-row-main"><strong>Atendimento · ' +
          (a.serviceName || "Serviço") +
          '</strong><span class="finance-row-meta">' +
          formatRange(a.completedAt || a.startAt) +
          (a.clientName ? " · " + a.clientName : "") +
          " · " +
          (paymentMethodLabel(a.paymentMethod) || "Pagamento não informado") +
          '</span></div><div class="finance-row-value">' +
          formatMoney(resolveApptPriceCents(a, barberServices)) +
          "</div>";
        list.appendChild(row);
      });
    }

    function renderCashHistory() {
      var box = document.getElementById("cashHistoryList");
      if (!box) return;
      box.innerHTML = "";
      var closed = cashSessionsCache.filter(function (s) {
        return s.status === "closed";
      });
      if (!closed.length) {
        box.innerHTML = '<p class="muted">Nenhum caixa fechado ainda.</p>';
        return;
      }
      closed.slice(0, 60).forEach(function (s) {
        var diff = s.differenceCents || 0;
        var movCount = cashMovementsCache.filter(function (m) {
          return m.sessionId === s.id;
        }).length;
        var row = document.createElement("div");
        row.className = "finance-row";
        row.innerHTML =
          '<div class="finance-row-main"><strong>' +
          new Date(s.openedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) +
          " → " +
          new Date(s.closedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) +
          '</strong><span class="finance-row-meta">Inicial ' +
          formatMoney(s.openingCents || 0) +
          " · Esperado " +
          formatMoney(s.expectedCents || 0) +
          " · Contado " +
          formatMoney(s.countedCents || 0) +
          " · " +
          movCount +
          (movCount === 1 ? " movimento" : " movimentos") +
          (s.closeNotes ? " · " + s.closeNotes : "") +
          '</span></div><div class="finance-row-value ' +
          (diff < 0 ? "cash-diff-neg" : diff > 0 ? "cash-diff-pos" : "") +
          '">' +
          (diff === 0 ? "Bateu" : (diff > 0 ? "Sobra " : "Falta ") + formatMoney(Math.abs(diff))) +
          "</div>";
        box.appendChild(row);
      });
    }

    async function renderCash() {
      try {
        var results = await Promise.all([
          B().listCashSessions(salonId),
          B().listCashMovements(salonId),
          B().listAllProfessionals(salonId),
          B().listAppointmentsBarberView(salonId),
          loadBarberServices(),
        ]);
        cashSessionsCache = results[0];
        cashMovementsCache = results[1];
        cashPros = results[2];
        cashAppointmentsCache = results[3];
      } catch (e) {
        showMsg(friendlyAuthError(e) || e.message || "Erro ao carregar o caixa.");
        return;
      }
      cashOpenSession =
        cashSessionsCache.find(function (s) {
          return s.status === "open";
        }) || null;
      var selectedPro = document.getElementById("cashMovePro").value;
      fillCashProSelect(selectedPro);
      if (!document.getElementById("cashMoveCategory").options.length) setCashKind(cashKind);
      renderCashCurrent();
      if (cashSubTab === "pros") renderCashPros();
      if (cashSubTab === "history") renderCashHistory();
    }

    document.getElementById("formCashOpen").onsubmit = function (ev) {
      ev.preventDefault();
      var cents = parseMoneyInput("cashOpenValue");
      if (isNaN(cents) || cents < 0) {
        showMsg("Informe o valor inicial do caixa.");
        return;
      }
      var fromVal = document.getElementById("cashOpenFrom").value;
      var untilVal = document.getElementById("cashOpenUntil").value;
      var from = parseHHMM(fromVal);
      var until = parseHHMM(untilVal);
      if (!from || !until || until.h * 60 + until.m < from.h * 60 + from.m) {
        showMsg("Informe até que horas a barbearia fica aberta hoje (depois do horário inicial).");
        return;
      }
      B()
        .openCashSession(salonId, me.id, {
          openingCents: cents,
          notes: document.getElementById("cashOpenNotes").value,
        })
        .then(function () {
          return saveTodayHours(fromVal, untilVal);
        })
        .then(function () {
          document.getElementById("formCashOpen").reset();
          showMsg(
            "Barbearia aberta até " + untilVal + " e caixa aberto com " + formatMoney(cents) + ".",
            "ok"
          );
          renderCash();
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao abrir o caixa.");
          renderCash();
        });
    };

    document.getElementById("formCashMove").onsubmit = function (ev) {
      ev.preventDefault();
      if (!cashOpenSession) {
        showMsg("Abra o caixa antes de lançar movimentos.");
        return;
      }
      var cents = parseMoneyInput("cashMoveAmount");
      if (isNaN(cents) || cents <= 0) {
        showMsg("Informe um valor maior que zero.");
        return;
      }
      var desc = document.getElementById("cashMoveDesc").value.trim();
      if (!desc) {
        showMsg("Descreva o movimento.");
        return;
      }
      var method = cashKind === "sangria" ? "cash" : document.getElementById("cashMoveMethod").value;
      var mov = {
        sessionId: cashOpenSession.id,
        direction: cashKind === "in" ? "in" : "out",
        category: document.getElementById("cashMoveCategory").value,
        amountCents: cents,
        method: method,
        description: desc,
      };
      if (cashKind === "pro") {
        var proId = document.getElementById("cashMovePro").value;
        var pro = cashPros.find(function (p) {
          return p.id === proId;
        });
        if (!pro) {
          showMsg("Escolha o profissional.");
          return;
        }
        mov.professionalId = pro.id;
        mov.professionalName = pro.name || "";
      }
      if (method === "cash" && mov.direction === "out" && cents > cashExpectedCents) {
        if (
          !confirm(
            "Esta saída (" +
              formatMoney(cents) +
              ") é maior que o saldo esperado em dinheiro (" +
              formatMoney(cashExpectedCents) +
              "). Lançar mesmo assim?"
          )
        ) {
          return;
        }
      }
      var btn = document.getElementById("btnCashMove");
      btn.disabled = true;
      B()
        .addCashMovement(salonId, me.id, mov)
        .then(function () {
          document.getElementById("cashMoveAmount").value = "";
          document.getElementById("cashMoveDesc").value = "";
          showMsg(
            (mov.direction === "in" ? "Entrada" : cashKind === "sangria" ? "Sangria" : "Saída") +
              " de " +
              formatMoney(cents) +
              " registrada.",
            "ok"
          );
          renderCash();
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao lançar movimento.");
        })
        .finally(function () {
          btn.disabled = false;
        });
    };

    document.getElementById("formCashClose").onsubmit = function (ev) {
      ev.preventDefault();
      if (!cashOpenSession) return;
      var counted = parseMoneyInput("cashCloseCounted");
      if (isNaN(counted) || counted < 0) {
        showMsg("Informe quanto dinheiro foi contado na gaveta.");
        return;
      }
      var s = computeCashSummary(cashOpenSession);
      var diff = counted - s.expected;
      if (
        !confirm(
          "Fechar o caixa?\n\nEsperado: " +
            formatMoney(s.expected) +
            "\nContado: " +
            formatMoney(counted) +
            "\n" +
            (diff === 0 ? "Caixa batendo." : diff > 0 ? "Sobra: " + formatMoney(diff) : "Falta: " + formatMoney(-diff))
        )
      ) {
        return;
      }
      B()
        .closeCashSession(salonId, me.id, cashOpenSession.id, {
          countedCents: counted,
          expectedCents: s.expected,
          notes: document.getElementById("cashCloseNotes").value,
          summary: {
            servicesCashCents: s.servicesCash,
            servicesTotalCents: s.servicesTotal,
            servicesCount: s.servicesCount,
            cashInCents: s.cashIn,
            cashOutCents: s.cashOut,
            inTotalCents: s.inTotal,
            outTotalCents: s.outTotal,
            proPaidCents: s.proPaid,
            byMethod: s.byMethod,
          },
        })
        .then(async function () {
          var closeShop = document.getElementById("cashCloseShop").checked;
          if (closeShop) {
            salon.dayOverrides = await B().setDayOverride(salonId, me.id, C().localDateKey(new Date()), {
              closed: true,
            });
          }
          document.getElementById("formCashClose").reset();
          document.getElementById("cashCloseShop").checked = true;
          showMsg(closeShop ? "Caixa fechado e barbearia fechada para hoje." : "Caixa fechado.", "ok");
          renderCash();
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao fechar o caixa.");
        });
    };

    setCashKind("in");

    /* ---------- Lançar atendimento manual (inclusive retroativo) ---------- */
    var manualPros = [];

    function manualSelectedServices() {
      var ids = [];
      document.querySelectorAll("#manualServices input[type=checkbox]:checked").forEach(function (c) {
        ids.push(c.value);
      });
      return barberServices.filter(function (s) {
        return ids.indexOf(s.id) >= 0;
      });
    }

    function manualStartDate() {
      var d = document.getElementById("manualDate").value;
      var t = document.getElementById("manualTime").value;
      if (!d || !t) return null;
      var dt = new Date(d + "T" + t + ":00");
      return isNaN(dt.getTime()) ? null : dt;
    }

    function updateManualStatus() {
      var picked = manualSelectedServices();
      var duration = picked.reduce(function (s, x) {
        return s + (x.durationMin || 0);
      }, 0) || 30;
      var start = manualStartDate();
      var hint = document.getElementById("manualStatusHint");
      if (!start) {
        hint.textContent = "";
        return;
      }
      var end = C().addMinutes(start, duration);
      var past = start <= new Date();
      setHidden("manualPayField", !past);
      hint.textContent = past
        ? "Será registrado como CONCLUÍDO em " +
          start.toLocaleString("pt-BR") +
          " e entra no histórico e no financeiro desse dia."
        : "Será registrado como CONFIRMADO para " +
          start.toLocaleString("pt-BR") +
          " (até " +
          end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) +
          ").";
    }

    function updateManualPrice() {
      var total = manualSelectedServices().reduce(function (s, x) {
        return s + (x.priceCents || 0);
      }, 0);
      document.getElementById("manualPrice").value = (total / 100).toFixed(2);
    }

    async function openManualForm() {
      await loadBarberServices();
      try {
        manualPros = (await B().listAllProfessionals(salonId)).filter(function (p) {
          return p.active !== false;
        });
      } catch (e) {
        manualPros = [];
      }
      var proSel = document.getElementById("manualPro");
      proSel.innerHTML = "";
      manualPros.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name || "Profissional";
        proSel.appendChild(o);
      });
      var svcBox = document.getElementById("manualServices");
      svcBox.innerHTML = "";
      barberServices
        .filter(function (s) {
          return s.active !== false;
        })
        .forEach(function (s) {
          var lab = document.createElement("label");
          lab.className = "payment-option";
          lab.innerHTML =
            '<input type="checkbox" value="' +
            s.id +
            '" /> ' +
            s.name +
            ' <span class="muted">· ' +
            formatMoney(s.priceCents || 0) +
            "</span>";
          lab.querySelector("input").onchange = function () {
            updateManualPrice();
            updateManualStatus();
          };
          svcBox.appendChild(lab);
        });
      var now = new Date();
      document.getElementById("manualDate").value = C().localDateKey(now);
      document.getElementById("manualTime").value = hhmm(now.getHours(), now.getMinutes() - (now.getMinutes() % 5));
      document.getElementById("manualPrice").value = "0.00";
      setHidden("manualApptBox", false);
      updateManualStatus();
      document.getElementById("manualClientName").focus();
    }

    function closeManualForm() {
      document.getElementById("formManualAppt").reset();
      var hint = document.getElementById("manualSubscriberHint");
      if (hint) hint.textContent = "";
      setHidden("manualApptBox", true);
    }

    document.getElementById("btnManualApptToggle").onclick = function () {
      if (document.getElementById("manualApptBox").classList.contains("hidden")) openManualForm();
      else closeManualForm();
    };
    document.getElementById("btnManualCancel").onclick = closeManualForm;
    async function refreshManualSubscriberHint() {
      var hint = document.getElementById("manualSubscriberHint");
      if (!hint) return;
      var name = document.getElementById("manualClientName").value.trim();
      var phone = document.getElementById("manualClientPhone").value.trim();
      if (!C().phoneKey(phone) || C().normalizePersonName(name).length < 3) {
        hint.textContent = "";
        return;
      }
      if (!membershipsCache.length) {
        try {
          membershipsCache = await B().listMemberships(salonId);
        } catch (e) {}
      }
      hint.textContent = subscriberBookingText(C().pickMembershipForClient(membershipsCache, name, phone));
    }
    var manualNameEl = document.getElementById("manualClientName");
    var manualPhoneEl = document.getElementById("manualClientPhone");
    if (manualNameEl) manualNameEl.oninput = refreshManualSubscriberHint;
    if (manualPhoneEl) manualPhoneEl.oninput = refreshManualSubscriberHint;
    document.getElementById("manualDate").onchange = updateManualStatus;
    document.getElementById("manualTime").onchange = updateManualStatus;

    document.getElementById("formManualAppt").onsubmit = async function (ev) {
      ev.preventDefault();
      var name = document.getElementById("manualClientName").value.trim();
      var picked = manualSelectedServices();
      var proId = document.getElementById("manualPro").value;
      var pro = manualPros.find(function (p) {
        return p.id === proId;
      });
      var start = manualStartDate();
      var cents = parseMoneyInput("manualPrice");
      if (!name) return showMsg("Informe o nome do cliente.");
      if (!pro) return showMsg("Escolha o profissional.");
      if (!picked.length) return showMsg("Selecione pelo menos um serviço.");
      if (!start) return showMsg("Informe data e horário.");
      if (isNaN(cents) || cents < 0) return showMsg("Informe o valor cobrado.");

      var duration = picked.reduce(function (s, x) {
        return s + (x.durationMin || 0);
      }, 0) || 30;
      var end = C().addMinutes(start, duration);
      var now = new Date();
      var past = start <= now;
      var all = [];
      try {
        all = await B().listAppointmentsBarberView(salonId);
      } catch (e) {
        all = [];
      }
      if (!past) {
        try {
          C().assertSlotFree(start, end, undefined, all, pro.id);
        } catch (e) {
          if (!confirm("Já existe agendamento de " + (pro.name || "") + " nesse horário. Lançar mesmo assim?")) return;
        }
      }
      var manualPhone = document.getElementById("manualClientPhone").value.trim();
      if (!membershipsCache.length) {
        try {
          membershipsCache = await B().listMemberships(salonId);
        } catch (e) {
          membershipsCache = membershipsCache || [];
        }
      }
      var manualMatch = C().pickMembershipForClient(membershipsCache, name, manualPhone);
      var ap = {
        clientId: null,
        clientName: name,
        clientPhone: manualPhone,
        professionalId: pro.id,
        professionalName: pro.name || "",
        serviceId: picked[0].id,
        serviceIds: picked.map(function (s) {
          return s.id;
        }),
        serviceName: picked
          .map(function (s) {
            return s.name;
          })
          .join(" + "),
        priceCents: cents,
        durationMin: duration,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        status: past ? "DONE" : "CONFIRMED",
        source: "manual",
        createdBy: me.id,
      };
      attachSubscriber(ap, manualMatch);
      if (past && manualMatch && C().subscriberState(manualMatch) === "active") {
        ap.paymentMethod = "subscription";
        ap.coveredByMembership = true;
      }
      if (past) {
        ap.completedAt = (end < now ? end : now).toISOString();
        if (!(manualMatch && C().subscriberState(manualMatch) === "active")) {
          ap.paymentMethod = document.getElementById("manualPay").value;
          ap.coveredByMembership = false;
        }
      }
      var btn = document.getElementById("btnManualSubmit");
      btn.disabled = true;
      try {
        await B().createAppointment(salonId, ap);
        closeManualForm();
        var manualSubText = subscriberBookingText(manualMatch);
        showMsg(
          (past
            ? "Atendimento de " + name + " registrado como concluído em " + start.toLocaleString("pt-BR") + "."
            : "Agendamento de " + name + " confirmado para " + start.toLocaleString("pt-BR") + ".") +
            (manualSubText ? " " + manualSubText : ""),
          "ok"
        );
        renderBarber();
        renderSummary();
      } catch (e) {
        showMsg(friendlyAuthError(e) || e.message || "Erro ao salvar o atendimento.");
      } finally {
        btn.disabled = false;
      }
    };

    var rangeMode = "60";
    var weekStartEl = document.getElementById("weekStart");
    var singleDayEl = document.getElementById("singleDay");
    var weekFields = document.getElementById("weekFields");
    var dayFields = document.getElementById("dayFields");

    function todayStr() {
      return C().startOfDay(new Date()).toISOString().slice(0, 10);
    }
    weekStartEl.value = todayStr();
    singleDayEl.value = todayStr();

    document.querySelectorAll("[data-range]").forEach(function (btn) {
      btn.onclick = function () {
        document.querySelectorAll("[data-range]").forEach(function (b) {
          b.classList.remove("is-active");
        });
        btn.classList.add("is-active");
        rangeMode = btn.getAttribute("data-range");
        weekFields.style.display = rangeMode === "week" ? "block" : "none";
        dayFields.style.display = rangeMode === "day" ? "block" : "none";
        renderBarber();
        renderSummary();
      };
    });
    weekStartEl.onchange = function () {
      renderBarber();
      renderSummary();
    };
    singleDayEl.onchange = function () {
      renderBarber();
      renderSummary();
    };

    function inFilter(a) {
      var s = new Date(a.startAt);
      var t0 = C().startOfDay(new Date());
      var t1 = C().addMinutes(t0, 60 * 24 * 60);
      if (rangeMode === "60") return s >= t0 && s < t1;
      if (rangeMode === "week") {
        var w0 = new Date(weekStartEl.value + "T00:00:00");
        return s >= w0 && s < C().addMinutes(w0, 7 * 24 * 60);
      }
      var d0 = new Date(singleDayEl.value + "T00:00:00");
      return s >= d0 && s < C().addMinutes(d0, 24 * 60);
    }

    function resolveSubscriber(a) {
      if (!a || !membershipsCache || !membershipsCache.length) return null;
      if (a.membershipId) {
        var byId = membershipsCache.find(function (m) {
          return m.id === a.membershipId;
        });
        if (byId) return byId;
      }
      return C().pickMembershipForClient(membershipsCache, a.clientName, a.clientPhone);
    }

    async function rememberSubscriber(a, match) {
      if (!match || a.membershipId || a.status === "CANCELLED") return;
      var state = C().subscriberState(match);
      var alreadyPaid = a.paymentMethod && a.paymentMethod !== "subscription";
      var openVisit = a.status === "PENDING" || a.status === "CONFIRMED";
      var extra = {
        membershipId: match.id,
        membershipPlanName: match.planName || "",
        subscriberStatus: state,
        clientPhone: a.clientPhone || match.clientPhone || "",
      };
      if (openVisit && state === "active" && !alreadyPaid) {
        extra.coveredByMembership = true;
        extra.paymentMethod = "subscription";
      }
      try {
        await B().updateAppointmentStatus(salonId, a.id, a.status, extra);
        Object.assign(a, extra);
      } catch (e) {}
    }

    async function consumeSubscriptionCuts(appointments) {
      for (var i = 0; i < appointments.length; i++) {
        var a = appointments[i];
        if (a.status !== "DONE" || a.membershipCutRegistered) continue;
        if (!C().isSubscriptionAppointment(a)) continue;
        var match = resolveSubscriber(a);
        if (!match || C().subscriberState(match) !== "active") continue;
        if (subscriptionCutAttempted[a.id]) continue;
        subscriptionCutAttempted[a.id] = true;
        try {
          var used = await B().registerMembershipCut(
            salonId,
            me.id,
            match.id,
            (a.clientName || "Cliente") + " · " + (a.serviceName || "corte")
          );
          match.cutsUsed = used;
          if (match.cutsIncluded > 0 && used >= match.cutsIncluded) match.status = "no_cuts";
          await B().updateAppointmentStatus(salonId, a.id, "DONE", {
            membershipCutRegistered: true,
            membershipId: match.id,
            paymentMethod: "subscription",
            coveredByMembership: true,
          });
          a.membershipCutRegistered = true;
        } catch (e) {
          console.warn("Corte de assinatura:", e);
        }
      }
    }

    async function renderBarber(options) {
      options = options || {};
      var list = document.getElementById(options.listId || "barberList");
      if (!list) return;
      list.innerHTML = "";
      var all = [];
      try {
        all = await B().listAppointmentsBarberView(salonId);
      } catch (e) {
        console.error("Agenda barbeiro:", e);
        list.innerHTML =
          '<p class="muted">Não foi possível carregar a agenda. Recarregue a página ou verifique o login.</p>';
        showMsg((e && e.message) || "Erro ao carregar agendamentos.");
        return;
      }
      if (!options.listId || options.listId === "barberList") watchNewAppointments(all);
      try {
        membershipsCache = await B().listMemberships(salonId);
      } catch (e) {
        membershipsCache = membershipsCache || [];
      }
      for (var si = 0; si < all.length; si++) {
        var liveMatch = resolveSubscriber(all[si]);
        if (liveMatch) await rememberSubscriber(all[si], liveMatch);
      }
      if (!options.skipSubscriptionCuts) await consumeSubscriptionCuts(all);
      var items = all
        .filter(function (a) {
          return options.filterFn ? options.filterFn(a) : inFilter(a);
        })
        .sort(function (a, b) {
          return new Date(a.startAt) - new Date(b.startAt);
        });
      if (!items.length) {
        if (options.emptyText) {
          list.innerHTML = '<p class="muted">' + options.emptyText + "</p>";
          return;
        }
        var pending = all.filter(function (a) {
          return a.status === "PENDING";
        }).length;
        list.innerHTML =
          '<p class="muted">Nenhum agendamento neste filtro.</p>' +
          (pending
            ? '<p class="muted">Há ' + pending + " pendente(s) fora do período — use o filtro <strong>60 dias</strong>.</p>"
            : "");
        return;
      }
      items.forEach(function (a) {
        var row = document.createElement("div");
        row.className = "appt-row";
        var left = document.createElement("div");
        left.innerHTML =
          "<strong>" +
          (a.clientName || "Cliente") +
          "</strong> — " +
          (a.serviceName || "") +
          (a.professionalName ? " · " + a.professionalName : "") +
          '<div class="appt-meta">' +
          formatRange(a.startAt) +
          (a.paymentMethod && a.paymentMethod !== "subscription" ? " · " + paymentMethodLabel(a.paymentMethod) : "") +
          (C().isSubscriptionAppointment(a) ? " · Assinatura" : "") +
          '</div><span class="' +
          badgeClass(a.status) +
          '">' +
          statusLabel(a.status) +
          "</span> " +
          appointmentSubscriberBadge(a, resolveSubscriber(a));
        var actions = document.createElement("div");
        actions.className = "appt-actions";

        function patchStatus(st, extraFields) {
          var extra = extraFields ? Object.assign({}, extraFields) : {};
          if (st === "DONE") {
            extra.completedAt = extra.completedAt || new Date().toISOString();
            if (a.priceCents == null) {
              var cents = resolveApptPriceCents(a, barberServices);
              if (cents) extra.priceCents = cents;
            }
          }
          B()
            .updateAppointmentStatus(salonId, a.id, st, extra)
            .then(async function () {
              var msg =
                st === "CONFIRMED"
                  ? "Seu horário foi confirmado."
                  : st === "DONE"
                    ? "Serviço finalizado. Obrigado!"
                    : st === "CANCELLED"
                      ? "Seu agendamento foi cancelado pela barbearia."
                      : "";
              if (msg && a.clientId) await B().addNotification(salonId, a.clientId, msg);
              renderBarber();
              renderSummary();
              if (st === "DONE") renderFinance();
              if (selectedProDeskId) renderProDesk();
            })
            .catch(function (e) {
              showMsg(e.message);
            });
        }

        if (a.status === "PENDING") {
          var b1 = document.createElement("button");
          b1.type = "button";
          b1.className = "salon-btn-outline";
          b1.textContent = "Confirmar";
          b1.onclick = function () {
            patchStatus("CONFIRMED");
          };
          actions.appendChild(b1);
        }
        if (a.status === "PENDING" || a.status === "CONFIRMED") {
          (a.clientId ? ["Finalizar", "Cancelar", "Lembrete"] : ["Finalizar", "Cancelar"]).forEach(function (label, i) {
            var bx = document.createElement("button");
            bx.type = "button";
            bx.className = i === 2 ? "salon-btn-ghost" : "salon-btn-outline";
            bx.textContent = label;
            bx.onclick = function () {
              if (label === "Finalizar") {
                var subMatch = resolveSubscriber(a);
                var subState = subMatch ? C().subscriberState(subMatch) : a.subscriberStatus || "";
                if (subState === "active" || C().isSubscriptionAppointment(a)) {
                  var matchId = (subMatch && subMatch.id) || a.membershipId || "";
                  var doneExtra = {
                    paymentMethod: "subscription",
                    coveredByMembership: true,
                    membershipId: matchId,
                    membershipPlanName: (subMatch && subMatch.planName) || a.membershipPlanName || "",
                    subscriberStatus: "active",
                    membershipCutRegistered: true,
                  };
                  function finishCovered() {
                    patchStatus("DONE", doneExtra);
                    showMsg("Finalizado como assinatura. O corte entra no plano do cliente.", "ok");
                  }
                  if (matchId && !a.membershipCutRegistered && subMatch && C().subscriberState(subMatch) === "active") {
                    B()
                      .registerMembershipCut(
                        salonId,
                        me.id,
                        matchId,
                        (a.clientName || "Cliente") + " · " + (a.serviceName || "corte")
                      )
                      .then(function (used) {
                        subMatch.cutsUsed = used;
                        if (subMatch.cutsIncluded > 0 && used >= subMatch.cutsIncluded) subMatch.status = "no_cuts";
                        subscriptionCutAttempted[a.id] = true;
                        finishCovered();
                      })
                      .catch(function (err) {
                        showMsg((err && err.message) || "Não foi possível usar a assinatura. Informe o pagamento.");
                        openPayMethodModal(
                          "Como " + (a.clientName || "o cliente") + " pagou?",
                          "",
                          function (method) {
                            patchStatus("DONE", { paymentMethod: method, coveredByMembership: false });
                          }
                        );
                      });
                    return;
                  }
                  finishCovered();
                  return;
                }
                if (subState === "expired" || subState === "no_cuts") {
                  showMsg(
                    subState === "expired"
                      ? "Assinatura vencida. Informe como o cliente pagou."
                      : "Assinatura sem cortes disponíveis. Informe como o cliente pagou."
                  );
                }
                openPayMethodModal(
                  "Como " + (a.clientName || "o cliente") + " pagou?",
                  a.paymentMethod || "",
                  function (method) {
                    patchStatus("DONE", { paymentMethod: method, coveredByMembership: false });
                  }
                );
              } else if (label === "Cancelar") patchStatus("CANCELLED");
              else {
                B()
                  .addNotification(
                    salonId,
                    a.clientId,
                    "Lembrete: horário em " + formatRange(a.startAt) + " — " + (a.serviceName || "")
                  )
                  .then(function () {
                    showMsg("Lembrete enviado.", "ok");
                  });
              }
            };
            actions.appendChild(bx);
          });
        }
        if (a.status === "DONE") {
          var payEdit = document.createElement("button");
          payEdit.type = "button";
          payEdit.className = "salon-btn-ghost";
          payEdit.textContent = a.paymentMethod ? "Alterar pagamento" : "Informar pagamento";
          payEdit.onclick = function () {
            changeAppointmentPayment(a);
          };
          actions.appendChild(payEdit);
        }
        row.appendChild(left);
        row.appendChild(actions);
        list.appendChild(row);
      });
    }

    async function renderSummary() {
      var all = await B().listAppointmentsBarberView(salonId);
      var today = C().startOfDay(new Date());
      var tomorrow = C().addMinutes(today, 24 * 60);
      var pend = all.filter(function (a) {
        return a.status === "PENDING";
      }).length;
      var confToday = all.filter(function (a) {
        var s = new Date(a.startAt);
        return a.status === "CONFIRMED" && s >= today && s < tomorrow;
      }).length;
      document.getElementById("summaryText").textContent =
        "Aguardando confirmação: " + pend + ". Confirmados para hoje: " + confToday + ".";

      var monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      var monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
      var doneMonth = all.filter(function (a) {
        if (a.status !== "DONE" || a.financeArchived) return false;
        var d = new Date(a.completedAt || a.startAt);
        return d >= monthStart && d < monthEnd;
      }).length;

      var statPending = document.getElementById("barberStatPending");
      var statToday = document.getElementById("barberStatToday");
      var statDone = document.getElementById("barberStatDone");
      if (statPending) statPending.textContent = String(pend);
      if (statToday) statToday.textContent = String(confToday);
      if (statDone) statDone.textContent = String(doneMonth);
    }

    async function renderServices() {
      var box = document.getElementById("servicesList");
      box.innerHTML = "";
      var list = await B().listServices(salonId);
      barberServices = list;
      var count = document.createElement("p");
      count.className = "services-count";
      count.textContent =
        list.length === 0
          ? "Nenhum serviço cadastrado ainda. Adicione quantos precisar abaixo."
          : list.length + (list.length === 1 ? " serviço cadastrado" : " serviços cadastrados");
      box.appendChild(count);
      list.forEach(function (s) {
        var row = document.createElement("div");
        row.className = "appt-row";
        row.innerHTML =
          "<div><strong>" +
          s.name +
          "</strong><div class=\"appt-meta\">" +
          formatMoney(s.priceCents) +
          " · " +
          s.durationMin +
          " min</div></div>";
        var actions = document.createElement("div");
        actions.className = "appt-actions";
        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "salon-btn-outline";
        edit.textContent = "Editar";
        edit.onclick = function () {
          document.getElementById("svcEditId").value = s.id;
          document.getElementById("svcName").value = s.name || "";
          document.getElementById("svcDur").value = s.durationMin || "";
          document.getElementById("svcPrice").value = ((s.priceCents || 0) / 100).toFixed(2);
          document.getElementById("btnSvcSubmit").textContent = "Salvar serviço";
          document.getElementById("btnSvcCancel").classList.remove("hidden");
          var title = document.getElementById("svcFormTitle");
          if (title) title.textContent = "Editar serviço";
          document.getElementById("svcName").focus();
          document.getElementById("formService").scrollIntoView({ behavior: "smooth", block: "start" });
        };
        actions.appendChild(edit);
        var del = document.createElement("button");
        del.type = "button";
        del.className = "salon-btn-ghost";
        del.textContent = "Remover";
        del.onclick = function () {
          if (!confirm("Remover o serviço \"" + s.name + "\"?")) return;
          B()
            .deleteService(salonId, me.id, s.id)
            .then(function () {
              if (document.getElementById("svcEditId").value === s.id) resetSvcForm();
              return renderServices();
            })
            .catch(function (e) {
              showMsg(e.message || "Erro ao remover serviço.");
            });
        };
        actions.appendChild(del);
        row.appendChild(actions);
        box.appendChild(row);
      });
    }

    function resetSvcForm() {
      document.getElementById("formService").reset();
      document.getElementById("svcEditId").value = "";
      document.getElementById("btnSvcSubmit").textContent = "Adicionar serviço";
      document.getElementById("btnSvcCancel").classList.add("hidden");
      var title = document.getElementById("svcFormTitle");
      if (title) title.textContent = "Adicionar serviço";
    }

    var btnSvcCancel = document.getElementById("btnSvcCancel");
    if (btnSvcCancel) btnSvcCancel.onclick = resetSvcForm;

    document.getElementById("formService").onsubmit = function (ev) {
      ev.preventDefault();
      var editId = document.getElementById("svcEditId").value.trim();
      var name = document.getElementById("svcName").value.trim();
      var durationMin = parseInt(document.getElementById("svcDur").value, 10);
      var priceVal = parseFloat(String(document.getElementById("svcPrice").value).replace(",", "."));
      if (!name) {
        showMsg("Informe o nome do serviço.");
        return;
      }
      if (!durationMin || durationMin < 5) {
        showMsg("Duração mínima: 5 minutos.");
        return;
      }
      if (isNaN(priceVal) || priceVal < 0) {
        showMsg("Informe um preço válido.");
        return;
      }
      var payload = {
        name: name,
        durationMin: durationMin,
        priceCents: Math.round(priceVal * 100),
        active: true,
      };
      if (editId) payload.id = editId;
      var btn = document.getElementById("btnSvcSubmit");
      if (btn) btn.disabled = true;
      B()
        .saveService(salonId, me.id, payload)
        .then(function () {
          resetSvcForm();
          renderServices();
          showMsg(editId ? "Serviço atualizado." : "Serviço adicionado.", "ok");
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao salvar serviço. Tente novamente.");
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    };

    var editingProIsOwner = false;

    function updateProDeleteBtn() {
      var btn = document.getElementById("btnProDelete");
      if (!btn) return;
      var editId = document.getElementById("proEditId").value.trim();
      btn.classList.toggle("hidden", !editId || editingProIsOwner);
    }

    function deleteProfessionalById(proId, proName) {
      if (!proId) return;
      if (!confirm("Excluir o profissional \"" + (proName || "sem nome") + "\" permanentemente?")) return;
      B()
        .deleteProfessional(salonId, me.id, proId)
        .then(function () {
          resetProForm();
          renderPros();
          showMsg("Profissional excluído.", "ok");
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao excluir profissional.");
        });
    }

    var editingPro = null;

    function updateProAccessBox() {
      var box = document.getElementById("proAccessBox");
      var hasLogin = !!(editingPro && editingPro.authUid);
      if (box) box.classList.toggle("hidden", editingProIsOwner);
      setHidden("proShopPercentField", editingProIsOwner);
      setHidden("proAccessNew", hasLogin);
      setHidden("proAccessExisting", !hasLogin);
      var emailEl = document.getElementById("proAccessEmail");
      if (emailEl) emailEl.textContent = hasLogin ? editingPro.email || "" : "";
    }

    function resetProForm() {
      document.getElementById("formPro").reset();
      document.getElementById("proEditId").value = "";
      document.getElementById("proShopPercent").value = String(DEFAULT_SHOP_PERCENT);
      editingProIsOwner = false;
      editingPro = null;
      document.getElementById("btnProSubmit").textContent = "Adicionar profissional";
      document.getElementById("btnProCancel").classList.add("hidden");
      document.getElementById("proPhotoPreview").classList.add("hidden");
      var title = document.getElementById("proFormTitle");
      if (title) title.textContent = "Adicionar profissional";
      updateProDeleteBtn();
      updateProAccessBox();
    }

    var btnGenPass = document.getElementById("btnProGenPass");
    if (btnGenPass) {
      btnGenPass.onclick = function () {
        document.getElementById("proPassword").value = randomPassword();
      };
    }

    var btnResetPass = document.getElementById("btnProResetPass");
    if (btnResetPass) {
      btnResetPass.onclick = function () {
        if (!editingPro || !editingPro.email) return;
        if (!confirm("Enviar e-mail de redefinição de senha para " + editingPro.email + "?")) return;
        B()
          .sendPasswordReset(editingPro.email)
          .then(function () {
            showMsg("E-mail de redefinição enviado para " + editingPro.email + ".", "ok");
          })
          .catch(function (e) {
            showMsg(friendlyAuthError(e) || e.message || "Erro ao enviar e-mail.");
          });
      };
    }

    function showProCredentials(name, email, password) {
      var text =
        "Acesso ao painel — " +
        (salon.salonName || "Barbearia") +
        "\nProfissional: " +
        name +
        "\nLink: " +
        location.origin +
        "/index.html\nE-mail: " +
        email +
        "\nSenha: " +
        password;
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
      alert(text + "\n\n(Os dados foram copiados. Envie ao profissional.)");
    }

    function updateProPhotoPreview() {
      var url = document.getElementById("proPhoto").value.trim();
      var wrap = document.getElementById("proPhotoPreview");
      var img = document.getElementById("proPhotoImg");
      if (!url) {
        wrap.classList.add("hidden");
        return;
      }
      img.src = url;
      wrap.classList.remove("hidden");
    }

    var proPhotoInput = document.getElementById("proPhoto");
    if (proPhotoInput) proPhotoInput.oninput = updateProPhotoPreview;

    document.getElementById("btnProCancel").onclick = resetProForm;

    var btnProDelete = document.getElementById("btnProDelete");
    if (btnProDelete) {
      btnProDelete.onclick = function () {
        var editId = document.getElementById("proEditId").value.trim();
        var name = document.getElementById("proName").value.trim();
        if (editingProIsOwner) {
          showMsg("O dono da barbearia não pode ser excluído.");
          return;
        }
        deleteProfessionalById(editId, name);
      };
    }

    async function renderPros() {
      var box = document.getElementById("prosList");
      box.innerHTML = "";
      var list = await B().listAllProfessionals(salonId);
      if (!list.length) {
        box.innerHTML = '<p class="muted">Nenhum profissional cadastrado.</p>';
        return;
      }
      list.forEach(function (p) {
        var row = document.createElement("div");
        row.className = "appt-row";
        var left = document.createElement("div");
        left.className = "pro-row";
        left.appendChild(createProAvatarEl(p));
        var info = document.createElement("div");
        var accessBadge = "";
        if (p.isOwner) accessBadge = "";
        else if (p.active === false) accessBadge = ' <span class="badge badge-cancelled">Bloqueado</span>';
        else if (p.authUid) accessBadge = ' <span class="badge badge-confirmed">Login ativo</span>';
        else accessBadge = ' <span class="badge badge-warn">Sem login</span>';
        info.innerHTML =
          "<strong>" +
          (p.name || "Profissional") +
          "</strong>" +
          (p.isOwner ? ' <span class="muted">· barbeiro admin</span>' : "") +
          accessBadge +
          '<div class="appt-meta">' +
          [
            p.email || "",
            p.phone || "",
            p.isOwner ? "" : "Barbearia " + String(proShopPercent(p)).replace(".", ",") + "%",
          ]
            .filter(Boolean)
            .join(" · ") +
          "</div>";
        left.appendChild(info);
        row.appendChild(left);
        var actions = document.createElement("div");
        actions.className = "appt-actions";
        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "salon-btn-outline";
        edit.textContent = "Editar";
        edit.onclick = function () {
          editingProIsOwner = !!p.isOwner;
          editingPro = p;
          document.getElementById("proEditId").value = p.id;
          document.getElementById("proName").value = p.name || "";
          document.getElementById("proPhone").value = p.phone || "";
          document.getElementById("proShopPercent").value = String(proShopPercent(p));
          document.getElementById("proEmail").value = "";
          document.getElementById("proPassword").value = "";
          document.getElementById("proPhoto").value = p.photoUrl || "";
          document.getElementById("btnProSubmit").textContent = "Salvar perfil";
          document.getElementById("btnProCancel").classList.remove("hidden");
          var title = document.getElementById("proFormTitle");
          if (title) title.textContent = "Editar profissional";
          updateProDeleteBtn();
          updateProAccessBox();
          updateProPhotoPreview();
          document.getElementById("proName").focus();
          document.getElementById("formPro").scrollIntoView({ behavior: "smooth", block: "start" });
        };
        actions.appendChild(edit);
        if (p.isOwner) {
          var ownerNote = document.createElement("span");
          ownerNote.className = "muted";
          ownerNote.style.fontSize = "0.78rem";
          ownerNote.textContent = "Dono — não pode excluir";
          actions.appendChild(ownerNote);
        } else {
          var toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "salon-btn-ghost";
          toggle.textContent = p.active === false ? "Desbloquear" : "Bloquear";
          toggle.onclick = function () {
            var nextActive = p.active === false;
            if (
              !nextActive &&
              !confirm(
                "Bloquear " +
                  (p.name || "profissional") +
                  "? Ele não poderá entrar no painel nem receber novos agendamentos."
              )
            ) {
              return;
            }
            B()
              .setProfessionalAccess(salonId, me.id, p.id, nextActive)
              .then(function () {
                showMsg(nextActive ? "Profissional desbloqueado." : "Profissional bloqueado.", "ok");
                renderPros();
              })
              .catch(function (e) {
                showMsg(e.message || "Erro ao alterar acesso.");
              });
          };
          actions.appendChild(toggle);
          var remove = document.createElement("button");
          remove.type = "button";
          remove.className = "salon-btn-ghost btn-danger-ghost";
          remove.textContent = "Excluir";
          remove.onclick = function () {
            deleteProfessionalById(p.id, p.name);
          };
          actions.appendChild(remove);
        }
        row.appendChild(actions);
        box.appendChild(row);
      });
      refreshProDeskTabs();
    }

    document.getElementById("formPro").onsubmit = function (ev) {
      ev.preventDefault();
      var editId = document.getElementById("proEditId").value.trim();
      var name = document.getElementById("proName").value.trim();
      var phone = document.getElementById("proPhone").value.trim();
      var photoUrl = document.getElementById("proPhoto").value.trim();
      var email = document.getElementById("proEmail").value.trim();
      var password = document.getElementById("proPassword").value;
      if (!name) {
        showMsg("Informe o nome do profissional.");
        return;
      }
      var wantsLogin = !editingProIsOwner && !(editingPro && editingPro.authUid) && (email || password);
      if (wantsLogin) {
        if (!email) {
          showMsg("Informe o e-mail de login do profissional.");
          return;
        }
        if (!password || password.length < 6) {
          showMsg("A senha do profissional precisa ter pelo menos 6 caracteres.");
          return;
        }
      }
      var shopPct = parseFloat(String(document.getElementById("proShopPercent").value).replace(",", "."));
      if (!editingProIsOwner && (isNaN(shopPct) || shopPct < 0 || shopPct > 100)) {
        showMsg("Informe o desconto da barbearia entre 0% e 100%.");
        return;
      }
      var payload = {
        name: name,
        phone: phone,
        photoUrl: photoUrl,
        active: editingPro ? editingPro.active !== false : true,
      };
      if (!editingProIsOwner) payload.shopPercent = shopPct;
      if (editId) payload.id = editId;
      var submitBtn = document.getElementById("btnProSubmit");
      submitBtn.disabled = true;
      B()
        .saveProfessional(salonId, me.id, payload)
        .then(async function (proId) {
          var savedId = editId || proId;
          if (wantsLogin) {
            try {
              await B().createProfessionalLogin(salonId, me.id, savedId, {
                name: name,
                phone: phone,
                email: email,
                password: password,
              });
            } catch (e) {
              showMsg(
                "Profissional salvo, mas o login não foi criado: " +
                  (friendlyAuthError(e) || e.message || "erro desconhecido") +
                  " Edite o profissional e tente outro e-mail."
              );
              resetProForm();
              renderPros();
              return;
            }
            showProCredentials(name, email, password);
          }
          resetProForm();
          renderPros();
          renderBarberDashboard(salon);
          showMsg(
            wantsLogin
              ? "Profissional salvo com login criado."
              : editId
                ? "Perfil atualizado."
                : "Profissional adicionado.",
            "ok"
          );
        })
        .catch(function (e) {
          showMsg(e.message || "Erro ao salvar profissional.");
        })
        .finally(function () {
          submitBtn.disabled = false;
        });
    };

    async function renderBlocks() {
      var box = document.getElementById("blocksList");
      box.innerHTML = "";
      var pros = await B().listAllProfessionals(salonId);
      var sel = document.getElementById("blockPro");
      sel.innerHTML = '<option value="">Todos os profissionais</option>';
      pros.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        sel.appendChild(o);
      });
      var blocks = await B().listBlockedSlots(salonId);
      blocks.forEach(function (b) {
        var row = document.createElement("div");
        row.className = "appt-row";
        row.innerHTML =
          "<div><strong>" +
          (b.label || "Bloqueio") +
          "</strong><div class=\"appt-meta\">" +
          formatRange(b.startAt) +
          " → " +
          new Date(b.endAt).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit" }) +
          "</div></div>";
        var del = document.createElement("button");
        del.type = "button";
        del.className = "salon-btn-ghost";
        del.textContent = "Remover";
        del.onclick = function () {
          B()
            .removeBlockedSlot(salonId, me.id, b.id)
            .then(renderBlocks);
        };
        row.appendChild(del);
        box.appendChild(row);
      });
    }

    document.getElementById("formBlock").onsubmit = function (ev) {
      ev.preventDefault();
      var pid = document.getElementById("blockPro").value || null;
      B()
        .addBlockedSlot(salonId, me.id, {
          label: document.getElementById("blockLabel").value.trim(),
          startAt: new Date(document.getElementById("blockStart").value).toISOString(),
          endAt: new Date(document.getElementById("blockEnd").value).toISOString(),
          professionalId: pid,
        })
        .then(function () {
          document.getElementById("formBlock").reset();
          renderBlocks();
          showMsg("Horário bloqueado.", "ok");
        })
        .catch(function (e) {
          showMsg(e.message);
        });
    };

    function updateSettingsPhotosPreview() {
      var box = document.getElementById("setPhotosPreview");
      var ta = document.getElementById("setPhotos");
      if (!box || !ta) return;
      var urls = ta.value
        .split("\n")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      box.innerHTML = "";
      if (!urls.length) {
        box.classList.add("hidden");
        return;
      }
      urls.forEach(function (url) {
        var img = document.createElement("img");
        img.src = url;
        img.alt = "Foto da barbearia";
        img.className = "gallery-img";
        box.appendChild(img);
      });
      box.classList.remove("hidden");
    }

    var setPhotosInput = document.getElementById("setPhotos");
    if (setPhotosInput) setPhotosInput.oninput = updateSettingsPhotosPreview;

    function updateSettingsPreviews() {
      var logoUrl = document.getElementById("setLogo").value.trim();
      var coverUrl = document.getElementById("setCover").value.trim();
      var logoWrap = document.getElementById("setLogoPreview");
      var logoImg = document.getElementById("setLogoImg");
      var coverWrap = document.getElementById("setCoverPreview");
      var coverImg = document.getElementById("setCoverImg");
      if (logoWrap && logoImg) {
        if (logoUrl) {
          logoImg.src = logoUrl;
          logoWrap.classList.remove("hidden");
        } else {
          logoWrap.classList.add("hidden");
        }
      }
      if (coverWrap && coverImg) {
        if (coverUrl) {
          coverImg.src = coverUrl;
          coverWrap.classList.remove("hidden");
        } else {
          coverWrap.classList.add("hidden");
        }
      }
    }

    var setLogoInput = document.getElementById("setLogo");
    var setCoverInput = document.getElementById("setCover");
    if (setLogoInput) setLogoInput.oninput = updateSettingsPreviews;
    if (setCoverInput) setCoverInput.oninput = updateSettingsPreviews;

    function fillSettings() {
      salon = salon;
      document.getElementById("setName").value = salon.salonName || "";
      document.getElementById("setSlug").value = salon.slug || "";
      document.getElementById("setAccent").value = salon.accentHex || "";
      document.getElementById("setLogo").value = salon.logoUrl || "";
      document.getElementById("setCover").value = salon.coverUrl || "";
      document.getElementById("setPhotos").value = (salon.photoUrls || []).join("\n");
      document.getElementById("setAddress").value = salon.address || "";
      document.getElementById("setCity").value = salon.city || "";
      document.getElementById("setState").value = salon.state || "";
      document.getElementById("setPhone").value = salon.phone || "";
      document.getElementById("setPhone2").value = salon.phone2 || "";
      document.getElementById("setWhatsapp").value = salon.whatsapp || "";
      document.getElementById("setInstagram").value = salon.instagram || "";
      document.getElementById("setFacebook").value = salon.facebook || "";
      document.getElementById("setZip").value = salon.zipCode || "";
      fillPaymentOptionsForm(document.getElementById("setPaymentOptions"), salon.paymentMethods || "");
      document.getElementById("setHasWifi").checked = salon.hasWifi === true;
      document.getElementById("setWifiInfo").value = salon.wifiInfo || "";
      document.getElementById("setHasParking").checked = salon.hasParking === true;
      document.getElementById("setParkingInfo").value = salon.parkingInfo || "";
      document.getElementById("setHasKids").checked = salon.hasKidsHaircut === true;
      document.getElementById("setHasWheelchair").checked = salon.hasWheelchairAccess === true;
      buildWeeklyHoursForm(document.getElementById("weeklyHoursGrid"), salon.weeklyHours);
      updateSettingsPreviews();
      updateSettingsPhotosPreview();
    }

    document.getElementById("formSettings").onsubmit = async function (ev) {
      ev.preventDefault();
      var photos = document
        .getElementById("setPhotos")
        .value.split("\n")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      var patch = {
        salonName: document.getElementById("setName").value.trim(),
        slug: slugFromInput(document.getElementById("setSlug").value),
        accentHex: document.getElementById("setAccent").value.trim() || salon.accentHex,
        logoUrl: document.getElementById("setLogo").value.trim(),
        coverUrl: document.getElementById("setCover").value.trim(),
        photoUrls: photos,
        address: document.getElementById("setAddress").value.trim(),
        city: document.getElementById("setCity").value.trim(),
        state: document.getElementById("setState").value.trim(),
        zipCode: document.getElementById("setZip").value.trim(),
        phone: document.getElementById("setPhone").value.trim(),
        phone2: document.getElementById("setPhone2").value.trim(),
        whatsapp: C().normalizeWhatsAppPhone(document.getElementById("setWhatsapp").value.trim()),
        instagram: document.getElementById("setInstagram").value.trim(),
        facebook: document.getElementById("setFacebook").value.trim(),
        paymentMethods: readPaymentOptionsForm(document.getElementById("setPaymentOptions")),
        hasWifi: document.getElementById("setHasWifi").checked,
        wifiInfo: document.getElementById("setWifiInfo").value.trim(),
        hasParking: document.getElementById("setHasParking").checked,
        parkingInfo: document.getElementById("setParkingInfo").value.trim(),
        hasKidsHaircut: document.getElementById("setHasKids").checked,
        hasWheelchairAccess: document.getElementById("setHasWheelchair").checked,
        weeklyHours: readWeeklyHoursFromForm(document.getElementById("weeklyHoursGrid")),
        notifyBarberUid: me.id,
      };
      try {
        await B().saveSettings(salonId, me.id, patch);
        salon = await B().getSalonById(salonId);
        renderBarberDashboard(salon);
        var url = B().publicSalonUrl(salon.slug);
        document.getElementById("publicLink").value = url;
        document.getElementById("previewLink").href = url;
        showMsg("Informações salvas.", "ok");
      } catch (e) {
        showMsg(e.message || "Erro ao salvar.");
      }
    };

    fillSettings();
    await loadBarberServices();
    try {
      await B().syncMemberKeys(salonId, me.id);
    } catch (e) {}
    await refreshProDeskTabs();
    await renderBarber();
    await renderSummary();
    promptAppointmentSound();
    setInterval(function () {
      renderBarber();
      renderSummary();
    }, 12000);
  }

  async function initAdmin() {
    var loginBox = document.getElementById("adminLogin");
    var panel = document.getElementById("adminPanel");
    var logoutBtn = document.getElementById("btnAdminLogout");
    var submitBtn = document.getElementById("btnAdminSubmit");
    var loginForm = document.getElementById("formAdminLogin");
    var rows = [];
    var loggingIn = false;

    async function renderTable(filter) {
      var tbody = document.getElementById("adminTableBody");
      var empty = document.getElementById("adminEmpty");
      tbody.innerHTML = "";
      var q = (filter || "").trim().toLowerCase();
      var list = rows.filter(function (r) {
        if (!q) return true;
        return (
          (r.ownerId || "").toLowerCase().indexOf(q) >= 0 ||
          (r.email || "").toLowerCase().indexOf(q) >= 0 ||
          (r.name || "").toLowerCase().indexOf(q) >= 0 ||
          (r.salonName || "").toLowerCase().indexOf(q) >= 0 ||
          (r.slug || "").toLowerCase().indexOf(q) >= 0
        );
      });
      if (!list.length) {
        empty.classList.remove("hidden");
        return;
      }
      empty.classList.add("hidden");
      list.forEach(function (r) {
        var tr = document.createElement("tr");
        var status = "";
        if (r.accountBlocked) {
          status += '<span class="badge badge-cancelled">Login bloqueado</span> ';
        }
        status += r.subscriptionActive
          ? '<span class="badge badge-confirmed">Ativo</span>'
          : '<span class="badge badge-pending">Aguardando</span>';
        var link = r.slug ? "/b/" + r.slug : "—";
        tr.innerHTML =
          '<td class="mono" title="' +
          r.ownerId +
          '">' +
          (r.ownerId ? r.ownerId.slice(0, 10) + "…" : "—") +
          "</td>" +
          "<td>" +
          (r.email || "—") +
          "</td>" +
          "<td>" +
          (r.name || "—") +
          "</td>" +
          "<td>" +
          (r.salonName || "—") +
          "</td>" +
          "<td><code>" +
          link +
          "</code></td>" +
          "<td>" +
          status +
          "</td>" +
          '<td class="admin-actions"></td>';
        var actions = tr.querySelector(".admin-actions");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = r.subscriptionActive ? "salon-btn-ghost" : "salon-btn-primary";
        btn.textContent = r.subscriptionActive ? "Bloquear" : "Liberar";
        btn.onclick = function () {
          var next = !r.subscriptionActive;
          B()
            .adminSetSubscription(r.salonId, next)
            .then(function () {
              r.subscriptionActive = next;
              showMsg(next ? "Barbearia liberada." : "Barbearia bloqueada.", "ok");
              setTimeout(function () {
                showMsg("");
              }, 2000);
              renderTable(document.getElementById("adminSearch").value);
            })
            .catch(function (e) {
              showMsg(friendlyAuthError(e) || e.message || "Erro ao atualizar.");
            });
        };
        actions.appendChild(btn);

        var btnLogin = document.createElement("button");
        btnLogin.type = "button";
        btnLogin.className = "salon-btn-ghost";
        btnLogin.textContent = r.accountBlocked ? "Liberar login" : "Bloquear login";
        btnLogin.onclick = function () {
          var next = !r.accountBlocked;
          if (
            next &&
            !confirm(
              "Bloquear o login de " + (r.email || r.name || "este barbeiro") + "? Ele não conseguirá entrar no painel."
            )
          ) {
            return;
          }
          B()
            .adminSetOwnerBlocked(r.ownerId, next)
            .then(function () {
              r.accountBlocked = next;
              showMsg(next ? "Login do barbeiro bloqueado." : "Login do barbeiro liberado.", "ok");
              renderTable(document.getElementById("adminSearch").value);
            })
            .catch(function (e) {
              showMsg(friendlyAuthError(e) || e.message || "Erro ao bloquear login.");
            });
        };
        actions.appendChild(btnLogin);

        var btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "salon-btn-ghost";
        btnDel.style.color = "#fca5a5";
        btnDel.textContent = "Excluir";
        btnDel.onclick = function () {
          if (
            !confirm(
              "Excluir permanentemente a barbearia \"" +
                (r.salonName || r.slug) +
                "\"?\n\nIsso remove serviços, agendamentos e o link público. O login do barbeiro será bloqueado."
            )
          ) {
            return;
          }
          B()
            .adminDeleteSalon(r.salonId)
            .then(function () {
              rows = rows.filter(function (x) {
                return x.salonId !== r.salonId;
              });
              showMsg("Barbearia excluída do sistema.", "ok");
              renderTable(document.getElementById("adminSearch").value);
            })
            .catch(function (e) {
              showMsg(friendlyAuthError(e) || e.message || "Erro ao excluir.");
            });
        };
        actions.appendChild(btnDel);

        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "salon-btn-ghost";
        edit.textContent = "Editar";
        edit.onclick = function () {
          var nm = prompt("Nome do barbeiro:", r.name || "");
          if (nm === null) return;
          var em = prompt("E-mail:", r.email || "");
          if (em === null) return;
          B()
            .adminUpdateOwner(r.ownerId, { name: nm.trim(), email: em.trim() })
            .then(function () {
              r.name = nm.trim();
              r.email = em.trim();
              showMsg("Dados atualizados.", "ok");
              renderTable(document.getElementById("adminSearch").value);
            })
            .catch(function (e) {
              showMsg(e.message || "Erro ao salvar.");
            });
        };
        actions.appendChild(edit);
        tbody.appendChild(tr);
      });
    }

    async function showPanel() {
      showMsg("Carregando barbearias…", "ok");
      try {
        rows = await B().listSalonsForAdmin();
      } catch (e) {
        showMsg(friendlyAuthError(e) || e.message || "Erro ao carregar barbearias.");
        throw e;
      }
      loginBox.classList.add("hidden");
      panel.classList.remove("hidden");
      logoutBtn.classList.remove("hidden");
      showMsg("");
      await renderTable();
    }

    if (loginForm) {
      loginForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        if (loggingIn) return;
        var email = document.getElementById("admEmail").value.trim();
        var pass = document.getElementById("admPass").value;
        if (!email || !pass) {
          showMsg("Preencha e-mail e senha.");
          return;
        }
        loggingIn = true;
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = "Entrando…";
        }
        showMsg("Verificando login…", "ok");
        B()
          .loginAdmin(email, pass)
          .then(showPanel)
          .catch(function (e) {
            console.error("Admin login:", e);
            showMsg(friendlyAuthError(e) || (e && e.message) || "Não foi possível entrar.");
          })
          .finally(function () {
            loggingIn = false;
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = "Entrar";
            }
          });
      });
    }

    var adminSearch = document.getElementById("adminSearch");
    if (adminSearch) {
      adminSearch.oninput = function () {
        renderTable(this.value);
      };
    }

    if (logoutBtn) {
      logoutBtn.onclick = function () {
        B()
          .logout()
          .then(function () {
            location.reload();
          });
      };
    }

    try {
      await B().waitForAuth();
      if (await B().isAdmin()) await showPanel();
    } catch (e) {
      console.error("Admin init:", e);
      showMsg(friendlyAuthError(e) || (e && e.message) || "Erro ao iniciar o painel admin.");
    }
  }

  var page = typeof window.SALAO_PAGE === "string" ? window.SALAO_PAGE : "";

  B()
    .init()
    .then(function () {
      if (page === "home") return initHome();
      else if (page === "app") return initApp();
      else if (page === "public") return initPublic();
      else if (page === "barbeiro") return initBarbeiro();
      else if (page === "admin") return initAdmin();
      else if (page === "cliente") {
        var slug = B().getCtxSlug() || "demo";
        location.replace("b/" + slug);
      }
    })
    .catch(function (e) {
      console.error(e);
      if (page !== "home") showMsg("Erro ao iniciar: " + (e.message || String(e)));
    });
})();
