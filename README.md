# 🥭 ระบบจองทุเรียนบุฟเฟ่ต์

ระบบจองออนไลน์ + หลังบ้านสำหรับจัดการรอบจอง ใช้ Express + SQLite

## โครงสร้างไฟล์

```
.
├── server.js        # Backend API (Express + SQLite)
├── index.html       # หน้าจอง (5 ขั้นตอน wizard)
├── admin.html       # หน้าหลังบ้าน (login + dashboard)
├── railway.toml     # Railway build/deploy config
├── package.json
└── README.md
```

## รันบนเครื่องตัวเอง

```bash
npm install
npm start
# http://localhost:3000           → หน้าจอง
# http://localhost:3000/admin.html → หลังบ้าน (admin / admin123)
```

## Booking Flow

ผู้จองทำตามลำดับนี้:
1. เลือกจำนวนคน → 2. เลือกวัน → 3. เลือกรอบ → 4. กรอกชื่อ/เบอร์/อีเมล →
5. **โอนเงิน + แนบสลิป** (หรือกด "แนบทีหลัง") → 6. หน้าสรุปสถานะ

สถานะการชำระเงิน 4 ขั้น: `pending` → `submitted` → `verified` → `rejected`
- รหัสตั๋ว 6 หลัก จะแสดงให้ผู้จองเห็นเมื่อสถานะเป็น `verified` เท่านั้น
- หลังบ้านจะมีปุ่ม **"✓ ออกตั๋ว"** เพื่อยืนยันการชำระเงินและเปิดเผยรหัสให้ลูกค้า
- ลูกค้ากลับเข้ามาด้วยเบอร์โทร (แท็บ "ตรวจสอบสถานะ") เพื่อแนบสลิปทีหลัง หรือดูรหัสตั๋วเมื่อยืนยันแล้ว

## Environment Variables

| ตัวแปร                 | Default                   | คำอธิบาย                                    |
|-----------------------|---------------------------|--------------------------------------------|
| `PORT`                | 3000                      | port ที่จะรัน                                |
| `DATA_DIR`            | โฟลเดอร์โปรเจกต์            | ที่เก็บไฟล์ฐานข้อมูล + โฟลเดอร์ `slips/`     |
| `ADMIN_USER`          | `admin`                   | username เข้าหลังบ้าน                        |
| `ADMIN_PASS`          | `admin123`                | password เข้าหลังบ้าน — **เปลี่ยนก่อนใช้จริง** |
| `BANK_NAME`           | `ธนาคารไทยพาณิชย์ (SCB)` | ธนาคารที่จะแสดงในหน้าชำระเงิน                |
| `BANK_ACCOUNT_NAME`   | `ร้านทุเรียนบุฟเฟ่ต์`       | ชื่อบัญชี                                     |
| `BANK_ACCOUNT_NUMBER` | `161-5-xxxxx-x`           | เลขที่บัญชี                                   |
| `PRICE_PER_PERSON`    | `599`                     | ราคา/คน (บาท)                                |
| `NODE_ENV`            | —                         | ตั้งเป็น `production` เพื่อเปิด startup warnings |

## API Endpoints

### Public
| Method | Path                              | หน้าที่                                |
|--------|-----------------------------------|----------------------------------------|
| GET    | `/api/config`                     | คืนรายการวันที่/รอบ/capacity            |
| GET    | `/api/availability?people=N`      | คืนสถานะแต่ละ slot สำหรับจำนวน N คน    |
| POST   | `/api/booking`                    | สร้างการจอง + รหัส 6 หลัก               |
| GET    | `/api/health`                     | health check                            |

### Admin (Bearer token)
| Method | Path                                     | หน้าที่                       |
|--------|------------------------------------------|------------------------------|
| POST   | `/api/admin/login`                       | login → คืน token             |
| POST   | `/api/admin/logout`                      | revoke token                  |
| GET    | `/api/admin/overview`                    | ภาพรวมทุกวัน × ทุกรอบ          |
| GET    | `/api/admin/slot?date=&time=`            | รายชื่อผู้จองในรอบ            |
| POST   | `/api/admin/bookings/:id/use`            | ติ๊กว่าใช้สิทธิ์แล้ว           |
| POST   | `/api/admin/bookings/:id/unuse`          | ยกเลิกสถานะใช้สิทธิ์           |

---

## 🚀 Deploy บน Railway (พร้อม Persistent Volume)

> SQLite เก็บข้อมูลเป็นไฟล์ ต้อง mount volume ไว้ ไม่งั้นข้อมูลหายทุกครั้งที่ deploy ใหม่

### 1) เชื่อม Repo เข้า Railway

1. https://railway.app → **New Project** → **Deploy from GitHub repo**
2. เลือก repo นี้ — Railway จะใช้ `railway.toml` ตั้งค่า build/start ให้อัตโนมัติ
3. รอ deploy รอบแรกเสร็จ (จะติด ⚠️ DATA_DIR warning ใน log — ปกติ จะไปแก้ในขั้นถัดไป)

### 2) เพิ่ม Volume

1. ที่ service → **Settings** → **Volumes** → **+ Volume**
2. **Mount path:** `/data`
3. กด Add — Railway จะ restart service ให้

### 3) ตั้ง Environment Variables

ที่ service → **Variables** → เพิ่ม:

| Key          | Value                          |
|--------------|--------------------------------|
| `DATA_DIR`   | `/data`                        |
| `ADMIN_USER` | (username ที่ต้องการ)          |
| `ADMIN_PASS` | (password ที่ปลอดภัย)          |
| `NODE_ENV`   | `production`                   |

> `PORT` ไม่ต้องตั้งเอง — Railway จะ inject ให้อัตโนมัติ

### 4) Generate Public Domain

Service → **Settings** → **Networking** → **Generate Domain**
ได้ URL: `https://your-app.up.railway.app`

### ตรวจสอบ

- เปิด `/api/health` — ต้องเห็น `{"ok":true}`
- ใน Deploy Logs ต้องเห็น `Database: /data/bookings.db` (ไม่ใช่ path ใน container)
- ลอง deploy อีกครั้ง — ข้อมูลที่จองไว้ก่อนหน้าต้องไม่หาย

---

## ⚠️ Production Checklist

- [ ] ตั้ง `ADMIN_USER` / `ADMIN_PASS` ใหม่ (อย่าใช้ค่า default)
- [ ] ตั้ง `DATA_DIR` ชี้ไปที่ volume
- [ ] ตั้ง `NODE_ENV=production`
- [ ] Backup ไฟล์ `bookings.db` เป็นระยะ (Railway volume ไม่ auto-backup)
- [ ] ถ้าต้องการ rate limiting หรือ CAPTCHA ใส่เพิ่มก่อนเปิดสาธารณะ
