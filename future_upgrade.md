# Future Upgrade

## 1. Build thành file thực thi

**Các phương án:**
- Sử dụng `pkg` để build thành file thực thi độc lập, không cần Node.js cài sẵn
- Hoặc chuyển đổi sang ngôn ngữ khác như Go, Rust để biên dịch tĩnh

### Vấn đề cần tách rõ: ai đang "nặng"?

Khi bạn chạy Playwright/Selenium:
```
[ binary của bạn ]  →  điều khiển  →  [ Chromium ]
```

| Thành phần | Nặng không |
|------------|------------|
| Node.js | ❌ nhẹ (vài chục MB RAM) |
| Go binary | ❌ nhẹ |
| Chromium | 🔴 RẤT NẶNG (200–400MB RAM) |

👉 **90% chi phí là browser, không phải runtime.**

### Các lựa chọn bên Go

| Tool | Bản chất |
|------|----------|
| chromedp | Go wrapper cho Chrome DevTools |
| rod | tương tự |
| playwright-go | binding Go của Playwright |

👉 **Tất cả đều:**
- vẫn phải chạy Chromium
- vẫn load HTML/CSS/JS
- vẫn chờ countdown awing

➡️ **Không nhanh hơn Node.js**

### Mô hình tối ưu NHẤT hiện tại

```
Node.js (nhẹ)
  ├─ fetch detect / expiry (rất nhẹ)
  └─ Playwright (chỉ bật khi cần)
        └─ Chromium (nặng nhưng không tránh được)
```

👉 Browser chỉ bật khi thật sự cần login  
👉 95% thời gian tool không chạy browser

---

## 2. Tối ưu Chromium

**Mục tiêu:**
- Dùng Chromium mà Playwright đã tải
- Hoặc chỉ định 1 Chromium riêng
- Tắt tối đa feature
- Không phụ thuộc Chrome cài sẵn của Windows

### Cách dùng Chromium portable của Playwright (KHUYÊN DÙNG)

Playwright đã có sẵn Chromium tại:
```
node_modules/.playwright/chromium-*/chrome-win/chrome.exe
```

**Chỉ định executablePath:**

```typescript
import path from 'path'
import { chromium } from 'playwright'

const chromiumPath = path.resolve(
  'node_modules/.playwright/chromium-*/chrome-win/chrome.exe'
)

const browser = await chromium.launch({
  executablePath: chromiumPath,
  headless: true,
  args: [
    '--disable-gpu',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-popup-blocking',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
  ],
})
```

---

## 3. Headless + Auto-start Windows + Silent mode

Đây là phần biến tool thành **"dịch vụ nền"**.

### Headless mode (KHÔNG hiện cửa sổ)

Trong `launchBrowser()`:

```typescript
const browser = await chromium.launch({
  headless: true, // 👈 không mở cửa sổ
  args: [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
})
```

### Auto-start với Windows

**Cách 1: Task Scheduler (Khuyên dùng)**

```powershell
# Tạo scheduled task tự chạy khi đăng nhập
schtasks /create /tn "AWingAutoLogin" /tr "C:\path\to\node.exe C:\path\to\src\index.ts" /sc onlogon /rl highest
```

**Cách 2: Startup folder**

Tạo shortcut hoặc batch file trong:
```
C:\Users\<YourUser>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
```

### Silent console (chạy nền không hiện CMD)

**Tạo file `start-silent.vbs`:**

```vbscript
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "npx ts-node src/index.ts", 0, False
Set WshShell = Nothing
```

Chạy file `.vbs` này thay vì chạy trực tiếp từ CMD → không có cửa sổ console.

---

## 4. Logging & Monitoring

### Ghi log ra file

```typescript
import fs from 'fs'
import path from 'path'

const logFile = path.join(__dirname, '../logs/auto-login.log')

function log(message: string) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`
  
  console.log(message) // vẫn giữ console
  fs.appendFileSync(logFile, line) // ghi vào file
}
```

### Gửi thông báo khi lỗi

```typescript
// Email qua nodemailer hoặc webhook Discord/Telegram
async function notifyError(error: string) {
  await fetch('https://discord.com/api/webhooks/YOUR_WEBHOOK', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `❌ AWing login failed: ${error}` })
  })
}
```

---

## 5. Backup plans

### Fallback: HTTP request thay vì browser (nếu được)

Nếu portal hỗ trợ, thử POST form trực tiếp:

```typescript
const formData = new URLSearchParams()
formData.append('action', 'connect')

const res = await fetch('http://186.186.0.1/connect', {
  method: 'POST',
  body: formData,
})
```

⚠️ **Lưu ý:** AWing có countdown animation → cần browser. Nhưng nếu test thấy POST trực tiếp work thì bỏ Playwright luôn.

---

## 6. Tổng kết các bước nâng cấp đề xuất

1. ✅ **Headless mode** → giảm hiển thị UI
2. ✅ **Auto-start Windows** → chạy ngầm khi khởi động
3. ✅ **Silent console** → không hiện CMD
4. ✅ **Logging** → ghi lại lịch sử login
5. ⚠️ **Build binary** (tùy chọn) → `pkg` hoặc `nexe`
6. ⚠️ **HTTP fallback** (nếu portal hỗ trợ) → bỏ Playwright hoàn toàn
