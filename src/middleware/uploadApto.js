// backend/src/middleware/uploadApto.js
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// backend/uploads/aptos (al lado de /src)
const uploadDir = path.join(__dirname, "..", "..", "uploads", "aptos");
fs.mkdirSync(uploadDir, { recursive: true });

function safeBaseName(filename = "") {
  const ext = path.extname(filename || "").toLowerCase();
  return path
    .basename(filename || "apto", ext)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/gi, "")
    .toLowerCase();
}

function safePdfExtension(filename = "", mimetype = "") {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext === ".pdf") return ".pdf";
  if (String(mimetype || "").toLowerCase() === "application/pdf") return ".pdf";
  return "";
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const ext = safePdfExtension(file?.originalname || "", file?.mimetype || "");
    const base = safeBaseName(file?.originalname || "apto");
    const unique = `${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    cb(null, `${base || "apto"}_${unique}${ext || ".pdf"}`);
  },
});

function fileFilter(req, file, cb) {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(String(file?.originalname || "")).toLowerCase();

  const isPdfMime =
    mimetype === "application/pdf" ||
    mimetype === "application/octet-stream";

  const isPdfExt = ext === ".pdf";

  if (!isPdfMime && !isPdfExt) {
    return cb(new Error("Solo se permiten archivos PDF"), false);
  }

  cb(null, true);
}

export const uploadApto = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

export default uploadApto;
