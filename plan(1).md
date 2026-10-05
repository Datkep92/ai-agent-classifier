# PLAN --- SMART AI API REGISTRY + ROUTER

## 0. MỆNH LỆNH THỰC THI

Bạn là AI triển khai dự án này. Hãy đọc toàn bộ PLAN trước khi sửa code.

Mục tiêu: xây một hệ thống mobile-first để người dùng chỉ cần **paste
URL / model / API key / JSON / text hỗn hợp**. Hệ thống tự phân loại,
discovery, map, test, đánh giá trạng thái và chuẩn bị logic xoay
vòng/fallback.

Ưu tiên: 1. Chính xác hơn "đoán". 2. Không làm mất dữ liệu đã paste. 3.
Không tự xóa key. 4. Không kết luận key chết chỉ vì `/models` lỗi. 5.
Inference thực tế có giá trị xác minh cao hơn model-list. 6. Thiết kế
lõi độc lập UI để sau này dùng chung cho Cloudflare Worker, Telegram và
EXE. 7. Mobile/Safari phải thao tác nhanh. 8. Không hard-code danh sách
model làm source-of-truth. 9. Không phá chức năng hiện có nếu tích hợp
vào project đang tồn tại. 10. Trước khi sửa: audit cấu trúc project và
tái sử dụng logic hiện có nếu phù hợp.

Nếu project hiện tại đã có registry/router/checker, KHÔNG tạo hệ thống
song song. Hãy tích hợp vào source-of-truth hiện có.

------------------------------------------------------------------------

# 1. MỤC TIÊU CUỐI

Luồng chuẩn:

``` text
PASTE ANYTHING
     ↓
SMART INGEST
     ↓
CLASSIFY
URL / MODEL / KEY / JSON / UNKNOWN
     ↓
NORMALIZE + DEDUPE
     ↓
DISCOVERY
     ↓
PROBE / VERIFY
     ↓
AUTO MAP
     ↓
REGISTRY
     ↓
TEST ENGINE
     ↓
ERROR CLASSIFIER
     ↓
HEALTH / SCORE / COOLDOWN
     ↓
SMART ROUTER
     ↓
KEY → MODEL → PROVIDER FALLBACK
```

Frontend đầu tiên là HTML mobile.

Về sau:

``` text
HTML ───────┐
Telegram ───┼──→ SAME CORE / SAME REGISTRY / SAME ROUTER
EXE ────────┘
                    ↓
              Cloudflare Worker
```

Không viết lại logic riêng cho Telegram/EXE.

------------------------------------------------------------------------

# 2. KIẾN TRÚC BẮT BUỘC

Tách thành các module logic độc lập (tên file có thể điều chỉnh theo
project):

``` text
core/
  ingest
  classifier
  normalizer
  discovery
  probe
  mapper
  registry
  error-classifier
  health
  router
  adapters
  storage

ui/
  mobile HTML/CSS/JS
```

UI KHÔNG được chứa toàn bộ business logic.

Core phải có thể gọi từ: - HTML/local - Cloudflare Worker - Telegram -
EXE/Node

Nếu hiện tại chưa có backend, V1 có thể chạy local nhưng phải giữ
interface để chuyển sang Worker sau.

------------------------------------------------------------------------

# 3. DATA MODEL

UI hiển thị dạng:

``` text
Provider / URL
└── Model
    └── Key
```

Nhưng storage KHÔNG duplicate key cho từng model.

Tối thiểu cần:

## Provider

``` js
{
  id,
  name,
  baseURL,
  protocol,
  status,
  createdAt,
  updatedAt,
  metadata
}
```

## Model

``` js
{
  id,
  providerId,
  modelId,
  source,       // pasted | discovered | imported
  status,
  capabilities,
  createdAt,
  updatedAt
}
```

## Key

``` js
{
  id,
  providerId,
  secret,
  fingerprint,
  masked,
  enabled,
  status,
  lastSuccessAt,
  lastFailureAt,
  createdAt,
  updatedAt
}
```

## Mapping

