const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const USING_DEFAULT_DATA_DIR = !process.env.DATA_DIR;
const SLIPS_DIR = path.join(DATA_DIR, 'slips');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SLIPS_DIR)) fs.mkdirSync(SLIPS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'bookings.db');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const BANK_INFO = {
  bank: process.env.BANK_NAME || 'ธนาคารไทยพาณิชย์ (SCB)',
  account_name: process.env.BANK_ACCOUNT_NAME || 'สถานีทุเรียนไอยรา',
  account_number: process.env.BANK_ACCOUNT_NUMBER || '161-5-xxxxx-x',
  price_per_person: Number(process.env.PRICE_PER_PERSON || 199),
};

const SLOT_CAPACITY = 100;
const MAX_PEOPLE_PER_BOOKING = 5;
const TIME_SLOTS = [
  '10:00', '11:00', '12:00', '13:00', '14:00',
  '15:00', '16:00', '17:00', '18:00', '19:00',
];
const DEFAULT_BOOKING_RANGE = { start: '2026-05-15', end: '2026-05-24' };
// BOOKING_DATES is computed from settings after the DB opens — see refreshBookingDates() below.
let BOOKING_DATES = [];

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function getSetting(key, defaultValue = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

// ─── Admin credentials (env-default with optional DB override) ─────────
// Initial credentials come from Railway env (ADMIN_USER, ADMIN_PASS).
// Admin can override via UI — stored as scrypt hash in settings table.
// "คืนค่าจาก Railway" deletes the override → fall back to env values.
function hashPassword(plain, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyHashedPassword(plain, hashHex, salt) {
  try {
    const computed = crypto.scryptSync(plain, salt, 64);
    const stored   = Buffer.from(hashHex, 'hex');
    if (computed.length !== stored.length) return false;
    return crypto.timingSafeEqual(computed, stored);
  } catch { return false; }
}
function getAdminCreds() {
  const hash = getSetting('admin_pass_hash', '');
  const salt = getSetting('admin_pass_salt', '');
  const userOverride = getSetting('admin_user_override', '');
  if (hash && salt) {
    return { user: userOverride || ADMIN_USER, mode: 'db', hash, salt };
  }
  return { user: ADMIN_USER, mode: 'env', plain: ADMIN_PASS };
}
function checkAdminPassword(plain) {
  if (typeof plain !== 'string') return false;
  const c = getAdminCreds();
  if (c.mode === 'db') return verifyHashedPassword(plain, c.hash, c.salt);
  // env mode — constant-time compare with the plaintext from env
  const a = Buffer.from(plain);
  const b = Buffer.from(c.plain);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Site settings: booking date range + manual open toggle ────────────
function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isValidISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime());
}
function computeBookingDates() {
  const start = getSetting('booking_start_date', DEFAULT_BOOKING_RANGE.start);
  const end   = getSetting('booking_end_date',   DEFAULT_BOOKING_RANGE.end);
  if (!isValidISODate(start) || !isValidISODate(end)) return [];
  const startD = new Date(start + 'T00:00:00');
  const endD   = new Date(end   + 'T00:00:00');
  if (startD > endD) return [];
  const out = [];
  for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}
function refreshBookingDates() {
  BOOKING_DATES = computeBookingDates();
}
refreshBookingDates();

// Returns one of: 'open' | 'closed-pre' | 'closed-post' | 'closed-manual'
// + helpers to consume on the customer side.
function getSiteState() {
  const start = getSetting('booking_start_date', DEFAULT_BOOKING_RANGE.start);
  const end   = getSetting('booking_end_date',   DEFAULT_BOOKING_RANGE.end);
  const manualMode = getSetting('site_manual_mode', 'auto'); // 'auto' | 'open' | 'closed'
  const today = todayLocalISO();

  let withinRange = false;
  if (isValidISODate(start) && isValidISODate(end)) {
    withinRange = today >= start && today <= end;
  }
  let state;
  if (manualMode === 'open')   state = 'open';
  else if (manualMode === 'closed') state = 'closed-manual';
  else state = withinRange ? 'open' : (today < start ? 'closed-pre' : 'closed-post');

  return {
    state,
    is_open: state === 'open',
    booking_start_date: start,
    booking_end_date:   end,
    manual_mode: manualMode,
    server_now:    new Date().toISOString(),
    today,
  };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    phone           TEXT NOT NULL,
    email           TEXT NOT NULL,
    num_people      INTEGER NOT NULL,
    booking_date    TEXT NOT NULL,
    time_slot       TEXT NOT NULL,
    payment_status  TEXT NOT NULL DEFAULT 'pending',
    slip_path       TEXT,
    slip_uploaded_at TEXT,
    verified_at     TEXT,
    rejected_reason TEXT,
    original_date   TEXT,
    original_time   TEXT,
    transferred_at  TEXT,
    used            INTEGER NOT NULL DEFAULT 0,
    used_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_slot   ON bookings(booking_date, time_slot);
  CREATE INDEX IF NOT EXISTS idx_code   ON bookings(code);
  CREATE INDEX IF NOT EXISTS idx_phone  ON bookings(phone);

  CREATE TABLE IF NOT EXISTS system_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action          TEXT NOT NULL,
    details         TEXT,
    bookings_before INTEGER,
    bookings_after  INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_log_created ON system_log(created_at DESC);
`);

// ─── Idempotent migrations for existing DBs ─────────────────
(function migrate() {
  const cols = db.prepare(`PRAGMA table_info(bookings)`).all().map(c => c.name);
  const adds = [
    ['payment_status', `TEXT NOT NULL DEFAULT 'pending'`],
    ['slip_path', `TEXT`],
    ['slip_uploaded_at', `TEXT`],
    ['verified_at', `TEXT`],
    ['rejected_reason', `TEXT`],
    ['original_date', `TEXT`],
    ['original_time', `TEXT`],
    ['transferred_at', `TEXT`],
    ['slip_ref', `TEXT`],
    ['slip_transfer_at', `TEXT`],
  ];
  for (const [name, def] of adds) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${def}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_slip_ref ON bookings(slip_ref);`);
})();

