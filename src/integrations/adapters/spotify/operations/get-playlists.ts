/**
 * Spotify get-playlists operation.
 *
 * Fetches the current user's playlists from the Spotify Web API.
 * Returns dual-channel IntegrationResult with compact forModel
 * (name, id, trackCount) and rich forUser (full playlist objects
 * with owner, images, URIs).
 */

import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatListResult, type IntegrationResult } from "../../../result";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_OFFSET = 0;

export interface GetPlaylistsParams {
  limit?: number;
  offset?: number;
}

interface SpotifyPlaylistOwner {
  display_name: string | null;
  id: string;
}

interface SpotifyPlaylistImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  uri: string;
  owner: SpotifyPlaylistOwner;
  tracks: { total: number };
  images: SpotifyPlaylistImage[];
  public: boolean | null;
  collaborative: boolean;
}

interface SpotifyPlaylistsResponse {
  items: SpotifyPlaylist[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  previous: string | null;
}

interface PlaylistCompact {
  name: string;
  id: string;
  trackCount: number;
}

interface PlaylistRich {
  id: string;
  name: string;
  description: string;
  uri: string;
  owner: string;
  trackCount: number;
  imageUrl: string | null;
  isPublic: boolean | null;
  isCollaborative: boolean;
}

/**
 * Get the current user's Spotify playlists.
 */
export async function getPlaylists(
  accessToken: string,
  params?: GetPlaylistsParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, params?.limit ?? DEFAULT_LIMIT),
  );
  const offset = Math.max(0, params?.offset ?? DEFAULT_OFFSET);

  const searchParams = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  const url = `${SPOTIFY_API_BASE}/me/playlists?${searchParams.toString()}`;

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

  let data: SpotifyPlaylistsResponse;
  try {
    data = (await response.json()) as SpotifyPlaylistsResponse;
  } catch {
    return err(new IntegrationError("Failed to parse Spotify playlists response"));
  }

  const playlists = data.items;

  const result = formatListResult<SpotifyPlaylist, PlaylistCompact, PlaylistRich>({
    entityName: "playlists",
    items: playlists,
    toModel: (item) => ({
      name: item.name,
      id: item.id,
      trackCount: item.tracks.total,
    }),
    toUser: (item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? "",
      uri: item.uri,
      owner: item.owner.display_name ?? item.owner.id,
      trackCount: item.tracks.total,
      imageUrl: item.images.length > 0 ? item.images[0].url : null,
      isPublic: item.public,
      isCollaborative: item.collaborative,
    }),
    title: "Your Spotify Playlists",
    emptyMessage: "No playlists found.",
    metadata: {
      total: data.total,
      limit,
      offset,
      hasMore: data.next !== null,
    },
  });

  return ok(result);
}
