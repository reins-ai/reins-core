import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { IntegrationError } from "../../../../src/integrations/errors";
import { validateIntegrationManifest } from "../../../../src/integrations/manifest";
import { InMemoryCredentialVault } from "../../../../src/integrations/credentials/vault";
import type { OAuthCredential } from "../../../../src/integrations/credentials/types";
import type { IntegrationResult } from "../../../../src/integrations/result";
import { getPlayback } from "../../../../src/integrations/adapters/spotify/operations/get-playback";
import {
  controlPlayback,
  type PlaybackAction,
} from "../../../../src/integrations/adapters/spotify/operations/control-playback";
import { search } from "../../../../src/integrations/adapters/spotify/operations/search";
import { getPlaylists } from "../../../../src/integrations/adapters/spotify/operations/get-playlists";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = mock(handler as typeof fetch) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, {
    status,
    headers: { ...headers },
  });
}

function textResponse(body: string, status: number, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Test OAuth credential helpers
// ---------------------------------------------------------------------------

function createTestOAuthCredential(overrides?: Partial<OAuthCredential>): OAuthCredential {
  return {
    type: "oauth",
    access_token: "test-spotify-access-token",
    refresh_token: "test-spotify-refresh-token",
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    scopes: [
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing",
      "playlist-read-private",
    ],
    token_type: "Bearer",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Realistic Spotify API response factories
// ---------------------------------------------------------------------------

function spotifyPlaybackResponse(overrides?: Partial<{
  is_playing: boolean;
  progress_ms: number | null;
  trackName: string;
  trackId: string;
  artistName: string;
  artistId: string;
  albumName: string;
  albumId: string;
  albumImageUrl: string;
  duration_ms: number;
  deviceName: string;
  deviceType: string;
  deviceId: string;
  volumePercent: number | null;
  shuffleState: boolean;
  repeatState: string;
}>) {
  return {
    is_playing: overrides?.is_playing ?? true,
    progress_ms: overrides?.progress_ms ?? 120000,
    item: {
      name: overrides?.trackName ?? "Test Song",
      id: overrides?.trackId ?? "track-001",
      uri: `spotify:track:${overrides?.trackId ?? "track-001"}`,
      duration_ms: overrides?.duration_ms ?? 240000,
      artists: [
        {
          name: overrides?.artistName ?? "Test Artist",
          id: overrides?.artistId ?? "artist-001",
          uri: `spotify:artist:${overrides?.artistId ?? "artist-001"}`,
        },
      ],
      album: {
        name: overrides?.albumName ?? "Test Album",
        id: overrides?.albumId ?? "album-001",
        uri: `spotify:album:${overrides?.albumId ?? "album-001"}`,
        images: [
          { url: overrides?.albumImageUrl ?? "https://i.scdn.co/image/test", height: 640, width: 640 },
        ],
      },
    },
    device: {
      id: overrides?.deviceId ?? "device-001",
      name: overrides?.deviceName ?? "Test Device",
      type: overrides?.deviceType ?? "Computer",
      is_active: true,
      volume_percent: overrides?.volumePercent ?? 75,
    },
    shuffle_state: overrides?.shuffleState ?? false,
    repeat_state: overrides?.repeatState ?? "off",
    currently_playing_type: "track",
  };
}

function spotifySearchResponse(overrides?: Partial<{
  tracks: Array<{
    id: string;
    name: string;
    artistName: string;
    albumName: string;
    duration_ms: number;
    popularity: number;
  }>;
  albums: Array<{
    id: string;
    name: string;
    artistName: string;
    totalTracks: number;
    releaseDate: string;
  }>;
  artists: Array<{
    id: string;
    name: string;
    genres: string[];
    popularity: number;
    followers: number;
  }>;
  playlists: Array<{
    id: string;
    name: string;
    ownerName: string;
    ownerId: string;
    description: string;
    trackCount: number;
  }>;
}>) {
  const response: Record<string, unknown> = {};

  if (overrides?.tracks) {
    response.tracks = {
      items: overrides.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        uri: `spotify:track:${t.id}`,
        duration_ms: t.duration_ms ?? 200000,
        popularity: t.popularity ?? 80,
        artists: [{ id: `artist-${t.id}`, name: t.artistName }],
        album: {
          id: `album-${t.id}`,
          name: t.albumName ?? "Album",
          images: [{ url: "https://i.scdn.co/image/track", height: 300, width: 300 }],
        },
      })),
      total: overrides.tracks.length,
      limit: 20,
      offset: 0,
    };
  }

  if (overrides?.albums) {
    response.albums = {
      items: overrides.albums.map((a) => ({
        id: a.id,
        name: a.name,
        uri: `spotify:album:${a.id}`,
        total_tracks: a.totalTracks ?? 12,
        release_date: a.releaseDate ?? "2025-01-01",
        artists: [{ id: `artist-${a.id}`, name: a.artistName }],
        images: [{ url: "https://i.scdn.co/image/album", height: 300, width: 300 }],
      })),
      total: overrides.albums.length,
      limit: 20,
      offset: 0,
    };
  }

  if (overrides?.artists) {
    response.artists = {
      items: overrides.artists.map((a) => ({
        id: a.id,
        name: a.name,
        uri: `spotify:artist:${a.id}`,
        popularity: a.popularity ?? 85,
        genres: a.genres ?? ["pop"],
        images: [{ url: "https://i.scdn.co/image/artist", height: 300, width: 300 }],
        followers: { total: a.followers ?? 1000000 },
      })),
      total: overrides.artists.length,
      limit: 20,
      offset: 0,
    };
  }

  if (overrides?.playlists) {
    response.playlists = {
      items: overrides.playlists.map((p) => ({
        id: p.id,
        name: p.name,
        uri: `spotify:playlist:${p.id}`,
        description: p.description ?? "",
        owner: { display_name: p.ownerName, id: p.ownerId },
        tracks: { total: p.trackCount ?? 50 },
        images: [{ url: "https://i.scdn.co/image/playlist", height: 300, width: 300 }],
      })),
      total: overrides.playlists.length,
      limit: 20,
      offset: 0,
    };
  }

  return response;
}

