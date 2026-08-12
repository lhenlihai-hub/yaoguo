// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { constants: fsConstants } = require("node:fs");
const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const { readImageMetadata } = require("../../media/imageMetadata");
const { isPathInside } = require("../../shared/pathSafety");
const { containsToolProtocol } = require("../../shared/internalToolProtocol");

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".css", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx", ".csv", ".tsv", ".xml", ".svg", ".yaml", ".yml"
]);
const IMAGE_EXTENSIONS = new Set([
  ".bmp", ".gif", ".ico", ".jpeg", ".jpg",
  ".png", ".psd", ".svg", ".tif", ".tiff", ".webp"
]);
const MAX_INSPECTION_BYTES = 128 * 1024 * 1024;
const MAX_OFFICE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 256 * 1024 * 1024;

const INSPECT_ARTIFACT_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "inspect_artifact",
    description: [
      "读取一个候选文件的真实落盘内容，并返回不可伪造的检查快照。",
      "在发布任何用户文件前调用；把页数、标题、正文预览、工作表或结构问题与用户要求逐项比较。",
      "文件修改后旧 inspectionId 失效，必须重新检查。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "候选文件路径。相对路径优先按宿主管理的内部制作区解析。"
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
};

const inspectArtifactTool = {
  schema: INSPECT_ARTIFACT_TOOL_SCHEMA,
  async execute(args = {}, ctx = {}) {
    const canonical = await resolveScopedArtifactPath(args.path, ctx);
    const format = path.extname(canonical).toLowerCase().slice(1);
    const snapshot = await createInspectionSnapshot(canonical, ctx, format);
    const details = await inspectByFormat(snapshot.absolute, format, snapshot.bytes);
    const issues = [...(details.issues || [])];
    if (details.textPreview && containsToolProtocol(details.textPreview)) {
      issues.push("文件包含内部工具协议文本。");
    }
    const inspectionId = createInspectionId(canonical, snapshot.sha256);
    const inspectedAt = new Date().toISOString();
    const inspection = {
      inspectionId,
      absolute: canonical,
      file: path.basename(canonical),
      format,
      bytes: snapshot.bytes,
      sha256: snapshot.sha256,
      inspectedAt,
      valid: issues.length === 0,
      issues,
      ...withoutIssues(details)
    };
    inspectionRegistry(ctx).set(inspectionId, {
      absolute: canonical,
      sha256: snapshot.sha256,
      snapshot: snapshot.absolute,
      valid: inspection.valid,
      inspectedAt
    });
    registerInspectedCandidate(ctx, inspection);
    return inspection;
  }
};

async function resolveScopedArtifactPath(requestedPath, ctx = {}) {
  const requested = `${requestedPath || ""}`.trim();
  const workDir = `${ctx.artifactWorkDir || ctx.agentWorkDir || ctx.taskDir || ""}`.trim();
  if (!requested || !workDir) throw new Error("缺少当前任务工作空间或文件路径。");
  const requestedCandidates = path.isAbsolute(requested)
    ? [requested]
    : [...new Set([
      ctx.artifactWorkDir ? path.join(ctx.artifactWorkDir, requested) : "",
      ctx.agentWorkDir ? path.join(ctx.agentWorkDir, requested) : "",
      path.join(workDir, requested)
    ].filter(Boolean))];
  const canonicalCandidates = [];
  for (const item of requestedCandidates) {
    const canonical = await fsp.realpath(path.resolve(item)).catch(() => "");
    if (canonical && !canonicalCandidates.includes(canonical)) canonicalCandidates.push(canonical);
  }
  if (!canonicalCandidates.length) throw new Error(`候选文件不存在：${requested}`);
  const registered = candidateRegistry(ctx);
  const canonical = canonicalCandidates.find((item) => registered.has(item))
    || canonicalCandidates[0];
  const roots = await canonicalRoots([ctx.artifactWorkDir, ctx.agentWorkDir]);
  const registeredCandidate = registered.has(canonical);
  if (!registeredCandidate && !roots.some((root) => isPathInside(root, canonical))) {
    throw new Error("只能检查当前 Agent 工作空间内的文件或生成工具登记的候选。");
  }
  return canonical;
}

async function canonicalRoots(values = []) {
  const roots = [];
  for (const value of values) {
    const requested = `${value || ""}`.trim();
    if (!requested) continue;
    const canonical = await fsp.realpath(path.resolve(requested)).catch(() => "");
    if (canonical && !roots.includes(canonical)) roots.push(canonical);
  }
  return roots;
}