Key × Model phải là record riêng:

``` js
{
  providerId,
  modelId,
  keyId,
  status,
  verified,
  latencyMs,
  lastTestAt,
  lastSuccessAt,
  lastErrorClass,
  lastErrorMessage,
  cooldownUntil,
  failureCount,
  score
}
```

## Unresolved Item

``` js
{
  id,
  raw,
  detectedType,
  status: "UNRESOLVED",
  candidates: [],
  createdAt
}
```

Không được vứt bỏ input chưa map được.

------------------------------------------------------------------------

# 4. KEY FINGERPRINT + BẢO MẬT

Key phải có fingerprint để chống duplicate.

Ví dụ: - SHA-256 của secret. - UI chỉ hiện masked key. - Paste lại cùng
key → không tạo duplicate → chạy test lại/cập nhật trạng thái.

Không log full API key trong console, copylog hoặc error message.

V1 local có thể lưu secret theo storage hiện có, nhưng kiến trúc phải
chuẩn bị cho V2: - secret chuyển server-side/Cloudflare. - HTML không
giữ key production lâu dài.

KHÔNG tự xóa key. KHÔNG tự sửa secret của key.

Key sai được giữ lại với trạng thái phù hợp để tránh nhập lại thành key
"mới".

------------------------------------------------------------------------

# 5. SMART PASTE / SMART INGEST

UI chỉ cần một ô lớn:

``` text
Paste URL / Model / API Key / JSON / mixed text
```

Nút:

``` text
ANALYZE + IMPORT
```

Phải hỗ trợ: - Một URL. - Một model. - Một key. - Nhiều URL. - Nhiều
model. - Nhiều key. - URL + model + key lộn xộn. - JSON config. - Text
có label như `baseURL:`, `model:`, `apiKey:`. - Nội dung chưa biết.

Parser phải tách token/item trước rồi classify từng item.

Không yêu cầu người dùng paste đúng thứ tự.

------------------------------------------------------------------------

# 6. CLASSIFIER

Các loại:

``` text
URL
MODEL
API_KEY
JSON_CONFIG
UNKNOWN
```

Có confidence:

``` text
EXACT
HIGH
MEDIUM
LOW
UNRESOLVED
```

Prefix key như: - `oc_sk_` - `sk-or-` - `sk-`

chỉ là HINT.

Không được kết luận provider chỉ dựa vào prefix nếu chưa verify.

------------------------------------------------------------------------

# 7. TRƯỜNG HỢP CHƯA CÓ URL/MODEL

Nếu paste model nhưng chưa có provider:

``` text
space-bunny-free
→ MODEL
→ UNRESOLVED
```

Giữ lại.

Sau này provider discovery thấy model đó:

``` text
UNRESOLVED
→ AUTO RESOLVE
→ provider/model mapping
```

Nếu paste key chưa biết provider:

``` text
KEY
→ candidate providers
→ probe khi đủ dữ kiện
→ nếu chưa chắc: UNRESOLVED
```

Nếu paste URL mới hoàn toàn: - Không cần URL đã được hard-code. - Thử
xác định OpenAI-compatible. - Thử discovery. - Nếu thành công, tạo
Custom Provider.

Không hard-code provider/model mới là điều kiện để hệ thống hoạt động.

------------------------------------------------------------------------

# 8. URL NORMALIZATION

Phải chống các lỗi:

``` text
/v1/v1
//chat/completions
trailing slash
base URL chứa sẵn endpoint
```

Ví dụ input:

``` text
https://opencode.ai/zen/v1/
```

normalize thành base URL ổn định.

Không tự nối `/v1` nếu chưa có bằng chứng provider yêu cầu.

------------------------------------------------------------------------

# 9. ADAPTER LAYER

Tạo adapter abstraction.

Tối thiểu V1 hỗ trợ OpenAI-compatible Chat Completions:

``` text
GET  {baseURL}/models
POST {baseURL}/chat/completions
```

Adapter API gợi ý:

