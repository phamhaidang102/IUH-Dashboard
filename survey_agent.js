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
  let currentIndex = state.iuh_survey_current_index || 0;
  let urls = state.iuh_survey_urls || [];

  // --- KỊCH BẢN A: ĐANG TẠI MÀN HÌNH DANH SÁCH PHIẾU KHẢO SÁT ---
  if (currentUrl.includes("/sinh-vien/danh-sach-khao-sat.html")) {
    await surveySleep(500);

    // 1. Quét danh sách khảo sát
    if (urls.length === 0) {
      const pendingElements = document.querySelectorAll(
        "#tab_chuaks .item a.title",
      );
      urls = Array.from(pendingElements).map(
        (a) => "https://sv.iuh.edu.vn" + a.getAttribute("href"),
      );

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
      currentIndex = 0;
    }

    // 2. Mở tab khảo sát từng môn
    if (currentIndex < urls.length) {
      await chrome.storage.local.set({
        iuh_survey_current_index: currentIndex + 1,
      });
      chrome.runtime.sendMessage({
        action: "openAndPinSurveyTab",
        url: urls[currentIndex],
      });
    }
    // 3. Hoàn thành tất cả -> Đóng tab, gửi trạng thái DONE
    else {
      await chrome.storage.local.set({
        iuh_auto_survey_running: false,
        iuh_survey_current_index: 0,
        iuh_survey_urls: [],
        iuh_survey_status: "DONE",
      });
      chrome.runtime.sendMessage({ action: "closeSurveyTab" });
    }
  }

  // --- KỊCH BẢN B: ĐANG TRONG TAB CHI TIẾT ĐIỀN KHẢO SÁT ---
  else if (currentUrl.includes("/sinh-vien/chi-tiet-phieu-khao-sat.html")) {
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
    textareas.forEach((textarea) => (textarea.value = "Không"));

    // Click gửi
    const btnGui = document.getElementById("btnGui");
    if (btnGui) btnGui.click();

    window.addEventListener("unload", () => {
      chrome.runtime.sendMessage({ action: "closeSurveyTab" });
    });

    await surveySleep(400);
    chrome.runtime.sendMessage({ action: "closeSurveyTab" });
  }
})();
