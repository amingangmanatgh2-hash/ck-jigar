import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPlain, stripMarkdown } from '../src/lib/text';
import { previewOf } from '../src/state/conversations';
import { message } from './fixtures';

describe('stripMarkdown', () => {
  it('removes emphasis, headings, lists, links and code from a one-line preview', () => {
    expect(stripMarkdown('حتماً! این یک **پاسخ نمونه** است')).toBe('حتماً! این یک پاسخ نمونه است');
    expect(stripMarkdown('# Title\n\n- one\n- two')).toBe('Title one two');
    expect(stripMarkdown('see [the docs](https://example.com/x) and `npm i`')).toBe('see the docs and npm i');
    expect(stripMarkdown('before\n```ts\nconst x = 1;\n```\nafter')).toBe('before after');
    expect(stripMarkdown('an *emphasised* word, 2 * 3 stays')).toBe('an emphasised word, 2 * 3 stays');
  });

  it('copes with a half-written code block (the answer is still streaming)', () => {
    expect(stripMarkdown('text ```ts\nconst x')).toBe('text');
  });
});

describe('previewOf', () => {
  it('strips Markdown only from the AI’s messages', () => {
    expect(previewOf(message({ senderId: 'usr_amin_ai', body: '**Done**' }))).toBe('Done');
    expect(previewOf(message({ senderId: 'someone', body: '__init__ and **kwargs' }))).toBe('__init__ and **kwargs');
  });

  it('shows nothing for an encrypted message and a paperclip for a bare attachment', () => {
    expect(previewOf(message({ senderId: 'x', body: null, cipher: { v: 1, iv: 'a', ct: 'b' } }))).toBe('');
    expect(previewOf(message({ senderId: 'x', body: '', attachments: [{ id: 'f' } as never] }))).toBe('📎');
  });
});

describe('renderPlain', () => {
  it('isolates @mentions as left-to-right runs so Persian text does not reorder them', () => {
    const { container } = render(<p dir="rtl">{renderPlain('سلام @AMINAI لطفاً خلاصه کن')}</p>);
    const mention = container.querySelector('bdi');
    expect(mention).toHaveTextContent('@AMINAI');
    expect(mention).toHaveAttribute('dir', 'ltr');
    expect(container.textContent).toBe('سلام @AMINAI لطفاً خلاصه کن');
  });

  it('leaves text without mentions alone', () => {
    const { container } = render(<p>{renderPlain('plain text')}</p>);
    expect(container.querySelector('bdi')).toBeNull();
    expect(container.textContent).toBe('plain text');
  });
});