async function createInspectionSnapshot(source, ctx, format) {
  const taskDir = `${ctx.taskDir || ""}`.trim();
  const snapshotDir = `${ctx.contextResultDir || ""}`.trim()
    || (taskDir ? path.join(taskDir, "context-results", "inspection-snapshots") : "");
  if (!snapshotDir) throw new Error("inspect_artifact 缺少宿主检查快照目录。");
  await fsp.mkdir(snapshotDir, { recursive: true });
  const canonicalSnapshotDir = await fsp.realpath(snapshotDir);
  if (taskDir) {
    const canonicalTaskDir = await fsp.realpath(taskDir);
    if (!isPathInside(canonicalTaskDir, canonicalSnapshotDir)) {
      throw new Error("检查快照目录越出当前任务边界。");
    }
  }
  const snapshot = path.join(canonicalSnapshotDir, `${crypto.randomBytes(16).toString("hex")}.snapshot`);
  const noFollow = Number(fsConstants.O_NOFOLLOW) || 0;
  let sourceHandle = null;
  let snapshotHandle = null;
  try {
    sourceHandle = await fsp.open(source, fsConstants.O_RDONLY | noFollow);
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("inspect_artifact 只能检查文件。");
    const bytes = Number(before.size);
    if (bytes <= 0) throw new Error("候选文件为空，不能发布。");
    if (bytes > MAX_INSPECTION_BYTES) {
      throw new Error(`候选文件超过检查上限 ${MAX_INSPECTION_BYTES} bytes。`);
    }
    if (["pptx", "docx", "xlsx"].includes(format) && bytes > MAX_OFFICE_ARCHIVE_BYTES) {
      throw new Error(`Office 候选超过检查上限 ${MAX_OFFICE_ARCHIVE_BYTES} bytes。`);
    }
    snapshotHandle = await fsp.open(
      snapshot,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    );
    const copied = await copyAndHash(sourceHandle, snapshotHandle);
    await snapshotHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameFileVersion(before, after) || copied.bytes !== bytes) {
      throw new Error("文件在检查快照期间发生变化，请重试检查。");
    }
    return { absolute: snapshot, bytes, sha256: copied.sha256 };
  } catch (error) {
    await fsp.unlink(snapshot).catch(() => {});
    throw error;
  } finally {
    await sourceHandle?.close().catch(() => {});
    await snapshotHandle?.close().catch(() => {});
  }
}

async function copyAndHash(sourceHandle, snapshotHandle) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  while (true) {
    const read = await sourceHandle.read(buffer, 0, buffer.length, null);
    if (!read.bytesRead) break;
    bytes += read.bytesRead;
    hash.update(buffer.subarray(0, read.bytesRead));
    let offset = 0;
    while (offset < read.bytesRead) {
      const written = await snapshotHandle.write(buffer, offset, read.bytesRead - offset, null);
      if (!written.bytesWritten) throw new Error("写入检查快照失败。");
      offset += written.bytesWritten;
    }
  }
  return { bytes, sha256: hash.digest("hex") };
}

