// @local/dsh-tunnel-notify —— DSH 本地插件（宿主半边）
//
// 解决什么问题
// ------------
// @wenbin_wb/dsh-bridge 的 Cloudflare 免费临时隧道每次重启都会换一个
// *.trycloudflare.com 域名；手机上存的旧链接随即失效，人不在电脑前就断了。
// 本插件在 DSH 进程内盯着隧道地址，一变就把新地址推到 IM（默认微信）。
//
// 为什么是「监听日志」而不是调插件 API
// ------------------------------------
// dsh-bridge 把 BridgeService 实例化在 apply() 的闭包里，没有 ctx.provide()，
// 外部插件拿不到那个对象；getStatus 又只在 connection RPC 通道里，需要管理员
// 鉴权 + WebSocket 客户端。但 dsh-bridge **会把 cloudflared 的 stdout/stderr
// 落盘**到 <home>/cloudflared.log，域名分配那一刻就写在里面 —— 这是稳定、
// 无需鉴权、且不受版本变化影响的信号。故本插件读该文件。
//
// 生命周期
// --------
// apply(ctx) 里起一个 ctx.effect 注册的定时器；插件卸载时自动清理（不泄漏）。
// DSH 一启动插件就活，**不需要 LaunchAgent，也不需要在沙箱外写任何文件**。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { sendWechatText, loadWechatAccount } from '../lib/wechat-send.mjs'

const name = 'tunnel-notify'
// 不 inject 任何服务：只用定时器 + 文件 + fetch，最大化兼容性。
const inject = []

const HOME = os.homedir()

// ---------------------------------------------------------------------------
// 可调参数（config 覆盖 > 环境变量 > 默认值）
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled: true,
  /** 轮询间隔（毫秒）。文件 stat 很便宜，3s 足够灵敏又不吵 */
  intervalMs: 3000,
  /** 新地址可达性探测：等隧道真的回源再推送 */
  probeAttempts: 10,
  probeDelayMs: 3000,
  probeTimeoutMs: 8000,
  /** 接收方：留空 = 用 dsh-bridge 配置里 allowFrom 的第一个 */
  peerId: '',
  /** 指定微信账号 instanceId（多账号时用），留空 = 第一个 */
  wechatInstanceId: '',
  /** 推送开关：false 时只记日志不真发（调试用） */
  dryRun: false,
  /** cloudflared 日志路径，留空 = 自动探测 */
  logPath: '',
  /** 去重状态文件路径，留空 = 插件目录下 .state/ */
  statePath: '',
  /**
   * dsh-bridge 本地反代的状态查询地址。
   * 这是**首选**信号源：插件自己认为「当前生效」的地址，比抓日志更权威。
   * 留空 = 自动探测（127.0.0.1:3082 及常见端口）。
   */
  statusUrl: '',
  /** 反代端口候选（用于自动探测 statusUrl） */
  proxyPorts: [3082, 3083, 3084],
}

/** 解析 dsh-bridge 的 home：凭证在 ~/.dsh/dsh-bridge，日志常在 ~/.dsh-bridge。 */
function detectBridgeHomes() {
  const candidates = [
    process.env.DSH_BRIDGE_HOME,
    path.join(HOME, '.dsh', 'dsh-bridge'),
    path.join(HOME, '.dsh-bridge'),
  ].filter(Boolean)
  return [...new Set(candidates)]
}

/** 凭证目录：含 config.json 的那个 */
function detectCredentialHome() {
  for (const dir of detectBridgeHomes()) {
    if (fs.existsSync(path.join(dir, 'config.json'))) return dir
  }
  return detectBridgeHomes()[0]
}

/** 日志路径：优先显式配置，其次环境变量，再次各候选目录 */
function detectLogPath(configured) {
  if (configured) return configured
  if (process.env.TUNNEL_NOTIFY_LOG) return process.env.TUNNEL_NOTIFY_LOG
  const candidates = detectBridgeHomes().map((d) => path.join(d, 'cloudflared.log'))
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[0]
}

