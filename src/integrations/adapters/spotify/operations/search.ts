/**
 * Spotify search operation.
 *
 * Searches Spotify for tracks, albums, artists, and playlists.
 * Returns dual-channel IntegrationResult with compact forModel
 * (type, name, artist/creator, id) and rich forUser
 * (full results with images, URIs, popularity).
 */

import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatListResult, type IntegrationResult } from "../../../result";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const DEFAULT_SEARCH_TYPES = ["track"] as const;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

export interface SearchParams {
  query: string;
  types?: string[];
  limit?: number;
}

const VALID_SEARCH_TYPES = new Set(["track", "album", "artist", "playlist"]);

interface SpotifySearchResponse {
  tracks?: SpotifyPaginatedResult<SpotifySearchTrack>;
  albums?: SpotifyPaginatedResult<SpotifySearchAlbum>;
  artists?: SpotifyPaginatedResult<SpotifySearchArtist>;
  playlists?: SpotifyPaginatedResult<SpotifySearchPlaylist>;
}

interface SpotifyPaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

interface SpotifySearchTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  popularity: number;
  artists: Array<{ id: string; name: string }>;
  album: {
    id: string;
    name: string;
    images: Array<{ url: string; height: number; width: number }>;
  };
}

interface SpotifySearchAlbum {
  id: string;
  name: string;
  uri: string;
  total_tracks: number;
  release_date: string;
  artists: Array<{ id: string; name: string }>;
  images: Array<{ url: string; height: number; width: number }>;
}

interface SpotifySearchArtist {
  id: string;
  name: string;
  uri: string;
  popularity: number;
  genres: string[];
  images: Array<{ url: string; height: number; width: number }>;
  followers: { total: number };
}

interface SpotifySearchPlaylist {
  id: string;
  name: string;
  uri: string;
  description: string;
  owner: { display_name: string; id: string };
  tracks: { total: number };
  images: Array<{ url: string; height: number; width: number }>;
}

interface SearchResultCompact {
  type: string;
  name: string;
  creator: string;
  id: string;
}

interface SearchResultRich {
  type: string;
  name: string;
  id: string;
  uri: string;
  creator: string;
  imageUrl: string | null;
  extra: Record<string, unknown>;
}

/**
 * Map a Spotify track to compact and rich result items.
 */
function mapTrack(track: SpotifySearchTrack): { compact: SearchResultCompact; rich: SearchResultRich } {
  const artist = track.artists.map((a) => a.name).join(", ") || "Unknown Artist";
  const albumImages = track.album.images;
  const imageUrl = albumImages.length > 0 ? albumImages[0].url : null;

  return {
    compact: { type: "track", name: track.name, creator: artist, id: track.id },
    rich: {
      type: "track",
      name: track.name,
      id: track.id,
      uri: track.uri,
      creator: artist,
      imageUrl,
      extra: {
        album: track.album.name,
        durationMs: track.duration_ms,
        popularity: track.popularity,
      },
    },
  };
}

/**
 * Map a Spotify album to compact and rich result items.
 */
function mapAlbum(album: SpotifySearchAlbum): { compact: SearchResultCompact; rich: SearchResultRich } {
  const artist = album.artists.map((a) => a.name).join(", ") || "Unknown Artist";
  const imageUrl = album.images.length > 0 ? album.images[0].url : null;

  return {
    compact: { type: "album", name: album.name, creator: artist, id: album.id },
    rich: {
      type: "album",
      name: album.name,
      id: album.id,
      uri: album.uri,
      creator: artist,
      imageUrl,
      extra: {
        totalTracks: album.total_tracks,
        releaseDate: album.release_date,
      },
    },
  };
}

/**
 * Map a Spotify artist to compact and rich result items.
 */
