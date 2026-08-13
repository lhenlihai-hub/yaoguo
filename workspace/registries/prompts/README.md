# Prompt 资产规范

Prompt 资产分为宪法层与执行层。`soul` 和 `aesthetic.baseline` 是唯一宪法资产，分别表达稳定人格与审美价值；它们给模型判断方向，不规定具体执行方式。其他 prompt 都是执行契约，每条指令必须改变可观察行为：是否调用工具、使用哪些输入、输出哪些字段、满足什么条件才算完成。

## 单一真相源

- `block://soul.zh`：定义腰果在回答、执行、修改与交付中的共同人格；内部分类、检查和工具子调用不加载。
- `block://system.agent`：定义通用 Agent 的行动、事实、工具与完成边界。静态前缀依次装配 Introduction、System、Doing Tasks、Actions、Tools、Tone and Style、Output Efficiency；Doing Tasks 使用资产键 `tasks`，其中软件工程规则只在请求涉及代码与仓库时生效。boundary 后依次装配 `memory.cache`、稳定的 `memory.behavior`、按当前 Memdir 形态计算的记忆指导和按启用工具计算的工具指导。记忆 sections 不包含具体路径、日期、用户规则、Memdir 索引或主题正文。
- `block://memory.guidance`：定义 Auto Memory、append-only Daily Log、project shared memory、AutoDream 与 Session Continuity 的动态规则；宿主按真实 Memdir scope/mode 和服务能力选择，不把 `/projects`、Session ID resume、知识图谱或其他未实现机制写进 Prompt。
- `block://context.guidance`：定义活动上下文与外部文件上下文的边界，以及腰果已实现的旧 Tool Result masking、ContextResultStore 外置、Session Memory checkpoint 和隔离子 Agent 语义；宿主按真实 loop 能力选择，不写不存在的模型分工或自修改工具。
- `block://tool.guidance`：定义 Read、Write/Edit、Bash、受管检索、Todo、Subagent 与并行调用的动态路由指导；宿主只选择当前工具组合对应的 sections，不为未启用工具生成说明。
- `block://aesthetic.baseline.zh`：定义所有面向用户回答与产出的唯一审美哲学。
- `block://output.style`：定义 `explanatory` 与 `learning` 两个可选 Output Style Plugin；宿主只把选中的 section 注入当前轮 user message。
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
- `src/platform/ai/prompts.js#getSystemPrompt` 是面向用户 System Prompt 的唯一装配入口，返回 `Promise<string[]>`。`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 只在组装阶段标识静态区与任务会话缓存区，编译 System Prompt 时必须剔除，不发送给 API。
- 动态 Section 由名称、依赖键函数和异步计算函数组成；缓存 Map 使用 `dynamic:<name>:<dependency-key>`。Memory Guidance 的键只包含 scope、storage mode 与连续性能力开关，Context Guidance 的键只包含宿主上下文管理能力开关，Tool Guidance 的键只包含排序后的工具名；高频变化的路径、日期、模型和 MCP 状态不进入这些键。
- DeepSeek 缓存按从第 0 token 开始的完整前缀单元命中。当前日期、provider 明示的知识截止、语言偏好、平台、Shell、Git 身份、模型、工作目录、任务制作区、附加目录、MCP Client、Feature Gate、能力索引与 output style 只进入当前轮最后一条 `user` message 中的 `system-reminder/runtime_meta_context`；同一 Agent 循环的 tools 保持既有顺序与 schema 不变，显式加载的新能力只在尾部追加。
- Skill 与可加载工具使用两层渐进披露：运行时 Meta Context 只列 id、kind、≤240 字符 description 与≤3 个触发线索；命中后由 `load_capability` 精确装载一项完整 schema 或 Skill action，不因磁盘上存在文件就假设模型已经知道其能力。
- 语言偏好只在 `settings.language.preferred` 非空时进入运行时 Meta Context。知识截止只接受 provider 配置中明确给出的 `YYYY-MM` 或 `YYYY-MM-DD`；未声明时不猜日期，并要求可变事实使用当前来源验证。
- 当前没有模型可调用的 `ask_user_question`、`send_message`、设置修改或 Hook 写入工具。阻塞问题由最终可见回复提出并结束当前 turn；长任务阶段状态由宿主的 Tool Activity 事件持续展示，Prompt 不把这些宿主能力伪装成 Tool Schema。
- `outputStyle.mode` 只允许 `standard`、`explanatory`、`learning`。未配置时为 `standard`；另外两种风格由当前轮运行环境注入，不改写 Introduction 或其他 System Prompt 前缀。
- Compact 类内部请求保留待压缩内容的原始顺序，并把操作指令放在当前 `user` message 末尾，不在内容前增加变化指令。

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
