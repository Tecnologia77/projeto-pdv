const deliveryState = {
  storeUid: null,
  store: null,
  storeSlug: null,
  products: [],
  cart: [],
  trackingOrderId: null,
  searchQuery: "",
  selectedCategory: "__all__"
};

let db = null;
let orderStatusUnsubscribe = null;

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function normalizeWhatsAppNumber(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12 && digits.startsWith("55")) return digits;
  if (digits.length >= 8 && digits.length <= 11) return `55${digits}`;
  return digits;
}

function getStoreWhatsAppNumber(store) {
  return normalizeWhatsAppNumber(store?.whatsapp || store?.phone || "");
}

function buildDeliveryOrderWhatsAppMessage({ storeName, orderId, customer, items, subtotal, deliveryFee, deliveryZoneName, total, paymentMethod }) {
  const lines = [
    `🛒 *NOVO PEDIDO — ${storeName || "Loja"}*`,
    "",
    `🆔 Pedido: #${String(orderId || "").slice(0, 8).toUpperCase()}`,
    `👤 *Cliente:* ${customer.name}`,
    `📱 *Telefone:* ${customer.phone}`,
    `📍 *Endereço:* ${customer.address}`,
    `💳 *Pagamento:* ${paymentMethod}`,
    ""
  ];
  if (customer.notes) {
    lines.push(`📝 *Obs:* ${customer.notes}`, "");
  }
  lines.push("*Itens:*");
  items.forEach((item) => {
    lines.push(`• ${item.name} x${item.qty} — ${money(item.subtotal || item.price * item.qty)}`);
    (item.selections || []).forEach((sel) => {
      lines.push(`   ${sel.groupName}: ${sel.name}`);
    });
  });
  lines.push("");
  lines.push(`Subtotal: ${money(subtotal)}`);
  if (deliveryZoneName) lines.push(`Bairro: ${deliveryZoneName}`);
  if (Number(deliveryFee) > 0 || deliveryZoneName) lines.push(`Taxa entrega: ${money(deliveryFee)}`);
  lines.push(`*TOTAL: ${money(total)}*`);
  lines.push("", "_Enviado pelo cardápio online_");
  return lines.join("\n");
}

function getWhatsAppChatUrl(phone, message) {
  const normalized = normalizeWhatsAppNumber(phone);
  if (!normalized) return "";
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

function openWhatsAppChat(phone, message) {
  const url = getWhatsAppChatUrl(phone, message);
  if (!url) return false;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobile) {
    window.location.href = url;
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return true;
}

const DELIVERY_CUSTOMER_STEPS = [
  { key: "awaiting_approval", label: "Aguardando aprovação" },
  { key: "approved", label: "Em preparação" },
  { key: "out_for_delivery", label: "Saiu para entrega" },
  { key: "delivered", label: "Finalizado" }
];

const DELIVERY_CUSTOMER_STATUS_MSG = {
  awaiting_approval: "Aguardando aprovação da loja",
  approved: "Seu pedido está em preparação",
  out_for_delivery: "Seu pedido saiu para entrega",
  delivered: "Pedido finalizado — obrigado!",
  cancelled: "Pedido cancelado pela loja"
};

function normalizeCustomerDeliveryStatus(status) {
  const raw = String(status || "").trim();
  if (!raw || raw === "new") return "awaiting_approval";
  if (raw === "preparing") return "approved";
  return raw;
}

function getCustomerStatusMessage(status) {
  const key = normalizeCustomerDeliveryStatus(status);
  return DELIVERY_CUSTOMER_STATUS_MSG[key] || "Atualizando status do pedido...";
}

function getTrackStorageKey() {
  return deliveryState.storeSlug ? `pdv_delivery_track_${deliveryState.storeSlug}` : "";
}

function saveTrackedOrder(orderId) {
  const key = getTrackStorageKey();
  if (!key || !orderId) return;
  try {
    sessionStorage.setItem(key, JSON.stringify({ orderId, savedAt: new Date().toISOString() }));
  } catch (_) { /* ignore */ }
}

function loadTrackedOrderId() {
  const key = getTrackStorageKey();
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.orderId || null;
  } catch (_) {
    return null;
  }
}

function clearTrackedOrder() {
  const key = getTrackStorageKey();
  if (key) sessionStorage.removeItem(key);
  deliveryState.trackingOrderId = null;
  if (orderStatusUnsubscribe) {
    orderStatusUnsubscribe();
    orderStatusUnsubscribe = null;
  }
  document.getElementById("orderTrackBar")?.classList.add("hidden");
  setOrderTrackLayout(false);
}

function renderCustomerDeliverySteps(activeKey = "awaiting_approval") {
  const status = normalizeCustomerDeliveryStatus(activeKey);
  if (status === "cancelled") {
    return '<p class="delivery-steps-cancelled">Pedido cancelado pela loja.</p>';
  }
  const idx = DELIVERY_CUSTOMER_STEPS.findIndex((s) => s.key === status);
  return `<div class="delivery-steps delivery-steps--customer">${DELIVERY_CUSTOMER_STEPS.map((step, i) => {
    let cls = "delivery-step";
    if (idx >= 0 && i < idx) cls += " delivery-step--done";
    else if (i === idx) cls += " delivery-step--active";
    return `<div class="${cls}"><span class="delivery-step-num">${i + 1}</span><span class="delivery-step-label">${step.label}</span></div>`;
  }).join("")}</div>`;
}

