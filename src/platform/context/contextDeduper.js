// @ts-check

function normalizeContextFingerprint(value = "") {
  return `${value || ""}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u200b-\u200d\ufeff]+/g, "")
    .replace(/[【】\[\]（）()<>《》“”‘’"'`：:，,。.!！?？；;、_-]+/g, "");
}

function isDuplicateFingerprint(candidate = "", accepted = "") {
  if (!candidate || !accepted) return false;
  if (candidate === accepted) return true;
  const shorter = candidate.length <= accepted.length ? candidate : accepted;
  const longer = candidate.length > accepted.length ? candidate : accepted;
  if (shorter.length < 24) return false;
  return longer.includes(shorter) && shorter.length / Math.max(1, longer.length) >= 0.72;
}

/**
 * @param {Array<{key?: string, label?: string, content?: string, priority?: number, protected?: boolean}>} sections
 */
function dedupeContextSections(sections = []) {
  const rows = sections
    .map((section, index) => ({
      ...section,
      index,
      content: `${section?.content || ""}`.trim(),
      fingerprint: normalizeContextFingerprint(section?.content || ""),
      priority: Number.isFinite(section?.priority) ? Number(section.priority) : 0
    }))
    .filter((section) => section.content);
  const ranked = [...rows].sort((a, b) => (
    Number(Boolean(b.protected)) - Number(Boolean(a.protected))
    || b.priority - a.priority
    || a.index - b.index
  ));
  const accepted = [];
  const dropped = [];
  for (const row of ranked) {
    const duplicate = accepted.find((item) => isDuplicateFingerprint(row.fingerprint, item.fingerprint));
    if (duplicate) {
      dropped.push({ key: row.key || "", duplicateOf: duplicate.key || "", reason: "duplicate-content" });
      continue;
    }
    accepted.push(row);
  }
  const acceptedIndexes = new Set(accepted.map((item) => item.index));
  return {
    included: rows.filter((item) => acceptedIndexes.has(item.index)).map(({ index, fingerprint, ...item }) => item),
    dropped
  };
}

function composeUniqueLabeledText(sections = []) {
  const { included } = dedupeContextSections(sections);
  return included
    .map((section) => section.label ? `${section.label}：${section.content}` : section.content)
    .join("\n");
}

module.exports = {
  normalizeContextFingerprint,
  isDuplicateFingerprint,
  dedupeContextSections,
  composeUniqueLabeledText
};