function sameFileVersion(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function createInspectionId(absolute, sha256) {
  return `inspection_${crypto.createHash("sha256").update(`${absolute}\0${sha256}`).digest("hex").slice(0, 24)}`;
}

function inspectionRegistry(ctx) {
  if (!(ctx.artifactInspections instanceof Map)) ctx.artifactInspections = new Map();
  return ctx.artifactInspections;
}

function candidateRegistry(ctx) {
  if (!(ctx.artifactCandidates instanceof Map)) ctx.artifactCandidates = new Map();
  return ctx.artifactCandidates;
}

function registerInspectedCandidate(ctx, inspection) {
  const candidates = candidateRegistry(ctx);
  const current = candidates.get(inspection.absolute) || {};
  candidates.set(inspection.absolute, {
    ...current,
    absolute: inspection.absolute,
    file: inspection.file,
    format: inspection.format,
    status: "inspected",
    inspectionId: inspection.inspectionId,
    sha256: inspection.sha256
  });
}

async function registerDeclaredCandidate(ctx, requestedPath, sourceTool = "") {
  const canonical = await resolveScopedArtifactPath(requestedPath, ctx);
  const stat = await fsp.stat(canonical);
  if (!stat.isFile()) throw new Error("只有真实文件可以声明为用户成品。");
  const candidates = candidateRegistry(ctx);
  const current = candidates.get(canonical) || {};
  candidates.set(canonical, {
    ...current,
    absolute: canonical,
    file: path.basename(canonical),
    format: path.extname(canonical).toLowerCase().slice(1),
    status: "declared",
    sourceTool: `${sourceTool || ""}`,
    declaredAt: new Date().toISOString()
  });
  return candidates.get(canonical);
}

async function inspectByFormat(absolute, format, bytes) {
  if (TEXT_EXTENSIONS.has(`.${format}`)) return inspectPlainText(await readTextPreview(absolute));
  if (format === "html" || format === "htm") return inspectHtml(await readTextPreview(absolute));
  if (format === "pptx") return inspectPptx(absolute);
  if (format === "docx") return inspectDocx(absolute);
  if (format === "xlsx") return inspectXlsx(absolute);
  if (format === "pdf") return inspectPdf(absolute, bytes);
  if (IMAGE_EXTENSIONS.has(`.${format}`)) return inspectImage(absolute);
  return {
    semanticInspectable: false,
    textPreview: "",
    issues: ["该文件格式没有可用的结构或内容检查器，不能安全发布。"]
  };
}

async function readTextPreview(absolute) {
  const handle = await fsp.open(absolute, "r");
  try {
    const buffer = Buffer.alloc(240000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function inspectPlainText(text) {
  const clean = `${text || ""}`.trim();
  const headings = [...clean.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim()).slice(0, 40);
  return {
    semanticInspectable: true,
    headings,
    characterCount: clean.length,
    textPreview: clean.slice(0, 8000),
    issues: clean ? [] : ["文本文件没有可见内容。"]
  };
}

function inspectHtml(html) {
  const headings = [...`${html}`.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map((match) => htmlToText(match[1])).filter(Boolean).slice(0, 40);
  const text = htmlToText(`${html}`.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " "));
  const issues = [];
  if (!/<(?:!doctype\s+html|html)\b/i.test(html)) issues.push("HTML 缺少完整文档结构。");
  if (!text) issues.push("HTML 没有可见正文。");
  return {
    semanticInspectable: true,
    headings,
    characterCount: text.length,
    textPreview: text.slice(0, 8000),
    issues
  };
}

async function inspectPptx(absolute) {
  const zip = await loadValidatedOfficeArchive(absolute);
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(numericPartOrder);
  const slides = [];
  for (const name of names) {
    const text = extractXmlText(await zip.file(name).async("string"));
    slides.push({
      page: slides.length + 1,
      title: text[0] || "",
      text: text.join(" · ").slice(0, 1000)
    });
  }
  const textPreview = slides.map((slide) => `第${slide.page}页 ${slide.text}`).join("\n").slice(0, 12000);
  const issues = [];
  if (!zip.file("[Content_Types].xml") || !zip.file("ppt/presentation.xml")) issues.push("PPTX 缺少核心 OOXML 部件。");
  if (!slides.length) issues.push("PPTX 中没有幻灯片。");
  if (slides.length && !slides.some((slide) => slide.text.trim())) issues.push("PPTX 页面没有可见文字。");
  return { semanticInspectable: true, pages: names.length, slides, textPreview, issues };
}

async function inspectDocx(absolute) {
  const zip = await loadValidatedOfficeArchive(absolute);
  const document = zip.file("word/document.xml");
  if (!document) return { semanticInspectable: true, textPreview: "", issues: ["DOCX 缺少 word/document.xml。"] };
  const paragraphs = extractXmlParagraphs(await document.async("string"), "w:p", "w:t");
  const textPreview = paragraphs.join("\n").slice(0, 10000);
  return {
    semanticInspectable: true,
    paragraphs: paragraphs.length,
    textPreview,
    issues: textPreview ? [] : ["DOCX 没有可见正文。"]
  };
}

async function inspectXlsx(absolute) {
  await loadValidatedOfficeArchive(absolute);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absolute);
  const sheets = workbook.worksheets.slice(0, 40).map((sheet) => {
    const sample = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 12) return;
      const values = Array.isArray(row.values) ? row.values : [];
      sample.push(values.slice(1, 13).map(displayCellValue));
    });
    return {
      name: sheet.name,
      rows: sheet.actualRowCount || sheet.rowCount || 0,
      columns: sheet.actualColumnCount || sheet.columnCount || 0,
      sample
    };
  });
  const textPreview = sheets.map((sheet) => (
    `${sheet.name}\n${sheet.sample.map((row) => row.join(" | ")).join("\n")}`
  )).join("\n\n").slice(0, 12000);
  return {
    semanticInspectable: true,
    sheetCount: workbook.worksheets.length,
    sheets,
    textPreview,
    issues: workbook.worksheets.length ? [] : ["XLSX 中没有工作表。"]
  };
}

