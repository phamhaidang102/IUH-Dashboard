// survey_agent.js
const surveySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async function handleAutoSurveyContext() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local)
    return;

  const state = await chrome.storage.local.get([
    "iuh_auto_survey_running",
    "iuh_survey_current_index",
    "iuh_survey_urls",
  ]);

  if (!state.iuh_auto_survey_running) return;

  const currentUrl = window.location.href;
  let urls = state.iuh_survey_urls || [];

  // --- KỊCH BẢN A: ĐANG TẠI MÀN HÌNH DANH SÁCH PHIẾU KHẢO SÁT ---
  if (currentUrl.includes("/sinh-vien/danh-sach-khao-sat.html")) {
    await surveySleep(500);

    // 1. Quét danh sách khảo sát
    if (urls.length === 0) {
      const pendingElements = document.querySelectorAll(
        "#tab_chuaks .item a.title",
      );
      urls = Array.from(pendingElements)
        .map((a) => {
          const href = (a.getAttribute("href") || "").trim();
          if (!href) return "";
          return href.startsWith("http")
            ? href
            : "https://sv.iuh.edu.vn" + (href.startsWith("/") ? "" : "/") + href;
        })
        .filter(Boolean);

      // Nếu không có môn nào -> Đóng tab, gửi trạng thái NO_SURVEYS về Dashboard
      if (urls.length === 0) {
        await chrome.storage.local.set({
          iuh_auto_survey_running: false,
          iuh_survey_current_index: 0,
          iuh_survey_urls: [],
          iuh_survey_status: "NO_SURVEYS",
        });
        chrome.runtime.sendMessage({ action: "closeSurveyTab" });
        return;
      }
      await chrome.storage.local.set({
        iuh_survey_urls: urls,
        iuh_survey_current_index: 0,
      });
    }

    const dispatchNextSurveyOrFinish = async () => {
      const latest = await chrome.storage.local.get([
        "iuh_auto_survey_running",
        "iuh_survey_current_index",
        "iuh_survey_urls",
      ]);
      if (!latest.iuh_auto_survey_running) return;
      const idx = latest.iuh_survey_current_index || 0;
      const list = latest.iuh_survey_urls || [];

      if (idx < list.length) {
        await chrome.storage.local.set({
          iuh_survey_current_index: idx + 1,
        });
        chrome.runtime.sendMessage({
          action: "openAndPinSurveyTab",
          url: list[idx],
        });
      } else {
        chrome.storage.onChanged.removeListener(onSurveyStepChange);
        await chrome.storage.local.set({
          iuh_auto_survey_running: false,
          iuh_survey_current_index: 0,
          iuh_survey_urls: [],
          iuh_survey_status: "DONE",
        });
        chrome.runtime.sendMessage({ action: "closeSurveyTab" });
      }
    };

    const onSurveyStepChange = (changes, area) => {
      if (area === "local" && changes.iuh_survey_step_done) {
        dispatchNextSurveyOrFinish();
      }
    };
    chrome.storage.onChanged.addListener(onSurveyStepChange);

    // 2. Mở tab khảo sát đầu tiên (hoặc kế tiếp)
    await dispatchNextSurveyOrFinish();
  }

  // --- KỊCH BẢN B: ĐANG TRONG TAB CHI TIẾT ĐIỀN KHẢO SÁT ---
  else if (currentUrl.includes("/sinh-vien/chi-tiet-phieu-khao-sat.html")) {
    await surveySleep(300);
    // Tự động chọn mức Bình thường
    const radioGroups = document.querySelectorAll("ul.group-cautraloi");
    radioGroups.forEach((ul) => {
      const labels = Array.from(ul.querySelectorAll("label"));
      const targetLabel = labels.find((l) =>
        l.textContent.includes("Bình thường"),
      );
      if (targetLabel) {
        const radioInput = targetLabel.querySelector('input[type="radio"]');
        if (radioInput) radioInput.click();
      }
    });

    // Điền tự luận "Không"
    const textareas = document.querySelectorAll("textarea.input-ykien");
    textareas.forEach((textarea) => {
      textarea.value = "Không";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Click gửi và chờ form submit hoàn tất trước khi đóng tab
    const btnGui = document.getElementById("btnGui");
    if (btnGui) btnGui.click();

    await surveySleep(1500);
    await chrome.storage.local.set({ iuh_survey_step_done: Date.now() });
    chrome.runtime.sendMessage({ action: "closeSurveyTab" });
  }
})();
