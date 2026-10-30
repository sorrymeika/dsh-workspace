// src/ → lib/ 同步：插件入口必须是 lib/index.js（package.json main），
// 但源码放 src/ 更清爽，改完跑一下 `node build.mjs` 即可。
import fs from 'node:fs'
import path from 'node:path'

const root = import.meta.dirname
const pairs = [
  ['src/index.js', 'lib/index.js'],
  ['../wechat-send.mjs', 'lib/wechat-send.mjs'],
]

for (const [from, to] of pairs) {
  const src = path.resolve(root, from)
  const dst = path.resolve(root, to)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log(`✓ ${from} → ${to}`)
}
