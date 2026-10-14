# Tích hợp PWA bên thứ ba vào Temple Keeper

Hướng dẫn cho người (hoặc AI) viết một PWA dùng lại backend Temple Keeper để soát vé.
Nếu tài liệu này nói khác code, **code đúng**.

Base URL: `https://nim.io.vn/bcn/templekeeper/`
Mọi thân request/response là JSON UTF-8. Mốc thời gian là **epoch millisecond**.

---

## 0. Việc cần xin BCN trước khi code

1. **Origin đã khai: `https://keeper.bcn.id.vn`** (khai ngày 2026-09-04). Danh sách trắng
   khớp **chính xác từng ký tự** — không có wildcard, và đó là chủ đích. Ba trường hợp bị
   chặn mà lúc gỡ lỗi rất dễ tưởng là lỗi code:
   - `http://keeper.bcn.id.vn` — sai giao thức, kể cả khi chạy thử ở máy nhà.
   - `https://www.keeper.bcn.id.vn` hay bất kỳ sub-domain nào khác.
   - `http://localhost:xxxx` lúc phát triển.

   Cần thêm origin nào thì **xin BCN khai trước**, đừng đợi tới lúc chạy thật. Trình duyệt
   chặn ở phía nó, nên không có cách nào lách từ phía client, và lỗi hiện ra sẽ là một
   "Network error" trống rỗng chứ không nói gì về CORS.
2. Tài khoản Zalo của những người sẽ dùng phải **đã được cấp quyền** soát vé
   (`MEMBER` / `ADMIN` / `SYSTEM`).

---

## 1. Đăng nhập: người dùng tự dán mã

**Không dùng OAuth redirect, và PWA không có màn đăng nhập.** PWA cài về màn hình chính trên
iOS có kho phiên riêng, tách khỏi Safari — luồng đăng nhập rời PWA sang Safari thì phiên nằm
lại ở Safari và PWA không bao giờ thấy. Cách duy nhất chạy được như nhau trên mọi nền tảng là
không rời PWA lần nào.

```
① Người dùng mở dashboard      ② Bấm avatar → "Mã cho ứng dụng ngoài"     ③ Dán vào PWA
   nim.io.vn/bcn/templekeeper/     → hiện chuỗi + nút Sao chép                (một ô text)
```

Ba bước đó đều nằm ngoài PWA của bạn. **Việc của bạn chỉ là một ô dán mã** và lưu lại chuỗi
nhận được. Làm được trên chính chiếc điện thoại đang dùng: chuyển sang Safari, copy, quay lại
PWA, dán — nên **cố ý không có QR**, vì phần lớn người dùng chỉ có một thiết bị.

### Màn dán mã cần có

- Một `<textarea>` (không phải `<input>`: chuỗi JWT dài, người dùng cần nhìn thấy đã dán đủ).
- **Cắt khoảng trắng hai đầu** trước khi lưu. Copy trên iOS rất hay kèm một dấu cách hoặc
  xuống dòng, và `Authorization: Bearer <token> ` thì server trả 401 — người dùng sẽ tưởng
  mã sai và đi xin mã mới, mã nào cũng "sai".
- Gọi thử `GET /me` ngay lúc dán để báo đúng/sai tại chỗ, thay vì để họ phát hiện lúc đứng ở
  cổng. `401` là mã hỏng hoặc dán thiếu; `200` **nhưng `role: null`** là mã thật của một tài
  khoản chưa được cấp quyền — hiện màn chờ duyệt, đừng cho vào màn quét.
- Hiện tên người dùng (`profile.name` từ `/me`) ở đâu đó dễ thấy. Mã là danh tính — dán nhầm
  mã của người khác thì mọi lượt quét ghi tên người đó, và không ai phát hiện ra.

### Dùng token

```http
Authorization: Bearer eyJ…
```

Lưu trong `localStorage`. **Không có refresh token** — hết hạn thì người dùng lấy mã mới và
dán lại. Nhận `401` ở bất kỳ đâu nghĩa là token chết: xoá nó, quay về màn dán mã, và **giữ
nguyên hàng chờ lượt quét chưa gửi** — đừng xoá dữ liệu khi đăng xuất.

**Hạn lấy từ `expiresIn`** (giây) trong phản hồi phát mã, đừng viết cứng một con số: hạn do
cấu hình máy chủ quyết định và hiện là **7 ngày**, nhưng BCN đổi được bất cứ lúc nào. Nếu bạn
hiện hạn cho người dùng, hãy tính từ `exp` trong token thay vì đoán — một con số viết sẵn sẽ
lệch âm thầm, và người dùng tưởng mã đã chết trong khi nó vẫn mở được cổng.