function updateCustomerOrderStatusUI(orderId, status) {
  const normalized = normalizeCustomerDeliveryStatus(status);
  const stepsEl = document.getElementById("successOrderSteps");
  const labelEl = document.getElementById("successOrderStatusLabel");
  const orderIdEl = document.getElementById("successOrderId");
  if (stepsEl) stepsEl.innerHTML = renderCustomerDeliverySteps(normalized);
  if (labelEl) labelEl.textContent = getCustomerStatusMessage(normalized);
  if (orderIdEl) orderIdEl.textContent = `Pedido #${String(orderId).slice(0, 8).toUpperCase()}`;

  const bar = document.getElementById("orderTrackBar");
  const barStatus = document.getElementById("orderTrackBarStatus");
  const barTitle = document.getElementById("orderTrackBarTitle");
  if (bar && barStatus && deliveryState.trackingOrderId === orderId) {
    bar.classList.remove("hidden");
    setOrderTrackLayout(true);
    if (barTitle) barTitle.textContent = `Pedido #${String(orderId).slice(0, 8).toUpperCase()}`;
    barStatus.textContent = getCustomerStatusMessage(normalized);
    if (normalized === "delivered" || normalized === "cancelled") {
      setTimeout(() => clearTrackedOrder(), 8000);
    }
  }
}

function unsubscribeOrderStatus() {
  if (orderStatusUnsubscribe) {
    orderStatusUnsubscribe();
    orderStatusUnsubscribe = null;
  }
}

function subscribeToOrderStatus(orderId) {
  if (!db || !deliveryState.storeUid || !orderId) return;
  unsubscribeOrderStatus();
  deliveryState.trackingOrderId = orderId;
  saveTrackedOrder(orderId);

  const ref = db
    .collection("stores")
    .doc(deliveryState.storeUid)
    .collection("deliveryOrderStatus")
    .doc(orderId);

  orderStatusUnsubscribe = ref.onSnapshot(
    (snap) => {
      if (!snap.exists) {
        updateCustomerOrderStatusUI(orderId, "awaiting_approval");
        return;
      }
      updateCustomerOrderStatusUI(orderId, snap.data()?.status);
    },
    (err) => {
      console.warn("Acompanhamento do pedido:", err);
      const labelEl = document.getElementById("successOrderStatusLabel");
      if (labelEl) labelEl.textContent = "Não foi possível atualizar o status. Recarregue a página.";
    }
  );
}

function startOrderTracking(orderId) {
  updateCustomerOrderStatusUI(orderId, "awaiting_approval");
  subscribeToOrderStatus(orderId);
}

function openOrderTrackModal() {
  if (!deliveryState.trackingOrderId) return;
  document.getElementById("successModal")?.classList.remove("hidden");
}

function showOrderSuccessModal(orderId, whatsappUrl, autoOpened) {
  startOrderTracking(orderId);
  document.getElementById("successOrderId").textContent = `Pedido #${String(orderId).slice(0, 8).toUpperCase()}`;
  const hint = document.getElementById("successWhatsAppHint");
  const btn = document.getElementById("btnWhatsAppSend");
  if (whatsappUrl && btn) {
    btn.href = whatsappUrl;
    btn.classList.remove("hidden");
    if (hint) {
      hint.classList.remove("hidden");
      hint.textContent = autoOpened
        ? "Confirme o envio no WhatsApp (toque em Enviar). Se não abriu, use o botão abaixo."
        : "Toque no botão para abrir o WhatsApp da loja com o resumo do pedido.";
    }
  } else {
    btn?.classList.add("hidden");
    if (hint) {
      hint.classList.remove("hidden");
      hint.textContent = "Pedido salvo no sistema. A loja ainda não cadastrou WhatsApp — avise a adega.";
    }
  }
  document.getElementById("successModal")?.classList.remove("hidden");
}

function getStoreSlugFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = String(params.get("loja") || "").trim().toLowerCase();
  if (fromQuery) return fromQuery;
  const match = window.location.pathname.match(/\/loja\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
}

function showError(message) {
  document.getElementById("deliveryApp")?.classList.add("hidden");
  const box = document.getElementById("deliveryError");
  const text = document.getElementById("deliveryErrorText");
  if (text) text.textContent = message;
  box?.classList.remove("hidden");
}

function getCartQty(productId) {
  const item = deliveryState.cart.find((i) => i.productId === productId);
  return item ? item.qty : 0;
}

function getCartTotals() {
  const subtotal = deliveryState.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const pricing = typeof DeliveryLogic !== "undefined"
    ? DeliveryLogic.calculateDeliveryFee(deliveryState.store || {}, deliveryState.selectedZoneId)
    : { fee: Number(deliveryState.store?.deliveryFee || 0), needsZone: false, zone: null, mode: "flat", zones: [] };
  const fee = pricing.needsZone ? 0 : Number(pricing.fee || 0);
  const minOrder = Number(deliveryState.store?.deliveryMinOrder || 0);
  return { subtotal, fee, total: subtotal + fee, minOrder, pricing };
}

function getComboGroups(product) {
  if (typeof DeliveryLogic === "undefined") return [];
  return DeliveryLogic.normalizeComboGroups(product?.comboGroups);
}

function productHasComboChoices(product) {
  return getComboGroups(product).length > 0;
}

function optionDeductQty(option, product) {
  const configured = Math.max(0, Number(option?.qty || 0));
  if (configured > 0) return configured;
  return product?.stockMode === "ml" ? 50 : 1;
}

