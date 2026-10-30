# Prompt Manager（DSH 插件）

在 ChatBox 底部工具条、权限选择控件的右侧放一个图标；点击弹出常用 Prompt 下拉框，把选中的 Prompt 插入当前输入框。Prompt 由用户自行增删改。

## 功能

- 输入框下方工具条内的图标按钮（`conversation.input.left`，位于权限 / Plan 控件右侧）
- 点击图标弹出浮层下拉框（`shell.overlay`，固定在视口内并按锚点定位）
- 无数据时：下拉框内展示空状态 + 添加按钮
- 有数据时：列表 + 下拉框底部栏的添加按钮
- 每条 Prompt 支持：点选插入、编辑、删除（删除带行内二次确认）
- 支持手机 / 窄屏：浮层宽度自适应并夹紧到视口、输入控件 16px 防 iOS 缩放、触控目标加大

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单（`dsh.bundle.patch` + `dsh.client`）与导出（含 `./locale/*.json`、`./icon`） |
| `cordis.patch.yml` | 插入一行 `prompt-manager`，指向本包 |
| `index.js` | Host 半：Prompt 持久化与同源 HTTP 路由 |
| `client.js` | Client 半：工具条按钮 + 浮层下拉框 + 编辑弹窗 |
| `locale/en.json`、`locale/zh.json` | 插件管理器展示的标题与描述 |
| `icon.svg` | 插件图标 |

## 数据存储

Prompt 保存在 `$DSH_HOME/storages/prompt-manager.json`（默认 `~/.dsh/storages/prompt-manager.json`）：

```json
{ "version": 1, "prompts": [{ "id": "...", "title": "", "text": "...", "createdAt": 0, "updatedAt": 0 }] }
```

写入使用「临时文件 + rename」的原子替换，并且所有修改串行化，多标签页同时编辑不会互相覆盖。若文件被手工改坏，会先另存为 `*.corrupt-<时间戳>` 再以空库继续，避免静默丢数据。

## HTTP 接口

前缀 `/api/dsh-prompt-manager`，仅同源调用（`sec-fetch-site` 为 `cross-site` 时返回 403）：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /list` | 返回 `{ ok, prompts }` |
| `POST /create` | `{ title?, text }` → `{ ok, prompt }` |
| `POST /update` | `{ id, title?, text? }` → `{ ok, prompt }` |
| `POST /delete` | `{ id }` → `{ ok }` |

限制：Prompt 数量 ≤ 200，标题 ≤ 120 字符，内容 ≤ 12000 字符，单请求体 ≤ 512 KiB。

## 插入方式

按钮所在 slot 会收到 Host / Client 提供的标准 prop `inputActions`；插入使用官方动作：

```js
inputActions.insertText(text, inputActions.captureInsertion())
```

即插入到当前光标位置（有选区则替换选区），全程不触碰 DOM。

## 安装

在 DSH 中通过 Plugin Manager 安装本目录，或：

```
plugin_manager(install_bundle, target: "<本目录绝对路径>")
```

安装后需刷新页面以加载 Client 半的最新代码。