---
name: docx
description: 当任务需要创建、读取、校验或预览 Word .docx 文件时使用；创建输入为 Markdown，读取输出为 Markdown。
---

# Word 文档

此 Skill 是 `generate_document` 的底层执行能力。通用 Agent 应优先调用宿主工具，不要自行拼接文件路径或绕过作用域。

## 选择动作

- `create`：把已完成的 Markdown 正文排版为 `.docx`。
- `read`：把已有 `.docx` 提取为 Markdown 和结构摘要。
- `validate`：检查文件是否存在、非空且能被解析，并拒绝包含内部工具协议的文件。
- `preview`：优先生成高保真 PDF；缺 LibreOffice 时生成近似 HTML。

## 工作准则

1. 创建前先完成正文，不把提纲、过程说明或占位符当成成品。
2. 所有输入、输出路径必须是宿主授予作用域内的绝对路径。
3. `create` 后检查返回的 `warnings`；需要交付时再执行 `validate`。
4. 预览的 `usedBackend` 决定保真度：`libreoffice` 为高保真，`mammoth` 为近似。
5. 失败时保留结构化错误码，不声称文件已经生成。

Action 的精确字段、类型和边界以 `skill.json` 的 `entry.<action>.inputSchema` 为唯一契约。