function getStockReserved(productId, cart = deliveryState.cart, ignoreLineId = "") {
  let reserved = 0;
  cart.forEach((item) => {
    if (ignoreLineId && item.lineId === ignoreLineId) return;
    const parent = deliveryState.products.find((p) => p.id === item.productId);
    const chosenHere = (item.selections || []).some((sel) => sel.productId === productId);
    if (item.productId === productId && !chosenHere && parent?.stockMode !== "ml") {
      reserved += Number(item.qty || 0);
    }
    (item.selections || []).forEach((sel) => {
      if (sel.productId === productId) {
        reserved += Number(sel.deductQty || 1) * Number(item.qty || 0);
      }
    });
    if (parent?.stockMode === "dose") {
      getNormalizedDoseRecipe(parent, deliveryState.products).forEach((comp) => {
        if (comp.productId !== productId) return;
        const ingredient = deliveryState.products.find((p) => p.id === productId);
        reserved += getDoseRecipeComponentPerDose(comp, ingredient) * Number(item.qty || 0);
      });
    }
  });
  return reserved;
}

function getOptionRemaining(option, ignoreLineId = "") {
  const product = deliveryState.products.find((p) => p.id === option.productId);
  if (!product) return 0;
  const need = optionDeductQty(option, product);
  if (need <= 0) return 0;
  const left = Number(product.qty || 0) - getStockReserved(product.id, deliveryState.cart, ignoreLineId);
  return Math.floor(left / need);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getDoseRecipeComponentPerDose(comp, ingredient) {
  if (!ingredient || !comp?.productId) return 0;
  if (ingredient.stockMode === "ml") return Math.max(0, Number(comp.ml || 0));
  if (!ingredient.stockMode || ingredient.stockMode === "unit") {
    return Math.max(0, Number(comp.qty > 0 ? comp.qty : 1));
  }
  return 0;
}

function getNormalizedDoseRecipe(product, products) {
  return (product.doseRecipe || [])
    .map((row) => {
      const productId = String(row?.productId || "").trim();
      if (!productId) return null;
      const ingredient = products.find((p) => p.id === productId);
      const ml = Math.max(0, Number(row?.ml || 0));
      const qty = Math.max(0, Math.floor(Number(row?.qty || 0)));
      if (ingredient?.stockMode === "ml" && ml > 0) return { productId, ml, qty: 0 };
      if (!ingredient?.stockMode || ingredient.stockMode === "unit") {
        return { productId, ml: 0, qty: qty > 0 ? qty : 1 };
      }
      if (ml > 0) return { productId, ml, qty: 0 };
      if (qty > 0) return { productId, ml: 0, qty };
      return null;
    })
    .filter(Boolean);
}

function getDeliveryProductAvailability(product, products = deliveryState.products, cart = deliveryState.cart) {
  if (!product || product.stockMode === "ml") return 0;
  const groups = getComboGroups(product);
  if (product.stockMode === "dose") {
    const recipe = getNormalizedDoseRecipe(product, products);
    if (!recipe.length && !groups.length) return 0;
    let maxDoses = Infinity;
    if (recipe.length) {
      const usage = new Map();
      cart.forEach((item) => {
        const p = products.find((x) => x.id === item.productId);
        if (!p || p.stockMode !== "dose") return;
        getNormalizedDoseRecipe(p, products).forEach((comp) => {
          const ing = products.find((x) => x.id === comp.productId);
          const perDose = getDoseRecipeComponentPerDose(comp, ing);
          if (perDose > 0) {
            usage.set(comp.productId, (usage.get(comp.productId) || 0) + perDose * item.qty);
          }
        });
      });
      recipe.forEach((comp) => {
        const ing = products.find((p) => p.id === comp.productId);
        const perDose = getDoseRecipeComponentPerDose(comp, ing);
        if (!ing || perDose <= 0) return (maxDoses = 0);
        const reservedChoices = cart.reduce((sum, item) => sum + (item.selections || [])
          .filter((sel) => sel.productId === comp.productId)
          .reduce((inner, sel) => inner + Number(sel.deductQty || 0) * Number(item.qty || 0), 0), 0);
        const available = Number(ing.qty || 0) - (usage.get(comp.productId) || 0) - reservedChoices;
        maxDoses = Math.min(maxDoses, Math.floor(available / perDose));
      });
    }
    if (groups.length) {
      const selectable = groups.every((group) => group.options.some((opt) => getOptionRemaining(opt) > 0));
      if (!selectable) return 0;
      if (!recipe.length) return 99;
    }
    return Math.max(0, maxDoses === Infinity ? 0 : maxDoses);
  }
  const reserved = getStockReserved(product.id, cart, product.id);
  return Math.max(0, Number(product.qty || 0) - reserved);
}

function isProductDeliveryVisible(product) {
  return product?.deliveryEnabled !== false;
}

function getAvailableProducts() {
  return deliveryState.products.filter(
    (p) => isProductDeliveryVisible(p) && getDeliveryProductAvailability(p) > 0
  );
}

function productMatchesSearch(product, query) {
  if (!query) return true;
  const q = normalizeSearch(query);
  const haystack = [
    product.name,
    product.code,
    product.category,
    product.description
  ].map(normalizeSearch).join(" ");
  return haystack.includes(q);
}

function getDeliveryCategoryNodes() {
  return (Array.isArray(deliveryState.store?.productCategories) ? deliveryState.store.productCategories : [])
    .map((node) => ({
      id: String(node?.id || "").trim(),
      name: String(node?.name || "").trim(),
      parentId: node?.parentId ? String(node.parentId).trim() : "",
      order: Number(node?.order || 0)
    }))
    .filter((node) => node.id && node.name);
}

function getDeliveryCategoryChildren(parentId = "") {
  return getDeliveryCategoryNodes()
    .filter((n) => (n.parentId || "") === (parentId || ""))
    .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, "pt-BR"));
}