``` js
adapter.discoverModels(...)
adapter.probeModel(...)
adapter.classifyResponse(...)
adapter.buildRequest(...)
```

Provider đặc biệt sau này chỉ thêm adapter, không sửa router.

------------------------------------------------------------------------

# 10. DISCOVERY

Discovery và inference verification là HAI việc khác nhau.

Discovery:

``` text
GET /models
```

Nếu PASS: - import model IDs. - đánh `DISCOVERED`. - không tự kết luận
inference hoạt động.

Nếu `/models` fail: - KHÔNG đánh key DEAD. - tiếp tục cho phép inference
probe nếu có model candidate.

Điều này bắt buộc vì đã có trường hợp: - EXE `/chat/completions` PASS. -
checker `/models` lại không xác minh đúng.

------------------------------------------------------------------------

# 11. PROBE / INFERENCE TEST

Inference probe phải gần giống request production.

OpenAI-compatible:

``` json
{
  "model": "<model>",
  "messages": [
    {"role": "user", "content": "Reply exactly: OK"}
  ],
  "max_tokens": 5
}
```

Nếu provider yêu cầu token tối thiểu khác, adapter xử lý.

Probe phải: - timeout. - đo latency. - lưu HTTP status. - parse error
body. - không spam retry. - hạn chế token.

Inference PASS có độ tin cậy cao hơn `/models` PASS.

------------------------------------------------------------------------

# 12. TRẠNG THÁI

Mapping Key × Model:

``` text
🟢 HEALTHY
🔵 DISCOVERED
🟠 RATE_LIMITED
🟣 QUOTA_EXHAUSTED
🔴 AUTH_INVALID
⚫ EXPIRED
🟡 MODEL_DENIED
🔵 PROVIDER_DOWN
🟤 TEMP_ERROR
⚪ UNKNOWN_ERROR
❓ UNRESOLVED
```

Có thể dùng enum nội bộ không emoji.

UI mới thêm emoji.

------------------------------------------------------------------------

# 13. ERROR CLASSIFIER

Không dựa duy nhất HTTP status.

Phải xét: - HTTP status. - error.type. - error.code. - error.message. -
headers như `Retry-After`. - provider adapter rules.

Baseline:

## 401/403 invalid/revoked

``` text
AUTH_INVALID
→ bỏ key khỏi rotation
```

## expired

``` text
EXPIRED
→ bỏ key khỏi rotation
```

## 402 / insufficient credit / quota exhausted

``` text
QUOTA_EXHAUSTED
→ bỏ khỏi rotation
→ chờ manual/recheck policy
```

## 429 rate limit

``` text
RATE_LIMITED
→ cooldown
→ Retry-After nếu có
```

## 429 quota

Nếu body rõ quota exhausted:

``` text
QUOTA_EXHAUSTED
```

Không đánh mọi 429 là hết quota.

## model not allowed

``` text
MODEL_DENIED
```

Chỉ disable mapping Key × Model. KHÔNG disable toàn key.

## model not found/unavailable

Disable hoặc mark model/mapping phù hợp. Không kết luận key invalid.

## 5xx

``` text
PROVIDER_DOWN hoặc TEMP_ERROR
```

## timeout/network

``` text
TEMP_ERROR
```

## 400 malformed request

``` text
REQUEST_ERROR
```

Không xoay hàng chục key nếu lỗi là request format/code.

------------------------------------------------------------------------

# 14. QUOTA

Không được bịa số dư.

Nếu provider không có balance/usage endpoint:

``` text
Quota: UNKNOWN
Inference: PASS
```

Không hiển thị "còn X" nếu không có dữ liệu thật.

Nếu inference PASS:

``` text
HEALTHY
```

Điều này chỉ có nghĩa request hiện tại chạy được, không đồng nghĩa biết
số quota còn lại.

------------------------------------------------------------------------

# 15. ROUTING / ROTATION

Thứ tự mặc định:

``` text
KEY → MODEL → PROVIDER
```

Ví dụ:

