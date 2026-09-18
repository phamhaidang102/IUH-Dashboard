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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") || "";

  // If server returns HTML (login page) instead of JSON -> not authenticated
  if (!contentType.includes("application/json")) {
    return null;
  }

  return await res.json();
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
      <td colspan="8" style="
        background: var(--primary, #4a90e2);
        color: white;
        font-weight: 700;
        padding: 10px 16px;
        font-size: 13px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      ">
        Hoc ky ${soHK} &mdash; Tong: ${soTcHK} TC
      </td>`;
    tbody.appendChild(hkRow);

    const bbList = hocKy.HocPhanBatBuoc || [];
    const tcList = hocKy.HocPhanTuChon || [];

    if (bbList.length > 0) {
      const groupRow = document.createElement("tr");
      groupRow.innerHTML = `<td colspan="8" style="background:rgba(255,255,255,0.05);padding:6px 16px;font-size:12px;color:var(--text-muted,#aaa);font-style:italic;">Hoc phan bat buoc</td>`;
      tbody.appendChild(groupRow);
      bbList.forEach((hp, i) => {
        tbody.appendChild(buildHpRow(hp, i, true));
        totalSubjects++;
        if (hp.IsDat) doneSubjects++;
      });
    }

    if (tcList.length > 0) {
      const groupRow = document.createElement("tr");
      groupRow.innerHTML = `<td colspan="8" style="background:rgba(255,255,255,0.05);padding:6px 16px;font-size:12px;color:var(--text-muted,#aaa);font-style:italic;">Hoc phan tu chon</td>`;
      tbody.appendChild(groupRow);
      tcList.forEach((hp, i) => {
        tbody.appendChild(buildHpRow(hp, i, false));
        totalSubjects++;
        if (hp.IsDat) doneSubjects++;
      });
    }
  });

  if (summaryRequired)
    summaryRequired.textContent = `Tong yeu cau: ${data.TongSoTCYeuCau || 0} TC`;
  if (summaryDone)
    summaryDone.textContent = `Da dat: ${doneSubjects}/${totalSubjects} mon`;
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

  const loaiBadge = isBatBuoc
    ? `<span style="background:rgba(252,129,129,0.2);color:#fc8181;padding:2px 7px;border-radius:99px;font-size:11px;white-space:nowrap;">Bat buoc</span>`
    : `<span style="background:rgba(104,211,145,0.2);color:#68d391;padding:2px 7px;border-radius:99px;font-size:11px;white-space:nowrap;">Tu chon</span>`;

  let trangThaiBadge;
  if (isDat) {
    trangThaiBadge = `<span style="background:rgba(104,211,145,0.2);color:#68d391;padding:2px 7px;border-radius:99px;font-size:11px;">Da dat</span>`;
  } else if (isDangDK) {
    trangThaiBadge = `<span style="background:rgba(99,179,237,0.2);color:#63b3ed;padding:2px 7px;border-radius:99px;font-size:11px;">Dang DK</span>`;
  } else {
    trangThaiBadge = `<span style="background:rgba(160,174,192,0.15);color:#718096;padding:2px 7px;border-radius:99px;font-size:11px;">Chua hoc</span>`;
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
    <td class="text-center">${loaiBadge}</td>
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

  if (_ctkCache && !forceRefresh) {
    showOnly(tableSectionEl);
    renderChuongTrinhKhung(_ctkCache);
    return;
  }

  showOnly(loadingEl);

  try {
    const data = await fetchChuongTrinhKhung();

    if (data === null) {
      showOnly(authGateEl);
      return;
    }

    _ctkCache = data;
    showOnly(tableSectionEl);
    renderChuongTrinhKhung(data);
  } catch (err) {
    console.error("[DKHP] Loi fetch Chuong trinh khung:", err);
    showOnly(authGateEl);
  }
}
