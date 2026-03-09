import { describe, it, expect, vi } from 'vitest';
import { handleAdminUploadImage } from '../src/handlers/upload.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

function makeFile(name = 'pic.jpg', type = 'image/jpeg') {
  const bytes = new Uint8Array([1,2,3,4]);
  return new File([bytes], name, { type });
}

describe('Admin upload image', () => {
  it('rejects non-multipart content-type', async () => {
    const ctx = makeCtx();
    const req = adminRequest('POST', 'https://api.local/api/admin/upload-image', { hello: 'world' });
    const res = await handleAdminUploadImage(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('uploads file to R2 and returns URL', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ env: { IMAGES_BUCKET: { put } as any, IMAGE_BASE_URL: 'https://assets.example.com' } as any });
    const fd = new FormData();
    fd.append('file', makeFile('photo.jpg', 'image/jpeg'));
    fd.append('entity_type', 'session');
    const req = new Request('https://api.local/api/admin/upload-image', {
      method: 'POST',
      headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.com' },
      body: fd,
    });
    const res = await handleAdminUploadImage(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.image_key).toMatch(/^sessions\//);
    expect(body.url).toMatch(/^https:\/\/assets\.example\.com\/sessions\//);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('validates entity_type', async () => {
    const ctx = makeCtx();
    const fd = new FormData();
    fd.append('file', makeFile());
    fd.append('entity_type', 'wrong');
    const req = new Request('https://api.local/api/admin/upload-image', {
      method: 'POST',
      headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.com' },
      body: fd,
    });
    const res = await handleAdminUploadImage(req, ctx);
    expect(res.status).toBe(400);
  });
});
