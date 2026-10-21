/**
 * QZ Tray — certificado + assinatura (impressão silenciosa).
 * Arquivos na raiz do site: /qz-certificate.txt e /qz-private-key.pem
 */
(function () {
  "use strict";

  let qzSecurityConfigured = false;
  let cachedCertificate = "";
  let cachedPrivateKey = "";
  let _loadingAssets = null;
  let _securitySetupPromise = null;

  function qzHexToRstr(hex) {
    if (typeof hextorstr === "function") return hextorstr(hex);
    let str = "";
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str;
  }

  function qzStob64(str) {
    if (typeof stob64 === "function") return stob64(str);
    return btoa(str);
  }

  async function loadQzSecurityAssets(force = false) {
    if (!force && cachedCertificate && cachedPrivateKey) return;
    if (_loadingAssets && !force) return _loadingAssets;

    _loadingAssets = (async () => {
      if (force) {
        cachedCertificate = "";
        cachedPrivateKey = "";
      }
      try {
        const [certRes, keyRes] = await Promise.all([
          fetch("/qz-certificate.txt", { cache: "no-store" }),
          fetch("/qz-private-key.pem", { cache: "no-store" })
        ]);
        if (certRes.ok) cachedCertificate = (await certRes.text()).trim();
        if (keyRes.ok) cachedPrivateKey = (await keyRes.text()).trim();
      } catch (err) {
        console.warn("QZ certificado/chave:", err);
      }
    })();

    try {
      await _loadingAssets;
    } finally {
      _loadingAssets = null;
    }
  }

  function isDemoCertificate(cert) {
    return /QZ Tray Demo Cert|Demo Cert/i.test(String(cert || ""));
  }

  function configureQzSigning() {
    if (typeof qz === "undefined") return;

    qz.security.setSignatureAlgorithm("SHA512");

    qz.security.setCertificatePromise((resolve, reject) => {
      if (cachedCertificate) resolve(cachedCertificate);
      else reject("Certificado QZ não carregado");
    });

    qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
      try {
        if (!cachedPrivateKey || typeof KJUR === "undefined") {
          reject(new Error("Chave privada QZ indisponível"));
          return;
        }
        const pk = KEYUTIL.getKey(cachedPrivateKey);
        const sig = new KJUR.crypto.Signature({ alg: "SHA512withRSA" });
        sig.init(pk);
        sig.updateString(toSign);
        const hex = sig.sign();
        resolve(qzStob64(qzHexToRstr(hex)));
      } catch (err) {
        reject(err);
      }
    });

    qzSecurityConfigured = true;
  }

  async function setupQZSecurity(forceReload = false) {
    if (typeof qz === "undefined") {
      window.__qzSecurityReady = false;
      return false;
    }

    if (forceReload) {
      qzSecurityConfigured = false;
      window.__qzSecurityReady = false;
    }

    if (qzSecurityConfigured && window.__qzSecurityReady && !forceReload) {
      return true;
    }

    await loadQzSecurityAssets(forceReload);

    const hasCert = cachedCertificate.length > 20
      && cachedCertificate.includes("BEGIN CERTIFICATE")
      && !cachedCertificate.includes("COLE_SEU_CERTIFICADO");
    const hasKey = cachedPrivateKey.includes("PRIVATE KEY") && typeof KJUR !== "undefined";

    if (!hasCert || !hasKey) {
      window.__qzSecurityReady = false;
      if (!qzSecurityConfigured) {
        console.info(
          "QZ Tray: certificado/chave não encontrados. " +
          "Publique qz-certificate.txt e qz-private-key.pem ou autorize no popup do QZ."
        );
      }
      return false;
    }

    configureQzSigning();

    window.__qzSecurityReady = true;
    window.__qzUsingDemoCert = isDemoCertificate(cachedCertificate);
    if (window.__qzUsingDemoCert) {
      console.info("QZ Tray: certificado DEMO — autorize no popup sem marcar Remember, ou adicione o site no Site Manager.");
    } else {
      console.info("QZ Tray: certificado e assinatura OK — impressão silenciosa ativa.");
    }
    return true;
  }

  function waitForQzSecurity(forceReload = false) {
    if (forceReload) _securitySetupPromise = null;
    if (!_securitySetupPromise) {
      _securitySetupPromise = setupQZSecurity(forceReload).catch((err) => {
        _securitySetupPromise = null;
        throw err;
      });
    }
    return _securitySetupPromise;
  }

  window.setupQZSecurity = setupQZSecurity;
  window.waitForQzSecurity = waitForQzSecurity;
  window.isQzSecurityReady = () => !!window.__qzSecurityReady;
  window.isQzDemoCertificate = () => !!window.__qzUsingDemoCert;
  window.getQzSiteUrl = () => String(window.location.origin || "").replace(/\/$/, "");
  window.getQzAllowHelpText = () => {
    const site = window.getQzSiteUrl();
    if (window.__qzUsingDemoCert) {
      return `Popup QZ: NÃO marque Remember — clique Allow. Neste PC: QZ Tray → Advanced → Site Manager → Import → use o certificado baixado do site (botão abaixo). Não crie certificado novo (+ Create New). Site: ${site}`;
    }
    return `Se aparecer popup do QZ Tray, clique Allow. Site: ${site}`;
  };
  window.ensureQzSecurityReady = async () => waitForQzSecurity(true);

  window.downloadQzCertificateForImport = async () => {
    await loadQzSecurityAssets(false);
    if (!cachedCertificate || !cachedCertificate.includes("BEGIN CERTIFICATE")) {
      throw new Error("Certificado não encontrado no site.");
    }
    const blob = new Blob([cachedCertificate], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "digital-certificate.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  window.downloadQzOverrideForPc = async () => {
    await loadQzSecurityAssets(false);
    if (!cachedCertificate || !cachedCertificate.includes("BEGIN CERTIFICATE")) {
      throw new Error("Certificado não encontrado no site.");
    }
    const blob = new Blob([cachedCertificate], { type: "application/x-x509-ca-cert" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "override.crt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (typeof qz !== "undefined") {
    waitForQzSecurity(false).catch(() => {});
  }
})();
