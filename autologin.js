chrome.storage.sync.get(
  ["iuhUser", "iuhPass", "autoFillInfo", "autoClickLogin"],
  async (result) => {
    const isAutoFill = result.autoFillInfo !== false;
    const isAutoLogin = result.autoClickLogin !== false;

    // Phân tích tham số để biết có đang chạy đồng bộ ngầm không
    const urlParams = new URLSearchParams(window.location.search);
    const isGhostTab =
      urlParams.get("auto_sync_mode") === "1" ||
      sessionStorage.getItem("iuh_auto_sync_active") === "true";
    if (urlParams.get("auto_sync_mode") === "1") {
      sessionStorage.setItem("iuh_auto_sync_active", "true");
    }

    // =========================================================================
    // 🛡️ TÍNH NĂNG: LÀM MỚI TRANG NẾU LỖI ĐĂNG NHẬP (MAX 5 LẦN)
    // =========================================================================
    let retryCount = parseInt(
      sessionStorage.getItem("iuh_login_retry_count") || "0",
      10,
    );

    if (retryCount >= 5) {
      console.warn(
        "[IUH Sync] 🔄 Đã vượt quá 5 lần thử đăng nhập. Đang tiến hành Refresh...",
      );

      // Reset bộ đếm VÀ XÓA LUÔN CỜ AUTO SYNC TRONG SESSION ĐỂ CẮT VÒNG LẶP
      sessionStorage.removeItem("iuh_login_retry_count");
      sessionStorage.removeItem("iuh_auto_sync_active");

      setTimeout(() => {
        // Thay vì reload giữ params cũ, ta đẩy thẳng về trang chủ để cắt đứt URL Params (?auto_sync_mode=1)
        window.location.href = window.location.pathname;
      }, 1000);

      return;
    }

    // Xóa dòng gán trùng lặp (duplicate) trong code cũ của bạn
    sessionStorage.setItem(
      "iuh_login_retry_count",
      (retryCount + 1).toString(),
    );
    // =========================================================================

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const userField = document.querySelector("#UserName");
    const passField = document.querySelector("#Password");
    const loginBtn = document.querySelector(
      '.authfy-panel.active #form-login input[type="submit"]',
    );

    let hasFilledSuccessfully = false;

    // 1. Tự động điền dữ liệu
    if (isAutoFill && result.iuhUser && result.iuhPass) {
      if (userField && passField) {
        userField.value = result.iuhUser;
        passField.value = result.iuhPass;

        userField.dispatchEvent(new Event("input", { bubbles: true }));
        passField.dispatchEvent(new Event("input", { bubbles: true }));
        userField.dispatchEvent(new Event("change", { bubbles: true }));
        passField.dispatchEvent(new Event("change", { bubbles: true }));

        console.log(
          `[IUH Sync] 👤 Đã tự động điền MSSV & Mật khẩu (Lần thử: ${retryCount + 1}/5).`,
        );
        hasFilledSuccessfully = true;
      } else {
        console.log(
          "[IUH Sync] ❌ Không tìm thấy ô nhập liệu, có thể giao diện đã thay đổi.",
        );
      }
    } else {
      hasFilledSuccessfully = true;
    }

    // 2. Chờ AI giải mã xong thì Click đăng nhập
    document.addEventListener("IuhCaptchaSolved", async () => {
      if (!isAutoLogin) return;

      let waitTimer = 0;
      while (!hasFilledSuccessfully && waitTimer < 3000) {
        await sleep(100);
        waitTimer += 100;
      }

      if (loginBtn) {
        console.log("[IUH Sync] 🚀 Đợi 1.5 giây mô phỏng người thật...");
        await sleep(1500);
        loginBtn.click();
      }
    });
  },
);
