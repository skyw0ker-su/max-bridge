/**
 * MAX -> Session bridge.
 *
 * Держит long-poll к Bot API MAX и вставляет каждое новое входящее сообщение
 * в сессию как обычное пользовательское, через ctx.sessionController.prompt().
 */
import { readFileSync, appendFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import https from 'node:https'

export const inject = ['sessionController']

const API_HOST = 'platform-api2.max.ru'
const TOKEN_FILE = join(homedir(), '.dsh', 'max-bot.json')

function loadAccount() {
  try {
    const raw = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
    return { token: raw.token, chatId: raw.chat_id }
  } catch {
    return {}
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const LOG_FILE = join(homedir(), '.dsh', 'max-bridge.log')

function log(message) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* диагностика не критична */
  }
}

function apiPost(token, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = https.request(
      {
        hostname: API_HOST,
        path,
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
        timeout: 30000,
      },
      res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('MAX API timeout')))
    req.write(body)
    req.end()
  })
}

function apiGet(token, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_HOST,
        path,
        method: 'GET',
        headers: { Authorization: token },
        // Bot API MAX отдаёт сертификат с цепочкой Минцифры, которой нет в Node.
        rejectUnauthorized: false,
        timeout: 90000,
      },
      res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('MAX API timeout')))
    req.end()
  })
}

