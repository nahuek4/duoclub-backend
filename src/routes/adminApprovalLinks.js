// backend/src/routes/adminApprovalLinks.js
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { fireAndForget, BRAND_URL } from "../mail.js";
import { sendUserApprovalResultEmail } from "../mail.js";

const router = express.Router();

function renderHtml(title, bodyHtml) {
  return `<!doctype html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta charset="utf-8" />
      <title>${title}</title>
      <style>
        body{ font-family: Arial, sans-serif; background:#f5f6f8; margin:0; padding:24px; }
        .card{ max-width:680px; margin:0 auto; background:#fff; border:1px solid #e7e7ea; border-radius:16px; overflow:hidden; }
        .pad{ padding:18px 18px; }
        .h{ font-size:18px; font-weight:800; margin:0 0 8px; }
        .p{ color:#333; line-height:1.45; margin:0 0 10px; }
        .muted{ color:#666; font-size:12px; }
        .btn{ display:inline-block; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700; }
        .btn-dark{ background:#111; color:#fff; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="pad">
          <div class="h">${title}</div>
          ${bodyHtml}
        </div>
      </div>
    </body>
  </html>`;
}

/**
 * GET /auth/admin-approval?t=TOKEN
 * TOKEN payload: { uid, action, kind: "admin_approval" }
 * action: "approved" | "rejected"
 */
router.get("/admin-approval", async (req, res) => {
  try {
    const token = String(req.query.t || "").trim();
    if (!token) {
      return res
        .status(400)
        .send(renderHtml("Token faltante", `<p class="p">Falta el token.</p>`));
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res
        .status(500)
        .send(renderHtml("Config faltante", `<p class="p">No hay JWT_SECRET configurado.</p>`));
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (e) {
      return res
        .status(400)
        .send(renderHtml("Link inválido", `<p class="p">El link es inválido o venció.</p>`));
    }

    const uid = payload?.uid;
    const action = payload?.action;
    const kind = payload?.kind;

    if (kind !== "admin_approval" || !uid || !["approved", "rejected"].includes(action)) {
      return res
        .status(400)
        .send(renderHtml("Link inválido", `<p class="p">El link es inválido.</p>`));
    }

    const user = await User.findById(uid);
    if (!user) {
      return res
        .status(404)
        .send(renderHtml("No encontrado", `<p class="p">Usuario inexistente.</p>`));
    }

    // ✅ si querés forzar que NO se apruebe sin verificación:
    if (action === "approved" && !user.emailVerified) {
      return res.status(400).send(
        renderHtml(
          "No se puede aprobar",
          `<p class="p">Este usuario todavía <b>no verificó el email</b>. Primero debe verificarlo.</p>`
        )
      );
    }

    // idempotencia
    if (String(user.approvalStatus || "pending") === action) {
      return res.send(
        renderHtml(
          "Acción ya aplicada",
          `<p class="p">Este usuario ya estaba en estado: <b>${action}</b>.</p><p class="muted">Podés cerrar esta ventana.</p>`
        )
      );
    }

    user.approvalStatus = action;
    // ✅ si aprobás, liberá el acceso
    if (action === "approved") user.suspended = false;
    if (action === "rejected") user.suspended = true;

    await user.save();

    // ✅ mail al usuario con link directo
    fireAndForget(() => sendUserApprovalResultEmail(user, action), "MAIL_APPROVAL_RESULT");

    const fullName = `${user.name || ""} ${user.lastName || ""}`.trim() || user.email;

    return res.send(
      renderHtml(
        action === "approved" ? "Usuario aprobado" : "Usuario rechazado",
        `
          <p class="p">
            Usuario: <b>${fullName}</b><br/>
            Email: <b>${user.email}</b><br/>
            Estado actualizado a: <b>${action}</b>
          </p>
          <p class="muted">Ya podés cerrar esta ventana.</p>
          ${
            BRAND_URL
              ? `<div style="margin-top:12px;">
                  <a class="btn btn-dark" href="${BRAND_URL}">Ir a DUO</a>
                </div>`
              : ""
          }
        `
      )
    );
  } catch (e) {
    console.log("[admin-approval] error:", e);
    return res
      .status(500)
      .send(renderHtml("Error", `<p class="p">Ocurrió un error procesando la acción.</p>`));
  }
});

export default router;
