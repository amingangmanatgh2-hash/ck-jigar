# Zeus Lite ⚡

یک پنل کانفیگ **VLESS روی کلودفلر** + دو اپ کلاینت: **اندروید (APK)** و **ویندوز (setup.exe)**.
همه‌چیز واقعی است: کانفیگ ساخته می‌شود، اپ وصل می‌شود، ترافیک هر کاربر شمرده می‌شود.

A VLESS panel that runs entirely on **Cloudflare Workers + D1**, plus two clients: **Android** and **Windows**.

---

## پنل / The panel

| | |
|---|---|
| آدرس پنل | https://zeus-lite.amin-ck.workers.dev |
| رمز اولیه | `amin_ck` — از دکمهٔ 🔑 **تغییر رمز** عوضش کنید |
| لینک اشتراک | `https://zeus-lite.amin-ck.workers.dev/sub/<token>` |
| صفحهٔ کاربر | `https://zeus-lite.amin-ck.workers.dev/status/<token>` |

### چه کاری می‌کند (فارسی)

1. **کاربر بسازید** (نام، روزهای اعتبار، سقف ترافیک). هر کاربر یک UUID و یک توکن اشتراک می‌گیرد.
2. دکمهٔ **کانفیگ‌ها** را بزنید: لینک VLESS، لینک اشتراک، و کانفیگ آمادهٔ Xray و sing-box را می‌بینید.
3. **IP سالم** را در تنظیمات وارد کنید (هر خط یکی). برای هر IP یک کانفیگ جدا ساخته می‌شود تا اگر دامنه بسته شد، IP مستقیم کار کند.
4. هر اتصال از مسیر `/ws` به Worker می‌آید، UUID بررسی می‌شود و بعد ترافیک به مقصد وصل می‌شود. مصرف هر کاربر روی همان اتصال جمع می‌شود.
5. کاربری که اعتبارش تمام شود یا سقفش پر شود، دیگر وصل نمی‌شود (بررسی هر ۳۰ ثانیه یک‌بار کش می‌شود).

### نکته‌های مهم

- **DNS از DoH** استفاده می‌کند. کلودفلر در Worker فقط سوکت TCP می‌دهد، پس UDP (کوئیک/بازی) از تونل رد نمی‌شود؛ به‌جایش کانفیگ‌ها DNS را روی HTTPS می‌برند تا هیچ‌چیز کند نشود.
- **فرگمنت و ECH** اختیاری‌اند و در لینک نوشته می‌شوند (`fragment=1,40-100`، `ech=...`).
- پلن رایگان Workers برای استفادهٔ شخصی کافی است؛ اگر تعداد اتصال‌ها زیاد شد، پلن ۵ دلاری راحت‌تر است.
- رمز مدیر فقط به‌صورت هش نگه داشته می‌شود؛ کوکی ورود با همان رمز امضا می‌شود، پس با تغییر رمز همهٔ نشست‌ها بسته می‌شوند.

### What it does (English)

A Cloudflare Workers + D1 panel: users with UUIDs, tokens, expiry and traffic quotas, a subscription document
(`/sub/<token>`, base64 of `vless://` links), QR/status pages, clean-IP lists that each produce their own link, and
a VLESS-over-WebSocket relay (`/ws`) that validates the UUID and counts bytes against the right user. The admin
page is a single inline-HTML app (no CDN), in Persian and English.

---

## اپ‌ها / The apps

| | فایل | توضیح |
|---|---|---|
| اندروید | `ZeusLite-1.0.0.apk` | از [Releases](../../releases) بگیرید؛ نصب کنید، لینک را بچسبانید یا لینک اشتراک را وارد کنید، دکمهٔ اتصال را بزنید (VPN). |
| ویندوز | `ZeusLite-Setup-1.0.0.exe` | نصب کنید؛ همان کار، ولی روی ویندوز پروکسی سیستم را روی `127.0.0.1:2080` می‌گذارد (sing-box داخل اپ). |

- **اندروید**: هستهٔ Xray (`libv2ray.aar` از `2dust/AndroidLibXrayLite`) داخل اپ است؛ `VpnService` + `tun2socks` کار می‌کند و کل ترافیک گوشی از تونل می‌رود.
- **ویندوز**: `sing-box.exe` داخل نصب‌کننده است؛ در زمان اتصال پروکسی ویندوز عوض می‌شود و در زمان قطع، تنظیم قبلی برمی‌گردد.
- هر دو اپ: افزودن لینک، لینک اشتراک، حذف، QR (اندروید)، پینگ، و ذخیرهٔ محلی فهرست کانفیگ‌ها.

---

## ساختن و تست / Build and test

```bash
npm install
npm test                      # ۳۷ تست: لینک‌ها، پارس هدر VLESS، API پنل روی SQLite واقعی
cd worker && npx wrangler dev # پنل روی ۱۲۷.۰.۰.۱:۸۷۸۷

npm run deploy                # D1 را می‌سازد، مایگریشن می‌زند، Worker را منتشر می‌کند
```

GitHub Actions:

- `CI` — تست‌ها + باندل شدن Worker.
- `Deploy panel` — انتشار روی کلودفلر و بعد **تست سرویس زنده** (صفحه، ورود، نشست، اشتراک).
- `Android app` — APK و آپلودش روی ریلیز `v1.0.0`.
- `Windows app` — `sing-box check` روی کانفیگ تولیدی، بعد ساخت `setup.exe` و آپلود.

رازها: `DEPLOY_ENV` (شامل `CLOUDFLARE_ACCOUNT_ID` و `CLOUDFLARE_API_TOKEN`). اختیاری: `ADMIN_PASSWORD`.

---

## ساختار / Layout

```
worker/
  src/index.js      روتر، ورود مدیر، API، /sub، /status، /ws
  src/vless.js      پارس هدر VLESS و رلهٔ TCP روی WebSocket
  src/links.js      ساخت/خواندن لینک، اشتراک، کانفیگ Xray و sing-box
  src/ui.js         صفحهٔ پنل و صفحهٔ کاربر (HTML درون‌خطی، RTL)
  migrations/       جدول‌های users و settings
  test/             تست‌ها با node:test (+ SQLite واقعی برای D1)
android/            اپ اندروید (Kotlin + Compose + VpnService + libv2ray)
windows/            اپ ویندوز (Electron + sing-box + پروکسی سیستم)
scripts/deploy.mjs  ساخت D1، مایگریشن، انتشار، گزارش آدرس
```

## مجوز / Licence

MIT برای کد این مخزن. `sing-box` (GPL-3.0) و `libv2ray` (LGPL-3.0) داخل بسته‌ها هستند و مجوز خودشان را دارند.
