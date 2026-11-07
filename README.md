# 🎓 IUH Alternative Dashboard

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TensorFlow.js](https://img.shields.io/badge/TensorFlow.js-Client--Side-orange?style=flat-square)](https://www.tensorflow.org/js)
[![Chart.js](https://img.shields.io/badge/Chart.js-3.9.1-coral?style=flat-square)](https://www.chartjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

## 📌 Giới thiệu

**IUH Alternative Dashboard** là tiện ích mở rộng (*Chrome Extension*) xây dựng trên chuẩn **Manifest V3**, thay thế hoàn toàn giao diện mặc định cũ kỹ của cổng thông tin sinh viên Đại học Công nghiệp TP.HCM (IUH - `sv.iuh.edu.vn` & `dkhp.iuh.edu.vn`).

Dự án phát triển theo mô hình **Single Page Application (SPA)** hiện đại, hoạt động **100% ngầm tại Client (No-Server)**. Ứng dụng kết hợp kỹ thuật Web Scraping an toàn, kết nối trực tiếp API đào tạo PMT-EMS, và mô hình Trí tuệ Nhân tạo (*TensorFlow.js*) chạy trên trình duyệt nhằm đem lại trải nghiệm học tập, quản lý điểm số và đăng ký học phần mượt mà, tự động hóa cao và an toàn tuyệt đối.

---

## ✨ Tính năng nổi bật

### 1. ⚡ Bộ công cụ Đăng ký học phần (DKHP Ultimate Suite)
* 📅 **Lập kế hoạch & Xếp Thời khóa biểu trực quan (Interactive LHP Planner):**
  * Tra cứu toàn bộ môn học từ **Chương trình khung (CTK)** theo từng học kỳ.
  * Xem trước ma trận lịch học dạng lưới tuần (Thứ 2 đến Chủ nhật, Tiết 1 đến 16).
  * **Ghost Preview:** Di chuột qua từng lớp mở để xem trước vị trí ca học trên lưới thời khóa biểu.
* 🔍 **Quét lớp mở DKHP trực tiếp (Direct PMT-EMS API):**
  * Gọi trực tiếp endpoint `/DangKyHocPhan/GetDanhSachLopHocPhan` để tải danh sách lớp mở, sĩ số thực, giảng viên, phòng học và thời gian biểu.
  * Hỗ trợ tra cứu và hiển thị danh sách lớp mở của **môn học phần đã bị áp cứng** (vốn bị ẩn trên giao diện web mặc định của trường).
* ⚠️ **Phát hiện trùng lịch học thông minh (Conflict Detection):**
  * Tự động kiểm tra chéo xung đột tiết học giữa tất cả các môn đã ghim, phân tích đồng thời cả **ca Lý thuyết** và **ca Thực hành**.
* 💰 **Dự toán Tín chỉ & Học phí học kỳ:**
  * Bóc tách chính xác số tín chỉ Lý thuyết (LT) và Thực hành (TH).
  * Tự động suy luận đơn giá và tính tổng học phí dự kiến cần nộp.
* 🚀 **Đăng ký tức thời lúc mở cổng (Zero-Hour 1-Click Speed-Run):**
  * Tự động nhận diện đợt mở đăng ký (`CheckDotChoPhepDangKy`).
  * Gửi lệnh đăng ký hàng loạt toàn bộ môn trong kế hoạch chỉ với **1-Click**, hoàn tất trong vài giây.
* 🎯 **Chế độ Bắn tỉa canh slot (Sniper Mode / Drop Hunting):**
  * Thăm dò định kỳ sĩ số thực tế của các lớp đã đầy (Full slot).
  * Bắt khoảnh khắc mili-giây khi có sinh viên nhả slot (Drop/Cancel) để tự động bắn lệnh đăng ký ngay lập tức.
  * Tự động chuyển đổi sang lớp dự phòng nếu lớp chính bị khóa hoặc không còn chỗ (`autoPickOpenClass`).
* 🛡️ **Bảo vệ phiên & Điều tốc thông minh:**
  * **Hàng đợi request (dkhpEnqueue):** Giới hạn tần suất gửi lệnh, chống nghẽn mạng và chống kích hoạt Cloudflare WAF / HTTP 403.
  * **Exponential Backoff:** Tự động giãn cách nhịp gửi khi server trường có dấu hiệu quá tải.
  * **Mutex Lock:** Đồng bộ khóa phiên độc quyền giữa tab Dashboard và trang web gốc, ngăn chặn xung đột đăng ký trùng lặp.

---

### 2. 🤖 AI Captcha Solver & Auto-Login
* Tích hợp sẵn mô hình Deep Learning (*TensorFlow.js* - `tf.min.js`) xử lý hình ảnh Captcha trực tiếp trên trình duyệt, không cần gửi ảnh về server ngoài.
* Nhận diện và điền tự động mã Captcha tại các cổng `sv.iuh.edu.vn` và `dkhp.iuh.edu.vn`.
* Tự động duy trì phiên đăng nhập (Keep-alive), ngăn chặn việc bị văng tài khoản vào các khung giờ cao điểm.

---

### 3. 📊 Quản lý Điểm số, GPA & Biểu đồ Phổ điểm LHP
* Tự động quét và phân tích điểm của tất cả học kỳ trong suốt khóa học.
* Tự động lọc trùng môn (ưu tiên điểm cao nhất của môn học cải thiện / học lại).
* Tính toán tổng tín chỉ tích lũy, GPA hệ 10 và hệ 4, trực quan hóa tiến độ tích lũy qua thanh Progress Bar.
* **Phổ điểm môn học:** Truy xuất ngầm dữ liệu điểm của toàn bộ sinh viên trong lớp học phần, trực quan hóa tỷ lệ A, B, C, D, F và thứ hạng bằng biểu đồ cột `Chart.js`.

---

### 4. 📝 Tự động Khảo sát đánh giá (Auto Survey)
* Quét toàn bộ phiếu khảo sát giảng viên chưa hoàn thành.
* Thuật toán Smart Random pha trộn tỷ lệ 80% mức "Rất hài lòng" và 20% "Hài lòng", giúp vượt qua các cơ chế phát hiện tự động của cổng thông tin và tự động nộp bài.

---

### 5. 📅 Đồng bộ Lịch học sang Google Calendar
* Kết nối với backend Google Apps Script (GAS) triển khai riêng của cá nhân.
* Đồng bộ toàn bộ thời khóa biểu, lịch thi sang Google Calendar với mã màu phân loại trực quan (Lý thuyết, Thực hành, Lịch thi, Trực tuyến, Tạm hoãn).
* Nhắc nhở lịch học trước giờ lên lớp qua thông báo điện thoại.

---

## 🧩 Kiến trúc hệ thống (No-Server Client Architecture)

```text
[Cổng Đào tạo IUH (sv.iuh.edu.vn / dkhp.iuh.edu.vn)]
                        │
                        ▼
    ┌──────────────────────────────────────────────┐
    │           Content Scripts & Agents           │
    │  - content.js / autologin.js (Chặn UI cũ)    │
    │  - dkhp_agent.js (Tiêm thanh công cụ DKHP)   │
    │  - survey_agent.js (Xử lý khảo sát)          │
    │  - tf.min.js (AI bẻ khóa Captcha)            │
    └──────────────────────────────────────────────┘
                        │
                        ▼
    ┌──────────────────────────────────────────────┐
    │       Core Engine & Storage (Client-side)    │
    │  - background.js (Service Worker MV3)        │
    │  - chrome.storage.local (Cache TKB, CTK, ĐK) │
    │  - Mutex Lock / Request Queue & Backoff      │
    └──────────────────────────────────────────────┘
                        │
                        ▼
    ┌──────────────────────────────────────────────┐
    │       IUH Dashboard SPA (portal.html)        │
    │  - portal.js / portal.css (Giao diện SPA)    │
    │  - dkhp-api.js (Bộ API & Thuật toán Sniper)  │
    │  - grade-scraper.js (Quét điểm & GPA)        │
    │  - Chart.js (Vẽ biểu đồ phổ điểm)            │
    └──────────────────────────────────────────────┘
```

---

## 🛠️ Hướng dẫn Cài đặt & Sử dụng

### 1️⃣ Cài đặt Extension vào trình duyệt
1. Clone hoặc tải mã nguồn dự án về máy tính:
   ```bash
   git clone https://github.com/phamhaidang102/IUH-Dashboard.git
   ```
2. Mở trình duyệt Google Chrome (hoặc Edge, Brave, Cốc Cốc...) và truy cập:
   ```text
   chrome://extensions/
   ```
3. Bật công tắc **Developer mode (Chế độ nhà phát triển)** ở góc trên bên phải.
4. Bấm **Load unpacked (Tải tiện ích đã giải nén)** và chọn thư mục dự án chứa file `manifest.json`.

---

### 2️⃣ Thiết lập thông tin cá nhân
1. Click vào biểu tượng Extension IUH trên thanh tiện ích để mở trang **Cài đặt (Options)**.
2. Nhập **MSSV** và **Mật khẩu** sinh viên.
3. Tùy chỉnh bật/tắt các tính năng:
   * *Tự động đăng nhập & Giải Captcha bằng AI*
   * *Tự động làm khảo sát*
   * *Cấu hình màu sắc đồng bộ Google Calendar*
4. Dán URL **Google Apps Script Web App** (nếu sử dụng tính năng đồng bộ lịch học).
5. Bấm **Lưu toàn bộ cấu hình**.

---

### 3️⃣ Hướng dẫn sử dụng Đăng ký học phần & Sniper
1. Mở trang sinh viên hoặc truy cập Dashboard: `chrome-extension://<EXTENSION_ID>/dashboard/portal.html`.
2. Chuyển sang mục **Đăng ký học phần**:
   * **Lập kế hoạch trước giờ G:** Vào tab *Chương trình khung* hoặc *Lịch học dự kiến*, bấm **Quét lớp mở DKHP** để xem sĩ số và thời khóa biểu từng lớp. Bấm **Ghim vào lịch dự kiến** để xếp TKB và kiểm tra trùng lịch.
   * **Đăng ký tức thời (20:00:00):** Trước giờ mở cổng, mở sẵn tab Dashboard. Khi cổng mở, nhấn nút **🚀 Tự động Đăng ký toàn bộ** để hoàn tất đăng ký trong 1 cú click.
   * **Canh slot lớp Full (Sniper):** Thêm mã lớp học phần vào danh sách, bấm **Bật Sniper**. Hệ thống sẽ tự động quét ngầm và nộp đơn ngay khi có vị trí trống.

---

## 📂 Cấu trúc thư mục dự án

```text
IUH-Dashboard/
├── dashboard/
│   ├── dkhp-api.js         # API kết nối DKHP, thuật toán kiểm tra trùng lịch, Sniper & Bộ xếp TKB
│   ├── grade-scraper.js    # Cào điểm, tính toán GPA và phân tích phổ điểm
│   ├── portal.css          # Giao diện hiện đại (Modern Responsive, Glassmorphism, Dark/Light Mode)
│   ├── portal.html         # Khung giao diện chính SPA Dashboard
│   └── portal.js           # Bộ điều hướng, xử lý sự kiện và render giao diện Dashboard
├── GAS/
│   └── Code.js             # Mã nguồn Google Apps Script đồng bộ dữ liệu với Google Calendar
├── tfjs_model/             # Trọng số mô hình Machine Learning giải mã Captcha IUH
│   ├── group1-shard1of3.bin
│   ├── group1-shard2of3.bin
│   ├── group1-shard3of3.bin
│   └── model.json
├── autologin.js            # Tự động hóa đăng nhập và kích hoạt model Captcha
├── background.js           # Service Worker nền tảng Manifest V3
├── bridge.js               # Cầu nối dữ liệu giữa MAIN world và Extension Context
├── content.js              # Content script chặn render giao diện cũ tại sv.iuh.edu.vn
├── dkhp_agent.js           # Content script hỗ trợ thao tác tự động tại cổng dkhp.iuh.edu.vn
├── manifest.json           # Tệp cấu hình phân quyền và tài nguyên Extension MV3
├── options.html            # Giao diện trang cấu hình tài khoản và thiết lập tiện ích
├── options.js              # Logic lưu trữ và quản lý cấu hình tiện ích
├── README.md               # Tài liệu hướng dẫn sử dụng và giới thiệu dự án
├── survey_agent.js         # Tác tử tự động giải quyết các biểu mẫu khảo sát đánh giá
└── tf.min.js               # Thư viện TensorFlow.js rút gọn cho môi trường Extension
```

---

## 📌 Disclaimer (Miễn trừ trách nhiệm)

Dự án này được phát triển với mục đích học tập, nghiên cứu ứng dụng công nghệ Client-side Deep Learning (*TensorFlow.js*) và tối ưu hóa trải nghiệm cá nhân trong học tập cho sinh viên IUH. Tác giả hoàn toàn không chịu bất kỳ trách nhiệm nào liên quan đến việc sử dụng công cụ sai mục đích hoặc vi phạm các quy chế hệ thống công nghệ thông tin của nhà trường.
