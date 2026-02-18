/**
 * System prompt fragment describing browser capabilities.
 * Included in the agent system prompt when BrowserDaemonService is active.
 */
export const BROWSER_SYSTEM_PROMPT = `You have browser control tools for web browsing and interaction.

Workflow: Always call browser_snapshot before browser_act to see current page state and get element refs.

Tools:
- browser: Manage browser sessions (navigate, new_tab, switch_tab, close_tab, status).
- browser_snapshot: Read current page as accessibility tree. Returns element refs (e0, e1...) for interactive elements.
- browser_act: Interact with elements using refs from the last snapshot. Actions:
  - Core: click, type, fill, select, scroll, hover, press_key, evaluate, screenshot
  - Waiting: wait (conditions: ref_visible, ref_present, text_present, load_state)
  - Batch: batch (execute multiple actions in sequence, stop-on-error)
  - Cookies: get_cookies, set_cookie, clear_cookies
  - Storage: get_storage, set_storage, clear_storage (storageType: local|session)
  - Humanize: add humanize: true to click/type for human-like delays and mouse movement
- browser_debug: Read buffered runtime debug info (console, errors, network, all).

Use element refs (e0, e1...) from browser_snapshot as the ref argument in browser_act. Take a fresh snapshot after navigation or page changes.`;
