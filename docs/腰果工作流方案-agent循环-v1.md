# 腰果通用 Agent 架构

## 不可变前提

腰果只有一个通用 Agent。直接回答、研究、文件修改、命令执行和成品交付都是同一个连续循环中的行为，不按请求类型选择另一套 Agent 或另一种引擎。

架构必须持续满足以下约束：

1. `runToolLoop()` 是唯一 Agent loop。
2. 不存在 `engine: "pi" | "native"`、native fallback 或平级循环实现。
3. `@earendil-works/pi-agent-core` 只是 `agentLoop` 内部依赖，不形成 `pi/` 目录、`pi*` 业务命名或外接式适配层。
4. 会话和持久化运行共享同一个 loop、身份、审美、模型网关与安全运行时。
5. 当前作用域只决定哪些服务和工具真实可用，不改变 Agent 身份或执行机制。
6. 文档转换、视觉验收、选择区改写和文件落盘不得启动第二个内容或视觉 Agent。

## 一次运行

```text
构造当前目标与有效上下文
  → 广告基础工具和当前可用的高频能力
  → 模型直接回答或发出 tool_calls
  → schema、授权、配额和作用域检查
  → 执行工具并写回真实结果
  → 按需揭示低频能力或分页读取大型结果
  → 模型继续处理
  → 模型不再调用工具时自然结束
```

`read`、`write`、`edit`、`bash` 始终属于循环基础能力。扩展工具按当前项目、任务、runDir 和已初始化服务过滤；扩展工具为空时，基础能力不会消失。

工具轮的候选文字不单独发布。工具结果写回同一消息历史后，模型自然继续；循环不会额外创建一个名为 final 的模型阶段。达到工具轮或工具预算上限时，下一轮关闭工具访问，让模型根据已有结果完成自然回复；若仍只有未完成的工具调用或空结果，运行明确失败。

## 内部组成

`src/platform/ai/agentLoop/` 是腰果 Agent 内核：

- `agentLoop.js`：唯一连续循环与自然结束条件。
- `coreDependency.js`：ESM-only 依赖的唯一加载边界。
- `messageProtocol.js`：DeepSeek / OpenAI 消息与 Agent 事件的协议转换。
- `scopedTools.js`：当前任务目录内的 `read/write/edit/bash`。
- `toolRuntime.js`：工具广告、schema、授权、副作用、配额、去重、结果外置与事件。

这些文件共同构成腰果自身的执行内核。第三方包名只应出现在依赖加载、包清单、许可证和法律声明中。

所有模型请求继续经过 `AiRouter` 与 `ModelGateway`。Agent 内核不得直接 `fetch` 模型供应商，也不得持有第二份模型配置。

## 身份与审美

稳定 system prompt 只有三个真相资产：

- `block://soul.zh`：腰果的性格、判断方式与长期表达取向。
- `block://system.agent`：通用 Agent 的行动、工具、事实与完成规则；其中独立的 `memory.behavior` section 保存稳定记忆行为规范。
- `block://aesthetic.baseline.zh`：所有面向用户回答与产出共同使用的统一审美原则。

具体的文本、代码、报告和视觉执行方式由模型根据真实目的、用户要求、项目参考与当前工具自主决定。文件可打开、内容不裁切、不越界、不重叠、图片不损坏等客观有效性由工具验证。不得重新创建 `aesthetic.visual-authoring` 或专用视觉人格。

人工维护的 Managed、User、Project、Local 指令不是第四个 system 真相源。它们由宿主作为首条 `user` message 注入，并以 `<system-reminder><instruction-memory>…` 包裹；路径激活的增量作为后续 protected user root。用户规则正文从不拼接到 system prompt。

内部分类、查询规划、长期记忆 Prefetch、事实检查和质量判断属于无工具的单一职责模型调用，只加载各自协议，不加载 `soul`、审美原则、`memory.behavior` 或用户指令记忆。Prefetch 与主 Agent并行，只接收主题文件前 30 行 Front Matter 元数据，返回 0-5 个当前 Memdir 文件名。Extract Memories 是 assistant 消息持久化后 fork 的受限维护 Agent：它仍复用 `runToolLoop()`，但只有 `read`、`grep`、`write_memory`，最多 5 轮且不阻塞前台交付。AutoDream 同样复用该循环：indexed 模式使用 24 小时与 5 个不同会话双门控，append-only 模式使用 24 小时、1 个新记忆会话与待整理日志门控，由夜间入口以最多 12 轮完成四阶段离线整合。

## 工具与能力披露

`toolCapabilityPolicy.js` 是工具行为的单一目录。每项能力声明：

```text
namespace
effect: read / network_read / model_compute / workspace_write
parallelSafe
repeat: reuse / reject
maxCallsPerLoop
resident / loadable / hidden
```

当前轮的工具集合由真实作用域和服务可用性决定：

- 会话尚无 runDir 时，不广告依赖 run/step 的 todo 与 handoff 工具。
- 持久化运行具有 runDir 时，可以获得对应能力。
- 文件基础工具始终限制在当前 task 目录。
- 未广告的工具返回 `TOOL_NOT_AUTHORIZED`，即使它存在于注册目录中也不执行。

通用 Agent 中安全读取可以并行，含写入、模型计算或其他副作用的批次串行。Extract Memories 的 `write_memory` 是显式例外：模型在独立写入回合并行发出不同主题，Memdir 在磁盘提交层串行化。重复读取在状态未变化时可复用，重复副作用拒绝执行。object schema 默认拒绝未声明字段。

