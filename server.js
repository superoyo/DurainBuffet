const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'bookings.db');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    email        TEXT NOT NULL,
    num_people   INTEGER NOT NULL,
    booking_date TEXT NOT NULL,
    time_slot    TEXT NOT NULL,
    used         INTEGER NOT NULL DEFAULT 0,
    used_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_slot ON bookings(booking_date, time_slot);
  CREATE INDEX IF NOT EXISTS idx_code ON bookings(code);
`);

app.use(express.json());
app.use(express.static(__dirname));

// ─── helpers ────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    const exists = db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code);
    if (!exists) return code;
  }
  throw new Error('Could not generate unique code');
}

function slotUsage(date, time) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(num_people), 0) AS total
    FROM bookings
    WHERE booking_date = ? AND time_slot = ?
  `).get(date, time);
  return row.total;
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

// ─── admin auth (simple in-memory token) ────────────────────────────────
const adminTokens = new Set();

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
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
  const token = req.headers.authorization.slice(7);
  adminTokens.delete(token);
  res.status(204).end();
});

// ─── public booking APIs ────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    dates: BOOKING_DATES,
    slots: TIME_SLOTS,
    capacity: SLOT_CAPACITY,
  });
});

// Returns availability matrix for a given group size:
// { "2026-05-15": { "10:00": { booked: 12, remaining: 88, available: true }, ... }, ... }
app.get('/api/availability', (req, res) => {
  const people = Math.max(1, Number(req.query.people) || 1);
  const rows = db.prepare(`
    SELECT booking_date, time_slot, COALESCE(SUM(num_people), 0) AS total
    FROM bookings
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
      result[date][time] = {
        booked,
        remaining,
        available: remaining >= people,
      };
    }
  }
  res.json({ people, capacity: SLOT_CAPACITY, slots: result });
});

app.post('/api/booking', (req, res) => {
  const errors = validateBooking(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'invalid', fields: errors });
  }
  const { booking_date, time_slot, num_people, name, phone, email } = req.body;

  // Atomic capacity check + insert
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
      INSERT INTO bookings (code, name, phone, email, num_people, booking_date, time_slot)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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
    res.status(201).json(row);
  } catch (e) {
    if (e.code === 'FULL') {
      return res.status(409).json({ error: 'full', remaining: e.remaining, message: 'รอบเวลานี้เต็มแล้ว' });
    }
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── admin APIs ─────────────────────────────────────────────────────────
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      booking_date,
      time_slot,
      COALESCE(SUM(num_people), 0) AS total_people,
      COALESCE(SUM(CASE WHEN used = 1 THEN num_people ELSE 0 END), 0) AS used_people,
      COUNT(*) AS bookings_count
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
        total_people: r ? r.total_people : 0,
        used_people: r ? r.used_people : 0,
        bookings_count: r ? r.bookings_count : 0,
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
    SELECT id, code, name, phone, email, num_people, used, used_at, created_at
    FROM bookings
    WHERE booking_date = ? AND time_slot = ?
    ORDER BY created_at ASC
  `).all(date, time);
  const total = bookings.reduce((s, b) => s + b.num_people, 0);
  const usedTotal = bookings.filter(b => b.used).reduce((s, b) => s + b.num_people, 0);
  res.json({
    date, time,
    capacity: SLOT_CAPACITY,
    total_people: total,
    used_people: usedTotal,
    bookings,
  });
});

app.post('/api/admin/bookings/:id/use', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.used) return res.status(409).json({ error: 'already_used', booking: row });
  db.prepare('UPDATE bookings SET used = 1, used_at = datetime(\'now\') WHERE id = ?').run(id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

app.post('/api/admin/bookings/:id/unuse', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('UPDATE bookings SET used = 0, used_at = NULL WHERE id = ?').run(id);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Durian buffet booking server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html  (user: ${ADMIN_USER})`);
  console.log(`Database: ${DB_PATH}`);
});
