// dashboard/grade-scraper.js

function lamTronDiemIUH(diem) {
  if (diem === null || isNaN(diem)) return null;
  const phanNguyen = Math.floor(diem);
  const phanLe = diem - phanNguyen;
  if (phanLe < 0.25) return phanNguyen + 0.0;
  else if (phanLe < 0.75) return phanNguyen + 0.5;
  else return phanNguyen + 1.0;
}

async function fetchAndProcessGrades() {
  try {
    // Fetch ngầm song song 2 trang cùng lúc (Cực nhanh)
    const [resGrades, resDash] = await Promise.all([
      fetch("https://sv.iuh.edu.vn/ket-qua-hoc-tap.html"),
      fetch("https://sv.iuh.edu.vn/dashboard.html"),
    ]);

    const htmlGrades = await resGrades.text();
    const htmlDash = await resDash.text();

    if (
      htmlGrades.includes('id="frmLogin"') ||
      htmlGrades.includes("dang-nhap")
    ) {
      console.warn("[IUH Scraper] Phiên đăng nhập hết hạn!");
      return "REQUIRE_LOGIN";
    }
    const parser = new DOMParser();

    // 1. BÓC TÁCH TÍN CHỈ TỪ TRANG DASHBOARD
    const docDash = parser.parseFromString(htmlDash, "text/html");
    let tcHienTai = 0;
    let tcTong = 130; // Mặc định nếu lỗi

    // Tìm element chứa biểu đồ của trường, số tín chỉ (VD: 81/163) nằm ngay thẻ <p> bên dưới
    const chartDiv = docDash.querySelector("#chartThongTinTinChiDaHoc");
    if (chartDiv && chartDiv.nextElementSibling) {
      const textTC = chartDiv.nextElementSibling.innerText.trim(); // "81/163"
      const parts = textTC.split("/");
      if (parts.length === 2) {
        tcHienTai = parseInt(parts[0]);
        tcTong = parseInt(parts[1]);
      }
    }

    // 2. BÓC TÁCH ĐIỂM TỪ TRANG KẾT QUẢ HỌC TẬP
    const doc = parser.parseFromString(htmlGrades, "text/html");
    const rows = doc.querySelectorAll("#xemDiem_aaa tbody tr");
    if (!rows || rows.length === 0) return null;

    let semesters = [];
    let currentSemester = null;

    rows.forEach((row) => {
      const headerCell = row.querySelector("td.row-head");
      if (headerCell) {
        if (currentSemester) semesters.push(currentSemester);
        currentSemester = {
          semesterName: headerCell.innerText.trim(),
          subjects: [],
          summary: {},
        };
        return;
      }

      if (!currentSemester) return;
      const diemTkCell = row.querySelector('td[title="DiemTongKet"]');
      if (diemTkCell && row.querySelectorAll("td").length > 10) {
        const cells = row.querySelectorAll("td");
        const maHP = cells[1].innerText.trim();
        const tenHP = cells[2].innerText.trim();
        const soTC = parseInt(cells[3].innerText.trim(), 10);

        const isExcludedFromGPA = /quốc phòng|thể chất|tiếng anh|anh văn/i.test(
          tenHP,
        );
        const isTotNghiep = /thực tập doanh nghiệp|khóa luận tốt nghiệp/i.test(
          tenHP,
        );

        const getDiemRaw = (title) => {
          const cell = row.querySelector(`td[title="${title}"]`);
          return cell && cell.innerText.trim()
            ? parseFloat(cell.innerText.trim().replace(",", "."))
            : null;
        };

        //Điểm thường kì
        let tkArr = [];
        let tkValid = [];
        for (let i = 1; i <= 6; i++) {
          let sc = getDiemRaw(`DiemHeSo1${i}`);
          tkArr.push(sc);
          if (sc !== null) tkValid.push(sc);
        }
        const diemGK =
          getDiemRaw("DiemChuyenCan1") ||
          getDiemRaw("DiemGiuaKy") ||
          getDiemRaw("DiemGK");

        //Điểm thực hành
        let thArr = [];
        let thValid = [];
        for (let i = 1; i <= 4; i++) {
          let sc = getDiemRaw(`DiemThucHanh${i}`);
          thArr.push(sc);
          if (sc !== null) thValid.push(sc);
        }
        const diemThi = getDiemRaw("DiemThi");

        let diem10_Local = getDiemRaw("DiemTongKet");
        let diem4_Local = getDiemRaw("DiemTinChi");
        let diemChu_Local =
          row.querySelector('td[title="DiemChu"]')?.innerText.trim() || "";
        let xepLoai_Local =
          row.querySelector('td[title="XepLoai"]')?.innerText.trim() || "";
        let isDat =
          (diem4_Local !== null && diem4_Local > 0) ||
          (diemChu_Local !== "" &&
            diemChu_Local !== "F" &&
            diemChu_Local !== "Kém");

        let diemTK_TongKet =
          tkValid.length > 0
            ? lamTronDiemIUH(
                tkValid.reduce((a, b) => a + b, 0) / tkValid.length,
              )
            : null;
        let diemTH_TongKet =
          thValid.length > 0
            ? lamTronDiemIUH(
                thValid.reduce((a, b) => a + b, 0) / thValid.length,
              )
            : null;
        let isTichHop =
          (diemTK_TongKet !== null || diemGK !== null) &&
          diemTH_TongKet !== null;
        let isThucHanhThuan =
          diemTH_TongKet !== null && diemTK_TongKet === null && diemGK === null;

        if (diem10_Local !== null || diemThi === null) {
          currentSemester.subjects.push({
            maHP,
            tenHP,
            soTC,
            isExcludedFromGPA,
            isTotNghiep,
            isTichHop,
            isThucHanhThuan,
            tk: tkArr,
            th: thArr,
            diemGK,
            diemThi,
            diem10: diem10_Local,
            diem4: diem4_Local,
            diemChu: diemChu_Local,
            xepLoai: xepLoai_Local,
            isDat: isDat,
          });
        }
      }
    });
    if (currentSemester) semesters.push(currentSemester);

    // GÓI GỌN DỮ LIỆU TÍN CHỈ VÀO FINAL DATA
    const finalData = {
      semesters: semesters,
      creditInfo: { current: tcHienTai, total: tcTong },
      lastUpdated: new Date().getTime(),
    };
    chrome.storage.local.set({ iuh_grade_data: finalData });
    return finalData;
  } catch (error) {
    return null;
  }
}
