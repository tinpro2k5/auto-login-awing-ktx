# Auto login AWing KTX

Tool tự động giữ mạng AWing luôn mở bằng Playwright (click UI portal) + kiểm tra hết hạn session.

## Yêu cầu
- Node.js 18+ (đã có fetch/AbortController toàn cục; project vẫn cài node-fetch cho tương thích).
- npm.

## Cài đặt
```bash
npm install
```

## Chạy
```bash
npx ts-node src/index.ts
```

## Cách hoạt động (ngắn gọn)
1) Phát hiện captive: gọi Google 204 trong [src/network/detect.ts](src/network/detect.ts).
2) Nếu đang online lâu, kiểm tra sắp hết hạn: lightweight probe tới `neverssl.com` để detect captive portal không trigger MAC lock trong [src/network/checkExpiryByFetch.ts](src/network/checkExpiryByFetch.ts).
3) Khi cần login: mở Chromium qua Playwright, chặn tài nguyên nặng nhưng giữ CSS portal trong [src/browser/launcher.ts](src/browser/launcher.ts), rồi click các nút `#logo_button` → `#connectToInternet` trong [src/portal/awing.ts](src/portal/awing.ts).
4) Sau mỗi lần thử, đo lại trạng thái mạng; tối đa 3 lần/đợt.

## Tuỳ chỉnh nhanh
- Chạy ẩn trình duyệt: đổi `headless: false` thành `true` trong [src/browser/launcher.ts](src/browser/launcher.ts).
- Giảm/ tăng chặn tài nguyên: chỉnh logic `context.route` trong [src/browser/launcher.ts](src/browser/launcher.ts).
- Thời gian chờ selector / retry: xem vòng lặp trong [src/portal/awing.ts](src/portal/awing.ts).

## Xử lý sự cố
- Timeout `#logo_button` hoặc `#connectToInternet`: thử bỏ chặn stylesheet/image trong [src/browser/launcher.ts](src/browser/launcher.ts), hoặc tăng timeout trong [src/portal/awing.ts](src/portal/awing.ts).
- Fetch lỗi do proxy/SSL: kiểm tra kết nối ra `http://connectivitycheck.gstatic.com/generate_204` và `http://186.186.0.1/login`.
- Playwright tải chậm: giảm `slowMo` hoặc bật headless.
npx ts-node src/index.ts
```