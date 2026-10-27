/**
 * STOCK PDV — Inteligência Artificial + hospedagem de imagens
 * Chaves centralizadas em firebase-config.js (rede inteira) ou Empresa (admin, 1x).
 */
(function () {
  "use strict";

  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
  const ACCEPTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"];
  // PNG azul de 180×180 que o ImgBB devolve no lugar da foto (HTTP 503 ou 200).
  const IMGBB_PLACEHOLDER_BYTES = 1115;
  const IMGBB_PLACEHOLDER_SHA256 = "3924575580e7b987e65ce7de63a3a51655e9c2abaafdf76d204174d1992c8a04";
  let pendingImageFile = null;
  let lastImageUrl = "";
  let uploadInProgress = false;

  function pdv() {
    return window.PDV || {};
  }

  function getSelectedProduct() {
    const id = document.getElementById("aiProductSelect")?.value;
    if (!id) return null;
    return (pdv().getProducts?.() || []).find((p) => p.id === id) || null;
  }

  function setAiStatus(msg, type = "") {
    const el = document.getElementById("aiStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "ai-status" + (type ? ` ai-status--${type}` : "");
  }

  function setProductPhotoStatus(msg, type = "") {
    const el = document.getElementById("productPhotoStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "product-photo-status" + (type ? ` product-photo-status--${type}` : "");
  }

  function setAiLoading(loading) {
    document.querySelectorAll(".ai-action-btn, #aiCopyImageLink, #aiUseImageLink").forEach((btn) => {
      btn.disabled = loading;
    });
    const zone = document.getElementById("aiImageDropzone");
    if (zone) zone.classList.toggle("ai-dropzone--loading", loading);
    const productZone = document.getElementById("productPhotoZone");
    if (productZone) productZone.classList.toggle("product-photo-zone--loading", loading);
  }

  function getGeminiApiKey() {
    return String(window.GEMINI_API_KEY || pdv().getCompany?.()?.geminiApiKey || "").trim();
  }

  function getImgBBKey() {
    return String(window.IMGBB_API_KEY || pdv().getCompany?.()?.imgbbApiKey || "").trim();
  }

  function hasImageUploadConfigured() {
    return Boolean(getImgBBKey() || pdv().getStorage?.());
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve(result.includes(",") ? result.split(",")[1] : result);
      };
      reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
      reader.readAsDataURL(file);
    });
  }

  async function uploadViaFirebaseStorage(file, uid) {
    const storage = pdv().getStorage?.();
    if (!storage) throw new Error("Firebase Storage não disponível.");
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `stores/${uid}/products/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const ref = storage.ref().child(path);
    const snap = await ref.put(file, { contentType: file.type });
    return snap.ref.getDownloadURL();
  }

  function imageBaseName(file) {
    const base = String(file?.name || "produto").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 40);
    if (!base || /^(shopping|image|img)$/i.test(base)) return "produto";
    return base;
  }

  function shouldTranscodeToJpeg(file) {
    const type = String(file?.type || "").toLowerCase();
    const name = String(file?.name || "").toLowerCase();
    if (type === "image/jpeg" || type === "image/jpg" || type === "image/png") return false;
    if (type === "image/webp" || type === "image/gif") return true;
    return /\.(webp|gif)$/.test(name);
  }

  function extractImageUrlFromHtml(html) {
    const match = String(html || "").match(/<img[^>]+src=["']([^"']+)["']/i);
    const src = match?.[1] || "";
    if (/^https?:\/\//i.test(src) || src.startsWith("data:image/")) return src;
    return "";
  }

  function extractHttpUrl(text) {
    const line = String(text || "")
      .split(/\s+/)
      .map((part) => part.trim())
      .find((part) => /^https?:\/\//i.test(part) && !/^https?:\/\/www\.google\./i.test(part));
    return line || "";
  }

  function imgbbCandidateUrls(payload) {
    const data = payload?.data || payload || {};
    const direct = [data.display_url, data.image?.url, data.medium?.url, data.url, data.thumb?.url]
      .map((url) => String(url || "").trim())
      .filter((url) => /^https?:\/\//i.test(url));
    const swapped = [];
    direct.forEach((url) => {
      if (/\.webp(\?.*)?$/i.test(url)) {
        swapped.push(url.replace(/\.webp(\?.*)?$/i, ".jpg"));
        swapped.push(url.replace(/\.webp(\?.*)?$/i, ".jpeg"));
        swapped.push(url.replace(/\.webp(\?.*)?$/i, ".png"));
      }
    });
    return [...new Set([...direct, ...swapped])];
  }

  async function isImgbbPlaceholderBuffer(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer || []);
    if (bytes.byteLength !== IMGBB_PLACEHOLDER_BYTES) return false;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === IMGBB_PLACEHOLDER_SHA256;
  }

  async function hostedImageIsUsable(url, { allowUnreachable = false } = {}) {
    try {
      const res = await fetch(url, { cache: "no-store", mode: "cors" });
      if (!res.ok) return false;
      const type = String(res.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("image/")) return false;
      const buf = await res.arrayBuffer();
      if (await isImgbbPlaceholderBuffer(buf)) return false;
      return buf.byteLength >= 64;
    } catch (_) {
      return allowUnreachable;
    }
  }

  async function imgbbUrlLooksBroken(url) {
    try {
      const res = await fetch(url, { cache: "no-store", mode: "cors" });
      if (res.status === 503) return true;
      if (!res.ok) return false;
      const buf = await res.arrayBuffer();
      return isImgbbPlaceholderBuffer(buf);
    } catch (_) {
      return false;
    }
  }

  async function firstUsableHostedUrl(urls) {
    for (const url of urls) {
      if (await hostedImageIsUsable(url)) return url;
    }
    return "";
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function uploadViaImgBB(file) {
    const key = getImgBBKey();
    if (!key) throw new Error("IMG_BB_NOT_CONFIGURED");
    const base64 = await fileToBase64(file);
    const body = new URLSearchParams();
    body.append("key", key);
    body.append("image", base64);
    body.append("name", imageBaseName(file));
    const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    const urls = imgbbCandidateUrls(data);
    if (!data?.success || !urls.length) {
      const msg = data?.error?.message || data?.error?.context || `Erro ao hospedar (${res.status})`;
      throw new Error(msg);
    }
    return urls;
  }

  async function verifiedImgbbUrl(file) {
    let lastUrls = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastUrls = await uploadViaImgBB(file);
      const delays = [0, 700, 1600];
      for (const delay of delays) {
        if (delay) await sleep(delay);
        const url = await firstUsableHostedUrl(lastUrls);
        if (url) return url;
      }
    }
    return "";
  }

  async function uploadImageFile(file) {
    const user = pdv().getUser?.();
    if (!user?.uid) throw new Error("Faça login para hospedar imagens.");

    let imgbbFailedOpen = false;

    if (getImgBBKey()) {
      try {
        const url = await verifiedImgbbUrl(file);
        if (url) return { url, provider: "ImgBB" };
        imgbbFailedOpen = true;
      } catch (err) {
        if (err.message !== "IMG_BB_NOT_CONFIGURED") console.warn("ImgBB:", err);
      }
    }

    try {
      const url = await uploadViaFirebaseStorage(file, user.uid);
      if (await hostedImageIsUsable(url, { allowUnreachable: true })) return { url, provider: "Firebase" };
    } catch (firebaseErr) {
      console.warn("Firebase Storage:", firebaseErr);
    }

    if (imgbbFailedOpen) {
      throw new Error(
        "O ImgBB devolveu \"service unavailable\" no lugar da foto. Tente de novo. Se arrastou do Google, salve a imagem no computador e clique na área para escolher o arquivo."
      );
    }

    throw new Error(
      "Hospedagem de imagens não configurada. O administrador deve configurar uma vez em Empresa → Integrações IA."
    );
  }

  function syncProductPhotoZoneLayout() {
    const zone = document.getElementById("productPhotoZone");
    const inner = document.getElementById("productPhotoZoneInner");
    const wrap = document.getElementById("productPhotoPreview");
    const img = document.getElementById("productPhotoPreviewImg");
    if (!zone || !inner || !wrap) return;

    const savedUrl = document.getElementById("productPhoto")?.value.trim() || "";
    const imgSrc = img?.getAttribute("src") || "";
    const previewVisible = Boolean(savedUrl || imgSrc);

    zone.classList.toggle("has-preview", previewVisible);
    inner.classList.toggle("hidden", previewVisible);
    wrap.classList.toggle("hidden", !previewVisible);
  }

  function showProductPhotoPreview(url) {
    const wrap = document.getElementById("productPhotoPreview");
    const img = document.getElementById("productPhotoPreviewImg");
    if (!wrap || !img) return;
    img.onerror = null;
    if (url) {
      img.dataset.retried = "0";
      img.onerror = () => {
        if (img.dataset.retried === "1") {
          setProductPhotoStatus("O ImgBB não abriu essa foto (service unavailable). Envie a imagem de novo.", "error");
          return;
        }
        img.dataset.retried = "1";
        const join = url.includes("?") ? "&" : "?";
        img.src = `${url}${join}r=${Date.now()}`;
      };
      img.src = url;
      if (/ibb\.co|imgbb\.com/i.test(url)) {
        imgbbUrlLooksBroken(url).then((broken) => {
          const current = document.getElementById("productPhoto")?.value.trim() || "";
          if (broken && current === url) {
            setProductPhotoStatus("O ImgBB não abriu essa foto (service unavailable). Envie a imagem de novo.", "error");
          }
        });
      }
    } else {
      img.removeAttribute("src");
    }
    syncProductPhotoZoneLayout();
  }

  function applyImageUrl(url, { context = "ai" } = {}) {
    lastImageUrl = url;
    const productInput = document.getElementById("productPhoto");
    const aiInput = document.getElementById("aiImageLink");

    if (context === "product" || context === "both") {
      if (productInput) productInput.value = url;
      const img = document.getElementById("productPhotoPreviewImg");
      const showingLocal = String(img?.src || "").startsWith("blob:");
      if (!showingLocal) showProductPhotoPreview(url);
      else syncProductPhotoZoneLayout();
      setProductPhotoStatus("Link gerado! Salve o produto para concluir.", "success");
    }

    if (context === "ai" || context === "both") {
      if (aiInput) aiInput.value = url;
      document.getElementById("aiImageLinkWrap")?.classList.remove("hidden");
      setAiStatus("Link gerado automaticamente!", "success");
    }
  }

  async function processImageFile(file, options = {}) {
    const { context = "ai", autoApplyProduct = false } = options;
    const validationMsg = validateImageFile(file);
    if (validationMsg) {
      if (context === "product") setProductPhotoStatus(validationMsg, "error");
      else setAiStatus(validationMsg, "error");
      return null;
    }

    if (uploadInProgress) {
      const msg = "Aguarde o envio da imagem anterior terminar.";
      if (context === "product") setProductPhotoStatus(msg, "error");
      else setAiStatus(msg, "error");
      return null;
    }

    uploadInProgress = true;
    pendingImageFile = file;

    if (context !== "product") showImagePreview(file);
    if (context === "product") {
      showLocalProductPhotoPreview(file);
      setProductPhotoStatus(
        file.size > MAX_IMAGE_BYTES || shouldTranscodeToJpeg(file)
          ? "Convertendo e enviando imagem..."
          : "Enviando imagem...",
        "info"
      );
    } else {
      setAiStatus("Gerando link da imagem...", "info");
    }
    setAiLoading(true);

    try {
      const fileToUpload = await prepareImageFile(file);
      if (fileToUpload.size > MAX_IMAGE_BYTES) {
        throw new Error("Imagem ainda está grande demais. Tente uma foto menor ou com menos qualidade.");
      }

      const { url } = await uploadImageFile(fileToUpload);
      const applyContext = context === "product" ? "product" : "ai";
      applyImageUrl(url, { context: applyContext });

      if (autoApplyProduct || context === "product") {
        const product = getSelectedProduct();
        if (product && context === "ai") {
          pdv().applyProductPhoto?.(url, product.id);
        }
      }

      try {
        await navigator.clipboard.writeText(url);
        if (context === "product") setProductPhotoStatus("Link gerado e copiado!", "success");
        else setAiStatus("Link gerado e copiado!", "success");
      } catch (_) {
        /* clipboard optional */
      }

      return url;
    } catch (error) {
      const msg = error.message || "Erro ao enviar imagem.";
      if (context === "product") {
        const savedUrl = document.getElementById("productPhoto")?.value.trim() || "";
        if (savedUrl) resetProductPhotoUploadUi();
        setProductPhotoStatus(msg, "error");
      } else {
        setAiStatus(msg, "error");
      }
      return null;
    } finally {
      uploadInProgress = false;
      setAiLoading(false);
    }
  }

  const GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-001"
  ];

  function formatGeminiError(data, status) {
    const raw = data?.error?.message || `Erro na IA (${status})`;
    if (/quota|rate.?limit|resource.?exhausted|limit:\s*0/i.test(raw)) {
      return (
        "Cota da IA Gemini esgotada ou indisponível no plano gratuito.\n\n" +
        "Peça ao administrador para:\n" +
        "1) Criar uma chave nova em aistudio.google.com/apikey\n" +
        "2) Ou ativar faturamento no Google Cloud (plano grátis continua com limites)\n\n" +
        "Detalhe: " + raw.split("\n")[0]
      );
    }
    if (/api.?key|invalid|permission|401|403/i.test(raw)) {
      return "Chave Gemini inválida. Crie uma nova em aistudio.google.com/apikey (formato AIza... ou chave atual do AI Studio).";
    }
    if (/not found|404|deprecated|shutdown/i.test(raw)) {
      return "Modelo de IA indisponível. Atualize o sistema (Ctrl+F5) e tente de novo.";
    }
    return raw;
  }

  async function callGemini(prompt, { json = false } = {}) {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      throw new Error("IA não configurada. O administrador deve configurar a chave Gemini (uma vez para toda a rede).");
    }
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: json ? { responseMimeType: "application/json" } : {}
    };

    let lastError = null;
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = formatGeminiError(data, res.status);
          lastError = new Error(msg);
          if (/quota|rate.?limit|limit:\s*0|404|not found/i.test(data?.error?.message || "")) {
            continue;
          }
          throw lastError;
        }
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        if (!text.trim()) throw new Error("A IA não retornou resposta. Tente novamente.");
        return text.trim();
      } catch (err) {
        lastError = err;
        if (!/quota|404|not found|limit:\s*0/i.test(String(err?.message || ""))) throw err;
      }
    }
    throw lastError || new Error("Não foi possível conectar à IA Gemini. Tente novamente em alguns minutos.");
  }

  function buildStoreContext() {
    const company = pdv().getCompany?.() || {};
    const products = pdv().getProducts?.() || [];
    const sales = pdv().getSales?.() || [];
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthSales = sales.filter((s) => s.createdAt?.startsWith(monthKey) && !s.cancelledAt && s.pendingStatus !== "cancelled");
    const topSold = {};
    monthSales.forEach((s) => {
      (s.items || []).forEach((i) => {
        const name = i.name || "Item";
        topSold[name] = (topSold[name] || 0) + Number(i.qty || 0);
      });
    });
    const topList = Object.entries(topSold).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([n, q]) => `${n} (${q} un.)`).join(", ") || "Sem dados";

    const lowStock = products
      .filter((p) => Number(p.qty || 0) <= Number(p.minStock || 0))
      .slice(0, 10)
      .map((p) => `${p.name}: ${p.qty} un. (mín. ${p.minStock || 0})`)
      .join("; ") || "Nenhum";

    return {
      storeName: company.name || "Loja",
      productCount: products.length,
      monthSalesTotal: monthSales.reduce((s, x) => s + Number(x.total || 0), 0),
      topSold: topList,
      lowStock
    };
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatAiText(text) {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  function renderAiResultHtml(title, html, plainText, actionsHtml = "") {
    const box = document.getElementById("aiResult");
    if (!box) return;
    box.classList.remove("hidden");
    box.innerHTML = `
      <div class="ai-result-header">
        <h3>${title}</h3>
        <button type="button" class="btn" id="aiCopyResult">Copiar</button>
      </div>
      <div class="ai-result-body">${html}</div>
      ${actionsHtml ? `<div class="ai-result-actions">${actionsHtml}</div>` : ""}`;
    document.getElementById("aiCopyResult")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(plainText);
        setAiStatus("Copiado!", "success");
      } catch (_) {
        prompt("Copie:", plainText);
      }
    });
  }

  function populateProductSelect() {
    const sel = document.getElementById("aiProductSelect");
    if (!sel) return;
    const products = [...(pdv().getProducts?.() || [])].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "pt-BR")
    );
    const current = sel.value;
    sel.innerHTML = `<option value="">— Selecione um produto (opcional) —</option>` +
      products.map((p) => `<option value="${p.id}">${escapeHtml(p.name || "Sem nome")}</option>`).join("");
    if (current && products.some((p) => p.id === current)) sel.value = current;
  }

  function isAllowedImageFile(file) {
    const type = String(file?.type || "").toLowerCase();
    if (ACCEPTED_TYPES.includes(type)) return true;
    if (type.startsWith("image/")) return true;
    const ext = String(file?.name || "").split(".").pop()?.toLowerCase() || "";
    return ACCEPTED_EXTENSIONS.includes(ext);
  }

  function validateImageFile(file) {
    if (!file) return "Nenhum arquivo selecionado.";
    if (!isAllowedImageFile(file)) return "Formato inválido. Use JPG, PNG, WebP ou GIF.";
    return null;
  }

  async function compressImageFile(file, maxBytes = MAX_IMAGE_BYTES, { forceJpeg = false } = {}) {
    if (!forceJpeg && file.size <= maxBytes) return file;
    const type = String(file.type || "").toLowerCase();
    if (type === "image/heic" || type === "image/heif" || /\.heic$|\.heif$/i.test(file.name || "")) {
      throw new Error("Foto HEIC do iPhone não é suportada aqui. Altere a câmera para JPG ou envie um print/captura.");
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      throw new Error("Não foi possível ler a imagem. Tente JPG ou PNG.");
    }

    let width = bitmap.width;
    let height = bitmap.height;
    const maxDim = 1600;
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    let quality = 0.88;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    while (blob && blob.size > maxBytes && quality > 0.42) {
      quality -= 0.08;
      blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }
    if (!blob) {
      if (forceJpeg) throw new Error("Não foi possível converter a foto arrastada. Salve a imagem no computador e escolha o arquivo.");
      return file;
    }
    if (blob.size > maxBytes) {
      throw new Error("Imagem ainda está grande demais. Tente uma foto menor ou com menos qualidade.");
    }
    return new File([blob], `${imageBaseName(file)}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
  }

  async function prepareImageFile(file) {
    const err = validateImageFile(file);
    if (err) throw new Error(err);
    const forceJpeg = shouldTranscodeToJpeg(file);
    if (!forceJpeg && file.size <= MAX_IMAGE_BYTES) return file;
    return compressImageFile(file, MAX_IMAGE_BYTES, { forceJpeg });
  }

  function resetProductPhotoUploadUi() {
    const savedUrl = document.getElementById("productPhoto")?.value.trim() || "";
    showProductPhotoPreview(savedUrl);
  }

  function resetProductPhotoForm() {
    const input = document.getElementById("productPhoto");
    const fileInput = document.getElementById("productPhotoFile");
    const status = document.getElementById("productPhotoStatus");
    const zone = document.getElementById("productPhotoZone");
    if (input) input.value = "";
    if (fileInput) fileInput.value = "";
    showProductPhotoPreview("");
    zone?.classList.remove("product-photo-zone--loading", "product-photo-zone--over");
    if (status) {
      status.textContent = "";
      status.className = "product-photo-status";
    }
    uploadInProgress = false;
    pendingImageFile = null;
    syncProductPhotoZoneLayout();
  }

  function showLocalProductPhotoPreview(file) {
    const preview = document.getElementById("productPhotoPreview");
    const img = document.getElementById("productPhotoPreviewImg");
    if (!preview || !img) return;
    img.onerror = null;
    const blobUrl = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(blobUrl);
    img.src = blobUrl;
    syncProductPhotoZoneLayout();
  }

  async function fileFromRemoteImageUrl(url) {
    const res = await fetch(url, { mode: "cors", cache: "no-store" });
    if (!res.ok) throw new Error("Não foi possível baixar a imagem arrastada.");
    const blob = await res.blob();
    const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
    if (!String(blob.type || type).startsWith("image/") && !url.startsWith("data:image/")) {
      throw new Error("O link arrastado não é uma imagem.");
    }
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    return new File([blob], `produto.${ext}`, { type, lastModified: Date.now() });
  }

  async function resolveDroppedImage(dataTransfer) {
    const file = dataTransfer?.files?.[0] || null;
    const html = dataTransfer?.getData?.("text/html") || "";
    const uri = `${dataTransfer?.getData?.("text/uri-list") || ""}\n${dataTransfer?.getData?.("text/plain") || ""}`;
    const remoteUrl = extractImageUrlFromHtml(html) || extractHttpUrl(uri);
    const hasFile = Boolean(file && file.size > 0 && isAllowedImageFile(file));
    let placeholder = false;

    let chosen = null;
    if (hasFile) {
      const buf = await file.arrayBuffer();
      placeholder = await isImgbbPlaceholderBuffer(buf);
      if (!placeholder) chosen = file;
    }

    if (chosen && shouldTranscodeToJpeg(chosen) && typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(chosen);
        bitmap.close?.();
      } catch (_) {
        chosen = null;
        if (remoteUrl) {
          try {
            return await fileFromRemoteImageUrl(remoteUrl);
          } catch (_) { /* tenta a mensagem abaixo */ }
        }
        throw new Error("Não consegui ler a foto arrastada do Google. Salve a imagem no computador e clique na área para escolher o arquivo.");
      }
    }

    if (!chosen && remoteUrl) return fileFromRemoteImageUrl(remoteUrl);
    if (!chosen && placeholder) {
      throw new Error("Essa imagem é o aviso \"service unavailable\" do ImgBB, não a foto da bebida. Arraste a foto de novo ou escolha o arquivo no computador.");
    }
    return chosen;
  }

  function showImagePreview(file) {
    const preview = document.getElementById("aiImagePreview");
    const img = document.getElementById("aiImagePreviewImg");
    if (!preview || !img) return;
    const url = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(url);
    img.src = url;
    preview.classList.remove("hidden");
    document.getElementById("aiImageDropzone")?.classList.add("has-preview");
  }

  function isProductPhotoContextActive() {
    const tab = document.getElementById("produtosTab");
    if (!tab?.classList.contains("active")) return false;
    const card = document.getElementById("productFormCard");
    return Boolean(card && !card.classList.contains("collapsed"));
  }

  function isAiTabActive() {
    return document.getElementById("aiTab")?.classList.contains("active");
  }

  function useImageLinkInProduct() {
    const url = document.getElementById("aiImageLink")?.value || lastImageUrl;
    if (!url) {
      setAiStatus("Cole uma imagem primeiro.", "error");
      return;
    }
    const product = getSelectedProduct();
    pdv().applyProductPhoto?.(url, product?.id);
    setAiStatus("Link aplicado no cadastro do produto.", "success");
  }

  async function runAiAction(action) {
    const product = getSelectedProduct();
    const ctx = buildStoreContext();
    const money = pdv().money || ((v) => `R$ ${Number(v || 0).toFixed(2)}`);

    setAiLoading(true);
    setAiStatus("Consultando IA...", "info");
    try {
      if (action === "description") {
        if (!product) throw new Error("Selecione um produto para gerar a descrição.");
        const prompt = `Você é redator de e-commerce para uma adega/distribuidora no Brasil.
Escreva uma descrição comercial curta (2 a 4 frases) em português do Brasil para o produto:
Nome: ${product.name}
Categoria: ${product.category || "Geral"}
Preço: ${money(product.price)}
Código: ${product.code || "-"}
Tom: convidativo, objetivo, sem emojis excessivos.`;
        const text = await callGemini(prompt);
        renderAiResultHtml("Descrição do produto", formatAiText(text), text,
          `<button type="button" class="btn primary" id="aiApplyDesc">Usar no cadastro</button>`);
        document.getElementById("aiApplyDesc")?.addEventListener("click", () => {
          pdv().applyProductDescription?.(text, product.id);
          setAiStatus("Descrição aplicada no cadastro.", "success");
        });
      }

      if (action === "price") {
        if (!product) throw new Error("Selecione um produto para sugerir preço.");
        const prompt = `Você é consultor de precificação para adega no Brasil.
Produto: ${product.name}
Categoria: ${product.category || "Geral"}
Custo atual: ${money(product.cost)}
Preço atual: ${money(product.price)}
Estoque: ${product.qty || 0} un.
Mais vendidos do mês na loja: ${ctx.topSold}

Responda em português, formato:
1) Preço sugerido (R$)
2) Margem estimada (%)
3) Justificativa breve (2-3 linhas)
4) Dica prática para a loja`;
        const text = await callGemini(prompt);
        renderAiResultHtml("Sugestão de preço", formatAiText(text), text);
      }

      if (action === "stock") {
        const prompt = `Você é analista de estoque para ${ctx.storeName} (adega/distribuidora).
Total de produtos: ${ctx.productCount}
Vendas do mês: ${money(ctx.monthSalesTotal)}
Mais vendidos: ${ctx.topSold}
Produtos com estoque baixo: ${ctx.lowStock}
${product ? `Foco no produto: ${product.name}, estoque ${product.qty || 0}, mínimo ${product.minStock || 0}.` : ""}

Em português do Brasil, forneça previsão de reposição, risco de ruptura e 3 a 5 ações práticas.`;
        const text = await callGemini(prompt);
        renderAiResultHtml("Previsão de estoque", formatAiText(text), text);
      }

      if (action === "promotions") {
        const prompt = `Você é especialista em promoções para ${ctx.storeName} (adega).
Mais vendidos: ${ctx.topSold}
Estoque baixo: ${ctx.lowStock}
${product ? `Produto em foco: ${product.name}, preço ${money(product.price)}.` : ""}

Crie 3 ideias de promoção para esta semana em português.`;
        const text = await callGemini(prompt);
        renderAiResultHtml("Ideias de promoção", formatAiText(text), text);
      }

      if (action === "recommendations") {
        const prompt = `Você é consultor de vendas para ${ctx.storeName}.
Mais vendidos: ${ctx.topSold}
${product ? `Cliente interessado em: ${product.name}.` : ""}

Sugira 5 combinações de produtos (cross-sell) em português.`;
        const text = await callGemini(prompt);
        renderAiResultHtml("Recomendações de produtos", formatAiText(text), text);
      }

      setAiStatus("Pronto!", "success");
    } catch (err) {
      setAiStatus(err.message, "error");
      alert(err.message);
    } finally {
      setAiLoading(false);
    }
  }

  function bindImageInput(zone, inputId, context) {
    const zoneEl = document.getElementById(zone);
    const input = document.getElementById(inputId);
    if (!zoneEl || !input) return;

    const usesOverlayInput = input.parentElement === zoneEl;
    if (!usesOverlayInput) {
      zoneEl.addEventListener("click", (e) => {
        if (e.target === input) return;
        if (e.target.closest("button, a")) return;
        input.click();
      });
    }

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) processImageFile(file, { context });
      input.value = "";
    });

    zoneEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      zoneEl.classList.add(context === "product" ? "product-photo-zone--over" : "ai-dropzone--over");
    });
    zoneEl.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && zoneEl.contains(e.relatedTarget)) return;
      zoneEl.classList.remove(context === "product" ? "product-photo-zone--over" : "ai-dropzone--over");
    });
    zoneEl.addEventListener("drop", (e) => {
      e.preventDefault();
      zoneEl.classList.remove(context === "product" ? "product-photo-zone--over" : "ai-dropzone--over");
      const transfer = e.dataTransfer;
      resolveDroppedImage(transfer)
        .then((file) => {
          if (file) return processImageFile(file, { context });
          const msg = "Não consegui ler a foto arrastada. Salve a imagem no computador e clique na área para escolher o arquivo.";
          if (context === "product") setProductPhotoStatus(msg, "error");
          else setAiStatus(msg, "error");
          return null;
        })
        .catch((err) => {
          const msg = err.message || "Não consegui ler a foto arrastada.";
          if (context === "product") setProductPhotoStatus(msg, "error");
          else setAiStatus(msg, "error");
        });
    });
  }

  function setupGlobalPaste() {
    document.addEventListener("paste", (e) => {
      const clipboard = e.clipboardData;
      if (!clipboard) return;

      let file = null;
      for (const item of clipboard.items || []) {
        if (item.type?.startsWith("image/")) {
          file = item.getAsFile();
          break;
        }
      }
      const html = clipboard.getData("text/html") || "";
      const remoteUrl = extractImageUrlFromHtml(html);
      if (!file && !remoteUrl) return;

      const target = e.target;
      const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inField && !file) return;
      if (!isProductPhotoContextActive() && !isAiTabActive()) return;

      e.preventDefault();
      const context = isProductPhotoContextActive() ? "product" : "ai";
      resolveDroppedImage({
        files: file ? [file] : [],
        getData: (kind) => (kind === "text/html" ? html : "")
      })
        .then((resolved) => {
          if (resolved) return processImageFile(resolved, { context });
          const msg = "Não consegui ler a imagem colada.";
          if (context === "product") setProductPhotoStatus(msg, "error");
          else setAiStatus(msg, "error");
          return null;
        })
        .catch((err) => {
          const msg = err.message || "Não consegui ler a imagem colada.";
          if (context === "product") setProductPhotoStatus(msg, "error");
          else setAiStatus(msg, "error");
        });
    });
  }

  function setupImageUpload() {
    bindImageInput("aiImageDropzone", "aiImageFile", "ai");
    setupGlobalPaste();

    document.getElementById("aiCopyImageLink")?.addEventListener("click", async () => {
      const url = document.getElementById("aiImageLink")?.value;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        setAiStatus("Link copiado!", "success");
      } catch (_) {
        prompt("Copie o link:", url);
      }
    });
    document.getElementById("aiUseImageLink")?.addEventListener("click", useImageLinkInProduct);
  }

  function setupProductPhotoUpload() {
    bindImageInput("productPhotoZone", "productPhotoFile", "product");

    document.getElementById("productPhoto")?.addEventListener("input", (e) => {
      const url = e.target.value.trim();
      showProductPhotoPreview(url || "");
    });
    syncProductPhotoZoneLayout();
  }

  function setupAiActions() {
    document.querySelectorAll(".ai-action-btn").forEach((btn) => {
      btn.addEventListener("click", () => runAiAction(btn.dataset.aiAction));
    });
  }

  const root = typeof window !== "undefined" ? window : globalThis;
  root.uploadProductImageFile = (file, options) => processImageFile(file, options);
  root.hasImageUploadConfigured = hasImageUploadConfigured;
  root.PDVImageUpload = {
    extractImageUrlFromHtml,
    extractHttpUrl,
    shouldTranscodeToJpeg,
    imageBaseName,
    imgbbCandidateUrls,
    isImgbbPlaceholderBuffer,
    prepareImageFile,
    resolveDroppedImage
  };

  function setupAiKeysForm() {
    document.getElementById("aiSaveKeysBtn")?.addEventListener("click", async () => {
      const imgbbKey = document.getElementById("aiImgBBKey")?.value.trim() || "";
      const geminiKey = document.getElementById("aiGeminiKey")?.value.trim() || "";
      const statusEl = document.getElementById("aiKeysStatus");
      const btn = document.getElementById("aiSaveKeysBtn");
      if (!imgbbKey && !geminiKey) {
        if (statusEl) { statusEl.textContent = "Cole ao menos uma chave."; statusEl.className = "ai-status ai-status--error"; }
        return;
      }
      const storeRef = pdv().getStoreRef?.();
      if (!storeRef) {
        alert("Faça login para salvar.");
        return;
      }
      btn.disabled = true;
      try {
        const patch = {};
        if (imgbbKey) patch.imgbbApiKey = imgbbKey;
        if (geminiKey) patch.geminiApiKey = geminiKey;
        await storeRef.set(patch, { merge: true });
        if (pdv().patchCompany) pdv().patchCompany(patch);
        pdv().syncAiKeyInputs?.({ ...(pdv().getCompany?.() || {}), ...patch });
        if (statusEl) { statusEl.textContent = "Chaves salvas! Todos os PCs da rede já podem usar."; statusEl.className = "ai-status ai-status--success"; }
      } catch (err) {
        if (statusEl) { statusEl.textContent = err.message; statusEl.className = "ai-status ai-status--error"; }
      } finally {
        btn.disabled = false;
      }
    });
  }

  function loadAiKeysIntoForm() {
    pdv().syncAiKeyInputs?.(pdv().getCompany?.() || {});
  }

  root.setupAI = function setupAI() {
    setupImageUpload();
    setupProductPhotoUpload();
    setupAiActions();
    setupAiKeysForm();
    populateProductSelect();
    loadAiKeysIntoForm();
  };

  root.onAITabActivated = function onAITabActivated() {
    populateProductSelect();
    loadAiKeysIntoForm();
  };

  root.refreshAIProductSelect = populateProductSelect;
  root.refreshProductPhotoPreview = showProductPhotoPreview;
  root.resetProductPhotoForm = resetProductPhotoForm;
  if (typeof module !== "undefined" && module.exports) module.exports = root.PDVImageUpload;
})();