function getDeliveryCategoryDescendantIds(categoryId) {
  const ids = new Set([categoryId]);
  const walk = (parentId) => {
    getDeliveryCategoryChildren(parentId).forEach((child) => {
      ids.add(child.id);
      walk(child.id);
    });
  };
  walk(categoryId);
  return ids;
}

function getDeliveryProductCategoryId(product) {
  const nodes = getDeliveryCategoryNodes();
  const id = String(product?.categoryId || "").trim();
  if (id && nodes.some((n) => n.id === id)) return id;
  const label = String(product?.category || "").trim();
  if (!label) return "";
  const byName = nodes.find((n) => normalizeSearch(n.name) === normalizeSearch(label));
  if (byName) return byName.id;
  const leaf = label.includes("›") ? label.split("›").pop().trim() : label;
  const byLeaf = nodes.find((n) => normalizeSearch(n.name) === normalizeSearch(leaf));
  return byLeaf?.id || "";
}

function getDeliveryProductCategoryLabel(product) {
  const nodes = getDeliveryCategoryNodes();
  const id = getDeliveryProductCategoryId(product);
  if (id) {
    const node = nodes.find((n) => n.id === id);
    if (node) {
      const parent = node.parentId ? nodes.find((n) => n.id === node.parentId) : null;
      return parent ? `${parent.name} › ${node.name}` : node.name;
    }
  }
  return String(product?.category || "").trim() || "Outros";
}

function getDeliveryProductRootCategory(product) {
  const nodes = getDeliveryCategoryNodes();
  let current = nodes.find((n) => n.id === getDeliveryProductCategoryId(product));
  let guard = 0;
  while (current?.parentId && guard < 20) {
    const parent = nodes.find((n) => n.id === current.parentId);
    if (!parent) break;
    current = parent;
    guard += 1;
  }
  if (current) return { id: current.id, name: current.name };
  const label = String(product?.category || "").trim();
  if (!label) return { id: "__other__", name: "Outros" };
  const rootName = label.includes("›") ? label.split("›")[0].trim() : label;
  return { id: `name:${normalizeSearch(rootName)}`, name: rootName || "Outros" };
}

function getDeliveryFilterTabs(products) {
  const fromTree = getDeliveryCategoryChildren("").map((node) => ({
    value: node.id,
    label: node.name
  }));
  if (fromTree.length) return fromTree;

  const map = new Map();
  products.forEach((product) => {
    const root = getDeliveryProductRootCategory(product);
    if (!map.has(root.id)) map.set(root.id, root.name);
  });
  return [...map.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

function productMatchesSelectedCategory(product) {
  const selected = deliveryState.selectedCategory;
  if (!selected || selected === "__all__") return true;
  const productId = getDeliveryProductCategoryId(product);
  if (productId) {
    if (productId === selected) return true;
    if (getDeliveryCategoryDescendantIds(selected).has(productId)) return true;
  }
  const root = getDeliveryProductRootCategory(product);
  if (root.id === selected) return true;
  return normalizeSearch(root.name) === normalizeSearch(selected)
    || normalizeSearch(product.category || "") === normalizeSearch(selected);
}

function renderCategoryTabs(products = getAvailableProducts()) {
  const container = document.getElementById("menuCategoryTabs");
  const wrap = document.querySelector(".menu-category-tabs-wrap");
  if (!container) return;

  const categories = getDeliveryFilterTabs(products);

  if (
    deliveryState.selectedCategory !== "__all__" &&
    !categories.some((category) => category.value === deliveryState.selectedCategory)
  ) {
    deliveryState.selectedCategory = "__all__";
  }

  const tabs = [
    { value: "__all__", label: "Todas" },
    ...categories
  ];

  wrap?.classList.toggle("hidden", categories.length === 0);

  container.innerHTML = tabs
    .map((tab) => {
      const active = tab.value === deliveryState.selectedCategory;
      return `
        <button
          type="button"
          class="menu-cat-tab${active ? " active" : ""}"
          data-category="${escapeHtml(tab.value)}"
          aria-pressed="${active}"
        >
          ${escapeHtml(tab.label)}
        </button>
      `;
    })
    .join("");

  container.querySelectorAll("[data-category]").forEach((btn) => {
    btn.addEventListener("click", () => {
      deliveryState.selectedCategory = btn.dataset.category;
      renderCategoryTabs(products);
      renderProducts();
    });
  });
}

function getFilteredProducts() {
  const query = deliveryState.searchQuery.trim();
  return getAvailableProducts()
    .filter((p) => productMatchesSelectedCategory(p))
    .filter((p) => productMatchesSearch(p, query))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function groupProductsByCategory(products) {
  const groups = new Map();
  products.forEach((product) => {
    const label = getDeliveryProductCategoryLabel(product);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(product);
  });
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
}

function setOrderTrackLayout(active) {
  document.body.classList.toggle("has-order-track", !!active);
  document.getElementById("deliveryApp")?.classList.toggle("has-order-track", !!active);
}

function renderProductCard(p) {
  const qty = getCartQty(p.id);
  const hasChoices = productHasComboChoices(p);
  const photo = p.photo
    ? `<img src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.closest('.product-card-media')?.classList.add('product-card-media--empty')" />`
    : `<div class="product-photo-placeholder" aria-hidden="true">📦</div>`;
  const choiceBadge = hasChoices
    ? `<div class="combo-badge">${qty > 0 ? `${qty} no pedido · ` : ""}Escolher opções</div>`
    : "";
  return `
    <article class="product-card" data-id="${escapeHtml(p.id)}">
      <div class="product-card-media${p.photo ? "" : " product-card-media--empty"}">${photo}</div>
      <div class="name">${escapeHtml(p.name)}</div>
      ${choiceBadge}
      <div class="price">${money(p.price)}</div>
      <div class="add-row">
        ${hasChoices
          ? `<button type="button" class="btn-add" data-action="choose" data-id="${escapeHtml(p.id)}">${qty > 0 ? "Adicionar outro" : "Montar combo"}</button>`
          : qty > 0 ? `
          <div class="qty-mini">
            <button type="button" data-action="minus" data-id="${escapeHtml(p.id)}" aria-label="Remover um">−</button>
            <span>${qty}</span>
            <button type="button" data-action="plus" data-id="${escapeHtml(p.id)}" aria-label="Adicionar um">+</button>
          </div>
        ` : `<button type="button" class="btn-add" data-action="add" data-id="${escapeHtml(p.id)}">Adicionar</button>`}
      </div>
    </article>`;
}

function bindProductGridActions(root) {
  root?.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const product = deliveryState.products.find((p) => p.id === id);
      if (!product) return;
      const action = btn.dataset.action;
      if (action === "choose") openComboModal(product);
      else if (action === "add") changeQty(product, 1);
      else if (action === "plus") changeQty(product, 1);
      else if (action === "minus") changeQty(product, -1);
    });
  });
}