// ─── System log helper ──────────────────────────────────────
function logSys(action, details, bookingsBefore, bookingsAfter) {
  try {
    db.prepare(`
      INSERT INTO system_log (action, details, bookings_before, bookings_after)
      VALUES (?, ?, ?, ?)
    `).run(action, details ? JSON.stringify(details) : null, bookingsBefore ?? null, bookingsAfter ?? null);
  } catch (e) {
    console.error('logSys failed:', e.message);
  }
}

app.use(express.json());
app.use(express.static(__dirname, { index: false })); // serve index.html via route below
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── helpers ────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(0, chars.length)];
    const exists = db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code);
    if (!exists) return code;
  }
  throw new Error('Could not generate unique code');
}

const normalizePhone = p => String(p || '').replace(/[\s\-+()]/g, '');

function slotUsage(date, time) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(num_people), 0) AS total
    FROM bookings
    WHERE booking_date = ? AND time_slot = ?
      AND payment_status NOT IN ('rejected', 'cancelled')
  `).get(date, time);
  return row.total;
}

// Strip sensitive fields and hide code until payment is verified.
function publicView(b) {
  if (!b) return null;
  const out = { ...b };
  delete out.slip_path;
  if (b.payment_status !== 'verified') out.code = null;
  out.has_slip = !!b.slip_path;
  return out;
}

function validateBooking(b) {
  const errors = {};
  const people = Number(b.num_people);
  if (!Number.isInteger(people) || people < 1 || people > MAX_PEOPLE_PER_BOOKING) {
    errors.num_people = `จำนวนคนต้องอยู่ระหว่าง 1-${MAX_PEOPLE_PER_BOOKING}`;
  }
  if (!BOOKING_DATES.includes(b.booking_date)) errors.booking_date = 'วันที่ไม่ถูกต้อง';
  if (!TIME_SLOTS.includes(b.time_slot)) errors.time_slot = 'รอบเวลาไม่ถูกต้อง';
  if (!b.name || !String(b.name).trim()) errors.name = 'กรุณากรอกชื่อ-นามสกุล';
  if (!/^[0-9\-+\s()]{9,15}$/.test(String(b.phone || '').trim())) errors.phone = 'เบอร์โทรไม่ถูกต้อง';
  // Email is optional — validate format only when provided
  const email = String(b.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'รูปแบบอีเมลไม่ถูกต้อง';
  return errors;
}

// ─── Multer for slip uploads ────────────────────────────────────────────
const slipUpload = multer({
  storage: multer.diskStorage({
    destination: SLIPS_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 8);
      const safe = ext.replace(/[^a-z0-9.]/g, '');
      cb(null, `${req.params.id || 'x'}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safe || '.jpg'}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('invalid_type'), ok);
  },
});

function unlinkSlip(filename) {
  if (!filename) return;
  try { fs.unlinkSync(path.join(SLIPS_DIR, filename)); } catch {}
}

// ─── Payment image (single file at DATA_DIR/payment.<ext>) ─────────────
const PAYMENT_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
function findPaymentImage() {
  for (const ext of PAYMENT_EXTS) {
    const p = path.join(DATA_DIR, `payment.${ext}`);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}
const paymentUpload = multer({
  storage: multer.diskStorage({
    destination: DATA_DIR,
    filename: (req, file, cb) => {
      const raw = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(1).replace(/[^a-z0-9]/g, '');
      const safe = PAYMENT_EXTS.includes(raw) ? raw : 'jpg';
      cb(null, `payment.${safe}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp)$/i.test(file.mimetype);
    cb(ok ? null : new Error('invalid_type'), ok);
  },
});

// ─── Banner image (single file at DATA_DIR/banner.<ext>) ────────────────
const BANNER_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
function findBanner() {
  for (const ext of BANNER_EXTS) {
    const p = path.join(DATA_DIR, `banner.${ext}`);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}
const bannerUpload = multer({
  storage: multer.diskStorage({
    destination: DATA_DIR,
    filename: (req, file, cb) => {
      const raw = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(1).replace(/[^a-z0-9]/g, '');
      const safe = BANNER_EXTS.includes(raw) ? raw : 'jpg';
      cb(null, `banner.${safe}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — banners can be large
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('invalid_type'), ok);
  },
});

// ─── Admin auth ─────────────────────────────────────────────────────────
const adminTokens = new Set();
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !adminTokens.has(token)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const creds = getAdminCreds();
  if (typeof username === 'string' && username === creds.user && checkAdminPassword(password)) {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'invalid credentials' });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  adminTokens.delete(req.headers.authorization.slice(7));
  res.status(204).end();
});

