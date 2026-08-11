// @ts-check

// 视觉成品的确定性检查汇总。DOM 几何问题由 Chromium 返回；这里补充图片与媒介结构检查，
// 并把机器结果转成模型可执行的返修指令。

function countMatches(text, re) {
  return (`${text || ""}`.match(re) || []).length;
}

function staticVisualIssues({ html = "", medium = "deck", localization = null, requirements = null } = {}) {
  const source = `${html || ""}`;
  const issues = [];
  const sectionCount = countMatches(source, /<section\b/gi);
  if (!/<style\b/i.test(source)) {
    issues.push({ code: "VISUAL_STYLE_MISSING", message: "HTML 没有内联 style，不能作为完成的视觉产物。建立颜色、字阶、间距和页面布局后重新生成。" });
  }
  if (!/<(?:main|section|article|div|header)\b/i.test(source)) {
    issues.push({ code: "VISUAL_STRUCTURE_MISSING", message: "HTML 没有承载页面结构的语义容器。按内容关系建立 main、section 或等价布局容器。" });
  }
  if (medium === "deck" && sectionCount === 0) {
    issues.push({ code: "DECK_SECTION_MISSING", message: "deck 没有 section 页面。把 body 的一级子元素改为独立 section。" });
  }
  if (medium === "deck" && /overflow(?:-y)?\s*:\s*(?:auto|scroll)/i.test(source)) {
    issues.push({ code: "DECK_SCROLLING_TEXT", message: "deck 使用了滚动容器。拆分页面，使全部正文在 16:9 页面内直接可见。" });
  }
  const removed = Number(localization?.removed || 0);
  if (removed > 0) {
    issues.push({ code: "IMAGE_DOWNLOAD_FAILED", message: `${removed} 张图片无法下载。删除损坏图片，或改用可访问的图片资源。` });
  }
  const capabilities = new Set(Array.isArray(requirements?.capabilities) ? requirements.capabilities : []);
  const capabilityChecks = {
    responsive: /@media\b|\bclamp\s*\(|\b(?:min|max)\s*\(/i,
    interaction: /<script\b[\s\S]*?(?:addEventListener|onclick|querySelector|requestAnimationFrame)/i,
    animation: /@keyframes\b|\banimation(?:-name)?\s*:|requestAnimationFrame\s*\(/i,
    scroll_interaction: /<script\b[\s\S]*?(?:wheel|scroll|pointermove|mousemove|touchmove)/i,
    navigation: /<nav\b|href\s*=\s*["']#/i,
    data_visualization: /<(?:svg|canvas)\b|\b(?:chart|plot|graph)\b/i
  };
  for (const capability of capabilities) {
    if (!capabilityChecks[capability]?.test(source)) {
      issues.push({
        code: `VISUAL_CAPABILITY_MISSING_${capability.toUpperCase()}`,
        message: `成品没有实现已声明的 ${capability} 能力。补齐可运行的结构、样式或内联脚本后重新生成。`
      });
    }
  }
  for (const requiredText of Array.isArray(requirements?.requiredText) ? requirements.requiredText : []) {
    const text = `${requiredText || ""}`.trim();
    if (text && !source.includes(text)) {
      issues.push({ code: "VISUAL_REQUIRED_TEXT_MISSING", message: `成品缺少必须出现的文字：${text}` });
    }
  }
  return issues;
}

function layoutIssueMessage(issue = {}) {
  const page = Number.isInteger(issue.pageIndex) ? `第 ${issue.pageIndex + 1} 页` : "页面";
  const target = issue.selector ? `（${issue.selector}）` : "";
  if (issue.code === "PAGE_OVERFLOW_X") return `${page}横向越界 ${Math.ceil(Number(issue.amount) || 0)}px${target}。调整栅格、宽度或内边距。`;
  if (issue.code === "PAGE_OVERFLOW_Y") return `${page}纵向越界 ${Math.ceil(Number(issue.amount) || 0)}px${target}。删减重复文字或拆分页面。`;
  if (issue.code === "TEXT_CLIPPED") return `${page}正文被裁切${target}。移除正文容器的 overflow:hidden/clip，并重新分配空间或拆页。`;
  if (issue.code === "TEXT_SCROLLING") return `${page}正文依赖滚动条${target}。拆分内容，使正文无需滚动即可看全。`;
  if (issue.code === "ELEMENT_OUTSIDE_PAGE") return `${page}元素超出页面边界${target}。把它移回安全边距。`;
  if (issue.code === "TEXT_OVERLAP") return `${page}两块正文发生重叠${target}。改用正常文档流、grid 或 flex 重新排布。`;
  if (issue.code === "BROKEN_IMAGE") return `${page}有无法显示的图片${target}。删除损坏图片，或改用可访问的图片资源。`;
  return `${issue.message || issue.code || "发现未分类版式问题"}`;
}

function mergeVisualIssues({ html = "", medium = "deck", localization = null, layout = null, requirements = null } = {}) {
  /** @type {any[]} */
  const merged = [...staticVisualIssues({ html, medium, localization, requirements })];
  for (const issue of Array.isArray(layout?.issues) ? layout.issues : []) {
    merged.push({ ...issue, message: layoutIssueMessage(issue) });
  }
  const seen = new Set();
  return merged.filter((issue) => {
    const key = `${issue.code || ""}:${issue.pageIndex ?? ""}:${issue.selector || ""}:${issue.message || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

function visualIssueMessages(issues = []) {
  return (Array.isArray(issues) ? issues : []).map((issue) => `${issue?.message || ""}`.trim()).filter(Boolean);
}

module.exports = { staticVisualIssues, mergeVisualIssues, visualIssueMessages, layoutIssueMessage };
