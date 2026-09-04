# Tích hợp API Temple Keeper

Tài liệu cho người viết **một client mới** — app iOS, một app Android khác, một trang web,
một script đối soát. Nó mô tả hợp đồng của `templekeeper-service` đang chạy thật, không phải
một bản thiết kế.

Nguồn sự thật vẫn là code: `server/templekeeper-service/src/routes/` là bản đồ đường đi,
`src/controllers/` là hình dạng dữ liệu. Nếu file này lệch với code thì code đúng.

---

## 1. Địa chỉ và tiền tố

```
https://nim.io.vn/bcn/templekeeper/
```

Nginx cắt tiền tố `/bcn/templekeeper/` trước khi chuyển vào service ở cổng 3014. Nghĩa là
đường dẫn trong tài liệu này (`/events`) nằm ở
`https://nim.io.vn/bcn/templekeeper/events`. Client chỉ cần cấu hình đúng một base URL có
dấu `/` ở cuối, phần còn lại là đường dẫn tương đối.

Kiểm tra service sống hay chết, không cần đăng nhập:

```bash
curl -fsS https://nim.io.vn/bcn/templekeeper/health
```

→ `{"ok":true,"service":"templekeeper"}`

`/admin/` là trang quản trị web (file tĩnh). Đường dẫn nào dưới `/admin/` không khớp file
tĩnh nào thì rơi xuống router API — đó là lý do endpoint quản trị cũng nằm dưới `/admin`.

---

## 2. Xác thực

Danh tính đến từ **Zalo**. Service không có mật khẩu riêng, không có form đăng ký. Sau khi
xác minh với Zalo, service phát một **JWT của riêng nó**; mọi request sau đó mang JWT này.

### 2.1 Token đi bằng hai cách

| Loại client | Cách mang token |
|---|---|
| App di động, script | `Authorization: Bearer <token>` |
| Trình duyệt (dashboard) | cookie `tk_session`, HttpOnly, do server tự đặt |

Cùng một JWT, chỉ khác cách mang. Client mới dạng app nên dùng `Authorization`.

Token sống mặc định **1 ngày** (`JWT_ACCESS_EXPIRES`). Hết hạn thì mọi request trả `401`
`invalid_token`; client phải đăng nhập lại chứ không có refresh token.

### 2.2 Luồng đăng nhập cho app di động

```
POST /auth/zalo
Content-Type: application/json

{ "oauthCode": "<code Zalo SDK trả về>", "codeVerifier": "<PKCE verifier>" }
```

Trả về:

```json
{
  "accessToken": "eyJhbGciOi...",
  "profile": { "zaloId": "123...", "name": "Nguyễn Văn A", "avatarUrl": "https://..." },
  "role": "MEMBER"
}
```

- `role` là `null` khi người này đăng nhập được nhưng **chưa được cấp quyền**. Đây không
  phải lỗi: server đã ghi hồ sơ vào hàng chờ, quản trị viên sẽ thấy và gán vào đơn vị. Client
  phải hiện màn hình "đang chờ được cấp quyền", không hiện lỗi kỹ thuật.
- Body cũng nhận `{ "accessToken": "<access token Zalo>" }` để tiện thử nghiệm. Đường nào
  cũng bị hỏi lại Zalo — server không bao giờ tin thông tin người dùng do client tự khai.

**App Secret của Zalo không bao giờ rời server.** Client chỉ giữ App ID. Việc đổi `oauthCode`
lấy token Zalo là việc của backend. Nhét secret vào client là để lộ nó cho bất kỳ ai giải nén
được gói cài.

Zalo bắt `redirect_uri` phải là https, còn app thì nhận deep link. Cầu nối có sẵn:

```
GET /auth/zalo/callback?code=...&state=...
→ 302 templekeeper://auth/zalo?code=...&state=...
```

Scheme đổi được bằng biến môi trường `APP_REDIRECT_SCHEME`. Client iOS muốn scheme riêng thì
báo để đổi ở server, đừng tự đoán.

### 2.3 Luồng đăng nhập cho trình duyệt

`GET /auth/web/start` → 302 sang Zalo → `GET /auth/web/callback` → đặt cookie `tk_session`
(7 ngày) → 302 về `/admin/`. `POST /auth/web/logout` xoá cookie. Toàn bộ PKCE và việc đổi
token nằm ở server; trình duyệt không thấy access token của Zalo.