// ─── Admin account: view + change password + reset to env ──────────────
app.get('/api/admin/account', requireAdmin, (req, res) => {
  const c = getAdminCreds();
  res.json({
    user: c.user,
    mode: c.mode, // 'env' = ใช้ค่าจาก Railway · 'db' = override ใน DB
    env_user: ADMIN_USER,
    is_default_pass: c.mode === 'env' && ADMIN_PASS === 'admin123',
    pass_updated_at: c.mode === 'db'
      ? (db.prepare('SELECT updated_at FROM settings WHERE key = ?').get('admin_pass_hash')?.updated_at || null)
      : null,
  });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const current = String(req.body?.current_password || '');
  const next    = String(req.body?.new_password || '');
  const newUser = req.body?.new_username != null ? String(req.body.new_username).trim() : null;

  if (!current || !next) return res.status(400).json({ error: 'missing_fields' });
  if (next.length < 6) return res.status(400).json({ error: 'weak_password', message: 'รหัสใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
  if (!checkAdminPassword(current)) return res.status(401).json({ error: 'wrong_current_password', message: 'รหัสปัจจุบันไม่ถูกต้อง' });

  const { hash, salt } = hashPassword(next);
  setSetting('admin_pass_hash', hash);
  setSetting('admin_pass_salt', salt);
  if (newUser) setSetting('admin_user_override', newUser);

  // Force re-login on every active session
  adminTokens.clear();
  logSys('admin_password_change', { user_changed: !!newUser, new_user: newUser || null });

  const c = getAdminCreds();
  res.json({ ok: true, mode: c.mode, user: c.user });
});

app.post('/api/admin/reset-password', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM settings WHERE key IN ('admin_pass_hash', 'admin_pass_salt', 'admin_user_override')`).run();
  adminTokens.clear();
  logSys('admin_password_reset', null);
  res.json({ ok: true, mode: 'env', user: ADMIN_USER });
});

// ─── Banner (public read, admin write) ──────────────────────────────────
app.get('/banner', (req, res) => {
  const found = findBanner();
  if (!found) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=60');
  res.sendFile(found.path);
});

app.get('/api/banner', (req, res) => {
  const found = findBanner();
  if (!found) return res.json({ exists: false });
  const stat = fs.statSync(found.path);
  res.json({
    exists: true,
    ext: found.ext,
    size: stat.size,
    uploaded_at: stat.mtime.toISOString(),
  });
});

app.post('/api/admin/banner', requireAdmin, (req, res, next) => {
  bannerUpload.single('banner')(req, res, (err) => {
    if (err) {
      if (err.message === 'invalid_type') return res.status(400).json({ error: 'invalid_type', message: 'รองรับเฉพาะรูปภาพ JPG/PNG/WEBP/HEIC' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'too_large', message: 'ไฟล์ใหญ่เกิน 10MB' });
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'กรุณาเลือกไฟล์ banner' });
  // Drop other-extension banners — keep only the one we just wrote
  for (const ext of BANNER_EXTS) {
    const p = path.join(DATA_DIR, `banner.${ext}`);
    if (p !== req.file.path && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
  const stat = fs.statSync(req.file.path);
  res.json({
    exists: true,
    ext: path.extname(req.file.filename).slice(1),
    size: stat.size,
    uploaded_at: stat.mtime.toISOString(),
  });
});

// ─── Payment settings (public read, admin write) ────────────────────────
app.get('/api/payment-info', (req, res) => {
  const found = findPaymentImage();
  res.json({
    top_text: getSetting('payment_top_text', ''),
    has_image: !!found,
    image_uploaded_at: found ? fs.statSync(found.path).mtime.toISOString() : null,
  });
});

app.get('/payment-image', (req, res) => {
  const found = findPaymentImage();
  if (!found) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=60');
  res.sendFile(found.path);
});

app.post('/api/admin/payment-settings', requireAdmin, (req, res, next) => {
  paymentUpload.single('image')(req, res, (err) => {
    if (err) {
      if (err.message === 'invalid_type') return res.status(400).json({ error: 'invalid_type', message: 'รองรับเฉพาะรูปภาพ JPG/PNG/WEBP' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'too_large', message: 'ไฟล์ใหญ่เกิน 10MB' });
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    next();
  });
}, (req, res) => {
  const topText = String(req.body.top_text || '').trim();
  setSetting('payment_top_text', topText);

  if (req.file) {
    // Drop other-extension files so only the new one remains
    for (const ext of PAYMENT_EXTS) {
      const p = path.join(DATA_DIR, `payment.${ext}`);
      if (p !== req.file.path && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  }

  const found = findPaymentImage();
  res.json({
    top_text: topText,
    has_image: !!found,
    image_uploaded_at: found ? fs.statSync(found.path).mtime.toISOString() : null,
  });
});

app.delete('/api/admin/payment-image', requireAdmin, (req, res) => {
  let removed = 0;
  for (const ext of PAYMENT_EXTS) {
    const p = path.join(DATA_DIR, `payment.${ext}`);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); removed++; } catch {}
    }
  }
  res.json({ removed });
});

// ─── Site state (public) + site settings (admin) ────────────────────────
app.get('/api/site-state', (req, res) => {
  res.json(getSiteState());
});

app.get('/api/admin/site-settings', requireAdmin, (req, res) => {
  res.json({
    ...getSiteState(),
    booking_dates: BOOKING_DATES,
  });
});

app.post('/api/admin/site-settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  const errors = {};

  let start = body.booking_start_date;
  let end   = body.booking_end_date;
  if (start !== undefined) {
    if (!isValidISODate(start)) errors.booking_start_date = 'รูปแบบวันที่ไม่ถูกต้อง';
  }
  if (end !== undefined) {
    if (!isValidISODate(end)) errors.booking_end_date = 'รูปแบบวันที่ไม่ถูกต้อง';
  }
  if (!Object.keys(errors).length && start && end) {
    if (new Date(start + 'T00:00:00') > new Date(end + 'T00:00:00')) {
      errors.booking_end_date = 'วันสุดท้ายต้องไม่ก่อนวันเริ่ม';
    } else {
      const days = Math.floor(
        (new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00')) / 86400000
      ) + 1;
      if (days > 90) errors.booking_end_date = 'ช่วงวันต้องไม่เกิน 90 วัน';
    }
  }

  let manual = body.manual_mode;
  if (manual !== undefined && !['auto', 'open', 'closed'].includes(manual)) {
    errors.manual_mode = 'ค่าโหมดไม่ถูกต้อง';
  }

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'invalid', fields: errors });
  }

  if (start  !== undefined) setSetting('booking_start_date', start);
  if (end    !== undefined) setSetting('booking_end_date',   end);
  if (manual !== undefined) setSetting('site_manual_mode',   manual);
  refreshBookingDates();

  res.json({
    ...getSiteState(),
    booking_dates: BOOKING_DATES,
  });
});

app.delete('/api/admin/banner', requireAdmin, (req, res) => {
  let removed = 0;
  for (const ext of BANNER_EXTS) {
    const p = path.join(DATA_DIR, `banner.${ext}`);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); removed++; } catch {}
    }
  }
  res.json({ removed });
});

// ─── Public APIs ────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    dates: BOOKING_DATES,
    slots: TIME_SLOTS,
    capacity: SLOT_CAPACITY,
    bank: BANK_INFO,
  });
});

app.get('/api/availability', (req, res) => {
  const people = Math.max(1, Number(req.query.people) || 1);
  const rows = db.prepare(`
    SELECT booking_date, time_slot, COALESCE(SUM(num_people), 0) AS total
    FROM bookings
    WHERE payment_status NOT IN ('rejected', 'cancelled')
    GROUP BY booking_date, time_slot
  `).all();
  const usage = new Map();
  for (const r of rows) usage.set(`${r.booking_date}|${r.time_slot}`, r.total);

  const result = {};
  for (const date of BOOKING_DATES) {
    result[date] = {};
    for (const time of TIME_SLOTS) {
      const booked = usage.get(`${date}|${time}`) || 0;
      const remaining = SLOT_CAPACITY - booked;
      result[date][time] = { booked, remaining, available: remaining >= people };
    }
  }
  res.json({ people, capacity: SLOT_CAPACITY, slots: result });
});

app.post('/api/booking', (req, res) => {
  const site = getSiteState();
  if (!site.is_open) {
    return res.status(403).json({
      error: 'site_closed',
      site_state: site.state,
      booking_start_date: site.booking_start_date,
      message: site.state === 'closed-pre'
        ? `เว็บไซต์ยังไม่เปิดให้จอง (เปิด ${site.booking_start_date})`
        : 'เว็บไซต์ปิดให้บริการชั่วคราว',
    });
  }
  const errors = validateBooking(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'invalid', fields: errors });

  const { booking_date, time_slot, num_people, name, phone, email } = req.body;
  const phoneClean = String(phone).trim();

  const tx = db.transaction(() => {
    // One phone = one booking per day. Cancelled bookings don't count
    // (so the customer can re-book after admin cancels). Different days
    // are allowed — same phone can book May 15 AND May 16 separately.
    const dup = db.prepare(`
      SELECT id, booking_date, time_slot, payment_status
      FROM bookings
      WHERE phone = ? AND booking_date = ? AND payment_status != 'cancelled'
    `).get(phoneClean, booking_date);
    if (dup) {
      const err = new Error('phone_exists');
      err.code = 'PHONE_EXISTS';
      err.existing = dup;
      throw err;
    }

    const used = slotUsage(booking_date, time_slot);
    if (used + num_people > SLOT_CAPACITY) {
      const err = new Error('full');
      err.code = 'FULL';
      err.remaining = SLOT_CAPACITY - used;
      throw err;
    }
    const code = generateCode();
    const info = db.prepare(`
      INSERT INTO bookings (code, name, phone, email, num_people, booking_date, time_slot, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      code,
      String(name).trim(),
      phoneClean,
      String(email || '').trim().toLowerCase(),
      num_people,
      booking_date,
      time_slot,
    );
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
  });

  try {
    const row = tx();
    res.status(201).json(publicView(row));
  } catch (e) {
    if (e.code === 'PHONE_EXISTS') {
      return res.status(409).json({
        error: 'phone_exists',
        existing: e.existing,
        message: 'เบอร์นี้เคยจองแล้ว — กรุณาเข้าตรวจสอบสถานะ',
      });
    }
    if (e.code === 'FULL') {
      return res.status(409).json({ error: 'full', remaining: e.remaining, message: 'รอบเวลานี้เต็มแล้ว' });
    }
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Realtime check used by the booking form to flag a phone before submit.
// If `date` is provided, only the per-day uniqueness rule is checked
// (same phone may book different days). Without date, returns the most
// recent active booking for the phone (used by lookups elsewhere).
app.get('/api/booking/check', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  const date  = String(req.query.date  || '').trim();
  if (!/^[0-9\-+\s()]{9,15}$/.test(phone)) return res.json({ exists: false });

  let row;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    row = db.prepare(`
      SELECT booking_date, time_slot, payment_status
      FROM bookings
      WHERE phone = ? AND booking_date = ? AND payment_status != 'cancelled'
    `).get(phone, date);
  } else {
    row = db.prepare(`
      SELECT booking_date, time_slot, payment_status
      FROM bookings WHERE phone = ? AND payment_status != 'cancelled'
      ORDER BY created_at DESC LIMIT 1
    `).get(phone);
  }
  if (!row) return res.json({ exists: false });
  res.json({
    exists: true,
    booking_date: row.booking_date,
    time_slot: row.time_slot,
    payment_status: row.payment_status,
  });
});