async function loadValidatedOfficeArchive(absolute) {
  const data = await fsp.readFile(absolute);
  if (data.length > MAX_OFFICE_ARCHIVE_BYTES) {
    throw new Error(`Office 候选超过检查上限 ${MAX_OFFICE_ARCHIVE_BYTES} bytes。`);
  }
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files || {});
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Office 压缩包条目超过 ${MAX_ARCHIVE_ENTRIES} 个。`);
  }
  let expanded = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const metadata = /** @type {{_data?:{uncompressedSize?:number}}} */ (
      /** @type {unknown} */ (entry)
    );
    const bytes = Number(metadata._data?.uncompressedSize);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("Office 压缩包缺少可验证的解压大小。");
    }
    if (bytes > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(`Office 压缩包单项超过 ${MAX_ARCHIVE_ENTRY_BYTES} bytes。`);
    }
    expanded += bytes;
    if (expanded > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error(`Office 压缩包解压总量超过 ${MAX_ARCHIVE_EXPANDED_BYTES} bytes。`);
    }
  }
  return zip;
}

async function inspectPdf(absolute, bytes) {
  void bytes;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fsp.readFile(absolute));
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true
  });
  try {
    const document = await loadingTask.promise;
    const samples = [];
    const sampledPages = Math.min(document.numPages, 20);
    for (let pageNumber = 1; pageNumber <= sampledPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const content = text.items
        .map((item) => ("str" in item ? `${item.str || ""}` : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      samples.push(`第${pageNumber}页 ${content}`.trim());
      page.cleanup();
    }
    const textPreview = samples.join("\n").slice(0, 12000);
    const issues = [];
    if (!document.numPages) issues.push("PDF 中没有页面。");
    if (document.numPages && !textPreview) issues.push("PDF 页面没有可提取正文，当前检查器无法核对真实内容。");
    return {
      semanticInspectable: Boolean(textPreview),
      pages: document.numPages,
      sampledPages,
      textPreview,
      issues
    };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

async function inspectImage(absolute) {
  const dimensions = readImageMetadata(await fsp.readFile(absolute));
  const width = Number(dimensions.width) || 0;
  const height = Number(dimensions.height) || 0;
  return {
    semanticInspectable: true,
    width,
    height,
    imageType: dimensions.type || "",
    orientation: null,
    textPreview: "",
    issues: width > 0 && height > 0 ? [] : ["图片没有有效尺寸。"]
  };
}

function extractXmlText(xml) {
  return [...`${xml}`.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => decodeXml(match[1]).trim()).filter(Boolean);
}

function extractXmlParagraphs(xml, paragraphTag, textTag) {
  const paragraphs = [];
  const paragraphPattern = new RegExp(`<${paragraphTag}\\b[^>]*>([\\s\\S]*?)<\\/${paragraphTag}>`, "gi");
  for (const match of `${xml}`.matchAll(paragraphPattern)) {
    const textPattern = new RegExp(`<${textTag}\\b[^>]*>([\\s\\S]*?)<\\/${textTag}>`, "gi");
    const text = [...match[1].matchAll(textPattern)].map((item) => decodeXml(item[1])).join("").trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function decodeXml(value) {
  return `${value || ""}`
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function htmlToText(value) {
  return decodeXml(`${value || ""}`.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function displayCellValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Object.hasOwn(value, "result")) return `${value.result ?? ""}`;
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
    if (Object.hasOwn(value, "text")) return `${value.text || ""}`;
  }
  return `${value}`;
}

function numericPartOrder(left, right) {
  return (Number(left.match(/(\d+)\.xml$/i)?.[1]) || 0) - (Number(right.match(/(\d+)\.xml$/i)?.[1]) || 0);
}

function withoutIssues(details) {
  const { issues, ...rest } = details || {};
  return rest;
}

module.exports = {
  inspectArtifactTool,
  INSPECT_ARTIFACT_TOOL_SCHEMA,
  resolveScopedArtifactPath,
  inspectionRegistry,
  candidateRegistry,
  registerDeclaredCandidate
};
