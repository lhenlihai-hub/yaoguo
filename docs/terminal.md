# 腰果终端使用说明

终端版直接调用腰果唯一的应用服务和 Agent loop。交互、stdin 与 JSON 只是输入输出方式不同，不会切换模型、工具集合或执行引擎。

## 快速开始

一行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/lhenlihai-hub/yaoguo/main/install.sh | sh
```

安装完成后，中文与英文命令等价：

```bash
export DEEPSEEK_API_KEY="你的密钥"
腰果
yaoguo "阅读当前目录并给出改进建议"
```

如果当前 npm 的全局目录不可写，安装器会使用 `~/.local` 并更新当前 shell 的启动文件。由于管道脚本无法修改父 shell 的环境，这种回退情况下需要新开一个终端，或按安装器的提示执行一次 `export PATH=...`。

从源码运行：

```bash
npm install
export DEEPSEEK_API_KEY="你的密钥"
npm run cli -- "阅读当前目录并给出改进建议"
```

不带任务时进入连续会话：

```bash
npm run cli
```

也可从 stdin 接收单次任务：

```bash
printf '%s\n' '总结 README.md' | npm run cli
```

如果通过 `npm link` 建立了本地命令，可把 `npm run cli --` 换成 `yaoguo` 或 `腰果`。

## 参数

```text
--workspace <目录>  Agent 工作空间，默认当前目录
--data-dir <目录>   运行数据目录，默认 ~/.yaoguo/runtime
--project <id>      使用或创建指定项目
--task <id>         使用或创建指定会话
-n, --new           在当前工作空间创建新会话
-y, --yes           本次进程自动授权需确认的工具操作
--json               单次任务输出 JSON
-v, --verbose        显示完整 Agent 活动
-q, --quiet          隐藏活动与本轮 token 统计
-h, --help           显示帮助
-V, --version        显示版本
```

`YAOGUO_HOME` 可设置默认运行数据目录，显式 `--data-dir` 的优先级更高。默认会话按工作空间的 canonical path 生成稳定 ID，因此回到同一目录会继续原会话；`--new` 会创建独立会话。

## Agent 状态与 token

交互终端默认显示规划、工具活动和完成状态。每轮结束后会显示模型调用次数、输入 token、输出 token、其中的推理 token、DeepSeek prompt cache 命中 token、命中率和本轮耗时。

```text
本轮 3 次模型调用 · 输入 12,345 · 输出 678 · 推理 120 · 缓存命中 75%（9,000/12,000） · 12.5s
```

输入 `/usage` 或 `/tokens` 可读取当前会话累计数据。这个命令直接查询本地 TokenLedger，不会调用模型，也不需要消耗 token：

```text
会话累计 18 次模型调用 · 输入 84,210 · 输出 6,422 · 推理 2,041 · 缓存命中 68%（57,263/84,210）
```

`--json` 会把本轮 `usage` 放入结构化结果；以 `--json /usage` 调用时只输出累计统计对象。

## 权限

安全读取、模型计算和 Agent 状态写入无需确认。修改工作空间、执行命令、访问网络、打开外部网址和写入长期记忆等操作遵循统一权限策略。

交互终端会显示授权目标与边界，可选择允许一次、本次进程允许、持久允许精确操作、持久允许该类型或拒绝。非交互 stdin 默认拒绝需要确认的操作；只有显式传入 `--yes` 才会在本次进程内自动授权。

`--yes` 不会取消路径边界、参数校验、无提权、私网阻断或沙箱限制，但仍可能允许 Agent 修改当前工作空间和执行命令。只在已审阅任务与可信目录中使用。

## 输出与退出码

- 普通模式把 Agent 正文写入 stdout，把活动、授权、成品路径和本轮统计写入 stderr。
- `--json` 关闭 token 流，在 stdout 输出项目、会话、工作空间、回复、成品和 usage。
- `--quiet` 保持 stdout 正文不变，同时隐藏 stderr 中的活动和本轮统计；授权请求仍会显示。
- 启动、配置或输入错误返回退出码 `1`；正常完成返回 `0`。

终端进程不启动 scheduler、bridge 或夜间后台任务，也不会主动打开系统浏览器。不要让两个进程同时修改同一个任务会话。
