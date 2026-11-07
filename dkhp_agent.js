// dkhp_agent.js
// Content Script hỗ trợ Tự động Đăng ký Học phần trực tiếp trên cổng https://dkhp.iuh.edu.vn/*
// Lưu ý bảo mật: Tuyệt đối KHÔNG chèn bất kỳ thẻ nào vào <head> và không dùng tên thẻ cấm của _cpc().

(function () {
  "use strict";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function removeVietnameseTones(str) {
    if (!str) return "";
    return String(str)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase();
  }

  // State của Agent trên trang DKHP
  let _agentPlannedByDot = {};
  let _agentSelectedDot = "64";
  let _agentHinhThuc = "1";
  let _agentAutoPickOpenClass = true;
  let _agentIsRunning = false;
  let _agentSniperIntervalId = null;
  let _agentSniperIntervalSec = 10;
  let _agentStatusByCourseKey = {}; // { [key]: { state: 'idle'|'running'|'ok'|'wait'|'err', msg: string } }
  let _agentMinimized = false;
  let _agentSniperToggling = false;
  const _agentInstanceId = "agent_" + Math.random().toString(36).substring(2, 9);

  // ---- Bảo vệ phiên: hàng đợi request, đếm lỗi liên tiếp, khóa sniper dùng chung ----
  const AGENT_MIN_GAP_MS = 300;
  const AGENT_SNIPER_MIN_SEC = 10;
  const AGENT_MAX_FAIL_STREAK = 3;
  const AGENT_SNIPER_LOCK_KEY = "iuh_dkhp_sniper_lock";
  const AGENT_SNIPER_OWNER = "agent";
  let _agentQueueTail = Promise.resolve();
  let _agentLastRequestAt = 0;
  let _agentFailStreak = 0;
  let _agentBlocked = false;

  function agentEnqueue(task) {
    const run = async () => {
      const wait = _agentLastRequestAt + AGENT_MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        _agentLastRequestAt = Date.now();
      }
    };
    const p = _agentQueueTail.then(run, run);
    _agentQueueTail = p.catch(() => {});
    return p;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const text = await res.text();
      return { res, text };
    } finally {
      clearTimeout(timer);
    }
  }

  function agentShouldAbortSniper() {
    return _agentBlocked || _agentFailStreak >= AGENT_MAX_FAIL_STREAK;
  }

  async function acquireAgentSniperLock(intervalSec) {
    const staleMs = Math.max(intervalSec * 3, 30) * 1000;
    const cur = (await chrome.storage.local.get(AGENT_SNIPER_LOCK_KEY))[AGENT_SNIPER_LOCK_KEY];
    if (cur && cur.owner !== AGENT_SNIPER_OWNER && Date.now() - cur.ts < staleMs) return false;
    await chrome.storage.local.set({
      [AGENT_SNIPER_LOCK_KEY]: { owner: AGENT_SNIPER_OWNER, instanceId: _agentInstanceId, ts: Date.now() },
    });
    return true;
  }

  function heartbeatAgentSniperLock() {
    chrome.storage.local.set({
      [AGENT_SNIPER_LOCK_KEY]: { owner: AGENT_SNIPER_OWNER, instanceId: _agentInstanceId, ts: Date.now() },
    });
  }

  function releaseAgentSniperLock() {
    chrome.storage.local.get(AGENT_SNIPER_LOCK_KEY, (r) => {
      const cur = r[AGENT_SNIPER_LOCK_KEY];
      if (cur?.owner === AGENT_SNIPER_OWNER && (!cur.instanceId || cur.instanceId === _agentInstanceId)) {
        chrome.storage.local.remove(AGENT_SNIPER_LOCK_KEY);
      }
    });
  }

  window.addEventListener("pagehide", () => releaseAgentSniperLock());
  window.addEventListener("beforeunload", () => releaseAgentSniperLock());

  /**
   * Phân loại phản hồi đăng ký từ DKHP cho Agent
   */
  function classifyDkhpRegResponse(regRes, targetMaLHP) {
    if (!regRes) {
      return {
        ok: false,
        retryable: true,
        state: "err",
        isGateWait: false,
        isConflict: false,
        isCoReq: false,
        msg: "Không nhận được phản hồi từ DKHP (Kiểm tra kết nối/đăng nhập)",
      };
    }
    if (regRes && typeof regRes === "object" && regRes.check === true) {
      return {
        ok: true,
        retryable: false,
        state: "ok",
        isGateWait: false,
        isConflict: false,
        isCoReq: false,
        msg: `Đăng ký thành công [${targetMaLHP}]`,
      };
    }
    const rawMsg = String(
      (regRes && (regRes.message || regRes.Message)) || (typeof regRes === "string" ? regRes : "") || "Máy chủ từ chối đăng ký"
    ).trim();
    const lower = rawMsg.toLowerCase();

    // 1. Cổng chưa mở / ngoài thời gian (BẮT BUỘC kiểm tra TRƯỚC "không đủ điều kiện")
    const isGateWait =
      lower.includes("thời gian") ||
      lower.includes("chưa mở") ||
      lower.includes("chưa đến giờ") ||
      lower.includes("ngoài thời gian");
    if (isGateWait) {
      return { ok: false, retryable: true, state: "wait", isGateWait: true, isConflict: false, isCoReq: false, msg: rawMsg };
    }

    // 2. Trùng lịch học (chống Fake OK)
    const isConflict =
      lower.includes("trùng lịch") ||
      lower.includes("trùng giờ") ||
      lower.includes("trùng ca");
    if (isConflict) {
      return { ok: false, retryable: false, state: "err", isGateWait: false, isConflict: true, isCoReq: false, msg: rawMsg };
    }

    // 3. Lớp đầy / khóa / hết sĩ số
    const isFullOrLocked =
      lower.includes("đầy") ||
      lower.includes("hết chỗ") ||
      lower.includes("sĩ số") ||
      lower.includes("đủ số lượng") ||
      lower.includes("khóa") ||
      lower.includes("tạm khóa");
    if (isFullOrLocked) {
      return { ok: false, retryable: true, state: "wait", isGateWait: false, isConflict: false, isCoReq: false, msg: rawMsg };
    }

    // 4. Môn học đã đăng ký trong đợt (chống Fake OK: không được dính trùng lịch hoặc đủ số lượng)
    const isAlreadyReg =
      (lower.includes("môn học này đã đăng ký") ||
        lower.includes("học phần này đã được đăng ký") ||
        lower.includes("đã đăng ký trong đợt") ||
        lower.includes("trùng môn học") ||
        lower.includes("trùng môn")) &&
      !lower.includes("trùng lịch") &&
      !lower.includes("đủ số lượng");
    if (isAlreadyReg) {
      return { ok: true, retryable: false, state: "ok", isGateWait: false, isConflict: false, isCoReq: false, msg: rawMsg };
    }

    // 5. Yêu cầu môn học song hành (để kích hoạt Pass 2)
    const isCoReq = lower.includes("song hành");
    if (isCoReq) {
      return { ok: false, retryable: true, state: "err", isGateWait: false, isConflict: false, isCoReq: true, msg: rawMsg };
    }

    // 6. Lỗi quy chế vĩnh viễn (tiên quyết, vượt tín chỉ, học phí, kỷ luật...)
    const isPermanent =
      lower.includes("tiên quyết") ||
      lower.includes("học trước") ||
      lower.includes("vượt quá số tín chỉ") ||
      lower.includes("tín chỉ tối đa") ||
      lower.includes("học phí") ||
      lower.includes("công nợ") ||
      lower.includes("không đủ điều kiện") ||
      lower.includes("cấm thi") ||
      lower.includes("kỷ luật");
    if (isPermanent) {
      return { ok: false, retryable: false, state: "err", isGateWait: false, isConflict: false, isCoReq: false, msg: rawMsg };
    }

    return { ok: false, retryable: true, state: "err", isGateWait: false, isConflict: false, isCoReq: false, msg: rawMsg };
  }

  function getCourseKey(item) {
    return String(item.maMonHoc || item.maHocPhan || item.maLHP || item.id || "");
  }

  async function dkhpFormPost(path, paramsObj, timeoutMs = 15000) {
    const body = Object.entries(paramsObj || {})
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
      .join("&");

    let res;
    let text;
    try {
      ({ res, text } = await agentEnqueue(async () => {
        return fetchWithTimeout(
          path,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body,
          },
          timeoutMs
        );
      }));
    } catch (e) {
      _agentFailStreak++;
      throw e;
    }

    if (!res) {
      _agentFailStreak++;
      throw new Error("Không nhận được phản hồi");
    }

    if (res.status === 403 || text.includes("Web Application Firewall")) {
      _agentBlocked = true;
      _agentFailStreak++;
      throw new Error("Cổng DKHP chặn yêu cầu (WAF/403). Đã dừng tự động để bảo vệ phiên.");
    }
    if (res.status >= 500 && res.status < 600) {
      return { serverBusy: true, message: `Máy chủ quá tải (HTTP ${res.status})` };
    }
    if (!res.ok) {
      _agentFailStreak++;
      throw new Error(`HTTP ${res.status}`);
    }
    if (text.includes("<!DOCTYPE") || text.includes("<html") || text.includes("frmLogin")) {
      _agentFailStreak++;
      throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
    }
    _agentFailStreak = 0;
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  function appendAgentLog(msg, type = "info") {
    const logBox = document.getElementById("iuh-agent-log-box");
    if (!logBox) return;
    const now = new Date().toLocaleTimeString("vi-VN", { hour12: false });
    const color =
      type === "ok"
        ? "#34d399"
        : type === "err"
        ? "#f87171"
        : type === "warn"
        ? "#fbbf24"
        : "#93c5fd";
    const line = document.createElement("div");
    line.style.cssText = `padding: 2px 0; border-bottom: 1px dashed rgba(255,255,255,0.05); color: ${color};`;
    line.innerHTML = `<span style="color:#64748b;">[${now}]</span> ${escapeHtml(msg)}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  // Chuẩn hóa cặp maMonHoc (6 chữ số) và dsHocPhanDuocHoc (10 chữ số) từ DOM trang DKHP hoặc từ dữ liệu Clipboard
  function resolveCourseParamsOnPage(item) {
    let rawMH = String(item.maMonHoc || "").trim();
    let rawHP = String(item.maHocPhan || "").trim();
    let rawLHP = String(item.maLHP || "").trim();

    // 1. Ưu tiên đọc từ bảng #monHocCho trên trang /DangKyHocPhan nếu môn đang hiển thị
    try {
      const courseRow =
        (rawMH ? document.querySelector(`#monHocCho tbody tr.monhoc_${CSS.escape(rawMH)}`) : null) ||
        Array.from(document.querySelectorAll("#monHocCho tbody tr.monhoctr")).find(
          (tr) =>
            (rawMH && tr.textContent.includes(rawMH)) ||
            (rawHP && tr.textContent.includes(rawHP)) ||
            (item.tenMonHoc && tr.textContent.includes(item.tenMonHoc))
        );
      if (courseRow) {
        const onclickAttr = courseRow.getAttribute("onclick") || "";
        const m = onclickAttr.match(/SelectMonHoc\(\s*this\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
        if (m) {
          rawMH = m[1].trim();
          rawHP = m[2].trim();
        }
      }
    } catch (_) {}

    // 2. Chuẩn hóa theo quy tắc mã IUH: MaMonHoc (6 số, VD: 003281), MaHocPhan (10 số: 4203 + MaMonHoc), MaLHP (12 số)
    const tenDigit =
      (rawHP.length >= 10 ? rawHP.substring(0, 10) : "") ||
      (rawMH.length >= 10 ? rawMH.substring(0, 10) : "") ||
      (rawLHP.length >= 10 ? rawLHP.substring(0, 10) : "");
    if (tenDigit && /^\d{10}$/.test(tenDigit)) {
      rawHP = tenDigit;
      if (!rawMH || rawMH.length > 6) {
        rawMH = tenDigit.substring(4, 10);
      }
    } else if (rawMH && /^\d{6}$/.test(rawMH) && (!rawHP || rawHP.length < 10)) {
      rawHP = `4203${rawMH}`;
    }

    const khoaHocEl = document.getElementById("cboKhoaHoc");
    const khoaHocDangKy = Number(khoaHocEl?.value || 0) || 0;

    return {
      maMonHoc: rawMH || rawHP,
      dsHocPhanDuocHoc: rawHP || rawMH,
      khoaHocDangKy,
    };
  }

  function isAgentClassOpen(cls) {
    if (!cls || !cls.IdLopHocPhanString) return false;
    const rawStatus = removeVietnameseTones(String(cls.TrangThai || cls.TrangThaiLopHocPhan || ""));
    if (rawStatus.includes("da khoa") || rawStatus.includes("tam khoa") || rawStatus.includes("huy")) {
      return false;
    }
    const siSo = Number(cls.SiSoDangKy ?? 0);
    const toiDa = Number(cls.SiSoToiDa ?? 0);
    if (toiDa <= 0 && siSo <= 0) return false;
    return toiDa <= 0 || siSo < toiDa;
  }

  // Đăng ký 1 môn bằng API trực tiếp ngay trên origin dkhp.iuh.edu.vn
  async function registerSingleCourseAjax(item, idDot, hinhThuc) {
    const key = getCourseKey(item);
    _agentStatusByCourseKey[key] = { state: "running", msg: "⏳ Đang dò lớp..." };
    updateAgentCourseRowUI(key);

    let targetMaLHP = String(item.maLHP || "").trim();
    const isSpecificLhpCode =
      targetMaLHP.length >= 11 &&
      targetMaLHP !== String(item.maHocPhan || "").trim() &&
      targetMaLHP !== String(item.maMonHoc || "").trim();

    let nhomTH =
      item.nhomTH !== null && item.nhomTH !== undefined && item.nhomTH !== ""
        ? Number(item.nhomTH)
        : 0;

    try {
      // Luôn gọi GetDanhSachLopHocPhan để lấy IdLopHocPhanString mới theo phiên hiện tại và kiểm tra sĩ số thực
      const queryParams = resolveCourseParamsOnPage(item);
      const classes = await dkhpFormPost("/DangKyHocPhan/GetDanhSachLopHocPhan", {
        maMonHoc: queryParams.maMonHoc,
        idDot: Number(idDot),
        dsHocPhanDuocHoc: queryParams.dsHocPhanDuocHoc,
        khoaHocDangKy: queryParams.khoaHocDangKy,
        isLHPKhongTrungLich: false,
      });

      if (classes && classes.serverBusy) {
        const msg = classes.message;
        _agentStatusByCourseKey[key] = { state: "wait", msg: `⏳ ${msg}` };
        updateAgentCourseRowUI(key);
        appendAgentLog(`${item.tenMonHoc}: ${msg}`, "warn");
        return { ok: false, retryable: true, msg };
      }

      const classList = Array.isArray(classes) ? classes : [];
      if (classList.length === 0) {
        const msg = "Chưa có lớp mở trên DKHP";
        _agentStatusByCourseKey[key] = { state: "wait", msg: `⚠️ ${msg}` };
        updateAgentCourseRowUI(key);
        appendAgentLog(`${item.tenMonHoc}: ${msg}`, "warn");
        return { ok: false, retryable: true, msg };
      }

      // Tìm theo Mã LHP 12 số đã ghim
      let matched = null;
      if (isSpecificLhpCode) {
        matched = classList.find(
          (c) => String(c.MaLopHocPhan || "").trim() === targetMaLHP
        );
      }

      // Nếu lớp đã ghim đầy/khóa hoặc chưa chọn lớp cụ thể, tự chọn lớp còn chỗ nếu bật _agentAutoPickOpenClass
      if (matched) {
        if (!isAgentClassOpen(matched)) {
          const siSo = Number(matched.SiSoDangKy ?? 0);
          const toiDa = Number(matched.SiSoToiDa ?? 0);
          const rawStatus = removeVietnameseTones(String(matched.TrangThai || matched.TrangThaiLopHocPhan || ""));
          const isLocked = rawStatus.includes("da khoa") || rawStatus.includes("tam khoa") || rawStatus.includes("huy");
          if (!_agentAutoPickOpenClass) {
            const msg = isLocked
              ? `Lớp ${targetMaLHP} đang khóa (${siSo}/${toiDa})`
              : `Lớp ${targetMaLHP} đã đầy (${siSo}/${toiDa})`;
            _agentStatusByCourseKey[key] = {
              state: "wait",
              msg: isLocked ? `🔒 Khóa (${siSo}/${toiDa})` : `🎯 Đầy (${siSo}/${toiDa})`,
            };
            updateAgentCourseRowUI(key);
            appendAgentLog(`${item.tenMonHoc}: ${msg}`, "warn");
            return { ok: false, retryable: true, msg };
          }
          const fallback = classList.find((c) => isAgentClassOpen(c));
          if (fallback) {
            matched = fallback;
            targetMaLHP = String(fallback.MaLopHocPhan || "");
            appendAgentLog(
              `${item.tenMonHoc}: Lớp cũ đầy/khóa, tự chuyển sang ${targetMaLHP} (${fallback.SiSoDangKy}/${fallback.SiSoToiDa})`,
              "warn"
            );
          }
        }
      } else if (_agentAutoPickOpenClass) {
        matched = classList.find((c) => isAgentClassOpen(c)) || classList[0];
        if (matched) {
          targetMaLHP = String(matched.MaLopHocPhan || "");
        }
      }

      if (!matched || !matched.IdLopHocPhanString) {
        const msg = isSpecificLhpCode
          ? `Không tìm thấy mã LHP ${targetMaLHP}`
          : "Chưa chọn mã LHP 12 số cụ thể";
        _agentStatusByCourseKey[key] = { state: "err", msg: `❌ ${msg}` };
        updateAgentCourseRowUI(key);
        appendAgentLog(`${item.tenMonHoc}: ${msg}`, "err");
        return { ok: false, retryable: true, msg };
      }

      if (!isAgentClassOpen(matched)) {
        const siSo = Number(matched.SiSoDangKy ?? 0);
        const toiDa = Number(matched.SiSoToiDa ?? 0);
        const rawStatus = removeVietnameseTones(String(matched.TrangThai || matched.TrangThaiLopHocPhan || ""));
        const isLocked = rawStatus.includes("da khoa") || rawStatus.includes("tam khoa") || rawStatus.includes("huy");
        const msg = isLocked
          ? `Lớp ${targetMaLHP} đang khóa (${siSo}/${toiDa})`
          : `Lớp ${targetMaLHP} đã đầy (${siSo}/${toiDa})`;
        _agentStatusByCourseKey[key] = {
          state: "wait",
          msg: isLocked ? `🔒 Khóa (${siSo}/${toiDa})` : `🎯 Đầy (${siSo}/${toiDa})`,
        };
        updateAgentCourseRowUI(key);
        appendAgentLog(`${item.tenMonHoc}: ${msg}`, "warn");
        return { ok: false, retryable: true, msg };
      }

      const idEncrypted = String(matched.IdLopHocPhanString);
      item.idEncrypted = idEncrypted;
      item.maLHP = targetMaLHP;

      // Kiểm tra chi tiết lớp để tự động lấy Tổ TH và các tổ khả dụng
      let availableGroups = [];
      if (item._noThConfirmed !== targetMaLHP) {
        try {
          const detail = await dkhpFormPost("/DangKyHocPhan/GetChiTietLopHocPhan", {
            idLopHocPhan: idEncrypted,
            maNhomTH: -1,
          });
          if (detail && Array.isArray(detail.DSNhomThucHanh) && detail.DSNhomThucHanh.length > 0) {
            availableGroups = detail.DSNhomThucHanh.map((g) => Number(g.MaNhom || 1)).filter((n) => n > 0);
            if ((!nhomTH || nhomTH <= 0) && availableGroups.length > 0) {
              nhomTH = availableGroups[0];
              item.nhomTH = nhomTH;
            }
          } else {
            item._noThConfirmed = targetMaLHP;
          }
        } catch (_) {}
      }

      let groupsToTry = [nhomTH];
      if (availableGroups.length > 0 && _agentAutoPickOpenClass) {
        groupsToTry = [nhomTH, ...availableGroups.filter((g) => g !== nhomTH)];
      }

      let finalRes = null;
      for (let gIdx = 0; gIdx < groupsToTry.length; gIdx++) {
        const curGroup = groupsToTry[gIdx];

        // Bước kiểm tra địa điểm phòng học
        try {
          await dkhpFormPost("/DangKyHocPhan/CheckKhacDiaDiemPhongBuoiHoc", {
            idLopHocPhan: idEncrypted,
            nhomThucHanh: curGroup > 0 ? curGroup : "",
          });
        } catch (_) {}

        _agentStatusByCourseKey[key] = {
          state: "running",
          msg: `🚀 Đang gửi ĐK${curGroup > 0 ? ` (Tổ ${curGroup})` : ""}...`,
        };
        updateAgentCourseRowUI(key);

        // Gọi endpoint đăng ký chính thức với timeout 20s
        const regRes = await dkhpFormPost(
          "/DangKyHocPhan/DangKyHocPhan",
          {
            idLopHocPhan: idEncrypted,
            loaiDangky: Number(hinhThuc || 1),
            idDot: Number(idDot),
            nhomThucHanh: curGroup > 0 ? curGroup : "",
          },
          20000
        );

        const classification = classifyDkhpRegResponse(regRes, targetMaLHP);
        finalRes = classification;

        if (classification.ok) {
          if (curGroup > 0) item.nhomTH = curGroup;
          const msg = `Đã ĐK thành công [${targetMaLHP}]${curGroup > 0 ? ` (Tổ ${curGroup})` : ""}`;
          _agentStatusByCourseKey[key] = { state: "ok", msg: `✅ ${msg}` };
          updateAgentCourseRowUI(key);
          appendAgentLog(`🎉 ${item.tenMonHoc}: ${msg}!`, "ok");
          return { ok: true, retryable: false, isCoReq: false, msg };
        }

        // Nếu lỗi do đầy/hết chỗ ở Tổ TH này và còn Tổ TH khác để thử -> xoay vòng thử tiếp
        if (classification.state === "wait" && gIdx < groupsToTry.length - 1) {
          appendAgentLog(
            `${item.tenMonHoc} [${targetMaLHP} - Tổ ${curGroup}]: ${classification.msg} -> Đang tự động thử tiếp Tổ ${groupsToTry[gIdx + 1]}...`,
            "warn"
          );
          await sleep(200);
          continue;
        }
        break;
      }

      _agentStatusByCourseKey[key] = {
        state: finalRes.state,
        msg: `${finalRes.state === "ok" ? "✅" : finalRes.state === "wait" ? "⏳" : "❌"} ${finalRes.msg}`,
      };
      updateAgentCourseRowUI(key);
      appendAgentLog(
        `${item.tenMonHoc}: ${finalRes.msg}`,
        finalRes.state === "ok" ? "ok" : finalRes.state === "wait" ? "warn" : "err"
      );
      return {
        ok: finalRes.ok,
        retryable: finalRes.retryable,
        isCoReq: finalRes.isCoReq,
        msg: finalRes.msg,
      };
    } catch (err) {
      const msg = err.message || "Lỗi kết nối";
      _agentStatusByCourseKey[key] = { state: "err", msg: `❌ ${msg}` };
      updateAgentCourseRowUI(key);
      appendAgentLog(`${item.tenMonHoc}: ${msg}`, "err");
      return { ok: false, retryable: true, msg };
    }
  }

  // Tự động thao tác DOM từng bước trên trang dkhp.iuh.edu.vn/DangKyHocPhan
  async function runDomClickAutomation() {
    if (_agentIsRunning) return;
    const list = _agentPlannedByDot[_agentSelectedDot] || [];
    const selectedItems = getCheckedClipboardItems(list);
    if (selectedItems.length === 0) {
      appendAgentLog("Chưa chọn môn nào trong Clipboard để chạy DOM.", "warn");
      return;
    }

    _agentIsRunning = true;
    updateAgentButtonsState();
    appendAgentLog(`🤖 Bắt đầu tự động thao tác DOM cho ${selectedItems.length} môn...`, "info");

    try {
      // 1. Chọn đợt đăng ký #ddk và loại đăng ký input[name="sv-dk"]
      const ddkEl = document.getElementById("ddk");
      if (ddkEl && String(ddkEl.value) !== String(_agentSelectedDot)) {
        ddkEl.value = String(_agentSelectedDot);
        ddkEl.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(1200);
      }

      const radEl = document.querySelector(
        `input[name="sv-dk"][value="${_agentHinhThuc}"]`
      );
      if (radEl && !radEl.checked) {
        radEl.click();
        await sleep(1000);
      }

      for (const item of selectedItems) {
        if (!_agentIsRunning) break;
        const key = getCourseKey(item);
        if (_agentStatusByCourseKey[key]?.state === "ok") continue;

        _agentStatusByCourseKey[key] = { state: "running", msg: "🤖 Đang chọn môn..." };
        updateAgentCourseRowUI(key);

        // Tìm dòng môn học trong bảng #monHocCho
        const resolved = resolveCourseParamsOnPage(item);
        const maMH = resolved.maMonHoc;
        const maHP = resolved.dsHocPhanDuocHoc;
        let courseRow =
          (maMH ? document.querySelector(`#monHocCho tbody tr.monhoc_${CSS.escape(maMH)}`) : null) ||
          Array.from(document.querySelectorAll("#monHocCho tbody tr.monhoctr")).find(
            (tr) =>
              (maMH && tr.textContent.includes(maMH)) ||
              (maHP && tr.textContent.includes(maHP)) ||
              (item.tenMonHoc && tr.textContent.includes(item.tenMonHoc))
          );

        if (!courseRow) {
          appendAgentLog(
            `Không thấy môn ${item.tenMonHoc} trên bảng Môn học chờ, chuyển sang gọi API trực tiếp...`,
            "warn"
          );
          await registerSingleCourseAjax(item, _agentSelectedDot, _agentHinhThuc);
          continue;
        }

        // Đánh dấu stale các hàng lớp học cũ trong #lopHocCho trước khi click
        document.querySelectorAll("#lopHocCho tbody tr").forEach((tr) => tr.setAttribute("data-iuh-stale", "1"));

        courseRow.scrollIntoView({ behavior: "smooth", block: "center" });
        courseRow.click();

        // Chờ danh sách lớp mới #lopHocCho hiển thị (kiểm tra không bị stale)
        let classRows = [];
        for (let w = 0; w < 16; w++) {
          await sleep(250);
          const matchingRows = maMH ? Array.from(document.querySelectorAll(`#lopHocCho tbody tr.mh_${CSS.escape(maMH)}`)) : [];
          if (matchingRows.length > 0) {
            classRows = matchingRows;
            break;
          }
          const freshRows = Array.from(document.querySelectorAll("#lopHocCho tbody tr.lophoctr:not([data-iuh-stale])"));
          if (freshRows.length > 0) {
            classRows = freshRows;
            break;
          }
        }

        if (classRows.length === 0) {
          _agentStatusByCourseKey[key] = {
            state: "wait",
            msg: "⚠️ Không có lớp mở trên bảng",
          };
          updateAgentCourseRowUI(key);
          appendAgentLog(`${item.tenMonHoc}: Không tìm thấy lớp mở trong #lopHocCho`, "warn");
          continue;
        }

        const targetMaLHP = String(item.maLHP || "").trim();
        const isSpecificLhp =
          targetMaLHP.length >= 11 &&
          targetMaLHP !== maHP &&
          targetMaLHP !== maMH;
        let targetRow = null;
        if (isSpecificLhp) {
          targetRow = classRows.find((tr) => tr.textContent.includes(targetMaLHP));
        }
        if (!targetRow && _agentAutoPickOpenClass) {
          targetRow =
            classRows.find((tr) => !tr.textContent.toLowerCase().includes("đã khóa")) ||
            classRows[0];
        }

        if (!targetRow) {
          _agentStatusByCourseKey[key] = {
            state: "err",
            msg: `❌ Không thấy lớp ${targetMaLHP}`,
          };
          updateAgentCourseRowUI(key);
          appendAgentLog(`${item.tenMonHoc}: Không thấy mã LHP ${targetMaLHP}`, "err");
          continue;
        }

        // Đánh dấu stale các chi tiết lớp cũ trong #chiTietLopHoc trước khi click lớp
        document.querySelectorAll("#chiTietLopHoc tbody tr").forEach((tr) => tr.setAttribute("data-iuh-stale", "1"));

        targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
        targetRow.click();

        // Chờ TimLopHocChiTiet nạp xong bảng #chiTietLopHoc và mở khóa nút #dkMonHoc
        for (let w = 0; w < 16; w++) {
          await sleep(250);
          const freshCtRows = document.querySelectorAll("#chiTietLopHoc tbody tr:not([data-iuh-stale])");
          const dkBtnCheck = document.getElementById("dkMonHoc");
          if (freshCtRows.length > 0 && dkBtnCheck && !dkBtnCheck.disabled) break;
        }
        await sleep(150);

        // Chọn nhóm thực hành nếu #selectNhomTH có option hợp lệ (> 0)
        const selectTH = document.getElementById("selectNhomTH");
        if (selectTH && selectTH.options.length > 0) {
          const validOpts = Array.from(selectTH.options).filter(
            (opt) => opt.value && Number(opt.value) > 0
          );
          if (validOpts.length > 0) {
            const desiredOpt =
              (item.nhomTH &&
                Number(item.nhomTH) > 0 &&
                validOpts.find((o) => Number(o.value) === Number(item.nhomTH))) ||
              validOpts[0];
            selectTH.value = desiredOpt.value;
            selectTH.dispatchEvent(new Event("change", { bubbles: true }));
            await sleep(250);
          }
        }

        const dkBtn = document.getElementById("dkMonHoc");
        if (dkBtn && !dkBtn.disabled) {
          dkBtn.click();

          // Chờ và tự động xử lý SweetAlert2: xác nhận địa điểm khác & đọc thông báo thật
          let popupMessage = "";
          let popupSuccess = false;
          for (let s = 0; s < 12; s++) {
            await sleep(300);
            const swalConfirm = document.querySelector(
              ".swal2-container .swal2-confirm:not(:disabled)"
            );
            const swalTitle = document.querySelector(".swal2-container #swal2-title, .swal2-container .swal2-title");
            const swalContent = document.querySelector(".swal2-container #swal2-content, .swal2-container .swal2-html-container");
            const titleText = (swalTitle?.textContent || "").toLowerCase();
            const contentText = swalContent?.textContent || "";

            if (titleText.includes("xác nhận") && swalConfirm && swalConfirm.offsetParent !== null) {
              swalConfirm.click();
              await sleep(400);
              continue;
            }

            if (contentText || titleText) {
              popupMessage = (swalTitle?.textContent ? `${swalTitle.textContent}: ` : "") + contentText;
              if (titleText.includes("thành công") || contentText.toLowerCase().includes("thành công")) {
                popupSuccess = true;
              }
              if (swalConfirm && swalConfirm.offsetParent !== null) {
                swalConfirm.click();
              }
              break;
            }
          }

          if (!popupMessage) {
            const lopDaDkTable = document.getElementById("lopDaDK");
            if (lopDaDkTable && (lopDaDkTable.textContent.includes(targetMaLHP) || lopDaDkTable.textContent.includes(item.tenMonHoc))) {
              popupSuccess = true;
              popupMessage = `Đã thấy môn [${targetMaLHP}] trong bảng Lớp đã đăng ký`;
            }
          }

          const classification = classifyDkhpRegResponse(popupSuccess ? { check: true } : popupMessage, targetMaLHP);
          _agentStatusByCourseKey[key] = {
            state: classification.state,
            msg: `${classification.state === "ok" ? "✅" : classification.state === "wait" ? "⏳" : "❌"} ${classification.msg}`,
          };
          updateAgentCourseRowUI(key);
          appendAgentLog(
            `${item.tenMonHoc}: ${classification.msg}`,
            classification.state === "ok" ? "ok" : classification.state === "wait" ? "warn" : "err"
          );
        } else {
          await registerSingleCourseAjax(item, _agentSelectedDot, _agentHinhThuc);
        }
      }
    } finally {
      _agentIsRunning = false;
      updateAgentButtonsState();
      refreshDkhpPageRegisteredTable();
    }
  }

  function refreshDkhpPageRegisteredTable() {
    try {
      const ddkEl = document.getElementById("ddk");
      if (ddkEl) {
        ddkEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (_) {}
  }

  function getCheckedClipboardItems(list) {
    const panel = document.getElementById("iuh-dkhp-agent-panel");
    if (!panel) return list;
    const checkedKeys = new Set(
      Array.from(panel.querySelectorAll(".iuh-agent-item-chk:checked")).map((el) =>
        el.getAttribute("data-key")
      )
    );
    return list.filter((item) => checkedKeys.has(getCourseKey(item)));
  }

  async function runBatchDirectAjax(isSniperTick = false) {
    if (_agentIsRunning) return;
    const list = _agentPlannedByDot[_agentSelectedDot] || [];
    const selectedItems = getCheckedClipboardItems(list);

    if (selectedItems.length === 0) {
      if (!isSniperTick) {
        appendAgentLog("Vui lòng tích chọn ít nhất 1 môn trong Clipboard.", "warn");
      }
      return;
    }

    _agentIsRunning = true;
    updateAgentButtonsState();

    if (!isSniperTick) {
      appendAgentLog(
        `⚡ Bắt đầu Đăng ký Siêu tốc (API) cho ${selectedItems.length} môn...`,
        "info"
      );
    }

    let anySuccess = false;
    let remainingRetryable = 0;
    const failedWithCoReqItems = [];

    try {
      // 1. Kiểm tra trạng thái cổng đăng ký bằng 1 request nhẹ
      try {
        const dotCheck = await dkhpFormPost("/DangKyHocPhan/CheckDotChoPhepDangKy", {
          idDot: Number(_agentSelectedDot),
        });
        const checkStr = typeof dotCheck === "string" ? dotCheck.trim() : (dotCheck?.message || "");
        if (checkStr.length > 0) {
          const lower = checkStr.toLowerCase();
          if (lower.includes("thời gian") || lower.includes("chưa mở") || lower.includes("chưa đến giờ")) {
            appendAgentLog(`⏳ Cổng DKHP đợt ${_agentSelectedDot} chưa mở: "${checkStr}" — Đang tiếp tục canh...`, "warn");
            return;
          }
        }
      } catch (_) {}

      // 2. Pass 1
      for (const item of selectedItems) {
        const key = getCourseKey(item);
        if (_agentStatusByCourseKey[key]?.state === "ok") continue;

        const res = await registerSingleCourseAjax(
          item,
          _agentSelectedDot,
          _agentHinhThuc
        );
        if (res.ok) {
          anySuccess = true;
        } else {
          if (res.isCoReq) failedWithCoReqItems.push(item);
          if (res.retryable) remainingRetryable++;
        }
        if (agentShouldAbortSniper()) {
          appendAgentLog(
            _agentBlocked
              ? "🛑 Cổng DKHP chặn yêu cầu (WAF/403). Đã dừng tự động để bảo vệ phiên đăng nhập."
              : `🛑 ${AGENT_MAX_FAIL_STREAK} lần lỗi liên tiếp từ DKHP. Đã dừng tự động để bảo vệ phiên đăng nhập.`,
            "err"
          );
          stopAgentSniperMode();
          break;
        }
        await sleep(180);
      }

      // 3. Pass 2 (Song hành)
      if (anySuccess && failedWithCoReqItems.length > 0) {
        appendAgentLog(
          "🔄 Có môn đã đăng ký thành công! Đang kích hoạt Lượt 2 (Pass 2) để tự động đăng ký lại các môn có yêu cầu Song hành...",
          "info"
        );
        for (const coReqItem of failedWithCoReqItems) {
          const key = getCourseKey(coReqItem);
          if (_agentStatusByCourseKey[key]?.state === "ok") continue;
          const res2 = await registerSingleCourseAjax(
            coReqItem,
            _agentSelectedDot,
            _agentHinhThuc
          );
          if (res2.ok) {
            anySuccess = true;
            remainingRetryable = Math.max(0, remainingRetryable - 1);
          }
          await sleep(180);
        }
      }
    } finally {
      _agentIsRunning = false;
      updateAgentButtonsState();
    }

    if (anySuccess) {
      refreshDkhpPageRegisteredTable();
    }

    if (_agentSniperIntervalId && remainingRetryable === 0) {
      stopAgentSniperMode();
      appendAgentLog("🎉 Tất cả các môn đã xử lý xong, tự động dừng Canh Slot!", "ok");
    }
  }

  async function toggleAgentSniperMode() {
    if (_agentSniperToggling) return;
    _agentSniperToggling = true;

    try {
      if (_agentSniperIntervalId) {
        stopAgentSniperMode();
        appendAgentLog("⏹️ Đã dừng chế độ Canh Slot tự động.", "warn");
        return;
      }

      const secInput = document.getElementById("iuh-agent-sniper-sec");
      _agentSniperIntervalSec = Math.max(
        AGENT_SNIPER_MIN_SEC,
        parseInt(secInput?.value || String(AGENT_SNIPER_MIN_SEC), 10) || AGENT_SNIPER_MIN_SEC
      );
      if (secInput) secInput.value = String(_agentSniperIntervalSec);

      // Chỉ cho phép 1 sniper chạy tại một thời điểm (Dashboard hoặc trang DKHP)
      const gotLock = await acquireAgentSniperLock(_agentSniperIntervalSec);
      if (!gotLock) {
        appendAgentLog(
          "⚠️ Đang có một Canh Slot khác chạy (trên tab Dashboard). Hãy dừng nó trước khi bật ở đây.",
          "warn"
        );
        return;
      }
      _agentFailStreak = 0;
      _agentBlocked = false;

      appendAgentLog(
        `🎯 Đã bật Canh Slot tự động (thử lại mỗi ${_agentSniperIntervalSec} giây)...`,
        "ok"
      );
      _agentSniperIntervalId = setInterval(() => {
        if (agentShouldAbortSniper()) {
          stopAgentSniperMode();
          return;
        }
        heartbeatAgentSniperLock();
        runBatchDirectAjax(true);
      }, _agentSniperIntervalSec * 1000);
      runBatchDirectAjax(false);
      updateAgentButtonsState();
    } finally {
      _agentSniperToggling = false;
    }
  }

  function stopAgentSniperMode() {
    if (_agentSniperIntervalId) {
      clearInterval(_agentSniperIntervalId);
      _agentSniperIntervalId = null;
    }
    releaseAgentSniperLock();
    updateAgentButtonsState();
  }

  function updateAgentCourseRowUI(key) {
    const badge = document.querySelector(
      `.iuh-agent-status-badge[data-key="${CSS.escape(key)}"]`
    );
    if (!badge) return;
    const st = _agentStatusByCourseKey[key] || { state: "idle", msg: "⏸️ Chờ lệnh" };
    badge.textContent = st.msg;
    if (st.state === "ok") {
      badge.style.background = "rgba(16,185,129,0.2)";
      badge.style.color = "#34d399";
    } else if (st.state === "running") {
      badge.style.background = "rgba(59,130,246,0.2)";
      badge.style.color = "#60a5fa";
    } else if (st.state === "wait") {
      badge.style.background = "rgba(245,158,11,0.2)";
      badge.style.color = "#fbbf24";
    } else if (st.state === "err") {
      badge.style.background = "rgba(239,68,68,0.2)";
      badge.style.color = "#f87171";
    } else {
      badge.style.background = "rgba(148,163,184,0.15)";
      badge.style.color = "#94a3b8";
    }
  }

  function updateAgentButtonsState() {
    const btnFast = document.getElementById("iuh-agent-btn-fast");
    const btnDom = document.getElementById("iuh-agent-btn-dom");
    const btnSniper = document.getElementById("iuh-agent-btn-sniper");
    if (btnFast) {
      btnFast.disabled = _agentIsRunning;
      btnFast.textContent = _agentIsRunning
        ? "⏳ Đang gửi lệnh ĐK..."
        : "⚡ ĐK Siêu tốc (API)";
    }
    if (btnDom) {
      btnDom.disabled = _agentIsRunning;
    }
    if (btnSniper) {
      btnSniper.textContent = _agentSniperIntervalId
        ? `⏹️ Dừng Canh (${_agentSniperIntervalSec}s)`
        : "🎯 Canh Slot Tự Động";
      btnSniper.style.background = _agentSniperIntervalId
        ? "rgba(239,68,68,0.25)"
        : "rgba(245,158,11,0.2)";
      btnSniper.style.color = _agentSniperIntervalId ? "#f87171" : "#fbbf24";
    }
  }

  function renderAgentPanel() {
    const path = window.location.pathname.toLowerCase();
    if (!path.includes("dangkyhocphan") && !document.getElementById("monHocCho")) {
      return;
    }

    let panel = document.getElementById("iuh-dkhp-agent-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "iuh-dkhp-agent-panel";
      panel.style.cssText = `
        position: fixed; bottom: 16px; right: 16px; z-index: 999999;
        width: 410px; max-width: calc(100vw - 24px);
        background: #0f172a; color: #f8fafc;
        border: 1px solid #334155; border-radius: 14px;
        box-shadow: 0 18px 42px rgba(0,0,0,0.55);
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        font-size: 12.5px; overflow: hidden;
      `;
      document.body.appendChild(panel);
    }

    const list = _agentPlannedByDot[_agentSelectedDot] || [];

    if (_agentMinimized) {
      panel.style.width = "auto";
      panel.innerHTML = `
        <button id="iuh-agent-expand-btn" type="button" style="
          background: linear-gradient(135deg, #2563eb, #10b981);
          color: #fff; border: none; padding: 10px 16px; border-radius: 12px;
          font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 8px;
        ">
          🚀 IUH Auto-ĐKHP (${list.length} môn trong Clipboard) ▲
        </button>
      `;
      panel
        .querySelector("#iuh-agent-expand-btn")
        ?.addEventListener("click", () => {
          _agentMinimized = false;
          renderAgentPanel();
        });
      return;
    }

    panel.style.width = "410px";

    const rowsHtml =
      list.length === 0
        ? `<div style="padding:18px; text-align:center; color:#94a3b8;">
            Clipboard đợt <b>${escapeHtml(_agentSelectedDot)}</b> đang trống.<br/>
            Hãy chọn môn từ <b>IUH Dashboard &rarr; Chương trình khung / Lịch dự kiến</b>.
          </div>`
        : list
            .map((item) => {
              const key = getCourseKey(item);
              const st = _agentStatusByCourseKey[key] || {
                state: "idle",
                msg: "⏸️ Chờ lệnh",
              };
              const isRealLhp =
                item.maLHP &&
                item.maLHP !== item.maMonHoc &&
                item.maLHP !== item.maHocPhan;
              return `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 10px; border-bottom:1px solid rgba(255,255,255,0.06); background:rgba(30,41,59,0.5);">
                  <label style="display:flex; align-items:flex-start; gap:7px; cursor:pointer; flex:1; min-width:0; margin:0; font-weight:normal;">
                    <input type="checkbox" class="iuh-agent-item-chk" data-key="${escapeHtml(key)}" checked style="margin-top:3px; accent-color:#3b82f6;" />
                    <div style="min-width:0;">
                      <div style="font-weight:700; color:#f8fafc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(item.tenMonHoc)}">
                        ${escapeHtml(item.tenMonHoc)}
                      </div>
                      <div style="font-size:11px; color:#94a3b8;">
                        Mã LHP: <b style="color:${isRealLhp ? "#60a5fa" : "#fbbf24"}; font-family:monospace;">${escapeHtml(item.maLHP || item.maHocPhan)}</b>
                        ${item.nhomTH ? ` &bull; <span style="color:#34d399;">Tổ TH ${escapeHtml(item.nhomTH)}</span>` : ""}
                      </div>
                    </div>
                  </label>
                  <span class="iuh-agent-status-badge" data-key="${escapeHtml(key)}" style="padding:2px 8px; border-radius:99px; font-size:11px; font-weight:700; white-space:nowrap; background:rgba(148,163,184,0.15); color:#94a3b8;">
                    ${escapeHtml(st.msg)}
                  </span>
                </div>
              `;
            })
            .join("");

    panel.innerHTML = `
      <div style="background:linear-gradient(135deg, #1e293b, #0f172a); padding:11px 14px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center;">
        <div style="display:flex; align-items:center; gap:7px;">
          <span style="font-size:16px;">🚀</span>
          <div>
            <div style="font-weight:800; font-size:13px; color:#f8fafc;">IUH Auto-ĐKHP Assistant</div>
            <div style="font-size:10.5px; color:#38bdf8;">Đồng bộ trực tiếp với Clipboard (${list.length} môn)</div>
          </div>
        </div>
        <button id="iuh-agent-min-btn" type="button" style="background:transparent; border:1px solid #475569; color:#cbd5e1; border-radius:6px; padding:2px 8px; font-size:11px; cursor:pointer;">Thu gọn ▼</button>
      </div>

      <div style="max-height:190px; overflow-y:auto;">
        ${rowsHtml}
      </div>

      <div style="padding:10px 12px; background:#0b1120; border-top:1px solid #1e293b;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; font-size:11.5px;">
          <label style="display:flex; align-items:center; gap:5px; cursor:pointer; color:#cbd5e1; margin:0; font-weight:normal;">
            <input type="checkbox" id="iuh-agent-autopick-chk" ${_agentAutoPickOpenClass ? "checked" : ""} style="accent-color:#10b981;" />
            Tự chọn lớp còn chỗ nếu lớp ghim đầy/chưa chọn
          </label>
          <div style="display:flex; align-items:center; gap:4px; white-space:nowrap;">
            <span style="color:#94a3b8;">Canh mỗi:</span>
            <input type="number" id="iuh-agent-sniper-sec" value="${_agentSniperIntervalSec}" min="10" max="300" style="width:44px; background:#1e293b; color:#fff; border:1px solid #334155; border-radius:4px; padding:2px 4px; text-align:center; font-size:11px;" />
            <span style="color:#94a3b8;">s</span>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px;">
          <button id="iuh-agent-btn-fast" type="button" style="background:linear-gradient(135deg, #2563eb, #1d4ed8); color:#fff; border:none; border-radius:7px; padding:8px 10px; font-weight:700; font-size:12px; cursor:pointer;">
            ⚡ ĐK Siêu tốc (API)
          </button>
          <button id="iuh-agent-btn-sniper" type="button" style="background:rgba(245,158,11,0.2); color:#fbbf24; border:1px solid rgba(245,158,11,0.4); border-radius:7px; padding:8px 10px; font-weight:700; font-size:12px; cursor:pointer;">
            🎯 Canh Slot Tự Động
          </button>
        </div>

        <button id="iuh-agent-btn-dom" type="button" style="width:100%; background:rgba(16,185,129,0.16); color:#34d399; border:1px solid rgba(16,185,129,0.35); border-radius:7px; padding:6px 10px; font-weight:600; font-size:11.5px; cursor:pointer;">
          🤖 Tự động Click chọn từng môn trên giao diện web
        </button>

        <div id="iuh-agent-log-box" style="margin-top:8px; max-height:95px; overflow-y:auto; background:#020617; border:1px solid #1e293b; border-radius:6px; padding:6px 8px; font-family:monospace; font-size:11px; line-height:1.4;">
          <div style="color:#64748b;">Sẵn sàng hỗ trợ đăng ký học phần...</div>
        </div>
      </div>
    `;

    list.forEach((item) => updateAgentCourseRowUI(getCourseKey(item)));
    updateAgentButtonsState();

    panel.querySelector("#iuh-agent-min-btn")?.addEventListener("click", () => {
      _agentMinimized = true;
      renderAgentPanel();
    });

    panel
      .querySelector("#iuh-agent-autopick-chk")
      ?.addEventListener("change", (e) => {
        _agentAutoPickOpenClass = !!e.target.checked;
      });

    panel
      .querySelector("#iuh-agent-btn-fast")
      ?.addEventListener("click", () => runBatchDirectAjax(false));

    panel
      .querySelector("#iuh-agent-btn-sniper")
      ?.addEventListener("click", () => toggleAgentSniperMode());

    panel
      .querySelector("#iuh-agent-btn-dom")
      ?.addEventListener("click", () => runDomClickAutomation());
  }

  async function initDkhpAgent() {
    // Trích xuất thụ động _iDSV từ inline script trên trang /DangKyHocPhan (nếu có) để lưu vào storage
    try {
      const scripts = document.querySelectorAll("script:not([src])");
      for (const sc of scripts) {
        const m = (sc.textContent || "").match(/var\s+_iDSV\s*=\s*['"](\d+)['"]/);
        if (m && m[1]) {
          chrome.storage.local.set({ iuh_dkhp_idsv: m[1].trim() });
          break;
        }
      }
    } catch (_) {}

    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(
        [
          "iuh_lhp_planned_by_dot",
          "iuh_lhp_selected_dot",
          "iuh_dkhp_autostart_pending",
        ],
        resolve
      )
    );

    if (stored.iuh_lhp_planned_by_dot) {
      _agentPlannedByDot = stored.iuh_lhp_planned_by_dot;
    }
    if (stored.iuh_lhp_selected_dot) {
      _agentSelectedDot = String(stored.iuh_lhp_selected_dot);
    } else {
      const ddkEl = document.getElementById("ddk");
      if (ddkEl && ddkEl.value) _agentSelectedDot = String(ddkEl.value);
    }

    const pending = stored.iuh_dkhp_autostart_pending;
    if (pending && pending.idDot) {
      _agentSelectedDot = String(pending.idDot);
    }
    if (pending && pending.hinhThuc) {
      _agentHinhThuc = String(pending.hinhThuc);
    }
    if (pending && typeof pending.autoPick === "boolean") {
      _agentAutoPickOpenClass = pending.autoPick;
    }

    renderAgentPanel();

    // Nếu có cờ tự động chạy từ Dashboard gửi qua thì kích hoạt ngay
    if (
      pending &&
      pending.active &&
      (window.location.pathname.toLowerCase().includes("dangkyhocphan") ||
        document.getElementById("monHocCho"))
    ) {
      chrome.storage.local.remove("iuh_dkhp_autostart_pending");
      await sleep(1000);
      if (pending.mode === "dom") {
        runDomClickAutomation();
      } else if (pending.mode === "sniper") {
        toggleAgentSniperMode();
      } else {
        runBatchDirectAjax(false);
      }
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let shouldRender = false;
    if (changes.iuh_lhp_planned_by_dot?.newValue) {
      _agentPlannedByDot = changes.iuh_lhp_planned_by_dot.newValue;
      shouldRender = true;
    }
    if (changes.iuh_lhp_selected_dot?.newValue) {
      _agentSelectedDot = String(changes.iuh_lhp_selected_dot.newValue);
      shouldRender = true;
    }
    if (shouldRender) {
      renderAgentPanel();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDkhpAgent);
  } else {
    initDkhpAgent();
  }
})();
