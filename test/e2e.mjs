// Every tool, through the real MCP server, against a Firefox started by
//   bin/firefox-remote --claude-profile
// (its dialog setting is one the checks rely on). Opens and closes its own
// tabs on a local test page and leaves the others alone. Run it with
// Firefox's window behind others too: that is how it is used.
//   pnpm test            VERBOSE=1 pnpm test   prints every call
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const server = new URL('../server.mjs', import.meta.url).pathname

const shop = `<!doctype html><title>Shop</title>
<label for="q">Search</label><input id="q" placeholder="find">
<select id="size"><option value="s">Small</option><option value="l">Large</option></select>
<button id="go" onclick="window.trusted=event.isTrusted; out.textContent='searched:'+q.value+':'+size.value; fetch('/api?q='+q.value)">Go</button>
<button id="del" onclick="out.textContent = confirm('Delete it?') ? 'deleted' : 'kept'">Delete</button>
<button id="two" onclick="out.textContent = confirm('Sure?') ? (alert('Done'), 'confirmed+alerted') : 'kept'">Confirm then alert</button>
<button id="dbl" ondblclick="out.textContent='double'">Double me</button>
<div id="late2" style="display:none">Shown later</div>
<a href="/two">Next page</a> <a href="/three" target="_blank">Pop out</a>
<p id="out">idle</p><div style="height:3000px"></div><button>Far button</button>
<script>console.log('shop loaded'); setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Late arrival'; document.body.append(p) }, 1500); setTimeout(() => late2.style.display = 'block', 2500)</script>`
const two = `<!doctype html><title>Two</title><h1>Second page</h1><script>throw new Error('boom on two')</script>`
const other = `<!doctype html><title>Other</title><body style="background:#c00"><h1>Other tab</h1></body>`
const srv = http
  .createServer((req, res) => {
    if (req.url.startsWith('/api')) {
      res.writeHead(201, { 'content-type': 'application/json' })
      return res.end('{}')
    }
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end('<title>Missing</title>nope')
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/two' ? two : req.url === '/three' ? other : shop)
  })
  .listen(0, '127.0.0.1')
await new Promise(r => srv.once('listening', r))
const base = `http://127.0.0.1:${srv.address().port}`

const connect = async () => {
  const c = new Client({ name: 'claude-in-firefox-test', version: '0' })
  await c.connect(new StdioClientTransport({ command: 'node', args: [server], stderr: 'inherit', env: process.env }))
  return c
}
const client = await connect()

let failed = 0
let slowest = { ms: 0 }
const check = (label, ok, got) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  got: ${String(got).slice(0, 300)}`}`)
}
const call = async (name, args = {}) => {
  const t0 = Date.now()
  let out
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 25000 })
    const t = r.content.map(c => (c.type === 'text' ? c.text : `<${c.type} ${c.data.length}b>`)).join(' | ')
    out = { t, err: !!r.isError, r }
  } catch (e) {
    out = { t: `THREW ${e.message}`, err: true }
  }
  out.ms = Date.now() - t0
  if (process.env.VERBOSE) console.log(`  ${name} ${JSON.stringify(args)} ${out.ms}ms${out.err ? ' ERROR' : ''}\n     → ${out.t.slice(0, 300)}`)
  if (out.ms > slowest.ms && name !== 'wait_for') slowest = { ms: out.ms, name }
  return out
}
const image = r => r.r?.content?.find(c => c.type === 'image')?.data ?? ''

const before = await call('tabs_list')
check('tabs_list', !before.err, before.t)

const o = await call('tab_open', { url: base + '/' })
const tab = Number(o.t.match(/tab (\d+)/)?.[1])
check('tab_open', !o.err && /HTTP 200.*Shop/.test(o.t), o.t)

let read = (await call('read_page', { tab })).t
const ref = name => read.match(new RegExp(`\\[(\\d+)\\][^\\n]*${name}`))?.[1]

