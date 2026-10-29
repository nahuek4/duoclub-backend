import path from 'node:path';

// Medical PDFs must be served through the authenticated /users/:id/apto route.
export function blockPublicMedicalUploads(req, res, next) {
  let decoded;
  try { decoded = decodeURIComponent(req.path || '/'); }
  catch { return res.status(404).end(); }
  const normalized = path.posix.normalize('/' + decoded.replace(/\\/g, '/')).toLowerCase();
  if (normalized === '/aptos' || normalized.startsWith('/aptos/')) {
    return res.status(404).set('Cache-Control', 'no-store').end();
  }
  return next();
}
