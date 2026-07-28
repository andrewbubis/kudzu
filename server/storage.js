// Image intake for artist uploads.
//
// Every uploaded file is decoded and re-encoded by sharp before it is
// written to disk. That is deliberate: it strips EXIF (which can carry
// the artist's home GPS coordinates), and it means anything that isn't a
// real image fails to parse instead of landing in a public directory.
//
// Files live on a Railway volume mounted at UPLOAD_DIR so they survive
// deploys. Locally they land in .uploads/, which is gitignored.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '.uploads');
const MAX_BYTES = (+process.env.MAX_UPLOAD_MB || 12) * 1024 * 1024;

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Longest edge, in pixels. Big enough to look sharp on a retina display,
// small enough that six works per artist stays trivial to store.
const WORK_MAX_EDGE = 2200;
const PHOTO_MAX_EDGE = 800;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(Object.assign(new Error('unsupported_type'), { code: 'BAD_TYPE' }));
    }
    cb(null, true);
  }
});

function subdir(artistId) {
  const dir = path.join(UPLOAD_DIR, String(artistId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Re-encode an uploaded buffer and write it under the artist's folder.
 * Returns the public path plus the stored dimensions.
 */
async function store(buffer, artistId, kind) {
  const maxEdge = kind === 'photo' ? PHOTO_MAX_EDGE : WORK_MAX_EDGE;
  const name = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.webp`;
  const dest = path.join(subdir(artistId), name);

  const out = await sharp(buffer, { failOn: 'error' })
    .rotate()                       // honour EXIF orientation, then drop EXIF
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',                // never crop — the whole work is kept
      withoutEnlargement: true
    })
    .webp({ quality: 86 })
    .toFile(dest);

  return {
    path: `/uploads/${artistId}/${name}`,
    width: out.width,
    height: out.height,
    bytes: out.size
  };
}

// Remove a stored file. Missing files are fine — deletion is idempotent.
// Refuses any path that would escape UPLOAD_DIR.
function remove(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const rel = publicPath.replace(/^\/uploads\//, '');
  const abs = path.resolve(UPLOAD_DIR, rel);
  if (!abs.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return;
  fs.promises.unlink(abs).catch(() => {});
}

module.exports = { upload, store, remove, UPLOAD_DIR, MAX_BYTES };
