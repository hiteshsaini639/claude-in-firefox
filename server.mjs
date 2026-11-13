#!/usr/bin/env node
// MCP server that drives a Firefox started by bin/firefox-remote, over
// Firefox's built-in WebDriver BiDi remote control.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import puppeteer from 'puppeteer-core'
import { z } from 'zod'

const PORT = Number(process.env.FIREFOX_REMOTE_PORT ?? 9222)
const ENDPOINT = `ws://127.0.0.1:${PORT}/session`
const START = new URL('./bin/firefox-remote', import.meta.url).pathname
const BUFFER = 500

let browser = null
let connecting = null
let nextTab = 1
const tabs = new Map()
const pageState = new WeakMap()

const log = (...a) => console.error('[claude-in-firefox]', ...a)
process.on('uncaughtException', e => log('uncaught', e))
process.on('unhandledRejection', e => log('unhandled', e))

const push = (list, item) => {
  list.push(item)
  if (list.length > BUFFER) list.shift()
}

const friendly = e => {
  const m = String(e?.message ?? e)
  if (/ECONNREFUSED|socket hang up|connect ETIMEDOUT/.test(m)) {
    return `Firefox is not listening for remote control on 127.0.0.1:${PORT}. Start it with "${START}" --claude-profile (Claude's own profile, beside the user's Firefox), or without --claude-profile for the user's everyday Firefox. The script says what is in the way, if anything.`
  }
  if (/Maximum number of active sessions/.test(m)) {
    return 'Firefox already has a remote-control session. Firefox allows one at a time: another Claude session may be using it, or an earlier connection ended without closing. Close the other session; if none is using it, quit Firefox and run bin/firefox-remote again.'
  }
  const code = m.match(/NS_ERROR_[A-Z_]+/)?.[0]
  if (code) return `Firefox could not load the page (${code}). ${NET[code] ?? ''}`.trim()
  // Firefox appends its own stack to some errors.
  if (/@(chrome|resource):\/\//.test(m)) return m.split('\n')[0].replace(/\s#\S+@\S+/g, '')
  return m
}

const NET = {
  NS_ERROR_UNKNOWN_HOST: 'No such site: the host name does not exist.',
  NS_ERROR_CONNECTION_REFUSED: 'Nothing is listening at that address and port.',
  NS_ERROR_NET_TIMEOUT: 'The site did not answer in time.',
  NS_ERROR_OFFLINE: 'Firefox is offline.',
  NS_ERROR_MALFORMED_URI: 'Give the whole address, with https:// or http://.',
}

function instrument(page) {
  if (pageState.has(page)) return pageState.get(page)
  const s = { console: [], network: [], seq: 0, pending: new WeakMap(), acceptDialogs: 0, mine: false }
  pageState.set(page, s)
  page.on('console', m => push(s.console, `${m.type()}: ${m.text()}`))
  page.on('pageerror', e => push(s.console, `pageerror: ${e.message}`))
  page.on('request', r => {
    const entry = { method: r.method(), url: r.url(), status: 'pending', seq: ++s.seq }
    s.pending.set(r, entry)
    push(s.network, entry)
  })
  page.on('response', r => {
    const entry = s.pending.get(r.request())
    if (entry) entry.status = r.status()
  })
  page.on('requestfailed', r => {
    const entry = s.pending.get(r)
    if (entry) entry.status = `failed: ${r.failure()?.errorText ?? 'unknown'}`
  })
  page.on('dialog', async d => {
    const accept = d.type() === 'alert' || s.acceptDialogs > 0
    try {
      accept ? await d.accept() : await d.dismiss()
    } catch {}
    push(s.console, `dialog: ${d.type()} "${d.message()}" → ${accept ? 'accepted' : 'dismissed'}`)
  })
  return s
}

function idOf(page) {
  for (const [id, p] of tabs) if (p === page) return id
  const id = nextTab++
  tabs.set(id, page)
  instrument(page)
  return id
}

async function getBrowser() {
  if (browser?.connected) return browser
  connecting ??= puppeteer
    .connect({ browserWSEndpoint: ENDPOINT, protocol: 'webDriverBiDi', defaultViewport: null })
    .then(b => {
      browser = b
      tabs.clear()
      b.on('disconnected', () => {
        browser = null
        tabs.clear()
      })
      b.on('targetcreated', async t => {
        try {
          if (t.type() === 'page') idOf(await t.page())
        } catch {}
      })
      return b
    })
    .finally(() => (connecting = null))
  return connecting
}

async function listTabs() {
  const b = await getBrowser()
  const pages = await b.pages()
  for (const [id, p] of tabs) if (!pages.includes(p)) tabs.delete(id)
  return pages.map(p => ({ id: idOf(p), page: p }))
}

async function tab(id) {
  await getBrowser()
  let page = tabs.get(id)
  if (!page) {
    await listTabs()
    page = tabs.get(id)
  }
  if (!page || page.isClosed()) throw new Error(`No tab ${id}. Call tabs_list for the current ids.`)
  return page
}

const text = t => ({ content: [{ type: 'text', text: t }] })

const server = new McpServer({ name: 'claude-in-firefox', version: '0.1.0' })

function tool(name, description, shape, run) {
  server.registerTool(name, { description, inputSchema: shape }, async args => {
    try {
      return await run(args)
    } catch (e) {
      return { content: [{ type: 'text', text: friendly(e) }], isError: true }
    }
  })
}

const tabArg = z.number().int().describe('Tab id from tabs_list or tab_open')
const target = {
  ref: z.string().optional().describe('Element ref from read_page, e.g. "12"'),
  selector: z.string().optional().describe('CSS selector'),
}

async function element(page, { ref, selector }) {
  if (ref) {
    const h = await page.evaluateHandle(r => window.__claudeInFirefoxRefs?.get(r)?.deref() ?? null, ref)
    const el = h.asElement()
    if (!el) throw new Error(`Ref ${ref} is gone (the page changed). Call read_page again.`)
    return el
  }
  if (selector) {
    const el = await page.$(selector)
    if (!el) throw new Error(`Nothing matches ${selector}.`)
    return el
  }
  return null
}

// Firefox cannot report or answer a dialog that opens within
// dom.successive_dialog_time_limit seconds of the last one (it carries a
// "stop this page" checkbox), and the action waits on it for good.
async function act(run, ms = 15000, slow = `Firefox did not finish within ${ms / 1000} s.`) {
  let timer
  const stuck = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${slow} A cause can be a dialog remote control cannot see: a second one within 3 seconds of the last. Ask the user to answer it in the tab; setting dom.successive_dialog_time_limit to 0 in about:config prevents it.`,
          ),
        ),
      ms,
    )
  })
  try {
    return await Promise.race([run(), stuck])
  } finally {
    clearTimeout(timer)
  }
}

// A Firefox window behind another one is not repainted. Firefox then never
// finishes switching tabs, page.bringToFront() also waits for the desktop to
// focus the window (GNOME refuses), and requestAnimationFrame and
// IntersectionObserver stop. So nothing here waits on any of those: a tab
// behind others still loads, reads, clicks, types and screenshots.
function front(page) {
  quick(page, () => document.visibilityState === 'visible', true).then(shown => shown || page.bringToFront().catch(() => {}))
}

// An evaluate that gives up: a page mid-navigation or behind a dialog may never answer.
const quick = (page, fn, fallback, ms = 1000) =>
  Promise.race([page.evaluate(fn).catch(() => fallback), new Promise(r => setTimeout(() => r(fallback), ms))])

// Firefox does the waiting. Puppeteer's goto, reload and goBack wait through
// its own navigation tracking, which a page restored from the back/forward
// cache leaves on a navigation that never ends, so the next goto never returns.
async function load(page, url) {
  const s = instrument(page)
  const since = s.seq
  const context = page.mainFrame().browsingContext
  await act(
    () => (url === 'reload' ? context.reload({ wait: 'complete' }) : context.navigate(url, 'complete')),
    40000,
    'The page did not finish loading within 40 s; it may still be loading.',
  )
  const [href] = await live(page)
  const doc = s.network.findLast(r => r.seq > since && r.url.split('#')[0] === href.split('#')[0])
  return typeof doc?.status === 'number' ? `HTTP ${doc.status}. ` : ''
}

async function traverse(page, delta) {
  const before = await quick(page, () => ((window.__claudeInFirefoxLeaving = true), location.href), null)
  try {
    await page.mainFrame().browsingContext.traverseHistory(delta)
  } catch (e) {
    if (/no such history entry/i.test(e.message)) throw new Error(`This tab has no ${delta < 0 ? 'earlier' : 'later'} page in its history.`)
    throw e
  }
  const until = Date.now() + 15000
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 100))
    const [moved, href, ready] = await quick(page, () => [!window.__claudeInFirefoxLeaving, location.href, document.readyState], [])
    if ((moved || href !== before) && ready === 'complete') return
  }
}

// Not element.click(): it waits on an IntersectionObserver report first.
async function centre(el) {
  const p = await el.evaluate(e => {
    const seen = r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    let rects = [...e.getClientRects()]
    if (!rects.some(seen)) {
      e.scrollIntoView({ block: 'center', inline: 'center' })
      rects = [...e.getClientRects()]
    }
    const r = rects.find(seen)
    if (!r) return null
    return {
      x: (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2,
      y: (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2,
    }
  })
  if (!p) throw new Error('That element takes no space on the page, so it cannot be clicked. It may be hidden; call read_page again.')
  return p
}

async function settle(page) {
  try {
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 })
  } catch {}
}

// page.url() goes stale when Firefox restores a page from its back/forward cache.
const live = async page => (await quick(page, () => [location.href, document.title], null, 2000)) ?? [page.url(), '']

const where = async page => {
  const [url, title] = await live(page)
  return `Now at ${url} — "${title}"`
}

tool('tabs_list', 'List the open Firefox tabs with their ids. Tabs Claude opened are marked.', {}, async () => {
  const all = await listTabs()
  if (!all.length) return text('No tabs open.')
  const lines = await Promise.all(
    all.map(async ({ id, page }) => {
      const [url, title] = await live(page)
      return `[${id}] ${pageState.get(page)?.mine ? '(mine) ' : ''}${title} — ${url}`
    }),
  )
  return text(lines.join('\n'))
})

tool('tab_open', 'Open a new tab, optionally at a URL. Work in a tab you opened unless the user names one of theirs.', { url: z.string().optional() }, async ({ url }) => {
  const b = await getBrowser()
  // A foreground tab waits for the window to repaint; see front().
  const page = await b.newPage({ background: true })
  const id = idOf(page)
  pageState.get(page).mine = true
  front(page)
  const status = url ? await load(page, url) : ''
  return text(`Opened tab ${id}. ${status}${await where(page)}`)
})

tool('tab_close', 'Close a tab.', { tab: tabArg }, async ({ tab: id }) => {
  const page = await tab(id)
  await page.close()
  tabs.delete(id)
  return text(`Closed tab ${id}.`)
})

tool('tab_focus', 'Show a tab in front of the others in its window, for the user to see. The other tools work on a tab whether it is in front or not.', { tab: tabArg }, async ({ tab: id }) => {
  const page = await tab(id)
  front(page)
  return text(`Brought tab ${id} forward. If Firefox's window is behind another one, the switch shows when the user looks at it. ${await where(page)}`)
})

