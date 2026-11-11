# RemoteDeck — Windows RDP 설계안 (초안)

상태: 설계 초안, 구현 전. 작성일 2026-11-12.

## 1. 목표 / 비목표

목표
- 호스트 목록에서 Windows 호스트를 골라 브라우저 탭 안에서 원격 데스크톱(화면·키보드·마우스·텍스트 클립보드)을 쓴다.
- 기존 SSH와 같은 방식으로 호스트·자격증명 저장, 탭, 접속 상태 표시, 재접속을 쓴다.
- 데스크톱·노트북·폴드·아이폰에서 쓸 수 있어야 한다(터치 입력 포함).

비목표(1차)
- 오디오, 프린터, 드라이브 리디렉션, 다중 모니터, 세션 녹화.
- 외부(인터넷)에서 Windows 3389 직접 노출. 접속은 항상 core-server → 사내망 경로로만 한다.

## 2. 방식 선택

| 안 | 내용 | 평가 |
|---|---|---|
| A. Apache Guacamole `guacd` + `guacamole-common-js` | core-server가 guacd에 TCP로 붙고, 브라우저와는 WebSocket으로 Guacamole 프로토콜을 중계 | **추천.** RDP 변환·비트맵 디코딩·클립보드·리사이즈를 검증된 코드가 처리. 브라우저 클라이언트가 Apache-2.0로 이미 있음 |
| B. IronRDP(WASM) | 브라우저에서 RDP를 직접 처리 | 게이트웨이(Devolutions Gateway 등)가 또 필요하고 통합 비용이 큼 |
| C. FreeRDP를 직접 붙여 캔버스로 스트리밍 | 자체 구현 | 비트맵·입력·클립보드·재접속을 전부 직접 만들어야 함. 비추천 |
| D. 별도 웹 RDP 제품(Guacamole 서버 전체 등) | 제품 UI를 iframe으로 | 호스트·자격증명 이중 관리, 탭 통합 불가 |

결론: **A**. guacd만 쓰고 Guacamole 웹앱(Java)은 쓰지 않는다.

## 3. 구성

```
브라우저(dev-client)
  └─ WSS /remotedeck/ws/rdp/:id   (guacamole-common-js, 단일 사용 티켓)
       └─ Workbench 프록시 (worker-card-relay)
            └─ core-server :4100   RdpSessionManager
                 └─ TCP 127.0.0.1:4822  guacd (Docker, localhost 전용)
                      └─ RDP 3389  Windows 호스트
```

- guacd는 Docker 컨테이너로 K6에서 실행하고 `127.0.0.1`에만 바인딩한다. 호스트에는 이미 Docker가 있다.
- core-server가 유일한 guacd 클라이언트다. 브라우저는 guacd에 직접 닿지 않는다.
- Windows 비밀번호는 기존 암호화 저장소에서 꺼내 core-server가 guacd 핸드셰이크에만 넣는다. 브라우저로는 내려보내지 않는다.

## 4. 데이터 모델 변경

- `hosts`에 컬럼 추가(마이그레이션, 기존 행은 `ssh`):
  - `protocol TEXT NOT NULL DEFAULT 'ssh'` — `'ssh' | 'rdp'`
  - `options TEXT DEFAULT '{}'` — RDP 옵션 JSON: `domain`, `security`(`nla`/`tls`/`any`), `width`/`height` 기본값, `color-depth`, `keyboard-layout`(ko-kr-qwerty 기본)
- `Host` 타입과 API(`CreateHostRequest` 등)에 `protocol`, `options` 추가. 기본 포트는 protocol에 따라 22 / 3389.
- 자격증명은 기존 `password` 타입을 재사용한다. 사용자명은 호스트의 `username`, 도메인은 `options.domain`.
- 클라이언트 폴더(`folder:` 태그)와 이름순 정렬, 최근 사용은 그대로 적용된다.

## 5. 서버

- 새 REST: `POST /api/rdp/sessions {hostId, width, height, dpi}` → `{sessionId}`, `DELETE /api/rdp/sessions/:id`, `POST /api/rdp/sessions/:id/ticket`. 기존 SSH 티켓 발급 방식을 그대로 따른다.
- 새 WS 업그레이드: `/ws/rdp/:id`. 기존 `/ws/sessions/`와 같은 티켓(서브프로토콜 `remotedeck.v1.<ticket>`) 검증을 쓴다. 메시지는 JSON이 아니라 Guacamole 텍스트 프로토콜을 그대로 중계한다.
- `RdpSessionManager`: guacd 소켓 1개 = RDP 세션 1개. 첫 인자로 `select rdp`, `connect`에 hostname·port·username·password·domain·security·`ignore-cert`·size를 넣는다. 기존 `resolveTransportTarget`의 자격증명 해석을 재사용하고, 비밀번호는 로그·에러에 남기지 않는다.
- SSH와 달리 **detach 개념이 없다.** 탭을 닫거나 WS가 끊기면 guacd 연결을 닫는다. 끊긴 세션은 Windows 쪽에 "연결 끊김" 상태로 남아 있으므로 같은 계정으로 다시 접속하면 이어진다. 그래서 자동 재연결은 "새 접속"으로 단순하게 처리한다.
- 같은 호스트에 동시 접속 제한(기본 1)을 둔다. Windows 클라이언트 OS는 동시 세션이 1개라 두 번째 접속이 기존 사용자를 쫓아낸다.
- 하트비트는 기존 WS ping/pong을 재사용한다. 유휴 세션 정리는 `REMOTEDECK_IDLE_TIMEOUT=0`이라 자동으로 되지 않으므로 RDP는 WS 종료 시 즉시 정리한다.