let r = await call('type', { tab, ref: ref('Search'), text: 'chairs' })
check('type finishes quickly', !r.err && r.ms < 5000, r.t)
r = await call('run_js', { tab, code: 'q.value' })
check('type reached the field', r.t === '"chairs"', r.t)
r = await call('select_option', { tab, ref: ref('Small'), option: 'Large' })
check('select_option', !r.err, r.t)
r = await call('click', { tab, ref: ref('"Go"') })
check('click finishes quickly', !r.err && r.ms < 5000, r.t)
r = await call('get_text', { tab, selector: '#out' })
check('click ran the handler', r.t === 'searched:chairs:l', r.t)
r = await call('run_js', { tab, code: 'window.trusted' })
check('click is a trusted event', r.t === 'true', r.t)
await call('type', { tab, ref: ref('Search'), text: ' and tables' })
r = await call('run_js', { tab, code: 'q.value' })
check('type without clear adds to the end', r.t === '"chairs and tables"', r.t)
await call('click', { tab, ref: ref('Double me'), double: true })
r = await call('get_text', { tab, selector: '#out' })
check('double click', r.t === 'double', r.t)

await call('click', { tab, ref: ref('Delete') })
r = await call('get_text', { tab, selector: '#out' })
check('confirm dismissed by default', r.t === 'kept', r.t)
await call('click', { tab, ref: ref('Delete'), accept_dialog: true })
r = await call('get_text', { tab, selector: '#out' })
check('confirm accepted with accept_dialog', r.t === 'deleted', r.t)
await call('click', { tab, ref: ref('Confirm then alert'), accept_dialog: true })
r = await call('get_text', { tab, selector: '#out' })
check('confirm then alert', r.t === 'confirmed+alerted', r.t)

await call('type', { tab, ref: ref('Search'), text: 'tables', clear: true })
r = await call('run_js', { tab, code: 'q.value' })
check('type clear replaces the value', r.t === '"tables"', r.t)
await call('press_key', { tab, keys: 'Control+a Backspace' })
r = await call('run_js', { tab, code: 'q.value' })
check('press_key reaches the focused field', r.t === '""', r.t)
r = await call('run_js', { tab, code: 'const a = 2; return { sum: a + 3 }' })
check('run_js with statements', /"sum": 5/.test(r.t), r.t)

r = await call('wait_for', { tab, text: 'Late arrival' })
check('wait_for text', !r.err, r.t)
r = await call('wait_for', { tab, selector: '#late2' })
check('wait_for a selector to become visible', !r.err, r.t)
r = await call('wait_for', { tab, selector: '#nope', timeout_ms: 1500 })
check('wait_for gives up at its timeout', r.err && r.ms < 4000, r.t)
r = await call('scroll', { tab, ref: ref('Far button') })
check('scroll to an element', !r.err && !/Scrolled to 0 /.test(r.t), r.t)
r = await call('read_page', { tab, only_in_view: true })
check('read_page only_in_view', /Far button/.test(r.t) && !/Search/.test(r.t), r.t)

const o3 = await call('tab_open', { url: base + '/three' })
const tab3 = Number(o3.t.match(/tab (\d+)/)?.[1])
check('second tab_open', !o3.err, o3.t)
r = await call('screenshot', { tab })
check('screenshot of a tab behind another', !r.err && r.ms < 5000 && image(r).length > 5000, r.t)
const r3 = await call('screenshot', { tab: tab3 })
check('each tab screenshots its own content', image(r3).length > 1000 && image(r3) !== image(r), `${image(r).length} vs ${image(r3).length}`)
r = await call('tab_focus', { tab: tab3 })
check('tab_focus', !r.err && r.ms < 5000, r.t)
r = await call('click', { tab, x: 5, y: 5 })
check('click by point on a tab behind another', !r.err && r.ms < 5000, r.t)

