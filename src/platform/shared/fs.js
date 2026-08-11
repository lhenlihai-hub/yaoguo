// @ts-check

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function ensureDir(dir) {
  if (!dir) return;
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function cloneFallback(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

async function readJson(file, fallback = null) {
  if (!(await exists(file))) return cloneFallback(fallback);
  const content = await fsp.readFile(file, "utf8");
  if (!content.trim()) return cloneFallback(fallback);
  return JSON.parse(content);
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(temp, file);
}

async function writeTextAtomic(file, text = "") {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, `${text}`, "utf8");
  await fsp.rename(temp, file);
}

async function appendText(file, text = "") {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${text}`, "utf8");
}

async function appendJsonl(file, row = {}) {
  await appendText(file, `${JSON.stringify(row)}\n`);
}

async function listJsonFiles(dir) {
  if (!(await exists(dir))) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(absolute);
    }
  }
  return files.sort();
}

module.exports = {
  ensureDir,
  exists,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
  appendText,
  appendJsonl,
  listJsonFiles
};
