---
name: xlsx
description: 当任务需要把 Markdown 中的结构化表格转为 Excel .xlsx 工作簿，或校验已有工作簿时使用。
---

# Excel 工作簿

此 Skill 适合数据表和结构化清单，不适合把散文伪装成电子表格。

## 选择动作

- `create`：每个 Markdown 表格生成一个工作表，并处理表头、冻结与列宽。
- `validate`：实际解析工作簿，检查文件结构和工作表数量，并拒绝包含内部工具协议的文件。

## 工作准则

1. 先确认内容确实具有行列结构；没有表格时应优先交付 Word 或 PDF。
2. 表格标题应能直接用作工作表名称；同名由运行时去重。
3. 输入、输出路径必须位于宿主授予的作用域。
4. 创建后检查 `sheets` 和 `warnings`，再执行 `validate` 交付。

Action 的精确字段、类型和边界以 `skill.json` 的 `entry.<action>.inputSchema` 为唯一契约。
