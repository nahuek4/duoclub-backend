// backend/src/middleware/uploadApto.js
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ backend/uploads/aptos (al lado de /src)
const uploadDir = path.join(__dirname, "..", "..", "uploads", "aptos");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase(); // .pdf
    const base = path
      .basename(file.originalname || "apto", ext)
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_-]/gi, "")
      .toLowerCase();

    const unique = Date.now();
    cb(null, `${base || "apto"}_${unique}${ext || ".pdf"}`);
  },
});

function fileFilter(req, file, cb) {
  if (file?.mimetype !== "application/pdf") {
    return cb(new Error("Solo se permiten archivos PDF"), false);
  }
  cb(null, true);
}

export const uploadApto = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // ✅ 10MB
  },
});