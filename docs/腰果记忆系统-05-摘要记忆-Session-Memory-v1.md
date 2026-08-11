# 腰果记忆系统 05：摘要记忆 Session Memory v1

状态：已接入唯一 Agent loop 的渐进维护与 Compact 边界
日期：2026-08-09

## 一、定位

Session Memory 解决同一个任务会话内部的长上下文连续性。它不是长期知识，也不是在上下文耗尽时临时回顾全部历史。宿主在会话进行中按双阈值启动一个无工具的后台模型调用，让模型持续维护 `session/memory.md`；真正 Compact 时直接使用已经存在的笔记，再拼接协议完整的近期原始消息。

模型负责判断哪些目标、状态、规格、文件、函数、步骤、错误与修正仍影响后续工作。宿主只负责 Token 与工具计数、文件作用域、固定章节、输出上限、原子写入和消息协议边界，不用关键词或确定性模板替代语义判断。

## 二、存储与固定结构

每个任务的宿主私有会话目录新增两份文件：

```text
<task>/session/
├── events.jsonl
├── memory.md
└── .memory.state.json
```

`memory.md` 由后台模型完整替换，必须按顺序且各出现一次六个二级标题：

```markdown
## 会话标题
## 当前工作状态
## 任务规格
## 涉及的关键文件和函数
## 工作流步骤
## 遇到的错误与修正
```

每章至少一行，无内容写“无”，全文不超过 6000 tokens。`.memory.state.json` 只保存 revision、更新时间、turnId、上次更新的上下文 Token 与工具调用数，不复制会话正文。两份文件权限为 `0600`，所在 `session/` 目录继续处于普通 Agent 文件工具的读取与写入拒绝范围。

已有笔记在下一个前台 turn 作为后台更新的 `previous_memory` 继续演化；只有 Compact 发生时才作为独立的 `user` checkpoint 注入。它不进入 system prompt，也不升级为用户原话或权威事实。

## 三、双阈值与旁路更新

默认策略是：

| 参数 | 默认值 | 行为 |
|---|---:|---|
| `minContextTokens` | 20,000 | 总上下文低于此值不启动维护 |
| `updateDeltaTokens` | 12,000 | 上次更新后新增 Token 达到此值可更新 |
| `updateToolCalls` | 6 | 上次更新后新增工具调用达到此值可更新 |
| `maxUpdateInputTokens` | 36,000 | 单次增量输入上限 |
| `maxNoteTokens` | 6,000 | 完整笔记输出上限 |

触发条件为：

```text
contextTokens >= 20,000
AND
(deltaTokens >= 12,000 OR deltaToolCalls >= 6)
```

普通更新通过任务级串行队列旁路执行，`prepareNextTurn` 只登记快照，不等待模型结果。达到 Compact 线时才等待已经启动的更新；若现有笔记尚未覆盖计划删除的前缀，再让模型把这一小段增量合并进旧笔记。模型每次收到 `previous_memory + task_seed + new_messages`，不是在压缩时从零读取全部历史。

## 四、10 万 Token Compact

Agent 请求的真实 Token 估算包含首轮 `baseResponse.requestMessages`、后续 Pi 消息与工具 schema。总量达到 100,000 tokens 后可触发 Compact。压缩结果固定为：

```text
protected roots
+ SESSION_MEMORY_COMPACT user message（session/memory.md）
+ 12,000-32,000 tokens 的近期原始消息
```

大型工具结果仍由 `ContextResultStore` 外置；近期或被索引的结果可通过 `resultRef` 分页回读。若 Session Memory 更新失败或输出不符合六章节契约，本次压缩回落到原有确定性 checkpoint，不把格式错误的模型输出写盘或注入。

Compact 后的笔记只是派生连续性：当前用户要求高于笔记，精确内容回读 `events.jsonl`、任务历史投影或工具结果引用。

Compact 边界确定后，宿主清除当前任务的 `memoryFiles`、`userContext` 与 `systemPromptSections` 三层缓存。正在进行的响应继续使用旧快照；下一次装配才重新读取规则、日期和系统记忆 section。

## 五、messages-to-keep 边界算法

`calculateMessagesToKeepIndex()` 接收上次摘要位置、上次压缩边界与最小/最大近期 Token：

1. 从上次摘要位置计算尚未被笔记覆盖的消息量。
2. 少于 12,000 tokens 时按原子消息组向前扩展。
3. 多于 32,000 tokens 时按原子消息组向后收缩。
4. 向前扩展不得越过上一次 Compact 边界。
5. 单个协议原子组超过最大预算时保留完整原子组，并报告 `protocolOversize`；协议完整性高于 Token 上限。

边界移动前先把消息归并为原子组：

- assistant 的全部 tool use 与对应 tool result 属于同一组；
- 相同 `streamId` / `fragmentGroupId` 的流式片段属于同一组；
- `parentMessageId`、`thinkingParentId` 等关联消息属于同一组；
- 单条 assistant 消息内的 thinking、text 与 tool call 天然不可拆分。

因此保留起点只会落在原子组之间，不会生成缺少 tool result、孤立 thinking 或半条流式消息的 API 请求。

## 六、实现位置

- 渐进维护、双阈值与原子写入：`src/platform/memory/session/sessionMemoryService.js`
- 消息原子组与 keep index：`src/platform/context/sessionCompactionBoundary.js`
- Compact 装配与旧 checkpoint 回退：`src/platform/context/agentContextLifecycle.js`
- Agent loop 观察、等待与统计：`src/platform/ai/agentLoop/toolRuntime.js`
- 任务级文件路径：`src/platform/sessions/taskSessionStore.js`
- 模型契约：`workspace/registries/prompts/blocks/memory.session.v1.json`
- 回归测试：`tests/session-memory.test.mjs`