function spotifyPlaylistsResponse(overrides?: Partial<{
  playlists: Array<{
    id: string;
    name: string;
    description: string;
    ownerName: string | null;
    ownerId: string;
    trackCount: number;
    isPublic: boolean | null;
    isCollaborative: boolean;
    hasImage: boolean;
  }>;
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
}>) {
  const playlists = overrides?.playlists ?? [
    {
      id: "pl-001",
      name: "My Playlist",
      description: "A test playlist",
      ownerName: "testuser",
      ownerId: "user-001",
      trackCount: 42,
      isPublic: true,
      isCollaborative: false,
      hasImage: true,
    },
  ];

  return {
    items: playlists.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      uri: `spotify:playlist:${p.id}`,
      owner: {
        display_name: p.ownerName,
        id: p.ownerId,
      },
      tracks: { total: p.trackCount },
      images: p.hasImage !== false
        ? [{ url: `https://i.scdn.co/image/${p.id}`, height: 300, width: 300 }]
        : [],
      public: p.isPublic ?? null,
      collaborative: p.isCollaborative ?? false,
    })),
    total: overrides?.total ?? playlists.length,
    limit: overrides?.limit ?? 20,
    offset: overrides?.offset ?? 0,
    next: overrides?.hasNext ? "https://api.spotify.com/v1/me/playlists?offset=20&limit=20" : null,
    previous: null,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

