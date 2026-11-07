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

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const userField = document.querySelector("#UserName");
    const passField = document.querySelector("#Password");
    const loginForm = document.getElementById("frmLogin") || document.getElementById("form-login");
    const currentPath = window.location.pathname.toLowerCase();
    const isLoginPage =
      Boolean(userField && passField) ||
      Boolean(loginForm) ||
      currentPath.includes("dang-nhap") ||
      currentPath.includes("login");

    // Nếu KHÔNG phải trang đăng nhập -> Đã đăng nhập thành công!
    // Reset bộ đếm retry và báo cho background.js biết nếu đang khôi phục Session
    if (!isLoginPage) {
      sessionStorage.removeItem("iuh_login_retry_count");
      if (isGhostTab) {
        sessionStorage.removeItem("iuh_auto_sync_active");
      }
      try {
        chrome.runtime.sendMessage({ action: "iuhSessionVerifiedAuthenticated" }, () => {
          const ignoreErr = chrome.runtime.lastError;
        });
      } catch (_) {}
      return;
    }

    // =========================================================================
    // 🛡️ TÍNH NĂNG: LÀM MỚI TRANG NẾU LỖI ĐĂNG NHẬP (MAX 5 LẦN CHỈ TRÊN TRANG LOGIN)
    // =========================================================================
    let retryCount = parseInt(
      sessionStorage.getItem("iuh_login_retry_count") || "0",
      10,
    );

    if (retryCount >= 5) {
      console.warn(
        "[IUH Sync] 🔄 Đã vượt quá 5 lần thử đăng nhập. Đang tiến hành dừng vòng lặp...",
      );

      // Reset bộ đếm VÀ XÓA LUÔN CỜ AUTO SYNC TRONG SESSION ĐỂ CẮT VÒNG LẶP
      sessionStorage.removeItem("iuh_login_retry_count");
      sessionStorage.removeItem("iuh_auto_sync_active");
      return;
    }

    sessionStorage.setItem(
      "iuh_login_retry_count",
      (retryCount + 1).toString(),
    );
    // =========================================================================

    const loginBtn = document.querySelector(
      '.authfy-panel.active #form-login input[type="submit"], #form-login input[type="submit"], #frmLogin input[type="submit"], #frmLogin button[type="submit"]',
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
