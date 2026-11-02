// dkhp-api.js
// Module fetch du lieu tu dkhp.iuh.edu.vn (session-based, khong Ghost Tab).

const DKHP_BASE = "https://dkhp.iuh.edu.vn";

// =============================================================================
// FETCH LAYER
// =============================================================================

/**
 * Fetch Chuong trinh khung tu dkhp.iuh.edu.vn.
 * Returns JSON object if ok, null if not authenticated, throws on network error.
 */
async function fetchChuongTrinhKhung() {
  const res = await fetch(`${DKHP_BASE}/ChuongTrinhKhung/GetChuongTrinhKhung`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: "",
  });

  if (!res.ok) {
    console.warn("[DKHP] HTTP error:", res.status, res.statusText);
    return null;
  }

  // Doc response dang text truoc vi server co the tra JSON voi content-type text/html
  const text = await res.text();

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

function renderCourseCodeBadge(code, type) {
  const meta = CTK_TYPE_META[type] || { color: "#a0aec0", label: type };
  const safeCode = escapeHtml(String(code).trim());
  return `<span class="ctk-code-badge" data-ctk-code="${safeCode}" data-ctk-rel="${escapeHtml(meta.label)}">${safeCode} <span style="color:${meta.color};font-size:11px;font-weight:700">(${type})</span></span>`;
}

function renderPrerequisitesHtml(hp) {
  const parts = [];
  const addGroup = (raw, type) => {
    if (!raw) return;
    const codes = extractCourseCodes(raw);
    if (codes.length > 0) {
      codes.forEach((c) => parts.push(renderCourseCodeBadge(c, type)));
    } else {
      const meta = CTK_TYPE_META[type];
      parts.push(
        `<span class="ctk-code-badge" data-ctk-code="${escapeHtml(String(raw).trim())}">${escapeHtml(String(raw).trim())} <span style="color:${meta.color};font-size:11px;font-weight:700">(${type})</span></span>`
      );
    }
  };
  addGroup(hp.HocPhanTruoc, "a");
  addGroup(hp.HocPhanTienQuyet, "b");
  addGroup(hp.HocPhanSongHanh, "c");
  return parts.join(" ");
}

function renderReverseDepsHtml(hp) {
  const deps = getReverseDepsForCourse(hp);
  if (deps.length === 0) return "";
  return deps.map((d) => renderCourseCodeBadge(d.code, d.type)).join(" ");
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
  const codeKey = maMH || maHP;

  tr.innerHTML = `
    <td class="text-center" style="color:var(--text-muted);font-size:12px;">${index + 1}</td>
    <td style="font-family:monospace;font-size:12px;"><span class="ctk-code-cell" data-ctk-code="${codeKey}">${maMH}</span></td>
    <td style="text-align:left;padding-left:12px;">${tenMH}</td>
    <td style="font-family:monospace;font-size:11px;color:var(--text-muted);"><span class="ctk-code-cell" data-ctk-code="${codeKey}">${maHP}</span></td>
    <td class="text-center" style="font-weight:600;">${hp.DVHT ?? ""}</td>
    <td style="font-size:12px;color:var(--text-muted);">${prerequisites}</td>
    <td style="font-size:12px;color:var(--text-muted);">${reverseDeps}</td>
    <td class="text-center">${trangThaiBadge}</td>`;

  return tr;
}

