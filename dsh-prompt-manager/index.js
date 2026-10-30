/**
 * Host half of the Prompt Manager bundle.
 *
 * Owns the prompt library: a single JSON document under `$DSH_HOME/storages`,
 * served to the browser half through same-origin HTTP routes. The Client half
 * never touches the file system; every mutation goes through one serialized
 * read-modify-write so concurrent browser tabs cannot interleave.
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable plugin identity for diagnostics. */
export const name = '@local/dsh-prompt-manager'

/** The Web server is the only Host capability this bundle needs. */
export const inject = ['webServer']

/** Route prefix of the prompt API. */
const API_PREFIX = '/api/dsh-prompt-manager'

/** Request bodies are small: 200 prompts of 12k characters stay well under this. */
const BODY_MAX_BYTES = 512 * 1024

/** Library limits, enforced on the Host so every caller shares them. */
const MAX_PROMPTS = 200
const MAX_TITLE = 120
const MAX_TEXT = 12000

/** JSON response headers shared by every route. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

/** Absolute path of the prompt document. */
function storeFile() {
  const home = process.env.DSH_HOME?.trim()
  const root = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(root, 'storages', 'prompt-manager.json')
}

/** An empty document. */
function emptyState() {
  return { version: 1, prompts: [] }
}

/** One stored prompt, or undefined when the record is unusable. */
function normalizeStored(value) {
  if (value === null || typeof value !== 'object') return undefined
  const id = typeof value.id === 'string' && value.id !== '' ? value.id : undefined
  const text = typeof value.text === 'string' ? value.text : undefined
  if (id === undefined || text === undefined || text.trim() === '') return undefined
  const title = typeof value.title === 'string' ? value.title.slice(0, MAX_TITLE) : ''
  const createdAt = Number.isFinite(value.createdAt) ? value.createdAt : Date.now()
  const updatedAt = Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt
  return { id, title, text: text.slice(0, MAX_TEXT), createdAt, updatedAt }
}

/**
 * Read the document. A missing file is an empty library; an unreadable one is
 * preserved beside the original before the library restarts empty, so a hand
 * edit that broke the JSON never costs the user the prompts inside it.
 */
async function readState() {
  const file = storeFile()
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return emptyState()
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.prompts) ? parsed.prompts : []
    const prompts = list.map(normalizeStored).filter((entry) => entry !== undefined)
    return { version: 1, prompts: prompts.slice(0, MAX_PROMPTS) }
  } catch {
    const preserved = `${file}.corrupt-${Date.now()}`
    await copyFile(file, preserved).catch(() => {})
    console.warn(`[prompt-manager] unreadable store preserved at ${preserved}`)
    return emptyState()
  }
}

/** Persist the document atomically: write a sibling, then rename over the original. */
async function writeState(state) {
  const file = storeFile()
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** One mutation at a time, so two callers never lose each other's write. */
let writeChain = Promise.resolve()
function serialize(operation) {
  const run = writeChain.then(operation, operation)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Whether the request may act on the library. */
function allowed(req) {
  // Same-origin browser traffic is what the Client half produces. Requests that
  // carry a cross-site fetch site are refused so an unrelated page cannot drive
  // the API; requests without the header (older engines, tunnels) stay allowed.
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false
  return true
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** Read a bounded JSON body; an unreadable or oversized body reads as empty. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_MAX_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/** Trimmed text fields of a create/update body, or a validation message. */
function readPromptFields(body, { requireText }) {
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE) : ''
  const text = typeof body.text === 'string' ? body.text : undefined
  if (text === undefined) {
    if (requireText) return { error: 'text is required' }
    return { title }
  }
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'text is required' }
  if (text.length > MAX_TEXT) return { error: `text exceeds ${MAX_TEXT} characters` }
  return { title, text }
}

/** The prompt list route. */
function listRoute() {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/list`,
    handler: async (req, res) => {
      if (!allowed(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const state = await readState()
        writeJson(res, 200, { ok: true, prompts: state.prompts })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorMessage(error) })
      }
    },
  }
}

/** Create one prompt. */
function createRoute() {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/create`,
    handler: async (req, res) => {
      if (!allowed(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorMessage(error) })
        return
      }
      const fields = readPromptFields(body, { requireText: true })
      if (fields.error !== undefined) {
        writeJson(res, 400, { ok: false, error: fields.error })
        return
      }
      try {
        const prompt = await serialize(async () => {
          const state = await readState()
          if (state.prompts.length >= MAX_PROMPTS) throw new Error(`prompt limit reached (${MAX_PROMPTS})`)
          const now = Date.now()
          const entry = {
            id: randomUUID(),
            title: fields.title ?? '',
            text: fields.text,
            createdAt: now,
            updatedAt: now,
          }
          await writeState({ version: 1, prompts: [entry, ...state.prompts] })
          return entry
        })
        writeJson(res, 200, { ok: true, prompt })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorMessage(error) })
      }
    },
  }
}

/** Update one prompt's title and/or text. */
function updateRoute() {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/update`,
    handler: async (req, res) => {
      if (!allowed(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorMessage(error) })
        return
      }
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        writeJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const fields = readPromptFields(body, { requireText: false })
      if (fields.error !== undefined) {
        writeJson(res, 400, { ok: false, error: fields.error })
        return
      }
      try {
        const result = await serialize(async () => {
          const state = await readState()
          const index = state.prompts.findIndex((entry) => entry.id === id)
          if (index < 0) throw new NotFoundError()
          const current = state.prompts[index]
          const next = {
            ...current,
            ...(fields.title === undefined ? {} : { title: fields.title }),
            ...(fields.text === undefined ? {} : { text: fields.text }),
            updatedAt: Date.now(),
          }
          if (fields.text !== undefined && fields.text.trim() === '') throw new ValidationError('text is required')
          const prompts = state.prompts.slice()
          prompts[index] = next
          await writeState({ version: 1, prompts })
          return next
        })
        writeJson(res, 200, { ok: true, prompt: result })
      } catch (error) {
        if (error instanceof NotFoundError) writeJson(res, 404, { ok: false, error: 'prompt not found' })
        else if (error instanceof ValidationError) writeJson(res, 400, { ok: false, error: error.message })
        else writeJson(res, 500, { ok: false, error: errorMessage(error) })
      }
    },
  }
}

/** Delete one prompt. */
function deleteRoute() {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/delete`,
    handler: async (req, res) => {
      if (!allowed(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorMessage(error) })
        return
      }
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        writeJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      try {
        await serialize(async () => {
          const state = await readState()
          const prompts = state.prompts.filter((entry) => entry.id !== id)
          if (prompts.length === state.prompts.length) throw new NotFoundError()
          await writeState({ version: 1, prompts })
        })
        writeJson(res, 200, { ok: true })
      } catch (error) {
        if (error instanceof NotFoundError) writeJson(res, 404, { ok: false, error: 'prompt not found' })
        else writeJson(res, 500, { ok: false, error: errorMessage(error) })
      }
    },
  }
}

/** A missing record, mapped to 404 by each route. */
class NotFoundError extends Error {}
/** A rejected field value, mapped to 400 by each route. */
class ValidationError extends Error {}

/** Short failure text for the browser half. */
function errorMessage(error) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
}

/**
 * Mount the prompt API.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const routes = [listRoute(), createRoute(), updateRoute(), deleteRoute()]
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    }
  }, 'prompt-manager: routes')
}