> **Nói rõ với người dùng rằng mã này là mật khẩu.** Ai cầm nó soát vé được dưới tên họ, và
> không có cách thu hồi riêng một mã — thứ duy nhất giới hạn thiệt hại là nó tự hết hạn, và
> **bảy ngày là một cửa sổ dài**. Dashboard đã cảnh báo ở chỗ phát mã; đừng làm nhẹ đi ở phía
> bạn bằng cách hiện mã thường trực trên màn hình hay ghi nó vào log.

## 2. Các endpoint cần dùng

Tất cả đều cần `Authorization: Bearer`.

### `GET /me` — kiểm tra mã và biết mình là ai

```json
{ "profile": { "zaloId": "…", "name": "Nguyễn Văn A" },
  "role": "MEMBER", "unit": { "unitId": "…", "name": "Đoàn khoa CNTT" } }
```

`role` ∈ `MEMBER` | `ADMIN` | `SYSTEM` | `null`. **`null` nghĩa là chưa được cấp quyền soát
vé** — endpoint này cố ý trả `200` cho cả người đang chờ duyệt, để PWA hiện được màn "đang chờ"
thay vì một lỗi vô nghĩa. Gọi lại lúc mở app; **lỗi mạng thì giữ nguyên vai trò cũ**, đừng hạ
quyền người đang đứng ở cổng chỉ vì wifi hội trường chập chờn.

### `GET /events` — danh sách sự kiện

```json
[{ "eventId": "e1", "name": "Lễ khai giảng", "gateId": "g1", "gateName": "Cổng B",
   "isLive": true, "soldCount": 940, "ticketCodeLength": 8,
   "rosterVersion": 17, "dedupeEnabled": false }]
```

- `isLive: false` → **không cho soát vé**. Ban tổ chức chưa mở cổng.
- `ticketCodeLength` → số chữ số của mã vé ở sự kiện này. Đừng đóng cứng 8.
- `dedupeEnabled` → xem mục 3.

### `GET /events/{id}/roster?cursor=&since=` — tải danh sách vé

```json
{ "tickets": [{ "ticketCode": "26656641", "holderName": "…", "holderRole": "…",
                "status": "VALID", "rowVersion": 5, "deleted": false }],
  "nextCursor": "200", "version": 17 }
```

Vòng lặp: gọi lại với `cursor` cho tới khi `nextCursor === null`.

**Ba luật bắt buộc, sai một cái là mất dữ liệu:**

1. `version` lấy từ **trang đầu tiên**, không phải trang cuối. Admin sửa danh sách giữa lúc bạn
   đang phân trang thì lấy trang cuối sẽ khiến bạn tự nhận đã đồng bộ qua dữ liệu chưa hề tải.
2. Chỉ ghi lại `version` **sau khi đã tải hết mọi trang**. Ghi sớm là tưởng mình đã bắt kịp và
   không bao giờ hỏi lại phần thiếu.
3. Lần sau gửi `since=<version đã ghi>` để tải delta. Khi đó server trả về cả **tombstone**
   (`deleted: true`) — phải **xoá** những mã đó khỏi máy, không được bỏ qua.

`status` ∈ `VALID` | `USED` | `CANCELLED`.

### `POST /scans` — gửi lượt quét

```json
{ "scans": [{
    "clientEventId": "uuid-sinh-o-client",
    "eventId": "e1", "gateId": "g1", "ticketCode": "26656641",
    "outcome": "ADMITTED",
    "scannedAtWallClock": 1788500000000,
    "deviceSeq": 42, "deviceId": "uuid-cua-may", "entryMode": "AUTO_SCAN"
}] }
```

`outcome` ∈ `ADMITTED` | `REJECTED_ALREADY_USED` | `REJECTED_NOT_FOUND` |
`REJECTED_CANCELLED` | `UNDONE`. Tối đa **500 dòng/lô**.

```json
{ "acks": [{ "clientEventId": "…", "accepted": true, "conflictReason": null }] }
```

**Luật xử lý phản hồi — đây là chỗ dễ mất dữ liệu nhất:**

| Tình huống | Nghĩa | Làm gì |
|---|---|---|
| `accepted: true` | Server nhận, công nhận lượt vào | Đánh dấu đã gửi |
| `accepted: false` | Server **đã có** dòng này, nhưng cổng khác giành vé trước | Đánh dấu đã gửi, hiện `conflictReason` |
| **Không có trong `acks`** | Server chưa từng thấy | **Giữ lại, gửi lại sau** |

