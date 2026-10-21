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

console.log("delivery-logic tests ok");
