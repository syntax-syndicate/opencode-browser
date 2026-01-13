# OpenCode Browser

Browser automation plugin for [OpenCode](https://opencode.ai).

Control your real Chromium browser (Chrome/Brave/Arc/Edge) using your existing profile (logins, cookies, bookmarks). No DevTools Protocol, no security prompts.


https://github.com/user-attachments/assets/1496b3b3-419b-436c-b412-8cda2fed83d6


## Why this architecture

This version is optimized for reliability and predictable multi-session behavior:
- **No MCP** -> just opencode plugin
- **No WebSocket port** → no port conflicts
- **Chrome Native Messaging** between extension and a local host process
- A local **broker** multiplexes multiple OpenCode plugin sessions and enforces **per-tab ownership**

## Installation

> Help me improve this! 

```bash
bunx @different-ai/opencode-browser@latest install
```


https://github.com/user-attachments/assets/d5767362-fbf3-4023-858b-90f06d9f0b25




The installer will:

1. Copy the extension to `~/.opencode-browser/extension/`
2. Walk you through loading + pinning it in `chrome://extensions`
3. Resolve a fixed extension ID (no copy/paste) and install a **Native Messaging Host manifest**
4. Update your `opencode.json` or `opencode.jsonc` to load the plugin

To override the extension ID, pass `--extension-id <id>` or set `OPENCODE_BROWSER_EXTENSION_ID`.

### Configure OpenCode

> Note: if you run the installer you'll be prompted to include this automatically. If you said "yes", you can skip this part.

Your `opencode.json` or `opencode.jsonc` should contain:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@different-ai/opencode-browser"]
}
```

### Update

```bash
bunx @different-ai/opencode-browser@latest update
```

## How it works

```
OpenCode Plugin <-> Local Broker (unix socket) <-> Native Host <-> Chrome Extension
```

- The extension connects to the native host.
- The plugin talks to the broker over a local unix socket.
- The broker forwards tool requests to the extension and enforces tab ownership.

## Agent Browser mode (alpha)

This branch adds an alternate backend powered by `agent-browser` (Playwright). It runs headless and does **not** reuse your existing Chrome profile.

### Enable locally

1. Install `agent-browser` and Chromium:

```bash
npm install -g agent-browser
agent-browser install
```

2. Set the backend mode:

```bash
export OPENCODE_BROWSER_BACKEND=agent
```

Optional overrides:
- `OPENCODE_BROWSER_AGENT_SESSION` (custom session name)
- `OPENCODE_BROWSER_AGENT_SOCKET` (unix socket path)
- `OPENCODE_BROWSER_AGENT_AUTOSTART=0` (disable auto-start)
- `OPENCODE_BROWSER_AGENT_DAEMON` (explicit daemon path)

### Tailnet/remote host

On the host (e.g., `home-server.taild435d7.ts.net`), run the TCP gateway:

```bash
OPENCODE_BROWSER_AGENT_GATEWAY_PORT=9833 node bin/agent-gateway.cjs
```

On the client:

```bash
export OPENCODE_BROWSER_BACKEND=agent
export OPENCODE_BROWSER_AGENT_HOST=home-server.taild435d7.ts.net
export OPENCODE_BROWSER_AGENT_PORT=9833
```

## Per-tab ownership

- First time a session touches a tab, the broker **auto-claims** it for that session.
- Each session tracks a default tab; tools without `tabId` route to it.
- `browser_open_tab` always works; if another session owns the active tab, the new tab opens in the background.
- Claims expire after inactivity (`OPENCODE_BROWSER_CLAIM_TTL_MS`, default 5 minutes).
- Use `browser_status` or `browser_list_claims` to inspect claims if needed.

## Available tools

Core primitives:
- `browser_status`
- `browser_get_tabs`
- `browser_list_claims`
- `browser_claim_tab`
- `browser_release_tab`
- `browser_open_tab`
- `browser_navigate`
- `browser_query` (modes: `text`, `value`, `list`, `exists`, `page_text`; optional `timeoutMs`/`pollMs`)
- `browser_click` (optional `timeoutMs`/`pollMs`)
- `browser_type` (optional `timeoutMs`/`pollMs`)
- `browser_select` (optional `timeoutMs`/`pollMs`)
- `browser_scroll` (optional `timeoutMs`/`pollMs`)
- `browser_wait`

Selector helpers (usable in `selector`):
- `label:Mailing Address: City`
- `aria:Principal Address: City`
- `placeholder:Search`, `name:email`, `role:button`, `text:Submit`
- `css:label:has(input)` to force CSS

Selector-based tools wait up to 2000ms by default; set `timeoutMs: 0` to disable.

Diagnostics:
- `browser_snapshot`
- `browser_screenshot`
- `browser_version`

## Roadmap

- [ ] Add tab management tools (`browser_set_active_tab`, `browser_close_tab`)
- [ ] Add navigation helpers (`browser_back`, `browser_forward`, `browser_reload`)
- [ ] Add keyboard input tool (`browser_key`)
- [ ] Add download support (`browser_download`, `browser_list_downloads`)
- [ ] Add upload support (`browser_set_file_input`)

## Troubleshooting

**Extension says native host not available**
- Re-run `npx @different-ai/opencode-browser install`
- If you loaded a custom extension ID, rerun with `--extension-id <id>`

**Tab ownership errors**
- Use `browser_status` or `browser_list_claims` to see current claims
- Use `browser_release_tab` or close the other OpenCode session to release ownership

## Uninstall

```bash
npx @different-ai/opencode-browser uninstall
```

Then remove the unpacked extension in `chrome://extensions` and remove the plugin from `opencode.json` or `opencode.jsonc`.
