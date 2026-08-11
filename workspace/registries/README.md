# 腰果资产注册表

这里保存可版本化的非运行态资产；运行记录、用户项目和生成文件不进入注册表。

边界：

- `prompts/`：稳定 prompt 与单一职责 block，业务代码只引用 ID。
- `skills/`：Skill 指令、机器契约和确定性脚本。

所有任务使用 `workspace/workflows/agent-default.json`。同一人格、审美、模型能力或 Skill 权限只在一个资产中定义，其他位置引用，不重述。