``` text
OpenCode
  Space Bunny
    Key1
    Key2
    Key3

  Fledge
    Key1
    Key2

  Nemotron
    Key1

→ hết usable mapping

OpenRouter
  Space Bunny
    Key1
```

Nhưng router phải skip: - AUTH_INVALID - EXPIRED - QUOTA_EXHAUSTED -
disabled - active cooldown - MODEL_DENIED cho đúng mapping đó

Không skip toàn key chỉ vì một model denied.

------------------------------------------------------------------------

# 16. SMART SCORE

Không chỉ round-robin mù.

Mỗi mapping có score dựa trên: - enabled. - health. - latency. -
consecutive failures. - cooldown. - last success. - recent usage. -
manual priority (sau này). - provider priority.

V1 có thể dùng công thức đơn giản, deterministic.

Không cần ML/AI cho router.

------------------------------------------------------------------------

# 17. COOLDOWN

RATE_LIMITED: - ưu tiên `Retry-After`. - nếu không có →
exponential/backoff có giới hạn. - hết cooldown → mapping có thể được
probe/reuse.

TEMP_ERROR: - retry giới hạn. - sau đó fallback.

Không retry vô hạn.

------------------------------------------------------------------------

# 18. CIRCUIT BREAKER

Provider lỗi liên tục phải được tạm bỏ qua.

Ví dụ: - 5 provider-level failures trong window ngắn. - OPEN circuit
120s. - request mới skip provider. - hết 120s → HALF_OPEN. - cho 1
probe. - PASS → CLOSED. - FAIL → OPEN lại.

Ngưỡng/config phải để một chỗ, không magic-number rải rác.

------------------------------------------------------------------------

# 19. AUTO RECOVERY

Tự phục hồi:

``` text
RATE_LIMITED → hết cooldown → eligible
PROVIDER_DOWN → health probe → recover
TEMP_ERROR → retry/retest
```

Không spam:

``` text
AUTH_INVALID
EXPIRED
QUOTA_EXHAUSTED
```

Các trạng thái này chỉ recheck theo manual action hoặc lịch
thưa/configurable.

------------------------------------------------------------------------

# 20. TEST ENGINE

Các action:

``` text
TEST KEY
TEST MODEL
TEST PROVIDER
TEST FAILED
TEST HEALTHY
TEST ALL
```

`TEST ALL` phải có: - concurrency limit. - delay/jitter nếu cần. -
progress. - cancel. - không tạo request vô hạn. - tối thiểu token.

Test pipeline:

``` text
Connectivity
→ Discovery
→ Authentication
→ Inference
→ Latency
→ Classification
→ Registry update
```

------------------------------------------------------------------------

# 21. UI MOBILE-FIRST

Mục tiêu Safari/iPhone.

Không làm desktop UI thu nhỏ.

Top:

``` text
AI API MANAGER

[ Paste anything...              ]
[                                ]

[ ANALYZE + IMPORT ]
```

Summary:

``` text
🟢 Healthy
🟠 Cooldown
🟣 Quota
🔴 Invalid
❓ Unresolved
```

Tree:

``` text
▼ OpenCode                         🟢
  https://...

  ▼ space-bunny-free              🟢
      Key 01  🟢 720ms
      Key 02  🟠 48s
      Key 03  🟣 quota

  ▶ fledge-alpha-free

▼ OpenRouter                       🟢
```

Key chỉ hiện:

``` text
oc_s…AlQY
```

Không full secret.

------------------------------------------------------------------------

# 22. UI ACTIONS

Primary: - Paste. - Analyze + Import. - Test. - Test All. - Retry. -
Enable/Disable. - Expand/Collapse. - View error. - Export. - Import.

Không cần Edit/Delete nổi bật.

Nếu cần:

``` text
⋯ Advanced
  Delete
  Remove provider
  Clear test history
```

KHÔNG auto-delete.

Key không có "edit secret" theo kiểu sửa từng ký tự. Key mới = paste key
mới.

------------------------------------------------------------------------

# 23. UNRESOLVED INBOX

UI phải có:

``` text
❓ Unresolved
```