// =============================================================================
// HOVER (1.5s) POPUP TOOLTIP CHO MA HOC PHAN / MA MON HOC
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
      .ctk-code-badge:hover {
        background: rgba(99, 179, 237, 0.16);
        border-color: var(--primary, #4a90e2);
      }
      .ctk-code-cell {
        cursor: help;
        border-bottom: 1px dashed rgba(160, 174, 192, 0.35);
        padding-bottom: 1px;
        transition: color 0.2s, border-color 0.2s;
      }
      .ctk-code-cell:hover {
        color: var(--primary, #4a90e2);
        border-bottom-color: var(--primary, #4a90e2);
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
    const target = e.target.closest("[data-ctk-code]");
    if (!target || target !== _ctkActiveHoverEl) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;

    if (_ctkHoverTimer) {
      clearTimeout(_ctkHoverTimer);
      _ctkHoverTimer = null;
    }
    target.classList.remove("ctk-code-pending");
    _ctkActiveHoverEl = null;

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

    const prereqHtml = renderPrerequisitesHtml(hp) || `<span style="color:var(--text-muted)">—</span>`;
    const reverseHtml = renderReverseDepsHtml(hp) || `<span style="color:var(--text-muted)">—</span>`;
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

async function _dkhpPost(path, body = "") {
  const url = `${DKHP_BASE}${path}`;
  console.log("[DKHP] POST →", url, "| body:", body || "(empty)");

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
  } catch (networkErr) {
    console.error("[DKHP] Lỗi mạng (CORS hoặc mất kết nối):", networkErr);
    return null;
  }

  console.log("[DKHP] HTTP", res.status, res.statusText, "| content-type:", res.headers.get("content-type"));

  const text = await res.text();
  console.log("[DKHP] Response body (400 ký tự đầu):", text.substring(0, 400));

  if (!res.ok) {
    console.warn("[DKHP] HTTP error:", res.status, "— body logged above");
    return null;
  }

  if (text.includes("<!DOCTYPE") || text.includes("<html") || text.includes("frmLogin")) {
    console.warn("[DKHP] Server trả HTML (trang login) — chưa đăng nhập hoặc session hết hạn.");
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("[DKHP] Không parse được JSON:", e);
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

const LHP_COLORS = [
  "#4285F4",
  "#DB4437",
  "#F4B400",
  "#0F9D58",
  "#AB47BC",
  "#00ACC1",
  "#FF7043",
  "#8D6E63",
];

/**
 * Tải tuần tự toàn bộ dữ liệu LHP + Chi tiết lịch học cho 1 đợt đăng ký (idDot).
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

      const parsedSchedules = schedules
        .map((sched) => {
          const lichHoc = sched.LichHoc || "";
          const phong = sched.Phong || "";
          const giangVien = sched.GiangVien || "";

          if (!lichHoc) return null;

          const match = lichHoc.match(
            /Thứ\s*(\d+)\s*\(\s*T?(\d+)\s*-+>?\s*T?(\d+)\s*\)/i
          );
          if (match) {
            const thu = parseInt(match[1]);
            const start = parseInt(match[2]);
            const end = parseInt(match[3]);
            const col = thu;

            return {
              col,
              start,
              end,
              tenMon,
              phong,
              giangVien,
              color: LHP_COLORS[i % LHP_COLORS.length],
              isLT: sched.IsLyThuyet,
            };
          }
          return null;
        })
        .filter(Boolean);

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

/** Render bảng Lớp học phần đã đăng ký + Lịch học tuần (từ cache hoặc kết quả vừa tải, KHÔNG phát sinh request ngầm) */
function renderLopHocPhanDaDangKy(data) {
  const tbody = document.getElementById("lhp-table-body");
  const summary = document.getElementById("lhp-summary");
  if (!tbody) return;

  const isBundled =
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray(data.rows);
  const rows = isBundled
    ? data.rows
    : Array.isArray(data)
    ? data
    : data?.data || data?.Data || [];
  const schedules = isBundled ? data.schedules : null;

  tbody.innerHTML = "";

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">Không có lớp học phần nào đã đăng ký trong học kỳ này.</td></tr>`;
    if (summary) summary.textContent = "0 môn — 0 tín chỉ";
    const calContainer = document.getElementById("lhp-calendar-container");
    if (calContainer) calContainer.innerHTML = "";
    return;
  }

  let tongTC = 0;
  rows.forEach((row, i) => {
    const soTC = row.SoTinChi || row.SoTC || row.DVHT || 0;
    tongTC += parseInt(soTC || 0);

    // Parse .NET /Date(...)/ format
    let ngayDK = "";
    const rawDate = row.NgayDangKy || row.NgayDK || "";
    if (typeof rawDate === "string") {
      const dateMatch = rawDate.match(/\/Date\((\d+)\)\//);
      if (dateMatch) {
        const d = new Date(parseInt(dateMatch[1]));
        ngayDK = `${String(d.getDate()).padStart(2, "0")}/${String(
          d.getMonth() + 1
        ).padStart(2, "0")}/${d.getFullYear()}`;
      } else {
        ngayDK = rawDate;
      }
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:center;">${i + 1}</td>
      <td style="font-family:monospace;font-size:12px;">${row.MaLopHocPhan || row.MaLHP || ""}</td>
      <td style="text-align:left;padding-left:10px;">${row.TenMonHoc || ""}</td>
      <td style="text-align:left;font-size:12px;">${row.LopDuKien || row.LopHocDuKien || ""}</td>
      <td style="text-align:center;font-weight:600;">${soTC}</td>
      <td style="text-align:center;">${row.MaNhomThucHanh != null ? row.MaNhomThucHanh : ""}</td>
      <td style="text-align:right;font-size:12px;">${row.HocPhi ? Number(row.HocPhi).toLocaleString("vi-VN") : ""}</td>
      <td style="font-size:12px;">${ngayDK}</td>
      <td style="font-size:12px;">${row.TrangThaiLopHocPhan || row.TrangThaiLHP || ""}</td>`;
    tbody.appendChild(tr);
  });

  if (summary) summary.textContent = `${rows.length} môn — ${tongTC} tín chỉ`;

  // Render Calendar UI từ dữ liệu đã có (không tự động gọi API ngầm)
  renderLhpCalendar(schedules);
}

// =============================================================================
// LHP — CALENDAR UI
// =============================================================================

function renderLhpCalendar(allSchedules) {
  const container = document.getElementById("lhp-calendar-container");
  if (!container) return;

  container.innerHTML = `
    <h3 style="margin: 0 0 16px 4px; font-size: 16px; color: var(--text-main);">Lịch học tuần</h3>
    <div id="lhp-calendar-grid" style="
      display: grid;
      grid-template-columns: 50px repeat(7, 1fr);
      grid-template-rows: 30px repeat(15, 40px);
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

  const grid = document.getElementById("lhp-calendar-grid");

  // Vẽ các ô lưới background (15 tiết x 7 ngày + 1 cột giờ)
  for (let t = 1; t <= 15; t++) {
    const timeCell = document.createElement("div");
    timeCell.style.cssText = `background: var(--bg-surface); grid-column: 1; grid-row: ${t + 1}; display: flex; align-items: center; justify-content: center; font-weight: 500; color: var(--text-muted); border-right: 1px solid var(--border-color);`;
    timeCell.textContent = `T${t}`;
    grid.appendChild(timeCell);

    for (let d = 2; d <= 8; d++) {
      const cell = document.createElement("div");
      cell.style.cssText = `background: var(--bg-card); grid-column: ${d}; grid-row: ${t + 1};`;
      grid.appendChild(cell);
    }
  }

  // Nếu dữ liệu cache từ phiên bản cũ chưa có schedules, nhắc bấm Tải lại
  if (!Array.isArray(allSchedules)) {
    container.innerHTML += `<div style="text-align:center; padding: 16px; font-size: 13px; color: var(--text-muted);">💡 Nhấn <b>"🔄 Tải lại"</b> ở góc phải trên để tải chi tiết thời khóa biểu cho học kỳ này.</div>`;
    return;
  }

  // Vẽ các block sự kiện lên grid
  allSchedules.forEach((ev) => {
    const block = document.createElement("div");
    block.style.cssText = `
      grid-column: ${ev.col};
      grid-row: ${ev.start + 1} / ${ev.end + 2};
      background: ${ev.color};
      color: #fff;
      margin: 2px;
      border-radius: 6px;
      padding: 6px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      z-index: 10;
    `;
    const loai = ev.isLT ? "LT" : "TH";
    block.title = `${ev.tenMon} (${loai})\nPhòng: ${ev.phong}\nGV: ${ev.giangVien}\nTiết: ${ev.start}-${ev.end}`;

    block.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.2; font-size: 11px;">${ev.tenMon}</div>
      <div style="font-size: 10px; opacity: 0.85;">📍 ${ev.phong}</div>
      <div style="font-size: 10px; opacity: 0.85; margin-top: 1px;">${loai === "TH" ? "🔬" : "📖"} ${loai}</div>
    `;

    grid.appendChild(block);
  });

  if (allSchedules.length === 0) {
    container.innerHTML += `<div style="text-align:center; padding: 20px; font-size: 14px; color: var(--text-muted);">Không tìm thấy dữ liệu lịch học hoặc môn học học online/chưa xếp lịch.</div>`;
  }
}

// =============================================================================
// LHP — TAB CONTROLLER & SEMESTER SELECTOR
// =============================================================================

let _lhpDotsCache = null;
let _lhpDataByDotCache = {};
let _lhpSelectBound = false;
let _isFetchingLhp = false;

function initLhpSemesterSelect() {
  if (_lhpSelectBound) return;
  const selectEl = document.getElementById("lhp-semester-select");
  if (!selectEl) return;
  _lhpSelectBound = true;

  selectEl.addEventListener("change", () => {
    const selectedDot = selectEl.value;
    if (selectedDot) {
      chrome.storage.local.set({ iuh_lhp_selected_dot: selectedDot });
      // Chỉ hiển thị cache nếu có, không tự động bắn request khi đổi học kỳ để bảo vệ session
      loadLhpTab(false, selectedDot);
    }
  });
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

function renderEmptyPromptForUnfetchedDot(dotText) {
  const tbody = document.getElementById("lhp-table-body");
  const summary = document.getElementById("lhp-summary");
  const calContainer = document.getElementById("lhp-calendar-container");

  if (summary) summary.textContent = `Chưa tải dữ liệu (${dotText})`;
  if (calContainer) {
    calContainer.innerHTML = `
      <div style="text-align: center; padding: 36px 20px; background: var(--bg-card); border: 1px dashed var(--border-color); border-radius: 10px;">
        <p style="font-size: 32px; margin: 0 0 10px 0;">📅</p>
        <p style="font-size: 15px; font-weight: 600; color: var(--text-main); margin: 0 0 6px 0;">
          Chưa có dữ liệu lưu sẵn cho học kỳ <span style="color: var(--primary);">${escapeHtml(dotText)}</span>
        </p>
        <p style="font-size: 13px; color: var(--text-muted); margin: 0;">
          Hãy kiểm tra đúng học kỳ cần xem ở menu phía trên và nhấn nút <b>"🔄 Tải lại"</b> để lấy dữ liệu từ DKHP.
        </p>
      </div>
    `;
  }
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:28px;color:var(--text-muted);">Nhấn <b>"🔄 Tải lại"</b> để tải danh sách môn học của ${escapeHtml(dotText)}.</td></tr>`;
  }
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

  // 1. Khởi tạo danh sách đợt đăng ký cố định (không gọi GET /DangKyHocPhan)
  if (!_lhpDotsCache) {
    _lhpDotsCache = getDanhSachDotDangKy();
  }

  // 2. Đọc dữ liệu đã lưu trong chrome.storage.local
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(
      ["iuh_lhp_selected_dot", "iuh_lhp_data_by_dot"],
      resolve
    )
  );
  if (stored.iuh_lhp_data_by_dot) {
    _lhpDataByDotCache = {
      ...stored.iuh_lhp_data_by_dot,
      ..._lhpDataByDotCache,
    };
  }

  // 3. Xác định activeIdDot:
  let activeIdDot = targetIdDot;
  if (!activeIdDot) {
    if (
      stored.iuh_lhp_selected_dot &&
      _lhpDotsCache.some(
        (d) => String(d.value) === String(stored.iuh_lhp_selected_dot)
      )
    ) {
      activeIdDot = String(stored.iuh_lhp_selected_dot);
    } else if (
      selectEl &&
      selectEl.value &&
      _lhpDotsCache.some((d) => String(d.value) === String(selectEl.value))
    ) {
      activeIdDot = String(selectEl.value);
    } else {
      // Mặc định chọn HK1 (2026 - 2027) (idDot = 64) hoặc đợt có sẵn dữ liệu gần nhất
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

  // 4. Nếu KHÔNG phải người dùng chủ động bấm "Tải lại" (!forceRefresh):
  // Chỉ hiển thị từ cache (0 network request!), tránh tự động gọi API khi mở tab / đổi dropdown
  if (!forceRefresh) {
    showOnly(tableSectionEl);
    if (_lhpDataByDotCache[activeIdDot]) {
      renderLopHocPhanDaDangKy(_lhpDataByDotCache[activeIdDot]);
    } else {
      renderEmptyPromptForUnfetchedDot(dotText);
    }
    return;
  }

  // 5. Khi người dùng bấm "🔄 Tải lại" (forceRefresh = true):
  // Khóa mutex để không cho phép gọi chồng chéo làm văng session ASP.NET
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
      if (_lhpDataByDotCache[activeIdDot]) {
        alert(
          "Lỗi xác thực: Vui lòng đăng nhập trang DKHP để tải dữ liệu mới nhất."
        );
        showOnly(tableSectionEl);
        renderLopHocPhanDaDangKy(_lhpDataByDotCache[activeIdDot]);
      } else {
        showOnly(authGateEl);
      }
      return;
    }

    _lhpDataByDotCache[activeIdDot] = bundledData;
    chrome.storage.local.set({
      iuh_lhp_data_by_dot: _lhpDataByDotCache,
      iuh_lhp_data: bundledData.rows, // Giữ tương thích ngược
    });

    showOnly(tableSectionEl);
    renderLopHocPhanDaDangKy(bundledData);
  } catch (err) {
    console.error("[DKHP] Lỗi fetch LHP cho đợt", activeIdDot, err);
    if (_lhpDataByDotCache[activeIdDot]) {
      alert("Lỗi mạng: Không thể lấy dữ liệu mới.");
      showOnly(tableSectionEl);
      renderLopHocPhanDaDangKy(_lhpDataByDotCache[activeIdDot]);
    } else {
      showOnly(authGateEl);
    }
  } finally {
    _isFetchingLhp = false;
    if (refreshBtn) refreshBtn.disabled = false;
    if (selectEl) selectEl.disabled = false;
  }
}

