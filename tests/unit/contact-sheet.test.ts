import { describe, it, expect } from 'vitest';
import {
  CONTACT_SHEET_CELL_HEIGHT,
  CONTACT_SHEET_CELL_WIDTH,
  CONTACT_SHEET_GAP,
  CONTACT_SHEET_IMAGE_HEIGHT,
  CONTACT_SHEET_MARGIN,
  CONTACT_SHEET_MAX_EDGE,
  getContactSheetCell,
  getContactSheetLayout,
  truncateCanvasText,
} from '@/lib/image/contact-sheet';

describe('Unit: contact sheet layout', () => {
  it('lays out a single artwork with one column', () => {
    const layout = getContactSheetLayout(1);

    expect(layout).toMatchObject({ columns: 1, rows: 1, width: 560, height: 464 });
    expect(layout.width).toBe(
      CONTACT_SHEET_MARGIN * 2 + CONTACT_SHEET_CELL_WIDTH
    );
    expect(layout.height).toBe(
      CONTACT_SHEET_MARGIN * 2 + CONTACT_SHEET_CELL_HEIGHT
    );

    expect(getContactSheetCell(layout, 0)).toMatchObject({
      column: 0,
      row: 0,
      x: CONTACT_SHEET_MARGIN,
      y: CONTACT_SHEET_MARGIN,
      image: {
        x: CONTACT_SHEET_MARGIN,
        y: CONTACT_SHEET_MARGIN,
        width: CONTACT_SHEET_CELL_WIDTH,
        height: CONTACT_SHEET_IMAGE_HEIGHT,
      },
    });
  });

  it('fills one row of four columns for four selections', () => {
    const layout = getContactSheetLayout(4);

    expect(layout).toMatchObject({ columns: 4, rows: 1, width: 2144, height: 464 });

    const last = getContactSheetCell(layout, 3);
    expect(last.x).toBe(
      CONTACT_SHEET_MARGIN + 3 * (CONTACT_SHEET_CELL_WIDTH + CONTACT_SHEET_GAP)
    );
    expect(last.x + CONTACT_SHEET_CELL_WIDTH).toBe(layout.width - CONTACT_SHEET_MARGIN);
  });

  it('lays out the full 24 selections at 2144 by 2624 pixels', () => {
    const layout = getContactSheetLayout(24);

    expect(layout).toMatchObject({ columns: 4, rows: 6, width: 2144, height: 2624 });
    expect(layout.width).toBeLessThanOrEqual(CONTACT_SHEET_MAX_EDGE);
    expect(layout.height).toBeLessThanOrEqual(CONTACT_SHEET_MAX_EDGE);

    const last = getContactSheetCell(layout, 23);
    expect(last).toMatchObject({ column: 3, row: 5 });
    expect(last.y + CONTACT_SHEET_CELL_HEIGHT).toBe(layout.height - CONTACT_SHEET_MARGIN);
  });

  it('rejects zero, more than 24, and non-integer selections', () => {
    for (const count of [0, 25, -1, 1.5, Number.NaN]) {
      expect(() => getContactSheetLayout(count)).toThrow(RangeError);
    }
  });

  it('rejects a cell outside the layout', () => {
    const layout = getContactSheetLayout(2);
    expect(() => getContactSheetCell(layout, -1)).toThrow(RangeError);
    expect(() => getContactSheetCell(layout, 2)).toThrow(RangeError);
  });

  it('truncates long captions to the measured width with a visible ellipsis', () => {
    const measure = (value: string) => value.length * 10;

    expect(truncateCanvasText('Short title', 200, measure)).toBe('Short title');

    const truncated = truncateCanvasText('A very long artwork title that cannot fit', 140, measure);
    expect(truncated.endsWith('\u2026')).toBe(true);
    expect(measure(truncated)).toBeLessThanOrEqual(140);
    expect(truncated.length).toBeLessThan('A very long artwork title that cannot fit'.length);
  });
});
