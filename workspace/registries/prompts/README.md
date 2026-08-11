# Prompt 资产规范

Prompt 资产分为宪法层与执行层。`soul` 和 `aesthetic.baseline` 是唯一宪法资产，分别表达稳定人格与审美价值；它们给模型判断方向，不规定具体执行方式。其他 prompt 都是执行契约，每条指令必须改变可观察行为：是否调用工具、使用哪些输入、输出哪些字段、满足什么条件才算完成。

## 单一真相源

- `block://soul.zh`：定义腰果在回答、执行、修改与交付中的共同人格；内部分类、检查和工具子调用不加载。
- `block://system.agent`：定义通用 Agent 的行动、事实、工具与完成边界；`sections["memory.cache"]` 定义三层缓存快照边界，`sections["memory.behavior"]` 定义稳定记忆行为规范。二者按任务会话独立缓存，只包含稳定规则和 `logs/{date}.md` 路径模式，不包含具体日期、用户规则、Memdir 索引或主题正文。
- `block://aesthetic.baseline.zh`：定义所有面向用户回答与产出的唯一审美哲学。
- `block://memory.prefetch`：定义无工具、无正文输入的长期记忆旁路筛选任务；只根据当前对话与 Front Matter 元数据返回 0-5 个文件名。
- `block://memory.extract`：定义 assistant 持久化后最多 5 轮的后台记忆提取 Agent；先并行读取，再通过 `write_memory` 并行提交四种封闭类型。indexed 模式维护主题与索引，append-only 模式只追加日期日志；禁止源码调查、shell、MCP 与递归 Agent。
- `block://memory.autodream`：定义按存储模式门控、最多 12 轮的离线整合 Agent；按 Orient、Gather、Consolidate、Prune and Index 顺序读取待整理日期日志、形成变更计划，最终由锁与 Memdir 快照校验后提交。
- `block://memory.session`：定义双阈值触发的渐进式会话笔记更新；输出固定六章节的完整 `session/memory.md`，供 10 万 Token 后的上下文压缩直接使用。
- 内部结构化调用不加载 `soul` 或 `aesthetic.baseline`。
- 内部规划、分类、检查与查询使用各自的单一职责 prompt，不定义身份。
- 工具的触发条件、反例和参数语义只写在工具 schema，不复制成常驻 block。
- Skill 的操作步骤只写在 Skill 内，system prompt 不复述。
- 项目参考样本与要求由运行时按当前任务选择，不复制进全局提示词。
- Managed、User、Project、Local 指令文件不注册为 prompt block，也不拼进 system prompt；运行时把有效快照作为首条 `user` message 注入。
- Memdir 的 `memory.md` 作为当前任务 `user` message 的 protected section；主题正文只会由异步 Prefetch 模型选择，或作为 `search_memory` 工具结果进入模型轮次。

## 写法

1. 宪法资产只保留稳定价值，不复制 system、工具、Skill、媒介或验收规则。
2. 执行型 prompt 按任务、输入边界、工具条件、输出协议和完成标准组织；不存在的部分不为形式完整而添加。
3. 执行型 prompt 写可观察动作，例如“引用原文定位”“比较两个独立来源”“输出合法 JSON”，不用质量形容词代替动作。
4. 数量、长度和格式只在业务确实要求时设定；数值必须能被程序或人工直接检查。
5. 工具说明写明何时调用、何时不调用、返回结果如何继续使用；参数类型和枚举交给 JSON Schema。
6. 示例只覆盖容易混淆的路由、格式或边界，包含一个正例和一个反例。
7. XML 标签只隔离不同权限或来源的内容，例如规则、用户输入和外部资料。
8. 一条规则行为不对时删除并重写原规则，不在末尾追加修正条款。
9. 每次修改关联一个失败用例或回归测试；没有行为变化的措辞调整不进入 prompt。

## 文件

- `prompts/<domain>.<name>.v<n>.json`：完整模型调用资产。
- `prompts/blocks/<name>.v<n>.json`：被运行时引用的单一职责 block。

尚未发布的重构可原地重写；需要复现旧运行时再提升版本。`npm run check` 验证引用、语法与 prompt 卫生红线。
