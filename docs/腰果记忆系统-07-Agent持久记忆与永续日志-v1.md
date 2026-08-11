# 腰果记忆系统 07：Agent 持久记忆与永续日志 v1

状态：已接入任务配置、Memdir、Extract Memories 与 AutoDream 夜间流程
日期：2026-08-09

## 一、定位

自定义 Agent 不是第二个执行引擎。所有 Agent 类型继续进入同一个 `runToolLoop()`、模型网关、工具授权和上下文协议；`agentType` 只定义长期记忆命名空间。代码审查 Agent、测试 Agent 与其他自定义 Agent 因此可以积累各自经验，而不会把主题、Prefetch 候选或 Dream 信号混到一起。

记忆的语义边界不因 Agent 类型变化：仍只允许 `user`、`feedback`、`project`、`reference` 四种封闭类型。Agent 类型决定“保存到哪一份 Memdir”，模型决定“什么值得保存以及如何组织”。

## 二、三种作用域

跨仓库作用域命名为 `agent`。它明确表示“同一 Agent 类型全域共享”，避免 `global` 被误解为所有 Agent 共用。

| scope | 共享范围 | 生产路径 | Git 行为 |
|---|---|---|---|
| `agent` | 同一 `agentType` 跨仓库 | `~/.yaoguo/agents/<agent-type>/memory/` | 不进入项目 Git |
| `project` | canonical Git root + `agentType` | `<canonical-root>/.yaoguo/agents/<agent-type>/memory/` | 可提交进 Git |
| `local` | canonical workspace + `agentType` | `~/.yaoguo/projects/<root-id>/agents/<agent-type>/memory/` | 只在本机 |

内建 `default + local` 保留原路径 `~/.yaoguo/projects/<root-id>/memory/`，已有 Memdir 不需要搬迁。Git worktree 仍按 `git-common-dir` 解析 canonical root，所以同一仓库的 worktree 共享 `project` 与 `local` 记忆身份。

任务通过以下持久化配置绑定记忆：

```json
{
  "agentMemory": {
    "agentType": "code-review",
    "scope": "agent",
    "mode": "append-only"
  }
}
```

`agentType` 必须是 1–64 字符的小写 ASCII kebab-case；`scope` 只允许 `agent/project/local`；`mode` 只允许 `indexed/append-only`。`ProjectService.configureTaskAgentMemory()` 负责校验并持久化。前台 Agent、后台 Extract Memories 和 AutoDream 都从同一任务字段绑定 store，模型工具参数不暴露作用域或目录。

## 三、JSON 快照

`MemdirStore.exportSnapshot()` 与 `exportSnapshotJson()` 序列化当前 Agent 的完整受管状态：

- 版本、种类、导出时间与来源 Agent profile；
- `memory.md`；
- 全部主题 Markdown 与逐文件 SHA-256；
- 待整理和已处理的日期日志与逐文件 SHA-256；
- 整体快照 SHA-256。

`importSnapshot()` 支持两种显式模式：

- `merge`：默认，只加入缺失文件；同名不同内容返回 `MEMDIR_SNAPSHOT_CONFLICT`。
- `replace`：用快照受管文件替换目标受管状态；锁与会话信号等宿主控制文件不属于迁移内容。

导入目标 Agent 和作用域由已经绑定的目标 store 决定，快照中的来源 profile 只作审计信息，不能改变落盘位置。宿主在写入前校验整体摘要、逐文件摘要、主题 Front Matter、四种类型、日志条目、大小与索引一致性；失败时恢复原受管状态。

产品层通过 `ProjectService.exportTaskAgentMemorySnapshot()` 与 `importTaskAgentMemorySnapshot()` 按任务解析 workspace 和 Agent profile；调用方不需要也不能提交 Memdir 绝对路径。

## 四、两种写入模式

### `indexed`

普通会话继续直接维护主题文件，并在每次非重复写入后确定性重建 `memory.md`。AutoDream 使用原有双门控：至少 24 小时且至少 5 个不同会话产生新记忆。

