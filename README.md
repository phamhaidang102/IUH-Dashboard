# 🎓 IUH Alternative Dashboard

## 📌 Giới thiệu

**IUH Alternative Dashboard** là một tiện ích mở rộng (_Chrome Extension_) sử dụng kiến trúc **Manifest V3**, được thiết kế để thay thế hoàn toàn giao diện mặc định cũ kỹ của cổng thông tin sinh viên Đại học Công nghiệp TP.HCM (IUH).

Tiến hóa từ dự án đồng bộ lịch học, phiên bản này lột xác thành một **Single Page Application (SPA)** hiện đại, trực quan và chạy 100% ngầm ở phía Client (No-Server). Hệ thống kết hợp kỹ thuật Web Scraping an toàn và trí tuệ nhân tạo (AI) để mang lại trải nghiệm quản lý học tập tối ưu, tự động hóa và bảo mật tuyệt đối cho sinh viên.

---

## ✨ Tính năng nổi bật

- 🤖 **AI Captcha Solver & Auto-Login:** Kế thừa sức mạnh từ phiên bản trước, tiện ích tích hợp sẵn mô hình Học máy (_TensorFlow.js_ thông qua `tf.min.js`) chạy trực tiếp trên trình duyệt để bẻ khóa mã Captcha và tự động đăng nhập mượt mà.
- 📊 **Quản lý Điểm số & Tiến Độ Học Tập:**
  - Tự động gửi lệnh `fetch()` ngầm trang kết quả học tập để cào danh sách ID của tất cả học kỳ.
  - Lọc bỏ các môn học trùng (chỉ giữ điểm cao nhất của môn cải thiện/học lại).
  - Tính toán tổng số tín chỉ tích lũy, GPA hệ 10 và hệ 4. Hiển thị thông qua thanh tiến trình (Progress Bar) động.
- 📈 **Phân Tích Điểm Trung Bình Lớp Học Phần:** Gửi request ngầm mô phỏng hành vi click vào chi tiết môn học. Đếm số lượng sinh viên đạt điểm A, B, C, D, F và tính vị trí xếp hạng. Trực quan hóa dữ liệu bằng biểu đồ cột (Bar Chart) thông qua thư viện `Chart.js` (`libs/chart.umd.js`).
- 📝 **Khảo Sát Tự Động (Auto Survey):** Quét ngầm các phiếu đánh giá chưa hoàn thành. Tự động điền form với thuật toán trộn ngẫu nhiên tỉ lệ 80-20 giữa mức "Rất hài lòng" và "Hài lòng" nhằm qua mặt hệ thống Bot-detection, sau đó tự động kích hoạt sự kiện `.click()` nộp bài.
- 🎨 **Thay Thế Giao Diện (UI Overrider):** Chặn đứng quá trình render giao diện gốc của trường ngay khi truy cập `sv.iuh.edu.vn/home.html`, phủ lên một lớp overlay nạp nội dung từ `dashboard/portal.html` với thiết kế Sidebar điều hướng, thẻ Card số liệu và hiệu ứng Dark Mode responsive.

---

## 🧩 Kiến trúc hoạt động (No-Server Workflow)

Hệ thống hoạt động hoàn toàn độc lập trên trình duyệt của người dùng, không phụ thuộc vào bất kỳ Server trung gian nào:

```text
[Website Lịch Trường IUH]
          │
          ▼
[Content Script - Chặn Render UI gốc & Tiêm Portal SPA overlay]
          │
          ▼
[Bridge.js - Giao tiếp giữa MAIN world và Extension Context]
          │
          ▼
[Client Script - Fetch ngầm (Rate Limiting) & Giải mã AI]
          │
          ▼
[Lưu trữ cục bộ an toàn vào chrome.storage.local (Caching)]
          │
          ▼
[Dashboard SPA - Hiển thị DOM Parser & Vẽ biểu đồ Chart.js]
```

---

## 🛠️ Hướng dẫn Cài đặt & Triển khai

### 1️⃣ Triển khai Google Apps Script (Phía Server)

Để lưu trữ và gán màu lịch học lên tài khoản Google của bạn, hãy tạo một cổng kết nối API:

