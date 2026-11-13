// quit_firefox and tab_close's last tab, through the real MCP server.
// Needs Claude's profile closed and port 9222 free: it starts Claude's
// profile headless (and quits it), plus a throwaway profile standing in for
// the user's, which it must never quit.
//   node test/quit.mjs
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const server = new URL('../server.mjs', import.meta.url).pathname
const start = new URL('../bin/firefox-remote', import.meta.url).pathname
const sleep = ms => new Promise(r => setTimeout(r, ms))
const owner = port => execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' }).match(/pid=(\d+)/)?.[1]
const freePort = () =>
  new Promise(res => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
const until = async (ok, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (ok()) return true
  return false
}

if (owner(9222)) {
  console.log('Port 9222 is in use: quit Claude\'s Firefox first.')
  process.exit(2)
}

let failed = 0
const check = (label, ok, got) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  got: ${String(got).slice(0, 300)}`}`)
}
const connect = async port => {
  const c = new Client({ name: 'claude-in-firefox-quit-test', version: '0' })
  await c.connect(new StdioClientTransport({ command: 'node', args: [server], stderr: 'inherit', env: { ...process.env, FIREFOX_REMOTE_PORT: String(port) } }))
  c.do = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 30000 })
    return { t: r.content.map(x => x.text).join(' '), err: !!r.isError }
  }
  return c
}

const srv = http.createServer((q, s) => s.end(`<title>Page ${q.url}</title>`)).listen(0, '127.0.0.1')
await new Promise(r => srv.once('listening', r))
const base = `http://127.0.0.1:${srv.address().port}`

// Someone else's profile: never quit.
const other = mkdtempSync(`${existsSync('/snap/bin/firefox') ? `${process.env.HOME}/snap/firefox/common` : tmpdir()}/claude-in-firefox-test-`)
writeFileSync(`${other}/user.js`, 'user_pref("remote.prefs.recommended", false);\n')
const otherPort = await freePort()
spawn('firefox', ['--headless', '--new-instance', '--profile', other, '--remote-debugging-port', String(otherPort)], { detached: true, stdio: 'ignore' }).unref()
try {
  check('the stand-in Firefox started', await until(() => owner(otherPort)), otherPort)
  const c = await connect(otherPort)
  let r = await c.do('tabs_list')
  const ids = [...r.t.matchAll(/^\[(\d+)\]/gm)].map(m => Number(m[1]))
  for (const id of ids.slice(1)) await c.do('tab_close', { tab: id })
  r = await c.do('tab_close', { tab: ids[0] })
  check('tab_close says it cannot close the last tab', r.err && /last tab/.test(r.t), r.t)
  r = await c.do('quit_firefox', { others_agreed: true })
  check("quit_firefox refuses a profile that is not Claude's", r.err && /not Claude's own profile/.test(r.t), r.t)
  await c.close()
  check('the stand-in Firefox is still running', !!owner(otherPort), '')
} finally {
  const pid = owner(otherPort)
  if (pid && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(other)) process.kill(Number(pid))
  await until(() => !owner(otherPort), 10000)
  rmSync(other, { recursive: true, force: true })
}

// Claude's profile: quit, but only with the user's yes for tabs Claude did not open.
const launch = () => {
  execFileSync(start, ['--claude-profile', '--headless'], { stdio: 'ignore' })
  return until(() => owner(9222))
}
check("Claude's profile started", await launch(), '')
let a = await connect(9222)
await a.do('tab_open', { url: `${base}/left-behind` })
await a.close()
let b = await connect(9222)
await b.do('tab_open', { url: `${base}/mine` })
let r = await b.do('quit_firefox')
check('quit_firefox refuses while a tab Claude did not open this session is open', r.err && /left-behind/.test(r.t) && !/\/mine/.test(r.t), r.t)
check('Firefox is still running after the refusal', !!owner(9222), '')
r = await b.do('quit_firefox', { others_agreed: true })
check('quit_firefox with the user\'s yes quits Firefox', !r.err && /has quit/.test(r.t) && !owner(9222), r.t)
await b.close()

check("Claude's profile started again", await launch(), '')
b = await connect(9222)
await b.do('tab_open', { url: `${base}/mine` })
r = await b.do('quit_firefox')
check('quit_firefox quits when only Claude\'s and blank tabs are open', !r.err && /has quit/.test(r.t) && !owner(9222), r.t)
r = await b.do('quit_firefox')
check('quit_firefox when Firefox is not running says so', !r.err && /not running/.test(r.t), r.t)
await b.close()
srv.close()

console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
