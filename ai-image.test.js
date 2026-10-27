const assert = require("assert");
const fs = require("fs");
const path = require("path");
const upload = require("./ai.js");

assert.strictEqual(upload.shouldTranscodeToJpeg({ type: "image/webp", name: "shopping.webp" }), true);
assert.strictEqual(upload.shouldTranscodeToJpeg({ type: "", name: "shopping.webp" }), true);
assert.strictEqual(upload.shouldTranscodeToJpeg({ type: "image/gif", name: "foto.gif" }), true);
assert.strictEqual(upload.shouldTranscodeToJpeg({ type: "image/jpeg", name: "foto.jpg" }), false);
assert.strictEqual(upload.shouldTranscodeToJpeg({ type: "image/png", name: "foto.png" }), false);

assert.strictEqual(upload.imageBaseName({ name: "shopping.webp" }), "produto");
assert.strictEqual(upload.imageBaseName({ name: "Beefeater 700.jpg" }), "Beefeater700");
assert.strictEqual(upload.imageBaseName({ name: "" }), "produto");

assert.strictEqual(
  upload.extractImageUrlFromHtml('<a href="https://www.google.com/url?sa=i"><img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:abc"></a>'),
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:abc"
);
assert.strictEqual(upload.extractImageUrlFromHtml("<img src='data:image/png;base64,aaaa'>"), "data:image/png;base64,aaaa");
assert.strictEqual(upload.extractImageUrlFromHtml("<p>sem foto</p>"), "");

assert.strictEqual(
  upload.extractHttpUrl("https://www.google.com/imgres?imgurl=1\nhttps://exemplo.com/garrafa.jpg"),
  "https://exemplo.com/garrafa.jpg"
);
assert.strictEqual(upload.extractHttpUrl("texto solto"), "");

const urls = upload.imgbbCandidateUrls({
  data: {
    url: "https://i.ibb.co/abc/shopping.webp",
    display_url: "https://i.ibb.co/xyz/shopping.webp",
    image: { url: "https://i.ibb.co/abc/shopping.webp" }
  }
});
assert.strictEqual(urls[0], "https://i.ibb.co/xyz/shopping.webp");
assert.ok(urls.includes("https://i.ibb.co/abc/shopping.webp"));
assert.ok(urls.includes("https://i.ibb.co/xyz/shopping.jpg"));
assert.ok(urls.indexOf("https://i.ibb.co/xyz/shopping.webp") < urls.indexOf("https://i.ibb.co/xyz/shopping.jpg"));
assert.strictEqual(new Set(urls).size, urls.length);

(async () => {
  const placeholder = fs.readFileSync(path.join(__dirname, "test", "imgbb-service-unavailable.png"));
  assert.strictEqual(placeholder.length, 1115);
  assert.strictEqual(await upload.isImgbbPlaceholderBuffer(placeholder), true);
  assert.strictEqual(await upload.isImgbbPlaceholderBuffer(placeholder.subarray(0, 100)), false);
  const almost = Buffer.alloc(1115, 1);
  assert.strictEqual(await upload.isImgbbPlaceholderBuffer(almost), false);

  await assert.rejects(
    () => upload.resolveDroppedImage({
      files: [new File([placeholder], "shopping.webp", { type: "image/webp" })],
      getData: () => ""
    }),
    /service unavailable/
  );

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const jpeg = await upload.resolveDroppedImage({
    files: [new File([jpegBytes], "garrafa.jpg", { type: "image/jpeg" })],
    getData: (kind) => (kind === "text/html" ? '<img src="https://cdn.exemplo/garrafa.jpg">' : "")
  });
  assert.strictEqual(jpeg.name, "garrafa.jpg");
  assert.strictEqual(jpeg.type, "image/jpeg");

  console.log("ai-image tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
