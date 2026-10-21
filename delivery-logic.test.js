const assert = require("assert");
const logic = require("./delivery-logic.js");

const flat = logic.calculateDeliveryFee({ deliveryFeeMode: "flat", deliveryFee: 7.5 }, "");
assert.strictEqual(flat.mode, "flat");
assert.strictEqual(flat.fee, 7.5);
assert.strictEqual(flat.needsZone, false);

const zones = [
  { name: "Centro", fee: 5 },
  { name: "Centro", fee: 8 },
  { name: "Vila Nova", fee: 12.5 }
];
const normalized = logic.normalizeDeliveryFeeZones(zones);
assert.strictEqual(normalized.length, 3);
assert.notStrictEqual(normalized[0].id, normalized[1].id);
assert.strictEqual(normalized[2].fee, 12.5);

const pending = logic.calculateDeliveryFee({ deliveryFeeMode: "zones", deliveryFee: 99, deliveryFeeZones: normalized }, "");
assert.strictEqual(pending.needsZone, true);
assert.strictEqual(pending.fee, 0);

const chosen = logic.calculateDeliveryFee(
  { deliveryFeeMode: "zones", deliveryFeeZones: normalized },
  normalized[2].id
);
assert.strictEqual(chosen.needsZone, false);
assert.strictEqual(chosen.fee, 12.5);
assert.strictEqual(chosen.zone.name, "Vila Nova");

const emptyZones = logic.calculateDeliveryFee({ deliveryFeeMode: "zones", deliveryFee: 4, deliveryFeeZones: [] }, "");
assert.strictEqual(emptyZones.mode, "flat");
assert.strictEqual(emptyZones.fee, 4);

const groups = logic.normalizeComboGroups([
  { name: " Marca ", options: [{ productId: "a", extraPrice: 2 }, { productId: "" }] },
  { name: "", options: [{ productId: "b" }] },
  { name: "Sabor", options: [{ productId: "c", extraPrice: -3, qty: 50 }] }
]);
assert.strictEqual(groups.length, 2);
assert.strictEqual(groups[0].options.length, 1);
assert.strictEqual(groups[1].options[0].extraPrice, 0);
assert.strictEqual(groups[1].options[0].qty, 50);

assert.strictEqual(logic.comboUnitPrice(20, [
  { extraPrice: 2 },
  { extraPrice: 3.5 }
]), 25.5);
assert.strictEqual(
  logic.comboSelectionKey("combo1", [{ groupId: "g1", productId: "a" }, { groupId: "g2", productId: "c" }]),
  "combo1::g1:a|g2:c"
);

const fromInsumo = logic.comboChoicesFromProduct({
  doseRecipe: [
    { productId: "gelo", ml: 0, qty: 1 },
    {
      productId: "energetico",
      ml: 0,
      qty: 1,
      choiceName: "Sabor",
      options: [
        { productId: "redbull", extraPrice: 0, qty: 9 },
        { productId: "monster", extraPrice: 2 }
      ]
    }
  ]
});
assert.strictEqual(fromInsumo.length, 1);
assert.strictEqual(fromInsumo[0].name, "Sabor");
assert.strictEqual(fromInsumo[0].replacesProductId, "energetico");
assert.strictEqual(fromInsumo[0].options[0].qty, 1);
assert.strictEqual(fromInsumo[0].options[1].qty, 1);
assert.strictEqual(fromInsumo[0].options[1].extraPrice, 2);

const catalog = {
  cereja: { id: "cereja", name: "Red Bull Cereja", stockMode: "unit", category: "Energéticos", categoryId: "energy" },
  tropical: { id: "tropical", name: "Red Bull Tropical", stockMode: "unit", category: "Energéticos", categoryId: "energy" },
  coco: { id: "coco", name: "Gelo de Coco", stockMode: "unit", category: "GELOS", categoryId: "gelo" },
  morango: { id: "morango", name: "Gelo de Morango", stockMode: "unit", category: "GELOS", categoryId: "gelo" },
  baly: { id: "baly", name: "Baly Tropical", stockMode: "unit", category: "Energéticos", categoryId: "energy" }
};
const listedFlavors = logic.comboStockParts({
  doseRecipe: [
    { productId: "cereja", qty: 10000 },
    { productId: "tropical", qty: 10000 },
    { productId: "coco", qty: 10000 },
    { productId: "morango", qty: 10000 },
    { productId: "baly", qty: 10000 }
  ]
}, (id) => catalog[id]);
assert.strictEqual(listedFlavors.groups.length, 2);
assert.strictEqual(listedFlavors.fixed.length, 0);
const geloGroup = listedFlavors.groups.find((group) => group.name === "GELOS");
const energyGroup = listedFlavors.groups.find((group) => group.name === "Energéticos");
assert.strictEqual(geloGroup.options.length, 2);
assert.strictEqual(energyGroup.options.length, 3);
assert.strictEqual(geloGroup.options[0].qty, 1);
const singleFlavor = logic.comboStockParts({
  doseRecipe: [{ productId: "baly", qty: 10000 }]
}, (id) => catalog[id]);
assert.strictEqual(singleFlavor.groups.length, 0);
assert.strictEqual(singleFlavor.fixed[0].qty, 1);
assert.strictEqual(logic.componentServingAmount({ ml: 150, qty: 0 }, { stockMode: "ml" }).ml, 150);

const legacy = logic.comboChoicesFromProduct({
  doseRecipe: [{ productId: "gelo", qty: 1 }],
  comboGroups: [{ name: "Marca", options: [{ productId: "jack", qty: 50 }] }]
});
assert.strictEqual(legacy.length, 1);
assert.strictEqual(legacy[0].options[0].qty, 50);

const tabs = logic.menuCategoryTabs(
  [
    { id: "dest", name: "Destilados", parentId: "", order: 1 },
    { id: "whisky", name: "Whisky", parentId: "dest", order: 0 },
    { id: "combos", name: "Combos", parentId: "", order: 2 }
  ],
  [
    { name: "Jack", categoryId: "whisky", category: "Destilados › Whisky" },
    { name: "Combo Red Bull", categoryId: "combos", category: "Combos" },
    { name: "Combo novo", category: "Especiais" }
  ]
);
assert.deepStrictEqual(tabs.map((tab) => tab.label), ["Destilados › Whisky", "Combos", "Especiais"]);
assert.strictEqual(tabs[1].value, "combos");
assert.strictEqual(tabs[2].value, "name:especiais");

console.log("delivery-logic tests ok");
