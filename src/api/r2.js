// src/api/r2.js
export async function uploadPdfToR2(file) {
  const formData = new FormData();
  formData.append("file", file);

  // 로컬 개발 환경(Vite 개발서버)일 때는 로컬 Express 포트로, 배포 시에는 상대 경로(/api/upload) 사용
  const isLocalDev = window.location.hostname === "localhost" && window.location.port === "5173";
  const uploadEndpoint = isLocalDev
    ? "http://localhost:3001/api/upload"
    : "/api/upload";

  const response = await fetch(uploadEndpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || "서버 업로드 실패");
  }

  return await response.json();
}