// ---------------------------------------------------------------------------
// URL 提取（与独立脚本同一套规则，双处保持一致）
// ---------------------------------------------------------------------------

const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi

/**
 * 从 cloudflared 日志文本提取「最新一次申请到」的临时隧道地址。
 * 只看最后一个 "Requesting new quick Tunnel" 之后的内容，并排除 api.* 预检目标。
 */
export function extractTunnelUrl(text) {
  if (!text) return null
  const idx = text.lastIndexOf('Requesting new quick Tunnel')
  const scope = idx >= 0 ? text.slice(idx) : text
  const matches = scope.match(QUICK_TUNNEL_RE)
  if (!matches) return null
  const candidates = matches.filter((u) => !/^https:\/\/api\./i.test(u))
  if (candidates.length === 0) return null
  return candidates[candidates.length - 1].toLowerCase()
}

function readTail(filePath, maxBytes = 256 * 1024) {
  const stat = fs.statSync(filePath)
  const start = Math.max(0, stat.size - maxBytes)
  const length = stat.size - start
  if (length <= 0) return ''
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// 首选信号源：dsh-bridge 本地反代的状态接口
// ---------------------------------------------------------------------------
//
// dsh-bridge 在本地反代上暴露了 POST /dsh-bridge/getStatus，带上 auth.secretToken
// 就能读到插件**自己认为**当前生效的隧道地址（cloudflared.rawUrl）。
// 这比抓 cloudflared 日志更权威：日志只说明「申请到了域名」，而状态接口反映
// 「插件当前真正在用哪个地址」，也天然覆盖固定 Token 隧道（域名不变）的场景。

/** 读取 dsh-bridge 的 auth.secretToken（getStatus 需要它鉴权） */
function readSecretToken(credentialHome) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(credentialHome, 'config.json'), 'utf8'))
    return cfg?.auth?.secretToken || null
  } catch {
    return null
  }
}

/** 调一次 getStatus，返回 { rawUrl, running } 或 null
 *
 *  报文格式（dsh-bridge 的 connection RPC 走本地反代的 client-request 信封）：
 *    POST /dsh-bridge/getStatus
 *    Authorization: Bearer <auth.secretToken>
 *    { type:'client-request', rpcId, method:'getStatus', payload:{} }
 *    响应：{ result: { ok:true, value: <getStatus 返回值> } }
 */
async function fetchStatusUrl(statusUrl, token, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(statusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `tunnel-notify-${Date.now()}`,
        method: 'getStatus',
        payload: {},
      }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    // 兼容两种形状：{result:{ok,value}} 或直接的 status 对象
    const value = parsed?.result?.value ?? parsed
    if (parsed?.result && parsed.result.ok === false) return null
    const cf = value?.cloudflared ?? {}
    const url = cf.rawUrl || cf.url
      || value?.customTunnel?.rawUrl || value?.customTunnel?.url
      || value?.externalTunnel?.url
      || null
    if (!url) return null
    return { rawUrl: String(url).replace(/\/+$/, ''), running: !!cf.running }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 自动探测可用的状态接口地址：依次试候选端口，成功即记住 */
async function detectStatusUrl(cfg, credentialHome) {
  if (cfg.statusUrl) return cfg.statusUrl
  const token = readSecretToken(credentialHome)
  if (!token) return null
  for (const port of cfg.proxyPorts ?? []) {
    const candidate = `http://127.0.0.1:${port}/dsh-bridge/getStatus`
    const r = await fetchStatusUrl(candidate, token)
    if (r) return candidate
  }
  return null
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// 可达性探测
// ---------------------------------------------------------------------------

async function probeUrl(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'dsh-tunnel-notify/1.0' },
    })
    // 任何 HTTP 状态都说明隧道已回源（认证页 401/302 是预期行为）
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
}