### 2.4 Biết mình là ai

```
GET /me
Authorization: Bearer <token>
```

```json
{
  "profile": { "zaloId": "123...", "name": "Nguyễn Văn A" },
  "account": {
    "accountId": "acc_...", "displayName": "Nguyễn Văn A", "phone": "0901234567",
    "role": "MEMBER", "status": "ACTIVE", "bound": true,
    "unitId": "u_cntt", "unitName": "Đoàn khoa CNTT", "ownerAccountId": null, "ownerName": null
  },
  "role": "MEMBER",
  "unit": {
    "unitId": "u_cntt", "name": "Đoàn khoa CNTT",
    "eventQuota": 5, "eventsCreated": 2, "eventsLeft": 3,
    "note": "", "createdAt": 1756370000000
  }
}
```

`account` và `role` là `null` với người chưa được cấp quyền. `role` chỉ có giá trị khi
`status === "ACTIVE"` — tài khoản bị khoá thì `account` vẫn có nhưng `role` là `null`.

Đây là endpoint đầu tiên client nên gọi sau khi đăng nhập, và là chỗ duy nhất để biết vai trò.

### 2.5 Vai trò

| Giá trị trong DB | Nghĩa | Thấy được gì |
|---|---|---|
| `SYSTEM` | BCN | Mọi đơn vị, mọi sự kiện |
| `ADMIN` | Quản lý đơn vị | Sự kiện và nhân sự **cùng `unitId`** |
| `MEMBER` | Người soát vé | Sự kiện của đơn vị mình |

**Vai trò được tra từ database ở mỗi request**, không đọc từ trong token. Gỡ quyền một người
có hiệu lực ngay, không phải chờ token hết hạn. Client không được cache vai trò lâu hơn một
phiên làm việc.

---

## 3. Quy ước chung

- Tất cả body và response là JSON UTF-8. Ngoại lệ duy nhất: file CSV xuất điểm danh.
- **Mọi mốc thời gian là epoch milliseconds** (số nguyên), không phải chuỗi ISO.
- Trần body JSON: **2 MB**.
- Client **phải bỏ qua trường lạ** trong JSON. Server thêm trường mới là chuyện thường và
  không coi là breaking change; bản Android đặt `ignoreUnknownKeys = true` chính vì việc này.
  Client nào vỡ khi gặp trường lạ là client đó sai.
- Trường mới luôn có giá trị mặc định hợp lý ở phía client (`rosterVersion = 0`,
  `deleted = false`, …) để bản cũ chạy được với server mới và ngược lại.

### 3.1 Hình dạng lỗi

Mọi lỗi đều là JSON, kể cả 404 đường dẫn:

```json
{ "error": "<mã máy đọc>", "message": "<câu tiếng Việt cho người đọc>" }
```

Lỗi 500 chỉ trả đúng chừng này, kèm mã request để tra log:

```json
{ "error": "internal", "message": "Lỗi máy chủ", "requestId": "a1b2c3" }
```

Một số lỗi mang thêm trường công khai (ví dụ `problems` của `POST /scans`). Không có lỗi nào
lộ thông điệp nội bộ của database ra ngoài.

### 3.2 Cách client phải xử lý từng nhóm mã

Đây là phần dễ làm sai nhất, và làm sai thì hoặc mất dữ liệu, hoặc quay vòng vô hạn.

| Mã | Nghĩa | Client phải làm gì |
|---|---|---|
| `2xx` | Xong | — |
| `400`, `403`, `404`, `409` | Lỗi **vĩnh viễn** của chính request đó | **Không thử lại.** Gửi lại y hệt sẽ hỏng y hệt. |
| `401` | Token thiếu / hỏng / hết hạn | Đăng nhập lại, rồi thử lại **một lần**. |
| `413` | Lô quá lớn | **Chia lô nhỏ hơn** rồi gửi lại. Đây là lý do `413` tồn tại tách khỏi `400`. |
| `5xx`, timeout, mất mạng | Lỗi **tạm thời** | Thử lại có backoff. Không được vứt dữ liệu. |

### 3.3 Bảng mã lỗi

