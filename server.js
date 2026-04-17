const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sharp = require('sharp');
const mime = require('mime-types');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const pkg = require('./package.json');

// --- Load .env if dotenv is available ---
try { require('dotenv').config(); } catch {}

const app = express();
app.set('trust proxy', 1);
const PORT = parseInt(process.env.PORT) || 4000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_VERSION = process.env.APP_VERSION || pkg.version || '0.2.0';

// --- Config from env ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'files');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const DERIVED_DIR = path.join(DATA_DIR, 'derived');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
function detectLanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function resolveBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  // No domain configured — pick a reachable host so generated URLs work from other machines.
  // Priority: HOST env if it's a routable IP, otherwise the first non-loopback IPv4, otherwise localhost.
  const hostEnv = process.env.HOST;
  const hostLooksRoutable = hostEnv && hostEnv !== '0.0.0.0' && hostEnv !== '127.0.0.1' && hostEnv !== 'localhost' && hostEnv !== '::';
  const host = hostLooksRoutable ? hostEnv : (detectLanIPv4() || 'localhost');
  return `http://${host}:${PORT}`;
}

const BASE_URL = resolveBaseUrl();
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024; // 500MB
const TOKEN_EXPIRY = parseInt(process.env.TOKEN_EXPIRY) || 7 * 24 * 60 * 60 * 1000; // 7 days
const VIDEO_TRANSCODE_ENABLED = process.env.VIDEO_TRANSCODE_ENABLED !== 'false';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const VIDEO_STREAM_MIME_TYPES = new Set(['video/mp4', 'video/webm']);
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE_URL) && BASE_URL.startsWith('https://');
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript'
]);
const INLINE_SAFE_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json'
]);

// Ensure dirs
[DATA_DIR, UPLOAD_DIR, THUMB_DIR, DERIVED_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// --- DB ---
function loadDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    const files = db.files || {};
    Object.values(files).forEach(file => {
      if (file.category === 'video' && !file.playbackUrl) file.playbackUrl = file.url;
      addPreviewMetadata(file);
    });
    db.files = files;
    return db;
  }
  catch { return { files: {}, stats: { totalFiles: 0, totalSize: 0 } }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let dbWriteQueue = Promise.resolve();

function mutateDB(mutator) {
  const task = dbWriteQueue.then(async () => {
    const db = loadDB();
    const result = await mutator(db);
    saveDB(db);
    return result;
  });
  dbWriteQueue = task.catch(() => {});
  return task;
}

// --- Auth ---
function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function maskSecret(secret) {
  return `${secret.slice(0, 8)}...${secret.slice(-4)}`;
}

function createApiKeyRecord(secret, overrides = {}) {
  return {
    id: overrides.id || createId('key'),
    name: overrides.name || 'Automation key',
    prefix: secret.slice(0, 12),
    maskedKey: maskSecret(secret),
    hash: hashApiKey(secret),
    createdAt: overrides.createdAt || new Date().toISOString(),
    lastUsedAt: overrides.lastUsedAt || null
  };
}

function normalizeAuth(rawAuth) {
  if (!rawAuth) return { auth: null, changed: false };

  let changed = false;
  const auth = {
    username: rawAuth.username,
    passwordHash: rawAuth.passwordHash,
    apiKeys: Array.isArray(rawAuth.apiKeys) ? rawAuth.apiKeys.map(entry => {
      if (typeof entry === 'string') {
        changed = true;
        return createApiKeyRecord(entry, { name: 'Migrated key' });
      }

      if (entry && typeof entry === 'object') {
        if (entry.hash) {
          return {
            id: entry.id || createId('key'),
            name: entry.name || 'Automation key',
            prefix: entry.prefix || (entry.maskedKey ? entry.maskedKey.split('...')[0] : 'isk_'),
            maskedKey: entry.maskedKey || `${entry.prefix || 'isk_'}...`,
            hash: entry.hash,
            createdAt: entry.createdAt || new Date().toISOString(),
            lastUsedAt: entry.lastUsedAt || null
          };
        }

        if (entry.key) {
          changed = true;
          return createApiKeyRecord(entry.key, {
            id: entry.id,
            name: entry.name,
            createdAt: entry.createdAt,
            lastUsedAt: entry.lastUsedAt
          });
        }
      }

      changed = true;
      return createApiKeyRecord(`isk_${crypto.randomBytes(24).toString('hex')}`, { name: 'Recovered key' });
    }) : []
  };

  return { auth, changed };
}

function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    const { auth, changed } = normalizeAuth(raw);
    if (changed) saveAuth(auth);
    return auth;
  }
  catch { return null; }
}
function saveAuth(auth) { fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2)); }
let authWriteQueue = Promise.resolve();

