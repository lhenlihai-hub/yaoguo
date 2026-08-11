---
name: pptx
description: 当任务需要把已有 Markdown 的标题、列表、表格和图片转为基础 PowerPoint .pptx，或校验演示文件、生成 PDF 预览时使用。
---

# PPT 演示文稿

此 Skill 保持 Markdown 的信息层级并生成固定版式；需要自定义配色、版式或视觉表达时使用 `generate_visual`。

## 选择动作

- `create`：按 H1/H2 切页，把段落、列表、表格和宿主已验证的图片放入幻灯片。
- `validate`：检查 `.pptx` 的 OOXML 容器、核心部件和幻灯片，并拒绝包含内部工具协议的文件。
- `preview`：经 LibreOffice 生成 PDF 预览。

## 工作准则

1. 输入先整理成一页一个中心观点的 Markdown，避免把长文直接塞进幻灯片。
2. 宿主提供图片时，封面和内容页按图文版式嵌入；没有可用图片时保持纯文字结构，不生成占位图。
3. 输入、输出路径必须位于宿主授予的作用域。
4. 检查返回的页数和 `warnings`；内容溢出时先重构，再交付。

Action 的精确字段、类型和边界以 `skill.json` 的 `entry.<action>.inputSchema` 为唯一契约。
