/**
 * Regras puras do cardápio: escolhas do combo e cálculo da taxa de entrega.
 * Usado pelo painel, pelo cardápio e pelos testes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DeliveryLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function normalizeDeliveryFeeZones(zones) {
    const used = new Set();
    return (Array.isArray(zones) ? zones : []).map((zone) => {
      const name = String(zone?.name || "").trim();
      if (!name) return null;
      let id = String(zone?.id || "").trim();
      if (!id || used.has(id)) {
        const base = name
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "bairro";
        id = base;
        let n = 2;
        while (used.has(id)) id = `${base}-${n++}`;
      }
      used.add(id);
      return {
        id,
        name,
        fee: roundMoney(Math.max(0, Number(zone?.fee || 0)))
      };
    }).filter(Boolean);
  }

  function getDeliveryFeeMode(store) {
    const mode = String(store?.deliveryFeeMode || "").trim();
    if (mode === "zones" || mode === "flat") return mode;
    return normalizeDeliveryFeeZones(store?.deliveryFeeZones).length ? "zones" : "flat";
  }

  function calculateDeliveryFee(store, zoneId) {
    const mode = getDeliveryFeeMode(store);
    const zones = normalizeDeliveryFeeZones(store?.deliveryFeeZones);
    const flatFee = roundMoney(Math.max(0, Number(store?.deliveryFee || 0)));
    if (mode !== "zones" || !zones.length) {
      return { mode: "flat", fee: flatFee, zone: null, needsZone: false, zones };
    }
    const zone = zones.find((item) => item.id === String(zoneId || "")) || null;
    if (!zone) {
      return { mode: "zones", fee: 0, zone: null, needsZone: true, zones };
    }
    return { mode: "zones", fee: zone.fee, zone, needsZone: false, zones };
  }

  function normalizeComboGroups(groups) {
    const used = new Set();
    return (Array.isArray(groups) ? groups : []).map((group, index) => {
      const name = String(group?.name || "").trim();
      if (!name) return null;
      let id = String(group?.id || "").trim() || `grp_${index + 1}`;
      if (used.has(id)) id = `${id}_${index + 1}`;
      used.add(id);
      const fixedQty = Math.max(0, Number(group?.fixedQty || 0));
      const options = (Array.isArray(group?.options) ? group.options : []).map((opt) => {
        const productId = String(opt?.productId || "").trim();
        if (!productId) return null;
        return {
          productId,
          extraPrice: roundMoney(Math.max(0, Number(opt?.extraPrice || 0))),
          qty: fixedQty > 0 ? fixedQty : Math.max(0, Number(opt?.qty || 0))
        };
      }).filter(Boolean);
      if (!options.length) return null;
      const replacesProductId = String(group?.replacesProductId || "").trim();
      const replacesProductIds = (Array.isArray(group?.replacesProductIds) ? group.replacesProductIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean);
      return {
        id,
        name,
        replacesProductId,
        replacesProductIds: replacesProductIds.length ? replacesProductIds : (replacesProductId ? [replacesProductId] : []),
        options
      };
    }).filter(Boolean);
  }

  function componentServingAmount(row, ingredient) {
    const ml = Math.max(0, Number(row?.ml || 0));
    const units = Math.max(0, Math.floor(Number(row?.qty || 0)));
    const mode = String(ingredient?.stockMode || "");
    if (mode === "ml" || (mode !== "unit" && ml > 0)) {
      const amount = ml > 0 ? ml : 50;
      return { ml: amount > 2000 ? 50 : amount, qty: 0 };
    }
    const qty = units > 0 ? units : 1;
    return { ml: 0, qty: qty > 30 ? 1 : qty };
  }

  function ingredientCategoryKey(ingredient) {
    const id = String(ingredient?.categoryId || "").trim();
    if (id) return `id:${id}`;
    const name = String(ingredient?.category || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    return name ? `name:${name}` : "";
  }

  function comboStockParts(product, findProduct) {
    const recipe = Array.isArray(product?.doseRecipe) ? product.doseRecipe : [];
    const groups = [];
    const fixed = [];
    const plain = [];
    const lookup = typeof findProduct === "function" ? findProduct : () => null;
    recipe.forEach((row, index) => {
      const productId = String(row?.productId || "").trim();
      if (!productId) return;
      const ingredient = lookup(productId);
      const serving = componentServingAmount(row, ingredient);
      const rawOptions = (Array.isArray(row?.options) ? row.options : [])
        .filter((opt) => String(opt?.productId || "").trim());
      if (rawOptions.length) {
        const fixedQty = serving.ml > 0 ? serving.ml : (serving.qty > 0 ? serving.qty : 1);
        groups.push({
          id: String(row?.choiceId || "").trim() || `insumo_${index + 1}`,
          name: String(row?.choiceName || "").trim() || "Sabor",
          replacesProductId: productId,
          replacesProductIds: [productId],
          fixedQty,
          options: rawOptions.map((opt) => ({
            productId: String(opt.productId).trim(),
            extraPrice: opt.extraPrice || 0,
            qty: fixedQty
          }))
        });
        return;
      }
      plain.push({ productId, ingredient, serving });
    });
    const buckets = new Map();
    plain.forEach((entry) => {
      const categoryKey = ingredientCategoryKey(entry.ingredient);
      const mode = String(entry.ingredient?.stockMode || "unit");
      const bucketKey = categoryKey ? `${categoryKey}|${mode}` : "";
      if (!bucketKey) {
        fixed.push(entry);
        return;
      }
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      buckets.get(bucketKey).push(entry);
    });
    buckets.forEach((entries, key) => {
      if (entries.length < 2) {
        fixed.push(entries[0]);
        return;
      }
      const fixedQty = entries[0].serving.ml > 0 ? entries[0].serving.ml : entries[0].serving.qty;
      groups.push({
        id: `cat_${key.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        name: String(entries[0].ingredient?.category || "Sabor").trim() || "Sabor",
        replacesProductId: "",
        replacesProductIds: entries.map((entry) => entry.productId),
        fixedQty,
        options: entries.map((entry) => ({
          productId: entry.productId,
          extraPrice: 0,
          qty: entry.serving.ml > 0 ? entry.serving.ml : entry.serving.qty
        }))
      });
    });
    const normalized = normalizeComboGroups(groups);
    if (!normalized.length) {
      return {
        fixed: fixed.map((entry) => ({ productId: entry.productId, ml: entry.serving.ml, qty: entry.serving.qty })),
        groups: normalizeComboGroups(product?.comboGroups)
      };
    }
    return {
      fixed: fixed.map((entry) => ({ productId: entry.productId, ml: entry.serving.ml, qty: entry.serving.qty })),
      groups: normalized
    };
  }

  function comboChoicesFromProduct(product, findProduct) {
    return comboStockParts(product, findProduct).groups;
  }

  function menuCategoryTabs(nodes, products) {
    const list = Array.isArray(nodes) ? nodes : [];
    const byId = new Map(list.filter((node) => node && node.id && node.name).map((node) => [String(node.id), node]));
    const map = new Map();
    (Array.isArray(products) ? products : []).forEach((product) => {
      const categoryId = String(product?.categoryId || "").trim();
      let label = "";
      if (categoryId && byId.has(categoryId)) {
        const parts = [];
        let current = byId.get(categoryId);
        let guard = 0;
        while (current && guard < 20) {
          parts.unshift(current.name);
          current = current.parentId ? byId.get(String(current.parentId)) : null;
          guard += 1;
        }
        label = parts.join(" › ");
      }
      if (!label) label = String(product?.category || "").trim() || "Outros";
      const key = label
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
      const value = categoryId && byId.has(categoryId) ? categoryId : `name:${key}`;
      const current = map.get(key);
      if (!current) map.set(key, { value, label });
      else if (byId.has(value)) current.value = value;
    });
    const order = new Map(list.map((node, index) => [String(node.id), Number(node.order ?? index)]));
    return [...map.values()].sort((a, b) =>
      (order.get(a.value) ?? 9999) - (order.get(b.value) ?? 9999)
      || a.label.localeCompare(b.label, "pt-BR")
    );
  }

  function comboUnitPrice(basePrice, selections) {
    const extra = (Array.isArray(selections) ? selections : []).reduce(
      (sum, sel) => sum + Math.max(0, Number(sel?.extraPrice || 0)),
      0
    );
    return roundMoney(Math.max(0, Number(basePrice || 0)) + extra);
  }

  function comboSelectionKey(productId, selections) {
    const parts = (Array.isArray(selections) ? selections : [])
      .map((sel) => `${sel.groupId || sel.groupName || ""}:${sel.productId || ""}`)
      .join("|");
    return `${productId}::${parts}`;
  }

  return {
    roundMoney,
    normalizeDeliveryFeeZones,
    getDeliveryFeeMode,
    calculateDeliveryFee,
    normalizeComboGroups,
    componentServingAmount,
    comboStockParts,
    comboChoicesFromProduct,
    menuCategoryTabs,
    comboUnitPrice,
    comboSelectionKey
  };
});