| `error` | HTTP | Khi nào |
|---|---|---|
| `missing_token` | 401 | Không có `Authorization` lẫn cookie |
| `invalid_token` | 401 | JWT sai chữ ký hoặc hết hạn |
| `zalo_rejected` | 401 | Zalo từ chối code / token |
| `missing_credentials` | 400 | `POST /auth/zalo` thiếu cả `oauthCode` lẫn `accessToken` |
| `no_group` | 403 | Đăng nhập được nhưng chưa thuộc đơn vị nào (kèm `profile`) |
| `disabled` | 403 | Tài khoản bị khoá |
| `forbidden` | 403 | Sai vai trò cho đường này |
| `not_found` | 404 | Sự kiện ngoài phạm vi, hoặc đường dẫn không tồn tại |
| `event_not_found` / `ticket_not_found` | 404 | Không có sự kiện / vé đó |
| `ticket_exists` / `event_exists` | 409 | Trùng mã khi tạo mới |
| `has_scans` | 409 | Xoá sự kiện đã có lượt quét |
| `bad_body` / `rejected` | 400 | Body sai hình dạng |
| `bad_cursor` / `bad_since` | 400 | Tham số phân trang âm |
| `bad_scan` | 400 | Lô quét có dòng hỏng, kèm `problems` |
| `batch_too_large` | 413 | Quá 500 lượt quét mỗi lô |
| `status_not_settable` | 400 | Cố đặt vé thành `USED` bằng tay |
| `unit_required` / `no_unit` / `unit_not_found` | 400/403 | Sự kiện phải thuộc một đơn vị |
| `internal` | 500 | Lỗi máy chủ, kèm `requestId` |

---

## 4. Nhóm endpoint của máy soát vé

Bốn đường này là **hợp đồng với các bản app đã cài ngoài hiện trường**, và một máy đang ở
cổng thì không cập nhật được giữa buổi lễ. Chúng nằm riêng trong
`src/routes/gate.routes.js` chính vì vậy. Client mới dùng đúng bốn đường này là chạy được.

Cả bốn yêu cầu vai trò bất kỳ trong `SYSTEM` / `ADMIN` / `MEMBER`.

### 4.1 `GET /events`

```
GET /events?gateId=<mã cổng của máy này>
```

`gateId` không bắt buộc. Có thì server trả đúng cổng đó; không thì lấy cổng đầu tiên của sự
kiện, để một máy chưa được phân cổng vẫn dùng được thay vì hỏng.

```json
[{
  "eventId": "iuh-khaigiang-2026",
  "name": "Lễ khai giảng 2026",
  "venue": "Hội trường A",
  "gateId": "cong-a", "gateName": "Cổng A",
  "scheduleLabel": "05/09/2026 · 07:00 – 11:00",
  "eventDate": "2026-09-05", "startsAt": "07:00", "endsAt": "11:00", "allDay": false,
  "isLive": true,
  "soldCount": 920,
  "gateCountLabel": "2 cổng",
  "ticketCodeLength": 8,
  "rosterVersion": 14,
  "unitId": "u_cntt", "unitName": "Đoàn khoa CNTT",
  "ownerAccountId": "acc_..."
}]
```

- `isLive` là công tắc mở cổng. `false` thì không cho vào màn quét.
- `soldCount` do server đếm từ bảng vé, client không gửi lên được.
- `ticketCodeLength` là số ký tự mã vé của sự kiện này — dùng để cắt/đệm mã đọc từ đầu đọc
  mã vạch.
- **`rosterVersion` là trục của toàn bộ việc đồng bộ.** Xem mục 5.

### 4.2 `GET /events/{eventId}/roster`

```
GET /events/{eventId}/roster?cursor=<offset>&since=<version>
```

| Tham số | Mặc định | Nghĩa |
|---|---|---|
| `cursor` | `0` | Offset trang. Lấy nguyên `nextCursor` của trang trước. |
| `since` | `0` | Phiên bản danh sách máy đang có. `0` = tải toàn bộ. |

Kích thước trang cố định **200 dòng** ở phía server; client không đổi được.

```json
{
  "tickets": [{
    "ticketCode": "26656641",
    "holderName": "Trần Thiên Ân",
    "holderRole": "DHKTPM17A",
    "ticketType": "", "seat": "",
    "status": "VALID",
    "checkedInAt": null,
    "checkedInAtGate": null,
    "revision": 0,
    "rowVersion": 3,
    "deleted": false
  }],
  "nextCursor": "200",
  "version": 14
}
```

