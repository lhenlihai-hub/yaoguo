// OOXML 格式共享的交付内容检查。格式脚本负责结构，本模块负责跨格式的内部协议泄漏。

const fsp = require("node:fs/promises");
const JSZip = require("jszip");
const { containsToolProtocol } = require("../shared/internalToolProtocol");

const CONTENT_PARTS = Object.freeze({
  docx: /^(?:word\/(?:document|footnotes|endnotes|comments)\.xml|word\/(?:header|footer)\d+\.xml)$/i,
  pptx: /^ppt\/(?:slides|notesSlides)\/[^/]+\.xml$/i,
  xlsx: /^(?:xl\/sharedStrings\.xml|xl\/workbook\.xml|xl\/worksheets\/[^/]+\.xml)$/i
});

async function findInternalProtocolLeak(inputPath = "", format = "") {
  const partPattern = CONTENT_PARTS[`${format || ""}`.toLowerCase()];
  if (!partPattern) return null;
  const zip = await JSZip.loadAsync(await fsp.readFile(inputPath));
  const parts = Object.keys(zip.files).filter((name) => partPattern.test(name)).sort();
  for (const part of parts) {
    const file = zip.file(part);
    if (!file) continue;
    const xml = await file.async("string");
    if (containsToolProtocol(xml)) return { part };
  }
  return null;
}

module.exports = {
  findInternalProtocolLeak
};
