// @ts-check

const INCLUDE_LINE = /^\s*@include\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/;

function parseInstructionSource(content = "", { allowPat = false } = {}) {
  const normalized = stripHtmlComments(`${content || ""}`.replace(/\r\n?/g, "\n"));
  const frontMatter = splitFrontMatter(normalized);
  if (!allowPat || !frontMatter.header) {
    return { body: frontMatter.body, patterns: null, patternError: "" };
  }
  const parsed = parsePat(frontMatter.header);
  return {
    body: frontMatter.body,
    patterns: parsed.patterns,
    patternError: parsed.error
  };
}

function stripHtmlComments(content = "") {
  return `${content || ""}`.replace(/<!--[\s\S]*?-->/g, "");
}

function splitFrontMatter(content = "") {
  if (!content.startsWith("---\n")) return { header: "", body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { header: "", body: content };
  return {
    header: content.slice(4, end),
    body: content.slice(end + 5)
  };
}

function parsePat(header = "") {
  const lines = `${header || ""}`.split("\n");
  let found = false;
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*pat\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    found = true;
    const inline = match[1];
    if (inline) {
      values.push(...parseInlinePat(inline));
      continue;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor].match(/^\s+-\s+(.+?)\s*$/);
      if (!item) break;
      values.push(parseScalar(item[1]));
      index = cursor;
    }
  }
  if (!found) return { patterns: null, error: "" };
  if (values.some((value) => typeof value !== "string")) {
    return { patterns: null, error: "pat 只接受字符串" };
  }
  const clean = values.map((value) => value.trim()).filter(Boolean);
  if (!clean.length || clean.length > 32) {
    return { patterns: null, error: "pat 必须包含 1–32 个非空字符串" };
  }
  return { patterns: clean, error: "" };
}

function parseInlinePat(value = "") {
  const source = `${value || ""}`.trim();
  if (!source.startsWith("[") || !source.endsWith("]")) return [parseScalar(source)];
  const inner = source.slice(1, -1).trim();
  if (!inner) return [];
  return splitInlineList(inner).map(parseScalar);
}

function splitInlineList(value = "") {
  const parts = [];
  let quote = "";
  let current = "";
  for (const char of value) {
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? "" : char;
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function parseScalar(value = "") {
  const source = `${value || ""}`.trim();
  if (source.startsWith("\"") && source.endsWith("\"")) {
    try {
      const parsed = JSON.parse(source);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (source.startsWith("'") && source.endsWith("'")) {
    return source.slice(1, -1).replace(/''/g, "'");
  }
  const unquoted = source.replace(/\s+#.*$/, "").trim();
  if (/^(?:true|false|null|~|[-+]?(?:\d+(?:\.\d*)?|\.\d+))$/i.test(unquoted)) return null;
  if (/^[{}]/.test(unquoted)) return null;
  return unquoted;
}

function parseIncludeLine(line = "") {
  const match = `${line || ""}`.match(INCLUDE_LINE);
  return match ? `${match[1] || match[2] || match[3] || ""}`.trim() : "";
}

function neutralizeInstructionTags(content = "") {
  return `${content || ""}`.replace(
    /<\/?(?:system-reminder|instruction-memory|instruction-document)(?:\s[^>]*)?>/gi,
    (value) => value.replace("<", "&lt;").replace(">", "&gt;")
  );
}

module.exports = {
  parseInstructionSource,
  parseIncludeLine,
  neutralizeInstructionTags,
  stripHtmlComments
};
