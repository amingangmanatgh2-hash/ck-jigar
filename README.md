<div dir="rtl">

# AMIN CHAT و AMIN AI

یک پیام‌رسان (وب + اندروید) با یک دستیار هوش مصنوعی واقعی به نام **AMIN AI** که مخاطب دائمی و تأییدشدهٔ هر کاربر است و روی **Cloudflare Workers AI** کار می‌کند؛ **Groq** هم به‌عنوان سرویس دوم و اختیاری کنارش است (کارهای سریع را اول جواب می‌دهد و پشتیبان Workers AI است). همه‌چیز روی Cloudflare اجرا می‌شود: Workers، Workers AI، Durable Objects، D1 و R2؛ بدون سرور دیگر.

## وضعیت صادقانه (اول این را بخوانید)

| | |
|---|---|
| ✅ ساخته و آزمایش‌شده | همهٔ بخش‌های خواستهٔ پروژه: مخاطب AMIN AI، گفتگو با پخش زنده، `@AMINAI` در چت‌ها با دسترسی مستقل برای هر چت، شش دستیار (به‌علاوهٔ «عمومی» و «سریع»؛ سریع روی Groq کار می‌کند و مثلاً چت یک نفر را برایتان آماده باز می‌کند)، موتور وظیفه با لاگ و لغو و تلاش دوباره، تأیید برای کارهای حساس، حافظهٔ قابل مدیریت، کنترل مدیران گروه، سهمیه و محدودیت نرخ، فارسی و انگلیسی با RTL واقعی. **۶۸۹ آزمون خودکار** (۳۲۰ آزمون API روی workerd واقعی، ۲۳۹ آزمون وب، ۱۳۰ آزمون اسکریپت و رله)، و CI در GitHub سبز است. |
| ✅ APK | روی GitHub ساخته و ۱۰ بررسی محتوا رویش انجام می‌شود (workflow «Android app»). |
| ❌ **هنوز دیپلوی واقعی نشده** | به حساب Cloudflare دسترسی نبود. دستور و workflow دیپلوی آماده‌اند ([docs/deploy.md](docs/deploy.md)) ولی هیچ‌وقت روی Cloudflare اجرا نشده‌اند؛ پس **آدرس زنده‌ای وجود ندارد**. |
| ❌ **اتصال واقعی Workers AI و Groq آزمایش نشده** | منطق مدل‌ها با شبیه‌ساز (برای هر دو سرویس) آزمایش شده است، نه با مدل واقعی. بعد از دیپلوی `npm run verify:ai` را اجرا کنید ([docs/testing.md](docs/testing.md)). در برنامه هیچ پاسخ ساختگی وجود ندارد: بدون اتصال، AMIN AI صادقانه می‌گوید وصل نیست. |
| ❌ آزمایش‌نشده | Google Drive واقعی، دستگاه یا WebView واقعی اندروید، شبکهٔ واقعی فیلترشدهٔ ایران. |
| ❌ ساخته‌نشده | اعلان (Push) وقتی برنامهٔ اندروید بسته است؛ تلگرام (عمداً: فقط نقطهٔ توسعه آماده است، [docs/telegram-extension.md](docs/telegram-extension.md))؛ ورود دومرحله‌ای، بازیابی گذرواژه و حذف حساب؛ ابزار نظارت درون‌برنامه (غیرفعال‌کردن حساب فقط با ویرایش مستقیم پایگاه داده ممکن است). |

فهرست کامل محدودیت‌ها: [docs/testing.md](docs/testing.md) (آزمایش‌نشده‌ها) و [docs/SECURITY.md](docs/SECURITY.md) (آنچه محافظت نمی‌شود).

## راه‌اندازی روی Cloudflare

