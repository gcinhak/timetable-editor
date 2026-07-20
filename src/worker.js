/**
 * 시간표 변경 웹앱 — Cloudflare Worker
 * --------------------------------------------------------
 * 순수 코어(Core_Model/Validate/Recommend + web_extra)를 브라우저·서버 공용으로 사용.
 * 인증: Google ID 토큰(Authorization: Bearer) 검증 + 도메인 제한.
 * 시트 접근: 로그인 사용자 본인의 OAuth access token(X-Sheets-Token 헤더) → Sheets API.
 *            구글이 시트 권한을 직접 강제하므로 앰비언트 권한(서비스 계정)은 두지 않는다.
 *
 * NOTE: wrangler Text rule에 의해 ./core/*.js·./index.html은 RAW 문자열로 import된다.
 *       ./lib/*.js는 일반 JS 번들.
 */

import html from './index.html';
import CoreModelSrc from './core/Core_Model.js';
import CoreValidateSrc from './core/Core_Validate.js';
import CoreRecommendSrc from './core/Core_Recommend.js';
import WebExtraSrc from './core/web_extra.js';
import { verifyIdToken } from './lib/google-auth.js';
import {
  hashGrid, hashValues, lastDataRow, cellsToBatchData, getSheets, batchGetValues, batchUpdateValues,
  appendRows, addSheet, duplicateSheet, detectHeaderRow, detectLayout, normalizeGrid, colLetter,
  nextCopyName, overwriteSheetRange, parseLinkedGroups, deriveClasslessFromGrades,
  makeSheetsFetch, mapSheetsError, resolveSheetId
} from './lib/sheets.js';
import {
  nonTeacherRows, incompleteUnits, historyKindLabel, parseDepts, raOpError,
  readConfigWithVersion as readConfigWithVersionImpl, resolveApplyTab
} from './lib/state.js';
import { getMockStore, mockPickTab, applyCellsToGrid, mockListTabs, mockDuplicateTab, mockSaveConfig } from './dev/mock_store.js';

/* =========================================================
   코어 조립 (모듈 로드시 1회). Function 스코프 안에서 module은 undefined이므로
   각 코어의 CJS 가드가 스킵되고 M-fallback이 동일 스코프 전역 함수를 참조한다.
   ========================================================= */
const CORE = new Function(
  CoreModelSrc + '\n' + CoreValidateSrc + '\n' + CoreRecommendSrc + '\n' + WebExtraSrc +
  '\nreturn { buildModel, checkMoves, checkMovesDelta, hasBlock, expandTargets, expandUnit, movesToCellWrites, slotLabel, slotIndex, indexToSlot, SLOT_COUNT, parseConfig, serializeConfig, resolvePinned };'
)();

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TAB_REVISED = 'revised';
const TAB_CONFIG = '설정';
const TAB_HISTORY = '변경이력';
const TAB_ELECTIVES = '선택과목코드';
const TAB_LINKED = '연결그룹';
const TAB_DEPTS = '교과별교사';

/* =========================================================
   서버 로깅 — 응답 본문에는 원인을 노출하지 않되(현행 은닉 정책 유지),
   Workers Logs 에서는 원인을 볼 수 있게 남긴다.
   시트 내용·토큰은 절대 남기지 않는다(예외 메시지만, 길이 제한).
   ========================================================= */
function logError(where, e) {
  try {
    const msg = String((e && e.message) || e || '');
    console.error('[timetable] ' + where + ': ' + msg.slice(0, 600));
  } catch (_) { /* 로깅 실패가 요청을 깨뜨리지 않게 한다 */ }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

// 편집 대상 시트가 아직 정해지지 않음(요청에도 없고 배포 기본값도 비어 있음).
// Sheets API 를 호출하기 전에 여기서 끊는다 → 클라이언트는 시트 주소 입력 안내를 띄운다.
function noSheetSelected() {
  return json({
    ok: false, error: 'no_sheet_selected',
    reasons: ['편집할 구글시트 주소(URL 또는 ID)를 입력하세요.']
  }, 400);
}

/* =========================================================
   JWKS 캐시
   ========================================================= */
let jwksCache = null;

async function fetchJwks() {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('jwks_fetch_failed ' + res.status);
  const data = await res.json();
  const byKid = {};
  (data.keys || []).forEach(function (k) { byKid[k.kid] = k; });
  jwksCache = { byKid: byKid, fetchedAt: Date.now() };
  return jwksCache;
}

async function getJwk(kid) {
  if (!jwksCache) await fetchJwks();
  if (!jwksCache.byKid[kid]) {
    if (Date.now() - jwksCache.fetchedAt > 60000) await fetchJwks();
  }
  return jwksCache.byKid[kid] || null;
}

/* =========================================================
   인증
   ========================================================= */
async function authenticate(request, env) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ ok: false, error: 'missing_token' }, 401);
  try {
    return await verifyIdToken(m[1], {
      clientId: env.GOOGLE_CLIENT_ID,
      allowedDomain: env.ALLOWED_DOMAIN,
      getJwk: getJwk
    });
  } catch (e) {
    return json({ ok: false, error: e.message || 'invalid_token' }, e.status || 401);
  }
}