// Lookup bookings by phone (used when returning users come back).
// Includes rejected bookings so the customer can see *why* and re-upload.
app.get('/api/booking/lookup', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (!/^[0-9\-+\s()]{9,15}$/.test(phone)) {
    return res.status(400).json({ error: 'invalid_phone' });
  }
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE phone = ?
    ORDER BY booking_date ASC, time_slot ASC, created_at ASC
  `).all(phone);
  res.json({ bookings: rows.map(publicView) });
});

// Upload payment slip — requires phone match for authorization
app.post('/api/booking/:id/slip', (req, res, next) => {
  slipUpload.single('slip')(req, res, (err) => {
    if (err) {
      if (err.message === 'invalid_type') return res.status(400).json({ error: 'invalid_type', message: 'รองรับเฉพาะรูปภาพ JPG/PNG/WEBP/HEIC' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'too_large', message: 'ไฟล์ใหญ่เกิน 5MB' });
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    next();
  });
}, (req, res) => {
  const id = Number(req.params.id);
  const phone = String(req.body.phone || '').trim();
  if (!Number.isFinite(id) || !phone) {
    if (req.file) unlinkSlip(req.file.filename);
    return res.status(400).json({ error: 'invalid' });
  }
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'กรุณาเลือกไฟล์สลิป' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND phone = ?').get(id, phone);
  if (!booking) {
    unlinkSlip(req.file.filename);
    return res.status(404).json({ error: 'not_found', message: 'ไม่พบการจอง — ตรวจสอบเบอร์โทรอีกครั้ง' });
  }
  if (booking.payment_status === 'verified') {
    unlinkSlip(req.file.filename);
    return res.status(409).json({ error: 'already_verified', message: 'การชำระเงินได้รับการยืนยันแล้ว' });
  }

  // When re-uploading from rejected state, the slot capacity was freed —
  // recheck before letting the booking back in (someone else may have taken the seats).
  if (booking.payment_status === 'rejected') {
    const used = slotUsage(booking.booking_date, booking.time_slot);
    if (used + booking.num_people > SLOT_CAPACITY) {
      unlinkSlip(req.file.filename);
      const remaining = SLOT_CAPACITY - used;
      return res.status(409).json({
        error: 'slot_full',
        remaining,
        message: `ขออภัย รอบนี้เต็มแล้ว เหลือเพียง ${remaining} ที่ — กรุณาทำการจองรอบใหม่`,
      });
    }
  }

  if (booking.slip_path) unlinkSlip(booking.slip_path);

  db.prepare(`
    UPDATE bookings
    SET slip_path = ?, slip_uploaded_at = datetime('now'),
        payment_status = 'submitted', rejected_reason = NULL
    WHERE id = ?
  `).run(req.file.filename, id);

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  res.json(publicView(updated));
});

// ─── Admin APIs ─────────────────────────────────────────────────────────
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      booking_date,
      time_slot,
      COALESCE(SUM(CASE WHEN payment_status NOT IN ('rejected', 'cancelled') THEN num_people ELSE 0 END), 0) AS total_people,
      COALESCE(SUM(CASE WHEN payment_status = 'verified' THEN num_people ELSE 0 END), 0) AS verified_people,
      COALESCE(SUM(CASE WHEN payment_status = 'submitted' THEN num_people ELSE 0 END), 0) AS pending_review_people,
      COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN num_people ELSE 0 END), 0) AS unpaid_people,
      COALESCE(SUM(CASE WHEN used = 1 THEN num_people ELSE 0 END), 0) AS used_people,
      COUNT(CASE WHEN payment_status NOT IN ('rejected', 'cancelled') THEN 1 END) AS bookings_count,
      COUNT(CASE WHEN payment_status = 'submitted' THEN 1 END) AS pending_review_count,
      COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) AS unpaid_count
    FROM bookings
    GROUP BY booking_date, time_slot
  `).all();
  const usage = new Map();
  for (const r of rows) usage.set(`${r.booking_date}|${r.time_slot}`, r);

  const matrix = {};
  for (const date of BOOKING_DATES) {
    matrix[date] = {};
    for (const time of TIME_SLOTS) {
      const r = usage.get(`${date}|${time}`);
      matrix[date][time] = {
        total_people: r?.total_people ?? 0,
        verified_people: r?.verified_people ?? 0,
        pending_review_people: r?.pending_review_people ?? 0,
        unpaid_people: r?.unpaid_people ?? 0,
        used_people: r?.used_people ?? 0,
        bookings_count: r?.bookings_count ?? 0,
        pending_review_count: r?.pending_review_count ?? 0,
        unpaid_count: r?.unpaid_count ?? 0,
        capacity: SLOT_CAPACITY,
      };
    }
  }
  res.json({ dates: BOOKING_DATES, slots: TIME_SLOTS, capacity: SLOT_CAPACITY, matrix });
});

