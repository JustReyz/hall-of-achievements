export const CONTACT_SHEET_MAX_ITEMS = 24;
export const CONTACT_SHEET_COLUMNS_MAX = 4;
export const CONTACT_SHEET_CELL_WIDTH = 512;
export const CONTACT_SHEET_CELL_HEIGHT = 416;
export const CONTACT_SHEET_IMAGE_HEIGHT = 384;
export const CONTACT_SHEET_CAPTION_HEIGHT = 32;
export const CONTACT_SHEET_GAP = 16;
export const CONTACT_SHEET_MARGIN = 24;
export const CONTACT_SHEET_MAX_EDGE = 4096;

export interface ContactSheetLayout {
  count: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  margin: number;
  gap: number;
  cellWidth: number;
  cellHeight: number;
  imageHeight: number;
  captionHeight: number;
}

export interface ContactSheetCell {
  column: number;
  row: number;
  x: number;
  y: number;
  image: { x: number; y: number; width: number; height: number };
  caption: { x: number; y: number; width: number; height: number; baselineY: number };
}

export function getContactSheetLayout(count: number): ContactSheetLayout {
  if (!Number.isInteger(count) || count < 1 || count > CONTACT_SHEET_MAX_ITEMS) {
    throw new RangeError(
      `A contact sheet needs between 1 and ${CONTACT_SHEET_MAX_ITEMS} artworks.`
    );
  }

  const columns = Math.min(CONTACT_SHEET_COLUMNS_MAX, count);
  const rows = Math.ceil(count / columns);
  const width =
    CONTACT_SHEET_MARGIN * 2 +
    columns * CONTACT_SHEET_CELL_WIDTH +
    (columns - 1) * CONTACT_SHEET_GAP;
  const height =
    CONTACT_SHEET_MARGIN * 2 +
    rows * CONTACT_SHEET_CELL_HEIGHT +
    (rows - 1) * CONTACT_SHEET_GAP;

  if (width > CONTACT_SHEET_MAX_EDGE || height > CONTACT_SHEET_MAX_EDGE) {
    throw new RangeError(`A contact sheet canvas may not exceed ${CONTACT_SHEET_MAX_EDGE} pixels.`);
  }

  return {
    count,
    columns,
    rows,
    width,
    height,
    margin: CONTACT_SHEET_MARGIN,
    gap: CONTACT_SHEET_GAP,
    cellWidth: CONTACT_SHEET_CELL_WIDTH,
    cellHeight: CONTACT_SHEET_CELL_HEIGHT,
    imageHeight: CONTACT_SHEET_IMAGE_HEIGHT,
    captionHeight: CONTACT_SHEET_CAPTION_HEIGHT,
  };
}

export function getContactSheetCell(layout: ContactSheetLayout, index: number): ContactSheetCell {
  if (!Number.isInteger(index) || index < 0 || index >= layout.count) {
    throw new RangeError(`Contact sheet cell ${index} is outside the layout.`);
  }

  const column = index % layout.columns;
  const row = Math.floor(index / layout.columns);
  const x = layout.margin + column * (layout.cellWidth + layout.gap);
  const y = layout.margin + row * (layout.cellHeight + layout.gap);
  const captionPadding = 8;

  return {
    column,
    row,
    x,
    y,
    image: { x, y, width: layout.cellWidth, height: layout.imageHeight },
    caption: {
      x: x + captionPadding,
      y: y + layout.imageHeight,
      width: layout.cellWidth - captionPadding * 2,
      height: layout.captionHeight,
      baselineY: y + layout.imageHeight + layout.captionHeight / 2,
    },
  };
}

export function truncateCanvasText(
  text: string,
  maxWidth: number,
  measure: (candidate: string) => number
): string {
  if (maxWidth <= 0) return '';
  if (measure(text) <= maxWidth) return text;

  const ellipsis = '\u2026';
  let low = 0;
  let high = text.length;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, middle).trimEnd()}${ellipsis}`) <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  if (low === 0) {
    return measure(ellipsis) <= maxWidth ? ellipsis : '';
  }

  return `${text.slice(0, low).trimEnd()}${ellipsis}`;
}
