# Gmail Integration

OAuth2-based integration for Gmail email management.

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

## Gmail-Specific Details

**Auth Type:** `oauth2`
- Browser-based OAuth2 flow with local callback server
- Required scopes: `gmail.readonly`, `gmail.send`, `gmail.modify`
- Automatic token refresh via `OAuthRefreshManager`
- Tokens stored encrypted in `CredentialVault`

**Operations:**
- `read_email`: Fetch email by ID (subject, sender, body, attachments)
- `search_emails`: Search with Gmail query syntax (from, to, subject, date)
- `send_email`: Compose and send email (to, cc, bcc, subject, body)
- `list_emails`: List recent inbox emails with pagination

**Implementation:** Uses Google Gmail API via native `fetch`.
