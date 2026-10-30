# dsh-workspace

DeepSeek Harness（DSH）的本地工作区，存放自建的插件 / bundle。每个子目录都是**独立可安装**的，用 DSH 的 `plugin_manager`（或手工 `pnpm add link:`）挂到 profile 上。

| 目录 | 类型 | 说明 |
| --- | --- | --- |
| [`dsh-prompt-manager/`](dsh-prompt-manager/) | Host + Client 插件 | 输入框权限按钮旁的图标打开提示词下拉，一键插入草稿 |
| [`figma-mcp/`](figma-mcp/) | 配置型 bundle | 把 **Figma 桌面版** Dev Mode MCP server（`http://127.0.0.1:3845/mcp`）接入 DSH，提供 `mcp__figma-desktop__*` 工具 |
| [`tunnel-notify/`](tunnel-notify/) | Host 插件 + 脚本 | 监听 `@wenbin_wb/dsh-bridge` 的公网隧道地址变更，自动推送到微信 / QQ / 飞书 / Telegram |

## 安装方式

DSH 的 profile（默认 `~/.dsh/profiles/desktop/`）把 bundle 目录以 `link:` 依赖加入，并登记到 `dsh.profile.bundles`：

```bash
# 以 figma-mcp 为例；其它目录同理
plugin_manager install_bundle target="link:/绝对路径/dsh-workspace/figma-mcp"
```

不建议手工复制这些步骤：`plugin_manager` 会同时处理依赖安装、`bundles` 登记和热生效，并返回 `nextStep`。

> ⚠️ 因为用 `link:` 引用，**移动或删除这些目录会让对应插件失效**（`git clone` 到新机器后需要重新安装一次）。

## 环境要求

- DeepSeek Harness 桌面版（内置 `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-client-ui-*` 等包，无需额外 npm 依赖）
- Node.js ≥ 22（仅 `tunnel-notify/build.mjs` 与部分脚本需要）
- `figma-mcp` 需要 Figma 桌面客户端，并在 **Figma → Preferences → Enable Dev Mode MCP Server** 打开本地端点；要求 Dev/Full 席位

## 安全说明

- 仓库内**不含任何密钥**：所有 token / secret 都在运行时从 `~/.dsh/...` 的外部配置读取（例如 `dsh-bridge` 的 `wechat.accounts[0].token`）
- `.gitignore` 排除了 `node_modules/`、`.state/`（含隧道 URL 等本机状态）、`*.log`、`.env*`、`*.pem`、`*.key`
- 提交身份使用 `sorrymeika@users.noreply.github.com`，避免暴露个人邮箱

## 相关文档

- `figma-mcp/README.md` —— 开启 Figma MCP、排错表、联调记录
- `cordis-plugin-development` skill（DSH 内置）—— 插件包结构、patch 方言、MCP bundle 模板