# Novel Object Storage

轻量级自托管对象存储服务，带 REST API 和 Web 管理界面。适合小项目快速搭建图片/视频/文档存储，每个文件都有公开访问 URL。

无需外部数据库 —— 数据以 JSON 文件存储在磁盘上。

## 功能

- 📁 **文件上传** — 支持图片、视频、文档（最大 500MB）
- 🔗 **公开 URL** — 每个上传的文件都有永久可缓存的访问链接
- 🖼️ **自动缩略图** — 图片自动生成缩略图
- 🔐 **鉴权** — 密码登录 + API Key 支持外部项目对接
- 🌐 **Web 界面** — 内置管理后台，支持拖拽上传
- 🏷️ **标签与搜索** — 用标签组织文件，支持全文搜索
- 📊 **统计** — 存储用量和文件数量概览
- 🪶 **零外部依赖** — 不需要 S3、不需要数据库，只要 Node.js

## 快速开始

```bash
git clone https://github.com/xuyuanzhang1122/Novel-Object-Storage.git
cd Novel-Object-Storage
cp .env.example .env
# 编辑 .env 填入你的用户名、密码和域名
npm install
npm start
```

详细配置和 API 文档见 [README.md](README.md)。

## API 快速参考

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| `POST` | `/api/login` | 登录获取 token | ❌ |
| `POST` | `/api/upload` | 上传文件 | ✅ |
| `GET` | `/api/files` | 文件列表（分页/搜索/筛选）| ✅ |
| `GET` | `/api/files/:id` | 文件详情 | ✅ |
| `PATCH` | `/api/files/:id` | 更新标签/描述 | ✅ |
| `DELETE` | `/api/files/:id` | 删除文件 | ✅ |
| `GET` | `/api/stats` | 统计信息 | ✅ |
| `POST` | `/api/keys` | 生成 API Key | ✅ |
| `GET` | `/f/{filename}` | 公开访问文件 | ❌ |
| `GET` | `/thumb/{id}.jpg` | 公开访问缩略图 | ❌ |

## 许可证

MIT
