export async function prepareProfileImage(file: File): Promise<Blob> {
  if (file.type !== 'image/jxl' && !/\.jxl$/i.test(file.name)) return file;
  if (file.size > 2 * 1024 * 1024) throw new Error('Foto melebihi 2 MB.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('Browser ini belum dapat membaca JPEG XL. Gunakan JPEG, PNG, atau WebP.'); }
  try {
    if (bitmap.width * bitmap.height > 20_000_000) throw new Error('Ukuran gambar terlalu besar.');
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Gagal memproses foto.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const converted = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!converted || converted.type !== 'image/webp') throw new Error('Browser ini tidak dapat mengubah foto ke WebP.');
    return converted;
  } finally { bitmap.close(); }
}