/* =========================================================
   그리드 패딩: 각 행을 정확히 42열로 보정(행 수는 유지, 추가 없음).
   ========================================================= */
function pad42(grid) {
  return (grid || []).map(function (r) {
    const out = new Array(42);
    for (let i = 0; i < 42; i++) out[i] = (r && r[i] != null) ? r[i] : '';
    return out;
  });
}

/* =========================================================
   시간표 탭 읽기: 헤더 범위로 레이아웃(headerRow/slotStartCol) 탐지 후
   실제 슬롯 열 범위를 읽어 표준 42열 그리드로 정규화. 시간표 아니면 null.
   ========================================================= */
async function readTimetable(sf, tab) {
  var head = (await batchGetValues(sf, ["'" + tab + "'!A1:M10"]))[0] || [];
  var layout = detectLayout(head);
  if (!layout) return null;
  var endCol = colLetter(layout.slotStartCol + 39);
  var raw = (await batchGetValues(sf, ["'" + tab + "'!A:" + endCol]))[0] || [];
  var grid = normalizeGrid(raw, layout);
  return { grid: grid, layout: layout, dataStart: layout.headerRow + 1 };
}

/* =========================================================
   선택과목 파서
   ========================================================= */
// '선택과목코드' 탭 값(A:C) → {code:[subjects]}. B열=코드, C열=과목, 1행 헤더 skip.
function parseElectives(rows) {
  var out = {};
  (rows || []).forEach(function (r, i) {
    if (i === 0) return;
    var code = String((r && r[1] != null ? r[1] : '')).trim();
    var subj = String((r && r[2] != null ? r[2] : '')).trim();
    if (!code || !subj) return;
    (out[code] = out[code] || []).push(subj);
  });
  return out;
}

// tab 미지정 시 첫 시간표 형식 탭(없으면 첫 탭 / 'revised').
async function pickTimetableTab(sf, sheetsList, tabParam) {
  if (tabParam && sheetsList.some(function (s) { return s.title === tabParam; })) return tabParam;
  var ranges = sheetsList.map(function (s) { return "'" + s.title + "'!A1:M10"; });
  var head = ranges.length ? await batchGetValues(sf, ranges) : [];
  for (var i = 0; i < sheetsList.length; i++) {
    if (detectLayout(head[i] || []) !== null) return sheetsList[i].title;
  }
  return sheetsList.length ? sheetsList[0].title : TAB_REVISED;
}

// 설정 탭 원본값(A:C)을 읽어 { config, version, raw, unavailable } 반환.
// 탭 부재 → 빈 config + version=hashValues([]).
// 조회 실패 → unavailable:true, version:null (빈 해시로 위장하지 않는다).
function readConfigWithVersion(sf, sheetsList) {
  return readConfigWithVersionImpl({
    batchGet: function (ranges) { return batchGetValues(sf, ranges); },
    parseConfig: CORE.parseConfig,
    hashValues: hashValues,
    onError: function (e) { logError('readConfigWithVersion', e); }
  }, sheetsList, TAB_CONFIG);
}

// 연결그룹 탭에서 pinned(고정수업시간) + 인식불가 라벨 경고를 읽는다. 탭 없거나 오류면 빈 값.
async function readLinkedPinned(sf, sheetsList) {
  if (!sheetsList.some(function (s) { return s.title === TAB_LINKED; })) return { pinned: {}, warnings: [], grades: {} };
  try {
    var lv = await batchGetValues(sf, ["'" + TAB_LINKED + "'!A:F"]);
    var parsed = parseLinkedGroups(lv[0] || []);
    return { pinned: parsed.pinned || {}, warnings: parsed.warnings || [], grades: parsed.grades || {} };
  } catch (e) { logError('readLinkedPinned', e); return { pinned: {}, warnings: [], grades: {} }; }
}

