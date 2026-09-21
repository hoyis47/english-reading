// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors()); // 모든 접근 허용

const upload = multer({ storage: multer.memoryStorage() });

// 백엔드 Node.js에서 R2와 직접 통신 (CORS 차단 전혀 없음)
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.VITE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.VITE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.VITE_R2_SECRET_ACCESS_KEY,
  },
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "파일이 없습니다." });

    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileKey = `books/${timestamp}_${safeName}`;

    await r2.send(
      new PutObjectCommand({
        Bucket: "english-reading",
        Key: fileKey,
        Body: file.buffer,
        ContentType: "application/pdf",
      })
    );

    const publicDomain = (process.env.VITE_R2_PUBLIC_DOMAIN || "").replace(/\/$/, "");
    const publicUrl = `${publicDomain}/${fileKey}`;

    console.log(`✅ R2 업로드 완료: ${fileKey}`);
    res.json({ success: true, fileKey, publicUrl });
  } catch (error) {
    console.error("❌ R2 업로드 오류:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, "0.0.0.0", () => {
  console.log("🚀 로컬 업로드 서버 실행 중 (포트 3001)");
});