1. Truy cập vào **Google Apps Script** và tạo một dự án mới.
2. Tạo file script và dán toàn bộ mã nguồn xử lý sự kiện từ file `/gas/Code.js` trong thư mục dự án này vào.
3. Bấm vào nút **Deploy (Triển khai)** ở góc trên cùng bên phải `-->` Chọn **New deployment (Triển khai mới)**.
4. Chọn loại cấu hình là **Web app (Ứng dụng web)**:
   - _Execute as (Thực thi dưới danh nghĩa):_ **Me (Tôi)**
   - _Who has access (Người có quyền truy cập):_ **Anyone (Bất kỳ ai)**
5. Bấm **Deploy**, tiến hành cấp quyền truy cập lịch nếu Google yêu cầu, sau đó sao chép lại đoạn **Web App URL** được cấp.

> ⚠️ **Lưu ý cực kỳ quan trọng:** Mỗi lần bạn chỉnh sửa mã nguồn trên Google Apps Script, bạn bắt buộc phải chọn **Manage Deployments (Quản lý bản triển khai)** `-->` Bấm biểu tượng **Cây bút** `-->` Chọn **New Version (Phiên bản mới)** thì code mới thực sự có hiệu lực đằng sau Web App.

---

### 2️⃣ Cài đặt Chrome Extension (Phía Client)

1. Tải toàn bộ mã nguồn của dự án này về máy tính của bạn và giải nén.
2. Mở trình duyệt Google Chrome (hoặc Edge, Brave, Opera...) và truy cập đường dẫn: `chrome://extensions/`.
3. Bật công tắc **Developer mode (Chế độ nhà phát triển)** ở góc trên bên phải giao diện.
4. Bấm vào nút **Load unpacked (Tải tiện ích đã giải nén)** ở góc trái và trỏ tới thư mục chứa mã nguồn Extension của bạn.

---

### 3️⃣ Cấu hình Dashboard để chạy ứng dụng

1. Click vào biểu tượng Extension IUH trên thanh công cụ của trình duyệt để mở **Bảng điều khiển (Dashboard)**.
2. Tiến hành cấu hình các thông số:
   - Dán link **Google Apps Script WebApp URL** đã copy ở Bước 1 vào ô API.
   - Nhập tài khoản **MSSV** và **Mật khẩu** sinh viên của bạn vào ô tương ứng.
   - Bật/Tắt các nút gạt tự động điền thông tin, tự động giải Captcha bằng AI theo nhu cầu sử dụng.
   - Lựa chọn màu sắc phân loại (Lý thuyết, Thực hành, Trực tuyến, Lịch thi, Lịch hoãn) bằng các ô chọn trực quan.
3. Bấm nút **LƯU TOÀN BỘ CẤU HÌNH** để hệ thống đồng bộ ghi nhận dữ liệu vào bộ nhớ của Chrome.

---

## 📅 Phân loại màu sắc mặc định (Mốc ban đầu)

Khi khởi tạo hoặc chưa có cấu hình riêng, hệ thống tự động gán các màu sắc đặc trưng bao gồm:

- 🔘 **Môn Lý thuyết:** Màu _Graphite (Xám)_
- 🌿 **Môn Thực hành:** Màu _Sage (Xanh lá nhạt)_
- 🔵 **Môn Trực tuyến:** Màu _Blueberry (Xanh dương)_
- 🟡 **Lịch Thi:** Màu _Banana (Vàng)_
- 🔴 **Tạm ngưng / Hoãn:** Màu _Tomato (Đỏ)_

---

## 📂 Cấu trúc thư mục dự án

```text
iuh-calendar-sync/
├── dashboard/
│   ├── grade-scraper.js
│   ├── portal.css
│   ├── portal.html
|   ├── grade-scraper.js
|   ├── dkhp-api.js
│   └── portal.js
├── GAS/
│   └── Code.js
├── tfjs_model/
│   ├── group1-shard1of3.bin
│   ├── group1-shard2of3.bin
│   ├── group1-shard3of3.bin
│   └── model.json
├── autologin.js
├── background.js
├── bridge.js
├── content.js
├── manifest.json
├── options.html
├── options.js
├── README.md
├── survey_agent.js
└── tf.min.js
```

📌 Disclaimer (Miễn trừ trách nhiệm)
Dự án này được phát triển hoàn toàn vì mục đích học tập, nghiên cứu ứng dụng công nghệ học máy (TensorFlow.js) chạy trên Client và hỗ trợ nâng cao trải nghiệm cá nhân, quản lý thời gian hiệu quả cho sinh viên IUH. Tác giả hoàn toàn không chịu bất kỳ trách nhiệm nào liên quan đến việc sử dụng công cụ này sai mục đích hoặc vi phạm các quy chế hệ thống thông tin của nhà trường.
