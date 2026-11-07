// dkhp-api.js
// Module fetch du lieu tu dkhp.iuh.edu.vn (session-based, khong Ghost Tab).

const DKHP_BASE = "https://dkhp.iuh.edu.vn";

// =============================================================================
// REQUEST QUEUE + SAFETY GUARDS (chong van session / WAF)
// =============================================================================
const DKHP_MIN_GAP_MS = 300; // khoang cach toi thieu giua 2 request
const DKHP_SNIPER_MIN_SEC = 10; // chu ky Canh Slot toi thieu
const DKHP_SNIPER_LOCK_KEY = "iuh_dkhp_sniper_lock";
const DKHP_SNIPER_OWNER_DASHBOARD = "dashboard";
const DKHP_MAX_FAIL_STREAK = 3;

// Hoisted Auto-Reg & Sniper State (tránh lỗi TDZ khi refreshCourseSiSo được gọi sớm)
let _autoRegModalBound = false;
let _autoRegIsRunning = false;
let _autoRegSniperTimerId = null;
let _autoRegSniperCountdownId = null;
let _autoRegSniperRemainSec = 0;
let _autoRegStatusByCourseId = {}; // { [plannedId]: { state: 'idle'|'running'|'ok'|'wait'|'err', msg: string } }
let _sniperToggling = false;
const _autoRegInstanceId = "dash_" + Math.random().toString(36).substring(2, 9);

let _dkhpQueueTail = Promise.resolve();
let _dkhpLastRequestAt = 0;
let _dkhpFailStreak = 0;
let _dkhpBlocked = false; // true khi gap WAF / 403

/** Xep hang moi request toi dkhp.iuh.edu.vn: chay tung cai mot, cach nhau >= DKHP_MIN_GAP_MS. */
function dkhpEnqueue(task) {
  const run = async () => {
    const wait = _dkhpLastRequestAt + DKHP_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      _dkhpLastRequestAt = Date.now();
    }
  };
  const p = _dkhpQueueTail.then(run, run);
  _dkhpQueueTail = p.catch(() => {});
  return p;
}

/** Wrapper fetch có timeout tự ngắt tránh treo Promise queue */
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

function dkhpNoteResult(ok, blocked = false, serverBusy = false) {
  if (blocked) _dkhpBlocked = true;
  if (ok) {
    _dkhpFailStreak = 0;
  } else if (!serverBusy) {
    _dkhpFailStreak++;
  }
}

/** Sniper phai dung lai neu bi WAF chan hoac loi lien tiep. */
function dkhpShouldAbortSniper() {
  return _dkhpBlocked || _dkhpFailStreak >= DKHP_MAX_FAIL_STREAK;
}

function dkhpResetGuards() {
  _dkhpBlocked = false;
  _dkhpFailStreak = 0;
}

/** Khoa sniper dung chung giua tab Dashboard va trang DKHP (chi 1 sniper chay). */
async function acquireSniperLock(owner, intervalSec) {
  const staleMs = Math.max(intervalSec * 3, 30) * 1000;
  const cur = (await chrome.storage.local.get(DKHP_SNIPER_LOCK_KEY))[DKHP_SNIPER_LOCK_KEY];
  if (cur && cur.owner !== owner && Date.now() - cur.ts < staleMs) return false;
  await chrome.storage.local.set({
    [DKHP_SNIPER_LOCK_KEY]: { owner, instanceId: _autoRegInstanceId, ts: Date.now() },
  });
  return true;
}

function heartbeatSniperLock(owner) {
  chrome.storage.local.set({
    [DKHP_SNIPER_LOCK_KEY]: { owner, instanceId: _autoRegInstanceId, ts: Date.now() },
  });
}

function releaseSniperLock(owner) {
  chrome.storage.local.get(DKHP_SNIPER_LOCK_KEY, (r) => {
    const cur = r[DKHP_SNIPER_LOCK_KEY];
    if (cur?.owner === owner && (!cur.instanceId || cur.instanceId === _autoRegInstanceId)) {
      chrome.storage.local.remove(DKHP_SNIPER_LOCK_KEY);
    }
  });
}

// Tự động giải phóng lock khi người dùng đóng hoặc reload tab Dashboard
window.addEventListener("pagehide", () => releaseSniperLock(DKHP_SNIPER_OWNER_DASHBOARD));
window.addEventListener("beforeunload", () => releaseSniperLock(DKHP_SNIPER_OWNER_DASHBOARD));

/**
 * Phân loại chính xác phản hồi đăng ký từ DKHP:
 * - Chống Fake OK ("Trùng lịch học với lớp đã đăng ký", "Đủ số lượng sinh viên đã đăng ký")
 * - Chống tắt Sniper sớm lúc 19:59:58 ("Sinh viên không đủ điều kiện đăng ký trong thời gian này")
 * - Phân biệt lỗi quy chế vĩnh viễn vs Lỗi tạm thời (chờ slot / chờ mở cổng)
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
  if (regRes.check === true) {
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
    regRes.message || regRes.Message || (typeof regRes === "string" ? regRes : "") || "Máy chủ từ chối đăng ký"
  ).trim();
  const lower = rawMsg.toLowerCase();

  // 1. Cổng đăng ký chưa mở / ngoài thời gian (BẮT BUỘC kiểm tra TRƯỚC "không đủ điều kiện")
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

  // 7. Mặc định: lỗi không xác định
  return { ok: false, retryable: true, state: "err", isGateWait: false, isConflict: false, isCoReq: false, msg: rawMsg };
}

// =============================================================================
// FETCH LAYER
// =============================================================================

/**
 * Fetch Chuong trinh khung tu dkhp.iuh.edu.vn.
 * Returns JSON object if ok, null if not authenticated, throws on network error.
 */
async function fetchChuongTrinhKhung() {
  let res, text;
  try {
    ({ res, text } = await dkhpEnqueue(() =>
      fetchWithTimeout(
        `${DKHP_BASE}/ChuongTrinhKhung/GetChuongTrinhKhung`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: "",
        },
        15000
      )
    ));
  } catch (err) {
    console.error("[DKHP] Lỗi mạng khi fetchChuongTrinhKhung:", err);
    return null;
  }

  if (!res || !res.ok) {
    console.warn("[DKHP] HTTP error:", res?.status, res?.statusText);
    return null;
  }

  // Response text đã được đọc trong fetchWithTimeout
  if (!text) return null;

  // Neu response chua HTML tag (trang login) => chua dang nhap
  if (text.includes("<!DOCTYPE") || text.includes("<html") || text.includes("frmLogin")) {
    console.warn("[DKHP] Server tra ve HTML (trang login), chua dang nhap.");
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("[DKHP] Khong parse duoc JSON:", e, "Response:", text.substring(0, 200));
    return null;
  }
}

// =============================================================================
// RENDER LAYER
// =============================================================================

/**
 * Chuyển đổi chuỗi tiếng Việt có dấu sang không dấu để tìm kiếm thuận tiện hơn.
 */
function removeVietnameseTones(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function matchHp(hp, queryNorm) {
  if (!queryNorm) return true;
  const tenNorm = removeVietnameseTones(hp.TenMonHoc || "");
  const maMH = (hp.MaMonHoc || "").toLowerCase();
  const maHP = (hp.MaHocPhan || "").toLowerCase();
  return (
    tenNorm.includes(queryNorm) ||
    maMH.includes(queryNorm) ||
    maHP.includes(queryNorm)
  );
}

// Map luu thong tin mon hoc va quan he phu thuoc nguoc (mon nay la dieu kien cua mon nao)
let _ctkCourseMap = {};
let _ctkReverseDepMap = {};

/**
 * Tach danh sach ma mon hoc / ma hoc phan tu chuoi HocPhanTruoc / TienQuyet / SongHanh.
 */
function extractCourseCodes(raw) {
  if (!raw) return [];
  const matches = String(raw).match(/\d{4,}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Xay dung index tra cuu nhanh mon hoc theo MaMonHoc / MaHocPhan va bang phu thuoc nguoc.
 */
function buildCtkIndex(data) {
  _ctkCourseMap = {};
  _ctkReverseDepMap = {};
  if (!data || !Array.isArray(data.ChuongTrinhHocKy)) return;

  const allCourses = [];
  data.ChuongTrinhHocKy.forEach((hocKy) => {
    const soHK = hocKy.HocKy || "?";
    (hocKy.HocPhanBatBuoc || []).forEach((hp) => {
      const enriched = { ...hp, _hocKy: soHK, _isBatBuoc: true };
      allCourses.push(enriched);
      if (hp.MaMonHoc) _ctkCourseMap[String(hp.MaMonHoc).trim()] = enriched;
      if (hp.MaHocPhan) _ctkCourseMap[String(hp.MaHocPhan).trim()] = enriched;
    });
    (hocKy.HocPhanTuChon || []).forEach((hp) => {
      const enriched = { ...hp, _hocKy: soHK, _isBatBuoc: false };
      allCourses.push(enriched);
      if (hp.MaMonHoc) _ctkCourseMap[String(hp.MaMonHoc).trim()] = enriched;
      if (hp.MaHocPhan) _ctkCourseMap[String(hp.MaHocPhan).trim()] = enriched;
    });
  });

  function registerDep(reqCode, targetCourse, type) {
    const key = String(reqCode).trim();
    if (!key) return;
    if (!_ctkReverseDepMap[key]) _ctkReverseDepMap[key] = [];
    const targetCode = String(targetCourse.MaMonHoc || targetCourse.MaHocPhan || "").trim();
    const exists = _ctkReverseDepMap[key].some(
      (item) => item.code === targetCode && item.type === type
    );
    if (!exists) {
      _ctkReverseDepMap[key].push({
        code: targetCode,
        maHP: targetCourse.MaHocPhan || "",
        tenMH: targetCourse.TenMonHoc || "",
        hocKy: targetCourse._hocKy,
        type,
      });
    }
  }

  allCourses.forEach((hp) => {
    extractCourseCodes(hp.HocPhanTruoc).forEach((c) => registerDep(c, hp, "a"));
    extractCourseCodes(hp.HocPhanTienQuyet).forEach((c) => registerDep(c, hp, "b"));
    extractCourseCodes(hp.HocPhanSongHanh).forEach((c) => registerDep(c, hp, "c"));
  });
}

function getReverseDepsForCourse(hp) {
  const result = [];
  const seen = new Set();
  const keys = [hp.MaMonHoc, hp.MaHocPhan].filter(Boolean).map((k) => String(k).trim());
  keys.forEach((k) => {
    (_ctkReverseDepMap[k] || []).forEach((dep) => {
      const id = `${dep.code}_${dep.type}`;
      if (!seen.has(id)) {
        seen.add(id);
        result.push(dep);
      }
    });
  });
  return result;
}

const CTK_TYPE_META = {
  a: { color: "#f6ad55", label: "Học trước (a)" },
  b: { color: "#fc8181", label: "Tiên quyết (b)" },
  c: { color: "#68d391", label: "Song hành (c)" },
};

function renderCourseCodeBadge(code, type, interactive = true) {
  const meta = CTK_TYPE_META[type] || { color: "#a0aec0", label: type };
  const safeCode = escapeHtml(String(code).trim());
  if (!interactive) {
    return `<span class="ctk-code-badge ctk-code-badge-static">${safeCode} <span style="color:${meta.color};font-size:11px;font-weight:700">(${type})</span></span>`;
  }
  return `<span class="ctk-code-badge" data-ctk-code="${safeCode}" data-ctk-rel="${escapeHtml(meta.label)}">${safeCode} <span style="color:${meta.color};font-size:11px;font-weight:700">(${type})</span></span>`;
}

function renderPrerequisitesHtml(hp, interactive = true) {
  const parts = [];
  const addGroup = (raw, type) => {
    if (!raw) return;
    const codes = extractCourseCodes(raw);
    if (codes.length > 0) {
      codes.forEach((c) => parts.push(renderCourseCodeBadge(c, type, interactive)));
    } else {
      parts.push(renderCourseCodeBadge(raw, type, interactive));
    }
  };
  addGroup(hp.HocPhanTruoc, "a");
  addGroup(hp.HocPhanTienQuyet, "b");
  addGroup(hp.HocPhanSongHanh, "c");
  return parts.join(" ");
}

function renderReverseDepsHtml(hp, interactive = true) {
  const deps = getReverseDepsForCourse(hp);
  if (deps.length === 0) return "";
  return deps.map((d) => renderCourseCodeBadge(d.code, d.type, interactive)).join(" ");
}

function getTrangThaiBadgeHtml(hp) {
  const isDat = hp.IsDat;
  const isDangDK = hp.IDDangKyHocPhan > 0 && !isDat;
  if (isDat) {
    return `<span style="background:rgba(104,211,145,0.2);color:#68d391;padding:2px 7px;border-radius:99px;font-size:11px;white-space:nowrap;">✅ Đã đạt</span>`;
  }
  if (isDangDK) {
    return `<span style="background:rgba(99,179,237,0.2);color:#63b3ed;padding:2px 7px;border-radius:99px;font-size:11px;white-space:nowrap;">Đang học</span>`;
  }
  return `<span style="background:rgba(160,174,192,0.15);color:#718096;padding:2px 7px;border-radius:99px;font-size:11px;white-space:nowrap;">Chưa học</span>`;
}

/**
 * Ve bang Chuong trinh khung vao #ctk-table-body.
 * Ho tro tim kiem theo ten mon hoc, ma mon hoc, ma hoc phan.
 */
function renderChuongTrinhKhung(data, searchQuery) {
  const tbody = document.getElementById("ctk-table-body");
  const summaryRequired = document.getElementById("ctk-summary-required");
  const summaryDone = document.getElementById("ctk-summary-done");
  const searchCountEl = document.getElementById("ctk-search-count");
  if (!tbody || !data) return;

  buildCtkIndex(data);
  ensureCtkTooltipInitialized();

  if (typeof searchQuery !== "string") {
    searchQuery = document.getElementById("ctk-search-input")?.value || "";
  }

  tbody.innerHTML = "";

  // Tinh tong so mon va so mon da dat tren toan bo chuong trinh khung
  let fullTotal = 0;
  let fullDone = 0;
  (data.ChuongTrinhHocKy || []).forEach((hocKy) => {
    (hocKy.HocPhanBatBuoc || []).forEach((hp) => {
      fullTotal++;
      if (hp.IsDat) fullDone++;
    });
    (hocKy.HocPhanTuChon || []).forEach((hp) => {
      fullTotal++;
      if (hp.IsDat) fullDone++;
    });
  });

  if (summaryRequired)
    summaryRequired.textContent = `Tổng yêu cầu: ${data.TongSoTCYeuCau || 0} TC`;
  if (summaryDone)
    summaryDone.textContent = `Đã đạt: ${fullDone}/${fullTotal} môn`;

  const queryNorm = removeVietnameseTones(searchQuery.trim());
  const isSearching = queryNorm.length > 0;
  let matchCount = 0;

  (data.ChuongTrinhHocKy || []).forEach((hocKy) => {
    const soHK = hocKy.HocKy || "?";
    const soTcHK = hocKy.SoTinChiHocKy || 0;

    const bbList = (hocKy.HocPhanBatBuoc || []).filter((hp) =>
      matchHp(hp, queryNorm)
    );
    const tcList = (hocKy.HocPhanTuChon || []).filter((hp) =>
      matchHp(hp, queryNorm)
    );

    // Neu dang tim kiem va khong co mon nao khop trong hoc ky nay thi an ca hoc ky
    if (isSearching && bbList.length === 0 && tcList.length === 0) {
      return;
    }

    const hkRow = document.createElement("tr");
    hkRow.innerHTML = `
      <td colspan="8" style="
        background: var(--primary, #4a90e2);
        color: white;
        font-weight: 700;
        padding: 10px 16px;
        font-size: 13px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      ">
        Học kỳ ${soHK} &mdash; Tổng: ${soTcHK} TC
      </td>`;
    tbody.appendChild(hkRow);

    if (bbList.length > 0) {
      const groupRow = document.createElement("tr");
      groupRow.innerHTML = `<td colspan="8" style="background:rgba(255,255,255,0.05);padding:6px 16px;font-size:12px;color:var(--text-muted,#aaa);font-style:italic;font-weight:bold;">Học phần bắt buộc</td>`;
      tbody.appendChild(groupRow);
      bbList.forEach((hp, i) => {
        tbody.appendChild(buildHpRow(hp, i, true));
        matchCount++;
      });
    }

    if (tcList.length > 0) {
      const groupRow = document.createElement("tr");
      groupRow.innerHTML = `<td colspan="8" style="background:rgba(255,255,255,0.05);padding:6px 16px;font-size:12px;color:var(--text-muted,#aaa);font-style:italic;font-weight:bold;">Học phần tự chọn</td>`;
      tbody.appendChild(groupRow);
      tcList.forEach((hp, i) => {
        tbody.appendChild(buildHpRow(hp, i, false));
        matchCount++;
      });
    }
  });

  if (searchCountEl) {
    if (isSearching) {
      searchCountEl.style.display = "inline";
      searchCountEl.textContent = `(Khớp: ${matchCount} môn)`;
    } else {
      searchCountEl.style.display = "none";
    }
  }

  if (isSearching && matchCount === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = `
      <td colspan="8" style="text-align: center; padding: 48px 20px; color: var(--text-muted);">
        <p style="font-size: 32px; margin-bottom: 8px;">🔍</p>
        <p style="font-size: 15px; font-weight: 500; color: var(--text-main); margin-bottom: 4px;">Không tìm thấy môn học nào</p>
        <p style="font-size: 13px; color: var(--text-muted);">Không có môn học nào phù hợp với từ khóa "<b>${escapeHtml(searchQuery.trim())}</b>"</p>
      </td>`;
    tbody.appendChild(emptyRow);
  }
}

function buildHpRow(hp, index, isBatBuoc) {
  const tr = document.createElement("tr");
  const isDat = hp.IsDat;
  const isDangDK = hp.IDDangKyHocPhan > 0 && !isDat;

  if (isDat) {
    tr.style.opacity = "0.6";
  } else if (isDangDK) {
    tr.style.background = "rgba(99, 179, 237, 0.08)";
  }

  const prerequisites = renderPrerequisitesHtml(hp);
  const reverseDeps = renderReverseDepsHtml(hp);
  const trangThaiBadge = getTrangThaiBadgeHtml(hp);

  const tenMH = hp.KhongTinhDiemTBC
    ? `${hp.TenMonHoc} <span style="color:#fc8181;font-weight:700">*</span>`
    : (hp.TenMonHoc || "");

  const maMH = escapeHtml(hp.MaMonHoc || "");
  const maHP = escapeHtml(hp.MaHocPhan || "");
  const rawCode = String(hp.MaMonHoc || hp.MaHocPhan || "").trim();

  let planBtnHtml = "";
  if (!isDat && !isDangDK && rawCode) {
    const isPlanned = typeof isCoursePlannedInActiveDot === "function" && isCoursePlannedInActiveDot(rawCode);
    planBtnHtml = `
      <div style="margin-top:4px;">
        <button
          type="button"
          class="ctk-plan-toggle-btn"
          data-plan-code="${escapeHtml(rawCode)}"
          style="
            background: ${isPlanned ? "rgba(16,185,129,0.2)" : "rgba(59,130,246,0.14)"};
            color: ${isPlanned ? "#34d399" : "#60a5fa"};
            border: 1px solid ${isPlanned ? "rgba(16,185,129,0.45)" : "rgba(59,130,246,0.35)"};
            border-radius: 6px;
            padding: 2px 7px;
            font-size: 10.5px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
          "
          title="${isPlanned ? "Bấm để bỏ khỏi Clipboard Lịch học dự kiến" : "Clip môn này vào Clipboard bên Lịch học dự kiến"}"
        >${isPlanned ? "📋 Đã Clip" : "➕ Clip"}</button>
      </div>`;
  }

  tr.innerHTML = `
    <td class="text-center" style="color:var(--text-muted);font-size:12px;">${index + 1}</td>
    <td style="font-family:monospace;font-size:12px;">${maMH}</td>
    <td style="text-align:left;padding-left:12px;">${tenMH}</td>
    <td style="font-family:monospace;font-size:11px;color:var(--text-muted);">${maHP}</td>
    <td class="text-center" style="font-weight:600;">${hp.DVHT ?? ""}</td>
    <td style="font-size:12px;color:var(--text-muted);">${prerequisites}</td>
    <td style="font-size:12px;color:var(--text-muted);">${reverseDeps}</td>
    <td class="text-center">${trangThaiBadge}${planBtnHtml}</td>`;

  const planBtn = tr.querySelector(".ctk-plan-toggle-btn");
  if (planBtn) {
    planBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof toggleCourseInActivePlanFromCtk === "function") {
        toggleCourseInActivePlanFromCtk(rawCode);
      }
    });
  }

  return tr;
}

// =============================================================================
// HOVER (0.5s) POPUP TOOLTIP CHO MA MON DIEU KIEN / MO KHOA
// =============================================================================

let _ctkTooltipInitialized = false;
let _ctkHoverTimer = null;
let _ctkHideTimer = null;
let _ctkActiveHoverEl = null;

function ensureCtkTooltipInitialized() {
  if (_ctkTooltipInitialized) return;
  _ctkTooltipInitialized = true;

  if (!document.getElementById("ctk-hover-tooltip-style")) {
    const style = document.createElement("style");
    style.id = "ctk-hover-tooltip-style";
    style.textContent = `
      .ctk-code-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 6px;
        margin: 2px 3px 2px 0;
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px dashed rgba(160, 174, 192, 0.4);
        font-family: monospace;
        font-size: 11.5px;
        color: var(--text-main);
        cursor: help;
        transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
      }
      .ctk-code-badge:not(.ctk-code-badge-static):hover {
        background: rgba(99, 179, 237, 0.16);
        border-color: var(--primary, #4a90e2);
      }
      .ctk-code-badge-static {
        cursor: default;
        border-style: solid;
        border-color: rgba(160, 174, 192, 0.25);
      }
      @keyframes ctkHoverWaitPulse {
        0% { box-shadow: 0 0 0 0 rgba(74, 144, 226, 0.55); }
        100% { box-shadow: 0 0 0 5px rgba(74, 144, 226, 0.25); }
      }
      .ctk-code-pending {
        animation: ctkHoverWaitPulse 0.5s linear forwards;
        border-color: var(--primary, #4a90e2) !important;
      }
      #ctk-hover-tooltip {
        position: fixed;
        z-index: 10050;
        display: none;
        background: var(--bg-card, #1e2533);
        border: 1px solid var(--primary, #4a90e2);
        border-radius: 10px;
        box-shadow: 0 14px 38px rgba(0, 0, 0, 0.65);
        padding: 12px 14px;
        max-width: 860px;
        min-width: 520px;
        color: var(--text-main);
        pointer-events: auto;
      }
      #ctk-hover-tooltip .ctk-tt-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.1));
        font-size: 12px;
        color: var(--text-muted);
      }
      #ctk-hover-tooltip .ctk-tt-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      #ctk-hover-tooltip .ctk-tt-table th {
        background: rgba(255, 255, 255, 0.06);
        color: var(--text-muted);
        font-weight: 600;
        padding: 6px 8px;
        border: 1px solid var(--border-color, rgba(255,255,255,0.12));
        text-align: center;
        white-space: nowrap;
      }
      #ctk-hover-tooltip .ctk-tt-table td {
        padding: 8px 10px;
        border: 1px solid var(--border-color, rgba(255,255,255,0.12));
        text-align: center;
        vertical-align: middle;
      }
    `;
    document.head.appendChild(style);
  }

  let tooltip = document.getElementById("ctk-hover-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "ctk-hover-tooltip";
    document.body.appendChild(tooltip);
  }

  tooltip.addEventListener("mouseenter", () => {
    if (_ctkHideTimer) {
      clearTimeout(_ctkHideTimer);
      _ctkHideTimer = null;
    }
  });

  tooltip.addEventListener("mouseleave", () => {
    hideCtkCourseTooltip();
  });

  document.addEventListener("mouseover", (e) => {
    // Bo qua moi su kien hover ben trong popup tooltip de khong lam tat/ghi de tooltip dang hien
    if (e.target.closest("#ctk-hover-tooltip")) {
      if (_ctkHideTimer) {
        clearTimeout(_ctkHideTimer);
        _ctkHideTimer = null;
      }
      return;
    }

    const target = e.target.closest("[data-ctk-code]");
    if (!target) return;
    if (target === _ctkActiveHoverEl) return;

    if (_ctkHoverTimer) {
      clearTimeout(_ctkHoverTimer);
      _ctkHoverTimer = null;
    }
    if (_ctkHideTimer) {
      clearTimeout(_ctkHideTimer);
      _ctkHideTimer = null;
    }
    if (_ctkActiveHoverEl) {
      _ctkActiveHoverEl.classList.remove("ctk-code-pending");
    }

    _ctkActiveHoverEl = target;
    target.classList.add("ctk-code-pending");

    // Hover 0.5s (500ms) moi hien popup
    _ctkHoverTimer = setTimeout(() => {
      target.classList.remove("ctk-code-pending");
      showCtkCourseTooltip(target);
    }, 500);
  });

  document.addEventListener("mouseout", (e) => {
    if (e.target.closest("#ctk-hover-tooltip")) return;

    const target = e.target.closest("[data-ctk-code]");
    if (!target || target !== _ctkActiveHoverEl) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;

    if (_ctkHoverTimer) {
      clearTimeout(_ctkHoverTimer);
      _ctkHoverTimer = null;
    }
    target.classList.remove("ctk-code-pending");
    _ctkActiveHoverEl = null;

    // Neu di chuot sang thang popup tooltip thi khong bat timer an
    if (e.relatedTarget && e.relatedTarget.closest("#ctk-hover-tooltip")) {
      return;
    }

    _ctkHideTimer = setTimeout(() => {
      hideCtkCourseTooltip();
    }, 220);
  });

  window.addEventListener(
    "scroll",
    () => {
      if (_ctkHoverTimer) {
        clearTimeout(_ctkHoverTimer);
        _ctkHoverTimer = null;
      }
      if (_ctkActiveHoverEl) {
        _ctkActiveHoverEl.classList.remove("ctk-code-pending");
        _ctkActiveHoverEl = null;
      }
      hideCtkCourseTooltip();
    },
    true
  );
}

