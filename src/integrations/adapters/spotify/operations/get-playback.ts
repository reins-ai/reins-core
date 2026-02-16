/**
 * Spotify get-playback operation.
 *
 * Fetches the current playback state from the Spotify Web API.
 * Returns dual-channel IntegrationResult with compact forModel
 * (track, artist, isPlaying, progressMs) and rich forUser
 * (full playback state with album art, device info, progress bar).
 */

import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

interface SpotifyArtist {
  name: string;
  id: string;
  uri: string;
}

interface SpotifyAlbum {
  name: string;
  id: string;
  uri: string;
  images: Array<{ url: string; height: number; width: number }>;
}

interface SpotifyTrack {
  name: string;
  id: string;
  uri: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
}

interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number | null;
}

interface SpotifyPlaybackResponse {
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrack | null;
  device: SpotifyDevice;
  shuffle_state: boolean;
  repeat_state: string;
  currently_playing_type: string;
}

interface PlaybackCompact {
  track: string;
  artist: string;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
}

interface PlaybackRich {
  track: {
    name: string;
    id: string;
    uri: string;
    artists: Array<{ name: string; id: string }>;
    album: {
      name: string;
      id: string;
      imageUrl: string | null;
    };
    durationMs: number;
  };
  progressMs: number;
  isPlaying: boolean;
  device: {
    name: string;
    type: string;
    volumePercent: number | null;
  };
  shuffleState: boolean;
  repeatState: string;
  progressBar: string;
}

/**
 * Build a text-based progress bar for playback visualization.
 */
function buildProgressBar(progressMs: number, durationMs: number): string {
  if (durationMs <= 0) {
    return "[--:-- / --:--]";
  }

  const ratio = Math.min(1, Math.max(0, progressMs / durationMs));
  const barLength = 20;
  const filled = Math.round(ratio * barLength);
  const empty = barLength - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

  const formatTime = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  };

  return `[${bar}] ${formatTime(progressMs)} / ${formatTime(durationMs)}`;
}

/**
 * Get the current Spotify playback state.
 */
export async function getPlayback(
  accessToken: string,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const url = `${SPOTIFY_API_BASE}/me/player`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
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

  if (response.status === 204) {
    const noPlaybackResult = formatDetailResult<
      { isPlaying: false },
      PlaybackCompact,
      { isPlaying: false; message: string }
    >({
      entityName: "playback",
      item: { isPlaying: false },
      toModel: () => ({
        track: "",
        artist: "",
        isPlaying: false,
        progressMs: 0,
        durationMs: 0,
      }),
      toUser: () => ({
        isPlaying: false,
        message: "No active playback. Start playing on a Spotify device first.",
      }),
      title: "Spotify Playback",
      message: "No active playback session.",
    });

    return ok(noPlaybackResult);
  }

  if (response.status === 401) {
    return err(new IntegrationError("Spotify authentication expired. Reconnect to refresh credentials."));
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") ?? "unknown";
    return err(new IntegrationError(`Spotify rate limited. Retry after ${retryAfter} seconds.`));
  }

  if (!response.ok) {
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

  let playback: SpotifyPlaybackResponse;
  try {
    playback = (await response.json()) as SpotifyPlaybackResponse;
  } catch {
    return err(new IntegrationError("Failed to parse Spotify playback response"));
  }

  const track = playback.item;
  const progressMs = playback.progress_ms ?? 0;
  const durationMs = track?.duration_ms ?? 0;
  const artistNames = track?.artists.map((a) => a.name) ?? [];
  const primaryArtist = artistNames.join(", ") || "Unknown Artist";
  const trackName = track?.name ?? "Unknown Track";
  const albumImages = track?.album.images ?? [];
  const albumImageUrl = albumImages.length > 0 ? albumImages[0].url : null;

  const rawPlayback = {
    track,
    progressMs,
    durationMs,
    isPlaying: playback.is_playing,
    device: playback.device,
    shuffleState: playback.shuffle_state,
    repeatState: playback.repeat_state,
    primaryArtist,
    trackName,
    albumImageUrl,
  };

  const result = formatDetailResult<typeof rawPlayback, PlaybackCompact, PlaybackRich>({
    entityName: "playback",
    item: rawPlayback,
    toModel: (item) => ({
      track: item.trackName,
      artist: item.primaryArtist,
      isPlaying: item.isPlaying,
      progressMs: item.progressMs,
      durationMs: item.durationMs,
    }),
    toUser: (item) => ({
      track: {
        name: item.trackName,
        id: item.track?.id ?? "",
        uri: item.track?.uri ?? "",
        artists: item.track?.artists.map((a) => ({ name: a.name, id: a.id })) ?? [],
        album: {
          name: item.track?.album.name ?? "",
          id: item.track?.album.id ?? "",
          imageUrl: item.albumImageUrl,
        },
        durationMs: item.durationMs,
      },
      progressMs: item.progressMs,
      isPlaying: item.isPlaying,
      device: {
        name: item.device.name,
        type: item.device.type,
        volumePercent: item.device.volume_percent,
      },
      shuffleState: item.shuffleState,
      repeatState: item.repeatState,
      progressBar: buildProgressBar(item.progressMs, item.durationMs),
    }),
    title: `Now ${rawPlayback.isPlaying ? "Playing" : "Paused"}: ${trackName}`,
    message: `${trackName} by ${primaryArtist}`,
    metadata: {
      deviceName: playback.device.name,
      deviceType: playback.device.type,
      shuffleState: playback.shuffle_state,
      repeatState: playback.repeat_state,
    },
  });

  return ok(result);
}