یک Secret در GitHub به نام `DEPLOY_ENV` (خط‌های `CF_ACCOUNT_ID=…`، `CF_API_TOKEN=…` و اختیاری `GROQ_API_KEY=…`؛ یا سه Secret جدا)، `ADMIN_USERNAMES` در `apps/api/wrangler.jsonc`، و یک کلیک روی **Actions ← Deploy to Cloudflare ← Run workflow**. اشتراک R2 لازم است (یک بار در داشبورد Cloudflare). پلن رایگان Workers برای امتحان کافی است، با دو محدودیت که در راهنما آمده؛ Workers Paid امن‌تر است. گام‌به‌گام و عیب‌یابی: **[docs/deploy.md](docs/deploy.md)**. دکمهٔ یک‌کلیکی Cloudflare برای این مخزن کار نمی‌کند (توضیح در همان فایل). دکمهٔ «Run workflow» فقط وقتی دیده می‌شود که workflow در شاخهٔ پیش‌فرض `Main` باشد؛ بدون Merge هم می‌شود با تغییر فایل `deploy/REQUEST` شروعش کرد.

## اجرا روی رایانهٔ خودتان

```bash
npm ci                    # Node 22 (فایل .nvmrc)
npm run dev:api:offline   # API روی :8787، بدون هوش مصنوعی (هر قابلیت AI می‌گوید «وصل نیست»)
npm run dev:web           # برنامهٔ وب روی :5173
# با Workers AI واقعی: npx wrangler login && npm run dev:api
npm test                  # همهٔ آزمون‌ها؛ npm run typecheck
```

در حالت محلی، مدیر `dev_admin` است.

## مستندات

| فایل | برای چه کسی / چه چیزی |
|---|---|
| [docs/deploy.md](docs/deploy.md) | راه‌اندازی روی Cloudflare، تنظیمات، بررسی پس از دیپلوی، عیب‌یابی |
| [docs/architecture.md](docs/architecture.md) | معماری و جریان یک درخواست، داده‌ها، لایهٔ AI، سیاست دسترسی، دستیارها و موتور وظیفه (انگلیسی) |
| [docs/api.md](docs/api.md) | مرجع API، محدودیت‌های نرخ، کدهای خطا (انگلیسی) |
| [docs/SECURITY.md](docs/SECURITY.md) | مدل امنیتی و محدودیت‌های شناخته‌شده (انگلیسی + خلاصهٔ فارسی) |
| [docs/testing.md](docs/testing.md) | آزمون‌ها، میزان واقعی‌بودنشان، و فهرست آزمایش‌نشده‌ها (انگلیسی) |
| [docs/storage-drive.md](docs/storage-drive.md) | انتقال فایل‌های قدیمی از R2 به Google Drive |
| [docs/connectivity.md](docs/connectivity.md) | اتصال در اینترنت ایران: چند آدرس، long-poll، صف ارسال، حالت آفلاین |
| [relay/README.md](relay/README.md) | رلهٔ کوچک برای وقتی آدرس Worker مسدود است |
| [docs/android.md](docs/android.md) | گرفتن و نصب APK، امضا، بررسی‌های CI |
| [docs/telegram-extension.md](docs/telegram-extension.md) | اگر بعداً تلگرام (یا کانال دیگر) خواستید: کجا و چگونه (انگلیسی) |

## ساختار مخزن

`apps/api` (Worker) · `apps/web` (برنامهٔ وب و پروژهٔ اندروید در `android/`) · `packages/shared` (نوع‌ها و قاعدهٔ دسترسی مشترک) · `relay/` · `scripts/` (deploy، خواندن `DEPLOY_ENV`، پیش‌آزمون Cloudflare و Groq، بررسی Workers AI، توکن Drive) · `.github/workflows` (CI، اندروید، دیپلوی، بررسی Workers AI) · `docs/`.

</div>

---

# AMIN CHAT and AMIN AI (English)

A messenger (web + Android) with a real AI assistant, **AMIN AI**, as a permanent, verified contact for every user, running on **Cloudflare Workers AI**, with **Groq** as an optional second provider (it answers quick requests first and is a fallback for Workers AI). Everything runs on Cloudflare — Workers, Workers AI, Durable Objects, D1 and R2 — with no other server. Persian and English, with proper right-to-left layout.

## Honest status (read this first)

