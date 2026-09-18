// background.js

const SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày
let isSyncTabSpawning = false; // Cờ khóa chống mở nhiều tab cùng lúc

// ==============================================================================
// 0. DỌN DẸP RÁC (ORPHANED STATES) KHI KHỞI ĐỘNG TRÌNH DUYỆT
// ==============================================================================

// Hàm dùng chung để dọn dẹp state tồn đọng từ phiên trước
function clearZombieStates() {
  chrome.storage.local.remove(
    [
      "iuh_auto_sync_active",
      "runningSyncTabId",
      // Dọn state khảo sát để tránh survey_agent.js chạy khi user vô tình vào trang
      "iuh_auto_survey_running",
      "iuh_survey_current_index",
      "iuh_survey_urls",
    ],
    () => {
      console.log(
        "[IUH Background] 🧹 Đã dọn dẹp các cờ hiệu chạy ngầm tồn đọng.",
      );
    },
  );
}

// Chạy khi Extension được cài mới hoặc cập nhật
chrome.runtime.onInstalled.addListener(() => {
  // Cứ mỗi 60 phút hệ thống sẽ thức dậy kiểm tra 1 lần xem đã quá 7 ngày chưa
  chrome.alarms.create("weeklyClientSyncCheck", { periodInMinutes: 60 });
  console.log(
    "[IUH Background] ⏱️ Đã khởi tạo bộ hẹn giờ tự động đồng bộ lịch.",
  );
  clearZombieStates();
});

// Chạy mỗi khi người dùng mở lại Google Chrome
chrome.runtime.onStartup.addListener(() => {
  clearZombieStates();
});

// ==============================================================================
// 1. HỆ THỐNG HẸN GIỜ (ALARM) TỰ ĐỘNG CHẠY NGẦM ĐỊNH KỲ (LỊCH HỌC)
// ==============================================================================
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "weeklyClientSyncCheck") {
    executePeriodicSync();
  }
});

function executePeriodicSync() {
  chrome.storage.sync.get(["lastSyncTime", "autoSyncEnabled"], (data) => {
    // Nếu người dùng tắt tính năng đồng bộ tự động trong cài đặt thì hủy bỏ
    if (data.autoSyncEnabled === false) return;

    const now = Date.now();
    const lastSync = data.lastSyncTime || 0;

    // Nếu đã trôi qua 7 ngày kể từ lần đồng bộ cuối cùng
    if (now - lastSync >= SYNC_INTERVAL_MS) {
      if (isSyncTabSpawning) return;
      isSyncTabSpawning = true;

      console.log(
        `[IUH Background] 🚀 Đã đến hạn 7 ngày. Khởi chạy Ghost Tab cào lịch tự động...`,
      );

      // Xóa tab kẹt nếu có
      chrome.storage.local.get(["runningSyncTabId"], (localData) => {
        if (localData.runningSyncTabId) {
          chrome.tabs.remove(localData.runningSyncTabId, () => {
            const err = chrome.runtime.lastError;
          });
        }

        // Mở Ghost Tab chạy ngầm để đồng bộ lịch
        chrome.storage.local.set({ iuh_auto_sync_active: true }, () => {
          chrome.tabs.create(
            {
              url: "https://sv.iuh.edu.vn/lich-theo-tuan.html",
              active: false, // CHẠY NGẦM: Không chiếm focus màn hình của user
              pinned: true, // CHẠY NGẦM: Ghim nhỏ lại ở góc
            },
            (tab) => {
              chrome.storage.local.set({ runningSyncTabId: tab.id });
              setTimeout(() => {
                isSyncTabSpawning = false;
              }, 2000);
            },
          );
        });
      });
    }
  });
}

