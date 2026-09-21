// functions/api/upload.js
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    // Cloudflare 대시보드에서 연결할 R2 바인딩 변수명: MY_BOOK_BUCKET
    const bucket = env.MY_BOOK_BUCKET;
    if (!bucket) {
      return new Response(JSON.stringify({ error: "R2 버킷 바인딩(MY_BOOK_BUCKET)이 설정되지 않았습니다." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return new Response(JSON.stringify({ error: "업로드할 파일이 없습니다." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 영문/숫자 기반 고유 키 생성
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileKey = `books/${timestamp}_${safeName}`;

    // R2 버킷에 직접 바이너리 스트림 기록 (인증키 불필요)
    await bucket.put(fileKey, file.stream(), {
      httpMetadata: {
        contentType: "application/pdf",
      },
    });

    // R2 공개 URL 조합 (Cloudflare 환경변수에서 가져옴)
    const publicDomain = (env.R2_PUBLIC_DOMAIN || "").replace(/\/$/, "");
    const publicUrl = publicDomain ? `${publicDomain}/${fileKey}` : "";

    return new Response(
      JSON.stringify({
        success: true,
        fileKey,
        publicUrl,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}