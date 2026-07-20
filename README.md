# 시간표 변경 웹앱 (timetable-editor)

교사 시간표를 브라우저에서 클릭으로 이동·확정하는 웹앱. Cloudflare Worker 한 개로
SPA와 API를 함께 제공하며, 시간표 데이터는 Google Sheets에 저장한다.

## 개요

- **런타임**: Cloudflare Worker (`src/worker.js`, wrangler 이름 `timetable-editor`).
- **코어 공용**: `src/core/*.js`(Core_Model / Core_Validate / Core_Recommend + web_extra)는
  순수 JS로, 브라우저와 서버가 **동일 코드**를 사용한다. 서버는 코어를 문자열로 import해
  조립하고(`CORE`), 브라우저는 `/core/*.js`로 주입받는다.
- **백엔드**: Google Sheets API. Worker는 **로그인 사용자 본인의 OAuth access token**을
  그대로 전달해 시트에 접근한다. 서비스 계정은 사용하지 않는다(앰비언트 권한 없음).
- **인증**: 헤더 2개로 신원과 데이터 접근을 분리한다.
  - `Authorization: Bearer <Google ID token>` — 서명·iss·aud·exp 검증 + 허용 도메인 제한.
  - `X-Sheets-Token: <Google OAuth access token>` — Sheets API 호출에 그대로 사용.

  access token 을 가진 사용자는 어차피 구글을 직접 호출할 수 있으므로 이 앱을 통한
  권한 상승은 없다. 시트 권한은 구글이 직접 강제한다.
- **탭 구성**: `revised`(원본), `시간표(작업)`(작업 사본, 있으면 우선 사용), `설정`,
  `변경이력`.

## API 계약

| 메서드 · 경로 | 인증 | 설명 |
|---|---|---|
| `GET /` | 무 | SPA HTML(클라이언트 ID·DEV_MODE 주입) |
| `GET /core/*.js` | 무 | 코어 스크립트(브라우저 주입용) |
| `GET /api/sheets` | 필요 | 탭 목록·선택과목·설정 버전 조회 |
| `GET /api/state` | 필요 | 현재 그리드·설정 상태 조회 |
| `POST /api/apply` | 필요 | 이동 확정 / RA 감독 배정·해제 |
| `POST /api/duplicate-tab` | 필요 | 지정 탭을 복제(`… (사본)`) |
| `POST /api/config` | 필요 | `설정` 탭 덮어쓰기(낙관적 버전 검증) |

모든 `/api/*` 요청은 헤더 2개가 필요하다.
- `Authorization: Bearer <Google ID token>`
- `X-Sheets-Token: <Google OAuth access token>` (scope `…/auth/spreadsheets`)

공통 오류:
- `401 missing_token` / `invalid_token` — ID 토큰 없음·무효.
- `401 missing_sheets_token` — `X-Sheets-Token` 헤더 없음.
- `401 sheets_token_expired` — access token 만료·무효. **클라이언트는 토큰을 조용히
  재발급받아 원래 요청을 1회 재시도한다**(`apiCall` 계층에 구현).
- `403 domain_not_allowed` — 허용 도메인 불일치.
- `403 no_access` — 해당 스프레드시트에 접근 권한 없음(구글의 403/404 를 통합).
  읽기 권한만 있는 사용자가 쓰기를 시도한 경우도 여기로 온다.
- `400 no_sheet_selected` — 요청에 `sheetId` 가 없고 `SPREADSHEET_ID` 기본값도 비어 있음.
  Sheets 를 호출하기 전에 끊으며, 클라이언트는 오류 대신 시트 주소 입력 안내를 띄운다.

### GET /api/state

응답:
```json
{ "ok": true, "tab": "...", "grid": [[...]], "config": {...}, "version": "...", "user": "..." }
```
- `tab`: 실제 사용 탭(`시간표(작업)`이 있으면 그것, 없으면 `revised`).
- `version`: 그리드 해시(낙관적 동시성 검증용).
- `config.missing === true`이면 `설정` 탭이 없다는 뜻(빈 config 폴백).

### POST /api/apply