- `status`: `VALID` | `USED` | `CANCELLED`.
- `checkedInAtGate` chứa **tên** cổng, không phải mã cổng. Đừng JOIN nó với `gateId`.
- `deleted: true` là **bia mộ**: vé vừa bị gỡ khỏi danh sách. Client nhận được thì phải xoá
  khỏi bản local. Lần tải đầu (`since=0`) không gửi bia mộ — máy chưa từng thấy chúng.
- `version` là phiên bản của **toàn bộ** danh sách tại thời điểm đọc, giống nhau ở mọi trang
  của một lượt tải.
- `nextCursor` là `null` ở trang cuối.

### 4.3 `GET /events/{eventId}/scans`

Lịch sử quét của **toàn sự kiện**, kể cả lượt của cổng khác. Đây là đường để một máy tham gia
muộn bắt kịp mọi thứ đã xảy ra: gọi với `since=0`.

```
GET /events/{eventId}/scans?since=<mốc>&limit=500&order=asc
```

| Tham số | Mặc định | Trần |
|---|---|---|
| `since` | `0` | — |
| `limit` | `500` | `1000` |
| `order` | `asc` | `asc` \| `desc` |

`since` so với `server_received_at` và là **so sánh ngặt** (`>`), nên không bao giờ nhận lại
dòng đã nhận.

```json
{
  "scans": [{
    "clientEventId": "0f1c…",
    "gateId": "cong-a", "gateName": "Cổng A",
    "ticketCode": "26656641",
    "holderName": "Trần Thiên Ân", "holderRole": "DHKTPM17A",
    "outcome": "ADMITTED",
    "undoesEventId": null,
    "scannedAtWallClock": 1756370000000,
    "deviceSeq": 412, "deviceId": "5a2e…", "entryMode": "AUTO_SCAN",
    "scannedByAccountId": "acc_…", "scannedByName": "Nguyễn Văn A",
    "accepted": true,
    "conflictReason": null,
    "serverReceivedAt": 1756370001234
  }],
  "nextSince": 1756370001234
}
```

- `accepted` là **phán quyết của server**, đã xử lý xong xung đột. Client không phân xử lại.
- `order=desc` dành cho màn hình "n lượt mới nhất" — đọc xuôi từ 0 trên sự kiện nghìn lượt
  thì nhận về những lượt cũ nhất. Cả hai chiều đều trả `nextSince` là mốc lớn nhất trong lô.
- Lô rỗng thì `nextSince` bằng đúng `since` đã gửi.

### 4.4 `POST /scans`

```
POST /scans
Content-Type: application/json

{ "scans": [{
  "clientEventId": "0f1c…",
  "eventId": "iuh-khaigiang-2026",
  "gateId": "cong-a",
  "ticketCode": "26656641",
  "outcome": "ADMITTED",
  "undoesEventId": null,
  "scannedAtWallClock": 1756370000000,
  "deviceSeq": 412,
  "deviceId": "5a2e…",
  "entryMode": "AUTO_SCAN"
}]}
```

Server nhận cả mảng trần lẫn `{ "scans": [...] }`. **Dùng dạng object** — sau này thêm được
trường ở cấp lô mà không phải đổi kiểu dữ liệu.

Tối đa **500 lượt mỗi lô**; quá thì `413 batch_too_large`.

```json
{ "acks": [
  { "clientEventId": "0f1c…", "accepted": true,  "conflictReason": null },
  { "clientEventId": "0f1d…", "accepted": false, "conflictReason": "Vé đã được cổng khác cho vào trước", "duplicate": true }
]}
```

`duplicate: true` nghĩa là server đã thấy `clientEventId` này rồi và trả lại đúng phán quyết
cũ. Đó là hành vi đúng, không phải lỗi.

`outcome` nhận đúng năm giá trị:

| `outcome` | Nghĩa |
|---|---|
| `ADMITTED` | Cho vào |
| `REJECTED_ALREADY_USED` | Mã đã được quét trước đó |
| `REJECTED_NOT_FOUND` | Mã không có trong danh sách |
| `REJECTED_CANCELLED` | Vé đã bị huỷ |
| `UNDONE` | Hoàn tác một lượt cho vào, kèm `undoesEventId` |

