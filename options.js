// options.js — Hex Color Picker System
// Migrated from ID-based (11 colors) to free hex color system

document.addEventListener("DOMContentLoaded", () => {
  // =========================================================================
  // GOOGLE CALENDAR PRESET COLORS (14 main colors shown in UI)
  // =========================================================================
  const GC_PRESETS = [
    { hex: "#d50000", name: "Tomato" },
    { hex: "#e67c73", name: "Flamingo" },
    { hex: "#f4511e", name: "Tangerine" },
    { hex: "#ef6c00", name: "Pumpkin" },
    { hex: "#f6bf26", name: "Banana" },
    { hex: "#e4c441", name: "Citron" },
    { hex: "#33b679", name: "Sage" },
    { hex: "#0b8043", name: "Basil" },
    { hex: "#7cb342", name: "Avocado" },
    { hex: "#33b679", name: "Eucalyptus" },
    { hex: "#039be5", name: "Peacock" },
    { hex: "#3f51b5", name: "Blueberry" },
    { hex: "#7986cb", name: "Lavender" },
    { hex: "#8e24aa", name: "Grape" },
    { hex: "#616161", name: "Graphite" },
    { hex: "#795548", name: "Cocoa" },
    { hex: "#a79b8e", name: "Birch" },
    { hex: "#ad1457", name: "Beetroot" },
    { hex: "#f48fb1", name: "Cherry Blossom" },
    { hex: "#9c27b0", name: "Wisteria" },
    { hex: "#00acc1", name: "Cobalt" },
    { hex: "#558b2f", name: "Pistachio" },
    { hex: "#f57f17", name: "Mango" },
  ];

  const DEFAULT_COLORS = {
    "ly-thuyet": "#616161",
    "thuc-hanh": "#33b679",
    "truc-tuyen": "#039be5",
    thi: "#f6bf26",
    "tam-ngung": "#d50000",
  };

  const COLOR_KEYS = [
    "ly-thuyet",
    "thuc-hanh",
    "truc-tuyen",
    "thi",
    "tam-ngung",
  ];

  // =========================================================================
  // HSV <-> HEX UTILITIES
  // =========================================================================
  function hsvToHex(h, s, v) {
    const f = (n, k = (n + h / 60) % 6) =>
      v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    const r = Math.round(f(5) * 255);
    const g = Math.round(f(3) * 255);
    const b = Math.round(f(1) * 255);
    return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  function hexToHsv(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
  }

  function isValidHex(hex) {
    return /^#[0-9a-fA-F]{6}$/.test(hex);
  }

  // =========================================================================
  // COLOR PICKER STATE
  // =========================================================================
  let activeKey = null;
  let pickerHue = 0,
    pickerS = 1,
    pickerV = 1;
  let isDraggingSV = false,
    isDraggingHue = false;
  let hsvVisible = false;

  const panel = document.getElementById("color-picker-panel");
  const presetContainer = document.getElementById("preset-colors");
  const hexInput = document.getElementById("hex-input");
  const hexPreview = document.getElementById("hex-preview-box");
  const svCanvas = document.getElementById("sv-canvas");
  const hueCanvas = document.getElementById("hue-canvas");
  const svThumb = document.getElementById("sv-thumb");
  const hueThumb = document.getElementById("hue-thumb");
  const hsvArea = document.getElementById("hsv-area");
  const toggleHsvBtn = document.getElementById("toggle-hsv-btn");

  // ---- Build preset dots ----
  GC_PRESETS.forEach((p) => {
    const dot = document.createElement("div");
    dot.className = "preset-dot";
    dot.style.background = p.hex;
    dot.title = p.name;
    dot.dataset.hex = p.hex;
    dot.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      applyColor(p.hex);
    });
    presetContainer.appendChild(dot);
  });

  // ---- Draw HSV canvas helpers ----
  function drawSVCanvas() {
    const ctx = svCanvas.getContext("2d");
    const W = svCanvas.width,
      H = svCanvas.height;
    const base = `hsl(${pickerHue}, 100%, 50%)`;
    const gradH = ctx.createLinearGradient(0, 0, W, 0);
    gradH.addColorStop(0, "white");
    gradH.addColorStop(1, base);
    ctx.fillStyle = gradH;
    ctx.fillRect(0, 0, W, H);
    const gradV = ctx.createLinearGradient(0, 0, 0, H);
    gradV.addColorStop(0, "rgba(0,0,0,0)");
    gradV.addColorStop(1, "black");
    ctx.fillStyle = gradV;
    ctx.fillRect(0, 0, W, H);
  }

  function drawHueCanvas() {
    const ctx = hueCanvas.getContext("2d");
    const W = hueCanvas.width,
      H = hueCanvas.height;
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= 360; i += 30)
      grad.addColorStop(i / 360, `hsl(${i},100%,50%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  function updateSVThumb() {
    const W = svCanvas.offsetWidth || svCanvas.width;
    const H = svCanvas.offsetHeight || svCanvas.height;
    const x = pickerS * W;
    const y = (1 - pickerV) * H;
    svThumb.style.left = x + "px";
    svThumb.style.top = y + "px";
    svThumb.style.background = hsvToHex(pickerHue, pickerS, pickerV);
  }

  function updateHueThumb() {
    const W = hueCanvas.offsetWidth || hueCanvas.width;
    hueThumb.style.left = (pickerHue / 360) * W + "px";
    hueThumb.style.background = `hsl(${pickerHue},100%,50%)`;
  }

  function syncFromHSV() {
    const hex = hsvToHex(pickerHue, pickerS, pickerV);
    hexInput.value = hex;
    hexPreview.style.background = hex;
    updateSVThumb();
    updateHueThumb();
    updatePresetSelection(hex);
  }

  function applyColor(hex) {
    if (!isValidHex(hex)) return;
    const hsv = hexToHsv(hex);
    pickerHue = hsv.h;
    pickerS = hsv.s;
    pickerV = hsv.v;
    hexInput.value = hex;
    hexPreview.style.background = hex;
    updatePresetSelection(hex);
    if (hsvVisible) {
      drawSVCanvas();
      updateSVThumb();
      updateHueThumb();
    }
    // Commit to hidden input + swatch
    if (activeKey) commitColor(activeKey, hex);
  }

  function updatePresetSelection(hex) {
    document.querySelectorAll(".preset-dot").forEach((dot) => {
      dot.classList.toggle(
        "selected",
        dot.dataset.hex.toLowerCase() === hex.toLowerCase(),
      );
    });
  }

  function commitColor(key, hex) {
    const hidden = document.getElementById("color-" + key);
    const swatch = document.getElementById("swatch-" + key);
    const display = document.getElementById("hexdisplay-" + key);
    if (hidden) hidden.value = hex;
    if (swatch) swatch.style.background = hex;
    if (display) display.textContent = hex;
  }

  // ---- Open/close panel ----
  function openPanel(key, trigger) {
    activeKey = key;
    const rect = trigger.getBoundingClientRect();
    const panelW = 280;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + panelW > window.innerWidth)
      left = window.innerWidth - panelW - 8;
    if (top + 420 > window.innerHeight) top = rect.top - 420 - 6;
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.classList.add("visible");

    const currentHex =
      document.getElementById("color-" + key)?.value || DEFAULT_COLORS[key];
    const hsv = hexToHsv(currentHex);
    pickerHue = hsv.h;
    pickerS = hsv.s;
    pickerV = hsv.v;
    hexInput.value = currentHex;
    hexPreview.style.background = currentHex;
    updatePresetSelection(currentHex);

    if (hsvVisible) {
      drawSVCanvas();
      drawHueCanvas();
      updateSVThumb();
      updateHueThumb();
    }
  }

  function closePanel() {
    panel.classList.remove("visible");
    activeKey = null;
  }

  // ---- Toggle HSV area ----
  toggleHsvBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hsvVisible = !hsvVisible;
    hsvArea.style.display = hsvVisible ? "block" : "none";
    toggleHsvBtn.textContent = hsvVisible
      ? "\u25b2 \u1ea8n b\u1ea3ng m\u00e0u tu\u1ef3 ch\u1ec9nh"
      : "\u25bc M\u1edf b\u1ea3ng m\u00e0u tu\u1ef3 ch\u1ec9nh";
    if (hsvVisible) {
      drawSVCanvas();
      drawHueCanvas();
      updateSVThumb();
      updateHueThumb();
    }
  });

  // ---- Hex input ----
  hexInput.addEventListener("input", () => {
    const raw = hexInput.value.trim();
    const hex = raw.startsWith("#") ? raw : "#" + raw;
    if (isValidHex(hex)) applyColor(hex);
    else {
      hexPreview.style.background = "#eee";
    }
  });
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") closePanel();
  });

  // ---- SV Canvas drag ----
  svCanvas.addEventListener("mousedown", (e) => {
    isDraggingSV = true;
    handleSVDrag(e);
  });
  document.addEventListener("mousemove", (e) => {
    if (isDraggingSV) handleSVDrag(e);
    if (isDraggingHue) handleHueDrag(e);
  });
  document.addEventListener("mouseup", () => {
    isDraggingSV = false;
    isDraggingHue = false;
  });

  function handleSVDrag(e) {
    const rect = svCanvas.getBoundingClientRect();
    pickerS = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    pickerV = Math.max(
      0,
      Math.min(1, 1 - (e.clientY - rect.top) / rect.height),
    );
    syncFromHSV();
    if (activeKey)
      commitColor(activeKey, hsvToHex(pickerHue, pickerS, pickerV));
  }

  hueCanvas.addEventListener("mousedown", (e) => {
    isDraggingHue = true;
    handleHueDrag(e);
  });
  function handleHueDrag(e) {
    const rect = hueCanvas.getBoundingClientRect();
    pickerHue = Math.max(
      0,
      Math.min(360, ((e.clientX - rect.left) / rect.width) * 360),
    );
    drawSVCanvas();
    syncFromHSV();
    if (activeKey)
      commitColor(activeKey, hsvToHex(pickerHue, pickerS, pickerV));
  }

  // ---- Click outside to cancel ----
  document.addEventListener("mousedown", (e) => {
    if (
      !panel.contains(e.target) &&
      !e.target.closest(".color-picker-trigger")
    ) {
      if (panel.classList.contains("visible")) closePanel();
    }
  });

  // ---- Attach triggers ----
  COLOR_KEYS.forEach((key) => {
    const trigger = document.getElementById("trigger-" + key);
    if (trigger) {
      trigger.addEventListener("click", () => openPanel(key, trigger));
    }
  });

  // =========================================================================
  // LOAD / SAVE SETTINGS
  // =========================================================================
  const scriptUrlInput = document.getElementById("scriptUrl");
  const userInp = document.getElementById("username");
  const passInp = document.getElementById("password");
  const autoSyncToggle = document.getElementById("autoSyncEnabled");
  const autoFillToggle = document.getElementById("autoFillInfo");
  const autoCaptchaToggle = document.getElementById("autoCaptcha");
  const autoClickToggle = document.getElementById("autoClickLogin");
  const saveBtn = document.getElementById("saveBtn");
  const status = document.getElementById("status");

  chrome.storage.sync.get(
    [
      "webAppUrl",
      "iuhUser",
      "iuhPass",
      "autoSyncEnabled",
      "autoFillInfo",
      "autoCaptcha",
      "autoClickLogin",
      "customColors",
    ],
    (data) => {
      if (data.webAppUrl) scriptUrlInput.value = data.webAppUrl;
      if (data.iuhUser) userInp.value = data.iuhUser;
      if (data.iuhPass) passInp.value = data.iuhPass;

      autoSyncToggle.checked = data.autoSyncEnabled !== false;
      autoFillToggle.checked = data.autoFillInfo !== false;
      autoCaptchaToggle.checked = data.autoCaptcha !== false;
      autoClickToggle.checked = data.autoClickLogin !== false;

      // Load saved hex colors (or use defaults)
      const saved = data.customColors || {};
      COLOR_KEYS.forEach((key) => {
        const hex =
          saved[key] && isValidHex(saved[key])
            ? saved[key]
            : DEFAULT_COLORS[key];
        commitColor(key, hex);
      });
    },
  );

  saveBtn.addEventListener("click", () => {
    const url = scriptUrlInput.value.trim();
    const user = userInp.value.trim();
    const pass = passInp.value.trim();

    if (!url || !user || !pass) {
      status.style.color = "red";
      status.innerText =
        "\u274c Th\u1ea5t b\u1ea1i: Vui l\u00f2ng \u0111i\u1ec1n \u0111\u1ea7y \u0111\u1ee7 th\u00f4ng tin t\u00e0i kho\u1ea3n v\u00e0 API tr\u01b0\u1edbc khi l\u01b0u!";
      return;
    }

    const customColorsObj = {};
    COLOR_KEYS.forEach((key) => {
      const hidden = document.getElementById("color-" + key);
      customColorsObj[key] =
        hidden && isValidHex(hidden.value) ? hidden.value : DEFAULT_COLORS[key];
    });

    chrome.storage.sync.set(
      {
        webAppUrl: url,
        iuhUser: user,
        iuhPass: pass,
        autoSyncEnabled: autoSyncToggle.checked,
        autoFillInfo: autoFillToggle.checked,
        autoCaptcha: autoCaptchaToggle.checked,
        autoClickLogin: autoClickToggle.checked,
        customColors: customColorsObj,
      },
      () => {
        status.style.color = "#0f9d58";
        status.innerText =
          "\ud83d\ude80 H\u1ec7 th\u1ed1ng ghi nh\u1eadn: \u0110\u00e3 c\u1eadp nh\u1eadt v\u00e0 l\u01b0u c\u1ea5u h\u00ecnh th\u00e0nh c\u00f4ng!";
        setTimeout(() => {
          status.innerText = "";
        }, 3000);
      },
    );
  });

  // ---- Show/hide password ----
  const togglePassword = document.getElementById("togglePassword");
  const eyeIcon = document.getElementById("eyeIcon");
  const passInput = document.getElementById("password");

  if (togglePassword && passInput && eyeIcon) {
    togglePassword.addEventListener("click", function () {
      const isPassword = passInput.getAttribute("type") === "password";
      passInput.setAttribute("type", isPassword ? "text" : "password");
      if (isPassword) {
        eyeIcon.innerHTML =
          '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
        eyeIcon.setAttribute("stroke", "#0056b3");
        togglePassword.setAttribute("title", "\u1ea8n m\u1eadt kh\u1ea9u");
      } else {
        eyeIcon.innerHTML =
          '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
        eyeIcon.setAttribute("stroke", "#666");
        togglePassword.setAttribute("title", "Hi\u1ec7n m\u1eadt kh\u1ea9u");
      }
    });
  }

  // ---- Survey button ----
  const btnStartSurvey = document.getElementById("btnStartSurvey");
  const surveyStatus = document.getElementById("survey-status");

  if (btnStartSurvey) {
    btnStartSurvey.addEventListener("click", async () => {
      surveyStatus.style.display = "block";
      surveyStatus.textContent =
        "\u0110ang ghi nh\u1eadn c\u1edd hi\u1ec7u ho\u1ea1t \u0111\u1ed9ng...";

      await chrome.storage.local.set({
        iuh_auto_survey_running: true,
        iuh_survey_current_index: 0,
        iuh_survey_urls: [],
      });

      surveyStatus.textContent =
        "\u0110ang ki\u1ec3m tra v\u00e0 \u0111i\u1ec1u h\u01b0\u1edbng \u0111\u1ebfn trang kh\u1ea3o s\u00e1t...";

      chrome.tabs.query({ url: "*://sv.iuh.edu.vn/*" }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, {
            url: "https://sv.iuh.edu.vn/sinh-vien/danh-sach-khao-sat.html",
            active: true,
          });
        } else {
          chrome.tabs.create({
            url: "https://sv.iuh.edu.vn/sinh-vien/danh-sach-khao-sat.html",
          });
        }
      });
    });
  }
});
