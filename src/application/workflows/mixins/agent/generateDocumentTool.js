// generate_document 提供 Agent 原生文档序列化能力。

const GENERATE_DOCUMENT_TOOL = {
  type: "function",
  function: {
    name: "generate_document",
    description: [
      "把你已经整理完成的正文或结构化数据序列化为原生 Word、PDF、PPTX 或 Excel 文件。",
      "本工具不替你构思、改写或扩写内容。新建文件时优先使用 prepared_content 或 workspace_file；",
      "成功只产生候选，随后必须 inspect_artifact 并 publish_artifact。PPTX 的 content 用 Markdown H1/H2 划分内容页。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["docx", "pdf", "pptx", "xlsx"],
          description: "目标原生文件格式。docx=Word；pdf=PDF；pptx=可编辑 PPTX；xlsx=Excel。"
        },
        source: {
          type: "string",
          enum: ["prepared_content", "workspace_file", "latest_artifact", "task_history"],
          description: "正文来源。prepared_content=content 中已完成的正文；workspace_file=path 指向的工作区文件；latest_artifact=当前任务最新成品；task_history=原样导出任务工作记录。"
        },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 240000,
          description: "source=prepared_content 时必填。必须是可以直接进入文件的最终正文或结构化数据，不包含计划、制作说明、验收指令或占位符。"
        },
        path: {
          type: "string",
          minLength: 1,
          description: "source=workspace_file 时必填。指向当前任务目录或当前 Agent 工作空间内已完成的 UTF-8 文本文件。"
        },
        title: {
          type: "string",
          description: "可选。生成文件的标题；不填则用 task 标题或第一段一级标题。"
        },
        imageAssetIds: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description: "可选。生成 PPTX 时，从 search_images 返回结果中选中的 assetId；不选择图片时省略。"
        }
      },
      required: ["format", "source"],
      additionalProperties: false
    }
  }
};

module.exports = {
  GENERATE_DOCUMENT_TOOL
};
