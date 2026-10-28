const assert = require("assert");
const fs = require("fs");
const path = require("path");
const restore = require("./photo-restore.js");

assert.strictEqual(restore.isImgbb("https://i.ibb.co/abc/shopping.webp"), true);
assert.strictEqual(restore.isImgbb("https://example.com/foto.jpg"), false);
assert.strictEqual(restore.isImgbb("blob:https://pdvstock.com.br/123"), false);

assert.strictEqual(
  restore.cleanUrl("https://i.ibb.co/abc/shopping.webp?pdv=123"),
  "https://i.ibb.co/abc/shopping.webp"
);
assert.strictEqual(
  restore.cleanUrl("https://i.ibb.co/abc/shopping.webp?x=1&pdv=2"),
  "https://i.ibb.co/abc/shopping.webp?x=1"
);

const urls = restore.candidateUrls("https://i.ibb.co/abc/shopping.webp");
assert.strictEqual(urls[0], "https://i.ibb.co/abc/shopping.webp");
assert.ok(urls.includes("https://i.ibb.co/abc/shopping.jpg"));
assert.ok(urls.includes("https://i.ibb.co/abc/shopping.png"));
assert.ok(!urls.includes("https://i.ibb.co/abc/shopping.webp.webp"));
assert.strictEqual(new Set(urls).size, urls.length);

(async () => {
  const placeholder = fs.readFileSync(path.join(__dirname, "test", "imgbb-service-unavailable.png"));
  assert.strictEqual(await restore.isPlaceholderBuffer(placeholder), true);
  assert.strictEqual(await restore.isPlaceholderBuffer(placeholder.subarray(0, 100)), false);
  assert.strictEqual(await restore.isPlaceholderBuffer(Buffer.alloc(1115, 7)), false);
  const real = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  assert.strictEqual(await restore.isPlaceholderBuffer(real), false);
  console.log("photo-restore tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
