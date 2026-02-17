/**
 * System prompt fragment describing browser capabilities.
 * Included in the agent system prompt when BrowserDaemonService is active.
 */
export const BROWSER_SYSTEM_PROMPT = `You have browser control tools for web browsing and interaction.

Workflow: Always call browser_snapshot before browser_act to see the current page state and get element refs.

Tools:
- browser: Navigate to URLs and manage tabs (navigate, new_tab, switch_tab, close_tab, status).
- browser_snapshot: Read the current page as an accessibility tree. Returns element refs (e0, e1, e2...) identifying interactive elements.
- browser_act: Interact with elements using refs from the last snapshot (click, type, fill, select, scroll, hover, press_key, evaluate, screenshot).

Use element refs (e0, e1, e2...) from browser_snapshot as the ref argument in browser_act. Always take a fresh snapshot after navigation or page changes before acting on elements.`;
