# Obsidian Integration

Local filesystem integration for Obsidian vaults.

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

## Obsidian-Specific Details

**Auth Type:** `local_path`
- Validates local vault directory exists and is readable
- Stores vault path in `CredentialVault`

**Operations:**
- `search_notes`: Search notes by content and title
- `read_note`: Read note content by path
- `create_note`: Create new note with title and content
- `list_notes`: List notes in a directory/folder

**Implementation:** Uses `node:fs` for local filesystem access.
