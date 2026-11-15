import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from '../src/components/Markdown';

describe('Markdown', () => {
  it('renders formatting, lists and tables', () => {
    const { container } = render(<Markdown text={'**bold** and a list:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('.table-wrap table th')).toHaveTextContent('a');
  });

  it('never renders raw HTML from a model answer (no script, no event handlers)', () => {
    const { container } = render(<Markdown text={'hello <img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> <b>not bold</b>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('opens links in a new tab without leaking the opener, and drops javascript: links', () => {
    const { container } = render(<Markdown text={'[docs](https://example.com/a) and [bad](javascript:alert(1))'} />);
    const links = [...container.querySelectorAll('a')];
    const good = links.find((a) => a.textContent === 'docs')!;
    expect(good).toHaveAttribute('href', 'https://example.com/a');
    expect(good).toHaveAttribute('target', '_blank');
    expect(good.getAttribute('rel')).toContain('noopener');
    expect(good.getAttribute('rel')).toContain('noreferrer');
    const bad = links.find((a) => a.textContent === 'bad');
    expect(bad?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });

  it('lets every paragraph choose its own direction, and keeps code left-to-right', () => {
    const { container } = render(<Markdown text={'سلام دنیا\n\nHello world\n\n```ts\nconst x = 1;\n```'} />);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    paragraphs.forEach((p) => expect(p).toHaveAttribute('dir', 'auto'));
    expect(container.querySelector('.codeblock')).toHaveAttribute('dir', 'ltr');
  });

  it('copies the code of a code block with its button', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Markdown text={'```js\nconsole.log(1);\n```'} />);
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('console.log(1);');
  });
});
