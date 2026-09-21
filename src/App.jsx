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

  // PDF 챕터 목차 상태
  const [outline, setOutline] = useState([]);
  const [isOutlineOpen, setIsOutlineOpen] = useState(false);
  const [jumpPageInput, setJumpPageInput] = useState("");

  // 단어장(복습 노트) 상태
  const [vocabList, setVocabList] = useState([]);
  const [isVocabOpen, setIsVocabOpen] = useState(false);
  const [vocabFilter, setVocabFilter] = useState("all"); // 'all' | 'word' | 'sentence'
  const [hideMemorized, setHideMemorized] = useState(false);

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

  // 단어장 로컬스토리지 불러오기
  useEffect(() => {
    const savedVocab = localStorage.getItem("english_reader_vocab");
    if (savedVocab) {
      try {
        setVocabList(JSON.parse(savedVocab));
      } catch (e) {
        console.error("단어장 로드 오류:", e);
      }
    }
  }, []);

  // 단어장 갱신 헬퍼
  const updateVocabList = (newList) => {
    setVocabList(newList);
    localStorage.setItem("english_reader_vocab", JSON.stringify(newList));
  };

  // 단어장에 추가/삭제 토글 (출처 정보 bookTitle, page 제외)
  const handleToggleVocab = () => {
    if (!panel.data || !panel.selectedText) return;

    const existingIndex = vocabList.findIndex(
      (v) => v.text.toLowerCase() === panel.selectedText.toLowerCase()
    );

    if (existingIndex >= 0) {
      const filtered = vocabList.filter((_, idx) => idx !== existingIndex);
      updateVocabList(filtered);
    } else {
      const newItem = {
        id: `vocab_${Date.now()}`,
        text: panel.selectedText,
        type: panel.data.type,
        data: panel.data,
        savedAt: new Date().toLocaleDateString(),
        memorized: false,
      };
      updateVocabList([newItem, ...vocabList]);
    }
  };

  // 단어장 항목 암기 완료 토글
  const toggleMemorized = (id) => {
    const updated = vocabList.map((item) =>
      item.id === id ? { ...item, memorized: !item.memorized } : item
    );
    updateVocabList(updated);
  };

  // 단어장 개별 삭제
  const removeVocabItem = (id) => {
    const filtered = vocabList.filter((item) => item.id !== id);
    updateVocabList(filtered);
  };

  // 로컬/배포 환경 자동 판별 및 R2 책 목록 불러오기
  const fetchBooksFromServer = useCallback(async () => {
    setIsFetchingBooks(true);
    try {
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

  // PDF 내장 목차(Outline) 파싱
  const extractPdfOutline = async (doc) => {
    try {
      const rawOutline = await doc.getOutline();
      if (!rawOutline || rawOutline.length === 0) {
        setOutline([]);
        return;
      }

      const parsedList = [];
      const traverseItems = async (items, depth = 0) => {
        for (const item of items) {
          let targetPageNumber = null;

          if (item.dest) {
            let destRef = item.dest;
            if (typeof destRef === "string") {
              destRef = await doc.getDestination(destRef);
            }
            if (Array.isArray(destRef) && destRef.length > 0) {
              const pageIndex = await doc.getPageIndex(destRef[0]);
              targetPageNumber = pageIndex + 1;
            }
          }

          if (targetPageNumber) {
            parsedList.push({
              title: item.title,
              pageNumber: targetPageNumber,
              depth: depth,
            });
          }

          if (item.items && item.items.length > 0) {
            await traverseItems(item.items, depth + 1);
          }
        }
      };

      await traverseItems(rawOutline);
      setOutline(parsedList);
    } catch (err) {
      console.warn("목차 추출 실패 또는 목차 데이터 없음:", err);
      setOutline([]);
    }
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
      await extractPdfOutline(loadedPdf);
    } catch (err) {
      console.error("PDF 열람 오류:", err);
      alert("PDF를 불러오는 중 오류가 발생했습니다: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  // 신규 PDF를 R2에 등록하고 즉시 전체 목록 재동기화
  const handleRegisterBook = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const title = file.name.replace(/\.[^/.]+$/, "");
    setIsUploading(true);

    try {
      const { fileKey, publicUrl } = await uploadPdfToR2(file);
      await fetchBooksFromServer();
      await loadPdfSource(publicUrl, title, fileKey, 1);
      setIsLibraryOpen(false);
      alert(`[${title}] 책이 R2 클라우드에 안전하게 등록되었습니다!`);
    } catch (err) {
      console.error("R2 업로드 실패:", err);
      alert("R2 등록 중 오류가 발생했습니다: " + err.message);
    } finally {
      setIsUploading(false);
      e.target.value = "";
    }
  };

  // 열려있는 책 닫기
  const handleCloseActiveBook = (id, e) => {
    e.stopPropagation();
    if (activeBookId === id) {
      setPdfDoc(null);
      setPageText("");
      setBookTitle("English Book Reader");
      setActiveBookId(null);
      setOutline([]);
      setIsOutlineOpen(false);
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

      let rawText = textContent.items
        .map((item) => (item.str ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

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

  // 특정 페이지 번호로 점프
  const jumpToPage = (targetPage) => {
    const page = parseInt(targetPage, 10);
    if (!isNaN(page) && page >= 1 && page <= totalPages && pdfDoc) {
      setCurrentPage(page);
      setPanel((prev) => ({ ...prev, visible: false }));
      extractPageText(pdfDoc, page);
      setIsOutlineOpen(false);
      setJumpPageInput("");
    } else {
      alert(`1페이지부터 ${totalPages}페이지 사이의 번호를 입력해주세요.`);
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

  // 현재 패널에 열린 단어가 이미 단어장에 저장되어 있는지 확인
  const isCurrentSaved =
    panel.selectedText &&
    vocabList.some((v) => v.text.toLowerCase() === panel.selectedText.toLowerCase());

  // 단어장 필터링 목록 계산
  const filteredVocab = vocabList.filter((item) => {
    if (vocabFilter !== "all" && item.type !== vocabFilter) return false;
    if (hideMemorized && item.memorized) return false;
    return true;
  });

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
        <div className="flex items-center gap-2.5 flex-wrap">
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
            📚 서재 ({savedBooks.length})
          </button>

          {/* 단어장 / 복습 모달 열기 버튼 */}
          <button
            onClick={() => setIsVocabOpen(true)}
            className={`text-sm px-3.5 py-2 rounded-lg border font-medium transition shadow-sm flex items-center gap-1.5 ${
              vocabList.length > 0
                ? "bg-amber-500/10 border-amber-500/50 text-amber-500 font-semibold hover:bg-amber-500/20"
                : isNight
                ? "bg-[#2C2C32] hover:bg-[#383842] text-stone-300 border-[#3E3E46]"
                : "bg-stone-100 hover:bg-stone-200 text-stone-700 border-stone-300"
            }`}
          >
            📝 단어장 ({vocabList.length})
          </button>

          {/* 책이 열려있을 때 노출되는 목차 버튼 */}
          {totalPages > 0 && (
            <button
              onClick={() => setIsOutlineOpen(true)}
              className={`text-sm px-3 py-2 rounded-lg border font-medium transition shadow-sm flex items-center gap-1.5 ${
                isNight
                  ? "bg-[#2C2C32] hover:bg-[#383842] text-amber-300 border-[#3E3E46]"
                  : "bg-stone-100 hover:bg-stone-200 text-stone-700 border-stone-300"
              }`}
            >
              📑 목차 {outline.length > 0 ? `(${outline.length})` : ""}
            </button>
          )}

          {/* R2 클라우드 새 책 등록 버튼 */}
          <label
            className={`cursor-pointer text-sm px-3.5 py-2 rounded-lg font-medium transition shadow-sm flex items-center gap-1.5 ${
              isNight ? "bg-[#2C2C32] hover:bg-[#383842] text-amber-300 border border-[#3E3E46]" : "bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-300"
            }`}
          >
            {isUploading ? "☁️ R2 업로드 중..." : "+ 새 책 등록"}
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
              상단의 <b>[📚 서재]</b>를 열어 책을 선택하거나, <b>[+ 새 책 등록]</b>으로 원서를 올려보세요!
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
              <div className="flex items-center gap-2">
                <span className="font-semibold text-amber-400 text-xs tracking-wider uppercase">
                  {panel.data?.type === "word" ? "단어/표현 사전" : "문장 구조 & 표현 분석"}
                </span>

                {/* 단어장 저장 버튼 */}
                {!panel.loading && panel.data && (
                  <button
                    onClick={handleToggleVocab}
                    className={`text-xs px-2.5 py-1 rounded-full font-medium transition flex items-center gap-1 ${
                      isCurrentSaved
                        ? "bg-amber-500 text-stone-950 font-bold shadow"
                        : "bg-stone-800 hover:bg-stone-700 text-stone-300 border border-stone-700"
                    }`}
                  >
                    {isCurrentSaved ? "★ 저장됨" : "⭐ 단어장에 저장"}
                  </button>
                )}
              </div>

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

      {/* 📝 단어장 / 복습 노트 모달 */}
      {isVocabOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 font-sans">
          <div
            className={`w-full max-w-3xl rounded-2xl shadow-2xl border p-6 max-h-[88vh] flex flex-col ${
              isNight ? "bg-[#222226] border-[#323238] text-stone-200" : "bg-white border-stone-200 text-stone-800"
            }`}
          >
            {/* 단어장 헤더 */}
            <div className="flex justify-between items-center pb-4 border-b border-stone-500/20 mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  📝 내 단어장 & 복습 노트 ({vocabList.length})
                </h2>
              </div>
              <button
                onClick={() => setIsVocabOpen(false)}
                className="text-stone-400 hover:text-stone-100 text-lg px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            {/* 필터 컨트롤 바 */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-stone-500/10 text-xs">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setVocabFilter("all")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition ${
                    vocabFilter === "all"
                      ? "bg-amber-600 text-white"
                      : isNight
                      ? "bg-stone-800 text-stone-400"
                      : "bg-stone-100 text-stone-600"
                  }`}
                >
                  전체 ({vocabList.length})
                </button>
                <button
                  onClick={() => setVocabFilter("word")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition ${
                    vocabFilter === "word"
                      ? "bg-amber-600 text-white"
                      : isNight
                      ? "bg-stone-800 text-stone-400"
                      : "bg-stone-100 text-stone-600"
                  }`}
                >
                  단어 ({vocabList.filter((v) => v.type === "word").length})
                </button>
                <button
                  onClick={() => setVocabFilter("sentence")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition ${
                    vocabFilter === "sentence"
                      ? "bg-amber-600 text-white"
                      : isNight
                      ? "bg-stone-800 text-stone-400"
                      : "bg-stone-100 text-stone-600"
                  }`}
                >
                  문장 ({vocabList.filter((v) => v.type === "sentence").length})
                </button>
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-stone-400 select-none">
                <input
                  type="checkbox"
                  checked={hideMemorized}
                  onChange={(e) => setHideMemorized(e.target.checked)}
                  className="rounded accent-amber-600"
                />
                <span>외운 것 숨기기</span>
              </label>
            </div>

            {/* 단어 리스트 영역 */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {filteredVocab.length === 0 ? (
                <div className="text-center py-16 text-stone-400 text-sm">
                  {vocabList.length === 0 ? (
                    <>
                      아직 단어장에 저장된 항목이 없습니다.<br />
                      원서를 읽으며 모르는 단어나 멋진 문장을 드래그한 후 <b>[⭐ 단어장에 저장]</b>을 눌러보세요!
                    </>
                  ) : (
                    "선택한 조건에 맞는 단어가 없습니다."
                  )}
                </div>
              ) : (
                filteredVocab.map((item) => (
                  <div
                    key={item.id}
                    className={`p-4 rounded-xl border transition flex flex-col gap-2 ${
                      item.memorized
                        ? "opacity-60 bg-stone-500/5 border-stone-500/20"
                        : isNight
                        ? "bg-[#28282E] border-[#383840]"
                        : "bg-stone-50 border-stone-200"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <input
                          type="checkbox"
                          checked={item.memorized}
                          onChange={() => toggleMemorized(item.id)}
                          className="w-4 h-4 rounded accent-amber-600 cursor-pointer"
                          title="외웠어요 체크"
                        />
                        <span
                          className={`text-xs px-2 py-0.5 rounded font-semibold ${
                            item.type === "word"
                              ? "bg-amber-400/20 text-amber-400"
                              : "bg-sky-400/20 text-sky-400"
                          }`}
                        >
                          {item.type === "word" ? "단어" : "문장"}
                        </span>
                        <b
                          className={`text-base font-semibold ${
                            item.memorized ? "line-through text-stone-400" : ""
                          }`}
                        >
                          {item.data.base || item.text}
                        </b>

                        {item.data.ipa && (
                          <span className="font-mono text-xs text-amber-400/80 bg-stone-900/80 px-1.5 py-0.5 rounded border border-stone-700/50">
                            {item.data.ipa}
                          </span>
                        )}

                        <button
                          onClick={() => speakText(item.data.base || item.text)}
                          className="text-stone-400 hover:text-white text-xs px-1"
                          title="발음 듣기"
                        >
                          🔊
                        </button>
                      </div>

                      <button
                        onClick={() => removeVocabItem(item.id)}
                        className="text-xs text-stone-500 hover:text-red-400 px-2 py-1 transition"
                        title="단어장에서 삭제"
                      >
                        ✕ 삭제
                      </button>
                    </div>

                    {/* 해석 및 주요 정보 */}
                    <div className="pl-6 text-sm text-stone-300">
                      {item.type === "word" ? (
                        <div className="flex items-center gap-2">
                          {item.data.pos && (
                            <span className="text-xs text-stone-400">[{item.data.pos}]</span>
                          )}
                          <span className="text-amber-300 font-medium">{item.data.meaning}</span>
                        </div>
                      ) : (
                        <div className="space-y-1 text-xs sm:text-sm">
                          <div className="text-stone-400 italic">"{item.text}"</div>
                          <div className="text-amber-200">{item.data.translation}</div>
                        </div>
                      )}
                    </div>

                    {/* 저장 일자 정보 (책 출처 및 페이지 제외) */}
                    <div className="pl-6 pt-1 text-[11px] text-stone-400 flex items-center gap-2 border-t border-stone-500/10">
                      <span>저장일: {item.savedAt}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 📑 챕터 목차 / 페이지 점프 사이드 드로어 */}
      {isOutlineOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-start font-sans">
          <div
            className={`w-80 sm:w-96 h-full shadow-2xl flex flex-col p-5 transition-transform ${
              isNight ? "bg-[#222226] text-stone-200 border-r border-[#323238]" : "bg-white text-stone-800 border-r border-stone-200"
            }`}
          >
            <div className="flex justify-between items-center pb-3 border-b border-stone-500/20 mb-3">
              <h3 className="font-bold text-base flex items-center gap-2">
                📑 챕터 목차 {outline.length > 0 ? `(${outline.length})` : ""}
              </h3>
              <button
                onClick={() => setIsOutlineOpen(false)}
                className="text-stone-400 hover:text-stone-100 text-lg px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                jumpToPage(jumpPageInput);
              }}
              className="mb-4 flex items-center gap-2"
            >
              <input
                type="number"
                min="1"
                max={totalPages}
                value={jumpPageInput}
                onChange={(e) => setJumpPageInput(e.target.value)}
                placeholder={`페이지 이동 (1 ~ ${totalPages})`}
                className={`flex-1 px-3 py-1.5 text-xs rounded-lg border outline-none ${
                  isNight
                    ? "bg-[#18181A] border-[#383840] text-stone-200 focus:border-amber-400"
                    : "bg-stone-50 border-stone-300 text-stone-800 focus:border-amber-600"
                }`}
              />
              <button
                type="submit"
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium transition"
              >
                이동
              </button>
            </form>

            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {outline.length === 0 ? (
                <div className="text-center py-10 text-stone-400 text-xs leading-relaxed">
                  이 PDF 파일에는 내장된 목차(북마크) 데이터가 없습니다.<br /><br />
                  위의 <b>페이지 이동 입력창</b>을 이용해 원하는 페이지로 바로 이동하실 수 있습니다.
                </div>
              ) : (
                outline.map((item, idx) => {
                  const isCurrent = currentPage === item.pageNumber;
                  return (
                    <button
                      key={idx}
                      onClick={() => jumpToPage(item.pageNumber)}
                      style={{ paddingLeft: `${12 + (item.depth || 0) * 14}px` }}
                      className={`w-full text-left py-2.5 pr-3 rounded-lg text-sm transition flex justify-between items-center ${
                        isCurrent
                          ? "bg-amber-500/20 text-amber-500 font-bold"
                          : isNight
                          ? "hover:bg-[#2E2E36] text-stone-300"
                          : "hover:bg-stone-100 text-stone-700"
                      }`}
                    >
                      <span className="truncate pr-2">{item.title}</span>
                      <span className="text-xs text-stone-400 shrink-0 font-mono">
                        {item.pageNumber}p
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

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

            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              {savedBooks.length === 0 ? (
                <div className="text-center py-12 text-stone-400 text-sm">
                  {isFetchingBooks ? (
                    "R2 클라우드에서 책 목록을 불러오는 중입니다..."
                  ) : (
                    <>
                      등록된 책이 없습니다.<br />
                      상단의 <b>[+ 새 책 등록]</b> 버튼으로 첫 원서를 등록해보세요!
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