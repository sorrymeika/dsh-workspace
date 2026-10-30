/**
 * Client half of the Prompt Manager bundle.
 *
 * Two slot entries share one module-level store:
 * - `conversation.input.left` renders the trigger button in the composer tool
 *   row, immediately right of the permission and plan controls.
 * - `shell.overlay` renders the dropdown panel and the add/edit dialog in the
 *   frame-wide floating layer, so anchored placement and a modal scrim are not
 *   affected by the composer card's stacking or clipping context.
 *
 * Prompt text is inserted into the current draft through the standard
 * `inputActions` slot prop, never through DOM access.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    /** Locale namespace owned by this bundle. */
    const NS = 'promptManager'
    /** Same-origin prompt API served by the Host half. */
    const API = 'api/dsh-prompt-manager'
    /** Field limits mirrored from the Host half for early feedback. */
    const LIMITS = { title: 120, text: 12000 }

    /** English strings. Keys stay fully qualified, matching the host dictionary convention. */
    const en = {
      'promptManager.button': 'Prompts',
      'promptManager.title': 'Saved prompts',
      'promptManager.count': '{n} prompts',
      'promptManager.empty.title': 'No prompts yet',
      'promptManager.empty.hint': 'Save the instructions you reuse, then insert them in one click.',
      'promptManager.add': 'Add prompt',
      'promptManager.addShort': 'Add',
      'promptManager.save': 'Save',
      'promptManager.saving': 'Saving…',
      'promptManager.cancel': 'Cancel',
      'promptManager.edit': 'Edit prompt',
      'promptManager.delete': 'Delete prompt',
      'promptManager.deleteConfirm': 'Delete this prompt?',
      'promptManager.confirm': 'Delete',
      'promptManager.titleLabel': 'Title (optional)',
      'promptManager.titlePlaceholder': 'e.g. Code review',
      'promptManager.textLabel': 'Prompt text',
      'promptManager.textPlaceholder': 'Write the prompt that gets inserted into the draft…',
      'promptManager.textRequired': 'Enter some prompt text.',
      'promptManager.newTitle': 'New prompt',
      'promptManager.editTitle': 'Edit prompt',
      'promptManager.loadFailed': 'Could not load prompts.',
      'promptManager.retry': 'Retry',
      'promptManager.insertFailed': 'Could not insert the prompt into the draft.',
      'promptManager.saveFailed': 'Could not save the prompt.',
      'promptManager.deleteFailed': 'Could not delete the prompt.',
      'promptManager.untitled': 'Untitled prompt',
      'promptManager.loading': 'Loading…',
      'promptManager.close': 'Close',
    }

    /** Chinese strings. */
    const zh = {
      'promptManager.button': '常用 Prompt',
      'promptManager.title': '常用 Prompt',
      'promptManager.count': '{n} 条',
      'promptManager.empty.title': '还没有常用 Prompt',
      'promptManager.empty.hint': '把你反复使用的指令存下来，之后一键插入输入框。',
      'promptManager.add': '添加 Prompt',
      'promptManager.addShort': '添加',
      'promptManager.save': '保存',
      'promptManager.saving': '保存中…',
      'promptManager.cancel': '取消',
      'promptManager.edit': '编辑 Prompt',
      'promptManager.delete': '删除 Prompt',
      'promptManager.deleteConfirm': '确认删除这条 Prompt？',
      'promptManager.confirm': '删除',
      'promptManager.titleLabel': '标题（可选）',
      'promptManager.titlePlaceholder': '例如：代码审查',
      'promptManager.textLabel': 'Prompt 内容',
      'promptManager.textPlaceholder': '写下要插入输入框的 Prompt 内容…',
      'promptManager.textRequired': '请填写 Prompt 内容。',
      'promptManager.newTitle': '新建 Prompt',
      'promptManager.editTitle': '编辑 Prompt',
      'promptManager.loadFailed': '加载 Prompt 失败。',
      'promptManager.retry': '重试',
      'promptManager.insertFailed': '无法插入到输入框。',
      'promptManager.saveFailed': '保存失败。',
      'promptManager.deleteFailed': '删除失败。',
      'promptManager.untitled': '未命名 Prompt',
      'promptManager.loading': '加载中…',
      'promptManager.close': '关闭',
    }

    /** Fallback translator for a composition without the Client locale service. */
    function fallbackTranslate(key, params) {
      const language = typeof navigator === 'object' && typeof navigator.language === 'string' ? navigator.language : 'en'
      const dictionary = language.toLowerCase().startsWith('zh') ? zh : en
      let text = dictionary[key] ?? en[key] ?? key
      if (params !== null && typeof params === 'object') {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }

    // #region api
    /** A prompt record as stored by the Host. */
    function normalizePrompt(value) {
      if (value === null || typeof value !== 'object') return undefined
      if (typeof value.id !== 'string' || value.id === '') return undefined
      if (typeof value.text !== 'string') return undefined
      return {
        id: value.id,
        title: typeof value.title === 'string' ? value.title : '',
        text: value.text,
        createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      }
    }

    /** One same-origin API call; resolves the parsed body or throws with the Host's reason. */
    async function call(action, payload) {
      const init =
        payload === undefined
          ? { method: 'GET' }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }
      let response
      try {
        response = await fetch(`${API}/${action}`, { ...init, credentials: 'same-origin' })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body === undefined || body.ok !== true) {
        const reason = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return body
    }
    // #endregion

    // #region store
    /**
     * One shared, framework-agnostic store. The trigger owns the insertion
     * handle (it is the session-scoped component that receives `inputActions`);
     * the overlay consumes it, so both halves stay in sync without props
     * crossing slot boundaries.
     */
    function createStore() {
      let state = {
        /** Whether the dropdown is open. */
        open: false,
        /** Loaded prompts, newest first. */
        prompts: [],
        /** idle | loading | ready | error */
        status: 'idle',
        /** Library-level failure text, or null. */
        notice: null,
        /** The add/edit dialog state, or null. */
        editor: null,
        /** Prompt id awaiting delete confirmation, or null. */
        confirmId: null,
        /** Insertion handle registered by the trigger component. */
        inserter: null,
        /** The trigger element, used to anchor the dropdown. */
        triggerEl: null,
      }
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      const patch = (next) => {
        state = { ...state, ...next }
        emit()
      }
      const get = () => state

      /** Load the library, keeping any already-known prompts on a transient failure. */
      const load = async () => {
        patch({ status: 'loading', notice: null })
        try {
          const body = await call('list')
          const prompts = Array.isArray(body.prompts) ? body.prompts.map(normalizePrompt).filter((entry) => entry !== undefined) : []
          patch({ status: 'ready', prompts, notice: null })
        } catch (error) {
          patch({ status: 'error', notice: error instanceof Error ? error.message : String(error) })
        }
      }

      /** Ensure the library has been fetched at least once. */
      const ensureLoaded = () => {
        const current = get()
        if (current.status === 'idle' || current.status === 'error') void load()
      }

      const openMenu = () => {
        patch({ open: true, confirmId: null })
        ensureLoaded()
      }

      const closeMenu = () => {
        if (!get().open) return
        patch({ open: false, editor: null, confirmId: null })
      }

      const toggleMenu = () => {
        if (get().open) closeMenu()
        else openMenu()
      }

      const openEditor = (mode, prompt) => {
        patch({
          confirmId: null,
          notice: null,
          editor: {
            mode,
            id: prompt === undefined ? null : prompt.id,
            title: prompt === undefined ? '' : prompt.title,
            text: prompt === undefined ? '' : prompt.text,
            error: null,
            busy: false,
          },
        })
      }

      const closeEditor = () => {
        const editor = get().editor
        if (editor === null || editor.busy) return
        patch({ editor: null })
      }

      const editEditor = (next) => {
        const editor = get().editor
        if (editor === null) return
        patch({ editor: { ...editor, ...next } })
      }

      /** Insert one prompt into the composer draft and close the dropdown. */
      const insert = (prompt) => {
        const inserter = get().inserter
        let inserted = false
        if (inserter !== null) {
          try {
            inserted = inserter(prompt.text) === true
          } catch {
            inserted = false
          }
        }
        if (inserted) closeMenu()
        else patch({ notice: 'insertFailed' })
      }

      /** Persist the dialog's prompt. */
      const saveEditor = async () => {
        const editor = get().editor
        if (editor === null || editor.busy) return
        if (editor.text.trim() === '') {
          patch({ editor: { ...editor, error: 'textRequired' } })
          return
        }
        patch({ editor: { ...editor, busy: true, error: null } })
        try {
          const body =
            editor.mode === 'create'
              ? await call('create', { title: editor.title, text: editor.text })
              : await call('update', { id: editor.id, title: editor.title, text: editor.text })
          const saved = normalizePrompt(body.prompt)
          const current = get()
          const prompts =
            saved === undefined
              ? current.prompts
              : editor.mode === 'create'
                ? [saved, ...current.prompts]
                : current.prompts.map((entry) => (entry.id === saved.id ? saved : entry))
          patch({ prompts, status: 'ready', editor: null, notice: null })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          patch({ editor: { ...(get().editor ?? editor), busy: false, error: message } })
        }
      }

      /** Delete one prompt after its confirmation. */
      const remove = async (prompt) => {
        patch({ confirmId: null, notice: null })
        try {
          await call('delete', { id: prompt.id })
          patch({ prompts: get().prompts.filter((entry) => entry.id !== prompt.id) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          patch({ notice: message })
        }
      }

      return {
        get,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        openMenu,
        closeMenu,
        toggleMenu,
        retry: () => void load(),
        openEditor,
        closeEditor,
        editEditor,
        saveEditor,
        remove,
        insert,
        setConfirmId: (id) => patch({ confirmId: id }),
        setInserter: (inserter) => {
          if (state.inserter === inserter) return
          patch({ inserter })
        },
        setTriggerEl: (element) => {
          if (state.triggerEl === element) return
          patch({ triggerEl: element })
        },
      }
    }

    const store = createStore()
    // #endregion

    // #region icons
    /** Inline 16/18px stroke icons; artwork keeps its own geometry and inherits the theme color. */
    function Icon({ path, size, strokeWidth }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size ?? 16,
          height: size ?? 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: strokeWidth ?? 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        path.map((d, index) => h('path', { key: index, d })),
      )
    }

    const ICON_PROMPT = ['M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-4 3.2V6.5Z', 'M8.5 8.5h7', 'M8.5 11.7h4.5']
    const ICON_PLUS = ['M12 5v14', 'M5 12h14']
    const ICON_PENCIL = ['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'M13.5 6.5 17.5 10.5']
    const ICON_TRASH = ['M4 7h16', 'M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7', 'M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12', 'M10.5 11v5.5', 'M13.5 11v5.5']
    const ICON_CLOSE = ['M6 6l12 12', 'M18 6 6 18']
    // #endregion

    // #region styles
    /** Component-local stylesheet: theme tokens only, mounted and removed with the entry. */
    const CSS = `
.pm-root{display:inline-flex;align-items:center;position:relative;margin-left:-12px}
.pm-trigger{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s,color .12s}
.pm-trigger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pm-trigger[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pm-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pm-trigger:disabled{opacity:.5;cursor:default}

.pm-panel{position:fixed;z-index:60;pointer-events:auto;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);font-size:13px;line-height:1.5}
.pm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.pm-headTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600}
.pm-count{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pm-body{display:flex;flex-direction:column;min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 6px 6px}
.pm-list{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}
.pm-item{display:flex;align-items:flex-start;gap:6px;border-radius:8px;padding:2px 2px 2px 8px}
.pm-item:hover,.pm-item:focus-within{background:var(--dsw-alias-bg-layer-2)}
.pm-itemMain{appearance:none;flex:1;min-width:0;display:flex;flex-direction:column;gap:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:3px 2px;border-radius:6px}
.pm-itemMain:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.pm-itemTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.pm-itemText{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.4;overflow-wrap:anywhere;white-space:pre-wrap}
.pm-itemActions{display:flex;align-items:center;gap:2px;flex:none;padding-top:4px;opacity:0;transition:opacity .12s}
.pm-item:hover .pm-itemActions,.pm-item:focus-within .pm-itemActions{opacity:1}
.pm-iconButton{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pm-iconButton:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.pm-iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.pm-iconButtonDanger:hover{color:var(--dsw-alias-state-error-primary)}
.pm-confirm{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px}
.pm-confirmText{flex:1;min-width:0}

.pm-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 18px 18px;text-align:center}
.pm-emptyMark{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pm-emptyTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.pm-emptyHint{max-width:250px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}

.pm-foot{display:flex;align-items:center;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding:6px}
.pm-footAdd{appearance:none;flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.pm-footAdd:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pm-footAdd:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.pm-notice{border-top:1px solid var(--dsw-alias-border-l1);padding:6px 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.pm-state{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}

.pm-scrim{position:fixed;inset:0;z-index:70;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 62%,transparent);backdrop-filter:blur(1.5px)}
.pm-dialog{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:16px;box-shadow:0 18px 44px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}
.pm-dialogHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pm-dialogTitle{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.pm-field{display:flex;flex-direction:column;gap:6px}
.pm-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.pm-input,.pm-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;padding:7px 10px}
.pm-input{height:32px}
.pm-textarea{min-height:132px;max-height:44vh;resize:vertical;white-space:pre-wrap}
.pm-input:focus-visible,.pm-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.pm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.pm-dialogFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px}
.pm-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.pm-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.pm-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pm-button:disabled{opacity:.5;cursor:default}
.pm-buttonPrimary{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.pm-buttonPrimary:hover:not(:disabled){opacity:.88;color:var(--dsw-alias-bg-base);border-color:transparent}
.pm-buttonDanger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.pm-buttonDanger:hover:not(:disabled){opacity:.88;color:var(--dsw-alias-bg-base);border-color:transparent}

@media (hover:none){
  .pm-itemActions{opacity:1}
  .pm-trigger{width:32px;height:32px;border-radius:8px}
  .pm-iconButton{width:32px;height:32px}
  .pm-itemMain{padding:5px 2px}
  .pm-footAdd{height:36px}
  .pm-input,.pm-textarea{font-size:16px}
  .pm-input{height:38px}
  .pm-button{height:36px}
}
@media (max-width:520px){
  .pm-dialog{width:100%;padding:14px;border-radius:12px}
  .pm-scrim{padding:10px;align-items:flex-end}
  .pm-textarea{max-height:38vh}
}
@media (prefers-reduced-motion:reduce){
  .pm-trigger,.pm-itemActions{transition:none}
}
`

    /** The stylesheet element shared by both entries. */
    function Styles() {
      return h('style', { key: 'pm-style' }, CSS)
    }
    // #endregion

    // #region trigger
    /**
     * The composer tool-row button. It is the session-scoped entry, so it owns
     * the insertion handle the overlay uses.
     * @param props - standard slot kit, including `inputActions` and `t`.
     */
    function PromptTrigger(props) {
      const state = useSyncExternalStore(store.subscribe, store.get)
      const actionsRef = useRef(props.inputActions)
      actionsRef.current = props.inputActions
      const buttonRef = useRef(null)
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate

      useEffect(() => {
        store.setInserter((text) => {
          const actions = actionsRef.current
          if (actions === null || typeof actions !== 'object') return false
          if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return false
          try {
            return actions.insertText(text, actions.captureInsertion()) === true
          } catch {
            return false
          }
        })
        return () => store.setInserter(null)
      }, [])

      useEffect(() => {
        const element = buttonRef.current
        if (element !== null) store.setTriggerEl(element)
        return () => store.setTriggerEl(null)
      }, [])

      const label = t('promptManager.button')
      return h(
        'div',
        { className: 'pm-root' },
        h(Styles),
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'pm-trigger',
            title: label,
            'aria-label': label,
            'aria-haspopup': 'dialog',
            'aria-expanded': state.open ? 'true' : 'false',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => store.toggleMenu(),
          },
          h(Icon, { path: ICON_PROMPT, size: 15 }),
        ),
      )
    }
    // #endregion

    // #region overlay
    /** The add/edit dialog, rendered above the dropdown inside the frame overlay. */
    function PromptDialog({ state, t }) {
      const editor = state.editor
      const textRef = useRef(null)
      const returnFocusRef = useRef(null)

      useEffect(() => {
        if (editor === null) return
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const frame = requestAnimationFrame(() => textRef.current?.focus())
        return () => {
          cancelAnimationFrame(frame)
          const previous = returnFocusRef.current
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [editor === null])

      if (editor === null) return null
      const busy = editor.busy
      const errorText =
        editor.error === 'textRequired'
          ? t('promptManager.textRequired')
          : editor.error === null
            ? null
            : `${t('promptManager.saveFailed')} ${editor.error}`

      return h(
        'div',
        {
          className: 'pm-scrim',
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) store.closeEditor()
          },
        },
        h(
          'div',
          {
            className: 'pm-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': editor.mode === 'create' ? t('promptManager.newTitle') : t('promptManager.editTitle'),
          },
          h(
            'div',
            { className: 'pm-dialogHead' },
            h('h2', { className: 'pm-dialogTitle' }, editor.mode === 'create' ? t('promptManager.newTitle') : t('promptManager.editTitle')),
            h(
              'button',
              {
                type: 'button',
                className: 'pm-iconButton',
                'aria-label': t('promptManager.close'),
                title: t('promptManager.close'),
                disabled: busy,
                onClick: () => store.closeEditor(),
              },
              h(Icon, { path: ICON_CLOSE, size: 15 }),
            ),
          ),
          h(
            'div',
            { className: 'pm-field' },
            h('label', { className: 'pm-label', htmlFor: 'pm-title' }, t('promptManager.titleLabel')),
            h('input', {
              id: 'pm-title',
              className: 'pm-input',
              type: 'text',
              maxLength: LIMITS.title,
              placeholder: t('promptManager.titlePlaceholder'),
              value: editor.title,
              disabled: busy,
              onChange: (event) => store.editEditor({ title: event.target.value, error: null }),
            }),
          ),
          h(
            'div',
            { className: 'pm-field' },
            h('label', { className: 'pm-label', htmlFor: 'pm-text' }, t('promptManager.textLabel')),
            h('textarea', {
              id: 'pm-text',
              ref: textRef,
              className: 'pm-textarea',
              maxLength: LIMITS.text,
              placeholder: t('promptManager.textPlaceholder'),
              value: editor.text,
              disabled: busy,
              onChange: (event) => store.editEditor({ text: event.target.value, error: null }),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void store.saveEditor()
                }
              },
            }),
          ),
          errorText === null ? null : h('p', { className: 'pm-error', role: 'alert' }, errorText),
          h(
            'div',
            { className: 'pm-dialogFoot' },
            h(
              'button',
              { type: 'button', className: 'pm-button', disabled: busy, onClick: () => store.closeEditor() },
              t('promptManager.cancel'),
            ),
            h(
              'button',
              { type: 'button', className: 'pm-button pm-buttonPrimary', disabled: busy, onClick: () => void store.saveEditor() },
              busy ? t('promptManager.saving') : t('promptManager.save'),
            ),
          ),
        ),
      )
    }

    /** One prompt row with its inline delete confirmation. */
    function PromptRow({ prompt, state, t }) {
      const confirming = state.confirmId === prompt.id
      const title = prompt.title.trim() === '' ? t('promptManager.untitled') : prompt.title
      if (confirming) {
        return h(
          'li',
          { className: 'pm-item' },
          h('div', { className: 'pm-confirm' }, h('span', { className: 'pm-confirmText' }, t('promptManager.deleteConfirm')), h(
            'button',
            {
              type: 'button',
              className: 'pm-button pm-buttonDanger',
              onClick: () => void store.remove(prompt),
            },
            t('promptManager.confirm'),
          ), h(
            'button',
            { type: 'button', className: 'pm-button', onClick: () => store.setConfirmId(null) },
            t('promptManager.cancel'),
          )),
        )
      }
      return h(
        'li',
        { className: 'pm-item' },
        h(
          'button',
          {
            type: 'button',
            className: 'pm-itemMain',
            title: title,
            onClick: () => store.insert(prompt),
          },
          h('span', { className: 'pm-itemTitle' }, title),
          h('span', { className: 'pm-itemText' }, prompt.text),
        ),
        h(
          'div',
          { className: 'pm-itemActions' },
          h(
            'button',
            {
              type: 'button',
              className: 'pm-iconButton',
              title: t('promptManager.edit'),
              'aria-label': t('promptManager.edit'),
              onClick: () => store.openEditor('edit', prompt),
            },
            h(Icon, { path: ICON_PENCIL, size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pm-iconButton pm-iconButtonDanger',
              title: t('promptManager.delete'),
              'aria-label': t('promptManager.delete'),
              onClick: () => store.setConfirmId(prompt.id),
            },
            h(Icon, { path: ICON_TRASH, size: 14 }),
          ),
        ),
      )
    }

    /**
     * The dropdown and dialog entry in the frame overlay.
     * @param props - root slot kit including `t`.
     */
    function PromptLayer(props) {
      const state = useSyncExternalStore(store.subscribe, store.get)
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      const panelRef = useRef(null)
      const [geometry, setGeometry] = useState(null)

      /** Anchor the panel above the trigger, clamped to the viewport for narrow screens. */
      const measure = useCallback(() => {
        const trigger = state.triggerEl
        if (trigger === null || typeof trigger.getBoundingClientRect !== 'function') return
        const rect = trigger.getBoundingClientRect()
        const margin = 8
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const width = Math.min(340, viewportWidth - margin * 2)
        const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin))
        const bottom = Math.max(margin, viewportHeight - rect.top + 8)
        const maxHeight = Math.max(180, Math.min(420, rect.top - margin * 2))
        setGeometry({ left, width, bottom, maxHeight })
      }, [state.triggerEl])

      useEffect(() => {
        if (!state.open) {
          setGeometry(null)
          return
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [state.open, measure])

      useEffect(() => {
        if (!state.open) return
        const onPointerDown = (event) => {
          const panel = panelRef.current
          const trigger = state.triggerEl
          if (panel !== null && event.target instanceof Node && panel.contains(event.target)) return
          if (trigger !== null && event.target instanceof Node && trigger.contains(event.target)) return
          if (store.get().editor !== null) return
          store.closeMenu()
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          const current = store.get()
          if (current.editor !== null) store.closeEditor()
          else store.closeMenu()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [state.open, state.triggerEl])

      const noticeText =
        state.notice === null
          ? null
          : state.notice === 'insertFailed'
            ? t('promptManager.insertFailed')
            : state.notice

      if (!state.open && state.editor === null) {
        return h(Styles)
      }

      const panel =
        !state.open || geometry === null
          ? null
          : h(
              'div',
              {
                ref: panelRef,
                className: 'pm-panel',
                role: 'dialog',
                'aria-label': t('promptManager.title'),
                style: {
                  left: `${geometry.left}px`,
                  bottom: `${geometry.bottom}px`,
                  width: `${geometry.width}px`,
                  maxHeight: `${geometry.maxHeight}px`,
                },
              },
              h(
                'div',
                { className: 'pm-head' },
                h('span', { className: 'pm-headTitle' }, t('promptManager.title')),
                state.prompts.length > 0 ? h('span', { className: 'pm-count' }, t('promptManager.count', { n: state.prompts.length })) : null,
              ),
              h(
                'div',
                { className: 'pm-body' },
                state.status === 'loading' && state.prompts.length === 0
                  ? h('div', { className: 'pm-state' }, t('promptManager.loading'))
                  : state.status === 'error' && state.prompts.length === 0
                    ? h(
                        'div',
                        { className: 'pm-state' },
                        h('span', null, t('promptManager.loadFailed')),
                        h('button', { type: 'button', className: 'pm-button', onClick: () => store.retry() }, t('promptManager.retry')),
                      )
                    : state.prompts.length === 0
                      ? h(
                          'div',
                          { className: 'pm-empty' },
                          h('div', { className: 'pm-emptyMark' }, h(Icon, { path: ICON_PROMPT, size: 20 })),
                          h('div', { className: 'pm-emptyTitle' }, t('promptManager.empty.title')),
                          h('div', { className: 'pm-emptyHint' }, t('promptManager.empty.hint')),
                          h(
                            'button',
                            { type: 'button', className: 'pm-button pm-buttonPrimary', onClick: () => store.openEditor('create') },
                            h(Icon, { path: ICON_PLUS, size: 14 }),
                            t('promptManager.add'),
                          ),
                        )
                      : h(
                          'ul',
                          { className: 'pm-list' },
                          state.prompts.map((prompt) => h(PromptRow, { key: prompt.id, prompt, state, t })),
                        ),
              ),
              noticeText === null ? null : h('div', { className: 'pm-notice', role: 'alert' }, noticeText),
              state.prompts.length > 0
                ? h(
                    'div',
                    { className: 'pm-foot' },
                    h(
                      'button',
                      { type: 'button', className: 'pm-footAdd', onClick: () => store.openEditor('create') },
                      h(Icon, { path: ICON_PLUS, size: 14 }),
                      t('promptManager.add'),
                    ),
                  )
                : null,
            )

      return h(React.Fragment, null, h(Styles), panel, h(PromptDialog, { state, t }))
    }
    // #endregion

    // #region apply
    /** Register both entries and the bundle's dictionaries. */
    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en })
        } catch {
          return () => {}
        }
      }, 'prompt-manager: dictionaries')

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'prompt-manager',
            order: 20,
            locale: NS,
            label: () => {
              try {
                return ctx.locale.bind(NS)('promptManager.button')
              } catch {
                return fallbackTranslate('promptManager.button')
              }
            },
          },
          PromptTrigger,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'prompt-manager-layer',
            order: 40,
            locale: NS,
            label: () => {
              try {
                return ctx.locale.bind(NS)('promptManager.title')
              } catch {
                return fallbackTranslate('promptManager.title')
              }
            },
          },
          PromptLayer,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
    // #endregion
  },
})