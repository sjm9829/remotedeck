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
  client-sdk/     # 클라이언트 SDK (direct / same-origin 모드)
  types/          # 공유 타입
  protocol/       # WebSocket 프로토콜 타입
```

## 서버 실행

```bash
cp .env.example .env
# .env 필수:
#   REMOTEDECK_MASTER_KEY  : 64자리 hex (32 bytes). 미설정/오류 시 기동 실패 (fail closed).
#   REMOTEDECK_API_TOKEN   : API Bearer 토큰 (최소 32자). 미설정/오류 시 기동 실패 (fail closed).
#   REMOTEDECK_ALLOWED_ORIGINS : CORS 허용 origin 목록(쉼표 구분). 비우면 same-origin만 허용.
# .env 선택:
#   REMOTEDECK_LISTEN_HOST : 수신(bind) 주소. IPv4/IPv6 리터럴만 허용(호스트명 거부,
#                            오류 시 기동 실패). 미설정 시 127.0.0.1(루프백 전용).
#                            모든 인터페이스 수신(0.0.0.0)은 Docker/compose 전용.
npm install
npm run build
npm run dev:server
```

## 수신 주소(Bind) 정책

core-server는 기본값으로 **`127.0.0.1`(루프백 전용)** 에 바인드합니다. 이는 승인된
로컬 전용 배포 조건을 만족합니다. `REMOTEDECK_LISTEN_HOST`로 명시 변경할 수 있으며,
값은 반드시 유효한 IPv4/IPv6 주소 리터럴이어야 합니다(호스트명은 거부되고 기동이
실패합니다).

- 호스트 systemd 배포(`scripts/install-deploy.sh`): 유닛이 `REMOTEDECK_LISTEN_HOST=127.0.0.1`
  를 명시하여 항상 루프백 전용으로 수신합니다.
- Docker/compose 배포: 컨테이너가 호스트 포트를 발행하므로 `docker-compose.yml`이
  `REMOTEDECK_LISTEN_HOST=0.0.0.0`을 명시적으로 설정합니다. host 배포 유닛/env는
  절대 `0.0.0.0`을 설정하지 않습니다.

`/healthz`만 무인증으로 응답하며, `/api/*`는 `Authorization: Bearer <token>` 헤더가
없으면 401로 거부됩니다. WebSocket(`/ws/sessions/:id`)은 API 토큰을 URL에 담지
않고, 인증된 REST(`POST /api/sessions/:id/ws-ticket`)에서 발급한 **단일사용 단기
ticket**을 `Sec-WebSocket-Protocol` 서브프로토콜(`remotedeck.v1.<ticket>`)로 제시해
인증합니다. ticket가 없거나 이미 사용되었거나 만료되면 WS 핸드셰이크가 401로
거부됩니다.

## 클라이언트 모드

`client-sdk`와 `dev-client`는 두 가지 모드를 지원합니다.

> **기본값**: `VITE_REMOTEDECK_MODE`가 설정되지 않았거나 인식할 수 없는 값이면
> `same-origin`으로 동작합니다(fail-safe). `direct` 모드는 명시적으로
> `VITE_REMOTEDECK_MODE=direct`를 설정한 경우에만 활성화됩니다.

### 1. 직접 접속 (direct mode) — 개발 환경

Vite 개발 서버 또는 별도 도메인에서 RemoteDeck API에 직접 접속할 때 사용합니다.

```bash
VITE_REMOTEDECK_MODE=direct npm run dev:client
```

- 화면에서 **API base URL**과 **API token**을 입력합니다.
- 토큰은 React state(메모리)에만 저장하며 localStorage/sessionStorage/URL에 저장하지 않습니다.
- 모든 REST 요청에 `Authorization: Bearer <token>` 헤더가 붙습니다.
- WebSocket URL은 `ws://<api-base>/ws/sessions/<id>`로 직접 연결합니다.

### 2. 동일 출처 프록시 (same-origin mode) — Workbench 등 리버스 프록시 (기본값)

Workbench 또는 다른 same-origin 리버스 프록시 뒤에 배포할 때 사용합니다.
`VITE_REMOTEDECK_MODE`를 생략하면 이 모드로 동작합니다.

```bash
VITE_REMOTEDECK_BASE=/remotedeck/ VITE_REMOTEDECK_MODE=same-origin \
  npm run build --workspace=apps/dev-client
```

- **API token 입력 필드가 없습니다.** 프록시가 쿠키 기반으로 인증을 처리합니다.
- 모든 REST 요청에 `credentials: 'same-origin'`이 설정되어 쿠키가 전달됩니다.
- REST 요청에는 `Authorization` 헤더가 붙지 않습니다.
- WebSocket URL은 현재 페이지의 origin과 `VITE_REMOTEDECK_BASE` 경로를 사용해
  `wss://<host>/remotedeck/ws/sessions/<id>`로 자동 구성됩니다.
- WS 서브프로토콜 `remotedeck.v1.<ticket>`은 동일하게 유지됩니다.

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `VITE_REMOTEDECK_BASE` | Vite base 경로. 하위 경로 배포 시 `/remotedeck/` 형태로 설정 | `/` |
| `VITE_REMOTEDECK_MODE` | `direct` 또는 `same-origin`. 누락·잘못된 값은 `same-origin` | `same-origin` |

## 개발

```bash
npm run typecheck   # 전체 타입체크
npm test            # 전체 테스트 (client-sdk + dev-client 포함)
```

## client-sdk 사용 예시

```typescript
import { RemoteDeckClient } from '@remotedeck/client-sdk';

// 직접 접속 모드 (개발 환경)
const direct = new RemoteDeckClient({
  baseUrl: 'http://localhost:4100',
  token: '<API_TOKEN>',   // 메모리에만 존재
});

// same-origin 프록시 모드 (배포 환경)
const proxied = new RemoteDeckClient({
  baseUrl: '/remotedeck',          // 상대 경로
  mode: 'same-origin',            // Authorization 없음, credentials 포함
  pageOrigin: 'https://workbench.example',  // 선택: WS URL 계산용
});
```