describe("Spotify Manifest", () => {
  it("passes validateIntegrationManifest with the raw JSON", async () => {
    const manifestPath = join(import.meta.dir, "../../../../src/integrations/adapters/spotify/manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    const result = validateIntegrationManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("has correct identity fields", async () => {
    const manifestPath = join(import.meta.dir, "../../../../src/integrations/adapters/spotify/manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    const result = validateIntegrationManifest(raw);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.value.id).toBe("spotify");
    expect(result.value.name).toBe("Spotify");
    expect(result.value.version).toBe("1.0.0");
    expect(result.value.category).toBe("media");
  });

  it("declares OAuth2 auth with PKCE and required scopes", async () => {
    const manifestPath = join(import.meta.dir, "../../../../src/integrations/adapters/spotify/manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    const result = validateIntegrationManifest(raw);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const auth = result.value.auth;
    expect(auth.type).toBe("oauth2");
    if (auth.type !== "oauth2") return;

    expect(auth.scopes).toContain("user-read-playback-state");
    expect(auth.scopes).toContain("user-modify-playback-state");
    expect(auth.scopes).toContain("user-read-currently-playing");
    expect(auth.scopes).toContain("playlist-read-private");
    expect(auth.pkce).toBe(true);
  });

  it("includes all four operations", async () => {
    const manifestPath = join(import.meta.dir, "../../../../src/integrations/adapters/spotify/manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    const result = validateIntegrationManifest(raw);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const opNames = result.value.operations.map((op) => op.name);
    expect(opNames).toContain("get-playback");
    expect(opNames).toContain("control-playback");
    expect(opNames).toContain("search");
    expect(opNames).toContain("get-playlists");
  });

  it("targets daemon platform", async () => {
    const manifestPath = join(import.meta.dir, "../../../../src/integrations/adapters/spotify/manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    const result = validateIntegrationManifest(raw);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.value.platforms).toContain("daemon");
  });
});

// ---------------------------------------------------------------------------
// get-playback operation
// ---------------------------------------------------------------------------

describe("getPlayback", () => {
  const TOKEN = "test-access-token";

  it("returns playback state when playing", async () => {
    const playback = spotifyPlaybackResponse({
      is_playing: true,
      progress_ms: 120000,
      trackName: "Bohemian Rhapsody",
      artistName: "Queen",
      albumName: "A Night at the Opera",
      duration_ms: 354000,
    });

    mockFetch(() => jsonResponse(playback));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel: compact
    expect(data.forModel.kind).toBe("detail");
    const modelData = data.forModel.data as {
      track: string;
      artist: string;
      isPlaying: boolean;
      progressMs: number;
      durationMs: number;
    };
    expect(modelData.track).toBe("Bohemian Rhapsody");
    expect(modelData.artist).toBe("Queen");
    expect(modelData.isPlaying).toBe(true);
    expect(modelData.progressMs).toBe(120000);
    expect(modelData.durationMs).toBe(354000);
  });

  it("returns playback state when paused", async () => {
    const playback = spotifyPlaybackResponse({
      is_playing: false,
      progress_ms: 60000,
      trackName: "Paused Track",
      artistName: "Paused Artist",
      duration_ms: 180000,
    });

    mockFetch(() => jsonResponse(playback));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { isPlaying: boolean; progressMs: number };
    expect(modelData.isPlaying).toBe(false);
    expect(modelData.progressMs).toBe(60000);
  });

  it("handles no active device (204 response)", async () => {
    mockFetch(() => emptyResponse(204));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { isPlaying: boolean };
    expect(modelData.isPlaying).toBe(false);

    const userData = data.forUser.data as { isPlaying: boolean; message: string };
    expect(userData.isPlaying).toBe(false);
    expect(userData.message).toContain("No active playback");
  });

  it("returns error for 401 auth error", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("authentication expired");
  });

  it("returns error for 429 rate limit with retry-after", async () => {
    mockFetch(() => emptyResponse(429, { "retry-after": "30" }));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("rate limited");
    expect(result.error.message).toContain("30");
  });

  it("returns error for 500 server error", async () => {
    mockFetch(() => textResponse("Internal Server Error", 500));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Spotify API error (500)");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("Network unreachable");
    });

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("sends correct Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};

    mockFetch((_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) {
        capturedHeaders = { ...headers };
      }
      return jsonResponse(spotifyPlaybackResponse());
    });

    await getPlayback("my-secret-token");
    expect(capturedHeaders["Authorization"]).toBe("Bearer my-secret-token");
  });

  it("forUser includes progress bar with block characters", async () => {
    const playback = spotifyPlaybackResponse({
      is_playing: true,
      progress_ms: 120000,
      duration_ms: 240000,
    });

    mockFetch(() => jsonResponse(playback));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userData = data.forUser.data as { progressBar: string };
    expect(userData.progressBar).toContain("\u2588"); // filled block
    expect(userData.progressBar).toContain("\u2591"); // empty block
    expect(userData.progressBar).toContain("2:00"); // 120000ms = 2:00
    expect(userData.progressBar).toContain("4:00"); // 240000ms = 4:00
  });

  it("forUser includes album art and device info", async () => {
    const playback = spotifyPlaybackResponse({
      albumImageUrl: "https://i.scdn.co/image/album-art-123",
      deviceName: "Living Room Speaker",
      deviceType: "Speaker",
    });

    mockFetch(() => jsonResponse(playback));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userData = data.forUser.data as {
      track: { album: { imageUrl: string | null } };
      device: { name: string; type: string };
    };
    expect(userData.track.album.imageUrl).toBe("https://i.scdn.co/image/album-art-123");
    expect(userData.device.name).toBe("Living Room Speaker");
    expect(userData.device.type).toBe("Speaker");
  });
});

// ---------------------------------------------------------------------------
// control-playback operation
// ---------------------------------------------------------------------------

describe("controlPlayback", () => {
  const TOKEN = "test-access-token";

  it("play action succeeds (204 response)", async () => {
    mockFetch(() => emptyResponse(204));

    const result = await controlPlayback(TOKEN, { action: "play" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { action: string; success: boolean };
    expect(modelData.action).toBe("play");
    expect(modelData.success).toBe(true);
  });

  it("pause action succeeds", async () => {
    mockFetch(() => emptyResponse(204));

    const result = await controlPlayback(TOKEN, { action: "pause" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { action: string; success: boolean };
    expect(modelData.action).toBe("pause");
    expect(modelData.success).toBe(true);
  });

  it("skip action succeeds", async () => {
    mockFetch(() => emptyResponse(204));

    const result = await controlPlayback(TOKEN, { action: "skip" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { action: string; success: boolean };
    expect(modelData.action).toBe("skip");
    expect(modelData.success).toBe(true);
  });

  it("previous action succeeds", async () => {
    mockFetch(() => emptyResponse(204));

    const result = await controlPlayback(TOKEN, { action: "previous" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { action: string; success: boolean };
    expect(modelData.action).toBe("previous");
    expect(modelData.success).toBe(true);
  });

  it("sends correct HTTP method and URL for each action", async () => {
    const actionEndpoints: Array<{ action: PlaybackAction; method: string; pathContains: string }> = [
      { action: "play", method: "PUT", pathContains: "/me/player/play" },
      { action: "pause", method: "PUT", pathContains: "/me/player/pause" },
      { action: "skip", method: "POST", pathContains: "/me/player/next" },
      { action: "previous", method: "POST", pathContains: "/me/player/previous" },
    ];

    for (const { action, method, pathContains } of actionEndpoints) {
      let capturedUrl = "";
      let capturedMethod = "";

      mockFetch((url, init) => {
        capturedUrl = url;
        capturedMethod = init?.method ?? "";
        return emptyResponse(204);
      });

      await controlPlayback(TOKEN, { action });
      expect(capturedUrl).toContain(pathContains);
      expect(capturedMethod).toBe(method);
    }
  });

  it("returns error for invalid action", async () => {
    const result = await controlPlayback(TOKEN, { action: "shuffle" as PlaybackAction });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("Invalid playback action");
    expect(result.error.message).toContain("shuffle");
  });

  it("handles 403 premium required error", async () => {
    mockFetch(() => textResponse("Forbidden", 403));

    const result = await controlPlayback(TOKEN, { action: "play" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Premium");
  });

  it("handles 404 no active device error", async () => {
    mockFetch(() => textResponse("Not Found", 404));

    const result = await controlPlayback(TOKEN, { action: "play" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("No active Spotify device");
  });

  it("handles 401 auth error", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await controlPlayback(TOKEN, { action: "play" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("authentication expired");
  });

  it("handles 429 rate limit", async () => {
    mockFetch(() => emptyResponse(429, { "retry-after": "15" }));

    const result = await controlPlayback(TOKEN, { action: "play" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("rate limited");
    expect(result.error.message).toContain("15");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("Connection refused");
    });

    const result = await controlPlayback(TOKEN, { action: "play" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("forUser includes action label and timestamp", async () => {
    mockFetch(() => emptyResponse(204));

    const result = await controlPlayback(TOKEN, { action: "skip" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userData = data.forUser.data as { action: string; message: string; timestamp: string };
    expect(userData.action).toBe("skip");
    expect(userData.message).toContain("Skipped");
    expect(userData.timestamp).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// search operation
// ---------------------------------------------------------------------------

describe("search", () => {
  const TOKEN = "test-access-token";

  it("searches tracks and returns results", async () => {
    const searchData = spotifySearchResponse({
      tracks: [
        { id: "t1", name: "Track One", artistName: "Artist A", albumName: "Album X", duration_ms: 200000, popularity: 85 },
        { id: "t2", name: "Track Two", artistName: "Artist B", albumName: "Album Y", duration_ms: 180000, popularity: 70 },
      ],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "test query", types: ["track"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.kind).toBe("list");
    expect(data.forModel.count).toBe(2);

    const modelItems = (data.forModel.data as { items: Array<{ type: string; name: string; creator: string; id: string }> }).items;
    expect(modelItems).toHaveLength(2);
    expect(modelItems[0].type).toBe("track");
    expect(modelItems[0].name).toBe("Track One");
    expect(modelItems[0].creator).toBe("Artist A");
    expect(modelItems[0].id).toBe("t1");
  });

  it("searches albums and returns results", async () => {
    const searchData = spotifySearchResponse({
      albums: [
        { id: "a1", name: "Album One", artistName: "Artist A", totalTracks: 12, releaseDate: "2025-06-15" },
      ],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "album query", types: ["album"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(1);

    const modelItems = (data.forModel.data as { items: Array<{ type: string; name: string; id: string }> }).items;
    expect(modelItems[0].type).toBe("album");
    expect(modelItems[0].name).toBe("Album One");
  });

  it("searches artists and returns results", async () => {
    const searchData = spotifySearchResponse({
      artists: [
        { id: "ar1", name: "Famous Artist", genres: ["pop", "rock"], popularity: 95, followers: 5000000 },
      ],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "famous", types: ["artist"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(1);

    const modelItems = (data.forModel.data as { items: Array<{ type: string; name: string; id: string }> }).items;
    expect(modelItems[0].type).toBe("artist");
    expect(modelItems[0].name).toBe("Famous Artist");
  });

  it("searches playlists and returns results", async () => {
    const searchData = spotifySearchResponse({
      playlists: [
        { id: "pl1", name: "Chill Vibes", ownerName: "DJ Cool", ownerId: "dj-cool", description: "Relaxing tunes", trackCount: 100 },
      ],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "chill", types: ["playlist"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(1);

    const modelItems = (data.forModel.data as { items: Array<{ type: string; name: string; creator: string; id: string }> }).items;
    expect(modelItems[0].type).toBe("playlist");
    expect(modelItems[0].name).toBe("Chill Vibes");
    expect(modelItems[0].creator).toBe("DJ Cool");
  });

  it("multi-type search returns all types", async () => {
    const searchData = spotifySearchResponse({
      tracks: [{ id: "t1", name: "Track", artistName: "A", albumName: "B", duration_ms: 200000, popularity: 80 }],
      albums: [{ id: "a1", name: "Album", artistName: "A", totalTracks: 10, releaseDate: "2025-01-01" }],
      artists: [{ id: "ar1", name: "Artist", genres: ["pop"], popularity: 90, followers: 1000000 }],
      playlists: [{ id: "pl1", name: "Playlist", ownerName: "User", ownerId: "u1", description: "", trackCount: 50 }],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "multi", types: ["track", "album", "artist", "playlist"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(4);

    const modelItems = (data.forModel.data as { items: Array<{ type: string }> }).items;
    const types = modelItems.map((item) => item.type);
    expect(types).toContain("track");
    expect(types).toContain("album");
    expect(types).toContain("artist");
    expect(types).toContain("playlist");
  });

  it("returns error for empty query", async () => {
    const result = await search(TOKEN, { query: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for whitespace-only query", async () => {
    const result = await search(TOKEN, { query: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("handles empty results gracefully", async () => {
    const searchData = spotifySearchResponse({
      tracks: [],
    });

    // Need to manually construct since factory skips empty arrays
    mockFetch(() => jsonResponse({
      tracks: { items: [], total: 0, limit: 20, offset: 0 },
    }));

    const result = await search(TOKEN, { query: "nonexistent-xyz-123", types: ["track"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(0);
    expect(data.forModel.summary).toContain("No");
    expect(data.forUser.message).toContain("No results");
  });

  it("returns error for invalid search types", async () => {
    const result = await search(TOKEN, { query: "test", types: ["invalid-type"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Invalid search types");
  });

  it("handles 401 auth error", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await search(TOKEN, { query: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("authentication expired");
  });

  it("handles 429 rate limit", async () => {
    mockFetch(() => emptyResponse(429, { "retry-after": "45" }));

    const result = await search(TOKEN, { query: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("rate limited");
    expect(result.error.message).toContain("45");
  });

  it("handles 500 server error", async () => {
    mockFetch(() => textResponse("Internal Server Error", 500));

    const result = await search(TOKEN, { query: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Spotify API error (500)");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("DNS resolution failed");
    });

    const result = await search(TOKEN, { query: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("sends correct query parameters in URL", async () => {
    let capturedUrl = "";

    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({
        tracks: { items: [], total: 0, limit: 5, offset: 0 },
      });
    });

    await search(TOKEN, { query: "test song", types: ["track", "album"], limit: 5 });
    expect(capturedUrl).toContain("q=test+song");
    expect(capturedUrl).toContain("type=track%2Calbum");
    expect(capturedUrl).toContain("limit=5");
  });

  it("defaults to track type when no types specified", async () => {
    let capturedUrl = "";

    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({
        tracks: { items: [], total: 0, limit: 20, offset: 0 },
      });
    });

    await search(TOKEN, { query: "test" });
    expect(capturedUrl).toContain("type=track");
  });

  it("forUser includes images and URIs", async () => {
    const searchData = spotifySearchResponse({
      tracks: [
        { id: "t1", name: "Rich Track", artistName: "Rich Artist", albumName: "Rich Album", duration_ms: 200000, popularity: 80 },
      ],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "rich", types: ["track"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userItems = (data.forUser.data as { items: Array<{ uri: string; imageUrl: string | null; extra: Record<string, unknown> }> }).items;
    expect(userItems).toHaveLength(1);
    expect(userItems[0].uri).toContain("spotify:track:");
    expect(userItems[0].imageUrl).toBeTruthy();
    expect(userItems[0].extra).toHaveProperty("durationMs");
    expect(userItems[0].extra).toHaveProperty("popularity");
  });
});

// ---------------------------------------------------------------------------
// get-playlists operation
// ---------------------------------------------------------------------------

describe("getPlaylists", () => {
  const TOKEN = "test-access-token";

  it("returns playlists with default limit", async () => {
    const playlistsData = spotifyPlaylistsResponse({
      playlists: [
        { id: "pl-001", name: "Workout Mix", description: "Pump it up", ownerName: "testuser", ownerId: "user-001", trackCount: 42, isPublic: true, isCollaborative: false, hasImage: true },
        { id: "pl-002", name: "Chill Vibes", description: "Relax", ownerName: "testuser", ownerId: "user-001", trackCount: 30, isPublic: false, isCollaborative: false, hasImage: true },
      ],
    });

    mockFetch(() => jsonResponse(playlistsData));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.kind).toBe("list");
    expect(data.forModel.count).toBe(2);

    const modelItems = (data.forModel.data as { items: Array<{ name: string; id: string; trackCount: number }> }).items;
    expect(modelItems).toHaveLength(2);
    expect(modelItems[0].name).toBe("Workout Mix");
    expect(modelItems[0].id).toBe("pl-001");
    expect(modelItems[0].trackCount).toBe(42);
    expect(modelItems[1].name).toBe("Chill Vibes");
    expect(modelItems[1].trackCount).toBe(30);
  });

  it("pagination works with limit and offset", async () => {
    let capturedUrl = "";

    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse(spotifyPlaylistsResponse({
        playlists: [
          { id: "pl-003", name: "Page 2 Playlist", description: "", ownerName: "user", ownerId: "u1", trackCount: 10, isPublic: true, isCollaborative: false, hasImage: true },
        ],
        offset: 20,
        limit: 10,
        hasNext: true,
      }));
    });

    const result = await getPlaylists(TOKEN, { limit: 10, offset: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(capturedUrl).toContain("limit=10");
    expect(capturedUrl).toContain("offset=20");

    const data = result.value as IntegrationResult;
    const metadata = data.forUser.metadata as { hasMore: boolean; offset: number; limit: number };
    expect(metadata.hasMore).toBe(true);
    expect(metadata.offset).toBe(20);
    expect(metadata.limit).toBe(10);
  });

  it("handles empty playlists list", async () => {
    mockFetch(() => jsonResponse(spotifyPlaylistsResponse({
      playlists: [],
      total: 0,
    })));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(0);
    expect(data.forModel.summary).toContain("No");
    expect(data.forUser.message).toContain("No playlists");
  });

  it("handles 401 auth error", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("authentication expired");
  });

  it("handles 429 rate limit", async () => {
    mockFetch(() => emptyResponse(429, { "retry-after": "20" }));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("rate limited");
    expect(result.error.message).toContain("20");
  });

  it("handles 500 server error", async () => {
    mockFetch(() => textResponse("Internal Server Error", 500));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Spotify API error (500)");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("Socket timeout");
    });

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("forUser includes owner and images", async () => {
    const playlistsData = spotifyPlaylistsResponse({
      playlists: [
        { id: "pl-rich", name: "Rich Playlist", description: "Full details", ownerName: "DJ Master", ownerId: "dj-master", trackCount: 100, isPublic: true, isCollaborative: false, hasImage: true },
      ],
    });

    mockFetch(() => jsonResponse(playlistsData));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userItems = (data.forUser.data as { items: Array<{ owner: string; imageUrl: string | null; uri: string; description: string }> }).items;
    expect(userItems).toHaveLength(1);
    expect(userItems[0].owner).toBe("DJ Master");
    expect(userItems[0].imageUrl).toBeTruthy();
    expect(userItems[0].uri).toContain("spotify:playlist:");
    expect(userItems[0].description).toBe("Full details");
  });

  it("forModel is compact with only name, id, trackCount", async () => {
    const playlistsData = spotifyPlaylistsResponse({
      playlists: [
        { id: "pl-compact", name: "Compact Test", description: "Long description that should not appear in forModel", ownerName: "Owner", ownerId: "o1", trackCount: 25, isPublic: true, isCollaborative: false, hasImage: true },
      ],
    });

    mockFetch(() => jsonResponse(playlistsData));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: Array<Record<string, unknown>> }).items;
    const modelKeys = Object.keys(modelItems[0]);
    expect(modelKeys).toContain("name");
    expect(modelKeys).toContain("id");
    expect(modelKeys).toContain("trackCount");
    expect(modelKeys).not.toContain("description");
    expect(modelKeys).not.toContain("owner");
    expect(modelKeys).not.toContain("imageUrl");
    expect(modelKeys).not.toContain("uri");
  });

  it("clamps limit to max 50", async () => {
    let capturedUrl = "";

    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse(spotifyPlaylistsResponse({ playlists: [] }));
    });

    await getPlaylists(TOKEN, { limit: 100 });
    expect(capturedUrl).toContain("limit=50");
  });

  it("handles playlist with null owner display_name", async () => {
    const playlistsData = spotifyPlaylistsResponse({
      playlists: [
        { id: "pl-null-owner", name: "No Display Name", description: "", ownerName: null, ownerId: "user-anon", trackCount: 5, isPublic: null, isCollaborative: false, hasImage: false },
      ],
    });

    mockFetch(() => jsonResponse(playlistsData));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userItems = (data.forUser.data as { items: Array<{ owner: string }> }).items;
    // Should fall back to owner ID
    expect(userItems[0].owner).toBe("user-anon");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (cross-cutting)
// ---------------------------------------------------------------------------

describe("Rate Limiting", () => {
  const TOKEN = "test-access-token";

  it("all operations handle 429 with retry-after header", async () => {
    const operations = [
      { name: "getPlayback", fn: () => getPlayback(TOKEN) },
      { name: "controlPlayback", fn: () => controlPlayback(TOKEN, { action: "play" }) },
      { name: "search", fn: () => search(TOKEN, { query: "test" }) },
      { name: "getPlaylists", fn: () => getPlaylists(TOKEN) },
    ];

    for (const { name, fn } of operations) {
      mockFetch(() => emptyResponse(429, { "retry-after": "60" }));

      const result = await fn();
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBeInstanceOf(IntegrationError);
      expect(result.error.message).toContain("rate limited");
      expect(result.error.message).toContain("60");
    }
  });

  it("rate limit error includes retry duration from header", async () => {
    mockFetch(() => emptyResponse(429, { "retry-after": "42" }));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("42");
  });

  it("rate limit error handles missing retry-after header", async () => {
    mockFetch(() => emptyResponse(429));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("rate limited");
    expect(result.error.message).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// Dual-channel result verification (cross-cutting)
// ---------------------------------------------------------------------------

describe("Dual-Channel Results", () => {
  const TOKEN = "test-access-token";

  it("getPlayback forModel is more compact than forUser", async () => {
    mockFetch(() => jsonResponse(spotifyPlaybackResponse({
      trackName: "Long Track Name for Comparison",
      artistName: "Long Artist Name for Comparison",
      albumName: "Long Album Name for Comparison",
    })));

    const result = await getPlayback(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelJson = JSON.stringify(data.forModel.data);
    const userJson = JSON.stringify(data.forUser.data);

    // forModel should be significantly smaller (token-optimized)
    expect(modelJson.length).toBeLessThan(userJson.length);
  });

  it("controlPlayback forModel has fewer fields than forUser", async () => {
    mockFetch(() => emptyResponse(204));

    const result = await controlPlayback(TOKEN, { action: "play" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelKeys = Object.keys(data.forModel.data as Record<string, unknown>);
    const userKeys = Object.keys(data.forUser.data as Record<string, unknown>);

    // forModel: action, success (2 keys)
    // forUser: action, message, timestamp (3 keys)
    expect(modelKeys.length).toBeLessThanOrEqual(userKeys.length);
  });

  it("search forModel items have fewer fields than forUser items", async () => {
    const searchData = spotifySearchResponse({
      tracks: [
        { id: "t1", name: "DC Track", artistName: "DC Artist", albumName: "DC Album", duration_ms: 200000, popularity: 80 },
      ],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "dc test", types: ["track"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: Array<Record<string, unknown>> }).items;
    const userItems = (data.forUser.data as { items: Array<Record<string, unknown>> }).items;

    expect(modelItems).toHaveLength(1);
    expect(userItems).toHaveLength(1);

    const modelKeys = Object.keys(modelItems[0]);
    const userKeys = Object.keys(userItems[0]);

    // forModel: type, name, creator, id (4 keys)
    // forUser: type, name, id, uri, creator, imageUrl, extra (7 keys)
    expect(modelKeys.length).toBeLessThan(userKeys.length);

    // forUser should have uri and imageUrl, forModel should not
    expect(userKeys).toContain("uri");
    expect(userKeys).toContain("imageUrl");
    expect(modelKeys).not.toContain("uri");
    expect(modelKeys).not.toContain("imageUrl");
  });

  it("getPlaylists forModel items have fewer fields than forUser items", async () => {
    const playlistsData = spotifyPlaylistsResponse({
      playlists: [
        { id: "pl-dc", name: "DC Playlist", description: "Dual channel test", ownerName: "Owner", ownerId: "o1", trackCount: 50, isPublic: true, isCollaborative: false, hasImage: true },
      ],
    });

    mockFetch(() => jsonResponse(playlistsData));

    const result = await getPlaylists(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: Array<Record<string, unknown>> }).items;
    const userItems = (data.forUser.data as { items: Array<Record<string, unknown>> }).items;

    const modelKeys = Object.keys(modelItems[0]);
    const userKeys = Object.keys(userItems[0]);

    // forModel: name, id, trackCount (3 keys)
    // forUser: id, name, description, uri, owner, trackCount, imageUrl, isPublic, isCollaborative (9 keys)
    expect(modelKeys.length).toBeLessThan(userKeys.length);

    // forUser should have owner and uri, forModel should not
    expect(userKeys).toContain("owner");
    expect(userKeys).toContain("uri");
    expect(modelKeys).not.toContain("owner");
    expect(modelKeys).not.toContain("uri");
  });

  it("all operations return IntegrationResult with forModel and forUser", async () => {
    // getPlayback
    mockFetch(() => jsonResponse(spotifyPlaybackResponse()));
    const playbackResult = await getPlayback(TOKEN);
    expect(playbackResult.ok).toBe(true);
    if (playbackResult.ok) {
      const r = playbackResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
      expect(r.forModel).toHaveProperty("kind");
      expect(r.forModel).toHaveProperty("summary");
      expect(r.forUser).toHaveProperty("kind");
      expect(r.forUser).toHaveProperty("title");
      expect(r.forUser).toHaveProperty("message");
    }

    // controlPlayback
    mockFetch(() => emptyResponse(204));
    const controlResult = await controlPlayback(TOKEN, { action: "play" });
    expect(controlResult.ok).toBe(true);
    if (controlResult.ok) {
      const r = controlResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
    }

    // search
    mockFetch(() => jsonResponse({
      tracks: { items: [], total: 0, limit: 20, offset: 0 },
    }));
    const searchResult = await search(TOKEN, { query: "test" });
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      const r = searchResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
    }

    // getPlaylists
    mockFetch(() => jsonResponse(spotifyPlaylistsResponse({ playlists: [] })));
    const playlistsResult = await getPlaylists(TOKEN);
    expect(playlistsResult.ok).toBe(true);
    if (playlistsResult.ok) {
      const r = playlistsResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
    }
  });

  it("forModel token size is smaller than raw response for search", async () => {
    const searchData = spotifySearchResponse({
      tracks: [
        { id: "t1", name: "Track 1", artistName: "Artist 1", albumName: "Album 1", duration_ms: 200000, popularity: 80 },
        { id: "t2", name: "Track 2", artistName: "Artist 2", albumName: "Album 2", duration_ms: 180000, popularity: 70 },
        { id: "t3", name: "Track 3", artistName: "Artist 3", albumName: "Album 3", duration_ms: 220000, popularity: 90 },
      ],
    });

    mockFetch(() => jsonResponse(searchData));

    const result = await search(TOKEN, { query: "test", types: ["track"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelJson = JSON.stringify(data.forModel);
    const rawJson = JSON.stringify(searchData);

    // forModel should be significantly smaller than the raw API response
    expect(modelJson.length).toBeLessThan(rawJson.length);
  });
});
