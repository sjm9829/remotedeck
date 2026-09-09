# RemoteDeck

개인용 셀프호스트 원격 관리 앱.

## 구조

```
apps/
  core-server/    # Fastify + ws 서버 (Core 1A)
  dev-client/     # React + Vite + @xterm/xterm 개발 UI
packages/
  core/           # 암호화, DB, 공통 로직
  api/            # API 타입 정의
  client-sdk/     # 클라이언트 SDK
  types/          # 공유 타입
  protocol/       # WebSocket 프로토콜 타입
```

## 실행

```bash
cp .env.example .env
# .env 필수:
#   REMOTEDECK_MASTER_KEY  : 64자리 hex (32 bytes). 미설정/오류 시 기동 실패 (fail closed).
#   REMOTEDECK_API_TOKEN   : API Bearer 토큰 (최소 32자). 미설정/오류 시 기동 실패 (fail closed).
#   REMOTEDECK_ALLOWED_ORIGINS : CORS 허용 origin 목록(쉼표 구분). 비우면 same-origin만 허용.
npm install
npm run build
npm run dev:server
```

`/healthz`만 무인증으로 응답하며, `/api/*`와 `/ws`는 `Authorization: Bearer <token>`
(브라우저 WS는 `?token=` 쿼리 허용)이 없으면 401로 거부합니다.

### 개발 클라이언트

```bash
npm run dev:client   # Vite dev 서버
npm run build        # 전체 빌드 (dev-client 포함)
```

API base와 token은 화면에서 입력하며 개발용 메모리 상태로만 유지합니다.
credential/token은 localStorage에 저장하지 않습니다.
## 개발

```bash
npm run typecheck
npm test
```
