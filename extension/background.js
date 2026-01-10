const NATIVE_HOST_NAME = "com.opencode.browser_automation"
const KEEPALIVE_ALARM = "keepalive"

let port = null
let isConnected = false
let connectionAttempts = 0

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) connect()
  }
})

function connect() {
  if (port) {
    try {
      port.disconnect()
    } catch {}
    port = null
  }

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)

    port.onMessage.addListener((message) => {
      handleMessage(message).catch((e) => {
        console.error("[OpenCode] Message handler error:", e)
      })
    })

    port.onDisconnect.addListener(() => {
      isConnected = false
      port = null
      updateBadge(false)

      const err = chrome.runtime.lastError
      if (err?.message) {
        connectionAttempts++
        if (connectionAttempts === 1) {
          console.log("[OpenCode] Native host not available. Run: npx @different-ai/opencode-browser install")
        } else if (connectionAttempts % 20 === 0) {
          console.log("[OpenCode] Still waiting for native host...")
        }
      }
    })

    isConnected = true
    connectionAttempts = 0
    updateBadge(true)
  } catch (e) {
    isConnected = false
    updateBadge(false)
    console.error("[OpenCode] connectNative failed:", e)
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" })
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" })
}

function send(message) {
  if (!port) return false
  try {
    port.postMessage(message)
    return true
  } catch {
    return false
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return

  if (message.type === "tool_request") {
    await handleToolRequest(message)
  } else if (message.type === "ping") {
    send({ type: "pong" })
  }
}

async function handleToolRequest(request) {
  const { id, tool, args } = request

  try {
    const result = await executeTool(tool, args || {})
    send({ type: "tool_response", id, result })
  } catch (error) {
    send({
      type: "tool_response",
      id,
      error: { content: error?.message || String(error) },
    })
  }
}

async function executeTool(toolName, args) {
  const tools = {
    get_active_tab: toolGetActiveTab,
    get_tabs: toolGetTabs,
    open_tab: toolOpenTab,
    navigate: toolNavigate,
    click: toolClick,
    type: toolType,
    select: toolSelect,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    query: toolQuery,
    scroll: toolScroll,
    wait: toolWait,
  }

  const fn = tools[toolName]
  if (!fn) throw new Error(`Unknown tool: ${toolName}`)
  return await fn(args)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error("No active tab found")
  return tab
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab()
}

async function runInPage(tabId, command, args) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageOps,
    args: [command, args || {}],
    world: "ISOLATED",
  })
  return result[0]?.result
}