Ví dụ:

``` text
space-bunny-free
Type: MODEL
Waiting for provider

sk-xxxx
Type: KEY
Candidate: unknown
```

Khi registry có dữ liệu mới: - chạy resolver. - map tự động nếu
confidence đủ. - nếu nhiều candidate ngang nhau → giữ unresolved.

Không map bừa.

------------------------------------------------------------------------

# 24. AUTO MAP

Mapping phải dựa trên evidence:

Mức mạnh gợi ý:

``` text
Inference PASS             100
Authenticated /models PASS 70
Model found in provider     60
Known exact provider config 50
Key prefix hint             20
Name similarity             10
```

Không bắt buộc dùng đúng điểm trên nhưng phải giữ nguyên nguyên tắc:
**probe thực tế \> discovery \> heuristic**.

------------------------------------------------------------------------

# 25. DEDUPE

Provider: - normalized baseURL.

Model: - providerId + exact modelId.

Key: - fingerprint.

Mapping: - providerId + modelId + keyId.

Paste lại: - không duplicate. - update/retest.

------------------------------------------------------------------------

# 26. IMPORT / EXPORT

V1 phải có export JSON.

Export: - registry. - mappings. - statuses/config. - tùy chọn KHÔNG
export secrets mặc định.

Nếu export secrets: - phải có cảnh báo rõ. - không bật mặc định.

Import phải merge/dedupe, không blind overwrite.

------------------------------------------------------------------------

# 27. STORAGE

V1: - có thể localStorage/IndexedDB tùy project.

Ưu tiên IndexedDB nếu dữ liệu/history nhiều.

Nhưng tạo storage interface:

``` js
storage.getProviders()
storage.saveProvider()
storage.saveKey()
storage.saveModel()
storage.saveMapping()
...
```

để V2 chuyển Cloudflare KV/D1/DO mà core không đổi lớn.

------------------------------------------------------------------------

# 28. CLOUDFLARE-READY

Không cần deploy Cloudflare trong V1 nếu task hiện tại chỉ làm
HTML/core.

Nhưng code phải chuẩn bị: - fetch chuẩn Web API. - tránh Node-only
dependency trong core nếu không cần. - secret abstraction. - storage
abstraction. - router không phụ thuộc DOM.

V2 có thể dùng: - Worker = API/router. - D1/KV/DO = registry/state tùy
nhu cầu. - Secrets = API keys.

Không quyết định D1/KV/DO một cách tùy tiện nếu chưa audit workload.

------------------------------------------------------------------------

# 29. TELEGRAM-READY

Telegram sau này chỉ gọi cùng ingest API.

Ví dụ user paste:

``` text
https://...
model...
key...
```

Bot:

``` text
→ ingest
→ classify
→ map/test
→ trả summary
```

Không viết parser thứ hai cho Telegram.

------------------------------------------------------------------------

# 30. EXE-READY

EXE sau này có thể: - gửi request qua central router. - hoặc sync
registry/config nếu thiết kế yêu cầu.

Không copy/paste rotation logic vào EXE nếu central router đã tồn tại.

------------------------------------------------------------------------

# 31. OBSERVABILITY

Mỗi test lưu tối thiểu: - timestamp. - provider. - model. - masked
key/fingerprint. - HTTP status. - classification. - latency. - short
sanitized error.

Không lưu full key.

Có thể giữ last N events thay vì history vô hạn.

------------------------------------------------------------------------

# 32. TEST CASES BẮT BUỘC

Phải test tối thiểu:

### A. Paste URL trước

``` text
URL → provider → discovery
```

### B. Paste model trước

``` text
model → unresolved
paste URL sau → auto resolve
```

### C. Paste key trước

``` text
key → unresolved/candidate
provider xuất hiện → probe → map
```

### D. Paste cả cục hỗn hợp

Phân loại đúng và không duplicate.

### E. `/models` FAIL nhưng inference PASS

Kết quả phải là VERIFIED/HEALTHY, không INVALID.

