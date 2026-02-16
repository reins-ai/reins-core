/**
 * Spotify control-playback operation.
 *
 * Controls Spotify playback with play, pause, skip, or previous commands.
 * Returns dual-channel IntegrationResult with compact forModel
 * (action, success) and rich forUser (action, message, timestamp).
 */

import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export type PlaybackAction = "play" | "pause" | "skip" | "previous";

const VALID_ACTIONS: readonly PlaybackAction[] = ["play", "pause", "skip", "previous"] as const;

interface ActionEndpoint {
  method: string;
  path: string;
}

const ACTION_ENDPOINTS: Record<PlaybackAction, ActionEndpoint> = {
  play: { method: "PUT", path: "/me/player/play" },
  pause: { method: "PUT", path: "/me/player/pause" },
  skip: { method: "POST", path: "/me/player/next" },
  previous: { method: "POST", path: "/me/player/previous" },
};

const ACTION_LABELS: Record<PlaybackAction, string> = {
  play: "Resumed playback",
  pause: "Paused playback",
  skip: "Skipped to next track",
  previous: "Went to previous track",
};

export interface ControlPlaybackParams {
  action: PlaybackAction;
}

interface ControlCompact {
  action: string;
  success: boolean;
}

interface ControlRich {
  action: string;
  message: string;
  timestamp: string;
}

/**
 * Control Spotify playback with play/pause/skip/previous.
 */
export async function controlPlayback(
  accessToken: string,
  params: ControlPlaybackParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const action = params.action;
  if (!VALID_ACTIONS.includes(action)) {
    return err(
      new IntegrationError(
        `Invalid playback action "${action}". Must be one of: ${VALID_ACTIONS.join(", ")}`,
      ),
    );
  }

  const endpoint = ACTION_ENDPOINTS[action];
  const url = `${SPOTIFY_API_BASE}${endpoint.path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: endpoint.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    return err(
      new IntegrationError(
        "Failed to connect to Spotify API",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  if (response.status === 401) {
    return err(new IntegrationError("Spotify authentication expired. Reconnect to refresh credentials."));
  }

  if (response.status === 403) {
    return err(new IntegrationError("Spotify Premium is required for playback control."));
  }

  if (response.status === 404) {
    return err(new IntegrationError("No active Spotify device found. Start playback on a device first."));
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") ?? "unknown";
    return err(new IntegrationError(`Spotify rate limited. Retry after ${retryAfter} seconds.`));
  }

  // 204 is the expected success response for control endpoints
  if (response.status !== 204 && !response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      detail = body.slice(0, 200);
    } catch {
      // ignore
    }

    return err(
      new IntegrationError(`Spotify API error (${response.status}): ${detail || response.statusText}`),
    );
  }

  const timestamp = new Date().toISOString();
  const label = ACTION_LABELS[action];

  const rawResult = {
    action,
    success: true,
    message: label,
    timestamp,
  };

  const result = formatDetailResult<typeof rawResult, ControlCompact, ControlRich>({
    entityName: "playback control",
    item: rawResult,
    toModel: (item) => ({
      action: item.action,
      success: item.success,
    }),
    toUser: (item) => ({
      action: item.action,
      message: item.message,
      timestamp: item.timestamp,
    }),
    title: label,
    message: `${label}.`,
    metadata: {
      action,
      timestamp,
    },
  });

  return ok(result);
}
