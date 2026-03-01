# Plan tạm — DNS/API stability cho auto-login

Trạng thái hiện tại: **tạm hoãn triển khai** vì hardcoded serial đang chạy nhanh/ổn.

## Mục tiêu
Giảm tính hên xui khi gọi `CHECK_API_URL` trong môi trường captive portal (DNS/intercept chập chờn).

## Scope đã chốt
1. **Retry/backoff riêng cho check API**
   - Chỉ áp dụng cho lỗi mạng/DNS: `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `UND_ERR_*`.
   - Backoff đề xuất: `800ms -> 2000ms -> 4000ms`.
   - Chỉ fallback sau khi retry fail hết.

2. **Phân loại lỗi rõ trong log**
   - `network_fail`: fail do DNS/socket/timeout.
   - `api_no_action`: API trả OK nhưng `errorcode:3`/không có action.
   - `api_ok_but_no_url`: API trả JSON hợp lệ nhưng không extract được `portalLoginUrl`.

3. **Giữ fallback hiện có làm safety net**
   - Fallback vẫn build URL với serial ưu tiên hiện tại.
   - Không đổi flow chính nếu check API thành công.

4. **Giữ khả năng chạy chế độ bypass API**
   - Dùng `AWING_SKIP_CHECK_API=1` khi cần bỏ qua check API tạm thời.

## Không làm trong phase này
- Không thay đổi UI flow.
- Không thay đổi cơ chế parse `contentAuthenForm`.
- Không thêm phụ thuộc ngoài.

## Điều kiện nghiệm thu
- Tỷ lệ fail do DNS giảm rõ rệt trong cùng điều kiện mạng captive.
- Log đủ chi tiết để biết fail do mạng hay do API context.
- Không ảnh hưởng luồng login thành công hiện tại.