tool(
  'navigate',
  'Go to a URL in a tab, or "back", "forward" or "reload". Waits for the page to load.',
  { tab: tabArg, url: z.string() },
  async ({ tab: id, url }) => {
    const page = await tab(id)
    if (url === 'back' || url === 'forward') {
      await act(() => traverse(page, url === 'back' ? -1 : 1), 20000)
      return text(await where(page))
    }
    return text(`${await load(page, url)}${await where(page)}`)
  },
)

const READ = (maxItems, onlyInView) => {
  const refs = (window.__claudeInFirefoxRefs ??= new Map())
  const seen = (window.__claudeInFirefoxSeen ??= new WeakMap())
  window.__claudeInFirefoxNext ??= 1
  const SEL =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])'
  const clean = s => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const nameOf = el =>
    clean(
      el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') ?? '')
          .split(' ')
          .map(id => document.getElementById(id)?.innerText ?? '')
          .join(' ') ||
        [...(el.labels ?? [])].map(l => l.innerText).join(' ') ||
        (el.tagName === 'INPUT' ? '' : el.innerText) ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.querySelector?.('img[alt]')?.getAttribute('alt') ||
        (['submit', 'button', 'reset'].includes(el.type) ? el.value : ''),
    )
  const roleOf = el => {
    const r = el.getAttribute('role')
    if (r) return r
    const t = el.tagName.toLowerCase()
    if (t === 'a') return 'link'
    if (t === 'select') return 'select'
    if (t === 'textarea') return 'textbox'
    if (t === 'input') return ['checkbox', 'radio', 'submit', 'button', 'file', 'range', 'reset'].includes(el.type) ? el.type : `textbox(${el.type || 'text'})`
    if (el.isContentEditable) return 'textbox'
    return t
  }
  const found = []
  const walk = root => {
    for (const el of root.querySelectorAll(SEL)) found.push(el)
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot)
  }
  walk(document)
  const items = []
  for (const el of found) {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
    if (onlyInView && !inView) continue
    let ref = seen.get(el)
    if (!ref) {
      ref = String(window.__claudeInFirefoxNext++)
      seen.set(el, ref)
      refs.set(ref, new WeakRef(el))
    }
    let line = `[${ref}] ${roleOf(el)} "${nameOf(el)}"`
    if (el.tagName === 'SELECT') line += ` = "${clean(el.selectedOptions?.[0]?.text)}"`
    else if (el.type === 'password') line += el.value ? ' (filled)' : ''
    else if ('value' in el && el.tagName !== 'BUTTON' && el.value && !['checkbox', 'radio', 'submit', 'button'].includes(el.type)) line += ` value="${clean(el.value)}"`
    if (el.checked) line += ' checked'
    if (el.disabled) line += ' disabled'
    if (el.tagName === 'A') line += ` → ${el.getAttribute('href')?.slice(0, 100)}`
    if (!inView) line += ' (off-screen)'
    items.push(line)
    if (items.length >= maxItems) break
  }
  const height = document.documentElement.scrollHeight
  return {
    head: `URL: ${location.href}\nTitle: ${document.title}\nScrolled ${Math.round(scrollY)} of ${height}px; viewport ${innerWidth}×${innerHeight}`,
    items,
    more: items.length >= maxItems,
  }
}

