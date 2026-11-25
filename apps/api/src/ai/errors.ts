import { AppError } from '../lib/errors';

export type AiErrorKind =
  | 'model_unavailable' // unknown / removed model
  | 'capacity' // temporary overload
  | 'account_limit' // Cloudflare account allocation exhausted — every model will fail the same way
  | 'access' // licence / paid-plan / permission problem for this model
  | 'bad_request' // the model rejected the input (e.g. unsupported parameter)
  | 'too_large' // the request exceeds what this model / plan accepts (e.g. Groq's tokens-per-minute limit): another model may take it
  | 'timeout'
  | 'aborted'
  | 'empty'
  | 'server'
  | 'unknown';

export class AiError extends Error {
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    public readonly modelId?: string,
    /** How long the provider asked us to wait (Retry-After on a 429). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export function classifyAiError(err: unknown, modelId?: string): AiError {
  if (err instanceof AiError) return err;
  const message = String((err as Error)?.message ?? err ?? 'unknown error');
  const name = String((err as Error)?.name ?? '');
  let kind: AiErrorKind = 'unknown';
  if (name === 'AbortError' || /\babort(ed)?\b/i.test(message)) kind = 'aborted';
  else if (/daily free allocation|3036|neurons|account.{0,20}limit|exceeded your .{0,20}quota/i.test(message)) kind = 'account_limit';
  else if (/no such model|5007|model.{0,30}not (found|exist)|unknown model|decommission|deprecat/i.test(message)) kind = 'model_unavailable';
  else if (/capacity|3040|overload|too many requests|\b429\b|rate.?limit/i.test(message)) kind = 'capacity';
  else if (/\bagree\b|licen[sc]e|not accessible|access (is )?required|paid plan|payment|\b40[123]\b|forbidden|unauthori[sz]ed|permission/i.test(message)) kind = 'access';
  else if (/timeout|timed out|deadline/i.test(message)) kind = 'timeout';
  else if (/invalid|schema|validation|bad request|unknown (field|param)|unexpected (field|param)|\b400\b|\b6001\b|\b5006\b|too long|context length|maximum context/i.test(message)) kind = 'bad_request';
  else if (/\b5\d\d\b|internal|upstream|unavailable|network|fetch failed/i.test(message)) kind = 'server';
  return new AiError(kind, message, modelId);
}

/**
 * Does the error warrant trying the next model in the priority list? `account_limit` is the exception that needs care: it says the
 * whole *provider account* is spent (every Workers AI model fails the same way), so the remaining models of THAT provider are skipped
 * — but models of another provider are still tried (see AiClient.execute).
 */
export function shouldFallback(kind: AiErrorKind): boolean {
  return kind !== 'aborted' && kind !== 'account_limit';
}

/** Does the error say something lasting about the model (so it should be shown as unavailable)? */
export function marksUnavailable(kind: AiErrorKind): boolean {
  return kind === 'model_unavailable' || kind === 'access';
}

export function userFacingAiError(err: AiError): AppError {
  switch (err.kind) {
    case 'account_limit':
      return new AppError(503, 'AI_ACCOUNT_LIMIT', 'The Workers AI allocation of this deployment is exhausted. Try again later or raise the Cloudflare plan limit.');
    case 'capacity':
      return new AppError(503, 'AI_BUSY', 'The AI models are busy right now. Please try again in a moment.');
    case 'timeout':
      return new AppError(504, 'AI_TIMEOUT', 'The AI model did not answer in time. Please try again.');
    case 'aborted':
      return new AppError(499 as 400, 'AI_ABORTED', 'The request was cancelled.');
    default:
      return new AppError(502, 'AI_FAILED', 'No AI model could answer this request.', { reason: err.message.slice(0, 300) });
  }
}