// Free-text search across name + phone — used by admin home search bar.
// Phone match strips formatting (-, +, spaces, parens) so "081 234 5678"
// finds "0812345678" in the DB.
app.get('/api/admin/search', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ bookings: [] });

  const phoneClean = q.replace(/[\s\-+()]/g, '');
  const phoneCondOK = /^\d+$/.test(phoneClean);
  const nameLike  = `%${q}%`;
  const phoneLike = `%${phoneClean}%`;

  let rows;
  if (phoneCondOK && phoneClean.length >= 2) {
    rows = db.prepare(`
      SELECT id, code, name, phone, email, num_people,
             booking_date, time_slot,
             payment_status, slip_path, slip_uploaded_at, verified_at, rejected_reason,
             original_date, original_time, transferred_at,
             used, used_at, created_at
      FROM bookings
      WHERE name LIKE ? OR phone LIKE ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(nameLike, phoneLike);
  } else {
    rows = db.prepare(`
      SELECT id, code, name, phone, email, num_people,
             booking_date, time_slot,
             payment_status, slip_path, slip_uploaded_at, verified_at, rejected_reason,
             original_date, original_time, transferred_at,
             used, used_at, created_at
      FROM bookings
      WHERE name LIKE ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(nameLike);
  }

  const bookings = rows.map(b => ({ ...b, has_slip: !!b.slip_path, slip_path: undefined }));
  res.json({ q, bookings });
});