tool(
  'read_page',
  'List the interactive elements of a tab (links, buttons, fields) with refs to pass to click, type and select_option. Covers the main frame and open shadow roots, not iframes.',
  {
    tab: tabArg,
    only_in_view: z.boolean().optional().describe('Only elements inside the viewport'),
    max_items: z.number().int().optional().describe('Default 250'),
  },
  async ({ tab: id, only_in_view = false, max_items = 250 }) => {
    const page = await tab(id)
    const r = await page.evaluate(READ, max_items, only_in_view)
    return text(`${r.head}\n\n${r.items.join('\n') || '(no interactive elements)'}${r.more ? `\n… stopped at ${max_items}` : ''}`)
  },
)

tool(
  'get_text',
  'The visible text of a tab, or of the element a selector names.',
  { tab: tabArg, selector: z.string().optional(), max_chars: z.number().int().optional().describe('Default 15000') },
  async ({ tab: id, selector, max_chars = 15000 }) => {
    const page = await tab(id)
    const t = await page.evaluate(sel => {
      const el = sel ? document.querySelector(sel) : document.body
      return el ? el.innerText : null
    }, selector ?? null)
    if (t === null) throw new Error(`Nothing matches ${selector}.`)
    const tidy = t.replace(/\n{3,}/g, '\n\n').trim()
    return text(tidy.length > max_chars ? `${tidy.slice(0, max_chars)}\n… cut at ${max_chars} of ${tidy.length} characters` : tidy)
  },
)

