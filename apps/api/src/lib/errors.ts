export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown, code = 'BAD_REQUEST') => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have access to this resource', code = 'FORBIDDEN', details?: unknown) =>
  new AppError(403, code, message, details);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
export const tooLarge = (message: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', message);
export const unsupportedMedia = (message: string) => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message);
export const rateLimited = (message: string, retryAfterSec: number) =>
  new AppError(429, 'RATE_LIMITED', message, { retryAfterSec });
export const quotaExceeded = (message: string, details?: unknown) => new AppError(429, 'QUOTA_EXCEEDED', message, details);
export const unavailable = (message: string, code = 'SERVICE_UNAVAILABLE', details?: unknown) =>
  new AppError(503, code, message, details);
