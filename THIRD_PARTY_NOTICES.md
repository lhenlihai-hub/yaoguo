# Third-Party Notices

## Pi

- Project: Pi
- Source: https://github.com/earendil-works/pi
- Packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui` and their Pi dependencies
- Locked version: see the exact dependency in `package.json`
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner

腰果将公开 SDK 作为内部实现依赖，没有修改安装在 `node_modules` 中的上游源码。
腰果的产品行为、模型、上下文、权限、工作区、安全与审美规则均保存在本仓库。

完整许可证见 `licenses/pi-MIT.txt`。

## Anthropic Sandbox Runtime

- Project: Anthropic Sandbox Runtime
- Source: https://github.com/anthropic-experimental/sandbox-runtime
- Package: `@anthropic-ai/sandbox-runtime`
- Locked version: see the exact dependency in `package.json`
- License: Apache License 2.0
- Copyright: Copyright 2025 Anthropic

腰果直接调用上游公开运行时，在 macOS 使用 Seatbelt、在 Linux 使用 bubblewrap 约束 Agent 命令；没有修改安装在 `node_modules` 中的上游源码。
它只负责 `bash` 子进程的操作系统级隔离；Agent 循环与基础工具仍由 Pi Agent Core 提供，模型与产品权限系统不依赖 Anthropic 服务。

完整许可证见 `licenses/anthropic-sandbox-runtime-Apache-2.0.txt`。
