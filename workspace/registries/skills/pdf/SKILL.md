---
name: pdf
description: 当任务需要把已有 Word 文档渲染为 PDF 或校验 PDF 文件时使用；Markdown 直出 PDF 由宿主优先使用 Chromium。
---

# PDF 文档

此 Skill 是 `generate_document` 的后备渲染器，不负责写正文，也不把 Markdown 直接排版为 PDF。

## 选择动作

- `create`：输入 `.docx`，通过 LibreOffice 生成 `.pdf`。
- `validate`：检查 PDF 文件头与非空状态。

## 工作准则

1. 宿主能用 Chromium 时优先走 Markdown → PDF，减少中间文件。
2. 使用 `create` 前保证输入 Word 已成功生成，输入和输出都位于授予作用域。
3. LibreOffice 不可用或转换失败时保留 Word 交付物，不声称 PDF 已完成。
4. 交付 PDF 前执行 `validate`；失败时返回结构化错误。

Action 的精确字段、类型和边界以 `skill.json` 的 `entry.<action>.inputSchema` 为唯一契约。