// Sheets API 접근/처리 오류 공통 응답.
// 401 → sheets_token_expired, 403 → insufficient_scope|no_access, 404 → not_found, 그 외 → sheets_error.
function handleApiError(e) {
  // 응답에는 원본 메시지를 노출하지 않으므로, 진단은 로그로만 가능하다.
  logError('sheets_api', e);
  const mapped = mapSheetsError(e);
  return json(mapped.body, mapped.status);
}

/* =========================================================
   API 핸들러 (prod = 사용자 본인 OAuth 토큰)
   ========================================================= */
async function handleSheets(sf, sheetId) {
  var sheetsList;
  try {
    sheetsList = await getSheets(sf);
  } catch (e) {
    return handleApiError(e);
  }
  var ranges = sheetsList.map(function (s) { return "'" + s.title + "'!A1:M10"; });
  var head = ranges.length ? await batchGetValues(sf, ranges) : [];
  var tabs = sheetsList.map(function (s, i) {
    var lay = detectLayout(head[i] || []);
    return {
      title: s.title, sheetId: s.sheetId, isTimetable: lay !== null,
      headerRow: lay ? lay.headerRow : null, dataStart: lay ? lay.headerRow + 1 : null
    };
  });
  var electives = {};
  if (sheetsList.some(function (s) { return s.title === TAB_LINKED; })) {
    try {
      var lv = await batchGetValues(sf, ["'" + TAB_LINKED + "'!A:F"]);
      electives = parseLinkedGroups(lv[0] || []).groups;
    } catch (e) { logError('electives(연결그룹)', e); electives = {}; }
  } else if (sheetsList.some(function (s) { return s.title === TAB_ELECTIVES; })) {
    try {
      var ev = await batchGetValues(sf, ["'" + TAB_ELECTIVES + "'!A:C"]);
      electives = parseElectives(ev[0] || []);
    } catch (e) { logError('electives(선택과목코드)', e); electives = {}; }
  }
  var cv = await readConfigWithVersion(sf, sheetsList);
  return json({ ok: true, sheetId: sheetId, tabs: tabs, electives: electives, configVersion: cv.version });
}

async function handleState(sf, sheetId, tabParam, payload) {
  const sheetsList = await getSheets(sf);
  const tab = await pickTimetableTab(sf, sheetsList, tabParam);
  const tt = await readTimetable(sf, tab);
  if (tt === null) {
    return json({ ok: false, error: 'not_timetable', reasons: ['시간표 형식 탭이 아닙니다.'] }, 400);
  }
  const grid = tt.grid;
  const dataStart = tt.dataStart;
  const dataEnd = lastDataRow(grid);
  const cv = await readConfigWithVersion(sf, sheetsList);
  const lp = await readLinkedPinned(sf, sheetsList);
  CORE.resolvePinned(cv.config, lp.pinned);
  deriveClasslessFromGrades(cv.config, lp.grades);
  const version = hashGrid(grid, dataStart, dataEnd);
  let depts = null;
  if (sheetsList.some(function (s) { return s.title === TAB_DEPTS; })) {
    try {
      const dv = await batchGetValues(sf, ["'" + TAB_DEPTS + "'!A:E"]);
      depts = parseDepts(dv[0] || []);
    } catch (e) { logError('parseDepts', e); depts = null; }
  }
  return json({
    ok: true, sheetId: sheetId, tab: tab, grid: grid, dataStart: dataStart,
    config: cv.config, version: version, configVersion: cv.version, user: payload.email, depts: depts,
    warnings: lp.warnings, pinnedSource: cv.config.pinnedSource, linkedPinned: lp.pinned
  });
}