**Lượt từ chối cũng phải gửi lên.** Một mã lạ xuất hiện ở cổng là dữ liệu ban tổ chức cần.

Nếu lô có dòng sai hình dạng, server trả `400 bad_scan` cho **cả lô** kèm chỉ số dòng hỏng:

```json
{ "error": "bad_scan", "message": "Lô có dòng không hợp lệ",
  "problems": [{ "index": 3, "message": "thiếu ticketCode" }] }
```

---

## 5. Thuật toán đồng bộ mà client phải cài

Bốn endpoint trên là phần dễ. Phần khó — và phần quyết định hệ thống có mất dữ liệu hay
không — là client dùng chúng theo trình tự nào.

### 5.1 Kéo danh sách vé (delta theo phiên bản)

```
mốc = phiên bản đã áp dụng thành công lần trước (0 nếu chưa có gì)
nếu event.rosterVersion == mốc  →  không có gì để làm, dừng
cursor = 0
phiênBản = mốc
trangĐầu = true
lặp:
    trang = GET /events/{id}/roster?cursor={cursor}&since={mốc}
    nếu trangĐầu:  phiênBản = trang.version;  trangĐầu = false
    với mỗi vé trong trang.tickets:
        nếu vé.deleted  →  xoá khỏi bản local
        ngược lại       →  ghi đè bản local
    cursor = trang.nextCursor
cho tới khi cursor == null
ghi nhận: phiên bản đã áp dụng = phiênBản      ← CHỈ ở đây, sau khi hết mọi trang
```

Ba chỗ sai kinh điển, cả ba đều đã có bẫy sẵn trong thiết kế:

1. **Lấy `version` từ trang cuối thay vì trang đầu.** Trong lúc client đang tải trang 2 thì
   quản trị viên sửa danh sách; trang cuối mang phiên bản mới hơn phần dữ liệu client thực sự
   nhận được. Client sẽ tự nhận là đã đồng bộ tới phiên bản đó và **không bao giờ hỏi lại**
   phần thiếu. Lấy ở trang đầu thì cùng lắm là tải thừa một lần.
2. **Ghi nhận phiên bản khi mới tải được nửa chừng.** Hậu quả y hệt: thiếu vé vĩnh viễn.
3. **Bỏ qua `deleted`.** Vé bị gỡ vẫn nằm trên máy, và người đã bị loại vẫn qua được cổng.

`rosterVersion` **cố ý không đổi khi có người quét**. Nếu nó nhảy theo từng lượt quét thì
giữa buổi lễ mọi máy sẽ tải lại cả nghìn vé hàng trăm lần, đúng lúc mạng hội trường yếu nhất.
Trạng thái "đã vào" đi bằng đường khác — mục 5.2.

### 5.2 Kéo lượt quét của cổng khác

```
mốc = nextSince đã lưu (0 nếu máy vừa tham gia)
lặp:
    lô = GET /events/{id}/scans?since={mốc}&limit=500
    áp dụng từng lượt theo ĐÚNG THỨ TỰ server trả về
    mốc = lô.nextSince
cho tới khi lô.scans rỗng
lưu mốc
```

Hai ràng buộc:

- **Áp dụng theo đúng thứ tự server trả.** Server đã phân xử xong; client chỉ diễn lại. Tự
  sắp xếp lại hay tự quyết định "lượt nào thắng" là dựng ra một trọng tài thứ hai, và hai
  trọng tài sẽ ra hai kết quả khác nhau trên hai máy.
- **Không ghi đè trạng thái local của vé còn lượt quét chưa đẩy lên.** Máy vừa quét một người
  khi mất mạng; nếu một lần đồng bộ xoá dấu vết đó thì công việc offline biến mất. Giữ lại,
  đẩy lên, rồi để phán quyết của server ghi đè sau.

### 5.3 Đẩy lượt quét (hàng đợi chỉ-ghi-thêm)

Quét khi mất mạng là ca **bình thường**, không phải ca ngoại lệ. Client phải:

1. Ghi lượt quét xuống bộ nhớ bền **trước khi** hiện kết quả cho người dùng. Hiện "đã vào"
   rồi mới ghi là mở ra khoảng thời gian mà tắt app sẽ mất một lượt điểm danh.
