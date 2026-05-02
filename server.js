const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'voting.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    group_name  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_name);

  CREATE TABLE IF NOT EXISTS votes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    voter_student_id   TEXT NOT NULL,
    target_student_id  TEXT NOT NULL,
    score              INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    group_name         TEXT NOT NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (voter_student_id, target_student_id)
  );
  CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_student_id);

  CREATE TABLE IF NOT EXISTS submissions (
    voter_student_id  TEXT PRIMARY KEY,
    submitted_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  INSERT OR IGNORE INTO settings(key, value) VALUES ('voting_open', '0');
`);

app.use(express.json());
app.use(express.static(__dirname));

const getVotingOpen = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('voting_open');
  return row && row.value === '1';
};
const setVotingOpen = (open) => {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(open ? '1' : '0', 'voting_open');
};

// ---------- Public endpoints ----------

// Register a new student
app.post('/api/register', (req, res) => {
  const student_id = String(req.body.student_id || '').trim();
  const name = String(req.body.name || '').trim();
  const group_name = String(req.body.group_name || '').trim();
  const errors = {};
  if (!student_id) errors.student_id = 'กรุณากรอกรหัสนักศึกษา';
  if (!name) errors.name = 'กรุณากรอกชื่อ';
  if (!group_name) errors.group_name = 'กรุณากรอกกลุ่ม';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'invalid', fields: errors });

  const dup = db.prepare('SELECT * FROM users WHERE student_id = ?').get(student_id);
  if (dup) {
    // If existing record matches name + group, treat as login
    if (dup.name === name && dup.group_name === group_name) {
      return res.json({ user: dup, returning: true });
    }
    return res.status(409).json({ error: 'duplicate', message: 'รหัสนักศึกษานี้ลงทะเบียนแล้ว ด้วยข้อมูลที่ไม่ตรงกัน' });
  }

  const info = db.prepare(
    'INSERT INTO users (student_id, name, group_name) VALUES (?, ?, ?)'
  ).run(student_id, name, group_name);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ user: row, returning: false });
});

// Login (by student_id)
app.post('/api/login', (req, res) => {
  const student_id = String(req.body.student_id || '').trim();
  if (!student_id) return res.status(400).json({ error: 'invalid', message: 'กรุณากรอกรหัสนักศึกษา' });
  const row = db.prepare('SELECT * FROM users WHERE student_id = ?').get(student_id);
  if (!row) return res.status(404).json({ error: 'not found', message: 'ไม่พบรหัสนักศึกษานี้ กรุณาลงทะเบียนก่อน' });
  res.json({ user: row });
});

// Voting status (open/closed) and whether this user has already submitted
app.get('/api/voting-status', (req, res) => {
  const student_id = req.query.student_id ? String(req.query.student_id).trim() : null;
  const open = getVotingOpen();
  let submitted = false;
  if (student_id) {
    submitted = !!db.prepare('SELECT 1 FROM submissions WHERE voter_student_id = ?').get(student_id);
  }
  res.json({ open, submitted });
});

// Get group members for voting (excluding self)
app.get('/api/group-members', (req, res) => {
  const student_id = String(req.query.student_id || '').trim();
  if (!student_id) return res.status(400).json({ error: 'invalid', message: 'ต้องระบุรหัสนักศึกษา' });
  if (!getVotingOpen()) return res.status(403).json({ error: 'closed', message: 'ระบบยังไม่เปิดให้โหวต' });
  const me = db.prepare('SELECT * FROM users WHERE student_id = ?').get(student_id);
  if (!me) return res.status(404).json({ error: 'not found' });
  const members = db.prepare(
    'SELECT student_id, name FROM users WHERE group_name = ? AND student_id != ? ORDER BY student_id ASC'
  ).all(me.group_name, student_id);
  res.json({ group_name: me.group_name, members });
});

// Submit votes
app.post('/api/vote', (req, res) => {
  const student_id = String(req.body.student_id || '').trim();
  const votes = Array.isArray(req.body.votes) ? req.body.votes : null;
  if (!student_id || !votes) return res.status(400).json({ error: 'invalid' });
  if (!getVotingOpen()) return res.status(403).json({ error: 'closed', message: 'ระบบยังไม่เปิดให้โหวต' });

  const me = db.prepare('SELECT * FROM users WHERE student_id = ?').get(student_id);
  if (!me) return res.status(404).json({ error: 'not found' });

  if (db.prepare('SELECT 1 FROM submissions WHERE voter_student_id = ?').get(student_id)) {
    return res.status(409).json({ error: 'already_submitted', message: 'คุณได้ส่งคะแนนแล้ว' });
  }

  const groupMembers = db.prepare(
    'SELECT student_id FROM users WHERE group_name = ? AND student_id != ?'
  ).all(me.group_name, student_id).map(r => r.student_id);

  // Validate votes: must cover every group member, scores 1-5
  const targetSet = new Set(groupMembers);
  const seen = new Set();
  for (const v of votes) {
    const t = String(v.target_student_id || '').trim();
    const s = Number(v.score);
    if (!targetSet.has(t)) return res.status(400).json({ error: 'invalid', message: `รหัส ${t} ไม่ได้อยู่ในกลุ่ม` });
    if (!Number.isInteger(s) || s < 1 || s > 5) return res.status(400).json({ error: 'invalid', message: 'คะแนนต้องอยู่ระหว่าง 1-5' });
    if (seen.has(t)) return res.status(400).json({ error: 'invalid', message: 'มีรหัสซ้ำ' });
    seen.add(t);
  }
  if (seen.size !== groupMembers.length) {
    return res.status(400).json({ error: 'invalid', message: 'กรุณาให้คะแนนครบทุกคน' });
  }

  const insertVote = db.prepare(
    'INSERT INTO votes (voter_student_id, target_student_id, score, group_name) VALUES (?, ?, ?, ?)'
  );
  const insertSub = db.prepare('INSERT INTO submissions (voter_student_id) VALUES (?)');

  const tx = db.transaction(() => {
    for (const v of votes) {
      insertVote.run(student_id, String(v.target_student_id).trim(), Number(v.score), me.group_name);
    }
    insertSub.run(student_id);
  });
  tx();
  res.status(201).json({ ok: true });
});

// ---------- Admin endpoints ----------

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Basic\s+(.+)$/i);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      if (u === ADMIN_USER && p === ADMIN_PASS) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="admin"');
  res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');
    return res.json({ ok: true, token });
  }
  res.status(401).json({ error: 'unauthorized', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, student_id, name, group_name, created_at FROM users ORDER BY group_name ASC, student_id ASC'
  ).all();
  const submitted = new Set(
    db.prepare('SELECT voter_student_id FROM submissions').all().map(r => r.voter_student_id)
  );
  const groups = {};
  for (const u of users) {
    if (!groups[u.group_name]) groups[u.group_name] = [];
    groups[u.group_name].push({ ...u, submitted: submitted.has(u.student_id) });
  }
  res.json({ groups });
});

app.delete('/api/admin/users/:student_id', requireAdmin, (req, res) => {
  const sid = String(req.params.student_id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE voter_student_id = ? OR target_student_id = ?').run(sid, sid);
    db.prepare('DELETE FROM submissions WHERE voter_student_id = ?').run(sid);
    db.prepare('DELETE FROM users WHERE student_id = ?').run(sid);
  });
  tx();
  res.status(204).end();
});

app.get('/api/admin/voting-state', requireAdmin, (req, res) => {
  res.json({ open: getVotingOpen() });
});

app.post('/api/admin/voting-state', requireAdmin, (req, res) => {
  const open = !!req.body.open;
  setVotingOpen(open);
  res.json({ open });
});

// Reset all votes (keep users)
app.post('/api/admin/reset-votes', requireAdmin, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM votes').run();
    db.prepare('DELETE FROM submissions').run();
  });
  tx();
  res.json({ ok: true });
});

// Get votes received by a single student
app.get('/api/admin/votes/:student_id', requireAdmin, (req, res) => {
  const sid = String(req.params.student_id);
  const target = db.prepare('SELECT * FROM users WHERE student_id = ?').get(sid);
  if (!target) return res.status(404).json({ error: 'not found' });
  const votes = db.prepare(`
    SELECT v.score, v.created_at, u.student_id AS voter_student_id, u.name AS voter_name
    FROM votes v
    JOIN users u ON u.student_id = v.voter_student_id
    WHERE v.target_student_id = ?
    ORDER BY u.student_id ASC
  `).all(sid);
  res.json({ target, votes, summary: summarize(votes.map(v => v.score)) });
});

function mode(arr) {
  if (!arr.length) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  let best = -1;
  const modes = [];
  for (const k of Object.keys(counts)) {
    const c = counts[k];
    if (c > best) { best = c; modes.length = 0; modes.push(Number(k)); }
    else if (c === best) { modes.push(Number(k)); }
  }
  modes.sort((a, b) => a - b);
  return { values: modes, count: best };
}

function summarize(scores) {
  if (!scores.length) return { n: 0, mode: null, modeDisplay: '-', avg: null };
  const m = mode(scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    n: scores.length,
    mode: m,
    modeDisplay: m.values.join(', '),
    avg: Number(avg.toFixed(2)),
  };
}

// Aggregated scores for all users (for the report)
app.get('/api/admin/scores', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT student_id, name, group_name FROM users ORDER BY group_name ASC, student_id ASC'
  ).all();
  const scoresByTarget = {};
  const rows = db.prepare('SELECT target_student_id, score FROM votes').all();
  for (const r of rows) {
    if (!scoresByTarget[r.target_student_id]) scoresByTarget[r.target_student_id] = [];
    scoresByTarget[r.target_student_id].push(r.score);
  }
  const result = users.map(u => {
    const list = scoresByTarget[u.student_id] || [];
    return { ...u, ...summarize(list), scores: list };
  });
  res.json({ users: result });
});

// CSV export
app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT student_id, name, group_name FROM users ORDER BY group_name ASC, student_id ASC'
  ).all();
  const rows = db.prepare('SELECT target_student_id, score FROM votes').all();
  const map = {};
  for (const r of rows) {
    if (!map[r.target_student_id]) map[r.target_student_id] = [];
    map[r.target_student_id].push(r.score);
  }
  const csvEscape = (v) => {
    const s = String(v == null ? '' : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = ['group_name', 'student_id', 'name', 'votes_count', 'mode', 'average', 'all_scores'];
  const lines = [header.join(',')];
  for (const u of users) {
    const list = map[u.student_id] || [];
    const sum = summarize(list);
    lines.push([
      u.group_name, u.student_id, u.name,
      sum.n,
      sum.mode ? sum.mode.values.join('|') : '',
      sum.avg == null ? '' : sum.avg,
      list.join('|'),
    ].map(csvEscape).join(','));
  }
  const csv = '﻿' + lines.join('\n'); // BOM for Excel UTF-8
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="scores.csv"');
  res.send(csv);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin page:    http://localhost:${PORT}/admin.html`);
  console.log(`Database:      ${DB_PATH}`);
});
