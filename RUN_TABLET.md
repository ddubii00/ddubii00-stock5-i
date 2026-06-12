# stock5 로컬 실행 방법

## 1. 압축 해제

Mac 또는 PC에서 zip 파일을 풀고, 터미널에서 해당 폴더로 이동합니다.

```bash
cd ddubii00-stock5-tablet
```

## 2. 의존성 설치

```bash
npm install
```

## 3. API 키 설정

프로젝트 루트에 `.env.local` 파일을 만들고 아래 값을 채웁니다.

```bash
KIS_APP_KEY=여기에_한국투자_APP_KEY
KIS_APP_SECRET=여기에_한국투자_APP_SECRET
KIS_BASE_URL=https://openapi.koreainvestment.com:9443
KIS_WS_URL=ws://ops.koreainvestment.com:21000
GEMINI_API_KEY=여기에_GEMINI_KEY
```

## 4. 실행

```bash
npm run dev
```

실행 후 터미널에 표시되는 주소를 사용합니다.

- Mac/PC에서 보기: `http://127.0.0.1:5173/`
- 같은 Wi-Fi의 iPad/Android 태블릿에서 보기: `http://컴퓨터_IP:5173/`

예:

```text
http://192.168.0.10:5173/
```

## 주의

- iPad/Android 태블릿에서 앱을 직접 실행하는 것이 아니라, Mac/PC에서 서버를 켜고 태블릿 브라우저로 접속합니다.
- `.env.local`은 키 파일이므로 GitHub나 다른 사람에게 공유하지 마세요.
- 한국투자 WebSocket 실시간 시세는 API 구독 수 제한이 있을 수 있습니다.