// Unified bookings endpoint: latest (no filter) / per-day / per-slot.
// Returns stats only when both date and time are provided (slot mode).
app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const { date, time } = req.query;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

  // Admin sees every status (including rejected + cancelled) so they can
  // audit and re-activate or follow up. Stats below still exclude inactive.
  const conds = ['1=1'];
  const params = [];

  if (date) {
    if (!BOOKING_DATES.includes(date)) return res.status(400).json({ error: 'invalid_date' });
    conds.push('booking_date = ?');
    params.push(date);
    if (time) {
      if (!TIME_SLOTS.includes(time)) return res.status(400).json({ error: 'invalid_time' });
      conds.push('time_slot = ?');
      params.push(time);
    }
  }

  const rows = db.prepare(`
    SELECT id, code, name, phone, email, num_people,
           booking_date, time_slot,
           payment_status, slip_path, slip_uploaded_at, verified_at, rejected_reason,
           used, used_at, created_at
    FROM bookings
    WHERE ${conds.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);

  const bookings = rows.map(b => ({ ...b, has_slip: !!b.slip_path, slip_path: undefined }));

  let stats = null;
  if (date && time) {
    const active    = bookings.filter(b => !['rejected', 'cancelled'].includes(b.payment_status));
    const total     = active.reduce((s, b) => s + b.num_people, 0);
    const verified  = active.filter(b => b.payment_status === 'verified').reduce((s, b) => s + b.num_people, 0);
    const submitted = active.filter(b => b.payment_status === 'submitted').reduce((s, b) => s + b.num_people, 0);
    const usedCnt   = active.filter(b => b.used).reduce((s, b) => s + b.num_people, 0);
    stats = {
      capacity: SLOT_CAPACITY,
      total_people: total,
      verified_people: verified,
      pending_review_people: submitted,
      used_people: usedCnt,
    };
  }

  res.json({ date: date || null, time: time || null, stats, bookings });
});

app.get('/api/admin/slot', requireAdmin, (req, res) => {
  const { date, time } = req.query;
  if (!BOOKING_DATES.includes(date) || !TIME_SLOTS.includes(time)) {
    return res.status(400).json({ error: 'invalid date/time' });
  }
  const bookings = db.prepare(`
    SELECT id, code, name, phone, email, num_people,
           payment_status, slip_path, slip_uploaded_at, verified_at, rejected_reason,
           used, used_at, created_at
    FROM bookings
    WHERE booking_date = ? AND time_slot = ?
    ORDER BY created_at ASC
  `).all(date, time);

  const view = bookings.map(b => ({ ...b, has_slip: !!b.slip_path, slip_path: undefined }));

  const total      = bookings.filter(b => b.payment_status !== 'rejected').reduce((s, b) => s + b.num_people, 0);
  const verified   = bookings.filter(b => b.payment_status === 'verified').reduce((s, b) => s + b.num_people, 0);
  const submitted  = bookings.filter(b => b.payment_status === 'submitted').reduce((s, b) => s + b.num_people, 0);
  const pending    = bookings.filter(b => b.payment_status === 'pending').reduce((s, b) => s + b.num_people, 0);
  const usedTotal  = bookings.filter(b => b.used).reduce((s, b) => s + b.num_people, 0);

  res.json({
    date, time,
    capacity: SLOT_CAPACITY,
    total_people: total,
    verified_people: verified,
    pending_review_people: submitted,
    unpaid_people: pending,
    used_people: usedTotal,
    bookings: view,
  });
});

// Serve slip image to admins only
app.get('/api/admin/bookings/:id/slip', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT slip_path FROM bookings WHERE id = ?').get(id);
  if (!row || !row.slip_path) return res.status(404).json({ error: 'no_slip' });
  const filePath = path.join(SLIPS_DIR, row.slip_path);
  if (!filePath.startsWith(SLIPS_DIR + path.sep)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file_missing' });
  res.sendFile(filePath);
});

// Save OCR'd slip metadata (ref + transfer time) and report any other
// bookings that already have the same ref — admin sees a duplicate warning.
// Both fields are best-effort; sanitization keeps OCR garbage out of the DB.
function sanitizeSlipRef(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9-]{8,40}$/.test(s) ? s : null;
}
app.post('/api/admin/bookings/:id/slip-ocr', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ref = sanitizeSlipRef(req.body?.ref);
  const transferAt = (() => {
    const v = String(req.body?.transfer_at || '').trim();
    return v.length >= 6 && v.length <= 40 ? v : null;
  })();
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  if (ref || transferAt) {
    db.prepare(`
      UPDATE bookings
      SET slip_ref         = COALESCE(?, slip_ref),
          slip_transfer_at = COALESCE(?, slip_transfer_at)
      WHERE id = ?
    `).run(ref, transferAt, id);
  }

  let duplicates = [];
  if (ref) {
    duplicates = db.prepare(`
      SELECT id, code, name, phone, payment_status, booking_date, time_slot,
             slip_uploaded_at, slip_ref, slip_transfer_at
      FROM bookings
      WHERE slip_ref = ? AND id != ?
      ORDER BY slip_uploaded_at DESC
    `).all(ref, id);
  }

  res.json({ ref, transfer_at: transferAt, duplicates });
});

app.post('/api/admin/bookings/:id/verify', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare(`
    UPDATE bookings
    SET payment_status = 'verified', verified_at = datetime('now'), rejected_reason = NULL
    WHERE id = ?
  `).run(id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

app.post('/api/admin/bookings/:id/reject', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim() || 'สลิปไม่ถูกต้อง';
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare(`
    UPDATE bookings
    SET payment_status = 'rejected', verified_at = NULL, rejected_reason = ?
    WHERE id = ?
  `).run(reason, id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

// Admin cancellation — typically used when payment hasn't arrived in time.
// Frees the slot capacity (same as reject) but reads as "cancelled" to the
// customer so they aren't told their slip was bad.
app.post('/api/admin/bookings/:id/cancel', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim() || 'ยกเลิกโดยผู้ดูแล';
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare(`
    UPDATE bookings
    SET payment_status = 'cancelled', verified_at = NULL, rejected_reason = ?
    WHERE id = ?
  `).run(reason, id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

// Reset back to pending/submitted (e.g. admin clicked verify by mistake)
app.post('/api/admin/bookings/:id/reset', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const newStatus = row.slip_path ? 'submitted' : 'pending';
  db.prepare(`
    UPDATE bookings
    SET payment_status = ?, verified_at = NULL, rejected_reason = NULL
    WHERE id = ?
  `).run(newStatus, id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

// Move a verified booking to a different (date, time). Source slot capacity
// is freed; destination is checked. Original date/time captured on the
// first transfer so the customer can see where they came from.
app.post('/api/admin/bookings/:id/transfer', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { date: newDate, time: newTime } = req.body || {};
  if (!BOOKING_DATES.includes(newDate)) return res.status(400).json({ error: 'invalid_date' });
  if (!TIME_SLOTS.includes(newTime))    return res.status(400).json({ error: 'invalid_time' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'not_found' });

  if (booking.payment_status !== 'verified') {
    return res.status(409).json({ error: 'not_verified', message: 'ย้ายได้เฉพาะการจองที่ยืนยันชำระเงินแล้ว' });
  }
  if (booking.used) {
    return res.status(409).json({ error: 'already_used', message: 'การจองนี้ใช้สิทธิ์ไปแล้ว' });
  }
  if (booking.booking_date === newDate && booking.time_slot === newTime) {
    return res.status(409).json({ error: 'same_slot', message: 'รอบใหม่เหมือนรอบเดิม' });
  }

  const tx = db.transaction(() => {
    // Capacity at destination — exclude this booking so a same-slot reflow doesn't double count
    const destUsage = db.prepare(`
      SELECT COALESCE(SUM(num_people), 0) AS total
      FROM bookings
      WHERE booking_date = ? AND time_slot = ? AND payment_status NOT IN ('rejected', 'cancelled') AND id != ?
    `).get(newDate, newTime, id);
    if (destUsage.total + booking.num_people > SLOT_CAPACITY) {
      const err = new Error('full');
      err.code = 'FULL';
      err.remaining = SLOT_CAPACITY - destUsage.total;
      throw err;
    }
    // Capture original on the first transfer only — subsequent moves keep the
    // earliest position so the customer always sees where they started.
    if (booking.original_date) {
      db.prepare(`
        UPDATE bookings
        SET booking_date = ?, time_slot = ?, transferred_at = datetime('now')
        WHERE id = ?
      `).run(newDate, newTime, id);
    } else {
      db.prepare(`
        UPDATE bookings
        SET booking_date = ?, time_slot = ?, transferred_at = datetime('now'),
            original_date = ?, original_time = ?
        WHERE id = ?
      `).run(newDate, newTime, booking.booking_date, booking.time_slot, id);
    }
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  });

  try {
    res.json(tx());
  } catch (e) {
    if (e.code === 'FULL') {
      return res.status(409).json({ error: 'slot_full', remaining: e.remaining, message: `รอบใหม่เต็ม เหลือเพียง ${e.remaining} ที่` });
    }
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/bookings/:id/use', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.payment_status !== 'verified') {
    return res.status(409).json({ error: 'not_verified', message: 'ยังไม่ได้ยืนยันการชำระเงิน — ออกตั๋วก่อนใช้สิทธิ์' });
  }
  if (row.used) return res.status(409).json({ error: 'already_used' });
  db.prepare(`UPDATE bookings SET used = 1, used_at = datetime('now') WHERE id = ?`).run(id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

app.post('/api/admin/bookings/:id/unuse', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE bookings SET used = 0, used_at = NULL WHERE id = ?`).run(id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

// ─── Backup / Restore / Clear / System log ─────────────────────────────
// Backups are stored as ZIP files in BACKUPS_DIR with this layout:
//   manifest.json   — { version, created_at, bookings_count, settings_count }
//   bookings.json   — full bookings table dump
//   settings.json   — full settings table dump
//   slips/<file>    — every file currently in SLIPS_DIR
//
// Restore is atomic on the DB side (single transaction); slip files are
// replaced after the DB transaction succeeds.

const BACKUP_VERSION = 1;
const restoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

function countBookings() {
  return db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
}

function buildBackupBuffer() {
  const zip = new AdmZip();
  const bookings = db.prepare('SELECT * FROM bookings ORDER BY id ASC').all();
  const settings = db.prepare('SELECT * FROM settings ORDER BY key ASC').all();
  const manifest = {
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    bookings_count: bookings.length,
    settings_count: settings.length,
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.addFile('bookings.json', Buffer.from(JSON.stringify(bookings, null, 2), 'utf8'));
  zip.addFile('settings.json', Buffer.from(JSON.stringify(settings, null, 2), 'utf8'));
  if (fs.existsSync(SLIPS_DIR)) {
    for (const name of fs.readdirSync(SLIPS_DIR)) {
      const p = path.join(SLIPS_DIR, name);
      if (fs.statSync(p).isFile()) {
        zip.addLocalFile(p, 'slips');
      }
    }
  }
  return { buffer: zip.toBuffer(), manifest };
}

function buildBackupJson() {
  const bookings = db.prepare('SELECT * FROM bookings ORDER BY id ASC').all();
  const settings = db.prepare('SELECT * FROM settings ORDER BY key ASC').all();
  return {
    manifest: {
      version: BACKUP_VERSION,
      created_at: new Date().toISOString(),
      bookings_count: bookings.length,
      settings_count: settings.length,
    },
    bookings,
    settings,
  };
}

// Returns { bookings, settings, slipsByName } parsed from buffer.
// Throws on malformed input.
function parseBackupPayload(buffer) {
  // Try JSON first (single object with bookings + settings)
  try {
    const txt = buffer.toString('utf8');
    if (txt.trim().startsWith('{')) {
      const obj = JSON.parse(txt);
      if (Array.isArray(obj.bookings)) {
        return {
          bookings: obj.bookings,
          settings: Array.isArray(obj.settings) ? obj.settings : [],
          slipsByName: new Map(),
          source: 'json',
        };
      }
    }
  } catch { /* not JSON, fall through to ZIP */ }

  // Treat as ZIP
  let zip;
  try { zip = new AdmZip(buffer); }
  catch { throw new Error('ไฟล์ไม่ใช่ ZIP หรือ JSON ที่อ่านได้'); }

  const entries = zip.getEntries();
  const slipsByName = new Map();
  let bookings = null;
  let settings = [];
  for (const e of entries) {
    const name = e.entryName;
    if (name === 'bookings.json') {
      bookings = JSON.parse(e.getData().toString('utf8'));
    } else if (name === 'settings.json') {
      settings = JSON.parse(e.getData().toString('utf8'));
    } else if (name.startsWith('slips/') && !e.isDirectory) {
      const base = path.basename(name);
      if (base) slipsByName.set(base, e.getData());
    }
  }
  if (!Array.isArray(bookings)) throw new Error('ไม่พบ bookings.json ในไฟล์ backup');
  if (!Array.isArray(settings)) settings = [];
  return { bookings, settings, slipsByName, source: 'zip' };
}

// Performs the destructive restore. Pre-condition: caller already has the
// parsed payload. DB changes are atomic in a single transaction; slip files
// are written after commit (best-effort).
function performRestore(payload) {
  const before = countBookings();

  const tx = db.transaction((bookings, settings) => {
    db.prepare('DELETE FROM bookings').run();
    db.prepare('DELETE FROM settings').run();

    if (bookings.length) {
      const cols = Object.keys(bookings[0]);
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = db.prepare(
        `INSERT INTO bookings (${cols.join(', ')}) VALUES (${placeholders})`
      );
      for (const b of bookings) stmt.run(cols.map(c => b[c]));
    }
    for (const s of settings) {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, COALESCE(?, datetime('now')))
      `).run(s.key, s.value, s.updated_at || null);
    }
  });
  tx(payload.bookings, payload.settings);

  // Replace slip files (only after DB commit)
  if (payload.source === 'zip') {
    if (fs.existsSync(SLIPS_DIR)) {
      for (const f of fs.readdirSync(SLIPS_DIR)) {
        try { fs.unlinkSync(path.join(SLIPS_DIR, f)); } catch { /* ignore */ }
      }
    }
    for (const [name, data] of payload.slipsByName) {
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, '');
      if (!safe) continue;
      try { fs.writeFileSync(path.join(SLIPS_DIR, safe), data); } catch (e) { console.error('restore slip failed:', name, e.message); }
    }
  }

  refreshBookingDates();
  return { before, after: countBookings(), restored_slips: payload.slipsByName.size };
}

// Filename safety: only alphanumeric, dot, underscore, dash
function safeBackupName(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!s.endsWith('.zip')) return null;
  return s;
}

// Create a new backup (saved to BACKUPS_DIR)
app.post('/api/admin/backups', requireAdmin, (req, res) => {
  try {
    const { buffer, manifest } = buildBackupBuffer();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = `backup-${ts}.zip`;
    fs.writeFileSync(path.join(BACKUPS_DIR, filename), buffer);
    logSys('backup_create', { filename, ...manifest, size: buffer.length }, manifest.bookings_count, manifest.bookings_count);
    res.status(201).json({
      filename,
      size: buffer.length,
      created_at: manifest.created_at,
      bookings_count: manifest.bookings_count,
      settings_count: manifest.settings_count,
    });
  } catch (e) {
    console.error('backup create failed:', e);
    res.status(500).json({ error: 'backup_failed', message: e.message });
  }
});

// List existing backups (most recent first)
app.get('/api/admin/backups', requireAdmin, (req, res) => {
  if (!fs.existsSync(BACKUPS_DIR)) return res.json({ backups: [] });
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const p = path.join(BACKUPS_DIR, f);
      const st = fs.statSync(p);
      let bookingsCount = null;
      try {
        const zip = new AdmZip(p);
        const entry = zip.getEntry('manifest.json');
        if (entry) {
          const m = JSON.parse(entry.getData().toString('utf8'));
          bookingsCount = m.bookings_count ?? null;
        }
      } catch { /* unreadable manifest, skip */ }
      return {
        filename: f,
        size: st.size,
        created_at: st.mtime.toISOString(),
        bookings_count: bookingsCount,
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ backups: files });
});

// Download a stored backup (ZIP)
app.get('/api/admin/backups/:name', requireAdmin, (req, res) => {
  const name = safeBackupName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  const filePath = path.join(BACKUPS_DIR, name);
  if (!filePath.startsWith(BACKUPS_DIR + path.sep)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
  res.download(filePath, name);
});

// Download a stored backup but as JSON only (no slip images)
app.get('/api/admin/backups/:name/json', requireAdmin, (req, res) => {
  const name = safeBackupName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  const filePath = path.join(BACKUPS_DIR, name);
  if (!filePath.startsWith(BACKUPS_DIR + path.sep)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
  try {
    const zip = new AdmZip(filePath);
    const manifest = JSON.parse((zip.getEntry('manifest.json')?.getData() || Buffer.from('{}')).toString('utf8'));
    const bookings = JSON.parse((zip.getEntry('bookings.json')?.getData() || Buffer.from('[]')).toString('utf8'));
    const settings = JSON.parse((zip.getEntry('settings.json')?.getData() || Buffer.from('[]')).toString('utf8'));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/\.zip$/, '.json')}"`);
    res.send(JSON.stringify({ manifest, bookings, settings }, null, 2));
  } catch (e) {
    res.status(500).json({ error: 'read_failed', message: e.message });
  }
});

// Download current data as JSON (without saving a snapshot on the server)
app.get('/api/admin/backups-current/json', requireAdmin, (req, res) => {
  try {
    const payload = buildBackupJson();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${ts}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    res.status(500).json({ error: 'export_failed', message: e.message });
  }
});

// Delete a stored backup
app.delete('/api/admin/backups/:name', requireAdmin, (req, res) => {
  const name = safeBackupName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  const filePath = path.join(BACKUPS_DIR, name);
  if (!filePath.startsWith(BACKUPS_DIR + path.sep)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
  fs.unlinkSync(filePath);
  logSys('backup_delete', { filename: name });
  res.json({ ok: true });
});

// Restore from a stored backup
app.post('/api/admin/backups/:name/restore', requireAdmin, (req, res) => {
  const name = safeBackupName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  const filePath = path.join(BACKUPS_DIR, name);
  if (!filePath.startsWith(BACKUPS_DIR + path.sep)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
  try {
    const buffer = fs.readFileSync(filePath);
    const payload = parseBackupPayload(buffer);
    const before = countBookings();
    const result = performRestore(payload);
    logSys('restore_server', { filename: name, source: payload.source, ...result }, before, result.after);
    res.json({ ok: true, ...result, source: payload.source });
  } catch (e) {
    console.error('restore failed:', e);
    res.status(400).json({ error: 'restore_failed', message: e.message });
  }
});

// Restore from an uploaded file (ZIP or JSON)
app.post('/api/admin/restore-upload', requireAdmin, (req, res, next) => {
  restoreUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'upload_failed', message: err.message });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    try {
      const payload = parseBackupPayload(req.file.buffer);
      const before = countBookings();
      const result = performRestore(payload);
      logSys('restore_upload', { filename: req.file.originalname, source: payload.source, ...result }, before, result.after);
      res.json({ ok: true, ...result, source: payload.source });
    } catch (e) {
      console.error('restore upload failed:', e);
      res.status(400).json({ error: 'restore_failed', message: e.message });
    }
  });
});