| | |
|---|---|
| ✅ Built and tested | The whole brief: the AMIN AI contact, streaming chat with edit / regenerate / search / voice / files, `@AMINAI` in other chats with an independent AI setting per chat (E2EE chats: only what the user selects), six agents (Personal, Research, Coding, Messenger, File, Creative) plus a General and a fast Quick agent (it runs on Groq and, for example, readies someone's chat for you to open), a task engine with a live operation log, retry and cancel, approval before anything sensitive, manageable per-user memory, group-admin control of the AI level, per-user quota and rate limits. **689 automated tests** (320 API tests on a real workerd, 239 web, 130 script and relay tests); CI is green on GitHub. |
| ✅ Android | The APK builds on GitHub and its contents are checked (10 checks), workflow *Android app*. |
| ❌ **Not deployed** | No Cloudflare credentials were available. The deploy script and workflow exist ([docs/deploy.md](docs/deploy.md)) but have never run against Cloudflare, so **there is no live URL**. |
| ❌ **The real Workers AI and Groq call paths are unverified** | Model handling was tested against deterministic doubles of both services, not a real model. After deploying, run `npm run verify:ai` ([docs/testing.md](docs/testing.md)). The app contains no canned answers: without a connection AMIN AI says so. |
| ❌ Unverified | Real Google Drive, a real Android device or WebView, a real filtered network. |
| ❌ Not built | Push notifications while the Android app is closed; Telegram (deliberately: only the extension points are documented, [docs/telegram-extension.md](docs/telegram-extension.md)); two-factor authentication, password reset and account deletion; in-app moderation (an account can only be disabled by editing the database directly). |

The complete lists: [docs/testing.md](docs/testing.md) (what is not verified) and [docs/SECURITY.md](docs/SECURITY.md) (what is not protected).

## Deploy

One GitHub secret named `DEPLOY_ENV` (the lines `CF_ACCOUNT_ID=…`, `CF_API_TOKEN=…` and optionally `GROQ_API_KEY=…`; or three separate secrets), `ADMIN_USERNAMES` in `apps/api/wrangler.jsonc`, then **Actions → Deploy to Cloudflare → Run workflow**. An R2 subscription is required (once, in the Cloudflare dashboard). The Workers Free plan is enough to try it, with two limits described in the guide; Workers Paid is safer. Step by step, with troubleshooting: **[docs/deploy.md](docs/deploy.md)**. Cloudflare's one-click button does not work for this monorepo (explained there), and GitHub shows *Run workflow* only once the workflow is on the default branch, `Main`; without merging, changing the file `deploy/REQUEST` starts it.

## Run locally

```bash
npm ci                    # Node 22 (.nvmrc)
npm run dev:api:offline   # API on :8787 without AI (every AI feature says "not connected")
npm run dev:web           # web app on :5173
# real Workers AI: npx wrangler login && npm run dev:api
npm test                  # everything;  npm run typecheck
```

Locally the admin user is `dev_admin`.

## Documentation

| File | What |
|---|---|
| [docs/deploy.md](docs/deploy.md) | Deploying to Cloudflare, settings, post-deploy checks, troubleshooting (Persian) |
| [docs/architecture.md](docs/architecture.md) | Architecture, request path, data, AI layer, access policy, agents and the task engine |
| [docs/api.md](docs/api.md) | API reference, rate limits, error codes |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model and known limitations |
| [docs/testing.md](docs/testing.md) | The tests, how real they are, and what is not verified |
| [docs/storage-drive.md](docs/storage-drive.md) | Moving old files from R2 to Google Drive (Persian) |
| [docs/connectivity.md](docs/connectivity.md) | Working on filtered or unstable networks (Persian) |
| [relay/README.md](relay/README.md) | The small relay for when the Worker's address is blocked (Persian) |
| [docs/android.md](docs/android.md) | Getting and installing the APK, signing, CI checks (Persian) |
| [docs/telegram-extension.md](docs/telegram-extension.md) | Where and how a Telegram (or other) channel would plug in |

## Repository layout

`apps/api` (the Worker) · `apps/web` (the web app; the Android project is in `android/`) · `packages/shared` (shared types and the access policy) · `relay/` · `scripts/` (deploy, the `DEPLOY_ENV` reader, the Cloudflare and Groq preflight, Workers AI check, Drive token) · `.github/workflows` (CI, Android, deploy, Workers AI check) · `docs/`.
