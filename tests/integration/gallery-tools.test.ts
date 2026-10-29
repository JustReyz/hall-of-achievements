import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolDialog } from '@/components/gallery/ToolDialog';

describe('Gallery tool dialog', () => {
  it('keeps a dismissed tool body mounted inside a named native dialog', () => {
    const markup = renderToStaticMarkup(createElement(
      ToolDialog,
      { open: false, label: 'Filters', onClose: () => {} },
      createElement('input', { defaultValue: 'Draft filter' })
    ));

    expect(markup).toMatch(/<dialog[^>]*aria-label="Filters"/);
    expect(markup).not.toMatch(/<dialog[^>]*\sopen[\s=>]/);
    expect(markup).toContain('value="Draft filter"');
    expect(markup).toMatch(/<button[^>]*aria-label="Close Filters"[^>]*>Close<\/button>/);
  });
});