2. Sinh `clientEventId` **duy nhất toàn cục** ngay tại máy (UUID). Đây là khoá chống trùng
   duy nhất server dùng.
3. Đẩy theo lô ở nền, thử lại khi hỏng tạm thời.
4. Chỉ đánh dấu "đã đồng bộ" cho những `clientEventId` **có mặt trong `acks`**. Id nào server
   không nhắc tới thì coi như chưa xong và giữ lại trong hàng đợi.
5. **Không sửa, không xoá** một lượt quét đã ghi. Hoàn tác là ghi **thêm** một dòng `UNDONE`
   trỏ vào `clientEventId` cũ qua `undoesEventId`.
6. Giữ `deviceSeq` là bộ đếm tăng dần **theo máy**, không reset khi mở lại app.

Vì sao phải chặt như vậy: `scan_events` là bằng chứng **duy nhất** ai đã dự sự kiện. Không có
nguồn thứ hai để dựng lại.

### 5.4 Server phân xử xung đột như thế nào

Hai cổng cùng offline có thể cùng cho một người vào; không máy nào biết máy kia. Server là
nơi duy nhất phân xử được, và luật là:

1. **Lượt quét sớm nhất thắng**, so bằng `scannedAtWallClock`.
2. Bằng nhau thì so `deviceSeq`, rồi tới `deviceId`.

Bước 2 không phải để công bằng mà để **tất định**: cùng một tập dữ liệu, đẩy lên theo thứ tự
nào cũng phải ra cùng một người thắng.

Khi một cổng offline đồng bộ muộn và giành lại được vé, lượt cũ **không bị xoá** — nó bị hạ
xuống `accepted: false` kèm `conflictReason`. Client nên hiện những dòng đó với dấu hiệu xung
đột thay vì giấu đi: người trực cổng cần biết đã có chuyện gì.

### 5.5 Trình tự khuyến nghị khi mở một sự kiện

```
GET /me                          → biết vai trò, đơn vị
GET /events                      → danh sách, có rosterVersion
   nếu đã có bản local            → VÀO THẲNG màn quét, đồng bộ chạy ở nền
   nếu chưa có gì                 → phải chờ tải xong, không có danh sách thì không quét được
song song ở nền:
   kéo roster delta (5.1)
   kéo scan feed (5.2)
   đẩy hàng đợi (5.3)
```

Bắt người trực cổng nhìn thanh tiến độ vài giây đúng lúc hàng người đã đứng trước mặt là thứ
tệ nhất màn hình chọn sự kiện có thể làm. Nhưng "vào nhanh" mà quên xếp hàng đồng bộ thì máy
sẽ soát vé bằng danh sách cũ mãi mãi — phải làm cả hai.

Nên chủ động kéo trước danh sách của các sự kiện sắp diễn ra khi máy còn ở nơi có wifi tốt,
và hiện cho người dùng thấy sự kiện nào đã có dữ liệu.

---

## 6. Nhóm endpoint quản trị

Cần vai trò `ADMIN` hoặc `SYSTEM`, trừ những dòng ghi rõ là chỉ `SYSTEM`. Tất cả nằm dưới
tiền tố `/admin`.

### Sự kiện

| Đường | Việc |
|---|---|
| `POST /admin/events` | Tạo hoặc sửa. Cần `eventId`, `name`. Gửi `createOnly: true` khi tạo để không lỡ tay ghi đè sự kiện cũ cùng mã. |
| `DELETE /admin/events/{eventId}` | Xoá. **Bị từ chối (`409 has_scans`) khi sự kiện đã có lượt quét** — đóng cổng thay vì xoá. |
| `POST /admin/events/{eventId}/gates` | Thêm/sửa cổng. Cần `gateId`, `name`. |
| `GET /admin/events/{eventId}/stats` | Số liệu: tổng vé, đã vào, đã huỷ, theo cổng, số xung đột, số lượt bị từ chối. |
| `GET /admin/events/{eventId}/attendance.csv` | File điểm danh. Xem 6.1. |

Thân của `POST /admin/events`:

```json
{
  "eventId": "iuh-khaigiang-2026", "name": "Lễ khai giảng 2026",
  "venue": "Hội trường A", "isLive": true,
  "eventDate": "2026-09-05", "startsAt": "07:00", "endsAt": "11:00", "allDay": false,
  "unitId": "u_cntt",
  "createOnly": true
}
```