요청:
```json
{ "tab": "...", "moves": [{ "row": 3, "fromIdx": 0, "toIdx": 1, "name": "..." }], "baseVersion": "...", "kind": "direct|chain" }
```
성공 응답:
```json
{ "ok": true, "tab": "...", "grid": [[...]], "config": {...}, "version": "...", "applied": 2 }
```
오류:
- `400 bad_json` — 본문 JSON 파싱 실패.
- `400 invalid_move` — 교사 행이 아닌 row를 이동하려 함.
- `409 stale` — `baseVersion`이 현재 시트 해시와 불일치(그 사이 시트가 바뀜).
- `409 conflict` — `checkMoves`가 block 수준 충돌을 반환.

확정 시 `변경이력` 탭에 기록이 append된다. 유형 라벨: `chain`→`연쇄`,
같은 슬롯 조합의 다건 이동→`이동(팀)`, 그 외→`이동`.

### POST /api/duplicate-tab

요청 `{ "sheetId": "...", "tab": "revised" }`. 지정 탭을 바로 뒤에 복제한다.
- 성공: `{ "ok": true, "tab": "revised (사본)" }` (이름 충돌 시 `(사본 2)`…)
- `400 no_tab` — 해당 탭이 없음.

### POST /api/config

요청 `{ "sheetId": "...", "config": {...}, "baseConfigVersion": "..." }`.
`설정` 탭을 직렬화한 값으로 덮어쓴다(탭이 없으면 생성).
- `400 missing_base_version` — `baseConfigVersion` 누락.
- `409 stale_config` — 그 사이 다른 사용자가 설정을 변경함.

## 배포

이 저장소 규칙상 **배포(`wrangler deploy`)는 사람이 수행**한다.

시크릿은 없다(서비스 계정 미사용).

1. **환경 변수** (`wrangler.jsonc`의 `vars`):
   - `SPREADSHEET_ID` — 기본 스프레드시트 ID(**선택**). 비워 두면 앱이 시트 주소 입력
     안내로 시작하고, 교사가 입력한 시트를 쓴다(최근 시트는 브라우저에 기억).
   - `ALLOWED_DOMAIN` — 허용 이메일 도메인(예: `gvcs-mg.org`).
   - `GOOGLE_CLIENT_ID` — 이 앱 전용 OAuth 클라이언트 ID.
2. **OAuth 설정** — Google Cloud Console에서:
   - OAuth 클라이언트(웹 애플리케이션)의 "승인된 JavaScript 원본"에 배포 Worker URL 등록.
   - OAuth 동의 화면의 범위에 `https://www.googleapis.com/auth/spreadsheets` 추가.
     이 스코프가 없으면 토큰 발급이 실패해 시트를 읽을 수 없다.
   - 프로젝트에서 **Google Sheets API** 활성화.
3. **시트 권한** — 별도 공유 설정 없음. 각 사용자는 **본인이 이미 권한을 가진 시트만**
   열고 편집할 수 있다(구글이 직접 강제).
4. 배포:
   ```
   wrangler deploy
   ```

## 알려진 한계

- **동시 확정 TOCTOU**: 확정 시 `baseVersion` 그리드 해시로 **낙관적 검증만** 하고,
  서버 측 락은 두지 않는다. 두 사용자가 동일 `baseVersion`에서 거의 동시에 제출하면
  이론상 TOCTOU 창이 존재한다. 다만 **순차 제출**은 두 번째 요청이 stale 해시로
  `409`가 되어 안전하다. 소수 사용자 전제이므로 별도 락을 두지 않았다.
- **권한 단위 = 스프레드시트 전체**: 접근 제어는 구글 시트 공유 권한에 위임한다.
  즉 어떤 시트에 편집자 권한이 있는 사용자는 그 시트 **전체**를 이 앱으로 편집할 수 있다.
  탭별·범위별 세분화된 권한은 두지 않는다. 반대로 권한이 없는 시트는 구글이 막으므로
  앱이 대신 열어 주지 않는다.
- **access token 만료**: OAuth access token은 약 1시간이면 만료된다. 클라이언트가
  `401 sheets_token_expired`를 받으면 조용히 재발급 후 1회 재시도한다. 재발급까지
  실패하면(구글 세션 만료 등) 로그인 화면으로 돌아간다.
