/**
 * Spotify operations barrel export.
 *
 * Re-exports all four Spotify operations:
 * get-playback, control-playback, search, get-playlists.
 */

export { getPlayback } from "./get-playback";
export { controlPlayback, type ControlPlaybackParams, type PlaybackAction } from "./control-playback";
export { search, type SearchParams } from "./search";
export { getPlaylists, type GetPlaylistsParams } from "./get-playlists";