Không gửi trường nào thì **giữ nguyên** giá trị cũ. `soldCount` và `ticketCodeLength` do
server tự suy ra, gửi lên cũng bị bỏ qua hoặc giữ nguyên. Sự kiện mới **bắt buộc** thuộc một
đơn vị, và việc tạo tiêu một lượt quota vĩnh viễn — xoá sự kiện không hoàn lượt.

### Danh sách vé

| Đường | Việc |
|---|---|
| `GET /admin/events/{id}/tickets?q=&status=&cursor=&limit=` | Duyệt, tìm, lọc. Kèm `totals` tính trên toàn sự kiện. |
| `POST /admin/events/{id}/tickets` | Thêm một vé. |
| `PATCH /admin/events/{id}/tickets/{ticketCode}` | Sửa. |
| `DELETE /admin/events/{id}/tickets/{ticketCode}` | Xoá **mềm**. |
| `POST /admin/events/{id}/roster` | Nạp một lô, tối đa **500 dòng**: `{ "tickets": [...] }` |

Mã vé chỉ nhận **chữ, số, gạch ngang, gạch dưới**, tối đa 64 ký tự — nó nằm trong đường dẫn.

Trường của một vé khi thêm/sửa: `ticketCode`, `holderName`, `holderRole`, `ticketType`,
`seat`, `status`.

Ba luật bất di bất dịch, client nào cũng phải biết trước khi dựng giao diện:

- **Nạp lại danh sách không đụng vào trạng thái check-in.** Bổ sung người giữa sự kiện là
  việc bình thường và nó không được phép xoá dấu vết ai đã vào.
- **Không đặt được `status: "USED"` bằng tay** → `400 status_not_settable`. "Đã vào" là kết
  luận rút ra từ một lượt quét có thật, có giờ, có cổng, có người quét. Cho phép gõ tay là
  làm hỏng đúng thứ cả hệ thống sinh ra để bảo đảm. Chiều ngược lại (`USED` → `VALID`, để gỡ
  một lượt vào nhầm) thì được, và server dọn sạch giờ vào, cổng, quyền giữ chỗ.
- **Nạp lại đúng file cũ không làm dòng nào đổi phiên bản**, nên máy soát vé hỏi delta sẽ
  nhận về rỗng thay vì tải lại cả nghìn vé.

Mọi thao tác ghi đều trả `version` mới của danh sách và đều được ghi vào nhật ký.

### 6.1 Xuất điểm danh

```
GET /admin/events/{eventId}/attendance.csv
```

Trả `text/csv; charset=utf-8` kèm `Content-Disposition: attachment`. Cột:

```
MSSV, Họ tên, Lớp, Đã dự, Giờ vào, Cổng, Người quét
```

- File có **BOM UTF-8** và xuống dòng CRLF — thiếu thì Excel trên Windows đọc tên tiếng Việt
  thành ký tự rác, mà Excel chính là thứ người nhận sẽ mở.
- Ô bắt đầu bằng `= + - @` được thêm dấu nháy đơn để Excel không chạy nó như công thức.
- Giờ cố định múi **+07:00**, dạng `dd/mm/yyyy hh:mm:ss`.
- Xuất **cả người chưa dự** (cột `Đã dự` rỗng): bên cộng điểm cần đối chiếu tổng số với danh
  sách gốc, và "vắng" cũng là một kết luận cần chứng minh.
- Mỗi lần tải đều ghi nhật ký `attendance.export`. File này là họ tên và MSSV của gần một
  nghìn sinh viên.

### Tài khoản, đơn vị, nhật ký