async function pageOps(command, args) {
  const options = args || {}
  const MAX_DEPTH = 6

  function safeString(value) {
    return typeof value === "string" ? value : ""
  }

  function normalizeSelectorList(selector) {
    if (Array.isArray(selector)) {
      return selector.map((s) => safeString(s).trim()).filter(Boolean)
    }
    if (typeof selector !== "string") return []
    const parts = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return parts.length ? parts : [selector.trim()].filter(Boolean)
  }

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
    return true
  }

  function deepQuerySelectorAll(sel, rootDoc) {
    const out = []
    const seen = new Set()

    function addAll(nodeList) {
      for (const el of nodeList) {
        if (!el || seen.has(el)) continue
        seen.add(el)
        out.push(el)
      }
    }

    function walkRoot(root, depth) {
      if (!root || depth > MAX_DEPTH) return
      try {
        addAll(root.querySelectorAll(sel))
      } catch {
        return
      }

      const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
      for (const el of tree) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot, depth + 1)
        }
      }

      const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument
          if (doc) walkRoot(doc, depth + 1)
        } catch {}
      }
    }

    walkRoot(rootDoc || document, 0)
    return out
  }

  function resolveMatches(selectors, index) {
    for (const sel of selectors) {
      const s = safeString(sel)
      if (!s) continue
      const matches = deepQuerySelectorAll(s, document)
      if (!matches.length) continue
      const visible = matches.filter(isVisible)
      const chosen = visible[index] || matches[index]
      return { selectorUsed: s, matches, chosen }
    }
    return { selectorUsed: selectors[0] || "", matches: [], chosen: null }
  }

  function clickElement(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }

    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
      el.dispatchEvent(new MouseEvent("mousedown", opts))
      el.dispatchEvent(new MouseEvent("mouseup", opts))
      el.dispatchEvent(new MouseEvent("click", opts))
    } catch {}

    try {
      el.click()
    } catch {}
  }

  function setNativeValue(el, value) {
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const proto = tag === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      if (setter) setter.call(el, value)
      else el.value = value
      return true
    }
    return false
  }

  function setSelectValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  function getInputValues() {
    const out = []
    const nodes = document.querySelectorAll("input, textarea")
    nodes.forEach((el) => {
      try {
        const name = el.getAttribute("aria-label") || el.getAttribute("name") || el.id || el.className || el.tagName
        const value = el.value
        if (value != null && String(value).trim()) out.push(`${name}: ${value}`)
      } catch {}
    })
    return out.join("\n")
  }

  function getPseudoText() {
    const out = []
    const elements = Array.from(document.querySelectorAll("*"))
    for (let i = 0; i < elements.length && out.length < 2000; i++) {
      const el = elements[i]
      try {
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") continue
        const before = window.getComputedStyle(el, "::before").content
        const after = window.getComputedStyle(el, "::after").content
        const pushContent = (content) => {
          if (!content) return
          const c = String(content)
          if (!c || c === "none" || c === "normal") return
          const unquoted = c.replace(/^"|"$/g, "").replace(/^'|'$/g, "")
          if (unquoted && unquoted !== "none" && unquoted !== "normal") out.push(unquoted)
        }
        pushContent(before)
        pushContent(after)
      } catch {}
    }
    return out.join("\n")
  }

  function buildMatches(text, pattern, flags) {
    if (!pattern) return []
    try {
      const re = new RegExp(pattern, flags || "")
      const found = []
      let m
      while ((m = re.exec(text)) && found.length < 50) {
        found.push(m[0])
        if (!re.global) break
      }
      return found
    } catch {
      return []
    }
  }

  function getPageText(limit, pattern, flags) {
    const parts = []
    const bodyText = safeString(document.body?.innerText || "")
    if (bodyText.trim()) parts.push(bodyText)
    const inputValues = getInputValues()
    if (inputValues) parts.push(inputValues)
    const pseudo = getPseudoText()
    if (pseudo) parts.push(pseudo)
    const text = parts.filter(Boolean).join("\n\n").slice(0, Math.max(0, limit))
    return {
      url: location.href,
      title: document.title,
      text,
      matches: buildMatches(text, pattern, flags),
    }
  }

  const mode = typeof options.mode === "string" && options.mode ? options.mode : "text"
  const selectors = normalizeSelectorList(options.selector)
  const index = Number.isFinite(options.index) ? options.index : 0
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 200
  const limit = Number.isFinite(options.limit) ? options.limit : mode === "page_text" ? 20000 : 50
  const pattern = typeof options.pattern === "string" ? options.pattern : null
  const flags = typeof options.flags === "string" ? options.flags : "i"

  if (command === "click") {
    const match = resolveMatches(selectors, index)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    clickElement(match.chosen)
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "type") {
    const text = options.text
    const shouldClear = !!options.clear
    const match = resolveMatches(selectors, index)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    const tag = match.chosen.tagName
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA"

    if (isTextInput) {
      if (shouldClear) setNativeValue(match.chosen, "")
      setNativeValue(match.chosen, (match.chosen.value || "") + text)
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      match.chosen.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    if (match.chosen.isContentEditable) {
      if (shouldClear) match.chosen.textContent = ""
      try {
        document.execCommand("insertText", false, text)
      } catch {
        match.chosen.textContent = (match.chosen.textContent || "") + text
      }
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    return { ok: false, error: `Element is not typable: ${match.selectorUsed} (${tag.toLowerCase()})` }
  }

  if (command === "select") {
    const value = typeof options.value === "string" ? options.value : null
    const label = typeof options.label === "string" ? options.label : null
    const optionIndex = Number.isFinite(options.optionIndex) ? options.optionIndex : null
    const match = resolveMatches(selectors, index)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "SELECT") {
      return { ok: false, error: `Element is not a select: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    if (value === null && label === null && optionIndex === null) {
      return { ok: false, error: "value, label, or optionIndex is required" }
    }

    const selectEl = match.chosen
    const optionList = Array.from(selectEl.options || [])
    let option = null

    if (value !== null) {
      option = optionList.find((opt) => opt.value === value)
    }

    if (!option && label !== null) {
      const target = label.trim()
      option = optionList.find((opt) => (opt.label || opt.textContent || "").trim() === target)
    }

    if (!option && optionIndex !== null) {
      option = optionList[optionIndex]
    }

    if (!option) {
      return { ok: false, error: "Option not found" }
    }

    try {
      selectEl.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      selectEl.focus()
    } catch {}

    setSelectValue(selectEl, option.value)
    option.selected = true
    selectEl.dispatchEvent(new Event("input", { bubbles: true }))
    selectEl.dispatchEvent(new Event("change", { bubbles: true }))

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: selectEl.value,
      label: (option.label || option.textContent || "").trim(),
    }
  }

  if (command === "scroll") {
    const scrollX = Number.isFinite(options.x) ? options.x : 0
    const scrollY = Number.isFinite(options.y) ? options.y : 0
    if (selectors.length) {
      const match = resolveMatches(selectors, index)
      if (!match.chosen) {
        return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
      }
      try {
        match.chosen.scrollIntoView({ behavior: "smooth", block: "center" })
      } catch {}
      return { ok: true, selectorUsed: match.selectorUsed }
    }
    window.scrollBy(scrollX, scrollY)
    return { ok: true }
  }

  if (command === "query") {
    if (mode === "page_text") {
      if (selectors.length && timeoutMs > 0) {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          const match = resolveMatches(selectors, index)
          if (match.matches.length) break
          await new Promise((r) => setTimeout(r, pollMs))
        }
      }
      return { ok: true, value: getPageText(limit, pattern, flags) }
    }

    if (!selectors.length) {
      return { ok: false, error: "Selector is required" }
    }

    let match = resolveMatches(selectors, index)
    if (timeoutMs > 0) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        match = resolveMatches(selectors, index)
        if (mode === "exists" && match.matches.length) break
        if (mode !== "exists" && match.chosen) break
        await new Promise((r) => setTimeout(r, pollMs))
      }
    }

    if (mode === "exists") {
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { exists: match.matches.length > 0, count: match.matches.length },
      }
    }

    if (!match.chosen) {
      return { ok: false, error: `No matches for selectors: ${selectors.join(", ")}` }
    }

    if (mode === "text") {
      const text = (match.chosen.innerText || match.chosen.textContent || "").trim()
      return { ok: true, selectorUsed: match.selectorUsed, value: text }
    }

    if (mode === "value") {
      const value = match.chosen.value
      return { ok: true, selectorUsed: match.selectorUsed, value: typeof value === "string" ? value : String(value ?? "") }
    }

    if (mode === "attribute") {
      const value = options.attribute ? match.chosen.getAttribute(options.attribute) : null
      return { ok: true, selectorUsed: match.selectorUsed, value }
    }

    if (mode === "property") {
      if (!options.property) return { ok: false, error: "property is required" }
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen[options.property] }
    }

    if (mode === "html") {
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen.outerHTML }
    }

    if (mode === "list") {
      const maxItems = Math.min(Math.max(1, limit), 200)
      const items = match.matches.slice(0, maxItems).map((el) => ({
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        tag: (el.tagName || "").toLowerCase(),
        ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
      }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { items, count: match.matches.length },
      }
    }

    return { ok: false, error: `Unknown mode: ${mode}` }
  }

  return { ok: false, error: `Unknown command: ${String(command)}` }
}

async function toolGetActiveTab() {
  const tab = await getActiveTab()
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, title: tab.title } }
}

async function toolOpenTab({ url, active = true }) {
  const createOptions = {}
  if (typeof url === "string" && url.trim()) createOptions.url = url.trim()
  if (typeof active === "boolean") createOptions.active = active

  const tab = await chrome.tabs.create(createOptions)
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, active: tab.active } }
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required")
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { url })

  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 30000)
  })

  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolClick({ selector, tabId, index = 0 }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "click", { selector, index })
  if (!result?.ok) throw new Error(result?.error || "Click failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Clicked ${used}` }
}

async function toolType({ selector, text, tabId, clear = false, index = 0 }) {
  if (!selector) throw new Error("Selector is required")
  if (text === undefined) throw new Error("Text is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "type", { selector, text, clear, index })
  if (!result?.ok) throw new Error(result?.error || "Type failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Typed "${text}" into ${used}` }
}

async function toolSelect({ selector, value, label, optionIndex, tabId, index = 0 }) {
  if (!selector) throw new Error("Selector is required")
  if (value === undefined && label === undefined && optionIndex === undefined) {
    throw new Error("value, label, or optionIndex is required")
  }
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "select", { selector, value, label, optionIndex, index })
  if (!result?.ok) throw new Error(result?.error || "Select failed")
  const used = result.selectorUsed || selector
  const valueText = result.value ? String(result.value) : ""
  const labelText = result.label ? String(result.label) : ""
  const summary = labelText && valueText && labelText !== valueText ? `${labelText} (${valueText})` : labelText || valueText
  return { tabId: tab.id, content: `Selected ${summary || "option"} in ${used}` }
}

async function toolScreenshot({ tabId }) {
  const tab = await getTabById(tabId)
  const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  return { tabId: tab.id, content: png }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function safeText(s) {
        return typeof s === "string" ? s : ""
      }

      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function pseudoText(el) {
        try {
          const before = window.getComputedStyle(el, "::before").content
          const after = window.getComputedStyle(el, "::after").content
          const norm = (v) => {
            const s = safeText(v)
            if (!s || s === "none") return ""
            return s.replace(/^"|"$/g, "")
          }
          return { before: norm(before), after: norm(after) }
        } catch {
          return { before: "", after: "" }
        }
      }

      function getName(el) {
        const aria = el.getAttribute("aria-label")
        if (aria) return aria
        const alt = el.getAttribute("alt")
        if (alt) return alt
        const title = el.getAttribute("title")
        if (title) return title
        const placeholder = el.getAttribute("placeholder")
        if (placeholder) return placeholder
        const txt = safeText(el.innerText)
        if (txt.trim()) return txt.slice(0, 200)
        const pt = pseudoText(el)
        const combo = `${pt.before} ${pt.after}`.trim()
        if (combo) return combo.slice(0, 200)
        return ""
      }

      function build(el, depth = 0, uid = 0) {
        if (!el || depth > 12) return { nodes: [], nextUid: uid }
        const nodes = []

        if (!isVisible(el)) return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          el.getAttribute("role") === "button" ||
          el.isContentEditable

        const name = getName(el)
        const pt = pseudoText(el)

        const shouldInclude = isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const node = {
            uid: `e${uid}`,
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: name,
            tag: el.tagName.toLowerCase(),
          }

          if (pt.before) node.before = pt.before
          if (pt.after) node.after = pt.after

          if (el.href) node.href = el.href

          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            node.type = el.type
            node.value = el.value
            if (el.readOnly) node.readOnly = true
            if (el.disabled) node.disabled = true
          }

          if (el.id) node.selector = `#${el.id}`
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".")
            if (cls) node.selector = `${el.tagName.toLowerCase()}.${cls}`
          }

          nodes.push(node)
          uid++
        }

        if (el.shadowRoot) {
          const r = build(el.shadowRoot.host, depth + 1, uid)
          uid = r.nextUid
        }

        for (const child of el.children) {
          const r = build(child, depth + 1, uid)
          nodes.push(...r.nodes)
          uid = r.nextUid
        }

        return { nodes, nextUid: uid }
      }

      function getAllLinks() {
        const links = []
        const seen = new Set()
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href)
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || ""
            links.push({ href, text })
          }
        })
        return links.slice(0, 200)
      }

      let pageText = ""
      try {
        pageText = safeText(document.body?.innerText || "").slice(0, 20000)
      } catch {}

      const built = build(document.body).nodes.slice(0, 800)

      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: getAllLinks(),
      }
    },
    world: "ISOLATED",
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const out = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  return { content: JSON.stringify(out, null, 2) }
}