function hideCtkCourseTooltip() {
  const tooltip = document.getElementById("ctk-hover-tooltip");
  if (tooltip) {
    tooltip.style.display = "none";
  }
}

function showCtkCourseTooltip(anchorEl) {
  const code = anchorEl.getAttribute("data-ctk-code");
  const relLabel = anchorEl.getAttribute("data-ctk-rel") || "";
  if (!code) return;

  const tooltip = document.getElementById("ctk-hover-tooltip");
  if (!tooltip) return;

  const hp = _ctkCourseMap[code];
  if (!hp) {
    tooltip.innerHTML = `
      <div class="ctk-tt-header">
        <span>🔍 Mã học phần / môn học: <b>${escapeHtml(code)}</b></span>
      </div>
      <div style="padding: 8px 4px; font-size: 12.5px; color: var(--text-muted);">
        Không tìm thấy thông tin chi tiết của mã <b>${escapeHtml(code)}</b> trong Chương trình khung.
      </div>
    `;
  } else {
    const loaiText = hp._isBatBuoc ? "Học phần bắt buộc" : "Học phần tự chọn";
    const tenMH = hp.KhongTinhDiemTBC
      ? `${escapeHtml(hp.TenMonHoc || "")} <span style="color:#fc8181;font-weight:700">*</span>`
      : escapeHtml(hp.TenMonHoc || "");

    const prereqHtml = renderPrerequisitesHtml(hp, false) || `<span style="color:var(--text-muted)">—</span>`;
    const reverseHtml = renderReverseDepsHtml(hp, false) || `<span style="color:var(--text-muted)">—</span>`;
    const statusHtml = getTrangThaiBadgeHtml(hp);

    // Hien thi kem ten cac mon dieu kien de sinh vien doc nhanh khong can tra cuu nhieu tang
    const prereqNames = [];
    const collectNames = (raw, type) => {
      extractCourseCodes(raw).forEach((c) => {
        const refCourse = _ctkCourseMap[c];
        if (refCourse) {
          const meta = CTK_TYPE_META[type];
          prereqNames.push(
            `<span style="display:inline-block;margin-right:10px;">• <b>${escapeHtml(c)}</b>: ${escapeHtml(refCourse.TenMonHoc || "")} <span style="color:${meta.color}">(${type})</span></span>`
          );
        }
      });
    };
    collectNames(hp.HocPhanTruoc, "a");
    collectNames(hp.HocPhanTienQuyet, "b");
    collectNames(hp.HocPhanSongHanh, "c");

    const reverseDeps = getReverseDepsForCourse(hp);
    const reverseNames = reverseDeps.map((d) => {
      const meta = CTK_TYPE_META[d.type] || { color: "#a0aec0" };
      return `<span style="display:inline-block;margin-right:10px;">• <b>${escapeHtml(d.code)}</b>: ${escapeHtml(d.tenMH)} (HK ${escapeHtml(String(d.hocKy))}) <span style="color:${meta.color}">(${d.type})</span></span>`;
    });

    tooltip.innerHTML = `
      <div class="ctk-tt-header">
        <span>📌 Thông tin học phần ${relLabel ? `&mdash; <b style="color:var(--primary)">${escapeHtml(relLabel)}</b>` : ""}</span>
        <span style="font-style:italic;">${loaiText}</span>
      </div>
      <table class="ctk-tt-table">
        <thead>
          <tr>
            <th>HK</th>
            <th>Mã MH</th>
            <th style="text-align:left;">Tên môn học</th>
            <th>Mã HP</th>
            <th>TC</th>
            <th>Tiên quyết <span style="color:#fc8181">(b)</span> / Trước <span style="color:#f6ad55">(a)</span> / Song hành <span style="color:#68d391">(c)</span></th>
            <th>Là ĐK của môn</th>
            <th>Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="font-weight:700;color:var(--primary);">HK ${escapeHtml(String(hp._hocKy ?? "?"))}</td>
            <td style="font-family:monospace;font-weight:600;">${escapeHtml(hp.MaMonHoc || "")}</td>
            <td style="text-align:left;font-weight:600;min-width:160px;">${tenMH}</td>
            <td style="font-family:monospace;color:var(--text-muted);">${escapeHtml(hp.MaHocPhan || "")}</td>
            <td style="font-weight:700;">${escapeHtml(String(hp.DVHT ?? ""))}</td>
            <td>${prereqHtml}</td>
            <td>${reverseHtml}</td>
            <td>${statusHtml}</td>
          </tr>
        </tbody>
      </table>
      ${
        prereqNames.length > 0
          ? `<div style="margin-top:8px;font-size:11.5px;color:var(--text-muted);line-height:1.5;">
              <b style="color:var(--text-main);">🔗 Môn điều kiện cần học:</b> ${prereqNames.join(" ")}
            </div>`
          : ""
      }
      ${
        reverseNames.length > 0
          ? `<div style="margin-top:4px;font-size:11.5px;color:var(--text-muted);line-height:1.5;">
              <b style="color:var(--text-main);">🔓 Mở khóa cho môn:</b> ${reverseNames.join(" ")}
            </div>`
          : ""
      }
    `;
  }

  tooltip.style.display = "block";
  const rect = anchorEl.getBoundingClientRect();
  const ttRect = tooltip.getBoundingClientRect();

  let top = rect.top - ttRect.height - 10;
  if (top < 12) {
    top = rect.bottom + 10;
  }
  if (top + ttRect.height > window.innerHeight - 12) {
    top = Math.max(12, window.innerHeight - ttRect.height - 12);
  }

  let left = rect.left + rect.width / 2 - ttRect.width / 2;
  if (left < 12) left = 12;
  if (left + ttRect.width > window.innerWidth - 12) {
    left = Math.max(12, window.innerWidth - ttRect.width - 12);
  }

  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.left = `${Math.round(left)}px`;
}

// =============================================================================
// TAB CONTROLLER
// =============================================================================

let _ctkCache = null;
let _ctkSearchBound = false;

