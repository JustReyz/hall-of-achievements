import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareProfileImage } from '@/lib/finance/profile-image';

describe('finance profile image preparation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves existing image formats for server validation', async () => {
    const file = Object.assign(new Blob(['png'], { type: 'image/png' }), { name: 'photo.png' }) as File;
    expect(await prepareProfileImage(file)).toBe(file);
  });

  it('converts a supported JPEG XL image to a bounded WebP', async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const bitmap = { width: 2000, height: 1000, close };
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: (done: (blob: Blob) => void) => done(new Blob(['webp'], { type: 'image/webp' })) };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal('document', { createElement: () => canvas });
    const file = Object.assign(new Blob(['jxl']), { name: 'photo.JXL' }) as File;
    expect((await prepareProfileImage(file)).type).toBe('image/webp');
    expect([canvas.width, canvas.height]).toEqual([1024, 512]);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('explains when the browser cannot decode JPEG XL', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')));
    const file = Object.assign(new Blob(['jxl'], { type: 'image/jxl' }), { name: 'photo.jxl' }) as File;
    await expect(prepareProfileImage(file)).rejects.toThrow('Browser ini belum dapat membaca JPEG XL');
  });

  it('rejects oversized JPEG XL before decoding', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    const file = Object.assign(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]), { name: 'large.jxl' }) as File;
    await expect(prepareProfileImage(file)).rejects.toThrow('Foto melebihi 2 MB');
    expect(decode).not.toHaveBeenCalled();
  });
});
