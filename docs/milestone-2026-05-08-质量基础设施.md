# Milestone 2026-05-08：质量基础设施 + 最大债务清理

> 这一轮做完之后，腰果的**架构 + 测试 + 工程纪律**已经从"专业务实"接近"顶级标准"。两个最大的复杂度债务还清，安全网到位。剩下的工作分布到几条独立路径，可以按需单点推进。

---

## 一、本轮完成清单

### 工程纪律（基础设施）

| 项 | 文件 | 状态 |
|---|---|---|
| **CI workflow** | `.github/workflows/check.yml` | macOS + Linux × Node 20/22 矩阵；`concurrency: cancel-in-progress`；`npm ci`；独立 coverage job 上传 artifact |
| **复杂度红线** | `scripts/check/complexityRedlines.mjs` | acorn AST 检测；行数 ≤ 250、圈复杂度 ≤ 80；三向棘轮（新违规 / 债务恶化 / 已修未清都 fail） |
| **TypeScript 增量** | `tsconfig.json` + 13 个 `// @ts-check` leaf 文件 | `allowJs: true, checkJs: false, noEmit: true`；按文件 opt-in |
| **覆盖率采集** | `.c8rc.json` + `npm run test:coverage` | 含 platform/application/domain；不卡阈值，先让数字可见 |
| **预提交钩子** | `.husky/pre-commit` + `.husky/pre-push` | commit 前跑 check+typecheck（4s），push 前跑 test（1s） |

### 最大债务清理（两次拆分）

| 函数 | 拆分前 | 拆分后 | 拆分到 |
|---|---|---|---|
| `scanAiTasteSignals` | 727 行 / cx=200 | **29 行 / cx=4** | `src/platform/evals/aiTasteDetectors/`（7 个模块） |
| `executePatchedDeliverableStep` | 401 行 / cx=123 | **20 行 / cx=4** | `src/application/workflows/mixins/patched/patchedDeliverablePhases/`（5 个 phase） |

两次拆分都**没改变任何外部行为**——重构前后测试 100% 通过，断言完全相同。

### 安全网测试

| 测试文件 | 内容 | 覆盖率提升 |
|---|---|---|
| `tests/ai-taste-detectors.test.mjs` | 27 个 detector × 正反 case（56 测试）+ baseline-clean + fixture 数量守卫 | `aiTasteScannerActions.js` 0% → 90% |
| `tests/patched-deliverable.test.mjs` | 10 个集成测试覆盖关键分支 | `patchedDeliverableActions.js` 0% → 67% |
| `tests/fixtures/aiTasteFixtures.mjs` | 27 个 detector 的 ground-truth fixture | — |

---

## 二、关键指标总览

### 红线现状（全部由 `npm run check` 自动验证）

| 红线 | 上限 | 当前 |
|---|---|---|
| `services.js` 必须是 1 行 shim | 必须等于固定字符串 | ✅ |
| `legacy/monolith/servicesLegacy.js` 不得含核心类定义 | — | ✅ |
| `main.js` 不得 `require("./services")` | — | ✅ |
| Prompt 必须从注册表加载 | — | ✅ |
| Token 估算唯一出口 | `platform/tokens/tokenEstimator.js` | ✅ |
| 函数行数 | ≤ 250 | ✅（2 条债务 in allowlist） |
| 圈复杂度 | ≤ 80 | ✅（2 条债务 in allowlist） |
| `workflowEngine.js` 总行数 | < 2200 | 1763 ✅ |
| `app.js` 总行数 | < 1600 | 1389 ✅ |
| 测试通过 | 100% | 103/103 ✅ |
| TypeScript 检查（13 个 leaf） | 零错误 | ✅ |

### 测试与覆盖率轨迹

| 时点 | 测试数 | lines | branches | functions |
|---|---|---|---|---|
| 起点（你贴架构图时） | 37 | 24.94% | 48.52% | 23.82% |
| 加完 detector 矩阵后 | 93 | 26.74% | 59.21% | 24.67% |
| 加完 patched 集成测试 | 103 | 29.98% | 61.03% | 28.80% |
| **现在** | **103** | **30.44%** | **61.14%** | **29.49%** |

