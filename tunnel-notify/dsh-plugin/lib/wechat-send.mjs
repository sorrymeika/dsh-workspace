// 微信 ClawBot（iLink Bot API）纯文本推送
//
// 协议与 @wenbin_wb/dsh-bridge 的 lib/wechat/gateway.js 保持一致：
//   POST {baseUrl}/ilink/bot/sendmessage
//   头：AuthorizationType: ilink_bot_token + Authorization: Bearer <token>
//   体：{ msg: { to_user_id, client_id, message_type: 2, message_state: 2,
//                item_list: [{ type: 1, text_item: { text } }] }, base_info }
//
// 这是纯出站 HTTP 拉取式接口：不需要公网地址、不需要隧道，重启后依然可用。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.2.0'
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
const MSG_TYPE_BOT = 2
const MSG_STATE_FINISH = 2
const ITEM_TEXT = 1
const API_TIMEOUT_MS = 15_000
const MAX_MESSAGE_CHARS = 2000

/** dsh-bridge 的持久化目录：优先 DSH_BRIDGE_HOME，其次 ~/.dsh/dsh-bridge */
export function resolveBridgeHome() {
  if (process.env.DSH_BRIDGE_HOME) return process.env.DSH_BRIDGE_HOME
  return path.join(os.homedir(), '.dsh', 'dsh-bridge')
}

/**
 * 读取 dsh-bridge 配置里的微信账号凭证。
 * 支持同平台多账号（v2.15.0）：accounts[] 中取第一个可用账号。
 */
export function loadWechatAccount({ home = resolveBridgeHome(), instanceId } = {}) {
  const configPath = path.join(home, 'config.json')
  const raw = fs.readFileSync(configPath, 'utf8')
  const config = JSON.parse(raw)
  const accounts = config?.wechat?.accounts ?? []
  if (accounts.length === 0) {
    throw new Error(`未在 ${configPath} 中找到 wechat.accounts，请先在面板中登录微信机器人`)
  }
  const account = instanceId
    ? accounts.find((a) => a.instanceId === instanceId)
    : accounts[0]
  if (!account) throw new Error(`找不到 instanceId=${instanceId} 的微信账号`)
  if (!account.token || !account.accountId) {
    throw new Error('微信账号缺少 token/accountId，请重新扫码登录')
  }
  return {
    instanceId: account.instanceId,
    token: account.token,
    accountId: account.accountId,
    baseUrl: account.baseUrl || ILINK_BASE_URL,
    allowFrom: Array.isArray(account.allowFrom) ? account.allowFrom : [],
    configPath,
  }
}

/** 读取该 peer 最近一次的 context_token（缺省则不带，gateway 也是这么降级的）。 */
export function loadContextToken(peerId, { home = resolveBridgeHome() } = {}) {
  const p = path.join(home, 'wechat-context-tokens.json')
  try {
    const raw = fs.readFileSync(p, 'utf8').trim()
    if (!raw) return undefined
    const map = JSON.parse(raw)
    const value = map?.[peerId]
    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

/** 每请求必带的头；X-WECHAT-UIN 每次随机防重放。 */
function requestHeaders(token, body) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body)),
    'X-WECHAT-UIN': randomBytes(4).toString('base64url'),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** 超长文本按 MAX_MESSAGE_CHARS 切分（链接本身不会被切断在最坏情况下也没关系，上层会单独成段）。 */
export function splitText(text, limit = MAX_MESSAGE_CHARS) {
  const s = String(text ?? '')
  if (s.length <= limit) return [s]
  const out = []
  for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit))
  return out
}

/**
 * 发送单条文本。返回 { success, messageId } 或 { success:false, error }。
 * 不抛异常，便于守护进程记录而不是崩掉。
 */
export async function sendTextOnce({ account, to, text, contextToken, clientId, timeoutMs = API_TIMEOUT_MS }) {
  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId ?? `dsh-tunnel-notify-${randomBytes(8).toString('hex')}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: { channel_version: CHANNEL_VERSION },
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${account.baseUrl.replace(/\/+$/, '')}/${EP_SEND_MESSAGE}`, {
      method: 'POST',
      headers: requestHeaders(account.token, body),
      body,
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${raw.slice(0, 200)}` }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { success: false, error: `响应不是 JSON: ${raw.slice(0, 200)}` }
    }
    const ret = parsed?.ret
    const errcode = parsed?.errcode
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      return {
        success: false,
        error: `ret=${ret} errcode=${errcode} errmsg=${parsed?.errmsg ?? ''}`,
        raw: parsed,
      }
    }
    return { success: true, messageId: parsed?.msgid ?? parsed?.msg_id ?? null }
  } catch (error) {
    return { success: false, error: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 发送给指定 peer（或默认白名单第一个）。
 * 会话过期（-14）时自动去掉 context_token 重试一次——与 gateway 行为一致。
 */
export async function sendWechatText({
  text,
  peerId,
  home = resolveBridgeHome(),
  instanceId,
  logger = console,
} = {}) {
  const account = loadWechatAccount({ home, instanceId })
  const to = peerId || account.allowFrom[0]
  if (!to) {
    return { success: false, error: '没有可用的接收方：配置里 allowFrom 为空，请显式传入 peerId' }
  }

  const chunks = splitText(text)
  let last = { success: false, error: 'no attempt' }
  for (const chunk of chunks) {
    let contextToken = loadContextToken(to, { home })
    last = await sendTextOnce({ account, to, text: chunk, contextToken })
    if (!last.success && /(-14|session expired|expired)/i.test(last.error ?? '')) {
      logger.warn?.('会话 token 可能过期，去掉 context_token 重试一次')
      last = await sendTextOnce({ account, to, text: chunk, contextToken: undefined })
    }
    if (!last.success) return last
  }
  return { ...last, to, accountId: account.accountId }
}