function mapArtist(artist: SpotifySearchArtist): { compact: SearchResultCompact; rich: SearchResultRich } {
  const imageUrl = artist.images.length > 0 ? artist.images[0].url : null;

  return {
    compact: { type: "artist", name: artist.name, creator: "", id: artist.id },
    rich: {
      type: "artist",
      name: artist.name,
      id: artist.id,
      uri: artist.uri,
      creator: "",
      imageUrl,
      extra: {
        genres: artist.genres,
        popularity: artist.popularity,
        followers: artist.followers.total,
      },
    },
  };
}

/**
 * Map a Spotify playlist to compact and rich result items.
 */
function mapPlaylist(playlist: SpotifySearchPlaylist): { compact: SearchResultCompact; rich: SearchResultRich } {
  const owner = playlist.owner.display_name || playlist.owner.id;
  const imageUrl = playlist.images.length > 0 ? playlist.images[0].url : null;

  return {
    compact: { type: "playlist", name: playlist.name, creator: owner, id: playlist.id },
    rich: {
      type: "playlist",
      name: playlist.name,
      id: playlist.id,
      uri: playlist.uri,
      creator: owner,
      imageUrl,
      extra: {
        description: playlist.description,
        trackCount: playlist.tracks.total,
      },
    },
  };
}

/**
 * Collect all search results into unified compact and rich arrays.
 */
function collectResults(data: SpotifySearchResponse): {
  compactItems: SearchResultCompact[];
  richItems: SearchResultRich[];
} {
  const compactItems: SearchResultCompact[] = [];
  const richItems: SearchResultRich[] = [];

  if (data.tracks) {
    for (const track of data.tracks.items) {
      const mapped = mapTrack(track);
      compactItems.push(mapped.compact);
      richItems.push(mapped.rich);
    }
  }

  if (data.albums) {
    for (const album of data.albums.items) {
      const mapped = mapAlbum(album);
      compactItems.push(mapped.compact);
      richItems.push(mapped.rich);
    }
  }

  if (data.artists) {
    for (const artist of data.artists.items) {
      const mapped = mapArtist(artist);
      compactItems.push(mapped.compact);
      richItems.push(mapped.rich);
    }
  }

  if (data.playlists) {
    for (const playlist of data.playlists.items) {
      const mapped = mapPlaylist(playlist);
      compactItems.push(mapped.compact);
      richItems.push(mapped.rich);
    }
  }

  return { compactItems, richItems };
}

/**
 * Search Spotify for tracks, albums, artists, and playlists.
 */
export async function search(
  accessToken: string,
  params: SearchParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const query = params.query.trim();
  if (query.length === 0) {
    return err(new IntegrationError("Search query must not be empty"));
  }

  const requestedTypes = params.types && params.types.length > 0
    ? params.types
    : [...DEFAULT_SEARCH_TYPES];

  const validatedTypes = requestedTypes
    .map((t) => t.trim().toLowerCase())
    .filter((t) => VALID_SEARCH_TYPES.has(t));

  if (validatedTypes.length === 0) {
    return err(
      new IntegrationError(
        `Invalid search types. Must include at least one of: ${[...VALID_SEARCH_TYPES].join(", ")}`,
      ),
    );
  }

  const limit = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, params.limit ?? DEFAULT_SEARCH_LIMIT),
  );

  const searchParams = new URLSearchParams({
    q: query,
    type: validatedTypes.join(","),
    limit: String(limit),
  });

  const url = `${SPOTIFY_API_BASE}/search?${searchParams.toString()}`;

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

  let data: SpotifySearchResponse;
  try {
    data = (await response.json()) as SpotifySearchResponse;
  } catch {
    return err(new IntegrationError("Failed to parse Spotify search response"));
  }

  const { compactItems, richItems } = collectResults(data);

  const result = formatListResult<SearchResultRich, SearchResultCompact, SearchResultRich>({
    entityName: "search results",
    items: richItems,
    toModel: (_item, index) => compactItems[index],
    toUser: (item) => item,
    title: `Spotify Search: "${query}"`,
    emptyMessage: `No results found for "${query}".`,
    metadata: {
      query,
      types: validatedTypes,
      limit,
    },
  });

  return ok(result);
}