tool(
  'screenshot',
  'A PNG of what the tab shows, whether or not it is in front. Coordinates in it are CSS pixels for click x/y.',
  { tab: tabArg, full_page: z.boolean().optional() },
  async ({ tab: id, full_page = false }) => {
    const page = await tab(id)
    front(page)
    const data = await page.screenshot({ type: 'png', fullPage: full_page, encoding: 'base64' })
    return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: await where(page) }] }
  },
)

tool(
  'click',
  'Click an element (ref or selector) or a point (x, y in CSS pixels). A confirm or prompt dialog the click opens is dismissed unless accept_dialog is true; alerts are accepted.',
  {
    tab: tabArg,
    ...target,
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    double: z.boolean().optional(),
    accept_dialog: z.boolean().optional(),
  },
  async ({ tab: id, ref, selector, x, y, button = 'left', double = false, accept_dialog = false }) => {
    const page = await tab(id)
    front(page)
    const s = instrument(page)
    const opts = { button, count: double ? 2 : 1 }
    if (accept_dialog) s.acceptDialogs++
    try {
      const el = await element(page, { ref, selector })
      if (!el && (x === undefined || y === undefined)) throw new Error('Give a ref, a selector, or x and y.')
      await act(async () => {
        const p = el ? await centre(el) : { x, y }
        await page.mouse.click(p.x, p.y, opts)
      })
      await settle(page)
    } finally {
      if (accept_dialog) setTimeout(() => s.acceptDialogs--, 1000)
    }
    return text(`Clicked. ${await where(page)}`)
  },
)

