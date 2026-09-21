import React, { useState, useEffect, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { analyzeWithGemini } from "./api/gemini";
import { uploadPdfToR2 } from "./api/r2";

// [WebKit/Safari 호환] 태블릿 ReadableStream 비동기 이터레이터 폴리필
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

// PDF.js 워커 세팅
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export default function App() {
  const [pdfDoc, setPdfDoc] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [pageText, setPageText] = useState("");
  const [loading, setLoading] = useState(false);
  const [bookTitle, setBookTitle] = useState("English Book Reader");

  // R2 버킷에서 동기화되는 서버 책 목록
  const [savedBooks, setSavedBooks] = useState([]);
  const [activeBookId, setActiveBookId] = useState(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isFetchingBooks, setIsFetchingBooks] = useState(false);

  // 테마 모드: 'day' / 'night'
  const [theme, setTheme] = useState("day");

  // 제미나이 분석 패널
  const [panel, setPanel] = useState({
    visible: false,
    selectedText: "",
    data: null,
    loading: false,
    error: null,
  });

  // [핵심 1] 로컬/배포 환경 자동 판별 및 R2 책 목록 불러오기
  const fetchBooksFromServer = useCallback(async () => {
    setIsFetchingBooks(true);
    try {
      // 로컬 개발 환경(포트 5173)이면 로컬 백엔드(3001)로, 배포 환경이면 Cloudflare Functions(/api/books)로 요청
      const isLocalDev = window.location.hostname === "localhost" && window.location.port === "5173";
      const endpoint = isLocalDev ? "http://localhost:3001/api/books" : "/api/books";

      const res = await fetch(endpoint);
      if (!res.ok) {
        throw new Error(`목록 조회 실패: HTTP ${res.status}`);
      }
      const data = await res.json();
      setSavedBooks(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("R2 책 목록 불러오기 실패:", err);
    } finally {
      setIsFetchingBooks(false);
    }
  }, []);

  // 화면 첫 마운트 시 책 목록 자동 조회
  useEffect(() => {
    fetchBooksFromServer();
  }, [fetchBooksFromServer]);

  // 브라우저 내장 TTS 음성 낭독
  const speakText = (textToSpeak) => {
    if (!("speechSynthesis" in window)) {
      alert("현재 브라우저 환경에서 음성 기능을 지원하지 않습니다.");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = "en-US";
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  };

  // R2 URL로부터 PDF 로드
  const loadPdfSource = async (url, title, bookId = null, startPage = 1) => {
    setLoading(true);
    setBookTitle(title);
    if (bookId) setActiveBookId(bookId);

    try {
      const loadingTask = pdfjsLib.getDocument({
        url: url,
        cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
        cMapPacked: true,
      });

      const loadedPdf = await loadingTask.promise;
      setPdfDoc(loadedPdf);
      setTotalPages(loadedPdf.numPages);
      setCurrentPage(startPage);
      await extractPageText(loadedPdf, startPage);
    } catch (err) {
      console.error("PDF 열람 오류:", err);
      alert("PDF를 불러오는 중 오류가 발생했습니다: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  // [핵심 2] 신규 PDF를 R2에 등록하고 즉시 전체 목록 재동기화
  const handleRegisterBook = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const title = file.name.replace(/\.[^/.]+$/, "");
    setIsUploading(true);

    try {
      // 1. Cloudflare R2에 업로드 (로컬은 server.js:3001, 배포는 /api/upload)
      const { fileKey, publicUrl } = await uploadPdfToR2(file);

      // 2. 서버의 R2 버킷 목록을 즉시 다시 읽어와 서재 동기화
      await fetchBooksFromServer();

      // 3. 업로드 완료 즉시 화면에 책 펼치기
      await loadPdfSource(publicUrl, title, fileKey, 1);
      setIsLibraryOpen(false);
      alert(`[${title}] 책이 R2 클라우드에 안전하게 등록되었습니다!`);
    } catch (err) {
      console.error("R2 업로드 실패:", err);
      alert("R2 등록 중 오류가 발생했습니다: " + err.message);
    } finally {
      setIsUploading(false);
      e.target.value = ""; // 파일 인풋 초기화
    }
  };

  // 등록된 책 닫기/해제 (화면 비우기)
  const handleCloseActiveBook = (id, e) => {
    e.stopPropagation();
    if (activeBookId === id) {
      setPdfDoc(null);
      setPageText("");
      setBookTitle("English Book Reader");
      setActiveBookId(null);
    }
  };

  // 텍스트 추출 로직 (소설 머리글 필터 및 줄바꿈 보존)
  const extractPageText = async (doc, pageNum) => {
    setLoading(true);
    try {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();

      if (!textContent || !textContent.items || textContent.items.length === 0) {
        setPageText("이 페이지에서 텍스트를 추출할 수 없습니다. (스캔된 이미지 PDF일 수 있습니다.)");
        return;
      }

      let rawText = textContent.items
        .map((item) => (item.str ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      rawText = rawText.replace(/^\s*\d+\s*\|\s*P\s*a\s*g\s*e\s*Twilight\s*[-–—]\s*Steph[a|e]nie\s+Meyer\s*/i, "");
      rawText = rawText.replace(/^\s*\d+\s*\|\s*Page[^\n.]*?Meyer\s*/i, "");
      rawText = rawText.replace(/^\s*(?:Page\s*)?\d+\s*/i, "");
      rawText = rawText.replace(/^([A-Z\s]{4,})\s+([A-Z][a-z"“'‘])/g, "$1\n\n$2");
      const formatted = rawText.replace(/([.!?])\s+(?=[A-Z"“'‘])/g, "$1\n\n");

      setPageText(formatted.trim() || rawText);
    } catch (err) {
      console.error("텍스트 파싱 오류:", err);
      setPageText("텍스트 파싱 중 오류가 발생했습니다: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  // 페이지 이동
  const changePage = (offset) => {
    const newPage = currentPage + offset;
    if (newPage >= 1 && newPage <= totalPages && pdfDoc) {
      setCurrentPage(newPage);
      setPanel((prev) => ({ ...prev, visible: false }));
      extractPageText(pdfDoc, newPage);
    }
  };

  // 텍스트 선택 감지 및 Gemini API 호출
  const handleTextSelection = async () => {
    setTimeout(async () => {
      const selection = window.getSelection();
      const selectedText = selection ? selection.toString().trim() : "";

      if (selectedText.length >= 2) {
        const wordCount = selectedText.split(/\s+/).length;
        const isSentence = wordCount >= 5 || selectedText.includes(".");

        let contextSentence = "";
        if (!isSentence && selection.anchorNode) {
          contextSentence = selection.anchorNode.textContent || "";
        }

        setPanel({
          visible: true,
          selectedText: selectedText,
          data: null,
          loading: true,
          error: null,
        });

        const res = await analyzeWithGemini({
          type: isSentence ? "sentence" : "word_or_phrase",
          text: selectedText,
          fullSentence: contextSentence,
        });

        if (res.error) {
          setPanel((prev) => ({ ...prev, loading: false, error: res.error }));
        } else {
          setPanel((prev) => ({ ...prev, loading: false, data: res }));
        }
      }
    }, 150);
  };

  const isNight = theme === "night";

  return (
    <div
      className={`min-h-screen transition-colors duration-300 font-serif p-4 md:p-6 flex flex-col items-center ${
        isNight ? "bg-[#18181A] text-[#D1D1D6]" : "bg-[#F7F4EE] text-[#2C2C2C]"
      }`}
    >
      {/* 상단 헤더 */}
      <header
        className={`w-full max-w-6xl rounded-xl shadow-sm border p-4 mb-4 flex flex-wrap items-center justify-between gap-4 font-sans transition-colors duration-300 ${
          isNight ? "bg-[#222226] border-[#323238] text-stone-200" : "bg-white border-stone-200 text-stone-800"
        }`}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <h1
            className="text-xl font-bold flex items-center gap-2 max-w-xs sm:max-w-md truncate"
            title={bookTitle}
          >
            📖 {bookTitle}
          </h1>

          {/* 서재 모달 열기 버튼 */}
          <button
            onClick={() => {
              fetchBooksFromServer();
              setIsLibraryOpen(true);
            }}
            className="text-sm px-3.5 py-2 rounded-lg font-medium transition shadow-sm bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1.5"
          >
            📚 등록된 책 서재 ({savedBooks.length})
          </button>

          {/* R2 클라우드 새 책 등록 버튼 */}
          <label
            className={`cursor-pointer text-sm px-3.5 py-2 rounded-lg font-medium transition shadow-sm flex items-center gap-1.5 ${
              isNight ? "bg-[#2C2C32] hover:bg-[#383842] text-amber-300 border border-[#3E3E46]" : "bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-300"
            }`}
          >
            {isUploading ? "☁️ R2 업로드 중..." : "+ 새 책 등록(R2)"}
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handleRegisterBook}
              disabled={isUploading}
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          {/* 낮 모드 / 밤 모드 토글 */}
          <button
            onClick={() => setTheme(isNight ? "day" : "night")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition ${
              isNight ? "bg-[#2C2C32] border-[#3E3E46] text-amber-300 hover:bg-[#383842]" : "bg-stone-100 border-stone-300 text-stone-700 hover:bg-stone-200"
            }`}
          >
            {isNight ? "☀️ 낮 모드" : "🌙 밤 모드"}
          </button>

          {/* 페이지 이동 컨트롤 */}
          {totalPages > 0 && (
            <div className={`flex items-center gap-2 text-sm ${isNight ? "text-stone-300" : "text-stone-600"}`}>
              <button
                onClick={() => changePage(-1)}
                disabled={currentPage <= 1 || loading}
                className={`px-3 py-1.5 rounded-md border transition disabled:opacity-30 disabled:cursor-not-allowed ${
                  isNight ? "border-[#3E3E46] hover:bg-[#2E2E36]" : "border-stone-300 hover:bg-stone-100"
                }`}
              >
                ◀ 이전
              </button>
              <span className="font-medium px-1">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={() => changePage(1)}
                disabled={currentPage >= totalPages || loading}
                className={`px-3 py-1.5 rounded-md border transition disabled:opacity-30 disabled:cursor-not-allowed ${
                  isNight ? "border-[#3E3E46] hover:bg-[#2E2E36]" : "border-stone-300 hover:bg-stone-100"
                }`}
              >
                다음 ▶
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 가이드 바 */}
      <div className={`w-full max-w-6xl mb-3 text-xs font-sans flex flex-wrap gap-4 px-2 ${isNight ? "text-stone-400" : "text-stone-500"}`}>
        <span>💡 <b>단어 드래그</b>: 발음기호 & 원어민 발음(🔊) + 품사/뜻</span>
        <span>💡 <b>문장 드래그</b>: 문장 전체 낭독 + 주어·동사 + 연어/구동사 + 회화 패턴</span>
      </div>

      {/* 메인 뷰어 및 사이드바 영역 */}
      <div className="w-full max-w-6xl flex flex-col lg:flex-row gap-6 items-start">
        {/* 원서 본문 뷰어 */}
        <main
          onMouseUp={handleTextSelection}
          onTouchEnd={handleTextSelection}
          className={`flex-1 w-full min-h-[700px] rounded-xl shadow-sm border p-6 sm:p-10 md:p-12 leading-loose text-lg break-words transition-colors duration-300 ${
            isNight
              ? "bg-[#202024] border-[#2F2F35] text-[#E0DFD5] selection:bg-amber-500/30 selection:text-white"
              : "bg-[#FFFDF9] border-stone-200 text-[#2B2824] selection:bg-amber-200 selection:text-black"
          }`}
        >
          {loading && (
            <div className={`text-center py-24 font-sans animate-pulse ${isNight ? "text-stone-500" : "text-stone-400"}`}>
              클라우드(R2)에서 책을 불러오는 중입니다...
            </div>
          )}

          {!loading && !pageText && (
            <div className={`text-center py-28 font-sans ${isNight ? "text-stone-500" : "text-stone-400"}`}>
              상단의 <b>[📚 등록된 책 서재]</b>를 열어 책을 선택하거나, <b>[+ 새 책 등록(R2)]</b>으로 PDF를 클라우드에 올려보세요!
            </div>
          )}

          {!loading && pageText && (
            <div className="whitespace-pre-line tracking-normal select-text">
              {pageText}
            </div>
          )}
        </main>

        {/* 분석 사이드바 패널 */}
        {panel.visible && (
          <aside
            className={`w-full lg:w-[440px] rounded-xl shadow-xl border p-5 font-sans sticky top-6 max-h-[92vh] overflow-y-auto transition-colors duration-300 ${
              isNight ? "bg-[#1E1E22] border-[#313138] text-stone-200" : "bg-stone-900 border-stone-800 text-stone-100"
            }`}
          >
            <div className={`flex justify-between items-center mb-3 pb-2 border-b ${isNight ? "border-stone-700/60" : "border-stone-800"}`}>
              <span className="font-semibold text-amber-400 text-xs tracking-wider uppercase">
                {panel.data?.type === "word" ? "단어/표현 사전" : "문장 구조 & 표현 분석"}
              </span>
              <button
                onClick={() => setPanel((prev) => ({ ...prev, visible: false }))}
                className="text-stone-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-stone-800 transition"
              >
                ✕ 닫기
              </button>
            </div>

            <div className="mb-4 p-3 bg-stone-800/60 rounded-lg border border-stone-700/50 flex flex-col gap-2">
              <div className="text-xs text-stone-300 italic">"{panel.selectedText}"</div>
              <div className="flex justify-end">
                <button
                  onClick={() => speakText(panel.selectedText)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-stone-700/80 hover:bg-stone-700 text-stone-200 rounded transition font-medium border border-stone-600/50 shadow-sm"
                >
                  🔊 소리 듣기
                </button>
              </div>
            </div>

            {panel.loading && (
              <div className="py-10 text-stone-400 text-center animate-pulse text-xs">
                Gemini가 구문과 표현 덩어리를 분석하고 있습니다...
              </div>
            )}

            {panel.error && (
              <div className="p-3 bg-red-950/50 border border-red-800/50 rounded-lg text-red-300 text-xs leading-relaxed">
                {panel.error}
              </div>
            )}

            {!panel.loading && panel.data && (
              <div className="space-y-4 text-xs md:text-sm">
                {panel.data.type === "word" ? (
                  <div className="bg-stone-800/40 p-4 rounded-lg border border-stone-800 space-y-3">
                    <div className="flex items-center justify-between gap-2 border-b border-stone-800/80 pb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-stone-400 text-xs">원형:</span>
                        <b className="text-white text-base">{panel.data.base}</b>
                        {panel.data.ipa && (
                          <span className="text-amber-300/90 font-mono text-xs px-1.5 py-0.5 bg-stone-900 rounded border border-stone-700">
                            {panel.data.ipa}
                          </span>
                        )}
                        <button
                          onClick={() => speakText(panel.data.base)}
                          className="p-1 rounded hover:bg-stone-700 text-stone-300 hover:text-white transition"
                        >
                          🔊
                        </button>
                      </div>
                      {panel.data.pos && (
                        <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-400/20 text-amber-300 border border-amber-400/30 whitespace-nowrap">
                          {panel.data.pos}
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="text-stone-400 text-[11px] mb-1">문맥 뜻:</div>
                      <div className="text-amber-300 text-base font-semibold leading-snug">
                        {panel.data.meaning}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="bg-stone-800/40 p-3 rounded-lg border border-stone-800">
                      <div className="text-amber-400 font-semibold text-xs mb-2">1. 뼈대 (주어 + 동사)</div>
                      <div className="text-stone-300 space-y-1">
                        <div><span className="text-stone-400">주어:</span> <b className="text-white">{panel.data.subject}</b></div>
                        <div><span className="text-stone-400">동사:</span> <b className="text-white">{panel.data.verb}</b></div>
                      </div>
                    </div>

                    <div className="bg-stone-800/40 p-3 rounded-lg border border-stone-800">
                      <div className="text-amber-400 font-semibold text-xs mb-2">2. 끊어 읽기 (슬래시 / [수식어구])</div>
                      <div className="text-stone-300 leading-relaxed font-mono text-xs bg-stone-950/40 p-2.5 rounded border border-stone-800/60">
                        {panel.data.chunking}
                      </div>
                    </div>

                    <div className="bg-stone-800/40 p-3 rounded-lg border border-stone-800">
                      <div className="text-amber-400 font-semibold text-xs mb-2">3. 직독직해</div>
                      <div className="text-stone-200 leading-relaxed">{panel.data.translation}</div>
                    </div>

                    {panel.data.collocations && panel.data.collocations.length > 0 && (
                      <div className="bg-emerald-950/30 p-3.5 rounded-lg border border-emerald-800/40">
                        <div className="text-emerald-400 font-semibold text-xs mb-2 flex items-center gap-1.5">
                          <span>🔗</span> 핵심 표현 덩어리 (연어·구동사)
                        </div>
                        <div className="space-y-2">
                          {panel.data.collocations.map((item, idx) => (
                            <div key={idx} className="bg-emerald-900/20 p-2 rounded border border-emerald-800/30 flex flex-col gap-0.5">
                              <div className="flex items-center justify-between">
                                <span className="text-emerald-300 font-mono font-bold text-xs">‣ {item.phrase}</span>
                                <button onClick={() => speakText(item.phrase)} className="text-[11px] text-stone-400 hover:text-white px-1">🔊</button>
                              </div>
                              <span className="text-stone-300 text-xs pl-3">{item.meaning}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {panel.data.grammar && (
                      <div className="bg-amber-950/20 p-3.5 rounded-lg border border-amber-900/40">
                        <div className="text-amber-400 font-semibold text-xs mb-2 flex items-center gap-1.5">
                          <span>💡</span> 문법 & 구문 포인트
                        </div>
                        <div className="text-amber-100/90 leading-relaxed text-xs whitespace-pre-line">
                          {panel.data.grammar}
                        </div>
                      </div>
                    )}

                    {panel.data.practice_pattern && (
                      <div className="bg-sky-950/30 p-3.5 rounded-lg border border-sky-800/40">
                        <div className="text-sky-400 font-semibold text-xs mb-2 flex items-center gap-1.5">
                          <span>🗣️</span> 일상 회화 응용 패턴
                        </div>
                        <div className="bg-sky-900/20 p-2.5 rounded border border-sky-800/30 space-y-2">
                          <div>
                            <span className="text-[11px] text-sky-400 font-bold block mb-0.5">기본 공식</span>
                            <span className="font-mono text-sky-200 font-medium text-xs">
                              {panel.data.practice_pattern.pattern}
                            </span>
                          </div>
                          <div className="pt-1.5 border-t border-sky-800/30">
                            <div className="flex items-center justify-between gap-1">
                              <div className="text-white text-xs font-medium">"{panel.data.practice_pattern.example_en}"</div>
                              <button onClick={() => speakText(panel.data.practice_pattern.example_en)} className="text-[11px] text-stone-400 hover:text-white px-1 shrink-0">🔊</button>
                            </div>
                            <div className="text-sky-300/80 text-[11px] mt-0.5">{panel.data.practice_pattern.example_ko}</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      {/* 📚 등록된 책 서재 모달 팝업 */}
      {isLibraryOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 font-sans">
          <div
            className={`w-full max-w-2xl rounded-2xl shadow-2xl border p-6 max-h-[85vh] flex flex-col ${
              isNight ? "bg-[#222226] border-[#323238] text-stone-200" : "bg-white border-stone-200 text-stone-800"
            }`}
          >
            <div className="flex justify-between items-center pb-4 border-b border-stone-500/20 mb-4">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  📚 Cloudflare R2 원서 서재
                </h2>
                <button
                  onClick={fetchBooksFromServer}
                  disabled={isFetchingBooks}
                  className="text-xs px-2 py-1 bg-stone-200 hover:bg-stone-300 dark:bg-stone-700 dark:hover:bg-stone-600 rounded text-stone-700 dark:text-stone-300 transition"
                  title="서재 새로고침"
                >
                  {isFetchingBooks ? "조회 중..." : "🔄 새로고침"}
                </button>
              </div>
              <button
                onClick={() => setIsLibraryOpen(false)}
                className="text-stone-400 hover:text-stone-100 text-lg px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            {/* 책 목록 영역 */}
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              {savedBooks.length === 0 ? (
                <div className="text-center py-12 text-stone-400 text-sm">
                  {isFetchingBooks ? (
                    "R2 클라우드에서 책 목록을 불러오는 중입니다..."
                  ) : (
                    <>
                      등록된 책이 없습니다.<br />
                      상단의 <b>[+ 새 책 등록(R2)]</b> 버튼으로 첫 원서를 등록해보세요!
                    </>
                  )}
                </div>
              ) : (
                savedBooks.map((book) => {
                  const isCurrent = activeBookId === book.id || activeBookId === book.fileKey;
                  return (
                    <div
                      key={book.id || book.fileKey}
                      onClick={() => {
                        loadPdfSource(book.publicUrl, book.title, book.id || book.fileKey, 1);
                        setIsLibraryOpen(false);
                      }}
                      className={`p-3.5 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition ${
                        isCurrent
                          ? "bg-amber-500/10 border-amber-500/60 ring-1 ring-amber-500/40"
                          : isNight
                          ? "bg-[#28282E] border-[#383840] hover:bg-[#303038]"
                          : "bg-stone-50 border-stone-200 hover:bg-amber-50/60"
                      }`}
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <span className="text-2xl">📖</span>
                        <div className="overflow-hidden">
                          <h4 className="font-semibold text-sm truncate">{book.title}</h4>
                          <div className="text-xs text-stone-400 mt-0.5 flex gap-2">
                            <span>등록일: {book.addedAt || "-"}</span>
                            {book.size && (
                              <>
                                <span>•</span>
                                <span>{(book.size / (1024 * 1024)).toFixed(1)} MB</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {isCurrent && (
                        <button
                          onClick={(e) => handleCloseActiveBook(book.id || book.fileKey, e)}
                          className="text-xs text-amber-500 hover:text-amber-400 px-2.5 py-1 rounded transition border border-amber-500/30"
                          title="열린 책 닫기"
                        >
                          닫기
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}