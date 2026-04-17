# API Reference

`Novel Object Storage v0.2.0`

这份文档面向 CLI、脚本和 AI 代理。

## Discovery

### `GET /api/health`

返回服务健康状态。

响应示例：

```json
{
  "ok": true,
  "version": "0.1.0",
  "time": "2026-04-03T12:00:00.000Z"
}
```

### `GET /api/meta`

返回服务元信息。

响应示例：

```json
{
  "name": "novel-object-storage",
  "version": "0.1.0",
  "baseUrl": "http://127.0.0.1:4000",
  "docsUrl": "http://127.0.0.1:4000/api/openapi.json",
  "uiUrl": "http://127.0.0.1:4000/",
  "maxFileSize": 524288000,
  "features": {
    "videoTranscode": true,
    "ffmpegAvailable": true
  },
  "auth": ["cookie", "bearer", "x-api-key"]
}
```

说明：

- `baseUrl` 支持域名或原始 IP（例如 `http://203.0.113.42:4000`）。`BASE_URL` 环境变量未设置时，服务启动时会自动选一个非 loopback IPv4

### `GET /api/openapi.json`

返回 OpenAPI 3.1 文档。

## Authentication

### 登录

`POST /api/login`

请求：

```json
{
  "username": "admin",
  "password": "your-password"
}
```

响应：

```json
{
  "ok": true,
  "token": "..."
}
```

说明：

- 同时会设置 `token` cookie
- CLI 场景请直接使用返回的 `token`

### 登出

`POST /api/logout`

行为：

- 如果请求带 cookie，会删除 cookie session
- 如果请求带 bearer token，会撤销对应 token session

## File Operations

### 上传文件

`POST /api/upload`

> 注意：上传路径是 `/api/upload`，不是 `POST /api/files`。OpenAPI 文档里同样记在 `/api/upload`。

认证：

- `Authorization: Bearer <token>`
- 或 `X-Api-Key: <key>`

表单字段：

- `files`: 多个文件
- `tags`: 可选，逗号分隔字符串
- `description`: 可选，字符串

响应：

```json
{
  "ok": true,
  "files": [
    {
      "id": "m5abc-1a2b3c4d",
      "filename": "m5abc-1a2b3c4d.jpg",
      "originalName": "photo.jpg",
      "mimeType": "image/jpeg",
      "category": "image",
      "size": 123456,
      "url": "http://127.0.0.1:4000/f/m5abc-1a2b3c4d.jpg",
      "thumbUrl": "http://127.0.0.1:4000/thumb/m5abc-1a2b3c4d.jpg",
      "previewUrl": "http://127.0.0.1:4000/thumb/m5abc-1a2b3c4d.jpg",
      "playbackUrl": null,
      "transcoded": false,
      "uploadedAt": "2026-04-03T12:00:00.000Z",
      "tags": ["agent", "release"],
      "description": "nightly build artifact"
    }
  ]
}
```

### 列表查询

`GET /api/files`

查询参数：

- `page`: 页码，默认 `1`
- `limit`: 每页数量，默认 `50`
- `category`: `image` / `video` / `document` / `other`
- `tag`: 按标签精确匹配
- `q`: 搜索文件名、描述、标签

### 获取单文件

`GET /api/files/:id`

### 更新元数据

`PATCH /api/files/:id`

请求体支持：

```json
{
  "tags": ["agent", "reviewed"],
  "description": "verified by operator"
}
```

或：

```json
{
  "tags": "agent, reviewed",
  "description": "verified by operator"
}
```

### 删除文件

`DELETE /api/files/:id`

## Stats

### `GET /api/stats`

响应示例：

```json
{
  "totalFiles": 42,
  "totalSize": 1073741824,
  "totalSizeHuman": "1 GB",
  "categories": {
    "image": 30,
    "video": 10,
    "document": 2
  }
}
```

## API Keys

### 创建 key

`POST /api/keys`

请求体：

```json
{
  "name": "agent-runner"
}
```

响应：

```json
{
  "ok": true,
  "key": "isk_xxx",
  "apiKey": {
    "id": "key_abcd1234",
    "name": "agent-runner",
    "maskedKey": "isk_xxx...abcd",
    "prefix": "isk_xxx",
    "createdAt": "2026-04-03T12:00:00.000Z"
  }
}
```

注意：

- `key` 明文只在创建时返回一次
- 后续撤销使用 `id`

### 列出 key

`GET /api/keys`

响应示例：

```json
{
  "keys": [
    {
      "id": "key_abcd1234",
      "name": "agent-runner",
      "maskedKey": "isk_xxx...abcd",
      "prefix": "isk_xxx",
      "createdAt": "2026-04-03T12:00:00.000Z",
      "lastUsedAt": "2026-04-03T13:00:00.000Z"
    }
  ]
}
```

### 撤销 key

`DELETE /api/keys/:id`

## Public Files

### 原始文件

`GET /f/:filename`

### 缩略图

`GET /thumb/:filename`

安全行为：

- 文件响应包含 `X-Content-Type-Options: nosniff`
- 危险 MIME 类型会附带 `Content-Disposition: attachment`
- 图片和视频保留内联预览能力
- 视频与派生视频文件支持 `Range` 请求，便于远程流播放
- 若服务端存在 `ffmpeg` 且 `VIDEO_TRANSCODE_ENABLED` 未关闭，非 `mp4/webm` 视频会尝试转码为 MP4，并在元数据里返回 `playbackUrl`
