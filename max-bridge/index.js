/**
 * MAX -> Session bridge.
 *
 * Держит long-poll к Bot API MAX и вставляет каждое новое входящее сообщение
 * в сессию как обычное пользовательское, через ctx.sessionController.prompt().
 */
import { readFileSync, appendFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import https from 'node:https'

export const inject = ['sessionController', 'llm', 'workspaceRegistry']

const API_HOST = 'platform-api2.max.ru'
const TOKEN_FILE = join(homedir(), '.dsh', 'max-bot.json')
const MARKER_FILE = join(homedir(), '.dsh', 'max-marker.json')

// Сертификат Минцифры: без него Bot API MAX не проходит проверку TLS.
// Файл кладётся рядом с плагином (certs/), при наличии — проверка строгая.
const CA_CANDIDATES = [
  join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'certs', 'russian_trusted_root_ca.pem'),
  join(homedir(), '.dsh', 'certs', 'russian_trusted_root_ca.pem'),
]

function loadCa() {
  for (const candidate of CA_CANDIDATES) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
    } catch { /* пробуем следующий */ }
  }
  return undefined
}

const CA_PEM = loadCa()
const TLS_OPTIONS = CA_PEM ? { ca: CA_PEM } : { rejectUnauthorized: false }

function loadAccount() {
  try {
    // Файл мог быть записан редактором с BOM — JSON.parse на нём падает.
    const raw = JSON.parse(readFileSync(TOKEN_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return { token: raw.token, chatId: raw.chat_id }
  } catch {
    return {}
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const LOG_FILE = join(homedir(), '.dsh', 'max-bridge.log')
const LOG_LIMIT = 1024 * 1024

function log(message) {
  try {
    // Ротация: лог не должен расти бесконечно на флешке роутера/малом диске.
    try {
      if (statSync(LOG_FILE).size > LOG_LIMIT) writeFileSync(LOG_FILE, '')
    } catch { /* файла ещё нет */ }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* диагностика не критична */
  }
}

function loadMarker() {
  try {
    return JSON.parse(readFileSync(MARKER_FILE, 'utf8')).marker ?? ''
  } catch {
    return ''
  }
}

function saveMarker(marker) {
  try {
    writeFileSync(MARKER_FILE, JSON.stringify({ marker, at: Date.now() }))
  } catch { /* не критично */ }
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
        ...TLS_OPTIONS,
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
        ...TLS_OPTIONS,
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
  log(`конфиг: ${JSON.stringify(config)}`)
  log(`TLS: ${CA_PEM ? 'строгая проверка (сертификат Минцифры найден)' : 'проверка отключена — сертификат не найден'}`)

  // Диагностика: какие провайдеры моделей доступны в этой сборке.
  try {
    const registered = ctx.llm?.listProviders?.() ?? []
    const configurable = ctx.llm?.listConfigurableProviders?.() ?? []
    log(`провайдеры: ${registered.map(p => p.id).join(', ') || '(нет)'}`)
    log(`конфигурируемые: ${configurable.map(p => `${p.provider}${p.declared ? '' : '(dormant)'}`).join(', ') || '(нет)'}`)
    void ctx.llm
      .listModels('anthropic')
      .then(models => log(`модели anthropic: ${models.map(m => m.id).join(', ') || '(пусто)'}`))
      .catch(error => log(`модели anthropic: ошибка ${error.message}`))
  } catch (error) {
    log(`диагностика провайдеров не удалась: ${error.message}`)
  }

  if (!account.token) {
    ctx.logger?.warn?.('max-bridge: нет токена в ~/.dsh/max-bot.json — мост не активен')
    return
  }

  // Маркер переживает перезапуск: иначе сервер отдаст хвост апдейтов заново
  // и старые сообщения повторно уйдут в сессию.
  const state = { marker: loadMarker(), seen: [], stopped: false, sessionId: config.sessionId }
  const SEEN_LIMIT = 500
  log(`маркер long-poll: ${state.marker ? 'восстановлен из файла' : 'новый'}`)
  const cancelled = new AbortController()

  // Панель управления. Прикрепляем её к КАЖДОМУ сообщению бота: клавиатура в
  // MAX живёт только под своим сообщением, поэтому «всегда доступные кнопки» —
  // это кнопки под последним сообщением, каким бы оно ни было. Удаление живёт
  // не здесь, а крестиком рядом с названием сессии в меню.
  const PANEL_ROW = [
    { type: 'callback', text: '🐋 Сессии', payload: 'menu' },
    { type: 'callback', text: '➕ Новая', payload: 'new' },
  ]
  const withPanel = (rows = []) => ({
    type: 'inline_keyboard',
    payload: { buttons: [...rows, PANEL_ROW] },
  })

  const SELECT_FILE = join(homedir(), '.dsh', 'max-session.json')
  const loadSelected = () => {
    try { return JSON.parse(readFileSync(SELECT_FILE, 'utf8')).sessionId } catch { return undefined }
  }
  const saveSelected = id => {
    try { writeFileSync(SELECT_FILE, JSON.stringify({ sessionId: id })) } catch { /* не критично */ }
  }
  let selectedSession = config.sessionId || loadSelected()
  let pendingRename = null

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
    const wasRunning = new Map()
    while (!state.stopped) {
      await sleep(1500)
      if (state.stopped) break
      try {
        const sessionId = await resolveSessionId(true)
        if (!sessionId) { log('supervisor: сессия не найдена'); continue }
        const running = await sessionRunning(sessionId)
        const report = `${sessionId} running=${running}`
        if (report !== lastReport) { log(`supervisor: ${report}`); lastReport = report }
        // Ход закончился — страхуем доставку ответа, если события не сработали.
        if (wasRunning.get(sessionId) === true && !running) {
          scheduleMirror(sessionId, 800)
        }
        wasRunning.set(sessionId, running)
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
    // Ответ ждём именно из этой сессии: пользователь может переключить выбор в
    // меню, пока ход ещё идёт, — терять из-за этого ответ нельзя.
    expectedReplies.add(sessionId)
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
          await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
            text: ackText,
            attachments: [withPanel()],
          })
        } catch {
          /* подтверждение не критично */
        }
      }
      // Статус «печатает» держит отдельный супервизор по состоянию сессии.
      // НЕ ждём завершения хода: иначе цикл опроса блокируется и следующие
      // сообщения из MAX доставляются только после конца предыдущего ответа.
      // Но промис всё равно резолвится по завершении хода — это надёжный
      // сигнал «пора отзеркалить ответ» в дополнение к agent/status.
      ctx.sessionController
        .prompt(
          {
            requestId: `max-${randomUUID()}`,
            sessionId,
            mode,
            content: [{ type: 'text', text: body }],
          },
          cancelled.signal,
        )
        .then(() => scheduleMirror(sessionId, 1200))
        .catch(error => {
          log(`prompt не принят: ${error.message}`)
        })
    } catch (error) {
      ctx.logger?.warn?.(`max-bridge: prompt не принят: ${error.message}`)
    }
  }

  async function sendText(text, extraRows = []) {
    try {
      await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
        text,
        attachments: [withPanel(extraRows)],
      })
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

  // Вариант B: название сессии занимает весь ряд, а действия живут в карточке.
  // Так текст названия не режется пополам ради крестика.
  function sessionRows(roots, active) {
    const rows = []
    roots.slice(0, 12).forEach(item => {
      const mark = item.sessionId === active ? '● ' : ''
      rows.push([
        { type: 'callback', text: `${mark}${sessionTitle(item)}`, payload: `card:${item.sessionId}` },
      ])
    })
    rows.push([{ type: 'callback', text: '🔄 Обновить', payload: 'refresh' }])
    return rows
  }

  // Карточка сессии: переключиться, удалить, вернуться к списку.
  async function sendSessionCard(callbackId, sessionId) {
    const roots = await listRoots()
    const item = roots.find(entry => entry.sessionId === sessionId)
    if (!item) {
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
        message: { text: 'Сессия не найдена — возможно, она уже удалена.', attachments: [withPanel()] },
      })
      return
    }
    const active = selectedSession || state.sessionId
    const marks = []
    if (item.sessionId === active) marks.push('текущая')
    if (item.running) marks.push('сейчас работает')
    const header = `${sessionTitle(item)}${marks.length ? `\n(${marks.join(', ')})` : ''}\n\nЧто сделать?`
    await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
      message: {
        text: header,
        attachments: [withPanel([
          [
            { type: 'callback', text: '✅ Вход', payload: `pick:${item.sessionId}` },
            { type: 'callback', text: '✏️ Rename', payload: `rename:${item.sessionId}` },
          ],
          [{ type: 'callback', text: '❌ Удалить', payload: `del:${item.sessionId}` }],
        ])],
      },
    })
  }

  async function sendSessionsMenu(callbackId) {
    const roots = userSessions(await listRoots())
    const active = selectedSession || state.sessionId
    const current = roots.find(item => item.sessionId === active)
    const header = current
      ? `Сессия: ${shortTitle(current)}`
      : 'Выберите сессию:'
    const payload = { text: header, attachments: [withPanel(sessionRows(roots, active))] }
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
    if (data.startsWith('card:')) {
      await sendSessionCard(callbackId, data.slice('card:'.length))
      return
    }
    if (data === 'new') {
      try {
        const created = await ctx.sessionController.create({})
        const newId = created?.sessionId ?? created?.id
        if (newId) {
          selectedSession = newId
          state.sessionId = newId
          saveSelected(newId)
          log(`создана новая сессия: ${newId}`)
        }
        await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
          message: {
            text: newId ? 'Новая сессия создана и выбрана. Пишите — сообщения пойдут в неё.' : 'Не удалось создать сессию.',
            attachments: [withPanel()],
          },
        })
      } catch (error) {
        log(`new: ошибка ${error.message}`)
        await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
          message: { text: `Не удалось создать сессию: ${error.message}`, attachments: [withPanel()] },
        })
      }
      return
    }
    // Переименование: просим прислать новое название следующим сообщением.
    if (data.startsWith('rename:')) {
      const target = data.slice('rename:'.length)
      if (!target) return
      pendingRename = { sessionId: target, at: Date.now() }
      const roots = await listRoots()
      const item = roots.find(entry => entry.sessionId === target)
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
        message: {
          text: `Новое название для «${item ? sessionTitle(item) : target}»?\n\nПришлите его одним сообщением — или /cancel, чтобы отменить.`,
          attachments: [withPanel([[{ type: 'callback', text: '⬅️ Отмена', payload: 'menu' }]])],
        },
      })
      return
    }
    // Крестик рядом с названием сессии: сначала спрашиваем, потом архивируем
    // ровно ту сессию, на которую нажали.
    if (data.startsWith('del:yes:')) {
      const target = data.slice('del:yes:'.length)
      if (!target) return
      try {
        // stopActivity: останавливаем активный ход, иначе архив откажется работать.
        await ctx.workspaceRegistry.archiveSession(target, { stopActivity: true })
        if ((selectedSession || state.sessionId) === target) {
          selectedSession = undefined
          state.sessionId = undefined
          saveSelected('')
        }
        log(`сессия отправлена в архив: ${target}`)
        await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
          message: { text: 'Сессия удалена из списка (перемещена в архив).', attachments: [withPanel()] },
        })
      } catch (error) {
        log(`del: ошибка ${error.message}`)
        const friendly = /cannot archive/i.test(error.message)
          ? 'Не получилось: сессия сейчас занята — удали её, когда ход закончится.'
          : `Не удалось удалить: ${error.message}`
        await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
          message: { text: friendly, attachments: [withPanel()] },
        })
      }
      return
    }
    if (data.startsWith('del:') && data !== 'del:yes') {
      const target = data.slice('del:'.length)
      const roots = await listRoots()
      const wanted = roots.find(item => item.sessionId === target)
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
        message: {
          text: `Удалить сессию «${wanted ? shortTitle(wanted) : target}»?\n\nОна уйдёт в архив: пропадёт из списка, но файлы останутся.`,
          attachments: [withPanel([
            [{ type: 'callback', text: '❌ Да, удалить', payload: `del:yes:${target}` }],
            [{ type: 'callback', text: 'Отмена', payload: 'menu' }],
          ])],
        },
      })
      return
    }
    // Старые клавиатуры (до перехода на крестики) ещё могут прислать просто del.
    if (data === 'del') {
      await sendSessionsMenu(callbackId)
      return
    }
    if (data === 'del:yes') {
      const active = selectedSession || state.sessionId
      if (!active) return
      try {
        await ctx.workspaceRegistry.archiveSession(active, { stopActivity: true })
        selectedSession = undefined
        state.sessionId = undefined
        saveSelected('')
        log(`сессия отправлена в архив: ${active}`)
        await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
          message: { text: 'Сессия удалена из списка (перемещена в архив).', attachments: [withPanel()] },
        })
      } catch (error) {
        log(`del: ошибка ${error.message}`)
        const friendly = /cannot archive/i.test(error.message)
          ? 'Не получилось: сессия сейчас занята — удали её, когда ход закончится.'
          : `Не удалось удалить: ${error.message}`
        await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
          message: { text: friendly, attachments: [withPanel()] },
        })
      }
      return
    }
    if (data === 'restart') {
      // Подтверждение отправляем отдельным сообщением: подмена текста в том же
      // сообщении легко остаётся незамеченной.
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
        message: { text: 'Нажмите «🔴 Да, перезапустить» в сообщении ниже.', attachments: [withPanel()] },
      })
      await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
        text: '🔴 Перезапустить DeepSeek?\n\nТекущая работа прервётся. Сессия сохранится и продолжится после запуска.',
        attachments: [withPanel([
          [{ type: 'callback', text: '🔴 Да, перезапустить', payload: 'restart:yes' }],
          [{ type: 'callback', text: 'Отмена', payload: 'menu' }],
        ])],
      })
      return
    }
    if (data === 'restart:yes') {
      await apiPost(account.token, `/answers?callback_id=${encodeURIComponent(callbackId)}`, {
        message: { text: '🔴 Перезапускаюсь… Вернусь через несколько секунд.', attachments: [withPanel()] },
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
    return false
  }

  async function loop() {
    while (!state.stopped) {
      try {
        const query = `/updates?timeout=${pollTimeoutSec}&limit=20` +
          (state.marker ? `&marker=${encodeURIComponent(state.marker)}` : '')
        const response = await apiGet(account.token, query)
        if (response?.marker) {
          state.marker = String(response.marker)
          saveMarker(state.marker)
        }
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
          if (!text || !mid || state.seen.includes(mid)) continue
          // Отмечаем сообщение прочитанным: в MAX это действие mark_seen —
          // в документации его нет, но Bot API его принимает.
          const seenAt = Date.now()
          void apiPost(account.token, `/chats/${account.chatId}/actions`, { action: 'mark_seen' })
            .then(res => log(`mark_seen: ${JSON.stringify(res)} (${Date.now() - seenAt} мс)`))
            .catch(error => log(`mark_seen ошибка: ${error.message}`))
          state.seen.push(mid)
          if (state.seen.length > SEEN_LIMIT) state.seen.splice(0, state.seen.length - SEEN_LIMIT)
          if (message?.sender?.is_bot) continue
          if (account.chatId && String(message?.recipient?.chat_id) !== String(account.chatId)) continue
          // Ожидаем новое название сессии — это сообщение не уходит агенту.
          if (pendingRename && Date.now() - pendingRename.at < 10 * 60 * 1000) {
            const pending = pendingRename
            pendingRename = null
            const title = String(text).trim()
            if (title && !title.startsWith('/')) {
              try {
                await ctx.sessionController.rename({ sessionId: pending.sessionId, title })
                log(`сессия переименована: ${pending.sessionId} -> ${title}`)
                await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
                  text: `Переименовано: «${title}»`,
                  attachments: [withPanel()],
                })
              } catch (error) {
                log(`rename: ошибка ${error.message}`)
                await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
                  text: `Не удалось переименовать: ${error.message}`,
                  attachments: [withPanel()],
                })
              }
              continue
            }
            pendingRename = pending
          }
          if (await handleCommand(text)) continue
          await deliver(text, message?.sender?.name)
        }
      } catch (error) {
        // Дублируем в наш лог: ctx.logger в файл не пишет, и ошибки цикла
        // раньше были невидимы.
        log(`loop: ${error.message}`)
        ctx.logger?.warn?.(`max-bridge: ${error.message}`)
        await sleep(3000)
      }
      if (!state.stopped) await sleep(300)
    }
  }

  // --- Зеркалирование ответов в MAX -------------------------------------
  // Слушаем события сессии, запоминаем последний текст ассистента и,
  // когда ход завершается (agent/status -> idle), отправляем его в чат.
  const lastAssistant = new Map()
  // Сессии, в которые мост только что доставил сообщение: ответ ждём именно
  // оттуда, даже если пользователь успел переключить выбор в меню.
  const expectedReplies = new Set()
  const MAX_TEXT = 3900

  // Рассуждения модели НЕ пересылаем: в чат должен уходить только финальный текст.
  const NON_ANSWER_TYPES = new Set(['reasoning', 'thinking', 'analysis', 'redacted_reasoning', 'reasoning_content'])

  function textOfContent(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter(part => typeof part === 'string' || !NON_ANSWER_TYPES.has(String(part?.type ?? '').toLowerCase()))
      .map(part => (typeof part === 'string' ? part : part?.text ?? ''))
      .filter(Boolean)
      .join('\n')
  }

  function findAssistantText(node, depth = 0, seen = new Set()) {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return undefined
    seen.add(node)
    // Сами блоки рассуждений пропускаем целиком
    const nodeType = String(node.type ?? node.kind ?? '').toLowerCase()
    if (NON_ANSWER_TYPES.has(nodeType)) return undefined
    if (node.reasoning && !node.content && !node.text) return undefined
    const role = node.role ?? node.message?.role
    if (role === 'assistant') {
      const text = textOfContent(node.content ?? node.text ?? node.message?.content)
      if (text.trim()) return text.trim()
    }
    for (const key of Object.keys(node)) {
      const found = findAssistantText(node[key], depth + 1, seen)
      if (found) return found
    }
    return undefined
  }

  function sessionIdOf(...candidates) {
    for (const candidate of candidates) {
      const id = candidate?.sessionId ?? candidate?.id ?? candidate?.session?.id
      if (typeof id === 'string' && id) return id
    }
    return undefined
  }

  async function mirrorReply(sessionId) {
    if (config.mirrorReplies === false || state.stopped) return
    const text = lastAssistant.get(sessionId)
    if (!text) {
      if (config.debugEvents) log(`зеркало: нет текста для ${sessionId}`)
      return
    }
    // Отвечаем только в те сессии, куда писали из MAX: чужие ходы (например,
    // работа в GUI) в чат не попадают.
    if (!expectedReplies.has(sessionId)) {
      lastAssistant.delete(sessionId)
      return
    }
    lastAssistant.delete(sessionId)
    const chunks = []
    for (let i = 0; i < text.length; i += MAX_TEXT) chunks.push(text.slice(i, i + MAX_TEXT))
    if (chunks.length === 0) return
    log(`зеркалю ответ в MAX (${text.length} символов, частей ${chunks.length})`)
    let first = true
    for (const chunk of chunks) {
      try {
        // MAX ограничивает частоту отправки (~2 сообщения в секунду):
        // между частями держим паузу, иначе часть может не уйти.
        if (!first) await sleep(300)
        first = false
        await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
          text: chunk,
          attachments: [withPanel()],
        })
      } catch (error) {
        log(`зеркалирование не удалось: ${error.message}`)
        break
      }
    }
    expectedReplies.delete(sessionId)
  }

  // Доставка ответа дебаунсом: финальный текст и событие idle приходят в разном
  // порядке (а assistant/message вообще сыплется на каждый шаг), поэтому ждём
  // паузу и проверяем, что ход действительно закончился.
  const mirrorTimers = new Map()
  function scheduleMirror(sessionId, delay = 2500) {
    if (config.mirrorReplies === false || !sessionId) return
    const prev = mirrorTimers.get(sessionId)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(async () => {
      mirrorTimers.delete(sessionId)
      if (state.stopped) return
      try {
        if (await sessionRunning(sessionId)) {
          scheduleMirror(sessionId, 1500)
          return
        }
        await mirrorReply(sessionId)
      } catch (error) {
        log(`зеркало: ошибка ${error.message}`)
      }
    }, delay)
    mirrorTimers.set(sessionId, timer)
  }

  // --- Трансляция процесса (мысли по ходу и вызовы инструментов) ----------
  const processState = new Map() // sessionId -> { text, sent }
  const PROCESS_CHUNK = 500

  function findReasoningText(node, depth = 0, seen = new Set()) {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return undefined
    seen.add(node)
    const parts = Array.isArray(node.content) ? node.content : undefined
    if (parts) {
      const reasoning = parts
        .filter(part => NON_ANSWER_TYPES.has(String(part?.type ?? '').toLowerCase()))
        .map(part => part?.text ?? '')
        .join('')
        .trim()
      if (reasoning) return reasoning
    }
    for (const key of Object.keys(node)) {
      const found = findReasoningText(node[key], depth + 1, seen)
      if (found) return found
    }
    return undefined
  }

  async function flushProcess(sessionId) {
    if (config.processFeed === false) return
    const active = selectedSession || state.sessionId
    if (active && active !== sessionId) return
    const entry = processState.get(sessionId)
    if (!entry) return
    while (entry.text.length - entry.sent > PROCESS_CHUNK) {
      const chunk = entry.text.slice(entry.sent, entry.sent + PROCESS_CHUNK)
      entry.sent += chunk.length
      try {
        await apiPost(account.token, `/messages?chat_id=${account.chatId}`, {
          text: `💭 ${chunk}`,
          attachments: [withPanel()],
        })
      } catch (error) {
        log(`трансляция мыслей не удалась: ${error.message}`)
        return
      }
    }
  }

  async function sendProcessLine(sessionId, line) {
    if (config.processFeed === false) return
    const active = selectedSession || state.sessionId
    if (active && active !== sessionId) return
    try {
      await apiPost(account.token, `/messages?chat_id=${account.chatId}`, { text: line, attachments: [withPanel()] })
    } catch { /* служебная строка, не критично */ }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (config.debugEvents) {
        let sample = ''
        try { sample = JSON.stringify(event).slice(0, 500) } catch { sample = '(не сериализуется)' }
        const s = typeof session === 'string'
          ? `string:${session.slice(0, 24)}`
          : `object keys=${Object.keys(session ?? {}).join('|')} id=${session?.sessionId ?? session?.id ?? '?'}`
        log(`evt session(${s}) keys=${Object.keys(event ?? {}).join(',')} :: ${sample}`)
      }
      const text = findAssistantText(event)
      if (text) {
        const id = sessionIdOf(session, event)
        if (id) {
          lastAssistant.set(id, text)
          scheduleMirror(id)
        }
      }
      const reasoning = findReasoningText(event)
      if (reasoning) {
        const id = sessionIdOf(session, event)
        if (id) {
          const prev = processState.get(id) ?? { text: '', sent: 0 }
          // reasoning приходит накопительно: берём более длинный вариант
          if (reasoning.length > prev.text.length) {
            processState.set(id, { text: reasoning, sent: prev.sent })
            void flushProcess(id)
          }
        }
      }
    } catch { /* событие может быть любого вида */ }
  })

  // Уведомления о вызовах инструментов. По умолчанию выключены:
  // в чат идут только мысли (💭) и финальный ответ.
  ctx.on('tools/result', exec => {
    if (config.processTools !== true) return
    try {
      const name = exec?.name ?? exec?.tool?.name ?? exec?.toolName ?? exec?.tool
      if (!name) return
      const id = sessionIdOf(exec?.agent, exec)
      if (id) void sendProcessLine(id, `⚙️ ${name}`)
    } catch { /* служебное */ }
  })

  ctx.on('agent/status', payload => {
    try {
      if (payload?.status !== 'idle') return
      const id = sessionIdOf(payload.agent, payload)
      if (id) scheduleMirror(id, 1200)
    } catch { /* статус не критичен */ }
  })

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




