const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const mime = require('mime-types');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');

// --- Load .env if dotenv is available ---
try { require('dotenv').config(); } catch {}

const app = express();
const PORT = parseInt(process.env.PORT) || 4000;
const HOST = process.env.HOST || '127.0.0.1';

// --- Config from env ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'files');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024; // 500MB
const TOKEN_EXPIRY = parseInt(process.env.TOKEN_EXPIRY) || 7 * 24 * 60 * 60 * 1000; // 7 days

// Ensure dirs
[DATA_DIR, UPLOAD_DIR, THUMB_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// --- DB ---
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch { return { files: {}, stats: { totalFiles: 0, totalSize: 0 } }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// --- Auth ---
function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
  catch { return null; }
}
function saveAuth(auth) { fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2)); }

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

function authMiddleware(req, res, next) {
  // Check API key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const auth = loadAuth();
    if (auth.apiKeys && auth.apiKeys.includes(apiKey)) {
      req.authed = true;
      return next();
    }
  }
  // Check Bearer token
  const bearer = req.headers['authorization'];
  if (bearer && bearer.startsWith('Bearer ')) {
    const token = bearer.slice(7);
    const session = sessions.get(token);
    if (session && Date.now() < session.expires) {
      req.authed = true;
      return next();
    }
  }
  // Check cookie
  const cookieToken = req.cookies?.token;
  if (cookieToken) {
    const session = sessions.get(cookieToken);
    if (session && Date.now() < session.expires) {
      req.authed = true;
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

// Serve files publicly
app.get('/f/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // sanitize
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(filePath).pipe(res);
});

// Serve thumbnails publicly
app.get('/thumb/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const thumbPath = path.join(THUMB_DIR, filename);
  if (!fs.existsSync(thumbPath)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(thumbPath).pipe(res);
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
  res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: TOKEN_EXPIRY });
  res.json({ ok: true, token });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.token;
  if (token) sessions.delete(token);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.post('/api/keys', authMiddleware, (req, res) => {
  const key = `isk_${crypto.randomBytes(24).toString('hex')}`;
  const auth = loadAuth();
  auth.apiKeys.push(key);
  saveAuth(auth);
  res.json({ key });
});

app.get('/api/keys', authMiddleware, (req, res) => {
  const auth = loadAuth();
  res.json({ keys: auth.apiKeys.map(k => `${k.slice(0, 8)}...${k.slice(-4)}`) });
});

app.delete('/api/keys/:key', authMiddleware, (req, res) => {
  const auth = loadAuth();
  auth.apiKeys = auth.apiKeys.filter(k => k !== req.params.key);
  saveAuth(auth);
  res.json({ ok: true });
});

// ==================== API ROUTES (AUTH REQUIRED) ====================

app.post('/api/upload', authMiddleware, upload.array('files', 50), async (req, res) => {
  const db = loadDB();
  const results = [];

  for (const file of req.files) {
    const id = path.basename(file.filename, path.extname(file.filename));
    const mimeType = mime.lookup(file.originalname) || 'application/octet-stream';
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
      uploadedAt: new Date().toISOString(),
      tags: req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : [],
      description: req.body.description || ''
    };

    if (category === 'image') {
      const thumbName = `${id}.jpg`;
      const hasThumb = await generateThumb(file.path, path.join(THUMB_DIR, thumbName));
      if (hasThumb) entry.thumbUrl = `${BASE_URL}/thumb/${thumbName}`;
    }

    db.files[id] = entry;
    db.stats.totalFiles++;
    db.stats.totalSize += file.size;
    results.push(entry);
  }

  saveDB(db);
  res.json({ ok: true, files: results });
});

app.get('/api/files', authMiddleware, (req, res) => {
  const db = loadDB();
  let files = Object.values(db.files);
  
  if (req.query.category) files = files.filter(f => f.category === req.query.category);
  if (req.query.tag) files = files.filter(f => f.tags.includes(req.query.tag));
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    files = files.filter(f => 
      f.originalName.toLowerCase().includes(q) || 
      f.description.toLowerCase().includes(q) ||
      f.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const total = files.length;
  files = files.slice((page - 1) * limit, page * limit);

  res.json({ files, total, page, limit, pages: Math.ceil(total / limit) });
});

app.get('/api/files/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const file = db.files[req.params.id];
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.patch('/api/files/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const file = db.files[req.params.id];
  if (!file) return res.status(404).json({ error: 'Not found' });
  if (req.body.tags) file.tags = req.body.tags;
  if (req.body.description !== undefined) file.description = req.body.description;
  saveDB(db);
  res.json(file);
});

app.delete('/api/files/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const file = db.files[req.params.id];
  if (!file) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, file.filename)); } catch {}
  try { fs.unlinkSync(path.join(THUMB_DIR, `${file.id}.jpg`)); } catch {}
  db.stats.totalFiles--;
  db.stats.totalSize -= file.size;
  delete db.files[file.id];
  saveDB(db);
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

app.listen(PORT, HOST, () => {
  console.log(`Image Store running on ${HOST}:${PORT}`);
  console.log(`Public URL: ${BASE_URL}`);
});