export function apply(ctx, config = {}) {
  const pollTimeoutSec = Number(config.pollTimeoutSec) || 25
  const mode = config.mode === 'steer' ? 'steer' : 'queue'
  const account = loadAccount()

  if (!account.token) {
    ctx.logger?.warn?.('max-bridge: нет токена в ~/.dsh/max-bot.json — мост не активен')
    return
  }

  const state = { marker: '', seen: new Set(), stopped: false, sessionId: config.sessionId }
  const cancelled = new AbortController()

  const SELECT_FILE = join(homedir(), '.dsh', 'max-session.json')
  const loadSelected = () => {
    try { return JSON.parse(readFileSync(SELECT_FILE, 'utf8')).sessionId } catch { return undefined }
  }
  const saveSelected = id => {
    try { writeFileSync(SELECT_FILE, JSON.stringify({ sessionId: id })) } catch { /* не критично */ }
  }
  let selectedSession = config.sessionId || loadSelected()
  let pendingChoices = []

  // При горячей перезагрузке прежний экземпляр мог остаться жить: гасим его.
  const previous = globalThis.__maxBridgeStop
  if (typeof previous === 'function') {
    try { previous() } catch { /* прежний экземпляр уже остановлен */ }
  }
  const stop = () => {
    state.stopped = true
    cancelled.abort()
  }
  globalThis.__maxBridgeStop = stop

  // Целевая сессия вычисляется каждый раз заново: пользователь может
  // переключаться между задачами. Приоритет — та, что работает сейчас,
  // иначе самая свежая по активности.
  async function listRoots() {
    const value = await ctx.sessionController.list({}, cancelled.signal)
    const items = Array.isArray(value?.items) ? value.items : []
    return items
      .filter(item => !item.parentSessionId && !item.blank)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  async function resolveSessionId(preferRunning = false) {
    if (selectedSession) return selectedSession
    try {
      const roots = await listRoots()
      const running = preferRunning ? roots.find(item => item.running) : undefined
      const chosen = running ?? roots[0]
      if (chosen) {
        if (state.sessionId !== chosen.sessionId) {
          state.sessionId = chosen.sessionId
          log(`сессия переключена: ${chosen.sessionId} running=${Boolean(chosen.running)}`)
        }
        return chosen.sessionId
      }
    } catch (error) {
      ctx.logger?.warn?.(`max-bridge: не удалось выбрать сессию: ${error.message}`)
    }
    return state.sessionId
  }

  async function sessionRunning(sessionId) {
    try {
      const value = await ctx.sessionController.list({}, cancelled.signal)
      const item = (value?.items ?? []).find(entry => entry.sessionId === sessionId)
      return Boolean(item?.running)
    } catch {
      return false
    }
  }

  // Супервизор статуса: пока сессия занята, бот в MAX «печатает».
  // Не привязан к отдельному сообщению — работает для любого хода.
  async function typingSupervisor(chatId) {
    if (!chatId) { log('supervisor: нет chatId'); return }
    log(`supervisor: старт, chatId=${chatId}`)
    let lastPing = 0
    let lastReport = ''
    while (!state.stopped) {
      await sleep(1500)
      if (state.stopped) break
      try {
        const sessionId = await resolveSessionId(true)
        if (!sessionId) { log('supervisor: сессия не найдена'); continue }
        const running = await sessionRunning(sessionId)
        const report = `${sessionId} running=${running}`
        if (report !== lastReport) { log(`supervisor: ${report}`); lastReport = report }
        if (!running) continue
        if (Date.now() - lastPing < 1200) continue
        lastPing = Date.now()
        const res = await apiPost(account.token, `/chats/${chatId}/actions`, { action: 'typing_on' })
        log(`supervisor: typing -> ${JSON.stringify(res)}`)
      } catch (error) {
        log(`supervisor: ошибка ${error.message}`)
      }
    }
  }

  async function deliver(text, senderName) {
    const sessionId = await resolveSessionId()
    if (!sessionId) {
      ctx.logger?.warn?.('max-bridge: нет доступной сессии для доставки')
      return
    }
    const replyScript = config.replyScript || 'maxsend.py'
    const prefix = config.replyHint === true
      ? `\n\n(Ответь пользователю в MAX скриптом ${replyScript} — текст передавай через --file в UTF-8.)`
      : ''
    const body = `[MAX] ${text}${prefix}`
    try {
      if (account.chatId && config.ackText !== false) {
        const ackText = typeof config.ackText === 'string' && config.ackText
          ? config.ackText
          : '✅ Принял, работаю…'
        try {
          await apiPost(account.token, `/messages?chat_id=${account.chatId}`, { text: ackText })
        } catch {
          /* подтверждение не критично */
        }
      }
      // Статус «печатает» держит отдельный супервизор по состоянию сессии.
      await ctx.sessionController.prompt(
        {
          requestId: `max-${randomUUID()}`,
          sessionId,
          mode,
          content: [{ type: 'text', text: body }],
        },
        cancelled.signal,
      )
    } catch (error) {
      ctx.logger?.warn?.(`max-bridge: prompt не принят: ${error.message}`)
    }
  }

  async function sendText(text) {
    try {
      await apiPost(account.token, `/messages?chat_id=${account.chatId}`, { text })
    } catch { /* не критично */ }
  }

  // Заголовок сессии в списке не приходит — читаем его из файла сессии.
  const SESSIONS_ROOT = join(homedir(), '.dsh', 'storages')
  const titleCache = new Map()

  function sessionFile(sessionId) {
    try {
      for (const storage of readdirSync(SESSIONS_ROOT)) {
        const candidate = join(SESSIONS_ROOT, storage, 'sessions', `${sessionId}.json`)
        if (existsSync(candidate)) return candidate
      }
    } catch { /* нет доступа — работаем без заголовка */ }
    return undefined
  }

  function titleFromFile(sessionId) {
    const cached = titleCache.get(sessionId)
    if (cached && Date.now() - cached.at < 60000) return cached.title
    try {
      const file = sessionFile(sessionId)
      if (!file) return undefined
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const title = raw?.record?.rows?.title?.val
      if (typeof title === 'string' && title.trim()) {
        titleCache.set(sessionId, { title, at: Date.now() })
        return title
      }
    } catch { /* заголовок необязателен */ }
    return undefined
  }

  const sessionTitle = item => {
    const own = item.title || item.name || item.summary
    if (typeof own === 'string' && own.trim()) return own
    return titleFromFile(item.sessionId) || item.sessionId.slice(9, 17)
  }

  const ago = ts => {
    const mins = Math.max(0, Math.round((Date.now() - (ts || 0)) / 60000))
    if (mins < 1) return 'только что'
    if (mins < 60) return `${mins} мин назад`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours} ч назад`
    return `${Math.round(hours / 24)} дн назад`
  }

  const shortTitle = item => {
    const raw = sessionTitle(item)
    return raw.length > 46 ? `${raw.slice(0, 45)}…` : raw
  }

  // Показываем только пользовательские сессии — как в списке приложения:
  // архивные, пустые и безымянные записи не показываем, как и всё старше трёх дней.
  const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
  const WORKSPACE_FILE = join(homedir(), '.dsh', 'storages', 'workspace.json')
  let workspaceCache = { at: 0, archived: new Set(), pinned: new Set() }

  function workspaceMeta() {
    if (Date.now() - workspaceCache.at < 15000) return workspaceCache
    try {
      const raw = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'))
      const global = raw?.global ?? {}
      workspaceCache = {
        at: Date.now(),
        archived: new Set(Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []),
        pinned: new Set(Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []),
      }
    } catch {
      workspaceCache = { at: Date.now(), archived: new Set(), pinned: new Set() }
    }
    return workspaceCache
  }

  const userSessions = roots => {
    const active = selectedSession || state.sessionId
    const meta = workspaceMeta()
    const visible = roots.filter(item => {
      if (item.sessionId === active) return true
      if (meta.archived.has(item.sessionId)) return false
      if (Date.now() - (item.updatedAt || 0) > MAX_AGE_MS) return false
      const own = item.title || item.name
      if (typeof own === 'string' && own.trim()) return true
      return Boolean(titleFromFile(item.sessionId))
    })
    // закреплённые — сверху, как в приложении
    visible.sort((a, b) => {
      const pa = meta.pinned.has(a.sessionId) ? 1 : 0
      const pb = meta.pinned.has(b.sessionId) ? 1 : 0
      if (pa !== pb) return pb - pa
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })
    return visible.length > 0 ? visible : roots
  }

  function buildKeyboard(roots, active) {
    const rows = []
    let row = []
    roots.slice(0, 12).forEach(item => {
      const mark = item.sessionId === active ? '● ' : ''
      row.push({ type: 'callback', text: `${mark}${shortTitle(item)}`, payload: `pick:${item.sessionId}` })
      if (row.length === 2) { rows.push(row); row = [] }
    })
    if (row.length > 0) rows.push(row)
    rows.push([{ type: 'callback', text: '🔄 Обновить', payload: 'refresh' }])
    return { type: 'inline_keyboard', payload: { buttons: rows } }
  }

  async function sendSessionsMenu(callbackId) {
    const roots = userSessions(await listRoots())
    const active = selectedSession || state.sessionId
    const current = roots.find(item => item.sessionId === active)
    const header = current
      ? `Сессия: ${shortTitle(current)}`
      : 'Выберите сессию:'
    const payload = { text: header, attachments: [buildKeyboard(roots, active)] }
    if (callbackId) {
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, { message: payload })
    } else {
      await apiPost(account.token, `/messages?chat_id=${account.chatId}`, payload)
    }
  }

  function restartApplication() {
    // Всю работу делает внешний скрипт: внутри spawn вложенные кавычки
    // ломают taskkill, а timeout без консоли вообще не работает.
    // Путь задаётся в конфиге (config.restartScript), иначе кнопка не работает.
    const script = config.restartScript
    if (!script) {
      log('рестарт: в конфиге не задан restartScript')
      return
    }
    try {
      const child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      log(`рестарт приложения запущен через ${script}`)
    } catch (error) {
      log(`рестарт не удался: ${error.message}`)
    }
  }

  async function handleCallback(update) {
    const callback = update?.callback
    const data = String(callback?.payload || '')
    const callbackId = callback?.callback_id
    if (!callbackId) return
    if (data === 'refresh' || data === 'menu') {
      await sendSessionsMenu(callbackId)
      return
    }
    if (data === 'restart') {
      // Подтверждение отправляем отдельным сообщением: подмена текста в том же
      // сообщении легко остаётся незамеченной.
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
        message: { text: 'Нажмите «🔴 Да, перезапустить» в сообщении ниже.' },
      })
      await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
        text: '🔴 Перезапустить DeepSeek?\n\nТекущая работа прервётся. Сессия сохранится и продолжится после запуска.',
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [{ type: 'callback', text: '🔴 Да, перезапустить', payload: 'restart:yes' }],
              [{ type: 'callback', text: 'Отмена', payload: 'menu' }],
            ],
          },
        }],
      })
      return
    }
    if (data === 'restart:yes') {
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
        message: { text: '🔴 Перезапускаюсь… Вернусь через несколько секунд.' },
      })
      await sendText('Приложение закрывается и запускается заново. Напишите что-нибудь через 15 секунд — проверю связь.')
      restartApplication()
      return
    }
    if (data.startsWith('pick:')) {
      const target = data.slice(5)
      selectedSession = target
      state.sessionId = target
      saveSelected(target)
      log(`выбрана сессия: ${target}`)
      // После выбора показываем тот же экран: заголовок с именем и кнопки под ним.
      await sendSessionsMenu(callbackId)
    }
  }

  async function showSessions() {
    await sendSessionsMenu()
  }

  async function handleCommand(text) {
    const trimmed = text.trim()
    if (/^\/(sessions|сессии|список)$/i.test(trimmed)) {
      await showSessions()
      return true
    }
    if (/^\/(session|сессия)$/i.test(trimmed)) {
      const roots = await listRoots()
      const active = roots.find(item => item.sessionId === (selectedSession || state.sessionId))
      await sendText(active
        ? `Текущая сессия: ${sessionTitle(active)}`
        : 'Сессия не выбрана — работаю с самой свежей. Напишите /sessions для выбора.')
      return true
    }
    const picked = trimmed.match(/^\/?(\d{1,2})$/)
    if (picked && pendingChoices.length > 0) {
      const index = Number(picked[1]) - 1
      if (index >= 0 && index < pendingChoices.length) {
        selectedSession = pendingChoices[index]
        state.sessionId = selectedSession
        saveSelected(selectedSession)
        const roots = await listRoots()
        const chosen = roots.find(item => item.sessionId === selectedSession)
        await sendText(`Переключился на: ${chosen ? sessionTitle(chosen) : selectedSession}`)
        log(`выбрана сессия: ${selectedSession}`)
        return true
      }
    }
    return false
  }

  async function loop() {
    while (!state.stopped) {
      try {
        const query = `/updates?timeout=${pollTimeoutSec}&limit=20` +
          (state.marker ? `&marker=${encodeURIComponent(state.marker)}` : '')
        const response = await apiGet(account.token, query)
        if (response?.marker) state.marker = String(response.marker)
        for (const update of response?.updates ?? []) {
          if (update?.update_type === 'message_callback') {
            try {
              log(`callback: ${update?.callback?.payload ?? '(нет payload)'}`)
              await handleCallback(update)
            } catch (error) {
              log(`callback ошибка: ${error.message}`)
            }
            continue
          }
          const message = update?.message
          const text = message?.body?.text
          const mid = message?.body?.mid
          if (!text || !mid || state.seen.has(mid)) continue
          state.seen.add(mid)
          if (message?.sender?.is_bot) continue
          if (account.chatId && String(message?.recipient?.chat_id) !== String(account.chatId)) continue
          if (await handleCommand(text)) continue
          await deliver(text, message?.sender?.name)
        }
      } catch (error) {
        ctx.logger?.warn?.(`max-bridge: ${error.message}`)
        await sleep(3000)
      }
      if (!state.stopped) await sleep(300)
    }
  }

  ctx.effect(() => {
    loop().catch(error => ctx.logger?.warn?.(`max-bridge остановлен: ${error.message}`))
    typingSupervisor(account.chatId).catch(() => {})
    return () => {
      stop()
      if (globalThis.__maxBridgeStop === stop) globalThis.__maxBridgeStop = undefined
    }
  })

  ctx.logger?.info?.('max-bridge: слушаю MAX')
}
