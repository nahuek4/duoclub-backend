// backend/src/routes/testMail.js
import express from "express";
import { sendMail, ADMIN_EMAIL } from "../mail/core.js";

const router = express.Router();

/**
 * GET /api/test-mail?to=alguien@gmail.com
 */
router.get("/", async (req, res) => {
  try {
    const to = String(req.query.to || ADMIN_EMAIL || "").trim();

    await sendMail(
      to,
      "TEST DUO ✅",
      "Si recibís esto, el SMTP funciona.",
      "<b>Si recibís esto, el SMTP funciona.</b>"
    );

    return res.json({ ok: true, sentTo: to });
  } catch (e) {
    console.log("[TEST MAIL] failed:", e);
    return res.status(500).json({
      ok: false,
      message: e?.message || String(e),
      code: e?.code,
      response: e?.response,
      responseCode: e?.responseCode,
    });
  }
});

export default router;