function mutateAuth(mutator) {
  const task = authWriteQueue.then(async () => {
    const auth = loadAuth();
    const result = await mutator(auth);
    saveAuth(auth);
    return result;
  });
  authWriteQueue = task.catch(() => {});
  return task;
}

// Init auth on first run
if (!loadAuth()) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.error('ERROR: ADMIN_USERNAME and ADMIN_PASSWORD must be set in .env on first run.');
    console.error('Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 12);
  saveAuth({ username, passwordHash: hash, apiKeys: [] });
  console.log(`Admin account created: ${username}`);
}

// --- Middleware ---
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session tokens (in-memory)
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

function getBearerToken(req) {
  const bearer = req.headers['authorization'];
  if (bearer && bearer.startsWith('Bearer ')) return bearer.slice(7);
  return '';
}

function isSafeInlineMimeType(mimeType) {
  return mimeType.startsWith('image/') ||
    mimeType.startsWith('video/') ||
    INLINE_SAFE_MIME_TYPES.has(mimeType);
}

function makeDownloadHeader(filename) {
  const safeName = path.basename(filename).replace(/"/g, '');
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function hasFfmpeg() {
  if (hasFfmpeg.cache !== undefined) return hasFfmpeg.cache;
  try {
    await execFileAsync(FFMPEG_PATH, ['-version']);
    hasFfmpeg.cache = true;
  } catch {
    hasFfmpeg.cache = false;
  }
  return hasFfmpeg.cache;
}

function shouldTranscodeVideo(file) {
  if (!VIDEO_TRANSCODE_ENABLED) return false;
  const ext = path.extname(file.originalname).toLowerCase();
  return !VIDEO_STREAM_MIME_TYPES.has(file.mimeType) || !['.mp4', '.webm'].includes(ext);
}

async function generateVideoPoster(filePath, outputPath) {
  try {
    await execFileAsync(FFMPEG_PATH, [
      '-y',
      '-i', filePath,
      '-ss', '00:00:01.000',
      '-frames:v', '1',
      '-vf', 'scale=400:-1',
      outputPath
    ]);
    return true;
  } catch {
    return false;
  }
}

async function transcodeVideoToMp4(sourcePath, outputPath) {
  await execFileAsync(FFMPEG_PATH, [
    '-y',
    '-i', sourcePath,
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    outputPath
  ]);
}

function addPreviewMetadata(entry) {
  entry.previewUrl = entry.thumbUrl || entry.playbackUrl || entry.url;
  return entry;
}

function sendFileWithRangeSupport(req, res, filePath, mimeType, extraHeaders = {}) {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  Object.entries(extraHeaders).forEach(([key, value]) => res.setHeader(key, value));

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.status(416).end();
    return;
  }

  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
    res.end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function authMiddleware(req, res, next) {
  // Check API key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const auth = loadAuth();
    const apiKeyHash = hashApiKey(apiKey);
    const apiKeyRecord = auth.apiKeys.find(record => record.hash === apiKeyHash);
    if (apiKeyRecord) {
      req.authed = true;
      req.authType = 'apiKey';
      req.apiKeyId = apiKeyRecord.id;
      if (!apiKeyRecord.lastUsedAt || Date.now() - new Date(apiKeyRecord.lastUsedAt).getTime() > 15 * 60 * 1000) {
        mutateAuth(currentAuth => {
          const record = currentAuth.apiKeys.find(item => item.id === apiKeyRecord.id);
          if (record) record.lastUsedAt = new Date().toISOString();
        }).catch(() => {});
      }
      return next();
    }
  }
  // Check Bearer token
  const bearerToken = getBearerToken(req);
  if (bearerToken) {
    const session = sessions.get(bearerToken);
    if (session && Date.now() < session.expires) {
      req.authed = true;
      req.authType = 'token';
      req.sessionToken = bearerToken;
      return next();
    }
  }
  // Check cookie
  const cookieToken = req.cookies?.token;
  if (cookieToken) {
    const session = sessions.get(cookieToken);
    if (session && Date.now() < session.expires) {
      req.authed = true;
      req.authType = 'cookie';
      req.sessionToken = cookieToken;
      return next();
    }
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// --- File ID generation ---
function generateId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}

// --- Multer setup ---
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = generateId();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// --- Thumbnail generation ---
async function generateThumb(filePath, thumbPath) {
  try {
    await sharp(filePath)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);
    return true;
  } catch { return false; }
}

// --- Detect file type category ---
function getCategory(mimeType) {
  if (!mimeType) return 'other';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/') || mimeType === 'application/pdf') return 'document';
  return 'other';
}

// ==================== PUBLIC ROUTES ====================

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: APP_VERSION, time: new Date().toISOString() });
});

