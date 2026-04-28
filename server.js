const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'registrations.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    phone      TEXT NOT NULL UNIQUE,
    dob        TEXT NOT NULL,
    age        INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email ON registrations(email);
  CREATE INDEX IF NOT EXISTS idx_phone ON registrations(phone);
`);

app.use(express.json());
app.use(express.static(__dirname));

const normalizePhone = p => String(p || '').replace(/[\s\-+()]/g, '');
const normalizeEmail = e => String(e || '').trim().toLowerCase();

function validateBody(b) {
  const errors = {};
  if (!b.name || !String(b.name).trim()) errors.name = 'กรุณากรอกชื่อ';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email || '').trim())) errors.email = 'รูปแบบอีเมลไม่ถูกต้อง';
  if (!/^[0-9\-+\s()]{9,15}$/.test(String(b.phone || '').trim())) errors.phone = 'เบอร์โทรไม่ถูกต้อง';
  if (!b.dob || isNaN(new Date(b.dob).getTime())) errors.dob = 'วันเกิดไม่ถูกต้อง';
  if (typeof b.age !== 'number' || b.age < 1 || b.age > 120) errors.age = 'อายุไม่ถูกต้อง';
  return errors;
}

// Realtime duplicate check (used while typing)
app.get('/api/check', (req, res) => {
  const email = req.query.email ? normalizeEmail(req.query.email) : null;
  const phone = req.query.phone ? normalizePhone(req.query.phone) : null;
  const result = { emailExists: false, phoneExists: false };
  if (email) {
    const row = db.prepare('SELECT 1 FROM registrations WHERE email = ?').get(email);
    result.emailExists = !!row;
  }
  if (phone) {
    const row = db.prepare('SELECT 1 FROM registrations WHERE phone = ?').get(phone);
    result.phoneExists = !!row;
  }
  res.json(result);
});

// Create registration
app.post('/api/register', (req, res) => {
  const errors = validateBody(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'invalid', fields: errors });

  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);

  const dupEmail = db.prepare('SELECT 1 FROM registrations WHERE email = ?').get(email);
  if (dupEmail) return res.status(409).json({ error: 'duplicate', field: 'email', message: 'อีเมลนี้ถูกลงทะเบียนแล้ว' });
  const dupPhone = db.prepare('SELECT 1 FROM registrations WHERE phone = ?').get(phone);
  if (dupPhone) return res.status(409).json({ error: 'duplicate', field: 'phone', message: 'เบอร์โทรนี้ถูกลงทะเบียนแล้ว' });

  const stmt = db.prepare(`
    INSERT INTO registrations (name, email, phone, dob, age)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    String(req.body.name).trim(),
    email,
    phone,
    new Date(req.body.dob).toISOString(),
    req.body.age
  );
  const row = db.prepare('SELECT * FROM registrations WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

// List all registrations
app.get('/api/registrations', (req, res) => {
  const rows = db.prepare('SELECT * FROM registrations ORDER BY created_at DESC').all();
  res.json(rows);
});

// Delete one
app.delete('/api/registrations/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const info = db.prepare('DELETE FROM registrations WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// Delete all (admin reset — should be protected in production)
app.delete('/api/registrations', (req, res) => {
  db.prepare('DELETE FROM registrations').run();
  res.status(204).end();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
