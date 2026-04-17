# Novel Object Storage

`v0.2.0`

[简体中文](README.zh-CN.md)

Lightweight, self-hosted, CLI-first object storage service for small projects, automation agents, and human operators.

Files land on disk. Metadata lives in JSON. No S3, no database, no external control-plane dependencies.

## Features

- Multi-file upload, up to 500 MB each, with tags and descriptions
- Auto-generated thumbnails for images
- In-console preview for images, videos, PDF, and text
- On-demand video transcoding to streaming-friendly MP4 (requires `ffmpeg`)
- Public file URLs and thumbnail URLs
- Password login, Bearer tokens, Cookies, and API keys
- API key naming, last-used tracking, and revocation by ID
- File search, category filtering, tag filtering, and metadata editing
- Built-in console UI for human inspection and light operations
- OpenAPI spec for CLI, scripts, and AI agent client generation

## One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/xuyuanzhang1122/Novel-Object-Storage/main/install.sh | bash
```

The installer will interactively prompt you for:

| Prompt | Default | Description |
|---|---|---|
| Install directory | `./Novel-Object-Storage` | Where to clone the project |
| Server port | `4000` | HTTP listening port |
| Data directory | `./data` | Where files and metadata are stored |
| Access method | Public IP (auto-detect) | Choose public IP, domain, or local-only |
| Admin username | `admin` | Admin login name |
| Admin password | *(required)* | Admin login password |

> **Note:** Requires `git`, `node >= 18`, and `npm`. The installer checks these before proceeding.

## Quick Start (Manual)

```bash
git clone https://github.com/xuyuanzhang1122/Novel-Object-Storage.git
cd Novel-Object-Storage
cp .env.example .env
# Edit .env — set ADMIN_USERNAME, ADMIN_PASSWORD, and BASE_URL
npm install
npm start
```

Default endpoint:

- `http://127.0.0.1:4000`

You **must** set the following in `.env` before the first run:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Server port |
| `HOST` | `127.0.0.1` | Listening address |
| `BASE_URL` | Auto-detect | Used to generate public URLs and the OpenAPI server URL. Accepts a domain or a public/LAN IP (e.g. `http://203.0.113.42:4000`). Auto-detects a non-loopback IPv4 if unset |
| `ADMIN_USERNAME` | – | Admin account created on first run |
| `ADMIN_PASSWORD` | – | Admin password created on first run |
| `DATA_DIR` | `./data` | Data directory |
| `MAX_FILE_SIZE` | `524288000` | Max file size in bytes |
| `TOKEN_EXPIRY` | `604800000` | Login session TTL in milliseconds |
| `COOKIE_SECURE` | Auto-detect | Force cookie `Secure` flag on or off |
| `VIDEO_TRANSCODE_ENABLED` | `true` | Whether to transcode videos unsuitable for remote streaming |
| `FFMPEG_PATH` | `ffmpeg` | Path to `ffmpeg` binary |
| `APP_VERSION` | `package.json` | Override the externally reported version |

Notes:

- `ADMIN_USERNAME` and `ADMIN_PASSWORD` are only used the first time `data/auth.json` is created
- To reset the admin account, delete `data/auth.json` and restart
- `COOKIE_SECURE` auto-detects from `BASE_URL` when unset; local `http://127.0.0.1:4000` will disable secure cookies automatically
- `BASE_URL` accepts a domain or raw IP; for public deployments without a domain, simply use the public IP, e.g. `http://203.0.113.42:4000`
- Video transcoding and cover images require `ffmpeg`; if missing, the service gracefully degrades to saving the original video only

## Data Layout

Default directory structure:

```text
data/
  auth.json       # Admin account + API key hashes
  db.json         # File metadata and statistics
  files/          # Original files
  thumbs/         # Image thumbnails
```

## Authentication

All `/api/*` management endpoints (except public file routes) support one of the following:

- Cookie — used by the browser console by default
- Bearer token — `Authorization: Bearer <token>`
- API key — `X-Api-Key: <key>`

The login endpoint sets a cookie and also returns a bearer token, making it easy to continue from CLI.

## CLI-First Interface

Three discovery endpoints require no authentication:

- `GET /api/health`
- `GET /api/meta`
- `GET /api/openapi.json`

Common operations:

```bash
# 1. Login
TOKEN=$(curl -s http://127.0.0.1:4000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}' | jq -r .token)

# 2. Create an automation key
curl -s http://127.0.0.1:4000/api/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-runner"}'

# 3. Upload a file
curl -s -X POST http://127.0.0.1:4000/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@artifact.png" \
  -F "tags=release,agent" \
  -F "description=nightly build artifact"

# 4. List files
curl -s "http://127.0.0.1:4000/api/files?limit=20&q=release" \
  -H "Authorization: Bearer $TOKEN"

# 5. Update metadata
curl -s -X PATCH http://127.0.0.1:4000/api/files/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tags":["release","verified"],"description":"reviewed by operator"}'
```

Full API reference:

- [docs/API.md](docs/API.md)

## API Quick Reference

| Method | Path | Description | Auth |
|---|---|---|---|
| `POST` | `/api/login` | Login & get token | ❌ |
| `POST` | `/api/upload` | Upload files | ✅ |
| `GET` | `/api/files` | List files (pagination / search / filter) | ✅ |
| `GET` | `/api/files/:id` | File details | ✅ |
| `PATCH` | `/api/files/:id` | Update tags / description | ✅ |
| `DELETE` | `/api/files/:id` | Delete file | ✅ |
| `GET` | `/api/stats` | Statistics | ✅ |
| `POST` | `/api/keys` | Create API key | ✅ |
| `GET` | `/api/keys` | List API keys | ✅ |
| `DELETE` | `/api/keys/:id` | Revoke API key | ✅ |
| `GET` | `/api/health` | Health check | ❌ |
| `GET` | `/api/meta` | Service metadata | ❌ |
| `GET` | `/api/openapi.json` | OpenAPI spec | ❌ |
| `GET` | `/f/{filename}` | Public file access | ❌ |
| `GET` | `/thumb/{id}.jpg` | Public thumbnail | ❌ |

## Security Notes

- Uploaded files use MIME type to decide whether to allow inline display
- `text/html`, `application/xhtml+xml`, `image/svg+xml`, JavaScript, and other dangerous types force `attachment`
- Responses include `X-Content-Type-Options: nosniff`
- The admin console no longer persists session tokens in browser storage
- API keys are no longer stored in plaintext; only hashes and metadata are saved to disk
- Video files support Range requests; transcoded MP4s are preferred for browser preview and remote playback

## Reverse Proxy Example

### Caddy

```caddy
your-domain.com {
    encode gzip
    reverse_proxy localhost:4000

    header /f/* {
        Cache-Control "public, max-age=31536000, immutable"
    }
    header /thumb/* {
        Cache-Control "public, max-age=31536000, immutable"
    }
}
```

## systemd Example

```ini
[Unit]
Description=Novel Object Storage
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/Novel-Object-Storage
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/Novel-Object-Storage/.env

[Install]
WantedBy=multi-user.target
```

## Development

```bash
npm run dev
```

When debugging, start by checking:

- `GET /api/health`
- `GET /api/meta`
- `GET /api/openapi.json`

## Changelog

### What's New in v0.2.0

- Fixed OpenAPI: `POST /api/upload` was incorrectly documented as `POST /api/files`, causing 404s for spec-generated clients
- OpenAPI spec now includes full `components.schemas` / `requestBody` / `responses` / `parameters`, ready for code generators and AI agents
- Public endpoints (`/api/health`, `/api/meta`, `/api/openapi.json`, `/api/login`, `/f/*`, `/thumb/*`, `/derived/*`) are explicitly marked as unauthenticated
- Support using public IP or LAN IP as `BASE_URL`; auto-detects a non-loopback IPv4 when not explicitly configured
- `/api/files` `page/limit` parameters now have boundary validation (`limit` capped at 200) with guards for legacy records missing `tags/description`
- `/api/upload` now returns 400 on empty requests
- File access uses `Object.prototype.hasOwnProperty` allowlist to block `__proto__` and other special-key exploits
- Frontend upload response parsing and file preview include null guards — abnormal responses no longer crash the UI
- Documentation (README / docs/API.md / .env.example) updated to reflect all above changes

### What Changed in v0.1.0

- Fixed public file same-origin execution risk: dangerous MIME types now force download instead of inline display
- Fixed stored XSS via filenames in the admin console
- Fixed browser logout not revoking bearer sessions
- Serialized `db.json` writes to prevent concurrent requests from overwriting each other
- API keys switched to `id + maskedKey + hash` model for reliable revocation
- Admin frontend rebuilt as operator console with focus on file workspace, CLI snippets, and key management
- Added `GET /api/health`, `GET /api/meta`, `GET /api/openapi.json`

## License

MIT