async function probeWithRetry(url, cfg, log) {
  for (let attempt = 1; attempt <= cfg.probeAttempts; attempt++) {
    const r = await probeUrl(url, cfg.probeTimeoutMs)
    if (r.ok) return { ...r, attempts: attempt }
    if (attempt < cfg.probeAttempts) {
      log.info('第 %d/%d 次探测未通（%s），%ds 后重试', attempt, cfg.probeAttempts, r.error, cfg.probeDelayMs / 1000)
      await sleep(cfg.probeDelayMs)
    } else {
      return { ok: false, error: r.error, attempts: attempt }
    }
  }
  return { ok: false, error: 'probe exhausted' }
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

function loadState(statePath, log) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return { lastUrl: null, lastNotifiedAt: null, history: [] }
  }
}

function saveState(statePath, state, log) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    const tmp = `${statePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, statePath)
  } catch (err) {
    log.warn('状态写入失败：%s', err?.message ?? err)
  }
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

function readAuthToken(credentialHome) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(credentialHome, 'config.json'), 'utf8'))
    return cfg?.auth?.secretToken || null
  } catch {
    return null
  }
}

export function buildMessage(url, { probeStatus, authToken } = {}) {
  const lines = ['🔗 DSH 远程访问地址已更新', '', url]
  if (authToken) {
    lines.push('', '带令牌直达（推荐，免登录）：', `${url}/?auth=${authToken}`)
  }
  lines.push(
    '',
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    probeStatus ? `状态：隧道已连通（HTTP ${probeStatus}）` : '状态：隧道已建立',
    '',
    '旧链接已失效，请使用上面的新地址打开。',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }

  const log = {
    info: (...a) => ctx.logger?.info?.('[tunnel-notify] ' + fmt(a)),
    warn: (...a) => ctx.logger?.warn?.('[tunnel-notify] ' + fmt(a)),
    error: (...a) => ctx.logger?.error?.('[tunnel-notify] ' + fmt(a)),
  }

  if (!cfg.enabled) {
    log.info('已在配置中禁用（enabled: false），不启动监听')
    return
  }

  const credentialHome = detectCredentialHome()
  const logPath = detectLogPath(cfg.logPath)
  // 状态文件必须落在**确定可写**的地方：凭证目录（~/.dsh/dsh-bridge）由 DSH 主进程
  // 管理，插件进程不一定有写权限（实测 EPERM），故默认放插件自己的目录下。
  const statePath = cfg.statePath || path.join(import.meta.dirname, '..', '.state', 'tunnel-notify-state.json')

  log.info('启动 | 日志=%s | 凭证=%s | 间隔=%dms', logPath, credentialHome, cfg.intervalMs)

  const state = loadState(statePath, log)
  let stopped = false
  let polling = false
  let lastSig = null
  let pollCount = 0
  let cachedStatusUrl = null

  async function notify(url, { probeStatus } = {}) {
    const message = buildMessage(url, { probeStatus, authToken: readAuthToken(credentialHome) })

    if (cfg.dryRun) {
      log.info('[dryRun] 本应推送：\n%s', message)
      state.lastUrl = url
      state.lastNotifiedAt = new Date().toISOString()
      saveState(statePath, state, log)
      return true
    }

    // 复用 dsh-bridge 自己的微信网关协议发送（纯出站 HTTP，不需要隧道）
    const result = await sendWechatText({
      text: message,
      peerId: cfg.peerId || undefined,
      home: credentialHome,
      instanceId: cfg.wechatInstanceId || undefined,
      logger: log,
    })

    if (!result.success) {
      log.error('微信推送失败：%s', result.error)
      return false
    }

    state.lastUrl = url
    state.lastNotifiedAt = new Date().toISOString()
    state.history = [...(state.history ?? []), { url, at: state.lastNotifiedAt }].slice(-50)
    saveState(statePath, state, log)
    log.info('推送成功 → %s', result.to)
    return true
  }

  /**
   * 一轮检查：取地址（状态接口优先，日志兜底）→ 去重 → 探测 → 推送
   *
   * 两条信号源的分工：
   *   - 状态接口：插件当前真正在用的地址，最权威；也覆盖「固定 Token 隧道」。
   *   - cloudflared 日志：状态接口偶发不可用（反代未起/端口变了）时的兜底，
   *     且它是「域名刚分配」那一刻就能看到的信号，灵敏度更高。
   */
  async function tick({ force = false } = {}) {
    if (stopped) return false

    let url = null
    let source = null

    // 1) 首选：本地反代状态接口
    const statusUrl = cachedStatusUrl ?? (cachedStatusUrl = await detectStatusUrl(cfg, credentialHome))
    if (statusUrl) {
      const token = readSecretToken(credentialHome)
      const r = token ? await fetchStatusUrl(statusUrl, token) : null
      if (r?.rawUrl) {
        url = r.rawUrl.toLowerCase()
        source = 'status'
      }
    }

    // 2) 兜底：cloudflared 日志
    if (!url && fs.existsSync(logPath)) {
      url = extractTunnelUrl(readTail(logPath))
      source = url ? 'log' : null
    }

    if (!url) return false
    if (!force && state.lastUrl === url) return false

    log.info('检测到%s地址（%s）：%s', state.lastUrl ? '新' : '当前', source, url)

    // 探测只是「锦上添花」：通了就在消息里标注，不通也照推。
    // 注意不能因为探测不通就不推——用户要的恰恰是「地址变了就告诉我」，
    // 本机网络受限（DNS/代理/防火墙）不该让通知丢失。
    const probe = await probeWithRetry(url, cfg, log).catch((err) => ({
      ok: false,
      error: err?.message ?? String(err),
    }))
    if (!probe.ok) {
      log.warn('地址 %s 探测未通（%s），仍按「已建立」推送', url, probe.error)
    }
    return notify(url, { probeStatus: probe.ok ? probe.status : undefined })
  }

  /**
   * 定时轮询。
   *
   * 日志 mtime/size 只用来做「无变化就快速跳过」的优化，不能当作唯一触发条件：
   * 状态接口会在日志未变动时也反映地址变化（例如插件内部重建隧道）。
   * 因此：日志变了 → 立刻查；日志没变 → 每 N 轮也查一次状态接口兜底。
   */
  async function poll() {
    if (polling || stopped) return
    polling = true
    try {
      let logChanged = false
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath)
        const sig = `${stat.size}:${stat.mtimeMs}`
        if (sig !== lastSig) {
          lastSig = sig
          logChanged = true
        }
      }

      // 日志没变时降低状态查询频率（约每 10 轮一次），避免无谓请求
      pollCount++
      const statusDue = pollCount % 10 === 0

      if (logChanged || statusDue || pollCount === 1) {
        await tick()
      }
    } catch (err) {
      log.error('轮询出错：%s', err?.message ?? err)
    } finally {
      polling = false
    }
  }

  // 首次延迟几秒执行，避开 DSH 启动高峰；之后进入固定间隔轮询
  const timer = setInterval(() => { void poll() }, cfg.intervalMs)
  const boot = setTimeout(() => { void poll() }, 2000)

  ctx.effect(() => () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(boot)
    log.info('已停止监听')
  }, 'tunnel-notify: stop polling')

  // 供调试：暴露一次手动检查（不影响正常轮询）
  ctx.on?.('tunnel-notify/check', () => { void tick({ force: false }) })
}

/** 极简 printf：让 log.info('a %s', b) 正常展开 */
function fmt(args) {
  if (args.length === 0) return ''
  const [first, ...rest] = args
  if (typeof first !== 'string' || rest.length === 0) return args.map(str).join(' ')
  let i = 0
  return first.replace(/%[sdjo%]/g, (m) => {
    if (m === '%%') return '%'
    if (i >= rest.length) return m
    return str(rest[i++])
  }) + (i < rest.length ? ` ${rest.slice(i).map(str).join(' ')}` : '')
}

function str(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.message
  try { return JSON.stringify(v) } catch { return String(v) }
}

export { name, inject, apply }
export default { name, inject, apply }