### `append-only`

永续会话的前台写入不改主题和索引，只向以下稳定模式追加：

```text
logs/{date}.md
```

宿主从动态 `current_date` 解析 `{date}`，模型不能提交文件名。实际文件例如 `logs/2026-08-09.md`，但具体日期从不写进 system prompt 或缓存的 Extract/Dream Prompt。

每个日志条目包含结构化四类型字段、记录时间和内容摘要。宿主使用 `O_APPEND + O_NOFOLLOW`，要求日志为 `nlink=1` 普通文件，单日日志不超过 2MB；相同内容摘要在同一天幂等去重。`memory.md` 权限设为只读，前台 `ensure()`、`pin_memory` 和 Extract Memories 都不能重建它。

Memdir 首次进入 append-only 后写入 `.append-only` 宿主标记。该策略对同一 Memdir 单向生效：其他任务或进程即使请求 indexed，也会检测标记并继续追加，避免共享 Agent 作用域出现一边重写索引、一边假设索引只读的冲突。需要恢复 indexed 时，应通过 JSON 快照导入新的 Agent 命名空间，而不是删除标记原地降级。

## 五、夜间 Dream

应用启动时 AutoDream 启动夜间入口：先做一次补偿扫描，此后按本地时间 02:00 扫描配置为 `append-only` 且确有待整理日志的任务。同一 Memdir 在一次扫描中只调度一次。

append-only 门控为：

```text
now - .autodream.lock.mtime >= 24 hours
AND
new-memory sessions >= 1
AND
pending date logs >= 1
```

四阶段仍由模型决策：

1. Orient 返回只读索引、主题元数据、待整理日期日志和近期会话入口。
2. Gather 必须读取全部待整理日期日志，以及可用的近期会话与拟修改主题。
3. Consolidate 用 `rewrite_memory` 合并已有主题；只有日志包含没有对应主题的新信号时，才用 `create_memory` 创建唯一主题。
4. Prune and Index 提交主题计划、重建只读 `memory.md`，并把已消费日志原样移动到 `logs/processed/`。

快照摘要覆盖主题、索引和全部待整理日志。Dream 运行期间出现新追加内容会改变摘要，最终提交返回 `MEMDIR_RESHAPE_CONFLICT`，不会吞掉并发日志。

## 六、缓存边界

稳定系统规范只写 `logs/{date}.md`；Extract Memories 与 AutoDream 的注册 Prompt 同样只写路径模式。`current_date`、`memory_mode` 和 `memory_log_pattern` 位于每次内部调用的动态 input，具体日期文件由宿主解析。

因此跨过午夜只改变 Extract/Dream 的动态数据与目标日志文件，不使稳定 Prompt 缓存失效。前台指令用户上下文中的日期属于独立会话缓存，在 `/clear` 或 Compact 后才重新取得；用户规则、日志日期和主题索引保持不同的缓存与 Token 预算。

## 七、实现与验收位置

- Agent profile：`src/platform/memory/memdir/agentMemoryProfile.js`
- 三作用域路径：`src/platform/memory/memdir/memdirPaths.js`
- append-only 日志：`src/platform/memory/memdir/memdirJournal.js`
- 快照、模式写入与 Dream 提交：`src/platform/memory/memdir/memdirStore.js`
- 任务配置：`src/platform/projects/actions/projectTaskActions.js`
- 前台绑定：`src/application/workflows/mixins/agentExecutionActions.js`
- 后台绑定：`src/platform/memory/extraction/memoryExtractionService.js`
- 夜间调度与门控：`src/platform/memory/autodream/autoDreamService.js`、`autoDreamState.js`
- Dream 日志工具：`src/platform/memory/autodream/autoDreamTools.js`
- 稳定系统规范：`workspace/registries/prompts/blocks/system.agent.v1.json#memory.behavior`
- 回归测试：`tests/agent-persistent-memory.test.mjs`
