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
 * Ve bang Chuong trinh khung vao #ctk-table-body.
 */
function renderChuongTrinhKhung(data) {
  const tbody = document.getElementById("ctk-table-body");
  const summaryRequired = document.getElementById("ctk-summary-required");
  const summaryDone = document.getElementById("ctk-summary-done");
  if (!tbody) return;

  tbody.innerHTML = "";
  let totalSubjects = 0;
  let doneSubjects = 0;

  (data.ChuongTrinhHocKy || []).forEach((hocKy) => {
    const soHK = hocKy.HocKy || "?";
    const soTcHK = hocKy.SoTinChiHocKy || 0;

    const hkRow = document.createElement("tr");
    hkRow.innerHTML = `
      <td colspan="7" style="
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

    const bbList = hocKy.HocPhanBatBuoc || [];
    const tcList = hocKy.HocPhanTuChon || [];

    if (bbList.length > 0) {
      const groupRow = document.createElement("tr");
      groupRow.innerHTML = `<td colspan="7" style="background:rgba(255,255,255,0.05);padding:6px 16px;font-size:12px;color:var(--text-muted,#aaa);font-style:italic;font-weight:bold;">Học phần bắt buộc</td>`;
      tbody.appendChild(groupRow);
      bbList.forEach((hp, i) => {
        tbody.appendChild(buildHpRow(hp, i, true));
        totalSubjects++;
        if (hp.IsDat) doneSubjects++;
      });
    }

    if (tcList.length > 0) {
      const groupRow = document.createElement("tr");
      groupRow.innerHTML = `<td colspan="7" style="background:rgba(255,255,255,0.05);padding:6px 16px;font-size:12px;color:var(--text-muted,#aaa);font-style:italic;font-weight:bold;">Học phần tự chọn</td>`;
      tbody.appendChild(groupRow);
      tcList.forEach((hp, i) => {
        tbody.appendChild(buildHpRow(hp, i, false));
        totalSubjects++;
        if (hp.IsDat) doneSubjects++;
      });
    }
  });

  if (summaryRequired)
    summaryRequired.textContent = `Tổng yêu cầu: ${data.TongSoTCYeuCau || 0} TC`;
  if (summaryDone)
    summaryDone.textContent = `Đã đạt: ${doneSubjects}/${totalSubjects} môn`;
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

  const prerequisites = [
    hp.HocPhanTruoc ? `${hp.HocPhanTruoc} <span style="color:#f6ad55;font-size:11px">(a)</span>` : "",
    hp.HocPhanTienQuyet ? `${hp.HocPhanTienQuyet} <span style="color:#fc8181;font-size:11px">(b)</span>` : "",
    hp.HocPhanSongHanh ? `${hp.HocPhanSongHanh} <span style="color:#68d391;font-size:11px">(c)</span>` : "",
  ]
    .filter(Boolean)
    .join("<br>");

  let trangThaiBadge;
  if (isDat) {
    trangThaiBadge = `<span style="background:rgba(104,211,145,0.2);color:#68d391;padding:2px 7px;border-radius:99px;font-size:11px;">✅ Đã đạt</span>`;
  } else if (isDangDK) {
    trangThaiBadge = `<span style="background:rgba(99,179,237,0.2);color:#63b3ed;padding:2px 7px;border-radius:99px;font-size:11px;">Đang học</span>`;
  } else {
    trangThaiBadge = `<span style="background:rgba(160,174,192,0.15);color:#718096;padding:2px 7px;border-radius:99px;font-size:11px;">Chưa học</span>`;
  }

  const tenMH = hp.KhongTinhDiemTBC
    ? `${hp.TenMonHoc} <span style="color:#fc8181;font-weight:700">*</span>`
    : (hp.TenMonHoc || "");

  tr.innerHTML = `
    <td class="text-center" style="color:var(--text-muted);font-size:12px;">${index + 1}</td>
    <td style="font-family:monospace;font-size:12px;">${hp.MaMonHoc || ""}</td>
    <td style="text-align:left;padding-left:12px;">${tenMH}</td>
    <td style="font-family:monospace;font-size:11px;color:var(--text-muted);">${hp.MaHocPhan || ""}</td>
    <td class="text-center" style="font-weight:600;">${hp.DVHT || ""}</td>
    <td style="font-size:12px;color:var(--text-muted);">${prerequisites}</td>
    <td class="text-center">${trangThaiBadge}</td>`;

  return tr;
}

// =============================================================================
// TAB CONTROLLER
// =============================================================================

let _ctkCache = null;

async function loadCtkTab(forceRefresh = false) {
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

/** Lấy danh sách lớp học phần đã ĐK trong học kỳ này */
async function fetchLopHocPhanDaDangKy() {
  // Bước 1: Gọi trang chủ DKHP để scrape tham số `idDot`
  let idDot = "";
  try {
    const htmlRes = await fetch(`${DKHP_BASE}/DangKyHocPhan`, { credentials: "include" });
    if (!htmlRes.ok) throw new Error("GET /DangKyHocPhan failed");
    const htmlText = await htmlRes.text();
    
    if (htmlText.includes("frmLogin")) {
      console.warn("[DKHP] Trang DKHP yêu cầu đăng nhập.");
      return null;
    }

    // Scrape idDot từ <select id="ddk">...<option value="66" selected>...</option>
    // Server select sẵn option của đợt hiện tại
    const ddkMatch = htmlText.match(/<select[^>]*id="ddk"[^>]*>([\s\S]*?)<\/select>/i);
    if (ddkMatch) {
      const optionsHtml = ddkMatch[1];
      const optionMatches = [...optionsHtml.matchAll(/<option[^>]+value="([^"]+)"[^>]*>/gi)];
      
      const selectedOpt = optionMatches.find(m => m[0].toLowerCase().includes('selected'));
      if (selectedOpt) {
        idDot = selectedOpt[1];
      } else if (optionMatches.length > 0) {
        idDot = optionMatches[0][1];
      }
    }
    console.log("[DKHP] Đã lấy idDot từ HTML:", idDot);
  } catch (e) {
    console.warn("[DKHP] Lỗi scrape HTML ĐKHP:", e);
  }

  // Bước 2: Gọi API với idDot (tham số bắt buộc để server khỏi quăng 500)
  const body = idDot ? `idDot=${encodeURIComponent(idDot)}` : "";
  return _dkhpPost("/DangKyHocPhan/GetDanhSachLopHocPhanDaDangKy", body);
}

/** Lấy chi tiết lịch học của 1 lớp. */
async function fetchChiTietLopHocPhan(idLHPEncrypted, maNhomTH) {
  const body = `idLopHocPhan=${encodeURIComponent(idLHPEncrypted)}&maNhomTH=${encodeURIComponent(maNhomTH)}`;
  return _dkhpPost("/DangKyHocPhan/GetChiTietLopHocPhan", body);
}

/** Render bảng Lớp học phần đã đăng ký */
function renderLopHocPhanDaDangKy(data) {
  const tbody = document.getElementById("lhp-table-body");
  const summary = document.getElementById("lhp-summary");
  if (!tbody) return;

  const rows = Array.isArray(data) ? data : (data.data || data.Data || []);
  tbody.innerHTML = "";

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">Không có lớp học phần nào đã đăng ký.</td></tr>`;
    // Xóa calendar nếu trống
    const calContainer = document.getElementById("lhp-calendar-container");
    if (calContainer) calContainer.innerHTML = "";
    return;
  }

  // Cố gắng đoán tên trường nếu nó bị obfuscate đổi tên
  let tongTC = 0;
  rows.forEach((row, i) => {
    // Dùng heuristics cho các trường bị thiếu
    const tenMon = row.TenMonHoc || row.TenHocPhan || Object.values(row).find(v => typeof v === 'string' && (v.toLowerCase().includes('nhập môn') || v.includes('Web'))) || "";
    const maLHP = row.MaLHP || row.MaLopHocPhan || row.MaLop || Object.values(row).find(v => typeof v === 'string' && /^\d{10,}$/.test(v)) || "";
    const lhpDuKien = row.LopHocDuKien || row.LopDuKien || row.TenLopXepLich || row.MaLopXepLich || Object.values(row).find(v => typeof v === 'string' && /^DH[A-Z0-9]+$/.test(v)) || "";
    const soTC = row.SoTC || row.DVHT || row.TinChi || row.SoTinChi || Object.values(row).find(v => typeof v === 'number' && v > 0 && v < 10) || "";
    const nhomTH = row.NhomTH || row.NhomThucHanh || "";
    const ngayDK = row.NgayDK || row.NgayDangKy || "";
    const trangThaiLHP = row.TrangThaiLHP || row.TrangThaiLopHocPhan || row.TenTrangThaiLHP || "";
    const hocPhi = row.HocPhi || Object.values(row).find(v => typeof v === 'number' && v > 1000000) || "";

    tongTC += parseInt(soTC || 0);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:center;">${i + 1}</td>
      <td style="font-family:monospace;font-size:12px;">${maLHP}</td>
      <td style="text-align:left;padding-left:10px;">${tenMon}</td>
      <td style="text-align:left;font-size:12px;">${lhpDuKien}</td>
      <td style="text-align:center;font-weight:600;">${soTC}</td>
      <td style="text-align:center;">${nhomTH}</td>
      <td style="text-align:right;font-size:12px;">${hocPhi ? Number(hocPhi).toLocaleString("vi-VN") : ""}</td>
      <td style="font-size:12px;">${ngayDK}</td>
      <td style="font-size:12px;">${trangThaiLHP}</td>`;
    tbody.appendChild(tr);
  });

  if (summary) summary.textContent = `${rows.length} môn — ${tongTC} tín chỉ`;

  // Render Calendar UI
  renderLhpCalendar(rows);
}

// =============================================================================
// LHP — CALENDAR UI
// =============================================================================

async function renderLhpCalendar(courses) {
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
    <div id="lhp-calendar-loading" style="text-align:center; padding: 20px; font-size: 14px; color: var(--text-muted);">
      ⏳ Đang tải chi tiết lịch học...
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

  const colors = ["#4285F4", "#DB4437", "#F4B400", "#0F9D58", "#AB47BC", "#00ACC1", "#FF7043", "#8D6E63"];
  
  // Lấy chi tiết song song cho tất cả môn
  const promises = courses.map(async (row, i) => {
    // Tìm ID
    const idEncrypted = row.IDLopHocPhanEncrypted || row.Id || row.IDLopHocPhan || Object.values(row).find(v => typeof v === 'string' && v.endsWith('==') && v.length > 10) || "";
    if (!idEncrypted) return null;

    const maNhomTH = row.NhomTH || row.NhomThucHanh || Object.values(row).find(v => typeof v === 'number' && v < 10) || 0;
    const tenMon = row.TenMonHoc || row.TenHocPhan || Object.values(row).find(v => typeof v === 'string' && (v.toLowerCase().includes('nhập môn') || v.includes('Web'))) || "(Không tên)";

    try {
      const detailData = await fetchChiTietLopHocPhan(idEncrypted, maNhomTH);
      if (!detailData) return null;
      const schedules = Array.isArray(detailData) ? detailData : (detailData.data || detailData.Data || []);
      
      return schedules.map(sched => {
        // Tìm lịch học, phòng, giảng viên
        const lichHoc = sched.LichHoc || Object.values(sched).find(v => typeof v === 'string' && v.includes('Thứ')) || "";
        const phong = sched.Phong || sched.MaPhong || Object.values(sched).find(v => typeof v === 'string' && v.match(/^[A-Z]\d{2}\.\d{2}$/)) || "";
        const giangVien = sched.GiangVien || sched.TenGiangVien || "";

        if (!lichHoc) return null;
        
        // Parse: "Thứ 2 (T1-T3)" hoặc "Thứ 4 (7-9)"
        const match = lichHoc.match(/Thứ\s*(\d+)\s*\([T]?(\d+)\s*-\s*[T]?(\d+)\)/i) || lichHoc.match(/T(\d+)\s*\([T]?(\d+)\s*-\s*[T]?(\d+)\)/i);
        if (match) {
          const thu = parseInt(match[1]); // 2 -> 8 (Chủ nhật)
          const start = parseInt(match[2]);
          const end = parseInt(match[3]);
          const col = thu === 8 ? 8 : (thu === 1 ? 8 : thu); // Xử lý CN
          
          return { col, start, end, tenMon, phong, giangVien, color: colors[i % colors.length] };
        }
        return null;
      }).filter(Boolean);
    } catch (e) {
      console.warn("[DKHP] Lỗi lấy lịch học môn:", tenMon, e);
      return null;
    }
  });

  const allSchedules = (await Promise.all(promises)).flat().filter(Boolean);

  // Xóa loading text
  const loading = document.getElementById("lhp-calendar-loading");
  if (loading) loading.remove();

  // Vẽ các block sự kiện lên grid
  allSchedules.forEach(ev => {
    const block = document.createElement("div");
    // grid-column: ev.col; grid-row: start+1 / end+2
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
    block.title = `${ev.tenMon}\nPhòng: ${ev.phong}\nGV: ${ev.giangVien}\nTiết: ${ev.start}-${ev.end}`;
    
    block.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.2;">${ev.tenMon}</div>
      <div style="font-size: 10px; opacity: 0.9;">📍 ${ev.phong}</div>
      <div style="font-size: 10px; opacity: 0.9;">👨‍🏫 ${ev.giangVien}</div>
    `;
    
    grid.appendChild(block);
  });

  if (allSchedules.length === 0) {
    container.innerHTML += `<div style="text-align:center; padding: 20px; font-size: 14px; color: var(--text-muted);">Không tìm thấy dữ liệu lịch học hoặc môn học học online/chưa xếp lịch.</div>`;
  }
}

// =============================================================================
// LHP — TAB CONTROLLER
// =============================================================================

let _lhpCache = null;

async function loadLhpTab(forceRefresh = false) {
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

  if (!forceRefresh) {
    if (_lhpCache) {
      showOnly(tableSectionEl);
      renderLopHocPhanDaDangKy(_lhpCache);
      return;
    }
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(["iuh_lhp_data"], resolve)
    );
    if (stored.iuh_lhp_data) {
      _lhpCache = stored.iuh_lhp_data;
      showOnly(tableSectionEl);
      renderLopHocPhanDaDangKy(_lhpCache);
      return;
    }
  }

  showOnly(loadingEl);

  try {
    const data = await fetchLopHocPhanDaDangKy();

    if (data === null) {
      if (_lhpCache) {
        alert("Lỗi xác thực: Vui lòng đăng nhập trang DKHP để tải dữ liệu mới nhất.");
        showOnly(tableSectionEl);
      } else {
        showOnly(authGateEl);
      }
      return;
    }

    _lhpCache = data;
    chrome.storage.local.set({ iuh_lhp_data: data });
    showOnly(tableSectionEl);
    renderLopHocPhanDaDangKy(data);
  } catch (err) {
    console.error("[DKHP] Lỗi fetch LHP:", err);
    if (_lhpCache) {
      alert("Lỗi mạng: Không thể lấy dữ liệu mới.");
      showOnly(tableSectionEl);
    } else {
      showOnly(authGateEl);
    }
  }
}

