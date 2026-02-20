/**
 * Provider key auto-detection utility.
 *
 * Detects the AI provider from an API key prefix using longest-prefix-first
 * matching. Returns null for unrecognized prefixes, allowing fallback to
 * manual provider selection.
 */

/**
 * Prefix-to-provider mapping, ordered longest-prefix-first.
 *
 * Ordering matters: `sk-ant-` and `sk-proj-` must be checked before the
 * shorter `sk-` prefix to avoid false matches.
 */
const PREFIX_RULES: ReadonlyArray<readonly [prefix: string, provider: string]> = [
  ["sk-ant-", "anthropic"],
  ["sk-proj-", "openai"],
  ["sk-", "openai"],
  ["AIza", "google"],
  ["fw-", "fireworks"],
];

/**
 * Detects the AI provider from an API key prefix.
 *
 * Matching is longest-prefix-first: `sk-ant-*` and `sk-proj-*` are checked
 * before the generic `sk-*` prefix.
 *
 * @param key - The API key to detect the provider from.
 * @returns The provider identifier (`"anthropic"`, `"openai"`, `"google"`,
 *   `"fireworks"`) or `null` if no prefix matches.
 *
 * @example
 * ```ts
 * detectProviderFromKey("sk-ant-abc123");  // "anthropic"
 * detectProviderFromKey("sk-proj-xyz");    // "openai"
 * detectProviderFromKey("sk-abc123");      // "openai"
 * detectProviderFromKey("AIzaSyAbc");      // "google"
 * detectProviderFromKey("fw-abc123");      // "fireworks"
 * detectProviderFromKey("unknown-key");    // null
 * ```
 */
export function detectProviderFromKey(key: string): string | null {
  const trimmed = key.trim();

  if (trimmed.length === 0) {
    return null;
  }

  for (const [prefix, provider] of PREFIX_RULES) {
    if (trimmed.startsWith(prefix)) {
      return provider;
    }
  }

  return null;
}