tool(
  'type',
  'Type text, into an element (ref or selector) or wherever focus is. clear empties the field first; submit presses Enter after.',
  { tab: tabArg, text: z.string(), ...target, clear: z.boolean().optional(), submit: z.boolean().optional() },
  async ({ tab: id, text: t, ref, selector, clear = false, submit = false }) => {
    const page = await tab(id)
    front(page)
    const el = await element(page, { ref, selector })
    await act(async () => {
      if (el) {
        const p = await centre(el)
        await page.mouse.click(p.x, p.y)
        // The click leaves the caret where it landed; typing adds to the end.
        await el.evaluate(e => {
          try {
            e.setSelectionRange?.(e.value.length, e.value.length)
          } catch {}
        })
      }
      if (clear) {
        await page.keyboard.down('Control')
        await page.keyboard.press('a')
        await page.keyboard.up('Control')
        await page.keyboard.press('Backspace')
      }
      await page.keyboard.type(t)
      if (submit) await page.keyboard.press('Enter')
    }, 30000)
    if (submit) await settle(page)
    return text(`Typed ${t.length} characters${submit ? ' and pressed Enter' : ''}. ${await where(page)}`)
  },
)

tool(
  'press_key',
  'Press a key or combination: "Enter", "Escape", "Tab", "ArrowDown", "Control+a", "Shift+Tab". Several separated by spaces run in turn.',
  { tab: tabArg, keys: z.string() },
  async ({ tab: id, keys }) => {
    const page = await tab(id)
    front(page)
    await act(async () => {
      for (const combo of keys.split(/\s+/).filter(Boolean)) {
        const parts = combo.split('+')
        const key = parts.pop()
        const mods = parts.map(m => ({ ctrl: 'Control', cmd: 'Meta', option: 'Alt' })[m.toLowerCase()] ?? m)
        for (const m of mods) await page.keyboard.down(m)
        await page.keyboard.press(mods.length && key.length === 1 ? key.toLowerCase() : key)
        for (const m of mods.reverse()) await page.keyboard.up(m)
      }
    })
    await settle(page)
    return text(`Pressed ${keys}. ${await where(page)}`)
  },
)

tool(
  'select_option',
  'Choose an option in a <select>, by its visible label or value.',
  { tab: tabArg, ...target, option: z.string() },
  async ({ tab: id, ref, selector, option }) => {
    const page = await tab(id)
    const el = await element(page, { ref, selector })
    if (!el) throw new Error('Give a ref or selector.')
    const chosen = await act(() => el.evaluate((sel, want) => {
      const o = [...sel.options].find(o => o.label.trim() === want || o.value === want)
      if (!o) return null
      sel.value = o.value
      sel.dispatchEvent(new Event('input', { bubbles: true }))
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return o.label
    }, option))
    if (chosen === null) throw new Error(`No option labelled or valued "${option}".`)
    return text(`Selected "${chosen}".`)
  },
)

