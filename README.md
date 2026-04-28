# แบบฟอร์มลงทะเบียน + Backend API

ระบบลงทะเบียนแบบ wizard 4 ขั้นตอน พร้อม backend API และฐานข้อมูล SQLite

## โครงสร้างไฟล์

```
survey/
├── server.js          # Backend API (Express + SQLite)
├── package.json
├── index.html         # หน้าลงทะเบียน (wizard)
├── report.html        # หน้ารายงาน
├── registrations.db   # ฐานข้อมูล (สร้างอัตโนมัติ)
└── README.md
```

## รันบนเครื่องตัวเอง

```bash
# 1. ติดตั้ง dependencies
npm install

# 2. รัน server
npm start

# 3. เปิดเบราว์เซอร์
# http://localhost:3000          → หน้าลงทะเบียน
# http://localhost:3000/report.html → หน้ารายงาน
```

## API Endpoints

| Method | Path                       | หน้าที่                          |
|--------|----------------------------|---------------------------------|
| GET    | `/api/check?email=&phone=` | เช็คอีเมล/เบอร์ซ้ำ (realtime)   |
| POST   | `/api/register`            | บันทึกผู้ลงทะเบียนใหม่           |
| GET    | `/api/registrations`       | ดึงรายชื่อทั้งหมด                |
| DELETE | `/api/registrations/:id`   | ลบรายการเดี่ยว                  |
| DELETE | `/api/registrations`       | ลบทั้งหมด                       |
| GET    | `/api/health`              | health check                    |

---

## Deploy ขึ้น Railway (แนะนำ — ง่ายที่สุด)

Railway ฟรี $5 credit/เดือน เพียงพอสำหรับเว็บนี้แน่นอน

### ขั้นที่ 1 — Push โค้ดขึ้น GitHub

```bash
cd /Users/anan/Desktop/ClaudeCode/survey
git init
git add .
git commit -m "Initial commit"
# สร้าง repo ใหม่บน github.com แล้ว:
git remote add origin https://github.com/USERNAME/REPO.git
git branch -M main
git push -u origin main
```

### ขั้นที่ 2 — Deploy บน Railway

1. ไปที่ https://railway.app → Login ด้วย GitHub
2. คลิก **New Project** → **Deploy from GitHub repo**
3. เลือก repo ที่เพิ่ง push
4. Railway จะ detect Node.js อัตโนมัติ และรัน `npm start`
5. คลิกที่ service → Settings → **Networking** → **Generate Domain**
6. ได้ URL ประมาณ `https://your-app.up.railway.app`

### ขั้นที่ 3 — เพิ่ม Persistent Volume (สำคัญมาก!)

โดย default ฐานข้อมูล SQLite จะหายไปทุกครั้งที่ deploy ใหม่ ต้องเพิ่ม volume:

1. ที่ service ใน Railway → **Settings** → **Volumes** → **+ New Volume**
2. **Mount path:** `/data`
3. **Variables** → เพิ่ม `DATA_DIR=/data`
4. Save → Railway จะ redeploy ให้อัตโนมัติ

ตอนนี้ฐานข้อมูลจะถูกเก็บไว้ที่ `/data/registrations.db` และไม่หายเมื่อ deploy ใหม่

---

## Deploy ขึ้น Render (ทางเลือก)

1. ไปที่ https://render.com → New → **Web Service**
2. Connect GitHub repo
3. ตั้งค่า:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. **Disks** (Settings) → Add Disk:
   - Name: `data`
   - Mount Path: `/data`
   - Size: 1 GB
5. **Environment** → Add: `DATA_DIR=/data`
6. Deploy

⚠️ Render free tier จะ sleep หลังไม่ใช้ 15 นาที (ครั้งแรกที่เปิดจะช้า ~30 วินาที)

---

## Deploy ขึ้น VPS (DigitalOcean, AWS EC2, ฯลฯ)

```bash
# บน server
git clone https://github.com/USERNAME/REPO.git
cd REPO
npm install
npm install -g pm2

# รันแบบ daemon
pm2 start server.js --name registration
pm2 startup
pm2 save

# ตั้ง nginx เป็น reverse proxy + SSL ด้วย certbot
```

---

## ⚠️ ข้อควรระวังด้านความปลอดภัย

โค้ดนี้ยังไม่มีระบบ auth — ใครก็สามารถ:
- เข้าหน้า `/report.html` ดูข้อมูลทุกคนได้
- เรียก `DELETE /api/registrations` ลบทั้งหมดได้
- กดเรียก `/api/check` หาว่ามีอีเมลใดในระบบ (enumeration)

**ก่อนเปิดให้คนทั่วไปใช้จริง ควรเพิ่ม:**
1. **Basic auth** หรือ login สำหรับหน้า report.html
2. **Rate limiting** เช่น `express-rate-limit`
3. **CAPTCHA** ป้องกัน bot spam
4. **HTTPS** (Railway/Render มีให้อัตโนมัติ)
5. **CORS policy** ถ้าจะแยก frontend/backend

ตัวอย่าง basic auth สำหรับหน้า report:
```js
app.use('/report.html', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth !== 'Basic ' + Buffer.from('admin:password').toString('base64')) {
    res.set('WWW-Authenticate', 'Basic realm="report"');
    return res.status(401).send('Auth required');
  }
  next();
});
```

---

## Environment Variables

| ตัวแปร     | Default            | คำอธิบาย                     |
|------------|--------------------|------------------------------|
| `PORT`     | 3000               | port ที่จะรัน                  |
| `DATA_DIR` | โฟลเดอร์โปรเจกต์    | ที่เก็บไฟล์ฐานข้อมูล SQLite    |
