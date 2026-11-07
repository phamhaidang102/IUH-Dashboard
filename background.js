// background.js

const SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày
const GHOST_TAB_WATCHDOG_MS = 90 * 1000; // Thu hồi Ghost Tab lịch học nếu kẹt quá 90s
let isSyncTabSpawning = false; // Cờ khóa chống mở nhiều tab cùng lúc
let syncWatchdogTimer = null;

// ==============================================================================
// 0. THIẾT LẬP HEADER ORIGIN/REFERER CHO REQUEST TỪ EXTENSION & DỌN DẸP RÁC
// ==============================================================================
async function ensureDkhpHeaderRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
    return;
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9001, 9002],
      addRules: [
        {
          id: 9001,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: "https://dkhp.iuh.edu.vn" },
              { header: "Referer", operation: "set", value: "https://dkhp.iuh.edu.vn/DangKyHocPhan" },
            ],
          },
          condition: {
            urlFilter: "||dkhp.iuh.edu.vn/",
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest"],
          },
        },
        {
          id: 9002,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: "https://sv.iuh.edu.vn" },
              { header: "Referer", operation: "set", value: "https://sv.iuh.edu.vn/dashboard.html" },
            ],
          },
          condition: {
            urlFilter: "||sv.iuh.edu.vn/",
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
  } catch (err) {
    console.warn("[IUH Background] Không thể đăng ký DNR header rules:", err);
  }
}

ensureDkhpHeaderRules();

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
      // Dọn khóa Sniper & cờ tự động đăng ký tồn đọng khi khởi động lại trình duyệt
      "iuh_dkhp_sniper_lock",
      "iuh_dkhp_autostart_pending",
    ],
    () => {
      console.log(
        "[IUH Background] 🧹 Đã dọn dẹp các cờ hiệu chạy ngầm tồn đọng.",
      );
    },
  );
}

function armSyncTabWatchdog(tabId) {
  if (syncWatchdogTimer) clearTimeout(syncWatchdogTimer);
  syncWatchdogTimer = setTimeout(() => {
    syncWatchdogTimer = null;
    chrome.storage.local.remove(["iuh_auto_sync_active", "runningSyncTabId"]);
    if (tabId) {
      chrome.tabs.remove(tabId, () => {
        const err = chrome.runtime.lastError;
      });
    }
    console.warn("[IUH Background] ⏱️ Đã tự động thu hồi Ghost Tab đồng bộ lịch quá thời gian chờ.");
  }, GHOST_TAB_WATCHDOG_MS);
}

// Chạy khi Extension được cài mới hoặc cập nhật
chrome.runtime.onInstalled.addListener(() => {
  ensureDkhpHeaderRules();
  // Cứ mỗi 60 phút hệ thống sẽ thức dậy kiểm tra 1 lần xem đã quá 7 ngày chưa
  chrome.alarms.create("weeklyClientSyncCheck", { periodInMinutes: 60 });
  console.log(
    "[IUH Background] ⏱️ Đã khởi tạo bộ hẹn giờ tự động đồng bộ lịch.",
  );
  clearZombieStates();
});

