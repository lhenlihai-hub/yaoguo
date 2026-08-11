// @ts-check

// skills 共享库：LibreOffice headless 文档转换。
// docx/pptx/xlsx → pdf 都走这里。docx skill 的 preview 和 pdf skill 的 create 共用。
//
// _lib/ 下没有 skill.json，SkillsRegistry 不会把它当 skill 加载。

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

const SOFFICE_CANDIDATES = [
  "soffice",
  "libreoffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/usr/bin/soffice",
  "/usr/local/bin/soffice",
  "/usr/bin/libreoffice"
];

const MISSING_HINT = "macOS: brew install --cask libreoffice 或从 libreoffice.org 下载安装。";

// 定位可用的 soffice 可执行文件；找不到返回 null。
function locateSoffice() {
  for (const cmd of SOFFICE_CANDIDATES) {
    try {
      const result = spawnSync(cmd, ["--version"], { timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0) return cmd;
    } catch { /* 下一个候选 */ }
  }
  return null;
}

// 把 inputPath（docx/pptx/...）转成同名 .pdf 落到 outputDir。
// 返回 pdfPath。soffice/转换失败时抛错。
function convertToPdf(soffice, inputPath, outputDir, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    // LibreOffice 的默认用户配置不允许多进程并发使用。每次转换独立 profile，
    // 避免多个 Agent/测试同时预览时互相抢锁或把输出写到另一个进程。
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaoguo-soffice-"));
    const profileArg = `-env:UserInstallation=${pathToFileURL(profileDir).href}`;
    const args = [profileArg, "--headless", "--convert-to", "pdf", "--outdir", outputDir, inputPath];
    const child = spawn(soffice, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* noop */ }
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      fail(new Error(`LibreOffice 转 PDF 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return fail(new Error(`LibreOffice 退出码 ${code}：${stderr || stdout}`));
      }
      const base = path.basename(inputPath, path.extname(inputPath));
      const pdfPath = path.join(outputDir, `${base}.pdf`);
      if (!fs.existsSync(pdfPath)) {
        return fail(new Error(`LibreOffice 未输出预期 PDF：${pdfPath}`));
      }
      cleanup();
      resolve(pdfPath);
    });
  });
}

module.exports = {
  SOFFICE_CANDIDATES,
  MISSING_HINT,
  locateSoffice,
  convertToPdf
};