async function toolQuery({
  tabId,
  selector,
  mode = "text",
  attribute,
  property,
  limit,
  index = 0,
  timeoutMs,
  pollMs,
  pattern,
  flags,
}) {
  if (!selector && mode !== "page_text") throw new Error("selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "query", {
    selector,
    mode,
    attribute,
    property,
    limit,
    index,
    timeoutMs,
    pollMs,
    pattern,
    flags,
  })

  if (!result?.ok) throw new Error(result?.error || "Query failed")

  if (mode === "list" || mode === "property" || mode === "exists" || mode === "page_text") {
    return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
  }

  return { tabId: tab.id, content: typeof result.value === "string" ? result.value : JSON.stringify(result.value) }
}

async function toolScroll({ x = 0, y = 0, selector, tabId }) {
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "scroll", { x, y, selector })
  if (!result?.ok) throw new Error(result?.error || "Scroll failed")
  const target = result.selectorUsed ? `to ${result.selectorUsed}` : `by (${x}, ${y})`
  return { tabId: tab.id, content: `Scrolled ${target}` }
}

async function toolWait({ ms = 1000, tabId }) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { tabId, content: `Waited ${ms}ms` }
}

chrome.runtime.onInstalled.addListener(() => connect())
chrome.runtime.onStartup.addListener(() => connect())
chrome.action.onClicked.addListener(() => {
  connect()
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "OpenCode Browser",
    message: isConnected ? "Connected" : "Reconnecting...",
  })
})

connect()