`load_capability` 只返回最相关的能力，不在零匹配时挂载整个目录。Skill 的说明、输入 schema、路径读写声明和授权都由 Skill 契约提供，system prompt 不复制操作手册。

## 交付能力

Agent 直接完成内容与源码，宿主只提供确定性的边界动作：

- `generate_document`：把当前回复、对话正文或已有成品转换为 DOCX、PDF、PPTX、XLSX，并验证文件结构。
- `generate_visual`：读取 Agent 已在 task 内写好的完整 HTML，检查图片、本地化、越界、裁切和文字重叠，通过后登记 HTML 并尽力导出 PDF。
- `final-package`：只在持久化运行中原样保存 Agent 结果，不调用模型、不改写内容。

文件数量不是宿主路由条件。Agent 在普通文件工具中用 `deliverable` 明确选择交付候选，并对选中的每个文件执行检查与发布；未选中的源稿、脚本、依赖、预览和缓存只留在受管制作区。宿主不根据任务关键词计算默认数量或发布上限。

视觉检查失败时，错误作为工具结果返回同一个 Agent，由它使用 `read/edit/write` 修正后重试。宿主不得偷偷调用模型自动修复。

## 子任务

`spawn_subagent` 是通用 Agent 的按需委派工具，不是第二套主执行系统。子任务：

- 复用同一个 `runToolLoop()`；
- 从自包含任务描述开始，不继承全部对话；
- 只能使用宿主裁定的安全工具子集；
- 不能再次调用 `spawn_subagent`；
- 与父任务共享模型次数、工具次数、墙钟 deadline 和 AbortSignal；
- 返回结果给父任务后，由父任务在原循环中继续。

`llm_judge_quality` 同样是按需模型工具，不是自动审核阶段。

Extract Memories 不是主 Agent 可调用的委派工具。它由宿主在 durable assistant 消息之后调度，不继承父任务预算或 AbortSignal；本轮主 Agent 已成功 `pin_memory` 时不启动，只推进提取游标。后台 Agent 不能调用 `spawn_subagent`，因此不会形成递归树。

## 上下文与预算

上下文由稳定目标、活跃消息、项目资料、内容寻址结果和确定性 checkpoint 组成。大型工具结果只保存一次，模型收到带信任等级的 receipt，并通过 `read_context_result` 分页读取。

六维记忆的统一边界见 [腰果记忆系统总览 v1](./腰果记忆系统-总览-v1.md)。第一维“指令记忆”的四层文件族、`@include`、`pat`、路径激活、双轨注入、独立缓存与 checkpoint 连续性已经接入本循环，运行时契约见 [腰果记忆系统 01：指令记忆 v1](./腰果记忆系统-01-指令记忆-v1.md)。第四维的两层 Memdir、动态召回与后台自动写入见 [腰果记忆系统 04：长期记忆 Memdir v1](./腰果记忆系统-04-长期记忆-Memdir-v1.md)、[腰果记忆系统 04A：动态召回 Prefetch v1](./腰果记忆系统-04A-动态召回-Prefetch-v1.md) 和 [腰果记忆系统 04B：自动写入 Extract Memories v1](./腰果记忆系统-04B-自动写入-Extract-Memories-v1.md)；第六维见 [腰果记忆系统 06：离线整合 AutoDream v1](./腰果记忆系统-06-离线整合-AutoDream-v1.md)。自定义 Agent 作用域、JSON 快照与永续日志见 [腰果记忆系统 07：Agent 持久记忆与永续日志 v1](./腰果记忆系统-07-Agent持久记忆与永续日志-v1.md)。

一个前台 turn 内的模型调用、供应商重试、模型式压缩、按需子任务和 judge 共享同一个执行预算。Extract Memories 在前台 turn 完成后使用独立的 5 轮后台预算；AutoDream 使用独立的 12 轮离线预算。二者不占用已经关闭的父预算，也不延迟其完成。缓存命中不重复计费，真实工具执行才扣减工具额度。取消信号传播到前台模型、网络和 Skill 子进程；取消后的旧执行不能覆盖已持久化状态。

## 外部数据与文件边界

- 网络读取阻断凭据 URL、本机、私网、链路本地、保留地址和危险重定向。
- 网络结果与外部 Skill 结果标记为 `untrusted_external_data`，回读后仍保留该标记。
- 外部内容中的指令不能修改系统目标、扩大权限或自行触发动作。
- 引用写入只接受用户提供或本轮真实观察到的 URL。
- 文件访问使用 realpath scope；符号链接、未解析父目录和输出路径不能越过授权边界。
- Skill 子进程使用最小环境、资源上限和明确的 `pathParams.read/write`。

## 自动护栏

`npm run check` 必须阻止以下回退：

- 恢复 `src/platform/ai/pi/`、`agentTools/toolLoop.js` 或任意双引擎选择。
- 新增 `pi*` 业务文件、函数、常量或重复依赖版本常量。
- 恢复 `produce_content`、`revise_content`、嵌套视觉生成或自动视觉修复。
- 恢复 `system.chat`、`system.production`、`chat.dialogue`、`chat.style` 或 `aesthetic.visual-authoring`。
- 绕过 `ModelGateway` 直接调用模型。
- 让交付工具在循环之外执行或让扩展能力覆盖基础工具。

验证顺序固定为：

```bash
npm run check
npm run typecheck
npm test
```
