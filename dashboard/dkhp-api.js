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
  const res = await fetch(`${DKHP_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      // jQuery $.ajax tự gửi header này, ASP.NET MVC dùng để nhận biết AJAX request
      // Nếu thiếu, server sẽ redirect về trang login thay vì trả JSON
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.includes("<!DOCTYPE") || text.includes("<html") || text.includes("frmLogin")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Lấy danh sách lớp học phần đã ĐK trong học kỳ này */
async function fetchLopHocPhanDaDangKy() {
  return _dkhpPost("/DangKyHocPhan/GetDanhSachLopHocPhanDaDangKy");
}

/** Lấy chi tiết lịch học của 1 lớp. idLHP là giá trị encrypted trả về từ danh sách */
async function fetchChiTietLopHocPhan(idLHPEncrypted) {
  return _dkhpPost(
    "/DangKyHocPhan/GetChiTietLopHocPhan",
    `IDLopHocPhan=${encodeURIComponent(idLHPEncrypted)}`
  );
}

// =============================================================================
// LHP — RENDER LAYER
// =============================================================================

/** Xây một dropdown ··· cho mỗi dòng môn học */
function buildThaoTacCell(row, index) {
  const idEncrypted = row.IDLopHocPhanEncrypted || row.IDLopHocPhan || "";
  const tenMon = (row.TenMonHoc || "").replace(/'/g, "\\'");
  const maLHP = row.MaLHP || "";
  const canHuy = !!row.ChoPhepHuyDK; // server gửi flag này khi còn trong thời hạn hủy

  const huyBtn = canHuy
    ? `<button class="lhp-btn-huy" data-id="${idEncrypted}" data-ten="${tenMon}" data-malHP="${maLHP}">Hủy đăng ký</button>`
    : "";

  return `
    <div class="lhp-dropdown" id="lhp-dd-${index}">
      <button class="lhp-dd-trigger" onclick="toggleLhpDropdown('lhp-dd-${index}')">···</button>
      <div class="lhp-dd-menu" style="display:none;">
        <button class="lhp-btn-xem" data-id="${idEncrypted}">Xem</button>
        ${huyBtn}
      </div>
    </div>`;
}

/** Render bảng Lớp học phần đã đăng ký */
function renderLopHocPhanDaDangKy(data) {
  const tbody = document.getElementById("lhp-table-body");
  const summary = document.getElementById("lhp-summary");
  if (!tbody) return;

  const rows = Array.isArray(data) ? data : (data.data || data.Data || []);
  tbody.innerHTML = "";

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted);">Không có lớp học phần nào đã đăng ký.</td></tr>`;
    return;
  }

  const tongTC = rows.reduce((s, r) => s + (parseInt(r.SoTC || r.DVHT || 0)), 0);
  if (summary) summary.textContent = `${rows.length} môn — ${tongTC} tín chỉ`;

  rows.forEach((row, i) => {
    const trangThaiLHP = row.TrangThaiLHP || row.TenTrangThaiLHP || "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:center;padding:4px 8px;">${buildThaoTacCell(row, i)}</td>
      <td style="text-align:center;">${i + 1}</td>
      <td style="font-family:monospace;font-size:12px;">${row.MaLHP || ""}</td>
      <td style="text-align:left;padding-left:10px;">${row.TenMonHoc || ""}</td>
      <td style="text-align:left;font-size:12px;">${row.LopHocDuKien || ""}</td>
      <td style="text-align:center;font-weight:600;">${row.SoTC || row.DVHT || ""}</td>
      <td style="text-align:center;">${row.NhomTH || ""}</td>
      <td style="text-align:right;font-size:12px;">${row.HocPhi ? Number(row.HocPhi).toLocaleString("vi-VN") : ""}</td>
      <td style="font-size:12px;">${row.NgayDK || ""}</td>
      <td style="font-size:12px;">${trangThaiLHP}</td>`;
    tbody.appendChild(tr);
  });

  // Gắn sự kiện Xem và Hủy sau khi render xong
  tbody.querySelectorAll(".lhp-btn-xem").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idEnc = btn.dataset.id;
      await openChiTietModal(idEnc);
    });
  });

  tbody.querySelectorAll(".lhp-btn-huy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ten = btn.dataset.ten;
      if (confirm(`Bạn có chắc muốn hủy đăng ký môn "${ten}" không?\n⚠️ Hành động này không thể hoàn tác nếu đã qua hạn.`)) {
        alert("Tính năng hủy đăng ký chưa được kích hoạt trong phiên bản này để đảm bảo an toàn.");
      }
    });
  });
}

/** Render bảng chi tiết lịch học trong modal */
function renderChiTietLichHoc(data) {
  const tbody = document.getElementById("lhp-modal-tbody");
  if (!tbody) return;

  const rows = Array.isArray(data) ? data : (data.data || data.Data || []);
  tbody.innerHTML = "";

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted);">Không có dữ liệu lịch học.</td></tr>`;
    return;
  }

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:center;">${i + 1}</td>
      <td>${r.LichHoc || ""}</td>
      <td style="text-align:center;">${r.Nhom || ""}</td>
      <td style="text-align:center;">${r.Phong || ""}</td>
      <td style="text-align:center;">${r.DayNha || ""}</td>
      <td>${r.CoSo || ""}</td>
      <td>${r.GiangVien || ""}</td>
      <td style="font-size:12px;">${r.ThoiGian || ""}</td>`;
    tbody.appendChild(tr);
  });
}

// =============================================================================
// LHP — MODAL & DROPDOWN
// =============================================================================

function toggleLhpDropdown(ddId) {
  // Đóng tất cả dropdown khác trước
  document.querySelectorAll(".lhp-dd-menu").forEach((m) => {
    if (m.parentElement.id !== ddId) m.style.display = "none";
  });
  const dd = document.getElementById(ddId);
  if (!dd) return;
  const menu = dd.querySelector(".lhp-dd-menu");
  if (menu) menu.style.display = menu.style.display === "none" ? "block" : "none";
}

// Đóng dropdown khi click ra ngoài
document.addEventListener("click", (e) => {
  if (!e.target.closest(".lhp-dropdown")) {
    document.querySelectorAll(".lhp-dd-menu").forEach((m) => { m.style.display = "none"; });
  }
});

async function openChiTietModal(idLHPEncrypted) {
  const modal = document.getElementById("lhp-detail-modal");
  const modalBody = document.getElementById("lhp-modal-tbody");
  const loadingRow = `<tr><td colspan="8" style="text-align:center;padding:20px;">⏳ Đang tải...</td></tr>`;

  if (!modal) return;
  modal.style.display = "flex";
  if (modalBody) modalBody.innerHTML = loadingRow;

  try {
    const data = await fetchChiTietLopHocPhan(idLHPEncrypted);
    if (!data) {
      if (modalBody) modalBody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:#fc8181;">Không thể tải dữ liệu. Vui lòng kiểm tra kết nối và đăng nhập DKHP.</td></tr>`;
      return;
    }
    renderChiTietLichHoc(data);
  } catch (err) {
    console.error("[DKHP] Lỗi fetch chi tiết LHP:", err);
    if (modalBody) modalBody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#fc8181;">Lỗi mạng.</td></tr>`;
  }
}

function closeLhpModal() {
  const modal = document.getElementById("lhp-detail-modal");
  if (modal) modal.style.display = "none";
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