| Đường | Vai trò | Việc |
|---|---|---|
| `GET /admin/accounts` | ADMIN+ | ADMIN thấy người cùng đơn vị; SYSTEM thấy tất cả |
| `POST /admin/accounts` | ADMIN+ | Cần `displayName`, `role`, `unitId` (ADMIN thì lấy đơn vị của chính mình). `phone` không bắt buộc. |
| `PATCH /admin/accounts/{id}` · `DELETE /admin/accounts/{id}` | ADMIN+ | ADMIN không sửa được ADMIN khác |
| `POST /admin/accounts/{id}/bind` · `/unbind` | ADMIN+ | Gắn / gỡ tài khoản Zalo |
| `GET /admin/pending-logins` | ADMIN+ | Người đã đăng nhập nhưng chưa được cấp quyền |
| `POST /admin/pending-logins/{zaloId}/grant` | ADMIN+ | Cấp quyền cho một người trong hàng chờ |
| `GET /admin/admins` | SYSTEM | Danh sách admin, để gán chủ sở hữu |
| `GET /admin/units` · `POST` · `PATCH` · `DELETE` | **SYSTEM** | Quản đơn vị và quota |
| `POST /admin/units/request-quota` | ADMIN+ | Đơn vị xin thêm lượt: `{ "message": "..." }`, ghi vào nhật ký |
| `GET /admin/audit?limit=` | **SYSTEM** | Nhật ký toàn hệ thống, mới nhất trước, tối đa 500 |

Nhật ký trả về `{ id, at, actor, action, target, detail }`.

---

## 7. Giới hạn

| Thứ | Trần |
|---|---|
| Body JSON | 2 MB |
| Lượt quét mỗi lô `POST /scans` | 500 |
| Dòng mỗi lô nạp danh sách | 500 |
| Trang roster (`/roster`) | 200, cố định |
| Trang scan feed | 500 mặc định, 1000 tối đa |
| Nhật ký | 100 mặc định, 500 tối đa |
| Hạn token | 1 ngày |

---

## 8. Những điều client không được làm

- **Không giữ Zalo App Secret**, và nói chung không giữ bất kỳ khoá nào của server. Client
  chỉ có App ID.
- **Không tự phân xử xung đột.** Việc đó của server; client diễn lại phán quyết.
- **Không xoá hay sửa một lượt quét đã ghi**, ở cả máy lẫn payload. Hoàn tác là ghi thêm
  `UNDONE`.
- **Không tin vai trò lưu trong token hay trong cache lâu ngày.** Hỏi lại `/me`.
- **Không thử lại 4xx.** Sửa request rồi mới gửi.
- **Không vứt dữ liệu khi gặp 5xx.** Giữ trong hàng đợi và thử lại.

---

## 9. Điều hệ thống này chưa làm được

Client chỉ đối chiếu với danh sách đã tải về, nên **không phân biệt được vé thật với ảnh chụp
màn hình của vé đã chuyển cho người khác**. Người thứ hai xuất trình sẽ bị báo "đã quét", còn
ai mới là chủ thật thì hệ thống không trả lời được.

Bịt lỗ này là đổi **nội dung mã vé**, không phải đổi kiến trúc: ký mã vé (Ed25519 hoặc HMAC)
vào trong QR và kiểm chữ ký ở client trước khi tra danh sách. Roster, schema database và
toàn bộ giao diện giữ nguyên. Nếu bạn đang viết client mới và việc này quan trọng, hãy bàn
trước khi làm — cả hai đầu phải đổi cùng lúc.

---

## 10. Việc cần làm khi viết một client mới

1. Đăng ký thêm nền tảng cho app Zalo (iOS cần bundle id; Android cần package name và
   signature hash), rồi báo để server đổi `APP_REDIRECT_SCHEME` nếu cần scheme riêng.
2. Cài đăng nhập `POST /auth/zalo` → lưu token → `GET /me`.
3. Xử lý đủ ba trạng thái danh tính: chưa đăng nhập · đã đăng nhập nhưng `role` là `null` ·
   đã có vai trò.
4. Cài kho local cho vé và hàng đợi lượt quét, ghi bền trước khi hiện kết quả.
5. Cài đúng ba vòng đồng bộ ở mục 5, chạy ở nền.
6. Thử **bốn** kịch bản này trước khi đem ra dùng thật — chúng là chỗ hệ thống thật sự hỏng:
   - Bật máy bay giữa lúc quét, quét tiếp 20 người, rồi bật mạng lại.
   - Hai máy cùng quét một mã trong lúc cả hai đang offline.
   - Một máy tham gia sự kiện sau khi cổng đã chạy được nửa buổi.
   - Quản trị viên xoá một vé trong lúc máy đang offline; máy phải chặn người đó khi lên
     mạng lại.
7. Đối chiếu số liệu cuối cùng bằng `GET /admin/events/{id}/stats` và file CSV.
