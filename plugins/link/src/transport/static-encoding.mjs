/** Compress only text assets; navigation rewrites and realtime streams stay untouched. */
export function gzipStatic(req, response) {
  if (!['GET', 'HEAD'].includes(req.method) || req.headers.range || response.status !== 200 || response.headers.has('content-encoding')) return false;
  if (!/^(?:text\/(?:javascript|css)|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)(?:;|$)/i.test(response.headers.get('content-type') || '')) return false;
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) < 1024) return false;
  let gzip, wildcard;
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    const parameter = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const quality = parameter === undefined ? 1 : Number(parameter.slice(2));
    const value = Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0;
    if (name === 'gzip') gzip = value;
    else if (name === '*') wildcard = value;
  }
  return (gzip ?? wildcard ?? 0) > 0;
}
