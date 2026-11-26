# Zeus Lite ⚡

پنل کانفیگ **VLESS روی کلودفلر** + دو اپ کلاینت: **اندروید (APK)** و **ویندوز (setup.exe)**.
همه‌چیز واقعی است: کانفیگ ساخته می‌شود، کاربر و ترافیک و انقضا دارد، اپ‌ها وصل می‌شوند.

A VLESS panel that runs entirely on **Cloudflare Workers + D1**, plus an **Android** app and a **Windows** app.

---

## پنل / The panel

| | |
|---|---|
| **آدرس** | **https://zeus.amin-ck.workers.dev** |
| رمز اولیه | `amin_ck` — از دکمهٔ 🔑 **تغییر رمز** عوضش کنید |
| لینک اشتراک | `…/sub/<token>` |
| صفحهٔ کاربر | `…/status/<token>` |
| لینک اتصال | `vless://…@دامنه:443?type=ws&security=tls&…#نام` (مسیر `/ws`) |

### اپ‌ها / The apps

| فایل | حجم | کجا |
|---|---|---|
| `ZeusLite-1.0.0.apk` | ~۶۸ مگابایت | [Releases → v1.0.0](../../releases/tag/v1.0.0) |
| `ZeusLite-Setup-1.0.0.exe` | ~۸۷ مگابایت | [Releases → v1.0.0](../../releases/tag/v1.0.0) |

---

## چطور کار می‌کند (فارسی)

1. **کاربر بسازید**: نام، روزهای اعتبار، سقف ترافیک (۰ = بی‌پایان). هر کاربر یک UUID و یک توکن اشتراک می‌گیرد.
2. **کانفیگ‌ها** را بزنید: لینک VLESS، لینک اشتراک، و کانفیگ آمادهٔ Xray و sing-box.
3. **IP سالم** را در تنظیمات بنویسید (هر خط یکی) تا برای هر IP یک کانفیگ جدا ساخته شود (رد کردن فیلتر دامنه).
4. کلاینت به `/ws` وصل می‌شود، Worker هدر VLESS را می‌خواند، UUID را با دیتابیس چک می‌کند (۳۰ ثانیه کش)، بعد ترافیک را به مقصد رله می‌کند و بایت‌ها را روی همان کاربر می‌نویسد.
5. کاربر منقضی یا پرترافیک دیگر وصل نمی‌شود. صفحهٔ `/status/<token>` مصرف و انقضا و لینک‌ها را نشان می‌دهد.

**نکته‌های واقعی:**

- Worker کلودفلر فقط سوکت **TCP** می‌دهد؛ پس UDP (کوئیک/بازی) از تونل رد نمی‌شود. به همین دلیل کانفیگ‌ها DNS را روی **DoH** می‌برند (`https://1.1.1.1/dns-query`) تا هیچ‌چیز کند یا خراب نشود.
- روی پلن رایگان Workers، هر درخواست سقف CPU کمی دارد؛ برای استفادهٔ شخصی کافی است.
- رمز مدیر فقط هش می‌شود؛ کوکی ورود با همان رمز امضا می‌شود، پس تغییر رمز همهٔ نشست‌ها را می‌بندد.

## What it does (English)

- **Users**: name, UUID, token, expiry, traffic quota; enable/disable, reset traffic, delete.
- **Links**: `vless://` (VLESS + WebSocket + TLS, uTLS `chrome`, `alpn=h2,http/1.1`, optional `fragment`/`ech`), one per clean IP.
- **Subscription**: `/sub/<token>` returns base64 links plus `Subscription-Userinfo`; `?raw=1` for plain text.
- **Admin**: a single inline-HTML page (no CDN, works where a CDN is blocked), Persian and English, with QR-free copy buttons and ready-made Xray and sing-box configs.
- **Relay**: `/ws` speaks VLESS (UUID check, TCP relay through `cloudflare:sockets`, byte counting per user).

---

## ساختن / Build

```bash
npm install
npm test                      # ۳۷ تست: لینک‌ها، هدر VLESS، و کل API پنل روی SQLite واقعی
cd worker && npx wrangler dev # پنل روی http://127.0.0.1:8787

npm run deploy                # D1 می‌سازد، مایگریشن می‌زند، منتشر می‌کند و آدرس را می‌گوید
```

GitHub Actions:

| ورک‌فلو | کار |
|---|---|
| `CI` | تست‌ها + باندل شدن Worker |
| `Deploy panel` | انتشار + **تست سرویس زنده**: صفحه، ورود، ساخت کاربر، لینک، اشتراک، صفحهٔ کاربر، حذف |
| `Android app` | `gradle assembleRelease` و آپلود APK روی ریلیز |
| `Windows app` | `sing-box check` روی کانفیگ تولیدی، سپس ساخت `setup.exe` و آپلود |
| `Cleanup Workers` | Worker‌های نوشته‌شده در `deploy/CLEANUP` را پاک می‌کند (پنل هیچ‌وقت) |

رازها: `DEPLOY_ENV` (شامل `CLOUDFLARE_ACCOUNT_ID` و `CLOUDFLARE_API_TOKEN`)؛ اختیاری `ADMIN_PASSWORD`.

---

## ساختار / Layout

```
worker/
  src/index.js      ورودی: app.js را تنبل ایمپورت می‌کند تا خطا پیام بدهد نه صفحهٔ 1101
  src/app.js        روتر، ورود مدیر، API، /sub، /status
  src/vless.js      پارس هدر VLESS + رلهٔ TCP روی WebSocket
  src/links.js      ساخت/خواندن لینک، اشتراک، کانفیگ Xray و sing-box
  src/ui.js         صفحهٔ پنل و صفحهٔ کاربر (HTML درون‌خطی، RTL)
  migrations/       جدول‌های users و settings
  test/             تست‌ها با node:test (+ SQLite واقعی به‌جای D1)
android/            Kotlin + Compose + VpnService + libv2ray (Xray)
windows/            Electron + sing-box + پروکسی سیستم ویندوز
scripts/            deploy / diagnose / cleanup
```

## محدودیت‌های صادقانه / Honest limits

- APK و setup.exe در CI ساخته و امضا شده‌اند؛ روی دستگاه واقعی تست نشده‌اند (اینجا گوشی و ویندوز نبود). اگر جایی گیر کرد، لاگ اپ اندروید (`TunnelState.message`) و پنجرهٔ **لاگ** ویندوز پیام می‌دهند.
- APK با کلید debug امضا شده تا بدون کار اضافه نصب شود؛ برای انتشار در فروشگاه باید کلید خودتان را بگذارید.
- پنل تست زندهٔ کامل دارد؛ اتصال واقعی VLESS را فقط یک کلاینت واقعی می‌تواند تأیید کند.

## مجوز / Licence

MIT برای کد این مخزن. `sing-box` (GPL-3.0) و `libv2ray` (LGPL-3.0) با مجوز خودشان داخل بسته‌ها هستند.