async function handleApply(sf, sheetId, body, payload) {
  const sheetsList = await getSheets(sf);
  // 쓰기 경로는 폴백하지 않는다. 클라이언트가 지정한 탭이 사라졌거나 이름이 바뀌었다면
  // 다른 탭(대개 원본 revised)에 기록하는 대신 명시적으로 거부한다.
  const picked = resolveApplyTab(sheetsList, body.tab);
  if (picked.error) {
    return json({
      ok: false, error: 'tab_not_found',
      reasons: ['작업 중이던 탭을 찾을 수 없습니다(이름 변경·삭제 가능성). 새로고침 후 탭을 다시 선택해 주세요.']
    }, 400);
  }
  const tab = picked.tab || await pickTimetableTab(sf, sheetsList, null);

  const tt = await readTimetable(sf, tab);
  if (tt === null) {
    return json({ ok: false, error: 'not_timetable', reasons: ['시간표 형식 탭이 아닙니다.'] }, 400);
  }
  const grid = tt.grid;
  const layout = tt.layout;
  const dataStart = tt.dataStart;
  const dataEnd = lastDataRow(grid);
  const cv = await readConfigWithVersion(sf, sheetsList);
  const config = cv.config;
  const lp = await readLinkedPinned(sf, sheetsList);
  CORE.resolvePinned(config, lp.pinned);
  deriveClasslessFromGrades(config, lp.grades);
  const model = CORE.buildModel(grid.slice(dataStart - 1), dataStart);

  const currentVersion = hashGrid(grid, dataStart, dataEnd);
  if (body.baseVersion && body.baseVersion !== currentVersion) {
    return json({ ok: false, error: 'stale', reasons: ['시트가 변경되었습니다. 새로고침 후 다시 시도하세요.'] }, 409);
  }

  // RA 감독 배정/해제 (moves 와 상호배타). 있으면 여기서 처리·반환.
  const assigns = body.assigns || [];
  const clears = body.clears || [];
  if (assigns.length || clears.length) {
    const err = raOpError(model, assigns, clears);
    if (err) {
      const raReason = {
        invalid_assign: '대상이 교사 행이 아닙니다.',
        invalid_clear: '대상이 교사 행이 아닙니다.',
        cell_occupied: '이미 다른 수업이 있는 슬롯입니다.',
        not_ra: 'RA 감독 배정 셀이 아닙니다.',
        invalid_value: 'RA 배정 값이 올바르지 않습니다.',
        duplicate_ra: '이미 그 반에 감독이 배정되어 있습니다.'
      };
      return json({ ok: false, error: err.error, reasons: [raReason[err.error]] }, err.status);
    }
    const cells = assigns.map(function (a) { return { row: a.row, idx: a.idx, value: (a.value == null || String(a.value).trim() === '') ? 'RA' : String(a.value).trim() }; })
      .concat(clears.map(function (c) { return { row: c.row, idx: c.idx, value: '' }; }));
    const data = cellsToBatchData(tab, cells, layout.slotStartCol);
    if (data.length) await batchUpdateValues(sf, data);

    // 변경이력 기록(대상 시트의 '변경이력' 탭)
    if (!sheetsList.some(function (s) { return s.title === TAB_HISTORY; })) {
      await addSheet(sf, TAB_HISTORY);
      await appendRows(sf, TAB_HISTORY, [['시각', '사용자', '유형', '교사', '과목', '원래슬롯', '새슬롯', '상태', '비고']]);
    }
    const histRows = assigns.map(function (a) {
      const entry = model.entries.find(function (x) { return x.row === a.row; });
      const val = (a.value == null || String(a.value).trim() === '') ? 'RA' : String(a.value).trim();
      return [new Date().toISOString(), payload.email, historyKindLabel('assign'), entry.name, val, '', CORE.slotLabel(a.idx), '확정', tab];
    }).concat(clears.map(function (c) {
      const entry = model.entries.find(function (x) { return x.row === c.row; });
      const cval = String(entry.slots[c.idx] == null ? '' : entry.slots[c.idx]).trim() || 'RA';
      return [new Date().toISOString(), payload.email, historyKindLabel('unassign'), entry.name, cval, CORE.slotLabel(c.idx), '', '확정', tab];
    }));
    if (histRows.length) await appendRows(sf, TAB_HISTORY, histRows);

    // 최신 상태 재조회(동일 탭 유지)
    const tt2 = await readTimetable(sf, tab);
    const grid2 = tt2 ? tt2.grid : grid;
    const dataStart2 = tt2 ? tt2.dataStart : dataStart;
    const dataEnd2 = lastDataRow(grid2);
    const version2 = hashGrid(grid2, dataStart2, dataEnd2);
    const cv2 = await readConfigWithVersion(sf, sheetsList);
    CORE.resolvePinned(cv2.config, lp.pinned);
    deriveClasslessFromGrades(cv2.config, lp.grades);
    return json({
      ok: true, sheetId: sheetId, tab: tab, grid: grid2, dataStart: dataStart2,
      config: cv2.config, version: version2, configVersion: cv2.version, applied: cells.length,
      warnings: [], pinnedSource: cv2.config.pinnedSource, linkedPinned: lp.pinned
    });
  }

  const moves = body.moves || [];
  const badRows = nonTeacherRows(model, moves);
  if (badRows.length) {
    return json({ ok: false, error: 'invalid_move', reasons: ['교사 행이 아닌 대상은 이동할 수 없습니다.'] }, 400);
  }
  if (incompleteUnits(model, config, moves, CORE.expandUnit).length) {
    return json({ ok: false, error: 'incomplete_unit', reasons: ['그룹/팀 이동은 전체가 함께 이동해야 합니다.'] }, 400);
  }
  const delta = CORE.checkMovesDelta(model, config, moves);
  if (delta.blocks.length) {
    return json({
      ok: false, error: 'conflict',
      reasons: delta.blocks.map(function (c) { return c.message; }),
      preexisting: delta.preexisting.map(function (c) { return c.message; })
    }, 409);
  }

  const cells = CORE.movesToCellWrites(model, moves);
  const data = cellsToBatchData(tab, cells, layout.slotStartCol);
  if (data.length) await batchUpdateValues(sf, data);

  // 변경이력 기록(대상 시트의 '변경이력' 탭)
  if (!sheetsList.some(function (s) { return s.title === TAB_HISTORY; })) {
    await addSheet(sf, TAB_HISTORY);
    await appendRows(sf, TAB_HISTORY, [['시각', '사용자', '유형', '교사', '과목', '원래슬롯', '새슬롯', '상태', '비고']]);
  }
  const histRows = moves.map(function (mv) {
    const entry = model.entries.find(function (en) { return en.row === mv.row; });
    const subject = entry ? entry.slots[mv.fromIdx] : '';
    return [
      new Date().toISOString(), payload.email, historyKindLabel(body.kind, moves),
      mv.name, subject, CORE.slotLabel(mv.fromIdx), CORE.slotLabel(mv.toIdx), '확정', tab
    ];
  });
  if (histRows.length) await appendRows(sf, TAB_HISTORY, histRows);

  // 최신 상태 재조회(동일 탭 유지)
  const tt2 = await readTimetable(sf, tab);
  const grid2 = tt2 ? tt2.grid : grid;
  const dataStart2 = tt2 ? tt2.dataStart : dataStart;
  const dataEnd2 = lastDataRow(grid2);
  const version2 = hashGrid(grid2, dataStart2, dataEnd2);
  const cv2 = await readConfigWithVersion(sf, sheetsList);
  CORE.resolvePinned(cv2.config, lp.pinned);
  deriveClasslessFromGrades(cv2.config, lp.grades);
  return json({
    ok: true, sheetId: sheetId, tab: tab, grid: grid2, dataStart: dataStart2,
    config: cv2.config, version: version2, configVersion: cv2.version, applied: cells.length,
    warnings: delta.preexisting.map(function (c) { return c.message; }),
    pinnedSource: cv2.config.pinnedSource, linkedPinned: lp.pinned
  });
}

