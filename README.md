# Claude in Firefox

Lets Claude Code drive your everyday Firefox, with your sign-ins: open tabs,
read pages, click, type, take screenshots, and read the console and network
requests. It is the Firefox counterpart of Claude in Chrome, built a different
way, because Firefox does not give extensions the debugging access Chrome does.

## How it works

Firefox has built-in remote control, WebDriver BiDi, a W3C standard for driving
a browser. `bin/firefox-remote` starts Firefox with it switched on, listening
only on your own machine (`127.0.0.1:9222`). `server.mjs` is an MCP server, a
small program that offers tools to Claude Code; it connects to that port with
Puppeteer when Claude first uses a tool. `skill/SKILL.md` tells Claude how to
use the tools with care.

## Setup, once

Needs Node 20 or later, pnpm, and Firefox on Linux.

```bash
git clone https://github.com/hiteshsaini639/claude-in-firefox.git
cd claude-in-firefox
pnpm install
claude mcp add --scope user firefox -- node "$PWD/server.mjs"
ln -s "$PWD/skill" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/claude-in-firefox"
```

The last two lines register the server and link the skill for one Claude Code
account. With several (`CLAUDE_CONFIG_DIR`), run them once for each.

## Each time: Claude's own profile (recommended)

```bash
bin/firefox-remote --claude-profile
```

This starts a second, separate Firefox beside your everyday one, with its own
profile (sign-ins, history, settings) at
`~/snap/firefox/common/claude-profile` for the snap Firefox, or
`~/.local/share/claude-in-firefox/profile` otherwise. The first time it is
empty: sign in there only to the sites you want Claude to use. It keeps those
sign-ins between runs. Quit it (Ctrl+Q in its window) when Claude is done;
your everyday Firefox is not touched.

Why this is the safer way: while remote control is on, any program on this
machine can drive that Firefox, with no password, and Claude can be misled by
text on a page. In Claude's profile, either reaches only the sites you signed
in to there, not your email or bank.

The script writes the two settings below into this profile's `user.js`, so
there is nothing to set by hand.

## Each time: your everyday profile

```bash
bin/firefox-remote
```

Your own Firefox with all its sign-ins. Firefox must be closed first: remote
control can only be switched on as it starts, and the script never closes it
for you. While it is on, the address bar is striped and shows a robot icon.
Quit Firefox and start it normally to switch it off. It needs, once:

1. In Firefox, open `about:config`, search for `remote.prefs.recommended` and
   toggle it to `false`. Without it, a remote-controlled Firefox switches off
   phishing and malware protection, tracking protection, the popup blocker
   and saved-password filling for that run. The setting changes nothing in
   normal browsing. The script refuses to start until it is set.
2. Optional: set `dom.successive_dialog_time_limit` to `0` too. Otherwise, when
   a page opens a second dialog within 3 seconds of the first (a confirm and
   then an "it's done" alert, say), Firefox gives it a "stop this page"
   checkbox that remote control cannot see or answer. Claude's action stops
   after 15 seconds and asks you to answer it. The cost: Firefox stops
   offering that checkbox in normal browsing too.

## Limits

- One controller at a time. Firefox allows one remote-control session; a
  second Claude session is told another one holds it. One Firefox at a time
  can listen on the port, too: Claude's profile or your everyday one.
- A server killed outright (not closed) leaves its session open, and Firefox
  refuses new ones until it restarts. Closing Claude Code normally is fine.
- Firefox's window can stay behind your other windows while Claude works;
  the tools work on a tab whether it is in front or not. Firefox does not
  repaint a window that is out of sight, though, so animations on its pages
  pause until you look at it.
- `read_page` does not see inside iframes; Claude uses a screenshot and
  clicks by position there.
- Console and network output is kept from the moment the server first
  touches a tab, 500 lines each.

## Tools

`tabs_list`, `tab_open`, `tab_close`, `tab_focus`, `navigate`, `read_page`,
`get_text`, `screenshot`, `click`, `type`, `press_key`, `select_option`,
`scroll`, `wait_for`, `run_js`, `console_messages`, `network_requests`.

`FIREFOX_REMOTE_PORT` changes the port, for the script and the server alike.
`FIREFOX_PROFILE` points the script at a profile folder other than your
default.

## Testing

With `bin/firefox-remote --claude-profile` running, `pnpm test` puts every
tool through the server against a local test page, in tabs of its own.
