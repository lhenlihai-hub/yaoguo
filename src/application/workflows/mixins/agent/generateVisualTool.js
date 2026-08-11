// generate_visual 验收 Agent 已写入工作区的 HTML，并生成待检查候选。

const GENERATE_VISUAL_TOOL = {
  type: "function",
  function: {
    name: "generate_visual",
    description: [
      "验收你已经用 write/edit 写好的自包含 HTML 视觉候选。",
      "它不会生成 PowerPoint；可编辑 PPTX 使用 generate_document。",
      "本工具不会替你生成或重写内容；成功后必须 inspect_artifact，再由 publish_artifact 发布。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        medium: {
          type: "string",
          enum: ["deck", "webpage", "poster", "report"],
          description: "产物形态。deck=幻灯片；webpage=网页；poster=海报；report=排版报告。"
        },
        path: {
          type: "string",
          minLength: 1,
          description: "当前任务目录或 Agent 工作空间内已经写好的 .html 文件路径。"
        },
        title: { type: "string", description: "可选。成品标题；不填用 task 标题或正文首个标题。" },
        exportPdf: {
          type: "boolean",
          description: "只有用户明确要求额外 PDF 时设为 true。"
        },
        requirements: {
          type: "object",
          description: "可选。宿主可做确定性验收的要求；只声明用户确实需要的能力。",
          properties: {
            capabilities: {
              type: "array",
              maxItems: 5,
              items: { type: "string", enum: ["responsive", "interaction", "animation", "scroll_interaction", "navigation", "data_visualization"] },
              description: "成品必须实际具备的能力。"
            },
            requiredText: {
              type: "array",
              maxItems: 12,
              items: { type: "string", minLength: 1, maxLength: 120 },
              description: "成品中必须出现的用户指定文字。"
            }
          },
          additionalProperties: false
        }
      },
      required: ["medium", "path"],
      additionalProperties: false
    }
  }
};

module.exports = { GENERATE_VISUAL_TOOL };
