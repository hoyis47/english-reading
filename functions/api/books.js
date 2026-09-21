// functions/api/books.js
export async function onRequestGet(context) {
  try {
    const { env } = context;
    const bucket = env.MY_BOOK_BUCKET;

    if (!bucket) {
      return new Response(JSON.stringify({ error: "MY_BOOK_BUCKET 바인딩이 없습니다." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // R2 버킷의 books/ 경로에 있는 파일 목록 조회
    const listed = await bucket.list({ prefix: "books/" });
    const publicDomain = (env.R2_PUBLIC_DOMAIN || "").replace(/\/$/, "");

    // [수정] 폴더(books/) 제외 및 순수 .pdf 파일만 골라내기
    const books = listed.objects
      .filter((obj) => obj.key.toLowerCase().endsWith(".pdf"))
      .map((obj) => {
        // 파일 키에서 타임스탬프 제거 및 제목 가공
        const fileName = obj.key.replace(/^books\/\d+_/, "").replace(/\.pdf$/i, "");
        const decodedTitle = decodeURIComponent(fileName).replace(/_/g, " ");

        return {
          id: obj.key,
          title: decodedTitle,
          fileKey: obj.key,
          publicUrl: `${publicDomain}/${obj.key}`,
          size: obj.size,
          addedAt: new Date(obj.uploaded).toLocaleDateString(),
        };
      });

    // 최신 등록 순으로 정렬
    books.reverse();

    return new Response(JSON.stringify(books), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}