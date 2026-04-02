# Novel Object Storage

Lightweight, self-hosted object storage service with REST API and Web UI. Designed for small projects that need a simple way to store and serve images, videos, and documents with public URLs.

No external database required — data is stored as JSON files on disk.

## Features

- 📁 **File Upload** — Images, videos, documents (up to 500MB)
- 🔗 **Public URLs** — Every uploaded file gets a permanent, cacheable URL
- 🖼️ **Auto Thumbnails** — Automatic thumbnail generation for images
- 🔐 **Auth** — Password login + API key support for external integrations
- 🌐 **Web UI** — Built-in management dashboard
- 🏷️ **Tags & Search** — Organize files with tags and full-text search
- 📊 **Stats** — Storage usage and file count overview
- 🪶 **Zero Dependencies on External Services** — No S3, no database, just Node.js

## Quick Start

```bash
git clone https://github.com/xuyuanzhang1122/Novel-Object-Storage.git
cd Novel-Object-Storage
cp .env.example .env
# Edit .env with your credentials and domain
npm install
npm start
```

The server starts on `http://127.0.0.1:4000` by default.

## Configuration

All configuration is done via environment variables (`.env` file):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Server port |
| `HOST` | `127.0.0.1` | Bind address |
| `BASE_URL` | `http://localhost:4000` | Public URL for generating file links |
| `ADMIN_USERNAME` | — | Admin username (**required on first run**) |
| `ADMIN_PASSWORD` | — | Admin password (**required on first run**) |
| `DATA_DIR` | `./data` | Storage directory |
| `MAX_FILE_SIZE` | `524288000` | Max upload size in bytes (500MB) |
| `TOKEN_EXPIRY` | `604800000` | Login session duration in ms (7 days) |

> **Note:** `ADMIN_USERNAME` and `ADMIN_PASSWORD` are only used on first run to create the admin account. The password is bcrypt-hashed and stored in `data/auth.json`. To change credentials later, delete `data/auth.json` and restart.

## Reverse Proxy (Caddy)

```
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

## Systemd Service

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

## API Reference

### Authentication

All API endpoints (except public file access) require authentication via one of:
- **Cookie** — Set automatically after login via Web UI
- **Bearer Token** — `Authorization: Bearer <token>` (obtained from login)
- **API Key** — `X-Api-Key: <key>` (generated via Web UI or API, recommended for integrations)

### Endpoints

#### Login

```
POST /api/login
Content-Type: application/json

{"username": "admin", "password": "your-password"}

→ {"ok": true, "token": "abc123..."}
```

#### Upload Files

```
POST /api/upload
Content-Type: multipart/form-data
X-Api-Key: isk_xxx

Form fields:
  files: (binary, multiple allowed, up to 50)
  tags: "tag1, tag2" (optional, comma-separated)
  description: "file description" (optional)

→ {
    "ok": true,
    "files": [{
      "id": "m5abc-1a2b3c4d",
      "filename": "m5abc-1a2b3c4d.jpg",
      "originalName": "photo.jpg",
      "mimeType": "image/jpeg",
      "category": "image",
      "size": 123456,
      "url": "https://your-domain.com/f/m5abc-1a2b3c4d.jpg",
      "thumbUrl": "https://your-domain.com/thumb/m5abc-1a2b3c4d.jpg",
      "uploadedAt": "2026-04-02T09:00:00.000Z",
      "tags": ["tag1", "tag2"],
      "description": ""
    }]
  }
```

#### List Files

```
GET /api/files?page=1&limit=50&category=image&tag=photos&q=search

→ {"files": [...], "total": 100, "page": 1, "limit": 50, "pages": 2}
```

Query parameters:
- `page` — Page number (default: 1)
- `limit` — Items per page (default: 50)
- `category` — Filter: `image`, `video`, `document`, `other`
- `tag` — Filter by tag
- `q` — Search filename, description, tags

#### Get File Info

```
GET /api/files/:id

→ {file object}
```

#### Update File Metadata

```
PATCH /api/files/:id
Content-Type: application/json

{"tags": ["new-tag"], "description": "updated"}

→ {updated file object}
```

#### Delete File

```
DELETE /api/files/:id

→ {"ok": true}
```

#### Stats

```
GET /api/stats

→ {
    "totalFiles": 42,
    "totalSize": 1073741824,
    "totalSizeHuman": "1 GB",
    "categories": {"image": 30, "video": 10, "document": 2}
  }
```

#### Generate API Key

```
POST /api/keys

→ {"key": "isk_abc123..."}
```

#### List API Keys (masked)

```
GET /api/keys

→ {"keys": ["isk_abc1...ef12"]}
```

### Public File Access (No Auth Required)

| URL | Description |
|---|---|
| `GET /f/{filename}` | Original file |
| `GET /thumb/{id}.jpg` | Thumbnail (images only, 400x400) |

Files are served with `Cache-Control: public, max-age=31536000, immutable`.

## Integration Example (curl)

```bash
# Login and get token
TOKEN=$(curl -s https://your-domain.com/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"pass"}' | jq -r .token)

# Upload a file
curl -X POST https://your-domain.com/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@photo.jpg" \
  -F "tags=landscape,nature"

# Or use API key
curl -X POST https://your-domain.com/api/upload \
  -H "X-Api-Key: isk_your_key_here" \
  -F "files=@photo.jpg"
```

## License

MIT
