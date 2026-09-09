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
# REMOTEDECK_MASTER_KEY에 64자리 hex 입력
npm install
npm run build
npm run dev:server
```

## 개발

```bash
npm run typecheck
npm test
```
