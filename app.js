const state = {
  user: null,
  license: null,
  isAdmin: false,
  company: null,
  products: [],
  sales: [],
  pendingAccounts: [],
  cashSession: null,
  cashSessions: [],
  financeTransactions: [],
  deliveryOrders: [],
  deliveryUnsubscribe: null,
  deliveryListenerError: null,
  deliverySyncAt: null,
  activeDeliveryOrderId: null,
  knownDeliveryOrderIds: new Set(),
  cart: [],
  adminUsers: [],
  discountValue: 0,
  discountType: "R$", // "R$" ou "%"
  pendingAccountEdit: null,
  activeRegister: null,
  activeOperator: null,
  splitPayments: []
};

let db = null;
let auth = null;
let storage = null;

// ── Barcode scan buffer ──────────────────────────────────────────
let _barcodeBuffer = "";
let _barcodeTimer = null;
const BARCODE_TIMEOUT_MS = 80;
let pdvSearchHighlightIndex = -1;
const stockBulkPriceSelection = new Set();
let stockBulkSelectionRendering = false;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatMonthLabelPt(monthISO, { short = false } = {}) {
  if (!monthISO || !/^\d{4}-\d{2}$/.test(monthISO)) return "Sem data";
  const [y, m] = monthISO.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  const label = date.toLocaleDateString("pt-BR", short
    ? { month: "short", year: "numeric" }
    : { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function getSaleCreditPendingAmount(sale) {
  if (!sale || isSaleCancelled(sale)) return 0;
  if (sale.pendingStatus === "paid") return 0;
  if (sale.pendingStatus === "pending" || Number(sale.pendingAmount || 0) > 0) {
    const raw = sale.pendingAmount != null ? sale.pendingAmount : sale.total;
    return Math.max(0, roundMoney(raw));
  }
  return 0;
}

/** Pendências efetivas por venda (já desconta pagamentos parciais da conta), do mês/venda mais antigo ao mais novo. */
function getEffectivePendingSalesForAccount(account) {
  const accountKey = account?.customerKey || account?.id;
  if (!accountKey) return [];
  const pendingSales = state.sales
    .filter((sale) =>
      sale.pendingCustomerKey === accountKey
      && !isSaleCancelled(sale)
      && (sale.pendingStatus === "pending" || Number(sale.pendingAmount || 0) > 0)
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  const accountPending = Math.max(0, roundMoney(account.totalPending || 0));
  const gross = roundMoney(pendingSales.reduce((sum, sale) => sum + getSaleCreditPendingAmount(sale), 0));
  let alreadyCovered = Math.max(0, roundMoney(gross - accountPending));

  const rows = [];
  for (const sale of pendingSales) {
    let amount = getSaleCreditPendingAmount(sale);
    if (alreadyCovered > 0 && amount > 0) {
      const deduct = Math.min(amount, alreadyCovered);
      amount = roundMoney(amount - deduct);
      alreadyCovered = roundMoney(alreadyCovered - deduct);
    }
    if (amount > 0) {
      rows.push({
        sale,
        pendingAmount: amount,
        monthKey: toLocalMonthISO(sale.createdAt) || "sem-data"
      });
    }
  }
  return rows;
}

function groupEffectivePendingByMonth(effectiveRows) {
  const map = new Map();
  for (const row of effectiveRows) {
    const key = row.monthKey || "sem-data";
    if (!map.has(key)) {
      map.set(key, { monthKey: key, total: 0, sales: [] });
    }
    const group = map.get(key);
    group.total = roundMoney(group.total + row.pendingAmount);
    group.sales.push(row);
  }
  return [...map.values()].sort((a, b) => String(a.monthKey).localeCompare(String(b.monthKey)));
}

/** Aplica valor recebido nas vendas mais antigas primeiro; também sincroniza pendências após baixas só na conta. */
function buildPendingSettlementPlan(account, settleValue) {
  const accountKey = account?.customerKey || account?.id;
  if (!accountKey) return [];
  const pendingSales = state.sales
    .filter((sale) =>
      sale.pendingCustomerKey === accountKey
      && !isSaleCancelled(sale)
      && (sale.pendingStatus === "pending" || Number(sale.pendingAmount || 0) > 0)
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  const accountPending = Math.max(0, roundMoney(account.totalPending || 0));
  const gross = roundMoney(pendingSales.reduce((sum, sale) => sum + getSaleCreditPendingAmount(sale), 0));
  let alreadyCovered = Math.max(0, roundMoney(gross - accountPending));
  let left = Math.max(0, roundMoney(settleValue));

  return pendingSales.map((sale) => {
    let remaining = getSaleCreditPendingAmount(sale);
    if (alreadyCovered > 0 && remaining > 0) {
      const deduct = Math.min(remaining, alreadyCovered);
      remaining = roundMoney(remaining - deduct);
      alreadyCovered = roundMoney(alreadyCovered - deduct);
    }
    let paidNow = 0;
    if (left > 0 && remaining > 0) {
      paidNow = Math.min(remaining, left);
      remaining = roundMoney(remaining - paidNow);
      left = roundMoney(left - paidNow);
    }
    return {
      sale,
      paidNow,
      nextPending: remaining,
      nextStatus: remaining <= 0 ? "paid" : "pending"
    };
  });
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function compactSearch(value) {
  return normalizeSearch(value).replace(/[^a-z0-9]/g, "");
}

function scrollToPanel(el) {
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

const COLLAPSIBLE_GROUPS = {
  estoque: ["stockEntryFormCard", "replenishFormCard", "openBottleFormCard"]
};

function updateEstoqueToolOpenState() {
  const body = document.querySelector(".page-body--estoque");
  if (!body) return;
  const anyOpen = COLLAPSIBLE_GROUPS.estoque.some((id) => {
    const card = document.getElementById(id);
    return card && !card.classList.contains("collapsed");
  });
  body.classList.toggle("page-body--estoque-tool-open", anyOpen);
}

function focusPageSectionTop(cardEl) {
  const section = cardEl?.closest(".page-section");
  if (!section) return;
  requestAnimationFrame(() => {
    section.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function setCollapsiblePanel(cardId, expanded, options = {}) {
  const { group = null, scroll = true, onState = null, toggleId = null } = options;
  const card = document.getElementById(cardId);
  if (!card) return;

  if (expanded && group?.length) {
    group.forEach((id) => {
      if (id !== cardId) {
        setCollapsiblePanel(id, false, {
          scroll: false,
          onState: options.siblingState?.[id],
          toggleId: `${id.replace("Card", "Toggle")}`
        });
      }
    });
  }

  const toggle = document.getElementById(toggleId || `${cardId.replace("Card", "Toggle")}`);
  card.classList.toggle("collapsed", !expanded);
  card.classList.toggle("form-card--focus", expanded);
  if (toggle) toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (typeof onState === "function") onState(expanded);
  if (group === COLLAPSIBLE_GROUPS.estoque) updateEstoqueToolOpenState();
  if (expanded && scroll) focusPageSectionTop(card);
}

function getProductLabel(product) {
  const name = String(product?.name || "").trim();
  return name || `Produto ${product?.code || ""}`.trim();
}

function normalizeCategory(value) {
  return String(value || "").trim();
}

const CATEGORY_PATH_SEP = " › ";
const UNCATEGORIZED_CATEGORY_KEY = "__uncategorized__";

function getProductCategoryNodes() {
  return (Array.isArray(state.company?.productCategories) ? state.company.productCategories : [])
    .map((node) => ({
      id: String(node?.id || "").trim(),
      name: normalizeCategory(node?.name),
      parentId: node?.parentId ? String(node.parentId).trim() : null,
      order: Number(node?.order || 0)
    }))
    .filter((node) => node.id && node.name);
}

function findCategoryById(categoryId, nodes = getProductCategoryNodes()) {
  return nodes.find((n) => n.id === categoryId) || null;
}

function findCategoryByName(name, nodes = getProductCategoryNodes()) {
  const key = normalizeCategory(name).toLowerCase();
  if (!key) return null;
  return nodes.find((n) => n.name.toLowerCase() === key) || null;
}

function getCategoryChildren(parentId = null, nodes = getProductCategoryNodes()) {
  const pid = parentId || null;
  return nodes
    .filter((n) => (n.parentId || null) === pid)
    .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, "pt-BR"));
}

function buildCategoryTree(nodes = getProductCategoryNodes()) {
  const attach = (node) => ({
    ...node,
    children: getCategoryChildren(node.id, nodes).map(attach)
  });
  return getCategoryChildren(null, nodes).map(attach);
}

function getCategoryPathLabel(categoryId, nodes = getProductCategoryNodes()) {
  const parts = [];
  let current = findCategoryById(categoryId, nodes);
  let guard = 0;
  while (current && guard < 30) {
    parts.unshift(current.name);
    current = current.parentId ? findCategoryById(current.parentId, nodes) : null;
    guard += 1;
  }
  return parts.join(CATEGORY_PATH_SEP);
}

function resolveProductCategoryId(product) {
  if (!product) return null;
  const nodes = getProductCategoryNodes();
  if (product.categoryId && findCategoryById(product.categoryId, nodes)) {
    return product.categoryId;
  }
  const legacy = normalizeCategory(product.category);
  if (!legacy || legacy === "Sem categoria") return null;
  if (legacy.includes(CATEGORY_PATH_SEP)) {
    const parts = legacy.split(CATEGORY_PATH_SEP).map((p) => p.trim()).filter(Boolean);
    let parentId = null;
    let resolved = null;
    for (const part of parts) {
      const candidates = findCategoryNodesByName(part, nodes);
      resolved = candidates.find((n) => (n.parentId || null) === parentId) || candidates[0] || null;
      if (!resolved) break;
      parentId = resolved.id;
    }
    if (resolved) return resolved.id;
  }
  const byPath = nodes.find((n) => getCategoryPathLabel(n.id, nodes) === legacy);
  if (byPath) return byPath.id;
  const leafName = legacy.includes(CATEGORY_PATH_SEP)
    ? legacy.split(CATEGORY_PATH_SEP).pop().trim()
    : legacy;
  const matches = findCategoryNodesByName(leafName, nodes);
  if (getCervejasCategoryNode(nodes) && isCervejasSubcategoryName(leafName)) {
    const cervejas = getCervejasCategoryNode(nodes);
    const underParent = findCervejasSubcategoryNodes(leafName, nodes).find((n) => n.parentId === cervejas.id);
    if (underParent) return underParent.id;
  }
  if (getTabacariaCategoryNode(nodes) && isTabacariaSubcategoryName(leafName)) {
    const tabacaria = getTabacariaCategoryNode(nodes);
    const underParent = findTabacariaSubcategoryNodes(leafName, nodes).find((n) => n.parentId === tabacaria.id);
    if (underParent) return underParent.id;
  }
  const underParent = matches.find((n) => n.parentId);
  if (underParent) return underParent.id;
  return matches[0]?.id || null;
}

function getProductCategory(product) {
  const categoryId = resolveProductCategoryId(product);
  if (categoryId) return getCategoryPathLabel(categoryId) || "Sem categoria";
  return normalizeCategory(product?.category) || "Sem categoria";
}

function getDescendantCategoryIds(categoryId, nodes = getProductCategoryNodes()) {
  const ids = new Set([categoryId]);
  const walk = (parentId) => {
    getCategoryChildren(parentId, nodes).forEach((child) => {
      ids.add(child.id);
      walk(child.id);
    });
  };
  walk(categoryId);
  return ids;
}

function productMatchesCategoryFilter(product, filterCategoryId) {
  if (!filterCategoryId) return true;
  if (filterCategoryId === UNCATEGORIZED_CATEGORY_KEY) {
    return !resolveProductCategoryId(product);
  }
  const productCatId = resolveProductCategoryId(product);
  if (!productCatId) return false;
  return getDescendantCategoryIds(filterCategoryId).has(productCatId);
}

function getProductsInCategoryDirect(categoryId, products) {
  return products.filter((p) => resolveProductCategoryId(p) === categoryId);
}

function getProductsInCategorySubtree(categoryId, products) {
  const ids = getDescendantCategoryIds(categoryId);
  return products.filter((p) => {
    const productCatId = resolveProductCategoryId(p);
    return productCatId && ids.has(productCatId);
  });
}

function getProductCategorySelectOptions() {
  const options = [];
  const walk = (nodes, depth) => {
    nodes.forEach((node) => {
      const prefix = depth > 0 ? `${"\u00A0".repeat(depth * 3)}↳ ` : "";
      options.push({ id: node.id, label: `${prefix}${node.name}`, depth });
      walk(node.children || [], depth + 1);
    });
  };
  walk(buildCategoryTree(), 0);
  return options;
}

async function persistProductCategories(nodes) {
  const storeRef = getStoreRef();
  if (!storeRef) return;
  state.company = { ...state.company, productCategories: nodes };
  await storeRef.set({ productCategories: nodes }, { merge: true });
  try {
    await syncStorePublic(state.company);
  } catch (err) {
    console.warn("Publicar categorias no delivery:", err);
  }
}

async function syncProductCategoryLabelsOnProducts() {
  const storeRef = getStoreRef();
  if (!storeRef) return;
  const pending = [];
  state.products.forEach((product) => {
    const categoryId = resolveProductCategoryId(product);
    if (!categoryId) return;
    const label = getCategoryPathLabel(categoryId);
    if (product.category === label && product.categoryId === categoryId) return;
    product.categoryId = categoryId;
    product.category = label;
    pending.push(storeRef.collection("products").doc(product.id).set({
      categoryId,
      category: label
    }, { merge: true }));
  });
  if (pending.length) await Promise.all(pending);
}

function normalizeCategoryNameKey(name) {
  return normalizeCategory(name).toLowerCase();
}

const DESTILADOS_SUBCATEGORIES = ["Whisky", "Gin"];

const STORE_DESTILADOS_SUBCATEGORIES = {
  distribuidorabrothers: [
    "Whisky",
    "Gin",
    "Cachaça",
    "Dose Cachaça",
    "Vinho",
    "Conhaque",
    "Licor"
  ]
};

const STORE_CERVEJAS_SUBCATEGORIES = {
  distribuidorabrothers: [
    "Cerveja Lata",
    "Cerveja Long Neck",
    "Cerveja Caixa"
  ]
};

const STORE_TABACARIA_SUBCATEGORIES = {
  distribuidorabrothers: [
    "Cigarro",
    "Essência",
    "Palheiros",
    "Narguilé"
  ]
};

function normalizeCervejasSubcategoryKey(name) {
  return normalizeCategoryNameKey(name).replace(/^cervejas?\s+/, "cerveja ");
}

function findCervejasSubcategoryNodes(canonicalName, nodes = getProductCategoryNodes()) {
  const key = normalizeCervejasSubcategoryKey(canonicalName);
  return nodes.filter((n) => normalizeCervejasSubcategoryKey(n.name) === key);
}

function isCervejasSubcategoryName(name, subNames = getCervejasSubcategoryNames()) {
  const key = normalizeCervejasSubcategoryKey(name);
  return subNames.some((sub) => normalizeCervejasSubcategoryKey(sub) === key);
}

function normalizeTabacariaSubcategoryKey(name) {
  return normalizeStorePresetKey(name);
}

function findTabacariaSubcategoryNodes(canonicalName, nodes = getProductCategoryNodes()) {
  const key = normalizeTabacariaSubcategoryKey(canonicalName);
  return nodes.filter((n) => normalizeTabacariaSubcategoryKey(n.name) === key);
}

function isTabacariaSubcategoryName(name, subNames = getTabacariaSubcategoryNames()) {
  const key = normalizeTabacariaSubcategoryKey(name);
  return subNames.some((sub) => normalizeTabacariaSubcategoryKey(sub) === key);
}

function getTabacariaSubcategoryNames() {
  const presetKey = getStoreCategoryPresetKey();
  if (presetKey && STORE_TABACARIA_SUBCATEGORIES[presetKey]) {
    return [...STORE_TABACARIA_SUBCATEGORIES[presetKey]];
  }
  const slug = normalizeStorePresetKey(normalizeDeliverySlug(state.company?.deliverySlug));
  const name = normalizeStorePresetKey(state.company?.name);
  if (slug.includes("distribuidorabrothers") || name.includes("distribuidorabrothers") || name.includes("brothers")) {
    return [...STORE_TABACARIA_SUBCATEGORIES.distribuidorabrothers];
  }
  return [];
}

function getCervejasSubcategoryNames() {
  const presetKey = getStoreCategoryPresetKey();
  if (presetKey && STORE_CERVEJAS_SUBCATEGORIES[presetKey]) {
    return [...STORE_CERVEJAS_SUBCATEGORIES[presetKey]];
  }
  const slug = normalizeStorePresetKey(normalizeDeliverySlug(state.company?.deliverySlug));
  const name = normalizeStorePresetKey(state.company?.name);
  if (slug.includes("distribuidorabrothers") || name.includes("distribuidorabrothers") || name.includes("brothers")) {
    return [...STORE_CERVEJAS_SUBCATEGORIES.distribuidorabrothers];
  }
  return [];
}

function getDestiladosSubcategoryNames() {
  const presetKey = getStoreCategoryPresetKey();
  if (presetKey && STORE_DESTILADOS_SUBCATEGORIES[presetKey]) {
    return [...STORE_DESTILADOS_SUBCATEGORIES[presetKey]];
  }
  const slug = normalizeStorePresetKey(normalizeDeliverySlug(state.company?.deliverySlug));
  const name = normalizeStorePresetKey(state.company?.name);
  if (slug.includes("distribuidorabrothers") || name.includes("distribuidorabrothers")) {
    return [...STORE_DESTILADOS_SUBCATEGORIES.distribuidorabrothers];
  }
  return [...DESTILADOS_SUBCATEGORIES];
}

function findCategoryNodesByName(name, nodes = getProductCategoryNodes()) {
  const key = normalizeCategoryNameKey(name);
  return nodes.filter((n) => normalizeCategoryNameKey(n.name) === key);
}

function getDestiladosCategoryNode(nodes = getProductCategoryNodes()) {
  return nodes.find((n) => !n.parentId && normalizeCategoryNameKey(n.name) === "destilados") || null;
}

function getCervejasCategoryNode(nodes = getProductCategoryNodes()) {
  return nodes.find((n) => !n.parentId && normalizeCategoryNameKey(n.name) === "cervejas") || null;
}

function getTabacariaCategoryNode(nodes = getProductCategoryNodes()) {
  return nodes.find((n) => !n.parentId && normalizeCategoryNameKey(n.name) === "tabacaria") || null;
}

function reassignProductsToCategoryId(fromId, toId, nodes) {
  if (!fromId || !toId || fromId === toId) return false;
  let changed = false;
  state.products.forEach((product) => {
    const productCatId = product.categoryId || resolveProductCategoryId(product);
    if (productCatId !== fromId) return;
    product.categoryId = toId;
    product.category = getCategoryPathLabel(toId, nodes);
    changed = true;
  });
  return changed;
}

function dedupeCategoryNodes(nodes) {
  let changed = false;
  const removeIds = new Set();

  const dedupeUnderParent = (parent, subNames, findMatches) => {
    if (!parent) return;
    const finder = findMatches || ((name) => findCategoryNodesByName(name, nodes));
    subNames.forEach((name, order) => {
      const matches = finder(name).filter((n) => n.id !== parent.id);
      if (!matches.length) return;

      let canonical = matches.find((n) => n.parentId === parent.id);
      if (!canonical) {
        canonical = matches[0];
        if (canonical.parentId !== parent.id) {
          canonical.parentId = parent.id;
          changed = true;
        }
      }
      if (canonical.order !== order) {
        canonical.order = order;
        changed = true;
      }

      matches.forEach((node) => {
        if (node.id === canonical.id) return;
        if (reassignProductsToCategoryId(node.id, canonical.id, nodes)) changed = true;
        removeIds.add(node.id);
        changed = true;
      });
    });
  };

  dedupeUnderParent(getDestiladosCategoryNode(nodes), getDestiladosSubcategoryNames());
  dedupeUnderParent(
    getCervejasCategoryNode(nodes),
    getCervejasSubcategoryNames(),
    (name) => findCervejasSubcategoryNodes(name, nodes)
  );
  dedupeUnderParent(
    getTabacariaCategoryNode(nodes),
    getTabacariaSubcategoryNames(),
    (name) => findTabacariaSubcategoryNodes(name, nodes)
  );

  const grouped = new Map();
  nodes.forEach((node) => {
    if (removeIds.has(node.id)) return;
    const key = `${node.parentId || ""}::${normalizeCategoryNameKey(node.name)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  });
  grouped.forEach((group) => {
    if (group.length <= 1) return;
    const [canonical, ...dups] = group;
    dups.forEach((dup) => {
      if (reassignProductsToCategoryId(dup.id, canonical.id, nodes)) changed = true;
      removeIds.add(dup.id);
      changed = true;
    });
  });

  const nextNodes = removeIds.size ? nodes.filter((n) => !removeIds.has(n.id)) : nodes;
  return { nodes: nextNodes, changed };
}

function ensureParentSubcategories(nodes, parentName, subNames, findMatches) {
  let changed = false;
  const parentKey = normalizeCategoryNameKey(parentName);
  let parent = nodes.find((n) => !n.parentId && normalizeCategoryNameKey(n.name) === parentKey);
  if (!parent) {
    parent = {
      id: uid(),
      name: parentName,
      parentId: null,
      order: nodes.filter((n) => !n.parentId).length
    };
    nodes.push(parent);
    changed = true;
  }

  const finder = findMatches || ((name) => findCategoryNodesByName(name, nodes));
  subNames.forEach((name, order) => {
    const exists = finder(name).some((n) => n.parentId === parent.id);
    if (exists) return;
    const loose = finder(name).find((n) => n.id !== parent.id);
    if (loose) {
      if (loose.name !== name) {
        loose.name = name;
        changed = true;
      }
      if (loose.parentId !== parent.id) {
        loose.parentId = parent.id;
        changed = true;
      }
      if (loose.order !== order) {
        loose.order = order;
        changed = true;
      }
      return;
    }
    nodes.push({ id: uid(), name, parentId: parent.id, order });
    changed = true;
  });

  return { parent, changed };
}

function ensureDestiladosSubcategories(nodes) {
  const subNames = getDestiladosSubcategoryNames();
  if (!subNames.length) return { nodes, changed: false };
  const { changed: parentChanged } = ensureParentSubcategories(nodes, "Destilados", subNames);
  const deduped = dedupeCategoryNodes(nodes);
  return { nodes: deduped.nodes, changed: parentChanged || deduped.changed };
}

function ensureCervejasSubcategories(nodes) {
  const subNames = getCervejasSubcategoryNames();
  if (!subNames.length) return { nodes, changed: false };
  const { changed: parentChanged } = ensureParentSubcategories(
    nodes,
    "Cervejas",
    subNames,
    (name) => findCervejasSubcategoryNodes(name, nodes)
  );
  const deduped = dedupeCategoryNodes(nodes);
  return { nodes: deduped.nodes, changed: parentChanged || deduped.changed };
}

function ensureTabacariaSubcategories(nodes) {
  const subNames = getTabacariaSubcategoryNames();
  if (!subNames.length) return { nodes, changed: false };
  const { changed: parentChanged } = ensureParentSubcategories(
    nodes,
    "Tabacaria",
    subNames,
    (name) => findTabacariaSubcategoryNodes(name, nodes)
  );
  const deduped = dedupeCategoryNodes(nodes);
  return { nodes: deduped.nodes, changed: parentChanged || deduped.changed };
}

function reassignOrphanSubsAtRoot(nodes, parent, subNames, options = {}) {
  let changed = false;
  if (!parent) return changed;
  const matchesSub = options.matchSubName || (
    (nodeName, subName) => normalizeCategoryNameKey(nodeName) === normalizeCategoryNameKey(subName)
  );
  const findSubNodes = options.findSubNodes || ((name) => findCategoryNodesByName(name, nodes));
  state.products.forEach((product) => {
    const categoryId = product.categoryId || resolveProductCategoryId(product);
    if (!categoryId) return;
    const node = findCategoryById(categoryId, nodes);
    if (!node || node.parentId) return;
    const subName = subNames.find((name) => matchesSub(node.name, name));
    if (!subName) return;
    const canonical = findSubNodes(subName, nodes).find((n) => n.parentId === parent.id);
    if (!canonical || canonical.id === node.id) return;
    product.categoryId = canonical.id;
    product.category = getCategoryPathLabel(canonical.id, nodes);
    changed = true;
  });
  return changed;
}

function resolveLegacyCategoryNode(leafName, nodes) {
  const destilados = getDestiladosCategoryNode(nodes);
  const cervejas = getCervejasCategoryNode(nodes);
  const tabacaria = getTabacariaCategoryNode(nodes);
  const isDestiladosSub = destilados && getDestiladosSubcategoryNames().some(
    (name) => normalizeCategoryNameKey(name) === normalizeCategoryNameKey(leafName)
  );
  const isCervejasSub = cervejas && isCervejasSubcategoryName(leafName);
  const isTabacariaSub = tabacaria && isTabacariaSubcategoryName(leafName);
  if (isDestiladosSub) {
    const under = findCategoryNodesByName(leafName, nodes).find((n) => n.parentId === destilados.id);
    if (under) return under;
    const loose = findCategoryNodesByName(leafName, nodes).find((n) => n.id !== destilados.id);
    if (loose) {
      loose.parentId = destilados.id;
      return loose;
    }
    const created = { id: uid(), name: leafName, parentId: destilados.id, order: nodes.length };
    nodes.push(created);
    return created;
  }
  if (isCervejasSub) {
    const under = findCervejasSubcategoryNodes(leafName, nodes).find((n) => n.parentId === cervejas.id);
    if (under) return under;
    const loose = findCervejasSubcategoryNodes(leafName, nodes).find((n) => n.id !== cervejas.id);
    if (loose) {
      loose.parentId = cervejas.id;
      if (getCervejasSubcategoryNames().some((sub) => normalizeCervejasSubcategoryKey(sub) === normalizeCervejasSubcategoryKey(leafName))) {
        const canonical = getCervejasSubcategoryNames().find(
          (sub) => normalizeCervejasSubcategoryKey(sub) === normalizeCervejasSubcategoryKey(leafName)
        );
        if (canonical && loose.name !== canonical) loose.name = canonical;
      }
      return loose;
    }
    const canonicalName = getCervejasSubcategoryNames().find(
      (sub) => normalizeCervejasSubcategoryKey(sub) === normalizeCervejasSubcategoryKey(leafName)
    ) || leafName;
    const created = { id: uid(), name: canonicalName, parentId: cervejas.id, order: nodes.length };
    nodes.push(created);
    return created;
  }
  if (isTabacariaSub) {
    const under = findTabacariaSubcategoryNodes(leafName, nodes).find((n) => n.parentId === tabacaria.id);
    if (under) return under;
    const loose = findTabacariaSubcategoryNodes(leafName, nodes).find((n) => n.id !== tabacaria.id);
    if (loose) {
      loose.parentId = tabacaria.id;
      const canonical = getTabacariaSubcategoryNames().find(
        (sub) => normalizeTabacariaSubcategoryKey(sub) === normalizeTabacariaSubcategoryKey(leafName)
      );
      if (canonical && loose.name !== canonical) loose.name = canonical;
      return loose;
    }
    const canonicalName = getTabacariaSubcategoryNames().find(
      (sub) => normalizeTabacariaSubcategoryKey(sub) === normalizeTabacariaSubcategoryKey(leafName)
    ) || leafName;
    const created = { id: uid(), name: canonicalName, parentId: tabacaria.id, order: nodes.length };
    nodes.push(created);
    return created;
  }
  let node = findCategoryNodesByName(leafName, nodes)[0];
  if (!node) {
    node = { id: uid(), name: leafName, parentId: null, order: nodes.length };
    nodes.push(node);
  }
  return node;
}

async function ensureProductCategoryTree() {
  try {
    let nodes = getProductCategoryNodes();
    let changed = false;
    const wasEmpty = !nodes.length;
    if (wasEmpty) {
      getDefaultProductCategories().forEach((name, order) => {
        nodes.push({ id: uid(), name, parentId: null, order });
      });
      changed = true;
      const destiladosResult = ensureDestiladosSubcategories(nodes);
      nodes = destiladosResult.nodes;
      if (destiladosResult.changed) changed = true;

      const cervejasResult = ensureCervejasSubcategories(nodes);
      nodes = cervejasResult.nodes;
      if (cervejasResult.changed) changed = true;

      const tabacariaResult = ensureTabacariaSubcategories(nodes);
      nodes = tabacariaResult.nodes;
      if (tabacariaResult.changed) changed = true;
    }

    state.products.forEach((product) => {
      const categoryId = product.categoryId || resolveProductCategoryId(product);
      if (!categoryId) {
        const legacy = normalizeCategory(product.category);
        if (!legacy || legacy === "Sem categoria") return;
        const leafName = legacy.includes(CATEGORY_PATH_SEP)
          ? legacy.split(CATEGORY_PATH_SEP).pop().trim()
          : legacy;
        const beforeLen = nodes.length;
        resolveLegacyCategoryNode(leafName, nodes);
        if (nodes.length !== beforeLen) changed = true;
        return;
      }
      const node = findCategoryById(categoryId, nodes);
      if (!node) {
        const legacy = normalizeCategory(product.category);
        if (legacy && legacy !== "Sem categoria") {
          const leafName = legacy.includes(CATEGORY_PATH_SEP)
            ? legacy.split(CATEGORY_PATH_SEP).pop().trim()
            : legacy;
          const beforeLen = nodes.length;
          const resolved = resolveLegacyCategoryNode(leafName, nodes);
          if (resolved && (nodes.length !== beforeLen || product.categoryId !== resolved.id)) {
            product.categoryId = resolved.id;
            product.category = getCategoryPathLabel(resolved.id, nodes);
            changed = true;
          }
        }
      }
    });

    const destilados = getDestiladosCategoryNode(nodes);
    if (reassignOrphanSubsAtRoot(nodes, destilados, getDestiladosSubcategoryNames())) changed = true;

    const cervejas = getCervejasCategoryNode(nodes);
    if (reassignOrphanSubsAtRoot(nodes, cervejas, getCervejasSubcategoryNames(), {
      matchSubName: (nodeName, subName) => (
        normalizeCervejasSubcategoryKey(nodeName) === normalizeCervejasSubcategoryKey(subName)
      ),
      findSubNodes: (name) => findCervejasSubcategoryNodes(name, nodes)
    })) changed = true;

    const tabacaria = getTabacariaCategoryNode(nodes);
    if (reassignOrphanSubsAtRoot(nodes, tabacaria, getTabacariaSubcategoryNames(), {
      matchSubName: (nodeName, subName) => (
        normalizeTabacariaSubcategoryKey(nodeName) === normalizeTabacariaSubcategoryKey(subName)
      ),
      findSubNodes: (name) => findTabacariaSubcategoryNodes(name, nodes)
    })) changed = true;

    if (changed) {
      state.company = { ...state.company, productCategories: nodes };
      await persistProductCategories(nodes);
      await syncProductCategoryLabelsOnProducts();
    }
  } catch (err) {
    console.error("ensureProductCategoryTree:", err);
  }
}

function expandCategoryPathTo(categoryId, view = "products") {
  if (!categoryId || categoryId === UNCATEGORIZED_CATEGORY_KEY) return;
  let current = findCategoryById(categoryId);
  while (current) {
    expandedCategoryGroups[view]?.add(current.id);
    current = current.parentId ? findCategoryById(current.parentId) : null;
  }
}

async function findOrCreateProductCategoryNode(name, parentId = null) {
  const normalized = normalizeCategory(name);
  if (!normalized) return null;
  const parent = parentId || null;
  const nodes = getProductCategoryNodes();
  const existing = nodes.find(
    (n) => n.name.toLowerCase() === normalized.toLowerCase() && (n.parentId || null) === parent
  );
  if (existing) return existing.id;
  const node = {
    id: uid(),
    name: normalized,
    parentId: parent,
    order: nodes.filter((n) => (n.parentId || null) === parent).length
  };
  nodes.push(node);
  await persistProductCategories(nodes);
  return node.id;
}

async function addProductCategoryNode(name, parentId = null) {
  return findOrCreateProductCategoryNode(name, parentId);
}

function refreshCategoryUI() {
  renderCategoryTreeManager();
  renderProductCategoryFilter();
  renderProductCategorySuggestions();
  renderProducts(document.getElementById("searchProduct")?.value || "", getProductCategoryFilter());
  if (typeof renderStock === "function") {
    renderStock(document.getElementById("stockSearch")?.value || "");
  }
}

async function uncategorizeProductsInCategoryIds(categoryIds) {
  const storeRef = getStoreRef();
  if (!storeRef || !categoryIds?.length) return;
  const ids = new Set(categoryIds);
  const updates = [];
  state.products.forEach((product) => {
    const catId = resolveProductCategoryId(product);
    if (!catId || !ids.has(catId)) return;
    product.categoryId = "";
    product.category = "";
    updates.push(product.id);
  });
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch();
    updates.slice(i, i + 400).forEach((productId) => {
      batch.set(storeRef.collection("products").doc(productId), { categoryId: "", category: "" }, { merge: true });
    });
    await batch.commit();
  }
}

function renderCategoryTreeManager() {
  const root = document.getElementById("categoryTreeManager");
  if (!root) return;
  const tree = buildCategoryTree();
  if (!tree.length) {
    root.innerHTML = `<p class="category-tree-empty">Nenhuma categoria cadastrada. Clique em «+ Categoria principal».</p>`;
    return;
  }
  const renderNodes = (nodes, depth) => nodes.map((node) => `
    <div class="category-manage-row" style="--cat-depth:${depth}">
      <span class="category-manage-name">${escapeHtml(node.name)}</span>
      <div class="category-manage-actions">
        <button type="button" class="btn btn-cash-sm" onclick="addSubCategory('${node.id}')">+ Subcategoria</button>
        <button type="button" class="btn btn-cash-sm" onclick="renameCategory('${node.id}')">Editar</button>
        <button type="button" class="btn btn-cash-sm danger" onclick="deleteCategory('${node.id}')">Excluir</button>
      </div>
    </div>
    ${renderNodes(node.children || [], depth + 1)}
  `).join("");
  root.innerHTML = renderNodes(tree, 0);
}

window.addSubCategory = async (parentId) => {
  const name = prompt("Nome da subcategoria:");
  if (!name?.trim()) return;
  const id = await addProductCategoryNode(name.trim(), parentId);
  if (!id) return;
  refreshCategoryUI();
};

window.renameCategory = async (categoryId) => {
  const node = findCategoryById(categoryId);
  if (!node) return;
  const name = prompt("Novo nome da categoria:", node.name);
  if (!name?.trim() || normalizeCategory(name) === node.name) return;
  const nodes = getProductCategoryNodes();
  const parent = node.parentId || null;
  const normalized = normalizeCategory(name);
  if (nodes.some((n) => n.id !== categoryId && n.name.toLowerCase() === normalized.toLowerCase() && (n.parentId || null) === parent)) {
    alert("Já existe categoria com este nome neste nível.");
    return;
  }
  const idx = nodes.findIndex((n) => n.id === categoryId);
  if (idx < 0) return;
  nodes[idx] = { ...nodes[idx], name: normalized };
  await persistProductCategories(nodes);
  await syncProductCategoryLabelsOnProducts();
  setProductCategoryFormValue(categoryId);
  refreshCategoryUI();
};

window.deleteCategory = async (categoryId) => {
  const nodes = getProductCategoryNodes();
  const node = findCategoryById(categoryId, nodes);
  if (!node) return;
  const ids = [...getDescendantCategoryIds(categoryId, nodes)];
  const productCount = state.products.filter((p) => ids.includes(resolveProductCategoryId(p))).length;
  const childCount = Math.max(0, ids.length - 1);
  let msg = `Excluir a categoria «${node.name}»?`;
  if (childCount > 0) msg += `\n\nTambém serão excluídas ${childCount} subcategoria(s).`;
  if (productCount > 0) msg += `\n\n${productCount} produto(s) ficarão sem categoria.`;
  if (!confirm(msg)) return;
  try {
    await uncategorizeProductsInCategoryIds(ids);
    await persistProductCategories(nodes.filter((n) => !ids.includes(n.id)));
    ids.forEach((id) => {
      expandedCategoryGroups.products.delete(id);
      expandedCategoryGroups.stock.delete(id);
    });
    if (ids.includes(getProductCategoryFormValue())) {
      setProductCategoryFormValue("");
    }
    refreshCategoryUI();
  } catch (error) {
    alert(`Erro ao excluir categoria: ${error.message}`);
  }
};

window.addRootCategory = async () => {
  const name = prompt("Nome da categoria principal:");
  if (!name?.trim()) return;
  const id = await addProductCategoryNode(name.trim(), null);
  if (!id) return;
  refreshCategoryUI();
};

window.editSelectedProductCategory = async () => {
  const categoryId = getProductCategoryFormValue();
  if (!categoryId) {
    alert("Selecione a categoria que deseja editar.");
    return;
  }
  await window.renameCategory(categoryId);
};

window.deleteSelectedProductCategory = async () => {
  const categoryId = getProductCategoryFormValue();
  if (!categoryId) {
    alert("Selecione a categoria que deseja excluir.");
    return;
  }
  await window.deleteCategory(categoryId);
};

function setupCategoryManager() {
  document.getElementById("categoryManagerToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    const card = document.getElementById("categoryManagerCard");
    const willOpen = Boolean(card?.classList.contains("collapsed"));
    setCollapsiblePanel("categoryManagerCard", willOpen, {
      toggleId: "categoryManagerToggle",
      scroll: false
    });
    if (willOpen) {
      requestAnimationFrame(() => card?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  });
  document.getElementById("btnAddRootCategory")?.addEventListener("click", (e) => {
    e.stopPropagation();
    window.addRootCategory();
  });
  renderCategoryTreeManager();
}

function normalizePersonKey(value) {
  return normalizeSearch(String(value || "")).replace(/[^a-z0-9]/g, "");
}

function getPendingCustomerName(rawName) {
  const clean = String(rawName || "").trim();
  return clean || "";
}

function getPendingCustomerKey(rawName) {
  return normalizePersonKey(getPendingCustomerName(rawName));
}

function getProductExpiryIso(product) {
  const value = String(product?.expiryDate || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function getDaysUntilIso(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) return null;
  const today = todayISO();
  const [ty, tm, td] = today.split("-").map(Number);
  const [ey, em, ed] = isoDate.split("-").map(Number);
  const t0 = Date.UTC(ty, tm - 1, td);
  const e0 = Date.UTC(ey, em - 1, ed);
  return Math.round((e0 - t0) / 86400000);
}

function getProductExpiryMeta(product) {
  const expiryIso = getProductExpiryIso(product);
  if (!expiryIso) return null;
  const daysLeft = getDaysUntilIso(expiryIso);
  if (daysLeft == null) return null;
  const [y, m, d] = expiryIso.split("-").map(Number);
  const dateBr = new Date(y, m - 1, d).toLocaleDateString("pt-BR");
  return { expiryIso, daysLeft, dateBr };
}

function getExpiryAlertProducts() {
  return state.products
    .map((product) => ({ product, meta: getProductExpiryMeta(product) }))
    .filter(({ meta }) => meta && meta.daysLeft >= 0 && meta.daysLeft <= 5);
}

function getMinStock(product) {
  return Math.max(0, Number(product?.minStock || 0));
}

function getStockStatus(product) {
  if (isDoseProduct(product)) {
    const doses = getMaxCartQty(product.id);
    const min = getMinStock(product);
    if (doses <= 0) return { key: "out", label: "Sem estoque" };
    if (min > 0 && doses <= min) return { key: "low", label: "Baixo" };
    return { key: "normal", label: "Normal" };
  }
  const qty = Math.max(0, Number(product?.qty || 0));
  const min = getMinStock(product);
  if (qty <= 0) {
    return { key: "out", label: "Sem estoque" };
  }
  if (qty <= min) {
    return { key: "low", label: "Baixo" };
  }
  return { key: "normal", label: "Normal" };
}

const STOCK_STATUS_ORDER = { out: 0, low: 1, normal: 2 };

function compareStockPriority(a, b) {
  const orderA = STOCK_STATUS_ORDER[getStockStatus(a).key] ?? 9;
  const orderB = STOCK_STATUS_ORDER[getStockStatus(b).key] ?? 9;
  if (orderA !== orderB) return orderA - orderB;
  return getProductLabel(a).localeCompare(getProductLabel(b), "pt-BR");
}

function sortProductsByStockPriority(products) {
  return [...products].sort(compareStockPriority);
}

const expandedCategoryGroups = {
  products: new Set(),
  stock: new Set()
};

function groupProductsByCategory(products) {
  const byCategory = products.reduce((acc, product) => {
    const key = getProductCategory(product);
    if (!acc[key]) acc[key] = [];
    acc[key].push(product);
    return acc;
  }, {});
  return Object.keys(byCategory)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .map((name) => ({
      name,
      items: sortProductsByStockPriority(byCategory[name])
    }));
}

function getCategoryAlertCount(products) {
  return products.filter((p) => {
    const key = getStockStatus(p).key;
    return key === "out" || key === "low";
  }).length;
}

function isCategoryExpanded(view, categoryName, autoExpand) {
  if (autoExpand) return true;
  return expandedCategoryGroups[view]?.has(categoryName) ?? false;
}

window.toggleCategoryFromEl = (el) => {
  const view = el.dataset.categoryView;
  const id = el.dataset.categoryId
    ? decodeURIComponent(el.dataset.categoryId)
    : decodeURIComponent(el.dataset.categoryName || "");
  if (!view || !id || !expandedCategoryGroups[view]) return;
  if (expandedCategoryGroups[view].has(id)) expandedCategoryGroups[view].delete(id);
  else expandedCategoryGroups[view].add(id);
  if (view === "products") {
    renderProducts(
      document.getElementById("searchProduct")?.value || "",
      getProductCategoryFilter()
    );
  } else if (view === "stock") {
    renderStock(document.getElementById("stockSearch")?.value || "");
  }
};

function renderStockStatusBadge(product) {
  const status = getStockStatus(product);
  return `<span class="stock-status status-${status.key}">${status.label}</span>`;
}

function renderProductExpiryBadge(product) {
  if (!product?.hasExpiry) return '<span class="expiry-chip">Não controla</span>';
  const meta = getProductExpiryMeta(product);
  if (!meta) return '<span class="expiry-chip">Sem validade</span>';
  if (meta.daysLeft < 0) return `<span class="expiry-chip expiry-chip--expired">Vencido (${meta.dateBr})</span>`;
  if (meta.daysLeft <= 5) return `<span class="expiry-chip expiry-chip--warning">Vence em ${meta.daysLeft}d (${meta.dateBr})</span>`;
  return `<span class="expiry-chip expiry-chip--ok">${meta.dateBr}</span>`;
}

function getStockAlertProducts() {
  return state.products.filter((p) => {
    const key = getStockStatus(p).key;
    return key === "low" || key === "out";
  });
}

function updateStockNavAlert() {
  const btn = document.getElementById("navEstoqueBtn");
  const dot = document.getElementById("navEstoqueAlert");
  if (!btn || !dot) return;

  const alerts = getStockAlertProducts();
  const count = alerts.length;
  if (count > 0) {
    const hasOut = alerts.some((p) => getStockStatus(p).key === "out");
    btn.classList.add("has-stock-alert");
    btn.classList.toggle("has-stock-alert-out", hasOut);
    dot.hidden = false;
    dot.setAttribute("aria-hidden", "false");
    const label = `${count} produto(s) com estoque baixo ou zerado`;
    dot.title = label;
    dot.setAttribute("aria-label", label);
  } else {
    btn.classList.remove("has-stock-alert", "has-stock-alert-out");
    dot.hidden = true;
    dot.setAttribute("aria-hidden", "true");
    dot.removeAttribute("title");
    dot.removeAttribute("aria-label");
  }
}

function getProductCategoryFilter() {
  return String(document.getElementById("filterProductCategory")?.value || "").trim();
}

const DEFAULT_PRODUCT_CATEGORIES = [
  "Cervejas",
  "Destilados",
  "Vinhos",
  "Refrigerantes",
  "Energéticos",
  "Doses"
];

const STOCK_MODE_UNIT = "unit";
const STOCK_MODE_ML = "ml";
const STOCK_MODE_DOSE = "dose";

function getProductStockMode(product) {
  const mode = String(product?.stockMode || STOCK_MODE_UNIT);
  if (mode === STOCK_MODE_ML || mode === STOCK_MODE_DOSE) return mode;
  return STOCK_MODE_UNIT;
}

function isMlStockProduct(product) {
  return getProductStockMode(product) === STOCK_MODE_ML;
}

function isDoseProduct(product) {
  return getProductStockMode(product) === STOCK_MODE_DOSE;
}

function isSellableProduct(product) {
  if (!product) return false;
  if (isMlStockProduct(product)) return false;
  return getMaxCartQty(product.id) > 0;
}

function isUnitStockProduct(product) {
  return getProductStockMode(product) === STOCK_MODE_UNIT;
}

function isValidDoseIngredient(product) {
  if (!product || isDoseProduct(product)) return false;
  return isMlStockProduct(product) || isUnitStockProduct(product);
}

function getDoseRecipeComponentPerDose(comp, ingredient) {
  if (!ingredient || !comp?.productId) return 0;
  if (isMlStockProduct(ingredient)) return Math.max(0, Number(comp.ml || 0));
  if (isUnitStockProduct(ingredient)) return Math.max(0, Number(comp.qty > 0 ? comp.qty : 1));
  return 0;
}

function getBottleVolumeMl(product) {
  return Math.max(0, Number(product?.bottleVolumeMl || 0));
}

function normalizeInsumoOptions(row) {
  const options = (Array.isArray(row?.options) ? row.options : []).map((opt) => {
    const productId = String(opt?.productId || "").trim();
    if (!productId) return null;
    return {
      productId,
      extraPrice: Math.max(0, Number(opt?.extraPrice || 0))
    };
  }).filter(Boolean);
  return {
    choiceId: String(row?.choiceId || "").trim(),
    choiceName: String(row?.choiceName || "").trim(),
    options
  };
}

function getDoseRecipe(product) {
  if (!isDoseProduct(product)) return [];
  return (product?.doseRecipe || [])
    .map((row) => {
      const productId = String(row?.productId || "").trim();
      if (!productId) return null;
      const ml = Math.max(0, Number(row?.ml || 0));
      const qty = Math.max(0, Math.floor(Number(row?.qty || 0)));
      const choices = normalizeInsumoOptions(row);
      const ingredient = state.products.find((p) => p.id === productId);
      const serving = typeof DeliveryLogic !== "undefined" && typeof DeliveryLogic.componentServingAmount === "function"
        ? DeliveryLogic.componentServingAmount(row, ingredient)
        : null;
      if (serving) return { productId, ml: serving.ml, qty: serving.qty, ...choices };
      if (ingredient) {
        if (isMlStockProduct(ingredient) && ml > 0) return { productId, ml, qty: 0, ...choices };
        if (isUnitStockProduct(ingredient)) return { productId, ml: 0, qty: qty > 0 ? qty : 1, ...choices };
      }
      if (ml > 0) return { productId, ml, qty: 0, ...choices };
      if (qty > 0) return { productId, ml: 0, qty, ...choices };
      return null;
    })
    .filter(Boolean);
}

function formatMlQty(ml) {
  const value = Math.max(0, Number(ml || 0));
  if (value >= 1000) {
    const liters = value / 1000;
    return `${liters % 1 === 0 ? liters.toFixed(0) : liters.toFixed(1)} L`;
  }
  return `${Math.round(value)} ml`;
}

function formatStockQty(product) {
  if (!product) return "0";
  if (isMlStockProduct(product)) return formatMlQty(product.qty);
  if (isDoseProduct(product)) {
    const doses = getMaxCartQty(product.id);
    return `${doses} dose${doses === 1 ? "" : "s"}`;
  }
  return String(Math.max(0, Number(product.qty || 0)));
}

function getCartIngredientUsage(cart, excludeLine = null) {
  const usage = new Map();
  (cart || []).forEach((item) => {
    if (excludeLine && item.productId === excludeLine.productId && item.priceType === excludeLine.priceType) return;
    const product = state.products.find((p) => p.id === item.productId);
    if (!product) return;
    resolveStockDeductionsForLineItem(product, item.qty).forEach((amt, productId) => {
      usage.set(productId, (usage.get(productId) || 0) + amt);
    });
  });
  return usage;
}

function resolveStockDeductionsForLineItem(product, qty, selections) {
  const map = new Map();
  const amount = Math.max(0, Number(qty || 0));
  if (!amount || !product) return map;
  if (isDoseProduct(product)) {
    const replaced = new Set(
      (selections || []).flatMap((sel) => [
        String(sel?.replacesProductId || "").trim(),
        ...((Array.isArray(sel?.replacesProductIds) ? sel.replacesProductIds : []).map((id) => String(id || "").trim()))
      ]).filter(Boolean)
    );
    if (typeof DeliveryLogic !== "undefined" && typeof DeliveryLogic.comboChoicesFromProduct === "function") {
      DeliveryLogic.comboChoicesFromProduct(product, (id) => state.products.find((item) => item.id === id))
        .forEach((group) => {
          const chosen = (selections || []).some((sel) => sel.groupId === group.id || (group.options || []).some((opt) => opt.productId === sel.productId));
          if (!chosen) return;
          (group.replacesProductIds || []).forEach((id) => replaced.add(id));
          (group.options || []).forEach((opt) => replaced.add(opt.productId));
          if (group.replacesProductId) replaced.add(group.replacesProductId);
        });
    }
    getDoseRecipe(product).forEach((comp) => {
      if (replaced.has(comp.productId)) return;
      const ingredient = state.products.find((p) => p.id === comp.productId);
      const perDose = getDoseRecipeComponentPerDose(comp, ingredient);
      if (perDose > 0) {
        map.set(comp.productId, (map.get(comp.productId) || 0) + perDose * amount);
      }
    });
    return map;
  }
  if (isMlStockProduct(product)) {
    const perUnit = getBottleVolumeMl(product) || amount;
    map.set(product.id, (map.get(product.id) || 0) + perUnit * amount);
    return map;
  }
  map.set(product.id, (map.get(product.id) || 0) + amount);
  return map;
}

function selectionDeductAmount(sel) {
  const qty = Math.max(0, Number(sel?.deductQty || 0));
  return qty > 0 ? qty : 1;
}

function resolveStockDeductionsFromSaleItems(items) {
  const map = new Map();
  (items || []).forEach((item) => {
    const product = state.products.find((p) => p.id === item.productId);
    if (product) {
      resolveStockDeductionsForLineItem(product, item.qty, item.selections).forEach((amt, productId) => {
        map.set(productId, (map.get(productId) || 0) + amt);
      });
    }
    const lineQty = Math.max(0, Number(item.qty || 0));
    (item.selections || []).forEach((sel) => {
      const productId = String(sel?.productId || "").trim();
      const per = selectionDeductAmount(sel);
      if (!productId || lineQty <= 0 || per <= 0) return;
      map.set(productId, (map.get(productId) || 0) + per * lineQty);
    });
  });
  return map;
}

function getMaxCartQty(productId, priceType = "retail", cart = state.cart) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return 0;
  const excludeLine = { productId, priceType };
  const cartWithoutLine = cart.filter((i) => !(i.productId === productId && i.priceType === priceType));

  if (isDoseProduct(product)) {
    const recipe = getDoseRecipe(product);
    const groups = typeof DeliveryLogic !== "undefined" && typeof DeliveryLogic.comboChoicesFromProduct === "function"
      ? DeliveryLogic.comboChoicesFromProduct(product, (id) => state.products.find((item) => item.id === id))
      : [];
    const choiceIds = new Set();
    groups.forEach((group) => {
      (group.replacesProductIds || []).forEach((id) => choiceIds.add(id));
      (group.options || []).forEach((opt) => choiceIds.add(opt.productId));
      if (group.replacesProductId) choiceIds.add(group.replacesProductId);
    });
    const fixed = recipe.filter((comp) => !choiceIds.has(comp.productId) && !(comp.options || []).length);
    if (!fixed.length && !groups.length) return 0;
    const usage = getCartIngredientUsage(cartWithoutLine);
    let maxDoses = Infinity;
    for (const comp of fixed) {
      const ingredient = state.products.find((p) => p.id === comp.productId);
      const perDose = getDoseRecipeComponentPerDose(comp, ingredient);
      if (!ingredient || perDose <= 0) return 0;
      const available = Number(ingredient.qty || 0) - (usage.get(comp.productId) || 0);
      maxDoses = Math.min(maxDoses, Math.floor(available / perDose));
    }
    const choicesAvailable = groups.every((group) => group.options.some((opt) => {
      const ingredient = state.products.find((p) => p.id === opt.productId);
      const per = Math.max(1, Number(opt.qty || 1));
      return ingredient && Number(ingredient.qty || 0) >= per;
    }));
    if (!choicesAvailable) return 0;
    if (!fixed.length) return 99;
    return Math.max(0, maxDoses === Infinity ? 0 : maxDoses);
  }

  if (isMlStockProduct(product)) return 0;

  const reserved = cartWithoutLine
    .filter((i) => i.productId === productId)
    .reduce((sum, i) => sum + Number(i.qty || 0), 0);
  return Math.max(0, Number(product.qty || 0) - reserved);
}

function getStockDeductionLabel(product, amount) {
  if (isMlStockProduct(product)) return formatMlQty(amount);
  return String(amount);
}

const STORE_CATEGORY_PRESETS = {
  distribuidorabrothers: [
    "Cervejas",
    "Destilados",
    "Refrigerantes",
    "Energéticos",
    "Doses",
    "Tabacaria"
  ]
};

function normalizeStorePresetKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function getStoreCategoryPresetKey() {
  const sources = [
    slugFromEmail(state.user?.email),
    normalizeDeliverySlug(state.company?.deliverySlug),
    normalizeDeliverySlug(state.company?.name),
    String(state.user?.email || "").split("@")[0]
  ].filter(Boolean);
  for (const source of sources) {
    const normalized = normalizeStorePresetKey(source);
    for (const presetKey of Object.keys(STORE_CATEGORY_PRESETS)) {
      const presetNorm = normalizeStorePresetKey(presetKey);
      if (normalized === presetNorm || normalized.includes(presetNorm)) {
        return presetKey;
      }
    }
  }
  return null;
}

const BROTHERS_MANAGER_PASSWORD_DEFAULT = "24262820@@";
const RESTRICTED_TAB_LABELS = {
  relatoriosTab: "Relatórios",
  financeiroTab: "Caixa Geral"
};
let managerPasswordResolve = null;

function isDistribuidoraBrothersStore() {
  if (getStoreCategoryPresetKey() === "distribuidorabrothers") return true;
  const slug = normalizeStorePresetKey(normalizeDeliverySlug(state.company?.deliverySlug || ""));
  const name = normalizeStorePresetKey(state.company?.name || "");
  const emailLocal = normalizeStorePresetKey(String(state.user?.email || "").split("@")[0]);
  return [slug, name, emailLocal].some(
    (s) => s.includes("distribuidorabrothers") || s.includes("brothers")
  );
}

function isBrothersDeployment() {
  const projectId = String(window.FIREBASE_CONFIG?.projectId || "").toLowerCase();
  if (projectId === "adega-brothers") return true;
  return isDistribuidoraBrothersStore();
}

function requiresManagerPassword() {
  if (state.isAdmin) return false;
  return !!state.company?.managerAreaPasswordEnabled;
}

function getManagerUnlockKey() {
  const uid = state.user?.uid || "";
  const opId = state.activeOperator?.id || "";
  return `managerAreaUnlock_${uid}_${opId || "loja"}`;
}

function getManagerAreaPassword() {
  const fromCompany = String(state.company?.managerAreaPassword || "").trim();
  if (fromCompany) return fromCompany;
  if (state.company?.managerAreaPasswordEnabled && isBrothersDeployment()) {
    return BROTHERS_MANAGER_PASSWORD_DEFAULT;
  }
  return "";
}

function syncManagerAreaLockUI() {
  const enabled = !!document.getElementById("companyManagerAreaLock")?.checked;
  const pwdWrap = document.getElementById("companyManagerAreaPasswordWrap");
  const pwdInput = document.getElementById("companyManagerAreaPassword");
  if (pwdWrap) pwdWrap.classList.toggle("hidden", !enabled);
  if (pwdInput) pwdInput.required = enabled && !String(state.company?.managerAreaPassword || "").trim();
  updateRestrictedNavUI();
}

function hasManagerAreaAccess() {
  if (!requiresManagerPassword()) return true;
  return sessionStorage.getItem(getManagerUnlockKey()) === "1";
}

function setManagerAreaAccess(unlocked) {
  const key = getManagerUnlockKey();
  if (unlocked) sessionStorage.setItem(key, "1");
  else sessionStorage.removeItem(key);
}

function clearAllManagerAreaAccess() {
  if (!state.user?.uid) return;
  const prefix = `managerAreaUnlock_${state.user.uid}_`;
  const toRemove = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (k && k.startsWith(prefix)) toRemove.push(k);
  }
  toRemove.forEach((k) => sessionStorage.removeItem(k));
}

function isRestrictedTab(tabId) {
  return tabId === "relatoriosTab" || tabId === "financeiroTab";
}

function showManagerPasswordModal(areaLabel) {
  return new Promise((resolve) => {
    managerPasswordResolve = resolve;
    const modal = document.getElementById("managerPasswordModal");
    const title = document.getElementById("managerPasswordModalTitle");
    const input = document.getElementById("managerPasswordInput");
    const err = document.getElementById("managerPasswordError");
    if (title) title.textContent = `Senha para acessar ${areaLabel}`;
    if (input) input.value = "";
    if (err) {
      err.textContent = "";
      err.classList.add("hidden");
    }
    modal?.classList.remove("hidden");
    setTimeout(() => input?.focus(), 80);
  });
}

function hideManagerPasswordModal(granted) {
  document.getElementById("managerPasswordModal")?.classList.add("hidden");
  const resolve = managerPasswordResolve;
  managerPasswordResolve = null;
  if (resolve) resolve(!!granted);
}

async function ensureManagerAreaAccess(areaLabel) {
  if (!requiresManagerPassword()) return true;
  if (hasManagerAreaAccess()) return true;
  return showManagerPasswordModal(areaLabel);
}

function leaveRestrictedTabIfLocked() {
  if (!requiresManagerPassword() || hasManagerAreaAccess()) return;
  const activeTab = document.querySelector(".tab-content.active");
  if (!activeTab || !isRestrictedTab(activeTab.id)) return;
  const pdvBtn = document.querySelector('.nav-item[data-tab="pdvTab"]');
  if (pdvBtn) activateTab(pdvBtn, "pdvTab", { skipRestrictedCheck: true });
}

function updateRestrictedNavUI() {
  const locked = requiresManagerPassword() && !hasManagerAreaAccess();
  Object.entries(RESTRICTED_TAB_LABELS).forEach(([tabId, label]) => {
    const btn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
    const span = btn?.querySelector("span:not(.nav-alert-dot)");
    if (span) span.textContent = locked ? `${label} 🔒` : label;
  });
}

function setupManagerPasswordModal() {
  const form = document.getElementById("managerPasswordForm");
  const input = document.getElementById("managerPasswordInput");
  const err = document.getElementById("managerPasswordError");
  document.getElementById("btnCancelManagerPassword")?.addEventListener("click", () => {
    hideManagerPasswordModal(false);
  });
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const pwd = input?.value || "";
    if (pwd === getManagerAreaPassword()) {
      setManagerAreaAccess(true);
      updateRestrictedNavUI();
      hideManagerPasswordModal(true);
    } else {
      if (err) {
        err.textContent = "Senha incorreta.";
        err.classList.remove("hidden");
      }
      input?.focus();
      input?.select();
    }
  });
  document.getElementById("managerPasswordModal")?.addEventListener("click", (e) => {
    if (e.target.id === "managerPasswordModal") hideManagerPasswordModal(false);
  });
}

function getDefaultProductCategories() {
  const presetKey = getStoreCategoryPresetKey();
  if (presetKey && STORE_CATEGORY_PRESETS[presetKey]) {
    return [...STORE_CATEGORY_PRESETS[presetKey]];
  }
  return [...DEFAULT_PRODUCT_CATEGORIES];
}

function getProductCategoryOptions() {
  const options = getProductCategorySelectOptions();
  if (state.products.some((p) => !resolveProductCategoryId(p))) {
    options.unshift({ id: UNCATEGORIZED_CATEGORY_KEY, label: "Sem categoria", depth: 0 });
  }
  return options;
}

function getCategoryRootAncestor(categoryId) {
  let current = findCategoryById(categoryId);
  if (!current) return null;
  while (current.parentId) {
    const parent = findCategoryById(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function getCategoryDescendantOptions(parentId) {
  const options = [];
  const walk = (pid, depth) => {
    getCategoryChildren(pid).forEach((node) => {
      const prefix = depth > 0 ? `${"\u00A0".repeat(depth * 3)}↳ ` : "";
      options.push({ id: node.id, label: `${prefix}${node.name}` });
      walk(node.id, depth + 1);
    });
  };
  walk(parentId, 0);
  return options;
}

function getProductCategoryFormValue() {
  const parent = String(document.getElementById("productCategoryParentSelect")?.value || "").trim();
  const sub = String(document.getElementById("productCategorySubSelect")?.value || "").trim();
  return sub || parent || "";
}

function syncProductCategoryHiddenValue() {
  const categoryId = getProductCategoryFormValue();
  const hidden = document.getElementById("productCategorySelect");
  if (hidden) hidden.value = categoryId;
  const pathEl = document.getElementById("productCategorySelectedPath");
  if (pathEl) {
    pathEl.textContent = categoryId ? getCategoryPathLabel(categoryId) : "Nenhuma categoria selecionada";
  }
}

function renderProductCategoryParentSelect() {
  const select = document.getElementById("productCategoryParentSelect");
  if (!select) return;
  const current = select.value;
  const roots = getCategoryChildren(null);
  select.innerHTML = [
    `<option value="">Selecione a categoria principal</option>`,
    ...roots.map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)}</option>`)
  ].join("");
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

function renderProductCategorySubSelect(rootId, selectedSubId = "") {
  const select = document.getElementById("productCategorySubSelect");
  if (!select) return;
  if (!rootId) {
    select.innerHTML = `<option value="">— Só categoria principal —</option>`;
    select.disabled = true;
    return;
  }
  const descendants = getCategoryDescendantOptions(rootId);
  select.disabled = !descendants.length;
  select.innerHTML = [
    `<option value="">— Só categoria principal —</option>`,
    ...descendants.map((opt) => `<option value="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</option>`)
  ].join("");
  if (selectedSubId && [...select.options].some((o) => o.value === selectedSubId)) {
    select.value = selectedSubId;
  } else {
    select.value = "";
  }
}

function setProductCategoryFormValue(categoryIdOrLegacy) {
  const parentSelect = document.getElementById("productCategoryParentSelect");
  if (!parentSelect) return;
  const value = String(categoryIdOrLegacy || "").trim();
  if (!value) {
    parentSelect.value = "";
    renderProductCategorySubSelect("", "");
    syncProductCategoryHiddenValue();
    return;
  }
  const resolvedId = findCategoryById(value)?.id
    || resolveProductCategoryId({ categoryId: value, category: value });
  if (!resolvedId) {
    syncProductCategoryHiddenValue();
    return;
  }
  const node = findCategoryById(resolvedId);
  const root = getCategoryRootAncestor(resolvedId);
  if (!node || !root) return;
  renderProductCategoryParentSelect();
  parentSelect.value = root.id;
  renderProductCategorySubSelect(root.id, node.id !== root.id ? node.id : "");
  syncProductCategoryHiddenValue();
}

function getProductCategorySuggestions() {
  return getProductCategorySelectOptions();
}

function renderProductCategorySuggestions() {
  renderProductCategoryParentSelect();
  const categoryId = getProductCategoryFormValue()
    || document.getElementById("productCategorySelect")?.value
    || "";
  if (categoryId) {
    setProductCategoryFormValue(categoryId);
    return;
  }
  const parentId = document.getElementById("productCategoryParentSelect")?.value || "";
  renderProductCategorySubSelect(parentId, "");
  syncProductCategoryHiddenValue();
}

function setupProductCategoryPicker() {
  if (!setupProductCategoryPicker._ready) {
    setupProductCategoryPicker._ready = true;
    document.getElementById("productCategoryParentSelect")?.addEventListener("change", () => {
      const rootId = document.getElementById("productCategoryParentSelect")?.value || "";
      renderProductCategorySubSelect(rootId, "");
      syncProductCategoryHiddenValue();
    });
    document.getElementById("productCategorySubSelect")?.addEventListener("change", () => {
      syncProductCategoryHiddenValue();
    });
    document.getElementById("btnCategoryAddSub")?.addEventListener("click", async () => {
      const parentId = document.getElementById("productCategoryParentSelect")?.value;
      if (!parentId) {
        alert("Selecione primeiro a categoria principal.");
        return;
      }
      const name = prompt(`Nome da subcategoria em «${getCategoryPathLabel(parentId)}»:`);
      if (!name?.trim()) return;
      const id = await findOrCreateProductCategoryNode(name.trim(), parentId);
      if (!id) return;
      renderProductCategoryFilter();
      renderProductCategorySubSelect(parentId, id);
      syncProductCategoryHiddenValue();
    });
    document.getElementById("btnAddRootCategoryFromProduct")?.addEventListener("click", async () => {
      const name = prompt("Nome da categoria principal:");
      if (!name?.trim()) return;
      const id = await findOrCreateProductCategoryNode(name.trim(), null);
      if (!id) return;
      refreshCategoryUI();
      renderProductCategoryParentSelect();
      document.getElementById("productCategoryParentSelect").value = id;
      renderProductCategorySubSelect(id, "");
      syncProductCategoryHiddenValue();
    });
    document.getElementById("btnCategoryRenameSelected")?.addEventListener("click", () => {
      window.editSelectedProductCategory();
    });
    document.getElementById("btnCategoryDeleteSelected")?.addEventListener("click", () => {
      window.deleteSelectedProductCategory();
    });
  }
  renderProductCategorySuggestions();
}

function renderProductCategoryFilter() {
  const select = document.getElementById("filterProductCategory");
  if (!select) return;
  const current = getProductCategoryFilter();
  const options = getProductCategoryOptions();
  const hasCurrent = current && options.some((opt) => opt.id === current);
  select.innerHTML = `<option value="">Todas as categorias</option>${
    options.map((opt) => `<option value="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</option>`).join("")
  }`;
  if (hasCurrent) select.value = current;
  renderProductCategorySuggestions();
}

function todayISO() {
  return toLocalDateISO(new Date());
}

/** Data local (YYYY-MM-DD) a partir de ISO/Date — corrige vendas após 21h no fuso BR (UTC-3). */
function toLocalDateISO(isoOrDate) {
  if (!isoOrDate) return "";
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toLocalMonthISO(isoOrDate) {
  const day = toLocalDateISO(isoOrDate);
  return day ? day.slice(0, 7) : "";
}

function isoMatchesLocalDay(isoOrDate, day) {
  if (!day) return true;
  return toLocalDateISO(isoOrDate) === day;
}

function isoMatchesLocalMonth(isoOrDate, month) {
  if (!month) return true;
  return toLocalMonthISO(isoOrDate) === month;
}

function getAdminEmails() {
  const emails = [];
  if (Array.isArray(window.ADMIN_EMAILS)) emails.push(...window.ADMIN_EMAILS);
  if (window.OWNER_ADMIN_EMAIL) emails.push(window.OWNER_ADMIN_EMAIL);
  emails.push("piresgustavo03@gmail.com");
  return [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
}

function isAdminUser(user) {
  if (!user?.email) return false;
  return getAdminEmails().includes(user.email.toLowerCase());
}

function getBuyerData() {
  return {
    name: document.getElementById("buyerName").value.trim(),
    phone: document.getElementById("buyerPhone").value.trim(),
    document: document.getElementById("buyerDocument").value.trim()
  };
}

function clearBuyerFields() {
  document.getElementById("buyerName").value = "";
  document.getElementById("buyerPhone").value = "";
  document.getElementById("buyerDocument").value = "";
}

const SPLIT_PAYMENT_METHODS = ["Dinheiro", "Pix", "Cartão Crédito", "Cartão Débito"];

function isSplitPaymentMode() {
  return !!document.getElementById("splitPaymentToggle")?.checked;
}

function getSelectedSinglePaymentMethod() {
  const checkedRadio = document.querySelector('input[name="payMethod"]:checked');
  return checkedRadio?.value || document.getElementById("paymentMethod")?.value || "Dinheiro";
}

function getCashPaymentAmountFromSplits(payments) {
  return (payments || [])
    .filter((p) => p.method === "Dinheiro")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

function normalizeSalePayments(payments, total, fallbackMethod = "Outro") {
  if (Array.isArray(payments) && payments.length) {
    return payments
      .map((p) => ({ method: String(p.method || fallbackMethod), amount: Number(p.amount || 0) }))
      .filter((p) => p.amount > 0);
  }
  return [{ method: fallbackMethod, amount: Number(total || 0) }];
}

function getSalePayments(sale) {
  if (Array.isArray(sale?.payments) && sale.payments.length) return sale.payments;
  return [{ method: sale?.paymentMethod || "Outro", amount: Number(sale?.total || 0) }];
}

function formatPaymentsLabel(payments) {
  const list = normalizeSalePayments(payments, 0);
  if (!list.length) return "—";
  if (list.length === 1) return list[0].method;
  return list.map((p) => `${p.method} ${money(p.amount)}`).join(" + ");
}

function isCreditPaymentMethod(method) {
  return method === "A Prazo";
}

function saleIsOnCredit(sale) {
  if (!sale) return false;
  if (isCreditPaymentMethod(sale.paymentMethod)) return true;
  return getSalePayments(sale).some((p) => isCreditPaymentMethod(p.method));
}

function readSplitPaymentsFromDOM(includeZero = true) {
  const rows = document.querySelectorAll("#splitPaymentsList .split-payment-row");
  const list = Array.from(rows).map((row) => ({
    method: row.querySelector(".split-pay-method")?.value || "Dinheiro",
    amount: Number(row.querySelector(".split-pay-amount")?.value || 0)
  }));
  return includeZero ? list : list.filter((p) => p.amount > 0);
}

function syncSplitPaymentsFromDOM() {
  state.splitPayments = readSplitPaymentsFromDOM(true);
  const { total } = state.cart.length ? buildSaleItems() : { total: 0 };
  updateSplitPaymentUI(total);
}

function renderSplitPaymentsList(total) {
  const list = document.getElementById("splitPaymentsList");
  if (!list) return;
  if (!state.splitPayments?.length) {
    state.splitPayments = [
      { method: getSelectedSinglePaymentMethod(), amount: total },
      { method: "Pix", amount: 0 }
    ];
  }
  list.innerHTML = state.splitPayments.map((p, idx) => `
    <div class="split-payment-row" data-idx="${idx}">
      <select class="split-pay-method">${SPLIT_PAYMENT_METHODS.map((m) =>
        `<option value="${m}" ${p.method === m ? "selected" : ""}>${m}</option>`
      ).join("")}</select>
      <input type="number" class="split-pay-amount" min="0" step="0.01" value="${p.amount > 0 ? Number(p.amount).toFixed(2) : ""}" placeholder="0,00" />
      ${state.splitPayments.length > 1 ? `<button type="button" class="btn-ctrl rm split-pay-remove" data-idx="${idx}" title="Remover">×</button>` : "<span></span>"}
    </div>`).join("");

  list.querySelectorAll(".split-pay-method, .split-pay-amount").forEach((el) => {
    el.addEventListener("input", syncSplitPaymentsFromDOM);
    el.addEventListener("change", syncSplitPaymentsFromDOM);
  });
  list.querySelectorAll(".split-pay-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      state.splitPayments.splice(idx, 1);
      updateSplitPaymentUI(total, { forceRender: true });
    });
  });
}

function updateSplitPaymentUI(total = 0, options = {}) {
  const { forceRender = false } = options;
  const wrap = document.getElementById("splitPaymentsWrap");
  const singleWrap = document.getElementById("singlePaymentWrap");
  const splitOn = isSplitPaymentMode();
  if (wrap) wrap.classList.toggle("hidden", !splitOn);
  if (singleWrap) singleWrap.classList.toggle("hidden", splitOn);
  if (splitOn && (forceRender || !document.querySelector("#splitPaymentsList .split-payment-row"))) {
    if (!state.splitPayments?.length) {
      state.splitPayments = [
        { method: getSelectedSinglePaymentMethod(), amount: total },
        { method: "Pix", amount: 0 }
      ];
    }
    renderSplitPaymentsList(total);
  }

  const payments = splitOn
    ? readSplitPaymentsFromDOM(false)
    : [{ method: getSelectedSinglePaymentMethod(), amount: total }];
  const assigned = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const remaining = total - assigned;
  const balanceEl = document.getElementById("splitPaymentBalance");
  if (balanceEl && splitOn) {
    if (Math.abs(remaining) < 0.009) {
      balanceEl.textContent = "✓ Pagamento completo";
      balanceEl.style.color = "var(--success)";
    } else if (remaining > 0) {
      balanceEl.textContent = `Restante: ${money(remaining)}`;
      balanceEl.style.color = "var(--danger)";
    } else {
      balanceEl.textContent = `Excedente: ${money(Math.abs(remaining))}`;
      balanceEl.style.color = "var(--danger)";
    }
  }

  updateCashPaymentUI(total, payments);
}

function resolveCheckoutPayments(forcePaymentMethod = "", total = 0) {
  if (forcePaymentMethod) {
    return {
      payments: [{ method: forcePaymentMethod, amount: total }],
      paymentMethod: forcePaymentMethod
    };
  }
  if (isSplitPaymentMode()) {
    const payments = readSplitPaymentsFromDOM(false);
    if (!payments.length) {
      throw new Error("Informe pelo menos uma forma de pagamento com valor.");
    }
    const sum = payments.reduce((acc, p) => acc + Number(p.amount || 0), 0);
    if (Math.abs(sum - total) > 0.009) {
      throw new Error(`Soma dos pagamentos (${money(sum)}) difere do total (${money(total)}).`);
    }
    if (payments.some((p) => isCreditPaymentMethod(p.method))) {
      throw new Error("Venda a prazo não pode ser dividida. Use «Finalizar a prazo».");
    }
    return { payments, paymentMethod: formatPaymentsLabel(payments) };
  }
  const method = getSelectedSinglePaymentMethod();
  return { payments: [{ method, amount: total }], paymentMethod: method };
}

function resetPaymentUI() {
  const splitToggle = document.getElementById("splitPaymentToggle");
  if (splitToggle) splitToggle.checked = false;
  state.splitPayments = [];
  setPaymentMethod("Dinheiro");
  document.getElementById("cashAmountPaid").value = "";
  updateSplitPaymentUI(0);
}

function getCashAmountPaid() {
  return Number(document.getElementById("cashAmountPaid")?.value || 0);
}

function isCashPaymentSelected(total = null) {
  if (isSplitPaymentMode()) {
    const built = total != null ? { total } : (state.cart.length ? buildSaleItems() : { total: 0 });
    const payments = readSplitPaymentsFromDOM(false);
    return getCashPaymentAmountFromSplits(payments) > 0;
  }
  return getSelectedSinglePaymentMethod() === "Dinheiro";
}

function updateCashPaymentUI(total = null, payments = null) {
  const cashWrap = document.getElementById("cashPaymentFields");
  const cashInput = document.getElementById("cashAmountPaid");
  const cashLabel = cashWrap?.querySelector("label");
  if (!cashWrap || !cashInput) return;

  if (total == null) {
    const built = state.cart.length ? buildSaleItems() : { total: 0 };
    total = built.total;
  }
  if (payments == null) {
    payments = isSplitPaymentMode()
      ? readSplitPaymentsFromDOM(false)
      : [{ method: getSelectedSinglePaymentMethod(), amount: total }];
  }

  const cashDue = isSplitPaymentMode()
    ? getCashPaymentAmountFromSplits(payments)
    : (getSelectedSinglePaymentMethod() === "Dinheiro" ? total : 0);
  const isCash = cashDue > 0;
  cashWrap.style.display = isCash ? "block" : "none";
  cashInput.required = isCash && !isSplitPaymentMode();
  if (cashLabel) {
    cashLabel.textContent = isSplitPaymentMode()
      ? `Valor entregue em dinheiro (parte: ${money(cashDue)})`
      : "Valor pago (dinheiro)";
  }
  if (!isCash) cashInput.value = "";
}

function updateCashChangePreview(total) {
  const infoEl = document.getElementById("cashChangeInfo");
  if (!infoEl) return;
  if (!isCashPaymentSelected(total)) {
    infoEl.textContent = "Troco: R$ 0,00";
    infoEl.style.color = "var(--muted)";
    return;
  }
  const amountPaid = getCashAmountPaid();
  const cashDue = isSplitPaymentMode()
    ? getCashPaymentAmountFromSplits(readSplitPaymentsFromDOM(false))
    : total;
  const change = amountPaid - cashDue;
  if (change < 0) {
    infoEl.textContent = `Falta: ${money(Math.abs(change))}`;
    infoEl.style.color = "var(--danger)";
    return;
  }
  infoEl.textContent = `Troco: ${money(change)}`;
  infoEl.style.color = "var(--success)";
}

function setPaymentMethod(method) {
  if (isSplitPaymentMode()) return;
  const select = document.getElementById("paymentMethod");
  if (select) select.value = method;
  const radio = document.querySelector(`input[name="payMethod"][value="${method}"]`);
  if (!radio) return;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
}

function getQtyShortcutDiff(key, shiftKey) {
  if (key === "+" || key === "NumpadAdd" || (key === "=" && shiftKey)) return 1;
  if (key === "-" || key === "NumpadSubtract") return -1;
  return 0;
}

function adjustActiveCartQty(diff) {
  if (!state.cart.length) return;
  let productId;
  let priceType;
  if (window._lastScanItem) {
    ({ productId, priceType } = window._lastScanItem);
    const item = state.cart.find((i) => i.productId === productId && i.priceType === priceType);
    if (!item) {
      const last = state.cart[state.cart.length - 1];
      productId = last.productId;
      priceType = last.priceType;
    }
  } else {
    const last = state.cart[state.cart.length - 1];
    productId = last.productId;
    priceType = last.priceType;
  }
  changeCartQty(productId, priceType, diff);
}

function handlePDVQtyKeyboard(e) {
  const pdvTab = document.getElementById("pdvTab");
  if (!pdvTab?.classList.contains("active")) return false;
  if (!state.cart.length) return false;

  const diff = getQtyShortcutDiff(e.key, e.shiftKey);
  if (!diff) return false;

  const focused = document.activeElement;
  const tag = focused?.tagName;
  const isQtyInput = focused?.classList?.contains("scan-qty-input");
  const isTextInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (isTextInput && !isQtyInput) return false;

  e.preventDefault();
  adjustActiveCartQty(diff);
  return true;
}

function setupPDVShortcuts() {
  document.addEventListener("keydown", (e) => {
    const pdvTab = document.getElementById("pdvTab");
    if (!pdvTab || !pdvTab.classList.contains("active")) return;

    if (handlePDVQtyKeyboard(e)) return;

    const allowedFunctionKeys = ["F1", "F2", "F3", "F4", "F6", "F7", "Escape"];
    const isAltPaymentShortcut = e.altKey && ["1", "2", "3", "4", "5"].includes(e.key);
    const isAllowedShortcut = allowedFunctionKeys.includes(e.key) || isAltPaymentShortcut;
    if (!isAllowedShortcut) return;

    e.preventDefault();

    if (e.key === "F1") {
      document.getElementById("pdvSearch")?.focus();
      return;
    }
    if (e.key === "F2") {
      document.getElementById("discountValue")?.focus();
      return;
    }
    if (e.key === "Escape") {
      const searchInput = document.getElementById("pdvSearch");
      const results = document.getElementById("pdvSearchResults");
      if (searchInput) searchInput.value = "";
      resetPDVSearchHighlight();
      if (results) {
        results.classList.remove("open");
        results.innerHTML = "";
      }
      return;
    }

    const methodByShortcut = {
      F3: "Dinheiro",
      F4: "Pix",
      F6: "Cartão Débito",
      F7: "Cartão Crédito",
      1: "Dinheiro",
      2: "Pix",
      3: "Cartão Débito",
      4: "Cartão Crédito"
    };

    const chosenMethod = methodByShortcut[e.key];
    if (chosenMethod && !isSplitPaymentMode()) {
      setPaymentMethod(chosenMethod);
      if (chosenMethod === "Dinheiro") document.getElementById("cashAmountPaid")?.focus();
      return;
    }

    if (e.altKey && e.key === "5") {
      if (!state.cart.length) {
        alert("Carrinho vazio.");
        return;
      }
      finalizeSale();
    }
  });
}

function getStoreRef() {
  if (!state.user) return null;
  return db.collection("stores").doc(state.user.uid);
}

function isDateOnlyString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

/** Converte vencimento salvo (texto AAAA-MM-DD, Timestamp ou Date) para fim do dia no fuso local. */
function parseLicenseDate(value) {
  if (value == null || value === "") return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isDateOnlyString(trimmed)) {
      const [y, m, d] = trimmed.split("-").map(Number);
      return new Date(y, m - 1, d, 23, 59, 59, 999);
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59, 999);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return null;
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
  }

  if (typeof value.toDate === "function") {
    const dt = value.toDate();
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
  }

  if (typeof value === "object" && typeof value.seconds === "number") {
    const dt = new Date(value.seconds * 1000);
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
  }

  if (value instanceof Date) {
    const dt = value;
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59, 999);
}

function formatDateForInput(date) {
  if (!date || Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeExpiresInput(input) {
  const trimmed = String(input || "").trim();
  if (!isDateOnlyString(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return null;
  return trimmed;
}

function getDaysUntilDate(targetDate) {
  const end = targetDate instanceof Date ? targetDate : parseLicenseDate(targetDate);
  if (!end || Number.isNaN(end.getTime())) return -1;
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((endDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function getDaysUntilIsoDate(isoDate) {
  const normalized = normalizeExpiresInput(isoDate);
  if (!normalized) return -1;
  const today = todayISO();
  const [ty, tm, td] = today.split("-").map(Number);
  const [ey, em, ed] = normalized.split("-").map(Number);
  const t0 = Date.UTC(ty, tm - 1, td);
  const e0 = Date.UTC(ey, em - 1, ed);
  return Math.round((e0 - t0) / 86400000);
}

function normalizeLicensePlan(plan) {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "monthly" || p === "mensal" || p === "mensalidade") return "monthly";
  if (p === "lifetime" || p === "vitalicio" || p === "vitalício" || p === "vitalicia") return "lifetime";
  return p;
}

function normalizeLicenseStatus(status) {
  const s = String(status || "active").toLowerCase().trim();
  if (["active", "ativa", "ativo"].includes(s)) return "active";
  if (["blocked", "bloqueada", "bloqueado"].includes(s)) return "blocked";
  if (["inactive", "inativa", "inativo"].includes(s)) return "inactive";
  return s;
}

function getLicenseExpiryField(license) {
  if (!license) return null;
  return license.expiresAt ?? license.expires_at ?? license.expiration ?? license.vencimento ?? null;
}

function getLicenseExpiresIso(license) {
  const raw = getLicenseExpiryField(license);
  if (raw == null || raw === "") return null;
  if (typeof raw === "string" && isDateOnlyString(raw.trim())) return raw.trim();
  const parsed = parseLicenseDate(raw);
  return parsed ? formatDateForInput(parsed) : null;
}

const LICENSE_EXPIRY_WARN_DAYS = 2;

function getLicenseExpiryWarning(license = state.license) {
  if (!license) return null;
  const plan = normalizeLicensePlan(license.plan);
  const status = normalizeLicenseStatus(license.status);
  if (plan !== "monthly" || status !== "active") return null;
  const expiresIso = getLicenseExpiresIso(license);
  if (!expiresIso) return null;
  const daysLeft = getDaysUntilIsoDate(expiresIso);
  if (daysLeft < 0 || daysLeft > LICENSE_EXPIRY_WARN_DAYS) return null;
  const [y, m, d] = expiresIso.split("-").map(Number);
  const dateStr = new Date(y, m - 1, d).toLocaleDateString("pt-BR");
  let whenText = `em ${daysLeft} dias`;
  if (daysLeft === 0) whenText = "hoje";
  else if (daysLeft === 1) whenText = "amanhã";
  else if (daysLeft === 2) whenText = "em 2 dias";
  return {
    daysLeft,
    expiresIso,
    dateStr,
    message: `Sua mensalidade vence ${whenText} (${dateStr}). Renove o pagamento para evitar bloqueio do sistema.`
  };
}

function getLicenseWarningDismissKey(warning) {
  if (!state.user?.uid || !warning) return "";
  return `license_warn_v2_${state.user.uid}_${warning.expiresIso || warning.dateStr}`;
}

async function refreshLicenseExpiryBanner() {
  if (state.user?.uid && db) {
    try {
      const snap = await db.collection("licenses").doc(state.user.uid).get();
      state.license = snap.exists ? snap.data() : null;
    } catch (err) {
      console.warn("Não foi possível atualizar aviso de licença:", err);
    }
  }
  updateLicenseExpiryBanner();
}

function updateLicenseExpiryBanner() {
  const banner = document.getElementById("licenseExpiryBanner");
  const messageEl = document.getElementById("licenseExpiryMessage");
  if (!banner || !messageEl) return;

  const warning = getLicenseExpiryWarning();
  if (!warning) {
    banner.classList.add("hidden");
    banner.classList.remove("urgent");
    messageEl.textContent = "";
    return;
  }

  if (sessionStorage.getItem(getLicenseWarningDismissKey(warning))) {
    banner.classList.add("hidden");
    return;
  }

  messageEl.textContent = warning.message;
  banner.classList.toggle("urgent", warning.daysLeft <= 1);
  banner.classList.remove("hidden");
}

function setupLicenseExpiryBanner() {
  document.getElementById("btnDismissLicenseBanner")?.addEventListener("click", () => {
    const warning = getLicenseExpiryWarning();
    if (warning) sessionStorage.setItem(getLicenseWarningDismissKey(warning), "1");
    document.getElementById("licenseExpiryBanner")?.classList.add("hidden");
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTH SCREEN TOGGLE
// ═══════════════════════════════════════════════════════════════
window.switchAuthTab = function(tab) {
  document.getElementById("tabLogin").classList.toggle("active", tab === "login");
  document.getElementById("tabRegister").classList.toggle("active", tab === "register");
  document.getElementById("loginForm").classList.toggle("hidden", tab !== "login");
  document.getElementById("registerForm").classList.toggle("hidden", tab !== "register");
};

// ═══════════════════════════════════════════════════════════════
// QZ TRAY — impressão automática na térmica ao finalizar venda
// ═══════════════════════════════════════════════════════════════
const ESC = "\x1B";
const GS = "\x1D";
const ESC_BOLD_ON = ESC + "E\x01";
const ESC_BOLD_OFF = ESC + "E\x00";
const ESC_CENTER = ESC + "a\x01";
const ESC_LEFT = ESC + "a\x00";
const ESC_DH_ON = GS + "!\x01";
const ESC_DH_OFF = GS + "!\x00";
const ESC_DH_WIDTH_ON = GS + "!\x11";

const RECEIPT_WIDTH = 32;

function escPosSafe(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[^\x20-\x7E]/g, "");
}

function moneyEscPos(value) {
  const n = Number(value || 0);
  return "R$ " + n.toFixed(2).replace(".", ",");
}

function wrapEscPosReceipt(text) {
  const body = String(text || "").replace(/\r\n/g, "\n").trimEnd();
  const feeds = ESC + "d\x06";
  return ESC + "@" + body + "\n" + feeds + GS + "V\x00";
}

async function qzPrintRawEscPos(printerName, receiptText) {
  const name = String(printerName || "").trim();
  const body = String(receiptText || "").replace(/\r\n/g, "\n").trimEnd();
  const payload = wrapEscPosReceipt(body);
  const config = qz.configs.create(name);
  try {
    await withQzTimeout(
      qz.print(config, [{ type: "raw", format: "plain", data: payload }]),
      25000,
      "Impressão"
    );
    return;
  } catch (plainErr) {
    console.warn("QZ impressão com corte:", plainErr);
  }
  await withQzTimeout(
    qz.print(config, [{ type: "raw", format: "plain", data: body + "\n" + ESC + "d\x06" }]),
    25000,
    "Impressão"
  );
}

function withQzTimeout(promise, ms = 25000, label = "Impressão") {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} demorou demais. Reinicie o QZ Tray e tente de novo.`)), ms);
    })
  ]);
}

function showPrintToast(message, isError = false) {
  let toast = document.getElementById("printToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "printToast";
    toast.setAttribute("role", "alert");
    toast.style.cssText = [
      "position:fixed",
      "bottom:max(20px, env(safe-area-inset-bottom))",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:99999",
      "padding:14px 22px",
      "border-radius:10px",
      "font-weight:600",
      "font-size:14px",
      "max-width:min(92vw, 480px)",
      "text-align:center",
      "box-shadow:0 8px 32px rgba(0,0,0,0.35)",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(toast);
  }
  toast.style.background = isError ? "#ff3d57" : "#00e676";
  toast.style.color = isError ? "#fff" : "#111";
  toast.textContent = message;
  toast.style.display = "block";
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.style.display = "none";
  }, isError ? 10000 : 5000);
}

function formatQzPrintError(err) {
  const msg = String(err?.message || err || "Erro desconhecido");
  if (/websocket|connect|connection/i.test(msg)) {
    return "QZ Tray não conectou. Abra o QZ Tray na bandeja do Windows.";
  }
  if (/signature|certificate|sign/i.test(msg)) {
    return "Erro de certificado QZ. Atualize a página (Ctrl+F5) e teste de novo.";
  }
  if (/printer|not found|unable/i.test(msg)) {
    return "Impressora não encontrada. Use «Listar impressoras» e confira o nome em Empresa.";
  }
  return msg;
}

function receiptHr(char = "-") {
  return char.repeat(RECEIPT_WIDTH);
}

function resolveOrderNumber(saleId, orderNumber) {
  if (orderNumber != null && orderNumber !== "") return Number(orderNumber);
  if (!saleId) return null;
  const idx = state.sales.findIndex((s) => s.id === saleId);
  if (idx >= 0) return state.sales.length - idx;
  const digits = String(saleId).replace(/\D/g, "");
  return digits ? parseInt(digits.slice(-4), 10) || null : null;
}

function receiptCenter(text, width = RECEIPT_WIDTH) {
  const t = String(text || "").substring(0, width);
  const pad = Math.max(0, Math.floor((width - t.length) / 2));
  return " ".repeat(pad) + t;
}

function receiptRow(label, value, width = RECEIPT_WIDTH) {
  const val = String(value ?? "");
  const lab = String(label ?? "");
  const space = Math.max(1, width - lab.length - val.length);
  return lab + " ".repeat(space) + val;
}

function receiptDateStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function resolveReceiptSurchargePercent(subtotal, discount, total, paymentMethod, company) {
  const base = Math.max(0, Number(subtotal || 0) - Number(discount || 0));
  const finalTotal = Number(total || 0);
  const configured = Number(company?.creditSurchargePercent || 0);
  if (paymentMethod === "A Prazo" && configured > 0) return configured;
  if (paymentMethod === "A Prazo" && base > 0 && finalTotal > base + 0.009) {
    return Math.round(((finalTotal - base) / base) * 10000) / 100;
  }
  return 0;
}

function buildReceiptModel({
  company,
  items,
  subtotal,
  discount,
  total,
  paymentMethod,
  payments = null,
  buyer,
  date,
  cashAmountPaid = 0,
  cashChange = 0,
  saleId = null,
  orderNumber = null,
  orderType = "BALCÃO",
  registerName = ""
}) {
  const dt = new Date(date);
  const saleItems = items || [];
  const itemCount = saleItems.reduce((s, i) => s + Number(i.qty || 0), 0);
  const subtotalValue = Number(subtotal ?? saleItems.reduce((s, i) => s + Number(i.subtotal || 0), 0));
  const discountValue = Number(discount || 0);
  const totalValue = Number(total || 0);
  const paymentList = normalizeSalePayments(payments, totalValue, paymentMethod || "—");
  const payment = paymentList.length === 1 ? paymentList[0].method : formatPaymentsLabel(paymentList);
  const surchargePercent = resolveReceiptSurchargePercent(subtotalValue, discountValue, totalValue, payment, company);

  return {
    company: company || {},
    items: saleItems,
    subtotal: subtotalValue,
    discount: discountValue,
    total: totalValue,
    paymentMethod: payment,
    payments: paymentList,
    buyer: buyer || {},
    date: dt,
    dateStr: receiptDateStr(dt),
    cashAmountPaid: Number(cashAmountPaid || 0),
    cashChange: Number(cashChange || 0),
    saleId: saleId || null,
    orderNumber: resolveOrderNumber(saleId, orderNumber),
    orderType: orderType || "BALCÃO",
    registerName: String(registerName || "").trim(),
    itemCount,
    surchargePercent
  };
}

function escPosReset() {
  return ESC_LEFT + ESC_BOLD_OFF + ESC_DH_OFF;
}

function escPosLargeCenterLine(text, maxLen = 16) {
  return ESC_CENTER + ESC_DH_WIDTH_ON + ESC_BOLD_ON
    + escPosSafe(String(text || "")).substring(0, maxLen)
    + "\n" + escPosReset();
}

function escPosMediumCenterLine(text, maxLen = 32) {
  return ESC_CENTER + ESC_DH_ON + ESC_BOLD_ON
    + escPosSafe(String(text || "")).substring(0, maxLen)
    + "\n" + escPosReset();
}

function escPosBoldLine(text) {
  return ESC_BOLD_ON + escPosSafe(String(text || "")) + "\n" + ESC_BOLD_OFF;
}

function escPosLine(text) {
  return escPosSafe(String(text || "")) + "\n";
}

function buildReceiptEscPos(model) {
  const c = model.company;
  const b = model.buyer;
  const chunks = [];
  const pushBoldRow = (label, value) => chunks.push(escPosBoldLine(receiptRow(label, value)));



  const companyName = c.name || "STOCK PDV";
  if (escPosSafe(companyName).length <= 16) {
    chunks.push(escPosLargeCenterLine(companyName));
  } else {
    chunks.push(escPosMediumCenterLine(companyName));
  }

  if (c.phone) chunks.push(escPosLine(`Tel: ${c.phone}`));
  if (c.address) chunks.push(escPosLine(`End: ${c.address}`));
  chunks.push(escPosBoldLine(`Tipo: ${model.orderType}`));
  if (model.registerName) chunks.push(escPosBoldLine(`Caixa: ${model.registerName}`));
  if (b.name) chunks.push(escPosBoldLine(`Cliente: ${b.name}`));
  else if (b.phone || b.document) chunks.push(escPosBoldLine(`Cliente: ${b.phone || b.document}`));
  chunks.push(escPosBoldLine(`Data: ${model.dateStr}`));
  chunks.push(escPosLine(receiptHr("-")));

  model.items.forEach((item) => {
    chunks.push(escPosBoldLine(String(item.name || "Produto").substring(0, RECEIPT_WIDTH)));
    chunks.push(escPosLine(receiptRow(`${item.qty} UN x ${moneyEscPos(item.price)}`, moneyEscPos(item.subtotal))));
  });

  chunks.push(escPosLine(receiptHr("-")));
  pushBoldRow("Total:", moneyEscPos(model.subtotal));
  if (model.surchargePercent > 0) {
    pushBoldRow("Acrescimo:", `${model.surchargePercent}%`);
  } else if (model.discount > 0) {
    pushBoldRow("Desconto:", "-" + moneyEscPos(model.discount));
  }
  pushBoldRow("FINAL:", moneyEscPos(model.total));
  if (model.payments?.length > 1) {
    chunks.push(escPosBoldLine("Pagamento:"));
    model.payments.forEach((p) => pushBoldRow(`  ${p.method}:`, moneyEscPos(p.amount)));
  } else {
    chunks.push(escPosBoldLine(`Pagamento: ${model.paymentMethod}`));
  }
  const cashPart = getCashPaymentAmountFromSplits(model.payments)
    || (model.paymentMethod === "Dinheiro" ? model.total : 0);
  if (cashPart > 0) {
    pushBoldRow("Recebido:", moneyEscPos(model.cashAmountPaid));
    if (model.cashChange > 0) pushBoldRow("Troco:", moneyEscPos(model.cashChange));
  }
  const hasPix = model.payments?.some((p) => p.method === "Pix") || model.paymentMethod === "Pix";
  if (hasPix && c.pix) chunks.push(escPosBoldLine(`PIX: ${c.pix}`));
  chunks.push(escPosLine(receiptHr("-")));
  chunks.push(escPosMediumCenterLine("Volte sempre!"));
  return chunks.join("");
}

function buildReceiptPlainText(model) {
  const c = model.company;
  const b = model.buyer;
  const S = escPosSafe;
  const lines = [];
  const push = (s) => lines.push(S(s));
  const pushRow = (label, value) => lines.push(S(receiptRow(label, value)));

  push(receiptCenter("DISTRIBUIDORA"));
  push(receiptCenter(c.name || "STOCK PDV"));
  if (c.phone) push(`Tel: ${S(c.phone)}`);
  if (c.address) push(`End: ${S(c.address)}`);
  push(`Tipo: ${S(model.orderType)}`);
  if (model.registerName) push(`Caixa: ${S(model.registerName)}`);
  if (b.name) push(`Cliente: ${S(b.name)}`);
  else if (b.phone || b.document) push(`Cliente: ${S(b.phone || b.document)}`);
  push(`Data: ${S(model.dateStr)}`);
  push(receiptHr("-"));

  model.items.forEach((item) => {
    push(String(item.name || "Produto").substring(0, RECEIPT_WIDTH));
    pushRow(`${item.qty} UN x ${moneyEscPos(item.price)}`, moneyEscPos(item.subtotal));
  });

  push(receiptHr("-"));
  pushRow("Total:", moneyEscPos(model.subtotal));
  if (model.surchargePercent > 0) {
    pushRow("Acrescimo:", `${model.surchargePercent}%`);
  } else if (model.discount > 0) {
    pushRow("Desconto:", "-" + moneyEscPos(model.discount));
  }
  pushRow("FINAL:", moneyEscPos(model.total));
  if (model.payments?.length > 1) {
    push("Pagamento:");
    model.payments.forEach((p) => pushRow(`  ${S(p.method)}:`, moneyEscPos(p.amount)));
  } else {
    push(`Pagamento: ${S(model.paymentMethod)}`);
  }
  const cashPart = getCashPaymentAmountFromSplits(model.payments)
    || (model.paymentMethod === "Dinheiro" ? model.total : 0);
  if (cashPart > 0) {
    pushRow("Recebido:", moneyEscPos(model.cashAmountPaid));
    if (model.cashChange > 0) pushRow("Troco:", moneyEscPos(model.cashChange));
  }
  const hasPix = model.payments?.some((p) => p.method === "Pix") || model.paymentMethod === "Pix";
  if (hasPix && c.pix) push(`PIX: ${S(c.pix)}`);
  push(receiptHr("-"));
  push(receiptCenter("VOLTE SEMPRE!"));
  return lines.join("\n");
}

function buildReceiptHtml(model) {
  const c = model.company;
  const b = model.buyer;

  const itemsHtml = model.items.map((item) => `
    <div class="item">
      <div class="item-name">${item.name}</div>
      <div class="item-row">
        <span>${item.qty} UN × ${money(item.price)}</span>
        <strong>${money(item.subtotal)}</strong>
      </div>
    </div>`).join("");

  const totalsHtml = `
    <div class="row total-label"><span>Total:</span><strong>${money(model.subtotal)}</strong></div>
    ${model.surchargePercent > 0
      ? `<div class="row"><span>Acréscimo:</span><span>${model.surchargePercent}%</span></div>`
      : model.discount > 0
        ? `<div class="row"><span>Desconto:</span><span>-${money(model.discount)}</span></div>`
        : ""}
    <div class="row final"><span>FINAL:</span><strong>${money(model.total)}</strong></div>`;

  const clienteLine = b.name
    ? `Cliente: ${b.name}`
    : (b.phone || b.document ? `Cliente: ${b.phone || b.document}` : "");

  const paymentHtml = model.payments?.length > 1
    ? `<div class="pay">Pagamento:</div>${model.payments.map((p) =>
      `<div class="meta-line">${p.method}: ${money(p.amount)}</div>`
    ).join("")}`
    : `<div class="pay">Pagamento: ${model.paymentMethod}</div>`;
  const cashPart = getCashPaymentAmountFromSplits(model.payments)
    || (model.paymentMethod === "Dinheiro" ? model.total : 0);
  const cashHtml = cashPart > 0 ? `
    <div class="meta-line">Valor recebido: ${money(model.cashAmountPaid)}</div>
    ${model.cashChange > 0 ? `<div class="meta-line">Troco: ${money(model.cashChange)}</div>` : ""}` : "";
  const hasPix = model.payments?.some((p) => p.method === "Pix") || model.paymentMethod === "Pix";
  const pixHtml = hasPix && c.pix ? `<div class="meta-line">PIX: ${c.pix}</div>` : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cupom</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; width: 80mm; max-width: 80mm; margin: 0 auto; padding: 12px 10px; font-size: 12px; color: #111; line-height: 1.35; }
  .logo { display: block; max-height: 56px; margin: 0 auto 8px; }
  .order-title { text-align: center; font-size: 20px; font-weight: 800; margin: 6px 0 4px; letter-spacing: 0.5px; }
  .company-name { text-align: center; font-weight: 800; font-size: 24px; margin: 8px 0 10px; letter-spacing: 0.5px; }
  .meta-line { margin: 2px 0; font-size: 12px; }
  .hr { border: none; border-top: 1px dashed #333; margin: 10px 0; }
  .items { margin-bottom: 4px; }
  .item { margin-bottom: 8px; }
  .item-name { margin-bottom: 2px; font-weight: 600; }
  .item-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
  .item-row strong { white-space: nowrap; }
  .totals .row { display: flex; justify-content: space-between; margin: 4px 0; }
  .totals .row.final { font-weight: 700; font-size: 14px; margin-top: 6px; }
  .totals .row.total-label { font-weight: 700; }
  .pay { margin-top: 8px; font-size: 12px; }
  .foot { text-align: center; font-weight: 800; font-size: 14px; margin-top: 12px; letter-spacing: 1px; }
</style></head><body>
  ${c.logo ? `<img class="logo" src="${c.logo}" alt="">` : ""}
  <div class="order-title">DISTRIBUIDORA</div>
  <div class="company-name">${c.name || "STOCK PDV"}</div>
  ${c.phone ? `<div class="meta-line">Tel: ${c.phone}</div>` : ""}
  ${c.address ? `<div class="meta-line">End: ${c.address}</div>` : ""}
  <div class="meta-line">Tipo: ${model.orderType}</div>
  ${model.registerName ? `<div class="meta-line">Caixa: ${model.registerName}</div>` : ""}
  ${clienteLine ? `<div class="meta-line">${clienteLine}</div>` : ""}
  <div class="meta-line">Data: ${model.dateStr}</div>
  <hr class="hr">
  <div class="items">${itemsHtml}</div>
  <hr class="hr">
  <div class="totals">${totalsHtml}</div>
  ${paymentHtml}
  ${cashHtml}
  ${pixHtml}
  <hr class="hr">
  <div class="foot">Volte sempre!</div>
</body></html>`;
}

function resolveReceiptRegisterName(extra = {}) {
  if (extra.registerName) return String(extra.registerName).trim();
  const reg = typeof getActiveRegister === "function" ? getActiveRegister() : null;
  return String(reg?.name || "").trim();
}

function buildReceiptLines(company, items, total, paymentMethod, buyer, date, cashAmountPaid = 0, cashChange = 0, extra = {}) {
  const subtotal = extra.subtotal ?? items.reduce((s, i) => s + Number(i.subtotal || 0), 0);
  const discount = extra.discount ?? Math.max(0, subtotal - Number(total || 0));
  const model = buildReceiptModel({
    company,
    items,
    subtotal,
    discount,
    total,
    paymentMethod,
    payments: extra.payments,
    buyer,
    date,
    cashAmountPaid,
    cashChange,
    saleId: extra.saleId || null,
    orderNumber: extra.orderNumber ?? null,
    orderType: extra.orderType || "BALCÃO",
    registerName: resolveReceiptRegisterName(extra)
  });
  return buildReceiptEscPos(model);
}

window.printCurrentCartReceipt = async function printCurrentCartReceipt() {
  if (!state.cart.length) {
    alert("Adicione itens no carrinho antes de imprimir.");
    return { ok: false, error: "Carrinho vazio" };
  }
  const printerName = getActivePrinter();
  if (!printerName) {
    const reg = getActiveRegister();
    alert(isMultiRegisterMode()
      ? `Impressora não configurada para ${reg?.name || "este caixa"}.`
      : "Configure a impressora em Empresa.");
    return { ok: false, error: "Sem impressora" };
  }
  showPrintToast(`Imprimindo em ${printerName}…`);
  const { items, subtotal, discount, total } = buildSaleItems();
  let paymentMethod = "Dinheiro";
  let payments = [{ method: "Dinheiro", amount: total }];
  try {
    ({ payments, paymentMethod } = resolveCheckoutPayments("", total));
  } catch { /* usa Dinheiro */ }
  const cashDue = getCashPaymentAmountFromSplits(payments);
  const cashAmountPaid = cashDue > 0 ? getCashAmountPaid() : 0;
  const cashChange = cashDue > 0 ? Math.max(0, cashAmountPaid - cashDue) : 0;
  const company = state.company || {};
  const text = buildReceiptLines(company, items, total, paymentMethod, getBuyerData(), new Date(), cashAmountPaid, cashChange, {
    subtotal,
    discount,
    payments
  });
  const result = await printViaQZ(text);
  if (result.ok) {
    flashPrinterStatus(`✅ Cupom enviado: ${result.printer || printerName}`);
  } else {
    flashPrinterStatus(`⚠️ ${result.error}`, true);
    alert(`Impressão falhou:\n\n${result.error}`);
  }
  return result;
};

let _qzConnectPromise = null;
let _qzSessionReady = false;
let _finalizeSaleLock = false;
let _lastAutoPrintedSaleId = null;
let _lastAutoPrintAt = 0;

function setupQzWebsocketCallbacks() {
  if (window.__qzCallbacksSet || typeof qz === "undefined") return;
  window.__qzCallbacksSet = true;
  try {
    qz.websocket.setClosedCallbacks(() => {
      _qzSessionReady = false;
    });
  } catch (err) {
    console.warn("QZ callbacks:", err);
  }
}

async function qzConnect(options = {}) {
  const forceSecurity = !!options.forceSecurity;
  if (typeof qz === "undefined") return { ok: false, error: "QZ Tray não instalado no navegador." };
  if (_qzSessionReady && qz.websocket.isActive() && !forceSecurity) return { ok: true };
  if (_qzConnectPromise) return _qzConnectPromise;
  _qzConnectPromise = (async () => {
    try {
      setupQzWebsocketCallbacks();
      const waitFn = typeof window.waitForQzSecurity === "function"
        ? window.waitForQzSecurity
        : (typeof window.setupQZSecurity === "function" ? window.setupQZSecurity : null);
      if (waitFn) {
        const ready = await waitFn(forceSecurity);
        if (!ready) {
          return {
            ok: false,
            error: "Certificado QZ não carregado. Em Empresa, clique «Verificar QZ neste PC» ou atualize a página (Ctrl+F5)."
          };
        }
      }
      if (qz.websocket.isActive()) {
        _qzSessionReady = true;
        return { ok: true };
      }
      await qz.websocket.connect({ retries: 4, delay: 1.5, keepAlive: 60 });
      _qzSessionReady = true;
      return { ok: true };
    } catch (err) {
      _qzSessionReady = false;
      console.warn("QZ Tray não conectou:", err);
      const base = formatQzPrintError(err);
      const hint = /untrusted|anonymous|certificate|sign|allow|blocked|invalid/i.test(String(err?.message || err))
        ? `${base} Neste PC: baixe «override.crt» em Empresa, copie para C:\\Program Files\\QZ Tray\\override.crt (como Administrador), reinicie o QZ Tray, importe o certificado no Site Manager e clique Allow (sem Remember).`
        : base;
      return { ok: false, error: hint };
    } finally {
      _qzConnectPromise = null;
    }
  })();
  return _qzConnectPromise;
}

async function qzDisconnect() {
  try {
    if (typeof qz !== "undefined" && qz.websocket.isActive()) await qz.websocket.disconnect();
  } catch { /* ignora */ }
}

async function qzWarmup() {
  if (!getActivePrinter()) return;
  await qzConnect();
}

async function ensureQzPrintSession() {
  if (!isAutoPrintEnabled()) return;
  await qzWarmup();
}

async function listQzPrinters() {
  const names = [];
  try {
    if (typeof qz?.printers?.details === "function") {
      const details = await qz.printers.details();
      const arr = Array.isArray(details) ? details : (details ? [details] : []);
      arr.forEach((item) => {
        const name = item && typeof item === "object" ? item.name : item;
        if (name) names.push(String(name).trim());
      });
    }
  } catch (err) {
    console.warn("qz.printers.details:", err);
  }
  if (!names.length) {
    try {
      const list = await qz.printers.find();
      const arr = Array.isArray(list) ? list : (list ? [list] : []);
      arr.forEach((name) => {
        if (name) names.push(String(name).trim());
      });
    } catch (err) {
      console.warn("qz.printers.find:", err);
    }
  }
  return [...new Set(names.filter(Boolean))];
}

function normalizePrinterName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveQzPrinter(printerName) {
  const wanted = String(printerName || "").trim();
  if (!wanted) return null;

  let names = [];
  try {
    names = await listQzPrinters();
  } catch { /* continua */ }

  const pickMatch = (list, target) => {
    const lower = target.toLowerCase();
    const norm = normalizePrinterName(target);
    return list.find((n) => String(n).toLowerCase() === lower)
      || list.find((n) => normalizePrinterName(n) === norm)
      || list.find((n) => {
        const nl = String(n).toLowerCase();
        return nl.includes(lower) || lower.includes(nl);
      });
  };

  if (names.length) {
    let match = pickMatch(names, wanted);
    if (!match && /epson|tm-?t/i.test(wanted)) {
      const epsonOnly = names.filter((n) => /epson|tm-?t|receipt/i.test(String(n)));
      if (epsonOnly.length === 1) match = epsonOnly[0];
    }
    if (!match) {
      const thermalOnly = names.filter((n) => /epson|tm-?t|pos-|elgin|receipt|thermal|térmica|térmico/i.test(String(n)));
      if (thermalOnly.length === 1) match = thermalOnly[0];
    }
    if (!match && names.length === 1) match = names[0];
    if (!match) {
      try {
        const def = await qz.printers.getDefault();
        const defName = typeof def === "string" ? def : def?.name;
        if (defName && pickMatch(names, wanted) === undefined) {
          const defMatch = pickMatch([defName], wanted) || (names.includes(defName) ? defName : null);
          if (defMatch) match = defMatch;
        }
      } catch { /* ignora */ }
    }
    return match || null;
  }

  try {
    const found = await qz.printers.find(wanted);
    if (Array.isArray(found) && found.length) return found[0];
    if (typeof found === "string" && found) return found;
  } catch { /* continua */ }
  return null;
}

async function validatePrinterOnThisPc(printerName) {
  const wanted = String(printerName || "").trim();
  if (!wanted) {
    return { ok: false, phase: "config", error: "Impressora não cadastrada para este caixa." };
  }
  const connected = await qzConnect();
  if (!connected.ok) {
    return { ok: false, phase: "qz", error: connected.error };
  }
  const available = await listQzPrinters();
  const resolved = await resolveQzPrinter(wanted);
  if (!resolved) {
    const listHint = available.length ? ` Neste PC o QZ vê: ${available.join(" | ")}.` : " QZ não listou impressoras neste PC.";
    return {
      ok: false,
      phase: "printer",
      error: `Impressora "${wanted}" não encontrada.${listHint}`,
      available
    };
  }
  return { ok: true, resolved, available };
}

async function warnRegisterPrinterOnThisPc(register) {
  if (!register?.printer) {
    showPrintToast(
      `⚠️ ${register.name}: impressora não cadastrada. Em Empresa → ${register.name} → «Listar neste PC».`,
      true
    );
    return;
  }
  const check = await validatePrinterOnThisPc(register.printer);
  if (check.ok) return;
  if (check.phase === "qz") {
    showPrintToast(`⚠️ ${register.name}: QZ Tray deste PC não está liberado. Em Empresa → Verificar QZ neste PC.`, true);
    return;
  }
  showPrintToast(`⚠️ ${register.name}: ${check.error}`, true);
}

async function printViaQZ(receiptText, allowRetry = true) {
  const register = getActiveRegister();
  const printerName = getActivePrinter();
  if (!printerName) {
    const hint = isMultiRegisterMode()
      ? `Impressora não configurada para ${register.name}. Em Empresa → Caixas, use «Listar neste PC» no ${register.name} e salve.`
      : "Impressora não configurada em Empresa.";
    return { ok: false, error: hint };
  }

  const connected = await qzConnect();
  if (!connected.ok) return { ok: false, error: connected.error };

  try {
    const resolved = await resolveQzPrinter(printerName);
    if (!resolved) {
      const names = await listQzPrinters();
      const listHint = names.length ? ` Neste PC: ${names.join(" | ")}` : " QZ não listou impressoras — reinicie o QZ Tray neste PC.";
      return {
        ok: false,
        error: `${register.name}: impressora "${printerName}" não encontrada.${listHint} Use «Listar neste PC» no ${register.name} e salve em Empresa.`
      };
    }
    await qzPrintRawEscPos(resolved, receiptText);
    return { ok: true, printer: resolved };
  } catch (err) {
    console.warn("QZ Tray erro ao imprimir:", err);
    if (allowRetry) {
      _qzSessionReady = false;
      try {
        if (typeof qz !== "undefined" && qz.websocket.isActive()) await qz.websocket.disconnect();
      } catch { /* ignora */ }
      return printViaQZ(receiptText, false);
    }
    let extra = "";
    try {
      const names = await listQzPrinters();
      if (names.length) {
        extra = ` QZ Tray vê neste PC: ${names.join(" | ")}.`;
      } else {
        extra = " QZ Tray não listou impressoras — reinicie o QZ Tray (ícone na bandeja) ou configure override.crt neste PC.";
      }
    } catch { /* ignora */ }
    return { ok: false, error: `${register.name}: ${formatQzPrintError(err)}.${extra}` };
  }
}

function printViaWindow(company, items, total, paymentMethod, buyer, date, cashAmountPaid = 0, cashChange = 0, extra = {}) {
  const subtotal = extra.subtotal ?? items.reduce((s, i) => s + Number(i.subtotal || 0), 0);
  const discount = extra.discount ?? Math.max(0, subtotal - Number(total || 0));
  const model = buildReceiptModel({
    company,
    items,
    subtotal,
    discount,
    total,
    paymentMethod,
    payments: extra.payments,
    buyer,
    date,
    cashAmountPaid,
    cashChange,
    saleId: extra.saleId || null,
    orderNumber: extra.orderNumber ?? null,
    orderType: extra.orderType || "BALCÃO",
    registerName: resolveReceiptRegisterName(extra)
  });
  const html = buildReceiptHtml(model);
  const win = window.open("", "_blank", "width=360,height=720");
  if (!win) { alert("Permita popups para imprimir o cupom."); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

async function doPrint(items, total, paymentMethod, buyer, date, cashAmountPaid = 0, cashChange = 0, extra = {}) {
  const { qzOnly = false, ...receiptExtra } = extra;
  const company = state.company || {};
  const receiptText = buildReceiptLines(company, items, total, paymentMethod, buyer, date, cashAmountPaid, cashChange, receiptExtra);
  const result = await printViaQZ(receiptText);
  if (result.ok) return { ok: true, printer: result.printer };
  if (qzOnly) return { ok: false, error: result.error };
  printViaWindow(company, items, total, paymentMethod, buyer, date, cashAmountPaid, cashChange, receiptExtra);
  return { ok: false, error: result.error, fallback: true };
}

function isAutoPrintEnabled() {
  const printer = getActivePrinter();
  const auto = getActiveRegister()?.autoPrintReceipt ?? state.company?.autoPrintReceipt;
  return !!printer && auto !== false;
}

async function autoPrintSaleReceipt(saleId, items, total, paymentMethod, buyer, saleDate, cashAmountPaid, cashChange, extra = {}) {
  if (!isAutoPrintEnabled()) return { ok: false, skipped: true };
  const printerName = getActivePrinter();
  const now = Date.now();
  if (_lastAutoPrintedSaleId === saleId || (now - _lastAutoPrintAt < 1500)) {
    return { ok: true, skipped: true };
  }
  _lastAutoPrintedSaleId = saleId;
  _lastAutoPrintAt = now;
  showPrintToast(`Imprimindo cupom em ${printerName}…`);
  const printed = await doPrint(items, total, paymentMethod, buyer, saleDate, cashAmountPaid, cashChange, {
    qzOnly: true,
    ...extra
  });
  if (printed.ok) {
    flashPrinterStatus(`✅ Cupom enviado para ${printed.printer || printerName}.`);
  } else {
    _lastAutoPrintedSaleId = null;
    const errMsg = printed.error || "Cupom não impresso.";
    flashPrinterStatus(`⚠️ ${errMsg}`, true);
    if (!printed.fallback) showPrintToast(`⚠️ ${errMsg}`, true);
  }
  return printed;
}

function flashPrinterStatus(message, isError = false) {
  showPrintToast(message, isError);
  const el = document.getElementById("printerInfo");
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? "var(--danger)" : "var(--success)";
  setTimeout(() => {
    el.style.color = "";
    updatePrinterInfo();
  }, isError ? 8000 : 4000);
}

// ═══════════════════════════════════════════════════════════════
// IMPRESSORA — teste e status
// ═══════════════════════════════════════════════════════════════
async function testActivePrinter(statusEl) {
  const status = statusEl || document.getElementById("printerStatus") || document.getElementById("printerInfo");
  const register = getActiveRegister();
  const printerName = getActivePrinter();
  const setStatus = (text, color) => {
    if (!status) return;
    status.textContent = text;
    if (color) status.style.color = color;
  };
  if (!printerName) {
    const msg = isMultiRegisterMode()
      ? `⚠️ ${register.name}: impressora não cadastrada. Neste PC, clique «Listar impressoras» e cole o nome em Empresa → ${register.name}.`
      : "⚠️ Configure o nome da impressora em Empresa.";
    setStatus(msg, "orange");
    return { ok: false, error: msg };
  }
  setStatus("Conectando ao QZ Tray...", "var(--muted)");
  if (window.isQzDemoCertificate?.()) {
    setStatus("⚠️ Popup QZ: NÃO marque Remember — clique Allow. Conectando...", "orange");
  }
  const connected = await qzConnect();
  if (!connected.ok) {
    setStatus(`❌ ${connected.error}`, "var(--danger)");
    return { ok: false, error: connected.error };
  }
  const result = await printViaQZ(`--- TESTE ${register.name} ---\nImpressora: ${printerName}\n`);
  if (result.ok) {
    const msg = `✅ ${register.name}: "${result.printer || printerName}" OK!`;
    setStatus(msg, "var(--success)");
    showPrintToast(msg);
    return result;
  }
  setStatus(`❌ ${result.error}`, "var(--danger)");
  showPrintToast(`❌ ${result.error}`, true);
  return result;
}

function fillRegisterPrinterField(printerName, targetRow = null) {
  const row = targetRow || (() => {
    const reg = getActiveRegister();
    const rows = [...document.querySelectorAll("#registersConfigList .register-config-row")];
    let match = rows.find((r) => r.querySelector(".register-name")?.value?.trim() === reg.name);
    if (!match) {
      const idx = getStoreRegisters().findIndex((r) => r.id === reg.id);
      if (idx >= 0) match = rows[idx];
    }
    return match;
  })();
  const input = row?.querySelector(".register-printer") || document.getElementById("companyPrinter");
  if (input) input.value = printerName;
}

async function listPrintersIntoRegisterRow(row) {
  const status = document.getElementById("printerStatus");
  const regName = row?.querySelector(".register-name")?.value?.trim() || "Caixa";
  const setStatus = (text, color) => {
    if (!status) return;
    status.textContent = text;
    if (color) status.style.color = color;
  };
  setStatus(`Buscando impressoras para ${regName} neste PC…`, "var(--muted)");
  const connected = await qzConnect();
  if (!connected.ok) {
    setStatus(`❌ ${regName}: ${connected.error}`, "var(--danger)");
    return;
  }
  try {
    const names = await listQzPrinters();
    const input = row?.querySelector(".register-printer");
    if (!names.length) {
      setStatus(
        `${regName}: QZ conectou mas não listou impressoras. Neste PC: reinicie o QZ Tray, confira o driver da EPSON e clique «Verificar QZ neste PC».`,
        "var(--danger)"
      );
      return;
    }
    if (names.length === 1 && input) {
      input.value = names[0];
      setStatus(`✅ ${regName}: "${names[0]}" preenchido — clique Salvar empresa.`, "var(--success)");
      return;
    }
    setStatus(`${regName} neste PC: ${names.join("  |  ")} — copie o nome exato para o campo e Salve.`, "var(--success)");
  } catch (err) {
    setStatus(`❌ ${regName}: ${err.message || err}`, "var(--danger)");
  }
}

function bindRegisterConfigRow(row, wrap) {
  row.querySelector(".btn-remove-register")?.addEventListener("click", () => {
    const rows = wrap.querySelectorAll(".register-config-row");
    if (rows.length <= 2) {
      alert("Mantenha pelo menos 2 caixas quando o modo multi-caixa estiver ativo.");
      return;
    }
    row.remove();
  });
  row.querySelector(".btn-list-register-printer")?.addEventListener("click", () => {
    listPrintersIntoRegisterRow(row);
  });
}

function setupPrinterTest() {
  document.getElementById("btnListPrinters")?.addEventListener("click", async () => {
    const status = document.getElementById("printerStatus");
    status.textContent = "Buscando impressoras...";
    status.style.color = "var(--muted)";
    const connected = await qzConnect();
    if (!connected.ok) {
      status.textContent = `❌ ${connected.error}`;
      status.style.color = "var(--danger)";
      return;
    }
    try {
      const names = await listQzPrinters();
      if (!names.length) {
        status.textContent = "QZ Tray conectou, mas não listou impressoras. Reinicie o QZ Tray (bandeja do Windows). Se a impressora aparece no Windows, copie o nome em Configurações → Impressoras e cole manualmente no campo do caixa.";
        status.style.color = "var(--danger)";
        return;
      }
      const reg = getActiveRegister();
      const hint = isMultiRegisterMode()
        ? ` — use «Listar neste PC» na linha do ${reg.name} (cada caixa tem impressora diferente)`
        : "";
      if (names.length === 1) {
        fillRegisterPrinterField(names[0]);
        status.textContent = `Impressora neste PC: ${names[0]}. Campo do ${reg.name} preenchido — clique Salvar empresa.${hint}`;
      } else {
        status.textContent = names.join("  |  ") + hint;
      }
      status.style.color = "var(--success)";
    } catch (err) {
      status.textContent = `❌ Erro: ${err.message || err}`;
      status.style.color = "var(--danger)";
    }
  });

  document.getElementById("btnTestPrinter")?.addEventListener("click", () => testActivePrinter(document.getElementById("printerStatus")));
  document.getElementById("btnTestActivePrinter")?.addEventListener("click", () => testActivePrinter(document.getElementById("printerInfo")));
  document.getElementById("btnDownloadQzCert")?.addEventListener("click", downloadQzCertificateForThisPc);
  document.getElementById("btnDownloadQzOverride")?.addEventListener("click", downloadQzOverrideForThisPc);
  document.getElementById("btnVerifyQzPc")?.addEventListener("click", verifyQzPcAuthorization);
  document.getElementById("btnCopyQzSiteUrl")?.addEventListener("click", async () => {
    const site = typeof window.getQzSiteUrl === "function" ? window.getQzSiteUrl() : window.location.origin;
    try {
      await navigator.clipboard.writeText(site);
      alert(`URL copiada: ${site}\n\nUse no Site Manager do QZ Tray deste PC se pedir o endereço do site.`);
    } catch {
      prompt("Copie a URL do site para o Site Manager:", site);
    }
  });
}

async function verifyQzPcAuthorization() {
  const el = document.getElementById("qzPcAuthStatus") || document.getElementById("printerStatus");
  const setMsg = (text, color) => {
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  };
  setMsg("Verificando QZ Tray neste computador… Se aparecer popup, clique Allow (sem Remember).", "var(--muted)");
  try {
    if (typeof window.ensureQzSecurityReady === "function") {
      await window.ensureQzSecurityReady();
    }
    const connected = await qzConnect({ forceSecurity: true });
    if (!connected.ok) {
      setMsg(`❌ Este PC ainda não liberou o QZ: ${connected.error}`, "var(--danger)");
      return { ok: false };
    }
    const names = await listQzPrinters();
    setMsg(
      names.length
        ? `✅ QZ Tray deste PC autorizou o site. Impressoras: ${names.join(" | ")}`
        : "✅ QZ Tray deste PC autorizou o site. Nenhuma impressora listada — confira driver/QZ aberto.",
      "var(--success)"
    );
    return { ok: true };
  } catch (err) {
    setMsg(`❌ ${err.message || err}`, "var(--danger)");
    return { ok: false };
  }
}

async function refreshQzSecurityStatus(forceReload = false) {
  const el = document.getElementById("qzSecurityStatus");
  const pcEl = document.getElementById("qzPcAuthStatus");
  const siteEl = document.getElementById("qzSiteUrlLabel");
  const site = typeof window.getQzSiteUrl === "function" ? window.getQzSiteUrl() : window.location.origin;
  if (siteEl) siteEl.textContent = site;
  if (typeof window.waitForQzSecurity === "function") {
    try {
      await window.waitForQzSecurity(forceReload);
    } catch (err) {
      console.warn("QZ security:", err);
    }
  } else if (typeof setupQZSecurity === "function") {
    await setupQZSecurity(forceReload);
  }
  if (el) {
    if (window.isQzSecurityReady?.()) {
      el.textContent = "ℹ️ Certificado do site carregado no navegador — isso NÃO significa que este PC já liberou o QZ Tray. Use «Verificar QZ neste PC» ou importe o certificado no Site Manager.";
      el.style.color = "#e6a817";
    } else {
      el.textContent = "⚠️ Certificado não carregou do site — verifique qz-certificate.txt no servidor.";
      el.style.color = "var(--danger)";
    }
  }
  if (pcEl && !pcEl.textContent) {
    pcEl.textContent = "Clique «Verificar QZ neste PC» para saber se o popup ainda vai aparecer neste computador.";
    pcEl.style.color = "var(--muted)";
  }
}

async function downloadQzOverrideForThisPc() {
  const status = document.getElementById("printerStatus");
  try {
    if (typeof window.downloadQzOverrideForPc !== "function") {
      throw new Error("Atualize a página (Ctrl+F5).");
    }
    await window.downloadQzOverrideForPc();
    if (status) {
      status.textContent = "✅ override.crt baixado. Copie para C:\\Program Files\\QZ Tray\\override.crt (Administrador), reinicie o QZ Tray e teste de novo.";
      status.style.color = "var(--success)";
    }
  } catch (err) {
    if (status) {
      status.textContent = `❌ ${err.message || err}`;
      status.style.color = "var(--danger)";
    }
  }
}

async function downloadQzCertificateForThisPc() {
  const status = document.getElementById("printerStatus");
  try {
    if (typeof window.downloadQzCertificateForImport !== "function") {
      throw new Error("Função de download indisponível. Atualize a página (Ctrl+F5).");
    }
    await window.downloadQzCertificateForImport();
    if (status) {
      status.textContent = "✅ Arquivo digital-certificate.txt baixado. QZ Tray → Advanced → Site Manager → Import → selecione esse arquivo neste PC.";
      status.style.color = "var(--success)";
    }
  } catch (err) {
    if (status) {
      status.textContent = `❌ ${err.message || err}`;
      status.style.color = "var(--danger)";
    }
  }
}

function updatePrinterInfo() {
  const el = document.getElementById("printerInfo");
  if (!el) return;
  const printer = getActivePrinter();
  const register = getActiveRegister();
  const qzOk = window.isQzSecurityReady?.();
  const regLabel = register?.name && register.id !== "default" ? `${register.name}: ` : "";
  if (printer && isAutoPrintEnabled()) {
    el.textContent = qzOk
      ? `🖨️ Cupom automático: ${regLabel}${printer} (v202606211)`
      : `🖨️ Cupom automático: ${regLabel}${printer} — neste PC clique «Verificar QZ neste PC» em Empresa`;
  } else if (printer) {
    el.textContent = `🖨️ Impressora ${regLabel}${printer} — use o botão Imprimir (automático desligado)`;
  } else {
    el.textContent = isMultiRegisterMode()
      ? `⚠️ ${register.name}: impressora não cadastrada — configure em Empresa → Caixas (use «Listar impressoras» neste PC).`
      : "🖨️ Configure a impressora em Empresa para cupom automático.";
  }
}

// ═══════════════════════════════════════════════════════════════
// LICENÇA
// ═══════════════════════════════════════════════════════════════
async function loadLicense() {
  if (!state.user) return { valid: false, reason: "Usuário não autenticado." };
  const snap = await db.collection("licenses").doc(state.user.uid).get();
  state.license = snap.exists ? snap.data() : null;
  if (state.isAdmin) return { valid: true, reason: "" };
  if (!snap.exists) {
    return { valid: false, reason: "Licença não encontrada. Fale com o suporte para ativar." };
  }
  const license = state.license;
  const status = normalizeLicenseStatus(license.status);
  const plan = normalizeLicensePlan(license.plan);
  if (status !== "active") return { valid: false, reason: "Licença inativa. Regularize o pagamento." };
  if (plan === "monthly") {
    const expiresIso = getLicenseExpiresIso(license);
    if (!expiresIso) return { valid: false, reason: "Licença mensal sem data de validade." };
    if (getDaysUntilIsoDate(expiresIso) < 0) return { valid: false, reason: "Licença mensal expirada. Renove para continuar." };
  }
  return { valid: true, reason: "" };
}

// ═══════════════════════════════════════════════════════════════
// CARREGAMENTO DE DADOS
// ═══════════════════════════════════════════════════════════════
async function loadCompany() {
  const storeRef = getStoreRef();
  if (!storeRef) return;
  const snap = await storeRef.get();
  if (!snap.exists) {
    const defaultCompany = {
      name: state.user?.displayName || "BROTHER'S",
      logo: "",
      pix: "",
      phone: "",
      whatsapp: "",
      address: "",
      printer: "",
      ownerName: state.user?.displayName || "",
      deliveryEnabled: true,
      deliverySlug: "",
      deliveryFee: 0,
      deliveryMinOrder: 0,
      cashRegisterRequired: false,
      autoPrintReceipt: false
    };
    await storeRef.set(defaultCompany);
    state.company = defaultCompany;
  } else {
    state.company = snap.data();
  }
  refreshActiveRegisterFromCompany();
  try {
    await ensureStoreDeliveryLink();
  } catch (err) {
    console.error("ensureStoreDeliveryLink:", err);
    updateDeliveryLinkUI(err.message || String(err));
    renderDeliveryTabLink(err.message || String(err));
  }
}

async function loadProducts() {
  const storeRef = getStoreRef();
  if (!storeRef) return;
  const snap = await storeRef.collection("products").get();
  state.products = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function loadSales() {
  const storeRef = getStoreRef();
  if (!storeRef) return;
  const snap = await storeRef.collection("sales").orderBy("createdAt", "desc").get();
  state.sales = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function loadPendingAccounts() {
  const storeRef = getStoreRef();
  if (!storeRef) return;
  const snap = await storeRef.collection("pendingAccounts").get();
  state.pendingAccounts = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function formatFinalizeSaleError(err) {
  const msg = String(err?.message || err || "");
  if (/quota|resource-exhausted|resource_exhausted/i.test(msg)) {
    return (
      "Limite de uso do Firebase (cota de leituras/gravações) foi atingido.\n\n" +
      "Isso costuma acontecer no plano gratuito com muitas vendas ou muitos recarregamentos.\n" +
      "No Console do Firebase → Uso e faturamento: ative faturamento ou aguarde o reinício da cota diária."
    );
  }
  return `Erro ao finalizar venda: ${msg}`;
}

// ═══════════════════════════════════════════════════════════════
// BRANDING
// ═══════════════════════════════════════════════════════════════
function updateTopbarBranding() {
  const company = state.company || {};
  const nameEl = document.getElementById("sidebarBrandName");
  const logoEl = document.getElementById("sidebarLogo");
  if (nameEl) nameEl.textContent = company.name || "STOCK PDV";
  if (logoEl) {
    if (company.logo) {
      logoEl.src = company.logo;
      logoEl.alt = company.name || "Logo da loja";
      logoEl.style.display = "inline-block";
    } else {
      logoEl.style.display = "none";
    }
  }
  // Atualiza também a topbar mobile
  const mobileNameEl = document.getElementById("mobileTopbarName");
  if (mobileNameEl) mobileNameEl.textContent = company.name || "STOCK PDV";
  if (typeof window.applyWebAppBranding === "function") {
    window.applyWebAppBranding(company);
  }
}

function setBootMessage(text) {
  const el = document.getElementById("bootScreenText");
  if (el && text) el.textContent = text;
}

function hideBootScreen() {
  document.getElementById("bootScreen")?.classList.add("hidden");
}

function requireAuthUI() {
  const logged = !!state.user;
  const loginScreen = document.getElementById("loginScreen");
  const appShell = document.getElementById("appShell");
  if (loginScreen) loginScreen.classList.toggle("hidden", logged);
  if (appShell) appShell.classList.toggle("hidden", !logged);

  if (logged && state.user) {
    const email = state.user.email || "";
    const labelEl = document.getElementById("loggedUserLabel");
    if (labelEl) labelEl.textContent = email;
    const avatarEl = document.getElementById("userAvatar");
    if (avatarEl) avatarEl.textContent = email.charAt(0).toUpperCase();
    const roleEl = document.getElementById("userRoleLabel");
    if (roleEl) roleEl.textContent = state.isAdmin ? "Administrador" : "Operador";
    const adminBtn = document.getElementById("adminNavBtn");
    if (adminBtn) adminBtn.classList.toggle("hidden", !state.isAdmin);
    if (typeof window.updatePwaInstallButton === "function") {
      window.updatePwaInstallButton();
    }
    updateRestrictedNavUI();
    hideBootScreen();
  } else if (!logged) {
    hideBootScreen();
  }
}

// ═══════════════════════════════════════════════════════════════
// NAVEGAÇÃO (SIDEBAR)
// ═══════════════════════════════════════════════════════════════
function activateTab(btn, tabId, options = {}) {
  const skipRestrictedCheck = !!options.skipRestrictedCheck;
  if (!skipRestrictedCheck && isRestrictedTab(tabId) && requiresManagerPassword() && !hasManagerAreaAccess()) {
    return;
  }
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((t) => {
    t.classList.remove("active");
    t.classList.add("hidden");
  });
  btn.classList.add("active");
  const tab = document.getElementById(tabId);
  if (tab) {
    tab.classList.add("active");
    tab.classList.remove("hidden");
    tab.scrollTop = 0;
    if (tabId === "deliveryTab") onDeliveryTabActivated();
    if (tabId === "relatoriosTab") onReportsTabActivated();
    if (tabId === "aiTab" && typeof window.onAITabActivated === "function") window.onAITabActivated();
  }
}

function setupTabs() {
  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tabId = btn.dataset.tab;
      if (isRestrictedTab(tabId)) {
        const label = RESTRICTED_TAB_LABELS[tabId] || tabId;
        if (!(await ensureManagerAreaAccess(label))) return;
      }
      activateTab(btn, tabId);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
function setupAuth() {
  document.getElementById("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("registerName").value.trim();
    const email = document.getElementById("registerEmail").value.trim().toLowerCase();
    const password = document.getElementById("registerPassword").value;
    if (!name || !email || !password) return;
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: name });
      await getStoreRef()?.set({ name: "BROTHER'S", logo: "", pix: "", phone: "", address: "", printer: "", ownerName: name }, { merge: true });
      await db.collection("customers").doc(cred.user.uid).set({ uid: cred.user.uid, name, email, createdAt: new Date().toISOString() }, { merge: true });
      e.target.reset();
    } catch (error) { alert(`Erro ao cadastrar: ${error.message}`); }
  });

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim().toLowerCase();
    const password = document.getElementById("loginPassword").value;
    try { await auth.signInWithEmailAndPassword(email, password); e.target.reset(); }
    catch (error) { alert(`Erro no login: ${error.message}`); }
  });

  document.getElementById("btnLogout").addEventListener("click", async () => {
    await qzDisconnect();
    unsubscribeDeliveryOrders();
    await auth.signOut();
    state.cart = [];
    state.pendingAccounts = [];
    state.cashSession = null;
    state.cashSessions = [];
    state.activeRegister = null;
    state.activeOperator = null;
    clearRegisterOperatorSession();
    clearAllManagerAreaAccess();
    state.financeTransactions = [];
    document.getElementById("licenseExpiryBanner")?.classList.add("hidden");
    requireAuthUI();
  });

  auth.onAuthStateChanged(async (firebaseUser) => {
    state.user = firebaseUser;
    state.license = null;
    state.isAdmin = isAdminUser(firebaseUser);
    state.adminUsers = [];
    state.pendingAccounts = [];
    state.cart = [];
    unsubscribeDeliveryOrders();
    requireAuthUI();
    if (!firebaseUser) return;

    setBootMessage("Verificando licença…");
    try {
      const licenseCheck = await loadLicense();
      if (!licenseCheck.valid) {
        hideBootScreen();
        alert(licenseCheck.reason);
        await auth.signOut();
        return;
      }
      setBootMessage("Carregando dados da loja…");
      await loadCompany();
      await loadProducts();
      renderAll();
      hideBootScreen();

      ensureProductCategoryTree().then(() => {
        renderProducts(
          document.getElementById("searchProduct")?.value || "",
          getProductCategoryFilter()
        );
      }).catch((err) => console.error("Categorias:", err));

      setBootMessage("Carregando vendas…");
      await loadSales();
      await loadPendingAccounts();
      restoreRegisterAndOperatorFromSession();
      await loadCashSessions();
      await loadFinanceTransactions();
      await ensureRegisterAndOperatorSession();
      if (isAutoPrintEnabled()) {
        ensureQzPrintSession().catch(() => {});
      }
      if (state.isAdmin) {
        try {
          await loadAdminUsers();
          renderAdminUsers();
        } catch (err) {
          console.error("Admin panel:", err);
          alert(
            `Erro ao carregar painel Admin: ${err.message || err}\n\n` +
            "Se acabou de restaurar o projeto, publique as regras: firebase deploy --only firestore:rules"
          );
        }
      }
      subscribeDeliveryOrders();
      renderAll();
      if (!normalizeDeliverySlug(state.company?.deliverySlug)) {
        await ensureStoreDeliveryLink();
      }
      updateDeliveryLinkUI();
      renderDeliveryTabLink();
      updateTopbarBranding();
      updatePrinterInfo();
      updateRestrictedNavUI();
      await refreshQzSecurityStatus();
      await refreshLicenseExpiryBanner();
    } catch (err) {
      console.error("Login:", err);
      hideBootScreen();
      alert(`Erro ao carregar o sistema: ${err.message || err}\n\nTente fechar e abrir de novo (Ctrl+F5).`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════
async function loadAdminUsers() {
  if (!state.isAdmin) return;
  const [customersSnap, storesSnap, licensesSnap] = await Promise.all([
    db.collection("customers").get(),
    db.collection("stores").get(),
    db.collection("licenses").get()
  ]);
  const licenseByUid = new Map();
  licensesSnap.docs.forEach((doc) => {
    licenseByUid.set(doc.id, { ...(doc.data() || {}), uid: doc.id });
  });
  const userMap = new Map();
  customersSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const key = data.uid || doc.id;
    userMap.set(key, {
      uid: key,
      id: key,
      name: data.name || data.ownerName || "",
      email: String(data.email || "").trim().toLowerCase(),
      source: "customers"
    });
  });
  storesSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const key = doc.id;
    const existing = userMap.get(key);
    const lic = licenseByUid.get(key);
    const email = String(data.email || existing?.email || lic?.email || "").trim().toLowerCase();
    if (existing) {
      if (!existing.email && email) existing.email = email;
      if (!existing.name) existing.name = data.ownerName || data.name || "";
      existing.source = existing.source || "stores";
    } else {
      userMap.set(key, {
        uid: key,
        id: key,
        name: data.ownerName || data.name || "",
        email,
        source: "stores"
      });
    }
  });
  const users = [...userMap.values()].map((base) => ({
    ...base,
    license: licenseByUid.get(base.uid) || null,
    email: base.email || String(licenseByUid.get(base.uid)?.email || "").trim().toLowerCase()
  }));
  state.adminUsers = users.sort((a, b) => `${a.email} ${a.name}`.localeCompare(`${b.email} ${b.name}`));
}

async function resolveAdminAccountByEmail(email, explicitUid = "") {
  const key = String(email || "").trim().toLowerCase();
  const uidHint = String(explicitUid || "").trim();
  if (uidHint) {
    const storeSnap = await db.collection("stores").doc(uidHint).get();
    if (storeSnap.exists) {
      return { uid: uidHint, email: key || storeSnap.data()?.email || "", name: storeSnap.data()?.name || "" };
    }
  }
  if (!key) return null;

  if (!state.adminUsers.length) await loadAdminUsers();
  const cached = findAdminUserByEmail(key);
  if (cached?.uid) return cached;

  const slugBase = normalizeDeliverySlug(key.split("@")[0]);
  if (slugBase) {
    const slugCandidates = [slugBase];
    for (let n = 1; n <= 5; n += 1) slugCandidates.push(`${slugBase}-${n}`);
    for (const candidate of slugCandidates) {
      const doc = await db.collection("storePublic").doc(candidate).get();
      const uid = doc.exists ? String(doc.data()?.uid || "").trim() : "";
      if (uid) {
        return {
          uid,
          email: key,
          name: doc.data()?.name || doc.data()?.storeName || ""
        };
      }
    }
  }

  const licensesSnap = await db.collection("licenses").get();
  const licenseDoc = licensesSnap.docs.find(
    (doc) => String(doc.data()?.email || "").trim().toLowerCase() === key
  );
  if (licenseDoc) {
    return {
      uid: licenseDoc.id,
      email: key,
      license: licenseDoc.data(),
      name: licenseDoc.data()?.name || ""
    };
  }

  const customersSnap = await db.collection("customers").get();
  const customerDoc = customersSnap.docs.find((doc) => {
    const data = doc.data() || {};
    return String(data.email || "").trim().toLowerCase() === key;
  });
  if (customerDoc) {
    const data = customerDoc.data() || {};
    return {
      uid: String(data.uid || customerDoc.id),
      email: key,
      name: data.name || data.ownerName || ""
    };
  }

  if (state.user?.email?.toLowerCase() === key && state.user?.uid) {
    const storeSnap = await db.collection("stores").doc(state.user.uid).get();
    if (storeSnap.exists) {
      return {
        uid: state.user.uid,
        email: key,
        name: state.user.displayName || storeSnap.data()?.name || ""
      };
    }
  }

  const storesSnap = await db.collection("stores").get();
  const storeDoc = storesSnap.docs.find((doc) => {
    const data = doc.data() || {};
    return String(data.email || "").trim().toLowerCase() === key;
  });
  if (storeDoc) {
    const data = storeDoc.data() || {};
    return {
      uid: storeDoc.id,
      email: key,
      name: data.ownerName || data.name || ""
    };
  }

  return null;
}

function setupAdmin() {
  document.getElementById("adminSearchUser").addEventListener("input", renderAdminUsers);
  document.getElementById("btnAdminSaveLicense").addEventListener("click", saveAdminLicense);
  document.getElementById("btnAdminCopyStore")?.addEventListener("click", adminCopyStoreData);
  document.getElementById("btnAdminClearOperators")?.addEventListener("click", adminClearOperatorsForTarget);
  document.getElementById("btnAdminActivateDelivery")?.addEventListener("click", adminActivateDeliveryForTarget);
}

function findAdminUserByEmail(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  return state.adminUsers.find((u) => String(u.email || "").trim().toLowerCase() === key) || null;
}

async function deleteCollectionDocs(collectionRef, batchSize = 400) {
  const snap = await collectionRef.get();
  if (snap.empty) return 0;
  let deleted = 0;
  let batch = db.batch();
  let inBatch = 0;
  for (const docSnap of snap.docs) {
    batch.delete(docSnap.ref);
    inBatch += 1;
    deleted += 1;
    if (inBatch >= batchSize) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch) await batch.commit();
  return deleted;
}

async function copyCollectionDocs(sourceRef, targetRef, batchSize = 400) {
  const snap = await sourceRef.get();
  if (snap.empty) return 0;
  let copied = 0;
  let batch = db.batch();
  let inBatch = 0;
  for (const docSnap of snap.docs) {
    batch.set(targetRef.doc(docSnap.id), docSnap.data());
    inBatch += 1;
    copied += 1;
    if (inBatch >= batchSize) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch) await batch.commit();
  return copied;
}

function sanitizeStoreCopyPayload(data) {
  const next = { ...(data || {}) };
  next.deliverySlug = "";
  next.deliveryEnabled = true;
  next.printer = "";
  next.autoPrintReceipt = false;
  delete next.managerAreaPassword;
  next.managerAreaPasswordEnabled = false;
  next.operators = [];
  next.multiRegisterEnabled = false;
  next.registers = [];
  next.cashRegisterRequired = false;
  return next;
}

async function adminCopyStoreData() {
  if (!state.isAdmin) {
    alert("Apenas o administrador pode copiar dados entre lojas.");
    return;
  }
  const statusEl = document.getElementById("adminCopyStoreStatus");
  const setStatus = (text, color) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = color || "var(--muted)";
  };

  const sourceEmail = document.getElementById("adminCopySourceEmail")?.value.trim().toLowerCase();
  const targetEmail = document.getElementById("adminCopyTargetEmail")?.value.trim().toLowerCase();
  const copyProducts = !!document.getElementById("adminCopyProducts")?.checked;
  const copyCategories = !!document.getElementById("adminCopyCategories")?.checked;
  const replaceProducts = !!document.getElementById("adminCopyReplaceProducts")?.checked;

  if (!sourceEmail || !targetEmail) {
    alert("Informe os e-mails de origem e destino.");
    return;
  }
  if (sourceEmail === targetEmail) {
    alert("Origem e destino não podem ser o mesmo e-mail.");
    return;
  }
  if (!copyProducts && !copyCategories) {
    alert("Marque ao menos uma opção para copiar.");
    return;
  }

  if (!state.adminUsers.length) await loadAdminUsers();
  const sourceUidHint = document.getElementById("adminCopySourceUid")?.value.trim() || "";
  const targetUidHint = document.getElementById("adminCopyTargetUid")?.value.trim() || "";
  const sourceUser = await resolveAdminAccountByEmail(sourceEmail, sourceUidHint);
  const targetUser = await resolveAdminAccountByEmail(targetEmail, targetUidHint);
  if (!sourceUser?.uid) {
    alert(
      `Conta origem não encontrada: ${sourceEmail}\n\n` +
      "Tente colar o UID da conta no campo «UID origem» (veja na lista de clientes acima) ou confira o link delivery da loja."
    );
    return;
  }
  if (!targetUser?.uid) {
    alert(
      `Conta destino não encontrada: ${targetEmail}\n\n` +
      "Peça para o cliente entrar uma vez no PDV ou cole o UID no campo «UID destino»."
    );
    return;
  }

  const summary = [
    `Origem: ${sourceEmail}`,
    `Destino: ${targetEmail}`,
    copyProducts ? "• Produtos" : null,
    copyCategories ? "• Categorias / estrutura da loja" : null,
    replaceProducts && copyProducts ? "• Apaga produtos atuais do destino antes" : null,
    "",
    "Não copia vendas, caixa, fiado nem delivery."
  ].filter((line) => line !== null).join("\n");

  if (!confirm(`Confirmar cópia?\n\n${summary}`)) return;

  const btn = document.getElementById("btnAdminCopyStore");
  if (btn) btn.disabled = true;
  setStatus("Copiando… aguarde.", "var(--muted)");

  try {
    const sourceRef = db.collection("stores").doc(sourceUser.uid);
    const targetRef = db.collection("stores").doc(targetUser.uid);
    const sourceSnap = await sourceRef.get();
    if (!sourceSnap.exists) {
      throw new Error(`Loja origem (${sourceEmail}) não tem dados no Firestore.`);
    }

    let deletedProducts = 0;
    let copiedProducts = 0;

    if (copyProducts && replaceProducts) {
      setStatus("Apagando produtos atuais do destino…", "var(--muted)");
      deletedProducts = await deleteCollectionDocs(targetRef.collection("products"));
    }

    if (copyCategories) {
      setStatus("Copiando categorias e configurações da loja…", "var(--muted)");
      const payload = sanitizeStoreCopyPayload(sourceSnap.data());
      await targetRef.set(payload, { merge: true });
    } else {
      await targetRef.set({ operators: [], cashRegisterRequired: false }, { merge: true });
    }

    if (copyProducts) {
      setStatus("Copiando produtos…", "var(--muted)");
      copiedProducts = await copyCollectionDocs(
        sourceRef.collection("products"),
        targetRef.collection("products")
      );
    }

    let deliveryResult = null;
    setStatus(
      `✅ Concluído: ${copiedProducts} produto(s) copiado(s)` +
      `${deletedProducts ? `, ${deletedProducts} removido(s) do destino antes` : ""}. ` +
      `Peça para ${targetEmail} entrar no PDV com Ctrl+F5.`,
      "var(--success)"
    );
    if (copyCategories) {
      setStatus("Ativando cardápio online do cliente…", "var(--muted)");
      deliveryResult = await adminActivateDeliveryForUid(targetUser.uid, targetEmail);
      if (deliveryResult.ok) {
        setStatus(
          `✅ Cópia concluída e cardápio ativo: ${deliveryResult.url}`,
          "var(--success)"
        );
      } else {
        setStatus(
          `✅ Cópia ok, mas cardápio falhou: ${deliveryResult.reason}. Use «Ativar cardápio (destino)».`,
          "var(--danger)"
        );
      }
    }
    alert(
      `Cópia concluída!\n\n` +
      `Produtos copiados: ${copiedProducts}\n` +
      (deletedProducts ? `Produtos removidos do destino: ${deletedProducts}\n` : "") +
      (copyCategories && deliveryResult?.ok ? `\nCardápio: ${deliveryResult.url}\n` : "") +
      `\nPeça para ${targetEmail} atualizar a página (Ctrl+F5).`
    );
  } catch (err) {
    console.error("adminCopyStoreData:", err);
    const msg = String(err?.message || err);
    setStatus(`❌ Erro: ${msg}`, "var(--danger)");
    alert(`Erro ao copiar dados:\n\n${msg}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function adminActivateDeliveryForUid(uid, email = "") {
  if (!uid || !db) return { ok: false, reason: "UID ou Firebase inválido." };
  const storeRef = db.collection("stores").doc(uid);
  const snap = await storeRef.get();
  const company = snap.exists ? { ...(snap.data() || {}) } : {};
  const prevSlug = normalizeDeliverySlug(company.deliverySlug);
  let slug = normalizeDeliverySlug(company.deliverySlug);
  if (!slug || isUglyDeliverySlug(slug)) {
    const base = buildDefaultDeliverySlugBase(company, email);
    slug = await findAvailableDeliverySlug(base, uid);
  } else {
    slug = await findAvailableDeliverySlug(slug, uid);
  }
  company.deliveryEnabled = true;
  company.deliverySlug = slug;
  await storeRef.set({ deliveryEnabled: true, deliverySlug: slug }, { merge: true });
  await syncStorePublic(company, { ownerUid: uid, prevSlug });
  const url = getDeliveryPublicUrl(slug);
  return { ok: true, slug, url };
}

async function adminActivateDeliveryForTarget() {
  if (!state.isAdmin) {
    alert("Apenas o administrador pode ativar o cardápio.");
    return;
  }
  const statusEl = document.getElementById("adminCopyStoreStatus");
  const setStatus = (text, color) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = color || "var(--muted)";
  };
  const targetEmail = document.getElementById("adminCopyTargetEmail")?.value.trim().toLowerCase();
  const targetUidHint = document.getElementById("adminCopyTargetUid")?.value.trim() || "";
  if (!targetEmail && !targetUidHint) {
    alert("Informe o e-mail ou UID do cliente destino.");
    return;
  }
  if (!state.adminUsers.length) await loadAdminUsers();
  const targetUser = await resolveAdminAccountByEmail(targetEmail, targetUidHint);
  if (!targetUser?.uid) {
    alert(`Conta não encontrada: ${targetEmail || targetUidHint}`);
    return;
  }
  const btn = document.getElementById("btnAdminActivateDelivery");
  if (btn) btn.disabled = true;
  setStatus("Ativando cardápio online…", "var(--muted)");
  try {
    const result = await adminActivateDeliveryForUid(targetUser.uid, targetEmail || targetUser.email);
    if (!result.ok) throw new Error(result.reason || "Falha ao publicar cardápio.");
    setStatus(`✅ Cardápio ativo: ${result.url}`, "var(--success)");
    alert(
      `Cardápio online ativado!\n\n` +
      `Link: ${result.url}\n\n` +
      `Peça para ${targetEmail || targetUser.uid} dar Ctrl+F5 no PDV.`
    );
  } catch (err) {
    console.error("adminActivateDeliveryForTarget:", err);
    setStatus(`❌ ${err.message || err}`, "var(--danger)");
    alert(`Erro ao ativar cardápio:\n\n${err.message || err}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function adminClearOperatorsForTarget() {
  if (!state.isAdmin) {
    alert("Apenas o administrador pode limpar operadores.");
    return;
  }
  const statusEl = document.getElementById("adminCopyStoreStatus");
  const setStatus = (text, color) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = color || "var(--muted)";
  };
  const targetEmail = document.getElementById("adminCopyTargetEmail")?.value.trim().toLowerCase();
  const targetUidHint = document.getElementById("adminCopyTargetUid")?.value.trim() || "";
  if (!targetEmail && !targetUidHint) {
    alert("Informe o e-mail ou UID do cliente destino.");
    return;
  }
  if (!state.adminUsers.length) await loadAdminUsers();
  const targetUser = await resolveAdminAccountByEmail(targetEmail, targetUidHint);
  if (!targetUser?.uid) {
    alert(`Conta não encontrada: ${targetEmail || targetUidHint}`);
    return;
  }
  if (!confirm(`Remover todos os operadores de ${targetEmail || targetUser.uid}?\n\nO PDV não pedirá login de operador até o cliente cadastrar de novo em Empresa.`)) {
    return;
  }
  const btn = document.getElementById("btnAdminClearOperators");
  if (btn) btn.disabled = true;
  setStatus("Limpando operadores…", "var(--muted)");
  try {
    await db.collection("stores").doc(targetUser.uid).set({
      operators: [],
      cashRegisterRequired: false
    }, { merge: true });
    setStatus(`✅ Operadores removidos de ${targetEmail || targetUser.uid}. Cliente deve dar Ctrl+F5.`, "var(--success)");
    alert("Operadores removidos. Peça para o cliente atualizar a página (Ctrl+F5).");
  } catch (err) {
    console.error("adminClearOperatorsForTarget:", err);
    setStatus(`❌ ${err.message || err}`, "var(--danger)");
    alert(`Erro: ${err.message || err}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderAdminUsers() {
  if (!state.isAdmin) return;
  const q = document.getElementById("adminSearchUser").value.trim().toLowerCase();
  const list = document.getElementById("adminUsersList");
  const filtered = state.adminUsers.filter((u) =>
    String(u.name || "").toLowerCase().includes(q) ||
    String(u.email || "").toLowerCase().includes(q) ||
    String(u.uid || "").toLowerCase().includes(q)
  );
  list.innerHTML = filtered.length
    ? filtered.map((u) => `<li>
        <span>${u.name || "-"} | ${u.email || "-"} | ${u.license?.status || "sem licença"} | ${u.license?.plan || "-"}</span>
        <button class="btn" onclick="editAdminLicense('${u.uid || u.id}')">Editar</button>
      </li>`).join("")
    : "<li>Nenhum cliente encontrado.</li>";
}

window.editAdminLicense = (userId) => {
  if (!state.isAdmin) return;
  const user = state.adminUsers.find((u) => (u.uid || u.id) === userId);
  if (!user) return;
  document.getElementById("adminLicenseUid").value = user.uid || user.id;
  document.getElementById("adminLicenseUidView").value = user.uid || user.id;
  document.getElementById("adminLicenseEmail").value = user.email || "";
  document.getElementById("adminLicenseStatus").value = user.license?.status || "active";
  document.getElementById("adminLicensePlan").value = user.license?.plan || "monthly";
  const rawExpires = getLicenseExpiryField(user.license);
  const expiresInput = document.getElementById("adminLicenseExpiresAt");
  const expiresIso = getLicenseExpiresIso(user.license);
  expiresInput.value = expiresIso || "";
};

async function saveAdminLicense() {
  if (!state.isAdmin) return;
  const hiddenUid = document.getElementById("adminLicenseUid").value.trim();
  const typedUid = document.getElementById("adminLicenseUidView").value.trim();
  const uidValue = hiddenUid || typedUid;
  if (!uidValue) { alert("Selecione um cliente ou informe o UID manualmente."); return; }
  const status = document.getElementById("adminLicenseStatus").value;
  const plan = document.getElementById("adminLicensePlan").value;
  const expiresInput = document.getElementById("adminLicenseExpiresAt").value;
  const payload = { status, plan, updatedAt: new Date().toISOString(), updatedBy: state.user?.email || "" };
  const typedEmail = document.getElementById("adminLicenseEmail").value.trim();
  if (typedEmail) payload.email = typedEmail;
  if (plan === "monthly") {
    const expiresDateOnly = normalizeExpiresInput(expiresInput);
    if (!expiresDateOnly) {
      alert("Informe a data de vencimento válida (use o calendário do campo).");
      return;
    }
    payload.expiresAt = expiresDateOnly;
  } else if (firebase?.firestore?.FieldValue) {
    payload.expiresAt = firebase.firestore.FieldValue.delete();
  }
  try {
    await db.collection("licenses").doc(uidValue).set(payload, { merge: true });
    document.getElementById("adminLicenseUid").value = uidValue;
    await loadAdminUsers();
    renderAdminUsers();
    editAdminLicense(uidValue);
    if (uidValue === state.user?.uid) {
      const snap = await db.collection("licenses").doc(uidValue).get();
      state.license = snap.exists ? snap.data() : null;
      await refreshLicenseExpiryBanner();
    }
    alert("Licença atualizada com sucesso.");
  } catch (error) {
    const msg = String(error?.message || error);
    if (/permission|insufficient/i.test(msg)) {
      alert(
        `Sem permissão para salvar licença.\n\n${msg}\n\n` +
        "Publique as regras do Firebase: firebase deploy --only firestore:rules\n" +
        "Entre com o e-mail admin (piresgustavo03@gmail.com)."
      );
    } else {
      alert(`Erro ao atualizar licença: ${msg}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// EMPRESA + DELIVERY (link público)
// ═══════════════════════════════════════════════════════════════
function normalizeDeliverySlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getDeliveryPublicOrigin() {
  const configured = String(window.DELIVERY_PUBLIC_ORIGIN || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return window.location.origin;
}

function getDeliveryPublicUrl(slug) {
  const clean = normalizeDeliverySlug(slug);
  if (!clean) return "";
  const origin = getDeliveryPublicOrigin();
  return `${origin}/loja/${encodeURIComponent(clean)}`;
}

/** Formato antigo (?loja=) — mantido só como referência alternativa */
function getDeliveryPublicUrlLegacy(slug) {
  const clean = normalizeDeliverySlug(slug);
  if (!clean) return "";
  const origin = getDeliveryPublicOrigin();
  return `${origin}/delivery.html?loja=${encodeURIComponent(clean)}`;
}

function slugFromEmail(email) {
  return normalizeDeliverySlug(String(email || "").split("@")[0]);
}

async function findAvailableDeliverySlug(baseSlug, ownerUid = state.user?.uid) {
  const fallback = `loja-${String(ownerUid || "").slice(0, 8)}`;
  let slug = normalizeDeliverySlug(baseSlug) || fallback;
  let candidate = slug;
  for (let n = 0; n < 50; n += 1) {
    const doc = await db.collection("storePublic").doc(candidate).get();
    if (!doc.exists || doc.data()?.uid === ownerUid) return candidate;
    candidate = `${slug}-${n + 1}`;
  }
  return `${slug}-${String(ownerUid).slice(0, 6)}`;
}

function isUglyDeliverySlug(slug) {
  const s = normalizeDeliverySlug(slug);
  if (!s) return true;
  if (/^loja-[a-z0-9]{18,}$/i.test(s)) return true;
  if (state.user?.uid && s.includes(state.user.uid.replace(/[^a-z0-9]/gi, "").slice(0, 12))) return true;
  return false;
}

function buildDefaultDeliverySlugBase(company, email = state.user?.email) {
  const fromEmail = slugFromEmail(email);
  const fromName = normalizeDeliverySlug(company?.name);
  const genericNames = new Set([
    "brothers", "brother-s", "stock-pdv", "master-stock",
    "adega-teste", "adega", "loja", "empresa"
  ]);
  if (fromEmail && fromEmail.length >= 3) return fromEmail;
  if (fromName && fromName.length >= 3 && !genericNames.has(fromName)) return fromName;
  return fromEmail || fromName || `loja-${String(state.user?.uid || "").slice(0, 8)}`;
}

/** Gera slug + publica link automaticamente para cada login que ainda não tem. */
async function ensureStoreDeliveryLink(options = {}) {
  if (!state.user?.uid || !db) return { ok: false, reason: "Sem usuário ou Firebase." };
  const forceRegenerate = !!options.forceRegenerate;
  const company = { ...(state.company || {}) };
  let slug = normalizeDeliverySlug(company.deliverySlug);
  let needsSave = false;
  let publishError = "";

  const shouldReplaceSlug = !slug || forceRegenerate || isUglyDeliverySlug(slug);
  if (shouldReplaceSlug) {
    const base = buildDefaultDeliverySlugBase(company);
    try {
      slug = await findAvailableDeliverySlug(base);
    } catch (err) {
      console.warn("Busca de slug:", err);
      slug = slugFromEmail(state.user?.email) || normalizeDeliverySlug(`loja-${state.user.uid.slice(0, 8)}`);
    }
    if (!slug) slug = slugFromEmail(state.user?.email) || `loja-${state.user.uid.slice(0, 8)}`;
    company.deliverySlug = slug;
    needsSave = true;
  }

  if (company.deliveryEnabled == null || company.deliveryEnabled === undefined) {
    company.deliveryEnabled = true;
    needsSave = true;
  }
  if (shouldReplaceSlug && company.deliveryEnabled === false) {
    company.deliveryEnabled = true;
    needsSave = true;
  }

  company.deliveryFee = Number(company.deliveryFee || 0);
  company.deliveryMinOrder = Number(company.deliveryMinOrder || 0);
  state.company = { ...state.company, ...company };

  if (needsSave) {
    try {
      await getStoreRef().set(company, { merge: true });
    } catch (err) {
      console.error("Salvar empresa:", err);
      alert(`Erro ao salvar link na loja: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  try {
    await syncStorePublic(state.company);
  } catch (err) {
    console.error("Publicar storePublic:", err);
    publishError = err.message || String(err);
  }

  updateDeliveryLinkUI(publishError);
  renderDeliveryTabLink(publishError);

  if (publishError) {
    return { ok: false, reason: publishError, slug: state.company.deliverySlug };
  }
  return { ok: true, slug: state.company.deliverySlug };
}

async function syncStorePublic(company, options = {}) {
  const ownerUid = options.ownerUid || state.user?.uid;
  if (!ownerUid || !db) return;
  const slug = normalizeDeliverySlug(company.deliverySlug);
  const prevSlug = normalizeDeliverySlug(options.prevSlug ?? state.company?.deliverySlug);

  if (slug) {
    const existing = await db.collection("storePublic").doc(slug).get();
    if (existing.exists && existing.data()?.uid && existing.data().uid !== ownerUid) {
      throw new Error("Este link da loja já está em uso. Escolha outro código.");
    }
    await db.collection("storePublic").doc(slug).set({
      uid: ownerUid,
      name: company.name || "Loja",
      logo: company.logo || "",
      phone: company.phone || "",
      whatsapp: company.whatsapp || company.phone || "",
      address: company.address || "",
      deliveryEnabled: company.deliveryEnabled !== false,
      deliveryFee: Number(company.deliveryFee || 0),
      deliveryFeeMode: company.deliveryFeeMode === "zones" ? "zones" : "flat",
      deliveryFeeZones: Array.isArray(company.deliveryFeeZones) ? company.deliveryFeeZones : [],
      deliveryMinOrder: Number(company.deliveryMinOrder || 0),
      productCategories: Array.isArray(company.productCategories) ? company.productCategories : [],
      updatedAt: new Date().toISOString()
    });
    if (prevSlug && prevSlug !== slug) {
      const prevDoc = await db.collection("storePublic").doc(prevSlug).get();
      if (prevDoc.exists && prevDoc.data()?.uid === ownerUid) {
        await db.collection("storePublic").doc(prevSlug).delete();
      }
    }
  } else if (prevSlug) {
    const prevDoc = await db.collection("storePublic").doc(prevSlug).get();
    if (prevDoc.exists && prevDoc.data()?.uid === ownerUid) {
      await db.collection("storePublic").doc(prevSlug).delete();
    }
  }
}

function getStoreDeliveryLink() {
  const slug = normalizeDeliverySlug(state.company?.deliverySlug);
  return slug ? getDeliveryPublicUrl(slug) : "";
}

function updateDeliveryLinkUI(publishError = "") {
  const box = document.getElementById("deliveryLinkBox");
  const input = document.getElementById("companyDeliveryLink");
  const openBtn = document.getElementById("btnOpenDeliveryLink");
  const hint = document.getElementById("deliveryLinkHint");
  const errEl = document.getElementById("deliveryLinkError");
  const c = state.company || {};
  const slug = normalizeDeliverySlug(c.deliverySlug);
  const enabled = !!c.deliveryEnabled;
  if (!box || !input) return;
  if (slug) {
    const url = getDeliveryPublicUrl(slug);
    input.value = url;
    if (openBtn) openBtn.href = url;
    box.style.display = "block";
    if (hint) {
      hint.textContent = enabled
        ? "Link ativo — envie para seus clientes pedirem online."
        : "Link criado, mas o cardápio está desativado. Marque a opção acima para aceitar pedidos.";
      hint.style.color = enabled ? "var(--success)" : "var(--muted)";
    }
    if (errEl) {
      if (publishError) {
        errEl.textContent = `Atenção: o link foi gerado, mas falhou ao publicar no Firebase (${publishError}). Rode: firebase deploy --only firestore:rules`;
        errEl.style.display = "block";
      } else {
        errEl.textContent = "";
        errEl.style.display = "none";
      }
    }
  } else {
    box.style.display = "block";
    input.value = "";
    if (hint) hint.textContent = "Clique em «Gerar link agora» para criar o link da sua loja.";
    if (errEl && publishError) {
      errEl.textContent = publishError;
      errEl.style.display = "block";
    }
  }
}

function renderDeliveryTabLink(publishError = "") {
  const box = document.getElementById("deliveryTabLinkBox");
  if (!box) return;
  const slug = normalizeDeliverySlug(state.company?.deliverySlug);
  const enabled = !!state.company?.deliveryEnabled;
  if (!slug) {
    box.innerHTML = `
      <p style="color:var(--muted);font-size:13px;margin-bottom:10px;">Nenhum link gerado ainda.</p>
      <button type="button" class="btn primary" onclick="regenerateStoreDeliveryLink()">Gerar link agora</button>`;
    return;
  }
  const url = getDeliveryPublicUrl(slug);
  const warn = publishError
    ? `<p style="color:var(--danger);font-size:12px;margin-top:8px;">Publicação no Firebase falhou: ${publishError}. Execute <code>firebase deploy --only firestore:rules</code></p>`
    : "";
  const legacyUrl = getDeliveryPublicUrlLegacy(slug);
  box.innerHTML = `
    <div class="delivery-tab-link-card">
      <div>
        <strong>Link da sua loja (envie aos clientes)</strong>
        <p style="font-size:12px;color:var(--muted);margin-top:4px;">
          ${enabled ? "Clientes pedem por este link e você aprova na aba Delivery." : "Cardápio pausado — marque «Ativar cardápio online» em Empresa."}
        </p>
        <code style="display:block;margin-top:8px;font-size:13px;word-break:break-all;padding:10px;background:var(--bg3);border-radius:8px;border:1px solid var(--border);">${url}</code>
        <p style="font-size:11px;color:var(--muted);margin-top:6px;">Código da loja: <strong>${slug}</strong></p>
        ${warn}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <button type="button" class="btn primary" onclick="copyStoreDeliveryLink()">Copiar link</button>
        <a class="btn" href="${url}" target="_blank" rel="noopener">Abrir cardápio</a>
        <button type="button" class="btn" onclick="regenerateStoreDeliveryLink(true)">Regenerar link</button>
      </div>
      <details style="margin-top:10px;font-size:12px;color:var(--muted);">
        <summary style="cursor:pointer;">Link alternativo</summary>
        <code style="display:block;margin-top:6px;word-break:break-all;">${legacyUrl}</code>
      </details>
    </div>`;
}

window.regenerateStoreDeliveryLink = async (forceRegenerate = false) => {
  const btn = document.getElementById("btnRegenerateDeliveryLink");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Gerando...";
  }
  const result = await ensureStoreDeliveryLink({ forceRegenerate });
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Gerar link agora";
  }
  if (result.ok) {
    alert("Link gerado com sucesso!");
  } else if (result.slug) {
    alert(`Link local: ${getDeliveryPublicUrl(result.slug)}\n\nMas a publicação falhou: ${result.reason}`);
  } else {
    alert(`Não foi possível gerar o link: ${result.reason || "erro desconhecido"}`);
  }
  renderCompany();
};

window.copyStoreDeliveryLink = async () => {
  const url = getStoreDeliveryLink();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    alert("Link copiado!");
  } catch (_) {
    prompt("Copie o link:", url);
  }
};

function setupCompany() {
  setupDeliveryFeeEditor();
  document.getElementById("companyManagerAreaLock")?.addEventListener("change", syncManagerAreaLockUI);

  document.getElementById("btnRegenerateDeliveryLink")?.addEventListener("click", () => {
    regenerateStoreDeliveryLink();
  });

  document.getElementById("btnCopyDeliveryLink")?.addEventListener("click", async () => {
    const url = document.getElementById("companyDeliveryLink")?.value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      alert("Link copiado!");
    } catch (_) {
      prompt("Copie o link:", url);
    }
  });

  document.getElementById("companyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    let deliverySlug = normalizeDeliverySlug(document.getElementById("companyDeliverySlug")?.value);
    const deliveryEnabled = !!document.getElementById("companyDeliveryEnabled")?.checked;
    if (!deliverySlug) {
      deliverySlug = normalizeDeliverySlug(state.company?.deliverySlug);
    }
    if (deliveryEnabled && !deliverySlug) {
      alert("Aguarde a geração do link ou informe um código (ex: adega-brothers).");
      return;
    }
    const multiRegisterEnabled = !!document.getElementById("companyMultiRegister")?.checked;
    const registers = collectRegistersFromForm();
    const operators = collectOperatorsFromForm();
    if (multiRegisterEnabled && registers.length < 2) {
      alert("Com multi-caixa ativo, cadastre pelo menos 2 caixas com impressora.");
      return;
    }
    const deliveryFeeMode = document.getElementById("companyDeliveryFeeMode")?.value === "zones" ? "zones" : "flat";
    const deliveryFeeZones = typeof DeliveryLogic !== "undefined"
      ? DeliveryLogic.normalizeDeliveryFeeZones(readDeliveryFeeZonesFromDOM())
      : readDeliveryFeeZonesFromDOM();
    if (deliveryFeeMode === "zones" && !deliveryFeeZones.length) {
      alert("Cadastre pelo menos um bairro com a taxa de entrega.");
      return;
    }
    const company = {
      ...(state.company || {}),
      name: document.getElementById("companyName").value.trim() || "BROTHER'S",
      logo: document.getElementById("companyLogo").value.trim(),
      pix: document.getElementById("companyPix").value.trim(),
      phone: document.getElementById("companyPhone").value.trim(),
      whatsapp: document.getElementById("companyWhatsApp")?.value.trim() || document.getElementById("companyPhone").value.trim(),
      address: document.getElementById("companyAddress").value.trim(),
      printer: document.getElementById("companyPrinter").value.trim(),
      autoPrintReceipt: !!document.getElementById("companyAutoPrintReceipt")?.checked,
      autoPrintDeliveryReceipt: !!document.getElementById("companyAutoPrintDeliveryReceipt")?.checked,
      ownerName: state.user?.displayName || "",
      deliveryEnabled,
      deliverySlug,
      deliveryFee: Number(document.getElementById("companyDeliveryFee")?.value || 0),
      deliveryFeeMode,
      deliveryFeeZones,
      deliveryMinOrder: Number(document.getElementById("companyDeliveryMinOrder")?.value || 0),
      cashRegisterRequired: !!document.getElementById("companyCashRegisterRequired")?.checked,
      multiRegisterEnabled,
      registers,
      operators,
      managerAreaPasswordEnabled: !!document.getElementById("companyManagerAreaLock")?.checked
    };
    const managerPwdInput = document.getElementById("companyManagerAreaPassword")?.value || "";
    if (managerPwdInput.trim()) {
      company.managerAreaPassword = managerPwdInput.trim();
    } else if (state.company?.managerAreaPassword) {
      company.managerAreaPassword = state.company.managerAreaPassword;
    } else if (company.managerAreaPasswordEnabled) {
      alert("Defina uma senha para proteger Relatórios e Caixa Geral.");
      return;
    }
    const imgbbKey = document.getElementById("companyImgBBKey")?.value.trim();
    const geminiKey = document.getElementById("companyGeminiKey")?.value.trim();
    if (imgbbKey) company.imgbbApiKey = imgbbKey;
    if (geminiKey) company.geminiApiKey = geminiKey;
    try {
      await syncStorePublic(company);
      await getStoreRef().set(company, { merge: true });
      state.company = company;
      clearRegisterOperatorSession();
      restoreRegisterAndOperatorFromSession();
      updateTopbarBranding();
      updatePrinterInfo();
      updateDeliveryLinkUI();
      renderDeliveryTabLink();
      await qzWarmup();
      clearAllManagerAreaAccess();
      updateRestrictedNavUI();
      leaveRestrictedTabIfLocked();
      alert("Empresa salva com sucesso.");
    } catch (error) { alert(`Erro ao salvar empresa: ${error.message}`); }
  });
}

function renderCompany() {
  const c = state.company || {};
  document.getElementById("companyName").value = c.name || "";
  document.getElementById("companyLogo").value = c.logo || "";
  document.getElementById("companyPix").value = c.pix || "";
  document.getElementById("companyPhone").value = c.phone || "";
  const whatsappEl = document.getElementById("companyWhatsApp");
  if (whatsappEl) whatsappEl.value = c.whatsapp || c.phone || "";
  document.getElementById("companyAddress").value = c.address || "";
  document.getElementById("companyPrinter").value = c.printer || "";
  const autoPrintEl = document.getElementById("companyAutoPrintReceipt");
  if (autoPrintEl) {
    if (typeof c.autoPrintReceipt === "boolean") {
      autoPrintEl.checked = c.autoPrintReceipt;
    } else {
      autoPrintEl.checked = !!String(c.printer || "").trim();
    }
  }
  const autoPrintDeliveryEl = document.getElementById("companyAutoPrintDeliveryReceipt");
  if (autoPrintDeliveryEl) autoPrintDeliveryEl.checked = !!c.autoPrintDeliveryReceipt;
  const enabledEl = document.getElementById("companyDeliveryEnabled");
  if (enabledEl) enabledEl.checked = !!c.deliveryEnabled;
  const slugEl = document.getElementById("companyDeliverySlug");
  if (slugEl) slugEl.value = c.deliverySlug || "";
  const feeEl = document.getElementById("companyDeliveryFee");
  if (feeEl) feeEl.value = Number(c.deliveryFee || 0);
  const feeModeEl = document.getElementById("companyDeliveryFeeMode");
  if (feeModeEl) {
    feeModeEl.value = c.deliveryFeeMode === "zones" ? "zones" : "flat";
  }
  renderDeliveryFeeZoneList(c.deliveryFeeZones || []);
  updateDeliveryFeeModeUI();
  const minEl = document.getElementById("companyDeliveryMinOrder");
  if (minEl) minEl.value = Number(c.deliveryMinOrder || 0);
  const cashReqEl = document.getElementById("companyCashRegisterRequired");
  if (cashReqEl) cashReqEl.checked = !!c.cashRegisterRequired;
  const multiRegEl = document.getElementById("companyMultiRegister");
  if (multiRegEl) multiRegEl.checked = !!c.multiRegisterEnabled;
  renderRegistersConfigList();
  renderOperatorsConfigList();
  const managerLockEl = document.getElementById("companyManagerAreaLock");
  if (managerLockEl) {
    if (typeof c.managerAreaPasswordEnabled === "boolean") {
      managerLockEl.checked = c.managerAreaPasswordEnabled;
    } else {
      managerLockEl.checked = isBrothersDeployment();
    }
  }
  const managerPwdEl = document.getElementById("companyManagerAreaPassword");
  if (managerPwdEl) {
    managerPwdEl.value = "";
    managerPwdEl.placeholder = c.managerAreaPassword
      ? "Senha definida (deixe em branco para manter)"
      : "Defina a senha do gerente";
  }
  syncManagerAreaLockUI();
  refreshActiveRegisterFromCompany();
  if (window.PDV?.syncAiKeyInputs) window.PDV.syncAiKeyInputs(c);
  updateDeliveryLinkUI();
  renderDeliveryTabLink();
  updatePdvCashUI();
  updatePrinterInfo();
  refreshQzSecurityStatus();
}

// ═══════════════════════════════════════════════════════════════
// MÚLTIPLOS CAIXAS + OPERADORES
// ═══════════════════════════════════════════════════════════════
function getPdvSessionPrefix() {
  return state.user?.uid ? `pdv_${state.user.uid}` : "pdv";
}

function getStoreRegisters(company = state.company) {
  const c = company || {};
  const multi = !!c.multiRegisterEnabled;
  if (Array.isArray(c.registers) && c.registers.length) {
    return c.registers.map((r, i) => {
      const ownPrinter = String(r.printer || "").trim();
      const printer = ownPrinter || (multi ? "" : String(c.printer || "").trim());
      return {
        id: String(r.id || `reg_${i + 1}`),
        name: String(r.name || `Caixa ${i + 1}`).trim() || `Caixa ${i + 1}`,
        printer,
        autoPrintReceipt: r.autoPrintReceipt !== false && !!printer
      };
    });
  }
  return [{
    id: "default",
    name: "Caixa",
    printer: String(c.printer || "").trim(),
    autoPrintReceipt: c.autoPrintReceipt !== false && !!String(c.printer || "").trim()
  }];
}

function refreshActiveRegisterFromCompany() {
  if (!state.activeRegister?.id) return;
  const match = getStoreRegisters().find((r) => r.id === state.activeRegister.id);
  if (match) saveActiveRegister(match);
}

function getStoreOperators(company = state.company) {
  if (!Array.isArray(company?.operators)) return [];
  return company.operators
    .filter((o) => o && o.active !== false)
    .map((o, i) => ({
      id: String(o.id || `op_${i + 1}`),
      name: String(o.name || "").trim(),
      login: normalizeCode(o.login),
      pin: String(o.pin || "").trim()
    }))
    .filter((o) => o.name && o.login && o.pin);
}

function isMultiRegisterMode() {
  return !!state.company?.multiRegisterEnabled && getStoreRegisters().length > 1;
}

function getActiveRegister() {
  const registers = getStoreRegisters();
  if (state.activeRegister?.id) {
    const match = registers.find((r) => r.id === state.activeRegister.id);
    if (match) return { ...state.activeRegister, ...match };
    return state.activeRegister;
  }
  return registers[0] || { id: "default", name: "Caixa", printer: "", autoPrintReceipt: false };
}

function getActivePrinter() {
  return String(getActiveRegister()?.printer || "").trim()
    || (!isMultiRegisterMode() ? String(state.company?.printer || "").trim() : "");
}

function saveActiveRegister(register) {
  const registers = getStoreRegisters();
  const match = registers.find((r) => r.id === register?.id) || register;
  state.activeRegister = match;
  if (state.user?.uid) {
    sessionStorage.setItem(`${getPdvSessionPrefix()}_register`, JSON.stringify(register));
  }
}

function saveActiveOperator(operator) {
  state.activeOperator = operator;
  setManagerAreaAccess(false);
  updateRestrictedNavUI();
  leaveRestrictedTabIfLocked();
  if (state.user?.uid) {
    sessionStorage.setItem(`${getPdvSessionPrefix()}_operator`, JSON.stringify({
      id: operator.id,
      name: operator.name,
      login: operator.login
    }));
  }
}

function clearRegisterOperatorSession() {
  state.activeRegister = null;
  state.activeOperator = null;
  if (state.user?.uid) {
    sessionStorage.removeItem(`${getPdvSessionPrefix()}_register`);
    sessionStorage.removeItem(`${getPdvSessionPrefix()}_operator`);
  }
}

function restoreRegisterAndOperatorFromSession() {
  state.activeRegister = null;
  state.activeOperator = null;
  if (!state.user?.uid) return;
  try {
    const regRaw = sessionStorage.getItem(`${getPdvSessionPrefix()}_register`);
    if (regRaw) {
      const parsed = JSON.parse(regRaw);
      const match = getStoreRegisters().find((r) => r.id === parsed.id);
      if (match) state.activeRegister = match;
    }
    const opRaw = sessionStorage.getItem(`${getPdvSessionPrefix()}_operator`);
    if (opRaw) {
      const parsed = JSON.parse(opRaw);
      const match = getStoreOperators().find((o) => o.id === parsed.id);
      if (match) {
        state.activeOperator = { id: match.id, name: match.name, login: match.login };
      }
    }
  } catch (err) {
    console.warn("restoreRegisterAndOperatorFromSession:", err);
  }
  if (!state.activeRegister) {
    const registers = getStoreRegisters();
    if (!isMultiRegisterMode() && registers[0]) {
      saveActiveRegister(registers[0]);
    }
  }
  updateRestrictedNavUI();
  leaveRestrictedTabIfLocked();
}

function needsRegisterSelection() {
  if (!isMultiRegisterMode()) return false;
  const registers = getStoreRegisters();
  return !registers.some((r) => r.id === state.activeRegister?.id);
}

function needsOperatorLogin() {
  return getStoreOperators().length > 0 && !state.activeOperator?.id;
}

function verifyOperatorLogin(login, pin) {
  const wantedLogin = normalizeCode(login);
  const wantedPin = String(pin || "").trim();
  if (!wantedLogin || !wantedPin) return null;
  const match = getStoreOperators().find((o) => o.login === wantedLogin && o.pin === wantedPin);
  if (!match) return null;
  return { id: match.id, name: match.name, login: match.login };
}

function showRegisterPickerModal() {
  const modal = document.getElementById("registerPickerModal");
  const list = document.getElementById("registerPickerList");
  if (!modal || !list) return;
  const registers = getStoreRegisters();
  list.innerHTML = registers.map((reg) => {
    const openSession = state.cashSessions.find((s) => s.status === "open" && s.registerId === reg.id);
    const status = openSession ? '<span class="register-card-status register-card-status--open">Caixa aberto</span>' : "";
    const printerLine = reg.printer
      ? `<small>Impressora: ${reg.printer}</small>`
      : '<small style="color:var(--danger)">Impressora não configurada — configure em Empresa</small>';
    return `<button type="button" class="register-card" data-register-id="${reg.id}">
      <strong>${reg.name}</strong>
      ${printerLine}
      ${status}
    </button>`;
  }).join("");
  list.querySelectorAll(".register-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const reg = registers.find((r) => r.id === btn.dataset.registerId);
      if (!reg) return;
      saveActiveRegister(reg);
      modal.classList.add("hidden");
      loadCashSessions();
      updatePdvRegisterBadge();
      updatePrinterInfo();
      qzWarmup().catch(() => {});
      warnRegisterPrinterOnThisPc(reg);
      if (needsOperatorLogin()) showOperatorLoginModal();
    });
  });
  modal.classList.remove("hidden");
}

function showOperatorLoginModal() {
  const modal = document.getElementById("operatorLoginModal");
  const err = document.getElementById("operatorLoginError");
  if (!modal) return;
  document.getElementById("operatorLoginInput").value = "";
  document.getElementById("operatorPinInput").value = "";
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  modal.classList.remove("hidden");
  setTimeout(() => document.getElementById("operatorLoginInput")?.focus(), 100);
}

function hideOperatorLoginModal() {
  document.getElementById("operatorLoginModal")?.classList.add("hidden");
}

async function ensureRegisterAndOperatorSession() {
  refreshActiveRegisterFromCompany();
  restoreRegisterAndOperatorFromSession();
  refreshActiveRegisterFromCompany();
  if (needsRegisterSelection()) {
    showRegisterPickerModal();
    return false;
  }
  if (needsOperatorLogin()) {
    showOperatorLoginModal();
    return false;
  }
  updatePdvRegisterBadge();
  await loadCashSessions();
  if (state.activeRegister?.id && isMultiRegisterMode()) {
    warnRegisterPrinterOnThisPc(getActiveRegister());
  }
  return true;
}

function updatePdvRegisterBadge() {
  const el = document.getElementById("pdvRegisterBadge");
  const btnReg = document.getElementById("btnSwitchRegister");
  const btnOp = document.getElementById("btnSwitchOperator");
  if (btnReg) btnReg.classList.toggle("hidden", !isMultiRegisterMode());
  if (btnOp) btnOp.classList.toggle("hidden", getStoreOperators().length === 0);
  if (!el) return;
  const reg = getActiveRegister();
  const op = state.activeOperator;
  const parts = [];
  if (isMultiRegisterMode() && reg?.name) parts.push(reg.name);
  if (op?.name) parts.push(op.name);
  if (!parts.length) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = parts.join(" · ");
  el.classList.remove("hidden");
}

function renderRegistersConfigList() {
  const wrap = document.getElementById("registersConfigList");
  const multiEl = document.getElementById("companyMultiRegister");
  if (!wrap) return;
  const enabled = !!multiEl?.checked;
  document.getElementById("registersConfigWrap")?.classList.toggle("hidden", !enabled);
  document.getElementById("singlePrinterWrap")?.classList.toggle("hidden", enabled);

  const registers = enabled
    ? (Array.isArray(state.company?.registers) && state.company.registers.length
      ? state.company.registers
      : [
        { id: uid(), name: "Caixa 1", printer: state.company?.printer || "", autoPrintReceipt: !!state.company?.autoPrintReceipt },
        { id: uid(), name: "Caixa 2", printer: "", autoPrintReceipt: true }
      ])
    : [];

  wrap.innerHTML = registers.map((reg, i) => `
    <div class="register-config-row" data-register-index="${i}">
      <input type="hidden" class="register-id" value="${reg.id || uid()}" />
      <div class="field-group">
        <label>Nome do caixa</label>
        <input type="text" class="register-name" value="${String(reg.name || `Caixa ${i + 1}`).replace(/"/g, "&quot;")}" placeholder="Caixa ${i + 1}" />
      </div>
      <div class="field-group">
        <label>Impressora (QZ Tray)</label>
        <input type="text" class="register-printer" value="${String(reg.printer || "").replace(/"/g, "&quot;")}" placeholder="Nome exato no Windows deste PC" />
        <small style="color:var(--muted);display:block;margin-top:4px;">Configure no computador deste caixa — clique «Listar neste PC» na linha do caixa.</small>
      </div>
      <label class="register-auto-print">
        <input type="checkbox" class="register-auto-print-check" ${reg.autoPrintReceipt !== false ? "checked" : ""} />
        Imprimir cupom automaticamente
      </label>
      <button type="button" class="btn btn-cash-sm btn-list-register-printer">📋 Listar neste PC</button>
      <button type="button" class="btn btn-remove-register" title="Remover caixa">&times;</button>
    </div>`).join("");

  wrap.querySelectorAll(".register-config-row").forEach((row) => bindRegisterConfigRow(row, wrap));
}

function renderOperatorsConfigList() {
  const wrap = document.getElementById("operatorsConfigList");
  if (!wrap) return;
  const operators = Array.isArray(state.company?.operators) ? state.company.operators : [];
  const list = operators.length ? operators : [{ id: uid(), name: "", login: "", pin: "", active: true }];
  wrap.innerHTML = list.map((op, i) => `
    <div class="operator-config-row" data-operator-index="${i}">
      <input type="hidden" class="operator-id" value="${op.id || uid()}" />
      <div class="field-group">
        <label>Nome</label>
        <input type="text" class="operator-name" value="${String(op.name || "").replace(/"/g, "&quot;")}" placeholder="Ex: Maria" />
      </div>
      <div class="field-group">
        <label>Login</label>
        <input type="text" class="operator-login" value="${String(op.login || "").replace(/"/g, "&quot;")}" placeholder="Ex: maria" autocomplete="off" />
      </div>
      <div class="field-group">
        <label>Senha / PIN</label>
        <input type="password" class="operator-pin" value="${String(op.pin || "").replace(/"/g, "&quot;")}" placeholder="4 dígitos" autocomplete="new-password" />
      </div>
      <button type="button" class="btn btn-remove-operator" title="Remover operador">&times;</button>
    </div>`).join("");

  wrap.querySelectorAll(".btn-remove-operator").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rows = wrap.querySelectorAll(".operator-config-row");
      if (rows.length <= 1) {
        btn.closest(".operator-config-row")?.querySelectorAll("input:not([type=hidden])").forEach((inp) => { inp.value = ""; });
        return;
      }
      btn.closest(".operator-config-row")?.remove();
    });
  });
}

function collectRegistersFromForm() {
  const multi = !!document.getElementById("companyMultiRegister")?.checked;
  if (!multi) return [];
  return [...document.querySelectorAll("#registersConfigList .register-config-row")].map((row, i) => ({
    id: row.querySelector(".register-id")?.value || uid(),
    name: row.querySelector(".register-name")?.value.trim() || `Caixa ${i + 1}`,
    printer: row.querySelector(".register-printer")?.value.trim() || "",
    autoPrintReceipt: !!row.querySelector(".register-auto-print-check")?.checked
  }));
}

function collectOperatorsFromForm() {
  return [...document.querySelectorAll("#operatorsConfigList .operator-config-row")]
    .map((row) => ({
      id: row.querySelector(".operator-id")?.value || uid(),
      name: row.querySelector(".operator-name")?.value.trim() || "",
      login: normalizeCode(row.querySelector(".operator-login")?.value),
      pin: row.querySelector(".operator-pin")?.value.trim() || "",
      active: true
    }))
    .filter((o) => o.name && o.login && o.pin);
}

function setupMultiRegisterConfig() {
  document.getElementById("companyMultiRegister")?.addEventListener("change", renderRegistersConfigList);
  document.getElementById("btnAddRegister")?.addEventListener("click", () => {
    const wrap = document.getElementById("registersConfigList");
    if (!wrap) return;
    const count = wrap.querySelectorAll(".register-config-row").length;
    const row = document.createElement("div");
    row.className = "register-config-row";
    row.innerHTML = `
      <input type="hidden" class="register-id" value="${uid()}" />
      <div class="field-group">
        <label>Nome do caixa</label>
        <input type="text" class="register-name" value="Caixa ${count + 1}" />
      </div>
      <div class="field-group">
        <label>Impressora (QZ Tray)</label>
        <input type="text" class="register-printer" placeholder="Nome exato no Windows deste PC" />
        <small style="color:var(--muted);display:block;margin-top:4px;">Configure no computador deste caixa — clique «Listar neste PC».</small>
      </div>
      <label class="register-auto-print">
        <input type="checkbox" class="register-auto-print-check" checked />
        Imprimir cupom automaticamente
      </label>
      <button type="button" class="btn btn-cash-sm btn-list-register-printer">📋 Listar neste PC</button>
      <button type="button" class="btn btn-remove-register" title="Remover caixa">&times;</button>`;
    wrap.appendChild(row);
    bindRegisterConfigRow(row, wrap);
  });
  document.getElementById("btnAddOperator")?.addEventListener("click", () => {
    const wrap = document.getElementById("operatorsConfigList");
    if (!wrap) return;
    const row = document.createElement("div");
    row.className = "operator-config-row";
    row.innerHTML = `
      <input type="hidden" class="operator-id" value="${uid()}" />
      <div class="field-group">
        <label>Nome</label>
        <input type="text" class="operator-name" placeholder="Ex: João" />
      </div>
      <div class="field-group">
        <label>Login</label>
        <input type="text" class="operator-login" placeholder="Ex: joao" autocomplete="off" />
      </div>
      <div class="field-group">
        <label>Senha / PIN</label>
        <input type="password" class="operator-pin" placeholder="4 dígitos" autocomplete="new-password" />
      </div>
      <button type="button" class="btn btn-remove-operator" title="Remover operador">&times;</button>`;
    wrap.appendChild(row);
    row.querySelector(".btn-remove-operator")?.addEventListener("click", () => row.remove());
  });

  document.getElementById("operatorLoginForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const login = document.getElementById("operatorLoginInput")?.value;
    const pin = document.getElementById("operatorPinInput")?.value;
    const err = document.getElementById("operatorLoginError");
    const operator = verifyOperatorLogin(login, pin);
    if (!operator) {
      if (err) {
        err.textContent = "Login ou senha incorretos.";
        err.classList.remove("hidden");
      }
      return;
    }
    saveActiveOperator(operator);
    hideOperatorLoginModal();
    updatePdvRegisterBadge();
    loadCashSessions();
  });

  document.getElementById("btnSwitchOperator")?.addEventListener("click", () => {
    state.activeOperator = null;
    sessionStorage.removeItem(`${getPdvSessionPrefix()}_operator`);
    showOperatorLoginModal();
  });

  document.getElementById("btnSwitchRegister")?.addEventListener("click", () => {
    if (!isMultiRegisterMode()) return;
    if (isCashSessionOpen()) {
      alert("Feche o caixa deste PDV antes de trocar de caixa.");
      return;
    }
    clearRegisterOperatorSession();
    showRegisterPickerModal();
  });
}

function sessionMatchesRegister(session, registerId) {
  if (!session) return false;
  if (session.registerId) return session.registerId === registerId;
  return registerId === "default";
}

// ═══════════════════════════════════════════════════════════════
// CONTROLE DE CAIXA
// ═══════════════════════════════════════════════════════════════
function isCashRegisterRequired() {
  return !!state.company?.cashRegisterRequired;
}

function isCashSessionOpen() {
  return state.cashSession?.status === "open";
}

function getOperatorInfo() {
  if (state.activeOperator?.name) {
    return {
      email: state.activeOperator.login || "",
      name: state.activeOperator.name,
      id: state.activeOperator.id || ""
    };
  }
  return {
    email: state.user?.email || "",
    name: state.user?.displayName || state.company?.ownerName || state.user?.email || "Operador",
    id: ""
  };
}

async function loadCashSessions() {
  const storeRef = getStoreRef();
  if (!storeRef) return;
  try {
    const snap = await storeRef.collection("cashSessions").orderBy("openedAt", "desc").limit(120).get();
    state.cashSessions = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const register = getActiveRegister();
    state.cashSession = state.cashSessions.find((s) => s.status === "open" && sessionMatchesRegister(s, register.id)) || null;
  } catch (err) {
    console.warn("loadCashSessions:", err);
    state.cashSessions = [];
    state.cashSession = null;
  }
  updatePdvCashUI();
  updatePdvRegisterBadge();
  renderCashSessionsTable();
}

function getSessionSales(sessionId) {
  if (!sessionId) return [];
  return state.sales.filter((s) => s.cashSessionId === sessionId && isCountableSale(s));
}

function calcCashSessionStats(session) {
  if (!session) return null;
  const sales = getSessionSales(session.id);
  const byPayment = {};
  let cashSales = 0;
  let totalSales = 0;
  sales.forEach((s) => {
    getSalePayments(s).forEach((p) => {
      const pm = p.method || "Outro";
      byPayment[pm] = (byPayment[pm] || 0) + Number(p.amount || 0);
      if (pm === "Dinheiro") cashSales += Number(p.amount || 0);
    });
    totalSales += Number(s.total || 0);
  });
  const movements = Array.isArray(session.movements) ? session.movements : [];
  const sangrias = movements.filter((m) => m.type === "sangria");
  const totalSangria = sangrias.reduce((sum, m) => sum + Number(m.amount || 0), 0);
  const opening = Number(session.openingAmount || 0);
  const expectedCash = opening + cashSales - totalSangria;
  return {
    sales,
    salesCount: sales.length,
    totalSales,
    byPayment,
    cashSales,
    sangrias,
    totalSangria,
    opening,
    expectedCash
  };
}

function updatePdvCashUI() {
  const wrap = document.getElementById("pdvCashStatusWrap");
  const text = document.getElementById("pdvCashStatusText");
  const dot = document.getElementById("pdvCashStatusDot");
  const btnOpen = document.getElementById("btnOpenCash");
  const btnSangria = document.getElementById("btnCashSangria");
  const btnClose = document.getElementById("btnCloseCash");
  const open = isCashSessionOpen();

  if (text) {
    if (open) {
      const stats = calcCashSessionStats(state.cashSession);
      const regName = state.cashSession.registerName ? `${state.cashSession.registerName} · ` : "";
      text.textContent = `${regName}Caixa aberto · ${stats.salesCount} venda(s)`;
    } else if (isCashRegisterRequired()) {
      text.textContent = "Caixa fechado — abra para vender";
    } else {
      text.textContent = "Caixa livre (opcional)";
    }
  }
  if (wrap) wrap.classList.toggle("pdv-status--closed", !open && isCashRegisterRequired());
  if (wrap) wrap.classList.toggle("pdv-status--open", open);
  if (dot) dot.style.background = open ? "var(--green)" : isCashRegisterRequired() ? "var(--danger)" : "var(--muted)";
  if (btnOpen) btnOpen.disabled = open;
  if (btnSangria) btnSangria.disabled = !open;
  if (btnClose) btnClose.disabled = !open;
}

function showCashModal(id) {
  document.getElementById(id)?.classList.remove("hidden");
}

function hideCashModal(id) {
  document.getElementById(id)?.classList.add("hidden");
}

function renderCashCloseSummary() {
  const box = document.getElementById("cashCloseSummary");
  if (!box || !state.cashSession) return;
  const stats = calcCashSessionStats(state.cashSession);
  const opened = new Date(state.cashSession.openedAt).toLocaleString("pt-BR");
  const payLines = Object.entries(stats.byPayment)
    .map(([pm, val]) => `<tr><td>${pm}</td><td style="text-align:right">${money(val)}</td></tr>`)
    .join("");
  box.innerHTML = `
    <p><strong>Abertura:</strong> ${opened}</p>
    <p><strong>Fundo de caixa:</strong> ${money(stats.opening)}</p>
    <p><strong>Vendas no turno:</strong> ${stats.salesCount} · ${money(stats.totalSales)}</p>
    <p><strong>Vendas em dinheiro:</strong> ${money(stats.cashSales)}</p>
    <p><strong>Sangrias:</strong> ${money(stats.totalSangria)}</p>
    <p><strong>Dinheiro esperado:</strong> ${money(stats.expectedCash)}</p>
    ${payLines ? `<table style="width:100%;margin-top:8px;font-size:12px;"><tbody>${payLines}</tbody></table>` : ""}`;
  const countedInput = document.getElementById("cashCountedAmount");
  if (countedInput && !countedInput.dataset.touched) {
    countedInput.value = stats.expectedCash.toFixed(2);
  }
  updateCashCloseDiff();
}

function updateCashCloseDiff() {
  const hint = document.getElementById("cashCloseDiffHint");
  if (!hint || !state.cashSession) return;
  const stats = calcCashSessionStats(state.cashSession);
  const counted = Number(document.getElementById("cashCountedAmount")?.value || 0);
  const diff = counted - stats.expectedCash;
  if (Number.isNaN(counted)) {
    hint.textContent = "";
    return;
  }
  if (Math.abs(diff) < 0.009) {
    hint.textContent = "Conferência: valor bate com o esperado.";
    hint.style.color = "var(--success)";
  } else if (diff > 0) {
    hint.textContent = `Sobra de ${money(diff)} em relação ao esperado.`;
    hint.style.color = "var(--accent)";
  } else {
    hint.textContent = `Falta de ${money(Math.abs(diff))} em relação ao esperado.`;
    hint.style.color = "var(--danger)";
  }
}

async function openCashSession() {
  const register = getActiveRegister();
  const existingOpen = state.cashSessions.find((s) => s.status === "open" && sessionMatchesRegister(s, register.id));
  if (existingOpen) {
    alert(`Já existe um caixa aberto em ${register.name || "este PDV"}.`);
    return;
  }
  if (needsOperatorLogin()) {
    showOperatorLoginModal();
    return;
  }
  const openingAmount = Number(document.getElementById("cashOpeningAmount")?.value || 0);
  if (openingAmount < 0) {
    alert("Valor inicial inválido.");
    return;
  }
  const openingNote = document.getElementById("cashOpeningNote")?.value.trim() || "";
  const operator = getOperatorInfo();
  const now = new Date().toISOString();
  const sessionId = uid();
  const session = {
    status: "open",
    openedAt: now,
    openedBy: operator.email,
    openedByName: operator.name,
    operatorId: operator.id || "",
    registerId: register.id,
    registerName: register.name,
    openingAmount,
    openingNote,
    movements: [],
    closedAt: null,
    countedCash: null,
    closingNote: null,
    expectedCash: null,
    cashDifference: null
  };
  try {
    await getStoreRef().collection("cashSessions").doc(sessionId).set(session);
    state.cashSession = { id: sessionId, ...session };
    state.cashSessions = [{ id: sessionId, ...session }, ...state.cashSessions.filter((s) => s.id !== sessionId)];
    hideCashModal("cashOpenModal");
    updatePdvCashUI();
    renderCashSessionsTable();
    alert("Caixa aberto com sucesso.");
  } catch (err) {
    alert(`Erro ao abrir caixa: ${err.message}`);
  }
}

async function registerCashSangria() {
  if (!isCashSessionOpen()) {
    alert("Abra o caixa antes de registrar sangria.");
    return;
  }
  const amount = Number(document.getElementById("cashSangriaAmount")?.value);
  const note = document.getElementById("cashSangriaNote")?.value.trim();
  if (!amount || amount <= 0) {
    alert("Informe o valor da sangria.");
    return;
  }
  if (!note) {
    alert("Informe o motivo da sangria.");
    return;
  }
  const operator = getOperatorInfo();
  const movement = {
    id: uid(),
    type: "sangria",
    amount,
    note,
    at: new Date().toISOString(),
    by: operator.email,
    byName: operator.name
  };
  const sessionId = state.cashSession.id;
  try {
    await getStoreRef().collection("cashSessions").doc(sessionId).update({
      movements: firebase.firestore.FieldValue.arrayUnion(movement)
    });
    const movements = [...(state.cashSession.movements || []), movement];
    state.cashSession = { ...state.cashSession, movements };
    const idx = state.cashSessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) state.cashSessions[idx] = { ...state.cashSession };
    document.getElementById("cashSangriaAmount").value = "";
    document.getElementById("cashSangriaNote").value = "";
    hideCashModal("cashSangriaModal");
    updatePdvCashUI();
    renderCashSessionsTable();
    alert(`Sangria de ${money(amount)} registrada.`);
  } catch (err) {
    alert(`Erro na sangria: ${err.message}`);
  }
}

async function closeCashSession() {
  if (!isCashSessionOpen()) return;
  const countedCash = Number(document.getElementById("cashCountedAmount")?.value);
  if (Number.isNaN(countedCash) || countedCash < 0) {
    alert("Informe o valor contado no caixa.");
    return;
  }
  const closingNote = document.getElementById("cashClosingNote")?.value.trim() || "";
  const stats = calcCashSessionStats(state.cashSession);
  const cashDifference = countedCash - stats.expectedCash;
  const operator = getOperatorInfo();
  const now = new Date().toISOString();
  const sessionId = state.cashSession.id;
  const payload = {
    status: "closed",
    closedAt: now,
    closedBy: operator.email,
    closedByName: operator.name,
    countedCash,
    closingNote,
    expectedCash: stats.expectedCash,
    cashDifference,
    closingStats: {
      salesCount: stats.salesCount,
      totalSales: stats.totalSales,
      cashSales: stats.cashSales,
      totalSangria: stats.totalSangria,
      byPayment: stats.byPayment
    }
  };
  try {
    await getStoreRef().collection("cashSessions").doc(sessionId).update(payload);
    const closed = { ...state.cashSession, ...payload };
    state.cashSession = null;
    const idx = state.cashSessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) state.cashSessions[idx] = closed;
    else state.cashSessions.unshift({ id: sessionId, ...closed });
    hideCashModal("cashCloseModal");
    updatePdvCashUI();
    renderCashSessionsTable();
    if (confirm("Caixa fechado. Deseja imprimir o relatório deste turno?")) {
      printCashSessionReport(sessionId);
    }
  } catch (err) {
    alert(`Erro ao fechar caixa: ${err.message}`);
  }
}

function buildCashSessionReportHtml(session) {
  const stats = calcCashSessionStats(session);
  const company = state.company || {};
  const opened = session.openedAt ? new Date(session.openedAt).toLocaleString("pt-BR") : "—";
  const closed = session.closedAt ? new Date(session.closedAt).toLocaleString("pt-BR") : "—";
  const payRows = Object.entries(stats.byPayment)
    .map(([pm, val]) => `<tr><td>${pm}</td><td style="text-align:right">${money(val)}</td></tr>`)
    .join("");
  const sangriaRows = stats.sangrias.length
    ? stats.sangrias.map((m) => {
      const t = new Date(m.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      return `<tr><td>${t}</td><td>${m.note || "—"}</td><td style="text-align:right">-${money(m.amount)}</td></tr>`;
    }).join("")
    : '<tr><td colspan="3" style="text-align:center;color:#999">Nenhuma sangria</td></tr>';
  const diff = session.status === "closed"
    ? Number(session.cashDifference ?? (Number(session.countedCash || 0) - stats.expectedCash))
    : null;
  return `
    <h1>${company.name || "STOCK PDV"} — Fechamento de Caixa</h1>
    <h2>Turno ${session.status === "open" ? "aberto" : "fechado"} · Gerado em ${new Date().toLocaleString("pt-BR")}</h2>
    <div class="summary">
      <div class="s-card"><label>Operador</label><strong>${session.openedByName || session.openedBy || "—"}</strong></div>
      ${session.registerName ? `<div class="s-card"><label>Caixa</label><strong>${session.registerName}</strong></div>` : ""}
      <div class="s-card"><label>Abertura</label><strong>${opened}</strong></div>
      <div class="s-card"><label>Fechamento</label><strong>${closed}</strong></div>
      <div class="s-card"><label>Vendas</label><strong>${stats.salesCount}</strong></div>
    </div>
    <table>
      <tbody>
        <tr><td>Fundo de caixa (abertura)</td><td style="text-align:right">${money(stats.opening)}</td></tr>
        <tr><td>Total vendido no turno</td><td style="text-align:right">${money(stats.totalSales)}</td></tr>
        <tr><td>Vendas em dinheiro</td><td style="text-align:right">${money(stats.cashSales)}</td></tr>
        <tr><td>Total sangrias</td><td style="text-align:right">-${money(stats.totalSangria)}</td></tr>
        <tr><td><strong>Dinheiro esperado</strong></td><td style="text-align:right"><strong>${money(stats.expectedCash)}</strong></td></tr>
        ${session.status === "closed" ? `<tr><td>Dinheiro contado</td><td style="text-align:right">${money(session.countedCash)}</td></tr>
        <tr><td>Diferença</td><td style="text-align:right">${money(diff)}</td></tr>` : ""}
      </tbody>
    </table>
    <h3 style="margin:20px 0 8px;font-size:14px;">Por forma de pagamento</h3>
    <table><thead><tr><th>Forma</th><th>Total</th></tr></thead><tbody>${payRows || '<tr><td colspan="2">Sem vendas</td></tr>'}</tbody></table>
    <h3 style="margin:20px 0 8px;font-size:14px;">Sangrias</h3>
    <table><thead><tr><th>Hora</th><th>Motivo</th><th>Valor</th></tr></thead><tbody>${sangriaRows}</tbody></table>
    ${session.openingNote ? `<p style="margin-top:12px;font-size:12px;color:#666;">Obs. abertura: ${session.openingNote}</p>` : ""}
    ${session.closingNote ? `<p style="font-size:12px;color:#666;">Obs. fechamento: ${session.closingNote}</p>` : ""}`;
}

window.printCashSessionReport = (sessionId) => {
  const session = state.cashSessions.find((s) => s.id === sessionId) || (state.cashSession?.id === sessionId ? state.cashSession : null);
  if (!session) {
    alert("Turno de caixa não encontrado.");
    return;
  }
  openReportPrintWindow(`Caixa — ${toLocalDateISO(session.openedAt) || ""}`, buildCashSessionReportHtml(session));
};

function renderCashSessionsTable() {
  const tbody = document.getElementById("cashSessionsTableBody");
  const daySel = document.getElementById("cashReportDaySelect");
  if (!tbody) return;
  const day = daySel?.value || todayISO();
  if (daySel && !daySel.value) daySel.value = day;
  if (daySel) daySel.max = todayISO();

  const list = state.cashSessions
    .filter((s) => isoMatchesLocalDay(s.openedAt, day))
    .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Nenhum turno de caixa neste dia</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((session) => {
    const stats = calcCashSessionStats(session);
    const openT = new Date(session.openedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const closeT = session.closedAt
      ? new Date(session.closedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "—";
    const statusLabel = session.status === "open"
      ? '<span style="color:var(--success)">Aberto</span>'
      : '<span style="color:var(--muted)">Fechado</span>';
    const registerLabel = session.registerName || (session.registerId && session.registerId !== "default" ? session.registerId : "—");
    return `<tr>
      <td>${registerLabel}</td>
      <td>${openT}</td>
      <td>${closeT}</td>
      <td>${statusLabel}</td>
      <td>${money(stats.opening)}</td>
      <td>${stats.salesCount} · ${money(stats.totalSales)}</td>
      <td>${money(stats.totalSangria)}</td>
      <td><button type="button" class="btn" onclick="printCashSessionReport('${session.id}')">Imprimir</button></td>
    </tr>`;
  }).join("");
}

window.printCashSessionsDayReport = () => {
  const day = document.getElementById("cashReportDaySelect")?.value || todayISO();
  const dayLabel = new Date(`${day}T12:00:00`).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  const company = state.company || {};
  const sessions = state.cashSessions
    .filter((s) => isoMatchesLocalDay(s.openedAt, day))
    .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)));

  if (!sessions.length) {
    alert("Nenhum turno de caixa neste dia.");
    return;
  }

  const sections = sessions.map((session, i) => {
    const inner = buildCashSessionReportHtml(session).replace(/<h1>.*?<\/h1>/, "").replace(/<h2>.*?<\/h2>/, "");
    return `<div style="margin-bottom:32px;${i > 0 ? "page-break-before:always;" : ""}"><h2 style="font-size:15px;margin-bottom:12px;">Turno ${i + 1}</h2>${inner}</div>`;
  }).join("");

  const bodyHtml = `
    <h1>${company.name || "STOCK PDV"} — Controle de Caixa do Dia</h1>
    <h2>${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} · ${sessions.length} turno(s)</h2>
    ${sections}`;

  openReportPrintWindow(`Caixas — ${day}`, bodyHtml);
};

function setupCashRegister() {
  document.getElementById("btnOpenCash")?.addEventListener("click", async () => {
    if (!(await ensureManagerAreaAccess("abrir o caixa"))) return;
    if (isCashSessionOpen()) return;
    if (needsRegisterSelection()) {
      showRegisterPickerModal();
      return;
    }
    if (needsOperatorLogin()) {
      showOperatorLoginModal();
      return;
    }
    const reg = getActiveRegister();
    const title = document.querySelector("#cashOpenModal .modal-title");
    if (title) title.textContent = reg?.name ? `Abrir ${reg.name}` : "Abrir caixa";
    document.getElementById("cashOpeningAmount").value = "0";
    document.getElementById("cashOpeningNote").value = "";
    showCashModal("cashOpenModal");
  });
  document.getElementById("btnCancelCashOpen")?.addEventListener("click", () => hideCashModal("cashOpenModal"));
  document.getElementById("btnConfirmCashOpen")?.addEventListener("click", openCashSession);

  document.getElementById("btnCashSangria")?.addEventListener("click", async () => {
    if (!(await ensureManagerAreaAccess("sangria no caixa"))) return;
    document.getElementById("cashSangriaAmount").value = "";
    document.getElementById("cashSangriaNote").value = "";
    showCashModal("cashSangriaModal");
  });
  document.getElementById("btnCancelCashSangria")?.addEventListener("click", () => hideCashModal("cashSangriaModal"));
  document.getElementById("btnConfirmCashSangria")?.addEventListener("click", registerCashSangria);

  document.getElementById("btnCloseCash")?.addEventListener("click", async () => {
    if (!(await ensureManagerAreaAccess("fechar o caixa"))) return;
    const counted = document.getElementById("cashCountedAmount");
    if (counted) {
      counted.dataset.touched = "";
      counted.value = "";
    }
    document.getElementById("cashClosingNote").value = "";
    renderCashCloseSummary();
    showCashModal("cashCloseModal");
  });
  document.getElementById("btnCancelCashClose")?.addEventListener("click", () => hideCashModal("cashCloseModal"));
  document.getElementById("btnConfirmCashClose")?.addEventListener("click", closeCashSession);
  document.getElementById("cashCountedAmount")?.addEventListener("input", () => {
    const el = document.getElementById("cashCountedAmount");
    if (el) el.dataset.touched = "1";
    updateCashCloseDiff();
  });
  document.getElementById("cashReportDaySelect")?.addEventListener("change", renderCashSessionsTable);
}

function assertCashOpenForSale() {
  if (needsOperatorLogin()) {
    showOperatorLoginModal();
    alert("Informe login e senha do operador para vender.");
    return false;
  }
  if (needsRegisterSelection()) {
    showRegisterPickerModal();
    alert("Selecione o caixa / PDV deste computador.");
    return false;
  }
  if (isCashRegisterRequired() && !isCashSessionOpen()) {
    alert("Abra o caixa antes de finalizar a venda.\n\nEm Empresa você pode desativar «Exigir abertura de caixa» se não quiser obrigar.");
    return false;
  }
  return true;
}

function buildDailyCashSessionsReportSection(day) {
  const sessions = state.cashSessions
    .filter((s) => isoMatchesLocalDay(s.openedAt, day))
    .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)));
  if (!sessions.length) return "";
  const rows = sessions.map((session) => {
    const stats = calcCashSessionStats(session);
    const openT = new Date(session.openedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const closeT = session.closedAt
      ? new Date(session.closedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "aberto";
    const diff = session.status === "closed" ? money(session.cashDifference ?? 0) : "—";
    return `<tr>
      <td>${openT} – ${closeT}</td>
      <td>${session.openedByName || "—"}</td>
      <td style="text-align:right">${money(stats.opening)}</td>
      <td style="text-align:right">${stats.salesCount}</td>
      <td style="text-align:right">${money(stats.totalSales)}</td>
      <td style="text-align:right">${money(stats.totalSangria)}</td>
      <td style="text-align:right">${money(stats.expectedCash)}</td>
      <td style="text-align:right">${session.status === "closed" ? money(session.countedCash) : "—"}</td>
      <td style="text-align:right">${diff}</td>
    </tr>`;
  }).join("");
  return `
    <h3 style="margin:28px 0 12px;font-size:14px;">Controle de caixa</h3>
    <table>
      <thead>
        <tr>
          <th>Turno</th><th>Operador</th><th>Fundo</th><th>Qtd</th><th>Vendas</th>
          <th>Sangrias</th><th>Esperado</th><th>Contado</th><th>Dif.</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:11px;color:#888;margin-top:8px;">Reimprima cada turno em Relatórios → Controle de caixa → Imprimir.</p>`;
}

// ═══════════════════════════════════════════════════════════════
// DELIVERY — pedidos online
// ═══════════════════════════════════════════════════════════════
function normalizeWhatsAppNumber(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12 && digits.startsWith("55")) return digits;
  if (digits.length >= 8 && digits.length <= 11) return `55${digits}`;
  return digits;
}

function wrapReceiptText(text, width = RECEIPT_WIDTH) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word.length > width ? word.slice(0, width) : word;
      while (line.length > width) {
        lines.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildDeliveryReceiptEscPos(order) {
  const c = state.company || {};
  const customer = order.customer || {};
  const items = order.items || [];
  const deliveryFee = Number(order.deliveryFee || 0);
  const subtotal = Number(order.subtotal ?? items.reduce((s, i) => s + Number(i.subtotal || i.price * i.qty || 0), 0));
  const total = Number(order.total ?? subtotal + deliveryFee);
  const chunks = [];
  const pushBoldRow = (label, value) => chunks.push(escPosBoldLine(receiptRow(label, value)));

  const companyName = c.name || "STOCK PDV";
  if (escPosSafe(companyName).length <= 16) {
    chunks.push(escPosLargeCenterLine(companyName));
  } else {
    chunks.push(escPosMediumCenterLine(companyName));
  }

  if (c.phone) chunks.push(escPosLine(`Tel loja: ${c.phone}`));
  chunks.push(escPosBoldLine("Tipo: DELIVERY"));
  chunks.push(escPosBoldLine(`Pedido: #${String(order.id || "").slice(0, 8).toUpperCase()}`));
  chunks.push(escPosBoldLine(`Data: ${receiptDateStr(order.createdAt || new Date())}`));
  chunks.push(escPosLine(receiptHr("-")));

  if (customer.name) chunks.push(escPosBoldLine(`Cliente: ${customer.name}`));
  if (customer.phone) chunks.push(escPosLine(`Tel: ${customer.phone}`));
  if (customer.address) {
    wrapReceiptText(customer.address).forEach((line, index) => {
      chunks.push(escPosBoldLine(index === 0 ? `Endereco: ${line}` : line));
    });
  }
  if (customer.notes) {
    chunks.push(escPosLine(receiptHr("-")));
    wrapReceiptText(`Obs: ${customer.notes}`).forEach((line) => chunks.push(escPosLine(line)));
  }
  chunks.push(escPosLine(receiptHr("-")));

  if (order.deliveryZoneName) chunks.push(escPosBoldLine(`Bairro: ${order.deliveryZoneName}`));
  items.forEach((item) => {
    chunks.push(escPosBoldLine(String(item.name || "Produto").substring(0, RECEIPT_WIDTH)));
    (item.selections || []).forEach((sel) => {
      chunks.push(escPosLine(`  ${sel.groupName}: ${sel.name}`.substring(0, RECEIPT_WIDTH)));
    });
    const sub = Number(item.subtotal || item.price * item.qty || 0);
    chunks.push(escPosLine(receiptRow(`${item.qty} UN x ${moneyEscPos(item.price)}`, moneyEscPos(sub))));
  });

  chunks.push(escPosLine(receiptHr("-")));
  pushBoldRow("Subtotal:", moneyEscPos(subtotal));
  if (deliveryFee > 0 || order.deliveryZoneName) pushBoldRow("Taxa entrega:", moneyEscPos(deliveryFee));
  pushBoldRow("FINAL:", moneyEscPos(total));
  chunks.push(escPosBoldLine(`Pagamento: ${order.paymentMethod || "—"}`));
  const hasPix = String(order.paymentMethod || "").toLowerCase().includes("pix");
  if (hasPix && c.pix) chunks.push(escPosBoldLine(`PIX: ${c.pix}`));
  chunks.push(escPosLine(receiptHr("-")));
  chunks.push(escPosMediumCenterLine("DELIVERY"));
  return chunks.join("");
}

function buildDeliveryReceiptHtml(order) {
  const c = state.company || {};
  const customer = order.customer || {};
  const items = order.items || [];
  const deliveryFee = Number(order.deliveryFee || 0);
  const subtotal = Number(order.subtotal ?? items.reduce((s, i) => s + Number(i.subtotal || i.price * i.qty || 0), 0));
  const total = Number(order.total ?? subtotal + deliveryFee);
  const itemsHtml = items.map((item) => {
    const sub = Number(item.subtotal || item.price * item.qty || 0);
    const choices = (item.selections || []).map((sel) => `<div class="meta-line">${sel.groupName}: ${sel.name}</div>`).join("");
    return `<div class="item"><div class="item-name">${item.name}</div>${choices}<div class="item-row"><span>${item.qty} UN × ${money(item.price)}</span><strong>${money(sub)}</strong></div></div>`;
  }).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cupom Delivery</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; width: 80mm; max-width: 80mm; margin: 0 auto; padding: 12px 10px; font-size: 12px; color: #111; line-height: 1.35; }
  .company-name { text-align: center; font-weight: 800; font-size: 20px; margin: 8px 0; }
  .meta-line { margin: 2px 0; font-size: 12px; }
  .hr { border: none; border-top: 1px dashed #333; margin: 10px 0; }
  .item { margin-bottom: 8px; }
  .item-name { font-weight: 600; margin-bottom: 2px; }
  .item-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
  .row { display: flex; justify-content: space-between; margin: 4px 0; }
  .row.final { font-weight: 700; font-size: 14px; margin-top: 6px; }
  .foot { text-align: center; font-weight: 800; font-size: 14px; margin-top: 12px; }
</style></head><body>
  <div class="company-name">${c.name || "STOCK PDV"}</div>
  ${c.phone ? `<div class="meta-line">Tel loja: ${c.phone}</div>` : ""}
  <div class="meta-line"><strong>Tipo: DELIVERY</strong></div>
  <div class="meta-line"><strong>Pedido: #${String(order.id || "").slice(0, 8).toUpperCase()}</strong></div>
  <div class="meta-line">Data: ${receiptDateStr(order.createdAt || new Date())}</div>
  <hr class="hr">
  ${customer.name ? `<div class="meta-line"><strong>Cliente:</strong> ${customer.name}</div>` : ""}
  ${customer.phone ? `<div class="meta-line"><strong>Tel:</strong> ${customer.phone}</div>` : ""}
  ${customer.address ? `<div class="meta-line"><strong>Endereço:</strong> ${customer.address}</div>` : ""}
  ${order.deliveryZoneName ? `<div class="meta-line"><strong>Bairro:</strong> ${order.deliveryZoneName}</div>` : ""}
  ${customer.notes ? `<div class="meta-line"><strong>Obs:</strong> ${customer.notes}</div>` : ""}
  <hr class="hr">
  ${itemsHtml}
  <hr class="hr">
  <div class="row"><span>Subtotal:</span><strong>${money(subtotal)}</strong></div>
  ${deliveryFee > 0 || order.deliveryZoneName ? `<div class="row"><span>Taxa entrega:</span><span>${money(deliveryFee)}</span></div>` : ""}
  <div class="row final"><span>FINAL:</span><strong>${money(total)}</strong></div>
  <div class="meta-line" style="margin-top:8px;">Pagamento: ${order.paymentMethod || "—"}</div>
  ${String(order.paymentMethod || "").toLowerCase().includes("pix") && c.pix ? `<div class="meta-line">PIX: ${c.pix}</div>` : ""}
  <hr class="hr">
  <div class="foot">DELIVERY</div>
</body></html>`;
}

async function doPrintDelivery(order) {
  const text = buildDeliveryReceiptEscPos(order);
  const result = await printViaQZ(text);
  if (result.ok) return { ok: true, printer: result.printer };
  const win = window.open("", "_blank", "width=360,height=720");
  if (win) {
    win.document.write(buildDeliveryReceiptHtml(order));
    win.document.close();
    win.focus();
    win.print();
  } else {
    alert("Permita popups para imprimir o cupom delivery.");
  }
  return { ok: false, error: result.error, fallback: true };
}

function isAutoPrintDeliveryEnabled() {
  const printer = getActivePrinter();
  return !!printer && state.company?.autoPrintDeliveryReceipt === true;
}

let _lastAutoPrintedDeliveryOrderId = null;
let _lastAutoPrintDeliveryAt = 0;

async function autoPrintDeliveryOrder(orderId) {
  if (!isAutoPrintDeliveryEnabled()) return { ok: false, skipped: true };
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  if (!order) return { ok: false, skipped: true };
  const now = Date.now();
  if (_lastAutoPrintedDeliveryOrderId === orderId || now - _lastAutoPrintDeliveryAt < 1500) {
    return { ok: true, skipped: true };
  }
  _lastAutoPrintedDeliveryOrderId = orderId;
  _lastAutoPrintDeliveryAt = now;
  const printerName = getActivePrinter();
  showPrintToast(`Imprimindo cupom delivery em ${printerName}…`);
  const printed = await doPrintDelivery(order);
  if (printed.ok) {
    flashPrinterStatus(`✅ Cupom delivery enviado para ${printed.printer || printerName}.`);
  } else {
    _lastAutoPrintedDeliveryOrderId = null;
    const errMsg = printed.error || "Cupom delivery não impresso.";
    flashPrinterStatus(`⚠️ ${errMsg}`, true);
    if (!printed.fallback) showPrintToast(`⚠️ ${errMsg}`, true);
  }
  return printed;
}

window.printDeliveryOrder = async (orderId) => {
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  if (!order) {
    alert("Pedido não encontrado.");
    return { ok: false };
  }
  const printerName = getActivePrinter();
  if (!printerName) {
    const reg = getActiveRegister();
    alert(isMultiRegisterMode()
      ? `Impressora não configurada para ${reg?.name || "este caixa"}. Configure em Empresa.`
      : "Configure a impressora em Empresa.");
    return { ok: false, error: "Sem impressora" };
  }
  showPrintToast(`Imprimindo cupom delivery em ${printerName}…`);
  const result = await doPrintDelivery(order);
  if (result.ok) {
    flashPrinterStatus(`✅ Cupom delivery enviado: ${result.printer || printerName}`);
  } else if (!result.fallback) {
    flashPrinterStatus(`⚠️ ${result.error}`, true);
    alert(`Impressão falhou:\n\n${result.error}`);
  }
  return result;
};

function buildDeliveryOrderWhatsAppMessage(order, storeName) {
  const customer = order.customer || {};
  const items = order.items || [];
  const lines = [
    `🛒 *NOVO PEDIDO — ${storeName || "Loja"}*`,
    "",
    `🆔 Pedido: #${String(order.id || "").slice(0, 8).toUpperCase()}`,
    `👤 *Cliente:* ${customer.name || "-"}`,
    `📱 *Telefone:* ${customer.phone || "-"}`,
    `📍 *Endereço:* ${customer.address || "-"}`,
    `💳 *Pagamento:* ${order.paymentMethod || "-"}`,
    ""
  ];
  if (customer.notes) lines.push(`📝 *Obs:* ${customer.notes}`, "");
  lines.push("*Itens:*");
  items.forEach((item) => {
    lines.push(`• ${item.name} x${item.qty} — ${money(item.subtotal || item.price * item.qty)}`);
    (item.selections || []).forEach((sel) => {
      lines.push(`   ${sel.groupName}: ${sel.name}`);
    });
  });
  lines.push("");
  lines.push(`Subtotal: ${money(order.subtotal)}`);
  if (order.deliveryZoneName) lines.push(`Bairro: ${order.deliveryZoneName}`);
  if (Number(order.deliveryFee) > 0 || order.deliveryZoneName) lines.push(`Taxa entrega: ${money(order.deliveryFee)}`);
  lines.push(`*TOTAL: ${money(order.total)}*`);
  return lines.join("\n");
}

window.copyDeliveryOrderText = async (orderId) => {
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  if (!order) return;
  const text = buildDeliveryOrderWhatsAppMessage(order, state.company?.name);
  try {
    await navigator.clipboard.writeText(text);
    alert("Resumo do pedido copiado!");
  } catch (_) {
    prompt("Copie o resumo do pedido:", text);
  }
};

window.openWhatsAppToCustomer = (orderId) => {
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  if (!order?.customer?.phone) return;
  const phone = normalizeWhatsAppNumber(order.customer.phone);
  if (!phone) {
    alert("Telefone do cliente inválido.");
    return;
  }
  const text = `Olá ${order.customer.name}, sobre seu pedido #${order.id.slice(0, 8).toUpperCase()} na ${state.company?.name || "loja"}...`;
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
};

const DELIVERY_STATUS_FLOW = [
  { key: "awaiting_approval", label: "Aguardando aprovação", legacy: ["new"] },
  { key: "approved", label: "Em preparação", legacy: ["preparing"] },
  { key: "out_for_delivery", label: "Saiu para entrega", legacy: [] },
  { key: "delivered", label: "Finalizado", legacy: [] }
];

const DELIVERY_STATUS_LABELS = {
  awaiting_approval: "Aguardando aprovação",
  approved: "Em preparação",
  out_for_delivery: "Saiu para entrega",
  delivered: "Finalizado",
  cancelled: "Cancelado",
  new: "Aguardando aprovação",
  preparing: "Em preparação"
};

function normalizeDeliveryStatus(status) {
  const raw = String(status || "").trim();
  if (!raw) return "awaiting_approval";
  for (const step of DELIVERY_STATUS_FLOW) {
    if (raw === step.key || step.legacy.includes(raw)) return step.key;
  }
  return raw;
}

function sortDeliveryOrdersNewestFirst(orders) {
  return [...orders].sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta;
  });
}

function applyDeliveryOrdersSnapshot(orders, options = {}) {
  const { playSound = true } = options;
  const sorted = sortDeliveryOrdersNewestFirst(orders);
  const newOnes = sorted.filter(
    (o) => isAwaitingApprovalStatus(o.status) && !state.knownDeliveryOrderIds.has(o.id)
  );
  if (playSound && state.knownDeliveryOrderIds.size > 0 && newOnes.length) {
    playNewDeliverySound();
    if (isAutoPrintDeliveryEnabled()) {
      newOnes.forEach((o) => autoPrintDeliveryOrder(o.id));
    }
  }
  sorted.forEach((o) => state.knownDeliveryOrderIds.add(o.id));
  state.deliveryOrders = sorted;
  state.deliverySyncAt = new Date();
  state.deliveryListenerError = null;
  renderDeliverySyncUI();
  renderDeliveryOrders();
  updateDeliveryNavAlert();
  backfillDeliveryOrderStatusDocs();
  if (state.activeDeliveryOrderId) {
    const still = state.deliveryOrders.find((o) => o.id === state.activeDeliveryOrderId);
    if (still) showDeliveryOrderDetails(state.activeDeliveryOrderId, { scroll: false });
    else {
      state.activeDeliveryOrderId = null;
      const box = document.getElementById("deliveryOrderDetails");
      if (box) box.innerHTML = "";
    }
  }
}

function renderDeliverySyncUI() {
  const statusEl = document.getElementById("deliverySyncStatus");
  const errEl = document.getElementById("deliveryListenerError");
  if (statusEl) {
    const total = state.deliveryOrders.length;
    const time = state.deliverySyncAt
      ? state.deliverySyncAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "—";
    statusEl.textContent = total
      ? `${total} pedido(s) no sistema · atualizado às ${time}`
      : `Nenhum pedido no momento · atualizado às ${time}`;
  }
  if (errEl) {
    if (state.deliveryListenerError) {
      errEl.textContent = state.deliveryListenerError;
      errEl.classList.remove("hidden");
    } else {
      errEl.textContent = "";
      errEl.classList.add("hidden");
    }
  }
}

async function fetchDeliveryOrdersFromFirestore() {
  const storeRef = getStoreRef();
  if (!storeRef) return [];
  let snap;
  try {
    snap = await storeRef.collection("deliveryOrders").orderBy("createdAt", "desc").limit(100).get();
  } catch (err) {
    console.warn("Delivery orderBy falhou, buscando sem ordenação:", err);
    snap = await storeRef.collection("deliveryOrders").limit(100).get();
  }
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function refreshDeliveryOrdersNow() {
  if (!state.user) return;
  try {
    const orders = await fetchDeliveryOrdersFromFirestore();
    applyDeliveryOrdersSnapshot(orders, { playSound: false });
  } catch (err) {
    state.deliveryListenerError = `Não foi possível atualizar pedidos: ${err.message || err}`;
    renderDeliverySyncUI();
    console.error("refreshDeliveryOrdersNow:", err);
  }
}

function getDeliveryStatusLabel(status) {
  const key = normalizeDeliveryStatus(status);
  return DELIVERY_STATUS_LABELS[key] || status;
}

function isAwaitingApprovalStatus(status) {
  return normalizeDeliveryStatus(status) === "awaiting_approval";
}

function syncDeliveryOrderStatusPublic(storeRef, orderId, status, extraFields = {}) {
  if (!storeRef || !orderId) return Promise.resolve();
  const normalized = normalizeDeliveryStatus(status);
  const payload = {
    status: normalized,
    updatedAt: new Date().toISOString(),
    ...extraFields
  };
  if (normalized === "delivered" && !payload.deliveredAt) {
    payload.deliveredAt = payload.updatedAt;
  }
  return storeRef.collection("deliveryOrderStatus").doc(orderId).set(payload, { merge: true });
}

let deliveryStatusBackfillDone = false;

async function backfillDeliveryOrderStatusDocs() {
  if (deliveryStatusBackfillDone) return;
  const storeRef = getStoreRef();
  if (!storeRef || !state.deliveryOrders.length) return;
  deliveryStatusBackfillDone = true;
  try {
    const writes = [];
    for (const order of state.deliveryOrders.slice(0, 80)) {
      const statusRef = storeRef.collection("deliveryOrderStatus").doc(order.id);
      const snap = await statusRef.get();
      if (snap.exists) continue;
      writes.push(
        statusRef.set({
          status: normalizeDeliveryStatus(order.status),
          createdAt: order.createdAt || new Date().toISOString(),
          updatedAt: order.updatedAt || order.acceptedAt || order.createdAt || new Date().toISOString(),
          ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {})
        })
      );
    }
    if (writes.length) await Promise.all(writes);
  } catch (err) {
    console.warn("Backfill deliveryOrderStatus:", err);
    deliveryStatusBackfillDone = false;
  }
}

function renderDeliveryStatusSteps(status) {
  const current = normalizeDeliveryStatus(status);
  if (current === "cancelled") {
    return '<p class="delivery-steps-cancelled">Pedido cancelado</p>';
  }
  const idx = DELIVERY_STATUS_FLOW.findIndex((s) => s.key === current);
  return `<div class="delivery-steps">${DELIVERY_STATUS_FLOW.map((step, i) => {
    let cls = "delivery-step";
    if (idx >= 0 && i < idx) cls += " delivery-step--done";
    else if (i === idx) cls += " delivery-step--active";
    return `<div class="${cls}"><span class="delivery-step-num">${i + 1}</span><span class="delivery-step-label">${step.label}</span></div>`;
  }).join("")}</div>`;
}

function getUnitsPerPack(product) {
  return Math.max(0, Math.floor(Number(product?.unitsPerPack || 0)));
}

function playNewDeliverySound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.2].forEach((delay) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      const t = ctx.currentTime + delay;
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
      o.start(t);
      o.stop(t + 0.25);
    });
  } catch (_) { /* ignore */ }
}

function updateDeliveryNavAlert() {
  const btn = document.getElementById("navDeliveryBtn");
  const dot = document.getElementById("navDeliveryAlert");
  if (!btn || !dot) return;
  const count = state.deliveryOrders.filter((o) => isAwaitingApprovalStatus(o.status)).length;
  if (count > 0) {
    btn.classList.add("has-stock-alert");
    dot.hidden = false;
    dot.setAttribute("aria-hidden", "false");
    const label = `${count} pedido(s) delivery novo(s)`;
    dot.title = label;
    dot.setAttribute("aria-label", label);
  } else {
    btn.classList.remove("has-stock-alert");
    dot.hidden = true;
    dot.setAttribute("aria-hidden", "true");
    dot.removeAttribute("title");
    dot.removeAttribute("aria-label");
  }
}

function unsubscribeDeliveryOrders() {
  if (state.deliveryUnsubscribe) {
    state.deliveryUnsubscribe();
    state.deliveryUnsubscribe = null;
  }
  state.deliveryOrders = [];
  state.knownDeliveryOrderIds = new Set();
}

function subscribeDeliveryOrders() {
  unsubscribeDeliveryOrders();
  const storeRef = getStoreRef();
  if (!storeRef) return;
  refreshDeliveryOrdersNow();
  const attachListener = (query) => {
    state.deliveryUnsubscribe = query.onSnapshot(
      (snap) => {
        const orders = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        applyDeliveryOrdersSnapshot(orders);
      },
      (err) => {
        console.warn("Delivery listener:", err);
        state.deliveryListenerError = `Conexão em tempo real falhou: ${err.message || err}. Use «Atualizar».`;
        renderDeliverySyncUI();
        refreshDeliveryOrdersNow();
      }
    );
  };
  try {
    attachListener(storeRef.collection("deliveryOrders").orderBy("createdAt", "desc").limit(100));
  } catch (err) {
    console.warn("Delivery listener orderBy:", err);
    attachListener(storeRef.collection("deliveryOrders").limit(100));
  }
}

let activeDeliveryTab = "awaiting_approval";

const DELIVERY_TAB_CONFIG = [
  { key: "awaiting_approval", countId: "deliveryTabCountAwaiting", empty: "Nenhum pedido aguardando aprovação." },
  { key: "approved", countId: "deliveryTabCountApproved", empty: "Nenhum pedido em preparação." },
  { key: "out_for_delivery", countId: "deliveryTabCountOut", empty: "Nenhum pedido saiu para entrega." },
  { key: "delivered", countId: "deliveryTabCountDelivered", empty: "Nenhum pedido finalizado." }
];

function setActiveDeliveryTab(tabKey) {
  activeDeliveryTab = tabKey;
  document.querySelectorAll(".delivery-status-tab").forEach((btn) => {
    const active = btn.dataset.deliveryTab === tabKey;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function updateDeliveryTabCounts() {
  DELIVERY_TAB_CONFIG.forEach(({ key, countId }) => {
    const el = document.getElementById(countId);
    if (!el) return;
    const count = state.deliveryOrders.filter((o) => normalizeDeliveryStatus(o.status) === key).length;
    el.textContent = String(count);
    el.classList.toggle("delivery-tab-count--zero", count === 0);
  });
}

// ═══════════════════════════════════════════════════════════════
// CAIXA GERAL (FINANCEIRO)
// ═══════════════════════════════════════════════════════════════
const FINANCE_CATEGORIES = {
  in: [
    { value: "entrada", label: "Entrada" },
    { value: "venda_externa", label: "Receita fora do PDV" },
    { value: "reembolso", label: "Reembolso / estorno" },
    { value: "saldo_inicial", label: "Saldo inicial" },
    { value: "transferencia_pdv", label: "Transferência do caixa PDV" },
    { value: "outros_entrada", label: "Outros" }
  ],
  out: [
    { value: "retirada", label: "Retirada" },
    { value: "mercadoria", label: "Compra de mercadoria" },
    { value: "fornecedor", label: "Pagamento a fornecedor" },
    { value: "despesa_operacional", label: "Despesa operacional (aluguel, luz…)" },
    { value: "funcionario", label: "Pagamento funcionário" },
    { value: "transferencia_pdv", label: "Transferência para caixa PDV" },
    { value: "outros_saida", label: "Outros" }
  ]
};

function getFinanceCategoryLabel(type, value) {
  const legacy = {
    aporte_socio: "Entrada",
    aporte_dono: "Entrada",
    retirada_socio: "Retirada",
    retirada_dono: "Retirada"
  };
  if (legacy[value]) return legacy[value];
  const list = FINANCE_CATEGORIES[type] || [];
  return list.find((c) => c.value === value)?.label || value || "—";
}

function getAllFinanceCategories() {
  return [...FINANCE_CATEGORIES.in, ...FINANCE_CATEGORIES.out];
}

function populateFinanceCategorySelect(selectEl, type, selected = "") {
  if (!selectEl) return;
  const list = FINANCE_CATEGORIES[type] || [];
  selectEl.innerHTML = list.map((c) => `<option value="${c.value}" ${c.value === selected ? "selected" : ""}>${c.label}</option>`).join("");
}

function populateFinanceFilterCategorySelect() {
  const select = document.getElementById("financeFilterCategory");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">Todas</option>${getAllFinanceCategories().map((c) => `<option value="${c.value}">${c.label}</option>`).join("")}`;
  if (current) select.value = current;
}

function sortFinanceTransactions(list) {
  return [...list].sort((a, b) => {
    const dateCmp = String(a.date || a.createdAt || "").localeCompare(String(b.date || b.createdAt || ""));
    if (dateCmp !== 0) return dateCmp;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

function computeFinanceBalance(transactions = state.financeTransactions) {
  return sortFinanceTransactions(transactions).reduce((sum, tx) => {
    const amount = Number(tx.amount || 0);
    return tx.type === "out" ? sum - amount : sum + amount;
  }, 0);
}

function getFinanceFilterRange() {
  const from = document.getElementById("financeFilterFrom")?.value || "";
  const to = document.getElementById("financeFilterTo")?.value || "";
  return { from, to };
}

function initFinanceFilterDates() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const firstDay = `${yyyy}-${mm}-01`;
  const today = todayISO();
  const fromEl = document.getElementById("financeFilterFrom");
  const toEl = document.getElementById("financeFilterTo");
  const dateEl = document.getElementById("financeDate");
  if (fromEl && !fromEl.value) fromEl.value = firstDay;
  if (toEl && !toEl.value) toEl.value = today;
  if (dateEl && !dateEl.value) dateEl.value = today;
}

function filterFinanceTransactions() {
  const { from, to } = getFinanceFilterRange();
  const typeFilter = document.getElementById("financeFilterType")?.value || "";
  const catFilter = document.getElementById("financeFilterCategory")?.value || "";
  return state.financeTransactions.filter((tx) => {
    const day = tx.date ? String(tx.date).slice(0, 10) : toLocalDateISO(tx.createdAt);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (typeFilter && tx.type !== typeFilter) return false;
    if (catFilter && tx.category !== catFilter) return false;
    return true;
  });
}

function setFinanceFormType(type) {
  const normalized = type === "out" ? "out" : "in";
  document.getElementById("financeType").value = normalized;
  document.getElementById("financeTypeIn")?.classList.toggle("active", normalized === "in");
  document.getElementById("financeTypeOut")?.classList.toggle("active", normalized === "out");
  populateFinanceCategorySelect(document.getElementById("financeCategory"), normalized);
  const btn = document.getElementById("financeSubmitBtn");
  if (btn) {
    btn.textContent = normalized === "in" ? "Registrar entrada" : "Registrar retirada";
    btn.classList.toggle("finance-submit-in", normalized === "in");
    btn.classList.toggle("finance-submit-out", normalized === "out");
  }
}

async function loadFinanceTransactions() {
  const storeRef = getStoreRef();
  if (!storeRef) {
    state.financeTransactions = [];
    return;
  }
  try {
    const snap = await storeRef.collection("financeTransactions").orderBy("createdAt", "desc").limit(500).get();
    state.financeTransactions = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.warn("Financeiro:", err);
    state.financeTransactions = [];
  }
}

function renderFinance() {
  initFinanceFilterDates();
  populateFinanceFilterCategorySelect();

  const filtered = filterFinanceTransactions();
  const sortedFiltered = [...filtered].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const periodIn = filtered.filter((tx) => tx.type === "in").reduce((s, tx) => s + Number(tx.amount || 0), 0);
  const periodOut = filtered.filter((tx) => tx.type === "out").reduce((s, tx) => s + Number(tx.amount || 0), 0);
  const balance = computeFinanceBalance();

  const balanceEl = document.getElementById("financeBalance");
  const inEl = document.getElementById("financePeriodIn");
  const outEl = document.getElementById("financePeriodOut");
  const countEl = document.getElementById("financePeriodCount");
  if (balanceEl) {
    balanceEl.textContent = money(balance);
    balanceEl.classList.toggle("finance-negative", balance < 0);
  }
  if (inEl) inEl.textContent = money(periodIn);
  if (outEl) outEl.textContent = money(periodOut);
  if (countEl) countEl.textContent = String(filtered.length);

  const tbody = document.getElementById("financeTableBody");
  if (!tbody) return;
  if (!sortedFiltered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="finance-empty">Nenhuma movimentação no período selecionado.</td></tr>`;
    return;
  }

  tbody.innerHTML = sortedFiltered.map((tx) => {
    const day = tx.date ? String(tx.date).slice(0, 10) : toLocalDateISO(tx.createdAt);
    const dateStr = day ? new Date(`${day}T12:00:00`).toLocaleDateString("pt-BR") : "—";
    const isIn = tx.type === "in";
    const typeLabel = isIn ? "Entrada" : "Retirada";
    const amountClass = isIn ? "finance-amount-in" : "finance-amount-out";
    const sign = isIn ? "+" : "−";
    const note = escapeHtml(String(tx.note || "—"));
    const by = escapeHtml(String(tx.createdByName || tx.createdBy || "—"));
    return `<tr class="finance-row finance-row--${tx.type}">
      <td data-label="Data">${dateStr}</td>
      <td data-label="Tipo"><span class="finance-badge finance-badge--${tx.type}">${typeLabel}</span></td>
      <td data-label="Categoria">${escapeHtml(getFinanceCategoryLabel(tx.type, tx.category))}</td>
      <td data-label="Valor" class="${amountClass}">${sign} ${money(tx.amount)}</td>
      <td data-label="Saldo após">${money(tx.balanceAfter ?? 0)}</td>
      <td data-label="Observação" class="finance-note-cell">${note}</td>
      <td data-label="Por">${by}</td>
    </tr>`;
  }).join("");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function submitFinanceMovement(e) {
  e.preventDefault();
  const type = document.getElementById("financeType")?.value === "out" ? "out" : "in";
  const category = document.getElementById("financeCategory")?.value || "";
  const amount = Number(document.getElementById("financeAmount")?.value || 0);
  const date = document.getElementById("financeDate")?.value || todayISO();
  const note = String(document.getElementById("financeNote")?.value || "").trim();

  if (!category) { alert("Selecione uma categoria."); return; }
  if (!Number.isFinite(amount) || amount <= 0) { alert("Informe um valor válido."); return; }
  if (!note) { alert("Informe uma observação para registrar o motivo da movimentação."); return; }

  const currentBalance = computeFinanceBalance();
  const nextBalance = type === "in" ? currentBalance + amount : currentBalance - amount;
    if (type === "out" && nextBalance < 0) {
    alert(`Saldo insuficiente no caixa geral.\nDisponível: ${money(currentBalance)}\nRetirada solicitada: ${money(amount)}`);
    return;
  }

  const createdAt = new Date().toISOString();
  const txId = uid();
  const tx = {
    type,
    category,
    amount,
    date,
    note,
    balanceAfter: nextBalance,
    createdAt,
    createdBy: state.user?.uid || "",
    createdByName: state.user?.email || state.company?.ownerName || "Operador"
  };

  try {
    await getStoreRef().collection("financeTransactions").doc(txId).set(tx);
    state.financeTransactions = [{ id: txId, ...tx }, ...state.financeTransactions];
    document.getElementById("financeAmount").value = "";
    document.getElementById("financeNote").value = "";
    document.getElementById("financeDate").value = todayISO();
    renderFinance();
    alert(type === "in" ? "Entrada registrada com sucesso." : "Retirada registrada com sucesso.");
  } catch (err) {
    alert(`Erro ao registrar movimentação: ${err.message}`);
  }
}

function buildFinancePrintHtml() {
  const company = state.company || {};
  const { from, to } = getFinanceFilterRange();
  const filtered = sortFinanceTransactions(filterFinanceTransactions());
  const periodIn = filtered.filter((tx) => tx.type === "in").reduce((s, tx) => s + Number(tx.amount || 0), 0);
  const periodOut = filtered.filter((tx) => tx.type === "out").reduce((s, tx) => s + Number(tx.amount || 0), 0);
  const balance = computeFinanceBalance();
  const fromStr = from ? new Date(`${from}T12:00:00`).toLocaleDateString("pt-BR") : "—";
  const toStr = to ? new Date(`${to}T12:00:00`).toLocaleDateString("pt-BR") : "—";

  const rows = filtered.map((tx) => {
    const day = tx.date ? String(tx.date).slice(0, 10) : toLocalDateISO(tx.createdAt);
    const dateStr = day ? new Date(`${day}T12:00:00`).toLocaleDateString("pt-BR") : "—";
    const sign = tx.type === "in" ? "+" : "−";
    return `<tr>
      <td>${dateStr}</td>
      <td>${tx.type === "in" ? "Entrada" : "Retirada"}</td>
      <td>${escapeHtml(getFinanceCategoryLabel(tx.type, tx.category))}</td>
      <td style="text-align:right">${sign} ${money(tx.amount)}</td>
      <td style="text-align:right">${money(tx.balanceAfter ?? 0)}</td>
      <td>${escapeHtml(tx.note || "—")}</td>
      <td>${escapeHtml(tx.createdByName || tx.createdBy || "—")}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Extrato Caixa Geral</title>
  <style>${getReportPrintStyles()}
  table { width:100%; border-collapse:collapse; margin-top:16px; font-size:12px; }
  th, td { border:1px solid #ddd; padding:8px; text-align:left; vertical-align:top; }
  th { background:#f5f5f5; }
  </style></head><body>
  <h1>${escapeHtml(company.name || "STOCK PDV")} — Extrato Caixa Geral</h1>
  <h2>Período: ${fromStr} a ${toStr}</h2>
  <div class="summary">
    <div class="s-card"><label>Saldo atual</label><strong>${money(balance)}</strong></div>
    <div class="s-card"><label>Entradas</label><strong>${money(periodIn)}</strong></div>
    <div class="s-card"><label>Retiradas</label><strong>${money(periodOut)}</strong></div>
    <div class="s-card"><label>Movimentações</label><strong>${filtered.length}</strong></div>
  </div>
  <p style="font-size:12px;color:#666;">Documento para controle interno. Cada linha possui observação registrada no sistema.</p>
  <table>
    <thead><tr><th>Data</th><th>Tipo</th><th>Categoria</th><th>Valor</th><th>Saldo após</th><th>Observação</th><th>Registrado por</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" style="text-align:center">Nenhuma movimentação</td></tr>`}</tbody>
  </table>
  <p style="margin-top:24px;font-size:11px;color:#888;">Emitido em ${new Date().toLocaleString("pt-BR")}</p>
  </body></html>`;
}

window.printFinanceReport = function printFinanceReport() {
  const html = buildFinancePrintHtml();
  const w = window.open("", "_blank");
  if (!w) { alert("Permita pop-ups para imprimir o extrato."); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
};

function setupFinance() {
  setFinanceFormType("in");
  initFinanceFilterDates();

  document.getElementById("financeTypeIn")?.addEventListener("click", () => setFinanceFormType("in"));
  document.getElementById("financeTypeOut")?.addEventListener("click", () => setFinanceFormType("out"));
  document.getElementById("financeForm")?.addEventListener("submit", submitFinanceMovement);
  document.getElementById("btnPrintFinanceReport")?.addEventListener("click", printFinanceReport);

  ["financeFilterFrom", "financeFilterTo", "financeFilterType", "financeFilterCategory"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", renderFinance);
  });
}

function isProductDeliveryVisible(product) {
  return product?.deliveryEnabled !== false;
}

function getDeliveryManageableProducts() {
  return state.products
    .filter((p) => !isMlStockProduct(p))
    .sort((a, b) => {
      const cat = getProductCategory(a).localeCompare(getProductCategory(b), "pt-BR");
      if (cat !== 0) return cat;
      return getProductLabel(a).localeCompare(getProductLabel(b), "pt-BR");
    });
}

function productMatchesDeliveryMenuSearch(product, term = "") {
  const q = normalizeSearch(term);
  const qCompact = compactSearch(term);
  if (!q && !qCompact) return true;
  const name = normalizeSearch(product.name);
  const nameCompact = compactSearch(product.name);
  const code = compactSearch(product.code);
  const category = normalizeSearch(getProductCategory(product));
  return (
    name.includes(q) ||
    nameCompact.includes(qCompact) ||
    code.includes(qCompact) ||
    category.includes(q)
  );
}

function renderDeliveryMenuManager() {
  const list = document.getElementById("deliveryMenuProductList");
  const stats = document.getElementById("deliveryMenuStats");
  if (!list) return;
  const term = document.getElementById("deliveryMenuSearch")?.value.trim() || "";
  const products = getDeliveryManageableProducts().filter((p) => productMatchesDeliveryMenuSearch(p, term));
  const visibleCount = getDeliveryManageableProducts().filter((p) => isProductDeliveryVisible(p)).length;
  const hiddenCount = getDeliveryManageableProducts().length - visibleCount;
  if (stats) {
    stats.textContent = products.length
      ? `${visibleCount} visível(is) no delivery · ${hiddenCount} oculto(s)${term ? ` · ${products.length} na busca` : ""}`
      : `${visibleCount} visível(is) no delivery · ${hiddenCount} oculto(s)`;
  }
  if (!products.length) {
    list.innerHTML = `<li class="delivery-menu-empty">${term ? "Nenhum produto encontrado na busca." : "Nenhum produto cadastrado para o cardápio."}</li>`;
    return;
  }
  list.innerHTML = products.map((p) => {
    const visible = isProductDeliveryVisible(p);
    const stock = formatStockQty(p);
    return `<li class="delivery-menu-item${visible ? "" : " delivery-menu-item--hidden"}">
      <label class="delivery-menu-item-label">
        <input type="checkbox" class="delivery-menu-toggle" data-product-id="${p.id}" ${visible ? "checked" : ""} />
        <span class="delivery-menu-item-text">
          <strong>${escapeHtml(p.name)}</strong>
          <small>${escapeHtml(getProductCategory(p))} · ${escapeHtml(p.code || "—")} · ${money(p.price)} · Estoque: ${escapeHtml(stock)}</small>
        </span>
      </label>
    </li>`;
  }).join("");
  list.querySelectorAll(".delivery-menu-toggle").forEach((input) => {
    input.addEventListener("change", async () => {
      const productId = input.dataset.productId;
      const enabled = !!input.checked;
      input.disabled = true;
      try {
        await setProductDeliveryVisibility(productId, enabled);
      } catch (err) {
        input.checked = !enabled;
        alert(`Erro ao atualizar: ${err.message || err}`);
      } finally {
        input.disabled = false;
      }
    });
  });
}

async function setProductDeliveryVisibility(productId, enabled) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  product.deliveryEnabled = !!enabled;
  const storeRef = getStoreRef();
  if (!storeRef) throw new Error("Loja não carregada.");
  await storeRef.collection("products").doc(productId).set({ deliveryEnabled: !!enabled }, { merge: true });
  renderDeliveryMenuManager();
}

async function setAllProductsDeliveryVisibility(enabled, onlyFiltered = false) {
  const term = document.getElementById("deliveryMenuSearch")?.value.trim() || "";
  let targets = getDeliveryManageableProducts();
  if (onlyFiltered && term) {
    targets = targets.filter((p) => productMatchesDeliveryMenuSearch(p, term));
  }
  if (!targets.length) return;
  const storeRef = getStoreRef();
  if (!storeRef) throw new Error("Loja não carregada.");
  const batchSize = 400;
  let batch = db.batch();
  let inBatch = 0;
  const pending = [];
  targets.forEach((product) => {
    product.deliveryEnabled = !!enabled;
    batch.set(storeRef.collection("products").doc(product.id), { deliveryEnabled: !!enabled }, { merge: true });
    inBatch += 1;
    if (inBatch >= batchSize) {
      pending.push(batch.commit());
      batch = db.batch();
      inBatch = 0;
    }
  });
  if (inBatch) pending.push(batch.commit());
  await Promise.all(pending);
  renderDeliveryMenuManager();
}

function setupDelivery() {
  document.querySelectorAll(".delivery-status-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveDeliveryTab(btn.dataset.deliveryTab);
      const details = document.getElementById("deliveryOrderDetails");
      if (details) details.innerHTML = "";
      renderDeliveryOrders();
    });
  });
  document.getElementById("btnRefreshDelivery")?.addEventListener("click", () => {
    refreshDeliveryOrdersNow();
    subscribeDeliveryOrders();
  });
  document.getElementById("deliveryMenuSearch")?.addEventListener("input", renderDeliveryMenuManager);
  document.getElementById("btnDeliveryMenuShowAll")?.addEventListener("click", async () => {
    const btn = document.getElementById("btnDeliveryMenuShowAll");
    if (btn) btn.disabled = true;
    try {
      await setAllProductsDeliveryVisibility(true, true);
    } catch (err) {
      alert(`Erro: ${err.message || err}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById("btnDeliveryMenuHideAll")?.addEventListener("click", async () => {
    if (!confirm("Ocultar os produtos filtrados do cardápio online?")) return;
    const btn = document.getElementById("btnDeliveryMenuHideAll");
    if (btn) btn.disabled = true;
    try {
      await setAllProductsDeliveryVisibility(false, true);
    } catch (err) {
      alert(`Erro: ${err.message || err}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function onDeliveryTabActivated() {
  subscribeDeliveryOrders();
  refreshDeliveryOrdersNow();
  renderDeliveryMenuManager();
}

function renderDeliveryOrders() {
  renderDeliveryTabLink();
  updateDeliveryTabCounts();
  const list = document.getElementById("deliveryOrdersList");
  if (!list) return;
  const tabMeta = DELIVERY_TAB_CONFIG.find((t) => t.key === activeDeliveryTab);
  const orders = state.deliveryOrders.filter((o) => normalizeDeliveryStatus(o.status) === activeDeliveryTab);
  if (!orders.length) {
    list.innerHTML = `<li class="delivery-list-empty">${tabMeta?.empty || "Nenhum pedido nesta etapa."}</li>`;
    return;
  }
  list.innerHTML = orders.map((o) => {
    const customer = o.customer?.name || "Cliente";
    const isNew = isAwaitingApprovalStatus(o.status);
    return `
      <li class="${isNew ? "sales-list-item--pending" : ""}">
        <span>${new Date(o.createdAt).toLocaleString("pt-BR")} | #${o.id.slice(0, 8).toUpperCase()} | ${customer} | ${money(o.total)}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="btn" onclick="printDeliveryOrder('${o.id}')">🖨️ Cupom</button>
          <button class="btn" onclick="showDeliveryOrderDetails('${o.id}')">Detalhes</button>
        </div>
      </li>`;
  }).join("");
}

window.showDeliveryOrderDetails = (orderId, options = {}) => {
  const { scroll = true } = options;
  state.activeDeliveryOrderId = orderId;
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  const box = document.getElementById("deliveryOrderDetails");
  if (!order || !box) {
    state.activeDeliveryOrderId = null;
    if (box) box.innerHTML = "<p>Pedido não encontrado. Clique em «Atualizar» ou troque de aba.</p>";
    return;
  }
  const itemsHtml = (order.items || [])
    .map((i) => {
      const choices = (i.selections || [])
        .map((sel) => `<div style="font-size:12px;color:var(--muted);">${escapeHtml(sel.groupName)}: ${escapeHtml(sel.name)}</div>`)
        .join("");
      return `<li>${escapeHtml(i.name)} x${i.qty} — ${money(i.subtotal || i.price * i.qty)}${choices}</li>`;
    })
    .join("");
  const status = normalizeDeliveryStatus(order.status);
  box.innerHTML = `
    <h3 style="font-family:var(--font-head);letter-spacing:2px;margin-bottom:12px;">Pedido ${order.id.slice(0, 8).toUpperCase()}</h3>
    ${renderDeliveryStatusSteps(status)}
    <p style="margin-top:12px;"><strong>Etapa atual:</strong> ${getDeliveryStatusLabel(status)}</p>
    <p><strong>Cliente:</strong> ${order.customer?.name || "-"}</p>
    <p><strong>Telefone:</strong> ${order.customer?.phone || "-"}</p>
    <p><strong>Endereço:</strong> ${escapeHtml(order.customer?.address || "-")}</p>
    ${order.deliveryZoneName ? `<p><strong>Bairro:</strong> ${escapeHtml(order.deliveryZoneName)}</p>` : ""}
    <p><strong>Observações:</strong> ${order.customer?.notes || "-"}</p>
    <p><strong>Pagamento:</strong> ${order.paymentMethod || "-"}</p>
    <ul style="margin:12px 0;padding-left:16px;">${itemsHtml}</ul>
    <p>Subtotal: ${money(order.subtotal)} | Taxa: ${money(order.deliveryFee || 0)} | <strong>Total: ${money(order.total)}</strong></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
      <button type="button" class="btn primary" onclick="printDeliveryOrder('${order.id}')">🖨️ Imprimir cupom delivery</button>
      <button type="button" class="btn" onclick="openWhatsAppToCustomer('${order.id}')">💬 WhatsApp do cliente</button>
      <button type="button" class="btn" onclick="copyDeliveryOrderText('${order.id}')">📋 Copiar resumo do pedido</button>
      ${status === "awaiting_approval" ? `<button class="btn primary" onclick="acceptDeliveryOrder('${order.id}')">Aprovar pedido (baixa estoque)</button>
        <button class="btn danger" onclick="cancelDeliveryOrder('${order.id}')">Recusar</button>` : ""}
      ${status === "approved" ? `<button class="btn primary" onclick="updateDeliveryOrderStatus('${order.id}','out_for_delivery')">Marcar: saiu para entrega</button>` : ""}
      ${status === "out_for_delivery" ? `<button class="btn primary" onclick="updateDeliveryOrderStatus('${order.id}','delivered')">Marcar: finalizado</button>` : ""}
      ${status !== "cancelled" && status !== "delivered" ? `<button class="btn danger" onclick="cancelDeliveryOrder('${order.id}')">Cancelar</button>` : ""}
      <button type="button" class="btn danger" onclick="deleteDeliveryOrder('${order.id}')">Excluir pedido</button>
    </div>`;
  if (scroll) scrollToPanel(box);
};

function deliveryOrderNeedsStockRestore(status) {
  return ["approved", "out_for_delivery", "delivered"].includes(normalizeDeliveryStatus(status));
}

window.deleteDeliveryOrder = async (orderId) => {
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  if (!order) return;
  const status = normalizeDeliveryStatus(order.status);
  const restoreStock = deliveryOrderNeedsStockRestore(status);
  const msg = restoreStock
    ? "Excluir este pedido permanentemente?\n\nO estoque dos itens será devolvido."
    : "Excluir este pedido permanentemente?";
  if (!confirm(msg)) return;
  const storeRef = getStoreRef();
  try {
    await db.runTransaction(async (tx) => {
      const orderRef = storeRef.collection("deliveryOrders").doc(orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new Error("Pedido não encontrado.");
      const data = orderSnap.data() || {};
      const currentStatus = normalizeDeliveryStatus(data.status);
      if (deliveryOrderNeedsStockRestore(currentStatus)) {
        const restoreMap = resolveStockDeductionsFromSaleItems(data.items || []);
        for (const [productId, addQty] of restoreMap) {
          const productRef = storeRef.collection("products").doc(productId);
          const productSnap = await tx.get(productRef);
          if (!productSnap.exists) continue;
          const currentQty = Number(productSnap.data()?.qty || 0);
          tx.update(productRef, { qty: currentQty + addQty });
        }
      }
      tx.delete(orderRef);
      tx.delete(storeRef.collection("deliveryOrderStatus").doc(orderId));
    });
    if (restoreStock) {
      resolveStockDeductionsFromSaleItems(order.items || []).forEach((addQty, productId) => {
        const p = state.products.find((x) => x.id === productId);
        if (p) p.qty = Number(p.qty || 0) + addQty;
      });
      updateStockNavAlert();
    }
    state.deliveryOrders = state.deliveryOrders.filter((o) => o.id !== orderId);
    state.knownDeliveryOrderIds.delete(orderId);
    state.activeDeliveryOrderId = null;
    const details = document.getElementById("deliveryOrderDetails");
    if (details) details.innerHTML = "";
    renderDeliveryOrders();
    updateDeliveryNavAlert();
    alert(restoreStock ? "Pedido excluído e estoque devolvido." : "Pedido excluído.");
  } catch (error) {
    alert(`Erro ao excluir pedido: ${error.message}`);
  }
};

window.acceptDeliveryOrder = async (orderId) => {
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  if (!order || !isAwaitingApprovalStatus(order.status)) return;
  if (!confirm("Aprovar pedido e baixar estoque dos produtos?")) return;
  const storeRef = getStoreRef();
  const acceptedAt = new Date().toISOString();
  try {
    await db.runTransaction(async (tx) => {
      const orderRef = storeRef.collection("deliveryOrders").doc(orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new Error("Pedido não encontrado.");
      const data = orderSnap.data() || {};
      const currentStatus = normalizeDeliveryStatus(data.status);
      if (currentStatus !== "awaiting_approval") throw new Error("Pedido já foi processado.");

      const stockDeductions = resolveStockDeductionsFromSaleItems(data.items || []);
      const productUpdates = [];
      for (const [productId, deductQty] of stockDeductions) {
        const productRef = storeRef.collection("products").doc(productId);
        const productSnap = await tx.get(productRef);
        if (!productSnap.exists) throw new Error(`Produto de estoque não encontrado: ${productId}`);
        const productData = productSnap.data() || {};
        const currentQty = Number(productData.qty || 0);
        if (currentQty < deductQty) {
          const label = state.products.find((p) => p.id === productId)?.name || productId;
          const unitLabel = isMlStockProduct(productData) ? formatMlQty(currentQty) : currentQty;
          const needLabel = isMlStockProduct(productData) ? formatMlQty(deductQty) : deductQty;
          throw new Error(`Estoque insuficiente para "${label}". Disponível: ${unitLabel}`);
        }
        productUpdates.push({ ref: productRef, nextQty: currentQty - deductQty, productId, qty: deductQty });
      }

      productUpdates.forEach((u) => tx.update(u.ref, { qty: u.nextQty }));
      tx.update(orderRef, { status: "approved", acceptedAt });
    });
    await syncDeliveryOrderStatusPublic(storeRef, orderId, "approved", { acceptedAt });

    const acceptedDeductions = resolveStockDeductionsFromSaleItems(order.items || []);
    acceptedDeductions.forEach((deductQty, productId) => {
      const p = state.products.find((x) => x.id === productId);
      if (p) p.qty = Math.max(0, Number(p.qty || 0) - deductQty);
    });
    order.status = "approved";
    order.acceptedAt = acceptedAt;
    updateStockNavAlert();
    setActiveDeliveryTab("approved");
    renderDeliveryOrders();
    showDeliveryOrderDetails(orderId, { scroll: false });
    alert("Pedido aprovado e estoque atualizado. Veja na aba «Em preparação».");
  } catch (error) {
    alert(`Erro ao aceitar pedido: ${error.message}`);
  }
};

window.cancelDeliveryOrder = async (orderId) => {
  if (!confirm("Cancelar este pedido delivery?")) return;
  await updateDeliveryOrderStatus(orderId, "cancelled");
};

const DELIVERY_STATUS_TO_TAB = {
  awaiting_approval: "awaiting_approval",
  approved: "approved",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  cancelled: "awaiting_approval"
};

window.updateDeliveryOrderStatus = async (orderId, nextStatus) => {
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  if (!order) return;
  try {
    const payload = { status: nextStatus, updatedAt: new Date().toISOString() };
    const normalized = normalizeDeliveryStatus(nextStatus);
    payload.status = normalized;
    if (normalized === "delivered") payload.deliveredAt = payload.updatedAt;
    const storeRef = getStoreRef();
    await storeRef.collection("deliveryOrders").doc(orderId).set(payload, { merge: true });
    await syncDeliveryOrderStatusPublic(storeRef, orderId, normalized, {
      deliveredAt: payload.deliveredAt || null
    });
    order.status = normalized;
    order.updatedAt = payload.updatedAt;
    if (DELIVERY_STATUS_TO_TAB[normalized]) setActiveDeliveryTab(DELIVERY_STATUS_TO_TAB[normalized]);
    renderDeliveryOrders();
    updateDeliveryNavAlert();
    showDeliveryOrderDetails(orderId, { scroll: false });
    await refreshDeliveryOrdersNow();
  } catch (error) {
    alert(`Erro ao atualizar pedido: ${error.message}`);
  }
};

// ═══════════════════════════════════════════════════════════════
// PRODUTOS
// ═══════════════════════════════════════════════════════════════
let productFormExpanded = false;

function updateProductFormMeta() {
  const meta = document.getElementById("productFormMeta");
  if (!meta) return;
  const id = document.getElementById("productId")?.value;
  const name = document.getElementById("productName")?.value.trim();
  updateProductDeleteButton();
  if (!productFormExpanded) {
    meta.textContent = id && name ? `Editando: ${name} — clique para abrir` : "Clique para cadastrar ou editar";
    return;
  }
  meta.textContent = id && name ? `Editando: ${name} — aberto` : "Cadastro aberto — clique para fechar";
}

function updateProductDeleteButton() {
  const btn = document.getElementById("btnDeleteProduct");
  const id = document.getElementById("productId")?.value;
  if (btn) btn.classList.toggle("hidden", !id);
}

function getProductsUsingAsIngredient(productId) {
  return state.products.filter((p) => {
    if (!isDoseProduct(p)) return false;
    return getDoseRecipe(p).some((row) => row.productId === productId);
  });
}

function setProductFormExpanded(expanded, options = {}) {
  const { scroll = false, focusField = false } = options;
  setCollapsiblePanel("productFormCard", expanded, {
    scroll,
    toggleId: "productFormToggle",
    onState: (v) => {
      productFormExpanded = v;
      updateProductFormMeta();
    }
  });
  if (expanded && focusField) {
    requestAnimationFrame(() => document.getElementById("productName")?.focus());
  }
}

window.toggleProductForm = () => {
  const willOpen = !productFormExpanded;
  setProductFormExpanded(willOpen, {
    scroll: willOpen,
    focusField: willOpen
  });
};

function openProductFormForNew() {
  clearProductForm(false);
  renderProductCategorySuggestions();
  if (typeof window.resetProductPhotoForm === "function") window.resetProductPhotoForm();
  setProductFormExpanded(true, { scroll: true, focusField: false });
  requestAnimationFrame(() => document.getElementById("productCode")?.focus());
}

function isProductsTabActive() {
  const tab = document.getElementById("produtosTab");
  return Boolean(tab?.classList.contains("active"));
}

function isProductFormOpen() {
  const card = document.getElementById("productFormCard");
  return Boolean(card && !card.classList.contains("collapsed"));
}

function applyBarcodeToProductCode(code) {
  const raw = String(code || "").trim();
  if (!raw) return;
  if (!isProductFormOpen()) {
    openProductFormForNew();
  }
  const input = document.getElementById("productCode");
  if (!input) return;
  input.value = raw;
  input.focus();
  input.select();
  updateProductFormMeta();
  const currentId = document.getElementById("productId")?.value;
  const duplicated = state.products.find(
    (p) => normalizeCode(p.code) === normalizeCode(raw) && p.id !== currentId
  );
  if (duplicated) {
    alert(`Código já cadastrado no produto "${getProductLabel(duplicated)}".`);
  }
}

function captureBarcodeKeydown(e, onScan) {
  if (e.key === "Enter") {
    const code = _barcodeBuffer.trim();
    _barcodeBuffer = "";
    clearTimeout(_barcodeTimer);
    if (code.length >= 3) onScan(code);
    return true;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    _barcodeBuffer += e.key;
    clearTimeout(_barcodeTimer);
    _barcodeTimer = setTimeout(() => {
      const code = _barcodeBuffer.trim();
      _barcodeBuffer = "";
      if (code.length >= 3) onScan(code);
    }, BARCODE_TIMEOUT_MS);
    return true;
  }
  return false;
}

function getMlIngredientProducts() {
  return state.products
    .filter((p) => isMlStockProduct(p))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"));
}

function getDoseIngredientProducts() {
  return state.products
    .filter((p) => isValidDoseIngredient(p))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"));
}

function formatDoseIngredientOptionLabel(product) {
  if (isMlStockProduct(product)) return `${product.name} (${formatMlQty(product.qty)})`;
  return `${product.name} (${Math.max(0, Number(product.qty || 0))} un.)`;
}

function doseRecipeRowUsesMl(productId) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return true;
  return isMlStockProduct(product);
}

function updateProductStockModeUI() {
  const mode = document.getElementById("productStockMode")?.value || STOCK_MODE_UNIT;
  const unitWrap = document.getElementById("productUnitStockFields");
  const mlWrap = document.getElementById("productMlStockFields");
  const doseWrap = document.getElementById("productDoseFields");
  const minLabel = document.getElementById("productMinStockLabel");
  const qtyLabel = document.getElementById("productQtyLabel");
  const unitsPerPackWrap = document.getElementById("productUnitsPerPackWrap");

  if (unitWrap) unitWrap.classList.toggle("hidden", mode !== STOCK_MODE_UNIT);
  if (mlWrap) mlWrap.classList.toggle("hidden", mode !== STOCK_MODE_ML);
  if (doseWrap) doseWrap.classList.toggle("hidden", mode !== STOCK_MODE_DOSE);
  if (unitsPerPackWrap) unitsPerPackWrap.classList.toggle("hidden", mode !== STOCK_MODE_UNIT);

  if (minLabel) {
    minLabel.textContent = mode === STOCK_MODE_ML
      ? "Estoque mínimo (ml)"
      : mode === STOCK_MODE_DOSE
        ? "Alerta se doses disponíveis ≤"
        : "Estoque mínimo";
  }
  if (qtyLabel) qtyLabel.textContent = "Quantidade em estoque (unidades)";
  if (mode === STOCK_MODE_DOSE && !document.querySelector("#doseRecipeList .dose-recipe-row")) {
    renderDoseRecipeList([{ productId: "", ml: 50, qty: 1 }]);
  }
}

function renderDoseRecipeAmountField(row) {
  if (doseRecipeRowUsesMl(row.productId)) {
    return `<input type="number" class="dose-recipe-ml" min="1" step="1" value="${row.ml > 0 ? row.ml : ""}" placeholder="ml" />`;
  }
  const rawQty = row.qty > 0 ? row.qty : 1;
  const qty = rawQty > 30 ? 1 : rawQty;
  return `<input type="number" class="dose-recipe-qty" min="1" max="30" step="1" value="${qty}" placeholder="un." />`;
}

function getInsumoOptionProducts(insumoId) {
  const insumo = state.products.find((p) => p.id === insumoId);
  return getComboChoiceProducts().filter((p) => {
    if (!insumo) return false;
    if (isMlStockProduct(insumo)) return isMlStockProduct(p);
    if (isUnitStockProduct(insumo)) return isUnitStockProduct(p);
    return false;
  });
}

function readInsumoOptionsFromRow(row, keepIncomplete) {
  return Array.from(row.querySelectorAll(".dose-choice-option")).map((optRow) => {
    const productId = optRow.querySelector(".dose-choice-product")?.value || "";
    const extraPrice = Math.max(0, Number(optRow.querySelector(".dose-choice-extra")?.value || 0));
    if (!productId && !keepIncomplete) return null;
    return { productId, extraPrice };
  }).filter(Boolean);
}

function renderDoseRecipeList(recipe = []) {
  const list = document.getElementById("doseRecipeList");
  if (!list) return;
  const ingredients = getDoseIngredientProducts();
  const rows = recipe.length ? recipe : [{ productId: "", ml: 50, qty: 1, options: [] }];
  list.innerHTML = rows.map((row, idx) => {
    const options = ingredients.length
      ? ingredients.map((p) =>
        `<option value="${p.id}" ${row.productId === p.id ? "selected" : ""}>${escapeHtml(formatDoseIngredientOptionLabel(p))}</option>`
      ).join("")
      : "";
    const choiceProducts = getInsumoOptionProducts(row.productId);
    const choiceRows = row.options?.length ? row.options : [];
    const choiceHtml = choiceRows.map((opt, optIdx) => {
      const selectOptions = choiceProducts.map((p) =>
        `<option value="${p.id}" ${opt.productId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`
      ).join("");
      return `<div class="dose-choice-option">
        <select class="dose-choice-product" ${choiceProducts.length ? "" : "disabled"}>
          <option value="">Selecione a opção</option>
          ${selectOptions}
        </select>
        <input type="number" class="dose-choice-extra" min="0" step="0.01" value="${Number(opt.extraPrice || 0)}" title="Acréscimo no preço, se esta opção custar a mais" placeholder="R$" />
        <button type="button" class="btn-ctrl rm dose-choice-remove" data-idx="${idx}" data-opt="${optIdx}" title="Remover opção">×</button>
      </div>`;
    }).join("");
    const fixedLabel = doseRecipeRowUsesMl(row.productId) ? "ml fixos" : "un. fixas";
    return `<div class="dose-recipe-row" data-idx="${idx}" data-choice-id="${escapeHtml(row.choiceId || "")}">
      <div class="dose-recipe-main">
        <select class="dose-recipe-product" ${ingredients.length ? "" : "disabled"}>
          <option value="">Selecione o insumo</option>
          ${options}
        </select>
        ${renderDoseRecipeAmountField(row)}
        ${rows.length > 1 ? `<button type="button" class="btn-ctrl rm dose-recipe-remove" data-idx="${idx}" title="Remover insumo">×</button>` : "<span></span>"}
      </div>
      <div class="dose-recipe-choices">
        <input type="text" class="dose-choice-name" value="${escapeHtml(row.choiceName || "")}" placeholder="Nome da escolha, ex.: Sabor" />
        <small class="dose-choice-hint">Quantidade ${fixedLabel} deste insumo. As opções abaixo usam essa mesma quantidade.</small>
        ${choiceHtml}
        <button type="button" class="btn btn-cash-sm dose-choice-add" data-idx="${idx}">+ Opção deste insumo</button>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".dose-recipe-qty, .dose-recipe-ml").forEach((input) => {
    input.addEventListener("wheel", (event) => {
      event.preventDefault();
      input.blur();
    }, { passive: false });
  });
  list.querySelectorAll(".dose-recipe-product").forEach((sel) => {
    sel.addEventListener("change", () => {
      renderDoseRecipeList(readDoseRecipeFromDOM(true));
    });
  });
  list.querySelectorAll(".dose-recipe-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = readDoseRecipeFromDOM(true);
      current.splice(Number(btn.dataset.idx), 1);
      renderDoseRecipeList(current);
    });
  });
  list.querySelectorAll(".dose-choice-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = readDoseRecipeFromDOM(true);
      const row = current[Number(btn.dataset.idx)];
      if (!row) return;
      if (!row.productId) {
        alert("Selecione o insumo antes de cadastrar as opções.");
        return;
      }
      row.options = row.options || [];
      row.options.push({ productId: "", extraPrice: 0 });
      renderDoseRecipeList(current);
    });
  });
  list.querySelectorAll(".dose-choice-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = readDoseRecipeFromDOM(true);
      const row = current[Number(btn.dataset.idx)];
      if (!row) return;
      row.options.splice(Number(btn.dataset.opt), 1);
      renderDoseRecipeList(current);
    });
  });
}

function readDoseRecipeFromDOM(keepIncomplete = false) {
  return Array.from(document.querySelectorAll("#doseRecipeList .dose-recipe-row")).map((row) => {
    const productId = row.querySelector(".dose-recipe-product")?.value || "";
    const product = state.products.find((p) => p.id === productId);
    const choiceName = row.querySelector(".dose-choice-name")?.value.trim() || "";
    const choiceId = row.dataset.choiceId || "";
    const options = readInsumoOptionsFromRow(row, keepIncomplete);
    let ml = 0;
    let qty = 0;
    if (isMlStockProduct(product)) {
      ml = Math.max(0, Number(row.querySelector(".dose-recipe-ml")?.value || 0));
    } else if (isUnitStockProduct(product)) {
      qty = Math.max(1, Math.floor(Number(row.querySelector(".dose-recipe-qty")?.value || 1)));
      if (qty > 30) qty = 1;
    } else {
      ml = Math.max(0, Number(row.querySelector(".dose-recipe-ml")?.value || 0));
      qty = Math.max(0, Math.floor(Number(row.querySelector(".dose-recipe-qty")?.value || 0)));
    }
    return { productId, ml, qty, choiceId, choiceName, options };
  });
}

function isValidDoseRecipeRow(row) {
  if (!row?.productId) return false;
  const ingredient = state.products.find((p) => p.id === row.productId);
  if (!isValidDoseIngredient(ingredient)) return false;
  if (isMlStockProduct(ingredient)) return row.ml > 0;
  if (isUnitStockProduct(ingredient)) return row.qty > 0;
  return false;
}

function newComboEditorId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function getComboChoiceProducts() {
  return state.products
    .filter((p) => p && !isDoseProduct(p))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"));
}

function readComboGroupsFromDOM(keepIncomplete = false) {
  return Array.from(document.querySelectorAll("#comboGroupList .combo-group")).map((groupEl) => {
    const options = Array.from(groupEl.querySelectorAll(".combo-option-row")).map((row) => {
      const productId = row.querySelector(".combo-option-product")?.value || "";
      const product = state.products.find((p) => p.id === productId);
      const qtyRaw = Number(row.querySelector(".combo-option-qty")?.value);
      const extraPrice = Math.max(0, Number(row.querySelector(".combo-option-extra")?.value || 0));
      let qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 0;
      if (!qty && product) qty = isMlStockProduct(product) ? 50 : 1;
      if (!productId && !keepIncomplete) return null;
      return { productId, extraPrice, qty };
    }).filter(Boolean);
    const name = groupEl.querySelector(".combo-group-name")?.value.trim() || "";
    const keptOptions = keepIncomplete ? options : options.filter((opt) => opt.productId);
    if (!keepIncomplete && (!name || !keptOptions.length)) return null;
    return {
      id: groupEl.dataset.id || newComboEditorId("grp"),
      name,
      options: keptOptions
    };
  }).filter(Boolean);
}

function renderComboGroupList(groups = []) {
  const list = document.getElementById("comboGroupList");
  if (!list) return;
  const products = getComboChoiceProducts();
  const rows = groups.length ? groups : [];
  list.innerHTML = rows.map((group) => {
    const options = group.options?.length ? group.options : [{ productId: "", extraPrice: 0, qty: 1 }];
    const optionHtml = options.map((opt, idx) => {
      const selected = products.find((p) => p.id === opt.productId);
      const qtyLabel = selected && isMlStockProduct(selected) ? "ml" : "un.";
      const qtyValue = opt.qty > 0 ? opt.qty : "";
      const selectOptions = products.map((p) =>
        `<option value="${p.id}" ${opt.productId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`
      ).join("");
      return `<div class="combo-option-row">
        <select class="combo-option-product">
          <option value="">Selecione o produto</option>
          ${selectOptions}
        </select>
        <input type="number" class="combo-option-qty" min="1" step="1" value="${qtyValue}" placeholder="${qtyLabel}" title="Quantidade que sai do estoque" />
        <input type="number" class="combo-option-extra" min="0" step="0.01" value="${Number(opt.extraPrice || 0)}" title="Acréscimo no preço do combo" />
        <button type="button" class="btn-ctrl rm combo-option-remove" data-group="${group.id}" data-idx="${idx}" title="Remover produto">×</button>
      </div>`;
    }).join("");
    return `<div class="combo-group" data-id="${escapeHtml(group.id)}">
      <div class="combo-group-head">
        <input type="text" class="combo-group-name" value="${escapeHtml(group.name || "")}" placeholder="Ex.: Marca, Sabor" />
        <button type="button" class="btn-ctrl rm combo-group-remove" title="Remover grupo">×</button>
      </div>
      ${optionHtml}
      <button type="button" class="btn btn-cash-sm combo-option-add">+ Produto nesta escolha</button>
    </div>`;
  }).join("");
}

function setupComboGroupEditor() {
  document.getElementById("btnAddComboGroup")?.addEventListener("click", () => {
    const groups = readComboGroupsFromDOM(true);
    groups.push({
      id: newComboEditorId("grp"),
      name: "",
      options: [{ productId: "", extraPrice: 0, qty: 1 }]
    });
    renderComboGroupList(groups);
  });
  document.getElementById("comboGroupList")?.addEventListener("click", (e) => {
    const groups = readComboGroupsFromDOM(true);
    if (e.target.closest(".combo-group-remove")) {
      const id = e.target.closest(".combo-group")?.dataset.id;
      renderComboGroupList(groups.filter((group) => group.id !== id));
      return;
    }
    if (e.target.closest(".combo-option-remove")) {
      const groupEl = e.target.closest(".combo-group");
      const idx = Number(e.target.closest(".combo-option-remove").dataset.idx);
      const group = groups.find((item) => item.id === groupEl?.dataset.id);
      if (!group) return;
      group.options.splice(idx, 1);
      if (!group.options.length) group.options.push({ productId: "", extraPrice: 0, qty: 1 });
      renderComboGroupList(groups);
      return;
    }
    if (e.target.closest(".combo-option-add")) {
      const groupEl = e.target.closest(".combo-group");
      const group = groups.find((item) => item.id === groupEl?.dataset.id);
      if (!group) return;
      group.options.push({ productId: "", extraPrice: 0, qty: 1 });
      renderComboGroupList(groups);
    }
  });
  document.getElementById("comboGroupList")?.addEventListener("change", (e) => {
    if (e.target.classList.contains("combo-option-product")) {
      renderComboGroupList(readComboGroupsFromDOM(true));
    }
  });
}

function readDeliveryFeeZonesFromDOM() {
  return Array.from(document.querySelectorAll("#deliveryFeeZoneList .delivery-fee-zone-row")).map((row) => ({
    id: row.dataset.id || "",
    name: row.querySelector(".delivery-fee-zone-name")?.value || "",
    fee: Number(row.querySelector(".delivery-fee-zone-fee")?.value || 0)
  }));
}

function renderDeliveryFeeZoneList(zones = []) {
  const list = document.getElementById("deliveryFeeZoneList");
  if (!list) return;
  const rows = zones.length ? zones : [];
  list.innerHTML = rows.map((zone) => `
    <div class="delivery-fee-zone-row" data-id="${escapeHtml(zone.id || newComboEditorId("zona"))}">
      <input type="text" class="delivery-fee-zone-name" value="${escapeHtml(zone.name || "")}" placeholder="Bairro ou região" />
      <input type="number" class="delivery-fee-zone-fee" min="0" step="0.01" value="${Number(zone.fee || 0)}" placeholder="R$" />
      <button type="button" class="btn-ctrl rm delivery-fee-zone-remove" title="Remover">×</button>
    </div>
  `).join("");
}

function updateDeliveryFeeModeUI() {
  const mode = document.getElementById("companyDeliveryFeeMode")?.value === "zones" ? "zones" : "flat";
  document.getElementById("companyDeliveryFeeFlatWrap")?.classList.toggle("hidden", mode === "zones");
  document.getElementById("companyDeliveryFeeZonesWrap")?.classList.toggle("hidden", mode !== "zones");
}

function setupDeliveryFeeEditor() {
  document.getElementById("companyDeliveryFeeMode")?.addEventListener("change", updateDeliveryFeeModeUI);
  document.getElementById("btnAddDeliveryFeeZone")?.addEventListener("click", () => {
    const zones = readDeliveryFeeZonesFromDOM();
    zones.push({ id: newComboEditorId("zona"), name: "", fee: 0 });
    renderDeliveryFeeZoneList(zones);
  });
  document.getElementById("deliveryFeeZoneList")?.addEventListener("click", (e) => {
    if (!e.target.closest(".delivery-fee-zone-remove")) return;
    const id = e.target.closest(".delivery-fee-zone-row")?.dataset.id;
    renderDeliveryFeeZoneList(readDeliveryFeeZonesFromDOM().filter((zone) => zone.id !== id));
  });
}

function readProductStockFields(mode) {
  if (mode === STOCK_MODE_ML) {
    return {
      qty: Math.max(0, Math.floor(Number(document.getElementById("productQtyMl")?.value || 0))),
      bottleVolumeMl: Math.max(0, Math.floor(Number(document.getElementById("productBottleVolumeMl")?.value || 0))),
      doseRecipe: [],
      comboGroups: []
    };
  }
  if (mode === STOCK_MODE_DOSE) {
    const doseRecipe = readDoseRecipeFromDOM(false)
      .filter(isValidDoseRecipeRow)
      .map((row) => {
        const options = (row.options || []).filter((opt) => opt.productId);
        return {
          productId: row.productId,
          ml: row.ml,
          qty: row.qty,
          choiceId: options.length ? (row.choiceId || newComboEditorId("ins")) : "",
          choiceName: options.length ? (row.choiceName || "Sabor") : "",
          options
        };
      });
    const comboGroups = typeof DeliveryLogic !== "undefined"
      ? DeliveryLogic.comboChoicesFromProduct({ doseRecipe, comboGroups: [] })
      : [];
    return {
      qty: 0,
      bottleVolumeMl: 0,
      doseRecipe,
      comboGroups
    };
  }
  const qtyRaw = Number(document.getElementById("productQty")?.value);
  return {
    qty: Number.isFinite(qtyRaw) ? Math.max(0, Math.floor(qtyRaw)) : 0,
    bottleVolumeMl: Math.max(0, Math.floor(Number(document.getElementById("productUnitBottleVolumeMl")?.value || 0))),
    doseRecipe: [],
    comboGroups: []
  };
}

function fillProductStockFields(product) {
  const mode = getProductStockMode(product);
  const modeEl = document.getElementById("productStockMode");
  if (modeEl) modeEl.value = mode;
  document.getElementById("productQty").value = Math.max(0, Number(product.qty || 0));
  document.getElementById("productUnitBottleVolumeMl").value = isUnitStockProduct(product)
    ? (getBottleVolumeMl(product) || "")
    : "";
  document.getElementById("productQtyMl").value = Math.max(0, Number(product.qty || 0));
  document.getElementById("productBottleVolumeMl").value = getBottleVolumeMl(product) || 1000;
  renderDoseRecipeList(editorDoseRecipe(product));
  updateProductStockModeUI();
}

function editorDoseRecipe(product) {
  const rows = getDoseRecipe(product);
  if (rows.some((row) => row.options.length)) return rows;
  return attachLegacyComboChoices(rows, Array.isArray(product?.comboGroups) ? product.comboGroups : []);
}

function attachLegacyComboChoices(rows, groups) {
  const pending = (groups || []).filter((group) => Array.isArray(group?.options) && group.options.length);
  if (!pending.length) return rows;
  const next = rows.map((row) => ({ ...row, options: row.options || [] }));
  pending.forEach((group) => {
    const match = next.find((row) => group.options.some((opt) => opt.productId === row.productId) && !row.options.length);
    const mapped = group.options.map((opt) => ({
      productId: opt.productId,
      extraPrice: Number(opt.extraPrice || 0)
    }));
    if (match) {
      match.choiceId = group.id || match.choiceId || "";
      match.choiceName = group.name || match.choiceName || "Sabor";
      match.options = mapped;
      return;
    }
    const first = group.options[0];
    const ingredient = state.products.find((p) => p.id === first.productId);
    const amount = Math.max(0, Number(first.qty || 0));
    const usesMl = ingredient ? isMlStockProduct(ingredient) : amount > 20;
    next.push({
      productId: first.productId,
      ml: usesMl ? (amount || 50) : 0,
      qty: usesMl ? 0 : (amount || 1),
      choiceId: group.id || "",
      choiceName: group.name || "Sabor",
      options: mapped
    });
  });
  return next;
}

function setupProducts() {
  document.getElementById("productFormToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleProductForm();
  });
  document.getElementById("btnNewProduct")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openProductFormForNew();
  });
  document.getElementById("btnProductPhotoAI")?.addEventListener("click", () => {
    switchToTab("aiTab");
  });
  setupProductCategoryPicker();
  setupCategoryManager();
  document.getElementById("productStockMode")?.addEventListener("change", updateProductStockModeUI);
  document.getElementById("btnAddDoseRecipeRow")?.addEventListener("click", () => {
    renderDoseRecipeList([...readDoseRecipeFromDOM(true), { productId: "", ml: 50, qty: 1, options: [] }]);
  });

  document.getElementById("productForm").addEventListener("submit", async (e) => {
    const form = e.target;
    if (!form.checkValidity()) {
      e.preventDefault();
      form.reportValidity();
      return;
    }
    e.preventDefault();
    const productId = document.getElementById("productId").value;
    const stockMode = document.getElementById("productStockMode")?.value || STOCK_MODE_UNIT;
    const stockFields = readProductStockFields(stockMode);
    let categoryId = getProductCategoryFormValue();
    if (!categoryId) {
      alert("Selecione a categoria principal (e subcategoria, se houver).");
      return;
    }
    const product = {
      name: document.getElementById("productName").value.trim(),
      code: document.getElementById("productCode").value.trim().replace(/\s+/g, ""),
      categoryId,
      category: getCategoryPathLabel(categoryId),
      price: Number(document.getElementById("productPrice").value),
      cost: Math.max(0, Number(document.getElementById("productCost").value) || 0),
      minStock: Number(document.getElementById("productMinStock").value || 0),
      photo: document.getElementById("productPhoto").value.trim(),
      description: document.getElementById("productDescription")?.value.trim() || "",
      stockMode,
      qty: stockFields.qty,
      bottleVolumeMl: stockFields.bottleVolumeMl,
      doseRecipe: stockFields.doseRecipe,
      comboGroups: stockFields.comboGroups || [],
      unitsPerPack: stockMode === STOCK_MODE_UNIT
        ? Math.max(0, Math.floor(Number(document.getElementById("productUnitsPerPack")?.value || 0)))
        : 0,
      deliveryEnabled: document.getElementById("productDeliveryEnabled")?.checked !== false
    };
    const hasExpiryControl = !!document.getElementById("productHasExpiry")?.checked;
    const expiryDateValue = String(document.getElementById("productExpiryDate")?.value || "").trim();
    if (hasExpiryControl) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDateValue)) {
        alert("Informe a data de validade do produto.");
        return;
      }
      product.hasExpiry = true;
      product.expiryDate = expiryDateValue;
    } else {
      product.hasExpiry = false;
      product.expiryDate = "";
    }
    if (!product.name || !product.categoryId || product.price < 0 || product.minStock < 0) {
      alert("Preencha os dados corretamente.");
      return;
    }
    if (stockMode === STOCK_MODE_DOSE) {
      const draftRows = readDoseRecipeFromDOM(true);
      const namedWithoutOption = draftRows.find((row) => row.choiceName && !(row.options || []).some((opt) => opt.productId));
      if (namedWithoutOption) {
        alert("A escolha do insumo precisa de pelo menos uma opção para o cliente selecionar.");
        return;
      }
      if (!product.doseRecipe.length) {
        alert("Cadastre pelo menos um insumo do combo e a quantidade fixa.");
        return;
      }
      const invalid = product.doseRecipe.find((row) => !isValidDoseRecipeRow(row));
      if (invalid) {
        alert("Cada insumo deve ser garrafa aberta (ml) ou produto em unidade (lata, gelo, etc.).");
        return;
      }
      const duplicatedOption = product.doseRecipe.find((row) => {
        const ids = (row.options || []).map((opt) => opt.productId);
        return ids.length !== new Set(ids).size;
      });
      if (duplicatedOption) {
        const label = duplicatedOption.choiceName || "insumo";
        alert(`A escolha «${label}» tem o mesmo produto mais de uma vez.`);
        return;
      }
    }
    if (product.code) {
      const duplicated = state.products.find((p) => p.code === product.code && p.id !== productId);
      if (duplicated) { alert("Já existe produto com este código."); return; }
    }
    try {
      const collection = getStoreRef().collection("products");
      if (productId) {
        await collection.doc(productId).set(product);
        const idx = state.products.findIndex((p) => p.id === productId);
        if (idx >= 0) state.products[idx] = { ...state.products[idx], ...product };
        else await loadProducts();
      } else {
        const docRef = await collection.add(product);
        state.products.push({ id: docRef.id, ...product });
      }
      clearProductForm(true);
      renderProducts();
      renderStock();
      renderPDVSearch("");
      try {
        await syncStorePublic(state.company);
      } catch (err) {
        console.warn("Publicar cardápio:", err);
      }
    } catch (error) { alert(`Erro ao salvar produto: ${error.message}`); }
  });
  document.getElementById("btnClearProduct").addEventListener("click", openProductFormForNew);
  document.getElementById("btnDeleteProduct")?.addEventListener("click", () => {
    const id = document.getElementById("productId")?.value;
    if (id) deleteProduct(id);
  });
  document.getElementById("productHasExpiry")?.addEventListener("change", () => updateProductExpiryFieldVisibility());
  updateProductFormMeta();
  updateProductExpiryFieldVisibility();
  document.getElementById("searchProduct").addEventListener("input", (e) => renderProducts(e.target.value, getProductCategoryFilter()));
  document.getElementById("filterProductCategory").addEventListener("change", (e) => {
    renderProducts(document.getElementById("searchProduct").value, e.target.value);
  });
  updateProductStockModeUI();
}

function updateProductExpiryFieldVisibility() {
  const wrap = document.getElementById("productExpiryDateWrap");
  const input = document.getElementById("productExpiryDate");
  const checked = !!document.getElementById("productHasExpiry")?.checked;
  if (!wrap || !input) return;
  wrap.style.display = checked ? "block" : "none";
  input.required = checked;
  if (!checked) input.value = "";
}

function clearProductForm(collapse = false) {
  document.getElementById("productForm").reset();
  document.getElementById("productId").value = "";
  const hasExpiryEl = document.getElementById("productHasExpiry");
  if (hasExpiryEl) hasExpiryEl.checked = false;
  if (typeof window.resetProductPhotoForm === "function") {
    window.resetProductPhotoForm();
  } else if (typeof window.refreshProductPhotoPreview === "function") {
    window.refreshProductPhotoPreview("");
  }
  updateProductExpiryFieldVisibility();
  renderProductCategoryParentSelect();
  renderProductCategorySubSelect("", "");
  syncProductCategoryHiddenValue();
  const modeEl = document.getElementById("productStockMode");
  if (modeEl) modeEl.value = STOCK_MODE_UNIT;
  renderDoseRecipeList([]);
  updateProductStockModeUI();
  updateProductFormMeta();
  if (collapse) setProductFormExpanded(false);
}

function renderProductTableRow(p) {
  return `
    <tr class="product-data-row">
      <td data-label="Produto">
        <div style="display:flex;align-items:center;gap:10px;">
          ${productThumb(p, 38)}
          <span>${p.name}</span>
        </div>
      </td>
      <td data-label="Categoria">${getProductCategory(p)}</td>
      <td data-label="Código">${p.code}</td>
      <td data-label="Preço varejo">${money(p.price)}</td>
      <td data-label="Custo">${money(p.cost)}</td>
      <td data-label="Mínimo">${isMlStockProduct(p) ? formatMlQty(getMinStock(p)) : getMinStock(p)}</td>
      <td data-label="Qtd">${formatStockQty(p)}${getUnitsPerPack(p) ? `<small style="display:block;color:var(--muted);">Fardo: ${getUnitsPerPack(p)} un.</small>` : ""}${isDoseProduct(p) ? `<small style="display:block;color:var(--muted);">Combo dose</small>` : ""}${isMlStockProduct(p) ? `<small style="display:block;color:var(--muted);">Insumo ml</small>` : ""}</td>
      <td data-label="Validade">${renderProductExpiryBadge(p)}</td>
      <td data-label="Status">${renderStockStatusBadge(p)}</td>
      <td data-label="Ações">
        <div class="product-row-actions">
          <button type="button" class="btn" onclick="event.stopPropagation(); editProduct('${p.id}')">Editar</button>
          <button type="button" class="btn danger" onclick="event.stopPropagation(); deleteProduct('${p.id}')">Excluir</button>
        </div>
      </td>
    </tr>`;
}

function renderProductTableCategoryBranch(node, products, depth, autoExpand) {
  const direct = sortProductsByStockPriority(getProductsInCategoryDirect(node.id, products));
  const childHtml = (node.children || [])
    .map((child) => renderProductTableCategoryBranch(child, products, depth + 1, autoExpand))
    .join("");
  if (!direct.length && !childHtml) return "";

  const expanded = isCategoryExpanded("products", node.id, autoExpand);
  const subtreeProducts = getProductsInCategorySubtree(node.id, products);
  const alertCount = getCategoryAlertCount(subtreeProducts);
  const encodedId = encodeURIComponent(node.id);

  return `
    <tr class="product-category-row ${expanded ? "expanded" : "collapsed"}"
      data-category-view="products"
      data-category-id="${encodedId}"
      style="--cat-depth:${depth}"
      onclick="toggleCategoryFromEl(this)">
      <td colspan="10">
        <div class="category-row-head">
          <span class="product-category-title">${escapeHtml(node.name)}</span>
          <span class="category-row-meta">
            ${subtreeProducts.length} ${subtreeProducts.length === 1 ? "produto" : "produtos"}
            ${alertCount ? `<span class="category-alert-badge">${alertCount} em alerta</span>` : ""}
          </span>
        </div>
      </td>
    </tr>
    ${expanded ? `${direct.map(renderProductTableRow).join("")}${childHtml}` : ""}`;
}

function renderUncategorizedProductTableRows(products, autoExpand) {
  const uncategorized = sortProductsByStockPriority(products.filter((p) => !resolveProductCategoryId(p)));
  if (!uncategorized.length) return "";
  const expanded = isCategoryExpanded("products", UNCATEGORIZED_CATEGORY_KEY, autoExpand);
  const alertCount = getCategoryAlertCount(uncategorized);
  return `
    <tr class="product-category-row ${expanded ? "expanded" : "collapsed"}"
      data-category-view="products"
      data-category-id="${UNCATEGORIZED_CATEGORY_KEY}"
      onclick="toggleCategoryFromEl(this)">
      <td colspan="10">
        <div class="category-row-head">
          <span class="product-category-title">Sem categoria</span>
          <span class="category-row-meta">
            ${uncategorized.length} ${uncategorized.length === 1 ? "produto" : "produtos"}
            ${alertCount ? `<span class="category-alert-badge">${alertCount} em alerta</span>` : ""}
          </span>
        </div>
      </td>
    </tr>
    ${expanded ? uncategorized.map(renderProductTableRow).join("") : ""}`;
}

function renderProducts(filter = "", categoryFilter = "") {
  const table = document.getElementById("productTableBody");
  const q = filter.trim().toLowerCase();
  const categoryFilterId = String(categoryFilter || "").trim();
  renderProductCategoryFilter();
  if (categoryFilterId) expandCategoryPathTo(categoryFilterId, "products");

  const products = state.products.filter((p) => {
    const matchesSearch = !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q);
    const matchesCategory = productMatchesCategoryFilter(p, categoryFilterId);
    return matchesSearch && matchesCategory;
  });
  if (!products.length) {
    table.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--muted);">Nenhum produto encontrado.</td></tr>`;
    return;
  }

  const autoExpand = Boolean(q) || Boolean(categoryFilterId);
  const tree = buildCategoryTree();
  let html = tree.map((node) => renderProductTableCategoryBranch(node, products, 0, autoExpand)).join("");
  html += renderUncategorizedProductTableRows(products, autoExpand);
  if (!html) {
    table.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--muted);">Nenhum produto encontrado.</td></tr>`;
    return;
  }
  table.innerHTML = html;
}

window.editProduct = (id) => {
  const p = state.products.find((item) => item.id === id);
  if (!p) return;
  document.getElementById("productId").value = p.id;
  document.getElementById("productName").value = p.name;
  document.getElementById("productCode").value = p.code;
  renderProductCategorySuggestions();
  setProductCategoryFormValue(p.categoryId || (getProductCategory(p) === "Sem categoria" ? "" : getProductCategory(p)));
  document.getElementById("productPrice").value = p.price;
  document.getElementById("productCost").value = p.cost;
  document.getElementById("productMinStock").value = getMinStock(p);
  fillProductStockFields(p);
  const unitsPerPackEl = document.getElementById("productUnitsPerPack");
  if (unitsPerPackEl) unitsPerPackEl.value = getUnitsPerPack(p);
  document.getElementById("productPhoto").value = p.photo || "";
  if (typeof window.refreshProductPhotoPreview === "function") {
    window.refreshProductPhotoPreview(p.photo || "");
  }
  const descEl = document.getElementById("productDescription");
  if (descEl) descEl.value = p.description || "";
  const hasExpiry = !!p.hasExpiry && !!getProductExpiryIso(p);
  const hasExpiryEl = document.getElementById("productHasExpiry");
  if (hasExpiryEl) hasExpiryEl.checked = hasExpiry;
  document.getElementById("productExpiryDate").value = hasExpiry ? getProductExpiryIso(p) : "";
  updateProductExpiryFieldVisibility();
  setProductFormExpanded(true, { scroll: true });
  updateProductFormMeta();
  requestAnimationFrame(() => document.getElementById("productCode")?.focus());
};

window.deleteProduct = async (id) => {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  if (state.cart.some((i) => i.productId === id)) {
    alert("Remova o item do carrinho antes de excluir.");
    return;
  }
  const usedInDoses = getProductsUsingAsIngredient(id);
  let message = `Excluir permanentemente «${product.name}»?`;
  if (usedInDoses.length) {
    const names = usedInDoses.map((p) => p.name).join(", ");
    message += `\n\nEste produto é insumo de: ${names}.\nAs doses ficarão com composição incompleta.`;
  }
  if (!confirm(message)) return;
  try {
    await getStoreRef().collection("products").doc(id).delete();
    state.products = state.products.filter((p) => p.id !== id);
    if (document.getElementById("productId")?.value === id) {
      clearProductForm(true);
    }
    renderAll();
  } catch (error) { alert(`Erro ao excluir produto: ${error.message}`); }
};

// ═══════════════════════════════════════════════════════════════
// ESTOQUE
// ═══════════════════════════════════════════════════════════════
function productMatchesReplenishSearch(product, term = "") {
  const q = normalizeSearch(term);
  const qCompact = compactSearch(term);
  if (!q || !product) return true;
  const name = normalizeSearch(product.name);
  const nameCompact = compactSearch(product.name);
  const code = compactSearch(product.code);
  return (
    name.startsWith(q) ||
    name.includes(q) ||
    nameCompact.startsWith(qCompact) ||
    nameCompact.includes(qCompact) ||
    code.startsWith(qCompact) ||
    code.includes(qCompact)
  );
}

function getReplenishProductMatches(term = "") {
  const list = state.products.filter((p) => productMatchesReplenishSearch(p, term));
  return list.sort((a, b) => getProductLabel(a).localeCompare(getProductLabel(b), "pt-BR"));
}

function ensureReplenishSelectionInList(list, selectedId) {
  if (!selectedId) return list;
  if (list.some((p) => p.id === selectedId)) return list;
  const selected = state.products.find((p) => p.id === selectedId);
  return selected ? [selected, ...list] : list;
}

function filterReplenishProductSearch(target, options = {}) {
  const alertIfEmpty = !!options.alertIfEmpty;
  const isOut = target === "out";
  const input = document.getElementById(isOut ? "replenishOutSearch" : "replenishInSearch");
  const select = document.getElementById(isOut ? "replenishOutProductId" : "replenishInProductId");
  if (!input || !select) return;
  const term = input.value.trim();
  if (!term) {
    renderReplenishProductSelect({
      outTerm: isOut ? "" : replenishSearchTerms.out,
      inTerm: isOut ? replenishSearchTerms.in : ""
    });
    return;
  }
  const matches = getReplenishProductMatches(term);
  renderReplenishProductSelect({
    outTerm: isOut ? term : replenishSearchTerms.out,
    inTerm: isOut ? replenishSearchTerms.in : term
  });
  if (!matches.length) {
    if (alertIfEmpty) alert(`Nenhum produto encontrado para «${term}».`);
    return;
  }
  if (matches.length === 1) {
    select.value = matches[0].id;
  } else if (!matches.some((p) => p.id === select.value)) {
    select.value = matches[0].id;
  }
  if (isOut) syncReplenishUnitsFromOut();
  updateReplenishPreview();
}

function applyReplenishProductSearch(target) {
  filterReplenishProductSearch(target, { alertIfEmpty: true });
  const isOut = target === "out";
  document.getElementById(isOut ? "replenishOutProductId" : "replenishInProductId")?.focus();
}

const replenishSearchTerms = { out: "", in: "" };
const openBottleSearchTerms = { out: "", in: "" };

function getOpenBottleOutProducts(term = "") {
  return state.products
    .filter((p) => isUnitStockProduct(p) && productMatchesReplenishSearch(p, term))
    .sort((a, b) => getProductLabel(a).localeCompare(getProductLabel(b), "pt-BR"));
}

function getOpenBottleInProducts(term = "") {
  return state.products
    .filter((p) => isMlStockProduct(p) && productMatchesReplenishSearch(p, term))
    .sort((a, b) => getProductLabel(a).localeCompare(getProductLabel(b), "pt-BR"));
}

function openBottleProductOption(p) {
  return `<option value="${p.id}">${p.name} (${p.code}) — ${formatStockQty(p)}</option>`;
}

const OPEN_BOTTLE_AUTO_IN = "";

function normalizeOpenBottleNameKey(name) {
  return normalizeSearch(name)
    .replace(/\s*\(aberta\)\s*/g, " ")
    .replace(/\s*\(fechada\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findOpenBottleInForClosed(closed) {
  if (!closed) return null;
  const linkedId = String(closed.linkedOpenProductId || "").trim();
  if (linkedId) {
    const linked = state.products.find((p) => p.id === linkedId && isMlStockProduct(p));
    if (linked) return linked;
  }
  const byBackLink = state.products.find(
    (p) => isMlStockProduct(p) && String(p.linkedClosedProductId || "") === closed.id
  );
  if (byBackLink) return byBackLink;
  const closedKey = normalizeOpenBottleNameKey(closed.name);
  if (!closedKey) return null;
  return state.products.find((p) => {
    if (!isMlStockProduct(p)) return false;
    const key = normalizeOpenBottleNameKey(p.name);
    return key === closedKey || key.includes(closedKey) || closedKey.includes(key);
  }) || null;
}

function resolveOpenBottleMlPerUnit(closed, inn) {
  if (inn && getBottleVolumeMl(inn) > 0) return getBottleVolumeMl(inn);
  if (closed && getBottleVolumeMl(closed) > 0) return getBottleVolumeMl(closed);
  return Math.max(0, Math.floor(Number(document.getElementById("openBottleMlPerUnit")?.value || 0)));
}

function buildOpenBottleInProductName(closed) {
  const base = String(closed?.name || "Insumo").trim();
  if (/\(aberta\)/i.test(base)) return base;
  return `${base} (aberta)`;
}

function buildOpenBottleInProductCode(closed) {
  const code = String(closed?.code || "").trim().replace(/\s+/g, "");
  if (!code) return `AB-${String(closed?.id || uid()).slice(0, 6).toUpperCase()}`;
  if (/-AB$/i.test(code)) return code;
  return `${code}-AB`.slice(0, 32);
}

async function ensureOpenBottleInProduct(closed, mlPerBottle) {
  const existing = findOpenBottleInForClosed(closed);
  if (existing) return existing;
  const storeRef = getStoreRef();
  if (!storeRef) throw new Error("Loja não carregada.");
  const id = uid();
  const volume = Math.max(1, Math.floor(Number(mlPerBottle || 0)) || 1000);
  const product = {
    name: buildOpenBottleInProductName(closed),
    code: buildOpenBottleInProductCode(closed),
    categoryId: closed.categoryId || "",
    category: closed.category || getProductCategory(closed),
    price: 0,
    cost: Math.max(0, Number(closed.cost || 0)),
    minStock: 0,
    photo: "",
    description: `Insumo aberto vinculado a ${closed.name}`,
    stockMode: STOCK_MODE_ML,
    qty: 0,
    bottleVolumeMl: volume,
    doseRecipe: [],
    unitsPerPack: 0,
    linkedClosedProductId: closed.id,
    deliveryEnabled: false,
    hasExpiry: false,
    expiryDate: ""
  };
  await storeRef.collection("products").doc(id).set(product);
  await storeRef.collection("products").doc(closed.id).set({ linkedOpenProductId: id }, { merge: true });
  closed.linkedOpenProductId = id;
  const saved = { id, ...product };
  state.products.push(saved);
  return saved;
}

function syncOpenBottleInFromOut() {
  const outId = document.getElementById("openBottleOutProductId")?.value;
  const inSelect = document.getElementById("openBottleInProductId");
  if (!outId || !inSelect) return;
  const closed = state.products.find((p) => p.id === outId);
  const match = findOpenBottleInForClosed(closed);
  if (match && inSelect.querySelector(`option[value="${match.id}"]`)) {
    inSelect.value = match.id;
  } else if (!inSelect.value) {
    inSelect.value = OPEN_BOTTLE_AUTO_IN;
  }
  syncOpenBottleMlPerUnit(closed);
}

function syncOpenBottleMlPerUnit(closed = null, inn = null) {
  const mlInput = document.getElementById("openBottleMlPerUnit");
  if (!mlInput) return;
  if (!closed) {
    const outId = document.getElementById("openBottleOutProductId")?.value;
    closed = state.products.find((p) => p.id === outId);
  }
  if (!inn) {
    const inId = document.getElementById("openBottleInProductId")?.value;
    inn = inId ? state.products.find((p) => p.id === inId) : null;
  }
  const ml = resolveOpenBottleMlPerUnit(closed, inn);
  if (ml > 0) mlInput.value = String(ml);
}

function syncOpenBottleMlFromIn() {
  syncOpenBottleMlPerUnit();
}

function updateOpenBottlePreview() {
  const preview = document.getElementById("openBottlePreview");
  const outId = document.getElementById("openBottleOutProductId")?.value;
  const inId = document.getElementById("openBottleInProductId")?.value;
  const bottles = Math.max(0, Math.floor(Number(document.getElementById("openBottleQty")?.value || 0)));
  const mlPerBottle = Math.max(0, Math.floor(Number(document.getElementById("openBottleMlPerUnit")?.value || 0)));
  if (!preview) return;
  const out = state.products.find((p) => p.id === outId);
  if (!out) {
    preview.textContent = "Selecione a garrafa fechada.";
    return;
  }
  if (!isUnitStockProduct(out)) {
    preview.textContent = "Saída deve ser produto em unidade (garrafa fechada).";
    return;
  }
  if (inId && inId === outId) {
    preview.textContent = "Saída e entrada devem ser produtos diferentes.";
    return;
  }
  const inn = inId ? state.products.find((p) => p.id === inId) : null;
  const autoCreate = !inId;
  if (inId && (!inn || !isMlStockProduct(inn))) {
    preview.textContent = "Entrada deve ser insumo em ml (garrafa aberta).";
    return;
  }
  if (bottles <= 0 || mlPerBottle <= 0) {
    preview.textContent = "Informe quantidade de garrafas e ml por garrafa.";
    return;
  }
  const addMl = bottles * mlPerBottle;
  const outQty = Number(out.qty || 0);
  const outNext = outQty - bottles;
  const inQty = inn ? Number(inn.qty || 0) : 0;
  const inNext = inQty + addMl;
  const inLabel = autoCreate ? buildOpenBottleInProductName(out) : inn.name;
  let msg = `${bottles} garrafa(s) × ${formatMlQty(mlPerBottle)} = +${formatMlQty(addMl)}.\n`;
  msg += `Saída — ${out.name}: ${outQty} → ${outNext} un.\n`;
  if (autoCreate) {
    msg += `Entrada — ${inLabel} (será criado): 0 ml → ${formatMlQty(inNext)}.`;
  } else {
    msg += `Entrada — ${inLabel}: ${formatMlQty(inQty)} → ${formatMlQty(inNext)}.`;
  }
  if (outNext < 0) msg += "\n⚠ Estoque de garrafa fechada insuficiente.";
  preview.textContent = msg;
}

function renderOpenBottleProductSelect(filters = {}) {
  const outSelect = document.getElementById("openBottleOutProductId");
  const inSelect = document.getElementById("openBottleInProductId");
  if (!outSelect || !inSelect) return;

  openBottleSearchTerms.out = String(filters.outTerm ?? openBottleSearchTerms.out ?? "").trim();
  openBottleSearchTerms.in = String(filters.inTerm ?? openBottleSearchTerms.in ?? "").trim();

  let outList = getOpenBottleOutProducts(openBottleSearchTerms.out);
  let inList = getOpenBottleInProducts(openBottleSearchTerms.in);
  const outCurrent = outSelect.value;
  const inCurrent = inSelect.value;
  outList = ensureReplenishSelectionInList(outList, outCurrent);
  inList = ensureReplenishSelectionInList(inList, inCurrent);

  const emptyOpt = '<option value="">Cadastre produtos primeiro</option>';
  if (!state.products.length) {
    outSelect.innerHTML = emptyOpt;
    inSelect.innerHTML = emptyOpt;
    outSelect.disabled = true;
    inSelect.disabled = true;
    return;
  }
  const autoInOpt = `<option value="${OPEN_BOTTLE_AUTO_IN}">— Criar insumo aberto na 1ª abertura —</option>`;
  if (!outList.length) {
    const noMatch = '<option value="">Nenhum produto na busca</option>';
    outSelect.innerHTML = noMatch;
    inSelect.innerHTML = autoInOpt;
    outSelect.disabled = true;
    inSelect.disabled = false;
    updateOpenBottlePreview();
    return;
  }
  outSelect.disabled = false;
  inSelect.disabled = false;
  outSelect.innerHTML = outList.map(openBottleProductOption).join("");
  const inOptions = inList.map(openBottleProductOption).join("");
  inSelect.innerHTML = autoInOpt + inOptions;
  if (outCurrent && outList.some((p) => p.id === outCurrent)) outSelect.value = outCurrent;
  else outSelect.selectedIndex = 0;
  if (inCurrent !== null && inCurrent !== undefined) {
    if (inCurrent === OPEN_BOTTLE_AUTO_IN || inList.some((p) => p.id === inCurrent)) {
      inSelect.value = inCurrent;
    }
  }
  syncOpenBottleInFromOut();
  updateOpenBottlePreview();
}

function filterOpenBottleProductSearch(target, options = {}) {
  const alertIfEmpty = !!options.alertIfEmpty;
  const isOut = target === "out";
  const input = document.getElementById(isOut ? "openBottleOutSearch" : "openBottleInSearch");
  const select = document.getElementById(isOut ? "openBottleOutProductId" : "openBottleInProductId");
  if (!input || !select) return;
  const term = input.value.trim();
  if (!term) {
    renderOpenBottleProductSelect({
      outTerm: isOut ? "" : openBottleSearchTerms.out,
      inTerm: isOut ? openBottleSearchTerms.in : ""
    });
    return;
  }
  const matches = isOut ? getOpenBottleOutProducts(term) : getOpenBottleInProducts(term);
  renderOpenBottleProductSelect({
    outTerm: isOut ? term : openBottleSearchTerms.out,
    inTerm: isOut ? openBottleSearchTerms.in : term
  });
  if (!matches.length) {
    if (alertIfEmpty) alert(`Nenhum produto encontrado para «${term}».`);
    return;
  }
  if (matches.length === 1) {
    select.value = matches[0].id;
  } else if (!matches.some((p) => p.id === select.value)) {
    select.value = matches[0].id;
  }
  if (!isOut) syncOpenBottleMlFromIn();
  updateOpenBottlePreview();
}

function applyOpenBottleProductSearch(target) {
  filterOpenBottleProductSearch(target, { alertIfEmpty: true });
  const isOut = target === "out";
  document.getElementById(isOut ? "openBottleOutProductId" : "openBottleInProductId")?.focus();
}

function replenishProductOption(p) {
  return `<option value="${p.id}">${p.name} (${p.code}) — ${formatStockQty(p)}</option>`;
}

function syncReplenishUnitsFromOut() {
  const outId = document.getElementById("replenishOutProductId")?.value;
  const unitsInput = document.getElementById("replenishUnitsPerPack");
  if (!unitsInput || !outId) return;
  const out = state.products.find((p) => p.id === outId);
  const units = getUnitsPerPack(out);
  if (units > 0) unitsInput.value = String(units);
}

function updateReplenishPreview() {
  const preview = document.getElementById("replenishPreview");
  const outId = document.getElementById("replenishOutProductId")?.value;
  const inId = document.getElementById("replenishInProductId")?.value;
  const packs = Math.max(0, Math.floor(Number(document.getElementById("replenishPackQty")?.value || 0)));
  const unitsPerPack = Math.max(0, Math.floor(Number(document.getElementById("replenishUnitsPerPack")?.value || 0)));
  if (!preview) return;
  const out = state.products.find((p) => p.id === outId);
  const inn = state.products.find((p) => p.id === inId);
  if (!out || !inn) {
    preview.textContent = "Selecione os produtos de saída e entrada.";
    return;
  }
  if (outId === inId) {
    preview.textContent = "Saída e entrada devem ser produtos diferentes.";
    return;
  }
  if (packs <= 0 || unitsPerPack <= 0) {
    preview.textContent = "Informe quantidade de fardos e unidades por fardo.";
    return;
  }
  const addQty = packs * unitsPerPack;
  const outQty = Number(out.qty || 0);
  const inQty = Number(inn.qty || 0);
  const outNext = outQty - packs;
  const inNext = inQty + addQty;
  let msg = `${packs} fardo(s) × ${unitsPerPack} un. = +${addQty} unidades.\n`;
  msg += `Saída — ${out.name}: ${outQty} → ${outNext} fardo(s).\n`;
  msg += `Entrada — ${inn.name}: ${inQty} → ${inNext} unidade(s).`;
  if (outNext < 0) msg += "\n⚠ Estoque de fardo insuficiente.";
  preview.textContent = msg;
}

function renderReplenishProductSelect(filters = {}) {
  const outSelect = document.getElementById("replenishOutProductId");
  const inSelect = document.getElementById("replenishInProductId");
  if (!outSelect || !inSelect) return;

  replenishSearchTerms.out = String(filters.outTerm ?? replenishSearchTerms.out ?? "").trim();
  replenishSearchTerms.in = String(filters.inTerm ?? replenishSearchTerms.in ?? "").trim();

  let outList = getReplenishProductMatches(replenishSearchTerms.out);
  let inList = getReplenishProductMatches(replenishSearchTerms.in);
  const outCurrent = outSelect.value;
  const inCurrent = inSelect.value;
  outList = ensureReplenishSelectionInList(outList, outCurrent);
  inList = ensureReplenishSelectionInList(inList, inCurrent);

  const emptyOpt = '<option value="">Cadastre produtos primeiro</option>';
  if (!state.products.length) {
    outSelect.innerHTML = emptyOpt;
    inSelect.innerHTML = emptyOpt;
    outSelect.disabled = true;
    inSelect.disabled = true;
    return;
  }
  if (!outList.length || !inList.length) {
    const noMatch = '<option value="">Nenhum produto na busca</option>';
    outSelect.innerHTML = outList.length ? outList.map(replenishProductOption).join("") : noMatch;
    inSelect.innerHTML = inList.length ? inList.map(replenishProductOption).join("") : noMatch;
    outSelect.disabled = !outList.length;
    inSelect.disabled = !inList.length;
    updateReplenishPreview();
    return;
  }
  outSelect.disabled = false;
  inSelect.disabled = false;
  outSelect.innerHTML = outList.map(replenishProductOption).join("");
  inSelect.innerHTML = inList.map(replenishProductOption).join("");
  if (outCurrent && outList.some((p) => p.id === outCurrent)) outSelect.value = outCurrent;
  else outSelect.selectedIndex = 0;
  if (inCurrent && inList.some((p) => p.id === inCurrent)) inSelect.value = inCurrent;
  else inSelect.selectedIndex = Math.min(1, inList.length - 1);
  syncReplenishUnitsFromOut();
  updateReplenishPreview();
}

let replenishFormExpanded = false;
let openBottleFormExpanded = false;
let stockEntryFormExpanded = false;

function updateStockPanelMeta(toggleId, expanded) {
  const meta = document.getElementById(toggleId)?.querySelector(".form-card-toggle-meta");
  if (meta) meta.textContent = expanded ? "Aberto — clique para fechar" : "Clique para abrir";
}

const stockPanelSiblingState = {
  stockEntryFormCard: (expanded) => {
    stockEntryFormExpanded = expanded;
    updateStockPanelMeta("stockEntryFormToggle", expanded);
  },
  replenishFormCard: (expanded) => {
    replenishFormExpanded = expanded;
    updateStockPanelMeta("replenishFormToggle", expanded);
  },
  openBottleFormCard: (expanded) => {
    openBottleFormExpanded = expanded;
    updateStockPanelMeta("openBottleFormToggle", expanded);
  }
};

function setOpenBottleFormExpanded(expanded) {
  setCollapsiblePanel("openBottleFormCard", expanded, {
    group: COLLAPSIBLE_GROUPS.estoque,
    scroll: false,
    toggleId: "openBottleFormToggle",
    onState: stockPanelSiblingState.openBottleFormCard,
    siblingState: stockPanelSiblingState
  });
}

function setReplenishFormExpanded(expanded) {
  setCollapsiblePanel("replenishFormCard", expanded, {
    group: COLLAPSIBLE_GROUPS.estoque,
    scroll: false,
    toggleId: "replenishFormToggle",
    onState: stockPanelSiblingState.replenishFormCard,
    siblingState: stockPanelSiblingState
  });
}

function setStockEntryFormExpanded(expanded) {
  setCollapsiblePanel("stockEntryFormCard", expanded, {
    group: COLLAPSIBLE_GROUPS.estoque,
    scroll: false,
    toggleId: "stockEntryFormToggle",
    onState: stockPanelSiblingState.stockEntryFormCard,
    siblingState: stockPanelSiblingState
  });
}

function setupStock() {
  document.getElementById("replenishFormToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    setReplenishFormExpanded(!replenishFormExpanded);
  });
  document.getElementById("openBottleFormToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    setOpenBottleFormExpanded(!openBottleFormExpanded);
  });
  document.getElementById("stockEntryFormToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    setStockEntryFormExpanded(!stockEntryFormExpanded);
  });

  document.getElementById("replenishOutProductId")?.addEventListener("change", () => {
    syncReplenishUnitsFromOut();
    updateReplenishPreview();
  });
  document.getElementById("replenishInProductId")?.addEventListener("change", updateReplenishPreview);
  document.getElementById("replenishPackQty")?.addEventListener("input", updateReplenishPreview);
  document.getElementById("replenishUnitsPerPack")?.addEventListener("input", updateReplenishPreview);

  document.getElementById("btnReplenishOutSearch")?.addEventListener("click", () => applyReplenishProductSearch("out"));
  document.getElementById("btnReplenishInSearch")?.addEventListener("click", () => applyReplenishProductSearch("in"));
  document.getElementById("replenishOutSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyReplenishProductSearch("out");
    }
  });
  document.getElementById("replenishInSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyReplenishProductSearch("in");
    }
  });
  document.getElementById("replenishOutSearch")?.addEventListener("input", () => {
    filterReplenishProductSearch("out");
  });
  document.getElementById("replenishInSearch")?.addEventListener("input", () => {
    filterReplenishProductSearch("in");
  });

  document.getElementById("openBottleOutProductId")?.addEventListener("change", () => {
    syncOpenBottleInFromOut();
    updateOpenBottlePreview();
  });
  document.getElementById("openBottleInProductId")?.addEventListener("change", () => {
    syncOpenBottleMlFromIn();
    updateOpenBottlePreview();
  });
  document.getElementById("openBottleQty")?.addEventListener("input", updateOpenBottlePreview);
  document.getElementById("openBottleMlPerUnit")?.addEventListener("input", updateOpenBottlePreview);
  document.getElementById("btnOpenBottleOutSearch")?.addEventListener("click", () => applyOpenBottleProductSearch("out"));
  document.getElementById("btnOpenBottleInSearch")?.addEventListener("click", () => applyOpenBottleProductSearch("in"));
  document.getElementById("openBottleOutSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyOpenBottleProductSearch("out");
    }
  });
  document.getElementById("openBottleInSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyOpenBottleProductSearch("in");
    }
  });
  document.getElementById("openBottleOutSearch")?.addEventListener("input", () => {
    filterOpenBottleProductSearch("out");
  });
  document.getElementById("openBottleInSearch")?.addEventListener("input", () => {
    filterOpenBottleProductSearch("in");
  });

  document.getElementById("openBottleForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const outId = document.getElementById("openBottleOutProductId")?.value;
    let inId = document.getElementById("openBottleInProductId")?.value;
    const bottles = Math.floor(Number(document.getElementById("openBottleQty")?.value));
    const mlPerBottle = Math.floor(Number(document.getElementById("openBottleMlPerUnit")?.value));
    const out = state.products.find((p) => p.id === outId);
    if (!out) {
      alert("Selecione a garrafa fechada (saída).");
      return;
    }
    if (!isUnitStockProduct(out)) {
      alert("Saída deve ser produto em unidade (garrafa fechada).");
      return;
    }
    if (bottles <= 0 || mlPerBottle <= 0) {
      alert("Informe quantidade de garrafas e ml por garrafa (mínimo 1).");
      return;
    }
    let inn = inId ? state.products.find((p) => p.id === inId) : null;
    if (inId && inId === outId) {
      alert("Saída e entrada devem ser produtos diferentes.");
      return;
    }
    if (inId && (!inn || !isMlStockProduct(inn))) {
      alert("Entrada deve ser insumo em ml (garrafa aberta).");
      return;
    }
    let createdInsumo = false;
    try {
      if (!inn) {
        inn = await ensureOpenBottleInProduct(out, mlPerBottle);
        inId = inn.id;
        createdInsumo = true;
        renderOpenBottleProductSelect();
        const inSelect = document.getElementById("openBottleInProductId");
        if (inSelect) inSelect.value = inId;
      }
    } catch (err) {
      alert(`Erro ao preparar insumo aberto: ${err.message || err}`);
      return;
    }
    const outQty = Number(out.qty || 0);
    if (outQty < bottles) {
      alert(`Estoque insuficiente de garrafa fechada.\n«${getProductLabel(out)}»: disponível ${outQty}, solicitado ${bottles}.`);
      return;
    }
    const addMl = bottles * mlPerBottle;
    const outNext = outQty - bottles;
    const inNext = Number(inn.qty || 0) + addMl;
    const msg =
      `Abrir ${bottles} garrafa(s)?\n\n` +
      `SAÍDA — ${getProductLabel(out)}\n${outQty} → ${outNext} un.\n\n` +
      `ENTRADA — ${getProductLabel(inn)}\n${formatMlQty(inn.qty)} → ${formatMlQty(inNext)} (+${formatMlQty(addMl)})` +
      (createdInsumo ? "\n\nO insumo aberto será criado e vinculado automaticamente." : "");
    if (!confirm(msg)) return;
    const storeRef = getStoreRef();
    try {
      await db.runTransaction(async (tx) => {
        const outRef = storeRef.collection("products").doc(outId);
        const inRef = storeRef.collection("products").doc(inId);
        const outSnap = await tx.get(outRef);
        const inSnap = await tx.get(inRef);
        if (!outSnap.exists || !inSnap.exists) throw new Error("Produto não encontrado.");
        const liveOutQty = Number(outSnap.data()?.qty || 0);
        const liveInQty = Number(inSnap.data()?.qty || 0);
        if (liveOutQty < bottles) {
          throw new Error(`Estoque insuficiente de garrafa fechada (${liveOutQty} disponível).`);
        }
        tx.update(outRef, { qty: liveOutQty - bottles });
        tx.update(inRef, { qty: liveInQty + addMl });
      });
      out.qty = outNext;
      inn.qty = inNext;
      document.getElementById("openBottleQty").value = "1";
      renderAll();
      alert(`Garrafa(s) aberta(s).\nSaída: −${bottles} un.\nEntrada: +${formatMlQty(addMl)}.`);
    } catch (error) {
      alert(`Erro ao abrir garrafa: ${error.message}`);
    }
  });

  document.getElementById("replenishForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const outId = document.getElementById("replenishOutProductId")?.value;
    const inId = document.getElementById("replenishInProductId")?.value;
    const packs = Math.floor(Number(document.getElementById("replenishPackQty")?.value));
    const unitsPerPack = Math.floor(Number(document.getElementById("replenishUnitsPerPack")?.value));
    const out = state.products.find((p) => p.id === outId);
    const inn = state.products.find((p) => p.id === inId);
    if (!out || !inn || outId === inId) {
      alert("Selecione produtos diferentes para saída (fardo) e entrada (unidade).");
      return;
    }
    if (packs <= 0 || unitsPerPack <= 0) {
      alert("Informe quantidade de fardos e unidades por fardo (mínimo 1).");
      return;
    }
    const outQty = Number(out.qty || 0);
    if (outQty < packs) {
      alert(`Estoque insuficiente de fardo.\n«${getProductLabel(out)}»: disponível ${outQty}, solicitado ${packs}.`);
      return;
    }
    const addQty = packs * unitsPerPack;
    const outNext = outQty - packs;
    const inNext = Number(inn.qty || 0) + addQty;
    const msg =
      `Converter ${packs} fardo(s)?\n\n` +
      `SAÍDA — ${getProductLabel(out)}\n${outQty} → ${outNext} fardo(s)\n\n` +
      `ENTRADA — ${getProductLabel(inn)}\n${inn.qty} → ${inNext} unidade(s) (+${addQty})`;
    if (!confirm(msg)) return;
    const storeRef = getStoreRef();
    try {
      await db.runTransaction(async (tx) => {
        const outRef = storeRef.collection("products").doc(outId);
        const inRef = storeRef.collection("products").doc(inId);
        const outSnap = await tx.get(outRef);
        const inSnap = await tx.get(inRef);
        if (!outSnap.exists || !inSnap.exists) throw new Error("Produto não encontrado.");
        const liveOutQty = Number(outSnap.data()?.qty || 0);
        const liveInQty = Number(inSnap.data()?.qty || 0);
        if (liveOutQty < packs) {
          throw new Error(`Estoque insuficiente de fardo (${liveOutQty} disponível).`);
        }
        tx.update(outRef, { qty: liveOutQty - packs });
        tx.update(inRef, { qty: liveInQty + addQty });
      });
      out.qty = outNext;
      inn.qty = inNext;
      document.getElementById("replenishPackQty").value = "1";
      renderAll();
      alert(`Reposição concluída.\nSaída: −${packs} fardo(s).\nEntrada: +${addQty} unidade(s).`);
    } catch (error) {
      alert(`Erro na reposição: ${error.message}`);
    }
  });

  document.getElementById("stockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const productId = document.getElementById("stockProductId").value;
    const qty = Number(document.getElementById("stockQty").value);
    const product = state.products.find((p) => p.id === productId);
    if (!product || qty <= 0) { alert("Selecione um produto e quantidade válida."); return; }
    try {
      const nextQty = product.qty + qty;
      await getStoreRef().collection("products").doc(productId).set({ ...product, qty: nextQty });
      product.qty = nextQty;
      e.target.reset();
      renderAll();
    } catch (error) { alert(`Erro ao atualizar estoque: ${error.message}`); }
  });
  document.getElementById("stockSearch").addEventListener("input", (e) => renderStock(e.target.value));
  document.getElementById("btnStockSelectVisible")?.addEventListener("click", selectAllVisibleStockProducts);
  document.getElementById("btnStockClearSelection")?.addEventListener("click", clearStockBulkSelection);
  document.getElementById("btnStockApplyBulkPrice")?.addEventListener("click", applyStockBulkPrice);
  document.getElementById("stockList")?.addEventListener("change", (e) => {
    const checkbox = e.target.closest(".stock-bulk-select");
    if (!checkbox || stockBulkSelectionRendering) return;
    e.stopPropagation();
    toggleStockBulkSelection(checkbox.dataset.productId, checkbox.checked);
  });
  document.getElementById("stockList")?.addEventListener("click", (e) => {
    if (e.target.closest(".stock-bulk-select")) e.stopPropagation();
  });
  stockBulkPriceSelection.clear();
  updateStockBulkSelectionUI();
}

function getStockFilteredProducts(filter = "") {
  const q = filter.trim().toLowerCase();
  if (!q) return state.products;
  return state.products.filter((p) =>
    p.name.toLowerCase().includes(q) ||
    p.code.toLowerCase().includes(q) ||
    getProductCategory(p).toLowerCase().includes(q)
  );
}

function updateStockBulkSelectionUI() {
  const countEl = document.getElementById("stockBulkSelectionCount");
  const count = stockBulkPriceSelection.size;
  if (countEl) {
    countEl.textContent = count === 1 ? "1 selecionado" : `${count} selecionados`;
  }
}

function toggleStockBulkSelection(productId, checked) {
  if (!productId || stockBulkSelectionRendering) return;
  if (checked) stockBulkPriceSelection.add(productId);
  else stockBulkPriceSelection.delete(productId);
  updateStockBulkSelectionUI();
  const row = document.querySelector(`.stock-list-item[data-product-id="${productId}"]`);
  if (row) row.classList.toggle("stock-list-item--selected", !!checked);
}

window.toggleStockBulkSelection = toggleStockBulkSelection;

function selectAllVisibleStockProducts() {
  const filter = document.getElementById("stockSearch")?.value || "";
  getStockFilteredProducts(filter).forEach((p) => stockBulkPriceSelection.add(p.id));
  updateStockBulkSelectionUI();
  renderStock(filter);
}

function clearStockBulkSelection() {
  stockBulkPriceSelection.clear();
  updateStockBulkSelectionUI();
  renderStock(document.getElementById("stockSearch")?.value || "");
}

async function applyStockBulkPrice() {
  const ids = [...stockBulkPriceSelection];
  if (!ids.length) {
    alert("Selecione pelo menos um produto na lista.");
    return;
  }
  const priceRaw = document.getElementById("stockBulkPriceValue")?.value;
  const price = Number(priceRaw);
  if (priceRaw === "" || Number.isNaN(price) || price < 0) {
    alert("Informe um preço válido (maior ou igual a zero).");
    document.getElementById("stockBulkPriceValue")?.focus();
    return;
  }
  const previewNames = ids
    .slice(0, 6)
    .map((id) => state.products.find((p) => p.id === id)?.name)
    .filter(Boolean);
  const extra = ids.length > previewNames.length ? `\n... e mais ${ids.length - previewNames.length} produto(s)` : "";
  if (!confirm(`Alterar o preço de ${ids.length} produto(s) para ${money(price)}?\n\n${previewNames.join("\n")}${extra}`)) {
    return;
  }
  const storeRef = getStoreRef();
  if (!storeRef) {
    alert("Loja não carregada.");
    return;
  }
  const btn = document.getElementById("btnStockApplyBulkPrice");
  if (btn) btn.disabled = true;
  try {
    const batchSize = 400;
    let batch = db.batch();
    let inBatch = 0;
    const pending = [];
    ids.forEach((id) => {
      batch.set(storeRef.collection("products").doc(id), { price }, { merge: true });
      inBatch += 1;
      if (inBatch >= batchSize) {
        pending.push(batch.commit());
        batch = db.batch();
        inBatch = 0;
      }
    });
    if (inBatch) pending.push(batch.commit());
    await Promise.all(pending);
    ids.forEach((id) => {
      const product = state.products.find((p) => p.id === id);
      if (product) product.price = price;
    });
    stockBulkPriceSelection.clear();
    const priceInput = document.getElementById("stockBulkPriceValue");
    if (priceInput) priceInput.value = "";
    updateStockBulkSelectionUI();
    renderAll();
    alert(`${ids.length} produto(s) atualizado(s) com preço ${money(price)}.`);
  } catch (error) {
    alert(`Erro ao atualizar preços: ${error.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderStock(filter = "") {
  const q = filter.trim().toLowerCase();
  const select = document.getElementById("stockProductId");
  const list = document.getElementById("stockList");
  renderReplenishProductSelect();
  renderOpenBottleProductSelect();
  const sortedAll = sortProductsByStockPriority(state.products);
  select.innerHTML = sortedAll.length
    ? sortedAll.map((p) => `<option value="${p.id}">${p.name} (${p.code}) — ${formatStockQty(p)}</option>`).join("")
    : `<option value="">Sem produtos cadastrados</option>`;
  const filtered = getStockFilteredProducts(q);
  if (!filtered.length) {
    list.innerHTML = "<li>Nenhum produto encontrado.</li>";
    return;
  }

  const autoExpand = Boolean(q);

  const renderStockItem = (p) => {
    const status = getStockStatus(p);
    const expiryMeta = getProductExpiryMeta(p);
    let expiryLine = "Validade: não controlada";
    if (p.hasExpiry && expiryMeta) {
      expiryLine = expiryMeta.daysLeft < 0
        ? `Validade: vencido em ${expiryMeta.dateBr}`
        : `Validade: ${expiryMeta.dateBr} (${expiryMeta.daysLeft}d)`;
    } else if (p.hasExpiry) {
      expiryLine = "Validade: não informada";
    }
    const selected = stockBulkPriceSelection.has(p.id);
    return `<li class="stock-list-item stock-list-item--${status.key}${selected ? " stock-list-item--selected" : ""}" data-product-id="${p.id}">
      <input type="checkbox" class="stock-bulk-select" data-product-id="${p.id}" ${selected ? "checked" : ""} aria-label="Selecionar ${escapeHtml(p.name)}" />
      <div class="stock-list-item-body" onclick="selectStockProduct('${p.id}')">
        ${productThumb(p, 36)}
        <span class="stock-list-item-name">${p.name} (${p.code})</span>
      </div>
      <div class="stock-list-item-meta">
        <strong>Qtd: ${formatStockQty(p)}</strong>
        <small>Preço: ${money(p.price)}</small>
        <small>Status: ${renderStockStatusBadge(p)}</small>
        <small>${expiryLine}</small>
      </div>
    </li>`;
  };

  const renderStockCategoryBranch = (node, products, depth, autoExpand) => {
    const direct = sortProductsByStockPriority(getProductsInCategoryDirect(node.id, products));
    const childHtml = (node.children || [])
      .map((child) => renderStockCategoryBranch(child, products, depth + 1, autoExpand))
      .join("");
    if (!direct.length && !childHtml) return "";

    const expanded = isCategoryExpanded("stock", node.id, autoExpand);
    const subtreeProducts = getProductsInCategorySubtree(node.id, products);
    const alertCount = getCategoryAlertCount(subtreeProducts);
    const encodedId = encodeURIComponent(node.id);
    const header = `<li class="stock-category-row ${expanded ? "expanded" : "collapsed"}"
      data-category-view="stock"
      data-category-id="${encodedId}"
      style="--cat-depth:${depth}"
      onclick="toggleCategoryFromEl(this)">
      <div class="category-row-head">
        <span class="stock-category-title">${escapeHtml(node.name)}</span>
        <span class="category-row-meta">
          ${subtreeProducts.length} ${subtreeProducts.length === 1 ? "produto" : "produtos"}
          ${alertCount ? `<span class="category-alert-badge">${alertCount} em alerta</span>` : ""}
        </span>
      </div>
    </li>`;
    return header + (expanded ? `${direct.map(renderStockItem).join("")}${childHtml}` : "");
  };

  const renderUncategorizedStockRows = (products, autoExpand) => {
    const uncategorized = sortProductsByStockPriority(products.filter((p) => !resolveProductCategoryId(p)));
    if (!uncategorized.length) return "";
    const expanded = isCategoryExpanded("stock", UNCATEGORIZED_CATEGORY_KEY, autoExpand);
    const alertCount = getCategoryAlertCount(uncategorized);
    const header = `<li class="stock-category-row ${expanded ? "expanded" : "collapsed"}"
      data-category-view="stock"
      data-category-id="${UNCATEGORIZED_CATEGORY_KEY}"
      onclick="toggleCategoryFromEl(this)">
      <div class="category-row-head">
        <span class="stock-category-title">Sem categoria</span>
        <span class="category-row-meta">
          ${uncategorized.length} ${uncategorized.length === 1 ? "produto" : "produtos"}
          ${alertCount ? `<span class="category-alert-badge">${alertCount} em alerta</span>` : ""}
        </span>
      </div>
    </li>`;
    return header + (expanded ? uncategorized.map(renderStockItem).join("") : "");
  };

  const tree = buildCategoryTree();
  let html = tree.map((node) => renderStockCategoryBranch(node, filtered, 0, autoExpand)).join("");
  html += renderUncategorizedStockRows(filtered, autoExpand);
  stockBulkSelectionRendering = true;
  list.innerHTML = html || "<li>Nenhum produto encontrado.</li>";
  stockBulkSelectionRendering = false;
  updateStockBulkSelectionUI();
}

window.selectStockProduct = (id) => {
  document.getElementById("stockProductId").value = id;
  document.getElementById("stockQty").focus();
};

// ═══════════════════════════════════════════════════════════════
// PDV — busca e resultados
// ═══════════════════════════════════════════════════════════════
function setupPDV() {
  document.querySelectorAll('input[name="payMethod"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const sel = document.getElementById("paymentMethod");
      if (sel) sel.value = radio.value;
      const { total } = buildSaleItems();
      updateSplitPaymentUI(total);
    });
  });

  document.getElementById("splitPaymentToggle")?.addEventListener("change", (e) => {
    const { total } = state.cart.length ? buildSaleItems() : { total: 0 };
    if (e.target.checked) {
      state.splitPayments = [
        { method: getSelectedSinglePaymentMethod(), amount: total },
        { method: "Pix", amount: 0 }
      ];
      updateSplitPaymentUI(total, { forceRender: true });
    } else {
      state.splitPayments = [];
      updateSplitPaymentUI(total);
    }
  });

  document.getElementById("btnAddSplitPayment")?.addEventListener("click", () => {
    const { total } = buildSaleItems();
    syncSplitPaymentsFromDOM();
    state.splitPayments.push({ method: "Pix", amount: 0 });
    updateSplitPaymentUI(total, { forceRender: true });
  });

  const searchInput = document.getElementById("pdvSearch");
  const dropdown = document.getElementById("pdvSearchResults");

  if (searchInput && dropdown) {
  searchInput.addEventListener("input", (e) => {
    const q = e.target.value.trim();
    resetPDVSearchHighlight();
    if (q.length === 0) {
      dropdown.classList.remove("open");
      dropdown.innerHTML = "";
      return;
    }
    renderPDVSearch(q);
  });

  searchInput.addEventListener("focus", () => {
    const q = searchInput.value.trim();
    if (q.length && getPDVSearchResultItems().length) {
      dropdown.classList.add("open");
    }
  });

  if (!window.__pdvSearchKeyboardBound) {
    window.__pdvSearchKeyboardBound = true;
    document.addEventListener("keydown", (e) => {
      if (!isPDVSearchNavKey(e)) return;
      const pdvTab = document.getElementById("pdvTab");
      if (!pdvTab?.classList.contains("active")) return;
      const activeSearch = document.getElementById("pdvSearch");
      if (!activeSearch || document.activeElement !== activeSearch) return;
      handlePDVSearchKeyboard(e);
    }, true);
  }

  searchInput.addEventListener("keydown", (e) => {
    if (isPDVSearchNavKey(e)) return;

    if (handlePDVSearchKeyboard(e)) return;

    if (e.key === "Enter") {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (query.length >= 1) {
        const normalizedCode = normalizeCode(query);
        const exact = state.products.find((p) => normalizeCode(p.code) === normalizedCode);
        if (exact) {
          handleBarcodeScan(exact.code || query);
          searchInput.value = "";
          dropdown.classList.remove("open");
          dropdown.innerHTML = "";
          return;
        }
        const matches = getPDVSearchMatches(query);
        if (matches.length === 1) {
          const product = matches[0];
          addToCart(product.id, "retail");
          flashCartFeedback(product.name, "retail");
          showScanFeedback(product, "retail");
          searchInput.value = "";
          dropdown.classList.remove("open");
          dropdown.innerHTML = "";
        }
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pdv-search-wrap")) {
      dropdown.classList.remove("open");
    }
  });
  }

  const discInput = document.getElementById("discountValue");
  discInput.addEventListener("input", () => {
    state.discountValue = parseFloat(discInput.value) || 0;
    renderCart();
  });

  document.getElementById("cashAmountPaid").addEventListener("input", () => {
    const { total } = buildSaleItems();
    updateCashChangePreview(total);
  });

  document.getElementById("discountTypeR").addEventListener("click", () => {
    state.discountType = "R$";
    document.getElementById("discountTypeR").classList.add("active");
    document.getElementById("discountTypeP").classList.remove("active");
    renderCart();
  });
  document.getElementById("discountTypeP").addEventListener("click", () => {
    state.discountType = "%";
    document.getElementById("discountTypeP").classList.add("active");
    document.getElementById("discountTypeR").classList.remove("active");
    renderCart();
  });

  document.getElementById("btnFinalizeSale").addEventListener("click", () => finalizeSale());
  document.getElementById("btnFinalizeOnCredit")?.addEventListener("click", finalizeSaleOnCredit);

  document.getElementById("btnPrintReceipt")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("btnPrintReceipt");
    if (btn?.disabled) {
      showPrintToast("Aguarde a impressão anterior…", true);
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await window.printCurrentCartReceipt();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ── Botão Varejo global no carrinho ──────────
  document.getElementById("btnSetAllRetail").addEventListener("click", () => {
    state.cart.forEach((item) => { item.priceType = "retail"; });
    document.getElementById("btnSetAllRetail").classList.add("active");
    renderCart();
  });

  updateSplitPaymentUI(0);
  setupPDVShortcuts();
}

function calcDiscountFrom(subtotal, discountValue, discountType) {
  const value = Number(discountValue || 0);
  if (!value || value <= 0) return 0;
  if (discountType === "%") {
    return Math.min(subtotal, subtotal * (value / 100));
  }
  return Math.min(subtotal, value);
}

function calcDiscount(subtotal) {
  return calcDiscountFrom(subtotal, state.discountValue, state.discountType);
}

function buildSaleItems() {
  const items = state.cart.map((item) => {
    const p = state.products.find((x) => x.id === item.productId);
    const price = getCartItemPrice(p, item.priceType);
    return {
      name: p ? getProductLabel(p) : "Produto",
      code: p?.code || "",
      category: p ? getProductCategory(p) : "",
      price,
      priceType: item.priceType,
      cost: Number(p?.cost || 0),
      qty: item.qty,
      subtotal: price * item.qty,
      productId: item.productId
    };
  });
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const discount = calcDiscount(subtotal);
  const total = Math.max(0, subtotal - discount);
  return { items, subtotal, discount, total };
}

function productThumb(p, size = 38) {
  if (p.photo) {
    return `<img src="${p.photo}" alt="${p.name}" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:6px;flex-shrink:0;border:1px solid var(--border);" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
            <div style="display:none;width:${size}px;height:${size}px;background:var(--bg4);border-radius:6px;flex-shrink:0;align-items:center;justify-content:center;font-size:${Math.round(size*0.28)}px;">📦</div>`;
  }
  return `<div style="width:${size}px;height:${size}px;background:var(--bg4);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.28)}px;border:1px solid var(--border);">📦</div>`;
}

function renderPDVSearch(term = "") {
  const q = normalizeSearch(term);
  const dropdown = document.getElementById("pdvSearchResults");
  if (!q) { dropdown.classList.remove("open"); dropdown.innerHTML = ""; return; }

  const products = getPDVSearchMatches(term);

  if (!products.length) {
    pdvSearchHighlightIndex = -1;
    const insumos = getPDVMlInsumoSearchMatches(term);
    if (insumos.length) {
      const label = insumos.length === 1 ? insumos[0].name : `${insumos.length} insumos (ml)`;
      dropdown.innerHTML = `<li class="pdv-search-insumo-hint" style="cursor:default;padding:12px;line-height:1.5;">
        <strong>${escapeHtml(label)}</strong> — insumo (garrafa aberta), não vende no caixa.<br>
        <span style="color:var(--muted);">Cadastre um produto «Dose/combo» com esse insumo para vender.</span>
      </li>`;
    } else {
      dropdown.innerHTML = `<li style="color:var(--muted);cursor:default;justify-content:center;">Nenhum produto encontrado</li>`;
    }
    dropdown.classList.add("open");
    return;
  }

  dropdown.innerHTML = products.map((p) => `
    <li class="pdv-search-item" data-product-id="${p.id}">
      ${productThumb(p, 40)}
      <div class="product-info">
        <span class="product-name">${p.name}</span>
        <span class="product-meta">Cód: ${p.code} · Cat: ${getProductCategory(p)} · Estq: ${formatStockQty(p)} · ${money(p.price)} · ${renderStockStatusBadge(p)}</span>
      </div>
      <div class="product-btns">
        <button class="btn-add-retail" onclick="addToCartFromSearch('${p.id}')" ${getMaxCartQty(p.id) <= 0 ? "disabled" : ""}>+ Adicionar</button>
      </div>
    </li>`).join("");
  dropdown.classList.add("open");
  if (pdvSearchHighlightIndex >= products.length) {
    pdvSearchHighlightIndex = products.length - 1;
  }
  updatePDVSearchHighlight();
}

function productMatchesPDVSearch(product, term = "") {
  const q = normalizeSearch(term);
  const qCompact = compactSearch(term);
  if (!q || !product) return false;
  const name = normalizeSearch(product.name);
  const nameCompact = compactSearch(product.name);
  const code = compactSearch(product.code);
  return (
    name.includes(q) ||
    name.startsWith(q) ||
    nameCompact.includes(qCompact) ||
    code.includes(qCompact)
  );
}

function getPDVSearchMatches(term = "") {
  if (!normalizeSearch(term)) return [];
  return state.products.filter((p) => !isMlStockProduct(p) && productMatchesPDVSearch(p, term));
}

function getPDVMlInsumoSearchMatches(term = "") {
  if (!normalizeSearch(term)) return [];
  return state.products.filter((p) => isMlStockProduct(p) && productMatchesPDVSearch(p, term));
}

function getPDVSearchResultItems() {
  const dropdown = document.getElementById("pdvSearchResults");
  if (!dropdown) return [];
  return [...dropdown.querySelectorAll("li.pdv-search-item[data-product-id]")];
}

function updatePDVSearchHighlight(items = getPDVSearchResultItems()) {
  items.forEach((li, index) => {
    li.classList.toggle("is-highlighted", index === pdvSearchHighlightIndex);
    if (index === pdvSearchHighlightIndex) {
      li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}

function resetPDVSearchHighlight() {
  pdvSearchHighlightIndex = -1;
  getPDVSearchResultItems().forEach((li) => li.classList.remove("is-highlighted"));
}

function isPDVSearchNavKey(e) {
  return e.key === "ArrowDown" || e.key === "ArrowUp"
    || e.key === "Down" || e.key === "Up"
    || e.keyCode === 40 || e.keyCode === 38;
}

function ensurePDVSearchResultItems(term = "") {
  const searchInput = document.getElementById("pdvSearch");
  const query = String(term || searchInput?.value || "").trim();
  if (!query) return [];

  let items = getPDVSearchResultItems();
  if (items.length >= 2) return items;

  const matches = getPDVSearchMatches(query);
  if (matches.length < 2) return items;

  renderPDVSearch(query);
  items = getPDVSearchResultItems();
  return items.length >= 2 ? items : [];
}

function handlePDVSearchKeyboard(e) {
  const searchInput = document.getElementById("pdvSearch");
  if (!searchInput || document.activeElement !== searchInput) return false;

  const term = searchInput.value.trim();
  if (!term) return false;

  const isDown = e.key === "ArrowDown" || e.key === "Down" || e.keyCode === 40;
  const isUp = e.key === "ArrowUp" || e.key === "Up" || e.keyCode === 38;
  const isEnter = e.key === "Enter";

  if (!isDown && !isUp && !(isEnter && pdvSearchHighlightIndex >= 0)) return false;

  const items = ensurePDVSearchResultItems(term);
  if (items.length < 2) return false;

  const dropdown = document.getElementById("pdvSearchResults");
  if (dropdown && !dropdown.classList.contains("open")) {
    dropdown.classList.add("open");
  }

  if (isDown) {
    e.preventDefault();
    e.stopPropagation();
    pdvSearchHighlightIndex = pdvSearchHighlightIndex < 0
      ? 0
      : Math.min(pdvSearchHighlightIndex + 1, items.length - 1);
    updatePDVSearchHighlight(items);
    return true;
  }

  if (isUp) {
    e.preventDefault();
    e.stopPropagation();
    pdvSearchHighlightIndex = pdvSearchHighlightIndex < 0
      ? items.length - 1
      : Math.max(pdvSearchHighlightIndex - 1, 0);
    updatePDVSearchHighlight(items);
    return true;
  }

  if (isEnter && pdvSearchHighlightIndex >= 0 && items[pdvSearchHighlightIndex]) {
    e.preventDefault();
    e.stopPropagation();
    addToCartFromSearch(items[pdvSearchHighlightIndex].dataset.productId);
    return true;
  }

  return false;
}

window.addToCartFromSearch = (productId) => {
  addToCart(productId, "retail");
  const p = state.products.find((x) => x.id === productId);
  if (p) {
    flashCartFeedback(p.name, "retail");
    showScanFeedback(p, "retail");
  }
  document.getElementById("pdvSearch").value = "";
  resetPDVSearchHighlight();
  document.getElementById("pdvSearchResults").classList.remove("open");
  document.getElementById("pdvSearchResults").innerHTML = "";
};

// ═══════════════════════════════════════════════════════════════
// LEITOR DE CÓDIGO DE BARRAS
// ═══════════════════════════════════════════════════════════════
function setupBarcodeListener() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const focused = document.activeElement;
    const tag = focused?.tagName;
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if (focused?.id === "productCode") {
      if (e.key === "Enter") e.preventDefault();
      return;
    }

    if (isProductsTabActive()) {
      const inOtherProductField = focused?.closest("#productForm") && focused?.id !== "productCode";
      if (!inOtherProductField && !isTextInput) {
        if (captureBarcodeKeydown(e, applyBarcodeToProductCode)) return;
      }
    }

    const pdvTab = document.getElementById("pdvTab");
    if (!pdvTab?.classList.contains("active")) return;

    if (isTextInput) {
      if (handlePDVQtyKeyboard(e)) return;
      return;
    }

    if (handlePDVQtyKeyboard(e)) return;

    if (e.key === "Enter") {
      const code = _barcodeBuffer.trim();
      _barcodeBuffer = "";
      clearTimeout(_barcodeTimer);
      if (code.length >= 3) {
        handleBarcodeScan(code);
        return;
      }
      if (state.cart.length > 0) {
        const confirmFinalize = confirm("Deseja finalizar a venda?");
        if (confirmFinalize) finalizeSale();
      }
      return;
    }

    if (e.key.length === 1) {
      captureBarcodeKeydown(e, handleBarcodeScan);
    }
  });
}

function handleBarcodeScan(code) {
  const normalizedCode = normalizeCode(code);
  const product = state.products.find(
    (p) => normalizeCode(p.code) === normalizedCode
  );

  if (!product) {
    const searchInput = document.getElementById("pdvSearch");
    if (searchInput) {
      searchInput.value = code;
      renderPDVSearch(code);
    }
    return;
  }

  if (getMaxCartQty(product.id) <= 0) {
    alert(`Produto "${getProductLabel(product)}" sem estoque.`);
    return;
  }

  addToCart(product.id, "retail");
  showScanFeedback(product, "retail");
}

function buildScanQtyControlsHtml(productId, priceType, qty, maxQty) {
  const safeMax = Math.max(1, Number(maxQty) || 1);
  const safeQty = Math.min(safeMax, Math.max(1, Number(qty) || 1));
  return `
    <button type="button" class="btn-ctrl scan-ctrl" aria-label="Diminuir quantidade"
      onclick="changeCartQty('${productId}','${priceType}',-1)">−</button>
    <input type="number" class="scan-qty-input" min="1" max="${safeMax}" value="${safeQty}"
      inputmode="numeric" aria-label="Quantidade"
      onclick="event.stopPropagation(); this.select();"
      onfocus="this.select()"
      onchange="setCartQty('${productId}','${priceType}', this.value)"
      onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" />
    <button type="button" class="btn-ctrl scan-ctrl" aria-label="Aumentar quantidade"
      onclick="changeCartQty('${productId}','${priceType}',1)">+</button>`;
}

function updateScanLastQtyControls(productId, priceType) {
  const wrap = document.getElementById("scanLastQtyWrap");
  const product = state.products.find((p) => p.id === productId);
  const item = state.cart.find((i) => i.productId === productId && i.priceType === priceType);
  if (!wrap || !product || !item) {
    if (wrap) wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = buildScanQtyControlsHtml(productId, priceType, item.qty, getMaxCartQty(productId, priceType));
}

function updateScanAreaVisibility() {
  const idleEl = document.getElementById("scanIdle");
  const lastEl = document.getElementById("scanLast");
  const panel = document.getElementById("scanSelectedPanel");
  const hasCart = state.cart.length > 0;

  if (panel) panel.classList.toggle("has-items", hasCart);

  if (hasCart) {
    if (idleEl) idleEl.style.display = "none";
    if (lastEl && window._lastScanItem) {
      const { productId, priceType } = window._lastScanItem;
      const product = state.products.find((p) => p.id === productId);
      const item = state.cart.find((i) => i.productId === productId && i.priceType === priceType);
      if (product && item) {
        lastEl.style.display = "flex";
        const metaEl = document.getElementById("scanLastMeta");
        if (metaEl) {
          const unit = getCartItemPrice(product, priceType);
          metaEl.textContent = `${money(unit)} · ${money(unit * item.qty)}`;
        }
        updateScanLastQtyControls(productId, priceType);
      } else {
        lastEl.style.display = "none";
      }
    }
  } else {
    window._lastScanItem = null;
    if (lastEl) lastEl.style.display = "none";
    if (idleEl) idleEl.style.display = "flex";
  }
}

function showScanFeedback(product, priceType) {
  const idleEl = document.getElementById("scanIdle");
  const lastEl = document.getElementById("scanLast");
  const nameEl = document.getElementById("scanLastName");
  const metaEl = document.getElementById("scanLastMeta");
  if (!lastEl) return;

  window._lastScanItem = { productId: product.id, priceType };
  const cartItem = state.cart.find((i) => i.productId === product.id && i.priceType === priceType);
  const qty = cartItem?.qty || 1;
  const price = getCartItemPrice(product, priceType);

  let imgEl = document.getElementById("scanLastImg");
  if (!imgEl) {
    imgEl = document.createElement("div");
    imgEl.id = "scanLastImg";
    lastEl.insertBefore(imgEl, lastEl.firstChild);
  }
  imgEl.innerHTML = productThumb(product, 80);
  imgEl.style.cssText = "display:flex;align-items:center;justify-content:center;margin-bottom:4px;";

  nameEl.textContent = getProductLabel(product);
  metaEl.textContent = `${money(price)} · ${money(price * qty)}`;
  updateScanLastQtyControls(product.id, priceType);
  idleEl.style.display = "none";
  lastEl.style.display = "flex";
  updateScanAreaVisibility();

  clearTimeout(window._scanFeedbackTimer);
  window._scanFeedbackTimer = null;
}

function openPriceModal(product) {
  const modal = document.getElementById("priceModal");
  document.getElementById("modalProductName").textContent = product.name;
  document.getElementById("modalRetailPrice").textContent = money(product.price);
  document.getElementById("modalWholesalePrice").textContent = money(product.priceWholesale);

  let imgWrap = document.getElementById("modalProductImg");
  if (!imgWrap) {
    imgWrap = document.createElement("div");
    imgWrap.id = "modalProductImg";
    imgWrap.style.cssText = "display:flex;justify-content:center;margin:4px 0 8px;";
    const titleEl = document.getElementById("modalProductName");
    titleEl.parentNode.insertBefore(imgWrap, titleEl);
  }
  imgWrap.innerHTML = productThumb(product, 72);

  const btnWholesale = document.getElementById("modalBtnWholesale");
  btnWholesale.disabled = !product.priceWholesale;

  modal.classList.remove("hidden");

  const onRetail = () => {
    addToCart(product.id, "retail");
    flashCartFeedback(product.name, "retail");
    showScanFeedback(product, "retail");
    closeModal();
  };
  const onWholesale = () => {
    addToCart(product.id, "wholesale");
    flashCartFeedback(product.name, "wholesale");
    showScanFeedback(product, "wholesale");
    closeModal();
  };
  const onCancel = () => closeModal();
  const onOverlay = (e) => { if (e.target === modal) closeModal(); };

  document.getElementById("modalBtnRetail").onclick = onRetail;
  document.getElementById("modalBtnWholesale").onclick = onWholesale;
  document.getElementById("modalBtnCancel").onclick = onCancel;
  modal.onclick = onOverlay;

  function closeModal() {
    modal.classList.add("hidden");
    modal.onclick = null;
    setTimeout(() => document.getElementById("pdvSearch")?.focus(), 50);
  }
}

function flashCartFeedback(productName, priceType) {
  const cartHeader = document.querySelector(".cart-header");
  if (!cartHeader) return;
  const flash = document.createElement("div");
  flash.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:#00e676; color:#0a0c10;
    padding:10px 24px; border-radius:8px;
    font-family:var(--font-head); font-size:14px; font-weight:700;
    letter-spacing:1px; z-index:9999;
    animation: flashIn 0.2s ease, flashOut 0.3s ease 1.2s forwards;
    box-shadow: 0 4px 20px rgba(0,230,118,0.4);
  `;
  flash.textContent = `✓ ${productName} adicionado`;
  if (!document.getElementById("flashKeyframes")) {
    const style = document.createElement("style");
    style.id = "flashKeyframes";
    style.textContent = `
      @keyframes flashIn { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
      @keyframes flashOut { to { opacity:0; transform:translateX(-50%) translateY(10px); } }
    `;
    document.head.appendChild(style);
  }
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 1600);
}

window.addToCart = (productId, priceType = "retail") => {
  const product = state.products.find((p) => p.id === productId);
  const maxQty = getMaxCartQty(productId, priceType);
  if (!product || maxQty <= 0) {
    if (product && isMlStockProduct(product)) {
      alert("Este produto é insumo (ml). Venda pela dose/combo vinculada.");
    }
    return;
  }
  const cartItem = state.cart.find((i) => i.productId === productId && i.priceType === priceType);
  if (cartItem) {
    if (cartItem.qty + 1 > maxQty) { alert("Estoque insuficiente."); return; }
    cartItem.qty += 1;
  } else {
    state.cart.push({ productId, qty: 1, priceType });
  }
  renderCart();
};

function getCartItemPrice(product, priceType) {
  if (!product) return 0;
  return Number(product.price || 0);
}

function renderScanSelectedItems() {
  const list = document.getElementById("scanSelectedList");
  if (!list) return;
  if (!state.cart.length) {
    list.innerHTML = `<li class="scan-selected-empty">Bipe ou busque um produto para começar.</li>`;
    return;
  }
  list.innerHTML = state.cart.map((item) => {
    const product = state.products.find((p) => p.id === item.productId);
    if (!product) return "";
    const unitPrice = getCartItemPrice(product, item.priceType);
    return `<li class="scan-selected-item">
      <div class="scan-selected-item-main">
        ${productThumb(product, 36)}
        <div class="scan-selected-info">
          <span class="scan-selected-name">${product.name}</span>
          <span class="scan-selected-unit">${money(unitPrice)} un.</span>
        </div>
      </div>
      <div class="scan-selected-actions">
        <span class="scan-selected-total">${money(unitPrice * item.qty)}</span>
        <div class="scan-qty-controls">
          ${buildScanQtyControlsHtml(product.id, item.priceType, item.qty, getMaxCartQty(product.id, item.priceType))}
        </div>
      </div>
    </li>`;
  }).join("");
}

function renderCart() {
  const list = document.getElementById("cartList");
  const emptyEl = document.getElementById("cartEmpty");
  const countEl = document.getElementById("cartCount");
  const toggleBar = document.getElementById("cartPriceToggle");

  if (state.cart.length === 0) {
    list.innerHTML = "";
    if (emptyEl) emptyEl.classList.add("visible");
    if (countEl) countEl.textContent = "0 itens";
    if (toggleBar) toggleBar.style.display = "none";
  } else {
    if (emptyEl) emptyEl.classList.remove("visible");
    if (toggleBar) toggleBar.style.display = "flex";
    if (countEl) {
      const total = state.cart.reduce((s, i) => s + i.qty, 0);
      countEl.textContent = `${total} ${total === 1 ? "item" : "itens"}`;
    }
    list.innerHTML = state.cart.map((item) => {
      const product = state.products.find((p) => p.id === item.productId);
      if (!product) return "";
      const unitPrice = getCartItemPrice(product, item.priceType);
      return `<li>
        ${productThumb(product, 42)}
        <div class="cart-item-info">
          <span class="cart-item-name">${product.name}</span>
          <span class="cart-item-sub">${money(unitPrice)} × ${item.qty}</span>
        </div>
        <span class="cart-item-total">${money(unitPrice * item.qty)}</span>
        <div class="cart-item-controls">
          <button class="btn-ctrl" onclick="changeCartQty('${product.id}','${item.priceType}',-1)">−</button>
          <button class="btn-ctrl" onclick="changeCartQty('${product.id}','${item.priceType}',1)">+</button>
          <button class="btn-ctrl rm" onclick="removeFromCart('${product.id}','${item.priceType}')">×</button>
        </div>
      </li>`;
    }).join("");
  }

  if (state.cart.length > 0) {
    const btnRetail = document.getElementById("btnSetAllRetail");
    if (btnRetail) btnRetail.classList.add("active");
  }

  const subtotal = state.cart.reduce((sum, item) => {
    const p = state.products.find((x) => x.id === item.productId);
    return sum + (p ? getCartItemPrice(p, item.priceType) * item.qty : 0);
  }, 0);
  const discount = calcDiscount(subtotal);
  const total = Math.max(0, subtotal - discount);

  const subtotalEl = document.getElementById("cartSubtotal");
  const totalEl = document.getElementById("cartTotal");
  const discInput = document.getElementById("discountValue");

  if (subtotalEl) subtotalEl.textContent = money(subtotal);
  if (totalEl) totalEl.textContent = money(total);
  if (discInput) discInput.classList.toggle("discount-applied", discount > 0);
  updateSplitPaymentUI(total);
  updateCashChangePreview(total);
  renderScanSelectedItems();
  updateScanAreaVisibility();
}

window.changeCartQty = (productId, priceType, diff) => {
  const product = state.products.find((p) => p.id === productId);
  const item = state.cart.find((i) => i.productId === productId && i.priceType === priceType);
  if (!product || !item) return;
  const next = item.qty + diff;
  const maxQty = getMaxCartQty(productId, priceType);
  if (next <= 0) state.cart = state.cart.filter((i) => !(i.productId === productId && i.priceType === priceType));
  else if (next > maxQty) alert("Estoque insuficiente.");
  else item.qty = next;
  renderCart();
};

window.setCartQty = (productId, priceType, rawQty) => {
  const product = state.products.find((p) => p.id === productId);
  const item = state.cart.find((i) => i.productId === productId && i.priceType === priceType);
  if (!product || !item) return;

  const parsed = Math.floor(Number(String(rawQty).replace(",", ".")));
  const maxQty = getMaxCartQty(productId, priceType);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    state.cart = state.cart.filter((i) => !(i.productId === productId && i.priceType === priceType));
    renderCart();
    return;
  }
  if (parsed > maxQty) {
    alert(`Estoque insuficiente. Disponível: ${maxQty}`);
    renderCart();
    return;
  }
  item.qty = parsed;
  renderCart();
};

window.removeFromCart = (productId, priceType) => {
  state.cart = state.cart.filter((i) => !(i.productId === productId && i.priceType === priceType));
  renderCart();
};

async function finalizeSale(forcePaymentMethod = "") {
  if (_finalizeSaleLock) return;
  if (!state.cart.length) { alert("Carrinho vazio."); return; }
  if (!assertCashOpenForSale()) return;
  _finalizeSaleLock = true;
  const finalizeBtn = document.getElementById("btnFinalizeSale");
  const creditBtn = document.getElementById("btnFinalizeOnCredit");
  if (finalizeBtn) finalizeBtn.disabled = true;
  if (creditBtn) creditBtn.disabled = true;
  try {
  const { items, subtotal, discount, total } = buildSaleItems();
  let payments;
  let paymentMethod;
  try {
    ({ payments, paymentMethod } = resolveCheckoutPayments(forcePaymentMethod, total));
  } catch (err) {
    alert(err.message || String(err));
    return;
  }
  const buyer = getBuyerData();
  const isOnCredit = isCreditPaymentMethod(paymentMethod);
  if (isOnCredit && !buyer.name) {
    alert("Para venda a prazo, informe o nome do cliente.");
    document.getElementById("buyerName")?.focus();
    return;
  }
  const pendingCustomerKey = isOnCredit ? getPendingCustomerKey(buyer.name) : "";
  if (isOnCredit && !pendingCustomerKey) {
    alert("Nome do cliente inválido para venda a prazo.");
    return;
  }
  const saleDate = new Date().toISOString();
  const cashDue = getCashPaymentAmountFromSplits(payments);
  const cashAmountPaid = cashDue > 0 ? getCashAmountPaid() : 0;
  const cashChange = cashDue > 0 ? (cashAmountPaid - cashDue) : 0;
  if (cashDue > 0 && cashAmountPaid < cashDue) {
    alert(`Valor em dinheiro insuficiente. Falta ${money(cashDue - cashAmountPaid)}.`);
    return;
  }
  const orderNumber = (state.sales.length || 0) + 1;
  const operator = getOperatorInfo();
  const activeRegister = getActiveRegister();
  const sale = {
    createdAt: saleDate,
    paymentMethod,
    payments,
    buyer,
    subtotal,
    discount,
    total,
    items,
    cashAmountPaid,
    cashChange,
    orderNumber,
    orderType: "BALCÃO",
    pendingStatus: isOnCredit ? "pending" : "paid",
    pendingCustomerKey: isOnCredit ? pendingCustomerKey : "",
    pendingAmount: isOnCredit ? total : 0,
    cashSessionId: state.cashSession?.id || "",
    registerId: activeRegister?.id || "",
    registerName: activeRegister?.name || "",
    operatorId: operator.id || "",
    operatorName: operator.name || ""
  };
  const soldProductIds = [...resolveStockDeductionsFromSaleItems(items).keys()];
  const saleId = uid();
    const storeRef = getStoreRef();
    const stockDeductions = resolveStockDeductionsFromSaleItems(items);
    await db.runTransaction(async (tx) => {
      let accountRef = null;
      let prevAccount = null;
      if (isOnCredit) {
        accountRef = storeRef.collection("pendingAccounts").doc(pendingCustomerKey);
        const accountSnap = await tx.get(accountRef);
        prevAccount = accountSnap.exists ? (accountSnap.data() || {}) : {};
      }

      const stockChecks = [];
      for (const [deductProductId, deductQty] of stockDeductions) {
        const ref = storeRef.collection("products").doc(deductProductId);
        const snap = await tx.get(ref);
        if (!snap.exists) {
          throw new Error(`Produto de estoque não encontrado: ${deductProductId}`);
        }
        const data = snap.data() || {};
        const currentQty = Number(data.qty || 0);
        if (currentQty < deductQty) {
          const label = state.products.find((p) => p.id === deductProductId)?.name || deductProductId;
          const unitLabel = isMlStockProduct(data) ? formatMlQty(currentQty) : currentQty;
          const needLabel = isMlStockProduct(data) ? formatMlQty(deductQty) : deductQty;
          throw new Error(`Estoque insuficiente para "${label}". Disponível: ${unitLabel}, necessário: ${needLabel}`);
        }
        stockChecks.push({ ref, nextQty: currentQty - deductQty, productId: deductProductId });
      }

      stockChecks.forEach((check) => {
        tx.update(check.ref, { qty: check.nextQty });
      });
      const saleRef = storeRef.collection("sales").doc(saleId);
      tx.set(saleRef, sale);
      if (isOnCredit) {
        const prev = prevAccount || {};
        const nextSaleIds = Array.isArray(prev.saleIds) ? [...new Set([...prev.saleIds, saleId])] : [saleId];
        tx.set(accountRef, {
          customerKey: pendingCustomerKey,
          customerName: getPendingCustomerName(buyer.name),
          phone: buyer.phone || prev.phone || "",
          document: buyer.document || prev.document || "",
          totalPending: Number(prev.totalPending || 0) + total,
          totalPaid: Number(prev.totalPaid || 0),
          status: "pending",
          saleIds: nextSaleIds,
          updatedAt: saleDate
        }, { merge: true });
      }
    });
    state.cart = [];
    state.discountValue = 0;
    state.discountType = "R$";
    clearBuyerFields();
    resetPaymentUI();
    const discInput = document.getElementById("discountValue");
    if (discInput) discInput.value = "";
    document.getElementById("discountTypeR")?.classList.add("active");
    document.getElementById("discountTypeP")?.classList.remove("active");
    document.getElementById("btnSetAllRetail")?.classList.add("active");
    window._lastScanItem = null;
    const idleEl = document.getElementById("scanIdle");
    const lastEl = document.getElementById("scanLast");
    if (idleEl) idleEl.style.display = "flex";
    if (lastEl) lastEl.style.display = "none";
    updateScanAreaVisibility();
    stockDeductions.forEach((deductQty, productId) => {
      const p = state.products.find((x) => x.id === productId);
      if (p) p.qty = Math.max(0, Number(p.qty || 0) - deductQty);
    });
    state.sales = [{ id: saleId, ...sale }, ...state.sales];
    if (isOnCredit) {
      const existingIdx = state.pendingAccounts.findIndex((a) => a.customerKey === pendingCustomerKey || a.id === pendingCustomerKey);
      if (existingIdx >= 0) {
        const account = state.pendingAccounts[existingIdx];
        account.totalPending = Number(account.totalPending || 0) + total;
        account.status = "pending";
        account.customerName = getPendingCustomerName(buyer.name);
        account.phone = buyer.phone || account.phone || "";
        account.document = buyer.document || account.document || "";
        const nextSaleIds = new Set([...(account.saleIds || []), saleId]);
        account.saleIds = [...nextSaleIds];
        account.updatedAt = saleDate;
      } else {
        state.pendingAccounts.push({
          id: pendingCustomerKey,
          customerKey: pendingCustomerKey,
          customerName: getPendingCustomerName(buyer.name),
          phone: buyer.phone || "",
          document: buyer.document || "",
          totalPending: total,
          totalPaid: 0,
          status: "pending",
          saleIds: [saleId],
          updatedAt: saleDate
        });
      }
    }
    renderAll();
    updatePdvCashUI();
    await autoPrintSaleReceipt(saleId, items, total, paymentMethod, buyer, saleDate, cashAmountPaid, Math.max(0, cashChange), {
      subtotal,
      discount,
      saleId,
      orderNumber,
      registerName: activeRegister?.name || "",
      payments
    });
    const productsOnAlert = state.products.filter((product) => soldProductIds.includes(product.id) && getStockStatus(product).key !== "normal");
    if (productsOnAlert.length) {
      const alertMessage = productsOnAlert
        .map((product) => `- ${getProductLabel(product)}: ${getStockStatus(product).label} (${formatStockQty(product)} | Mín: ${isMlStockProduct(product) ? formatMlQty(getMinStock(product)) : getMinStock(product)})`)
        .join("\n");
      alert(`Atenção ao estoque:\n${alertMessage}`);
    }
  } catch (error) {
    alert(formatFinalizeSaleError(error));
  } finally {
    _finalizeSaleLock = false;
    if (finalizeBtn) finalizeBtn.disabled = false;
    if (creditBtn) creditBtn.disabled = false;
  }
}

async function finalizeSaleOnCredit() {
  await finalizeSale("A Prazo");
}

function calcSaleProfit(sale) {
  return sale.items?.reduce((sum, i) => sum + (Number(i.price) - Number(i.cost)) * Number(i.qty), 0) || 0;
}

function getReportPrintStyles() {
  return `
    body { font-family: monospace; max-width: 700px; margin: 0 auto; padding: 24px; font-size: 13px; color: #111; }
    h1 { font-size: 18px; margin-bottom: 4px; }
    h2 { font-size: 13px; font-weight: normal; color: #555; margin-bottom: 24px; }
    .summary { display: flex; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
    .s-card { border: 1px solid #ddd; padding: 12px 20px; border-radius: 6px; min-width: 120px; }
    .s-card label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
    .s-card strong { font-size: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 8px 10px; text-align: left; background: #f5f5f5; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #ddd; }
    td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
    tfoot td { font-weight: bold; background: #f9f9f9; border-top: 2px solid #ddd; }
    .items-cell { font-size: 11px; color: #444; max-width: 280px; }
    @media print { body { padding: 0; } }
  `;
}

function openReportPrintWindow(title, bodyHtml) {
  const html = `<html><head><meta charset="utf-8"><title>${title}</title><style>${getReportPrintStyles()}</style></head><body>${bodyHtml}</body></html>`;
  const win = window.open("", "_blank", "width=780,height=650");
  if (!win) { alert("Permita popups para imprimir o relatório."); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

function getReportFilterLabel() {
  const channel = getReportChannelFilter();
  const productId = getReportProductFilter();
  const product = productId ? state.products.find((p) => p.id === productId) : null;
  const channelLabel = channel === REPORT_CHANNEL_BALCAO
    ? "Balcão"
    : channel === REPORT_CHANNEL_DELIVERY
      ? "Delivery"
      : "Todos os canais";
  const productLabel = product ? ` · Produto: ${product.name}` : "";
  return `${channelLabel}${productLabel}`;
}

function printDailyReport() {
  const day = document.getElementById("reportDaySelect")?.value || todayISO();
  const dayLabel = new Date(`${day}T12:00:00`).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  const company = state.company || {};
  const anonymousBuyerLabels = buildAnonymousBuyerLabelMap();
  const productId = getReportProductFilter();
  const channel = getReportChannelFilter();
  const rows = buildReportDayRows(day);
  const agg = calcReportAggregate({ day });

  const cancelledSales = channel === REPORT_CHANNEL_DELIVERY ? [] : state.sales
    .filter((s) => isoMatchesLocalDay(s.createdAt, day) && isSaleCancelled(s))
    .filter((s) => !productId || saleHasProduct(s, productId))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const saleRows = rows.map((entry) => {
    if (entry.kind === "balcao") {
      const sale = entry.sale;
      const time = new Date(sale.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const itemsSummary = (sale.items || []).map((i) => `${i.name} x${i.qty}`).join(", ") || "—";
      return `<tr>
        <td>${time}</td>
        <td>Balcão</td>
        <td>${getSaleBuyerName(sale, anonymousBuyerLabels)}</td>
        <td>${sale.paymentMethod || "—"}</td>
        <td class="items-cell">${itemsSummary}</td>
        <td style="text-align:right">${money(getSaleProductAmount(sale, productId))}</td>
      </tr>`;
    }
    const order = entry.order;
    const time = new Date(entry.sortAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const itemsSummary = (order.items || []).map((i) => `${i.name} x${i.qty}`).join(", ") || "—";
    return `<tr>
      <td>${time}</td>
      <td>Delivery</td>
      <td>${order.customer?.name || "Cliente delivery"}</td>
      <td>${order.paymentMethod || "—"}</td>
      <td class="items-cell">${itemsSummary}</td>
      <td style="text-align:right">${money(getOrderProductAmount(order, productId))}</td>
    </tr>`;
  }).join("");

  const cancelledRows = cancelledSales.map((sale) => {
    const time = new Date(sale.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const cancelTime = sale.cancelledAt
      ? new Date(sale.cancelledAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "—";
    return `<tr style="color:#999">
      <td>${time}</td>
      <td>Balcão</td>
      <td>${getSaleBuyerName(sale, anonymousBuyerLabels)}</td>
      <td>${sale.paymentMethod || "—"}</td>
      <td>Cancelada às ${cancelTime}</td>
      <td style="text-align:right;text-decoration:line-through">${money(getSaleProductAmount(sale, productId))}</td>
    </tr>`;
  }).join("");

  const productStatsHtml = productId ? (() => {
    const stats = calcProductChannelStats(productId, { day });
    return `<p style="font-size:12px;color:#666;margin:8px 0 16px;">
      Produto no dia — Total: ${stats.totalQty} un. (${money(stats.totalRevenue)}) ·
      Balcão: ${stats.balcaoQty} un. (${money(stats.balcaoRevenue)}) ·
      Delivery: ${stats.deliveryQty} un. (${money(stats.deliveryRevenue)})
    </p>`;
  })() : "";

  const bodyHtml = `
    <h1>${company.name || "STOCK PDV"} — Relatório do Dia</h1>
    <h2>${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} &nbsp;·&nbsp; ${getReportFilterLabel()}</h2>
    <p style="font-size:12px;color:#666;">Gerado em ${new Date().toLocaleString("pt-BR")}</p>
    ${productStatsHtml}
    <div class="summary">
      <div class="s-card"><label>Vendas</label><strong>${agg.count}</strong></div>
      <div class="s-card"><label>Total</label><strong>${money(agg.total)}</strong></div>
      <div class="s-card"><label>Balcão</label><strong>${agg.balcaoCount}</strong></div>
      <div class="s-card"><label>Delivery</label><strong>${agg.deliveryCount}</strong></div>
    </div>
    <table>
      <thead>
        <tr><th>Hora</th><th>Canal</th><th>Cliente</th><th>Pagamento</th><th>Itens</th><th>Total</th></tr>
      </thead>
      <tbody>${saleRows || '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">Nenhuma venda neste dia</td></tr>'}</tbody>
      <tfoot>
        <tr>
          <td colspan="5">TOTAL DO DIA</td>
          <td style="text-align:right">${money(agg.total)}</td>
        </tr>
      </tfoot>
    </table>
    ${cancelledSales.length ? `
    <h3 style="margin:24px 0 8px;font-size:14px;">Vendas canceladas (${cancelledSales.length})</h3>
    <table>
      <thead>
        <tr><th>Hora</th><th>Canal</th><th>Cliente</th><th>Pagamento</th><th>Obs.</th><th>Total</th></tr>
      </thead>
      <tbody>${cancelledRows}</tbody>
    </table>` : ""}
    ${buildDailyCashSessionsReportSection(day)}`;

  openReportPrintWindow(`Relatório do Dia — ${day}`, bodyHtml);
}
window.printDailyReport = printDailyReport;

function printMonthlyReport() {
  const sel = document.getElementById("reportMonthSelect");
  const ym = sel?.value;
  if (!ym) return;
  const [yyyy, mm] = ym.split("-");
  const monthLabel = new Date(Number(yyyy), Number(mm) - 1, 1)
    .toLocaleString("pt-BR", { month: "long", year: "numeric" });
  const daysInMonth = new Date(Number(yyyy), Number(mm), 0).getDate();
  const company = state.company || {};
  const productId = getReportProductFilter();

  const byDay = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${ym}-${String(d).padStart(2, "0")}`;
    byDay[key] = { count: 0, total: 0, discount: 0, profit: 0, balcao: 0, delivery: 0 };
  }

  getFilteredBalcaoSales({ month: ym }).forEach((sale) => {
    const day = toLocalDateISO(sale.createdAt);
    if (!day || !byDay[day]) return;
    const amount = getSaleProductAmount(sale, productId);
    if (productId && amount <= 0) return;
    byDay[day].count += 1;
    byDay[day].total += amount;
    byDay[day].discount += productId ? 0 : Number(sale.discount || 0);
    byDay[day].profit += getSaleProductProfit(sale, productId);
    byDay[day].balcao += amount;
  });

  getFilteredDeliveryOrders({ month: ym }).forEach((order) => {
    const day = getDeliveryOrderReportDate(order);
    if (!day || !byDay[day]) return;
    const amount = getOrderProductAmount(order, productId);
    if (productId && amount <= 0) return;
    byDay[day].count += 1;
    byDay[day].total += amount;
    byDay[day].profit += getOrderProductProfit(order, productId);
    byDay[day].delivery += amount;
  });

  const rows = Object.entries(byDay).filter(([, d]) => d.count > 0);
  const totalGeral = rows.reduce((s, [, d]) => s + d.total, 0);
  const discountGeral = rows.reduce((s, [, d]) => s + d.discount, 0);
  const profitGeral = rows.reduce((s, [, d]) => s + d.profit, 0);
  const salesCount = rows.reduce((s, [, d]) => s + d.count, 0);
  const balcaoTotal = rows.reduce((s, [, d]) => s + d.balcao, 0);
  const deliveryTotal = rows.reduce((s, [, d]) => s + d.delivery, 0);

  const tableRows = rows.map(([date, d]) => {
    const dt = new Date(date + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
    const split = getReportChannelFilter() === REPORT_CHANNEL_ALL
      ? `<br><small>Balcão ${money(d.balcao)} · Delivery ${money(d.delivery)}</small>`
      : "";
    return `<tr>
      <td>${dt}</td>
      <td style="text-align:center">${d.count}</td>
      <td style="text-align:right">${money(d.total)}${split}</td>
      <td style="text-align:right">${d.discount > 0 ? "-" + money(d.discount) : "—"}</td>
      <td style="text-align:right">${money(d.profit)}</td>
    </tr>`;
  }).join("");

  const productStatsHtml = productId ? (() => {
    const stats = calcProductChannelStats(productId, { month: ym });
    return `<p style="font-size:12px;color:#666;margin:8px 0 16px;">
      Produto no mês — Total: ${stats.totalQty} un. (${money(stats.totalRevenue)}) ·
      Balcão: ${stats.balcaoQty} un. (${money(stats.balcaoRevenue)}) ·
      Delivery: ${stats.deliveryQty} un. (${money(stats.deliveryRevenue)})
    </p>`;
  })() : "";

  const bodyHtml = `
    <h1>${company.name || "STOCK PDV"} — Relatório Mensal</h1>
    <h2>${monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)} &nbsp;·&nbsp; ${getReportFilterLabel()}</h2>
    <p style="font-size:12px;color:#666;">Gerado em ${new Date().toLocaleString("pt-BR")}</p>
    ${productStatsHtml}
    <div class="summary">
      <div class="s-card"><label>Vendas</label><strong>${salesCount}</strong></div>
      <div class="s-card"><label>Total</label><strong>${money(totalGeral)}</strong></div>
      <div class="s-card"><label>Balcão</label><strong>${money(balcaoTotal)}</strong></div>
      <div class="s-card"><label>Delivery</label><strong>${money(deliveryTotal)}</strong></div>
    </div>
    <table>
      <thead>
        <tr><th>Data</th><th>Vendas</th><th>Total</th><th>Desconto</th><th>Lucro</th></tr>
      </thead>
      <tbody>${tableRows || '<tr><td colspan="5" style="text-align:center;color:#999;padding:20px;">Nenhuma venda neste mês</td></tr>'}</tbody>
      <tfoot>
        <tr>
          <td>TOTAL</td>
          <td style="text-align:center">${salesCount}</td>
          <td style="text-align:right">${money(totalGeral)}</td>
          <td style="text-align:right">${discountGeral > 0 ? "-" + money(discountGeral) : "—"}</td>
          <td style="text-align:right">${money(profitGeral)}</td>
        </tr>
      </tfoot>
    </table>`;

  openReportPrintWindow(`Relatório Mensal — ${monthLabel}`, bodyHtml);
}
window.printMonthlyReport = printMonthlyReport;

function setupSales() {
  document.getElementById("saleDateFilter").addEventListener("change", renderSales);
  setupSaleActionHandlers();
  document.getElementById("btnClearSalesHistory").addEventListener("click", async () => {
    if (!confirm("Deseja apagar TODO o histórico de vendas? Esta ação não pode ser desfeita.")) return;
    try {
      const [snapSales, snapPending] = await Promise.all([
        getStoreRef().collection("sales").get(),
        getStoreRef().collection("pendingAccounts").get()
      ]);
      const batch = db.batch();
      snapSales.docs.forEach((doc) => batch.delete(doc.ref));
      snapPending.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      await loadSales();
      await loadPendingAccounts();
      renderSales();
      document.getElementById("saleDetails").innerHTML = "";
      alert("Histórico de vendas apagado.");
    } catch (error) { alert(`Erro ao limpar histórico: ${error.message}`); }
  });
}

function setupReports() {
  const rerender = () => {
    refreshReportViews();
    document.getElementById("reportSaleDetails").innerHTML = "";
  };
  document.getElementById("reportDaySelect")?.addEventListener("change", rerender);
  document.getElementById("reportChannelFilter")?.addEventListener("change", rerender);
  document.getElementById("reportProductFilter")?.addEventListener("change", rerender);
}

function setupSaleActionHandlers() {
  document.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action][data-sale-id]");
    if (!btn) return;
    const saleId = btn.dataset.saleId;
    if (!saleId) return;
    if (btn.dataset.action === "sale-cancel") {
      event.preventDefault();
      window.cancelSale?.(saleId);
      return;
    }
    if (btn.dataset.action === "sale-details") {
      event.preventDefault();
      const inReport = Boolean(btn.closest("#dailySalesReportTable, #dailySalesReportBody, #reportSaleDetails"));
      showSaleDetails(saleId, inReport ? "report" : "sales");
    }
  });
}

function renderDailySalesReport() {
  const tbody = document.getElementById("dailySalesReportBody");
  const day = document.getElementById("reportDaySelect")?.value || todayISO();
  if (!tbody) return;

  const anonymousBuyerLabels = buildAnonymousBuyerLabelMap();
  const productId = getReportProductFilter();
  const rows = buildReportDayRows(day);

  if (!rows.length) {
    const channel = getReportChannelFilter();
    const emptyMsg = channel === REPORT_CHANNEL_DELIVERY
      ? "Nenhum pedido delivery finalizado neste dia"
      : channel === REPORT_CHANNEL_BALCAO
        ? "Nenhuma venda de balcão neste dia"
        : "Nenhuma venda neste dia";
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px;">${emptyMsg}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((entry) => {
    if (entry.kind === "balcao") {
      const sale = entry.sale;
      const cancelled = isSaleCancelled(sale);
      const time = new Date(sale.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const status = getSalePendingStatusText(sale);
      const rowStyle = cancelled ? ' style="opacity:0.7"' : "";
      const amount = getSaleProductAmount(sale, productId);
      const totalStyle = cancelled ? ' style="text-decoration:line-through;color:var(--muted)"' : "";
      return `<tr${rowStyle}>
        <td>${time}</td>
        <td><span class="report-channel-chip report-channel-chip--balcao">Balcão</span></td>
        <td>${getSaleBuyerName(sale, anonymousBuyerLabels)}</td>
        <td>${sale.paymentMethod || "—"}</td>
        <td${totalStyle}>${money(amount)}</td>
        <td>${status}</td>
        <td>${buildSaleActionButtons(sale, { compact: true }).replace('class="sales-list-actions"', 'class="sales-list-actions" style="justify-content:flex-end"')}</td>
      </tr>`;
    }

    const order = entry.order;
    const time = new Date(entry.sortAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const amount = getOrderProductAmount(order, productId);
    return `<tr>
      <td>${time}</td>
      <td><span class="report-channel-chip report-channel-chip--delivery">Delivery</span></td>
      <td>${order.customer?.name || "Cliente delivery"}</td>
      <td>${order.paymentMethod || "—"}</td>
      <td>${money(amount)}</td>
      <td>Finalizado</td>
      <td><button type="button" class="btn" style="padding:4px 8px;font-size:12px;" onclick="showDeliveryOrderReportDetails('${order.id}')">Detalhes</button></td>
    </tr>`;
  }).join("");
}

window.showDeliveryOrderReportDetails = (orderId) => {
  const order = state.deliveryOrders.find((o) => o.id === orderId);
  const box = document.getElementById("reportSaleDetails");
  if (!box || !order) return;
  const productId = getReportProductFilter();
  const itemsHtml = (order.items || []).map((item) => {
    const highlight = productId && item.productId === productId ? " style='font-weight:700;color:var(--accent)'" : "";
    return `<li${highlight}>${item.name} x${item.qty} — ${money(item.subtotal ?? item.price * item.qty)}</li>`;
  }).join("");
  box.innerHTML = `
    <h3 style="font-family:var(--font-head);letter-spacing:2px;margin-bottom:12px;">Pedido delivery #${order.id.slice(0, 8)}</h3>
    <p>Cliente: ${order.customer?.name || "-"}</p>
    <p>Telefone: ${order.customer?.phone || "-"}</p>
    <p>Endereço: ${order.customer?.address || "-"}</p>
    <p>Pagamento: ${order.paymentMethod || "-"}</p>
    <p>Status: ${getDeliveryStatusLabel(order.status)}</p>
    <p>Finalizado: ${new Date(order.deliveredAt || order.updatedAt || order.createdAt).toLocaleString("pt-BR")}</p>
    <ul style="margin:12px 0;padding-left:16px;">${itemsHtml}</ul>
    <strong>Total: ${money(order.total)}</strong>`;
  scrollToPanel(box);
};

function renderSales() {
  const filterDate = document.getElementById("saleDateFilter").value;
  const list = document.getElementById("salesList");
  const anonymousBuyerLabels = buildAnonymousBuyerLabelMap();
  const filtered = filterDate
    ? state.sales.filter((s) => isoMatchesLocalDay(s.createdAt, filterDate))
    : state.sales;
  const pendingAccounts = state.pendingAccounts
    .filter((acc) => Number(acc.totalPending || 0) > 0)
    .sort((a, b) => Number(b.totalPending || 0) - Number(a.totalPending || 0));

  const pendingHtml = pendingAccounts.map((acc) => {
    const monthGroups = groupEffectivePendingByMonth(getEffectivePendingSalesForAccount(acc));
    const salesCount = monthGroups.reduce((sum, g) => sum + g.sales.length, 0);
    const monthsSummary = monthGroups.length
      ? monthGroups.map((g) => `${formatMonthLabelPt(g.monthKey, { short: true })}: ${money(g.total)}`).join(" · ")
      : "";
    return `
      <li class="sales-list-item sales-list-item--pending">
        <span>
          ⏳ Em aberto | ${acc.customerName || "Cliente"} | Total pendente: ${money(acc.totalPending)} | Vendas: ${salesCount}
          ${monthsSummary ? `<br><small class="pending-months-summary">${monthsSummary}</small>` : ""}
        </span>
        <button class="btn" onclick="showPendingAccountDetails('${acc.id || acc.customerKey}')">Detalhes</button>
        <button class="btn" onclick="openPendingAccountEditor('${acc.id || acc.customerKey}')">Editar</button>
        <button class="btn danger" onclick="cancelPendingAccount('${acc.id || acc.customerKey}')">Cancelar conta</button>
      </li>`;
  }).join("");

  const salesHtml = filtered.map((s) => {
    const cancelled = isSaleCancelled(s);
    const pendingLabel = s.pendingStatus === "pending" ? " | Pendente" : cancelled ? " | Cancelado" : "";
    return `
      <li${cancelled ? ' style="opacity:0.65"' : ""}>
        <span${cancelled ? ' style="text-decoration:line-through"' : ""}>${new Date(s.createdAt).toLocaleString("pt-BR")} | ${money(s.total)} | ${s.paymentMethod}${pendingLabel} | ${getSaleBuyerName(s, anonymousBuyerLabels)}</span>
        ${buildSaleActionButtons(s)}
      </li>`;
  }).join("");

  list.innerHTML = (pendingHtml || salesHtml) ? `${pendingHtml}${salesHtml}` : "<li>Nenhuma venda encontrada.</li>";
}

function buildAnonymousBuyerLabelMap() {
  const map = new Map();
  const countersByMonth = {};
  const ordered = [...state.sales].sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return aTime - bTime;
  });
  ordered.forEach((sale) => {
    const buyerName = String(sale?.buyer?.name || "").trim();
    if (buyerName || !sale?.id || !sale?.createdAt) return;
    const monthKey = toLocalMonthISO(sale.createdAt);
    countersByMonth[monthKey] = (countersByMonth[monthKey] || 0) + 1;
    map.set(sale.id, `Comprador ${countersByMonth[monthKey]}`);
  });
  return map;
}

function getSaleBuyerName(sale, labelsMap = null) {
  const name = String(sale?.buyer?.name || "").trim();
  if (name) return name;
  const labels = labelsMap || buildAnonymousBuyerLabelMap();
  return labels.get(sale?.id) || "Comprador";
}

function isSaleCancelled(sale) {
  return sale?.pendingStatus === "cancelled" || sale?.status === "cancelled" || Boolean(sale?.cancelledAt);
}

function isCountableSale(sale) {
  return !isSaleCancelled(sale);
}

function isPendingCreditSale(sale) {
  if (!sale || !saleIsOnCredit(sale) || isSaleCancelled(sale)) return false;
  if (sale.pendingStatus === "pending") return true;
  if (Number(sale.pendingAmount || 0) > 0) return true;
  const accountKey = sale.pendingCustomerKey;
  if (!accountKey) return false;
  const account = state.pendingAccounts.find((acc) => (acc.customerKey || acc.id) === accountKey);
  return Boolean(account && Number(account.totalPending || 0) > 0 && (account.saleIds || []).includes(sale.id));
}

function isCancellableCreditSale(sale) {
  return isPendingCreditSale(sale);
}

function isCancellableSale(sale) {
  if (!sale || isSaleCancelled(sale)) return false;
  if (saleIsOnCredit(sale)) return isPendingCreditSale(sale);
  return true;
}

function getSaleDetailsContainer(preferred = "") {
  if (preferred === "report") return document.getElementById("reportSaleDetails");
  if (preferred === "sales") return document.getElementById("saleDetails");
  const reportTab = document.getElementById("relatoriosTab");
  if (reportTab?.classList.contains("active")) {
    return document.getElementById("reportSaleDetails") || document.getElementById("saleDetails");
  }
  return document.getElementById("saleDetails") || document.getElementById("reportSaleDetails");
}

function buildSaleActionButtons(sale, { compact = false, details = true } = {}) {
  const style = compact ? ' style="margin-left:8px;padding:4px 8px;font-size:12px;"' : "";
  const detailsBtn = details
    ? `<button type="button" class="btn" data-action="sale-details" data-sale-id="${sale.id}"${style}>Detalhes</button>`
    : "";
  const cancelBtn = isCancellableSale(sale)
    ? `<button type="button" class="btn danger" data-action="sale-cancel" data-sale-id="${sale.id}"${style}>Cancelar</button>`
    : "";
  return `<div class="sales-list-actions">${detailsBtn}${cancelBtn}</div>`;
}

function getSaleItemDisplayName(item) {
  const name = String(item?.name || item?.productName || "").trim();
  if (name) return name;
  const code = String(item?.code || "").trim();
  return code ? `Produto ${code}` : "Produto";
}

function getSaleItemQtyLabel(item) {
  const qty = Number(item?.qty || 0);
  if (item?.unit === "ml" || item?.stockMode === "ml") return formatMlQty(qty);
  return String(qty);
}

function getSaleItemSubtotal(item) {
  const qty = Number(item?.qty || 0);
  const price = Number(item?.price || 0);
  return Number(item?.subtotal ?? price * qty);
}

function buildSaleItemsListHtml(items) {
  if (!Array.isArray(items) || !items.length) {
    return `<li class="pending-sale-empty">Nenhum produto nesta venda.</li>`;
  }
  return items.map((item) => {
    const name = getSaleItemDisplayName(item);
    const qty = getSaleItemQtyLabel(item);
    const subtotal = getSaleItemSubtotal(item);
    const code = String(item?.code || "").trim();
    const codeHtml = code ? `<span class="pending-sale-item-code">${code}</span>` : "";
    return `<li class="pending-sale-item">
      <span class="pending-sale-item-name">${name} ${codeHtml} <small>× ${qty}</small></span>
      <strong>${money(subtotal)}</strong>
    </li>`;
  }).join("");
}

function buildPendingSaleCardHtml(sale, { effective = null } = {}) {
  const statusLabel = getSalePendingStatusLabel(sale);
  const remainingLabel = effective
    ? ` · em aberto: ${money(effective.pendingAmount)}`
    : "";
  const actions = buildSaleActionButtons(sale, { compact: true, details: false });
  const dateLabel = sale.createdAt ? new Date(sale.createdAt).toLocaleString("pt-BR") : "-";
  return `
    <div class="pending-sale-card">
      <details>
        <summary class="pending-sale-summary">
          <span class="pending-sale-open-hint">Abrir</span>
          <span>${dateLabel} — ${money(sale.total)} (${statusLabel}${remainingLabel})</span>
        </summary>
        <div class="pending-sale-body">
          <p class="pending-sale-body-title">Produtos desta venda</p>
          <ul class="pending-sale-items">${buildSaleItemsListHtml(sale.items)}</ul>
        </div>
      </details>
      ${actions}
    </div>`;
}

function getSalePendingStatusText(sale) {
  if (sale?.pendingStatus === "cancelled") return "Cancelado";
  if (sale?.pendingStatus === "pending") return "Pendente";
  return "Pago";
}

function getSalePendingStatusLabel(sale) {
  const text = getSalePendingStatusText(sale);
  return text.toLowerCase();
}

function getPendingSalesForAccount(accountKey) {
  return state.sales.filter(
    (sale) => sale.pendingCustomerKey === accountKey && sale.pendingStatus === "pending"
  );
}

function aggregateItemsQtyByProduct(items) {
  const map = new Map();
  for (const item of items || []) {
    const productId = item?.productId;
    if (!productId) continue;
    map.set(productId, (map.get(productId) || 0) + Math.max(0, Number(item.qty || 0)));
  }
  return map;
}

/** Firestore exige todas as leituras antes de qualquer escrita na mesma transação. */
async function restoreSaleItemsInTransaction(tx, storeRef, items) {
  const qtyByProduct = resolveStockDeductionsFromSaleItems(items);
  const reads = [];
  for (const [productId, addQty] of qtyByProduct) {
    if (addQty <= 0) continue;
    const productRef = storeRef.collection("products").doc(productId);
    reads.push({ productRef, addQty, snap: await tx.get(productRef) });
  }
  for (const { productRef, addQty, snap } of reads) {
    if (!snap.exists) continue;
    const currentQty = Number(snap.data()?.qty || 0);
    tx.update(productRef, { qty: currentQty + addQty });
  }
}

function applySaleStockRestoreLocally(sale) {
  resolveStockDeductionsFromSaleItems(sale.items).forEach((addQty, productId) => {
    const p = state.products.find((x) => x.id === productId);
    if (p) p.qty = Number(p.qty || 0) + addQty;
  });
}

function itemsToProductQtyMap(items) {
  return resolveStockDeductionsFromSaleItems(items);
}

function aggregateEditCartItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.productId}|${item.priceType || "retail"}`;
    const existing = map.get(key);
    if (existing) existing.qty += Number(item.qty || 0);
    else map.set(key, { productId: item.productId, priceType: item.priceType || "retail", qty: Number(item.qty || 0) });
  }
  return [...map.values()];
}

function flattenPendingSalesToEditCart(pendingSales) {
  const cart = [];
  for (const sale of pendingSales) {
    for (const item of sale.items || []) {
      cart.push({
        productId: item.productId,
        priceType: item.priceType || "retail",
        qty: Number(item.qty || 0)
      });
    }
  }
  return aggregateEditCartItems(cart);
}

function buildSaleItemsFromEditCart(cartItems, discountValue, discountType) {
  const items = [];
  for (const item of cartItems) {
    const p = state.products.find((x) => x.id === item.productId);
    if (!p) continue;
    const price = getCartItemPrice(p, item.priceType);
    const qty = Number(item.qty || 0);
    if (qty <= 0) continue;
    items.push({
      name: p.name,
      code: p.code,
      category: getProductCategory(p),
      price,
      priceType: item.priceType,
      cost: p.cost,
      qty,
      subtotal: price * qty,
      productId: p.id
    });
  }
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const discount = calcDiscountFrom(subtotal, discountValue, discountType);
  const total = Math.max(0, subtotal - discount);
  return { items, subtotal, discount, total };
}

function getAvailableStockForPendingEdit(productId, editItems) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return 0;
  if (isDoseProduct(product)) {
    const usage = new Map();
    (editItems || []).forEach((item) => {
      if (item.productId === productId) return;
      const p = state.products.find((x) => x.id === item.productId);
      if (!p) return;
      resolveStockDeductionsForLineItem(p, item.qty).forEach((amt, pid) => {
        usage.set(pid, (usage.get(pid) || 0) + amt);
      });
    });
    const recipe = getDoseRecipe(product);
    let maxDoses = Infinity;
    recipe.forEach((comp) => {
      const ing = state.products.find((p) => p.id === comp.productId);
      const perDose = getDoseRecipeComponentPerDose(comp, ing);
      if (!ing || perDose <= 0) return;
      const avail = Number(ing.qty || 0) - (usage.get(comp.productId) || 0);
      maxDoses = Math.min(maxDoses, Math.floor(avail / perDose));
    });
    const reserved = (editItems || [])
      .filter((i) => i.productId === productId)
      .reduce((sum, i) => sum + Number(i.qty || 0), 0);
    return Math.max(0, (maxDoses === Infinity ? 0 : maxDoses)) + reserved;
  }
  const reservedInEdit = (editItems || [])
    .filter((i) => i.productId === productId)
    .reduce((sum, i) => sum + Number(i.qty || 0), 0);
  return Number(product?.qty || 0) + reservedInEdit;
}

async function applyProductStockDeltaInTransaction(tx, storeRef, oldQtyMap, newQtyMap) {
  const allIds = new Set([...oldQtyMap.keys(), ...newQtyMap.keys()]);
  const pending = [];
  for (const productId of allIds) {
    const stockDelta = (oldQtyMap.get(productId) || 0) - (newQtyMap.get(productId) || 0);
    if (stockDelta === 0) continue;
    const productRef = storeRef.collection("products").doc(productId);
    pending.push({ productRef, productId, stockDelta, snap: await tx.get(productRef) });
  }
  for (const { productRef, productId, stockDelta, snap } of pending) {
    if (!snap.exists) throw new Error("Produto não encontrado.");
    const currentQty = Number(snap.data()?.qty || 0);
    if (stockDelta < 0 && currentQty < -stockDelta) {
      const label = state.products.find((p) => p.id === productId)?.name || "produto";
      throw new Error(`Estoque insuficiente para "${label}". Disponível: ${currentQty}`);
    }
    tx.update(productRef, { qty: currentQty + stockDelta });
  }
}

function applyProductStockDeltaLocally(oldQtyMap, newQtyMap) {
  const allIds = new Set([...oldQtyMap.keys(), ...newQtyMap.keys()]);
  allIds.forEach((productId) => {
    const stockDelta = (oldQtyMap.get(productId) || 0) - (newQtyMap.get(productId) || 0);
    if (!stockDelta) return;
    const p = state.products.find((x) => x.id === productId);
    if (p) p.qty = Number(p.qty || 0) + stockDelta;
  });
}

function renderPendingAccountEditSearch(term = "") {
  const dropdown = document.getElementById("pendingAccountEditResults");
  if (!dropdown) return;
  const q = normalizeSearch(term);
  if (!q) {
    dropdown.classList.remove("open");
    dropdown.innerHTML = "";
    return;
  }
  const products = getPDVSearchMatches(term).slice(0, 12);
  if (!products.length) {
    dropdown.innerHTML = `<li style="color:var(--muted);cursor:default;justify-content:center;">Nenhum produto encontrado</li>`;
    dropdown.classList.add("open");
    return;
  }
  const editItems = state.pendingAccountEdit?.items || [];
  dropdown.innerHTML = products.map((p) => {
    const available = getAvailableStockForPendingEdit(p.id, editItems);
    const disabled = available <= 0 ? "disabled" : "";
    return `<li>
      ${productThumb(p, 36)}
      <div class="product-info">
        <span class="product-name">${p.name}</span>
        <span class="product-meta">Cód: ${p.code} · Estq: ${available} · ${money(p.price)}</span>
      </div>
      <button type="button" class="btn-add-retail" ${disabled} onclick="pendingEditAddProduct('${p.id}')">+ Adicionar</button>
    </li>`;
  }).join("");
  dropdown.classList.add("open");
}

function renderPendingAccountEditor() {
  const edit = state.pendingAccountEdit;
  const box = document.getElementById("saleDetails");
  if (!edit || !box) return;

  const account = state.pendingAccounts.find((acc) => (acc.id || acc.customerKey) === edit.accountId);
  const { items, subtotal, discount, total } = buildSaleItemsFromEditCart(
    edit.items,
    edit.discountValue,
    edit.discountType
  );

  const itemsHtml = edit.items.length
    ? edit.items.map((item) => {
      const product = state.products.find((p) => p.id === item.productId);
      if (!product) return "";
      const unitPrice = getCartItemPrice(product, item.priceType);
      const maxQty = getAvailableStockForPendingEdit(product.id, edit.items);
      return `<li class="pending-edit-item">
        ${productThumb(product, 40)}
        <div class="pending-edit-item-info">
          <span class="pending-edit-item-name">${product.name}</span>
          <span class="pending-edit-item-meta">${money(unitPrice)} × ${item.qty} = ${money(unitPrice * item.qty)}</span>
        </div>
        <div class="pending-edit-item-actions">
          <button type="button" class="btn-ctrl" onclick="pendingEditChangeQty('${item.productId}','${item.priceType}',-1)">−</button>
          <input type="number" class="pending-edit-qty-input" min="1" max="${maxQty}" value="${item.qty}"
            onchange="pendingEditSetQty('${item.productId}','${item.priceType}',this.value)" />
          <button type="button" class="btn-ctrl" onclick="pendingEditChangeQty('${item.productId}','${item.priceType}',1)">+</button>
          <button type="button" class="btn-ctrl rm" onclick="pendingEditRemoveItem('${item.productId}','${item.priceType}')">×</button>
        </div>
      </li>`;
    }).join("")
    : `<li class="pending-edit-empty">Nenhum produto na conta. Busque abaixo para adicionar.</li>`;

  box.innerHTML = `
    <div class="pending-account-edit">
      <h3 class="pending-edit-title">Editar conta — ${account?.customerName || "Cliente"}</h3>
      <p class="pending-edit-hint">Adicione, remova ou altere quantidades. O estoque é ajustado ao salvar.</p>
      <ul class="pending-edit-list">${itemsHtml}</ul>
      <div class="pending-edit-search-wrap">
        <label>Adicionar produto</label>
        <input type="text" id="pendingAccountEditSearch" placeholder="Nome ou código de barras..." autocomplete="off" />
        <ul id="pendingAccountEditResults" class="pdv-search-results pending-edit-search-results"></ul>
      </div>
      <div class="pending-edit-discount">
        <label>Desconto</label>
        <div class="pending-edit-discount-row">
          <input type="number" id="pendingEditDiscountValue" min="0" step="0.01" value="${edit.discountValue || 0}" />
          <select id="pendingEditDiscountType">
            <option value="R$" ${edit.discountType === "R$" ? "selected" : ""}>R$</option>
            <option value="%" ${edit.discountType === "%" ? "selected" : ""}>%</option>
          </select>
        </div>
      </div>
      <div class="pending-edit-totals">
        <span>Subtotal: ${money(subtotal)}</span>
        ${discount > 0 ? `<span>Desconto: −${money(discount)}</span>` : ""}
        <strong>Total pendente: ${money(total)}</strong>
      </div>
      <div class="pending-edit-actions">
        <button type="button" class="btn primary" onclick="savePendingAccountEdit()">Salvar alterações</button>
        <button type="button" class="btn" onclick="closePendingAccountEditor()">Voltar</button>
      </div>
    </div>
  `;

  const searchInput = document.getElementById("pendingAccountEditSearch");
  searchInput?.addEventListener("input", (e) => renderPendingAccountEditSearch(e.target.value));
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.getElementById("pendingAccountEditResults")?.classList.remove("open");
    }
  });

  document.getElementById("pendingEditDiscountValue")?.addEventListener("change", (e) => {
    edit.discountValue = Number(e.target.value || 0);
    renderPendingAccountEditor();
  });
  document.getElementById("pendingEditDiscountType")?.addEventListener("change", (e) => {
    edit.discountType = e.target.value;
    renderPendingAccountEditor();
  });

  scrollToPanel(box);
}

window.openPendingAccountEditor = (accountId) => {
  const account = state.pendingAccounts.find((acc) => (acc.id || acc.customerKey) === accountId);
  if (!account) {
    alert("Conta a prazo não encontrada.");
    return;
  }
  const accountKey = account.customerKey || account.id;
  const pendingSales = getPendingSalesForAccount(accountKey);
  if (!pendingSales.length) {
    alert("Esta conta não tem vendas pendentes para editar.");
    return;
  }
  const totalDiscount = pendingSales.reduce((sum, sale) => sum + Number(sale.discount || 0), 0);
  state.pendingAccountEdit = {
    accountId,
    accountKey,
    items: flattenPendingSalesToEditCart(pendingSales),
    discountValue: totalDiscount,
    discountType: "R$",
    pendingSaleIds: pendingSales.map((s) => s.id)
  };
  renderPendingAccountEditor();
};

window.closePendingAccountEditor = () => {
  const accountId = state.pendingAccountEdit?.accountId;
  state.pendingAccountEdit = null;
  if (accountId) showPendingAccountDetails(accountId);
};

window.pendingEditAddProduct = (productId) => {
  const edit = state.pendingAccountEdit;
  if (!edit) return;
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  const available = getAvailableStockForPendingEdit(productId, edit.items);
  if (available <= 0) {
    alert(`Produto "${getProductLabel(product)}" sem estoque.`);
    return;
  }
  const existing = edit.items.find((i) => i.productId === productId && i.priceType === "retail");
  if (existing) {
    if (existing.qty + 1 > available) {
      alert("Estoque insuficiente.");
      return;
    }
    existing.qty += 1;
  } else {
    edit.items.push({ productId, priceType: "retail", qty: 1 });
  }
  document.getElementById("pendingAccountEditSearch").value = "";
  renderPendingAccountEditSearch("");
  renderPendingAccountEditor();
};

window.pendingEditChangeQty = (productId, priceType, diff) => {
  const edit = state.pendingAccountEdit;
  if (!edit) return;
  const item = edit.items.find((i) => i.productId === productId && i.priceType === priceType);
  if (!item) return;
  const next = item.qty + diff;
  if (next <= 0) {
    edit.items = edit.items.filter((i) => !(i.productId === productId && i.priceType === priceType));
  } else {
    const maxQty = getAvailableStockForPendingEdit(productId, edit.items);
    if (next > maxQty) {
      alert(`Estoque insuficiente. Disponível: ${maxQty}`);
      return;
    }
    item.qty = next;
  }
  renderPendingAccountEditor();
};

window.pendingEditSetQty = (productId, priceType, rawQty) => {
  const edit = state.pendingAccountEdit;
  if (!edit) return;
  const item = edit.items.find((i) => i.productId === productId && i.priceType === priceType);
  if (!item) return;
  const parsed = Math.floor(Number(String(rawQty).replace(",", ".")));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    edit.items = edit.items.filter((i) => !(i.productId === productId && i.priceType === priceType));
  } else {
    const maxQty = getAvailableStockForPendingEdit(productId, edit.items);
    if (parsed > maxQty) {
      alert(`Estoque insuficiente. Disponível: ${maxQty}`);
      renderPendingAccountEditor();
      return;
    }
    item.qty = parsed;
  }
  renderPendingAccountEditor();
};

window.pendingEditRemoveItem = (productId, priceType) => {
  const edit = state.pendingAccountEdit;
  if (!edit) return;
  edit.items = edit.items.filter((i) => !(i.productId === productId && i.priceType === priceType));
  renderPendingAccountEditor();
};

window.savePendingAccountEdit = async () => {
  const edit = state.pendingAccountEdit;
  if (!edit) return;
  const account = state.pendingAccounts.find((acc) => (acc.id || acc.customerKey) === edit.accountId);
  if (!account) return;

  const { items, subtotal, discount, total } = buildSaleItemsFromEditCart(
    edit.items,
    edit.discountValue,
    edit.discountType
  );
  if (!items.length) {
    alert("A conta precisa ter pelo menos um produto. Use «Cancelar conta» para zerar tudo.");
    return;
  }

  const pendingSales = getPendingSalesForAccount(edit.accountKey)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  const primarySale = pendingSales[0];
  const otherSales = pendingSales.slice(1);

  const oldItems = pendingSales.flatMap((s) => s.items || []);
  const oldQtyMap = itemsToProductQtyMap(oldItems);
  const newQtyMap = itemsToProductQtyMap(items);
  const oldPendingSalesTotal = pendingSales.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const currentPending = Math.max(0, Number(account.totalPending || 0));
  const nextPending = Math.max(0, currentPending - oldPendingSalesTotal + total);

  const updatedAt = new Date().toISOString();
  try {
    const storeRef = getStoreRef();
    await db.runTransaction(async (tx) => {
      const primaryRef = storeRef.collection("sales").doc(primarySale.id);
      const accountRef = storeRef.collection("pendingAccounts").doc(edit.accountKey);
      const primarySnap = await tx.get(primaryRef);
      if (!primarySnap.exists) throw new Error("Venda principal não encontrada.");

      const otherSnaps = [];
      for (const sale of otherSales) {
        const saleRef = storeRef.collection("sales").doc(sale.id);
        otherSnaps.push({ saleRef, snap: await tx.get(saleRef) });
      }
      await tx.get(accountRef);

      await applyProductStockDeltaInTransaction(tx, storeRef, oldQtyMap, newQtyMap);

      tx.set(primaryRef, {
        items,
        subtotal,
        discount,
        total,
        pendingAmount: total,
        pendingStatus: "pending",
        updatedAt
      }, { merge: true });

      for (const { saleRef, snap } of otherSnaps) {
        if (!snap.exists) continue;
        const data = snap.data() || {};
        if (data.pendingStatus !== "pending") continue;
        tx.set(saleRef, {
          pendingStatus: "cancelled",
          pendingAmount: 0,
          cancelledAt: updatedAt,
          cancelReason: "merged_on_account_edit",
          mergedIntoSaleId: primarySale.id
        }, { merge: true });
      }

      const saleIds = [primarySale.id, ...(account.saleIds || []).filter((id) => !otherSales.some((s) => s.id === id))];
      tx.set(accountRef, {
        totalPending: nextPending,
        status: nextPending <= 0 ? "paid" : "pending",
        saleIds: [...new Set(saleIds)],
        updatedAt
      }, { merge: true });
    });

    applyProductStockDeltaLocally(oldQtyMap, newQtyMap);
    updateStockNavAlert();

    primarySale.items = items;
    primarySale.subtotal = subtotal;
    primarySale.discount = discount;
    primarySale.total = total;
    primarySale.pendingAmount = total;
    primarySale.updatedAt = updatedAt;

    otherSales.forEach((sale) => {
      sale.pendingStatus = "cancelled";
      sale.pendingAmount = 0;
      sale.cancelledAt = updatedAt;
    });

    account.totalPending = nextPending;
    account.status = nextPending <= 0 ? "paid" : "pending";
    account.updatedAt = updatedAt;
    if (Array.isArray(account.saleIds)) {
      account.saleIds = [...new Set([primarySale.id, ...account.saleIds.filter((id) => !otherSales.some((s) => s.id === id))])];
    }

    state.pendingAccountEdit = null;
    renderAll();
    showPendingAccountDetails(edit.accountId);
    alert("Conta atualizada com sucesso.");
  } catch (error) {
    alert(`Erro ao salvar conta: ${error.message}`);
  }
};

window.showPendingAccountDetails = (accountId) => {
  const account = state.pendingAccounts.find((acc) => (acc.id || acc.customerKey) === accountId);
  const box = document.getElementById("saleDetails");
  if (!account) {
    box.innerHTML = "<p>Conta pendente não encontrada.</p>";
    return;
  }
  const accountKey = account.customerKey || account.id;
  const accountSales = state.sales
    .filter((sale) => sale.pendingCustomerKey === accountKey)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  const effectiveRows = getEffectivePendingSalesForAccount(account);
  const monthGroups = groupEffectivePendingByMonth(effectiveRows);
  const pendingSales = accountSales.filter((sale) => sale.pendingStatus === "pending" || Number(sale.pendingAmount || 0) > 0);
  const pendingTotal = Math.max(0, roundMoney(account.totalPending || effectiveRows.reduce((s, r) => s + r.pendingAmount, 0)));

  const monthsHtml = monthGroups.length
    ? monthGroups.map((group, idx) => `
        <li class="pending-month-row${idx === 0 ? " pending-month-row--oldest" : ""}">
          <span class="pending-month-label">
            ${formatMonthLabelPt(group.monthKey)}
            ${idx === 0 ? '<small class="pending-month-badge">baixa primeiro</small>' : ""}
          </span>
          <strong class="pending-month-value">${money(group.total)}</strong>
        </li>`).join("")
    : `<li class="pending-month-row"><span>Nenhum valor em aberto por mês.</span></li>`;

  const salesByMonth = new Map();
  accountSales.forEach((sale) => {
    const monthKey = toLocalMonthISO(sale.createdAt) || "sem-data";
    if (!salesByMonth.has(monthKey)) salesByMonth.set(monthKey, []);
    salesByMonth.get(monthKey).push(sale);
  });
  const monthKeys = [...salesByMonth.keys()].sort((a, b) => String(b).localeCompare(String(a)));
  const saleListHtml = monthKeys.length
    ? monthKeys.map((monthKey) => {
        const sales = salesByMonth.get(monthKey) || [];
        const cards = sales.map((sale) => {
          const effective = effectiveRows.find((r) => r.sale.id === sale.id);
          return buildPendingSaleCardHtml(sale, { effective });
        }).join("");
        return `
          <section class="pending-month-sales">
            <h5 class="pending-month-sales-title">${formatMonthLabelPt(monthKey)}</h5>
            ${cards}
          </section>`;
      }).join("")
    : `<p class="pending-sale-empty">Sem vendas registradas.</p>`;

  box.innerHTML = `
    <h3 style="font-family:var(--font-head);letter-spacing:2px;margin-bottom:12px;">Conta a prazo — ${account.customerName || "Cliente"}</h3>
    <p>Total pendente: <strong style="color:var(--danger);">${money(pendingTotal)}</strong></p>
    <p>Telefone: ${account.phone || "-"}</p>
    <p>CPF/CNPJ: ${account.document || "-"}</p>
    <p>Última atualização: ${account.updatedAt ? new Date(account.updatedAt).toLocaleString("pt-BR") : "-"}</p>
    <div class="pending-months-card">
      <h4 class="pending-months-title">Valores por mês</h4>
      <p class="pending-months-hint">Conforme o cliente paga, a baixa entra no mês mais antigo. Abra cada venda para ver os produtos.</p>
      <ul class="pending-months-list">${monthsHtml}</ul>
    </div>
    <div class="pending-sales-wrap">${saleListHtml}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <input type="number" id="pendingSettlementAmount" min="0" step="0.01" placeholder="Valor recebido" style="max-width:180px;" />
      <button class="btn primary" onclick="settlePendingAccount('${account.id || account.customerKey}')">Baixar pagamento</button>
      <button class="btn" onclick="settlePendingAccount('${account.id || account.customerKey}', true)">Quitar tudo</button>
      ${pendingSales.length ? `<button class="btn" onclick="openPendingAccountEditor('${account.id || account.customerKey}')">Editar conta</button>` : ""}
      ${pendingSales.length ? `<button class="btn danger" onclick="cancelPendingAccount('${account.id || account.customerKey}')">Cancelar conta inteira</button>` : ""}
    </div>
  `;
  scrollToPanel(box);
};

window.settlePendingAccount = async (accountId, settleAll = false) => {
  const account = state.pendingAccounts.find((acc) => (acc.id || acc.customerKey) === accountId);
  if (!account) return;
  const currentPending = Math.max(0, roundMoney(account.totalPending || 0));
  if (currentPending <= 0) {
    alert("Esta conta já está quitada.");
    return;
  }
  const inputAmount = Number(document.getElementById("pendingSettlementAmount")?.value || 0);
  const settleValue = roundMoney(settleAll ? currentPending : inputAmount);
  if (!Number.isFinite(settleValue) || settleValue <= 0) {
    alert("Informe um valor válido para baixar.");
    return;
  }
  if (settleValue > currentPending) {
    alert(`Valor acima do pendente (${money(currentPending)}).`);
    return;
  }

  const nextPending = Math.max(0, roundMoney(currentPending - settleValue));
  const paidAt = new Date().toISOString();
  const settlementPlan = buildPendingSettlementPlan(account, settleValue);
  try {
    const storeRef = getStoreRef();
    await db.runTransaction(async (tx) => {
      const accountRef = storeRef.collection("pendingAccounts").doc(account.id || account.customerKey);
      tx.set(accountRef, {
        totalPending: nextPending,
        totalPaid: roundMoney(Number(account.totalPaid || 0) + settleValue),
        status: nextPending <= 0 ? "paid" : "pending",
        updatedAt: paidAt
      }, { merge: true });

      settlementPlan.forEach((row) => {
        const saleRef = storeRef.collection("sales").doc(row.sale.id);
        const patch = {
          pendingStatus: row.nextStatus,
          pendingAmount: row.nextPending
        };
        if (row.nextStatus === "paid") patch.paidAt = paidAt;
        tx.set(saleRef, patch, { merge: true });
      });
    });

    account.totalPending = nextPending;
    account.totalPaid = roundMoney(Number(account.totalPaid || 0) + settleValue);
    account.status = nextPending <= 0 ? "paid" : "pending";
    account.updatedAt = paidAt;
    settlementPlan.forEach((row) => {
      const sale = state.sales.find((s) => s.id === row.sale.id) || row.sale;
      sale.pendingStatus = row.nextStatus;
      sale.pendingAmount = row.nextPending;
      if (row.nextStatus === "paid") sale.paidAt = paidAt;
    });
    renderSales();
    showPendingAccountDetails(account.id || account.customerKey);
    const paidMonths = groupEffectivePendingByMonth(
      settlementPlan
        .filter((row) => row.paidNow > 0)
        .map((row) => ({
          sale: row.sale,
          pendingAmount: row.paidNow,
          monthKey: toLocalMonthISO(row.sale.createdAt) || "sem-data"
        }))
    );
    const monthMsg = paidMonths.length
      ? `\nBaixa aplicada: ${paidMonths.map((g) => `${formatMonthLabelPt(g.monthKey, { short: true })} ${money(g.total)}`).join(" · ")}`
      : "";
    alert(`Pagamento baixado com sucesso.${monthMsg}`);
  } catch (error) {
    alert(`Erro ao baixar pagamento: ${error.message}`);
  }
};

window.cancelSale = async (saleId) => {
  const sale = state.sales.find((s) => s.id === saleId);
  if (!sale || !isCancellableSale(sale)) {
    alert("Esta venda não pode ser cancelada (já quitada ou cancelada).");
    return;
  }

  const isCredit = sale.paymentMethod === "A Prazo";
  const confirmMsg = isCredit
    ? `Cancelar esta venda a prazo (${money(sale.total)})?\n\nOs produtos voltarão ao estoque.`
    : `Cancelar esta venda (${money(sale.total)} — ${sale.paymentMethod})?\n\nOs produtos voltarão ao estoque.\n\nO valor será removido dos relatórios.`;
  if (!confirm(confirmMsg)) return;

  const accountKey = sale.pendingCustomerKey;
  const cancelledAt = new Date().toISOString();
  const saleTotal = Number(sale.total || 0);
  const operator = getOperatorInfo();

  try {
    const storeRef = getStoreRef();
    await db.runTransaction(async (tx) => {
      const saleRef = storeRef.collection("sales").doc(saleId);
      const saleSnap = await tx.get(saleRef);
      if (!saleSnap.exists) throw new Error("Venda não encontrada.");
      const data = saleSnap.data() || {};
      if (isSaleCancelled(data)) throw new Error("Esta venda já foi cancelada.");
      if (data.paymentMethod === "A Prazo" && !isPendingCreditSale({ ...data, id: saleId })) {
        throw new Error("Esta venda a prazo já foi quitada ou cancelada.");
      }

      let accountRef = null;
      let accountSnap = null;
      if (isCredit && accountKey) {
        accountRef = storeRef.collection("pendingAccounts").doc(accountKey);
        accountSnap = await tx.get(accountRef);
      }

      await restoreSaleItemsInTransaction(tx, storeRef, data.items);

      tx.set(saleRef, {
        pendingStatus: "cancelled",
        status: "cancelled",
        pendingAmount: 0,
        cancelledAt,
        cancelledBy: operator.email || "",
        cancelledByName: operator.name || ""
      }, { merge: true });

      if (accountRef && accountSnap?.exists) {
        const acc = accountSnap.data() || {};
        const nextPending = Math.max(0, Number(acc.totalPending || 0) - saleTotal);
        const saleIds = Array.isArray(acc.saleIds) ? acc.saleIds.filter((id) => id !== saleId) : [];
        tx.set(accountRef, {
          totalPending: nextPending,
          status: nextPending <= 0 ? "paid" : "pending",
          saleIds,
          updatedAt: cancelledAt
        }, { merge: true });
      }
    });

    sale.pendingStatus = "cancelled";
    sale.status = "cancelled";
    sale.pendingAmount = 0;
    sale.cancelledAt = cancelledAt;
    sale.cancelledBy = operator.email || "";
    sale.cancelledByName = operator.name || "";
    applySaleStockRestoreLocally(sale);
    updateStockNavAlert();

    if (isCredit && accountKey) {
      const account = state.pendingAccounts.find((a) => (a.customerKey || a.id) === accountKey);
      if (account) {
        account.totalPending = Math.max(0, Number(account.totalPending || 0) - saleTotal);
        account.status = account.totalPending <= 0 ? "paid" : "pending";
        if (Array.isArray(account.saleIds)) {
          account.saleIds = account.saleIds.filter((id) => id !== saleId);
        }
        account.updatedAt = cancelledAt;
      }
    }

    renderAll();
    updatePdvCashUI();
    renderDailySalesReport();
    if (isCredit && accountKey && state.pendingAccounts.some((a) => (a.customerKey || a.id) === accountKey && Number(a.totalPending || 0) > 0)) {
      showPendingAccountDetails(accountKey);
    } else {
      const reportTab = document.getElementById("relatoriosTab");
      showSaleDetails(saleId, reportTab?.classList.contains("active") ? "report" : "sales");
    }
    alert("Venda cancelada e estoque devolvido.");
  } catch (error) {
    alert(`Erro ao cancelar venda: ${error.message}`);
  }
};

window.cancelPendingSale = (saleId) => window.cancelSale?.(saleId);

window.cancelPendingAccount = async (accountId) => {
  const account = state.pendingAccounts.find((acc) => (acc.id || acc.customerKey) === accountId);
  if (!account) {
    alert("Conta a prazo não encontrada.");
    return;
  }
  const accountKey = account.customerKey || account.id;
  const pendingSales = getPendingSalesForAccount(accountKey);
  if (!pendingSales.length) {
    alert("Esta conta não tem vendas pendentes para cancelar.");
    return;
  }
  const pendingTotal = Math.max(0, Number(account.totalPending || 0));
  const customerName = account.customerName || "Cliente";
  if (!confirm(
    `Cancelar a conta inteira de ${customerName}?\n\n` +
    `${pendingSales.length} venda(s) pendente(s) — total ${money(pendingTotal)}\n\n` +
    "Todas as vendas serão canceladas e os produtos voltarão ao estoque."
  )) return;

  const cancelledAt = new Date().toISOString();
  try {
    const storeRef = getStoreRef();
    await db.runTransaction(async (tx) => {
      const accountRef = storeRef.collection("pendingAccounts").doc(accountKey);
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists) throw new Error("Conta a prazo não encontrada no servidor.");

      const salesToCancel = [];
      const allItems = [];
      for (const sale of pendingSales) {
        const saleRef = storeRef.collection("sales").doc(sale.id);
        const saleSnap = await tx.get(saleRef);
        if (!saleSnap.exists) continue;
        const data = saleSnap.data() || {};
        if (data.paymentMethod !== "A Prazo" || data.pendingStatus !== "pending") continue;
        salesToCancel.push({ saleRef });
        allItems.push(...(data.items || []));
      }

      if (!salesToCancel.length) {
        throw new Error("Nenhuma venda pendente encontrada. Clique em Atualizar na aba Vendas ou recarregue a página.");
      }

      await restoreSaleItemsInTransaction(tx, storeRef, allItems);

      for (const { saleRef } of salesToCancel) {
        tx.set(saleRef, {
          pendingStatus: "cancelled",
          status: "cancelled",
          pendingAmount: 0,
          cancelledAt
        }, { merge: true });
      }

      tx.set(accountRef, {
        totalPending: 0,
        status: "paid",
        updatedAt: cancelledAt,
        cancelledAt
      }, { merge: true });
    });

    pendingSales.forEach((sale) => {
      sale.pendingStatus = "cancelled";
      sale.status = "cancelled";
      sale.pendingAmount = 0;
      sale.cancelledAt = cancelledAt;
      applySaleStockRestoreLocally(sale);
    });
    account.totalPending = 0;
    account.status = "paid";
    account.updatedAt = cancelledAt;
    account.cancelledAt = cancelledAt;
    updateStockNavAlert();

    renderAll();
    document.getElementById("saleDetails").innerHTML = "<p>Conta cancelada. Nenhum valor pendente.</p>";
    alert(`Conta de ${customerName} cancelada. Estoque devolvido.`);
  } catch (error) {
    console.error("cancelPendingAccount:", error);
    const msg = error?.message || String(error);
    if (/reads before writes|reads to be executed before all writes/i.test(msg)) {
      alert("Erro ao cancelar conta: falha de sincronização. Atualize a página e tente de novo.");
    } else {
      alert(`Erro ao cancelar conta: ${msg}`);
    }
  }
};

window.showSaleDetails = (saleId, target = "") => {
  const sale = state.sales.find((s) => s.id === saleId);
  const box = getSaleDetailsContainer(target);
  if (!box) return;
  if (!sale) { box.innerHTML = "<p>Venda não encontrada.</p>"; return; }
  const anonymousBuyerLabels = buildAnonymousBuyerLabelMap();
  const cancelled = isSaleCancelled(sale);
  const paymentLines = getSalePayments(sale).length > 1
    ? getSalePayments(sale).map((p) => `<div class="meta-line">${p.method}: ${money(p.amount)}</div>`).join("")
    : `<p>Pagamento: ${sale.paymentMethod}</p>`;
  box.innerHTML = `
    <h3 style="font-family:var(--font-head);letter-spacing:2px;margin-bottom:12px;">Venda ${sale.id.slice(0, 8)}${cancelled ? " — CANCELADA" : ""}</h3>
    <p>Data: ${new Date(sale.createdAt).toLocaleString("pt-BR")}</p>
    <p>Comprador: ${getSaleBuyerName(sale, anonymousBuyerLabels)}</p>
    <p>Telefone: ${sale.buyer?.phone || "-"}</p>
    <p>CPF/CNPJ: ${sale.buyer?.document || "-"}</p>
    ${paymentLines}
    <p>Status: ${getSalePendingStatusText(sale)}</p>
    ${sale.cancelledAt ? `<p>Cancelado em: ${new Date(sale.cancelledAt).toLocaleString("pt-BR")}${sale.cancelledByName ? ` por ${sale.cancelledByName}` : ""}</p>` : ""}
    <ul style="margin:12px 0;padding-left:16px;">${sale.items.map((i) => `<li>${i.name} (${i.code}) x${i.qty} - ${money(i.subtotal)}</li>`).join("")}</ul>
    <strong style="font-family:var(--font-head);font-size:18px;color:${cancelled ? "var(--muted)" : "var(--accent)"};${cancelled ? "text-decoration:line-through;" : ""}">Total: ${money(sale.total)}</strong>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" class="btn primary" onclick="reprintSale('${sale.id}')">🖨️ Reimprimir</button>
      ${isCancellableSale(sale) ? `<button type="button" class="btn danger" data-action="sale-cancel" data-sale-id="${sale.id}">Cancelar venda</button>` : ""}
    </div>`;
  scrollToPanel(box);
};

window.reprintSale = async (saleId) => {
  const sale = state.sales.find((s) => s.id === saleId);
  if (!sale) return;
  const payments = getSalePayments(sale);
  await doPrint(
    sale.items,
    sale.total,
    sale.paymentMethod,
    sale.buyer || {},
    sale.createdAt,
    Number(sale.cashAmountPaid || 0),
    Math.max(0, Number(sale.cashChange || 0)),
    {
      subtotal: sale.subtotal,
      discount: sale.discount,
      saleId: sale.id,
      orderNumber: sale.orderNumber,
      registerName: sale.registerName || "",
      payments
    }
  );
};

// ═══════════════════════════════════════════════════════════════
// RELATÓRIOS — filtros canal / produto
// ═══════════════════════════════════════════════════════════════
const REPORT_CHANNEL_ALL = "all";
const REPORT_CHANNEL_BALCAO = "balcao";
const REPORT_CHANNEL_DELIVERY = "delivery";

function getReportChannelFilter() {
  return document.getElementById("reportChannelFilter")?.value || REPORT_CHANNEL_ALL;
}

function getReportProductFilter() {
  return document.getElementById("reportProductFilter")?.value || "";
}

function isCountableDeliveryOrder(order) {
  if (!order) return false;
  return normalizeDeliveryStatus(order.status) === "delivered";
}

function getDeliveryOrderReportDate(order) {
  const raw = order?.deliveredAt || order?.updatedAt || order?.createdAt || "";
  return toLocalDateISO(raw);
}

function saleHasProduct(sale, productId) {
  if (!productId) return true;
  return (sale?.items || []).some((item) => item.productId === productId);
}

function deliveryOrderHasProduct(order, productId) {
  if (!productId) return true;
  return (order?.items || []).some((item) => item.productId === productId);
}

function getSaleProductAmount(sale, productId) {
  if (!productId) return Number(sale?.total || 0);
  return (sale?.items || [])
    .filter((item) => item.productId === productId)
    .reduce((sum, item) => sum + Number(item.subtotal ?? (Number(item.price || 0) * Number(item.qty || 0))), 0);
}

function getOrderProductAmount(order, productId) {
  if (!productId) return Number(order?.total || 0);
  return (order?.items || [])
    .filter((item) => item.productId === productId)
    .reduce((sum, item) => sum + Number(item.subtotal ?? (Number(item.price || 0) * Number(item.qty || 0))), 0);
}

function getSaleProductProfit(sale, productId) {
  return (sale?.items || [])
    .filter((item) => !productId || item.productId === productId)
    .reduce((sum, item) => sum + (Number(item.price || 0) - Number(item.cost || 0)) * Number(item.qty || 0), 0);
}

function getOrderProductProfit(order, productId) {
  return (order?.items || [])
    .filter((item) => !productId || item.productId === productId)
    .reduce((sum, item) => sum + (Number(item.price || 0) - Number(item.cost || 0)) * Number(item.qty || 0), 0);
}

function getFilteredBalcaoSales({ day = "", month = "", channel = "", productId = "" } = {}) {
  const ch = channel || getReportChannelFilter();
  if (ch === REPORT_CHANNEL_DELIVERY) return [];
  const pid = productId || getReportProductFilter();
  return state.sales.filter((sale) => {
    if (!isCountableSale(sale)) return false;
    if (day && !isoMatchesLocalDay(sale.createdAt, day)) return false;
    if (month && !isoMatchesLocalMonth(sale.createdAt, month)) return false;
    if (pid && !saleHasProduct(sale, pid)) return false;
    return true;
  });
}

function getFilteredDeliveryOrders({ day = "", month = "", channel = "", productId = "" } = {}) {
  const ch = channel || getReportChannelFilter();
  if (ch === REPORT_CHANNEL_BALCAO) return [];
  const pid = productId || getReportProductFilter();
  return state.deliveryOrders.filter((order) => {
    if (!isCountableDeliveryOrder(order)) return false;
    const date = getDeliveryOrderReportDate(order);
    if (day && !date.startsWith(day)) return false;
    if (month && !date.startsWith(month)) return false;
    if (pid && !deliveryOrderHasProduct(order, pid)) return false;
    return true;
  });
}

function calcProductChannelStats(productId, { day = "", month = "" } = {}) {
  const stats = { balcaoQty: 0, balcaoRevenue: 0, deliveryQty: 0, deliveryRevenue: 0, totalQty: 0, totalRevenue: 0 };
  if (!productId) return stats;

  const addItems = (items, channel) => {
    (items || []).forEach((item) => {
      if (item.productId !== productId) return;
      const qty = Number(item.qty || 0);
      const revenue = Number(item.subtotal ?? (Number(item.price || 0) * qty));
      if (channel === "balcao") {
        stats.balcaoQty += qty;
        stats.balcaoRevenue += revenue;
      } else {
        stats.deliveryQty += qty;
        stats.deliveryRevenue += revenue;
      }
    });
  };

  getFilteredBalcaoSales({ day, month, channel: REPORT_CHANNEL_BALCAO, productId }).forEach((sale) => addItems(sale.items, "balcao"));
  getFilteredDeliveryOrders({ day, month, channel: REPORT_CHANNEL_DELIVERY, productId }).forEach((order) => addItems(order.items, "delivery"));
  stats.totalQty = stats.balcaoQty + stats.deliveryQty;
  stats.totalRevenue = stats.balcaoRevenue + stats.deliveryRevenue;
  return stats;
}

function calcReportAggregate({ day = "", month = "" } = {}) {
  const productId = getReportProductFilter();
  const balcaoSales = getFilteredBalcaoSales({ day, month });
  const deliveryOrders = getFilteredDeliveryOrders({ day, month });
  let total = 0;
  let profit = 0;
  let count = 0;
  const qtyByProduct = {};

  balcaoSales.forEach((sale) => {
    const amount = getSaleProductAmount(sale, productId);
    if (productId && amount <= 0) return;
    total += amount;
    profit += getSaleProductProfit(sale, productId);
    count += 1;
    if (!productId) {
      (sale.items || []).forEach((item) => {
        qtyByProduct[item.name] = (qtyByProduct[item.name] || 0) + Number(item.qty || 0);
      });
    }
  });

  deliveryOrders.forEach((order) => {
    const amount = getOrderProductAmount(order, productId);
    if (productId && amount <= 0) return;
    total += amount;
    profit += getOrderProductProfit(order, productId);
    count += 1;
    if (!productId) {
      (order.items || []).forEach((item) => {
        qtyByProduct[item.name] = (qtyByProduct[item.name] || 0) + Number(item.qty || 0);
      });
    }
  });

  let topProduct = "-";
  if (productId) {
    const product = state.products.find((p) => p.id === productId);
    topProduct = product?.name || "-";
  } else {
    let topQty = 0;
    Object.entries(qtyByProduct).forEach(([name, qty]) => {
      if (qty > topQty) {
        topQty = qty;
        topProduct = `${name} (${qty} un.)`;
      }
    });
  }

  return { total, profit, count, topProduct, balcaoCount: balcaoSales.length, deliveryCount: deliveryOrders.length };
}

function populateReportProductFilter() {
  const sel = document.getElementById("reportProductFilter");
  if (!sel) return;
  const current = sel.value;
  const products = [...state.products].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"));
  sel.innerHTML = `<option value="">Todos os produtos</option>${products.map((p) =>
    `<option value="${p.id}" ${p.id === current ? "selected" : ""}>${p.name}</option>`
  ).join("")}`;
}

function renderReportProductStats() {
  const box = document.getElementById("reportProductStats");
  const productId = getReportProductFilter();
  if (!box) return;
  if (!productId) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const product = state.products.find((p) => p.id === productId);
  const day = document.getElementById("reportDaySelect")?.value || todayISO();
  const month = document.getElementById("reportMonthSelect")?.value || "";
  const dayStats = calcProductChannelStats(productId, { day });
  const monthStats = month ? calcProductChannelStats(productId, { month }) : null;

  const row = (label, stats) => `<tr>
    <td>${label}</td>
    <td><strong>${stats.totalQty} un.</strong><br><span style="color:var(--accent)">${money(stats.totalRevenue)}</span></td>
    <td>${stats.balcaoQty} un.<br>${money(stats.balcaoRevenue)}</td>
    <td>${stats.deliveryQty} un.<br>${money(stats.deliveryRevenue)}</td>
  </tr>`;

  const dayLabel = new Date(`${day}T12:00:00`).toLocaleDateString("pt-BR");
  const monthLabel = month
    ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleString("pt-BR", { month: "long", year: "numeric" })
    : "";

  box.innerHTML = `
    <h4 style="margin:0 0 10px;font-size:14px;">Vendas de: <strong>${product?.name || "Produto"}</strong></h4>
    <div class="table-wrap table-scroll">
      <table class="monthly-table report-product-table">
        <thead>
          <tr><th>Período</th><th>Total</th><th>Balcão</th><th>Delivery</th></tr>
        </thead>
        <tbody>
          ${row(`Dia ${dayLabel}`, dayStats)}
          ${monthStats ? row(`${monthLabel.charAt(0).toUpperCase()}${monthLabel.slice(1)}`, monthStats) : ""}
        </tbody>
      </table>
    </div>`;
  box.classList.remove("hidden");
}

function buildReportDayRows(day) {
  const productId = getReportProductFilter();
  const rows = [];

  getFilteredBalcaoSales({ day, productId }).forEach((sale) => {
    rows.push({ kind: "balcao", sortAt: sale.createdAt, sale });
  });
  getFilteredDeliveryOrders({ day, productId }).forEach((order) => {
    rows.push({
      kind: "delivery",
      sortAt: order.deliveredAt || order.updatedAt || order.createdAt,
      order
    });
  });

  return rows.sort((a, b) => String(a.sortAt).localeCompare(String(b.sortAt)));
}

function onReportsTabActivated() {
  if (requiresManagerPassword() && !hasManagerAreaAccess()) {
    leaveRestrictedTabIfLocked();
    return;
  }
  populateReportProductFilter();
  refreshDeliveryOrdersNow().catch(() => {});
  renderReports();
}

function refreshReportViews() {
  renderReportProductStats();
  renderDailySalesReport();
  renderMonthlySummary();
  const today = todayISO();
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dayAgg = calcReportAggregate({ day: document.getElementById("reportDaySelect")?.value || today });
  const monthAgg = calcReportAggregate({ month: document.getElementById("reportMonthSelect")?.value || ym });
  const todayEl = document.getElementById("reportToday");
  const monthEl = document.getElementById("reportMonth");
  const topEl = document.getElementById("reportTopProduct");
  const profitEl = document.getElementById("reportProfit");
  if (todayEl) todayEl.textContent = money(dayAgg.total);
  if (monthEl) monthEl.textContent = money(monthAgg.total);
  if (topEl) topEl.textContent = monthAgg.topProduct;
  if (profitEl) profitEl.textContent = money(monthAgg.profit);
}

// ═══════════════════════════════════════════════════════════════
// RELATÓRIOS
// ═══════════════════════════════════════════════════════════════
let _monthlyChart = null;

function renderReports() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const today = todayISO();

  populateReportProductFilter();

  const daySel = document.getElementById("reportDaySelect");
  if (daySel) {
    if (!daySel.value) daySel.value = today;
    daySel.max = today;
  }

  populateMonthSelect();
  refreshReportViews();
  const cashDaySel = document.getElementById("cashReportDaySelect");
  if (cashDaySel && !cashDaySel.value) cashDaySel.value = today;
  renderCashSessionsTable();
}

function populateMonthSelect() {
  const sel = document.getElementById("reportMonthSelect");
  if (!sel) return;
  const months = new Set();
  state.sales.forEach((s) => {
    if (s.createdAt) months.add(toLocalMonthISO(s.createdAt));
  });
  state.deliveryOrders.forEach((o) => {
    const d = getDeliveryOrderReportDate(o);
    if (d) months.add(d.slice(0, 7));
  });
  const now = new Date();
  months.add(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const sorted = [...months].sort().reverse();
  const current = sel.value || sorted[0];
  sel.innerHTML = sorted.map((m) => {
    const [y, mo] = m.split("-");
    const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleString("pt-BR", { month: "long", year: "numeric" });
    return `<option value="${m}" ${m === current ? "selected" : ""}>${label.charAt(0).toUpperCase() + label.slice(1)}</option>`;
  }).join("");
  sel.onchange = () => {
    refreshReportViews();
    document.getElementById("reportSaleDetails").innerHTML = "";
  };
}

function renderMonthlySummary() {
  const sel = document.getElementById("reportMonthSelect");
  if (!sel) return;
  const ym = sel.value;
  if (!ym) return;
  const [yyyy, mm] = ym.split("-");
  const daysInMonth = new Date(Number(yyyy), Number(mm), 0).getDate();
  const productId = getReportProductFilter();

  const byDay = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${ym}-${String(d).padStart(2, "0")}`;
    byDay[key] = { count: 0, total: 0, discount: 0, profit: 0, balcao: 0, delivery: 0 };
  }

  getFilteredBalcaoSales({ month: ym }).forEach((sale) => {
    const day = toLocalDateISO(sale.createdAt);
    if (!day || !byDay[day]) return;
    const amount = getSaleProductAmount(sale, productId);
    if (productId && amount <= 0) return;
    byDay[day].count += 1;
    byDay[day].total += amount;
    byDay[day].discount += productId ? 0 : Number(sale.discount || 0);
    byDay[day].profit += getSaleProductProfit(sale, productId);
    byDay[day].balcao += amount;
  });

  getFilteredDeliveryOrders({ month: ym }).forEach((order) => {
    const day = getDeliveryOrderReportDate(order);
    if (!day || !byDay[day]) return;
    const amount = getOrderProductAmount(order, productId);
    if (productId && amount <= 0) return;
    byDay[day].count += 1;
    byDay[day].total += amount;
    byDay[day].profit += getOrderProductProfit(order, productId);
    byDay[day].delivery += amount;
  });

  const labels = Object.keys(byDay).map((d) => d.slice(8));
  const totals = Object.values(byDay).map((d) => d.total);
  const profits = Object.values(byDay).map((d) => d.profit);

  const canvas = document.getElementById("monthlyChart");
  if (canvas) {
    if (_monthlyChart) { _monthlyChart.destroy(); _monthlyChart = null; }
    _monthlyChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Vendas (R$)",
            data: totals,
            backgroundColor: "rgba(0,229,255,0.25)",
            borderColor: "#00e5ff",
            borderWidth: 2,
            borderRadius: 4,
            order: 2
          },
          {
            label: "Lucro (R$)",
            data: profits,
            type: "line",
            borderColor: "#00e676",
            backgroundColor: "rgba(0,230,118,0.1)",
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: "#00e676",
            tension: 0.4,
            fill: true,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#8892a4", font: { size: 12 } } },
          tooltip: {
            backgroundColor: "#0f1117",
            borderColor: "#1e2535",
            borderWidth: 1,
            titleColor: "#e8eaf0",
            bodyColor: "#8892a4",
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.raw)}`
            }
          }
        },
        scales: {
          x: { ticks: { color: "#4a5568", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.03)" } },
          y: { ticks: { color: "#4a5568", font: { size: 11 }, callback: (v) => money(v) }, grid: { color: "rgba(255,255,255,0.05)" } }
        }
      }
    });
  }

  const tbody = document.getElementById("monthlyTableBody");
  if (!tbody) return;
  const rows = Object.entries(byDay).filter(([, d]) => d.count > 0);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">Nenhuma venda neste mês</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(([date, d]) => {
    const dt = new Date(date + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
    const channel = getReportChannelFilter();
    const splitInfo = channel === REPORT_CHANNEL_ALL && (d.balcao > 0 || d.delivery > 0)
      ? `<br><small style="color:var(--muted)">Balcão ${money(d.balcao)} · Delivery ${money(d.delivery)}</small>`
      : "";
    return `<tr>
      <td>${dt}</td>
      <td>${d.count}</td>
      <td style="color:var(--accent)">${money(d.total)}${splitInfo}</td>
      <td style="color:var(--yellow)">${d.discount > 0 ? "-" + money(d.discount) : "—"}</td>
      <td style="color:var(--green)">${money(d.profit)}</td>
    </tr>`;
  }).join("");
}

// ═══════════════════════════════════════════════════════════════
// RENDER ALL
// ═══════════════════════════════════════════════════════════════
function renderAll() {
  renderCompany();
  renderProducts(
    document.getElementById("searchProduct")?.value || "",
    document.getElementById("filterProductCategory")?.value || ""
  );
  renderStock(document.getElementById("stockSearch")?.value || "");
  updateStockNavAlert();
  renderCart();
  renderSales();
  renderDeliveryOrders();
  renderReports();
  renderFinance();
  updatePdvCashUI();
  updateLicenseExpiryBanner();
  updateDeliveryNavAlert();
  notifyExpiryAlerts();
  if (typeof window.refreshAIProductSelect === "function") window.refreshAIProductSelect();
}

function notifyExpiryAlerts() {
  const alerts = getExpiryAlertProducts();
  if (!alerts.length || !state.user?.uid) return;
  const key = `expiry_warn_${state.user.uid}_${todayISO()}`;
  if (sessionStorage.getItem(key)) return;
  const message = alerts
    .slice(0, 5)
    .map(({ product, meta }) => `- ${getProductLabel(product)}: vence em ${meta.daysLeft} dia(s) (${meta.dateBr})`)
    .join("\n");
  alert(`Produtos próximos da validade (até 5 dias):\n${message}`);
  sessionStorage.setItem(key, "1");
}

// ═══════════════════════════════════════════════════════════════
// MENU MOBILE — hamburguer + overlay
// ═══════════════════════════════════════════════════════════════
function setupMobileMenu() {
  const btnToggle = document.getElementById("btnMenuToggle");
  const sidebar   = document.querySelector(".sidebar");
  const overlay   = document.getElementById("sidebarOverlay");

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("visible");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("visible");
    document.body.style.overflow = "";
  }

  if (btnToggle) btnToggle.addEventListener("click", openSidebar);
  if (overlay)   overlay.addEventListener("click", closeSidebar);

  // Fecha ao trocar de aba no mobile
  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (window.innerWidth <= 1024) closeSidebar();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
function validateFirebaseConfig() {
  if (!window.FIREBASE_CONFIG) throw new Error("Arquivo firebase-config.js não encontrado.");
  const missing = Object.entries(window.FIREBASE_CONFIG).filter(([, v]) => !v || String(v).includes("COLOQUE_SEU"));
  if (missing.length) throw new Error("Preencha os dados do Firebase em firebase-config.js.");
}

// ═══════════════════════════════════════════════════════════════
// BRIDGE IA + NAVEGAÇÃO
// ═══════════════════════════════════════════════════════════════
function switchToTab(tabId) {
  const btn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (btn) btn.click();
}

function openProductFormFromAI(productId) {
  switchToTab("produtosTab");
  if (productId) {
    editProduct(productId);
  } else {
    openProductFormForNew();
  }
  setProductFormExpanded(true, { scroll: true });
}

window.PDV = {
  getProducts: () => state.products,
  getSales: () => state.sales,
  getCompany: () => state.company || {},
  getUser: () => state.user,
  getStoreRef,
  getStorage: () => storage,
  money,
  patchCompany: (patch) => {
    state.company = { ...(state.company || {}), ...patch };
  },
  switchToTab,
  applyProductPhoto: (url, productId) => {
    openProductFormFromAI(productId || document.getElementById("productId")?.value || "");
    const photoEl = document.getElementById("productPhoto");
    if (photoEl) photoEl.value = url;
    if (typeof window.refreshProductPhotoPreview === "function") window.refreshProductPhotoPreview(url);
    const zone = document.getElementById("productPhotoZone");
    if (zone) zone.classList.toggle("has-preview", Boolean(url));
  },
  applyProductDescription: (text, productId) => {
    openProductFormFromAI(productId || document.getElementById("productId")?.value || "");
    const descEl = document.getElementById("productDescription");
    if (descEl) descEl.value = text;
  },
  syncAiKeyInputs: (company) => {
    const c = company || state.company || {};
    const imgbb = c.imgbbApiKey || "";
    const gemini = c.geminiApiKey || "";
    ["companyImgBBKey", "aiImgBBKey"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = imgbb;
    });
    ["companyGeminiKey", "aiGeminiKey"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = gemini;
    });
  }
};

async function init() {
  requireAuthUI();
  try {
    validateFirebaseConfig();
    firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    storage = firebase.storage();
    if (typeof window.waitForQzSecurity === "function") {
      window.waitForQzSecurity(false).catch((err) => console.warn("QZ security:", err));
    } else if (typeof setupQZSecurity === "function") {
      setupQZSecurity(false).catch((err) => console.warn("QZ security:", err));
    }
  } catch (error) {
    hideBootScreen();
    alert(`Erro de configuração Firebase: ${error.message}`);
    return;
  }
  setupTabs();
  setupManagerPasswordModal();
  setupAuth();
  setupLicenseExpiryBanner();
  setupCompany();
  setupMultiRegisterConfig();
  setupProducts();
  setupStock();
  setupPDV();
  setupCashRegister();
  setupFinance();
  setupSales();
  setupReports();
  setupDelivery();
  setupAdmin();
  setupPrinterTest();
  setupBarcodeListener();
  setupMobileMenu();
  if (typeof window.setupAI === "function") window.setupAI();
  requireAuthUI();
}

init();