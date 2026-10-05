// bridge.js
(function () {
  const extId = chrome.runtime.id;
  document.documentElement.setAttribute(
    "data-iuh-ext-url",
    `chrome-extension://${extId}/`,
  );
  document.documentElement.setAttribute(
    "data-iuh-model-url",
    chrome.runtime.getURL("tfjs_model/model.json"),
  );

  // 1. Đọc cấu hình từ Sync Storage và dán lên web
  chrome.storage.sync.get(
    [
      "webAppUrl",
      "autoCaptcha",
      "autoFillInfo",
      "autoClickLogin",
      "customColors",
      "calendarColorDirect",
      "calendarColorOnline",
      "calendarColorPractice",
      "calendarColorPostponed",
      "calendarColorExam",
    ],
    (data) => {
      document.documentElement.setAttribute(
        "data-iuh-webapp-url",
        data.webAppUrl || "",
      );
      document.documentElement.setAttribute(
        "data-iuh-auto-captcha",
        data.autoCaptcha !== false,
      );
      document.documentElement.setAttribute(
        "data-iuh-auto-fill",
        data.autoFillInfo !== false,
      );
      document.documentElement.setAttribute(
        "data-iuh-auto-login",
        data.autoClickLogin !== false,
      );

      // 🎨 Tổng hợp bảng màu hex từ cả hai nguồn lưu trữ:
      // - options.js lưu dưới key "customColors" (object { "ly-thuyet": "#hex", ... })
      // - portal.js lưu riêng từng key "calendarColorDirect", "calendarColorOnline", ...
      const mergedColors = {
        "ly-thuyet": "#616161",
        "thuc-hanh": "#33b679",
        "truc-tuyen": "#039be5",
        thi: "#f6bf26",
        "tam-ngung": "#d50000",
      };

      // Ưu tiên options.js customColors nếu có
      if (data.customColors) {
        if (data.customColors["ly-thuyet"])
          mergedColors["ly-thuyet"] = data.customColors["ly-thuyet"];
        if (data.customColors["thuc-hanh"])
          mergedColors["thuc-hanh"] = data.customColors["thuc-hanh"];
        if (data.customColors["truc-tuyen"])
          mergedColors["truc-tuyen"] = data.customColors["truc-tuyen"];
        if (data.customColors["thi"])
          mergedColors["thi"] = data.customColors["thi"];
        if (data.customColors["tam-ngung"])
          mergedColors["tam-ngung"] = data.customColors["tam-ngung"];
      }

      // Hàm kiểm tra hex hợp lệ
      const isValidHex = (hex) => /^#[0-9a-fA-F]{6}$/.test(hex);

      // Override bởi portal.js keys nếu có và phải là hex hợp lệ (tránh dính ID cũ '1'-'11')
      if (data.calendarColorDirect && isValidHex(data.calendarColorDirect))
        mergedColors["ly-thuyet"] = data.calendarColorDirect;
      if (data.calendarColorOnline && isValidHex(data.calendarColorOnline))
        mergedColors["truc-tuyen"] = data.calendarColorOnline;
      if (data.calendarColorPractice && isValidHex(data.calendarColorPractice))
        mergedColors["thuc-hanh"] = data.calendarColorPractice;
      if (
        data.calendarColorPostponed &&
        isValidHex(data.calendarColorPostponed)
      )
        mergedColors["tam-ngung"] = data.calendarColorPostponed;
      if (data.calendarColorExam && isValidHex(data.calendarColorExam))
        mergedColors["thi"] = data.calendarColorExam;

      document.documentElement.setAttribute(
        "data-iuh-custom-colors",
        JSON.stringify(mergedColors),
      );
    },
  );

  // 2. Đọc cờ hiệu Local Storage (Chế độ chạy ngầm) và dán lên web
  // Đã SỬA BUG: Thêm 'iuh_sync_weeks_count' vào mảng để lấy số tuần người dùng nhập
  chrome.storage.local.get(
    ["iuh_auto_sync_active", "iuh_sync_weeks_count"],
    (data) => {
      if (data.iuh_auto_sync_active) {
        document.documentElement.setAttribute(
          "data-iuh-auto-sync-active",
          "true",
        );
      }

      // Dán số tuần lên DOM để content.js có thể đọc được
      if (data.iuh_sync_weeks_count) {
        document.documentElement.setAttribute(
          "data-iuh-sync-weeks-count",
          data.iuh_sync_weeks_count.toString(),
        );
      }
    },
  );

  // 3. Lắng nghe hiệu lệnh từ content.js (MAIN WORLD) để báo cho background.js
  document.addEventListener("IuhSyncComplete", () => {
    chrome.runtime.sendMessage({ action: "syncComplete" });
  });

  document.addEventListener("IuhManualSyncComplete", () => {
    chrome.runtime.sendMessage({ action: "manualSyncComplete" });
  });
})();
