// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"; // ListObjectsV2Command 추가
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.VITE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.VITE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.VITE_R2_SECRET_ACCESS_KEY,
  },
});

// 1. 책 등록 (업로드)
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

// 2. [추가] R2 버킷에 저장된 책 목록 조회 (로컬용)
app.get("/api/books", async (req, res) => {
  try {
    const data = await r2.send(
      new ListObjectsV2Command({
        Bucket: "english-reading",
        Prefix: "books/",
      })
    );

    const publicDomain = (process.env.VITE_R2_PUBLIC_DOMAIN || "").replace(/\/$/, "");
    const items = data.Contents || [];

    const books = items
      .filter((obj) => obj.Key !== "books/") // 폴더 자체 항목 제외
      .map((obj) => {
        const fileName = obj.Key.replace(/^books\/\d+_/, "").replace(/\.pdf$/i, "");
        const title = decodeURIComponent(fileName).replace(/_/g, " ");

        return {
          id: obj.Key,
          title: title,
          fileKey: obj.Key,
          publicUrl: `${publicDomain}/${obj.Key}`,
          size: obj.Size,
          addedAt: new Date(obj.LastModified).toLocaleDateString(),
        };
      });

    books.reverse(); // 최신순 정렬
    res.json(books);
  } catch (error) {
    console.error("❌ R2 목록 조회 오류:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, "0.0.0.0", () => {
  console.log("🚀 로컬 업로드/조회 서버 실행 중 (포트 3001)");
});