function renderProducts() {
  const grid = document.getElementById("productsGrid");
  const empty = document.getElementById("emptyProducts");
  const emptySearch = document.getElementById("emptySearch");
  const available = getAvailableProducts();

  renderCategoryTabs(available);

  if (!available.length) {
    grid.innerHTML = "";
    empty?.classList.remove("hidden");
    emptySearch?.classList.add("hidden");
    return;
  }
  empty?.classList.add("hidden");

  const filtered = getFilteredProducts();

  if (!filtered.length) {
    grid.innerHTML = "";
    emptySearch?.classList.remove("hidden");
    return;
  }
  emptySearch?.classList.add("hidden");

  const grouped = groupProductsByCategory(filtered);
  const showGroups = deliveryState.selectedCategory === "__all__" && grouped.length > 1;
  if (showGroups) {
    grid.className = "menu-catalog";
    grid.innerHTML = grouped.map(([label, items]) => `
      <section class="category-block">
        <div class="category-head category-head--static">
          <span class="category-head-title">${escapeHtml(label)}</span>
          <span class="category-head-count">${items.length}</span>
        </div>
        <div class="category-body open">
          <div class="products-grid">${items.map(renderProductCard).join("")}</div>
        </div>
      </section>
    `).join("");
  } else {
    grid.className = "products-grid";
    grid.innerHTML = filtered.map(renderProductCard).join("");
  }
  bindProductGridActions(grid);
}

function setupMenuToolbar() {
  const searchInput = document.getElementById("menuSearch");
  const clearBtn = document.getElementById("btnClearSearch");
  if (!searchInput) return;

  searchInput.addEventListener("input", () => {
    deliveryState.searchQuery = searchInput.value.trim();
    clearBtn?.classList.toggle("hidden", !deliveryState.searchQuery);
    renderProducts();
  });

  clearBtn?.addEventListener("click", () => {
    searchInput.value = "";
    deliveryState.searchQuery = "";
    clearBtn.classList.add("hidden");
    renderProducts();
    searchInput.focus();
  });
}

function changeQty(product, diff) {
  const lineId = product.id;
  const max = Math.max(0, Number(product.qty || 0) - getStockReserved(product.id, deliveryState.cart, lineId));
  let item = deliveryState.cart.find((i) => i.lineId === lineId);
  if (!item && diff > 0) {
    item = {
      lineId,
      productId: product.id,
      name: product.name,
      code: product.code || "",
      price: Number(product.price || 0),
      cost: Number(product.cost || 0),
      qty: 0,
      selections: []
    };
    deliveryState.cart.push(item);
  }
  if (!item) return;
  const next = item.qty + diff;
  if (next <= 0) {
    deliveryState.cart = deliveryState.cart.filter((i) => i.lineId !== lineId);
  } else if (next > max) {
    alert(`Estoque máximo: ${max}`);
    return;
  } else {
    item.qty = next;
  }
  renderCart();
  renderProducts();
}

function buildComboSelections(product) {
  const groups = getComboGroups(product);
  const selections = [];
  for (const group of groups) {
    const selectedId = document.querySelector(`input[name="combo-${group.id}"]:checked`)?.value || "";
    const option = group.options.find((opt) => opt.productId === selectedId);
    const chosen = deliveryState.products.find((p) => p.id === selectedId);
    if (!option || !chosen) return null;
    if (getOptionRemaining(option) <= 0) return null;
    selections.push({
      groupId: group.id,
      groupName: group.name,
      productId: chosen.id,
      name: chosen.name,
      extraPrice: Number(option.extraPrice || 0),
      deductQty: optionDeductQty(option, chosen)
    });
  }
  return selections;
}

