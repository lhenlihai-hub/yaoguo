# 参与贡献

感谢你愿意改进腰果。提交代码前，请先阅读根目录的 `AGENTS.md`；其中的架构边界、复杂度红线和项目卫生规则对人工与自动化贡献同样生效。

## 开发环境

需要 Node.js `22.19.0` 或更高的 Node 22 版本。

```bash
npm install
export DEEPSEEK_API_KEY="你的测试密钥"
npm run cli
```

## 修改原则

- 所有回答、工具调用和交付必须继续使用 `src/platform/ai/agentLoop/agentLoop.js` 中的唯一 Agent loop。
- `@earendil-works/pi-agent-core` 是内部基础依赖，不新增引擎选择、备用模型或第二套业务命名空间。
- 终端交互只放在 `src/cli/`；业务规则属于 `src/application/` 或 `src/platform/`。
- Prompt 必须是注册资产，不在业务代码中内联堆叠任务模板。
- 模型支持范围保持为 DeepSeek；新增提供商属于产品方向变化，不能作为普通 PR 引入。
- 不提交 API Key、本机路径数据、对话、项目、运行记录、日志、coverage 或安装包。
- 避免顺手格式化或重写无关文件；已有未提交修改属于原作者。
- 新行为应附带正常路径、失败路径与安全边界测试。

## 验证顺序

顺序不可交换：

```bash
npm run check
npm run typecheck
npm test
```

影响依赖、配置、运行时数据或公开文档时，再执行：

```bash
npm run check:open-source
```

## 提交与 Pull Request

- 每个提交只表达一个完整动机，提交信息说明为什么修改。
- PR 描述应包含问题、方案、验证结果、兼容性影响和安全影响。
- 行为变化需要同步 README 或对应文档。
- 不通过删除测试、放宽安全边界或扩大复杂度 allowlist 来掩盖失败。
- 安全漏洞不要提交公开 Issue，请按 `SECURITY.md` 私下报告。

Copyright © 2026 刘海涛。
