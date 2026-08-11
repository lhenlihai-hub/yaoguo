import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readImageMetadata } = require("../src/platform/media/imageMetadata.js");
const { normalizeImages } = require("../workspace/registries/skills/pptx/scripts/create.js");

function png(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("安全图片元数据解析器只读取有界头部，支持常用格式", () => {
  assert.deepEqual(readImageMetadata(png(640, 480)), { type: "png", width: 640, height: 480 });

  const gif = Buffer.alloc(10);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(readImageMetadata(gif), { type: "gif", width: 320, height: 200 });

  const jpeg = Buffer.from("ffd8ffc0000b08006400c803011100ffd9", "hex");
  assert.deepEqual(readImageMetadata(jpeg), { type: "jpg", width: 200, height: 100 });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  webp[24] = 255;
  webp[27] = 127;
  assert.deepEqual(readImageMetadata(webp), { type: "webp", width: 256, height: 128 });

  assert.deepEqual(
    readImageMetadata(Buffer.from('<svg viewBox="0 0 1200 630"></svg>')),
    { type: "svg", width: 1200, height: 630 }
  );
});

test("危险或损坏图片不调用通用探测器，而是有界失败", () => {
  for (const payload of [
    Buffer.from("icns00000000", "ascii"),
    Buffer.from([0xff, 0x0a, 0, 0, 0, 0]),
    Buffer.alloc(128, 0xff)
  ]) {
    assert.throws(() => readImageMetadata(payload), (error) => error.code === "IMAGE_METADATA_INVALID");
  }
  assert.throws(() => readImageMetadata(png(100000, 100000)), /safe|\u5b89全上限/);
});

test("PPT Skill 只接收宿主已验证的尺寸，不在子进程重复解析图片", () => {
  const data = `data:image/png;base64,${png(10, 20).toString("base64")}`;
  const warnings = [];
  assert.deepEqual(normalizeImages([{ data, width: 10, height: 20, title: "安全图片" }], warnings), [{
    data,
    width: 10,
    height: 20,
    title: "安全图片",
    credit: ""
  }]);
  assert.deepEqual(warnings, []);

  const rejectedWarnings = [];
  assert.deepEqual(normalizeImages([{ data, width: -1, height: 20 }], rejectedWarnings), []);
  assert.equal(rejectedWarnings.length, 1);
});
