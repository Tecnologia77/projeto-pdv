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
      return {
        id,
        name,
        replacesProductId: String(group?.replacesProductId || "").trim(),
        options
      };
    }).filter(Boolean);
  }

  function comboChoicesFromProduct(product) {
    const recipe = Array.isArray(product?.doseRecipe) ? product.doseRecipe : [];
    const fromRecipe = [];
    recipe.forEach((row, index) => {
      const rawOptions = (Array.isArray(row?.options) ? row.options : []).filter((opt) => String(opt?.productId || "").trim());
      if (!rawOptions.length) return;
      const ml = Math.max(0, Number(row?.ml || 0));
      const units = Math.max(0, Number(row?.qty || 0));
      const fixedQty = ml > 0 ? ml : (units > 0 ? units : 1);
      fromRecipe.push({
        id: String(row?.choiceId || "").trim() || `insumo_${index + 1}`,
        name: String(row?.choiceName || "").trim() || "Sabor",
        replacesProductId: String(row?.productId || "").trim(),
        fixedQty,
        options: rawOptions.map((opt) => ({
          productId: String(opt.productId).trim(),
          extraPrice: opt.extraPrice || 0,
          qty: fixedQty
        }))
      });
    });
    if (fromRecipe.length) return normalizeComboGroups(fromRecipe);
    return normalizeComboGroups(product?.comboGroups);
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
    comboChoicesFromProduct,
    comboUnitPrice,
    comboSelectionKey
  };
});
