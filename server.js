const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const USING_DEFAULT_DATA_DIR = !process.env.DATA_DIR;
const SLIPS_DIR = path.join(DATA_DIR, 'slips');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SLIPS_DIR)) fs.mkdirSync(SLIPS_DIR, { recursive: true });
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
const BOOKING_DATES = [
  '2026-05-15', '2026-05-16', '2026-05-17', '2026-05-18', '2026-05-19',
  '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24',
];
const TIME_SLOTS = [
  '10:00', '11:00', '12:00', '13:00', '14:00',
  '15:00', '16:00', '17:00', '18:00', '19:00',
];

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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
    used            INTEGER NOT NULL DEFAULT 0,
    used_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_slot   ON bookings(booking_date, time_slot);
  CREATE INDEX IF NOT EXISTS idx_code   ON bookings(code);
  CREATE INDEX IF NOT EXISTS idx_phone  ON bookings(phone);
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
  ];
  for (const [name, def] of adds) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${def}`);
  }
})();

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
    WHERE booking_date = ? AND time_slot = ? AND payment_status != 'rejected'
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
  if (!Number.isInteger(people) || people < 1 || people > SLOT_CAPACITY) {
    errors.num_people = 'จำนวนคนไม่ถูกต้อง';
  }
  if (!BOOKING_DATES.includes(b.booking_date)) errors.booking_date = 'วันที่ไม่ถูกต้อง';
  if (!TIME_SLOTS.includes(b.time_slot)) errors.time_slot = 'รอบเวลาไม่ถูกต้อง';
  if (!b.name || !String(b.name).trim()) errors.name = 'กรุณากรอกชื่อ-นามสกุล';
  if (!/^[0-9\-+\s()]{9,15}$/.test(String(b.phone || '').trim())) errors.phone = 'เบอร์โทรไม่ถูกต้อง';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email || '').trim())) errors.email = 'รูปแบบอีเมลไม่ถูกต้อง';
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
  if (username === ADMIN_USER && password === ADMIN_PASS) {
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
    WHERE payment_status != 'rejected'
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
  const errors = validateBooking(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'invalid', fields: errors });

  const { booking_date, time_slot, num_people, name, phone, email } = req.body;

  const tx = db.transaction(() => {
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
      String(phone).trim(),
      String(email).trim().toLowerCase(),
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
    if (e.code === 'FULL') {
      return res.status(409).json({ error: 'full', remaining: e.remaining, message: 'รอบเวลานี้เต็มแล้ว' });
    }
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Lookup bookings by phone (used when returning users come back)
app.get('/api/booking/lookup', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (!/^[0-9\-+\s()]{9,15}$/.test(phone)) {
    return res.status(400).json({ error: 'invalid_phone' });
  }
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE phone = ? AND payment_status != 'rejected'
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
      COALESCE(SUM(CASE WHEN payment_status != 'rejected' THEN num_people ELSE 0 END), 0) AS total_people,
      COALESCE(SUM(CASE WHEN payment_status = 'verified' THEN num_people ELSE 0 END), 0) AS verified_people,
      COALESCE(SUM(CASE WHEN payment_status = 'submitted' THEN num_people ELSE 0 END), 0) AS pending_review_people,
      COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN num_people ELSE 0 END), 0) AS unpaid_people,
      COALESCE(SUM(CASE WHEN used = 1 THEN num_people ELSE 0 END), 0) AS used_people,
      COUNT(CASE WHEN payment_status != 'rejected' THEN 1 END) AS bookings_count,
      COUNT(CASE WHEN payment_status = 'submitted' THEN 1 END) AS pending_review_count
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
        capacity: SLOT_CAPACITY,
      };
    }
  }
  res.json({ dates: BOOKING_DATES, slots: TIME_SLOTS, capacity: SLOT_CAPACITY, matrix });
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Durian buffet booking server running on port ${PORT}`);
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
