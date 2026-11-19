import type { AttachmentDto } from '@aminchat/shared';
import { useEffect, useState } from 'react';
import { fetchBlob } from '../lib/api';
import { fmtBytes } from '../lib/format';
import { useLocale, useT } from '../lib/i18n';
import { toast } from '../state/toast';
import { Icon } from './Icon';

function useBlobUrl(path: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let objectUrl: string | null = null;
    fetchBlob(path)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, failed: false });
      })
      .catch(() => alive && setState({ url: null, failed: true }));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return state;
}

export async function downloadFile(file: Pick<AttachmentDto, 'id' | 'name'>): Promise<void> {
  const blob = await fetchBlob(`/api/files/${encodeURIComponent(file.id)}?download=1`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function AttachmentView({ file }: { file: AttachmentDto }) {
  const t = useT();
  const locale = useLocale();
  const inline = file.kind === 'image' || file.kind === 'audio';
  const { url, failed } = useBlobUrl(inline ? `/api/files/${encodeURIComponent(file.id)}` : null);
  if (file.kind === 'image') {
    return url ? (
      <a className="att-image" href={url} target="_blank" rel="noopener noreferrer" title={file.name}>
        <img src={url} alt={file.name} loading="lazy" />
      </a>
    ) : (
      <div className="att-file" aria-busy={!failed}>
        <Icon name="image" />
        <span className="att-name" dir="auto">
          {file.name}
        </span>
        <span className="muted small">{failed ? t('file.unavailable') : t('common.loading')}</span>
      </div>
    );
  }
  if (file.kind === 'audio' && url) {
    return (
      <div className="att-audio">
        <span className="att-name small" dir="auto">
          {file.name}
        </span>
        <audio controls src={url} preload="metadata" />
      </div>
    );
  }
  return (
    <button
      type="button"
      className="att-file"
      onClick={() => downloadFile(file).catch(() => toast(t('file.unavailable'), 'error'))}
      title={t('file.download')}
    >
      <Icon name="file" />
      <span className="att-name" dir="auto">
        {file.name}
      </span>
      <span className="muted small">{fmtBytes(file.size, locale)}</span>
    </button>
  );
}

export function AttachmentList({ files }: { files: AttachmentDto[] }) {
  if (files.length === 0) return null;
  return (
    <div className="att-list">
      {files.map((f) => (
        <AttachmentView key={f.id} file={f} />
      ))}
    </div>
  );
}
