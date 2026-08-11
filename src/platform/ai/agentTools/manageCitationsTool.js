// @ts-check
// manage_citations —— 管理当前任务的已引用参考来源（列出 / 加入）。
// 与 search_reference / fetch_url 配套：搜到/读到一个好来源，可沉淀进引用清单。
// 以前只有 UI 引用面板能做。依赖 ctx.projectService（listReferences/addReference）。

const { ensureReferenceObservationState, normalizeReferenceUrl } = require("./referenceObservation");

const MANAGE_CITATIONS_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "manage_citations",
    description: "管理当前任务的已引用参考来源：list=列出已引用；add=把一个来源加入引用（通常是 search_reference / fetch_url 命中后想沉淀的来源）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add"], description: "list=列出已引用；add=加入一条引用。" },
        reference: {
          type: "object",
          description: "action=add 时必填。url 必须来自用户输入或本轮 search_reference / fetch_url 的真实结果。",
          properties: {
            url: { type: "string", minLength: 1, maxLength: 4000 }
          },
          required: ["url"],
          additionalProperties: false
        }
      },
      required: ["action"]
    }
  }
};

async function executeManageCitations(args = {}, ctx = {}) {
  const ps = ctx.projectService;
  const projectId = ctx.projectId || "";
  const taskId = ctx.taskId || "";
  if (!ps || typeof ps.listReferences !== "function") return { ok: false, error: "manage_citations 缺少 ctx.projectService" };
  if (!projectId || !taskId) return { ok: false, error: "缺少 projectId/taskId（请在某个任务下）" };
  const action = ["list", "add"].includes(args.action) ? args.action : "list";
  try {
    if (action === "add") {
      const ref = (args.reference && typeof args.reference === "object") ? args.reference : {};
      if (!ref.url) return { ok: false, error: "add 需要 reference.url" };
      const normalizedUrl = normalizeReferenceUrl(ref.url);
      if (!normalizedUrl) return { ok: false, error: "reference.url 格式无效" };
      ensureReferenceObservationState(ctx);
      if (!ctx.observedReferenceUrls.has(normalizedUrl)) {
        return {
          ok: false,
          code: "CITATION_NOT_OBSERVED",
          error: "该 URL 未出现在用户输入或本轮真实检索结果中，拒绝把模型臆造来源写入引用清单。"
        };
      }
      const observed = ctx.observedReferencesByUrl.get(normalizedUrl) || {};
      const saved = await ps.addReference(projectId, taskId, {
        url: normalizedUrl,
        title: observed.title || new URL(normalizedUrl).hostname,
        snippet: observed.snippet || ""
      });
      return { ok: true, action, reference: { id: saved.id, title: saved.title, url: saved.url } };
    }
    const refs = await ps.listReferences(projectId, taskId);
    return {
      ok: true,
      action: "list",
      count: Array.isArray(refs) ? refs.length : 0,
      references: (Array.isArray(refs) ? refs : []).slice(0, 20).map((r) => ({ id: r.id, title: r.title, url: r.url, snippet: r.snippet }))
    };
  } catch (err) {
    return { ok: false, error: `${err?.message || err}` };
  }
}

const manageCitationsTool = { schema: MANAGE_CITATIONS_TOOL_SCHEMA, execute: executeManageCitations };

module.exports = { manageCitationsTool, MANAGE_CITATIONS_TOOL_SCHEMA, executeManageCitations };
