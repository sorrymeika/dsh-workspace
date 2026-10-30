// 查询当前 dsh-bridge 公网隧道访问入口链接
//
// 用途：DSH 每次重启后 cloudflared 会拿到新的随机 *.trycloudflare.com 域名，
// 本脚本通过 dsh-bridge 的 getStatus RPC 读取「当前实时」隧道域名，
// 再拼上长期有效的 ?auth=<secretToken>，输出可直接访问的完整入口链接。
//
// 用法：node get-tunnel-url.mjs
// 输出：第一行 = 完整链接；其余为诊断信息（--quiet 只输出链接）

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BRIDGE_HOME = process.env.DSH_BRIDGE_HOME || path.join(os.homedir(), '.dsh', 'dsh-bridge')
const CONFIG_PATH = path.join(BRIDGE_HOME, 'config.json')
const PROXY_URL = 'http://127.0.0.1:3082/dsh-bridge/getStatus'

function readConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const token = cfg?.auth?.secretToken
  if (!token) throw new Error(`未在 ${CONFIG_PATH} 的 auth.secretToken 中找到认证 token`)
  return { token }
}

async function fetchStatus(token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'client-request', rpcId: 'tunnel-url', method: 'getStatus', payload: {} }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`getStatus HTTP ${res.status}: ${text.slice(0, 200)}`)
    const parsed = JSON.parse(text)
    if (!parsed?.result?.ok) throw new Error(`getStatus 返回失败: ${text.slice(0, 300)}`)
    return parsed.result.value
  } finally {
    clearTimeout(timer)
  }
}

/** 往返探测：确认隧道真的通到应用（401=认证门禁生效），而不是 530（隧道已断） */
async function probe(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { redirect: 'manual', signal: controller.signal })
    return { status: res.status, ok: res.status !== 530 && res.status < 600 }
  } catch (e) {
    return { status: 0, ok: false, error: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
  }
}

const quiet = process.argv.includes('--quiet')
const { token } = readConfig()
const status = await fetchStatus(token)

const cf = status?.cloudflared ?? {}
const url = cf.rawUrl || cf.url
if (!url) {
  console.error('隧道未运行或未就绪：cloudflared.running =', cf.running)
  console.error('完整 cloudflared 状态：', JSON.stringify(cf).slice(0, 300))
  process.exit(2)
}

const full = `${url.replace(/\/+$/, '')}/?auth=${token}`
const p = await probe(full)

if (quiet) {
  console.log(full)
} else {
  console.log(full)
  console.log('')
  console.log(`隧道状态 : ${cf.running ? '运行中' : '未运行'}`)
  console.log(`隧道域名 : ${url}`)
  console.log(`认证 token: ${token}`)
  console.log(`连通性   : HTTP ${p.status}${p.ok ? '（隧道通到应用，401=认证门禁正常）' : '（异常：隧道可能已断）'}`)
  console.log(`读取时间 : ${new Date().toISOString()}`)
}

process.exit(p.ok ? 0 : 3)