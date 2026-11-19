import { assertSameOrigin, readJson } from '../../base/shared/http.mjs';

const noStore = { 'cache-control': 'no-store' };

function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  return first < size && (last === null || last >= first) ? { start: first, end: Math.min(last ?? size - 1, size - 1) } : null;
}

export function mountMediaGenerationWeb(ctx, generation) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/benchgo/media/settings', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        assertSameOrigin(request, { allowDesktopOrigin: true });
        if (request.method === 'GET') {
          return Response.json({ settings: await generation.getSettings() }, { headers: noStore });
        }
        const { settings, revision } = await readJson(request);
        return Response.json({ settings: await generation.updateSettings(settings, revision) }, { headers: noStore });
      } catch (error) {
        return Response.json({ error: error.message }, { status: error.status ?? 400, headers: noStore });
      }
    },
  }));
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/benchgo/media/artifact', methods: ['GET', 'HEAD'], requestBody: 'buffered',
    async fetch(request) {
      try { assertSameOrigin(request, { allowDesktopOrigin: true }); }
      catch (error) { return new Response(error.message, { status: error.status, headers: noStore }); }
      const query = new URL(request.url).searchParams;
      const name = query.get('file');
      if (!name || !/^[a-z0-9_.-]{1,200}$/iu.test(name)) return new Response('Invalid artifact', { status: 400, headers: noStore });
      const file = await generation.artifact(name);
      if (!file) return new Response('Artifact not found', { status: 404, headers: noStore });
      const rangeHeader = request.method === 'GET' && !request.headers.has('if-range') ? request.headers.get('range') : null;
      const range = rangeHeader ? byteRange(rangeHeader, file.bytes) : null;
      if (!range && rangeHeader?.toLowerCase().startsWith('bytes=')) {
        return new Response(null, { status: 416, headers: { ...noStore, 'content-range': `bytes */${file.bytes}` } });
      }
      const disposition = query.get('download') === '1' || file.mimeType === 'image/svg+xml' ? 'attachment' : 'inline';
      return new Response(request.method === 'HEAD' ? null : file.stream(range), { status: range ? 206 : 200, headers: {
        'content-type': file.mimeType,
        'content-length': String(range ? range.end - range.start + 1 : file.bytes),
        'accept-ranges': 'bytes',
        ...(range && { 'content-range': `bytes ${range.start}-${range.end}/${file.bytes}` }),
        'content-disposition': `${disposition}; filename="${name}"`,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      } });
    },
  }));
}
