# dsh-prompt-enhance-local

DeepSeek Harness（DSH）桌面插件：在输入框右侧、发送键同排加一个 **✨ 增强提示词** 按钮。点击后用**本机 DSH 模型路由**把当前草稿整段改写为更清晰、更可执行的提示词；绝不自动发送，并保留一键「恢复原文」与 `Cmd/Ctrl+Z` 还原点。

- 纯本地：只走 `ctx.llm.stream()` 调用本机模型路由（`agentDefaultModel`），不访问任何外部服务。
- 语言一致：中文进中文出、英文进英文出、中英混排保持自然混排。
- 只输出提示词正文：无前言、无标签、无代码围栏、无包裹引号。
- 四态按钮：`✨ idle` → `⟳ enhancing（可点击取消）` → `↩ revert（恢复原文）` / `⚠ error（title 显示失败原因，点击重试）`。
- 图标：内联 Lucide（ISC）线性 SVG，切换有回弹动效，尊重 `prefers-reduced-motion`。

## 安装

用 DSH 的插件管理器安装本目录（绝对路径），**不要**手改 profile 的 `package.json` / `cordis.patch.yml`：

```
plugin_manager(action="install_bundle", target="/Users/vigor/Vibecoding/dsh-prompt-enhance-local")
```

确认激活：

```
plugin_manager(action="list_plugins")   # 找 entryId=include:prompt-enhance, fiberPhase=active
```

停用 / 启用：

```
plugin_manager(action="set_plugin", target="include:prompt-enhance", enabled=false)
plugin_manager(action="set_plugin", target="include:prompt-enhance", enabled=true)
```

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | DSH bundle 清单（`dsh.bundle.patch` + `dsh.client`） |
| `cordis.patch.yml` | 插入一行 `id: prompt-enhance`；行 `name` 必须等于包名 |
| `index.js` | **Host 半**（ESM）：`POST /prompt-enhance/enhance`，双层提示词 + 带外 `ctx.llm.stream()` + 后处理清洗 + 同源栅栏 |
| `client.js` | **Client 半**（lazy-CJS，`window.__ModuleLoader__.load` 包装）：`conversation.input.right` 槽位的按钮与四态状态机 |
| `prompt-template.mjs` | 双层提示词模板（`SYSTEM_PROMPT` / `USER_TEMPLATE` / `renderUserPrompt` / `buildMessages`） |
| `icon.svg` / `locale/{zh,en}.json` | 插件管理器显示元数据与文案 |
| `tests/` | 离线测试（Host 41 项 + Client 29 项，不启动 DSH） |
| `docs/` | 交付说明与验收报告、结构图、四态图标预览 |

## 接口契约

`POST /prompt-enhance/enhance`，body `{ "text": string, "model"?: string }`，HTTP **恒 200**（业务失败靠 `success:false`）：

```json
{ "success": true,  "text": "改写后的提示词" }
{ "success": false, "text": "", "code": "empty_input|llm_unavailable|llm_error|forbidden|bad_request|unknown", "error": "..." }
```

非 POST → 405；坏 JSON → 400；跨站/伪造 Origin → 403；`config.enabled === false` → 409；空输入短路不调模型。

## 开发与测试

```
NODE=$(command -v node)
$NODE tests/host.test.mjs      # 41 项
$NODE tests/client.test.mjs    # 29 项（vm 沙箱 + 自写 mini-React，因为 shell 注入 react）
```

改完插件文件即热更（`pnpm link`），无需重装；若需重装：`remove_bundle` → `install_bundle`。

## 已知限制

- 草稿里的 `@` 文件/对话引用按纯文本送入模型，不做引用展开。
- 模型为单次调用、不自动重试；失败由按钮 `⚠` 呈现，点击即重试。
- 4xx/5xx 摘要与验收证据见 `docs/交付说明与验收报告.md`。

## 许可与致谢

- 项目代码：MIT（见 `LICENSE`）。
- 图标路径内联自 [Lucide](https://lucide.dev)（ISC License），已按其许可在源码与 `NOTICE` 中保留署名；未引入任何运行时依赖。