### F. `/models` PASS nhưng inference FAIL auth

Phải phân loại auth theo inference.

### G. 429 rate-limit

Cooldown, không quota-exhausted nếu body không nói quota.

### H. quota exhausted

Không rotation vào mapping đó.

### I. model denied

Key vẫn có thể chạy model khác.

### J. provider 5xx

Fallback provider.

### K. malformed 400

Không xoay toàn bộ key vô ích.

### L. duplicate key

Không tạo bản ghi mới.

### M. duplicate provider trailing slash

Không tạo provider mới.

### N. unknown provider OpenAI-compatible

Discovery/probe và tạo custom provider nếu verify.

### O. circuit breaker

Provider bị skip trong OPEN state và recover HALF_OPEN.

------------------------------------------------------------------------

# 33. TEST THỰC TẾ

Nếu project có test framework: - thêm unit tests cho
classifier/error-classifier/router. - integration tests cho adapter bằng
mock fetch. - không gọi API thật trong automated test mặc định.

Manual real API test: - chỉ khi có key hợp lệ do user cấu hình. -
request tối thiểu. - không in key ra log.

------------------------------------------------------------------------

# 34. PERFORMANCE

Smart Paste phải phản hồi UI ngay: - parse/classify local trước. -
network discovery/test chạy async. - hiển thị progress từng item. -
không khóa UI.

Test nhiều mapping: - concurrency giới hạn. - không `Promise.all` hàng
trăm request không giới hạn.

------------------------------------------------------------------------

# 35. KHÔNG ĐƯỢC LÀM

Không: - hard-code model list làm nguồn duy nhất. - đánh key invalid vì
`/models` fail. - đánh mọi 429 là hết quota. - đánh cả key chết vì một
model denied. - tự xóa key. - log full API key. - lưu key duplicate. -
retry vô hạn. - fallback khi lỗi malformed request mà không phân loại. -
viết riêng logic HTML/Telegram/EXE. - map heuristic LOW confidence thành
VERIFIED. - bịa balance/quota. - sửa file ngoài phạm vi nếu không cần.

------------------------------------------------------------------------

# 36. PHASE TRIỂN KHAI

## PHASE 0 --- AUDIT

-   đọc project.
-   xác định stack.
-   xác định source-of-truth.
-   xác định logic API hiện có.
-   xác định storage hiện có.
-   xác định test/build commands.
-   ghi ngắn kết luận trước khi sửa.

## PHASE 1 --- CORE + UI SHELL

-   schema.
-   storage interface.
-   classifier.
-   normalizer.
-   registry.
-   mobile UI.
-   Smart Paste.
-   unresolved inbox.
-   import/export.

## PHASE 2 --- DISCOVERY + PROBE

-   adapter.
-   `/models`.
-   `/chat/completions`.
-   auto-map.
-   latency.
-   sanitized errors.

## PHASE 3 --- HEALTH + ROUTER

-   error classifier.
-   statuses.
-   cooldown.
-   score.
-   rotation Key → Model → Provider.
-   circuit breaker.
-   recovery.

## PHASE 4 --- TEST + HARDEN

-   unit/integration tests.
-   edge cases.
-   mobile Safari review.
-   dedupe.
-   error handling.
-   security review.

Không nhảy sang Telegram/Cloudflare deployment trước khi core V1 PASS,
trừ khi project hiện tại bắt buộc backend để hoạt động.

------------------------------------------------------------------------

# 37. DEFINITION OF DONE

Chỉ được báo DONE khi:

1.  UI chạy được.
2.  Paste mixed input được.
3.  URL/model/key được classify.
4.  Unknown được giữ ở Unresolved.
5.  Provider mới có thể discovery nếu OpenAI-compatible.
6.  Model discovery hoạt động.
7.  Inference probe hoạt động.
8.  `/models` fail không làm chết key nếu inference pass.
9.  Error classification hoạt động.
10. Key/model/provider mapping không duplicate.
11. Rotation hoạt động đúng Key → Model → Provider.
12. Cooldown hoạt động.
13. Circuit breaker hoạt động.
14. Model denied không khóa toàn key.
15. Quota/rate-limit được phân biệt khi response đủ dữ kiện.
16. UI không lộ full secret.
17. Test/build hiện có PASS hoặc ghi rõ blocker thực tế.
18. Không phá behavior cũ.
19. Có hướng dẫn chạy.
20. Có COPYLOG cuối cùng.

