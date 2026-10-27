import { describe, it, expect } from 'vitest';
import { clampViewerTransform } from '@/lib/image/viewer-transform';

describe('clampViewerTransform', () => {
  it('holds zoom between 1 and 4', () => {
    const fitted = { width: 800, height: 600 };
    const viewport = { width: 400, height: 300 };

    expect(clampViewerTransform({ zoom: 0.25, x: 0, y: 0 }, viewport, fitted).zoom).toBe(1);
    expect(clampViewerTransform({ zoom: 9, x: 0, y: 0 }, viewport, fitted).zoom).toBe(4);
  });

  it('has zero pan overflow when the image fits at zoom 1', () => {
    const fitted = { width: 400, height: 300 };
    const viewport = { width: 500, height: 400 };

    expect(clampViewerTransform({ zoom: 1, x: 30, y: -40 }, viewport, fitted)).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    });

    const edgeFitted = { width: 500, height: 300 };
    expect(clampViewerTransform({ zoom: 1, x: 5, y: 5 }, viewport, edgeFitted)).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    });
  });

  it('bounds pan to the scaled image edges on both axes', () => {
    const fitted = { width: 400, height: 300 };
    const viewport = { width: 500, height: 400 };

    expect(clampViewerTransform({ zoom: 2, x: 999, y: -999 }, viewport, fitted)).toEqual({
      zoom: 2,
      x: 150,
      y: -100,
    });
    expect(clampViewerTransform({ zoom: 2, x: -999, y: 999 }, viewport, fitted)).toEqual({
      zoom: 2,
      x: -150,
      y: 100,
    });
    expect(clampViewerTransform({ zoom: 2, x: 25, y: -30 }, viewport, fitted)).toEqual({
      zoom: 2,
      x: 25,
      y: -30,
    });
  });

  it('re-clamps the existing pan when the viewport grows', () => {
    const fitted = { width: 400, height: 300 };

    const before = clampViewerTransform(
      { zoom: 2, x: 150, y: 100 },
      { width: 500, height: 400 },
      fitted
    );
    expect(before).toEqual({ zoom: 2, x: 150, y: 100 });

    expect(clampViewerTransform(before, { width: 700, height: 500 }, fitted)).toEqual({
      zoom: 2,
      x: 50,
      y: 50,
    });

    expect(clampViewerTransform(before, { width: 800, height: 600 }, fitted)).toEqual({
      zoom: 2,
      x: 0,
      y: 0,
    });
  });
});
