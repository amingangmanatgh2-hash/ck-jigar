/** The call every provider implements: `(model id, input, options) → parsed JSON, or an SSE byte stream when `input.stream` is set`. */
export type RunFn = (id: string, input: unknown, options?: unknown) => Promise<unknown>;
