<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · **Tiếng Việt** · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending-daily.svg" alt="Dune Awakening Community — Daily Top Repository" width="280" height="79">
  <img src="../../assets/community-trending-weekly.svg" alt="Dune Awakening Community — Weekly Top Repository" width="280" height="79">
  <img src="../../assets/community-trending-monthly.svg" alt="Dune Awakening Community — Monthly Top Repository" width="280" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console là công cụ quản lý máy chủ riêng Dune: Awakening dựa trên Docker cho Linux, Windows/WSL2 và máy ảo. Trình cài đặt có hướng dẫn và bảng quản trị trên trình duyệt giúp quản lý người chơi, bản đồ, sao lưu, cập nhật và vận hành máy chủ.

Đây là dự án cộng đồng không chính thức, không liên kết, được chứng thực, tài trợ hay hỗ trợ bởi Funcom. Dự án đang thử nghiệm; cơ chế tự lưu trữ của Funcom có thể thay đổi.

## Bạn Có Thể Làm Gì

- **Triển Khai và Vận Hành:** Thiết lập trong trình duyệt, cập nhật, điều khiển dịch vụ, lịch và hàng đợi khởi động lại, chẩn đoán và phục hồi.
- **Theo Dõi Trực Tiếp:** Bản đồ tương tác, vị trí người chơi và phương tiện, tài nguyên, tình trạng máy chủ, hiệu năng và nhật ký.
- **Quản Lý Arrakis:** Bản đồ, Sietch, bố cục Deep Desert, tự động điều chỉnh quy mô, bộ nhớ, thiết lập trò chơi và **Regis Tanks thử nghiệm**.
- **Quản Lý Người Chơi:** Công cụ người chơi và bang hội, hành trang, tiến trình, căn cứ, kho, phương tiện, Landsraad, phần thưởng và Care Packages.
- **Vận Hành Kinh Tế:** Xem niêm yết Exchange và tự động giao dịch bằng Market Bot tích hợp.
- **Bảo Vệ Máy Chủ:** Sao lưu cơ sở dữ liệu và hệ thống được mã hóa, khôi phục, di chuyển, vai trò truy cập, khóa API giới hạn quyền và API mã hóa.
- **Xây Dựng và Chia Sẻ:** Thiết kế căn cứ 3D, nhập và chia sẻ bản thiết kế, hồ sơ máy chủ công khai và kiểm tra độ trễ.
- **Tùy Chỉnh:** Tiện ích cộng đồng, tích hợp Discord, nhiều ngôn ngữ và góp ý sửa bản dịch từ cộng đồng.

Xem [Thư Viện Ảnh](../screenshots.md).

## Yêu Cầu

Không cần là chuyên gia Linux. Trình cài đặt kiểm tra điều kiện cơ bản và chuẩn bị Docker trên Linux được hỗ trợ.

| Thành Phần | Khuyến Nghị |
|---|---|
| Máy chủ | Ubuntu 64 bit mới cài là lựa chọn dễ nhất. Hỗ trợ Linux khác, Docker Desktop trên Windows/WSL2 và máy ảo. |
| Docker | Được trình cài đặt chuẩn bị nếu chưa có trên Linux được hỗ trợ. |
| CPU | Hỗ trợ AVX/AVX2 |
| Bộ nhớ | Bắt đầu với 20 GB RAM; 30–40 GB trở lên cho thêm bản đồ chạy liên tục |
| Lưu trữ | 200 GB trở lên |
| Token Funcom | Nhập an toàn khi thiết lập trên trình duyệt |

Trên Fedora, Bazzite và máy dùng SELinux, cấu hình dùng nhãn gắn kết dự án dùng chung và chỉ tắt cách ly nhãn cho Console cần truy cập socket Docker. SELinux của máy, nhãn và quyền socket không đổi. Sau nâng cấp chạy `dune console reload`. Cài Docker trước nếu trình cài tự động của Docker không hỗ trợ bản phân phối.

<details>
<summary>Hướng Dẫn RAM và CPU</summary>

RAM quyết định số bản đồ có thể chạy ổn định. Bắt đầu với cấu hình cơ bản rồi tăng theo bản đồ luôn chạy và hoạt động người chơi. Máy chủ Survival chính thức thường giữ khoảng 10–12 GB bộ nhớ thường trú dù không có người chơi; một ảnh chụp lúc rảnh không chứng minh rò rỉ bộ nhớ. Trong `docker stats`, `100%` là sử dụng hết một CPU logic.

| Cấu Hình | RAM Đề Xuất |
|---|---:|
| Máy chủ cơ bản | 20 GB |
| Thế giới chính và bản đồ cốt truyện/xã hội bổ sung | 30 GB |
| Thế giới chính, bản đồ bổ sung và Deep Desert | 40 GB |
| Nhiều bản đồ luôn chạy hoặc đông người chơi | 60 GB+ |

</details>

Chuyển tiếp các cổng sau khi mở máy chủ ra internet:

| Cổng | Giao Thức | Mục Đích |
|---|---|---|
| `8088` | TCP | Quản trị web, chỉ cho quản trị viên tin cậy |
| `31982` | TCP | Điểm nhắn tin trò chơi RabbitMQ |
| `31983` | TCP | Điểm HTTP trò chơi RabbitMQ |
| `7777-7810` | UDP | Lưu lượng trò chơi |
| `32000-32015` | UDP | Đo độ trễ trực tiếp tùy chọn; vẫn có chuyển tiếp khi đóng |
| `8797` | TCP | API HTTPS tùy chọn; xem [Truy Cập API Mã Hóa](../console/encrypted-api.md) |

