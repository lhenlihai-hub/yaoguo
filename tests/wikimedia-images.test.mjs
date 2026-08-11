// 公有领域配图检索：parseCommonsResponse 只留开放授权、提取 url/credit，兼容两种 format。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseCommonsResponse, isOpenLicense } = require("../src/platform/media/wikimediaImages.js");

const sample = {
  query: {
    pages: {
      "101": {
        title: "File:Sun Wen Red Chamber 7.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/0/08/Sun_Wen_Red_Chamber_7.jpg",
          thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/Sun_Wen_Red_Chamber_7.jpg/1000px-x.jpg",
          extmetadata: { LicenseShortName: { value: "Public domain" }, Artist: { value: "<a href=\"#\">孙温</a>" } }
        }]
      },
      "102": {
        title: "File:Modern Photo.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/x/modern.jpg",
          extmetadata: { LicenseShortName: { value: "All rights reserved" }, Artist: { value: "someone" } }
        }]
      }
    }
  }
};

test("parseCommonsResponse：只留公有领域，剥 HTML 取作者，优先 thumburl", () => {
  const rows = parseCommonsResponse(sample);
  assert.equal(rows.length, 1, "版权未开放的应被过滤");
  assert.equal(rows[0].title, "Sun Wen Red Chamber 7.jpg");
  assert.match(rows[0].url, /1000px/);
  assert.equal(rows[0].credit, "孙温", "Artist 的 HTML 应被剥除");
  assert.match(rows[0].license, /Public domain/);
});

test("parseCommonsResponse：兼容 formatversion=2 的数组 pages + 空响应", () => {
  const arr = { query: { pages: [sample.query.pages["101"]] } };
  assert.equal(parseCommonsResponse(arr).length, 1);
  assert.deepEqual(parseCommonsResponse({}), []);
  assert.deepEqual(parseCommonsResponse(null), []);
});

test("isOpenLicense：接受 BY/BY-SA，拒绝 NC/ND", () => {
  assert.equal(isOpenLicense("CC BY 4.0"), true);
  assert.equal(isOpenLicense("CC-BY-SA-4.0"), true);
  assert.equal(isOpenLicense("CC BY-NC 4.0"), false);
  assert.equal(isOpenLicense("CC BY-ND 4.0"), false);
  assert.equal(isOpenLicense("CC BY-NC-ND 4.0"), false);
});
