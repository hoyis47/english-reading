import React, { useState, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { analyzeWithGemini } from "./api/gemini";

// [WebKit/Safari 호환] 태블릿 ReadableStream 비동기 이터레이터 누락 폴리필
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

// 모바일/태블릿 및 PC 공용 워커 설정
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export default function App() {
  const [pdfDoc, setPdfDoc] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [pageText, setPageText] = useState("");
  const [loading, setLoading] = useState(false);
  const [bookTitle, setBookTitle] = useState("English Book Reader");

  // 테마 모드 상태: 'day'(낮 모드 - 따뜻한 크림/세피아), 'night'(밤 모드 - 부드러운 다크 그레이)
  const [theme, setTheme] = useState("day");

  const [panel, setPanel] = useState({
    visible: false,
    selectedText: "",
    data: null,
    loading: false,
    error: null,
  });

  // 브라우저 내장 TTS (단어/문장 발음)
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

  // PDF 파일 업로드 핸들러
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
    setBookTitle(fileNameWithoutExt);

    setLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();

      const loadedPdf = await pdfjsLib.getDocument({
        data: arrayBuffer,
        cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
        cMapPacked: true,
      }).promise;

      setPdfDoc(loadedPdf);
      setTotalPages(loadedPdf.numPages);
      setCurrentPage(1);
      await extractPageText(loadedPdf, 1);
    } catch (err) {
      console.error("PDF 로드 오류:", err);
      alert("PDF 파일을 읽는 중 문제가 발생했습니다: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  // 텍스트 추출 로직
  const extractPageText = async (doc, pageNum) => {
    setLoading(true);
    try {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();

      if (!textContent || !textContent.items || textContent.items.length === 0) {
        setPageText("이 페이지에서 텍스트를 추출할 수 없습니다. (스캔된 이미지 PDF일 수 있습니다.)");
        return;
      }

      // 1. 모든 텍스트 조각 공백 연결
      let rawText = textContent.items
        .map((item) => (item.str ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      // 2. 머리글 필터링
      rawText = rawText.replace(/^\s*\d+\s*\|\s*P\s*a\s*g\s*e\s*Twilight\s*[-–—]\s*Steph[a|e]nie\s+Meyer\s*/i, "");
      rawText = rawText.replace(/^\s*\d+\s*\|\s*Page[^\n.]*?Meyer\s*/i, "");
      rawText = rawText.replace(/^\s*(?:Page\s*)?\d+\s*/i, "");

      // 3. 챕터 제목 뒤 줄바꿈
      rawText = rawText.replace(/^([A-Z\s]{4,})\s+([A-Z][a-z"“'‘])/g, "$1\n\n$2");

      // 4. 문장 단위 줄바꿈
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

  // 마우스 드래그 및 모바일 터치 선택 감지
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
          isNight
            ? "bg-[#222226] border-[#323238] text-stone-200"
            : "bg-white border-stone-200 text-stone-800"
        }`}
      >
        <div className="flex items-center gap-3">
          <h1
            className="text-xl font-bold flex items-center gap-2 max-w-xs sm:max-w-md truncate"
            title={bookTitle}
          >
            📖 {bookTitle}
          </h1>

          <label
            className={`cursor-pointer text-sm px-4 py-2 rounded-lg font-medium transition shadow-sm ${
              isNight
                ? "bg-amber-500 hover:bg-amber-600 text-stone-950 font-semibold"
                : "bg-stone-800 hover:bg-stone-900 text-white"
            }`}
          >
            원서(PDF) 열기
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          {/* 낮 모드 / 밤 모드 토글 버튼 */}
          <button
            onClick={() => setTheme(isNight ? "day" : "night")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition ${
              isNight
                ? "bg-[#2C2C32] border-[#3E3E46] text-amber-300 hover:bg-[#383842]"
                : "bg-stone-100 border-stone-300 text-stone-700 hover:bg-stone-200"
            }`}
            title="낮/밤 모드 전환"
          >
            {isNight ? "☀️ 낮 모드" : "🌙 밤 모드"}
          </button>

          {/* 페이지 이동 컨트롤 */}
          {totalPages > 0 && (
            <div
              className={`flex items-center gap-2 text-sm ${
                isNight ? "text-stone-300" : "text-stone-600"
              }`}
            >
              <button
                onClick={() => changePage(-1)}
                disabled={currentPage <= 1 || loading}
                className={`px-3 py-1.5 rounded-md border transition disabled:opacity-30 disabled:cursor-not-allowed ${
                  isNight
                    ? "border-[#3E3E46] hover:bg-[#2E2E36]"
                    : "border-stone-300 hover:bg-stone-100"
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
                  isNight
                    ? "border-[#3E3E46] hover:bg-[#2E2E36]"
                    : "border-stone-300 hover:bg-stone-100"
                }`}
              >
                다음 ▶
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 가이드 안내 */}
      <div
        className={`w-full max-w-6xl mb-3 text-xs font-sans flex flex-wrap gap-4 px-2 ${
          isNight ? "text-stone-400" : "text-stone-500"
        }`}
      >
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
            <div
              className={`text-center py-24 font-sans animate-pulse ${
                isNight ? "text-stone-500" : "text-stone-400"
              }`}
            >
              페이지를 불러오는 중입니다...
            </div>
          )}

          {!loading && !pageText && (
            <div
              className={`text-center py-28 font-sans ${
                isNight ? "text-stone-500" : "text-stone-400"
              }`}
            >
              상단의 [원서(PDF) 열기] 버튼을 눌러 읽고 싶은 영어책 PDF를 선택해 주세요.
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
              isNight
                ? "bg-[#1E1E22] border-[#313138] text-stone-200"
                : "bg-stone-900 border-stone-800 text-stone-100"
            }`}
          >
            {/* 패널 헤더 */}
            <div
              className={`flex justify-between items-center mb-3 pb-2 border-b ${
                isNight ? "border-stone-700/60" : "border-stone-800"
              }`}
            >
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

            {/* 선택 원문 & 전체 소리 듣기 */}
            <div className="mb-4 p-3 bg-stone-800/60 rounded-lg border border-stone-700/50 flex flex-col gap-2">
              <div className="text-xs text-stone-300 italic">
                "{panel.selectedText}"
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => speakText(panel.selectedText)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-stone-700/80 hover:bg-stone-700 text-stone-200 rounded transition font-medium border border-stone-600/50 shadow-sm"
                  title="원어민 발음 듣기"
                >
                  🔊 소리 듣기
                </button>
              </div>
            </div>

            {/* 로딩 표시 */}
            {panel.loading && (
              <div className="py-10 text-stone-400 text-center animate-pulse text-xs">
                Gemini가 구문과 원어민 표현 덩어리를 분석하고 있습니다...
              </div>
            )}

            {/* 에러 표시 */}
            {panel.error && (
              <div className="p-3 bg-red-950/50 border border-red-800/50 rounded-lg text-red-300 text-xs leading-relaxed">
                {panel.error}
              </div>
            )}

            {/* 결과 데이터 */}
            {!panel.loading && panel.data && (
              <div className="space-y-4 text-xs md:text-sm">
                {panel.data.type === "word" ? (
                  /* 단어 분석 결과 */
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
                          title="단어 발음 듣기"
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
                  /* 문장 분석 결과 */
                  <>
                    <div className="bg-stone-800/40 p-3 rounded-lg border border-stone-800">
                      <div className="text-amber-400 font-semibold text-xs mb-2">1. 뼈대 (주어 + 동사)</div>
                      <div className="text-stone-300 space-y-1">
                        <div>
                          <span className="text-stone-400">주어:</span> <b className="text-white">{panel.data.subject}</b>
                        </div>
                        <div>
                          <span className="text-stone-400">동사:</span> <b className="text-white">{panel.data.verb}</b>
                        </div>
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
                      <div className="text-stone-200 leading-relaxed">
                        {panel.data.translation}
                      </div>
                    </div>

                    {panel.data.collocations && panel.data.collocations.length > 0 && (
                      <div className="bg-emerald-950/30 p-3.5 rounded-lg border border-emerald-800/40">
                        <div className="text-emerald-400 font-semibold text-xs mb-2 flex items-center gap-1.5">
                          <span>🔗</span> 핵심 표현 덩어리 (연어·구동사)
                        </div>
                        <div className="space-y-2">
                          {panel.data.collocations.map((item, idx) => (
                            <div
                              key={idx}
                              className="bg-emerald-900/20 p-2 rounded border border-emerald-800/30 flex flex-col gap-0.5"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-emerald-300 font-mono font-bold text-xs">
                                  ‣ {item.phrase}
                                </span>
                                <button
                                  onClick={() => speakText(item.phrase)}
                                  className="text-[11px] text-stone-400 hover:text-white px-1"
                                  title="표현 발음 듣기"
                                >
                                  🔊
                                </button>
                              </div>
                              <span className="text-stone-300 text-xs pl-3">
                                {item.meaning}
                              </span>
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
                              <div className="text-white text-xs font-medium">
                                "{panel.data.practice_pattern.example_en}"
                              </div>
                              <button
                                onClick={() => speakText(panel.data.practice_pattern.example_en)}
                                className="text-[11px] text-stone-400 hover:text-white px-1 shrink-0"
                                title="예문 발음 듣기"
                              >
                                🔊
                              </button>
                            </div>
                            <div className="text-sky-300/80 text-[11px] mt-0.5">
                              {panel.data.practice_pattern.example_ko}
                            </div>
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
    </div>
  );
}