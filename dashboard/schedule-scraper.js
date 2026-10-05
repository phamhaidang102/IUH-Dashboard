const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAndProcessSchedule() {
  try {
    const response = await fetch("https://dkhp.iuh.edu.vn/DangKyHocPhan");
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const rows = doc.querySelectorAll("#lopDaDK tbody tr");
    if (!rows || rows.length === 0) return null;

    const courses = [];

    for (let row of rows) {
      const tds = row.querySelectorAll("td");
      if (tds.length < 4) continue;

      const tenMonHoc = tds[3].innerText.trim();
      const btnXem = row.querySelector('input[value="Xem"]');
      if (!btnXem) continue;

      const onclickAttr = btnXem.getAttribute("onclick");
      const match = onclickAttr.match(/XemLichHoc\('([^']+)',\s*(\d+)\)/);
      if (!match) continue;

      try {
        const formData = new URLSearchParams();
        formData.append("idLopHocPhan", match[1]);
        formData.append("maNhomTH", match[2]);

        const detailRes = await fetch("/DangKyHocPhan/GetChiTietLopHocPhan", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: formData,
        });

        const data = await detailRes.json();

        if (data && data.ListLichHoc) {
          const chiTiet = data.ListLichHoc.map((item) => {
            return {
              loaiLop: item.Nhom || item.NhomThucHanh ? "TH" : "LT",
              thoiGian: item.ThoiGian,
              lichHoc: item.LichHoc, // "LT - Thứ 2 (T10 -> T12)"
              giangVien: item.GiangVien,
              phong: item.Phong, // "Trực tuyến (MS Teams)" hoặc "N4.1"
            };
          });
          courses.push({ tenMonHoc, chiTiet });
        }
      } catch (error) {
        console.error("Lỗi fetch chi tiết:", error);
      }

      // BẢO MẬT: Delay 400ms để không bị block IP
      await sleep(400);
    }

    chrome.storage.local.set({ iuh_timetable_data: courses });
    return courses;
  } catch (error) {
    return null;
  }
}