// Clear all booking data + slip files (settings retained)
app.post('/api/admin/clear-data', requireAdmin, (req, res) => {
  try {
    const before = countBookings();
    db.prepare('DELETE FROM bookings').run();
    let slipCount = 0;
    if (fs.existsSync(SLIPS_DIR)) {
      for (const f of fs.readdirSync(SLIPS_DIR)) {
        try { fs.unlinkSync(path.join(SLIPS_DIR, f)); slipCount++; } catch { /* ignore */ }
      }
    }
    logSys('data_clear', { slip_files_deleted: slipCount }, before, 0);
    res.json({ ok: true, bookings_deleted: before, slips_deleted: slipCount });
  } catch (e) {
    console.error('clear failed:', e);
    res.status(500).json({ error: 'clear_failed', message: e.message });
  }
});

// Recent system log entries
app.get('/api/admin/system-log', requireAdmin, (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const rows = db.prepare(`
    SELECT id, action, details, bookings_before, bookings_after, created_at
    FROM system_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json({
    entries: rows.map(r => ({
      ...r,
      details: r.details ? safeJsonParse(r.details) : null,
    })),
  });
});

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Explicit 0.0.0.0 — Railway proxies to IPv4, default Node binding can leave
// the upstream unreachable from the edge (manifests as 502 fallback).
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`Durian buffet booking server listening on ${HOST}:${PORT}`);
  console.log(`Admin user: ${ADMIN_USER}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Slips dir: ${SLIPS_DIR}`);
  if (USING_DEFAULT_DATA_DIR && process.env.NODE_ENV === 'production') {
    console.warn('⚠️  DATA_DIR is not set — DB and slip uploads will live in the ephemeral container and be lost on every redeploy.');
    console.warn('   On Railway: attach a Volume (mount path e.g. /data) and set env var DATA_DIR=/data');
  }
  if (process.env.NODE_ENV === 'production' && ADMIN_PASS === 'admin123') {
    console.warn('⚠️  ADMIN_PASS is using the default value. Set ADMIN_USER and ADMIN_PASS env vars in production.');
  }
});

server.on('error', (err) => {
  console.error('❌ HTTP server failed to start:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});
