/**
 * Centralized runtime defaults for reins-core.
 * All hardcoded values that should be configurable live here.
 * Downstream tasks (14.2, 14.3, 14.4) should add their constants to this file.
 */

/** Port for the Reins daemon HTTP server. Override with REINS_DAEMON_PORT env var. */
export const DAEMON_PORT = parseInt(process.env.REINS_DAEMON_PORT ?? "7433", 10);

/** Hostname the daemon binds to by default. */
export const DAEMON_HOST = "localhost";

/** Port for Chrome DevTools Protocol (CDP) debugging. Override with REINS_CDP_PORT env var. */
export const CDP_PORT = parseInt(process.env.REINS_CDP_PORT ?? "9222", 10);

/** Anthropic OAuth client ID for device-code auth flow */
export const ANTHROPIC_CLIENT_ID =
  process.env.ANTHROPIC_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
