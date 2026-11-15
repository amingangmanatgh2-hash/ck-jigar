/** Microphone capture for voice input. The recording is sent to POST /api/ai/transcribe (speech-to-text) and is never stored. */
export const canRecord = (): boolean => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

export interface Recording {
  /** Stops and resolves with the recording. */
  stop(): Promise<Blob>;
  /** Discards the recording. */
  cancel(): void;
  startedAt: number;
}

const MAX_MS = 120_000;

function pickMime(): string | undefined {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

export async function startRecording(onAutoStop?: (blob: Blob) => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      release();
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
    };
  });
  recorder.start(250);
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    recorder.stop();
    void finished.then((b) => onAutoStop?.(b));
  }, MAX_MS);
  return {
    startedAt: Date.now(),
    async stop() {
      clearTimeout(timer);
      if (!done) {
        done = true;
        if (recorder.state !== 'inactive') recorder.stop();
      }
      return finished;
    },
    cancel() {
      clearTimeout(timer);
      done = true;
      chunks.length = 0;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
