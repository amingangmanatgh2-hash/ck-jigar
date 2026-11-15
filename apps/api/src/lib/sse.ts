/**
 * Minimal, robust Server-Sent-Events parser.
 * - Handles \n, \r\n and \r line endings.
 * - Decodes UTF-8 incrementally, so multi-byte characters (Persian!) split across network chunks stay intact.
 */
export interface SseEvent {
  event?: string;
  data: string;
}

export class SseParser {
  private decoder = new TextDecoder('utf-8');
  private buffer = '';
  private eventName: string | undefined;
  private dataLines: string[] = [];

  /** Feed a chunk; returns every complete event contained so far. */
  feed(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** Call at end of stream to flush an unterminated trailing event. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    const lines = this.buffer.split(/\r\n|\n|\r/);
    // The last element is an incomplete line unless we are flushing.
    this.buffer = final ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (line === '') {
        const ev = this.dispatch();
        if (ev) events.push(ev);
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.dataLines.push(value);
      else if (field === 'event') this.eventName = value;
    }
    if (final) {
      const ev = this.dispatch();
      if (ev) events.push(ev);
    }
    return events;
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      return null;
    }
    const ev: SseEvent = { data: this.dataLines.join('\n') };
    if (this.eventName) ev.event = this.eventName;
    this.dataLines = [];
    this.eventName = undefined;
    return ev;
  }
}
