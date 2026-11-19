import type { Locale } from '@aminchat/shared';

const FA = {
  declined: (summary: string) => `✋ این عملیات را تأیید نکردید و انجام نشد: ${summary}`,
  expired: (summary: string) => `⌛ مهلت تأیید این عملیات تمام شد و انجام نشد: ${summary}`,
  stepFailed: (title: string, error: string) => `⚠️ مرحلهٔ «${title}» ناموفق بود: ${error}`,
  reportTitle: 'گزارش عملیات',
  notConfirmed: 'انجام‌شدنِ این مرحله تأیید نشد',
  skipped: 'اجرا نشد',
  cancelled: 'لغو شد',
  answerFailed: 'پاسخ نهایی تولید نشد؛ این گزارش عملیات است:',
  genericError: 'خطایی رخ داد و درخواست کامل نشد.',
};
const EN = {
  declined: (summary: string) => `✋ You did not approve this action, so it was not performed: ${summary}`,
  expired: (summary: string) => `⌛ The approval window expired, so this action was not performed: ${summary}`,
  stepFailed: (title: string, error: string) => `⚠️ The step "${title}" failed: ${error}`,
  reportTitle: 'Operation report',
  notConfirmed: 'completion was not confirmed',
  skipped: 'not executed',
  cancelled: 'cancelled',
  answerFailed: 'The final answer could not be generated; here is the operation report:',
  genericError: 'Something went wrong and the request could not be completed.',
};

export const t = (locale: Locale) => (locale === 'fa' ? FA : EN);