Giữ riêng các cổng cơ sở dữ liệu và quản trị nội bộ. Không mở giao diện web cho người không tin cậy.

## Cài Đặt

Dùng tài khoản thường có `sudo`, không đăng nhập bằng `root`; chỉ yêu cầu quyền quản trị khi cần. Chạy trên Linux mới:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

Trình cài tải bản phát hành mới nhất, mở giao diện web và cho biết địa chỉ. Hoàn tất bằng trình duyệt. Đường dẫn mặc định là `~/dune-awakening-selfhost-docker`; để dùng ổ khác, chỉ rõ đường dẫn đầy đủ:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Trên Windows, dùng terminal Linux VM được hỗ trợ hoặc Ubuntu WSL2, không dùng PowerShell, Command Prompt hay shell nội bộ Docker Desktop. Trước khi giải nén sẽ kiểm tra quyền ghi và dung lượng; tải lỗi không ghi đè dở dang cài đặt.

Alpine Linux dùng gói Docker và Docker Compose của bản phân phối cùng OpenRC. Nếu kho community không có, trình cài hỏi trước khi đổi cấu hình kho.

## Danh Bạ Máy Chủ Công Khai

[DuneDocker.app](https://dunedocker.app/) giới thiệu cộng đồng và giúp người chơi tìm máy chủ. Trang trực tiếp có trạng thái, số người chơi, khu vực, Sietch, độ trễ riêng và liên kết Discord tùy chọn.

Xác nhận quyền sở hữu từ phần Cài Đặt của Console để quản lý hồ sơ, lời mời Discord và quảng bá máy chủ. Có thể bật/tắt niêm yết bất cứ lúc nào.

Đo trực tiếp dùng UDP `32000-32015`: cho phép qua tường lửa máy, tường lửa internet–DMZ và NAT. Nếu không mở, máy chủ vẫn tương thích và tự dùng bộ chuyển tiếp Dune Docker.

Máy cục bộ hoặc chỉ LAN không bao giờ được niêm yết. Mặc định chỉ góp số lượng máy chủ ẩn danh, không tên, địa chỉ, người chơi hay thiết lập. Có thể tắt riêng thống kê này trong Cài Đặt.

## Công Cụ Thiết Kế Căn Cứ

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) giúp lập kế hoạch và chia sẻ căn cứ 3D trên trình duyệt. Thử trước khi tốn thời gian, vật liệu trong game bằng danh mục công trình có tìm kiếm, đặt, bắt dính, xoay, va chạm và phạm vi lãnh thổ.

Đổi góc nhìn/ngày đêm, đi bộ trong thiết kế, chụp ảnh, nhập bố cục và xuất thiết kế. Thành viên đăng nhập có thể lưu, chọn công khai/không niêm yết/riêng tư, đăng xem trước, khám phá và sao chép bản thiết kế cộng đồng. Console cũng có liên kết ở chân trang.

## Tiện Ích Cộng Đồng

Cài và quản lý công cụ tùy chọn qua giao diện web. Quyền được công bố trước cài đặt; cập nhật giữ thiết lập và yêu cầu duyệt quyền mới. Nhà phát triển có thể dùng [Mẫu Tiện Ích Chính Thức](https://github.com/Red-Blink/dune-docker-addon-template).

## Trợ Giúp và Tài Liệu

- [Trang Chính Thức](https://dunedocker.app/) — Dự án, cài đặt, FAQ và danh bạ
- [Thiết Kế Căn Cứ](https://blueprints.dunedocker.app/) — Lập kế hoạch, xem, lưu và chia sẻ 3D
- [Tài Liệu Chính Thức](https://docs.dunedocker.app/) — Hướng dẫn, tính năng, kỹ thuật và API
- [Cộng Đồng Discord](https://discord.gg/duneawakeningdocker) — Hỗ trợ, cập nhật, tiện ích và trao đổi
- [Tài Liệu Kho Mã](../README.md) — Ghi chú kỹ thuật đi cùng mã nguồn
- [Ủng Hộ Dự Án](https://ko-fi.com/redblink) — Hỗ trợ phát triển, kiểm thử và hạ tầng

## Đóng Góp

Chào đón nhà phát triển, chủ máy chủ và người chơi. Kiểm tra [Issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) và [Pull Requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) để tránh trùng lặp.

- **Báo Lỗi:** Nêu phiên bản, bước tái hiện và kết quả mong đợi; xóa mật khẩu, thông tin cá nhân khỏi nhật ký và ảnh.
- **Đề Xuất:** Giải thích vấn đề và lợi ích; thảo luận thay đổi lớn trong issue trước.
- **Gửi Pull Request:** Giữ phạm vi tập trung, liên kết issue, giải thích thay đổi và cách kiểm thử.
- **Hỗ Trợ Ngoài Mã:** Cải thiện tài liệu, thử nghiệm, tạo tiện ích hoặc đề xuất sửa bản dịch từ Console.

Trao đổi tại [Cộng Đồng Discord](https://discord.gg/duneawakeningdocker).

## Ghi Công và Giấy Phép

RedBlink dẫn dắt và duy trì dự án với đóng góp cộng đồng. Vui lòng ghi công RedBlink là nhà phát triển gốc khi chia sẻ hoặc phân phối lại.

**Miễn phí, mã nguồn mở theo [Giấy Phép MIT](../../LICENSE).**
