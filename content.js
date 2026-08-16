// content.js
(function () {
  console.log(
    "[IUH Sync] Content Script Loaded - Full Automation Mode with AI Solver",
  );

  // Vá lỗi jQuery cũ của web trường
  if (window.jQuery && !window.jQuery.fn.andSelf) {
    window.jQuery.fn.andSelf = window.jQuery.fn.addBack;
    console.log(
      "[IUH Sync] 🛠️ Đã vá thành công lỗi .andSelf() của web trường.",
    );
  }

  // Hằng số thời gian tiết học
  const TIET_TIME = {
    1: "06:30",
    2: "07:20",
    3: "08:10",
    4: "09:10",
    5: "10:00",
    6: "10:50",
    7: "12:30",
    8: "13:20",
    9: "14:10",
    10: "15:10",
    11: "16:00",
    12: "16:50",
    13: "18:00",
    14: "18:50",
    15: "19:50",
    16: "20:40",
    17: "21:30",
    18: "22:20",
  };

  // Bảng màu hex mặc định Fallback (hex tự do, hỗ trợ toàn bộ bảng màu mới của Google Calendar)
  const GOOGLE_COLORS = {
    "ly-thuyet": "#616161", // Graphite (ọ xám)
    "thuc-hanh": "#33b679", // Sage (xanh mint)
    "truc-tuyen": "#039be5", // Peacock (xanh lơ)
    thi: "#f6bf26", // Banana (vàng)
    "tam-ngung": "#d50000", // Tomato (đỏ)
  };

  const CHARACTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let iuhModel = null;

  // =========================================================================
  // UI WIDGET (Hiển thị tiến trình trong tab ngầm - Dùng cho mục đích Debug)
  // =========================================================================
  function updateSyncWidget(message, status = "processing") {
    let widget = document.getElementById("iuh-sync-widget");
    if (!widget) {
      widget = document.createElement("div");
      widget.id = "iuh-sync-widget";
      widget.style.cssText = `
              position: fixed; top: 20px; right: 20px; z-index: 10000000; 
              width: 320px; padding: 16px; border-radius: 10px; 
              background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.15); 
              font-family: 'Segoe UI', Tahoma, sans-serif; display: flex; 
              flex-direction: column; gap: 8px; border-left: 6px solid #2196F3; 
              box-sizing: border-box; transition: all 0.3s ease;
          `;
      widget.innerHTML = `
              <div style="font-weight: bold; color: #1a73e8; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                  🔄 <span>IUH Automation Agent</span>
              </div>
              <div id="iuh-sync-widget-body" style="font-size: 13px; color: #444; line-height: 1.4;"></div>
          `;
      document.body.appendChild(widget);
    }

    widget.style.borderLeftColor =
      status === "success"
        ? "#4CAF50"
        : status === "error"
          ? "#F44336"
          : "#2196F3";
    document.getElementById("iuh-sync-widget-body").innerText = message;
  }

  // =========================================================================
  // LOGIC CÀO DỮ LIỆU LỊCH HỌC
  // =========================================================================
  function waitForNextWeek(oldDate) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const newDate = document.getElementById("firstDateOffWeek")?.value;
        if (newDate && newDate !== oldDate) {
          clearInterval(check);
          setTimeout(resolve, 800);
        }
      }, 100);
    });
  }

  function scrapeCurrentWeek(customColorMap) {
    const table = document.querySelector("table.fl-table");
    if (!table) return [];
    const dateMap = {};
    table.querySelectorAll("thead th").forEach((th, idx) => {
      const m = th.innerText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) dateMap[idx] = `${m[3]}-${m[2]}-${m[1]}`;
    });

    const finalColors = customColorMap || GOOGLE_COLORS;
    const events = [];

    table.querySelectorAll("tbody tr td").forEach((cell) => {
      const date = dateMap[cell.cellIndex];
      if (!date) return;

      cell.querySelectorAll(".content").forEach((div) => {
        const text = div.innerText;
        const style = div.getAttribute("style") || "";
        const dataBg = div.getAttribute("data-bg");
        const subjectName =
          div.querySelector("a")?.innerText.trim() || "Môn học";
        const tietMatch = text.match(/Tiết:\s*(\d+)\s*-\s*(\d+)/);
        if (!tietMatch) return;

        const room = (
          text.match(/Phòng:\s*(.+?)(\n|$)/)?.[1] || "Không rõ"
        ).trim();
        const teacher = (
          text.match(/GV:\s*(.+?)(\n|$)/)?.[1] || "Chưa cập nhật"
        ).trim();
        let group =
          div
            .querySelector('span[lang="lichtheotuan-nhom"]')
            ?.parentElement?.innerText.replace("Nhóm:", "")
            .trim() || "";
        let note = (text.match(/Ghi chú:\s*([\s\S]*?)(\n\n|$)/)?.[1] || "")
          .replace(/\n/g, " ")
          .trim();

        const startTiet = parseInt(tietMatch[1]);
        const endTiet = parseInt(tietMatch[2]);
        const startTime = TIET_TIME[startTiet];
        const endTime = TIET_TIME[endTiet + 1];

        if (!startTime || !endTime) return;

        let type = "ly-thuyet";
        if (div.querySelector(".tamngung") || text.includes("Tạm ngưng"))
          type = "tam-ngung";
        else if (
          dataBg === "208412" ||
          group !== "" ||
          text.includes("Lịch thi")
        )
          type = "thi";
        else if (
          style.includes("#92d6ff") ||
          text.includes("Trực tuyến") ||
          room.toLowerCase().includes("zoom")
        )
          type = "truc-tuyen";
        else if (style.includes("#71cb35") || text.includes("Thực hành"))
          type = "thuc-hanh";

        events.push({
          subject: `[IUH] ${subjectName} ${type === "thi" ? "(THI)" : ""}`,
          start: `${date}T${startTime}:00+07:00`,
          end: `${date}T${endTime}:00+07:00`,
          room,
          teacher,
          type,
          note,
          group,
          calendarColorHex: finalColors[type],
        });
      });
    });
    return events;
  }

  // =========================================================================
  // TIẾN TRÌNH ĐỒNG BỘ HOÀN TOÀN TỰ ĐỘNG (SILENT SYNC)
  // =========================================================================
  async function startSilentSyncProcess() {
    const webAppUrl = document.documentElement.getAttribute(
      "data-iuh-webapp-url",
    );
    if (!webAppUrl) {
      updateSyncWidget(
        "❌ Thất bại: Thiếu link Google Apps Script trong cấu hình!",
        "error",
      );
      return;
    }

    // Lấy màu tùy chỉnh từ DOM
    let customColorMap = GOOGLE_COLORS;
    const domColors = document.documentElement.getAttribute(
      "data-iuh-custom-colors",
    );
    if (domColors) {
      try {
        customColorMap = JSON.parse(domColors);
      } catch (e) {}
    }

    // Lấy số tuần do người dùng nhập từ Dashboard (Mặc định 5 nếu lỗi)
    const domWeeks = document.documentElement.getAttribute(
      "data-iuh-sync-weeks-count",
    );
    const numWeeks = domWeeks ? parseInt(domWeeks, 10) : 5;

    let allEvents = [];

    try {
      for (let i = 0; i < numWeeks; i++) {
        const currentDate = document.getElementById("firstDateOffWeek")?.value;
        updateSyncWidget(
          `⏳ Đang cào dữ liệu lịch học: Tuần ${i + 1}/${numWeeks}...`,
        );

        const weekData = scrapeCurrentWeek(customColorMap);
        allEvents = allEvents.concat(weekData);

        if (i < numWeeks - 1) {
          const nextBtn = document.getElementById("btn_Tiep");
          if (!nextBtn) break;
          nextBtn.click();
          await waitForNextWeek(currentDate);
        }
      }

      if (allEvents.length === 0) {
        updateSyncWidget("⚠️ Không tìm thấy dữ liệu lịch học.", "error");
        setTimeout(
          () => document.dispatchEvent(new CustomEvent("IuhSyncComplete")),
          2000,
        );
        return;
      }

      allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

      const payload = {
        weekStart: allEvents[0].start.split("T")[0],
        weekEnd: allEvents[allEvents.length - 1].end.split("T")[0],
        events: allEvents,
      };

      updateSyncWidget("🚀 Đang đồng bộ dữ liệu sang Google Calendar...");

      const response = await fetch(webAppUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });

      const resultText = await response.text();
      if (resultText.includes("ERROR")) throw new Error(resultText);

      updateSyncWidget("🎉 Cập nhật lịch ngầm thành công!", "success");

      // Bắn sự kiện ra cho bridge.js bắt để gửi lệnh đóng tab
      setTimeout(() => {
        document.getElementById("iuh-sync-widget")?.remove();
        document.dispatchEvent(new CustomEvent("IuhSyncComplete"));
      }, 1500);
    } catch (err) {
      updateSyncWidget("❌ Lỗi tiến trình ngầm: " + err.message, "error");
      setTimeout(
        () => document.dispatchEvent(new CustomEvent("IuhSyncComplete")),
        3000,
      ); // Vẫn đóng tab nếu gặp lỗi
    }
  }

  // =========================================================================
  // AUTO CAPTCHA SOLVER (AI TENSORFLOW.JS)
  // =========================================================================
  async function loadAIModel() {
    try {
      const extBaseUrl =
        document.documentElement.getAttribute("data-iuh-ext-url");
      if (!extBaseUrl) return;
      iuhModel = await tf.loadLayersModel(extBaseUrl + "tfjs_model/model.json");
    } catch (error) {
      console.error("[IUH Sync] ❌ Lỗi nạp mô hình AI:", error);
    }
  }

  function preprocessCaptcha(imgElement) {
    const canvas = document.createElement("canvas");
    canvas.width = 150;
    canvas.height = 50;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgElement, 0, 0, 150, 50);
    return tf.tidy(() => {
      let tensor = tf.browser.fromPixels(ctx.getImageData(0, 0, 150, 50), 1);
      return tensor.toFloat().div(tf.scalar(255.0)).expandDims(0);
    });
  }

  async function solveIUHCaptcha() {
    await loadAIModel();
    if (!iuhModel) return;

    const imgElement = document.querySelector("#newcaptcha");
    const inputElement = document.querySelector("#Captcha");
    if (!imgElement || !inputElement) return;

    try {
      const tensor = preprocessCaptcha(imgElement);
      const prediction = iuhModel.predict(tensor);
      const data = prediction.dataSync();
      let result = "";

      for (let i = 0; i < 4; i++) {
        let maxVal = -1,
          maxIdx = -1;
        for (let j = 0; j < 36; j++) {
          if (data[i * 36 + j] > maxVal) {
            maxVal = data[i * 36 + j];
            maxIdx = j;
          }
        }
        result += CHARACTERS[maxIdx];
      }

      inputElement.value = result;
      inputElement.dispatchEvent(new Event("input", { bubbles: true }));
      inputElement.dispatchEvent(new Event("change", { bubbles: true }));

      document.dispatchEvent(new CustomEvent("IuhCaptchaSolved"));

      tf.dispose(tensor);
      tf.dispose(prediction);
    } catch (err) {
      console.error("[IUH Sync] ❌ Lỗi tiến trình giải mã AI:", err);
    }
  }

  let aiTriggered = false;
  const checkExist = setInterval(() => {
    if (
      document.documentElement.getAttribute("data-iuh-auto-captcha") === "false"
    ) {
      return clearInterval(checkExist);
    }
    if (
      document.querySelector("#newcaptcha") &&
      document.querySelector("#Captcha") &&
      !aiTriggered
    ) {
      aiTriggered = true;
      clearInterval(checkExist);
      setTimeout(solveIUHCaptcha, 500);
    }
  }, 500);

  // =========================================================================
  // ROUTING & BẮT ĐẦU LUỒNG CHẠY NGẦM
  // =========================================================================
  setTimeout(() => {
    const isAutoSync =
      document.documentElement.getAttribute("data-iuh-auto-sync-active") ===
      "true";

    // Vì hệ thống hiện tại đã 100% tự động, nếu cờ hiệu bật, ta sẽ chạy logic ngầm
    if (isAutoSync) {
      const currentUrl = window.location.href.toLowerCase();

      if (
        currentUrl.includes("lich-theo-tuan") ||
        currentUrl.includes("lichhoc")
      ) {
        updateSyncWidget("📅 Đã vào trang lịch học. Chuẩn bị cào dữ liệu...");
        setTimeout(startSilentSyncProcess, 1500);
      } else if (!currentUrl.includes("dang-nhap")) {
        updateSyncWidget("🔄 Đang tự động điều hướng đến Lịch Học...");
        setTimeout(
          () =>
            (window.location.href =
              "https://sv.iuh.edu.vn/lich-theo-tuan.html"),
          1000,
        );
      }
    }
  }, 500);
})();