async function handleDuplicateTab(sf, sheetId, body) {
  const sheetsList = await getSheets(sf);
  const src = sheetsList.find(function (s) { return s.title === body.tab; });
  if (!src) return json({ ok: false, error: 'no_tab', reasons: ['탭을 찾을 수 없습니다: ' + body.tab] }, 400);
  const newName = nextCopyName(sheetsList.map(function (s) { return s.title; }), body.tab);
  await duplicateSheet(sf, src.sheetId, newName, src.index + 1);
  return json({ ok: true, sheetId: sheetId, tab: newName });
}

async function handleConfig(sf, sheetId, body) {
  const sheetsList = await getSheets(sf);
  if (typeof body.baseConfigVersion === 'undefined') {
    return json({ ok: false, error: 'missing_base_version', reasons: ['설정 버전이 필요합니다. 새로고침 후 다시 시도하세요.'] }, 400);
  }
  // 조회 실패를 "설정 탭 없음"(빈 해시)으로 위장하면 낙관적 락이 무의미해지고
  // 설정 전체가 소거된다. 실패면 저장 자체를 거부한다.
  const cur = await readConfigWithVersion(sf, sheetsList);
  if (cur.unavailable) {
    return json({
      ok: false, error: 'config_unavailable',
      reasons: ['설정을 불러오지 못해 저장할 수 없습니다. 새로고침 후 다시 시도해 주세요.']
    }, 503);
  }
  if (body.baseConfigVersion !== cur.version) {
    return json({ ok: false, error: 'stale_config', reasons: ['다른 사용자가 설정을 변경했습니다. 새로고침 후 다시 시도하세요.'] }, 409);
  }
  if (!sheetsList.some(function (s) { return s.title === TAB_CONFIG; })) {
    await addSheet(sf, TAB_CONFIG);
  }
  const values = CORE.serializeConfig(body.config || {});
  // clear 없이 A:C 범위만 단일 batchUpdate 로 덮어쓴다.
  // (1) clear→write 사이의 "설정 탭이 빈 채로 남는" 구간 제거
  // (2) D열 이후의 메모·보조 데이터 보존
  await overwriteSheetRange(sf, TAB_CONFIG, values, 3, (cur.raw || []).length);
  return json({ ok: true });
}