// ==============================================================================
// 2. BỘ LẮNG NGHE TIN NHẮN TỪ DASHBOARD (ĐIỀU KHIỂN & AUTOMATION)
// ==============================================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ---------------------------------------------------------
  // [MODULE 1: LỊCH HỌC] ĐÓNG GHOST TAB (Tự động & Thủ công)
  // ---------------------------------------------------------
  if (
    request.action === "syncComplete" ||
    request.action === "manualSyncComplete"
  ) {
    console.log(
      `[IUH Background] Xử lý đóng Ghost Tab sau sự kiện: ${request.action}`,
    );

    // Cập nhật lại mốc thời gian để 7 ngày sau Alarm mới kêu tiếp
    chrome.storage.sync.set({ lastSyncTime: Date.now() });
    chrome.storage.local.remove("iuh_auto_sync_active");

    chrome.storage.local.get(["runningSyncTabId"], (data) => {
      const tabId =
        data.runningSyncTabId || (sender.tab ? sender.tab.id : null);
      if (tabId) {
        chrome.tabs.update(tabId, { pinned: false }, () => {
          chrome.tabs.remove(tabId, () => {
            chrome.storage.local.remove("runningSyncTabId");
            console.log(
              "[IUH Background] ✅ Đã dọn dẹp Ghost Tab đồng bộ lịch thành công.",
            );
          });
        });
      }
    });
  }

  // ---------------------------------------------------------
  // [MODULE 1: LỊCH HỌC] KÍCH HOẠT CÀO LỊCH HỌC TỪ DASHBOARD
  // ---------------------------------------------------------
  if (request.action === "triggerManualScheduleSync") {
    if (isSyncTabSpawning) return;
    isSyncTabSpawning = true;
    console.log(
      "[IUH Background] 📅 Kích hoạt Ghost Tab đồng bộ lịch từ Dashboard.",
    );

    chrome.storage.local.get(["runningSyncTabId"], (data) => {
      if (data.runningSyncTabId) {
        chrome.tabs.remove(data.runningSyncTabId, () => {
          const err = chrome.runtime.lastError;
        });
      }

      chrome.storage.local.set({ iuh_auto_sync_active: true }, () => {
        chrome.tabs.create(
          {
            url: "https://sv.iuh.edu.vn/lich-theo-tuan.html",
            active: false,
            pinned: true,
          },
          (tab) => {
            chrome.storage.local.set({ runningSyncTabId: tab.id });
            setTimeout(() => {
              isSyncTabSpawning = false;
            }, 2000);
          },
        );
      });
    });
  }

  // ---------------------------------------------------------
  // [MODULE 2: KHẢO SÁT TỰ ĐỘNG] CÁC LỆNH ĐIỀU PHỐI KHẢO SÁT
  // ---------------------------------------------------------
  if (request.action === "triggerAutoSurvey") {
    console.log("[IUH Background] 📝 Kích hoạt luồng khảo sát tự động.");
    // BUG FIX: Phải set flag TRƯỚC khi mở tab. Nếu không, survey_agent.js sẽ
    // luôn return early tại dòng `if (!state.iuh_auto_survey_running) return`.
    chrome.storage.local.set(
      {
        iuh_auto_survey_running: true,
        iuh_survey_current_index: 0,
        iuh_survey_urls: [],
      },
      () => {
        chrome.tabs.create({
          url: "https://sv.iuh.edu.vn/sinh-vien/danh-sach-khao-sat.html",
          active: false,
          pinned: true,
        });
      },
    );
  }

  if (request.action === "openAndPinSurveyTab") {
    chrome.tabs.create(
      { url: request.url, pinned: true, active: true },
      (tab) => {
        sendResponse({ success: true, tabId: tab.id });
      },
    );
    return true; // Giữ cổng kết nối mở cho sendResponse bất đồng bộ
  }

  if (request.action === "closeSurveyTab") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId) {
      chrome.tabs.update(tabId, { pinned: false }, () => {
        chrome.tabs.remove(tabId);
      });
    }
  }

  // ---------------------------------------------------------
  // [MODULE 3: SESSION RENEW] GHOST TAB TỰ ĐĂNG NHẬP NGẦM
  // ---------------------------------------------------------
  if (request.action === "renewSessionViaGhostTab") {
    console.log(
      "[IUH Background] 🔑 Kích hoạt Ghost Tab khôi phục Session đăng nhập.",
    );

    // Lưu lại ID của tab Dashboard ra lệnh để lát nữa tự động quay về (Focus)
    const dashboardTabId = sender.tab ? sender.tab.id : null;

    chrome.tabs.create(
      {
        url: "https://sv.iuh.edu.vn/ket-qua-hoc-tap.html?auto_sync_mode=1",
        active: true, // 🚨 CHỐT HẠ: Bắt buộc mở nổi tab lên để CPU không bị bóp hiệu năng giải AI Captcha
        pinned: true,
      },
      (tab) => {
        const cookieCheckListener = (tabId, changeInfo, updatedTab) => {
          if (tabId !== tab.id) return;

          // Lấy URL thực tế an toàn thông qua Chrome Tabs API
          chrome.tabs.get(tabId, (currentTab) => {
            if (chrome.runtime.lastError || !currentTab || !currentTab.url)
              return;

            const currentUrl = currentTab.url.toLowerCase();

            // Danh sách các từ khóa nhận dạng trang đăng nhập
            const isLoginRoute =
              currentUrl.includes("dang-nhap") ||
              currentUrl.includes("login") ||
              currentUrl.includes("auth");

            // 🔥 Nếu đã vượt qua trang đăng nhập và tiến vào domain trường thành công
            if (currentUrl.includes("sv.iuh.edu.vn") && !isLoginRoute) {
              console.log(
                `[IUH Background] ✅ Đăng nhập thành công tại: ${currentUrl}. Tiến hành xóa Ghost Tab...`,
              );

              // 1. Gỡ listener ngay lập tức tránh trùng lặp
              chrome.tabs.onUpdated.removeListener(cookieCheckListener);

              // 2. Chờ 1.5 giây để ghi Cookie ổn định
              setTimeout(() => {
                // 3. Đóng Ghost Tab dọn RAM
                chrome.tabs.update(tabId, { pinned: false }, () => {
                  chrome.tabs.remove(tabId, () => {
                    // 4. Phản hồi trực tiếp về Portal.js để kích hoạt cào điểm
                    sendResponse({ success: true });

                    // 5. Tự động focus quay lại màn hình Dashboard của sinh viên
                    if (dashboardTabId) {
                      chrome.tabs.update(
                        dashboardTabId,
                        { active: true },
                        () => {
                          const err = chrome.runtime.lastError;
                        },
                      );
                    }
                  });
                });
              }, 1500);
            }
          });
        };
        chrome.tabs.onUpdated.addListener(cookieCheckListener);
      },
    );

    return true; // 🚨 BẮT BUỘC có dòng này để giữ cổng giao tiếp mở chờ tiến trình bất đồng bộ phản hồi
  }
});

// ==============================================================================
// 3. BẮT SỰ KIỆN KHI CLICK VÀO ICON CỦA EXTENSION TRÊN THANH TOOLBAR
// ==============================================================================
chrome.action.onClicked.addListener((tab) => {
  // Mở trang SPA Dashboard mới thay vì trang options cũ
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/portal.html") });
});