function renderComboModal(product) {
  const groups = getComboGroups(product);
  const box = document.getElementById("comboModalGroups");
  const title = document.getElementById("comboModalTitle");
  const hint = document.getElementById("comboModalHint");
  if (title) title.textContent = product.name;
  if (hint) hint.textContent = "Escolha um produto em cada grupo para montar o pedido.";
  if (!box) return;
  box.innerHTML = groups.map((group) => {
    const options = group.options.map((opt) => {
      const chosen = deliveryState.products.find((p) => p.id === opt.productId);
      if (!chosen) return "";
      const remaining = getOptionRemaining(opt);
      const extra = Number(opt.extraPrice || 0);
      const disabled = remaining <= 0 ? "disabled" : "";
      return `<label class="combo-option">
        <input type="radio" name="combo-${escapeHtml(group.id)}" value="${escapeHtml(opt.productId)}" ${disabled} />
        <span>${escapeHtml(chosen.name)}${remaining <= 0 ? " (sem estoque)" : ""}</span>
        <small>${extra > 0 ? `+ ${money(extra)}` : "incluso"}</small>
      </label>`;
    }).join("");
    return `<fieldset class="combo-choice"><strong>${escapeHtml(group.name)}</strong>${options}</fieldset>`;
  }).join("");
  box.querySelectorAll("input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => updateComboModalPrice(product));
  });
  groups.forEach((group) => {
    const first = box.querySelector(`input[name="combo-${CSS.escape(group.id)}"]:not(:disabled)`);
    if (first) first.checked = true;
  });
  updateComboModalPrice(product);
}

function updateComboModalPrice(product) {
  const priceEl = document.getElementById("comboModalPrice");
  const selections = buildComboSelections(product) || [];
  const price = typeof DeliveryLogic !== "undefined"
    ? DeliveryLogic.comboUnitPrice(product.price, selections)
    : Number(product.price || 0);
  if (priceEl) priceEl.textContent = selections.length === getComboGroups(product).length
    ? `Preço deste combo: ${money(price)}`
    : "Selecione uma opção em cada grupo.";
}

function openComboModal(product) {
  if (!productHasComboChoices(product)) {
    changeQty(product, 1);
    return;
  }
  const missing = getComboGroups(product).find((group) => !group.options.some((opt) => getOptionRemaining(opt) > 0));
  if (missing) {
    alert(`Sem estoque para escolher «${missing.name}».`);
    return;
  }
  deliveryState.comboProductId = product.id;
  renderComboModal(product);
  document.getElementById("comboModal")?.classList.remove("hidden");
}

function closeComboModal() {
  deliveryState.comboProductId = null;
  document.getElementById("comboModal")?.classList.add("hidden");
}

function confirmComboSelection() {
  const product = deliveryState.products.find((p) => p.id === deliveryState.comboProductId);
  if (!product) return;
  const selections = buildComboSelections(product);
  if (!selections || selections.length !== getComboGroups(product).length) {
    alert("Escolha um produto em cada grupo do combo.");
    return;
  }
  const over = selections.find((sel) => {
    const group = getComboGroups(product).find((item) => item.id === sel.groupId);
    const option = group?.options.find((opt) => opt.productId === sel.productId);
    return !option || getOptionRemaining(option) <= 0;
  });
  if (over) {
    alert(`Sem estoque para ${over.name}.`);
    return;
  }
  const lineId = DeliveryLogic.comboSelectionKey(product.id, selections);
  let item = deliveryState.cart.find((line) => line.lineId === lineId);
  if (!item) {
    item = {
      lineId,
      productId: product.id,
      name: product.name,
      code: product.code || "",
      price: DeliveryLogic.comboUnitPrice(product.price, selections),
      cost: Number(product.cost || 0),
      qty: 0,
      selections
    };
    deliveryState.cart.push(item);
  }
  if (getNormalizedDoseRecipe(product, deliveryState.products).length && getDeliveryProductAvailability(product) < 1) {
    alert("Estoque insuficiente para montar mais um combo.");
    return;
  }
  item.qty += 1;
  closeComboModal();
  renderCart();
  renderProducts();
}

function changeLineQty(lineId, diff) {
  const item = deliveryState.cart.find((line) => line.lineId === lineId);
  if (!item) return;
  const product = deliveryState.products.find((p) => p.id === item.productId);
  if (!product) return;
  if (diff > 0 && productHasComboChoices(product)) {
    const blocked = (item.selections || []).find((sel) => {
      const group = getComboGroups(product).find((entry) => entry.id === sel.groupId);
      const option = group?.options.find((opt) => opt.productId === sel.productId);
      return !option || getOptionRemaining(option, lineId) < item.qty + 1;
    });
    if (blocked) {
      alert(`Sem estoque para ${blocked.name}.`);
      return;
    }
  } else if (diff > 0 && !productHasComboChoices(product)) {
    const max = Math.max(0, Number(product.qty || 0) - getStockReserved(product.id, deliveryState.cart, lineId));
    if (item.qty + diff > max) {
      alert(`Estoque máximo: ${max}`);
      return;
    }
  }
  const next = item.qty + diff;
  if (next <= 0) deliveryState.cart = deliveryState.cart.filter((line) => line.lineId !== lineId);
  else item.qty = next;
  renderCart();
  renderProducts();
}

function syncDeliveryZoneSelects() {
  const zones = deliveryState.zonePricing?.zones || [];
  ["cartDeliveryZone", "checkoutDeliveryZone"].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = deliveryState.selectedZoneId || "";
    select.innerHTML = `<option value="">Selecione o bairro</option>${zones.map((zone) =>
      `<option value="${escapeHtml(zone.id)}" ${zone.id === current ? "selected" : ""}>${escapeHtml(zone.name)} — ${money(zone.fee)}</option>`
    ).join("")}`;
    select.value = current;
  });
  const show = (deliveryState.zonePricing?.mode === "zones") && zones.length > 0;
  document.getElementById("deliveryZoneBox")?.classList.toggle("hidden", !show);
  document.getElementById("checkoutZoneLabel")?.classList.toggle("hidden", !show);
}

function setDeliveryZone(zoneId) {
  deliveryState.selectedZoneId = zoneId || "";
  syncDeliveryZoneSelects();
  renderCart();
}

