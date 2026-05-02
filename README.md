# ระบบให้คะแนนเพื่อนในกลุ่ม

ระบบให้นักศึกษาเข้าสู่ระบบ รอผู้ดูแลเปิดให้โหวต แล้วให้คะแนนเพื่อนในกลุ่มเดียวกัน 1–5 คะแนน
ฝั่งหลังบ้านดูรายชื่อ ดูคะแนนแต่ละคน คำนวณค่ากลางแบบ Mode และ export เป็น CSV ได้

## โครงสร้างไฟล์

```
survey/
├── server.js       # Backend (Express + SQLite, better-sqlite3)
├── index.html      # หน้านักศึกษา (ลงทะเบียน → รอ → โหวต → ส่ง)
├── admin.html      # หน้าหลังบ้าน
├── package.json
├── voting.db       # ฐานข้อมูล (สร้างอัตโนมัติ)
└── README.md
```

## รัน

```bash
npm install
npm start              # http://localhost:3000
```

หน้าเว็บ:
- นักศึกษา → `/` (index.html)
- หลังบ้าน → `/admin.html` (user: `admin`, pass: `admin123`)

ตัวแปรสภาพแวดล้อม (ทั้งหมดมีค่าเริ่มต้น):
- `PORT` — พอร์ต (default 3000)
- `ADMIN_USER`, `ADMIN_PASS` — ชื่อผู้ใช้/รหัสผ่าน admin
- `DATA_DIR` — โฟลเดอร์เก็บฐานข้อมูล

## การทำงาน

1. นักศึกษาลงทะเบียน (รหัสนักศึกษา + ชื่อ + กลุ่ม) — รหัสซ้ำไม่ได้
2. หน้าจอรอ — polling ทุก 3 วินาทีเช็คสถานะการเปิดโหวต
3. ผู้ดูแลกดเปิดโหวตจากหลังบ้าน — นักศึกษาที่รออยู่จะเห็นรายชื่อเพื่อนในกลุ่มเดียวกัน (ไม่รวมตัวเอง)
4. นักศึกษาให้คะแนน 1–5 สำหรับทุกคน → กดยืนยัน (ส่งซ้ำไม่ได้)
5. หลังบ้านดูคะแนนรายคน คำนวณ Mode (กรณีเสมอ แสดงทุกค่า) และ export CSV

## API

ฝั่งนักศึกษา:
- `POST /api/register` `{student_id, name, group_name}`
- `POST /api/login` `{student_id}`
- `GET  /api/voting-status?student_id=...` → `{open, submitted}`
- `GET  /api/group-members?student_id=...` → รายชื่อเพื่อน (เปิดโหวตอยู่เท่านั้น)
- `POST /api/vote` `{student_id, votes:[{target_student_id, score}]}`

ฝั่งหลังบ้าน (Basic Auth):
- `POST /api/admin/login` `{username, password}` → `{token}` (base64 user:pass)
- `GET  /api/admin/users` → รายชื่อแยกกลุ่ม
- `DELETE /api/admin/users/:student_id` — ลบผู้ใช้ + คะแนนที่เกี่ยวข้อง
- `GET  /api/admin/voting-state` / `POST /api/admin/voting-state` `{open}`
- `POST /api/admin/reset-votes` — ล้างคะแนนทั้งหมด
- `GET  /api/admin/scores` — สรุปทุกคน (mode, เฉลี่ย, จำนวน)
- `GET  /api/admin/votes/:student_id` — รายละเอียดคะแนนที่ได้รับ
- `GET  /api/admin/export.csv` — ดาวน์โหลด CSV (UTF-8 + BOM)
