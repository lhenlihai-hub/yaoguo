function decodeHtmlEntities(value = "") {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return `${value}`.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    }
    return named[lower] || `&${entity};`;
  });
}

function htmlToText(html = "") {
  return decodeHtmlEntities(`${html}`)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstXmlValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return htmlToText(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, ""));
}

function parseRssItems(xml = "") {
  return Array.from(`${xml}`.matchAll(/<item\b[\s\S]*?<\/item>/gi)).map((match) => {
    const block = match[0];
    return {
      title: firstXmlValue(block, "title"),
      url: decodeHtmlEntities(firstXmlValue(block, "link")),
      snippet: firstXmlValue(block, "description"),
      datePublished: firstXmlValue(block, "pubDate")
    };
  }).filter((item) => item.title && item.url);
}

module.exports = {
  decodeHtmlEntities,
  htmlToText,
  firstXmlValue,
  parseRssItems
};
