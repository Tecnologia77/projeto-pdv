/**
 * Fotos já cadastradas continuam no ImgBB. O servidor às vezes responde
 * primeiro com o aviso azul "service unavailable" e, na tentativa seguinte,
 * devolve a imagem original. Este script pede de novo sem apagar o cadastro.
 */
(function () {
  if (window.__pdvPhotoRestore) return;
  window.__pdvPhotoRestore = true;

  var MAX_TRIES = 5;

  function isImgbb(src) {
    return /i\.ibb\.co|imgbb\.com/i.test(String(src || ""));
  }

  function cleanUrl(src) {
    var value = String(src || "");
    var hash = "";
    var hashAt = value.indexOf("#");
    if (hashAt >= 0) {
      hash = value.slice(hashAt);
      value = value.slice(0, hashAt);
    }
    value = value.replace(/([?&])pdv=\d+/g, "$1").replace(/[?&]$/, "").replace(/\?&/, "?");
    return value + hash;
  }

  function retry(img) {
    var src = img.currentSrc || img.getAttribute("src") || "";
    if (!isImgbb(src)) return false;
    var tries = Number(img.getAttribute("data-pdv-retry") || "0");
    if (tries >= MAX_TRIES) return false;
    var clean = img.getAttribute("data-pdv-src") || cleanUrl(src);
    img.setAttribute("data-pdv-src", clean);
    img.setAttribute("data-pdv-retry", String(tries + 1));
    window.setTimeout(function () {
      var join = clean.indexOf("?") >= 0 ? "&" : "?";
      img.src = clean + join + "pdv=" + Date.now();
    }, 400 + tries * 700);
    return true;
  }

  document.addEventListener("error", function (event) {
    var img = event.target;
    if (!img || img.tagName !== "IMG") return;
    if (retry(img)) event.stopImmediatePropagation();
  }, true);

  document.addEventListener("load", function (event) {
    var img = event.target;
    if (!img || img.tagName !== "IMG") return;
    if (!isImgbb(img.currentSrc || img.src)) return;
    if (img.naturalWidth === 180 && img.naturalHeight === 180 && retry(img)) {
      event.stopImmediatePropagation();
    }
  }, true);
})();