tool(
  'scroll',
  'Scroll the page, or bring an element into view.',
  { tab: tabArg, ...target, direction: z.enum(['up', 'down']).optional(), pixels: z.number().optional().describe('Default 600') },
  async ({ tab: id, ref, selector, direction = 'down', pixels = 600 }) => {
    const page = await tab(id)
    const el = await element(page, { ref, selector })
    if (el) await el.scrollIntoView()
    else await page.evaluate(dy => window.scrollBy(0, dy), direction === 'up' ? -pixels : pixels)
    const y = await page.evaluate(() => `${Math.round(scrollY)} of ${document.documentElement.scrollHeight}px`)
    return text(`Scrolled to ${y}.`)
  },
)

tool(
  'wait_for',
  'Wait until text appears on the page or a selector matches a visible element.',
  { tab: tabArg, text: z.string().optional(), selector: z.string().optional(), timeout_ms: z.number().int().optional().describe('Default 10000') },
  async ({ tab: id, text: t, selector, timeout_ms = 10000 }) => {
    const page = await tab(id)
    // Polled on a timer: waitForSelector's visible check runs per animation frame.
    const opts = { timeout: timeout_ms, polling: 250 }
    if (selector) {
      await page.waitForFunction(sel => {
        const e = document.querySelector(sel)
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
      }, opts, selector)
    } else if (t) await page.waitForFunction(want => document.body?.innerText.includes(want), opts, t)
    else throw new Error('Give text or a selector.')
    return text(`Found. ${await where(page)}`)
  },
)

const AsyncFunction = (async () => {}).constructor

tool(
  'run_js',
  "Run JavaScript in the tab's page and return the result as JSON. An expression, or statements with a return.",
  { tab: tabArg, code: z.string() },
  async ({ tab: id, code }) => {
    const page = await tab(id)
    let wrapped = `(async () => (${code}))()`
    try {
      new AsyncFunction(`return (${code})`)
    } catch {
      wrapped = `(async () => { ${code} })()`
    }
    const result = await act(() => page.evaluate(wrapped), 30000)
    const out = result === undefined ? 'undefined' : JSON.stringify(result, null, 2)
    return text(out.length > 20000 ? `${out.slice(0, 20000)}\n… cut at 20000 characters` : out)
  },
)

const filtered = (list, pattern, limit) => {
  const re = pattern ? new RegExp(pattern, 'i') : null
  return list.filter(l => !re || re.test(typeof l === 'string' ? l : `${l.method} ${l.status} ${l.url}`)).slice(-limit)
}
const logArgs = {
  tab: tabArg,
  pattern: z.string().optional().describe('Regular expression to keep only matching lines'),
  limit: z.number().int().optional().describe('Most recent N, default 100'),
  clear: z.boolean().optional().describe('Empty the buffer after reading'),
}

tool(
  'console_messages',
  "Console output, page errors and dialogs seen in a tab since Claude first touched it.",
  logArgs,
  async ({ tab: id, pattern, limit = 100, clear = false }) => {
    const s = instrument(await tab(id))
    const lines = filtered(s.console, pattern, limit)
    if (clear) s.console.length = 0
    return text(lines.join('\n') || '(nothing)')
  },
)

tool(
  'network_requests',
  'Requests a tab made since Claude first touched it: method, status, URL.',
  logArgs,
  async ({ tab: id, pattern, limit = 100, clear = false }) => {
    const s = instrument(await tab(id))
    const lines = filtered(s.network, pattern, limit).map(r => `${r.method} ${r.status} ${r.url}`)
    if (clear) s.network.length = 0
    return text(lines.join('\n') || '(nothing)')
  },
)

// Firefox keeps a remote-control session open after its socket drops, and
// refuses every new one until it restarts, so every way out ends it.
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  try {
    await Promise.race([browser?.disconnect(), new Promise(r => setTimeout(r, 2000))])
  } catch {}
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown)
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

await server.connect(new StdioServerTransport())
