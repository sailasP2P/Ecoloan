
"use strict";

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const crypto = require("crypto");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3000;

const required = [
  "DATABASE_URL",
  "APP_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ADMIN_CHAT_ID",
  "TELEGRAM_ADMIN_USER_ID",
  "TELEGRAM_WEBHOOK_SECRET"
];

for (const name of required) {
  if (!process.env[name]) {
    console.error("Missing environment setting:", name);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: true }
    : undefined
});

const sms = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.TELEGRAM_ADMIN_CHAT_ID);
const ADMIN_USER_ID = String(process.env.TELEGRAM_ADMIN_USER_ID);
const APP_SECRET = process.env.APP_SECRET;
const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

app.use(helmet());
app.use(express.json({ limit: "20kb" }));
app.use(express.static("public"));

const applicationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later." }
});

const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many verification attempts. Please wait." }
});

function randomCode(length) {
  const max = 10 ** length;
  return crypto.randomInt(0, max).toString().padStart(length, "0");
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hash(value) {
  return crypto
    .createHmac("sha256", APP_SECRET)
    .update(String(value))
    .digest("hex");
}

function safeCompare(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function authenticateApplication(applicationId, token) {
  if (!applicationId || !token) return null;

  const result = await pool.query(
    `SELECT * FROM applications
     WHERE id = $1 AND token_hash = $2`,
    [applicationId, hash(token)]
  );

  return result.rows[0] || null;
}

async function sendSMS(phone, message) {
  await sms.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone
  });
}

async function telegram(method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error("Telegram request failed");
  }

  return result;
}

/* Create a new loan application */

app.post("/api/applications", applicationLimiter, async (req, res) => {
  try {
    const {
      amount,
      term,
      purpose,
      purposeDetails,
      firstName,
      lastName,
      email,
      phone
    } = req.body || {};

    const validPhone = /^\+[1-9]\d{7,14}$/.test(phone || "");
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");

    if (
      !Number.isInteger(amount) ||
      amount < 1000 ||
      amount > 50000 ||
      !Number.isInteger(term) ||
      term < 1 ||
      term > 12 ||
      !purpose ||
      !firstName ||
      !lastName ||
      !validEmail ||
      !validPhone
    ) {
      return res.status(400).json({
        message: "Please check your application details."
      });
    }

    const allowedPurposes = [
      "Business",
      "Education",
      "Medical expenses",
      "Family needs",
      "Emergency",
      "Other"
    ];

    if (!allowedPurposes.includes(purpose)) {
      return res.status(400).json({
        message: "Please select a valid loan purpose."
      });
    }

    const applicationToken = randomToken();
    const code = randomCode(4);
    const applicationId = crypto.randomUUID();

    const result = await pool.query(
      `INSERT INTO applications (
        id, token_hash, amount, term, purpose, purpose_details,
        first_name, last_name, email, phone, status,
        application_code_hash, application_code_expires,
        created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        'pending_verification',$11,NOW() + INTERVAL '10 minutes',NOW()
      )
      RETURNING id`,
      [
        applicationId,
        hash(applicationToken),
        amount,
        term,
        purpose,
        String(purposeDetails || "").slice(0, 1000),
        String(firstName).trim().slice(0, 80),
        String(lastName).trim().slice(0, 80),
        String(email).trim().toLowerCase(),
        phone,
        hash(code)
      ]
    );

    await sendSMS(
      phone,
      `Your independent loan application verification code is ${code}. It expires in 10 minutes. Never share this code with anyone.`
    );

    return res.status(201).json({
      applicationId: result.rows[0].id,
      applicationToken
    });
  } catch (error) {
    console.error("Application creation error:", error.message);
    return res.status(500).json({
      message: "Unable to submit your application. Please try again later."
    });
  }
});

/* Verify the first four-digit application code */

app.post(
  "/api/applications/verify",
  verificationLimiter,
  async (req, res) => {
    try {
      const { applicationId, applicationToken, code } = req.body || {};

      if (!/^\d{4}$/.test(code || "")) {
        return res.status(400).json({ message: "Invalid verification code." });
      }

      const application = await authenticateApplication(
        applicationId,
        applicationToken
      );

      if (!application || application.status !== "pending_verification") {
        return res.status(400).json({
          message: "Application could not be verified."
        });
      }

      if (
        !application.application_code_expires ||
        new Date(application.application_code_expires) < new Date() ||
        !safeCompare(hash(code), application.application_code_hash)
      ) {
        return res.status(400).json({
          message: "The code is incorrect or has expired."
        });
      }

      await pool.query(
        `UPDATE applications
         SET status = 'pending_admin',
             application_code_hash = NULL,
             application_code_expires = NULL
         WHERE id = $1`,
        [application.id]
      );

      const message =
        `New loan application for administrator review\n\n` +
        `Application ID: ${application.id}\n` +
        `Applicant: ${application.first_name} ${application.last_name}\n` +
        `Amount: KSh ${Number(application.amount).toLocaleString("en-KE")}\n` +
        `Term: ${application.term} months\n` +
        `Purpose: ${application.purpose}\n\n` +
        `Review this application using the buttons below.`;

      await telegram("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: message,
        reply_markup: {
          inline_keyboard: [[
            {
              text: "Approve",
              callback_data: `approve:${application.id}`
            },
            {
              text: "Reject",
              callback_data: `reject:${application.id}`
            }
          ]]
        }
      });

      return res.json({ message: "Application verified." });
    } catch (error) {
      console.error("Application verification error:", error.message);
      return res.status(500).json({
        message: "Unable to verify right now. Please try again."
      });
    }
  }
);

