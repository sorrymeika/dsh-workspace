# dsh-tunnel-notify

DSH 本地插件：**dsh-bridge 公网隧道地址一变，自动把新地址推到微信**。

解决的是这个问题 —— dsh-bridge 的 Cloudflare 免费临时隧道每次重启都会换一个
`*.trycloudflare.com` 域名，手机上存的旧链接立刻失效，人不在电脑前就断了。

---

## 它怎么工作

```
cloudflared 申请新域名 ──┐
                          ├──► 本地反代 /dsh-bridge/getStatus（首选，最权威）
                          │     读 cloudflared.rawUrl = 插件当前真正在用的地址
                          │
                          └──► ~/.dsh-bridge/cloudflared.log（兜底）
                                抓 "Requesting new quick Tunnel" 后的域名
                                        │
                                        ▼
                                  地址变了吗？（对比已推送记忆）
                                        │
                                        ▼
                                   探测新地址是否可达
                                        │
                                        ▼
                                  微信 ClawBot 推送新链接
```

**两个信号源，互为兜底：**

| 来源 | 优点 | 缺点 |
|---|---|---|
| 本地反代 `getStatus` | 插件**自己认为**当前生效的地址，最权威；覆盖固定 Token 隧道 | 反代未起/端口变了就取不到 |
| cloudflared 日志 | 域名刚分配就能看到，灵敏度高 | 只说明「申请到了」，不保证插件在用 |

两个设计要点：

1. **为什么不用 LaunchAgent**
   插件跑在 DSH 进程内，DSH 一启动它就活；DSH 退出它自然停。不用写
   `~/Library/LaunchAgents`，也不用常驻后台脚本。

2. **为什么推送走微信协议而不是别的**
   推送用的是 **dsh-bridge 自己的微信网关协议**（`ilink/bot/sendmessage`），
   纯出站 HTTP 拉取式接口 —— 不需要公网地址、不需要隧道，所以它能在
   「隧道刚坏」的那一刻把新地址发出去。

---

## 安装

```bash
cd dsh-plugin
./install-plugin.sh          # 安装并注册进 profile bundles
./install-plugin.sh status   # 检查注册状态
./install-plugin.sh uninstall # 卸载
```

然后**重启 DSH**（退出并重新打开 DeepSeek Harness）生效。

> 为什么安装要你自己跑：`~/.dsh/profiles/<profile>/` 在会话工作区之外，
> agent 的沙箱只能写工作区。脚本本身不做任何特权操作，只是 `pnpm add file:...`
> 加改一下 profile 的 `package.json`。

安装做的事情只有两件：
1. 把插件以 `file:` 依赖链接进 `~/.dsh/profiles/desktop/`
2. 把 `@local/dsh-tunnel-notify` 追加进该 profile 的 `dsh.profile.bundles`

---

## 验证

重启 DSH 后，在 DSH 日志里搜 `[tunnel-notify]`，应能看到：

```
[tunnel-notify] 启动 | 日志=/Users/you/.dsh-bridge/cloudflared.log | 凭证=/Users/you/.dsh/dsh-bridge | 间隔=3000ms
[tunnel-notify] 检测到当前地址：https://xxx.trycloudflare.com
[tunnel-notify] 推送成功 → o9cq...@im.wechat
```

想立刻看效果：在 dsh-bridge 面板里把公网隧道**关闭再打开**，会拿到一个新域名，
微信应马上收到新链接。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（都有默认值，通常不用动）：

```yaml
- id: tunnel-notify
  name: "@local/dsh-tunnel-notify"
  config:
    intervalMs: 3000          # 轮询间隔
    peerId: ""                # 接收方；留空 = 用 dsh-bridge 里 allowFrom 的第一个
    wechatInstanceId: ""      # 多微信账号时指定 instanceId
    dryRun: false             # true = 只记日志不真发
    statusUrl: ""             # 留空 = 自动探测 127.0.0.1:3082/dsh-bridge/getStatus
    logPath: ""               # 留空 = 自动探测
    probeAttempts: 10         # 可达性探测次数
    probeDelayMs: 3000        # 每次探测间隔
```

---

## 常见问题

**收不到消息？**
- 确认 dsh-bridge 面板里微信机器人是「已连接」状态（扫码登录没过期）。
- 确认 `~/.dsh/dsh-bridge/config.json` 里 `wechat.accounts[0].token` 存在。
- 看 DSH 日志里的 `[tunnel-notify]` 行，推送失败会打印具体原因。

**地址变了但没推送？**
- 插件只认 `Requesting new quick Tunnel` 之后的域名。若 dsh-bridge 用的是
  **固定 Token 隧道**（有 `cloudflared.token`），域名本来就不变，无需通知。
- 日志被轮转（>5MB）时可能错过一次，下一轮会补上。

**会重复推送吗？**
不会。已推送的地址记在 `dsh-plugin/.state/tunnel-notify-state.json`，同一个地址只推一次。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `src/index.js` | 插件源码（宿主半边） |
| `lib/index.js` | 构建产物 = 插件入口（`node build.mjs` 从 src 生成） |
| `lib/wechat-send.mjs` | 微信 iLink 协议发送（从 `../wechat-send.mjs` 复制） |
| `cordis.patch.yml` | bundle patch，声明插入 `tunnel-notify` |
| `install-plugin.sh` | 安装/卸载/状态 |

改完 `src/` 记得跑 `node build.mjs`（或在安装脚本里会自动同步）。