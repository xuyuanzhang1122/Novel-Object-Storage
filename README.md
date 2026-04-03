# Novel Object Storage

`v0.1.0`

轻量、自托管、CLI 优先的对象存储服务，适合小型项目、自动化代理和人工运维协作。

文件直接落到磁盘，元数据保存在 JSON 中；没有 S3，没有数据库，没有额外控制面依赖。

## 这版做了什么

- 修复公开文件同源执行风险：危险 MIME 会强制下载，不再以内联页面执行
- 修复管理后台文件名存储型 XSS
- 修复浏览器登出不撤销 bearer session 的问题
- 将 `db.json` 写入改为串行化，避免并发请求互相覆盖
- API key 改为 `id + maskedKey + hash` 模型，支持可靠撤销
- 管理前端重做为运维控制台，强调文件工作区、CLI 片段和 key 管理
- 增加 `GET /api/health`、`GET /api/meta`、`GET /api/openapi.json`

## 特性

- 多文件上传，最大 500MB，可附带标签和描述
- 图片自动生成缩略图
- 图片、视频、PDF、文本在控制台内支持预览
- 视频上传后可按需转码为更适合远程流播放的 MP4（依赖 `ffmpeg`）
- 公开文件 URL 与缩略图 URL
- 密码登录、Bearer token、Cookie、API key 多种认证方式
- API key 命名、查看最近使用时间、按 id 撤销
- 文件搜索、分类筛选、标签筛选、元数据编辑
- 内置控制台 UI，适合人工排查和轻量运维
- OpenAPI 文档，方便 CLI、脚本和 AI 代理生成客户端

## 快速启动

```bash
git clone https://github.com/xuyuanzhang1122/Novel-Object-Storage.git
cd Novel-Object-Storage
cp .env.example .env
npm install
npm start
```

默认监听：

- `http://127.0.0.1:4000`

首次启动前必须在 `.env` 里设置：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4000` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `BASE_URL` | `http://localhost:4000` | 用于生成公开 URL 和 OpenAPI server URL |
| `ADMIN_USERNAME` | - | 首次启动时创建管理员账号 |
| `ADMIN_PASSWORD` | - | 首次启动时创建管理员密码 |
| `DATA_DIR` | `./data` | 数据目录 |
| `MAX_FILE_SIZE` | `524288000` | 单文件最大大小，单位字节 |
| `TOKEN_EXPIRY` | `604800000` | 登录 session 过期时间，单位毫秒 |
| `COOKIE_SECURE` | 自动判断 | 强制指定 cookie 是否使用 `Secure` |
| `VIDEO_TRANSCODE_ENABLED` | `true` | 是否尝试转码不适合远程流播放的视频 |
| `FFMPEG_PATH` | `ffmpeg` | `ffmpeg` 可执行文件路径 |
| `APP_VERSION` | `package.json` | 覆盖对外暴露的版本号 |

说明：

- `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 只在第一次创建 `data/auth.json` 时使用
- 如需重置管理员账号，删除 `data/auth.json` 后重启
- `COOKIE_SECURE` 未设置时，会根据 `BASE_URL` 自动判断；本地 `http://127.0.0.1:4000` 会自动关闭 secure cookie
- 视频转码和视频封面依赖 `ffmpeg`；如果系统里没有 `ffmpeg`，服务会自动降级为仅保存原视频

## 数据布局

默认目录结构：

```text
data/
  auth.json       # 管理员账号 + API key 哈希
  db.json         # 文件元数据与统计
  files/          # 原始文件
  thumbs/         # 图片缩略图
```

## 认证方式

除公开文件下载路由外，所有 `/api/*` 管理接口都支持以下认证方式之一：

- Cookie：浏览器控制台默认使用
- Bearer token：`Authorization: Bearer <token>`
- API key：`X-Api-Key: <key>`

登录接口既会设置 cookie，也会返回 bearer token，便于 CLI 直接继续调用。

## CLI 优先接口

服务暴露了三个无需认证的发现接口：

- `GET /api/health`
- `GET /api/meta`
- `GET /api/openapi.json`

常用操作示例：

```bash
# 1. 登录
TOKEN=$(curl -s http://127.0.0.1:4000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}' | jq -r .token)

# 2. 创建 automation key
curl -s http://127.0.0.1:4000/api/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-runner"}'

# 3. 上传文件
curl -s -X POST http://127.0.0.1:4000/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@artifact.png" \
  -F "tags=release,agent" \
  -F "description=nightly build artifact"

# 4. 列出文件
curl -s "http://127.0.0.1:4000/api/files?limit=20&q=release" \
  -H "Authorization: Bearer $TOKEN"

# 5. 更新元数据
curl -s -X PATCH http://127.0.0.1:4000/api/files/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tags":["release","verified"],"description":"reviewed by operator"}'
```

完整接口说明见：

- [docs/API.md](docs/API.md)

## 安全说明

- 上传文件会根据 MIME 类型决定是否允许浏览器内联展示
- `text/html`、`application/xhtml+xml`、`image/svg+xml`、JavaScript 等危险类型会强制 `attachment`
- 响应附带 `X-Content-Type-Options: nosniff`
- 管理端不再把 session token 落到浏览器持久存储
- API key 不再以明文持久保存，磁盘上只保留哈希和元数据
- 视频文件支持 Range 请求；转码后的 MP4 会优先作为浏览器预览与远程播放地址

## 反向代理示例

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

## systemd 示例

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

## 开发提示

```bash
npm run dev
```

调试时建议先检查：

- `GET /api/health`
- `GET /api/meta`
- `GET /api/openapi.json`

## License

MIT