function renderCart() {
  const { subtotal, fee, total, minOrder, pricing } = getCartTotals();
  deliveryState.zonePricing = pricing;
  syncDeliveryZoneSelects();
  const count = deliveryState.cart.reduce((s, i) => s + i.qty, 0);
  const fab = document.getElementById("btnOpenCart");
  const list = document.getElementById("cartItems");

  if (count === 0) {
    fab?.classList.add("hidden");
    document.getElementById("cartPanel")?.classList.add("hidden");
  } else {
    fab?.classList.remove("hidden");
    document.getElementById("cartFabCount").textContent = String(count);
    document.getElementById("cartFabTotal").textContent = money(total);
  }

  list.innerHTML = deliveryState.cart.map((item) => {
    const choices = (item.selections || []).map((sel) =>
      `<small>${escapeHtml(sel.groupName)}: ${escapeHtml(sel.name)}</small>`
    ).join("");
    return `
    <li>
      <div>
        <span>${escapeHtml(item.name)} × ${item.qty}</span>
        ${choices ? `<div class="cart-item-choices">${choices}</div>` : ""}
      </div>
      <div class="cart-item-actions">
        <button type="button" data-line-diff="-1" data-line-id="${escapeHtml(item.lineId)}" aria-label="Diminuir">−</button>
        <button type="button" data-line-diff="1" data-line-id="${escapeHtml(item.lineId)}" aria-label="Aumentar">+</button>
        <strong>${money(item.price * item.qty)}</strong>
      </div>
    </li>`;
  }).join("");
  list.querySelectorAll("[data-line-id]").forEach((btn) => {
    btn.addEventListener("click", () => changeLineQty(btn.dataset.lineId, Number(btn.dataset.lineDiff)));
  });

  document.getElementById("cartSubtotal").textContent = money(subtotal);
  document.getElementById("cartTotal").textContent = money(total);
  const feeLine = document.getElementById("deliveryFeeLine");
  const feeLabel = document.getElementById("cartDeliveryFeeLabel");
  const zoneName = pricing?.zone?.name;
  if (pricing?.needsZone) {
    feeLine?.classList.remove("hidden");
    if (feeLabel) feeLabel.textContent = "Taxa entrega";
    document.getElementById("cartDeliveryFee").textContent = "escolha o bairro";
  } else if (fee > 0 || pricing?.mode === "zones") {
    feeLine?.classList.remove("hidden");
    if (feeLabel) feeLabel.textContent = zoneName ? `Taxa (${zoneName})` : "Taxa entrega";
    document.getElementById("cartDeliveryFee").textContent = money(fee);
  } else {
    feeLine?.classList.add("hidden");
  }

  const btnCheckout = document.getElementById("btnOpenCheckout");
  const belowMin = minOrder > 0 && subtotal < minOrder;
  if (btnCheckout) {
    btnCheckout.disabled = count === 0 || belowMin;
    btnCheckout.textContent = belowMin
      ? `Pedido mínimo ${money(minOrder)}`
      : "Finalizar pedido";
  }

  const warn = document.getElementById("checkoutMinWarning");
  if (warn) {
    if (pricing?.needsZone) {
      warn.textContent = "Selecione o bairro para o sistema calcular a taxa de entrega.";
      warn.classList.remove("hidden");
    } else if (belowMin) {
      warn.textContent = `Pedido mínimo: ${money(minOrder)}. Faltam ${money(minOrder - subtotal)}.`;
      warn.classList.remove("hidden");
    } else {
      warn.classList.add("hidden");
    }
  }
}

async function resumeOrderTrackingIfAny() {
  const orderId = loadTrackedOrderId();
  if (!orderId || !deliveryState.storeUid) return;
  startOrderTracking(orderId);
  const bar = document.getElementById("orderTrackBar");
  if (bar) {
    bar.classList.remove("hidden");
    setOrderTrackLayout(true);
  }
}

async function loadStore(slug) {
  deliveryState.storeSlug = slug;
  const publicSnap = await db.collection("storePublic").doc(slug).get();
  if (!publicSnap.exists) {
    showError("Loja não encontrada. Confira o link.");
    return false;
  }
  const data = publicSnap.data() || {};
  if (data.deliveryEnabled === false) {
    showError("Esta loja não está aceitando pedidos online no momento.");
    return false;
  }
  deliveryState.storeUid = data.uid;
  deliveryState.store = data;

  const nameEl = document.getElementById("storeName");
  const metaEl = document.getElementById("storeMeta");
  const logoEl = document.getElementById("storeLogo");
  if (nameEl) nameEl.textContent = data.name || "Loja";
  if (metaEl) {
    const parts = [];
    if (data.phone) parts.push(data.phone);
    if (data.address) parts.push(data.address);
    metaEl.textContent = parts.join(" · ") || "Delivery";
  }
  if (logoEl && data.logo) {
    logoEl.src = data.logo;
    logoEl.classList.remove("hidden");
  }

  const productsSnap = await db.collection("stores").doc(data.uid).collection("products").get();
  deliveryState.products = productsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  document.getElementById("deliveryApp")?.classList.remove("hidden");
  document.title = `${data.name || "Loja"} — Pedido online`;
  if (typeof window.applyWebAppBranding === "function") {
    window.applyWebAppBranding({ name: data.name || "" });
  }
  renderProducts();
  renderCart();
  await resumeOrderTrackingIfAny();
  return true;
}