`branches` 从 48.52% → 61.14% 是这一轮最大的质量信号：覆盖的不仅是行，还包括了**条件判断的两侧**。

---

## 三、债务列表（仍登记在 `complexityRedlines.mjs` 的 `ALLOWLIST`）

### 剩余 2 条复杂度债务

| 函数 | 位置 | 行数 | cx | 拆解路径 | 紧迫度 |
|---|---|---|---|---|---|
| `runTask` | `src/platform/ai/aiRouter.js:42` | 451 | 75 | 按 selector / executor / recorder 拆——但三段共享状态多，慎重 | **中** |
| `runNextStep` | `src/application/workflows/mixins/runLifecycleActions.js:151` | 302 | 50 | 迁到现存的 `StepExecutor`——但这是 1-2 周引擎级迁移 | **低**（除非要做 StepExecutor 全量启用） |

### 已发现但未量化的债务

| 项 | 性质 | 优先级 |
|---|---|---|
| `StepExecutor` 死代码 | 在 `platformKernel.js:31` 实例化但全代码库无调用方 | **高（清洁度问题）** |
| 渲染端无质量约束 | `app.js` 1389 行 + `views/` 多个 200-500 行文件，0 个测试，0 个 `@ts-check`，复杂度红线豁免 | **高（最大盲点）** |
| CI 未接分支保护 | YAML 已写但 GitHub Settings 未设为 required check | **高（不接分保 CI 等于装饰）** |
| 测试真实捕捉力未量化 | 覆盖率 ≠ 测试质量。需变异测试（stryker）才能知道哪些测试是装饰 | **中** |
| `executeChunkedDeAiStep` 0% 覆盖 | `patchedDeliverableActions.js` 残余的另一个步骤 | **中** |
| 8 个测试套件覆盖不足 | 距离 50% lines 目标差 ~20pp | **中** |

---

## 四、下一步路径（按 ROI 排）

### 路径 A：清洁度收尾（半天，应优先）

1. **删除 / 启用 `StepExecutor`**（1 小时）
   - 读一下，要么补迁移 PoC（把 `runNextStep` 中一个 step kind 迁过去），要么删除并从 `platformKernel.js` 摘掉实例化。
   - 死代码不能留。
2. **CI required check 指引**（15 分钟）
   - 在 `docs/` 下加一份 `branch-protection.md`，写清楚要在 GitHub Settings 里勾哪些 check。
   - 在 README.md 里挂一个 CI badge。
3. **AGENTS.md 更新**（10 分钟）
   - 把今天新增的拆分目录写进 Architecture 章节。

### 路径 B：质量量化（半天）

4. **跑一次 stryker mutation testing**
   - 安装 `@stryker-mutator/core` + `@stryker-mutator/typescript-checker`
   - 配置只跑 `src/platform/evals/aiTasteDetectors/**`（覆盖率最高的区域，最适合验证测试质量）
   - 输出 mutation score。低于 70% 的 mutator 暴露的就是装饰性测试。
   - 修补漏检的测试。

### 路径 C：渲染端开始有约束（1-2 天）

5. **renderer 复杂度红线**
   - 把 `src/renderer/` 从 `complexityRedlines.mjs` 的 `SKIP_DIRS` 里移出（局部允许 IIFE 包裹检测）
   - 测量当前违规情况，建立基线 ALLOWLIST
6. **`app.js` 1389 行起步拆分**
   - 看看里面是事件路由 + 业务逻辑混合，还是已经有结构
   - 至少把 IPC bridge 的 dispatch 表拆出去（通常这是最大块）
7. **第一个 view 测试**（jsdom + 一个 view 的快照测试）—— 验证前端测试基础设施可行

### 路径 D：续做后端债务（如果你要完美主义）