/* =========================================================
   DEV MODE 핸들러 (인메모리 모의 스토어, env.DEV_MODE==='1' 에서만 사용)
   프로덕션 경로와 동일한 계약(응답 형태·reason 문자열)을 미러링한다.
   시트 URL/ID 입력은 dev 에서 무시(고정 mock). 응답에 devMode:true 유지.
   ========================================================= */
function handleSheetsDev() {
  const store = getMockStore();
  return json({ ok: true, sheetId: 'MOCK', tabs: mockListTabs(store), electives: store.electives || {}, configVersion: hashValues(store.config), devMode: true });
}

function handleStateDev(tabParam, payload) {
  const store = getMockStore();
  const tab = (tabParam && store.sheets[tabParam]) ? tabParam : mockPickTab(store);
  const grid = pad42(store.sheets[tab]);
  store.sheets[tab] = grid;
  const hr = detectHeaderRow(grid);
  const dataStart = hr !== null ? hr + 1 : 3;
  const dataEnd = lastDataRow(grid);
  const config = CORE.parseConfig(store.config);
  config.missing = false;
  CORE.resolvePinned(config, store.pinned || {});
  deriveClasslessFromGrades(config, store.grades || {});
  const version = hashGrid(grid, dataStart, dataEnd);
  return json({ ok: true, sheetId: 'MOCK', tab: tab, grid: grid, dataStart: dataStart, config: config, version: version, configVersion: hashValues(store.config), user: payload.email, depts: store.depts || null, devMode: true, warnings: store.warnings || [], pinnedSource: config.pinnedSource, linkedPinned: store.pinned || {} });
}