// Chạy mỗi khi người dùng mở lại Google Chrome
chrome.runtime.onStartup.addListener(() => {
  ensureDkhpHeaderRules();
  chrome.alarms.get("weeklyClientSyncCheck", (existing) => {
    if (!existing) {
      chrome.alarms.create("weeklyClientSyncCheck", { periodInMinutes: 60 });
    }
  });
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
  chrome.storage.sync.get(["lastSyncTime", "autoSyncEnabled", "webAppUrl"], (data) => {
    // Nếu người dùng tắt tính năng đồng bộ tự động hoặc chưa cấu hình link GAS thì hủy bỏ
    if (data.autoSyncEnabled === false) return;
    if (!data.webAppUrl || !String(data.webAppUrl).trim()) return;

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
              if (tab && tab.id) {
                chrome.storage.local.set({ runningSyncTabId: tab.id });
                armSyncTabWatchdog(tab.id);
              }
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

    if (syncWatchdogTimer) {
      clearTimeout(syncWatchdogTimer);
      syncWatchdogTimer = null;
    }

    // Cập nhật lại mốc thời gian để 7 ngày sau Alarm mới kêu tiếp
    chrome.storage.sync.set({ lastSyncTime: Date.now() });
    chrome.storage.local.remove("iuh_auto_sync_active");

    chrome.storage.local.get(["runningSyncTabId"], (data) => {
      const tabId =
        data.runningSyncTabId || (sender.tab ? sender.tab.id : null);
      if (tabId) {
        chrome.tabs.update(tabId, { pinned: false }, () => {
          const ignoreErr = chrome.runtime.lastError;
          chrome.tabs.remove(tabId, () => {
            const ignoreRemoveErr = chrome.runtime.lastError;
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
            if (tab && tab.id) {
              chrome.storage.local.set({ runningSyncTabId: tab.id });
              armSyncTabWatchdog(tab.id);
            }
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
        if (!tab || !tab.id) {
          sendResponse({ success: false });
          return;
        }
        let settled = false;
        let timeoutId = null;

        const cleanupAll = () => {
          chrome.runtime.onMessage.removeListener(authMsgListener);
          chrome.tabs.onRemoved.removeListener(tabRemovedListener);
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        };

        const finishRenew = (ok, shouldCloseTab) => {
          if (settled) return;
          settled = true;
          cleanupAll();

          const finalize = () => {
            try {
              sendResponse({ success: ok });
            } catch (_) {}
            if (dashboardTabId) {
              chrome.tabs.update(dashboardTabId, { active: true }, () => {
                const err = chrome.runtime.lastError;
              });
            }
          };

          if (shouldCloseTab) {
            setTimeout(() => {
              chrome.tabs.update(tab.id, { pinned: false }, () => {
                const ignoreErr = chrome.runtime.lastError;
                chrome.tabs.remove(tab.id, () => {
                  const ignoreRemoveErr = chrome.runtime.lastError;
                  finalize();
                });
              });
            }, 1200);
          } else {
            finalize();
          }
        };

        // Xác nhận chắc chắn từ autologin.js rằng trang đã tải xong và KHÔNG còn form đăng nhập
        const authMsgListener = (msg, msgSender) => {
          if (
            msg &&
            msg.action === "iuhSessionVerifiedAuthenticated" &&
            msgSender.tab &&
            msgSender.tab.id === tab.id
          ) {
            console.log(
              "[IUH Background] ✅ Đã xác thực Session thực tế thành công. Đóng Ghost Tab...",
            );
            finishRenew(true, true);
          }
        };

        const tabRemovedListener = (removedTabId) => {
          if (removedTabId === tab.id) {
            finishRenew(false, false);
          }
        };

        chrome.runtime.onMessage.addListener(authMsgListener);
        chrome.tabs.onRemoved.addListener(tabRemovedListener);

        // Timeout an toàn 45 giây nếu sai mật khẩu hoặc captcha lỗi liên tục
        timeoutId = setTimeout(() => {
          console.warn("[IUH Background] ⏱️ Hết thời gian chờ khôi phục Session (45s).");
          finishRenew(false, true);
        }, 45000);
      },
    );

    return true; // 🚨 BẮT BUỘC có dòng này để giữ cổng giao tiếp mở chờ tiến trình bất đồng bộ phản hồi
  }
});

// ==============================================================================
// 3. BẮT SỰ KIỆN KHI CLICK VÀO ICON CỦA EXTENSION TRÊN THANH TOOLBAR
// ==============================================================================
chrome.action.onClicked.addListener((tab) => {
  // Mở trang SPA Dashboard mới thay vì trang options cũ và đặt mức zoom mặc định 75%
  chrome.tabs.create(
    { url: chrome.runtime.getURL("dashboard/portal.html") },
    (newTab) => {
      if (newTab && newTab.id) {
        chrome.tabs.setZoom(newTab.id, 0.75);
      }
    },
  );
});
