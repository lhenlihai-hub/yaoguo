# 生产依赖安全记录

本文记录无法立即升级消除、但已经完成可达性分析的生产依赖告警。每个公开 tag 前必须重新执行审计；出现修复版本或执行路径变化时，本记录不能作为继续忽略告警的依据。

## `pptxgenjs` 间接依赖 `image-size`

- 记录日期：2026-08-10
- 检测命令：`npm audit --omit=dev --audit-level=moderate`
- 依赖链：`pptxgenjs@4.0.1` → `image-size@1.2.1`
- 告警：`GHSA-w3rx-r6r6-pgpr`、`GHSA-5p2g-fcmc-qvqq`
- 上游状态：两个告警均影响 `image-size <= 2.0.2`，当前没有 patched version；强制 `npm audit fix` 会把 `pptxgenjs` 降到不兼容的旧版本，因此不执行。

### 可达性结论

当前腰果执行路径不调用 `image-size`：

1. `pptxgenjs@4.0.1` 的 CommonJS 运行产物不静态导入 `image-size`。
2. PPTX Skill 只接受带有已验证宽高的 PNG、JPEG、GIF、WebP data URI，不接受告警涉及的 ICNS、JXL 或 HEIF 输入。
3. 腰果代码不把 `image-size` 暴露为 Agent 工具，也不允许未受信任代码直接加载它。

npm 仍会因为上游依赖声明安装这个未使用模块，因此审计会继续报告告警。这不是“已修复”，而是一项经过可达性复核的暂时例外。若代码开始解析相关图片类型、PptxGenJS 开始调用该依赖，或未受信任代码可直接加载它，则例外立即失效并阻塞发布。

### 退出条件

满足任一条件后移除此例外：

- 上游发布不受影响的 `image-size` 版本，且 `pptxgenjs` 的版本范围可解析到该版本；
- `pptxgenjs` 移除该未使用依赖；
- 项目更换 PPTX 生成实现，不再引入该依赖。

每个公开 tag 前都要重新运行生产依赖审计，并复核 GitHub Advisory Database 中两个告警的 patched version。
