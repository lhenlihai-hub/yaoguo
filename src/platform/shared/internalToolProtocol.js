// 内部工具协议的唯一识别规则。聊天净化和所有 OOXML 交付校验共用此模块。

function normalizeProtocolText(value = "") {
  return `${value || ""}`
    .replace(/[｜︱]/g, "|")
    .replace(/&lt;|&#60;|&#x3c;/gi, "<")
    .replace(/&gt;|&#62;|&#x3e;/gi, ">")
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&amp;/gi, "&");
}

function containsToolProtocol(content = "") {
  const text = normalizeProtocolText(content);
  return /(?:\bDSML\b[\s\S]{0,240}(?:tool[_ -]?calls?|invoke|parameter)|<\/?tool[_ -]?calls?\b|<\/?invoke\b[^>]{0,240}\bname\s*=|<\/?parameter\b[^>]{0,240}\bname\s*=)/i.test(text);
}

function classifyToolProtocolLine(line = "") {
  const text = normalizeProtocolText(line).trim();
  const closes = /(?:<\/[^>]*\bDSML\b[^>]*tool[_ -]?calls?[^>]*>|<\/tool[_ -]?calls?\s*>)/i.test(text);
  const opens = !closes && /(?:<[^>]*\bDSML\b[^>]*tool[_ -]?calls?[^>]*>|<tool[_ -]?calls?\b[^>]*>)/i.test(text);
  return { text, opens, closes, protocol: containsToolProtocol(text) };
}

function stripInternalToolProtocol(content = "") {
  const lines = `${content || ""}`.split(/\r?\n/);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    const { opens, closes, protocol } = classifyToolProtocolLine(line);
    if (inside || opens) {
      inside = !closes;
      continue;
    }
    if (protocol) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  normalizeProtocolText,
  containsToolProtocol,
  classifyToolProtocolLine,
  stripInternalToolProtocol
};
