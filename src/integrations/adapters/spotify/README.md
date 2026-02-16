# Spotify Integration

OAuth2-based integration for Spotify playback control and music discovery.

## 5-File Integration Contract

This integration follows the standard 5-file contract pattern:

### 1. `manifest.json`
Integration metadata including:
- `id`: Unique integration identifier (kebab-case)
- `name`: Human-readable integration name
- `description`: Brief description of integration capabilities
- `version`: Semantic version (semver)
- `author`: Integration author
- `category`: Integration category (productivity, communication, media, etc.)
- `auth`: Authentication requirements (oauth2, api_key, or local_path)
- `permissions`: Required permissions
- `platforms`: Supported platforms (daemon, tui, desktop, mobile, api)
- `operations`: Available operations with parameter schemas

### 2. `auth.ts`
Authentication handler implementing:
- `connect()`: Establish connection with authentication
- `disconnect()`: Terminate connection and clear credentials
- `getStatus()`: Return current connection status
- Credential storage via `CredentialVault`

### 3. `operations/index.ts`
Barrel export for all operation modules.

### 4. Individual Operation Files
Each operation in `operations/` directory:
- Implements specific integration capability
- Returns `IntegrationResult<T>` with dual channels:
  - `forModel`: Token-optimized compact data
  - `forUser`: Display-optimized rich data
- Uses `Result<T>` for error handling

### 5. `README.md` (this file)
Documentation of the integration contract and usage.

## Spotify-Specific Details

**Auth Type:** `oauth2`
- Browser-based OAuth2 flow with local callback server and PKCE
- Required scopes: `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`, `playlist-read-private`
- Automatic token refresh via `OAuthRefreshManager`
- Tokens stored encrypted in `CredentialVault`

**Operations:**
- `get_playback`: Current playback state (track, artist, progress, device)
- `control_playback`: Play/pause/skip/previous commands
- `search`: Search tracks, albums, artists, playlists
- `get_playlists`: User's playlists with track counts

**Implementation:** Uses Spotify Web API via native `fetch`. Playback control targets <1s response time.

**Note:** Playback control requires Spotify Premium subscription.