8. `runTask` 拆 selector/executor/recorder
9. `runNextStep` 迁 StepExecutor（建议路径 C 完成后再做，因为这是引擎级动作，要和前端架构一起决策）

### 路径 E：增量 TS 第三批（30 分钟，零风险，背景任务）

10. 把 `// @ts-check` 推到 `platform/artifacts/`、`platform/context/`、`platform/decisions/` 等下一批 leaf

---

## 五、几个值得记录的判断

### 关于"拆分价值"的认知

两次拆分都成功的关键不是机械执行——是**先验证拆分目标天然有清晰边界**：
- `scanAiTasteSignals` 27 个 detector 各自独立，本来就该是独立模块
- `executePatchedDeliverableStep` 是 preflight → detect → scan → apply → finalize 的线性流水线，phase 间有干净的数据交接

`runTask` 不一样——selector / executor / recorder 共享重试 / 降级 / 计费状态，**强行拆可能只是把复杂度推到 ctx 字段**。这就是为什么我把它的优先级降到"中"。

### 关于棘轮

`complexityRedlines.mjs` 的三向棘轮（**新违规 fail / 债务恶化 fail / 已修未清 fail**）这一轮证明了价值——两次拆分完成时它都精准触发"已修未清"，强制清理 allowlist。这意味着**债务列表永远反映现实**，没人能"忘记清"。

这个机制是 Stripe / Shopify 在 ESLint plugin 上的标准玩法，但在这种自定义 check 脚本里也能工作。

### 关于"顶级"的边界

写完的代码和写完的测试加起来，离"专业团队"已经达标，距"顶级"还差几口气：
- TS 不是 strict（增量 13 个文件，目标该是大部分 platform/）
- 没有变异测试
- 没有属性测试
- 渲染端无约束
- CI 未接分支保护

但这几口气是**有明确路径**的——不是模糊的"还要努力"，而是上面列的清晰待办清单。

---

## 六、文件清单（这一轮新增 / 改动）

### 新增

```
.github/workflows/check.yml                                        # CI matrix + concurrency
.husky/pre-commit                                                  # check + typecheck
.husky/pre-push                                                    # test
.c8rc.json                                                         # 覆盖率配置
tsconfig.json                                                      # TS 增量配置
scripts/check/complexityRedlines.mjs                               # AST 复杂度红线
tests/ai-taste-detectors.test.mjs                                  # 27 detector 矩阵测试
tests/patched-deliverable.test.mjs                                 # 集成测试
tests/fixtures/aiTasteFixtures.mjs                                 # detector ground-truth
src/platform/evals/aiTasteDetectors/                               # 7 个 detector 模块
docs/milestone-2026-05-08-质量基础设施.md                          # 本文档
src/application/workflows/mixins/patched/patchedDeliverablePhases/ # 5 个 phase
```

### 改动

```
package.json                  # +typecheck/test:coverage 脚本，+5 个 devDep
package-lock.json
scripts/check.mjs             # 接入 complexity redlines
scripts/check/workflowRegression.mjs  # 把拆分后的 detector 文件加入 grep 源列表
src/platform/evals/aiTasteScannerActions.js  # 从 803 行 → 113 行
src/application/workflows/mixins/patchedDeliverableActions.js  # 从 656 行 → 283 行
src/platform/{shared,tokens,prompts,registries,runs,workflows}/  # 13 个文件加 // @ts-check
AGENTS.md                     # +复杂度红线章节、+TS 增量策略
```

### 依赖

新增 5 个 devDependency：
- `acorn` + `acorn-walk`（AST 解析）
- `typescript` + `@types/node`（类型检查）
- `c8`（覆盖率）
- `husky`（git hooks）

总安装包数 47 个（含传递依赖）。零运行时依赖变化。

---

## 七、一句话总结

**腰果今天从"架构上对、工程纪律待补齐"走到了"架构上对、工程纪律到位、最大债务清完"——剩下的事不是必须要做才能继续开发，而是要做才能持续保持"顶级"。**