function handleApplyDev(body, payload) {
  const store = getMockStore();
  // 프로덕션과 동일: 쓰기 경로는 없는 탭으로 폴백하지 않는다.
  if (body.tab && !store.sheets[body.tab]) {
    return json({
      ok: false, error: 'tab_not_found',
      reasons: ['작업 중이던 탭을 찾을 수 없습니다(이름 변경·삭제 가능성). 새로고침 후 탭을 다시 선택해 주세요.']
    }, 400);
  }
  const tab = body.tab || mockPickTab(store);
  store.sheets[tab] = pad42(store.sheets[tab]);
  const grid = store.sheets[tab];
  const hr = detectHeaderRow(grid);
  const dataStart = hr !== null ? hr + 1 : 3;
  const dataEnd = lastDataRow(grid);
  const config = CORE.parseConfig(store.config);
  config.missing = false;
  CORE.resolvePinned(config, store.pinned || {});
  deriveClasslessFromGrades(config, store.grades || {});
  const model = CORE.buildModel(grid.slice(dataStart - 1), dataStart);
  const currentVersion = hashGrid(grid, dataStart, dataEnd);
  if (body.baseVersion && body.baseVersion !== currentVersion) {
    return json({ ok: false, error: 'stale', reasons: ['시트가 변경되었습니다. 새로고침 후 다시 시도하세요.'] }, 409);
  }
  // RA 감독 배정/해제 (moves 와 상호배타). 있으면 여기서 처리·반환.
  const assigns = body.assigns || [];
  const clears = body.clears || [];
  if (assigns.length || clears.length) {
    const err = raOpError(model, assigns, clears);
    if (err) {
      const raReason = { invalid_assign: '대상이 교사 행이 아닙니다.', invalid_clear: '대상이 교사 행이 아닙니다.', cell_occupied: '이미 다른 수업이 있는 슬롯입니다.', not_ra: 'RA 감독 배정 셀이 아닙니다.', invalid_value: 'RA 배정 값이 올바르지 않습니다.', duplicate_ra: '이미 그 반에 감독이 배정되어 있습니다.' };
      return json({ ok: false, error: err.error, reasons: [raReason[err.error]] }, err.status);
    }
    const cells = assigns.map((a) => ({ row: a.row, idx: a.idx, value: (a.value == null || String(a.value).trim() === '') ? 'RA' : String(a.value).trim() }))
      .concat(clears.map((c) => ({ row: c.row, idx: c.idx, value: '' })));
    applyCellsToGrid(grid, cells);
    assigns.forEach((a) => {
      const entry = model.entries.find((x) => x.row === a.row);
      const val = (a.value == null || String(a.value).trim() === '') ? 'RA' : String(a.value).trim();
      store.history.push([new Date().toISOString(), payload.email, historyKindLabel('assign'), entry.name, val, '', CORE.slotLabel(a.idx), '확정', tab]);
    });
    clears.forEach((c) => {
      const entry = model.entries.find((x) => x.row === c.row);
      const cval = String(entry.slots[c.idx] == null ? '' : entry.slots[c.idx]).trim() || 'RA';
      store.history.push([new Date().toISOString(), payload.email, historyKindLabel('unassign'), entry.name, cval, CORE.slotLabel(c.idx), '', '확정', tab]);
    });
    const dataEndRa = lastDataRow(grid);
    const versionRa = hashGrid(grid, dataStart, dataEndRa);
    return json({ ok: true, sheetId: 'MOCK', tab: tab, grid: grid, dataStart: dataStart, config: config, version: versionRa, configVersion: hashValues(store.config), applied: cells.length, devMode: true, warnings: [], pinnedSource: config.pinnedSource, linkedPinned: store.pinned || {} });
  }
  const moves = body.moves || [];
  const badRows = nonTeacherRows(model, moves);
  if (badRows.length) {
    return json({ ok: false, error: 'invalid_move', reasons: ['교사 행이 아닌 대상은 이동할 수 없습니다.'] }, 400);
  }
  if (incompleteUnits(model, config, moves, CORE.expandUnit).length) {
    return json({ ok: false, error: 'incomplete_unit', reasons: ['그룹/팀 이동은 전체가 함께 이동해야 합니다.'] }, 400);
  }
  const delta = CORE.checkMovesDelta(model, config, moves);
  if (delta.blocks.length) {
    return json({ ok: false, error: 'conflict', reasons: delta.blocks.map((c) => c.message), preexisting: delta.preexisting.map((c) => c.message) }, 409);
  }
  const cells = CORE.movesToCellWrites(model, moves);
  applyCellsToGrid(grid, cells);
  moves.forEach((mv) => {
    const entry = model.entries.find((en) => en.row === mv.row);
    const subject = entry ? entry.slots[mv.fromIdx] : '';
    store.history.push([
      new Date().toISOString(), payload.email, historyKindLabel(body.kind, moves),
      mv.name, subject, CORE.slotLabel(mv.fromIdx), CORE.slotLabel(mv.toIdx), '확정', tab
    ]);
  });
  const dataEnd2 = lastDataRow(grid);
  const version2 = hashGrid(grid, dataStart, dataEnd2);
  return json({ ok: true, sheetId: 'MOCK', tab: tab, grid: grid, dataStart: dataStart, config: config, version: version2, configVersion: hashValues(store.config), applied: cells.length, devMode: true, warnings: delta.preexisting.map((c) => c.message), pinnedSource: config.pinnedSource, linkedPinned: store.pinned || {} });
}

function handleDuplicateTabDev(body) {
  const store = getMockStore();
  if (!body.tab || !store.sheets[body.tab]) return json({ ok: false, error: 'no_tab', reasons: ['탭을 찾을 수 없습니다.'] }, 400);
  const name = mockDuplicateTab(store, body.tab);
  return json({ ok: true, sheetId: 'MOCK', tab: name, devMode: true });
}