function initCtkSearch() {
  if (_ctkSearchBound) return;
  const input = document.getElementById("ctk-search-input");
  const clearBtn = document.getElementById("ctk-search-clear");
  if (!input) return;
  _ctkSearchBound = true;

  input.addEventListener("input", () => {
    const q = input.value;
    if (clearBtn) clearBtn.style.display = q ? "block" : "none";
    if (_ctkCache) {
      renderChuongTrinhKhung(_ctkCache, q);
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      input.value = "";
      clearBtn.style.display = "none";
      input.focus();
      if (_ctkCache) {
        renderChuongTrinhKhung(_ctkCache, "");
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCtkSearch);
} else {
  initCtkSearch();
}

async function loadCtkTab(forceRefresh = false) {
  initCtkSearch();
  const loadingEl = document.getElementById("ctk-loading");
  const authGateEl = document.getElementById("ctk-auth-gate");
  const tableSectionEl = document.getElementById("ctk-table-section");

  function showOnly(el) {
    [loadingEl, authGateEl, tableSectionEl].forEach((e) => {
      if (e) e.style.display = "none";
    });
    if (el) el.style.display = "block";
  }

  if (!forceRefresh) {
    if (_ctkCache) {
      showOnly(tableSectionEl);
      renderChuongTrinhKhung(_ctkCache);
      return;
    }

    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(["iuh_ctk_data"], resolve)
    );
    if (stored.iuh_ctk_data) {
      _ctkCache = stored.iuh_ctk_data;
      showOnly(tableSectionEl);
      renderChuongTrinhKhung(_ctkCache);
      return;
    }
  }

  showOnly(loadingEl);

  try {
    const data = await fetchChuongTrinhKhung();

    if (data === null) {
      if (_ctkCache) {
        alert("Lỗi xác thực: Vui lòng đăng nhập trang DKHP để tải dữ liệu mới nhất.");
        showOnly(tableSectionEl);
      } else {
        showOnly(authGateEl);
      }
      return;
    }

    _ctkCache = data;
    chrome.storage.local.set({ iuh_ctk_data: data });

    showOnly(tableSectionEl);
    renderChuongTrinhKhung(data);
  } catch (err) {
    console.error("[DKHP] Lỗi fetch Chương trình khung:", err);
    if (_ctkCache) {
      alert("Lỗi mạng: Không thể lấy dữ liệu mới.");
      showOnly(tableSectionEl);
    } else {
      showOnly(authGateEl);
    }
  }
}

// =============================================================================
// LHP — FETCH LAYER
// =============================================================================

async function _dkhpPost(path, body = "", timeoutMs = 15000) {
  const url = `${DKHP_BASE}${path}`;
  console.log("[DKHP] POST →", url, "| body:", body || "(empty)");

  let res;
  let text;
  try {
    // Xếp hàng: mỗi request chạy tuần tự, có timeout tự ngắt tránh treo ASP.NET Session
    ({ res, text } = await dkhpEnqueue(async () => {
      return fetchWithTimeout(
        url,
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
  } catch (networkErr) {
    console.error("[DKHP] Lỗi mạng hoặc quá thời gian chờ (timeout):", networkErr);
    dkhpNoteResult(false);
    return null;
  }

  if (!res) {
    dkhpNoteResult(false);
    return null;
  }

  console.log("[DKHP] HTTP", res.status, res.statusText, "| content-type:", res.headers.get("content-type"));
  console.log("[DKHP] Response body (400 ký tự đầu):", text.substring(0, 400));

  if (res.status === 403 || text.includes("Web Application Firewall")) {
    console.warn("[DKHP] Bị WAF chặn (403) — dừng mọi tác vụ tự động để bảo vệ phiên.");
    dkhpNoteResult(false, true);
    return null;
  }

  // Máy chủ quá tải giờ cao điểm (500, 502, 503) -> Giữ trạng thái retryable, không ngắt phiên
  if (res.status >= 500 && res.status < 600) {
    console.warn(`[DKHP] Máy chủ quá tải (HTTP ${res.status}). Giữ phiên và tiếp tục chu kỳ sau...`);
    dkhpNoteResult(false, false, true);
    return { serverBusy: true, message: `Máy chủ quá tải (HTTP ${res.status})` };
  }

  if (!res.ok) {
    console.warn("[DKHP] HTTP error:", res.status, "— body logged above");
    dkhpNoteResult(false);
    return null;
  }

  if (text.includes("<!DOCTYPE") || text.includes("<html") || text.includes("frmLogin")) {
    console.warn("[DKHP] Server trả HTML (trang login) — chưa đăng nhập hoặc session hết hạn.");
    dkhpNoteResult(false);
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    dkhpNoteResult(true);
    return parsed;
  } catch (e) {
    console.error("[DKHP] Không parse được JSON:", e);
    dkhpNoteResult(false);
    return null;
  }
}

/**
 * Danh sách các đợt đăng ký (idDot) theo chuẩn PMT-EMS của IUH.
 * Không gọi GET /DangKyHocPhan để tránh làm ASP.NET reset/invalidate session.
 * Công thức idDot: 58 = HK1 (2024 - 2025), mỗi năm học gồm 3 học kỳ (HK1, HK2, HK3).
 */
function getDanhSachDotDangKy() {
  return [
    { value: "66", text: "HK3 (2026 - 2027)" },
    { value: "65", text: "HK2 (2026 - 2027)" },
    { value: "64", text: "HK1 (2026 - 2027)" },
    { value: "63", text: "HK3 (2025 - 2026)" },
    { value: "62", text: "HK2 (2025 - 2026)" },
    { value: "61", text: "HK1 (2025 - 2026)" },
    { value: "60", text: "HK3 (2024 - 2025)" },
    { value: "59", text: "HK2 (2024 - 2025)" },
    { value: "58", text: "HK1 (2024 - 2025)" },
  ];
}

/** Lấy danh sách lớp học phần đã ĐK trong học kỳ chỉ định (idDot) */
async function fetchLopHocPhanDaDangKy(idDot) {
  const body = idDot ? `idDot=${encodeURIComponent(idDot)}` : "";
  return _dkhpPost("/DangKyHocPhan/GetDanhSachLopHocPhanDaDangKy", body);
}

/** Lấy chi tiết lịch học của 1 lớp. */
async function fetchChiTietLopHocPhan(idLHPEncrypted, maNhomTH) {
  const body = `idLopHocPhan=${encodeURIComponent(idLHPEncrypted)}&maNhomTH=${encodeURIComponent(maNhomTH)}`;
  return _dkhpPost("/DangKyHocPhan/GetChiTietLopHocPhan", body);
}

/**
 * Lấy danh sách môn học phần đang mở đăng ký từ DKHP.
 * TẠM VÔ HIỆU: endpoint này chưa được xác minh trên DKHP thật (tên endpoint đoán).
 * Bật lại (đặt true) sau khi xác nhận bằng DevTools > Network.
 */
const DKHP_OPEN_COURSES_ENDPOINT_VERIFIED = false;
async function fetchDanhSachMonHocPhanDangKy(idDot, hinhThuc = 1) {
  if (!DKHP_OPEN_COURSES_ENDPOINT_VERIFIED) return [];
  const stored = await chrome.storage.local.get("iuh_dkhp_idsv");
  const idSv = stored?.iuh_dkhp_idsv ? String(stored.iuh_dkhp_idsv).trim() : "";
  if (!idSv) return [];
  const body = `Id=${encodeURIComponent(idSv)}&dotDangKy=${encodeURIComponent(Number(idDot))}&hinhThuc=${encodeURIComponent(hinhThuc)}&khoaHocDangKy=0`;
  return _dkhpPost("/DangKyHocPhan/GetDanhSachMonHocPhanDangKy", body);
}

/**
 * Chuẩn hóa cặp mã maMonHoc (6 chữ số, VD: "003281") và maHocPhan (10 chữ số, VD: "4203003281")
 * để gửi đúng định dạng mà /DangKyHocPhan/GetDanhSachLopHocPhan yêu cầu.
 */
function resolveDkhpCourseCodes(maMonHoc, maHocPhan = "", maLHP = "") {
  let rawMH = String(maMonHoc || "").trim();
  let rawHP = String(maHocPhan || "").trim();
  let rawLHP = String(maLHP || "").trim();

  const hp =
    _ctkCourseMap[rawMH] ||
    _ctkCourseMap[rawHP] ||
    (rawLHP.length >= 10 ? _ctkCourseMap[rawLHP.substring(0, 10)] : null) ||
    (rawMH.length >= 10 ? _ctkCourseMap[rawMH.substring(0, 10)] : null) ||
    (rawHP.length >= 10 ? _ctkCourseMap[rawHP.substring(0, 10)] : null);

  if (hp) {
    if (hp.MaMonHoc) rawMH = String(hp.MaMonHoc).trim();
    if (hp.MaHocPhan) rawHP = String(hp.MaHocPhan).trim();
  } else {
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
  }

  return {
    maMonHoc: rawMH || rawHP,
    maHocPhan: rawHP || rawMH,
  };
}

/** Lấy danh sách lớp học phần đang mở của 1 môn học từ DKHP */
async function fetchDanhSachLopHocPhan(maMonHoc, idDot, maHocPhan = "", maLHP = "") {
  const codes = resolveDkhpCourseCodes(maMonHoc, maHocPhan, maLHP);
  const body = `maMonHoc=${encodeURIComponent(codes.maMonHoc)}&idDot=${encodeURIComponent(Number(idDot))}&dsHocPhanDuocHoc=${encodeURIComponent(codes.maHocPhan)}&khoaHocDangKy=0&isLHPKhongTrungLich=false`;
  return _dkhpPost("/DangKyHocPhan/GetDanhSachLopHocPhan", body);
}

/**
 * Kiểm tra đợt đăng ký có đang mở cho phép đăng ký hay không.
 * Server trả về chuỗi rỗng "" nếu cho phép, hoặc chuỗi thông báo lỗi nếu chưa mở / hạn chế.
 */
async function checkDotChoPhepDangKy(idDot) {
  try {
    const { res, text } = await dkhpEnqueue(async () => {
      return fetchWithTimeout(
        `${DKHP_BASE}/DangKyHocPhan/CheckDotChoPhepDangKy`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: `idDot=${encodeURIComponent(Number(idDot))}`,
        },
        12000
      );
    });
    if (!res) {
      dkhpNoteResult(false);
      return null;
    }
    if (res.status === 403 || text.includes("Web Application Firewall")) {
      dkhpNoteResult(false, true);
      return null;
    }
    if (res.status >= 500 && res.status < 600) {
      dkhpNoteResult(false, false, true);
      return { unauthenticated: false, allowed: false, message: `Máy chủ bận (HTTP ${res.status})` };
    }
    if (!res.ok) {
      dkhpNoteResult(false);
      return null;
    }
    if (text.includes("<!DOCTYPE") || text.includes("<html") || text.includes("frmLogin")) {
      dkhpNoteResult(false);
      return { unauthenticated: true, message: "Chưa đăng nhập dkhp.iuh.edu.vn" };
    }
    dkhpNoteResult(true);
    let clean = text.trim();
    try {
      const parsed = JSON.parse(clean);
      if (typeof parsed === "string") clean = parsed.trim();
    } catch (_) {}
    return { unauthenticated: false, allowed: clean.length === 0, message: clean };
  } catch (err) {
    console.warn("[DKHP] Lỗi CheckDotChoPhepDangKy:", err);
    dkhpNoteResult(false);
    return null;
  }
}

/**
 * Kiểm tra khác địa điểm / phòng học buổi học trước khi gửi lệnh đăng ký (giống dangkyHP() của trường).
 */
async function checkKhacDiaDiemPhongBuoiHoc(idEncrypted, nhomTH = "") {
  const thVal = nhomTH && Number(nhomTH) > 0 ? String(nhomTH) : "";
  const body = `idLopHocPhan=${encodeURIComponent(idEncrypted)}&nhomThucHanh=${encodeURIComponent(thVal)}`;
  return _dkhpPost("/DangKyHocPhan/CheckKhacDiaDiemPhongBuoiHoc", body, 15000);
}

/**
 * Gửi lệnh Đăng ký Lớp học phần trực tiếp lên /DangKyHocPhan/DangKyHocPhan.
 * Không yêu cầu CAPTCHA. Trả về { check: true/false, message: "..." }.
 */
async function dangKyLopHocPhanApi(idEncrypted, loaiDangKy = 1, idDot = 64, nhomTH = "") {
  const thVal = nhomTH && Number(nhomTH) > 0 ? String(nhomTH) : "";
  const body =
    `idLopHocPhan=${encodeURIComponent(idEncrypted)}` +
    `&loaiDangky=${encodeURIComponent(Number(loaiDangKy || 1))}` +
    `&idDot=${encodeURIComponent(Number(idDot))}` +
    `&nhomThucHanh=${encodeURIComponent(thVal)}`;
  return _dkhpPost("/DangKyHocPhan/DangKyHocPhan", body, 20000);
}

const LHP_COLORS = [
  "#3B82F6",
  "#EF4444",
  "#F59E0B",
  "#10B981",
  "#8B5CF6",
  "#06B6D4",
  "#F97316",
  "#EC4899",
  "#14B8A6",
  "#6366F1",
];

// =============================================================================
// PLANNER STATE & STORAGE
// =============================================================================

let _lhpDotsCache = null;
let _lhpDataByDotCache = {};
let _lhpPlannedByDot = {}; // { [idDot]: Array<PlannedCourseItem> }
let _lhpOpenCoursesByDot = {}; // { [`${idDot}_${hinhThuc}`]: Array<OpenCourse> }
let _lhpOpenClassesByCourse = {}; // { [`${idDot}_${maMH}`]: Array<OpenClass> }
let _lhpClassDetailCache = {}; // { [idEncrypted]: Array<RawSchedule> }
let _lhpCustomRatesByDot = {}; // { [idDot]: { rateLT, rateTH } }
let _lhpLtThSplitOverrides = {}; // { [courseCode]: { tcLT, tcTH } }

let _lhpActiveSourceTab = "pinned"; // Mặc định: 'pinned' (Clipboard các môn đã clip từ CTK) | 'suggest' | 'hybrid'
let _lhpExpandedCourseCode = null;
let _lhpGhostSchedules = [];
let _lhpSelectBound = false;
let _isFetchingLhp = false;

// Quản lý bộ đếm tự động refresh sĩ số lớp học phần (chu kỳ 2 phút = 120s)
let _lhpSiSoAutoRefreshEnabled = true;
let _lhpSiSoRefreshIntervalId = null;
let _lhpSiSoCountdownSec = 120;
let _lhpLastSiSoUpdatedAt = {}; // { [classCacheKey]: "HH:MM:SS" }

function getActiveLhpDot() {
  const selectEl = document.getElementById("lhp-semester-select");
  if (selectEl && selectEl.value) return String(selectEl.value);
  return "64";
}

function getAcademicYearStartFromDot(idDot) {
  const num = parseInt(idDot, 10);
  if (isNaN(num)) return 2026;
  // idDot 58,59,60 = 2024-2025 (2024); 61,62,63 = 2025-2026 (2025); 64,65,66 = 2026-2027 (2026)
  return 2024 + Math.floor((num - 58) / 3);
}

function getDotTextById(idDot) {
  const dots = _lhpDotsCache || getDanhSachDotDangKy();
  const found = dots.find((d) => String(d.value) === String(idDot));
  return found ? found.text : `Đợt ${idDot}`;
}

function saveLhpPlannerState() {
  chrome.storage.local.set({
    iuh_lhp_planned_by_dot: _lhpPlannedByDot,
    iuh_lhp_custom_rates_by_dot: _lhpCustomRatesByDot,
    iuh_lhp_lt_th_overrides: _lhpLtThSplitOverrides,
    iuh_lhp_open_courses_by_dot: _lhpOpenCoursesByDot,
    iuh_lhp_open_classes_by_course: _lhpOpenClassesByCourse,
    iuh_lhp_class_detail_cache: _lhpClassDetailCache,
  });
}

function isCoursePlannedInActiveDot(code) {
  if (!code) return false;
  const dot = getActiveLhpDot();
  const list = _lhpPlannedByDot[dot] || [];
  const norm = String(code).trim();
  return list.some(
    (item) =>
      String(item.maMonHoc || "").trim() === norm ||
      String(item.maHocPhan || "").trim() === norm
  );
}

function toggleCourseInActivePlanFromCtk(code) {
  if (!code) return;
  const dot = getActiveLhpDot();
  if (!_lhpPlannedByDot[dot]) _lhpPlannedByDot[dot] = [];
  const list = _lhpPlannedByDot[dot];
  const norm = String(code).trim();

  const existingIdx = list.findIndex(
    (item) =>
      String(item.maMonHoc || "").trim() === norm ||
      String(item.maHocPhan || "").trim() === norm
  );

  if (existingIdx >= 0) {
    list.splice(existingIdx, 1);
  } else {
    const hp = _ctkCourseMap[norm];
    if (!hp) return;
    const soTC = parseInt(hp.DVHT || hp.SoTinChi || 0, 10) || 0;
    const split = getCourseLtThCredits(hp, soTC);
    list.push({
      id: `plan_${norm}_${Date.now()}`,
      maMonHoc: String(hp.MaMonHoc || norm).trim(),
      maHocPhan: String(hp.MaHocPhan || norm).trim(),
      maLHP: String(hp.MaHocPhan || hp.MaMonHoc || norm).trim(),
      tenMonHoc: hp.TenMonHoc || "(Không tên)",
      lopDuKien: "Chưa chọn lớp (Dự kiến)",
      soTC,
      tcLT: split.tcLT,
      tcTH: split.tcTH,
      nhomTH: null,
      schedules: [],
      source: "ctk",
    });
  }

  saveLhpPlannerState();
  if (_ctkCache) {
    renderChuongTrinhKhung(_ctkCache);
  }
  refreshLhpPlannerView(dot);
}

// =============================================================================
// TÁCH TÍN CHỈ LT / TH & SUY LUẬN ĐƠN GIÁ HỌC PHÍ (+10%/NĂM)
// =============================================================================

/**
 * Tách số tín chỉ Lý thuyết (tcLT) và Thực hành (tcTH) của 1 môn học.
 * Ưu tiên:
 * 1. Override do người dùng chỉnh tay (_lhpLtThSplitOverrides)
 * 2. Dữ liệu SoTinChiLT / SoTinChiTH hoặc SoTietLT / 15 và SoTietTH / 30 từ Chương trình khung
 * 3. Suy luận từ lịch học (có tiết TH hay không) hoặc MaNhomThucHanh
 */
function getCourseLtThCredits(courseOrCode, fallbackTotalTC = 0, schedulesOrRow = null) {
  let hp = null;
  let codeKey = "";

  if (courseOrCode && typeof courseOrCode === "object") {
    codeKey = String(
      courseOrCode.MaMonHoc ||
        courseOrCode.maMonHoc ||
        courseOrCode.MaHocPhan ||
        courseOrCode.maHocPhan ||
        courseOrCode.MaLopHocPhan ||
        ""
    ).trim();
    hp =
      _ctkCourseMap[String(courseOrCode.MaMonHoc || "").trim()] ||
      _ctkCourseMap[String(courseOrCode.MaHocPhan || "").trim()] ||
      courseOrCode;
  } else if (courseOrCode) {
    codeKey = String(courseOrCode).trim();
    hp = _ctkCourseMap[codeKey] || null;
  }

  // Nếu chưa tìm thấy trong _ctkCourseMap bằng mã (do row chỉ có MaLopHocPhan 12 số hoặc TenMonHoc)
  if (!hp && courseOrCode && typeof courseOrCode === "object") {
    const rawLhp = String(courseOrCode.MaLopHocPhan || courseOrCode.MaLHP || "").trim();
    // Mã HP của IUH thường là 10 chữ số đầu của Mã LHP 12 chữ số
    if (rawLhp.length >= 10) {
      const prefix10 = rawLhp.substring(0, 10);
      if (_ctkCourseMap[prefix10]) {
        hp = _ctkCourseMap[prefix10];
        codeKey = String(hp.MaMonHoc || hp.MaHocPhan || prefix10).trim();
      }
    }
    if (!hp && courseOrCode.TenMonHoc) {
      const targetName = removeVietnameseTones(courseOrCode.TenMonHoc).trim();
      const matched = Object.values(_ctkCourseMap).find(
        (c) => removeVietnameseTones(c.TenMonHoc || "").trim() === targetName
      );
      if (matched) {
        hp = matched;
        codeKey = String(matched.MaMonHoc || matched.MaHocPhan || "").trim();
      }
    }
  }

  const totalTC =
    parseInt(
      fallbackTotalTC ||
        hp?.DVHT ||
        hp?.SoTinChi ||
        courseOrCode?.SoTinChi ||
        courseOrCode?.soTC ||
        0,
      10
    ) || 0;

  if (totalTC <= 0) {
    return { tcLT: 0, tcTH: 0, totalTC: 0 };
  }

  // 1. Kiểm tra override thủ công của người dùng
  if (codeKey && _lhpLtThSplitOverrides[codeKey]) {
    const ov = _lhpLtThSplitOverrides[codeKey];
    if (ov.tcLT + ov.tcTH === totalTC) {
      return { tcLT: ov.tcLT, tcTH: ov.tcTH, totalTC };
    }
  }

  // 2. Kiểm tra trường SoTinChiLT / SoTinChiTH hoặc SoTietLT / SoTietTH trong CTK
  if (hp) {
    if (hp.SoTinChiTH != null || hp.SoTinChiLT != null) {
      const tcTH = Math.min(totalTC, Math.max(0, Number(hp.SoTinChiTH) || 0));
      const tcLT = Math.max(0, totalTC - tcTH);
      return { tcLT, tcTH, totalTC };
    }
    if (hp.SoTietTH != null || hp.TietTH != null || hp.SoTietLT != null || hp.TietLT != null) {
      const tietTH = Number(hp.SoTietTH ?? hp.TietTH ?? 0);
      const tietLT = Number(hp.SoTietLT ?? hp.TietLT ?? 0);
      if (tietTH > 0 || tietLT > 0) {
        let tcTH = Math.round(tietTH / 30);
        if (tietTH > 0 && tcTH === 0) tcTH = 1;
        tcTH = Math.min(totalTC, Math.max(0, tcTH));
        const tcLT = Math.max(0, totalTC - tcTH);
        return { tcLT, tcTH, totalTC };
      }
    }
  }

  // 3. Suy luận từ tên môn / Nhóm TH / Lịch học
  const tenNorm = removeVietnameseTones(
    hp?.TenMonHoc || courseOrCode?.TenMonHoc || courseOrCode?.tenMonHoc || ""
  );
  if (
    tenNorm.includes("giao duc the chat") ||
    tenNorm.includes("thi nghiem") ||
    tenNorm.includes("thuc hanh") ||
    tenNorm.includes("do an") ||
    tenNorm.includes("khoa luan") ||
    tenNorm.includes("thuc tap")
  ) {
    return { tcLT: 0, tcTH: totalTC, totalTC };
  }

  const rowObj =
    schedulesOrRow && !Array.isArray(schedulesOrRow)
      ? schedulesOrRow
      : courseOrCode && typeof courseOrCode === "object"
      ? courseOrCode
      : null;

  const hasNhomTH =
    rowObj &&
    ((rowObj.MaNhomThucHanh != null && Number(rowObj.MaNhomThucHanh) > 0) ||
      (rowObj.nhomTH != null && Number(rowObj.nhomTH) > 0));

  const schedArray = Array.isArray(schedulesOrRow)
    ? schedulesOrRow
    : Array.isArray(rowObj?.schedules)
    ? rowObj.schedules
    : [];

  const hasThSchedule = schedArray.some((s) => s.isLT === false);
  const hasLtSchedule = schedArray.some((s) => s.isLT !== false);

  if (hasThSchedule && !hasLtSchedule) {
    return { tcLT: 0, tcTH: totalTC, totalTC };
  }

  if (hasNhomTH || hasThSchedule) {
    const tcTH = totalTC > 1 ? 1 : totalTC;
    const tcLT = Math.max(0, totalTC - tcTH);
    return { tcLT, tcTH, totalTC };
  }

  return { tcLT: totalTC, tcTH: 0, totalTC };
}

/**
 * Suy luận đơn giá 1 TC Lý thuyết (rateLT) và 1 TC Thực hành (rateTH) từ 1 tập các môn đã ĐK (có cột HocPhi).
 * Quy tắc:
 * - Tìm môn thuần LT (tcTH === 0, tcLT > 0) => rateLT = HocPhi / tcLT
 * - Sau đó tìm môn có TH (tcTH > 0) => rateTH = (HocPhi - tcLT * rateLT) / tcTH
 */
function solveDotTuitionRates(bundledDotData) {
  if (!bundledDotData) return null;
  const rows = Array.isArray(bundledDotData)
    ? bundledDotData
    : bundledDotData.rows || [];
  const allSchedules = Array.isArray(bundledDotData.schedules)
    ? bundledDotData.schedules
    : [];

  if (rows.length === 0) return null;

  const analyzed = rows
    .map((row) => {
      const hocPhi = Number(row.HocPhi || 0);
      const soTC = parseInt(row.SoTinChi || row.SoTC || row.DVHT || 0, 10) || 0;
      const rowScheds = allSchedules.filter(
        (s) => s.tenMon === (row.TenMonHoc || "")
      );
      const split = getCourseLtThCredits(row, soTC, rowScheds.length ? rowScheds : row);
      return {
        tenMon: row.TenMonHoc || "",
        hocPhi,
        soTC,
        tcLT: split.tcLT,
        tcTH: split.tcTH,
      };
    })
    .filter((item) => item.hocPhi > 0 && item.soTC > 0);

  if (analyzed.length === 0) return null;

  let rateLT = null;
  let pureLtCourseName = "";

  // Bước 1: Chọn môn thuần LT (tcTH === 0, tcLT > 0)
  const pureLt = analyzed.find((c) => c.tcTH === 0 && c.tcLT > 0);
  if (pureLt) {
    rateLT = Math.round(pureLt.hocPhi / pureLt.tcLT);
    pureLtCourseName = pureLt.tenMon;
  }

  // Bước 2: Từ tiền của LT => suy ra tiền của TH trên môn có TH (tcTH > 0)
  let rateTH = null;
  let thCourseName = "";

  if (rateLT !== null) {
    const withTh = analyzed.find(
      (c) => c.tcTH > 0 && c.hocPhi - c.tcLT * rateLT > 0
    );
    if (withTh) {
      const candidateTH = Math.round(
        (withTh.hocPhi - withTh.tcLT * rateLT) / withTh.tcTH
      );
      // Nếu candidateTH hợp lý (> 0)
      if (candidateTH > 0) {
        rateTH = candidateTH;
        thCourseName = withTh.tenMon;
      }
    }
  } else {
    // Nếu trong kỳ chỉ toàn môn thuần TH
    const pureTh = analyzed.find((c) => c.tcLT === 0 && c.tcTH > 0);
    if (pureTh) {
      rateTH = Math.round(pureTh.hocPhi / pureTh.tcTH);
      thCourseName = pureTh.tenMon;
    }
  }

  return {
    rateLT,
    rateTH,
    pureLtCourseName,
    thCourseName,
  };
}

/**
 * Suy luận đơn giá LT / TH cho học kỳ targetIdDot:
 * 1. Nếu người dùng đã chỉnh tay cho đợt này => dùng giá chỉnh tay.
 * 2. Thử suy luận trực tiếp từ các môn đã ĐK của chính đợt targetIdDot.
 * 3. Nếu chưa đủ (ví dụ kỳ mới chưa ĐK hoặc thiếu môn TH), lấy từ học kỳ trước trong CÙNG NĂM HỌC (x1.0).
 * 4. Nếu vẫn chưa có, lấy từ năm học trước gần nhất và nhân lũy tiến +10%/năm ((1.1)^yearDiff).
 */
function inferTuitionRatesForDot(targetIdDot) {
  const dotStr = String(targetIdDot);

  // Kiểm tra override thủ công
  if (
    _lhpCustomRatesByDot[dotStr] &&
    _lhpCustomRatesByDot[dotStr].rateLT > 0 &&
    _lhpCustomRatesByDot[dotStr].rateTH > 0
  ) {
    return {
      rateLT: _lhpCustomRatesByDot[dotStr].rateLT,
      rateTH: _lhpCustomRatesByDot[dotStr].rateTH,
      isCustom: true,
      sourceNote: "Đơn giá tùy chỉnh thủ công",
    };
  }

  const targetYear = getAcademicYearStartFromDot(dotStr);
  const allCachedDots = Object.keys(_lhpDataByDotCache)
    .map((d) => ({
      dot: String(d),
      year: getAcademicYearStartFromDot(d),
      solved: solveDotTuitionRates(_lhpDataByDotCache[d]),
    }))
    .filter((entry) => entry.solved && (entry.solved.rateLT || entry.solved.rateTH));

  // Sắp xếp ưu tiên:
  // 1. Chính đợt đang chọn
  // 2. Cùng năm học (year === targetYear), đợt gần nhất
  // 3. Khác năm học, khoảng cách năm nhỏ nhất (ưu tiên năm trước suy lên)
  allCachedDots.sort((a, b) => {
    if (a.dot === dotStr) return -1;
    if (b.dot === dotStr) return 1;
    const diffYearA = Math.abs(targetYear - a.year);
    const diffYearB = Math.abs(targetYear - b.year);
    if (diffYearA !== diffYearB) return diffYearA - diffYearB;
    return Number(b.dot) - Number(a.dot);
  });

  let baseLT = null;
  let baseLTYear = targetYear;
  let baseLTDot = null;
  let baseLTCourse = "";

  let baseTH = null;
  let baseTHYear = targetYear;
  let baseTHDot = null;
  let baseTHCourse = "";

  for (const item of allCachedDots) {
    if (baseLT === null && item.solved.rateLT > 0) {
      baseLT = item.solved.rateLT;
      baseLTYear = item.year;
      baseLTDot = item.dot;
      baseLTCourse = item.solved.pureLtCourseName;
    }
    if (baseTH === null && item.solved.rateTH > 0) {
      baseTH = item.solved.rateTH;
      baseTHYear = item.year;
      baseTHDot = item.dot;
      baseTHCourse = item.solved.thCourseName;
    }
    if (baseLT !== null && baseTH !== null) break;
  }

  // Mặc định chuẩn IUH nếu chưa từng tải bất kỳ học kỳ nào có học phí
  if (baseLT === null && baseTH === null) {
    const defaultLT = 900000;
    const defaultTH = 1230000;
    return {
      rateLT: defaultLT,
      rateTH: defaultTH,
      isCustom: false,
      sourceNote: "Mặc định ước tính (Hãy tải 1 kỳ đã học để tự động suy luận chính xác)",
    };
  }

  const scaleByYearDiff = (val, fromYear) => {
    const yearDiff = targetYear - fromYear;
    if (yearDiff === 0) return val;
    const scaled = val * Math.pow(1.1, yearDiff);
    return Math.round(scaled / 1000) * 1000;
  };

  let finalLT = baseLT !== null ? scaleByYearDiff(baseLT, baseLTYear) : null;
  let finalTH = baseTH !== null ? scaleByYearDiff(baseTH, baseTHYear) : null;

  // Nếu có LT nhưng chưa tìm được môn TH nào để tách (hoặc TH <= LT), dùng hệ số TH/LT (~1.37x chuẩn IUH, TH luôn đắt hơn LT)
  if (finalLT !== null && (finalTH === null || finalTH <= finalLT)) {
    finalTH = Math.round((finalLT * 1.37) / 1000) * 1000;
  } else if (finalTH !== null && finalLT === null) {
    finalLT = Math.round((finalTH / 1.37) / 1000) * 1000;
  }

  const yearDiffLT = targetYear - baseLTYear;
  const dotLabel = baseLTDot ? getDotTextById(baseLTDot) : "";
  let noteParts = [];

  if (baseLTDot === dotStr) {
    noteParts.push(`Suy luận trực tiếp từ ${dotLabel} (Môn LT: ${baseLTCourse || "Auto"}${baseTHCourse ? `, Môn TH: ${baseTHCourse}` : ""})`);
  } else if (yearDiffLT === 0) {
    noteParts.push(`Cơ sở từ ${dotLabel} (Cùng năm học, giữ nguyên đơn giá)`);
  } else if (yearDiffLT > 0) {
    const pct = Math.round((Math.pow(1.1, yearDiffLT) - 1) * 100);
    noteParts.push(`Cơ sở từ ${dotLabel} (+${pct}% theo quy tắc +10%/năm học)`);
  } else {
    const pct = Math.round((1 - Math.pow(1.1, yearDiffLT)) * 100);
    noteParts.push(`Quy đổi lùi từ ${dotLabel} (-${pct}% theo quy tắc 10%/năm học)`);
  }

  return {
    rateLT: finalLT,
    rateTH: finalTH,
    isCustom: false,
    sourceNote: noteParts.join(" • "),
  };
}

// =============================================================================
// KIỂM TRA ĐIỀU KIỆN TIÊN QUYẾT (b) / HỌC TRƯỚC (a) / SONG HÀNH (c)
// =============================================================================

function evaluateCoursePrerequisites(hp, activeIdDot) {
  if (!hp) return { ok: true, warnings: [], missingSongHanhCodes: [] };

  const warnings = [];
  const missingSongHanhCodes = [];
  const plannedList = _lhpPlannedByDot[activeIdDot] || [];
  const regData = _lhpDataByDotCache[activeIdDot];
  const regRows = Array.isArray(regData?.rows) ? regData.rows : [];

  const isCodeInCurrentSemester = (code) => {
    const norm = String(code).trim();
    const inPlanned = plannedList.some(
      (p) =>
        String(p.maMonHoc || "").trim() === norm ||
        String(p.maHocPhan || "").trim() === norm
    );
    if (inPlanned) return true;
    return regRows.some((r) => {
      const lhp = String(r.MaLopHocPhan || r.MaLHP || "").trim();
      return lhp.startsWith(norm);
    });
  };

  // 1. Tiên quyết (b): Phải Đạt (IsDat === true)
  extractCourseCodes(hp.HocPhanTienQuyet).forEach((code) => {
    const ref = _ctkCourseMap[code];
    if (ref && !ref.IsDat) {
      warnings.push({
        type: "b",
        code,
        tenMon: ref.TenMonHoc || code,
        label: `Chưa đạt Tiên quyết (b): ${ref.TenMonHoc || code}`,
      });
    }
  });

  // 2. Học trước (a): Phải Đạt hoặc Đã từng học (IDDangKyHocPhan > 0)
  extractCourseCodes(hp.HocPhanTruoc).forEach((code) => {
    const ref = _ctkCourseMap[code];
    if (ref && !ref.IsDat && !(ref.IDDangKyHocPhan > 0)) {
      warnings.push({
        type: "a",
        code,
        tenMon: ref.TenMonHoc || code,
        label: `Chưa học môn Trước (a): ${ref.TenMonHoc || code}`,
      });
    }
  });

  // 3. Song hành (c): Phải Đạt, Đang học, hoặc được ghim cùng kỳ này
  extractCourseCodes(hp.HocPhanSongHanh).forEach((code) => {
    const ref = _ctkCourseMap[code];
    if (ref && !ref.IsDat && !(ref.IDDangKyHocPhan > 0) && !isCodeInCurrentSemester(code)) {
      missingSongHanhCodes.push(code);
      warnings.push({
        type: "c",
        code,
        tenMon: ref.TenMonHoc || code,
        label: `Cần học Song hành (c): ${ref.TenMonHoc || code}`,
      });
    }
  });

  return {
    ok: warnings.length === 0,
    warnings,
    missingSongHanhCodes,
  };
}

// =============================================================================
// KIỂM TRA TRÙNG LỊCH (CONFLICT DETECTION)
// =============================================================================

function checkScheduleConflicts(candidateBlocks, existingBlocks, ignoreCourseCode = null) {
  const conflicts = [];
  for (const cand of candidateBlocks) {
    for (const ex of existingBlocks) {
      if (
        ignoreCourseCode &&
        (String(ex.maMonHoc || "") === String(ignoreCourseCode) ||
          String(ex.maHocPhan || "") === String(ignoreCourseCode) ||
          String(ex.maLHP || "") === String(ignoreCourseCode))
      ) {
        continue;
      }
      if (Number(cand.col) === Number(ex.col)) {
        const timeOverlap = !(Number(cand.end) < Number(ex.start) || Number(cand.start) > Number(ex.end));
        if (timeOverlap) {
          // Kiểm tra xem 2 môn có trùng khoảng tuần/ngày học hay không (tránh báo trùng lịch giả giữa các môn học cuốn chiếu khác tuần)
          let dateOverlap = true;
          if (cand.startDate && cand.endDate && ex.startDate && ex.endDate) {
            dateOverlap = !(cand.endDate < ex.startDate || cand.startDate > ex.endDate);
          }
          if (dateOverlap) {
            conflicts.push({
              col: cand.col,
              start: Math.max(cand.start, ex.start),
              end: Math.min(cand.end, ex.end),
              withCourse: ex.tenMon,
              detail: `Thứ ${cand.col === 8 ? "CN" : cand.col} (T${cand.start}-${cand.end}) trùng với ${ex.tenMon}`,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

// =============================================================================
// LHP — FETCH DATA CHO ĐỢT ĐĂNG KÝ
// =============================================================================

/**
 * Tải tuần tự toàn bộ dữ liệu LHP đã đăng ký + Chi tiết lịch học cho 1 đợt đăng ký (idDot).
 * Có khoảng nghỉ 180ms giữa các request để tránh ASP.NET Session Lock / Force Logout.
 */
async function fetchFullLhpDataForDot(idDot, onProgress) {
  const rawData = await fetchLopHocPhanDaDangKy(idDot);
  if (rawData === null) return null;

  const rows = Array.isArray(rawData)
    ? rawData
    : rawData.data || rawData.Data || [];
  const allSchedules = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const idEncrypted =
      row.IdLopHocPhanString || row.IDLopHocPhanEncrypted || "";
    if (!idEncrypted) continue;

    const maNhomTH = row.MaNhomThucHanh != null ? row.MaNhomThucHanh : 0;
    const tenMon = row.TenMonHoc || "(Không tên)";
    const maLHP = row.MaLopHocPhan || row.MaLHP || "";

    if (typeof onProgress === "function") {
      onProgress(i + 1, rows.length, tenMon);
    }

    // Nghỉ 180ms trước mỗi request chi tiết để ASP.NET nhả khóa Session an toàn
    await new Promise((r) => setTimeout(r, 180));

    try {
      const detailData = await fetchChiTietLopHocPhan(idEncrypted, maNhomTH);
      if (!detailData) continue;

      const schedules =
        detailData.ListLichHoc || (Array.isArray(detailData) ? detailData : []);

      const parsedSchedules = parseRawScheduleList(
        schedules,
        tenMon,
        LHP_COLORS[i % LHP_COLORS.length],
        maNhomTH,
        {
          statusType: "registered",
          maLHP,
          maMonHoc: maLHP.length >= 10 ? maLHP.substring(0, 10) : maLHP,
        }
      );

      allSchedules.push(...parsedSchedules);
    } catch (e) {
      console.warn("[DKHP] Lỗi lấy lịch học môn:", tenMon, e);
    }
  }

  return {
    rows,
    schedules: allSchedules,
    fetchedAt: Date.now(),
  };
}

function parseRawScheduleList(schedules, tenMon, color, selectedNhomTH = null, extraMeta = {}) {
  if (!Array.isArray(schedules)) return [];
  const result = [];
  const seenSlotKeys = new Set();

  schedules.forEach((sched) => {
    const lichHoc = sched.LichHoc || "";
    const phong = sched.Phong || "";
    const giangVien = sched.GiangVien || "";
    const nhomTH = sched.NhomThucHanh != null ? Number(sched.NhomThucHanh) : null;
    const isLT = sched.IsLyThuyet !== undefined ? Boolean(sched.IsLyThuyet) : nhomTH === null || nhomTH === 0;

    // Nếu lớp có nhiều tổ thực hành và người dùng đã chọn 1 tổ TH cụ thể, chỉ lấy lịch LT + đúng tổ TH đó
    if (
      !isLT &&
      selectedNhomTH != null &&
      Number(selectedNhomTH) > 0 &&
      nhomTH != null &&
      nhomTH > 0 &&
      nhomTH !== Number(selectedNhomTH)
    ) {
      return;
    }

    if (!lichHoc) return;

    // Regex hỗ trợ cả Thứ 2-7, CN, Chủ nhật, dấu gạch nối unicode (en-dash, em-dash) và có/không chữ Thứ
    const match = lichHoc.match(/(?:Thứ\s*(\d+)|(CN|Chủ\s*nhật))\s*\(\s*(?:Tiết\s*|T)?(\d+)\s*[-–—]+>?\s*(?:Tiết\s*|T)?(\d+)\s*\)/i);
    if (match) {
      let col = 2;
      if (match[1]) {
        col = parseInt(match[1], 10);
      } else if (match[2]) {
        col = 8; // Chủ nhật gán col = 8
      }
      const start = parseInt(match[3], 10);
      const end = parseInt(match[4], 10);

      // Trích xuất khoảng ngày học UTC (tránh lệch timezone)
      let startDate = null;
      let endDate = null;
      const timeStr = String(sched.ThoiGian || sched.TuNgayDenNgay || "");
      const tuStr = String(sched.TuNgay || "");
      const denStr = String(sched.DenNgay || "");
      const dMatches = (timeStr + " " + tuStr + " " + denStr).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g);
      if (dMatches && dMatches.length >= 2) {
        const p1 = dMatches[0].split("/");
        const p2 = dMatches[dMatches.length - 1].split("/");
        startDate = Date.UTC(parseInt(p1[2], 10), parseInt(p1[1], 10) - 1, parseInt(p1[0], 10));
        endDate = Date.UTC(parseInt(p2[2], 10), parseInt(p2[1], 10) - 1, parseInt(p2[0], 10));
      }

      // Gộp các dòng lịch trùng Thứ + Tiết của cùng 1 môn (do DKHP tách nhiều dải tuần)
      const dedupKey = `${col}_${start}_${end}_${isLT ? "LT" : "TH"}_${nhomTH || 0}`;
      if (seenSlotKeys.has(dedupKey)) return;
      seenSlotKeys.add(dedupKey);

      result.push({
        col,
        start,
        end,
        startDate,
        endDate,
        tenMon,
        phong,
        giangVien,
        color,
        isLT,
        nhomTH,
        ...extraMeta,
      });
    }
  });

  return result;
}

// =============================================================================
// LHP — RENDER VÙNG TÍNH HỌC PHÍ LT/TH + LỊCH TUẦN + BẢNG TỔNG HỢP
// =============================================================================

function refreshLhpPlannerView(targetIdDot = null) {
  const activeIdDot = targetIdDot ? String(targetIdDot) : getActiveLhpDot();
  const bundled = _lhpDataByDotCache[activeIdDot] || { rows: [], schedules: [] };
  renderLopHocPhanDaDangKy(bundled, activeIdDot);
  renderLhpLeftCourseList(activeIdDot);
}

function renderLhpTuitionCard(activeIdDot, regRows, plannedList, ratesInfo) {
  const card = document.getElementById("lhp-tuition-card");
  if (!card) return;

  const { rateLT, rateTH, isCustom, sourceNote } = ratesInfo;

  let regTcLT = 0;
  let regTcTH = 0;
  let regFeeActual = 0;

  const regKeys = new Set();
  (regRows || []).forEach((row) => {
    const lhp = String(row.MaLopHocPhan || row.MaLHP || "").trim();
    const mh = String(row.MaMonHoc || "").trim();
    if (lhp) regKeys.add(lhp);
    if (mh) regKeys.add(mh);
    if (lhp.length >= 10) regKeys.add(lhp.substring(0, 10));
    if (lhp.length >= 10) regKeys.add(lhp.substring(4, 10));

    const soTC = parseInt(row.SoTinChi || row.SoTC || row.DVHT || 0, 10) || 0;
    const split = getCourseLtThCredits(row, soTC, row);
    regTcLT += split.tcLT;
    regTcTH += split.tcTH;
    const actualFee = Number(row.HocPhi || 0);
    if (actualFee > 0) {
      regFeeActual += actualFee;
    } else {
      regFeeActual += split.tcLT * rateLT + split.tcTH * rateTH;
    }
  });

  const isPlannedAlreadyReg = (item) => {
    const lhp = String(item.maLHP || "").trim();
    const hp = String(item.maHocPhan || "").trim();
    const mh = String(item.maMonHoc || "").trim();
    return (lhp && regKeys.has(lhp)) || (hp && regKeys.has(hp)) || (mh && regKeys.has(mh));
  };

  let planTcLT = 0;
  let planTcTH = 0;
  let planFeeEst = 0;

  plannedList.forEach((item) => {
    if (isPlannedAlreadyReg(item)) return; // Bỏ qua môn đã ĐK chính thức để tránh nhân đôi học phí
    const split = getCourseLtThCredits(item, item.soTC || 0, item);
    planTcLT += split.tcLT;
    planTcTH += split.tcTH;
    planFeeEst += split.tcLT * rateLT + split.tcTH * rateTH;
  });

  const totalTC = regTcLT + regTcTH + planTcLT + planTcTH;
  const totalFee = regFeeActual + planFeeEst;

  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <h3 style="margin:0; font-size:15px; color:var(--text-main);">💰 Dự tính Học phí &amp; Tín chỉ (Lý thuyết / Thực hành)</h3>
        </div>
        <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">
          📐 <b>Nguồn đơn giá:</b> ${escapeHtml(sourceNote)}
        </div>
      </div>

      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; background:rgba(15,23,42,0.55); padding:6px 10px; border-radius:8px; border:1px solid var(--border-color);">
        <label style="font-size:11.5px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
          <span>📖 1 TC LT:</span>
          <input type="number" id="lhp-rate-lt-input" class="lhp-rate-input" step="10000" value="${rateLT}" title="Đơn giá 1 tín chỉ Lý thuyết (VNĐ)" />
          <span>đ</span>
        </label>
        <label style="font-size:11.5px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
          <span>🔬 1 TC TH:</span>
          <input type="number" id="lhp-rate-th-input" class="lhp-rate-input" step="10000" value="${rateTH}" title="Đơn giá 1 tín chỉ Thực hành (VNĐ)" />
          <span>đ</span>
        </label>
        ${
          isCustom
            ? `<button type="button" id="btn-reset-tuition-rate" class="lhp-mini-btn" title="Khôi phục đơn giá suy luận tự động">🔄 Auto</button>`
            : ""
        }
      </div>
    </div>

    <div class="lhp-tuition-grid">
      <div class="lhp-tuition-stat">
        <div style="font-size:11.5px; color:var(--text-muted);">Tổng Tín Chỉ (LT + TH)</div>
        <div style="font-size:18px; font-weight:800; color:var(--text-main); margin-top:3px;">
          ${totalTC} TC
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
          📖 <b>${regTcLT + planTcLT}</b> TC LT &bull; 🔬 <b>${regTcTH + planTcTH}</b> TC TH
        </div>
      </div>

      <div class="lhp-tuition-stat">
        <div style="font-size:11.5px; color:var(--text-muted);">✅ Đã ĐK chính thức (${regRows.length} môn)</div>
        <div style="font-size:17px; font-weight:700; color:#60a5fa; margin-top:3px;">
          ${regFeeActual.toLocaleString("vi-VN")} đ
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
          ${regTcLT + regTcTH} TC (${regTcLT} LT + ${regTcTH} TH)
        </div>
      </div>

      <div class="lhp-tuition-stat">
        <div style="font-size:11.5px; color:var(--text-muted);">📌 Dự kiến xếp thêm (${plannedList.length} môn)</div>
        <div style="font-size:17px; font-weight:700; color:#34d399; margin-top:3px;">
          +${planFeeEst.toLocaleString("vi-VN")} đ
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
          ${planTcLT + planTcTH} TC (${planTcLT} LT + ${planTcTH} TH)
        </div>
      </div>

      <div class="lhp-tuition-stat" style="border-color:rgba(245,158,11,0.45); background:rgba(245,158,11,0.07);">
        <div style="font-size:11.5px; color:#fbbf24; font-weight:600;">∑ Tổng Học Phí Kỳ Này</div>
        <div style="font-size:19px; font-weight:800; color:#fbbf24; margin-top:3px;">
          ${totalFee.toLocaleString("vi-VN")} đ
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
          Chênh lệch TH/LT: +${Math.max(0, rateTH - rateLT).toLocaleString("vi-VN")} đ/TC
        </div>
      </div>
    </div>
  `;

  const ltInput = document.getElementById("lhp-rate-lt-input");
  const thInput = document.getElementById("lhp-rate-th-input");
  const resetBtn = document.getElementById("btn-reset-tuition-rate");

  const handleRateChange = () => {
    const newLT = Math.max(0, parseInt(ltInput?.value || "0", 10) || 0);
    const newTH = Math.max(0, parseInt(thInput?.value || "0", 10) || 0);
    if (newLT > 0 && newTH > 0) {
      _lhpCustomRatesByDot[String(activeIdDot)] = { rateLT: newLT, rateTH: newTH };
      saveLhpPlannerState();
      refreshLhpPlannerView(activeIdDot);
    }
  };

  if (ltInput) ltInput.addEventListener("change", handleRateChange);
  if (thInput) thInput.addEventListener("change", handleRateChange);
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      delete _lhpCustomRatesByDot[String(activeIdDot)];
      saveLhpPlannerState();
      refreshLhpPlannerView(activeIdDot);
    });
  }
}

/** Render bảng Lớp học phần (Đã đăng ký + Dự kiến) + Thẻ Học Phí + Lịch học tuần */
function renderLopHocPhanDaDangKy(data, explicitDot = null) {
  const activeIdDot = explicitDot ? String(explicitDot) : getActiveLhpDot();
  const tbody = document.getElementById("lhp-table-body");
  const summary = document.getElementById("lhp-summary");
  const clearBtn = document.getElementById("btn-clear-planned-lhp");
  const pinnedTabCountEl = document.getElementById("lhp-pinned-count-tab");
  if (!tbody) return;

  ensureCtkTooltipInitialized();

  const isBundled =
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray(data.rows);
  const regRows = isBundled
    ? data.rows
    : Array.isArray(data)
    ? data
    : data?.data || data?.Data || [];
  const regSchedules = isBundled && Array.isArray(data.schedules) ? data.schedules : [];

  const plannedList = _lhpPlannedByDot[activeIdDot] || [];
  if (pinnedTabCountEl) pinnedTabCountEl.textContent = String(plannedList.length);
  if (clearBtn) {
    clearBtn.style.display = plannedList.length > 0 ? "inline-block" : "none";
  }

  const ratesInfo = inferTuitionRatesForDot(activeIdDot);
  renderLhpTuitionCard(activeIdDot, regRows, plannedList, ratesInfo);

  const regKeys = new Set();
  regRows.forEach((r) => {
    const lhp = String(r.MaLopHocPhan || r.MaLHP || "").trim();
    const mh = String(r.MaMonHoc || "").trim();
    if (lhp) regKeys.add(lhp);
    if (mh) regKeys.add(mh);
    if (lhp.length >= 10) regKeys.add(lhp.substring(0, 10));
    if (lhp.length >= 10) regKeys.add(lhp.substring(4, 10));
  });

  const isPlannedAlreadyReg = (item) => {
    const lhp = String(item.maLHP || "").trim();
    const hp = String(item.maHocPhan || "").trim();
    const mh = String(item.maMonHoc || "").trim();
    return (lhp && regKeys.has(lhp)) || (hp && regKeys.has(hp)) || (mh && regKeys.has(mh));
  };

  // Kết hợp lịch học Đã ĐK + lịch học Dự kiến
  const combinedSchedules = [
    ...regSchedules.map((s) => ({ ...s, statusType: "registered" })),
  ];

  plannedList.forEach((item, idx) => {
    if (isPlannedAlreadyReg(item)) return; // Không nhân đôi lịch trên TKB nếu môn đã ĐK chính thức
    const color = item.color || LHP_COLORS[(regRows.length + idx) % LHP_COLORS.length];
    (item.schedules || []).forEach((s) => {
      combinedSchedules.push({
        ...s,
        tenMon: item.tenMonHoc,
        color,
        statusType: "planned",
        plannedId: item.id,
        maMonHoc: item.maMonHoc,
        maHocPhan: item.maHocPhan,
        maLHP: item.maLHP,
      });
    });
  });

  renderLhpCalendar(combinedSchedules, _lhpGhostSchedules, activeIdDot);

  tbody.innerHTML = "";

  if (regRows.length === 0 && plannedList.length === 0) {
    const dotText = getDotTextById(activeIdDot);
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center;padding:28px;color:var(--text-muted);">
          Chưa có môn đã đăng ký hoặc môn dự kiến nào trong <b>${escapeHtml(dotText)}</b>.<br/>
          💡 Hãy chọn môn ở <b>Cột bên trái</b> để xếp thử lịch và tính học phí, hoặc nhấn <b>"🔄 Tải lại từ DKHP"</b>.
        </td>
      </tr>`;
    if (summary) summary.textContent = `${dotText}: 0 môn — 0 TC`;
    return;
  }

  let stt = 1;
  let totalTC = 0;

  // 1. Render các môn Đã ĐK chính thức
  regRows.forEach((row) => {
    const soTC = parseInt(row.SoTinChi || row.SoTC || row.DVHT || 0, 10) || 0;
    totalTC += soTC;
    const split = getCourseLtThCredits(row, soTC, row);
    const hocPhi =
      Number(row.HocPhi || 0) > 0
        ? Number(row.HocPhi)
        : split.tcLT * ratesInfo.rateLT + split.tcTH * ratesInfo.rateTH;

    const maLHP = row.MaLopHocPhan || row.MaLHP || "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:center;">${stt++}</td>
      <td style="text-align:center;">
        <span style="background:rgba(59,130,246,0.18);color:#60a5fa;border:1px solid rgba(59,130,246,0.4);padding:2px 7px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap;">
          ✅ Đã ĐK
        </span>
      </td>
      <td style="font-family:monospace;font-size:12px;font-weight:600;">${escapeHtml(maLHP)}</td>
      <td style="text-align:left;padding-left:10px;font-weight:600;">${escapeHtml(row.TenMonHoc || "")}</td>
      <td style="text-align:left;font-size:12px;">${escapeHtml(row.LopDuKien || row.LopHocDuKien || "")}</td>
      <td style="text-align:center;font-weight:600;">
        ${soTC} <span style="font-size:11px;color:var(--text-muted);font-weight:400;">(${split.tcLT}LT/${split.tcTH}TH)</span>
      </td>
      <td style="text-align:center;">${row.MaNhomThucHanh != null && row.MaNhomThucHanh > 0 ? `Tổ ${row.MaNhomThucHanh}` : "—"}</td>
      <td style="text-align:right;font-size:12px;font-weight:600;color:#60a5fa;">
        ${hocPhi.toLocaleString("vi-VN")} đ
      </td>
      <td style="font-size:11.5px;color:var(--text-muted);">
        ${escapeHtml(row.TrangThaiLopHocPhan || row.TrangThaiLHP || "Đã đăng ký")}
      </td>
      <td style="text-align:center;">
        <button type="button" class="lhp-mini-btn btn-copy-single-lhp" data-code="${escapeHtml(maLHP)}" title="Copy Mã LHP">📋</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 2. Render các môn Đang ghim Dự kiến
  plannedList.forEach((item) => {
    const alreadyReg = isPlannedAlreadyReg(item);
    const soTC = parseInt(item.soTC || 0, 10) || 0;
    if (!alreadyReg) {
      totalTC += soTC;
    }
    const split = getCourseLtThCredits(item, soTC, item);
    const estFee = split.tcLT * ratesInfo.rateLT + split.tcTH * ratesInfo.rateTH;
    const hp =
      _ctkCourseMap[String(item.maMonHoc || "").trim()] ||
      _ctkCourseMap[String(item.maHocPhan || "").trim()] ||
      null;
    const prereqEval = evaluateCoursePrerequisites(hp, activeIdDot);

    const schedSummary =
      (item.schedules || [])
        .map(
          (s) =>
            `T${s.col === 8 ? "CN" : s.col}(T${s.start}-${s.end}${s.isLT === false ? " TH" : " LT"})`
        )
        .join(", ") || "Chưa gán tiết";

    let statusHtml = "";
    if (alreadyReg) {
      statusHtml = `<span style="color:#34d399;font-weight:600;font-size:11.5px;">✓ Đã đăng ký chính thức</span>`;
    } else {
      const conflictList = checkScheduleConflicts(
        item.schedules || [],
        combinedSchedules,
        item.maMonHoc || item.maHocPhan
      );

      if (conflictList.length > 0) {
        statusHtml += `<div style="color:#f87171;font-weight:600;font-size:11px;">⚠️ ${escapeHtml(conflictList[0].detail)}</div>`;
      }
      if (!prereqEval.ok) {
        statusHtml += prereqEval.warnings
          .map(
            (w) =>
              `<div style="font-size:11px;margin-top:2px;">⚠️ ${renderCourseCodeBadge(w.code, w.type, true)}</div>`
          )
          .join(" ");
      }
      if (!statusHtml) {
        statusHtml = `<span style="color:#34d399;font-size:11.5px;">✓ Hợp lệ</span>`;
      }
    }

    const codeKey = String(item.maMonHoc || item.maHocPhan || "").trim();

    const tr = document.createElement("tr");
    tr.style.background = alreadyReg ? "rgba(59, 130, 246, 0.04)" : "rgba(16, 185, 129, 0.05)";
    tr.innerHTML = `
      <td style="text-align:center;">${stt++}</td>
      <td style="text-align:center;">
        <span style="background:${alreadyReg ? "rgba(59,130,246,0.18)" : "rgba(16,185,129,0.18)"};color:${alreadyReg ? "#60a5fa" : "#34d399"};border:1px ${alreadyReg ? "solid rgba(59,130,246,0.4)" : "dashed rgba(52,211,153,0.6)"};padding:2px 7px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap;">
          ${alreadyReg ? "✅ Đã ĐK" : "📌 Dự kiến"}
        </span>
      </td>
      <td style="font-family:monospace;font-size:12px;font-weight:600;color:#34d399;">
        ${escapeHtml(item.maLHP || item.maHocPhan || item.maMonHoc || "")}
      </td>
      <td style="text-align:left;padding-left:10px;font-weight:600;">
        ${escapeHtml(item.tenMonHoc || "")}
      </td>
      <td style="text-align:left;font-size:11.5px;">
        <div><b>${escapeHtml(item.lopDuKien || "Dự kiến")}</b></div>
        <div style="color:var(--text-muted);">${escapeHtml(schedSummary)}</div>
      </td>
      <td style="text-align:center;font-weight:600;">
        <button
          type="button"
          class="lhp-mini-btn btn-toggle-lt-th"
          data-code="${escapeHtml(codeKey)}"
          data-total-tc="${soTC}"
          title="Bấm để đổi tỷ lệ Tín chỉ Lý thuyết / Thực hành của môn này"
          style="padding:2px 6px;font-size:11px;"
        >
          ${soTC} TC (${split.tcLT}LT/${split.tcTH}TH) ✎
        </button>
      </td>
      <td style="text-align:center;">${item.nhomTH ? `Tổ ${item.nhomTH}` : "—"}</td>
      <td style="text-align:right;font-size:12px;font-weight:700;color:#34d399;">
        ~${estFee.toLocaleString("vi-VN")} đ
      </td>
      <td style="font-size:11.5px;">${statusHtml}</td>
      <td style="text-align:center;white-space:nowrap;">
        <button type="button" class="lhp-mini-btn btn-autoreg-single-lhp" data-code="${escapeHtml(item.maMonHoc || item.maHocPhan || "")}" style="background:rgba(16,185,129,0.18);color:#34d399;border-color:rgba(16,185,129,0.4);" title="Tự động đăng ký môn này lên cổng DKHP">🚀 ĐK</button>
        <button type="button" class="lhp-mini-btn btn-copy-single-lhp" data-code="${escapeHtml(item.maLHP || item.maHocPhan || "")}" title="Copy Mã LHP">📋</button>
        <button type="button" class="lhp-mini-btn danger btn-unpin-planned" data-id="${escapeHtml(item.id)}" title="Bỏ ghim môn dự kiến này">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (summary) {
    summary.textContent = `${regRows.length} đã ĐK + ${plannedList.length} dự kiến — Tổng ${totalTC} TC`;
  }

  // Gắn sự kiện cho các nút trong bảng
  tbody.querySelectorAll(".btn-autoreg-single-lhp").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-code") || "";
      openLhpAutoRegModal(code);
    });
  });

  tbody.querySelectorAll(".btn-copy-single-lhp").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-code") || "";
      if (code) {
        navigator.clipboard.writeText(code);
        const old = btn.textContent;
        btn.textContent = "✅";
        setTimeout(() => (btn.textContent = old), 1000);
      }
    });
  });

  tbody.querySelectorAll(".btn-unpin-planned").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      removePlannedItemById(activeIdDot, id);
    });
  });

  tbody.querySelectorAll(".btn-toggle-lt-th").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-code");
      const tot = parseInt(btn.getAttribute("data-total-tc") || "0", 10);
      if (!code || tot <= 0) return;
      const cur = getCourseLtThCredits(code, tot);
      // Xoay vòng số TC Thực hành: 0 -> 1 -> ... -> tot -> 0
      const nextTH = (cur.tcTH + 1) % (tot + 1);
      const nextLT = tot - nextTH;
      _lhpLtThSplitOverrides[code] = { tcLT: nextLT, tcTH: nextTH };
      saveLhpPlannerState();
      refreshLhpPlannerView(activeIdDot);
    });
  });
}

function removePlannedItemById(activeIdDot, plannedId) {
  const list = _lhpPlannedByDot[activeIdDot] || [];
  _lhpPlannedByDot[activeIdDot] = list.filter((item) => item.id !== plannedId);
  saveLhpPlannerState();
  refreshLhpPlannerView(activeIdDot);
  if (_ctkCache) renderChuongTrinhKhung(_ctkCache);
}

/**
 * Xóa lịch của 1 môn trên Thời khóa biểu nhưng VẪN GIỮ môn đó trong Clipboard
 */
function clearSinglePlannedScheduleKeepClipboard(activeIdDot, plannedId) {
  const list = _lhpPlannedByDot[activeIdDot] || [];
  const target = list.find((item) => item.id === plannedId);
  if (!target) return;
  target.schedules = [];
  target.lopDuKien = "Chưa chọn lớp (Clipboard)";
  target.nhomTH = null;
  target.idEncrypted = "";
  target.maLHP = target.maHocPhan || target.maMonHoc;
  saveLhpPlannerState();
  refreshLhpPlannerView(activeIdDot);
}

/**
 * Xóa TOÀN BỘ lịch dự kiến trên Thời khóa biểu nhưng VẪN GIỮ NGUYÊN danh sách môn trong Clipboard
 */
function clearAllPlannedSchedulesKeepClipboard(activeIdDot) {
  const list = _lhpPlannedByDot[activeIdDot] || [];
  if (list.length === 0) return;
  list.forEach((item) => {
    item.schedules = [];
    item.lopDuKien = "Chưa chọn lớp (Clipboard)";
    item.nhomTH = null;
    item.idEncrypted = "";
    item.maLHP = item.maHocPhan || item.maMonHoc;
  });
  _lhpGhostSchedules = [];
  saveLhpPlannerState();
  refreshLhpPlannerView(activeIdDot);
}

// =============================================================================
// LHP — CALENDAR UI (3 LỚP TRẠNG THÁI: ĐÃ ĐK / DỰ KIẾN / GHOST + BÁO TRÙNG)
// =============================================================================

function renderLhpCalendar(allSchedules = [], ghostSchedules = [], activeIdDot = null) {
  const container = document.getElementById("lhp-calendar-container");
  if (!container) return;

  const hasPlannedBlocks = Array.isArray(allSchedules) && allSchedules.some((s) => s.statusType === "planned");

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin: 0 0 12px 2px;">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <h3 style="margin: 0; font-size: 15.5px; color: var(--text-main);">🗓️ Thời khóa biểu tuần</h3>
        ${
          hasPlannedBlocks
            ? `<button
                type="button"
                id="btn-cal-clear-keep-clipboard"
                class="lhp-mini-btn danger"
                style="padding:3px 9px; font-size:11px;"
                title="Gỡ toàn bộ các ca dự kiến trên lịch nhưng vẫn giữ nguyên môn học trong Clipboard"
              >
                🧹 Clear lịch dự kiến (Giữ Clipboard)
              </button>`
            : ""
        }
      </div>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; font-size:11.5px; color:var(--text-muted);">
        <span style="display:inline-flex;align-items:center;gap:5px;">
          <span style="width:12px;height:12px;border-radius:3px;background:#3B82F6;display:inline-block;"></span>
          ✅ Đã ĐK chính thức
        </span>
        <span style="display:inline-flex;align-items:center;gap:5px;">
          <span style="width:12px;height:12px;border-radius:3px;background:rgba(16,185,129,0.35);border:2px dashed #34d399;display:inline-block;"></span>
          📌 Dự kiến (Bấm ✕ để gỡ ca)
        </span>
        <span style="display:inline-flex;align-items:center;gap:5px;">
          <span style="width:12px;height:12px;border-radius:3px;background:rgba(239,68,68,0.35);border:2px solid #ef4444;display:inline-block;"></span>
          ⚠️ Trùng tiết học
        </span>
      </div>
    </div>
    <div id="lhp-calendar-grid" style="
      display: grid;
      grid-template-columns: 48px repeat(7, 1fr);
      grid-template-rows: 30px repeat(15, 38px);
      gap: 1px;
      background: var(--border-color);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      font-size: 12px;
      position: relative;
    ">
      <div style="background: var(--bg-surface); grid-column: 1; grid-row: 1;"></div>
      <div style="background: var(--bg-surface); grid-column: 2; grid-row: 1; text-align: center; font-weight: 600; padding-top: 6px;">Thứ 2</div>
      <div style="background: var(--bg-surface); grid-column: 3; grid-row: 1; text-align: center; font-weight: 600; padding-top: 6px;">Thứ 3</div>
      <div style="background: var(--bg-surface); grid-column: 4; grid-row: 1; text-align: center; font-weight: 600; padding-top: 6px;">Thứ 4</div>
      <div style="background: var(--bg-surface); grid-column: 5; grid-row: 1; text-align: center; font-weight: 600; padding-top: 6px;">Thứ 5</div>
      <div style="background: var(--bg-surface); grid-column: 6; grid-row: 1; text-align: center; font-weight: 600; padding-top: 6px;">Thứ 6</div>
      <div style="background: var(--bg-surface); grid-column: 7; grid-row: 1; text-align: center; font-weight: 600; padding-top: 6px;">Thứ 7</div>
      <div style="background: var(--bg-surface); grid-column: 8; grid-row: 1; text-align: center; font-weight: 600; padding-top: 6px;">Chủ nhật</div>
    </div>
  `;

  const btnClearCal = document.getElementById("btn-cal-clear-keep-clipboard");
  if (btnClearCal) {
    btnClearCal.addEventListener("click", () => {
      clearAllPlannedSchedulesKeepClipboard(activeIdDot || getActiveLhpDot());
    });
  }

  const grid = document.getElementById("lhp-calendar-grid");
  if (!grid) return;

  for (let t = 1; t <= 15; t++) {
    const timeCell = document.createElement("div");
    timeCell.style.cssText = `background: var(--bg-surface); grid-column: 1; grid-row: ${t + 1}; display: flex; align-items: center; justify-content: center; font-weight: 500; color: var(--text-muted); border-right: 1px solid var(--border-color); font-size: 11px;`;
    timeCell.textContent = `T${t}`;
    grid.appendChild(timeCell);

    for (let d = 2; d <= 8; d++) {
      const cell = document.createElement("div");
      cell.style.cssText = `background: var(--bg-card); grid-column: ${d}; grid-row: ${t + 1};`;
      grid.appendChild(cell);
    }
  }

  const rawSchedules = Array.isArray(allSchedules) ? allSchedules : [];
  const safeSchedules = [];
  const seenRenderKeys = new Set();
  rawSchedules.forEach((ev) => {
    const key = `${ev.statusType || "reg"}_${ev.tenMon || ""}_${ev.col}_${ev.start}_${ev.end}_${ev.isLT === false ? "TH" : "LT"}`;
    if (seenRenderKeys.has(key)) return;
    seenRenderKeys.add(key);
    safeSchedules.push(ev);
  });

  const safeGhosts = Array.isArray(ghostSchedules) ? ghostSchedules : [];

  // Phát hiện các cặp bị trùng lịch giữa CÁC MÔN KHÁC NHAU
  const hasConflictWithOthers = (ev, idx) => {
    return safeSchedules.some((other, oIdx) => {
      if (oIdx === idx) return false;
      if (
        ev.tenMon &&
        other.tenMon &&
        removeVietnameseTones(ev.tenMon).trim() === removeVietnameseTones(other.tenMon).trim() &&
        ev.statusType === other.statusType
      ) {
        return false;
      }
      if (Number(ev.col) !== Number(other.col)) return false;
      return !(Number(ev.end) < Number(other.start) || Number(ev.start) > Number(other.end));
    });
  };

  safeSchedules.forEach((ev, idx) => {
    const isPlanned = ev.statusType === "planned";
    const isConflict = hasConflictWithOthers(ev, idx);
    const loai = ev.isLT === false ? "TH" : "LT";

    const block = document.createElement("div");
    block.style.cssText = `
      grid-column: ${ev.col};
      grid-row: ${ev.start + 1} / ${ev.end + 2};
      background: ${isConflict ? "rgba(220, 38, 38, 0.88)" : ev.color || "#3B82F6"};
      color: #fff;
      margin: 2px;
      border-radius: 6px;
      padding: 5px 6px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.28);
      border: ${
        isConflict
          ? "2px solid #fca5a5"
          : isPlanned
          ? "2px dashed #a7f3d0"
          : "1px solid rgba(255,255,255,0.2)"
      };
      overflow: hidden;
      display: flex;
      flex-direction: column;
      z-index: ${isConflict ? 15 : isPlanned ? 12 : 10};
      position: relative;
    `;

    block.title = `${isPlanned ? "[📌 DỰ KIẾN] " : "[✅ ĐÃ ĐK] "}${ev.tenMon} (${loai})\nPhòng: ${ev.phong || "—"}\nGV: ${ev.giangVien || "—"}\nTiết: ${ev.start}-${ev.end}${isConflict ? "\n⚠️ CẢNH BÁO: Bị trùng tiết học!" : ""}`;

    block.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px;">
        <div style="font-weight:700;margin-bottom:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.2;font-size:11px;">
          ${isConflict ? "⚠️ " : isPlanned ? "📌 " : ""}${escapeHtml(ev.tenMon || "")}
        </div>
        ${
          isPlanned && ev.plannedId
            ? `<button type="button" class="cal-unpin-btn" data-id="${escapeHtml(ev.plannedId)}" title="Gỡ ca học dự kiến này khỏi lịch (vẫn giữ môn trong Clipboard)" style="background:rgba(0,0,0,0.35);border:none;color:#fff;border-radius:4px;font-size:10px;padding:1px 4px;cursor:pointer;line-height:1;">✕</button>`
            : ""
        }
      </div>
      <div style="font-size: 10px; opacity: 0.9;">📍 ${escapeHtml(ev.phong || "Chưa rõ")}</div>
      <div style="font-size: 10px; opacity: 0.9; margin-top: 1px;">
        ${loai === "TH" ? "🔬" : "📖"} ${loai}${ev.nhomTH ? ` (Tổ ${ev.nhomTH})` : ""}
      </div>
    `;

    const unpinBtn = block.querySelector(".cal-unpin-btn");
    if (unpinBtn) {
      unpinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSinglePlannedScheduleKeepClipboard(activeIdDot || getActiveLhpDot(), ev.plannedId);
      });
    }

    grid.appendChild(block);
  });

  // Vẽ các khối Ghost Preview khi rê chuột
  safeGhosts.forEach((gh) => {
    const conflicts = checkScheduleConflicts([gh], safeSchedules, gh.maMonHoc);
    const isConflict = conflicts.length > 0;
    const loai = gh.isLT === false ? "TH" : "LT";

    const ghostEl = document.createElement("div");
    ghostEl.className = "cal-block-ghost";
    ghostEl.style.cssText = `
      grid-column: ${gh.col};
      grid-row: ${gh.start + 1} / ${gh.end + 2};
      background: ${isConflict ? "rgba(239, 68, 68, 0.55)" : "rgba(52, 211, 153, 0.45)"};
      border: 2px dashed ${isConflict ? "#f87171" : "#34d399"};
      color: #fff;
      margin: 2px;
      border-radius: 6px;
      padding: 5px 6px;
      z-index: 25;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    `;
    ghostEl.innerHTML = `
      <div style="font-weight:700;font-size:11px;line-height:1.2;">
        ${isConflict ? "⚠️ TRÙNG: " : "👻 Xem thử: "}${escapeHtml(gh.tenMon || "")}
      </div>
      <div style="font-size:10px;">📍 ${escapeHtml(gh.phong || "Dự kiến")} (${loai})</div>
    `;
    grid.appendChild(ghostEl);
  });
}

// =============================================================================
// LHP — CỘT TRÁI (35%): CHỌN MÔN & LỚP DỰ KIẾN (HYBRID DKHP + CTK + SMART SUGGEST)
// =============================================================================

function getUnifiedCandidateCourses(activeIdDot) {
  // Đảm bảo đã xây dựng index CTK nếu có cache
  if (_ctkCache && Object.keys(_ctkCourseMap).length === 0) {
    buildCtkIndex(_ctkCache);
  }

  const hinhThucEl = document.getElementById("lhp-hinhthuc-select");
  const hinhThuc = hinhThucEl ? hinhThucEl.value : "1";
  const openKey = `${activeIdDot}_${hinhThuc}`;
  const openCourses = _lhpOpenCoursesByDot[openKey] || [];

  const statusEl = document.getElementById("lhp-source-status");
  if (statusEl) {
    if (openCourses.length > 0) {
      statusEl.innerHTML = `<span style="color:#34d399;">● Đã nạp ${openCourses.length} môn mở từ DKHP</span>`;
    } else {
      statusEl.innerHTML = `<span>Nguồn: Chương trình khung (Hybrid)</span>`;
    }
  }

  const courseList = [];
  const seenCodes = new Set();

  // 1. Đưa các môn mở trực tiếp trên DKHP vào trước (nếu có)
  openCourses.forEach((oc) => {
    const maMH = String(oc.MaMonHoc || oc.MaHocPhan || "").trim();
    const maHP = String(oc.MaHocPhan || oc.MaMonHoc || "").trim();
    if (!maMH && !maHP) return;
    const key = maMH || maHP;
    if (seenCodes.has(key)) return;
    seenCodes.add(key);
    if (maHP) seenCodes.add(maHP);

    const ctkRef = _ctkCourseMap[maMH] || _ctkCourseMap[maHP] || null;
    const soTC = parseInt(oc.SoTinChi || oc.DVHT || ctkRef?.DVHT || 0, 10) || 0;
    courseList.push({
      maMonHoc: maMH || maHP,
      maHocPhan: maHP || maMH,
      tenMonHoc: oc.TenMonHoc || ctkRef?.TenMonHoc || "(Không tên)",
      soTC,
      hocKy: ctkRef?._hocKy ?? oc.HocKy ?? "?",
      isBatBuoc: ctkRef ? ctkRef._isBatBuoc : Boolean(oc.IsBatBuoc ?? true),
      isDat: Boolean(ctkRef?.IsDat),
      isOpenOnDkhp: true,
      ctkHp: ctkRef,
    });
  });

  // 2. Bổ sung toàn bộ môn từ Chương trình khung (_ctkCache)
  if (_ctkCache && Array.isArray(_ctkCache.ChuongTrinhHocKy)) {
    _ctkCache.ChuongTrinhHocKy.forEach((hk) => {
      const soHK = hk.HocKy || "?";
      const pushFromCtk = (hp, isBB) => {
        const maMH = String(hp.MaMonHoc || "").trim();
        const maHP = String(hp.MaHocPhan || "").trim();
        const key = maMH || maHP;
        if (!key || seenCodes.has(key) || (maHP && seenCodes.has(maHP))) return;
        seenCodes.add(key);
        if (maHP) seenCodes.add(maHP);

        const enriched = _ctkCourseMap[maMH] || _ctkCourseMap[maHP] || { ...hp, _hocKy: soHK, _isBatBuoc: isBB };
        courseList.push({
          maMonHoc: maMH || maHP,
          maHocPhan: maHP || maMH,
          tenMonHoc: hp.TenMonHoc || "(Không tên)",
          soTC: parseInt(hp.DVHT || hp.SoTinChi || 0, 10) || 0,
          hocKy: soHK,
          isBatBuoc: isBB,
          isDat: Boolean(hp.IsDat),
          isOpenOnDkhp: false,
          ctkHp: enriched,
        });
      };

      (hk.HocPhanBatBuoc || []).forEach((hp) => pushFromCtk(hp, true));
      (hk.HocPhanTuChon || []).forEach((hp) => pushFromCtk(hp, false));
    });
  }

  return courseList;
}

function renderLhpLeftCourseList(activeIdDot = null) {
  const dot = activeIdDot ? String(activeIdDot) : getActiveLhpDot();
  const listContainer = document.getElementById("lhp-course-list");
  if (!listContainer) return;

  const searchInput = document.getElementById("lhp-course-search");
  const hidePassedChk = document.getElementById("lhp-hide-passed-chk");
  const queryNorm = removeVietnameseTones((searchInput?.value || "").trim());
  const hidePassed = hidePassedChk ? hidePassedChk.checked : true;

  let courses = getUnifiedCandidateCourses(dot);

  if (courses.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align:center; padding:32px 14px; color:var(--text-muted); font-size:12.5px;">
        <p style="font-size:28px; margin:0 0 8px 0;">📂</p>
        <p style="margin:0 0 10px 0;">Chưa có dữ liệu Chương trình khung trong bộ nhớ đệm.</p>
        <button type="button" id="btn-load-ctk-for-planner" class="btn-primary" style="padding:7px 14px; font-size:12px;">
          📥 Tải Chương trình khung ngay
        </button>
      </div>
    `;
    const btnLoadCtk = document.getElementById("btn-load-ctk-for-planner");
    if (btnLoadCtk) {
      btnLoadCtk.addEventListener("click", async () => {
        btnLoadCtk.disabled = true;
        btnLoadCtk.textContent = "⏳ Đang tải CTK...";
        const data = await fetchChuongTrinhKhung();
        if (data) {
          _ctkCache = data;
          buildCtkIndex(data);
          chrome.storage.local.set({ iuh_ctk_data: data });
          refreshLhpPlannerView(dot);
        } else {
          alert("Vui lòng đăng nhập trang dkhp.iuh.edu.vn trước khi tải.");
          btnLoadCtk.disabled = false;
          btnLoadCtk.textContent = "📥 Tải Chương trình khung ngay";
        }
      });
    }
    return;
  }

  const plannedList = _lhpPlannedByDot[dot] || [];
  const regRows = _lhpDataByDotCache[dot]?.rows || [];

  const isCoursePinned = (c) =>
    plannedList.some(
      (p) =>
        p.maMonHoc === c.maMonHoc ||
        p.maHocPhan === c.maHocPhan ||
        p.maMonHoc === c.maHocPhan
    );

  const isCourseRegistered = (c) =>
    regRows.some((r) => {
      const lhp = String(r.MaLopHocPhan || r.MaLHP || "").trim();
      return (
        (c.maHocPhan && lhp.startsWith(c.maHocPhan)) ||
        removeVietnameseTones(r.TenMonHoc || "") === removeVietnameseTones(c.tenMonHoc)
      );
    });

  // Lọc theo tab nguồn ('hybrid' | 'suggest' | 'pinned')
  if (_lhpActiveSourceTab === "pinned") {
    courses = courses.filter((c) => isCoursePinned(c));
  } else if (_lhpActiveSourceTab === "suggest") {
    courses = courses
      .filter((c) => !c.isDat && !isCourseRegistered(c))
      .map((c) => {
        const revCount = c.ctkHp ? getReverseDepsForCourse(c.ctkHp).length : 0;
        const prereq = evaluateCoursePrerequisites(c.ctkHp, dot);
        return { ...c, _revCount: revCount, _prereqOk: prereq.ok };
      })
      .sort((a, b) => {
        if (a._prereqOk !== b._prereqOk) return a._prereqOk ? -1 : 1;
        if (b._revCount !== a._revCount) return b._revCount - a._revCount;
        if (a.isBatBuoc !== b.isBatBuoc) return a.isBatBuoc ? -1 : 1;
        return (parseInt(a.hocKy, 10) || 99) - (parseInt(b.hocKy, 10) || 99);
      });
  } else {
    if (hidePassed) {
      courses = courses.filter((c) => !c.isDat || isCoursePinned(c));
    }
  }

  // Lọc theo từ khóa tìm kiếm
  if (queryNorm) {
    courses = courses.filter((c) => {
      const nameNorm = removeVietnameseTones(c.tenMonHoc || "");
      const mh = (c.maMonHoc || "").toLowerCase();
      const hp = (c.maHocPhan || "").toLowerCase();
      const hk = `hk${c.hocKy}`;
      return (
        nameNorm.includes(queryNorm) ||
        mh.includes(queryNorm) ||
        hp.includes(queryNorm) ||
        hk.includes(queryNorm)
      );
    });
  }

  listContainer.innerHTML = "";

  if (courses.length === 0) {
    if (_lhpActiveSourceTab === "pinned") {
      listContainer.innerHTML = `
        <div style="text-align:center; padding:34px 16px; color:var(--text-muted); font-size:12.5px; line-height:1.55;">
          <p style="font-size:32px; margin:0 0 8px 0;">📋</p>
          <p style="font-size:14px; font-weight:700; color:var(--text-main); margin:0 0 6px 0;">
            Clipboard đang trống
          </p>
          <p style="margin:0 0 14px 0;">
            Hãy qua tab <b>📂 Chương trình khung</b> và bấm nút <b>➕ Clip</b> ở những môn bạn cần đăng ký kỳ tới, chúng sẽ hiện ngay tại đây để bạn xếp lịch &amp; tính học phí!
          </p>
          <button
            type="button"
            id="btn-empty-clipboard-goto-ctk"
            class="btn-primary"
            style="padding:8px 16px; font-size:12.5px; border-radius:8px; cursor:pointer;"
          >
            📂 Mở Chương trình khung để Clip môn
          </button>
        </div>
      `;
      const gotoBtn = document.getElementById("btn-empty-clipboard-goto-ctk");
      if (gotoBtn) {
        gotoBtn.addEventListener("click", () => {
          const navCtk = document.getElementById("nav-ctk");
          if (navCtk) navCtk.click();
        });
      }
    } else {
      listContainer.innerHTML = `
        <div style="text-align:center; padding:28px 12px; color:var(--text-muted); font-size:12.5px;">
          Không có môn học nào khớp với bộ lọc hiện tại.
        </div>
      `;
    }
    return;
  }

  const ratesInfo = inferTuitionRatesForDot(dot);

  courses.forEach((course) => {
    const codeKey = course.maMonHoc || course.maHocPhan;
    const pinned = isCoursePinned(course);
    const registered = isCourseRegistered(course);
    const isExpanded = _lhpExpandedCourseCode === codeKey;

    const split = getCourseLtThCredits(course.ctkHp || course, course.soTC);
    const estCourseFee = split.tcLT * ratesInfo.rateLT + split.tcTH * ratesInfo.rateTH;
    const prereqEval = evaluateCoursePrerequisites(course.ctkHp, dot);
    const reverseDeps = course.ctkHp ? getReverseDepsForCourse(course.ctkHp) : [];

    const prereqHtml = course.ctkHp ? renderPrerequisitesHtml(course.ctkHp, true) : "";
    const reverseHtml = course.ctkHp ? renderReverseDepsHtml(course.ctkHp, true) : "";

    const card = document.createElement("div");
    card.className = `lhp-course-card ${pinned ? "is-pinned" : ""} ${registered ? "is-registered" : ""} ${isExpanded ? "expanded" : ""}`;

    card.innerHTML = `
      <div class="lhp-course-header">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <div style="font-weight:700; font-size:13px; color:var(--text-main); line-height:1.35;">
            ${course.isOpenOnDkhp ? `<span title="Môn đang mở ĐK trên DKHP" style="color:#34d399;">●</span> ` : ""}
            ${escapeHtml(course.tenMonHoc)}
          </div>
          <span style="background:rgba(255,255,255,0.07); color:var(--text-main); padding:2px 7px; border-radius:6px; font-size:11px; font-weight:700; white-space:nowrap;">
            HK${escapeHtml(String(course.hocKy))} &bull; ${course.soTC} TC
          </span>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; font-size:11px; color:var(--text-muted);">
          <span>
            Mã: <b style="font-family:monospace;color:var(--text-main);">${escapeHtml(course.maHocPhan || course.maMonHoc)}</b>
            &bull; 📖 ${split.tcLT} LT + 🔬 ${split.tcTH} TH
            &bull; <span style="color:#34d399;font-weight:600;">~${estCourseFee.toLocaleString("vi-VN")}đ</span>
          </span>
          <span>
            ${
              registered
                ? `<span style="color:#60a5fa;font-weight:700;">✅ Đã ĐK</span>`
                : pinned
                ? `<span style="color:#34d399;font-weight:700;">📌 Đã ghim</span>`
                : `<span style="color:var(--primary);">${isExpanded ? "▲ Thu gọn" : "▼ Chọn lớp / Xếp ca"}</span>`
            }
          </span>
        </div>

        ${
          prereqHtml || reverseHtml
            ? `<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:11px; padding-top:2px;">
                ${prereqHtml ? `<span>ĐK: ${prereqHtml}</span>` : ""}
                ${reverseHtml ? `<span>🔓 Mở khóa (${reverseDeps.length}): ${reverseHtml}</span>` : ""}
              </div>`
            : ""
        }

        ${
          !prereqEval.ok
            ? `<div style="background:rgba(245,158,11,0.12); border-left:3px solid #f59e0b; padding:5px 8px; border-radius:4px; font-size:11px; color:#fbbf24;">
                ${prereqEval.warnings.map((w) => `<div>⚠️ ${escapeHtml(w.label)}</div>`).join("")}
                ${
                  prereqEval.missingSongHanhCodes.length > 0
                    ? `<button type="button" class="lhp-mini-btn btn-pin-song-hanh" data-codes="${escapeHtml(prereqEval.missingSongHanhCodes.join(","))}" style="margin-top:4px; padding:2px 7px; font-size:10.5px;">
                        ➕ Ghim luôn môn Song hành (c) đi kèm
                      </button>`
                    : ""
                }
              </div>`
            : ""
        }
      </div>

      <div class="lhp-course-body" id="lhp-course-body-${escapeHtml(codeKey)}"></div>
    `;

    const headerEl = card.querySelector(".lhp-course-header");
    headerEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-ctk-code]") || e.target.closest(".btn-pin-song-hanh")) {
        return;
      }
      _lhpExpandedCourseCode = _lhpExpandedCourseCode === codeKey ? null : codeKey;
      renderLhpLeftCourseList(dot);
    });

    const btnSongHanh = card.querySelector(".btn-pin-song-hanh");
    if (btnSongHanh) {
      btnSongHanh.addEventListener("click", (e) => {
        e.stopPropagation();
        const codes = (btnSongHanh.getAttribute("data-codes") || "").split(",").filter(Boolean);
        codes.forEach((c) => {
          if (!isCoursePlannedInActiveDot(c)) {
            toggleCourseInActivePlanFromCtk(c);
          }
        });
      });
    }

    listContainer.appendChild(card);

    if (isExpanded) {
      const bodyEl = card.querySelector(".lhp-course-body");
      renderExpandedCourseBody(bodyEl, course, dot);
    }
  });
}

/**
 * Làm mới sĩ số các lớp học phần của môn đang mở (tự động mỗi 2 phút hoặc khi bấm nút).
 */
async function refreshCourseSiSo(course, activeIdDot, bodyEl) {
  // Khong chen request khi dang tai du lieu / dang chay dang ky / da bi WAF chan
  if (_isFetchingLhp || _autoRegIsRunning || _dkhpBlocked) return;
  const codeKey = course.maMonHoc || course.maHocPhan;
  const classCacheKey = `${activeIdDot}_${codeKey}`;
  const currentList = _lhpOpenClassesByCourse[classCacheKey];
  if (!Array.isArray(currentList) || currentList.length === 0) return;

  // Gọi API lấy lại sĩ số mới nhất từ DKHP
  const prevMap = {};
  currentList.forEach((c) => {
    const k = c.MaLopHocPhan || c.MaLHP;
    if (k) prevMap[k] = Number(c.SiSoDangKy ?? c.SoLuongDangKy ?? 0);
  });

  const raw = await fetchDanhSachLopHocPhan(
    course.maMonHoc,
    activeIdDot,
    course.maHocPhan
  );
  if (!raw) return;

  const freshList = Array.isArray(raw) ? raw : raw.data || raw.Data || [];
  if (freshList.length > 0) {
    freshList.forEach((c) => {
      const k = c.MaLopHocPhan || c.MaLHP;
      if (k && prevMap[k] !== undefined) {
        c._prevSiSo = prevMap[k];
      }
    });
    _lhpOpenClassesByCourse[classCacheKey] = freshList;
    _lhpLastSiSoUpdatedAt[classCacheKey] = new Date().toLocaleTimeString("vi-VN");
    _lhpSiSoCountdownSec = 120;
    saveLhpPlannerState();
    if (bodyEl && document.body.contains(bodyEl)) {
      const classesArea = bodyEl.querySelector(".lhp-open-classes-area");
      renderOpenClassesForCourse(classesArea, course, activeIdDot, freshList, bodyEl);
    }
  }
}

function startOrUpdateSiSoAutoRefreshTimer(bodyEl, course, activeIdDot) {
  if (_lhpSiSoRefreshIntervalId) {
    clearInterval(_lhpSiSoRefreshIntervalId);
    _lhpSiSoRefreshIntervalId = null;
  }

  _lhpSiSoCountdownSec = 120;

  _lhpSiSoRefreshIntervalId = setInterval(() => {
    if (!bodyEl || !document.body.contains(bodyEl)) {
      clearInterval(_lhpSiSoRefreshIntervalId);
      _lhpSiSoRefreshIntervalId = null;
      return;
    }
    if (!_lhpSiSoAutoRefreshEnabled) return;

    _lhpSiSoCountdownSec = Math.max(0, _lhpSiSoCountdownSec - 1);
    const cdEl = bodyEl.querySelector(".lhp-siso-countdown");
    if (cdEl) {
      const mm = String(Math.floor(_lhpSiSoCountdownSec / 60)).padStart(2, "0");
      const ss = String(_lhpSiSoCountdownSec % 60).padStart(2, "0");
      cdEl.textContent = `${mm}:${ss}`;
    }

    if (_lhpSiSoCountdownSec <= 0) {
      _lhpSiSoCountdownSec = 120;
      refreshCourseSiSo(course, activeIdDot, bodyEl);
    }
  }, 1000);
}

function renderExpandedCourseBody(bodyEl, course, activeIdDot) {
  if (!bodyEl) return;
  const codeKey = course.maMonHoc || course.maHocPhan;
  const classCacheKey = `${activeIdDot}_${codeKey}`;
  const cachedClasses = _lhpOpenClassesByCourse[classCacheKey] || null;

  const plannedList = _lhpPlannedByDot[activeIdDot] || [];
  const existingPlanned = plannedList.find(
    (p) => p.maMonHoc === course.maMonHoc || p.maHocPhan === course.maHocPhan
  );

  bodyEl.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:10px; flex-wrap:wrap;">
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="lhp-mini-btn btn-fetch-course-classes">
          🔍 ${cachedClasses ? "Quét lại từ DKHP" : "Quét Lớp mở DKHP"}
        </button>
      </div>
      ${
        existingPlanned
          ? `<button type="button" class="lhp-mini-btn danger btn-unpin-course">✕ Bỏ ghim môn này</button>`
          : `<button type="button" class="lhp-mini-btn btn-quick-pin-no-slot">📌 Ghim môn (Chưa xếp ca)</button>`
      }
    </div>

    <div class="lhp-open-classes-area"></div>

    <!-- Bộ tạo ca học giả lập (Dùng khi trường chưa mở lớp hoặc muốn tự ướm lịch) -->
    <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border-color);">
      <div style="font-size:11.5px; font-weight:700; color:var(--text-main); margin-bottom:6px;">
        🛠️ Tự xếp ca học dự kiến (Khi DKHP chưa mở lớp):
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:6px; margin-bottom:6px;">
        <select class="sim-thu" style="background:var(--bg-dark);color:var(--text-main);border:1px solid var(--border-color);border-radius:6px;padding:4px 6px;font-size:11.5px;">
          <option value="2">Thứ 2</option>
          <option value="3">Thứ 3</option>
          <option value="4">Thứ 4</option>
          <option value="5">Thứ 5</option>
          <option value="6">Thứ 6</option>
          <option value="7">Thứ 7</option>
          <option value="8">Chủ nhật</option>
        </select>
        <select class="sim-start" title="Tiết bắt đầu" style="background:var(--bg-dark);color:var(--text-main);border:1px solid var(--border-color);border-radius:6px;padding:4px 6px;font-size:11.5px;">
          ${Array.from({ length: 15 }, (_, i) => `<option value="${i + 1}" ${i + 1 === 1 ? "selected" : ""}>Từ T${i + 1}</option>`).join("")}
        </select>
        <select class="sim-end" title="Tiết kết thúc" style="background:var(--bg-dark);color:var(--text-main);border:1px solid var(--border-color);border-radius:6px;padding:4px 6px;font-size:11.5px;">
          ${Array.from({ length: 15 }, (_, i) => `<option value="${i + 1}" ${i + 1 === 3 ? "selected" : ""}>Đến T${i + 1}</option>`).join("")}
        </select>
        <select class="sim-loai" style="background:var(--bg-dark);color:var(--text-main);border:1px solid var(--border-color);border-radius:6px;padding:4px 6px;font-size:11.5px;">
          <option value="LT">📖 LT</option>
          <option value="TH">🔬 TH</option>
        </select>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <input type="text" class="sim-phong" placeholder="Phòng / Ghi chú (VD: X10.01)" style="flex:1; background:var(--bg-dark); color:var(--text-main); border:1px solid var(--border-color); border-radius:6px; padding:5px 8px; font-size:11.5px;" />
        <button type="button" class="lhp-mini-btn btn-add-sim-slot" style="background:rgba(16,185,129,0.2);color:#34d399;border-color:rgba(16,185,129,0.45);">
          ➕ Thêm ca &amp; Ghim
        </button>
      </div>
    </div>
  `;

  const classesArea = bodyEl.querySelector(".lhp-open-classes-area");
  renderOpenClassesForCourse(classesArea, course, activeIdDot, cachedClasses, bodyEl);

  // Nút tải danh sách lớp thật từ DKHP
  const btnFetchClasses = bodyEl.querySelector(".btn-fetch-course-classes");
  if (btnFetchClasses) {
    btnFetchClasses.addEventListener("click", async () => {
      btnFetchClasses.disabled = true;
      btnFetchClasses.textContent = "⏳ Đang tải từ DKHP...";
      const raw = await fetchDanhSachLopHocPhan(
        course.maMonHoc,
        activeIdDot,
        course.maHocPhan
      );
      if (raw === null) {
        alert("Chưa đăng nhập DKHP hoặc phiên làm việc đã hết hạn.");
        btnFetchClasses.disabled = false;
        btnFetchClasses.textContent = "🔍 Quét Lớp mở DKHP";
        return;
      }
      const list = Array.isArray(raw) ? raw : raw.data || raw.Data || [];
      _lhpOpenClassesByCourse[classCacheKey] = list;
      _lhpLastSiSoUpdatedAt[classCacheKey] = new Date().toLocaleTimeString("vi-VN");
      saveLhpPlannerState();
      renderExpandedCourseBody(bodyEl, course, activeIdDot);
    });
  }

  // Nút ghim môn không cần ca học
  const btnQuickPin = bodyEl.querySelector(".btn-quick-pin-no-slot");
  if (btnQuickPin) {
    btnQuickPin.addEventListener("click", () => {
      pinOrUpdatePlannedCourse(activeIdDot, course, {
        maLHP: course.maHocPhan || course.maMonHoc,
        lopDuKien: "Dự kiến (Chưa xếp ca)",
        nhomTH: null,
        schedules: [],
        source: "ctk",
      });
    });
  }

  const btnUnpin = bodyEl.querySelector(".btn-unpin-course");
  if (btnUnpin && existingPlanned) {
    btnUnpin.addEventListener("click", () => {
      removePlannedItemById(activeIdDot, existingPlanned.id);
    });
  }

  // Bộ xếp ca giả lập + Ghost preview
  const thuEl = bodyEl.querySelector(".sim-thu");
  const startEl = bodyEl.querySelector(".sim-start");
  const endEl = bodyEl.querySelector(".sim-end");
  const loaiEl = bodyEl.querySelector(".sim-loai");
  const phongEl = bodyEl.querySelector(".sim-phong");
  const btnAddSim = bodyEl.querySelector(".btn-add-sim-slot");

  const getSimBlock = () => {
    const col = parseInt(thuEl.value, 10);
    const s = parseInt(startEl.value, 10);
    const e = Math.max(s, parseInt(endEl.value, 10));
    const isLT = loaiEl.value !== "TH";
    return {
      col,
      start: s,
      end: e,
      tenMon: course.tenMonHoc,
      phong: phongEl.value.trim() || "Giả lập",
      giangVien: "Tự xếp",
      isLT,
      nhomTH: isLT ? null : 1,
      maMonHoc: course.maMonHoc,
    };
  };

  if (btnAddSim) {
    btnAddSim.addEventListener("mouseenter", () => {
      _lhpGhostSchedules = [getSimBlock()];
      const bundled = _lhpDataByDotCache[activeIdDot] || { rows: [], schedules: [] };
      renderLopHocPhanDaDangKy(bundled, activeIdDot);
    });
    btnAddSim.addEventListener("mouseleave", () => {
      _lhpGhostSchedules = [];
      const bundled = _lhpDataByDotCache[activeIdDot] || { rows: [], schedules: [] };
      renderLopHocPhanDaDangKy(bundled, activeIdDot);
    });
    btnAddSim.addEventListener("click", () => {
      _lhpGhostSchedules = [];
      const newBlock = getSimBlock();
      const prevSchedules = existingPlanned ? [...(existingPlanned.schedules || [])] : [];
      prevSchedules.push(newBlock);

      pinOrUpdatePlannedCourse(activeIdDot, course, {
        maLHP: existingPlanned?.maLHP || course.maHocPhan || course.maMonHoc,
        lopDuKien: "Lịch tự xếp giả lập",
        nhomTH: newBlock.isLT ? existingPlanned?.nhomTH || null : 1,
        schedules: prevSchedules,
        source: "custom",
      });
    });
  }
}

function renderOpenClassesForCourse(container, course, activeIdDot, classes, bodyEl = null) {
  if (!container) return;
  const codeKey = course.maMonHoc || course.maHocPhan;
  const classCacheKey = `${activeIdDot}_${codeKey}`;

  if (!classes) {
    container.innerHTML = `
      <div style="font-size:11.5px; color:var(--text-muted); padding:6px 2px; line-height:1.5;">
        💡 Nhấn <b>"🔍 Quét Lớp mở DKHP"</b> để lấy lớp thực tế từ trường, hoặc dùng bộ <b>Tự xếp ca học dự kiến</b> bên dưới.
      </div>
    `;
    return;
  }

  if (classes.length === 0) {
    container.innerHTML = `
      <div style="font-size:11.5px; color:#fbbf24; background:rgba(245,158,11,0.1); padding:8px 10px; border-radius:6px; line-height:1.5;">
        ⚠️ Hiện tại cổng DKHP chưa mở lớp học phần nào cho môn này ở đợt đang chọn.<br/>
        👉 Bạn có thể dùng bộ <b>Tự xếp ca học dự kiến</b> bên dưới!
      </div>
    `;
    return;
  }

  const plannedList = _lhpPlannedByDot[activeIdDot] || [];
  const existingPlanned = plannedList.find(
    (p) => p.maMonHoc === course.maMonHoc || p.maHocPhan === course.maHocPhan
  );

  const lastUpdated = _lhpLastSiSoUpdatedAt[classCacheKey] || new Date().toLocaleTimeString("vi-VN");
  const mm = String(Math.floor(_lhpSiSoCountdownSec / 60)).padStart(2, "0");
  const ss = String(_lhpSiSoCountdownSec % 60).padStart(2, "0");

  container.innerHTML = `
    <!-- Thanh trạng thái Sĩ số & Tự động Refresh mỗi 2 phút (120s) -->
    <div style="
      display:flex;
      justify-content:space-between;
      align-items:center;
      flex-wrap:wrap;
      gap:6px;
      background:rgba(15,23,42,0.75);
      border:1px solid var(--border-color);
      border-radius:7px;
      padding:6px 10px;
      margin-bottom:8px;
      font-size:11px;
    ">
      <div style="display:flex; align-items:center; gap:6px; color:var(--text-muted);">
        <span>👥 <b>${classes.length} lớp</b></span>
        <span>&bull; Cập nhật: <b style="color:var(--text-main);">${escapeHtml(lastUpdated)}</b></span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; color:#60a5fa; font-weight:600;" title="Tự động quét lại sĩ số lớp mỗi 2 phút (120 giây)">
          <input type="checkbox" class="chk-auto-siso" ${_lhpSiSoAutoRefreshEnabled ? "checked" : ""} style="accent-color:#3b82f6; cursor:pointer;" />
          <span>⏱️ Auto 2p (<span class="lhp-siso-countdown" style="font-family:monospace;">${mm}:${ss}</span>)</span>
        </label>
        <button type="button" class="lhp-mini-btn btn-manual-refresh-siso" style="padding:2px 7px; font-size:10.5px;" title="Làm mới sĩ số ngay lập tức">
          🔄 Sĩ số
        </button>
      </div>
    </div>
    <div class="lhp-classes-items-wrap"></div>
  `;

  const chkAuto = container.querySelector(".chk-auto-siso");
  if (chkAuto) {
    chkAuto.addEventListener("change", () => {
      _lhpSiSoAutoRefreshEnabled = chkAuto.checked;
    });
  }

  const btnManualRefresh = container.querySelector(".btn-manual-refresh-siso");
  if (btnManualRefresh) {
    btnManualRefresh.addEventListener("click", async () => {
      btnManualRefresh.disabled = true;
      btnManualRefresh.textContent = "⏳...";
      await refreshCourseSiSo(course, activeIdDot, bodyEl || container.parentElement);
    });
  }

  if (bodyEl) {
    startOrUpdateSiSoAutoRefreshTimer(bodyEl, course, activeIdDot);
  }

  const listWrap = container.querySelector(".lhp-classes-items-wrap");

  classes.forEach((cls, clsIdx) => {
    const idEncrypted = cls.IdLopHocPhanString || cls.IDLopHocPhanEncrypted || cls.Id || "";
    const maLHP = cls.MaLopHocPhan || cls.MaLHP || "";
    const lopDK = cls.LopDuKien || cls.LopHocDuKien || cls.TenLop || "";
    const siSoNum = Number(cls.SiSoDangKy ?? cls.SoLuongDangKy ?? 0);
    const tongSoNum = Number(cls.SiSoToiDa ?? cls.SoLuongToiDa ?? 80);
    const trangThai = cls.TrangThaiLopHocPhan || cls.TrangThai || "";

    const pct = tongSoNum > 0 ? Math.min(100, Math.round((siSoNum / tongSoNum) * 100)) : 0;
    const conTrong = Math.max(0, tongSoNum - siSoNum);
    const isFull = siSoNum >= tongSoNum;
    const isNearFull = !isFull && pct >= 80;

    const capColor = isFull ? "#f87171" : isNearFull ? "#fbbf24" : "#34d399";
    const capBg = isFull
      ? "rgba(239,68,68,0.16)"
      : isNearFull
      ? "rgba(245,158,11,0.16)"
      : "rgba(16,185,129,0.15)";

    let deltaHtml = "";
    if (cls._prevSiSo !== undefined && cls._prevSiSo !== siSoNum) {
      const diff = siSoNum - cls._prevSiSo;
      deltaHtml =
        diff > 0
          ? `<span style="color:#f87171;font-weight:700;font-size:10px;margin-left:4px;" title="Tăng ${diff} SV vừa đăng ký">▲+${diff}</span>`
          : `<span style="color:#34d399;font-weight:700;font-size:10px;margin-left:4px;" title="Giảm ${Math.abs(diff)} SV vừa hủy">▼${diff}</span>`;
    }

    const isSelected = existingPlanned && existingPlanned.maLHP === maLHP;
    const rawDetail = idEncrypted ? _lhpClassDetailCache[idEncrypted] : null;

    // Tìm danh sách các Tổ Thực Hành (NhomThucHanh > 0) nếu đã tải chi tiết lịch
    const thGroups = [];
    if (Array.isArray(rawDetail)) {
      rawDetail.forEach((s) => {
        const g = Number(s.NhomThucHanh || 0);
        if (g > 0 && !thGroups.includes(g)) thGroups.push(g);
      });
      thGroups.sort((a, b) => a - b);
    }

    let selectedNhomTH = isSelected
      ? existingPlanned.nhomTH
      : thGroups.length > 0
      ? thGroups[0]
      : 0;

    const itemEl = document.createElement("div");
    itemEl.className = `lhp-class-option ${isSelected ? "selected" : ""}`;

    const buildClassContent = () => {
      const parsedBlocks = Array.isArray(rawDetail)
        ? parseRawScheduleList(rawDetail, course.tenMonHoc, "#10B981", selectedNhomTH, {
            maMonHoc: course.maMonHoc,
            maHocPhan: course.maHocPhan,
            maLHP,
          })
        : [];

      const schedLines = parsedBlocks.map((b) => {
        const thuLabel = b.col === 8 ? "Chủ nhật" : `Thứ ${b.col}`;
        const badgeType = b.isLT
          ? `<span style="background:rgba(59,130,246,0.2);color:#60a5fa;padding:1px 5px;border-radius:4px;font-weight:700;font-size:10px;">📖 LT</span>`
          : `<span style="background:rgba(16,185,129,0.2);color:#34d399;padding:1px 5px;border-radius:4px;font-weight:700;font-size:10px;">🔬 TH Tổ ${b.nhomTH || selectedNhomTH || 1}</span>`;
        return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; padding:3px 0; border-bottom:1px dashed rgba(255,255,255,0.05);">
            <div>
              ${badgeType}
              <b style="color:var(--text-main); margin-left:4px;">${thuLabel} (Tiết ${b.start}–${b.end})</b>
              &bull; 📍 <span style="color:#fbbf24;">${escapeHtml(b.phong || "?")}</span>
            </div>
            <div style="color:var(--text-main); font-weight:600; white-space:nowrap;">
              👨‍🏫 ${escapeHtml(b.giangVien || "Chưa phân công")}
            </div>
          </div>
        `;
      });

      itemEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;">
          <div style="font-size:12px; font-weight:700; color:var(--text-main);">
            <span style="color:var(--text-muted); font-size:11px;">#${clsIdx + 1}</span>
            <span style="font-family:monospace; color:#60a5fa; margin-left:3px;">${escapeHtml(maLHP)}</span>
            ${lopDK ? ` &mdash; <span style="color:#f8fafc;">${escapeHtml(lopDK)}</span>` : ""}
          </div>
          <div style="display:flex; align-items:center; gap:5px;">
            <span style="background:${capBg}; color:${capColor}; border:1px solid ${capColor}55; padding:2px 7px; border-radius:99px; font-size:11px; font-weight:700;">
              👥 ${siSoNum}/${tongSoNum} (${isFull ? "Hết chỗ" : `Còn ${conTrong}`})${deltaHtml}
            </span>
          </div>
        </div>

        <!-- Thanh tiến độ Sĩ số lớp -->
        <div style="width:100%; height:5px; background:rgba(255,255,255,0.08); border-radius:99px; overflow:hidden; margin-top:6px;">
          <div style="width:${pct}%; height:100%; background:${capColor}; transition:width 0.3s ease;"></div>
        </div>

        ${
          rawDetail
            ? `
              <div style="font-size:11px; color:var(--text-muted); margin-top:6px; line-height:1.45;">
                ${schedLines.join("") || "Chưa có thông tin tiết học"}
              </div>
              ${
                thGroups.length > 0
                  ? `<div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap; margin-top:8px;">
                      <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
                        <span style="font-size:11px; color:var(--text-muted);">Chọn Tổ TH:</span>
                        ${thGroups
                          .map(
                            (g) =>
                              `<button type="button" class="lhp-th-pill ${Number(selectedNhomTH) === g ? "active" : ""}" data-th="${g}">Tổ ${g}</button>`
                          )
                          .join("")}
                      </div>
                      <button type="button" class="lhp-mini-btn btn-pin-this-class" style="${isSelected ? "background:rgba(16,185,129,0.25);color:#34d399;" : ""}">
                        ${isSelected ? "✅ Đang ghim (Cập nhật)" : "📌 Ghim lớp này"}
                      </button>
                    </div>`
                  : `<div style="display:flex; justify-content:flex-end; margin-top:8px;">
                      <button type="button" class="lhp-mini-btn btn-pin-this-class" style="${isSelected ? "background:rgba(16,185,129,0.25);color:#34d399;" : ""}">
                        ${isSelected ? "✅ Đang ghim (Cập nhật)" : "📌 Ghim lớp này"}
                      </button>
                    </div>`
              }
            `
            : `
              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
                <span style="font-size:11px; color:var(--text-muted);">Trạng thái: ${escapeHtml(trangThai || "Đang mở")}</span>
                <button type="button" class="lhp-mini-btn btn-load-class-detail">📅 Xem GV, Giờ học &amp; Tổ TH</button>
              </div>
            `
        }
      `;

      // Sự kiện tải chi tiết lịch của lớp
      const btnDetail = itemEl.querySelector(".btn-load-class-detail");
      if (btnDetail && idEncrypted) {
        btnDetail.addEventListener("click", async () => {
          btnDetail.disabled = true;
          btnDetail.textContent = "⏳ Đang tải lịch...";
          const detailData = await fetchChiTietLopHocPhan(idEncrypted, -1);
          if (detailData) {
            const list =
              detailData.ListLichHoc || (Array.isArray(detailData) ? detailData : []);
            _lhpClassDetailCache[idEncrypted] = list;
            saveLhpPlannerState();
            renderOpenClassesForCourse(container, course, activeIdDot, classes, bodyEl);
          } else {
            btnDetail.disabled = false;
            btnDetail.textContent = "📅 Xem GV, Giờ học & Tổ TH";
          }
        });
      }

      // Sự kiện đổi Tổ TH
      itemEl.querySelectorAll(".lhp-th-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          selectedNhomTH = parseInt(pill.getAttribute("data-th") || "0", 10);
          buildClassContent();
        });
      });

      // Hover Ghost Preview
      if (parsedBlocks.length > 0) {
        itemEl.onmouseenter = () => {
          _lhpGhostSchedules = parsedBlocks;
          const bundled = _lhpDataByDotCache[activeIdDot] || { rows: [], schedules: [] };
          renderLopHocPhanDaDangKy(bundled, activeIdDot);
        };
        itemEl.onmouseleave = () => {
          _lhpGhostSchedules = [];
          const bundled = _lhpDataByDotCache[activeIdDot] || { rows: [], schedules: [] };
          renderLopHocPhanDaDangKy(bundled, activeIdDot);
        };
      }

      // Nút Ghim lớp
      const btnPinClass = itemEl.querySelector(".btn-pin-this-class");
      if (btnPinClass) {
        btnPinClass.addEventListener("click", () => {
          _lhpGhostSchedules = [];
          pinOrUpdatePlannedCourse(activeIdDot, course, {
            maLHP,
            idEncrypted,
            lopDuKien: lopDK || "Lớp mở DKHP",
            nhomTH: selectedNhomTH || null,
            schedules: parsedBlocks,
            source: "dkhp",
          });
        });
      }
    };

    buildClassContent();
    listWrap.appendChild(itemEl);
  });
}

function pinOrUpdatePlannedCourse(activeIdDot, course, classPayload) {
  if (!_lhpPlannedByDot[activeIdDot]) _lhpPlannedByDot[activeIdDot] = [];
  const list = _lhpPlannedByDot[activeIdDot];

  const split = getCourseLtThCredits(
    course.ctkHp || course,
    course.soTC,
    classPayload.schedules
  );

  const idx = list.findIndex(
    (p) => p.maMonHoc === course.maMonHoc || p.maHocPhan === course.maHocPhan
  );

  const newItem = {
    id: idx >= 0 ? list[idx].id : `plan_${course.maMonHoc}_${Date.now()}`,
    maMonHoc: course.maMonHoc,
    maHocPhan: course.maHocPhan,
    maLHP: classPayload.maLHP || course.maHocPhan || course.maMonHoc,
    idEncrypted: classPayload.idEncrypted || "",
    tenMonHoc: course.tenMonHoc,
    lopDuKien: classPayload.lopDuKien || "Dự kiến",
    soTC: course.soTC,
    tcLT: split.tcLT,
    tcTH: split.tcTH,
    nhomTH: classPayload.nhomTH,
    schedules: classPayload.schedules || [],
    source: classPayload.source || "ctk",
  };

  if (idx >= 0) {
    list[idx] = newItem;
  } else {
    list.push(newItem);
  }

  saveLhpPlannerState();
  refreshLhpPlannerView(activeIdDot);
  if (_ctkCache) renderChuongTrinhKhung(_ctkCache);
}

// =============================================================================
// LHP — TAB CONTROLLER & SỰ KIỆN TƯƠNG TÁC
// =============================================================================

function initLhpSemesterSelect() {
  if (_lhpSelectBound) return;
  const selectEl = document.getElementById("lhp-semester-select");
  if (!selectEl) return;
  _lhpSelectBound = true;

  selectEl.addEventListener("change", () => {
    const selectedDot = selectEl.value;
    if (selectedDot) {
      chrome.storage.local.set({ iuh_lhp_selected_dot: selectedDot });
      loadLhpTab(false, selectedDot);
    }
  });

  // Nút chuyển nhanh sang Chương trình khung để Clip môn
  const btnGotoCtk = document.getElementById("btn-goto-ctk-from-clipboard");
  if (btnGotoCtk) {
    btnGotoCtk.addEventListener("click", () => {
      const navCtk = document.getElementById("nav-ctk");
      if (navCtk) navCtk.click();
    });
  }

  // Bộ chọn nguồn môn học (Clipboard / Gợi ý / Tất cả)
  const sourceTabs = document.querySelectorAll("#lhp-source-tabs .lhp-source-tab");
  sourceTabs.forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      sourceTabs.forEach((b) => b.classList.remove("active"));
      tabBtn.classList.add("active");
      _lhpActiveSourceTab = tabBtn.getAttribute("data-source") || "pinned";
      renderLhpLeftCourseList(getActiveLhpDot());
    });
  });

  // Ô tìm kiếm môn bên trái
  const searchInput = document.getElementById("lhp-course-search");
  const clearSearchBtn = document.getElementById("lhp-course-search-clear");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      if (clearSearchBtn) {
        clearSearchBtn.style.display = searchInput.value ? "block" : "none";
      }
      renderLhpLeftCourseList(getActiveLhpDot());
    });
  }
  if (clearSearchBtn && searchInput) {
    clearSearchBtn.addEventListener("click", () => {
      searchInput.value = "";
      clearSearchBtn.style.display = "none";
      renderLhpLeftCourseList(getActiveLhpDot());
    });
  }

  const hidePassedChk = document.getElementById("lhp-hide-passed-chk");
  if (hidePassedChk) {
    hidePassedChk.addEventListener("change", () => {
      renderLhpLeftCourseList(getActiveLhpDot());
    });
  }

  const hinhThucEl = document.getElementById("lhp-hinhthuc-select");
  if (hinhThucEl) {
    hinhThucEl.addEventListener("change", () => {
      renderLhpLeftCourseList(getActiveLhpDot());
    });
  }

  // Nút Quét DS môn mở từ DKHP
  const btnFetchOpen = document.getElementById("btn-fetch-open-courses");
  if (btnFetchOpen) {
    btnFetchOpen.addEventListener("click", async () => {
      if (_isFetchingLhp) return;
      if (!DKHP_OPEN_COURSES_ENDPOINT_VERIFIED) {
        alert(
          "Tính năng quét danh sách môn mở toàn đợt đang tạm tắt để bảo vệ phiên đăng nhập (endpoint chưa được xác minh).\n\nHãy dùng danh sách Chương trình khung, rồi bấm \"Quét Lớp mở của môn này\" cho từng môn."
        );
        return;
      }
      const dot = getActiveLhpDot();
      const hinhThuc = hinhThucEl ? hinhThucEl.value : "1";
      btnFetchOpen.disabled = true;
      btnFetchOpen.textContent = "⏳ Đang quét DKHP...";
      try {
        const res = await fetchDanhSachMonHocPhanDangKy(dot, hinhThuc);
        if (res === null) {
          alert("Lỗi xác thực: Vui lòng đăng nhập dkhp.iuh.edu.vn trước khi quét.");
        } else {
          const list = Array.isArray(res) ? res : res.data || res.Data || [];
          _lhpOpenCoursesByDot[`${dot}_${hinhThuc}`] = list;
          saveLhpPlannerState();
          renderLhpLeftCourseList(dot);
          if (list.length === 0) {
            alert(
              `Cổng DKHP hiện trả về 0 môn mở cho ${getDotTextById(dot)}. Hệ thống đã tự động giữ danh sách Chương trình khung để bạn xếp lịch trước!`
            );
          }
        }
      } finally {
        btnFetchOpen.disabled = false;
        btnFetchOpen.textContent = "⚡ Quét lớp mở DKHP";
      }
    });
  }

  // Nút Copy toàn bộ Mã LHP dự kiến
  const btnCopyAll = document.getElementById("btn-copy-planned-lhp");
  if (btnCopyAll) {
    btnCopyAll.addEventListener("click", () => {
      const dot = getActiveLhpDot();
      const planned = _lhpPlannedByDot[dot] || [];
      const reg = _lhpDataByDotCache[dot]?.rows || [];
      const codes = [
        ...planned.map((p) => p.maLHP || p.maHocPhan || p.maMonHoc),
        ...reg.map((r) => r.MaLopHocPhan || r.MaLHP),
      ].filter(Boolean);

      if (codes.length === 0) {
        alert("Chưa có Mã LHP nào trong học kỳ này để sao chép.");
        return;
      }
      navigator.clipboard.writeText(codes.join("\n"));
      const oldHtml = btnCopyAll.innerHTML;
      btnCopyAll.innerHTML = `<span class="icon">✅</span> Đã copy (${codes.length} mã)`;
      setTimeout(() => (btnCopyAll.innerHTML = oldHtml), 1800);
    });
  }

  // Nút Clear lịch dự kiến (All) nhưng giữ nguyên danh sách môn trong Clipboard
  const btnClearPlanned = document.getElementById("btn-clear-planned-lhp");
  if (btnClearPlanned) {
    btnClearPlanned.addEventListener("click", () => {
      const dot = getActiveLhpDot();
      clearAllPlannedSchedulesKeepClipboard(dot);
    });
  }

  // Nút Mở Trung tâm Tự động Đăng ký trên cổng DKHP
  const btnOpenAutoReg = document.getElementById("btn-open-autoreg-modal");
  if (btnOpenAutoReg) {
    btnOpenAutoReg.addEventListener("click", () => {
      openLhpAutoRegModal(null);
    });
  }

  const btnClipboardAutoReg = document.getElementById("btn-clipboard-autoreg");
  if (btnClipboardAutoReg) {
    btnClipboardAutoReg.addEventListener("click", () => {
      openLhpAutoRegModal(null);
    });
  }

  initLhpAutoRegModalControls();

  // Nút Mô phỏng GPA kỳ này (Liên thông sang tab Kết quả học tập)
  const btnSimGpa = document.getElementById("btn-sim-planned-gpa");
  if (btnSimGpa) {
    btnSimGpa.addEventListener("click", () => {
      const dot = getActiveLhpDot();
      const planned = _lhpPlannedByDot[dot] || [];
      const reg = _lhpDataByDotCache[dot]?.rows || [];
      if (planned.length === 0 && reg.length === 0) {
        alert("Hãy ghim ít nhất 1 môn dự kiến ở cột bên trái trước khi đẩy sang Bảng điểm mô phỏng GPA!");
        return;
      }
      if (typeof window.pushPlannedCoursesToGradeSimulator === "function") {
        window.pushPlannedCoursesToGradeSimulator(
          dot,
          getDotTextById(dot),
          planned,
          reg
        );
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLhpSemesterSelect);
} else {
  initLhpSemesterSelect();
}

function renderSemesterOptions(dots, activeIdDot) {
  const selectEl = document.getElementById("lhp-semester-select");
  if (!selectEl || !Array.isArray(dots) || dots.length === 0) return;

  selectEl.innerHTML = "";
  dots.forEach((dot) => {
    const opt = document.createElement("option");
    opt.value = dot.value;
    opt.textContent = dot.text;
    if (dot.value === String(activeIdDot)) {
      opt.selected = true;
    }
    selectEl.appendChild(opt);
  });
  selectEl.value = String(activeIdDot);
}

async function loadLhpTab(forceRefresh = false, targetIdDot = null) {
  initLhpSemesterSelect();
  if (_isFetchingLhp) {
    console.warn("[DKHP] Đang tải dữ liệu LHP, bỏ qua thao tác trùng lặp để tránh xung đột session.");
    return;
  }

  const selectEl = document.getElementById("lhp-semester-select");
  const refreshBtn = document.getElementById("btn-refresh-lhp");
  const loadingEl = document.getElementById("lhp-loading");
  const authGateEl = document.getElementById("lhp-auth-gate");
  const tableSectionEl = document.getElementById("lhp-table-section");
  const placeholderEl = document.getElementById("lhp-placeholder");

  function showOnly(el) {
    [loadingEl, authGateEl, tableSectionEl, placeholderEl].forEach((e) => {
      if (e) e.style.display = "none";
    });
    if (el) el.style.display = "block";
  }

  if (!_lhpDotsCache) {
    _lhpDotsCache = getDanhSachDotDangKy();
  }

  // Đọc toàn bộ state từ chrome.storage.local (bao gồm cả CTK để phục vụ cột trái + tính LT/TH)
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(
      [
        "iuh_lhp_selected_dot",
        "iuh_lhp_data_by_dot",
        "iuh_lhp_planned_by_dot",
        "iuh_lhp_custom_rates_by_dot",
        "iuh_lhp_lt_th_overrides",
        "iuh_lhp_open_courses_by_dot",
        "iuh_lhp_open_classes_by_course",
        "iuh_lhp_class_detail_cache",
        "iuh_ctk_data",
      ],
      resolve
    )
  );

  if (stored.iuh_ctk_data && !_ctkCache) {
    _ctkCache = stored.iuh_ctk_data;
    buildCtkIndex(_ctkCache);
  }
  if (stored.iuh_lhp_data_by_dot) {
    _lhpDataByDotCache = { ...stored.iuh_lhp_data_by_dot, ..._lhpDataByDotCache };
  }
  if (stored.iuh_lhp_planned_by_dot) {
    _lhpPlannedByDot = { ...stored.iuh_lhp_planned_by_dot, ..._lhpPlannedByDot };
  }
  if (stored.iuh_lhp_custom_rates_by_dot) {
    _lhpCustomRatesByDot = { ...stored.iuh_lhp_custom_rates_by_dot, ..._lhpCustomRatesByDot };
  }
  if (stored.iuh_lhp_lt_th_overrides) {
    _lhpLtThSplitOverrides = { ...stored.iuh_lhp_lt_th_overrides, ..._lhpLtThSplitOverrides };
  }
  if (stored.iuh_lhp_open_courses_by_dot) {
    _lhpOpenCoursesByDot = { ...stored.iuh_lhp_open_courses_by_dot, ..._lhpOpenCoursesByDot };
  }
  if (stored.iuh_lhp_open_classes_by_course) {
    _lhpOpenClassesByCourse = { ...stored.iuh_lhp_open_classes_by_course, ..._lhpOpenClassesByCourse };
    // Dọn dữ liệu lớp mẫu cũ (tính năng "Xem mẫu 5 lớp" đã bị gỡ)
    Object.keys(_lhpOpenClassesByCourse).forEach((k) => {
      const list = _lhpOpenClassesByCourse[k];
      if (Array.isArray(list) && list.some((c) => c && c._isMock)) delete _lhpOpenClassesByCourse[k];
    });
  }
  if (stored.iuh_lhp_class_detail_cache) {
    _lhpClassDetailCache = { ...stored.iuh_lhp_class_detail_cache, ..._lhpClassDetailCache };
  }

  let activeIdDot = targetIdDot;
  if (!activeIdDot) {
    if (
      stored.iuh_lhp_selected_dot &&
      _lhpDotsCache.some((d) => String(d.value) === String(stored.iuh_lhp_selected_dot))
    ) {
      activeIdDot = String(stored.iuh_lhp_selected_dot);
    } else if (
      selectEl &&
      selectEl.value &&
      _lhpDotsCache.some((d) => String(d.value) === String(selectEl.value))
    ) {
      activeIdDot = String(selectEl.value);
    } else {
      const cachedDots = Object.keys(_lhpDataByDotCache);
      activeIdDot = cachedDots.length > 0 ? cachedDots[0] : "64";
    }
  } else {
    activeIdDot = String(activeIdDot);
  }

  chrome.storage.local.set({ iuh_lhp_selected_dot: activeIdDot });
  renderSemesterOptions(_lhpDotsCache, activeIdDot);

  const dotObj = _lhpDotsCache.find((d) => String(d.value) === activeIdDot);
  const dotText = dotObj ? dotObj.text : `Đợt ${activeIdDot}`;

  if (!forceRefresh) {
    showOnly(tableSectionEl);
    refreshLhpPlannerView(activeIdDot);
    return;
  }

  _isFetchingLhp = true;
  if (refreshBtn) refreshBtn.disabled = true;
  if (selectEl) selectEl.disabled = true;
  showOnly(loadingEl);

  const loadingTextEl = loadingEl ? loadingEl.querySelector("p") : null;
  if (loadingTextEl) {
    loadingTextEl.textContent = `⏳ Đang tải danh sách môn học (${dotText})...`;
  }

  try {
    const bundledData = await fetchFullLhpDataForDot(
      activeIdDot,
      (idx, total, tenMon) => {
        if (loadingTextEl) {
          loadingTextEl.textContent = `⏳ Đang tải lịch học (${idx}/${total}): ${tenMon}...`;
        }
      }
    );

    if (bundledData === null) {
      if (_lhpDataByDotCache[activeIdDot] || (_lhpPlannedByDot[activeIdDot]?.length || 0) > 0) {
        alert("Lỗi xác thực: Vui lòng đăng nhập trang DKHP để tải dữ liệu mới nhất.");
        showOnly(tableSectionEl);
        refreshLhpPlannerView(activeIdDot);
      } else {
        showOnly(authGateEl);
      }
      return;
    }

    _lhpDataByDotCache[activeIdDot] = bundledData;
    chrome.storage.local.set({
      iuh_lhp_data_by_dot: _lhpDataByDotCache,
      iuh_lhp_data: bundledData.rows,
    });

    showOnly(tableSectionEl);
    refreshLhpPlannerView(activeIdDot);
  } catch (err) {
    console.error("[DKHP] Lỗi fetch LHP cho đợt", activeIdDot, err);
    showOnly(tableSectionEl);
    refreshLhpPlannerView(activeIdDot);
  } finally {
    _isFetchingLhp = false;
    if (refreshBtn) refreshBtn.disabled = false;
    if (selectEl) selectEl.disabled = false;
  }
}

// =============================================================================
// LHP — TRUNG TÂM TỰ ĐỘNG ĐĂNG KÝ HỌC PHẦN (AUTO-ĐKHP & SNIPER ENGINE)
// =============================================================================

function appendAutoRegLog(message, level = "info") {
  const box = document.getElementById("lhp-autoreg-log-box");
  if (!box) return;
  const timeStr = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  const color =
    level === "ok"
      ? "#34d399"
      : level === "err"
      ? "#f87171"
      : level === "warn"
      ? "#fbbf24"
      : "#93c5fd";
  const line = document.createElement("div");
  line.style.cssText = `padding: 2px 0; border-bottom: 1px dashed rgba(255,255,255,0.05); color: ${color};`;
  line.innerHTML = `<span style="color:#64748b;">[${timeStr}]</span> ${escapeHtml(message)}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function updateAutoRegRowBadge(plannedId) {
  const badge = document.querySelector(
    `.autoreg-status-pill[data-id="${CSS.escape(String(plannedId))}"]`
  );
  if (!badge) return;
  const st = _autoRegStatusByCourseId[plannedId] || {
    state: "idle",
    msg: "⏸️ Chờ lệnh",
  };
  badge.textContent = st.msg;
  if (st.state === "ok") {
    badge.style.background = "rgba(16,185,129,0.2)";
    badge.style.color = "#34d399";
    badge.style.borderColor = "rgba(16,185,129,0.45)";
  } else if (st.state === "running") {
    badge.style.background = "rgba(59,130,246,0.2)";
    badge.style.color = "#60a5fa";
    badge.style.borderColor = "rgba(59,130,246,0.45)";
  } else if (st.state === "wait") {
    badge.style.background = "rgba(245,158,11,0.18)";
    badge.style.color = "#fbbf24";
    badge.style.borderColor = "rgba(245,158,11,0.45)";
  } else if (st.state === "err") {
    badge.style.background = "rgba(239,68,68,0.18)";
    badge.style.color = "#f87171";
    badge.style.borderColor = "rgba(239,68,68,0.45)";
  } else {
    badge.style.background = "rgba(148,163,184,0.12)";
    badge.style.color = "#94a3b8";
    badge.style.borderColor = "rgba(148,163,184,0.28)";
  }
}

function updateAutoRegButtonsUI() {
  const btnNow = document.getElementById("btn-autoreg-run-now");
  const btnSniper = document.getElementById("btn-autoreg-toggle-sniper");
  if (btnNow) {
    btnNow.disabled = _autoRegIsRunning;
    btnNow.innerHTML = _autoRegIsRunning
      ? "⏳ Đang gửi lệnh ĐK..."
      : "⚡ Đăng ký ngay (Direct API Siêu tốc)";
  }
  if (btnSniper) {
    if (_autoRegSniperTimerId) {
      btnSniper.innerHTML = `⏹️ Dừng Canh Slot (Thử lại sau ${_autoRegSniperRemainSec}s)`;
      btnSniper.style.background = "rgba(239, 68, 68, 0.22)";
      btnSniper.style.color = "#f87171";
      btnSniper.style.borderColor = "rgba(239, 68, 68, 0.5)";
    } else {
      btnSniper.innerHTML = "🎯 Bật Canh Slot / Tự động thử lại";
      btnSniper.style.background = "rgba(245, 158, 11, 0.18)";
      btnSniper.style.color = "#fbbf24";
      btnSniper.style.borderColor = "rgba(245, 158, 11, 0.45)";
    }
  }
}

function openLhpAutoRegModal(focusCourseCode = null) {
  initLhpAutoRegModalControls();
  const modal = document.getElementById("lhp-autoreg-modal");
  if (!modal) return;

  const activeIdDot = getActiveLhpDot();
  const hinhThucEl = document.getElementById("lhp-hinhthuc-select");
  const hinhThucText =
    hinhThucEl?.options[hinhThucEl.selectedIndex]?.text || "📘 Học mới";
  const subtitle = document.getElementById("lhp-autoreg-subtitle");
  if (subtitle) {
    subtitle.innerHTML = `Đợt đăng ký: <b style="color:#60a5fa;">${escapeHtml(getDotTextById(activeIdDot))} (idDot=${escapeHtml(activeIdDot)})</b> &bull; Hình thức: <b style="color:#34d399;">${escapeHtml(hinhThucText)}</b>`;
  }

  renderLhpAutoRegModalTable(activeIdDot, focusCourseCode);
  modal.style.display = "flex";
}

function renderLhpAutoRegModalTable(activeIdDot, focusCourseCode = null) {
  const tbody = document.getElementById("lhp-autoreg-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const plannedList = _lhpPlannedByDot[activeIdDot] || [];
  if (plannedList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center; padding:32px 16px; color:var(--text-muted);">
          📋 <b>Clipboard của bạn đang trống.</b><br/>
          Hãy chọn môn từ tab <b>Chương trình khung (➕ Clip)</b> hoặc ghim lớp ở cột bên trái trước khi chạy Tự động Đăng ký.
        </td>
      </tr>
    `;
    return;
  }

  const normFocus = focusCourseCode ? String(focusCourseCode).trim() : null;

  plannedList.forEach((item) => {
    const codeKey = item.maMonHoc || item.maHocPhan;
    const classCacheKey = `${activeIdDot}_${codeKey}`;
    const openClasses = _lhpOpenClassesByCourse[classCacheKey] || [];
    const matchedCls = openClasses.find(
      (c) => String(c.MaLopHocPhan || "").trim() === String(item.maLHP || "").trim()
    );

    let siSoBadge = `<span style="color:var(--text-muted);font-size:11px;">Sẽ tự dò khi chạy</span>`;
    if (matchedCls) {
      const s = Number(matchedCls.SiSoDangKy ?? 0);
      const t = Number(matchedCls.SiSoToiDa ?? 80);
      const trangThai = String(matchedCls.TrangThai || matchedCls.TrangThaiLopHocPhan || "");
      const isLocked = trangThai.toLowerCase().includes("khóa");
      const isFull = (t > 0 && s >= t) || isLocked;
      siSoBadge = `<span style="color:${isFull ? "#f87171" : "#34d399"};font-weight:700;font-size:11.5px;">👥 ${s}/${t}${isLocked ? " (Khóa)" : ""}</span>`;
    } else if (Array.isArray(item.schedules) && item.schedules.length > 0) {
      siSoBadge = `<span style="color:#60a5fa;font-size:11px;">📅 Đã xếp ${item.schedules.length} ca</span>`;
    }

    const isChecked =
      !normFocus ||
      String(item.maMonHoc || "").trim() === normFocus ||
      String(item.maHocPhan || "").trim() === normFocus ||
      String(item.maLHP || "").trim() === normFocus;

    const st = _autoRegStatusByCourseId[item.id] || {
      state: "idle",
      msg: "⏸️ Chờ lệnh",
    };

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:center;">
        <input type="checkbox" class="autoreg-item-chk" data-id="${escapeHtml(item.id)}" ${isChecked ? "checked" : ""} style="accent-color:var(--primary);cursor:pointer;width:15px;height:15px;" />
      </td>
      <td style="text-align:left;">
        <div style="font-weight:700; color:var(--text-main); font-size:13px;">${escapeHtml(item.tenMonHoc)}</div>
        <div style="font-size:11px; color:var(--text-muted);">
          Mã MH: <span style="font-family:monospace;">${escapeHtml(item.maMonHoc)}</span>
          &bull; Mã HP: <span style="font-family:monospace;">${escapeHtml(item.maHocPhan)}</span>
          &bull; ${item.soTC || 0} TC (${item.tcLT || 0}LT/${item.tcTH || 0}TH)
        </div>
      </td>
      <td>
        <input
          type="text"
          class="autoreg-malhp-input"
          data-id="${escapeHtml(item.id)}"
          value="${escapeHtml(item.maLHP || item.maHocPhan || "")}"
          placeholder="Nhập Mã LHP 12 số..."
          style="width:145px; background:var(--bg-dark); color:#60a5fa; font-family:monospace; font-weight:700; border:1px solid var(--border-color); border-radius:6px; padding:5px 8px; font-size:12px;"
          title="Nhập Mã LHP 12 chữ số muốn đăng ký (hoặc để Mã HP 10 số để hệ thống tự chọn lớp mở còn chỗ)"
        />
      </td>
      <td>
        <input
          type="number"
          class="autoreg-nhomth-input"
          data-id="${escapeHtml(item.id)}"
          value="${item.nhomTH ? escapeHtml(String(item.nhomTH)) : ""}"
          min="0"
          max="20"
          placeholder="Không TH"
          style="width:85px; background:var(--bg-dark); color:#34d399; font-weight:700; border:1px solid var(--border-color); border-radius:6px; padding:5px 8px; font-size:12px; text-align:center;"
          title="Nhập số Tổ Thực hành (1, 2, 3...) hoặc để trống nếu môn chỉ có Lý thuyết"
        />
      </td>
      <td style="text-align:center;">
        <div data-siso-id="${escapeHtml(item.id)}">${siSoBadge}</div>
        <div data-lopdk-id="${escapeHtml(item.id)}" style="font-size:10.5px; color:var(--text-muted);">${escapeHtml(item.lopDuKien || "")}</div>
      </td>
      <td>
        <span
          class="autoreg-status-pill"
          data-id="${escapeHtml(item.id)}"
          style="display:inline-block; padding:3px 9px; border-radius:99px; font-size:11.5px; font-weight:700; border:1px solid rgba(148,163,184,0.28); background:rgba(148,163,184,0.12); color:#94a3b8;"
        >
          ${escapeHtml(st.msg)}
        </span>
      </td>
    `;

    tbody.appendChild(tr);
    updateAutoRegRowBadge(item.id);
  });

  // Lắng nghe chỉnh sửa Mã LHP / Tổ TH ngay trong bảng Modal
  tbody.querySelectorAll(".autoreg-malhp-input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = inp.getAttribute("data-id");
      const target = (_lhpPlannedByDot[activeIdDot] || []).find((x) => x.id === id);
      if (target) {
        const newCode = inp.value.trim();
        if (newCode && newCode !== target.maLHP) {
          target.maLHP = newCode;
          target.idEncrypted = ""; // Để tự động phân giải lại IdLopHocPhanString mới
          saveLhpPlannerState();
          refreshLhpPlannerView(activeIdDot);
        }
      }
    });
  });

  tbody.querySelectorAll(".autoreg-nhomth-input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = inp.getAttribute("data-id");
      const target = (_lhpPlannedByDot[activeIdDot] || []).find((x) => x.id === id);
      if (target) {
        const val = parseInt(inp.value.trim(), 10);
        target.nhomTH = !isNaN(val) && val > 0 ? val : null;
        saveLhpPlannerState();
        refreshLhpPlannerView(activeIdDot);
      }
    });
  });
}

function updateAutoRegRowLiveMeta(item, matchedCls = null) {
  if (!item || !item.id) return;
  const escId = CSS.escape(String(item.id));
  const lhpInp = document.querySelector(`.autoreg-malhp-input[data-id="${escId}"]`);
  if (lhpInp && item.maLHP && document.activeElement !== lhpInp) {
    lhpInp.value = String(item.maLHP);
  }
  const thInp = document.querySelector(`.autoreg-nhomth-input[data-id="${escId}"]`);
  if (thInp && item.nhomTH && document.activeElement !== thInp) {
    thInp.value = String(item.nhomTH);
  }
  const lopDkEl = document.querySelector(`[data-lopdk-id="${escId}"]`);
  if (lopDkEl && (matchedCls?.LopDuKien || item.lopDuKien)) {
    lopDkEl.textContent = String(matchedCls?.LopDuKien || item.lopDuKien || "");
  }
  const siSoEl = document.querySelector(`[data-siso-id="${escId}"]`);
  if (siSoEl && matchedCls) {
    const s = Number(matchedCls.SiSoDangKy ?? 0);
    const t = Number(matchedCls.SiSoToiDa ?? 80);
    const trangThai = String(matchedCls.TrangThai || matchedCls.TrangThaiLopHocPhan || "");
    const isLocked = trangThai.toLowerCase().includes("khóa");
    const isFull = (t > 0 && s >= t) || isLocked;
    siSoEl.innerHTML = `<span style="color:${isFull ? "#f87171" : "#34d399"};font-weight:700;font-size:11.5px;">👥 ${s}/${t}${isLocked ? " (Khóa)" : ""}</span>`;
  }
}

function isClassOpenForRegistration(cls) {
  if (!cls || !cls.IdLopHocPhanString) return false;
  const rawStatus = removeVietnameseTones(String(cls.TrangThai || cls.TrangThaiLopHocPhan || ""));
  if (rawStatus.includes("da khoa") || rawStatus.includes("tam khoa") || rawStatus.includes("huy")) {
    return false;
  }
  const siSo = Number(cls.SiSoDangKy ?? 0);
  const toiDa = Number(cls.SiSoToiDa ?? 0);
  // Loại bỏ các lớp nháp có sĩ số 0/0
  if (toiDa <= 0 && siSo <= 0) return false;
  return toiDa <= 0 || siSo < toiDa;
}

/**
 * Thực thi đăng ký 1 môn học từ Clipboard qua Direct API
 */
async function executeSingleCourseAutoReg(item, activeIdDot, hinhThuc, autoPickOpenClass) {
  _autoRegStatusByCourseId[item.id] = {
    state: "running",
    msg: "⏳ Đang dò lớp...",
  };
  updateAutoRegRowBadge(item.id);

  let targetMaLHP = String(item.maLHP || "").trim();
  let nhomTH =
    item.nhomTH !== null && item.nhomTH !== undefined && item.nhomTH !== ""
      ? Number(item.nhomTH)
      : 0;

  // Kiểm tra Mã LHP hiện tại có phải mã LHP 12 số cụ thể hay chỉ là Mã HP 10 số / Mã MH 6 số
  const isSpecificLhpCode =
    targetMaLHP.length >= 11 &&
    targetMaLHP !== String(item.maHocPhan || "").trim() &&
    targetMaLHP !== String(item.maMonHoc || "").trim();

  // Luôn gọi GetDanhSachLopHocPhan để lấy IdLopHocPhanString mới nhất theo phiên và kiểm tra sĩ số trực tiếp
  const rawClasses = await fetchDanhSachLopHocPhan(
    item.maMonHoc,
    activeIdDot,
    item.maHocPhan,
    targetMaLHP
  );

  if (rawClasses === null) {
    const msg = "Chưa đăng nhập dkhp.iuh.edu.vn hoặc phiên hết hạn";
    _autoRegStatusByCourseId[item.id] = { state: "err", msg: "❌ Chưa đăng nhập" };
    updateAutoRegRowBadge(item.id);
    appendAutoRegLog(`${item.tenMonHoc}: ${msg}`, "err");
    return { ok: false, unauthenticated: true, retryable: false, msg };
  }

  const classList = Array.isArray(rawClasses)
    ? rawClasses
    : rawClasses.data || rawClasses.Data || [];

  // Lưu danh sách lớp thực tế vào cache để cập nhật sĩ số
  const classCacheKey = `${activeIdDot}_${item.maMonHoc || item.maHocPhan}`;
  if (classList.length > 0) {
    _lhpOpenClassesByCourse[classCacheKey] = classList;
    _lhpLastSiSoUpdatedAt[classCacheKey] = new Date().toLocaleTimeString("vi-VN");
    saveLhpPlannerState();
  }

  if (classList.length === 0) {
    const msg = "Cổng DKHP chưa mở lớp cho môn này";
    _autoRegStatusByCourseId[item.id] = {
      state: "wait",
      msg: "⏳ Chưa mở lớp (Đang chờ)",
    };
    updateAutoRegRowBadge(item.id);
    appendAutoRegLog(`${item.tenMonHoc}: ${msg}`, "warn");
    return { ok: false, retryable: true, msg };
  }

  let chosenCls = null;
  if (isSpecificLhpCode) {
    chosenCls = classList.find(
      (c) => String(c.MaLopHocPhan || "").trim() === targetMaLHP
    );
  }

  if (chosenCls) {
    updateAutoRegRowLiveMeta(item, chosenCls);
    if (!isClassOpenForRegistration(chosenCls)) {
      const siSo = Number(chosenCls.SiSoDangKy ?? 0);
      const toiDa = Number(chosenCls.SiSoToiDa ?? 0);
      const rawStatus = removeVietnameseTones(String(chosenCls.TrangThai || chosenCls.TrangThaiLopHocPhan || ""));
      const isLocked = rawStatus.includes("da khoa") || rawStatus.includes("tam khoa") || rawStatus.includes("huy");
      if (!autoPickOpenClass) {
        const msg = isLocked
          ? `Lớp ${targetMaLHP} đang khóa (${siSo}/${toiDa})`
          : `Lớp ${targetMaLHP} đã đầy (${siSo}/${toiDa})`;
        _autoRegStatusByCourseId[item.id] = {
          state: "wait",
          msg: isLocked ? `🔒 Khóa (${siSo}/${toiDa})` : `🎯 Đầy ${siSo}/${toiDa} (Chờ slot)`,
        };
        updateAutoRegRowBadge(item.id);
        appendAutoRegLog(`${item.tenMonHoc}: ${msg}`, "warn");
        return { ok: false, retryable: true, msg };
      }
      // Tự động tìm lớp khác còn chỗ và chưa khóa
      const altCls = classList.find((c) => isClassOpenForRegistration(c));
      if (altCls) {
        chosenCls = altCls;
        targetMaLHP = String(altCls.MaLopHocPhan || "");
        appendAutoRegLog(
          `${item.tenMonHoc}: Lớp cũ đầy/khóa, tự động chuyển sang lớp còn chỗ ${targetMaLHP} (${altCls.SiSoDangKy}/${altCls.SiSoToiDa})`,
          "warn"
        );
      }
    }
  } else if (autoPickOpenClass) {
    chosenCls = classList.find((c) => isClassOpenForRegistration(c)) || classList[0];
    if (chosenCls) {
      targetMaLHP = String(chosenCls.MaLopHocPhan || "");
      appendAutoRegLog(
        `${item.tenMonHoc}: Tự động chọn lớp mở ${targetMaLHP} (Sĩ số ${chosenCls.SiSoDangKy ?? 0}/${chosenCls.SiSoToiDa ?? "?"})`,
        "info"
      );
    }
  }

  if (!chosenCls || !chosenCls.IdLopHocPhanString) {
    const msg = isSpecificLhpCode
      ? `Không tìm thấy Mã LHP ${targetMaLHP} trên DKHP`
      : "Chưa chọn Mã LHP 12 số cụ thể";
    _autoRegStatusByCourseId[item.id] = { state: "err", msg: `❌ ${msg}` };
    updateAutoRegRowBadge(item.id);
    appendAutoRegLog(`${item.tenMonHoc}: ${msg}`, "err");
    return { ok: false, retryable: true, msg };
  }

  updateAutoRegRowLiveMeta(item, chosenCls);

  if (!isClassOpenForRegistration(chosenCls)) {
    const siSo = Number(chosenCls.SiSoDangKy ?? 0);
    const toiDa = Number(chosenCls.SiSoToiDa ?? 0);
    const rawStatus = removeVietnameseTones(String(chosenCls.TrangThai || chosenCls.TrangThaiLopHocPhan || ""));
    const isLocked = rawStatus.includes("da khoa") || rawStatus.includes("tam khoa") || rawStatus.includes("huy");
    const msg = isLocked
      ? `Lớp ${targetMaLHP} đang khóa (${siSo}/${toiDa})`
      : `Tất cả lớp của môn (${targetMaLHP}) hiện đã đầy (${siSo}/${toiDa})`;
    _autoRegStatusByCourseId[item.id] = {
      state: "wait",
      msg: isLocked ? `🔒 Khóa (${siSo}/${toiDa})` : `🎯 Đầy ${siSo}/${toiDa} (Canh slot)`,
    };
    updateAutoRegRowBadge(item.id);
    appendAutoRegLog(`${item.tenMonHoc}: ${msg}`, "warn");
    return { ok: false, retryable: true, msg };
  }

  const idEncrypted = String(chosenCls.IdLopHocPhanString);
  item.idEncrypted = idEncrypted;
  item.maLHP = targetMaLHP;
  if (chosenCls.LopDuKien) item.lopDuKien = chosenCls.LopDuKien;
  updateAutoRegRowLiveMeta(item, chosenCls);
  saveLhpPlannerState();

  // Kiểm tra chi tiết lớp để lấy danh sách các Tổ Thực hành khả dụng
  let availableGroups = [];
  if (item._noThConfirmed !== targetMaLHP) {
    try {
      const detail = await fetchChiTietLopHocPhan(idEncrypted, -1);
      if (detail && Array.isArray(detail.DSNhomThucHanh) && detail.DSNhomThucHanh.length > 0) {
        availableGroups = detail.DSNhomThucHanh.map((g) => Number(g.MaNhom || 1)).filter((n) => n > 0);
        if ((!nhomTH || nhomTH <= 0) && availableGroups.length > 0) {
          nhomTH = availableGroups[0];
          item.nhomTH = nhomTH;
          updateAutoRegRowLiveMeta(item, chosenCls);
          appendAutoRegLog(
            `${item.tenMonHoc}: Tự động chọn Tổ Thực hành ${nhomTH}`,
            "info"
          );
        }
      } else {
        item._noThConfirmed = targetMaLHP;
      }
    } catch (_) {}
  }

  // Danh sách Tổ TH cần thử theo thứ tự ưu tiên
  let groupsToTry = [nhomTH];
  if (availableGroups.length > 0 && autoPickOpenClass) {
    groupsToTry = [nhomTH, ...availableGroups.filter((g) => g !== nhomTH)];
  }

  let finalRes = null;
  for (let gIdx = 0; gIdx < groupsToTry.length; gIdx++) {
    const curGroup = groupsToTry[gIdx];

    // Bước kiểm tra địa điểm phòng học (tương đương dangkyHP() của trường)
    try {
      await checkKhacDiaDiemPhongBuoiHoc(idEncrypted, curGroup);
    } catch (_) {}

    _autoRegStatusByCourseId[item.id] = {
      state: "running",
      msg: `🚀 Đang gửi lệnh ĐK${curGroup > 0 ? ` (Tổ ${curGroup})` : ""}...`,
    };
    updateAutoRegRowBadge(item.id);

    // Gửi lệnh đăng ký chính thức lên /DangKyHocPhan/DangKyHocPhan
    const regRes = await dangKyLopHocPhanApi(
      idEncrypted,
      hinhThuc,
      activeIdDot,
      curGroup
    );

    const classification = classifyDkhpRegResponse(regRes, targetMaLHP);
    finalRes = classification;

    if (classification.ok) {
      if (curGroup > 0) item.nhomTH = curGroup;
      _autoRegStatusByCourseId[item.id] = {
        state: "ok",
        msg: `✅ Thành công (${targetMaLHP}${curGroup > 0 ? ` - T${curGroup}` : ""})`,
      };
      updateAutoRegRowBadge(item.id);
      appendAutoRegLog(
        `🎉 ${item.tenMonHoc}: Đăng ký thành công [${targetMaLHP}]${curGroup > 0 ? ` (Tổ ${curGroup})` : ""}!`,
        "ok"
      );
      return { ok: true, retryable: false, isCoReq: false, msg: classification.msg };
    }

    // Nếu lỗi do đầy/hết chỗ ở Tổ TH này và còn Tổ TH khác dự phòng -> xoay vòng thử tiếp
    if (classification.state === "wait" && gIdx < groupsToTry.length - 1) {
      appendAutoRegLog(
        `${item.tenMonHoc} [${targetMaLHP} - Tổ ${curGroup}]: ${classification.msg} -> Đang tự động thử tiếp Tổ ${groupsToTry[gIdx + 1]}...`,
        "warn"
      );
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    break;
  }

  _autoRegStatusByCourseId[item.id] = {
    state: finalRes.state,
    msg: `${finalRes.state === "ok" ? "✅" : finalRes.state === "wait" ? "⏳" : "❌"} ${finalRes.msg}`,
  };
  updateAutoRegRowBadge(item.id);
  appendAutoRegLog(
    `${item.tenMonHoc} [${targetMaLHP}]: ${finalRes.msg}`,
    finalRes.state === "ok" ? "ok" : finalRes.state === "wait" ? "warn" : "err"
  );
  return {
    ok: finalRes.ok,
    retryable: finalRes.retryable,
    isCoReq: finalRes.isCoReq,
    msg: finalRes.msg,
  };
}

async function runDashboardBatchAutoReg(isSniperTick = false) {
  if (_autoRegIsRunning) return;

  const activeIdDot = getActiveLhpDot();
  const hinhThucEl = document.getElementById("lhp-hinhthuc-select");
  const hinhThuc = hinhThucEl ? hinhThucEl.value : "1";
  const autoPickChk = document.getElementById("lhp-autoreg-autopick-chk");
  const autoPickOpenClass = autoPickChk ? autoPickChk.checked : true;

  const plannedList = _lhpPlannedByDot[activeIdDot] || [];
  const checkedIds = new Set(
    Array.from(document.querySelectorAll(".autoreg-item-chk:checked")).map((el) =>
      el.getAttribute("data-id")
    )
  );
  const targetItems = plannedList.filter((item) => checkedIds.has(item.id));

  if (targetItems.length === 0) {
    if (!isSniperTick) {
      appendAutoRegLog("⚠️ Vui lòng tích chọn ít nhất 1 môn học trong bảng để đăng ký.", "warn");
    }
    return;
  }

  _autoRegIsRunning = true;
  updateAutoRegButtonsUI();

  if (!isSniperTick) {
    appendAutoRegLog(
      `🚀 Bắt đầu tiến trình Đăng ký Siêu tốc cho ${targetItems.length} môn (${getDotTextById(activeIdDot)})...`,
      "info"
    );
  }

  let anySuccess = false;
  let remainingRetryable = 0;
  const failedWithCoReqItems = [];

  try {
    // 1. Kiểm tra trạng thái mở cổng: Mỗi tick sniper chỉ gửi 1 request nhẹ kiểm tra cổng thay vì spam hàng chục request
    const dotStatus = await checkDotChoPhepDangKy(activeIdDot);
    if (dotStatus && dotStatus.unauthenticated) {
      appendAutoRegLog(
        "🔐 Phiên đăng nhập dkhp.iuh.edu.vn đã hết hạn! Vui lòng đăng nhập lại.",
        "err"
      );
      stopDashboardSniperMode();
      return;
    }

    if (dotStatus && !dotStatus.allowed && dotStatus.message) {
      const lower = dotStatus.message.toLowerCase();
      // Nếu cổng chưa đến thời gian mở -> Giữ trạng thái sniper chờ đợi (Gate-Wait), không spam chi tiết từng môn
      if (lower.includes("thời gian") || lower.includes("chưa mở") || lower.includes("chưa đến giờ")) {
        appendAutoRegLog(
          `⏳ Cổng DKHP đợt ${getDotTextById(activeIdDot)} chưa mở: "${dotStatus.message}" — Đang trong chế độ Canh cổng, tiếp tục chờ...`,
          "warn"
        );
        return;
      }
    }

    // 2. Chạy Pass 1 cho các môn được chọn
    for (const item of targetItems) {
      if (_autoRegStatusByCourseId[item.id]?.state === "ok") continue;

      const res = await executeSingleCourseAutoReg(
        item,
        activeIdDot,
        hinhThuc,
        autoPickOpenClass
      );
      if (res.unauthenticated) {
        stopDashboardSniperMode();
        break;
      }
      if (res.ok) {
        anySuccess = true;
      } else {
        if (res.isCoReq) failedWithCoReqItems.push(item);
        if (res.retryable) remainingRetryable++;
      }
      if (dkhpShouldAbortSniper()) {
        appendAutoRegLog(
          _dkhpBlocked
            ? "🛑 Cổng DKHP chặn yêu cầu (WAF/403). Đã dừng tự động để bảo vệ phiên đăng nhập."
            : `🛑 ${DKHP_MAX_FAIL_STREAK} lần lỗi liên tiếp từ DKHP. Đã dừng tự động để bảo vệ phiên đăng nhập.`,
          "err"
        );
        stopDashboardSniperMode();
        break;
      }
      await new Promise((r) => setTimeout(r, 180));
    }

    // 3. Pass 2 (Song hành): Nếu có môn thành công và có môn trước đó bị lỗi do yêu cầu môn song hành -> Chạy lại ngay lập tức
    if (anySuccess && failedWithCoReqItems.length > 0) {
      appendAutoRegLog(
        `🔄 Có môn đã đăng ký thành công! Đang kích hoạt Lượt 2 (Pass 2) để tự động đăng ký lại các môn có ràng buộc Song hành...`,
        "info"
      );
      for (const coReqItem of failedWithCoReqItems) {
        if (_autoRegStatusByCourseId[coReqItem.id]?.state === "ok") continue;
        const res2 = await executeSingleCourseAutoReg(
          coReqItem,
          activeIdDot,
          hinhThuc,
          autoPickOpenClass
        );
        if (res2.ok) {
          anySuccess = true;
          remainingRetryable = Math.max(0, remainingRetryable - 1);
        }
        await new Promise((r) => setTimeout(r, 180));
      }
    }
  } finally {
    _autoRegIsRunning = false;
    updateAutoRegButtonsUI();
  }

  if (anySuccess) {
    appendAutoRegLog(
      "🔄 Có môn đăng ký thành công! Đang đồng bộ lại Thời khóa biểu chính thức từ DKHP...",
      "ok"
    );
    await loadLhpTab(true, activeIdDot);
    renderLhpAutoRegModalTable(activeIdDot);
  }

  if (_autoRegSniperTimerId && remainingRetryable === 0) {
    stopDashboardSniperMode();
    appendAutoRegLog(
      "🎉 Toàn bộ các môn được chọn đã xử lý hoàn tất! Tự động dừng chế độ Canh Slot.",
      "ok"
    );
  }
}

function stopDashboardSniperMode() {
  if (_autoRegSniperTimerId) {
    clearInterval(_autoRegSniperTimerId);
    _autoRegSniperTimerId = null;
  }
  if (_autoRegSniperCountdownId) {
    clearInterval(_autoRegSniperCountdownId);
    _autoRegSniperCountdownId = null;
  }
  _autoRegSniperRemainSec = 0;
  releaseSniperLock(DKHP_SNIPER_OWNER_DASHBOARD);
  updateAutoRegButtonsUI();
}

async function toggleDashboardSniperMode() {
  if (_sniperToggling) return;
  _sniperToggling = true;

  try {
    if (_autoRegSniperTimerId) {
      stopDashboardSniperMode();
      appendAutoRegLog("⏹️ Đã dừng chế độ Canh Slot / Tự động thử lại.", "warn");
      return;
    }

    const intervalSelect = document.getElementById("lhp-autoreg-interval-select");
    const intervalSec = Math.max(
      DKHP_SNIPER_MIN_SEC,
      parseInt(intervalSelect?.value || String(DKHP_SNIPER_MIN_SEC), 10) || DKHP_SNIPER_MIN_SEC
    );

    // Chỉ cho phép 1 sniper chạy tại một thời điểm (tránh chồng request lên cùng 1 session)
    const gotLock = await acquireSniperLock(DKHP_SNIPER_OWNER_DASHBOARD, intervalSec);
    if (!gotLock) {
      appendAutoRegLog(
        "⚠️ Đang có một Canh Slot khác chạy (trên trang DKHP). Hãy dừng nó trước khi bật ở đây.",
        "warn"
      );
      return;
    }
    dkhpResetGuards();
    _autoRegSniperRemainSec = intervalSec;

    appendAutoRegLog(
      `🎯 Đã kích hoạt Chế độ Canh Slot (Sniper Mode) — Tự động quét sĩ số & gửi lệnh ĐK mỗi ${intervalSec} giây!`,
      "ok"
    );

    _autoRegSniperCountdownId = setInterval(() => {
      if (_autoRegIsRunning) return;
      _autoRegSniperRemainSec = Math.max(1, _autoRegSniperRemainSec - 1);
      updateAutoRegButtonsUI();
    }, 1000);

    _autoRegSniperTimerId = setInterval(async () => {
      if (dkhpShouldAbortSniper()) {
        stopDashboardSniperMode();
        return;
      }
      _autoRegSniperRemainSec = intervalSec;
      updateAutoRegButtonsUI();
      heartbeatSniperLock(DKHP_SNIPER_OWNER_DASHBOARD);
      runDashboardBatchAutoReg(true);
    }, intervalSec * 1000);

    // Lượt đầu: chạy như lượt thường
    runDashboardBatchAutoReg(false);

    updateAutoRegButtonsUI();
  } finally {
    _sniperToggling = false;
  }
}
function openDkhpPortalWithAutoStart(mode = "api") {
  const activeIdDot = getActiveLhpDot();
  const hinhThucEl = document.getElementById("lhp-hinhthuc-select");
  const hinhThuc = hinhThucEl ? hinhThucEl.value : "1";
  const autoPickChk = document.getElementById("lhp-autoreg-autopick-chk");
  const autoPick = autoPickChk ? autoPickChk.checked : true;

  saveLhpPlannerState();
  chrome.storage.local.set(
    {
      iuh_lhp_selected_dot: activeIdDot,
      iuh_dkhp_autostart_pending: {
        active: true,
        mode, // 'api' | 'dom' | 'sniper'
        idDot: activeIdDot,
        hinhThuc,
        autoPick,
        timestamp: Date.now(),
      },
    },
    () => {
      appendAutoRegLog(
        `🌐 Đang mở trang https://dkhp.iuh.edu.vn/DangKyHocPhan (Chế độ: ${mode === "dom" ? "Tự động Click DOM" : "API Siêu tốc trên cổng"})...`,
        "info"
      );
      window.open("https://dkhp.iuh.edu.vn/DangKyHocPhan", "_blank");
    }
  );
}

function initLhpAutoRegModalControls() {
  if (_autoRegModalBound) return;
  const modal = document.getElementById("lhp-autoreg-modal");
  if (!modal) return;
  _autoRegModalBound = true;

  const closeBtn = document.getElementById("btn-close-autoreg-modal");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
  }

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.style.display = "none";
    }
  });

  const checkAll = document.getElementById("lhp-autoreg-check-all");
  if (checkAll) {
    checkAll.addEventListener("change", () => {
      document.querySelectorAll(".autoreg-item-chk").forEach((chk) => {
        chk.checked = checkAll.checked;
      });
    });
  }

  const btnRunNow = document.getElementById("btn-autoreg-run-now");
  if (btnRunNow) {
    btnRunNow.addEventListener("click", () => {
      runDashboardBatchAutoReg(false);
    });
  }

  const btnToggleSniper = document.getElementById("btn-autoreg-toggle-sniper");
  if (btnToggleSniper) {
    btnToggleSniper.addEventListener("click", () => {
      toggleDashboardSniperMode();
    });
  }

  const btnOpenPortalApi = document.getElementById("btn-autoreg-open-portal-api");
  if (btnOpenPortalApi) {
    btnOpenPortalApi.addEventListener("click", () => {
      openDkhpPortalWithAutoStart("api");
    });
  }

  const btnOpenPortalDom = document.getElementById("btn-autoreg-open-portal-dom");
  if (btnOpenPortalDom) {
    btnOpenPortalDom.addEventListener("click", () => {
      openDkhpPortalWithAutoStart("dom");
    });
  }

  const btnClearLog = document.getElementById("btn-autoreg-clear-log");
  if (btnClearLog) {
    btnClearLog.addEventListener("click", () => {
      const box = document.getElementById("lhp-autoreg-log-box");
      if (box) box.innerHTML = `<div style="color:#64748b;">Đã xóa nhật ký.</div>`;
    });
  }
}