------------------------------------------------------------------------

# 38. COPYLOG --- BẮT BUỘC

Terminal của người dùng khó copy. Vì vậy sau khi hoàn thành, AI BẮT BUỘC
tạo một file báo cáo dễ mở/copy.

Tên ưu tiên:

``` text
copylog.txt
```

Đặt tại ROOT của project, trừ khi project đã có convention khác rõ ràng.

Nếu `copylog.txt` đã tồn tại: - append một section mới có timestamp. -
không xóa lịch sử cũ.

Nội dung COPYLOG phải là plain text, ngắn nhưng đủ kiểm tra:

``` text
==================================================
SMART API MANAGER — IMPLEMENTATION REPORT
Time:
Status: PASS / PARTIAL / BLOCKED

1. AUDIT
- Stack:
- Existing architecture:
- Source of truth reused:

2. FILES CHANGED
- path
  - changed what
- path
  - changed what

3. IMPLEMENTED
[PASS] Smart Paste
[PASS] Classifier
[PASS] Registry
...

4. ROUTER
- Rotation order:
- Cooldown:
- Circuit breaker:

5. TEST RESULTS
- command:
- result:

6. MANUAL TEST
- what was tested
- result

7. KNOWN ISSUES
- none / list

8. HOW TO RUN
<exact commands>

9. HOW TO OPEN
<exact local URL/path>

10. NEXT RECOMMENDED STEP
<one concise next step>
==================================================
```

Rất quan trọng: - KHÔNG ghi API key đầy đủ vào `copylog.txt`. - Mask
key. - Không ghi secret/token/password. - Các command phải là command
sạch có thể copy. - Nếu build/test fail, ghi nguyên nhân thật; không báo
PASS giả.

Sau khi tạo `copylog.txt`, AI phải: 1. đọc lại file. 2. xác nhận file
tồn tại. 3. xác nhận không có secret rõ ràng. 4. in ra terminal CHỈ
đường dẫn tới `copylog.txt` và status cuối cùng, để người dùng có thể mở
file bằng Filza/editor/UI khác.

------------------------------------------------------------------------

# 39. CÁCH AI PHẢI LÀM VIỆC

-   Điều tra trước, sửa sau.
-   Không hỏi người dùng những thứ có thể tự xác định từ project.
-   Nếu có ambiguity không ảnh hưởng lớn, chọn phương án an toàn và ghi
    vào copylog.
-   Thay đổi tối thiểu nhưng kiến trúc phải mở rộng được.
-   Không tạo abstraction vô ích.
-   Không rewrite toàn project nếu không cần.
-   Reuse code hiện có.
-   Sau mỗi phase quan trọng, chạy test phù hợp.
-   Trước DONE, chạy full verification.
-   Nếu gặp blocker thật, dừng ở trạng thái PARTIAL/BLOCKED và ghi chính
    xác vào copylog.

------------------------------------------------------------------------

# 40. KẾT QUẢ MONG MUỐN

Người dùng cuối chỉ cần:

``` text
1. Mở UI trên iPhone.
2. Paste bất kỳ URL/model/key/config.
3. Bấm ANALYZE + IMPORT.
4. Hệ thống tự classify.
5. Tự discovery.
6. Tự probe.
7. Tự map.
8. Tự phân loại health/quota/rate-limit/auth/model.
9. Router tự chọn mapping khỏe.
10. Khi lỗi → tự fallback theo Key → Model → Provider.
```

Đây là lõi phải đủ sạch để bước tiếp theo chỉ cần gắn: - Cloudflare
Worker. - Telegram Bot. - EXE.

Không viết lại core ở các bước sau.