function handleConfigDev(body) {
  const store = getMockStore();
  if (typeof body.baseConfigVersion === 'undefined') {
    return json({ ok: false, error: 'missing_base_version', reasons: ['설정 버전이 필요합니다. 새로고침 후 다시 시도하세요.'] }, 400);
  }
  if (body.baseConfigVersion !== hashValues(store.config)) {
    return json({ ok: false, error: 'stale_config', reasons: ['다른 사용자가 설정을 변경했습니다. 새로고침 후 다시 시도하세요.'] }, 409);
  }
  mockSaveConfig(store, CORE.serializeConfig(body.config || {}));
  return json({ ok: true, devMode: true });
}

/* =========================================================
   엔트리
   ========================================================= */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' && request.method === 'GET') {
      return new Response(html.replace(/__GOOGLE_CLIENT_ID__/g, env.GOOGLE_CLIENT_ID).replace(/__DEV_MODE__/g, env.DEV_MODE === '1' ? '1' : ''), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    // 코어 스크립트 제공(브라우저 주입용, 무인증)
    if (request.method === 'GET' && (path === '/core/Core_Model.js' || path === '/core/Core_Validate.js' || path === '/core/Core_Recommend.js')) {
      const src = path === '/core/Core_Model.js' ? CoreModelSrc
        : path === '/core/Core_Validate.js' ? CoreValidateSrc
        : CoreRecommendSrc;
      return new Response(src, { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    }

    if (path.startsWith('/api/')) {
      if (env.DEV_MODE === '1') {
        const payload = { email: env.DEV_EMAIL };
        try {
          if (path === '/api/sheets' && request.method === 'GET') return handleSheetsDev();
          if (path === '/api/state' && request.method === 'GET') return handleStateDev(url.searchParams.get('tab'), payload);
          if (path === '/api/apply' && request.method === 'POST') {
            let body; try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }
            return handleApplyDev(body, payload);
          }
          if (path === '/api/duplicate-tab' && request.method === 'POST') {
            let body; try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }
            return handleDuplicateTabDev(body);
          }
          if (path === '/api/config' && request.method === 'POST') {
            let body; try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }
            return handleConfigDev(body);
          }
          return json({ ok: false, error: 'not_found' }, 404);
        } catch (e) { logError('dev_handler', e); return json({ ok: false, error: String(e && e.message || e) }, 500); }
      }
      const payload = await authenticate(request, env);
      if (payload instanceof Response) return payload;

      // 시트 접근은 사용자 본인의 OAuth access token 으로만 수행한다(SA 경로 없음).
      const sheetsToken = (request.headers.get('x-sheets-token') || '').trim();
      if (!sheetsToken) {
        return json({
          ok: false, error: 'missing_sheets_token',
          reasons: ['시트 접근 권한이 필요합니다. 다시 로그인해 주세요.']
        }, 401);
      }

      try {
        if (path === '/api/sheets' && request.method === 'GET') {
          const sheetId = resolveSheetId(url.searchParams.get('sheetId'), env.SPREADSHEET_ID);
          if (!sheetId) return noSheetSelected();
          return await handleSheets(makeSheetsFetch(sheetsToken, sheetId), sheetId);
        }
        if (path === '/api/state' && request.method === 'GET') {
          const sheetId = resolveSheetId(url.searchParams.get('sheetId'), env.SPREADSHEET_ID);
          if (!sheetId) return noSheetSelected();
          return await handleState(makeSheetsFetch(sheetsToken, sheetId), sheetId, url.searchParams.get('tab'), payload);
        }
        if (path === '/api/apply' && request.method === 'POST') {
          let body;
          try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }
          const sheetId = resolveSheetId(body.sheetId, env.SPREADSHEET_ID);
          if (!sheetId) return noSheetSelected();
          return await handleApply(makeSheetsFetch(sheetsToken, sheetId), sheetId, body, payload);
        }
        if (path === '/api/duplicate-tab' && request.method === 'POST') {
          let body;
          try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }
          const sheetId = resolveSheetId(body.sheetId, env.SPREADSHEET_ID);
          if (!sheetId) return noSheetSelected();
          return await handleDuplicateTab(makeSheetsFetch(sheetsToken, sheetId), sheetId, body);
        }
        if (path === '/api/config' && request.method === 'POST') {
          let body;
          try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }
          const sheetId = resolveSheetId(body.sheetId, env.SPREADSHEET_ID);
          if (!sheetId) return noSheetSelected();
          return await handleConfig(makeSheetsFetch(sheetsToken, sheetId), sheetId, body);
        }
        return json({ ok: false, error: 'not_found' }, 404);
      } catch (e) {
        return handleApiError(e);
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
