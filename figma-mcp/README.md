# Figma Desktop MCP（DSH 配置型 bundle）

把 **Figma 桌面版** 自带的 Dev Mode MCP server 接到 DSH：无需写代码，只用一个 `cordis.patch.yml` 插入已有的
`@deepseek-ai/dsh-mcp-client` 插件。

- 包名：`@local/dsh-figma-mcp`
- MCP 端点：`http://127.0.0.1:3845/mcp`（streamable HTTP）
- serverName：`figma-desktop` → 工具对外名字为 `mcp__figma-desktop__<tool>`

## 1. 打开 Figma 的 MCP server

1. 打开 **Figma 桌面客户端**（网页版不行），登录。
2. 菜单 **Figma → Preferences**（macOS）或 **Figma → 首选项**，勾选 **Enable Dev Mode MCP Server**。
3. 看到提示 “MCP server running at http://127.0.0.1:3845/mcp” 即就绪；终端可用
   `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3845/mcp` 探测（有响应即可，根路径 405/400 都算活着）。

> Figma 版本较老时该开关叫 “Enable local MCP server”。早期只提供 SSE 端点 `/sse`，而当前
> `dsh-mcp-client` 只支持 `stdio` 与 `streamable-http` 两种 transport，因此请把 Figma 升级到带
> `/mcp` 端点的版本。

## 2. 安装到 DSH profile

自动化方式（Agent 已执行）：

```bash
# 由 plugin_manager 完成：把本目录以 link: 依赖加入 profile，并写入 dsh.profile.bundles
```

手工方式（等价）：

```bash
PROFILE_DIR=~/.dsh/profiles/desktop      # DSH_PROFILE=desktop 时
cd "$PROFILE_DIR"
pnpm add "link:/Users/user/Documents/deepseek-harness/default-workspace/figma-mcp"
node -e "const fs=require('fs'),p='package.json',pkg=JSON.parse(fs.readFileSync(p));
pkg.dsh.profile.bundles.includes('@local/dsh-figma-mcp')||pkg.dsh.profile.bundles.push('@local/dsh-figma-mcp');
fs.writeFileSync(p,JSON.stringify(pkg,2))"
```

然后**重启 DeepSeek Harness**（profile 的 bundle 列表在启动时组装）。

## 3. 使用

在 Figma 里选中一个 frame / component / 图层，然后在 DSH 里让 Agent 使用 `mcp__figma-desktop__*` 工具，例如：

- `get_design_context` —— 当前选中的设计结构 + 代码提示
- `get_screenshot` —— 选中节点的截图
- `get_metadata` —— 选中节点的层级 / 尺寸概览
- `get_variable_defs` —— 变量（design tokens）
- `get_code_connect_map` / `get_code_connect_suggestions` —— Code Connect 组件映射

## 4. 排错

| 现象 | 处理 |
| --- | --- |
| 工具列表里没有 `mcp__figma-desktop__*` | Figma 没开或 Dev Mode MCP 没开启；插件按 1s→30s 退避自动重连（约 35 天预算），打开 Figma 后无需重启 DSH |
| 一直连不上 | `curl -i http://127.0.0.1:3845/mcp` 看是否有响应；确认端口 3845 未被其它进程占用 |
| 端口冲突 | 改 `cordis.patch.yml` 里的 `url`（Figma 端口固定为 3845，通常无需改） |
| 需要自己的 serverName | 改 `serverName: figma-desktop`（必须匹配 `[A-Za-z0-9_-]{1,32}`，且全局唯一；**不能带空格**，所以 `"Figma Desktop"` 这种写法用不了） |
| 旧版 Figma 只有 SSE | 当前 `dsh-mcp-client` 只支持 `stdio` 与 `streamable-http`，没有 SSE transport，请升级 Figma 桌面版到提供 `/mcp` 的版本 |
| 想改用云端 `https://mcp.figma.com/mcp` | 该端点是 `401 + Bearer resource_metadata=...oauth-protected-resource`，要求 OAuth 2.0 或 `X-Figma-Token` 头；而本插件的 streamable-http transport 只透传 `headers`、**不跑 OAuth 流程**，所以只能手动塞 Figma PAT（`headers: { X-Figma-Token: ... }`），且账号需 Dev/Full 席位。默认仍推荐本地桌面版 |

## 5. 为什么用 `failOnStartupError: false`

Figma 的 MCP server 只在桌面客户端运行时存在。若设为 `true`，Figma 没开时整个 DSH 启动会失败。
这里关掉它，并由 `reconnect` 承担“先开 DSH、后开 Figma”的常见用法。

## 6. 联调记录（2026-10-29）

- 端点探测：`POST http://127.0.0.1:3845/mcp` → `200`，`serverInfo.name = "Figma Dev MCP Server"`，`protocolVersion = 2025-11-25`
- DSH 侧自动重连（未重启 Host），`mcp__figma-desktop__get_metadata` 返回了真实文件里选中节点的层级：
  `Chart`（4487:122819，900×446），内含 `Main Kline` / `Kline_price detail` / `Orderbar` / `Y axis` 等子树
- 结论：`mcp__figma-desktop__<tool>` 已可用；之后在 Figma 里选中节点即可让 Agent 读取设计