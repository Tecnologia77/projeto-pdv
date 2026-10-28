/**
 * Fotos já cadastradas continuam no ImgBB. O servidor às vezes responde
 * com o aviso azul "service unavailable" (HTTP 503 com um PNG de 180×180).
 * O navegador desenha esse PNG como se a foto tivesse carregado, então o
 * onerror não dispara. Este script baixa a imagem de novo e só troca o
 * src quando os bytes são a foto de verdade.
 */
(function (root) {
  var PLACEHOLDER_BYTES = 1115;
  var PLACEHOLDER_SHA256 = "3924575580e7b987e65ce7de63a3a51655e9c2abaafdf76d204174d1992c8a04";
  var ROUNDS = [0, 700, 1600, 3200, 5600, 9000];
  var MAX_PARALLEL = 4;
  var tasks = [];
  var active = 0;

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

  function candidateUrls(src) {
    var clean = cleanUrl(src).split("#")[0];
    var queryAt = clean.indexOf("?");
    var base = queryAt >= 0 ? clean.slice(0, queryAt) : clean;
    var query = queryAt >= 0 ? clean.slice(queryAt) : "";
    var match = base.match(/^(.*)\.([a-z0-9]+)$/i);
    var urls = [base + query];
    if (match) {
      ["jpg", "png", "webp", "jpeg"].forEach(function (ext) {
        if (ext.toLowerCase() !== match[2].toLowerCase()) urls.push(match[1] + "." + ext + query);
      });
    }
    var seen = Object.create(null);
    return urls.filter(function (url) {
      if (seen[url]) return false;
      seen[url] = true;
      return true;
    });
  }

  function bytesOf(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    return new Uint8Array(buffer || new ArrayBuffer(0));
  }

  function sha256Hex(bytes) {
    if (typeof require === "function") {
      try {
        return require("crypto").createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      } catch (err) {
        return "";
      }
    }
    return "";
  }

  function isPlaceholderBuffer(buffer) {
    var bytes = bytesOf(buffer);
    if (bytes.byteLength !== PLACEHOLDER_BYTES) return Promise.resolve(false);
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      return Promise.resolve(false);
    }
    var sync = sha256Hex(bytes);
    if (sync) return Promise.resolve(sync === PLACEHOLDER_SHA256);
    if (root.crypto && root.crypto.subtle) {
      var copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return root.crypto.subtle.digest("SHA-256", copy).then(function (digest) {
        var hex = Array.prototype.map.call(new Uint8Array(digest), function (part) {
          return part.toString(16).padStart(2, "0");
        }).join("");
        return hex === PLACEHOLDER_SHA256;
      }).catch(function () {
        return true;
      });
    }
    return Promise.resolve(true);
  }

  function sniffType(buffer, headerType) {
    var type = String(headerType || "").split(";")[0].trim().toLowerCase();
    if (type.indexOf("image/") === 0 && type.indexOf("svg") < 0) return type;
    var bytes = bytesOf(buffer);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
    return "";
  }

  function pooled(work) {
    return new Promise(function (resolve) {
      tasks.push(function () {
        return Promise.resolve().then(work).then(resolve, function () { resolve(null); });
      });
      drain();
    });
  }

  function drain() {
    while (active < MAX_PARALLEL && tasks.length) {
      var job = tasks.shift();
      active += 1;
      job().then(function () {
        active -= 1;
        drain();
      });
    }
  }

  function loadCandidate(url) {
    if (typeof fetch !== "function") return Promise.resolve(null);
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 7000);
    var join = url.indexOf("?") >= 0 ? "&" : "?";
    return fetch(url + join + "pdv=" + Date.now(), {
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (!res.ok) return null;
      var headerType = res.headers.get("content-type") || "";
      return res.arrayBuffer().then(function (buf) {
        return isPlaceholderBuffer(buf).then(function (placeholder) {
          if (placeholder || !buf || buf.byteLength < 64) return null;
          var type = sniffType(buf, headerType);
          if (!type) return null;
          return new Blob([buf], { type: type });
        });
      });
    }).catch(function () {
      return null;
    }).then(function (blob) {
      clearTimeout(timer);
      return blob;
    });
  }

  function firstGood(urls) {
    if (!urls.length) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var left = urls.length;
      var settled = false;
      urls.forEach(function (url) {
        pooled(function () { return loadCandidate(url); }).then(function (blob) {
          if (blob && !settled) {
            settled = true;
            resolve(blob);
          }
          left -= 1;
          if (!left && !settled) resolve(null);
        });
      });
    });
  }

  function still(img, token) {
    return img && img.isConnected !== false && img.getAttribute("data-pdv-token") === token && img.getAttribute("data-pdv-state") === "pending";
  }

  function showImage(img) {
    if (img.getAttribute("data-pdv-hidden") === "1") {
      img.style.visibility = "";
      img.removeAttribute("data-pdv-hidden");
    }
  }

  function applyBlob(img, token, blob) {
    if (!still(img, token)) return;
    var previous = img.getAttribute("data-pdv-blob");
    var objectUrl = URL.createObjectURL(blob);
    img.setAttribute("data-pdv-blob", objectUrl);
    img.setAttribute("data-pdv-state", "ok");
    showImage(img);
    img.src = objectUrl;
    if (previous) URL.revokeObjectURL(previous);
  }

  function giveUp(img, token) {
    if (!still(img, token)) return;
    img.setAttribute("data-pdv-state", "failed");
    showImage(img);
  }

  function runRound(img, clean, token, round) {
    if (!still(img, token)) return;
    if (round >= ROUNDS.length) {
      giveUp(img, token);
      return;
    }
    setTimeout(function () {
      if (!still(img, token)) return;
      firstGood(candidateUrls(clean)).then(function (blob) {
        if (!still(img, token)) return;
        if (blob) applyBlob(img, token, blob);
        else runRound(img, clean, token, round + 1);
      });
    }, ROUNDS[round]);
  }

  function scheduleRestore(img, clean) {
    if (!img || !isImgbb(clean)) return false;
    if (img.getAttribute("data-pdv-state") === "pending" && img.getAttribute("data-pdv-src") === clean) return true;
    if (img.getAttribute("data-pdv-state") === "ok" && img.getAttribute("data-pdv-src") === clean) return false;
    var token = Date.now().toString(36) + Math.random().toString(36).slice(2);
    img.setAttribute("data-pdv-token", token);
    img.setAttribute("data-pdv-src", clean);
    img.setAttribute("data-pdv-state", "pending");
    if (img.naturalWidth === 180 && img.naturalHeight === 180) {
      img.style.visibility = "hidden";
      img.setAttribute("data-pdv-hidden", "1");
    }
    runRound(img, clean, token, 0);
    return true;
  }

  function inspect(img) {
    if (!img || img.tagName !== "IMG") return;
    var src = img.currentSrc || img.getAttribute("src") || "";
    if (!src || src.indexOf("blob:") === 0) return;
    if (!isImgbb(src)) return;
    var clean = cleanUrl(src);
    if (img.getAttribute("data-pdv-src") && img.getAttribute("data-pdv-src") !== clean) {
      img.setAttribute("data-pdv-state", "");
    }
    if (img.naturalWidth === 180 && img.naturalHeight === 180) {
      scheduleRestore(img, clean);
      return;
    }
    if (img.naturalWidth > 0 && img.getAttribute("data-pdv-state") !== "pending") {
      img.setAttribute("data-pdv-state", "ok");
      img.setAttribute("data-pdv-src", clean);
    }
  }

  function install() {
    if (!root || !root.document || root.__pdvPhotoRestore) return;
    root.__pdvPhotoRestore = true;
    var document = root.document;

    document.addEventListener("error", function (event) {
      var img = event.target;
      if (!img || img.tagName !== "IMG") return;
      var src = img.currentSrc || img.getAttribute("src") || "";
      if (!isImgbb(src)) return;
      if (scheduleRestore(img, cleanUrl(src))) event.stopImmediatePropagation();
    }, true);

    document.addEventListener("load", function (event) {
      var img = event.target;
      if (!img || img.tagName !== "IMG") return;
      inspect(img);
    }, true);

    function scan(node) {
      if (!node || !node.querySelectorAll) return;
      if (node.tagName === "IMG") inspect(node);
      var images = node.querySelectorAll("img");
      for (var i = 0; i < images.length; i += 1) inspect(images[i]);
    }

    function watch() {
      scan(document);
      if (typeof MutationObserver !== "function") return;
      var observer = new MutationObserver(function (records) {
        records.forEach(function (record) {
          if (record.type === "attributes") inspect(record.target);
          for (var i = 0; i < record.addedNodes.length; i += 1) scan(record.addedNodes[i]);
        });
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"]
      });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", watch, { once: true });
    } else {
      watch();
    }
  }

  var api = {
    isImgbb: isImgbb,
    cleanUrl: cleanUrl,
    candidateUrls: candidateUrls,
    isPlaceholderBuffer: isPlaceholderBuffer,
    install: install
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.document) install();
})(typeof window !== "undefined" ? window : globalThis);
