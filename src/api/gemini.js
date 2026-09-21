// src/api/gemini.js
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

const CANDIDATE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
];

function cleanText(str) {
  if (!str) return "";
  return str
    .replace(/[*#_~`]/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

export async function analyzeWithGemini({ type, text, fullSentence }) {
  if (!API_KEY) {
    return { error: ".env 파일에 VITE_GEMINI_API_KEY가 없습니다." };
  }

  let prompt = "";

  if (type === "word_or_phrase") {
    prompt = `문맥 문장: "${fullSentence || text}"
선택한 단어/표현: "${text}"

위 소설 문맥에 맞춰 이 단어가 '현재 문장에서 쓰인 문법적 역할(품사)'과 표준 국제음성기호(IPA)를 분석하여 오직 순수 JSON 형식으로만 응답해:
{
  "base": "원형 단어 또는 기본 숙어 표현",
  "ipa": "표준 미국식 국제음성기호(IPA), 예: /ˌæb.səˈluːt.li/",
  "pos": "현재 문장에서 쓰인 품사 (예: 명사, 타동사, 자동사, 형용사, 부사, 과거분사, 전치사, 구동사 등 구체적으로)",
  "meaning": "이 문맥과 품사에 딱 맞는 간결한 한국어 뜻"
}`;
  } else {
    prompt = `영어 문장: "${text}"

위 문장의 구조와 문법, 그리고 원어민 표현 덩어리를 분석하여 오직 순수 JSON 형식으로만 응답해:
{
  "subject": "문장에 실제 쓰인 문법적 주어 (가주어 it/there 유지. 임의로 화자 상상 금지)",
  "verb": "본동사 (시제 및 조동사 포함)",
  "chunking": "슬래시(/)와 수식어구 대괄호([])로 명확히 분리한 영문",
  "translation": "호흡 단위로 끊어 자연스럽게 번역한 한국어",
  "grammar": "도치, 분사구문, 관계사 생략 등 특수 문법 포인트를 '1. 설명\\n2. 설명' 형태로 번호마다 줄바꿈(\\n)하여 명쾌하게 설명",
  "collocations": [
    {
      "phrase": "문장에 쓰인 연어/구동사/관용 표현 원형 (예: give thought to, bring oneself to)",
      "meaning": "한국어 뜻"
    }
  ],
  "practice_pattern": {
    "pattern": "이 문장에서 뽑아낸 실생활 응용 기본 공식 (예: I couldn't bring myself to + [동사원형])",
    "example_en": "원어민이 일상에서 흔히 쓰는 짧고 세련된 실생활 영문 예문",
    "example_ko": "위 예문의 자연스러운 한국어 해석"
  }
}`;
  }

  for (const model of CANDIDATE_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 800,
            responseMimeType: "application/json",
          },
        }),
      });

      const data = await response.json();

      if (data.error) {
        console.warn(`[${model}] 오류, 다음 모델 시도:`, data.error.message);
        continue;
      }

      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (jsonText) {
        const parsed = JSON.parse(jsonText);
        if (type === "word_or_phrase") {
          return {
            type: "word",
            base: cleanText(parsed.base),
            ipa: cleanText(parsed.ipa),
            pos: cleanText(parsed.pos),
            meaning: cleanText(parsed.meaning),
          };
        } else {
          return {
            type: "sentence",
            subject: cleanText(parsed.subject),
            verb: cleanText(parsed.verb),
            chunking: cleanText(parsed.chunking),
            translation: cleanText(parsed.translation),
            grammar: cleanText(parsed.grammar),
            collocations: Array.isArray(parsed.collocations)
              ? parsed.collocations.map((c) => ({
                  phrase: cleanText(c.phrase),
                  meaning: cleanText(c.meaning),
                }))
              : [],
            practice_pattern: parsed.practice_pattern
              ? {
                  pattern: cleanText(parsed.practice_pattern.pattern),
                  example_en: cleanText(parsed.practice_pattern.example_en),
                  example_ko: cleanText(parsed.practice_pattern.example_ko),
                }
              : null,
          };
        }
      }
    } catch (err) {
      console.warn(`[${model}] 네트워크 실패:`, err);
    }
  }

  return { error: "분석 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요." };
}