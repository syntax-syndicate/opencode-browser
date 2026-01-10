# OpenCode Browser Agent Best Practices

This tutorial is a practical, composable playbook for agents using the OpenCode Browser plugin. The design goal is **small, stable primitives** that combine into reliable workflows.

## Core Principles

1. **Compose simple primitives** rather than relying on complex, one-off logic.
2. **Prefer visible UI semantics** over brittle DOM attributes.
3. **Always confirm state changes** with a read after action.
4. **Minimize assumptions** and ask for clarification when needed.
5. **Keep actions reversible** unless the user explicitly approves destructive changes.

## Core Tool Set

Use these as your primary building blocks:

- `browser_status` — inspect connectivity and tab claims.
- `browser_get_tabs` — list tabs and find the right `tabId`.
- `browser_navigate` — move to a URL.
- `browser_query` — read data, wait for UI, or extract page text.
- `browser_click` — click elements by selector and index.
- `browser_type` — fill inputs by selector and index.
- `browser_scroll` — bring elements into view or move the viewport.
- `browser_wait` — short delays when timing is uncertain.

Diagnostics only:

- `browser_snapshot` — page structure + visible text.
- `browser_screenshot` — visual confirmation.

## `browser_query` Modes

Use the mode that best matches the intent:

- `mode=text` — read visible text from a matched element.
- `mode=value` — read input values.
- `mode=list` — return multiple matches with text/metadata.
- `mode=exists` — check presence and count.
- `mode=page_text` — extract visible text from the page (plus input values and pseudo-content).

`browser_query` supports waiting by passing `timeoutMs` and `pollMs`.

## Recommended Workflow (Template)

1. **Get context**
   - `browser_status`
   - `browser_get_tabs`
2. **Navigate if needed**
   - `browser_navigate`
3. **Wait for UI**
   - `browser_query` with `timeoutMs` and a tight selector.
4. **Discover targets**
   - `browser_query` with `mode=list` on candidate elements.
5. **Act**
   - `browser_click` or `browser_type` using the chosen selector + index.
6. **Confirm**
   - `browser_query` or `browser_snapshot` to verify state.

## Selector Strategy

### Prefer these first
- `button`, `input`, `textarea`, `select`, `a`
- `*[role="button"]`, `*[role="menuitem"]`
- Stable IDs or `aria-label` values

### Avoid brittle selectors
- Long or deeply nested selectors
- Classnames that look auto-generated
- Exact URLs when the UI may rewrite paths

### If a selector fails
1. Use `browser_query mode=page_text` to confirm the content exists.
2. Use `browser_query mode=list` on generic selectors (e.g., `button`, `a`, `*[role="button"]`).
3. Pick by **index** after validating the list output.
4. Confirm with `browser_snapshot` if still unsure.

## Composable Patterns

### Wait + Read
```
⚙ browser_query [selector=button[aria-label*="Verify"], mode=exists, timeoutMs=10000]
```

### List + Pick + Click
```
⚙ browser_query [selector=button, mode=list, limit=200]
⚙ browser_click [selector=button, index=12]
```

### Page Text + Refine
```
⚙ browser_query [mode=page_text, pattern="Verify domain", flags="i"]
⚙ browser_query [selector=*[role="button"], mode=list, limit=200]
```

### Type + Confirm
```
⚙ browser_type [selector=input[name="domain"], text="example.com", clear=true]
⚙ browser_query [selector=input[name="domain"], mode=value]
```

## Dealing With Dynamic UIs

- **Always allow time to render** using `timeoutMs` before acting.
- Prefer `browser_query` with a **targeted selector** rather than fixed sleeps.
- If DOM shifts, re-run `browser_query mode=list` to reselect by index.

## Confirmations and Safety

- After any action that changes data, **re-read the UI** to confirm.
- If the action is destructive (delete, remove, revoke), **ask for confirmation** before clicking.

## Tab Ownership Behavior

- Tabs are **auto-claimed** by the first session that touches them.
- If you see ownership errors, use `browser_status` and ask the user to close the other session.

## Troubleshooting Checklist

1. **Element not found** → `browser_query mode=page_text` to confirm content.
2. **Wrong element clicked** → re-run `mode=list` and pick a different index.
3. **UI not ready** → use `timeoutMs` on `browser_query`.
4. **Still blocked** → use `browser_snapshot` or `browser_screenshot` for visibility.

## Example: Find and Click a “Verify domain” Button

```
⚙ browser_query [mode=page_text, pattern="Verify domain", flags="i"]
⚙ browser_query [selector=button, mode=list, limit=200]
⚙ browser_query [selector=*[role="button"], mode=list, limit=200]
⚙ browser_click [selector=*[role="button"], index=7]
⚙ browser_query [mode=page_text, pattern="Verification", flags="i"]
```

## Common Pitfalls to Avoid

- Assuming `href` or `data-*` attributes exist in custom UI components.
- Clicking without verifying the element list.
- Relying on JavaScript evaluation or DOM mutation hooks.

---

This tutorial is meant to keep agent behavior predictable, composable, and safe. Start narrow, verify often, and use lists + index to act reliably in modern web UIs.
