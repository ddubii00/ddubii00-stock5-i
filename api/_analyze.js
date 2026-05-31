import process from 'node:process';

const ANALYSIS_PROMPT = `너는 주식 기술적 분석 전문가다.

첨부된 4개의 차트 이미지를 분석하라:
1. 캔들차트
2. 거래량차트
3. MACD
4. 일목균형표

분석 목적은 단순한 매수/매도 추천이 아니라, 현재 종목의 기술적 상태를 객관적으로 분류하고 매매 시나리오를 만드는 것이다.

다음 기준으로 분석하라.

[1] 전체 시장 상태
- 현재 구간이 상승 추세, 하락 추세, 박스권, 추세 전환 가능 구간 중 어디인지 판단
- 단기 추세와 중기 추세를 구분
- 현재 가격이 추격매수 구간인지, 눌림목 구간인지, 위험 구간인지 판단

[2] 캔들차트 분석
- 최근 고점과 저점의 방향
- 주요 지지선과 저항선
- 장대양봉, 장대음봉, 윗꼬리, 아랫꼬리, 갭 발생 여부
- 돌파, 이탈, 눌림목, 반등 실패 여부

[3] 거래량 분석
- 최근 가격 움직임이 거래량 증가를 동반했는지
- 상승 시 거래량 증가 여부
- 하락 시 거래량 증가 여부
- 평균 거래량 대비 현재 거래량의 강도
- 돌파 또는 이탈의 신뢰도

[4] MACD 분석
- MACD선과 시그널선의 골든크로스/데드크로스 여부
- MACD가 0선 위인지 아래인지
- 히스토그램 증가/감소 여부
- 가격과 MACD 사이의 다이버전스 여부
- MACD 기준 매수/매도 모멘텀 판단

[5] 일목균형표 분석
- 현재 가격이 구름대 위, 안, 아래 중 어디인지
- 전환선과 기준선의 관계
- 구름대의 방향과 두께
- 후행스팬의 위치
- 일목균형표 기준 상승/중립/하락 판단

[6] 종합 판단
- 상승 신호, 하락 신호, 중립 신호를 구분
- 4개 차트의 신호가 일치하는지 또는 충돌하는지 설명
- 현재 구간을 다음 중 하나로 분류:
  A. 적극 매수 관심
  B. 눌림목 매수 관심
  C. 관망
  D. 비중 축소
  E. 손절 또는 위험 관리 필요
- 최종 판단은 단순히 "상승/하락"으로 끝내지 말고 반드시 아래 5단계 등급으로도 표시하라:
  1단계: 적극 매수 관심
  2단계: 눌림목 매수 관심
  3단계: 관망
  4단계: 비중 축소
  5단계: 손절/위험 관리
- A~E 분류와 1~5단계 등급은 같은 의미로 대응시켜라.
- 표와 JSON 모두에 "최종 등급", "등급 의미", "판단 근거" 필드를 포함하라.

[7] 매매 시나리오
- 매수 관심 가격대
- 돌파 확인 가격대
- 손절 기준 가격대
- 1차 목표 가격대
- 2차 목표 가격대
- 반대 시나리오
- 신뢰도 점수 0~100점

주의사항:
- 차트에서 보이지 않는 가격이나 수치를 임의로 만들지 마라.
- 불확실한 부분은 반드시 "확인 불가"라고 표시하라.
- 단정적으로 예측하지 말고 조건부 시나리오로 작성하라.
- 결과는 표와 JSON 형식으로 함께 출력하라.`;

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(image => image?.dataUrl && typeof image.dataUrl === 'string')
    .slice(0, 4)
    .map((image, index) => ({
      label: image.label || `차트 ${index + 1}`,
      dataUrl: image.dataUrl,
    }));
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error('차트 이미지 형식이 올바르지 않습니다.');
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function getGeminiModel() {
  return (process.env.GEMINI_MODEL || process.env.GOOGLE_AI_MODEL || 'gemini-2.5-flash').replace(/^models\//, '');
}

function getGeminiMaxOutputTokens() {
  const value = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value > 0 ? value : 12000;
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .map(part => part?.text)
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || '';
}

export async function analyzeCharts({ symbol, symbolName, mainTf, limit, ichiTf, ichiLimit, images }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다. Vercel Project Settings > Environment Variables에 Google AI Studio API 키를 추가하세요.');
  }

  const chartImages = normalizeImages(images);
  if (chartImages.length !== 4) {
    throw new Error('분석에는 캔들차트, 거래량차트, MACD, 일목균형표 이미지 4개가 필요합니다.');
  }

  const metadata = [
    `종목명: ${symbolName || '확인 불가'}`,
    `종목코드: ${symbol || '확인 불가'}`,
    `캔들/MACD 기준 봉: ${mainTf || '확인 불가'}`,
    `캔들/MACD 기준 기간: ${limit || '확인 불가'}`,
    `일목균형표 기준 봉: ${ichiTf || '확인 불가'}`,
    `일목균형표 기준 기간: ${ichiLimit || '확인 불가'}`,
  ].join('\n');

  const parts = [
    { text: `${ANALYSIS_PROMPT}\n\n[차트 메타데이터]\n${metadata}` },
    ...chartImages.map(image => ({
      inline_data: parseDataUrl(image.dataUrl),
    })),
  ];

  const model = getGeminiModel();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: '사용자가 제공한 차트 이미지에 보이는 정보만 근거로 기술적 분석을 작성한다. 투자 자문처럼 단정하지 말고 조건부 시나리오로 답한다.',
        }],
      },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: getGeminiMaxOutputTokens(),
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini API 요청 실패 (${response.status})`);
  }

  const result = extractGeminiText(payload);
  if (!result) throw new Error('Gemini API 응답에서 분석 결과를 찾을 수 없습니다.');
  return result;
}