/* Check application status */

app.get("/api/applications/status", async (req, res) => {
  try {
    const applicationId = req.query.applicationId;
    const token = getBearerToken(req);

    const application = await authenticateApplication(
      applicationId,
      token
    );

    if (!application) {
      return res.status(404).json({ message: "Application not found." });
    }

    return res.json({ status: application.status });
  } catch (error) {
    console.error("Status error:", error.message);
    return res.status(500).json({ message: "Unable to check status." });
  }
});

/* Telegram administrator approval and rejection */

app.post("/api/telegram/webhook", async (req, res) => {
  try {
    if (
      !safeCompare(
        req.headers["x-telegram-bot-api-secret-token"] || "",
        TELEGRAM_SECRET
      )
    ) {
      return res.sendStatus(401);
    }

    const callback = req.body && req.body.callback_query;

    if (!callback) return res.sendStatus(200);

    const userId = String(callback.from && callback.from.id);
    const chatId = String(
      callback.message && callback.message.chat &&
      callback.message.chat.id
    );

    if (userId !== ADMIN_USER_ID || chatId !== ADMIN_CHAT_ID) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "You are not authorized to perform this action.",
        show_alert: true
      });

      return res.sendStatus(200);
    }

    const match = /^(approve|reject):([0-9a-f-]{36})$/i.exec(
      callback.data || ""
    );

    if (!match) return res.sendStatus(200);

    const action = match[1];
    const applicationId = match[2];

    const result = await pool.query(
      "SELECT * FROM applications WHERE id = $1",
      [applicationId]
    );

    const application = result.rows[0];

    if (!application || application.status !== "pending_admin") {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "This application has already been processed.",
        show_alert: true
      });

      return res.sendStatus(200);
    }

    if (action === "reject") {
      await pool.query(
        `UPDATE applications
         SET status = 'rejected', reviewed_at = NOW()
         WHERE id = $1 AND status = 'pending_admin'`,
        [applicationId]
      );

      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Application rejected."
      });

      await telegram("editMessageReplyMarkup", {
        chat_id: ADMIN_CHAT_ID,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });

      return res.sendStatus(200);
    }

    const finalCode = randomCode(6);

    await pool.query(
      `UPDATE applications
       SET status = 'approved',
           final_code_hash = $1,
           final_code_expires = NOW() + INTERVAL '10 minutes',
           reviewed_at = NOW()
       WHERE id = $2 AND status = 'pending_admin'`,
      [hash(finalCode), applicationId]
    );

    await sendSMS(
      application.phone,
      `Your independent loan application has passed the administrator review stage. Your final verification code is ${finalCode}. It expires in 10 minutes. Never share it.`
    );

    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Application approved. Final verification SMS sent."
    });

    await telegram("editMessageReplyMarkup", {
      chat_id: ADMIN_CHAT_ID,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("Telegram webhook error:", error.message);
    return res.sendStatus(500);
  }
});

/* Verify the final six-digit code */

app.post(
  "/api/applications/verify-final",
  verificationLimiter,
  async (req, res) => {
    try {
      const { applicationId, applicationToken, code } = req.body || {};

      if (!/^\d{6}$/.test(code || "")) {
        return res.status(400).json({ message: "Invalid verification code." });
      }

      const application = await authenticateApplication(
        applicationId,
        applicationToken
      );

      if (!application || application.status !== "approved") {
        return res.status(400).json({
          message: "Application is not ready for final verification."
        });
      }

      if (
        !application.final_code_expires ||
        new Date(application.final_code_expires) < new Date() ||
        !safeCompare(hash(code), application.final_code_hash)
      ) {
        return res.status(400).json({
          message: "The code is incorrect or has expired."
        });
      }

      await pool.query(
        `UPDATE applications
         SET status = 'completed',
             final_code_hash = NULL,
             final_code_expires = NULL,
             completed_at = NOW()
         WHERE id = $1`,
        [application.id]
      );

      return res.json({
        message: "Verification completed. This does not confirm disbursement."
      });
    } catch (error) {
      console.error("Final verification error:", error.message);
      return res.status(500).json({
        message: "Unable to complete verification. Please try again."
      });
    }
  }
);

/* Resend final verification code */

app.post(
  "/api/applications/resend-final",
  verificationLimiter,
  async (req, res) => {
    try {
      const { applicationId, applicationToken } = req.body || {};

      const application = await authenticateApplication(
        applicationId,
        applicationToken
      );

      if (!application || application.status !== "approved") {
        return res.status(400).json({
          message: "Application is not ready for final verification."
        });
      }

      const code = randomCode(6);

      await pool.query(
        `UPDATE applications
         SET final_code_hash = $1,
             final_code_expires = NOW() + INTERVAL '10 minutes'
         WHERE id = $2 AND status = 'approved'`,
        [hash(code), application.id]
      );

      await sendSMS(
        application.phone,
        `Your new independent loan application verification code is ${code}. It expires in 10 minutes. Never share it.`
      );

      return res.json({
        message: "A new verification code has been sent."
      });
    } catch (error) {
      console.error("Resend code error:", error.message);
      return res.status(500).json({
        message: "Unable to send a new code. Please try again later."
      });
    }
  }
);

/* General error handler */

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);
  res.status(500).json({ message: "An unexpected error occurred." });
});

app.listen(PORT, () => {
  console.log(`Loan service server running on port ${PORT}`);
});