## 6. 인증서·보안

- 기본은 NLA. guacd는 서버 인증서 지문 고정(pinning)을 지원하지 않고 `ignore-cert`만 제공한다.
- 1차: 사내망 전용이라는 전제로 `ignore-cert=true`를 쓰되 호스트 편집 창에 경고를 표시한다.
- 2차: core-server가 접속 직전에 3389에 X.224+TLS 핸드셰이크만 해서 인증서 지문을 읽고, SSH의 "키 확인 필요"와 같은 최초 신뢰(TOFU) 흐름으로 저장·비교한다. 지문이 바뀌면 접속을 막는다.
- core-server가 임의 주소로 접속하는 SSRF 위험은 기존 SSH와 같으므로, 대상 호스트는 저장된 호스트 레코드로만 해석한다(요청에서 주소를 직접 받지 않는다).
- guacd는 localhost 바인딩, Docker는 non-root·읽기 전용 파일시스템·불필요한 capability 제거.
- 클립보드는 기본 양방향 텍스트 허용, 호스트별로 끌 수 있게 한다.

## 7. 프록시(Workbench)

`worker-card-relay/src/remotedeck-proxy.js`는 `/remotedeck/ws/` 접두어 아래 WS를 업스트림으로 파이프한다. `/remotedeck/ws/rdp/:id`는 이 접두어 안이라 코드 변경이 필요 없어 보이지만, 경로 화이트리스트 여부를 구현 단계에서 확인한다. 변경이 필요하면 relay 쪽 수정과 재시작이 필요하므로 별도 승인을 받는다.

## 8. 클라이언트(dev-client)

- 호스트 편집 창: 프로토콜 선택(SSH/RDP), RDP 선택 시 도메인·해상도·보안·클립보드 옵션 표시. 호스트 목록 행에 프로토콜 아이콘.
- `WorkspacePane`이 `host.protocol`로 분기: SSH는 기존 터미널+SFTP, RDP는 `RdpPane`(캔버스 + 툴바).
- `RdpPane`: `guacamole-common-js`의 `Guacamole.Client` + `WebSocketTunnel`. 컨테이너 크기에 맞춰 `size` 변경(Guacamole `display-update`), 연결 상태를 기존 LED·탭 상태에 연결한다. 연결된 탭 닫기 확인 창도 그대로 적용한다.
- 툴바: 전체화면, Ctrl+Alt+Del, 클립보드 붙여넣기, 키보드 호출(모바일), 해상도 맞춤/고정.
- 키보드: 브라우저가 가로채는 키(Ctrl+W, Alt+Tab 등)는 전체화면 + Keyboard Lock API로 일부만 전달 가능. 한계는 문서화한다.
- **터치(가장 어려운 부분)**: 한 손가락 이동 = 마우스 이동(트랙패드 모드)과 직접 터치 모드 전환, 탭 = 클릭, 길게 누르기 = 우클릭, 두 손가락 = 스크롤, 핀치 = 확대. 아이폰은 소프트 키보드로 입력, 한글 IME는 `keysym`이 아니라 텍스트 입력 이벤트로 보내야 해서 별도 검증이 필요하다.
- 번들 크기: `guacamole-common-js`는 RDP 탭을 처음 열 때 동적 import로 불러온다.

## 9. 단계

0. **스파이크(0.5~1일)**: K6에 guacd 컨테이너를 띄우고 Windows 1대로 core-server 임시 라우트 + 캔버스 한 장으로 화면·입력이 되는지, 한글 입력과 지연을 확인한다.
1. **MVP**: `protocol` 마이그레이션, RDP 세션 API/WS, `RdpPane`, 호스트 편집 UI, 텍스트 클립보드, 리사이즈, 연결 상태·재접속. 데스크톱 브라우저 기준.
2. **모바일·보안**: 터치 입력 모드, 소프트 키보드/IME, 인증서 TOFU.
3. **선택**: 오디오, 파일 전송, 읽기 전용 관전(viewer), 다중 모니터.

검증은 SSH와 같은 방식으로 한다: 서버 단위 테스트(guacd를 가짜 TCP 서버로 대체해 핸드셰이크·티켓·정리 검증), 클라이언트 단위 테스트, 모의 Playwright, 마지막에 실제 Windows 1대로 수동 확인.

## 10. 확정이 필요한 질문

1. 접속할 Windows가 어떤 에디션인가? Home 에디션은 RDP 호스트가 안 된다(Pro 이상 필요).
2. 대상 PC가 K6에서 직접 닿는 같은 LAN인가, VPN/Tailscale을 거치는가? 도메인 가입 PC가 있는가?
3. 1차 범위에 클립보드 말고 필요한 것(오디오, 파일 전송)이 있는가?
4. K6에 guacd Docker 컨테이너를 상시 띄워도 되는가(메모리 약 50~100MB)?
5. 인증서는 1차에 `ignore-cert`로 시작해도 되는가, 처음부터 TOFU가 필요한가?
6. 가장 많이 쓸 기기는 무엇인가? 터치 UX를 어디에 맞출지 정한다.
