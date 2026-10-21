/**
 * Ícone fixo STOCK PDV + botão instalar aplicativo (PWA).
 */
(function () {
  const APP_NAME = "STOCK PDV";
  let deferredInstallPrompt = null;

  function isPwaInstalled() {
    return (
      window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: fullscreen)").matches
      || window.navigator.standalone === true
    );
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent);
  }

  function getInstallStepsHtml() {
    if (isIos()) {
      return [
        "Abra este site no <strong>Safari</strong>.",
        "Toque em <strong>Compartilhar</strong> (ícone com seta).",
        "Escolha <strong>Adicionar à Tela de Início</strong>.",
        "Confirme — o ícone STOCK PDV aparecerá na tela inicial."
      ];
    }
    if (isAndroid()) {
      return [
        "No <strong>Chrome</strong>, toque no menu <strong>⋮</strong>.",
        "Selecione <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>.",
        "Confirme a instalação."
      ];
    }
    const isEdge = /Edg\//.test(navigator.userAgent);
    if (isEdge) {
      return [
        "Clique no menu <strong>⋯</strong> (três pontos) no canto superior direito.",
        "Vá em <strong>Aplicativos</strong> → <strong>Instalar STOCK PDV</strong>.",
        "Ou clique no ícone <strong>⊕ Instalar</strong> na barra de endereço.",
        "Confirme — o atalho será criado na área de trabalho."
      ];
    }
    return [
      "No <strong>Chrome</strong>, clique no menu <strong>⋮</strong>.",
      "Escolha <strong>Salvar e compartilhar</strong> → <strong>Instalar STOCK PDV</strong>.",
      "Ou use o ícone <strong>⊕</strong> na barra de endereço.",
      "Não use apenas «Criar atalho» — use <strong>Instalar aplicativo</strong>."
    ];
  }

  function showInstallHelpModal() {
    const modal = document.getElementById("pwaInstallModal");
    const list = document.getElementById("pwaInstallModalSteps");
    const hint = document.getElementById("pwaInstallModalHint");
    if (!modal || !list) return;
    if (hint) {
      hint.textContent = deferredInstallPrompt
        ? "Se o botão não abrir o instalador, siga os passos abaixo:"
        : "Seu navegador ainda não liberou a instalação automática. Siga os passos:";
    }
    list.innerHTML = getInstallStepsHtml().map((step) => `<li>${step}</li>`).join("");
    modal.classList.remove("hidden");
  }

  function hideInstallHelpModal() {
    document.getElementById("pwaInstallModal")?.classList.add("hidden");
  }

  window.updatePwaInstallButton = function updatePwaInstallButton() {
    const wrap = document.getElementById("pwaInstallWrap");
    const btn = document.getElementById("btnInstallPwa");
    if (!wrap || !btn) return;

    const appShell = document.getElementById("appShell");
    const loggedIn = appShell && !appShell.classList.contains("hidden");

    if (!loggedIn || isPwaInstalled()) {
      wrap.classList.add("hidden");
      return;
    }

    wrap.classList.remove("hidden");
    const canPrompt = Boolean(deferredInstallPrompt);
    btn.classList.toggle("btn-install-pwa--ready", canPrompt);
    btn.title = canPrompt
      ? "Instalar STOCK PDV na área de trabalho"
      : "Ver como instalar o STOCK PDV";
  };

  async function triggerPwaInstall() {
    if (isPwaInstalled()) {
      alert("O STOCK PDV já está instalado como aplicativo.");
      return;
    }
    if (!deferredInstallPrompt) {
      showInstallHelpModal();
      return;
    }
    try {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      window.updatePwaInstallButton();
      if (choice.outcome === "dismissed") {
        showInstallHelpModal();
      }
    } catch (err) {
      console.warn("Instalação PWA:", err);
      showInstallHelpModal();
    }
  }

  function setupPwaInstallUi() {
    document.getElementById("btnInstallPwa")?.addEventListener("click", triggerPwaInstall);
    document.getElementById("btnClosePwaInstallModal")?.addEventListener("click", hideInstallHelpModal);
    document.getElementById("pwaInstallModal")?.addEventListener("click", (e) => {
      if (e.target.id === "pwaInstallModal") hideInstallHelpModal();
    });

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      window.updatePwaInstallButton();
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      window.updatePwaInstallButton();
      hideInstallHelpModal();
    });

    window.addEventListener("resize", window.updatePwaInstallButton);
  }

  window.applyWebAppBranding = function applyWebAppBranding(company) {
    const c = company || {};
    const pageTitle = String(c.name || "").trim();
    const isDelivery = (document.documentElement.dataset.pwaManifest || "").includes("delivery");
    if (pageTitle) {
      document.title = isDelivery ? `${pageTitle} — Pedido online` : `${pageTitle} — PDV`;
    } else {
      document.title = isDelivery ? "Pedido online" : APP_NAME;
    }
    window.updatePwaInstallButton();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupPwaInstallUi();
      window.updatePwaInstallButton();
    });
  } else {
    setupPwaInstallUi();
    window.updatePwaInstallButton();
  }

  window.applyWebAppBranding({});

  // ── Verificação de nova versão ───────────────────────────────
  const VERSION_CHECK_MS = 5 * 60 * 1000;
  let latestRemoteVersion = null;

  function getRunningAppVersion() {
    const appScript = document.querySelector('script[src*="app.js"]');
    const fromScript = appScript?.src?.match(/[?&]v=([^&]+)/)?.[1]?.trim();
    if (fromScript) return fromScript;
    return document.querySelector('meta[name="app-build"]')?.content?.trim() || "";
  }

  function getUpdateDismissKey(version) {
    return `stock_pdv_update_dismiss_${version}`;
  }

  async function fetchRemoteAppVersion() {
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.version) return null;
      return {
        version: String(data.version),
        label: data.label ? String(data.label) : String(data.version)
      };
    } catch (err) {
      console.warn("Verificação de versão:", err);
      return null;
    }
  }

  function showAppUpdateBanner(remoteVersion, label) {
    const banner = document.getElementById("appUpdateBanner");
    const text = document.getElementById("appUpdateBannerText");
    if (!banner) return;
    if (sessionStorage.getItem(getUpdateDismissKey(remoteVersion))) return;
    if (text && label) {
      text.textContent = `Versão ${label} disponível. Atualize para usar os recursos mais recentes.`;
    }
    banner.classList.remove("hidden");
    document.body.classList.add("has-app-update-banner");
  }

  function hideAppUpdateBanner() {
    document.getElementById("appUpdateBanner")?.classList.add("hidden");
    document.body.classList.remove("has-app-update-banner");
  }

  async function checkForAppUpdate() {
    const remote = await fetchRemoteAppVersion();
    if (!remote) return;
    latestRemoteVersion = remote.version;
    const running = getRunningAppVersion();
    if (!running) return;
    if (remote.version === running) {
      hideAppUpdateBanner();
      try {
        localStorage.setItem("stock_pdv_app_version_ok", remote.version);
      } catch { /* ignora */ }
      return;
    }
    showAppUpdateBanner(remote.version, remote.label);
  }

  async function applyAppUpdate() {
    hideAppUpdateBanner();
    if (latestRemoteVersion) {
      sessionStorage.removeItem(getUpdateDismissKey(latestRemoteVersion));
      try {
        localStorage.setItem("stock_pdv_app_version_ok", latestRemoteVersion);
      } catch { /* ignora */ }
    }
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch (err) {
      console.warn("Limpeza de cache:", err);
    }
    const url = new URL(window.location.href);
    url.searchParams.set("_v", Date.now());
    window.location.replace(url.toString());
  }

  function dismissAppUpdateLater() {
    if (latestRemoteVersion) {
      sessionStorage.setItem(getUpdateDismissKey(latestRemoteVersion), "1");
    }
    hideAppUpdateBanner();
  }

  function setupAppUpdateCheck() {
    document.getElementById("btnAppUpdateNow")?.addEventListener("click", applyAppUpdate);
    document.getElementById("btnAppUpdateLater")?.addEventListener("click", dismissAppUpdateLater);
    checkForAppUpdate();
    setInterval(checkForAppUpdate, VERSION_CHECK_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForAppUpdate();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupAppUpdateCheck);
  } else {
    setupAppUpdateCheck();
  }
})();
