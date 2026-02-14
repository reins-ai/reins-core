/** Transport security classification */
export const TRANSPORT_TYPES = ["localhost", "tailscale", "cloudflare", "direct"] as const;
export type TransportType = (typeof TRANSPORT_TYPES)[number];

/** A named daemon connection profile */
export interface DaemonProfile {
  /** Unique profile name (e.g., "local", "office-server") */
  name: string;
  /** HTTP base URL (e.g., "http://localhost:7433") */
  httpUrl: string;
  /** WebSocket URL (e.g., "ws://localhost:7433") */
  wsUrl: string;
  /** Detected or manually set transport type */
  transportType: TransportType;
  /** Whether this is the default connection profile */
  isDefault: boolean;
  /** ISO timestamp of last successful connection */
  lastConnected: string | null;
  /** ISO timestamp when profile was created */
  createdAt: string;
}

/** On-disk format for daemons.json */
export interface DaemonProfilesFile {
  version: 1;
  profiles: DaemonProfile[];
}

/** Regex for valid profile names: lowercase alphanumeric and hyphens */
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Validate and normalize a profile name (lowercase, alphanumeric + hyphens) */
export function normalizeProfileName(name: string): string {
  return name.toLowerCase().trim();
}

/** Check whether a profile name is valid (alphanumeric + hyphens, not empty) */
export function isValidProfileName(name: string): boolean {
  const normalized = normalizeProfileName(name);
  return normalized.length > 0 && PROFILE_NAME_PATTERN.test(normalized);
}