async function submitOrder(e) {
  e.preventDefault();
  if (!deliveryState.cart.length || !deliveryState.storeUid) return;

  const { subtotal, fee, total, minOrder, pricing } = getCartTotals();
  if (pricing?.needsZone) {
    alert("Selecione o bairro para calcular a taxa de entrega.");
    return;
  }
  if (minOrder > 0 && subtotal < minOrder) {
    alert(`Pedido mínimo: ${money(minOrder)}`);
    return;
  }

  const customer = {
    name: document.getElementById("customerName").value.trim(),
    phone: document.getElementById("customerPhone").value.trim(),
    address: document.getElementById("customerAddress").value.trim(),
    notes: document.getElementById("customerNotes").value.trim()
  };
  if (!customer.name || !customer.phone || !customer.address) {
    alert("Preencha nome, telefone e endereço.");
    return;
  }

  const btn = document.getElementById("btnSubmitOrder");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  const items = deliveryState.cart.map((item) => ({
    productId: item.productId,
    name: item.name,
    code: item.code,
    price: item.price,
    cost: item.cost,
    qty: item.qty,
    subtotal: item.price * item.qty,
    selections: (item.selections || []).map((sel) => ({
      groupId: sel.groupId,
      groupName: sel.groupName,
      productId: sel.productId,
      name: sel.name,
      extraPrice: Number(sel.extraPrice || 0),
      deductQty: Number(sel.deductQty || 0)
    }))
  }));

  const order = {
    createdAt: new Date().toISOString(),
    status: "awaiting_approval",
    customer: {
      ...customer,
      district: pricing?.zone?.name || ""
    },
    items,
    subtotal,
    deliveryFee: fee,
    deliveryZoneId: pricing?.zone?.id || "",
    deliveryZoneName: pricing?.zone?.name || "",
    total,
    paymentMethod: document.getElementById("customerPayment").value,
    source: "delivery_web"
  };

  try {
    const batch = db.batch();
    const orderRef = db
      .collection("stores")
      .doc(deliveryState.storeUid)
      .collection("deliveryOrders")
      .doc();
    const statusRef = db
      .collection("stores")
      .doc(deliveryState.storeUid)
      .collection("deliveryOrderStatus")
      .doc(orderRef.id);
    const now = order.createdAt;
    batch.set(orderRef, order);
    batch.set(statusRef, {
      status: "awaiting_approval",
      createdAt: now,
      updatedAt: now
    });
    await batch.commit();
    const ref = { id: orderRef.id };

    deliveryState.cart = [];
    renderCart();
    renderProducts();
    document.getElementById("checkoutModal")?.classList.add("hidden");
    document.getElementById("checkoutForm")?.reset();

    const storeWhatsApp = getStoreWhatsAppNumber(deliveryState.store);
    const message = buildDeliveryOrderWhatsAppMessage({
      storeName: deliveryState.store?.name,
      orderId: ref.id,
      customer,
      items,
      subtotal,
      deliveryFee: fee,
      deliveryZoneName: order.deliveryZoneName,
      total,
      paymentMethod: order.paymentMethod
    });
    const whatsappUrl = getWhatsAppChatUrl(storeWhatsApp, message);
    let autoOpened = false;
    if (whatsappUrl) {
      autoOpened = openWhatsAppChat(storeWhatsApp, message);
    }
    showOrderSuccessModal(ref.id, whatsappUrl, autoOpened);
  } catch (err) {
    alert(`Não foi possível enviar o pedido: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar pedido";
  }
}

function setupUI() {
  document.getElementById("btnOpenCart")?.addEventListener("click", () => {
    document.getElementById("cartPanel")?.classList.remove("hidden");
  });
  document.getElementById("btnCloseCart")?.addEventListener("click", () => {
    document.getElementById("cartPanel")?.classList.add("hidden");
  });
  document.getElementById("btnOpenCheckout")?.addEventListener("click", () => {
    if (!deliveryState.cart.length) return;
    document.getElementById("cartPanel")?.classList.add("hidden");
    document.getElementById("checkoutModal")?.classList.remove("hidden");
  });
  document.getElementById("btnCancelCheckout")?.addEventListener("click", () => {
    document.getElementById("checkoutModal")?.classList.add("hidden");
  });
  document.getElementById("checkoutForm")?.addEventListener("submit", submitOrder);
  document.getElementById("btnCancelCombo")?.addEventListener("click", closeComboModal);
  document.getElementById("btnConfirmCombo")?.addEventListener("click", confirmComboSelection);
  document.getElementById("cartDeliveryZone")?.addEventListener("change", (e) => setDeliveryZone(e.target.value));
  document.getElementById("checkoutDeliveryZone")?.addEventListener("change", (e) => setDeliveryZone(e.target.value));
  document.getElementById("btnSuccessClose")?.addEventListener("click", () => {
    document.getElementById("successModal")?.classList.add("hidden");
    if (deliveryState.trackingOrderId) {
      document.getElementById("orderTrackBar")?.classList.remove("hidden");
      setOrderTrackLayout(true);
    }
  });
  document.getElementById("btnOpenOrderTrack")?.addEventListener("click", openOrderTrackModal);
}

async function initDelivery() {
  const slug = getStoreSlugFromUrl();
  if (!slug) {
    showError("Link inválido. Use o link enviado pela loja.");
    return;
  }
  if (!window.FIREBASE_CONFIG) {
    showError("Sistema não configurado.");
    return;
  }
  try {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    db = firebase.firestore();
  } catch (err) {
    showError(err.message || "Erro ao conectar.");
    return;
  }
  setupUI();
  setupMenuToolbar();
  await loadStore(slug);
}

if (!window.PDV_SKIP_DELIVERY_INIT) initDelivery();