Nhánh thứ ba là nhánh dễ bỏ sót. Mặc định coi là thành công chính là cách một lượt quét biến
mất trong im lặng: máy tưởng đã gửi, server chưa từng nhận.

`clientEventId` là **khoá chống trùng** — sinh UUID ở client, ≤64 ký tự. Gửi lại sau một lần
hỏng không rõ kết quả sẽ **không** bị đếm hai lần.

### `GET /events/{id}/scans?since=&limit=` — lượt quét của các cổng khác

```json
{ "scans": [{ "clientEventId": "…", "ticketCode": "…", "outcome": "ADMITTED",
              "accepted": true, "serverReceivedAt": 1788500000000 }],
  "nextSince": 1788500000000 }
```

Dùng để biết cổng khác vừa cho ai vào. **Phát lại đúng thứ tự server trả về** — server đã phân
xử xong xung đột, `accepted` là kết quả. **Đừng tự phán xử ở client**: bạn không nhìn thấy hết
mọi cổng. Lần sau gửi `since=nextSince`.

---

## 3. Luật nghiệp vụ phải làm đúng

**Phân loại một mã quét được** (tra trong danh sách đã tải, không gọi mạng):

| Tình huống | Kết quả |
|---|---|
| Không đọc được / không có trong danh sách | `REJECTED_NOT_FOUND` |
| `status = CANCELLED` | `REJECTED_CANCELLED` — **luôn chặn**, kể cả khi `dedupeEnabled: false` |
| `status = VALID` | `ADMITTED` |
| `status = USED` **và** `dedupeEnabled: true` | `REJECTED_ALREADY_USED` |
| `status = USED` **và** `dedupeEnabled: false` | `ADMITTED` — sự kiện này chỉ ghi nhận có mặt |

`dedupeEnabled` **mặc định `true`** khi trường vắng mặt trong JSON. Đây là mặc định an toàn:
server cũ chưa có trường này thì vẫn phải chặn trùng như trước, không được tự ý nới lỏng.

**Ghi cả lượt từ chối.** Mã lạ, mã sai sự kiện đều phải gửi lên — đó là bằng chứng chuyện đã xảy
ra ở cổng.

**Hoàn tác không xoá gì.** Ghi thêm một dòng `outcome: "UNDONE"` kèm `undoesEventId` trỏ về
`clientEventId` của lượt gốc.

**Offline là mặc định, không phải trường hợp ngoại lệ.** Tải danh sách vé xuống máy trước, tra
tại chỗ, xếp lượt quét vào hàng chờ, gửi lên khi có mạng. Chờ mạng mới quét được là hỏng ở cổng.

---

## 4. Bảng lỗi

| Mã | `error` | Làm gì |
|---|---|---|
| 400 | `bad_scan` | Lô có dòng sai định dạng — **sửa, đừng gửi lại nguyên xi** |
| 401 | `missing_token` / `invalid_token` | Token chết hoặc dán thiếu → về màn dán mã |
| 403 | `no_group` | Đăng nhập được nhưng chưa được cấp quyền → hiện màn chờ duyệt |
| 403 | `disabled` / `forbidden` | Tài khoản bị khoá hoặc sai vai trò → không thử lại |
| 404 | `not_found` | Sự kiện không thuộc phạm vi của tài khoản → không thử lại |
| 413 | `batch_too_large` | Chia lô nhỏ hơn rồi gửi lại |
| 5xx | — | Thử lại có backoff |

Thân lỗi luôn có dạng `{ "error": "mã", "message": "câu tiếng Việt hiển thị được" }`.
Dùng luôn `message` cho người dùng đọc.

---

## 5. Những thứ tuyệt đối không làm

- **Đừng dùng cookie.** Safari chặn cookie bên thứ ba; PWA đã cài lại có kho cookie riêng.
  Chỉ dùng `Authorization: Bearer`.
- **Đừng gọi thẳng API của Zalo.** App Secret nằm ở server và không bao giờ rời khỏi đó.
- **Đừng tin `status` trong danh sách để quyết định chặn khi `dedupeEnabled: false`** — vé `USED`
  vẫn phải cho vào.
- **Đừng đánh dấu đã gửi khi server không nhắc tới `clientEventId` đó.**
- **Đừng tự gọi `/auth/token`.** Endpoint đó nhận cookie phiên của dashboard, và cookie đó
  `HttpOnly` + `SameSite=Lax` — từ domain của bạn thì không gọi được, đúng như thiết kế.
- **Đừng ghi token ra log, ra URL, ra thông báo lỗi.** Nó là mật khẩu, và hạn của nó tính
  bằng ngày chứ không phải giờ.
