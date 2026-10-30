# DSH 隧道地址 → 微信自动通知

**问题**：dsh-bridge 的公网隧道（Cloudflare 免费临时隧道）每次重启都会换一个
`*.trycloudflare.com` 域名，手机上存的旧链接立刻失效，人不在电脑前就断了。

**方案**：做一个 **DSH 本地插件**，在 DSH 进程内盯着隧道地址，一变就把新地址
（带免登录 auth token）推到微信 ClawBot。

---

## 快速开始

```bash
cd dsh-plugin
./install-plugin.sh        # 安装到 DSH 的 desktop profile
```

然后重启 DSH（退出并重新打开 DeepSeek Harness）即生效。

---

## 交付物

| 路径 | 说明 |
|---|---|
| [dsh-plugin/](dsh-plugin/) | **本地插件本体**（安装这个） |
| [dsh-plugin/README.md](dsh-plugin/README.md) | 插件详细说明、配置项、FAQ |
| [dsh-plugin/install-plugin.sh](dsh-plugin/install-plugin.sh) | 安装 / 卸载 / 状态检查 |
| [dsh-plugin/src/index.js](dsh-plugin/src/index.js) | 插件源码 |
| [dsh-plugin/lib/wechat-send.mjs](dsh-plugin/lib/wechat-send.mjs) | 微信 iLink 协议发送实现 |
| [get-tunnel-url.mjs](get-tunnel-url.mjs) | 单独的「查当前隧道链接」小工具，可随时手动跑 |
| [wechat-send.mjs](wechat-send.mjs) | 微信发送实现（插件 lib 的源） |

---

## 已经验证过的事实

| 验证项 | 结果 |
|---|---|
| 微信推送链路 | ✅ 真实发出成功（`success: true`） |
| 从 cloudflared 日志提取隧道地址 | ✅ 与实际域名一致 |
| 本地反代 `getStatus` 读实时地址 | ✅ 返回 `rawUrl`，`state.phase: ready` |
| 插件 `apply()` 生命周期 + 卸载清理 | ✅ 无定时器泄漏 |
| 地址变更检测 | ✅ 实测捕获到一次真实换域名 |
| 新地址可达性 | ✅ 新地址 HTTP 401（活着），旧地址 DNS 已失效（000） |

> 实测中恰好遇到一次真实重启：隧道从 `wyoming-modules-aims-association`
> 变成了 `abroad-rear-laboratory-often` —— 正是你说的问题场景，插件成功捕获。

---

## 设计说明（为什么这么做）

**1. 为什么是插件，不是守护脚本**

最初考虑过「后台脚本 + LaunchAgent」，但安装 LaunchAgent 要写工作区之外的
`~/Library/LaunchAgents`，需要提权。而做成本地插件后：跑在 DSH 进程内，
DSH 启它就启、DSH 停它就停，**不需要任何后台常驻进程，也不需要沙箱外写文件**。

**2. 为什么同时用两个信号源**

- **本地反代状态接口**（首选）：`POST 127.0.0.1:3082/dsh-bridge/getStatus`，
  拿 `cloudflared.rawUrl`。这是插件**自己认为**当前生效的地址，最权威。
- **cloudflared 日志**（兜底）：`~/.dsh-bridge/cloudflared.log` 里
  `Requesting new quick Tunnel` 之后的域名。反代取不到时用它。

**3. 为什么推送能发出去**

微信 iLink 是**纯出站 HTTP 拉取式**接口，不需要公网地址、不需要隧道 ——
所以即使隧道刚挂，通知照样发得出去。

---

## 关于 `?auth=` token

推送的消息里会带一个免登录直达链接：

```
https://xxx.trycloudflare.com/?auth=dsh_<secretToken>
```

token 来自 `~/.dsh/dsh-bridge/config.json` 的 `auth.secretToken`，**长期有效**，
所以换域名后点开就能直接进，不用重新登录。

> ⚠️ 这个链接等于一把钥匙，别转发给别人。想关闭可把消息模板里的 auth 段去掉。

---

## 常见问题

**收不到消息？**
1. 确认 dsh-bridge 面板里微信机器人是「已连接」（扫码登录没过期）
2. 确认 `~/.dsh/dsh-bridge/config.json` 里 `wechat.accounts[0].token` 存在
3. 重启 DSH 后在日志里搜 `[tunnel-notify]`，失败会打印具体原因

**还没重启 DSH，能先手动查当前链接吗？**
```bash
node get-tunnel-url.mjs
```

**想把通知发到 QQ / 飞书 / Telegram？**
本项目目前只实现了微信（复用 dsh-bridge 的微信网关协议）。
其余平台协议不同，需要另写发送实现，可参考 `wechat-send.mjs` 的结构。