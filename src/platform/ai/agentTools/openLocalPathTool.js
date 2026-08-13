// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");
const { isPathInside } = require("../../shared/pathSafety");

const OPEN_LOCAL_PATH_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "open_local_path",
    description: [
      "在用户系统中打开当前任务可访问的本地文件或文件夹。",
      "文件使用系统默认应用打开；文件夹使用系统文件管理器打开。",
      "只在用户明确要求打开、显示或定位本地路径时调用；相对路径按当前 Agent 工作空间解析。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "要打开的文件或文件夹路径。使用 '.' 打开当前 Agent 工作空间。"
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
};

const openLocalPathTool = {
  schema: OPEN_LOCAL_PATH_TOOL_SCHEMA,
  async execute(args = {}, ctx = {}) {
    if (typeof ctx.openLocalPath !== "function") {
      throw new Error("当前宿主未提供本地文件或文件夹打开能力。");
    }
    const absolute = await resolveOpenLocalPath(args.path, ctx);
    const stat = await fsp.stat(absolute);
    const kind = stat.isDirectory() ? "directory" : (stat.isFile() ? "file" : "");
    if (!kind) throw new Error("只能打开普通文件或文件夹。");
    const result = await ctx.openLocalPath(absolute, {
      kind,
      signal: ctx.signal || null
    });
    if (result === false || result?.allow === false || result?.ok === false) {
      throw new Error(result?.error || result?.reason || "宿主拒绝打开该本地路径。");
    }
    return { opened: true, absolute, kind };
  }
};

async function resolveOpenLocalPath(requestedPath = "", ctx = {}) {
  const requested = `${requestedPath || ""}`.trim();
  const workDir = `${ctx.agentWorkDir || ctx.workspacePath || ""}`.trim();
  if (!requested || !workDir) throw new Error("缺少要打开的路径或当前 Agent 工作空间。");
  const resolved = path.resolve(path.isAbsolute(requested) ? requested : path.join(workDir, requested));
  const absolute = await fsp.realpath(resolved).catch(() => "");
  if (!absolute) throw new Error(`要打开的本地路径不存在：${resolved}`);
  const allowedRoots = await canonicalRoots(
    Array.isArray(ctx.agentOpenScopeAllow) ? ctx.agentOpenScopeAllow : [workDir]
  );
  const exactAllowed = await canonicalRoots(ctx.agentOpenExactAllow || []);
  if (!allowedRoots.some((root) => isPathInside(root, absolute)) && !exactAllowed.includes(absolute)) {
    throw new Error("只能打开当前任务工作空间、已发布成品路径或用户本轮明确指定的本地路径。");
  }
  const deniedRoots = await canonicalRoots(ctx.agentOpenScopeDeny || [], true);
  if (deniedRoots.some((root) => isPathInside(root, absolute))) {
    throw new Error("不能打开腰果的宿主控制目录。");
  }
  return absolute;
}

async function canonicalRoots(values = [], allowMissing = false) {
  const roots = [];
  for (const value of Array.isArray(values) ? values : []) {
    const raw = `${value || ""}`.trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const canonical = await fsp.realpath(resolved).catch(() => (allowMissing ? resolved : ""));
    if (canonical && !roots.includes(canonical)) roots.push(canonical);
  }
  return roots;
}

module.exports = {
  OPEN_LOCAL_PATH_TOOL_SCHEMA,
  openLocalPathTool,
  resolveOpenLocalPath
};