r = await call('console_messages', { tab })
check('console_messages', /shop loaded/.test(r.t) && /dialog: confirm/.test(r.t), r.t)
r = await call('network_requests', { tab, pattern: 'api' })
check('network_requests', /GET 201 .*api\?q=chairs/.test(r.t), r.t)
read = (await call('read_page', { tab })).t
r = await call('click', { tab, ref: ref('Next page') })
check('click a link navigates', /Two/.test(r.t), r.t)
r = await call('console_messages', { tab, pattern: 'boom' })
check('page errors captured', /boom on two/.test(r.t), r.t)
r = await call('navigate', { tab, url: 'back' })
check('back to a page restored from memory', /Shop/.test(r.t) && r.ms < 3000, r.t)
r = await call('navigate', { tab, url: base + '/three' })
check('navigate right after back', /HTTP 200.*Other/.test(r.t) && r.ms < 5000, r.t)
r = await call('navigate', { tab, url: 'back' })
check('back again', /Shop/.test(r.t) && r.ms < 3000, r.t)
r = await call('navigate', { tab, url: 'forward' })
check('forward', /Other/.test(r.t) && r.ms < 3000, r.t)
r = await call('navigate', { tab, url: 'reload' })
check('reload', /HTTP 200.*Other/.test(r.t) && r.ms < 5000, r.t)
r = await call('navigate', { tab, url: base + '/missing' })
check('a 404 is reported', /HTTP 404/.test(r.t), r.t)
r = await call('navigate', { tab, url: base + '/three#part' })
check('navigate to a #fragment', !r.err && /#part/.test(r.t) && r.ms < 5000, r.t)
r = await call('navigate', { tab, url: 'forward' })
check('forward with nothing ahead says so', r.err && /no later page/.test(r.t), r.t)
r = await call('navigate', { tab, url: 'http://no-such-host.invalid/' })
check('a missing host, in plain words', r.err && /No such site/.test(r.t), r.t)
const closed = await new Promise(res => {
  const t = http.createServer().listen(0, '127.0.0.1', () => {
    const p = t.address().port
    t.close(() => res(p))
  })
})
r = await call('navigate', { tab, url: `http://127.0.0.1:${closed}/` })
check('a refused connection, in plain words', r.err && /Nothing is listening/.test(r.t), r.t)
r = await call('navigate', { tab, url: 'example.com' })
check('an address without https://, in plain words', r.err && /https:\/\//.test(r.t), r.t)
r = await call('navigate', { tab, url: 'http://127.0.0.1:1/' })
check('a port Firefox blocks, in one line', r.err && !r.t.includes('\n') && !/@(chrome|resource):/.test(r.t), r.t)
r = await call('get_text', { tab })
check('the tab still answers after failed navigations', !r.err, r.t)

await call('navigate', { tab, url: base + '/' })
await call('navigate', { tab, url: base + '/two' })
await call('navigate', { tab, url: 'back' })
r = await call('tabs_list')
check('tabs_list shows the live URL after back', r.t.split('\n').some(l => l.endsWith(`Shop — ${base}/`)), r.t)
read = (await call('read_page', { tab })).t
await call('click', { tab, ref: ref('Pop out') })
await new Promise(res => setTimeout(res, 1000))
r = await call('tabs_list')
const pop = r.t.split('\n').find(l => /Other/.test(l) && !l.includes('(mine)'))
check('a link that opens a new tab shows in tabs_list', !!pop, r.t)
if (pop) await call('tab_close', { tab: Number(pop.match(/\[(\d+)\]/)[1]) })
r = await call('click', { tab: 999, x: 1, y: 1 })
check('an unknown tab, in plain words', r.err && /No tab 999/.test(r.t), r.t)

r = await call('tab_close', { tab })
check('tab_close', !r.err && r.ms < 5000, r.t)
await call('tab_close', { tab: tab3 })
const after = await call('tabs_list')
check('only the tabs from before remain', after.t.split('\n').length === before.t.split('\n').length, after.t)
await client.close()
srv.close()

const again = await connect()
const rr = await again.callTool({ name: 'tabs_list', arguments: {} })
check('a new session connects after a clean close', !rr.isError, rr.content[0].text)
await again.close()

console.log(`\nSlowest call other than wait_for: ${slowest.name}, ${slowest.ms} ms`)
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