app.get('/api/meta', async (req, res) => {
  res.json({
    name: pkg.name,
    version: APP_VERSION,
    baseUrl: BASE_URL,
    docsUrl: `${BASE_URL}/api/openapi.json`,
    uiUrl: `${BASE_URL}/`,
    maxFileSize: MAX_FILE_SIZE,
    features: {
      videoTranscode: VIDEO_TRANSCODE_ENABLED,
      ffmpegAvailable: await hasFfmpeg()
    },
    auth: ['cookie', 'bearer', 'x-api-key']
  });
});

const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Novel Object Storage API',
    version: APP_VERSION,
    description: 'CLI-oriented object storage API for human operators and automation agents.'
  },
  servers: [{ url: BASE_URL }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'token' }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error']
      },
      Ok: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok']
      },
      FileEntry: {
        type: 'object',
        required: ['id', 'filename', 'originalName', 'mimeType', 'category', 'size', 'url', 'uploadedAt'],
        properties: {
          id: { type: 'string' },
          filename: { type: 'string' },
          originalName: { type: 'string' },
          mimeType: { type: 'string' },
          category: { type: 'string', enum: ['image', 'video', 'document', 'other'] },
          size: { type: 'integer' },
          url: { type: 'string', format: 'uri' },
          thumbUrl: { type: ['string', 'null'], format: 'uri' },
          previewUrl: { type: ['string', 'null'], format: 'uri' },
          playbackUrl: { type: ['string', 'null'], format: 'uri' },
          playbackMimeType: { type: 'string' },
          playbackSize: { type: 'integer' },
          derivedFilename: { type: ['string', 'null'] },
          transcoded: { type: 'boolean' },
          uploadedAt: { type: 'string', format: 'date-time' },
          tags: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' }
        }
      },
      FileList: {
        type: 'object',
        required: ['files', 'total', 'page', 'limit', 'pages'],
        properties: {
          files: { type: 'array', items: { $ref: '#/components/schemas/FileEntry' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          limit: { type: 'integer' },
          pages: { type: 'integer' }
        }
      },
      UploadResponse: {
        type: 'object',
        required: ['ok', 'files'],
        properties: {
          ok: { type: 'boolean' },
          files: { type: 'array', items: { $ref: '#/components/schemas/FileEntry' } }
        }
      },
      ApiKeySummary: {
        type: 'object',
        required: ['id', 'name', 'maskedKey', 'prefix', 'createdAt'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          maskedKey: { type: 'string' },
          prefix: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: { type: ['string', 'null'], format: 'date-time' }
        }
      },
      ApiKeyCreateResponse: {
        type: 'object',
        required: ['ok', 'key', 'apiKey'],
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string', description: 'Plaintext secret, shown only once at creation.' },
          apiKey: { $ref: '#/components/schemas/ApiKeySummary' }
        }
      },
      HealthResponse: {
        type: 'object',
        required: ['ok', 'version', 'time'],
        properties: {
          ok: { type: 'boolean' },
          version: { type: 'string' },
          time: { type: 'string', format: 'date-time' }
        }
      },
      MetaResponse: {
        type: 'object',
        required: ['name', 'version', 'baseUrl', 'maxFileSize', 'auth'],
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          baseUrl: { type: 'string', format: 'uri' },
          docsUrl: { type: 'string', format: 'uri' },
          uiUrl: { type: 'string', format: 'uri' },
          maxFileSize: { type: 'integer' },
          features: {
            type: 'object',
            properties: {
              videoTranscode: { type: 'boolean' },
              ffmpegAvailable: { type: 'boolean' }
            }
          },
          auth: { type: 'array', items: { type: 'string' } }
        }
      },
      StatsResponse: {
        type: 'object',
        required: ['totalFiles', 'totalSize', 'totalSizeHuman', 'categories'],
        properties: {
          totalFiles: { type: 'integer' },
          totalSize: { type: 'integer' },
          totalSizeHuman: { type: 'string' },
          categories: { type: 'object', additionalProperties: { type: 'integer' } }
        }
      },
      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' }
        }
      },
      LoginResponse: {
        type: 'object',
        required: ['ok', 'token'],
        properties: {
          ok: { type: 'boolean' },
          token: { type: 'string' }
        }
      },
      FilePatchRequest: {
        type: 'object',
        properties: {
          tags: {
            oneOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string', description: 'Comma-separated list.' }
            ]
          },
          description: { type: 'string' }
        }
      },
      ApiKeyCreateRequest: {
        type: 'object',
        properties: {
          name: { type: 'string' }
        }
      }
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid credentials.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
      },
      NotFound: {
        description: 'Resource not found.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
      }
    },
    parameters: {
      FileId: {
        name: 'id', in: 'path', required: true,
        schema: { type: 'string' }
      },
      ApiKeyId: {
        name: 'id', in: 'path', required: true,
        schema: { type: 'string' }
      }
    }
  },
  security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }],
  paths: {
    '/api/health': {
      get: {
        summary: 'Health check',
        security: [],
        responses: {
          '200': {
            description: 'Service is up.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } }
          }
        }
      }
    },
    '/api/meta': {
      get: {
        summary: 'Service metadata',
        security: [],
        responses: {
          '200': {
            description: 'Runtime configuration and feature flags.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MetaResponse' } } }
          }
        }
      }
    },
    '/api/openapi.json': {
      get: {
        summary: 'OpenAPI 3.1 document',
        security: [],
        responses: { '200': { description: 'OpenAPI document.' } }
      }
    },
    '/api/login': {
      post: {
        summary: 'Create a session and return a bearer token',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } }
        },
        responses: {
          '200': {
            description: 'Login succeeded.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/api/logout': {
      post: {
        summary: 'Revoke the current session token or cookie session',
        responses: {
          '200': {
            description: 'Session revoked.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } }
          }
        }
      }
    },
    '/api/upload': {
      post: {
        summary: 'Upload one or more files',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['files'],
                properties: {
                  files: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                    description: 'One or more files (field name must be "files").'
                  },
                  tags: { type: 'string', description: 'Comma-separated tags applied to every uploaded file.' },
                  description: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Files uploaded.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadResponse' } } }
          },
          '400': { description: 'No files supplied or invalid request.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '413': { description: 'File exceeds MAX_FILE_SIZE.' }
        }
      }
    },
    '/api/files': {
      get: {
        summary: 'List files',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'category', in: 'query', schema: { type: 'string', enum: ['image', 'video', 'document', 'other'] } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search filename, description, tags.' }
        ],
        responses: {
          '200': {
            description: 'Paginated list of files.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FileList' } } }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/api/files/{id}': {
      get: {
        summary: 'Get file metadata',
        parameters: [{ $ref: '#/components/parameters/FileId' }],
        responses: {
          '200': {
            description: 'File metadata.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FileEntry' } } }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        summary: 'Update file metadata',
        parameters: [{ $ref: '#/components/parameters/FileId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/FilePatchRequest' } } }
        },
        responses: {
          '200': {
            description: 'Updated file metadata.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FileEntry' } } }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      delete: {
        summary: 'Delete a file',
        parameters: [{ $ref: '#/components/parameters/FileId' }],
        responses: {
          '200': {
            description: 'File deleted.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/api/stats': {
      get: {
        summary: 'Get storage statistics',
        responses: {
          '200': {
            description: 'Aggregate statistics.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StatsResponse' } } }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/api/keys': {
      get: {
        summary: 'List API keys',
        responses: {
          '200': {
            description: 'API key summaries (hash and plaintext are not returned).',
            content: { 'application/json': {
              schema: {
                type: 'object',
                required: ['keys'],
                properties: { keys: { type: 'array', items: { $ref: '#/components/schemas/ApiKeySummary' } } }
              }
            } }
          }
        }
      },
      post: {
        summary: 'Create an API key',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreateRequest' } } }
        },
        responses: {
          '201': {
            description: 'API key created. Plaintext secret is returned only once.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreateResponse' } } }
          }
        }
      }
    },
    '/api/keys/{id}': {
      delete: {
        summary: 'Revoke an API key by id',
        parameters: [{ $ref: '#/components/parameters/ApiKeyId' }],
        responses: {
          '200': {
            description: 'Key revoked.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/f/{filename}': {
      get: {
        summary: 'Download the raw public object',
        security: [],
        parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Binary file. Supports Range requests.' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/thumb/{filename}': {
      get: {
        summary: 'Fetch a generated image/video thumbnail',
        security: [],
        parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'JPEG thumbnail.' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/derived/{filename}': {
      get: {
        summary: 'Fetch a transcoded MP4 derivative',
        security: [],
        parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Derived MP4 file. Supports Range requests.' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    }
  }
};

app.get('/api/openapi.json', (req, res) => {
  res.json(OPENAPI_SPEC);
});

// Serve files publicly
app.get('/f/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // sanitize
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable'
  };
  if (!isSafeInlineMimeType(mimeType) || ACTIVE_CONTENT_TYPES.has(mimeType)) {
    headers['Content-Disposition'] = makeDownloadHeader(filename);
  }
  sendFileWithRangeSupport(req, res, filePath, mimeType, headers);
});

app.get('/derived/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DERIVED_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  sendFileWithRangeSupport(req, res, filePath, mimeType, {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
});

// Serve thumbnails publicly
app.get('/thumb/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const thumbPath = path.join(THUMB_DIR, filename);
  if (!fs.existsSync(thumbPath)) return res.status(404).json({ error: 'Not found' });
  sendFileWithRangeSupport(req, res, thumbPath, 'image/jpeg', {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
});

// ==================== AUTH ROUTES ====================

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const auth = loadAuth();
  if (username !== auth.username || !bcrypt.compareSync(password, auth.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateToken();
  sessions.set(token, { expires: Date.now() + TOKEN_EXPIRY });
  res.cookie('token', token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', maxAge: TOKEN_EXPIRY });
  res.json({ ok: true, token });
});

app.post('/api/logout', (req, res) => {
  const cookieToken = req.cookies?.token;
  const bearerToken = getBearerToken(req);
  if (cookieToken) sessions.delete(cookieToken);
  if (bearerToken) sessions.delete(bearerToken);
  res.clearCookie('token', { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict' });
  res.json({ ok: true });
});

app.post('/api/keys', authMiddleware, async (req, res) => {
  const name = typeof req.body?.name === 'string' && req.body.name.trim()
    ? req.body.name.trim()
    : 'Automation key';
  const key = `isk_${crypto.randomBytes(24).toString('hex')}`;
  const record = createApiKeyRecord(key, { name });
  await mutateAuth(auth => {
    auth.apiKeys.push(record);
  });
  res.status(201).json({
    ok: true,
    key,
    apiKey: {
      id: record.id,
      name: record.name,
      maskedKey: record.maskedKey,
      prefix: record.prefix,
      createdAt: record.createdAt
    }
  });
});

app.get('/api/keys', authMiddleware, (req, res) => {
  const auth = loadAuth();
  res.json({
    keys: auth.apiKeys.map(record => ({
      id: record.id,
      name: record.name,
      maskedKey: record.maskedKey,
      prefix: record.prefix,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt
    }))
  });
});

app.delete('/api/keys/:id', authMiddleware, async (req, res) => {
  const deleted = await mutateAuth(auth => {
    const before = auth.apiKeys.length;
    auth.apiKeys = auth.apiKeys.filter(record => record.id !== req.params.id);
    return auth.apiKeys.length !== before;
  });
  if (!deleted) return res.status(404).json({ error: 'API key not found' });
  res.json({ ok: true });
});

// ==================== API ROUTES (AUTH REQUIRED) ====================

app.post('/api/upload', authMiddleware, upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files supplied. Attach at least one file under the "files" field.' });
  }
  const tags = typeof req.body.tags === 'string'
    ? req.body.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  const ffmpegReady = await hasFfmpeg();
  const results = await mutateDB(async db => {
    const entries = [];

    for (const file of req.files) {
      const id = path.basename(file.filename, path.extname(file.filename));
      const mimeType = mime.lookup(file.originalname) || mime.lookup(file.filename) || 'application/octet-stream';
      const category = getCategory(mimeType);

      const entry = {
        id,
        filename: file.filename,
        originalName: file.originalname,
        mimeType,
        category,
        size: file.size,
        url: `${BASE_URL}/f/${file.filename}`,
        thumbUrl: null,
        playbackUrl: null,
        derivedFilename: null,
        transcoded: false,
        uploadedAt: new Date().toISOString(),
        tags,
        description
      };

      if (category === 'image') {
        const thumbName = `${id}.jpg`;
        const hasThumb = await generateThumb(file.path, path.join(THUMB_DIR, thumbName));
        if (hasThumb) entry.thumbUrl = `${BASE_URL}/thumb/${thumbName}`;
      }

      if (category === 'video') {
        const posterName = `${id}.jpg`;
        if (ffmpegReady) {
          const hasPoster = await generateVideoPoster(file.path, path.join(THUMB_DIR, posterName));
          if (hasPoster) entry.thumbUrl = `${BASE_URL}/thumb/${posterName}`;
        }

        entry.playbackUrl = entry.url;
        if (ffmpegReady && shouldTranscodeVideo({ ...file, mimeType })) {
          const derivedFilename = `${id}.mp4`;
          const derivedPath = path.join(DERIVED_DIR, derivedFilename);
          try {
            await transcodeVideoToMp4(file.path, derivedPath);
            const derivedStat = fs.statSync(derivedPath);
            entry.playbackUrl = `${BASE_URL}/derived/${derivedFilename}`;
            entry.derivedFilename = derivedFilename;
            entry.transcoded = true;
            entry.playbackMimeType = 'video/mp4';
            entry.playbackSize = derivedStat.size;
            db.stats.totalSize += derivedStat.size;
          } catch {}
        }
      }

      addPreviewMetadata(entry);
      db.files[id] = entry;
      db.stats.totalFiles++;
      db.stats.totalSize += file.size;
      entries.push(entry);
    }

    return entries;
  });
  res.json({ ok: true, files: results });
});

app.get('/api/files', authMiddleware, (req, res) => {
  const db = loadDB();
  let files = Object.values(db.files);

  if (req.query.category) files = files.filter(f => f.category === req.query.category);
  if (req.query.tag) {
    const tag = req.query.tag;
    files = files.filter(f => Array.isArray(f.tags) && f.tags.includes(tag));
  }
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    files = files.filter(f =>
      (f.originalName || '').toLowerCase().includes(q) ||
      (f.description || '').toLowerCase().includes(q) ||
      (Array.isArray(f.tags) && f.tags.some(t => String(t).toLowerCase().includes(q)))
    );
  }

  files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  const pageRaw = parseInt(req.query.page, 10);
  const limitRaw = parseInt(req.query.limit, 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const total = files.length;
  files = files.slice((page - 1) * limit, page * limit);

  res.json({ files, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
});

function getFile(db, id) {
  return Object.prototype.hasOwnProperty.call(db.files, id) ? db.files[id] : null;
}

app.get('/api/files/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const file = getFile(db, req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.patch('/api/files/:id', authMiddleware, async (req, res) => {
  const tags = req.body.tags;
  const description = req.body.description;
  try {
    const updated = await mutateDB(db => {
      const record = getFile(db, req.params.id);
      if (!record) return null;
      if (Array.isArray(tags)) record.tags = tags.map(tag => String(tag).trim()).filter(Boolean);
      else if (typeof tags === 'string') record.tags = tags.split(',').map(tag => tag.trim()).filter(Boolean);
      if (description !== undefined) record.description = String(description).trim();
      addPreviewMetadata(record);
      return record;
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update file' });
  }
});

app.delete('/api/files/:id', authMiddleware, async (req, res) => {
  const file = await mutateDB(db => {
    const record = getFile(db, req.params.id);
    if (!record) return null;
    db.stats.totalFiles = Math.max(0, db.stats.totalFiles - 1);
    db.stats.totalSize = Math.max(0, db.stats.totalSize - record.size - (record.playbackSize || 0));
    delete db.files[record.id];
    return record;
  });
  if (!file) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, file.filename)); } catch {}
  try { fs.unlinkSync(path.join(THUMB_DIR, `${file.id}.jpg`)); } catch {}
  if (file.derivedFilename) {
    try { fs.unlinkSync(path.join(DERIVED_DIR, file.derivedFilename)); } catch {}
  }
  res.json({ ok: true });
});

app.get('/api/stats', authMiddleware, (req, res) => {
  const db = loadDB();
  const files = Object.values(db.files);
  const categories = {};
  files.forEach(f => { categories[f.category] = (categories[f.category] || 0) + 1; });
  res.json({
    totalFiles: db.stats.totalFiles,
    totalSize: db.stats.totalSize,
    totalSizeHuman: formatBytes(db.stats.totalSize),
    categories
  });
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== WEB UI ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Max size is ${MAX_FILE_SIZE} bytes.` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(500).json({ error: 'Internal server error' });
  return next();
});

app.listen(PORT, HOST, () => {
  console.log(`Novel Object Storage running on ${HOST}:${PORT}`);
  console.log(`Public URL: ${BASE_URL}${process.env.BASE_URL ? '' : ' (auto-detected — set BASE_URL to override)'}`);
  console.log(`Version: ${APP_VERSION}`);
});
