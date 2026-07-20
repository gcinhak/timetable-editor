/**
 * 통합 단위 테스트 (Node ESM). 실행: node test/run_tests.js
 * 커버: parseConfig / apply 재검증(checkMoves) / sheets 배치 변환 / hashGrid / 인증.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { slotColLetter, cellsToBatchData, hashGrid, hashValues, lastDataRow, parseLinkedGroups, deriveClasslessFromGrades, detectLayout, normalizeGrid, colLetter, makeSheetsFetch, resolveSheetId, sheetsErrorStatus, mapSheetsError, overwriteSheetRange, padRows, parseStageTab, nextStageNames } from '../src/lib/sheets.js';
import { signJwtRS256, verifyIdToken } from '../src/lib/google-auth.js';
import { readConfigSafe, readConfigWithVersion, resolveApplyTab, nonTeacherRows, incompleteUnits, historyKindLabel, deptBoundaries, parseDepts, gradeSlotState, toggleGradeSlot, gradeFreeState, assignCandidates, raOpError, isRaValue, RA_VALUE_RE, parseRaValue, nextRaSeq, formatRaValue, raFreeCellLabel, subjectGradeTargets, gradeSubjectIndex } from '../src/lib/state.js';
import { getMockStore, resetMockStore, mockPickTab, applyCellsToGrid, mockDuplicateTab, mockSaveConfig, mockListTabs } from '../src/dev/mock_store.js';

// 코어(CJS 가드형)를 worker/브라우저와 동일하게 텍스트 연결 → new Function 로드.
// (package.json "type":"module" 이라 .js 를 require 하면 ESM 로 해석돼 CJS 가드가 깨짐)
const __dir = dirname(fileURLToPath(import.meta.url));
const readCore = function (rel) { return readFileSync(join(__dir, rel), 'utf8'); };
const CORE = new Function(
  readCore('../src/core/Core_Model.js') + '\n' +
  readCore('../src/core/Core_Validate.js') + '\n' +
  readCore('../src/core/Core_Recommend.js') + '\n' +
  readCore('../src/core/web_extra.js') + '\n' +
  'return { buildModel, checkMoves, checkMovesDelta, hasBlock, parseConfig, planMoveTo, planMovesTo, planScanTo, planScanAll, planSwapTo, slotLabel, movesToCellWrites, serializeConfig, expandUnit, findConflicts, resolvePinned };'
)();
const parseConfig = CORE.parseConfig;
const CM = { buildModel: CORE.buildModel };
const CV = { checkMoves: CORE.checkMoves, checkMovesDelta: CORE.checkMovesDelta, hasBlock: CORE.hasBlock };

const failures = [];
function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + desc);
  if (!cond) failures.push(desc);
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// index.html 안의 함수 하나를 중괄호 매칭으로 잘라낸다(브라우저 코드를 new Function 으로 로드하기 위함)
function fnSrc(html, name) {
  const start = html.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('함수를 찾지 못함: ' + name);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('중괄호 불일치: ' + name);
}
async function expectFail(desc, promise, code, status) {
  try {
    await promise;
    check(desc + ' (거부되어야 함)', false);
  } catch (e) {
    check(desc + ' → ' + e.message + (e.status ? '/' + e.status : ''),
      e.message === code && (status === undefined || e.status === status));
  }
}

/* =========================================================
   1. parseConfig
   ========================================================= */
{
  const values = [
    ['[고정블록]'], ['슬롯', '라벨', '적용학년'], ['월3', 'Counseling', '전체'], ['화7', 'S.A', '7,8,9'], [''],
    ['[무반과목]'], ['과목명', '대상학급', '비고'], ['Cal12', '12전체', ''], ['JMA', '', ''], [''],
    ['[팀티칭]'], ['과목명', '교사들'], ['Cal12', '교사04, 교사07']
  ];
  const cfg = parseConfig(values);
  check('parseConfig fixedBlocks 2개', cfg.fixedBlocks.length === 2);
  const wol3 = cfg.fixedBlocks.find(function (b) { return b.day === 0 && b.period === 3; });
  check('월3 grades === "all"', wol3 && wol3.grades === 'all');
  const hwa7 = cfg.fixedBlocks.find(function (b) { return b.day === 1 && b.period === 7; });
  check('화7 grades === [7,8,9]', hwa7 && eq(hwa7.grades, [7, 8, 9]));
  check('classless.Cal12 === ["12전체"]', eq(cfg.classless['Cal12'], ['12전체']));
  check('classless.JMA 키 없음(미분류)', !Object.prototype.hasOwnProperty.call(cfg.classless, 'JMA'));
  check('classlessUnset 에 JMA 포함', (cfg.classlessUnset || []).indexOf('JMA') !== -1);
  check('teamTeaching.Cal12 === ["교사04","교사07"]', eq(cfg.teamTeaching['Cal12'], ['교사04', '교사07']));
}

/* =========================================================
   1b. 무반 미지정(미분류) vs 대상없음 확정 분리
   ========================================================= */
{
  const serializeConfig = CORE.serializeConfig;
  // (a) 빈 대상 행 → 키 없음(미분류) + classlessUnset 수집
  const a = parseConfig([['[무반과목]'],['과목명','대상학급','비고'],['ApCalAB','','']]);
  check('빈행→classless 키 없음', !Object.prototype.hasOwnProperty.call(a.classless,'ApCalAB'));
  check('빈행→classlessUnset 포함', a.classlessUnset.indexOf('ApCalAB')!==-1);
  // (b) '없음' 토큰 → [] (대상 없음 확정)
  const b = parseConfig([['[무반과목]'],['과목명','대상학급','비고'],['ApCalBC','없음','']]);
  check("'없음'→[]", eq(b.classless['ApCalBC'], []));
  const b2 = parseConfig([['[무반과목]'],['과목명','대상학급','비고'],['ApCalBC','대상 없음','']]);
  check("'대상 없음'(공백)→[]", eq(b2.classless['ApCalBC'], []));
  // (c) 라운드트립 []→'없음'→[]
  const rows = serializeConfig({ classless: { Econ: [] }, classlessUnset: [] });
  const back = parseConfig(rows);
  check('라운드트립 []→없음→[]', eq(back.classless['Econ'], []));
  // (d) 하위호환: 기존 빈행 데이터는 이제 미분류(키 없음)로 파싱
  const c = parseConfig([['[무반과목]'],['과목명','대상학급','비고'],['Legacy','','메모']]);
  check('하위호환 빈행→미분류', !Object.prototype.hasOwnProperty.call(c.classless,'Legacy') && c.classlessUnset.indexOf('Legacy')!==-1);
}

/* =========================================================
   1c. [정규교시] 블록 파싱/직렬화 왕복 (규칙 제거 후에도 시트 내용 보존)
   ========================================================= */
{
  const serializeConfig = CORE.serializeConfig;
  const values = [
    ['[정규교시]'], ['학년', '요일', '교시'],
    ['8', '금', '7'], ['7', '화', '7'],
    ['8', '금', '9'],            // period 9 = 파싱 실패 → rawExtras 보존
  ];
  const cfg = parseConfig(values);
  check('regularSlots 2건 파싱', cfg.regularSlots.length === 2);
  check('8학년 금7 등록', cfg.regularSlots.some(function (s) { return s.grade === 8 && s.day === 4 && s.period === 7; }));
  check('7학년 화7 등록', cfg.regularSlots.some(function (s) { return s.grade === 7 && s.day === 1 && s.period === 7; }));
  check('정규교시 파싱실패행 rawExtras 보존', !!cfg.rawExtras['[정규교시]'] && cfg.rawExtras['[정규교시]'].length === 1);
  // 왕복: serialize → re-parse 동일
  const back = parseConfig(serializeConfig(cfg));
  check('정규교시 왕복 regularSlots 동일', eq(back.regularSlots, cfg.regularSlots));
  check('정규교시 왕복 rawExtras 보존', eq(back.rawExtras['[정규교시]'], cfg.rawExtras['[정규교시]']));
  // 7·8교시 특별취급 없음: 등록/미등록과 무관하게 일반 판정
  const model0 = { entries: [] };
  check('8학년 금7 → 일반 판정', gradeFreeState(model0, cfg, 8, { day: 4, period: 7 }).kind === 'all');
  check('7학년 금7 → 일반 판정(동일)', gradeFreeState(model0, cfg, 7, { day: 4, period: 7 }).kind === 'all');
  // 직렬화 원문 보존: [정규교시] 블록의 유효행·실패행이 모두 다시 써진다
  const rows = serializeConfig(cfg).map(function (r) { return r.join('|'); });
  check('직렬화에 [정규교시] 블록 유지', rows.indexOf('[정규교시]') !== -1);
  check('직렬화에 유효행 8|금|7 유지', rows.indexOf('8|금|7') !== -1);
  check('직렬화에 실패행 8|금|9 유지', rows.indexOf('8|금|9') !== -1);
  // busy 판정도 정상 동작: 8학년 금7 슬롯(idx 4*8+6=38)에 Kor8A 배정 → 8A busy
  const modelBusy = { entries: [{ slots: (function () { var a = []; a[38] = 'Kor8A'; return a; })() }] };
  const gfb = gradeFreeState(modelBusy, cfg, 8, { day: 4, period: 7 });
  check('8학년 금7 등록 + Kor8A 배정 → 8A busy', gfb.busyClasses.indexOf('8A') !== -1);
}

/* =========================================================
   2. apply 재검증 (checkMoves)
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  // teacherX(행3): Kor7A @idx1, teacherY(행4): Kor7A @idx0
  const dataRows = [
    dataRow('김X', { 1: 'Kor7A' }),
    dataRow('이Y', { 0: 'Kor7A' })
  ];
  const model = CM.buildModel(dataRows, 3);
  const config = {
    fixedBlocks: [],
    classless: { Cal12: ['12A', '12B', '12C'], JMA: ['12A', '12B', '12C'] },
    teamTeaching: {}
  };

  // (a) 유효 이동: teacherX의 Kor7A(idx1) → 빈 슬롯(idx5)
  const okMoves = [{ name: '김X', row: 3, fromIdx: 1, toIdx: 5 }];
  const okConf = CV.checkMoves(model, config, okMoves);
  check('유효 이동은 block 없음', CV.hasBlock(okConf) === false);

  // (b) 학급 중복: teacherY의 Kor7A(idx0) → idx1 (teacherX Kor7A와 같은 슬롯·학급 7A)
  const badMoves = [{ name: '이Y', row: 4, fromIdx: 0, toIdx: 1 }];
  const badConf = CV.checkMoves(model, config, badMoves);
  const reasons = badConf.filter(function (c) { return c.severity === 'block'; }).map(function (c) { return c.message; });
  check('학급 충돌 이동은 block 발생', CV.hasBlock(badConf) === true && reasons.length > 0);

  // (c) 델타: 기존 충돌 슬롯을 지나는 무관 이동은 통과(block 없음) + preexisting 보고
  // 교사P/교사Q가 idx1에 Kor7A(기존 7A@월2 충돌), 교사R은 idx5 Kor8A → idx1로 이동(무관 과목)
  const preRows = [
    dataRow('P', { 1: 'Kor7A' }),
    dataRow('Q', { 1: 'Kor7A' }),
    dataRow('R', { 5: 'Kor8A' })
  ];
  const preModel = CM.buildModel(preRows, 3);
  const preDelta = CV.checkMovesDelta(preModel, config, [{ name: 'R', row: 5, fromIdx: 5, toIdx: 1 }]);
  check('기존충돌 슬롯 통과 이동은 block 없음', preDelta.blocks.length === 0);
  check('기존충돌은 preexisting 경고로 보고', preDelta.preexisting.some(function (c) { return c.preexisting === true && c.slot === 1; }));
}

/* =========================================================
   3. sheets 배치 변환
   ========================================================= */
{
  check('slotColLetter(0)==="C"', slotColLetter(0) === 'C');
  check('slotColLetter(7)==="J"', slotColLetter(7) === 'J');
  check('slotColLetter(23)==="Z"', slotColLetter(23) === 'Z');
  check('slotColLetter(24)==="AA"', slotColLetter(24) === 'AA');
  check('slotColLetter(39)==="AP"', slotColLetter(39) === 'AP');

  const cells = [{ row: 3, idx: 0, value: '' }, { row: 45, idx: 39, value: 'X' }];
  const data = cellsToBatchData('시간표(작업)', cells);
  check("cellsToBatchData[0].range === 'C3'",
    data[0].range === "'시간표(작업)'!C3" && eq(data[0].values, [['']]));
  check("cellsToBatchData[1].range === 'AP45'",
    data[1].range === "'시간표(작업)'!AP45" && eq(data[1].values, [['X']]));
}

/* =========================================================
   3b. 레이아웃 탐지 / 정규화 / 역매핑 (가변 slotStartCol 버그 수정)
   ========================================================= */
{
  function headerRowAt(slotStartCol) {
    // 1-based slotStartCol 위치(index slotStartCol-1)에 'Mon1'을 둔 헤더행(index1)
    var row = [];
    for (var i = 0; i < 12; i++) row.push('');
    row[slotStartCol - 1] = 'Mon1';
    return row;
  }
  function gridWithHeader(slotStartCol) {
    return [
      ['제목행'],                 // index0
      headerRowAt(slotStartCol),  // index1 = 1-based 2행
      ['교사01']                  // index2 데이터
    ];
  }
  // detectLayout: B/C/D 시작 3케이스
  var lB = detectLayout(gridWithHeader(2));
  check('detectLayout B-start → slotStartCol 2', lB && lB.slotStartCol === 2 && lB.headerRow === 2);
  var lC = detectLayout(gridWithHeader(3));
  check('detectLayout C-start → slotStartCol 3', lC && lC.slotStartCol === 3 && lC.headerRow === 2);
  var lD = detectLayout(gridWithHeader(4));
  check('detectLayout D-start → slotStartCol 4', lD && lD.slotStartCol === 4 && lD.headerRow === 2);
  // Mon1 없음 → null
  check('detectLayout Mon1 없음 → null', detectLayout([['a', 'b'], ['c', 'd']]) === null);

  // normalizeGrid: D-start 원시행 [teacher, classroom, 'EMPTY', 'S0','S1',...]
  var rawD = ['T', 'C', 'EMPTY'];
  for (var k = 0; k < 40; k++) rawD.push('S' + k);
  var outD = normalizeGrid([rawD], { headerRow: 2, slotStartCol: 4 })[0];
  check('normalizeGrid D-start out[0]=teacher', outD[0] === 'T');
  check('normalizeGrid D-start out[1]=classroom', outD[1] === 'C');
  check('normalizeGrid D-start out[2]=S0', outD[2] === 'S0');
  check('normalizeGrid D-start out[3]=S1', outD[3] === 'S1');

  // normalizeGrid: B-start 원시행 [teacher, 'S0','S1',...] → classroom '' , out[2]=S0
  var rawB = ['T'];
  for (var k2 = 0; k2 < 40; k2++) rawB.push('S' + k2);
  var outB = normalizeGrid([rawB], { headerRow: 2, slotStartCol: 2 })[0];
  check('normalizeGrid B-start out[1]="" (교실열 없음)', outB[1] === '');
  check('normalizeGrid B-start out[2]=S0', outB[2] === 'S0');

  // 역매핑: cellsToBatchData slotStartCol 반영
  check("cellsToBatchData slotStartCol=2 → 'T'!B3",
    cellsToBatchData('T', [{ row: 3, idx: 0, value: 'x' }], 2)[0].range === "'T'!B3");
  check("cellsToBatchData slotStartCol=4 → 'T'!D3",
    cellsToBatchData('T', [{ row: 3, idx: 0, value: 'x' }], 4)[0].range === "'T'!D3");
  check("cellsToBatchData 기본(인자없음) → 'T'!C3",
    cellsToBatchData('T', [{ row: 3, idx: 0, value: 'x' }])[0].range === "'T'!C3");
}

/* =========================================================
   4. hashGrid 결정성
   ========================================================= */
{
  function mkGrid() {
    const g = [];
    for (let r = 0; r < 5; r++) {
      const row = [];
      for (let c = 0; c < 42; c++) row.push('r' + r + 'c' + c);
      g.push(row);
    }
    return g;
  }
  // dataStart=3(index2), dataEnd=5(index4): 슬롯 셀(index2..41) 행 index2..4만 해시.
  const g0 = mkGrid();
  const h1 = hashGrid(g0, 3, 5);

  const g1 = mkGrid();
  g1[2][2] = 'CHANGED'; // 슬롯 셀
  const h2 = hashGrid(g1, 3, 5);

  const g2 = mkGrid();
  g2[2][0] = 'CHANGED'; // A열(이름)
  const h3 = hashGrid(g2, 3, 5);

  check('hashGrid 슬롯 셀 변경 → 해시 다름', h1 !== h2);
  check('hashGrid A열 변경 → 해시 동일', h1 === h3);
}

/* =========================================================
   4b. 동적 dataStart/dataEnd (헤더행 비-최상단 + 후행 빈 행)
   ========================================================= */
{
  // 0행: 주석, 1행: 헤더(Mon1), 2~3행: 교사 데이터, 4~6행: 후행 전부 빈 행.
  function slotRow(name, subj0) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(i === 0 ? subj0 : '');
    return r;
  }
  const header = ['', ''];
  for (let i = 0; i < 40; i++) header.push('Mon' + (i + 1));
  header[2] = 'Mon1';
  const emptyRow = new Array(42).fill('');
  const grid = [
    ['제목행', '', '', '', '', ''],   // 0
    header,                            // 1 (헤더, 1-based 2)
    slotRow('김A', 'Kor7A'),          // 2 (1-based 3)
    slotRow('이B', 'Kor7B'),          // 3 (1-based 4)
    emptyRow.slice(),                 // 4 후행 빈
    emptyRow.slice(),                 // 5 후행 빈
    emptyRow.slice()                  // 6 후행 빈
  ];
  const dataStart = 3, dataEnd = lastDataRow(grid);
  check('lastDataRow 후행 빈 행 무시 → 4', dataEnd === 4);

  // 후행 빈 행을 더 붙여도 (dataStart,dataEnd) 해시는 동일.
  const grid2 = grid.map((r) => r.slice());
  grid2.push(emptyRow.slice()); grid2.push(emptyRow.slice());
  check('lastDataRow 여전히 4(빈 행 추가 무시)', lastDataRow(grid2) === 4);
  check('hashGrid 후행 빈 행 무시 → 안정적',
    hashGrid(grid, dataStart, dataEnd) === hashGrid(grid2, dataStart, lastDataRow(grid2)));

  const model = CORE.buildModel(grid.slice(dataStart - 1), dataStart);
  check('buildModel 동적 dataStart → entries 2개', model.entries.length === 2);
  check('buildModel 행번호 3,4', eq(model.entries.map((e) => e.row).sort(), [3, 4]));
}

/* =========================================================
   5. 인증 (RSA 자체 발급 ID 토큰)
   ========================================================= */
{
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicJwk = publicKey.export({ format: 'jwk' });

  const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  const DOMAIN = 'gvcs-mg.org';
  const KID = 'test-kid-1';
  const now = Math.floor(Date.now() / 1000);
  const getJwk = async function (kid) { return kid === KID ? publicJwk : null; };
  const opts = { clientId: CLIENT_ID, allowedDomain: DOMAIN, getJwk: getJwk };

  function makeIdToken(overrides, kid) {
    const payload = Object.assign({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '1234567890',
      email: 'x@gvcs-mg.org',
      email_verified: true,
      hd: DOMAIN,
      iat: now,
      exp: now + 3600
    }, overrides || {});
    return signJwtRS256(payload, privatePem, kid === undefined ? KID : kid);
  }

  // 이 블록은 즉시 실행 async IIFE로 감싸 최상위 await 회피
  await (async function () {
    const p = await verifyIdToken(await makeIdToken(), opts);
    check('정상 토큰 통과 (email 반환)', p.email === 'x@gvcs-mg.org');

    await expectFail('gmail.com 도메인 거부',
      verifyIdToken(await makeIdToken({ hd: 'gmail.com', email: 'x@gmail.com' }), opts),
      'domain_not_allowed', 403);
    await expectFail('hd 없는 gmail 거부',
      verifyIdToken(await makeIdToken({ hd: undefined, email: 'x@gmail.com' }), opts),
      'domain_not_allowed', 403);
  })();
}

/* =========================================================
   6. state 헬퍼 — 설정 부재 폴백 / 교사행 이동 가드 / 유형 라벨
   ========================================================= */
await (async function () {
  // (1) 설정 탭 부재 → batchGet throw → missing:true 로 state 성공
  const throwingGet = async function () { throw new Error('sheets_api_error 400 no config tab'); };
  const cfgMissing = await readConfigSafe(throwingGet, "'설정'!A:C", parseConfig);
  check('설정 부재 시 config.missing === true', cfgMissing.missing === true);
  check('설정 부재 시 fixedBlocks 빈 배열', eq(cfgMissing.fixedBlocks, []));
  check('설정 부재 시 classless 빈 객체', eq(cfgMissing.classless, {}));

  // (2) 설정 존재 → missing:false
  const okGet = async function () { return [[['[고정블록]'], ['슬롯', '라벨', '적용학년'], ['월3', 'Counseling', '전체']]]; };
  const cfgOk = await readConfigSafe(okGet, "'설정'!A:C", parseConfig);
  check('설정 존재 시 config.missing === false', cfgOk.missing === false);
  check('설정 존재 시 fixedBlocks 파싱됨', cfgOk.fixedBlocks.length === 1);

  // (3) RA 행 move → nonTeacherRows 비어있지 않음 (apply에서 400 거부 경로)
  const model = { entries: [
    { row: 3, type: 'teacher' },
    { row: 4, type: 'ra' }
  ] };
  check('교사행만 이동 → nonTeacherRows 빈 배열',
    eq(nonTeacherRows(model, [{ row: 3, fromIdx: 0, toIdx: 1 }]), []));
  check('RA행 포함 이동 → nonTeacherRows 해당 row 반환',
    eq(nonTeacherRows(model, [{ row: 4, fromIdx: 0, toIdx: 1 }]), [4]));

  // (4) 유형 라벨 매핑
  check("historyKindLabel('undo') === '되돌리기'", historyKindLabel('undo', [{ fromIdx: 5, toIdx: 2 }]) === '되돌리기');
  check("historyKindLabel('undo') 팀형태여도 '되돌리기'",
    historyKindLabel('undo', [{ fromIdx: 2, toIdx: 5 }, { fromIdx: 2, toIdx: 5 }]) === '되돌리기');
  check("historyKindLabel('chain') === '연쇄'", historyKindLabel('chain', [{ fromIdx: 0, toIdx: 1 }]) === '연쇄');
  check("historyKindLabel(undefined,1건) === '이동'", historyKindLabel(undefined, [{ fromIdx: 0, toIdx: 1 }]) === '이동');
  check("direct 팀이동(같은 슬롯 2건) === '이동(팀)'",
    historyKindLabel('direct', [{ fromIdx: 2, toIdx: 5 }, { fromIdx: 2, toIdx: 5 }]) === '이동(팀)');
  check("direct 서로 다른 슬롯 2건 === '이동'",
    historyKindLabel('direct', [{ fromIdx: 2, toIdx: 5 }, { fromIdx: 3, toIdx: 6 }]) === '이동');
})();

/* =========================================================
   DEV MODE 모의 스토어 (인메모리 스냅샷)
   ========================================================= */
{
  // (1) 스냅샷 차원
  resetMockStore();
  const store = getMockStore();
  check('mock grid 83행', store.sheets.revised.length === 83);
  check('mock grid 모든 행 42열', store.sheets.revised.every((r) => r.length === 42));

  // (2) 설정 파싱
  const cfg = parseConfig(store.config);
  check('mock fixedBlocks 9개', cfg.fixedBlocks.length === 9);
  const b월3 = cfg.fixedBlocks.find((b) => b.day === 0 && b.period === 3);
  check("mock 월3 고정블록 grades === 'all'", !!b월3 && b월3.grades === 'all');
  const b화7 = cfg.fixedBlocks.find((b) => b.day === 1 && b.period === 7);
  check('mock 화7 고정블록 grades === [7,8,9]', !!b화7 && eq(b화7.grades, [7, 8, 9]));
  check('mock teamTeaching 비어있지 않음', Object.keys(cfg.teamTeaching).length > 0);
  check('mock classless 비어있지 않음', Object.keys(cfg.classless).length > 0);

  // (3) 실제 mock 그리드에 기계적 apply
  const model = CORE.buildModel(store.sheets.revised.slice(2), 3);
  let entry = null, fromIdx = -1, toIdx = -1;
  for (let i = 0; i < model.entries.length; i++) {
    const e = model.entries[i];
    if (e.type !== 'teacher') continue;
    const f = e.slots.findIndex((s) => s);
    const t = e.slots.findIndex((s) => !s);
    if (f >= 0 && t >= 0) { entry = e; fromIdx = f; toIdx = t; break; }
  }
  check('교사 이동 대상(채워진 슬롯+빈 슬롯) 존재', !!entry);
  if (entry) {
    const subject = entry.slots[fromIdx];
    const move = [{ name: entry.name, row: entry.row, fromIdx, toIdx }];
    const cells = CORE.movesToCellWrites(model, move);
    const dEnd = lastDataRow(store.sheets.revised);
    const h0 = hashGrid(store.sheets.revised, 3, dEnd);
    applyCellsToGrid(store.sheets.revised, cells);
    check('apply 후 목적 슬롯에 과목 기록', store.sheets.revised[entry.row - 1][2 + toIdx] === subject);
    check("apply 후 원래 슬롯 비워짐", store.sheets.revised[entry.row - 1][2 + fromIdx] === '');
    check('apply 후 hashGrid 변경됨', hashGrid(store.sheets.revised, 3, dEnd) !== h0);
  }

  // (4) 탭 복제 딥카피 독립성
  resetMockStore();
  const s2 = getMockStore();
  const dupName = mockDuplicateTab(s2, 'revised');
  check("사본 이름 '3차(최종)'(기존 1차·2차 뒤 차수)", dupName === '3차(최종)');
  check('사본 탭 생성됨', !!s2.sheets[dupName]);
  check('사본 == revised 스냅샷',
    JSON.stringify(s2.sheets[dupName]) === JSON.stringify(s2.sheets.revised));
  s2.sheets[dupName][2][2] = '__X__';
  check('사본 수정이 revised 에 전이되지 않음(딥카피)', s2.sheets.revised[2][2] !== '__X__');

  // (5) 연속 복제: 차수가 오르고 '(최종)' 이 매번 마지막 탭으로 옮겨간다
  resetMockStore();
  const s3 = getMockStore();
  check('1회차 복제 → 3차(최종)', mockDuplicateTab(s3, 'revised') === '3차(최종)');
  check('2회차 복제 → 4차(최종)', mockDuplicateTab(s3, '1차') === '4차(최종)');
  check("2회차 후 3차 의 '(최종)' 떨어짐", !!s3.sheets['3차'] && !s3.sheets['3차(최종)']);
  check('3회차 복제 → 5차(최종)', mockDuplicateTab(s3, 'revised') === '5차(최종)');
  check("3회차 후 '(최종)' 은 5차 하나뿐",
    Object.keys(s3.sheets).filter(function (t) { return /\(최종\)$/.test(t); }).join() === '5차(최종)');
  check('무관 탭 revised 는 그대로 남음', !!s3.sheets.revised);
}

/* =========================================================
   6-2. 차수 탭 이름 규칙 (parseStageTab / nextStageNames)
   ========================================================= */
{
  check('parseStageTab 0차', eq(parseStageTab('0차'), { n: 0, final: false }));
  check('parseStageTab 12차(최종)', eq(parseStageTab('12차(최종)'), { n: 12, final: true }));
  check('parseStageTab revised → null', parseStageTab('revised') === null);
  check('parseStageTab 기초자료 → null', parseStageTab('기초자료') === null);
  check("parseStageTab '2차 최종본' → null(규칙 불일치)", parseStageTab('2차 최종본') === null);
  check("parseStageTab '3차 (최종)' → null(공백 있음)", parseStageTab('3차 (최종)') === null);

  const names = function (t) { return nextStageNames(t); };
  check('차수 탭 없음 → 1차(최종), 이름변경 없음',
    eq(names(['revised', '기초자료']), { newName: '1차(최종)', renames: [] }));
  check('0차만 → 1차(최종)', eq(names(['0차']), { newName: '1차(최종)', renames: [] }));
  check('0·1차 → 2차(최종)', eq(names(['revised', '0차', '1차']), { newName: '2차(최종)', renames: [] }));
  check("1차 복제인데 2차 존재 → 3차(최종)(원본 무관)",
    eq(names(['0차', '1차', '2차']), { newName: '3차(최종)', renames: [] }));
  check("'(최종)' 붙은 탭도 같은 차수로 인식 + 접미사 이동",
    eq(names(['1차', '2차(최종)']), { newName: '3차(최종)', renames: [{ from: '2차(최종)', to: '2차' }] }));
  check('무관 탭은 이름변경 대상에서 제외',
    eq(names(['revised', '2차 최종본', '1차(최종)']),
      { newName: '2차(최종)', renames: [{ from: '1차(최종)', to: '1차' }] }));
  check("충돌: '2차' 가 이미 있으면 '2차(최종)' 은 건드리지 않는다",
    eq(names(['2차', '2차(최종)']), { newName: '3차(최종)', renames: [] }));
  check('10차 이상도 사전순이 아닌 수치 비교', eq(names(['9차', '10차']).newName, '11차(최종)'));
}

/* =========================================================
   7. serializeConfig 왕복 일치 (parseConfig ∘ serializeConfig === identity)
   ========================================================= */
{
  const serializeConfig = CORE.serializeConfig;
  const cfg = {
    fixedBlocks: [
      { day: 0, period: 3, label: 'Counseling', grades: 'all', classes: [], partialGrades: [] },
      { day: 1, period: 7, label: 'S.A', grades: [7, 8, 9], classes: [], partialGrades: [] },
      { day: 2, period: 1, label: '반블록', grades: [], classes: ['7A'], partialGrades: [] }
    ],
    classless: { Cal12: ['12A', '12B', '12C'], JMA: [] },
    teamTeaching: { Cal12: ['교사04', '교사07'] },
    linkedGroups: { '제2외': ['Honors Japanese', 'Honors German'] },
    unavailable: [
      { name: '교사01', slots: [0, 10] },
      { name: '교사09', slots: [20], row: 35 }
    ]
  };
  const round = parseConfig(serializeConfig(cfg));
  delete round.missing; delete round.classlessNotes; delete round.rawExtras; delete round.pinnedManual; delete round.classlessUnset; delete round.regularSlots;
  check('serializeConfig 왕복 일치(parseConfig 역함수)', eq(round, cfg));

  // 교사불가 파싱: 행 유무 분기
  const unavVals = [
    ['[교사불가]'], ['교사명', '슬롯들'],
    ['교사01', '수5'],
    ['교사09(행35)', '월1, 화3']
  ];
  const pu = parseConfig(unavVals);
  check('교사불가 파싱 교사01(행 없음)', eq(pu.unavailable[0], { name: '교사01', slots: [20] }));
  check('교사불가 파싱 교사09(행35)', eq(pu.unavailable[1], { name: '교사09', slots: [0, 10], row: 35 }));

  // 7b. 콘텐츠 보존 강화: 무반 비고 + 블록 내 stray 행 + 블록 이전 주석 행.
  function normRow(row) {
    var r = (row || []).map(function (c) { return String(c == null ? '' : c); });
    while (r.length && r[r.length - 1] === '') r.pop();
    return JSON.stringify(r);
  }
  function hasContent(row) {
    return (row || []).some(function (c) { return String(c == null ? '' : c).trim() !== ''; });
  }
  function groupNonEmpty(values) {
    var out = {}, cur = '__outside__';
    (values || []).forEach(function (row) {
      var first = String((row && row[0]) != null ? row[0] : '').trim();
      if (/^\[.*\]$/.test(first)) { cur = first; return; }
      if (!hasContent(row)) return;
      (out[cur] = out[cur] || []).push(normRow(row));
    });
    return out;
  }
  function eqMultiset(a, b) {
    var ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (!eq(ka, kb)) return false;
    return ka.every(function (k) { return eq(a[k].slice().sort(), b[k].slice().sort()); });
  }

  const values = [
    ['※ 자동생성 주의'],                          // __outside__ 주석
    ['[고정블록]'],
    ['슬롯', '라벨', '적용학년'],
    ['월3', 'Counseling', '전체'],
    ['화7', 'S.A', '7,8,9'],
    ['월9', '수기 잘못된 슬롯'],                    // 고정블록 stray(슬롯 파싱 실패)
    [''],
    ['[무반과목]'],
    ['과목명', '대상학급', '비고'],
    ['Cal12', '12전체', '수기 비고'],              // 무반 비고 보존 대상
    ['JMA', '', ''],
    ['', '무반 수기 코멘트'],                       // 무반 stray(첫 셀 빈)
    [''],
    ['[팀티칭]'],
    ['과목명', '교사들'],
    ['Cal12', '교사04, 교사07'],
    [''],
    ['[연결그룹]'],
    ['그룹명', '과목들'],
    ['제2외', 'Honors Japanese, Honors German'],
    [''],
    ['[교사불가]'],
    ['교사명', '슬롯들'],
    [''],
    ['[고정수업]'],
    ['과목명', '교시들'],
    ['수학보충8', '수7'],
    [''],
    ['[정규교시]'],
    ['학년', '요일', '교시']
  ];

  const p1 = parseConfig(values);
  check('무반 비고 보존 classlessNotes.Cal12', p1.classlessNotes.Cal12 === '수기 비고');
  check('무반 비고 없는 항목 제외(JMA)', p1.classlessNotes.JMA === undefined);
  check('rawExtras __outside__ 보존', p1.rawExtras['__outside__'] && p1.rawExtras['__outside__'].length === 1);
  check('rawExtras 고정블록 stray 보존', p1.rawExtras['[고정블록]'] && p1.rawExtras['[고정블록]'].length === 1);
  check('rawExtras 무반 stray 보존', p1.rawExtras['[무반과목]'] && p1.rawExtras['[무반과목]'].length === 1);

  const p2 = parseConfig(serializeConfig(p1));
  check('parse→serialize→parse 콘텐츠 안정', eq(p2, p1));

  const g1 = groupNonEmpty(values);
  const g2 = groupNonEmpty(serializeConfig(p1));
  check('serialize(parse(values)) 블록별 비-빈 행 멀티셋 일치', eqMultiset(g1, g2));
}

/* =========================================================
   7c. 학년 일부(partial-grade) — 파싱/왕복 + 일부↔정규/일부↔일부 이동
   (충돌 판별 필드: checkMovesDelta().blocks[i].type === 'class' — findConflicts가
    학급중복(정규 dup + 일부↔정규)에 type:'class', severity:'block'을 부여, 고정블록은 type:'fixed')
   ========================================================= */
{
  var vP = [
    ['[고정블록]'], ['슬롯', '라벨', '적용학년'],
    ['월1', '부분금지', '12일부, 11'],
    [''],
    ['[무반과목]'], ['과목명', '대상학급', '비고'],
    ['Elec12X', '12일부', ''],
    [''],
  ];
  var cP = parseConfig(vP);
  check('parseFixedBlocks partialGrades=[12]', cP.fixedBlocks[0].partialGrades.length === 1 && cP.fixedBlocks[0].partialGrades[0] === 12);
  check('parseFixedBlocks grades=[11]', cP.fixedBlocks[0].grades[0] === 11);
  check('classless 12일부 토큰 보존', cP.classless['Elec12X'][0] === '12일부');
  check('serializeConfig 왕복(partialGrades 포함)', eq(parseConfig(CORE.serializeConfig(cP)), cP));

  var cfgPart = { classless: { 'Elec12X': ['12일부'], 'Elec12Y': ['12일부'] }, fixedBlocks: [], teamTeaching: {}, linkedGroups: {} };
  var mReg = CORE.buildModel([
    ['교사A', '', ...Array.from({ length: 40 }, (_, i) => i === 0 ? 'Elec12X' : '')],
    ['교사B', '', ...Array.from({ length: 40 }, (_, i) => i === 1 ? 'Kor12A' : '')],
  ], 3);
  var dReg = CORE.checkMovesDelta(mReg, cfgPart, [{ name: '교사A', row: 3, fromIdx: 0, toIdx: 1 }]);
  check('일부↔정규 같은 슬롯 이동 차단', dReg.blocks.some(function (c) { return c.type === 'class'; }));
  var mPP = CORE.buildModel([
    ['교사A', '', ...Array.from({ length: 40 }, (_, i) => i === 0 ? 'Elec12X' : '')],
    ['교사B', '', ...Array.from({ length: 40 }, (_, i) => i === 1 ? 'Elec12Y' : '')],
  ], 3);
  var dPP = CORE.checkMovesDelta(mPP, cfgPart, [{ name: '교사A', row: 3, fromIdx: 0, toIdx: 1 }]);
  check('일부↔일부 같은 슬롯 이동 허용', !dPP.blocks.some(function (c) { return c.type === 'class'; }));
}

/* =========================================================
   8. 멀티탭 mock 스토어 (revised/1차/2차)
   ========================================================= */
{
  resetMockStore();
  const store = getMockStore();
  const tabs = ['revised', '1차', '2차'];
  check('mock 3개 탭 존재', tabs.every((t) => !!store.sheets[t]));
  check('mock 각 탭 83x42',
    tabs.every((t) => store.sheets[t].length === 83 && store.sheets[t].every((r) => r.length === 42)));
  check('mockListTabs 3개 이상 & isTimetable/dataStart',
    mockListTabs(store).length >= 3 && mockListTabs(store).every((m) => m.isTimetable && m.dataStart === 3));
}

/* =========================================================
   9. mockSaveConfig 왕복 (serializeConfig → store.config → parseConfig)
   ========================================================= */
{
  resetMockStore();
  const store = getMockStore();
  const cfg = { fixedBlocks: [{ day: 0, period: 3, label: 'X', grades: 'all', classes: [] }], classless: {}, teamTeaching: {}, linkedGroups: {} };
  mockSaveConfig(store, CORE.serializeConfig(cfg));
  const parsed = parseConfig(store.config);
  check('mockSaveConfig 왕복 → fixedBlocks 1개', parsed.fixedBlocks.length === 1);
  check("mockSaveConfig 왕복 → grades 'all'", parsed.fixedBlocks[0].grades === 'all');
}

/* =========================================================
   10. 연결그룹 확장 이동 (순수 코어) — 그룹 상호 학급중복 예외로 block 없음
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  const rows = [dataRow('A', { 0: 'KorA7A' }), dataRow('B', { 0: 'KorB7A' })];
  const model = CORE.buildModel(rows, 3);
  const config = { fixedBlocks: [], classless: {}, teamTeaching: {}, linkedGroups: { '분반7A': ['KorA7A', 'KorB7A'] } };
  const expanded = CORE.expandUnit(model, config, { name: 'A', row: 3, fromIdx: 0, toIdx: 1 });
  check('연결그룹 확장 → 2건 이동', expanded.length === 2);
  const delta = CORE.checkMovesDelta(model, config, expanded);
  check('연결그룹 상호 학급중복 예외 → block 없음', delta.blocks.length === 0);
}

/* =========================================================
   11. 반 단위 고정블록 위반 → block (409 트리거 조건)
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  const rows = [dataRow('A', { 0: 'Kor7A' })];
  const model = CORE.buildModel(rows, 3);
  const config = { fixedBlocks: [{ day: 0, period: 2, label: '금지', grades: [], classes: ['7A'] }], classless: {}, teamTeaching: {}, linkedGroups: {} };
  const delta = CORE.checkMovesDelta(model, config, [{ name: 'A', row: 3, fromIdx: 0, toIdx: 1 }]);
  check('반단위 고정블록 슬롯 진입 → block 발생(409)', delta.blocks.length > 0);
}

/* =========================================================
   12. hashValues 결정성 + 민감도
   ========================================================= */
{
  const v = [['[고정블록]'], ['슬롯', '라벨', '적용학년'], ['월3', 'X', '전체']];
  const v2 = [['[고정블록]'], ['슬롯', '라벨', '적용학년'], ['월3', 'X', '전체']];
  const v3 = [['[고정블록]'], ['슬롯', '라벨', '적용학년'], ['월3', 'Y', '전체']];
  check('hashValues 동일 입력 → 동일 해시', hashValues(v) === hashValues(v2));
  check('hashValues 셀 변경 → 다른 해시', hashValues(v) !== hashValues(v3));
  check('hashValues 빈 배열 결정적', hashValues([]) === hashValues([]));
}

/* =========================================================
   13. incompleteUnits — 연결그룹 단위 이동 온전성
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  const rows = [dataRow('A', { 0: 'KorA7A' }), dataRow('B', { 0: 'KorB7A' })];
  const model = CORE.buildModel(rows, 3);
  const config = { fixedBlocks: [], classless: {}, teamTeaching: {}, linkedGroups: { '분반7A': ['KorA7A', 'KorB7A'] } };
  const full = CORE.expandUnit(model, config, { name: 'A', row: 3, fromIdx: 0, toIdx: 1 });
  check('전체 확장 단위 → incompleteUnits 빈 배열', eq(incompleteUnits(model, config, full, CORE.expandUnit), []));
  const partial = full.slice(0, 1); // 1건만(부분 단위)
  check('부분 단위(1건 누락) → incompleteUnits 비어있지 않음',
    incompleteUnits(model, config, partial, CORE.expandUnit).length > 0);
}

/* =========================================================
   14. parseLinkedGroups — '연결그룹' 탭 파싱(그룹핑 + 그룹 내 중복 제거)
   ========================================================= */
{
  const rows = [
    ['과목명', '교사명', '시간표 표기명', '그룹'],
    ['Honors Chinese', '교사35', 'Honors Chinese', 'Elective_A'],
    ['Statistics', '교사09', 'Statistics', 'Elective_A'],
    ['STEAM R&E', '교사19', 'STEAM R&E', 'Elective_C'],
    ['STEAM R&E', '교사30', 'STEAM R&E', 'Elective_C'], // 팀티칭 중복 → 1개로
    ['Training', '교사25', 'Training', 'Elective_C'],
    ['Training', '교사24', 'Training', 'Elective_D'],   // 다른 그룹 동일 표기명 → 별개 유지
    ['PreCal11A', '수학1', 'PreCal11A', 'PreCal+APCalAB'],
    ['', '', '', 'EmptyGroup']                          // 표기명 없음 → skip
  ];
  const lg = parseLinkedGroups(rows);
  check('parseLinkedGroups Elective_A 그룹핑', eq(lg.groups['Elective_A'], ['Honors Chinese', 'Statistics']));
  check('parseLinkedGroups 그룹 내 중복 제거(STEAM R&E 1개)', eq(lg.groups['Elective_C'], ['STEAM R&E', 'Training']));
  check('parseLinkedGroups 다른 그룹의 동일 표기명 유지(Training in D)', eq(lg.groups['Elective_D'], ['Training']));
  check('parseLinkedGroups 표기명 없는 행 무시', lg.groups['EmptyGroup'] === undefined);
  check('parseLinkedGroups 헤더행 skip', lg.groups['그룹'] === undefined);
  check('parseLinkedGroups 구schema pinned 없음', eq(lg.pinned, {}));
  check('parseLinkedGroups 구schema warnings 없음', eq(lg.warnings, []));
}

/* =========================================================
   14b. parseLinkedGroups — 신schema(고정수업시간) + 경고
   ========================================================= */
{
  const rows = [
    ['학년','과목명','교사명','시간표 표기명','고정수업시간','그룹'],
    ['', 'Statistics', '교사09', 'Statistics', '월5, 월6, 수5, 수6', 'Elective_A'],
    ['', 'Honors Chinese', '교사35', 'Honors Chinese', '', 'Elective_A'],
    ['', 'Sports Health', '교사26', 'Sports Health', '월5, 수5', 'Elective_B2'],
    ['', 'AP World History', '교사16', 'AP World History', '화7, 확8, 목7, 목8', 'Elective_D'],
    ['', 'Training', '교사25', 'Training', '월7, 월8, 수7, 수8', 'Elective_C'],
    ['', 'Training', '교사24', 'Training', '화7, 확8, 목7, 목8', 'Elective_D'],
  ];
  const lg = parseLinkedGroups(rows);
  check('parseLinkedGroups 신schema groups', eq(lg.groups['Elective_A'], ['Statistics','Honors Chinese']));
  check('parseLinkedGroups pinned Statistics=[4,5,20,21]', eq(lg.pinned['Statistics'], [4,5,20,21]));
  check('parseLinkedGroups pinned 월5,수5=[4,20]', eq(lg.pinned['Sports Health'], [4,20]));
  check('parseLinkedGroups 빈 고정수업시간 → pinned 없음', lg.pinned['Honors Chinese'] === undefined);
  check("parseLinkedGroups '확8' 인식불가 → warnings 포함", lg.warnings.indexOf('확8') !== -1);
  check("parseLinkedGroups '확8' 인식불가 → 해당 idx 미포함(화7,목7,목8만)", eq(lg.pinned['AP World History'], [14,30,31]));
  check('parseLinkedGroups 동일 표기명 union(Training C+D)', eq(lg.pinned['Training'], [6,7,14,22,23,30,31]));
  check('parseLinkedGroups warnings 중복 제거', lg.warnings.filter(function(w){return w==='확8';}).length === 1);
}

/* =========================================================
   14c. parseLinkedGroups — 학년 열 파싱(grades)
   ========================================================= */
{
  const rows = [
    ['학년','과목명','교사명','시간표 표기명','고정수업시간','그룹'],
    ['11,12', 'AP Statistics', '교사09', 'AP Statistics', '', 'Elective_A'],
    ['10,11', 'Statistics', '교사09', 'Statistics', '', 'Elective_B'],
    ['12.0', 'Honors Chinese', '교사35', 'Honors Chinese', '', 'Elective_A'],
    ['', 'Sports Health', '교사26', 'Sports Health', '', 'Elective_B2'],
    ['abc', 'Garbage Subject', '교사16', 'Garbage Subject', '', 'Elective_D'],
  ];
  const lg = parseLinkedGroups(rows);
  check('parseLinkedGroups grades AP Statistics=[11,12]', eq(lg.grades['AP Statistics'], [11,12]));
  check('parseLinkedGroups grades Statistics=[10,11]', eq(lg.grades['Statistics'], [10,11]));
  check("parseLinkedGroups grades 숫자형식 '12.0'→[12]", eq(lg.grades['Honors Chinese'], [12]));
  check('parseLinkedGroups grades 빈 학년 → 미포함', lg.grades['Sports Health'] === undefined);
  check('parseLinkedGroups grades 쓰레기 학년 → 미포함', lg.grades['Garbage Subject'] === undefined);
}

/* =========================================================
   14d. deriveClasslessFromGrades — 수동 우선 파생
   ========================================================= */
{
  const config = { classless: { 'Manual': ['12전체'] } };
  const grades = { 'Manual': [10,11], 'Derived': [11,12], 'NoGrade': [] };
  deriveClasslessFromGrades(config, grades);
  check('deriveClasslessFromGrades Manual 유지(수동 우선)', eq(config.classless['Manual'], ['12전체']));
  check('deriveClasslessFromGrades Derived=[11일부,12일부]', eq(config.classless['Derived'], ['11일부','12일부']));
  check('deriveClasslessFromGrades classlessDerived.Derived===true', config.classlessDerived['Derived'] === true);
  check('deriveClasslessFromGrades Manual 파생표시 없음', config.classlessDerived['Manual'] === undefined);
  check('deriveClasslessFromGrades NoGrade 미추가',
    Object.prototype.hasOwnProperty.call(config.classless, 'NoGrade') === false);
}

// ---- deptBoundaries: 실측 이름 시퀀스 + 중복이름(교사09) 오매핑 방어 ----
(function () {
  var depts = {
    names: {
      '교사01': '국어', '교사02': '국어', '교사03': '국어',
      '교사04': '수학', '교사06': '수학', '교사07': '수학', 'Teacher08': '수학', 'Teacher43': '수학',
      'Teacher10': '영어', '교사11': '영어', 'Teacher12': '영어', 'Teacher13': '영어', 'Teacher14': '영어', 'English1': '영어',
      '교사16': '사회', '교사17': '사회', 'Teacher18': '사회', '교사19': '사회',
      '교사20': '과학', '교사22': '과학', 'Teacher23': '과학',
      '교사24': '태권도', '교사25': '태권도', '교사26': '태권도', '교사27': '태권도',
      '교사28': '예술', '교사29': '예술', '교사30': '예술',
      '교사31': '정보', '교사09': '정보', '교사32': '정보',
      '교사33': '제2외국어', '교사34': '제2외국어', '교사35': '제2외국어', 'Teacher36': '제2외국어', '교사37': '제2외국어',
      '교사38': '성경', '교사39': '성경', '교사40': '성경', '교사44': '제2외국어'
    },
    order: ['국어', '수학', '영어', '사회', '과학', '태권도', '예술', '정보', '제2외국어', '성경']
  };
  var seq = [
    [3, '교사01'], [4, '교사02'], [5, '교사03'], [6, '교사04'], [7, '교사05'], [8, '교사06'],
    [9, '교사07'], [10, 'Teacher08'], [11, '교사09'], [12, 'Teacher10'], [13, '교사11'], [14, 'Teacher12'],
    [15, 'Teacher13'], [16, 'Teacher14'], [17, 'Teacher15'], [18, '교사16'], [19, '교사17'], [20, 'Teacher18'],
    [21, '교사19'], [22, '교사20'], [23, 'Teacher21'], [24, '교사22'], [25, 'Teacher23'], [26, '교사24'],
    [27, '교사25'], [28, '교사26'], [29, '교사27'], [30, '교사28'], [31, '교사29'], [32, '교사30'],
    [33, '교사31'], [34, '교사32'], [35, '교사09'], [36, '교사33'], [37, '교사34'], [38, '교사35'],
    [39, 'Teacher36'], [40, '교사37'], [41, '교사38'], [42, '교사39'], [43, '교사40'], [44, '교사41'], [45, '교사42']
  ];
  var entries = seq.map(function (p) { return { name: p[1], row: p[0], type: 'teacher' }; });
  entries.push({ name: 'RA1', row: 46, type: 'raSlot' });
  var got = deptBoundaries(entries, depts);
  var expected = [6, 12, 18, 22, 26, 30, 33, 36, 41, 46];
  check('deptBoundaries 실측 시퀀스 경계행 = [6,12,18,22,26,30,33,36,41,46] (got ' + JSON.stringify(got) + ')',
    JSON.stringify(got) === JSON.stringify(expected));
  check('deptBoundaries: 교사09(11행) 오매핑 무시 — 경계선 없음', got.indexOf(11) === -1);
  check('deptBoundaries: Teacher10(12행, 영어) 경계선 존재', got.indexOf(12) !== -1);
  check('deptBoundaries: depts=null → []', JSON.stringify(deptBoundaries(entries, null)) === '[]');
  var pd = parseDepts([
    ['교사명', '교과', '주임여부', '', '배치순서'],
    ['교사01', '국어', '주임', '', '국어'],
    ['교사04', '수학', '주임', '', '수학'],
    ['', '', '', '', '영어']
  ]);
  check('parseDepts: names 매핑', pd && pd.names['교사01'] === '국어' && pd.names['교사04'] === '수학');
  check('parseDepts: order 순서', pd && JSON.stringify(pd.order) === JSON.stringify(['국어', '수학', '영어']));
  check('parseDepts: heads(주임) 수집', pd && JSON.stringify(pd.heads) === JSON.stringify(['교사01', '교사04']));
})();

/* =========================================================
   15. 학년별 시간 매트릭스 매핑 (gradeSlotState / toggleGradeSlot)
   ========================================================= */
{
  // CHAPEL 전체(all) 규칙: 전 학년 불가
  const allBlocks = [{ day: 2, period: 3, label: 'CHAPEL', grades: 'all', classes: [] }];
  check("gradeSlotState all → 7학년 불가", gradeSlotState(allBlocks, 2, 3, 7) === '불가');
  check("gradeSlotState all → 12학년 불가", gradeSlotState(allBlocks, 2, 3, 12) === '불가');
  check("gradeSlotState 규칙 없는 슬롯 → 가능", gradeSlotState(allBlocks, 0, 1, 7) === '가능');

  // 배열 grades
  const arrBlocks = [{ day: 1, period: 7, label: '', grades: [7, 8, 9], classes: [] }];
  check("gradeSlotState [7,8,9] → 8학년 불가", gradeSlotState(arrBlocks, 1, 7, 8) === '불가');
  check("gradeSlotState [7,8,9] → 10학년 가능", gradeSlotState(arrBlocks, 1, 7, 10) === '가능');

  // 반 단위만 → 일부
  const partBlocks = [{ day: 0, period: 2, label: '', grades: [], classes: ['7A'] }];
  check("gradeSlotState 반단위만 7 → 일부", gradeSlotState(partBlocks, 0, 2, 7) === '일부');
  check("gradeSlotState 반단위 8 무관 → 가능", gradeSlotState(partBlocks, 0, 2, 8) === '가능');

  // 다중 규칙(비정상) → 첫 규칙 기준, 크래시 없음
  const dupBlocks = [
    { day: 3, period: 5, label: '', grades: [7], classes: [] },
    { day: 3, period: 5, label: '', grades: [8], classes: [] }
  ];
  check("gradeSlotState 다중규칙 첫 규칙 기준(7 불가)", gradeSlotState(dupBlocks, 3, 5, 7) === '불가');
  check("gradeSlotState 다중규칙 첫 규칙 기준(8 가능)", gradeSlotState(dupBlocks, 3, 5, 8) === '가능');

  // toggle: 신규 생성 (가능→불가, 규칙 없음)
  const t1 = [];
  toggleGradeSlot(t1, 0, 5, 7);
  check("toggle 신규 생성", t1.length === 1 && t1[0].day === 0 && t1[0].period === 5 && eq(t1[0].grades, [7]) && t1[0].label === '' && eq(t1[0].classes, []));

  // toggle: 기존 규칙에 학년 추가
  const t2 = [{ day: 0, period: 5, label: '', grades: [7], classes: [] }];
  toggleGradeSlot(t2, 0, 5, 9);
  check("toggle 기존 규칙에 추가", t2.length === 1 && eq(t2[0].grades, [7, 9]));

  // toggle: all 전개 후 한 학년 제거 → 나머지 5학년 유지 + 라벨 규칙 보존
  const t3 = [{ day: 2, period: 3, label: 'CHAPEL', grades: 'all', classes: [] }];
  toggleGradeSlot(t3, 2, 3, 7);
  check("toggle all 전개 후 7 제거 → [8,9,10,11,12]", eq(t3[0].grades, [8, 9, 10, 11, 12]));
  check("toggle all 전개 후 규칙·라벨 유지", t3.length === 1 && t3[0].label === 'CHAPEL');

  // toggle: 불가→가능, 규칙이 완전히 비면 삭제
  const t4 = [{ day: 0, period: 5, label: '', grades: [7], classes: [] }];
  toggleGradeSlot(t4, 0, 5, 7);
  check("toggle 마지막 학년 제거 → 규칙 삭제", t4.length === 0);

  // toggle: 라벨/반 있는 규칙은 학년만 비어도 유지
  const t5 = [{ day: 0, period: 5, label: 'X', grades: [7], classes: ['8A'] }];
  toggleGradeSlot(t5, 0, 5, 7);
  check("toggle 라벨·반 있는 규칙은 유지", t5.length === 1 && eq(t5[0].grades, []) && t5[0].label === 'X' && eq(t5[0].classes, ['8A']));

  // toggle: 일부→승격(학년 추가, 반 유지)
  const t6 = [{ day: 0, period: 2, label: '', grades: [], classes: ['7A'] }];
  toggleGradeSlot(t6, 0, 2, 7);
  check("toggle 일부→불가 승격", eq(t6[0].grades, [7]) && eq(t6[0].classes, ['7A']));
  check("toggle 승격 후 상태 불가", gradeSlotState(t6, 0, 2, 7) === '불가');
}

/* =========================================================
   15b. 학년별 공강 현황 (gradeFreeState, 조회 전용)
   ========================================================= */
{
  function gfEntry(subj, day, period) {
    var slots = Array(40).fill('');
    slots[day * 8 + (period - 1)] = subj;
    return { name: 'T', room: '', type: 'teacher', row: 3, slots: slots };
  }
  function gfModel(entries) { return { entries: entries }; }

  // CASE 전체: 빈 모델 → 세 반 모두 공강
  var rAll = gradeFreeState(gfModel([]), {}, 10, { day: 0, period: 1 });
  check("gradeFree 전체 → label 전체/kind all", rAll.label === '전체' && rAll.kind === 'all');

  // CASE 반 나열: Alge10A 하나 → 10A busy, 나머지 free
  var rSome = gradeFreeState(gfModel([gfEntry('Alge10A', 0, 1)]), {}, 10, { day: 0, period: 1 });
  check("gradeFree 반나열 → '10B, 10C'/some", rSome.label === '10B, 10C' && rSome.kind === 'some');
  check("gradeFree 반나열 → 10A busy", rSome.classes['10A'] === 'busy');

  // CASE 일부: '12일부' 매핑 과목만 존재
  var rPart = gradeFreeState(gfModel([gfEntry('AP Statistics', 0, 5)]),
    { classless: { 'AP Statistics': ['12일부'] } }, 12, { day: 0, period: 5 });
  check("gradeFree 일부 → label 일부/kind partial", rPart.label === '일부' && rPart.kind === 'partial');

  // CASE G전체: '12전체' → 세 반 모두 busy
  var rBusy = gradeFreeState(gfModel([gfEntry('Cal12', 0, 1)]),
    { classless: { 'Cal12': ['12전체'] } }, 12, { day: 0, period: 1 });
  check("gradeFree G전체 → kind none/label ''", rBusy.kind === 'none' && rBusy.label === '');
  check("gradeFree G전체 → 세 반 busy",
    rBusy.classes['12A'] === 'busy' && rBusy.classes['12B'] === 'busy' && rBusy.classes['12C'] === 'busy');

  // CASE 반 토큰 매핑: '무반X' → ['10A','10B']
  var rTok = gradeFreeState(gfModel([gfEntry('무반X', 0, 1)]),
    { classless: { '무반X': ['10A', '10B'] } }, 10, { day: 0, period: 1 });
  check("gradeFree 반토큰 → 10A&10B busy",
    rTok.busyClasses.indexOf('10A') !== -1 && rTok.busyClasses.indexOf('10B') !== -1);
  check("gradeFree 반토큰 → free 10C/label 10C/some",
    eq(rTok.freeClasses, ['10C']) && rTok.label === '10C' && rTok.kind === 'some');

  // CASE NA(대상없음): 빈 매핑 [] → 기여 없음
  var rNA = gradeFreeState(gfModel([gfEntry('JMA', 0, 1)]),
    { classless: { 'JMA': [] } }, 12, { day: 0, period: 1 });
  check("gradeFree 대상없음 → 전체 공강", rNA.label === '전체' && rNA.kind === 'all');

  // CASE 미분류: classless에 없는 과목 → 무시
  var rUn = gradeFreeState(gfModel([gfEntry('Unknown', 0, 1)]),
    { classless: {} }, 10, { day: 0, period: 1 });
  check("gradeFree 미분류 → 전체 공강", rUn.label === '전체' && rUn.kind === 'all');

  // CASE partial + one busy: 12A 수업 + '12일부' → 12A busy, 12B/12C partial, free 없음
  var rMix = gradeFreeState(gfModel([gfEntry('Kor12A', 0, 5), gfEntry('AP Statistics', 0, 5)]),
    { classless: { 'AP Statistics': ['12일부'] } }, 12, { day: 0, period: 5 });
  check("gradeFree partial+busy → 12A busy",
    rMix.classes['12A'] === 'busy' && rMix.busyClasses.indexOf('12A') !== -1);
  check("gradeFree partial+busy → 12B/12C partial",
    rMix.classes['12B'] === 'partial' && rMix.classes['12C'] === 'partial');
  check("gradeFree partial+busy → free 없음/label 일부/partial",
    rMix.freeClasses.length === 0 && rMix.label === '일부' && rMix.kind === 'partial');

  // fixedBlocks 학년 전체 금지: 월3 Counseling(grades:'all') → blocked+라벨 (10·12학년), 타 슬롯 무영향
  var cfgCoun = { fixedBlocks: [{ day: 0, period: 3, label: 'Counseling', grades: 'all', classes: [], partialGrades: [] }] };
  var rB10 = gradeFreeState(gfModel([]), cfgCoun, 10, { day: 0, period: 3 });
  check("gradeFree 전체금지 → 10학년 blocked+라벨", rB10.kind === 'blocked' && rB10.label === 'Counseling' && rB10.freeClasses.length === 0);
  var rB12 = gradeFreeState(gfModel([]), cfgCoun, 12, { day: 0, period: 3 });
  check("gradeFree 전체금지 → 12학년 blocked+라벨", rB12.kind === 'blocked' && rB12.label === 'Counseling');
  var rBoff = gradeFreeState(gfModel([]), cfgCoun, 10, { day: 0, period: 1 });
  check("gradeFree 전체금지 → 타 슬롯 무영향(전체 공강)", rBoff.kind === 'all');

  // fixedBlocks 학년 지정 금지: grades:[7,8,9] → 7학년 blocked, 10학년 정상
  var cfgSA = { fixedBlocks: [{ day: 1, period: 6, label: 'S.A', grades: [7, 8, 9], classes: [], partialGrades: [] }] };
  var rSA7 = gradeFreeState(gfModel([]), cfgSA, 7, { day: 1, period: 6 });
  check("gradeFree 학년지정금지 → 7학년 blocked", rSA7.kind === 'blocked' && rSA7.label === 'S.A');
  var rSA10 = gradeFreeState(gfModel([]), cfgSA, 10, { day: 1, period: 6 });
  check("gradeFree 학년지정금지 → 미포함 학년 정상(전체)", rSA10.kind === 'all');

  // 7·8교시도 다른 교시와 동일 취급: 금지 규칙이 그대로 적용된다
  var cfgAfter = { fixedBlocks: [{ day: 1, period: 7, label: 'S.A', grades: [7, 8, 9], classes: [], partialGrades: [] }] };
  var rAfter7 = gradeFreeState(gfModel([]), cfgAfter, 7, { day: 1, period: 7 });
  check("gradeFree 7교시 → 금지 규칙 적용(blocked)", rAfter7.kind === 'blocked' && rAfter7.label === 'S.A');
  var rAfter6 = gradeFreeState(gfModel([]), cfgAfter, 7, { day: 1, period: 6 });
  check("gradeFree 6교시 → 기존 판정 정상(전체 공강)", rAfter6.kind === 'all' && rAfter6.label === '전체');

  // fixedBlocks 반 단위 금지: classes:['10A'] → 10A 제외, free 10B/10C
  var cfgCls = { fixedBlocks: [{ day: 2, period: 1, label: '', grades: [], classes: ['10A'], partialGrades: [] }] };
  var rCls = gradeFreeState(gfModel([]), cfgCls, 10, { day: 2, period: 1 });
  check("gradeFree 반금지 → 10A blocked 제외", rCls.classes['10A'] === 'blocked' && rCls.freeClasses.indexOf('10A') === -1);
  check("gradeFree 반금지 → free 10B,10C/some", eq(rCls.freeClasses, ['10B', '10C']) && rCls.kind === 'some' && rCls.label === '10B, 10C');
  var rCls7 = gradeFreeState(gfModel([]), cfgCls, 7, { day: 2, period: 1 });
  check("gradeFree 반금지 → 타 학년 무영향(전체)", rCls7.kind === 'all');

  // fixedBlocks partialGrades(정규만 금지)는 공강 판정 무영향
  var cfgPG = { fixedBlocks: [{ day: 0, period: 5, label: 'x', grades: [], classes: [], partialGrades: [12] }], classless: { 'AP Statistics': ['12일부'] } };
  var rPG = gradeFreeState(gfModel([gfEntry('AP Statistics', 0, 5)]), cfgPG, 12, { day: 0, period: 5 });
  check("gradeFree partialGrades 무영향 → 여전히 일부/partial", rPG.kind === 'partial' && rPG.label === '일부');
  var rPGempty = gradeFreeState(gfModel([]), cfgPG, 12, { day: 0, period: 5 });
  check("gradeFree partialGrades 무영향 → 규칙만으론 전체 공강", rPGempty.kind === 'all');
}

/* =========================================================
   15c. 공강 현황 매트릭스의 과목 표시 (subjectGradeTargets / gradeSubjectIndex)
   ========================================================= */
{
  function sEntry(slotMap) {
    var slots = Array(40).fill('');
    Object.keys(slotMap).forEach(function (k) { slots[parseInt(k, 10)] = slotMap[k]; });
    return { name: 'T', room: '', type: 'teacher', row: 3, slots: slots };
  }
  function sModel(entries) { return { entries: entries }; }

  // --- subjectGradeTargets: 학년 매칭 ---
  check('subjTargets 과목명 파싱 → 해당 학년 반',
    eq(subjectGradeTargets('PEng7A', 7, {}), { classes: ['7A'], partial: false }));
  check('subjTargets 다른 학년 → null', subjectGradeTargets('PEng7A', 10, {}) === null);
  check('subjTargets 10 vs 1 오인 없음(Eng10B 는 10학년)',
    eq(subjectGradeTargets('Eng10B', 10, {}), { classes: ['10B'], partial: false }));
  check('subjTargets 파싱되면 무반 매핑 무시',
    eq(subjectGradeTargets('Eng10B', 10, { 'Eng10B': ['12전체'] }), { classes: ['10B'], partial: false }));
  check('subjTargets 무반 G전체 → 세 반',
    eq(subjectGradeTargets('CHAPEL', 9, { 'CHAPEL': ['9전체'] }), { classes: ['9A', '9B', '9C'], partial: false }));
  check('subjTargets 무반 반토큰 → 해당 반만',
    eq(subjectGradeTargets('무반X', 10, { '무반X': ['10A', '10C', '11B'] }), { classes: ['10A', '10C'], partial: false }));
  check('subjTargets 무반 G일부 → partial',
    eq(subjectGradeTargets('AP Statistics', 12, { 'AP Statistics': ['12일부'] }), { classes: [], partial: true }));
  check('subjTargets 대상없음([]) → null', subjectGradeTargets('JMA', 12, { 'JMA': [] }) === null);
  check('subjTargets 미분류(매핑없음) → null', subjectGradeTargets('Unknown', 10, {}) === null);
  check('subjTargets RA 값은 수업 아님', subjectGradeTargets('RA11B', 11, {}) === null);
  check('subjTargets 빈 값 → null', subjectGradeTargets('', 10, {}) === null && subjectGradeTargets(null, 10, {}) === null);

  // --- gradeSubjectIndex: 슬롯별 수집 ---
  // 월1(idx 0)에 7학년 세 과목 + 다른 학년 과목 1개
  var mIdx = gradeSubjectIndex(sModel([
    sEntry({ 0: 'PEng7A' }), sEntry({ 0: 'TKD7B' }), sEntry({ 0: 'Eng7C' }), sEntry({ 0: 'Alge10A' }),
  ]), {}, 7);
  check('subjIndex 월1 7학년 → 세 과목만', eq(mIdx[0], ['PEng7A', 'TKD7B', 'Eng7C']));
  check('subjIndex 길이 40 · 빈 슬롯은 빈 배열', mIdx.length === 40 && eq(mIdx[1], []));
  var mIdx10 = gradeSubjectIndex(sModel([
    sEntry({ 0: 'PEng7A' }), sEntry({ 0: 'Alge10A' }),
  ]), {}, 10);
  check('subjIndex 학년 전환 → 그 학년 과목만', eq(mIdx10[0], ['Alge10A']));

  // 팀티칭: 같은 과목이 두 교사에게 → 중복 제거
  var mTeam = gradeSubjectIndex(sModel([
    sEntry({ 5: 'PreCal11A' }), sEntry({ 5: 'PreCal11A' }), sEntry({ 5: 'Kor11B' }),
  ]), {}, 11);
  check('subjIndex 팀티칭 중복 제거', eq(mTeam[5], ['PreCal11A', 'Kor11B']));

  // 무반 과목: classless 매핑을 통해 학년 판정 (공강 판정과 같은 규칙)
  var clsCfg = { classless: { 'CHAPEL': ['9전체'], 'AP Statistics': ['12일부'], 'JMA': [] } };
  var mCls = gradeSubjectIndex(sModel([sEntry({ 18: 'CHAPEL', 19: 'AP Statistics', 20: 'JMA' })]), clsCfg, 9);
  check('subjIndex 무반 G전체 포함', eq(mCls[18], ['CHAPEL']));
  check('subjIndex 무반 대상없음 제외', eq(mCls[20], []));
  var mCls12 = gradeSubjectIndex(sModel([sEntry({ 18: 'CHAPEL', 19: 'AP Statistics' })]), clsCfg, 12);
  check('subjIndex G일부 매핑도 표시 대상', eq(mCls12[19], ['AP Statistics']));
  check('subjIndex 타 학년 무반 과목 제외', eq(mCls12[18], []));

  // RA 감독 값은 수업이 아니다 → 목록에서 제외(공강 셀에 RA 가 과목처럼 보이면 안 됨)
  var mRa = gradeSubjectIndex(sModel([sEntry({ 0: 'RA11B' }), sEntry({ 0: 'RA' }), sEntry({ 0: 'Kor11A' })]), {}, 11);
  check('subjIndex RA 값 제외', eq(mRa[0], ['Kor11A']));

  // 인덱스 결과와 gradeFreeState 의 cover 가 어긋나지 않는다(같은 판정 로직 재사용)
  var coverModel = sModel([sEntry({ 0: 'Eng10A' }), sEntry({ 0: 'Eng10B' })]);
  var coverIdx = gradeSubjectIndex(coverModel, {}, 10);
  var coverGf = gradeFreeState(coverModel, {}, 10, { day: 0, period: 1 });
  check('subjIndex 와 gradeFreeState.cover 일치',
    eq(coverIdx[0].slice().sort(), [].concat(coverGf.cover['10A'], coverGf.cover['10B'], coverGf.cover['10C']).sort()));
}

/* =========================================================
   15d. 공강 현황 셀 렌더(index.html gradeFreeCellHtml) — 과목 표시·이스케이프
   ========================================================= */
{
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');
  const src = fnSrc(html, 'gradeFreeCellHtml') + '\n' + fnSrc(html, 'gfClickHint') + '\n'
    + fnSrc(html, 'gradeFreeState') + '\n' + fnSrc(html, 'subjectGradeTargets') + '\n'
    + fnSrc(html, 'gradeSubjectIndex') + '\n' + fnSrc(html, 'raFreeCellLabel') + '\n'
    + fnSrc(html, 'ghState') + '\n' + fnSrc(html, 'ghPartClasses') + '\n'
    + fnSrc(html, 'parseRaValue') + '\n'
    + fnSrc(html, 'esc');
  const cell = new Function('STATE', 'RA_VALUE_RE', 'isRaValue', 'raSupBreakdownAt', 'GF_SUBJECT_RE2', 'SLOT_COUNT', 'GF_SUBJ_MAX',
    src + '\nreturn gradeFreeCellHtml;')(
      { model: { entries: [] }, config: {} }, RA_VALUE_RE, isRaValue,
      function () {   // raSupBreakdownAt 스텁: 감독 없음(반별 빈 배열)
        var bc = {};
        [7, 8, 9, 10, 11, 12].forEach(function (g) { ['A', 'B', 'C'].forEach(function (c) { bc[g + c] = []; }); });
        return { byClass: bc, gradeSups: [], pure: [] };
      },
      /^(.+?)(7|8|9|10|11|12)([A-C])$/, 40, 4);

  // gradeFreeCellHtml(g, dd, p, cfg, blocks, paint, subjects)
  //   cfg = 미리보기용 config(DRAFT 의 금지 슬롯을 반영) / blocks = 편집 형태 규칙
  const h = cell(7, 0, 1, {}, [], false, ['PEng7A', 'TKD7B', 'Eng7C']);
  check('셀 렌더: 상태 줄과 과목 줄이 분리됨', h.indexOf('<div class="gf-st">') !== -1 && h.indexOf('<div class="gf-subj">') !== -1);
  check('셀 렌더: 과목이 줄바꿈되도록 각각 span', h.indexOf('<span>PEng7A</span><span>TKD7B</span><span>Eng7C</span>') !== -1);
  check('셀 렌더: 공강 상태 텍스트 유지', h.indexOf('전체') !== -1);
  check('셀 렌더: 과목 전체가 툴팁에도', h.indexOf('PEng7A / TKD7B / Eng7C') !== -1);

  // 과목 없는 칸은 과목 블록 자체가 없다(빈 점선이 남으면 안 됨)
  check('셀 렌더: 과목 없으면 과목 줄 없음', cell(7, 0, 1, {}, [], false, []).indexOf('gf-subj') === -1);

  // 5개 이상 → 앞의 4개 + '+N'
  const hMany = cell(7, 0, 1, {}, [], false, ['A7A', 'B7A', 'C7A', 'D7A', 'E7A', 'F7A']);
  check('셀 렌더: 최대 4개 표시 + 나머지 +N', hMany.indexOf('<span class="gf-more">+2</span>') !== -1 && hMany.indexOf('E7A</span>') === -1);
  check('셀 렌더: 접힌 과목도 툴팁에는 전부', hMany.indexOf('E7A') !== -1 && hMany.indexOf('F7A') !== -1);

  // 칠하기 모드에서는 과목을 숨긴다(칸 판독 방해 방지)
  check('셀 렌더: 칠하기 모드는 과목 숨김', cell(7, 0, 1, {}, [], true, ['PEng7A']).indexOf('gf-subj') === -1);

  // 과목명은 사용자 데이터 → HTML 이스케이프
  const hEsc = cell(7, 0, 1, {}, [], false, ['<img src=x onerror=alert(1)>7A']);
  check('셀 렌더: 과목명 HTML 이스케이프', hEsc.indexOf('<img') === -1 && hEsc.indexOf('&lt;img') !== -1);

  // 금지 슬롯: '금지' 표기를 유지하면서 편성된 과목도 함께 보인다(이상 신호)
  const blocks = [{ day: 0, period: 1, label: '회의', grades: [7], partialGrades: [], classes: [] }];
  const hNogo = cell(7, 0, 1, { fixedBlocks: blocks }, blocks, false, ['PEng7A']);
  check('셀 렌더: 금지 슬롯도 라벨 + 과목 병기',
    hNogo.indexOf('gf-nogo') !== -1 && hNogo.indexOf('회의') !== -1 && hNogo.indexOf('<span>PEng7A</span>') !== -1);

  // 이름 있는 금지 슬롯 = 회색 블록(gf-named) + 라벨 / 이름 없는 금지 슬롯 = 사선 무늬 + '금지'
  check('셀 렌더: 이름 있는 금지 슬롯은 gf-named + 라벨', hNogo.indexOf('gf-nogo gf-named') !== -1);
  const bare = [{ day: 0, period: 1, label: '', grades: [7], partialGrades: [], classes: [] }];
  const hBare = cell(7, 0, 1, { fixedBlocks: bare }, bare, false, []);
  check('셀 렌더: 이름 없는 금지 슬롯은 사선(gf-named 없음) + 금지',
    hBare.indexOf('gf-nogo') !== -1 && hBare.indexOf('gf-named') === -1 && hBare.indexOf('금지') !== -1);

  // cfg 는 DRAFT 미리보기용 — 규칙이 cfg 에 반영되면 판정(kind)도 blocked 가 된다
  check('셀 렌더: cfg 의 금지 규칙이 판정에 반영됨', hNogo.indexOf('gf-blocked') !== -1);
  // 반대로 cfg 에서 규칙을 지우면(=칠하기로 해제) 더는 blocked 로 보이지 않는다
  const hErased = cell(7, 0, 1, {}, [], false, ['PEng7A']);
  check('셀 렌더: cfg 에서 규칙이 빠지면 금지 표기도 사라짐',
    hErased.indexOf('gf-nogo') === -1 && hErased.indexOf('gf-blocked') === -1);
}

/* =========================================================
   16. 고정수업시간(pinned) — 이동 차단 / 이탈 경고 / 왕복 제외
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  const cfg = { pinned: { 'Stat': [4, 5, 20, 21] }, linkedGroups: {}, classless: {}, teamTeaching: {} };

  // (1) 고정 과목 이동 차단(delta): Stat@idx4 → idx1
  const model = CORE.buildModel([dataRow('교사99', { 4: 'Stat', 0: 'Kor7A' })], 3);
  const d = CORE.checkMovesDelta(model, cfg, [{ name: '교사99', row: 3, fromIdx: 4, toIdx: 1 }]);
  check('고정 과목 이동 → block 발생', d.blocks.length >= 1);
  check('고정 과목 block 메시지 "고정 수업" 포함',
    d.blocks.some(function (c) { return String(c.message).indexOf('고정 수업') !== -1; }));

  // (2) 비고정 과목 이동은 허용: Kor7A@idx0 → idx2
  const d2 = CORE.checkMovesDelta(model, cfg, [{ name: '교사99', row: 3, fromIdx: 0, toIdx: 2 }]);
  check('비고정 과목 이동 → block 없음', d2.blocks.length === 0);

  // (3) 이탈 경고: Stat@idx2(지정 슬롯 밖) → pinnedLeave warn
  const model2 = CORE.buildModel([dataRow('교사99', { 2: 'Stat' })], 3);
  const cf = CORE.findConflicts(model2, cfg);
  check('고정 시간 이탈 → pinnedLeave 경고',
    cf.some(function (c) { return c.type === 'pinnedLeave'; }));
  check('pinnedLeave 메시지 "고정 시간 이탈" + "지정: 월5,월6,수5,수6" 포함',
    cf.some(function (c) {
      return String(c.message).indexOf('고정 시간 이탈') !== -1 &&
        String(c.message).indexOf('지정: 월5,월6,수5,수6') !== -1;
    }));

  // (4) 왕복은 pinned 를 배제(설정 탭에 절대 기록 안 됨)
  const cfg2 = { fixedBlocks: [], classless: {}, teamTeaching: {}, linkedGroups: { 'G': ['A', 'B'] }, unavailable: [], pinned: { 'A': [4, 5] } };
  const round = parseConfig(CORE.serializeConfig(cfg2));
  check('serializeConfig 왕복 → pinned 제외', round.pinned === undefined);
  check('serializeConfig 왕복 → linkedGroups 보존', eq(round.linkedGroups, { 'G': ['A', 'B'] }));
}

/* =========================================================
   17. 고정수업 수동설정(pinnedManual) — 파싱 / 직렬화 왕복 / 우선순위(resolvePinned)
   ========================================================= */
{
  const serializeConfig = CORE.serializeConfig;
  const resolvePinned = CORE.resolvePinned;

  // (a) [고정수업] 파싱: 인식불가 라벨 무시, 슬롯 union/정렬, 슬롯 0개 과목 제외
  const vals = [
    ['[고정수업]'], ['과목명', '교시들'],
    ['수학보충8', '수7, 수7, 월5'],   // 중복(수7=22) + 정렬(월5=4)
    ['AI', '목7, 확8, 목8'],          // 확8 인식불가 무시(목7=30, 목8=31)
    ['빈과목', '확9'],                 // 인식 슬롯 0개 → 제외
  ];
  const pm = parseConfig(vals).pinnedManual;
  check('pinnedManual 수학보충8 union+정렬 [4,22]', eq(pm['수학보충8'], [4, 22]));
  check('pinnedManual AI 인식불가(확8) 무시 → [30,31]', eq(pm['AI'], [30, 31]));
  check('pinnedManual 인식 슬롯 0개 과목 제외', pm['빈과목'] === undefined);

  // (b) 직렬화 왕복: pinnedManual + 기존 블록(linkedGroups) 보존
  const cfg = {
    fixedBlocks: [], classless: {}, teamTeaching: {},
    linkedGroups: { 'G': ['A', 'B'] }, unavailable: [],
    pinnedManual: { '수학보충8': [22], 'AI': [30, 31] }
  };
  const round = parseConfig(serializeConfig(cfg));
  check('직렬화 왕복 → pinnedManual 보존', eq(round.pinnedManual, cfg.pinnedManual));
  check('직렬화 왕복 → linkedGroups 보존', eq(round.linkedGroups, { 'G': ['A', 'B'] }));

  // (c) 우선순위 resolvePinned
  const linked = { 'Statistics': [4, 5, 20, 21] };
  const rm = resolvePinned({ pinnedManual: { '수학보충8': [22] } }, linked);
  check("resolvePinned manual 1개↑ → source='manual', linked 무시",
    rm.pinnedSource === 'manual' && eq(rm.pinned, { '수학보충8': [22] }));
  const rl = resolvePinned({ pinnedManual: {} }, linked);
  check("resolvePinned manual 비면 → source='linked' & pinned=linked",
    rl.pinnedSource === 'linked' && eq(rl.pinned, linked));
  const rn = resolvePinned({ pinnedManual: {} }, {});
  check("resolvePinned 둘 다 비면 → source='none' & pinned={}",
    rn.pinnedSource === 'none' && eq(rn.pinned, {}));
}

/* =========================================================
   18. planMovesTo — 복수 경로 열거(막힌 목적지 blocker 재배치)
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  // A(행3): Eng7A @idx0 → idx1 이동 희망. idx1 은 B(행4)의 Kor7A(같은 학급 7A)가 점유 → 직접 이동 차단.
  // B 는 Kor7A 를 여러 빈 슬롯으로 재배치 가능 → 서로 다른 무충돌 계획 다수.
  const rows = [dataRow('A', { 0: 'Eng7A' }), dataRow('B', { 1: 'Kor7A' })];
  const model = CORE.buildModel(rows, 3);
  const config = { fixedBlocks: [], classless: {}, teamTeaching: {}, linkedGroups: {} };
  const plans = CORE.planMovesTo(model, config, { name: 'A', row: 3, fromIdx: 0 }, 1);

  check('planMovesTo ≥ 2개 경로 열거', plans.length >= 2);
  check('planMovesTo 모든 경로 무충돌(checkMovesDelta blocks===0)',
    plans.every(function (p) { return CV.checkMovesDelta(model, config, p.moves).blocks.length === 0; }));

  function sig(moves) {
    return moves.map(function (m) { return m.row + ':' + m.fromIdx + '→' + m.toIdx; }).sort().join('|');
  }
  const sigs = plans.map(function (p) { return sig(p.moves); });
  check('planMovesTo 경로 서명 전부 고유(중복 없음)', new Set(sigs).size === sigs.length);
  check('planMovesTo moves.length 오름차순 정렬',
    plans.every(function (p, i) { return i === 0 || plans[i - 1].moves.length <= p.moves.length; }));
}

/* =========================================================
   19. 경량 후보 스캔 planScanTo/planScanAll — 부분집합 스모크
   (클라이언트 셀클릭 색칠 경로. 하드 불변식: 스캔 계획은 무충돌 + 같은
    (target,to)에 planMovesTo 해 존재. 색칠: direct=green(재배치 없음)/chain=yellow.)
   ========================================================= */
{
  const planScanTo = CORE.planScanTo;
  const planScanAll = CORE.planScanAll;
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  // A(행3): Eng7A@idx0 → idx1(B의 Kor7A 점유, 같은 학급 7A). B 재배치로 연쇄 가능.
  const rows = [dataRow('A', { 0: 'Eng7A' }), dataRow('B', { 1: 'Kor7A' })];
  const model = CORE.buildModel(rows, 3);
  const config = { fixedBlocks: [], classless: {}, teamTeaching: {}, linkedGroups: {} };
  const move = { name: 'A', row: 3, fromIdx: 0 };

  const arr = planScanAll(model, config, move);
  check('planScanAll → 길이 40 배열', Array.isArray(arr) && arr.length === 40);
  let hits = 0, dirty = 0, viol = 0, badKind = 0;
  for (let d = 0; d < arr.length; d++) {
    const p = arr[d];
    if (!p) continue;
    hits++;
    if (CORE.checkMovesDelta(model, config, p.moves).blocks.length !== 0) dirty++;
    if (CORE.planMovesTo(model, config, move, d).length === 0) viol++;
    const relocated = p.moves.some(function (mv) { return mv.toIdx !== d; });
    if ((p.kind === 'direct') === relocated) badKind++;
  }
  check('planScanAll 후보 존재', hits > 0);
  check('planScanAll 계획 전부 무충돌(checkMovesDelta clean)', dirty === 0);
  check('planScanAll hit ⟹ planMovesTo 해 존재(부분집합)', viol === 0);
  check('planScanAll 색칠 의미 일치(direct⟺재배치없음)', badKind === 0);

  // idx1: 연쇄 필요(B 점유) — planScanTo 도 계획 반환 + 무충돌 + planMovesTo 존재.
  const s1 = planScanTo(model, config, move, 1);
  check('planScanTo(막힌 idx1) 계획 반환', !!s1);
  check('planScanTo(idx1) 무충돌 & planMovesTo 해 존재',
    !!s1 && CORE.checkMovesDelta(model, config, s1.moves).blocks.length === 0
    && CORE.planMovesTo(model, config, move, 1).length > 0);
}

/* =========================================================
   20. planSwapTo — 두 열 맞교환(Kempe). 성공/실패 경계 + 부분집합 불변식.
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  const baseCfg = () => ({ fixedBlocks: [], classless: {}, teamTeaching: {}, linkedGroups: {}, pinned: {}, unavailable: [] });

  // (a) 단순 맞교환: A:X7A@0(→1), B:Y7A@1 → T 점유 Y7A 를 F(0)로 밀어내 성공.
  {
    const model = CORE.buildModel([dataRow('A', { 0: 'X7A' }), dataRow('B', { 1: 'Y7A' })], 3);
    const cfg = baseCfg();
    const sw = CORE.planSwapTo(model, cfg, { name: 'A', row: 3, fromIdx: 0 }, 1);
    check('§20(a) 단순 맞교환 성공(non-null·swap·blocks0)',
      !!sw && sw.kind === 'swap' && CV.checkMovesDelta(model, cfg, sw.moves).blocks.length === 0);
  }

  // (b) pinned: 밀려날 Y7A 가 idx1 에 고정 → 맞교환 불가 → null.
  {
    const model = CORE.buildModel([dataRow('A', { 0: 'X7A' }), dataRow('B', { 1: 'Y7A' })], 3);
    const cfg = baseCfg(); cfg.pinned = { Y7A: [1] };
    const sw = CORE.planSwapTo(model, cfg, { name: 'A', row: 3, fromIdx: 0 }, 1);
    check('§20(b) pinned 점유행 → null', sw === null);
  }

  // (c) 해소 불가(홀수 사이클): 세 7A 가 두 열에 걸침 → 2색 불가 → null.
  {
    const model = CORE.buildModel([dataRow('A', { 0: 'X7A' }), dataRow('B', { 1: 'Z7A' }), dataRow('C', { 0: 'W7A' })], 3);
    const cfg = baseCfg();
    const sw = CORE.planSwapTo(model, cfg, { name: 'A', row: 3, fromIdx: 0 }, 1);
    check('§20(c) 해소 불가(odd cycle) → null', sw === null);
  }

  // (c2) 자기 두 열 맞교환: B 가 F(0)·T(1) 양쪽에 다른 학급 과목 → 정상 해(과도 null 방지).
  {
    const model = CORE.buildModel([dataRow('A', { 0: 'X7A' }), dataRow('B', { 0: 'Q7C', 1: 'P7A' })], 3);
    const cfg = baseCfg();
    const sw = CORE.planSwapTo(model, cfg, { name: 'A', row: 3, fromIdx: 0 }, 1);
    check('§20(c2) 자기 두 열 맞교환 성공',
      !!sw && CV.checkMovesDelta(model, cfg, sw.moves).blocks.length === 0);
  }

  // (d) swap-only 슬롯 ⟹ planMovesTo 부분집합 불변식.
  //   벽(pinned)이 빈슬롯 재배치를 전부 차단 → chain 실패, Pass3 swap 만 성공.
  {
    const wall = {}, wallSlots = [];
    for (let i = 2; i < 40; i++) { wall[i] = 'WX7A'; wallSlots.push(i); }
    const model = CORE.buildModel([
      dataRow('A', { 0: 'AX7A' }),
      dataRow('B', { 0: 'BY7C', 1: 'BX7A' }),
      dataRow('W', wall),
    ], 3);
    const cfg = baseCfg(); cfg.pinned = { WX7A: wallSlots };
    const move = { name: 'A', row: 3, fromIdx: 0 };
    const scan = CORE.planScanAll(model, cfg, move);
    check('§20(d) swap-only 슬롯 scan[1].kind===swap',
      !!scan[1] && scan[1].kind === 'swap' && CORE.planMovesTo(model, cfg, move, 1).length > 0);
    let viol = 0;
    for (let d = 0; d < scan.length; d++) {
      if (scan[d] && scan[d].kind === 'swap' && CORE.planMovesTo(model, cfg, move, d).length === 0) viol++;
    }
    check('§20(d) 모든 swap scan hit ⟹ planMovesTo≥1 (viol=0)', viol === 0);
  }
}

/* =========================================================
   21. RA 감독 배정 — assignCandidates / RA 미분류 제외 / RA 점유 차단 / raOpError
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  const baseCfg = { fixedBlocks: [], classless: {}, teamTeaching: {}, linkedGroups: {} };

  // (1) assignCandidates: 정렬 + 점유 제외 + 불가시간 제외 + ra/lessons 카운트
  const acRows = [
    dataRow('교사A', { 0: 'Kor7A', 1: 'RA' }),   // total=2, ra=1, lessons=1 ; idx5 비어있음
    dataRow('교사B', {}),                         // total=0 ; idx5 비어있음
    dataRow('교사C', { 5: 'Math8A' }),            // idx5 점유 → 제외
    dataRow('교사D', { 0: 'Eng9A' }),             // idx5 비어있으나 불가시간 → 제외
  ];
  const acModel = CORE.buildModel(acRows, 3);
  const acConfig = { unavailable: [{ name: '교사D', slots: [5] }] };
  const cands = assignCandidates(acModel, acConfig, 5);
  check('assignCandidates 점유 슬롯 교사 제외(교사C)', !cands.some((c) => c.name === '교사C'));
  check('assignCandidates 불가시간 교사 제외(교사D)', !cands.some((c) => c.name === '교사D'));
  check('assignCandidates 후보 = [교사B, 교사A] (total asc)', eq(cands.map((c) => c.name), ['교사B', '교사A']));
  const aCand = cands.find((c) => c.name === '교사A');
  check('assignCandidates 교사A total=2/ra=1/lessons=1', !!aCand && aCand.total === 2 && aCand.ra === 1 && aCand.lessons === 1);

  // 정렬 동률(total 동일) → name 오름차순
  const tieModel = CORE.buildModel([dataRow('나', { 0: 'X7A' }), dataRow('가', { 0: 'Y7A' })], 3);
  const tie = assignCandidates(tieModel, { unavailable: [] }, 5);
  check('assignCandidates 동률 name asc(가 먼저)', eq(tie.map((c) => c.name), ['가', '나']));

  // (2) RA 는 미분류로 플래그되지 않음, 미지 과목(ZZZ)은 미분류
  const raModel = CORE.buildModel([dataRow('T1', { 3: 'RA' }), dataRow('T2', { 4: 'ZZZ' })], 3);
  const rc = CORE.findConflicts(raModel, baseCfg);
  check('RA 셀은 unclassified 아님', !rc.some((c) => c.type === 'unclassified' && c.subject === 'RA'));
  check('미지 과목 ZZZ 는 unclassified', rc.some((c) => c.type === 'unclassified' && c.subject === 'ZZZ'));

  // (3) RA 점유는 여전히 이동 차단(교사 중복): idx0 수업을 RA 점유 idx1 로 이동
  const occModel = CORE.buildModel([dataRow('T', { 0: 'Kor7A', 1: 'RA' })], 3);
  const occDelta = CORE.checkMovesDelta(occModel, baseCfg, [{ name: 'T', row: 3, fromIdx: 0, toIdx: 1 }]);
  check('RA 점유 슬롯으로 이동 → block(교사 중복)', occDelta.blocks.length > 0);

  // (4) raOpError: 배정/해제 재검증
  const opModel = CORE.buildModel([dataRow('T', { 1: 'RA', 2: 'Kor7A' })], 3);  // row3 teacher: idx0 빈칸, idx1 RA, idx2 수업
  check('raOpError 빈 슬롯 배정 → null', raOpError(opModel, [{ row: 3, idx: 0 }], []) === null);
  check('raOpError 점유 슬롯 배정 → cell_occupied/409', eq(raOpError(opModel, [{ row: 3, idx: 2 }], []), { error: 'cell_occupied', status: 409 }));
  check('raOpError 미지 행 배정 → invalid_assign/400', eq(raOpError(opModel, [{ row: 999, idx: 0 }], []), { error: 'invalid_assign', status: 400 }));
  const synthModel = { entries: [{ row: 3, type: 'teacher', slots: opModel.entries[0].slots }, { row: 50, type: 'raSlot', slots: new Array(40).fill('') }] };
  check('raOpError raSlot(비교사) 행 배정 → invalid_assign/400', eq(raOpError(synthModel, [{ row: 50, idx: 0 }], []), { error: 'invalid_assign', status: 400 }));
  check('raOpError RA 셀 해제 → null', raOpError(opModel, [], [{ row: 3, idx: 1 }]) === null);
  check('raOpError 비-RA 셀 해제 → not_ra/409', eq(raOpError(opModel, [], [{ row: 3, idx: 2 }]), { error: 'not_ra', status: 409 }));

  // (5) raOpError 반 단위 값 검증 + duplicate_ra
  const vModel = CORE.buildModel([dataRow('T', { 2: 'Kor7A' })], 3);  // row3: idx0 빈칸, idx2 수업
  check('raOpError value=RA11B 빈 슬롯 배정 → null', raOpError(vModel, [{ row: 3, idx: 0, value: 'RA11B' }], []) === null);
  check('raOpError value=RA 배정 → null', raOpError(vModel, [{ row: 3, idx: 0, value: 'RA' }], []) === null);
  check('raOpError value=XYZ → invalid_value/400', eq(raOpError(vModel, [{ row: 3, idx: 0, value: 'XYZ' }], []), { error: 'invalid_value', status: 400 }));
  // duplicate_ra: 교사A idx0에 RA11B, 교사B(idx0 빈칸) 같은 값 배정 시도
  const dupModel = CORE.buildModel([dataRow('A', { 0: 'RA11B' }), dataRow('B', {})], 3);  // A=row3, B=row4
  check('raOpError 반 중복 배정 → duplicate_ra/409', eq(raOpError(dupModel, [{ row: 4, idx: 0, value: 'RA11B' }], []), { error: 'duplicate_ra', status: 409 }));
  // 순수 RA 는 중복 허용
  const dupRaModel = CORE.buildModel([dataRow('A', { 0: 'RA' }), dataRow('B', {})], 3);
  check('raOpError 순수 RA 중복 배정 허용 → null', raOpError(dupRaModel, [{ row: 4, idx: 0, value: 'RA' }], []) === null);
  // clear: RA11B 셀 해제 가능, 실수업 셀 해제 불가
  const clrModel = CORE.buildModel([dataRow('T', { 0: 'RA11B', 2: 'Kor7A' })], 3);
  check('raOpError RA11B 셀 해제 → null', raOpError(clrModel, [], [{ row: 3, idx: 0 }]) === null);
  check('raOpError 실수업 셀 해제 → not_ra/409', eq(raOpError(clrModel, [], [{ row: 3, idx: 2 }]), { error: 'not_ra', status: 409 }));

  // (6) isRaValue / RA_VALUE_RE
  check('isRaValue RA/RA11B 참, RA13A/XYZ/빈값 거짓',
    isRaValue('RA') && isRaValue('RA11B') && !isRaValue('RA13A') && !isRaValue('XYZ') && !isRaValue(''));
  check('isRaValue RA12(학년 단위) 참', isRaValue('RA12') === true);

  // (7) gradeFreeState: RA+반 값은 busy 아님 — 반 free 유지 + raClasses/covered
  const gfRa = gradeFreeState(CORE.buildModel([dataRow('T', { 0: 'RA11B' })], 3), baseCfg, 11, { day: 0, period: 1 });
  check('gradeFree RA11B → 11B free 유지', gfRa.freeClasses.indexOf('11B') !== -1);
  check('gradeFree RA11B → 11B busy 아님', gfRa.busyClasses.indexOf('11B') === -1);
  check('gradeFree RA11B → raClasses 11B 포함', gfRa.raClasses.indexOf('11B') !== -1);
  check('gradeFree RA11B → 라벨 전체/kind all(배정 전 동일)', gfRa.kind === 'all' && gfRa.label === '전체');
  check('gradeFree 일부 반만 RA배정 → covered false', gfRa.covered === false);
  // 공강 반 전부 RA배정 → covered true
  const gfCovAll = gradeFreeState(CORE.buildModel([dataRow('A', { 0: 'RA11A' }), dataRow('B', { 0: 'RA11B' }), dataRow('C', { 0: 'RA11C' })], 3), baseCfg, 11, { day: 0, period: 1 });
  check('gradeFree 전 반 RA배정 → covered true', gfCovAll.covered === true && gfCovAll.kind === 'all');
  // partial + 순수 RA(legacy) 감독 → 학년 커버 안 함 → covered false
  const partCfg = Object.assign({}, baseCfg, { classless: { 'AP Statistics': ['12일부'] } });
  const gfPartRA = gradeFreeState(CORE.buildModel([dataRow('S', { 4: 'AP Statistics' }), dataRow('R', { 4: 'RA' })], 3), partCfg, 12, { day: 0, period: 5 });
  check('gradeFree partial + 순수 RA(legacy) → covered false', gfPartRA.kind === 'partial' && gfPartRA.covered === false);
  // partial + 학년 단위 RA12 감독 → covered true
  const gfPartRA12 = gradeFreeState(CORE.buildModel([dataRow('S', { 4: 'AP Statistics' }), dataRow('R', { 4: 'RA12' })], 3), partCfg, 12, { day: 0, period: 5 });
  check('gradeFree partial + RA12 → covered true', gfPartRA12.kind === 'partial' && gfPartRA12.covered === true);
  const gfPartNo = gradeFreeState(CORE.buildModel([dataRow('S', { 4: 'AP Statistics' })], 3), partCfg, 12, { day: 0, period: 5 });
  check('gradeFree partial + RA 감독 없음 → covered false', gfPartNo.covered === false);

  // (8) core: RA11B 는 미분류 아님 + 같은 반 이동 차단
  const raClsModel = CORE.buildModel([dataRow('T', { 0: 'RA11B' })], 3);
  check('RA11B 셀은 unclassified 아님', !CORE.findConflicts(raClsModel, baseCfg).some((c) => c.type === 'unclassified' && c.subject === 'RA11B'));
  const occClsModel = CORE.buildModel([dataRow('T', { 0: 'Kor11B', 1: 'RA11B' })], 3);
  const occClsDelta = CORE.checkMovesDelta(occClsModel, baseCfg, [{ name: 'T', row: 3, fromIdx: 0, toIdx: 1 }]);
  check('Kor11B → RA11B 슬롯 이동 → block(반 11B 중복)', occClsDelta.blocks.length > 0);

  // (9) assignCandidates: RA11B 슬롯은 ra 로 카운트(수업 아님)
  const acRaModel = CORE.buildModel([dataRow('교사R', { 0: 'RA11B' })], 3);  // idx5 빈칸
  const acRa = assignCandidates(acRaModel, { unavailable: [] }, 5).find((c) => c.name === '교사R');
  check('assignCandidates RA11B → ra≥1 & lessons=0', !!acRa && acRa.ra >= 1 && acRa.lessons === 0);

  // (10) BUG fix: 부분 커버가 학년 간 누수되지 않음 — 11일부+12일부 슬롯에 RA12 배정
  const xCfg = Object.assign({}, baseCfg, { classless: { 'AP11': ['11일부'], 'AP12': ['12일부'] } });
  const xModel12 = CORE.buildModel([dataRow('S11', { 0: 'AP11' }), dataRow('S12', { 0: 'AP12' }), dataRow('R', { 0: 'RA12' })], 3);
  const x12 = gradeFreeState(xModel12, xCfg, 12, { day: 0, period: 1 });
  const x11 = gradeFreeState(xModel12, xCfg, 11, { day: 0, period: 1 });
  check('BUG fix: RA12 → 12학년 covered true', x12.kind === 'partial' && x12.covered === true);
  check('BUG fix: RA12 → 11학년 covered false(누수 없음)', x11.kind === 'partial' && x11.covered === false);
  const xModelRA = CORE.buildModel([dataRow('S11', { 0: 'AP11' }), dataRow('S12', { 0: 'AP12' }), dataRow('R', { 0: 'RA' })], 3);
  check('BUG fix: bare RA → 11·12 둘 다 covered false',
    gradeFreeState(xModelRA, xCfg, 11, { day: 0, period: 1 }).covered === false &&
    gradeFreeState(xModelRA, xCfg, 12, { day: 0, period: 1 }).covered === false);

  // (11) raFreeCellLabel (순수)
  check("raFreeCellLabel partial 무감독 → '12일부'", raFreeCellLabel({ kind: 'partial' }, {}, 12) === '12일부');
  check("raFreeCellLabel partial 1감독 → '12일부\\n교사31'", raFreeCellLabel({ kind: 'partial' }, { gradeSups: ['교사31'] }, 12) === '12일부\n교사31');
  check("raFreeCellLabel partial 2감독 → '12일부\\n교사31,박OO'", raFreeCellLabel({ kind: 'partial' }, { gradeSups: ['교사31', '박OO'] }, 12) === '12일부\n교사31,박OO');
  check("raFreeCellLabel some 혼합 → '11B\\n교사31\\n11C'", raFreeCellLabel({ kind: 'some', freeClasses: ['11B', '11C'] }, { byClass: { '11B': ['교사31'] } }, 11) === '11B\n교사31\n11C');
  check("raFreeCellLabel some 무감독 → '11B, 11C'", raFreeCellLabel({ kind: 'some', freeClasses: ['11B', '11C'] }, {}, 11) === '11B, 11C');
  check("raFreeCellLabel some 혼합(11B배정·11C미배정) → '11B\\n교사42\\n11C'", raFreeCellLabel({ kind: 'some', freeClasses: ['11B', '11C'] }, { byClass: { '11B': ['교사42'] } }, 11) === '11B\n교사42\n11C');
  check("raFreeCellLabel all 일부감독 → '12A\\n교사31\\n12B\\n12C'", raFreeCellLabel({ kind: 'all', freeClasses: ['12A', '12B', '12C'] }, { byClass: { '12A': ['교사31'] } }, 12) === '12A\n교사31\n12B\n12C');
  check("raFreeCellLabel all 무감독 → '전체'", raFreeCellLabel({ kind: 'all', freeClasses: ['12A', '12B', '12C'] }, {}, 12) === '전체');

  // (12) raOpError: 학년 단위 RA12 값(공동감독 허용, 반 지정만 중복 차단)
  const g12Model = CORE.buildModel([dataRow('T', { 2: 'Kor7A' })], 3);
  check('raOpError value=RA12 빈 슬롯 → null', raOpError(g12Model, [{ row: 3, idx: 0, value: 'RA12' }], []) === null);
  const dupG12 = CORE.buildModel([dataRow('A', { 0: 'RA12' }), dataRow('B', {})], 3);
  check('raOpError RA12 공동감독 중복 허용 → null', raOpError(dupG12, [{ row: 4, idx: 0, value: 'RA12' }], []) === null);
  const dupG12B = CORE.buildModel([dataRow('A', { 0: 'RA12B' }), dataRow('B', {})], 3);
  check('raOpError RA12B 중복 → duplicate_ra/409', eq(raOpError(dupG12B, [{ row: 4, idx: 0, value: 'RA12B' }], []), { error: 'duplicate_ra', status: 409 }));
  const clrG12 = CORE.buildModel([dataRow('T', { 0: 'RA12', 2: 'Kor7A' })], 3);
  check('raOpError RA12 셀 해제 → null', raOpError(clrG12, [], [{ row: 3, idx: 0 }]) === null);

  // (13) core: RA12(학년 단위)는 미분류 아님 (동기화된 src/core 의존)
  const ra12Model = CORE.buildModel([dataRow('T', { 0: 'RA12' })], 3);
  check('RA12 셀은 unclassified 아님', !CORE.findConflicts(ra12Model, baseCfg).some((c) => c.type === 'unclassified' && c.subject === 'RA12'));

  // (14) 신 값 형식 RA{순번2자리}_{대상} — formatRaValue / parseRaValue / nextRaSeq
  check("formatRaValue(1,'11A')==='RA01_11A'", formatRaValue(1, '11A') === 'RA01_11A');
  check("formatRaValue(2,'7C')==='RA02_7C'", formatRaValue(2, '7C') === 'RA02_7C');
  check("formatRaValue(3,'12')==='RA03_12'", formatRaValue(3, '12') === 'RA03_12');
  check("formatRaValue(100,'8')==='RA100_8'", formatRaValue(100, '8') === 'RA100_8');

  check("parseRaValue('RA01_11A')", eq(parseRaValue('RA01_11A'), { seq: 1, grade: 11, cls: 'A', target: '11A' }));
  check("parseRaValue('RA03_12')", eq(parseRaValue('RA03_12'), { seq: 3, grade: 12, cls: null, target: '12' }));
  check("parseRaValue('RA100_7C')", eq(parseRaValue('RA100_7C'), { seq: 100, grade: 7, cls: 'C', target: '7C' }));
  check("parseRaValue legacy 'RA11B'", eq(parseRaValue('RA11B'), { seq: null, grade: 11, cls: 'B', target: '11B' }));
  check("parseRaValue legacy 'RA12'", eq(parseRaValue('RA12'), { seq: null, grade: 12, cls: null, target: '12' }));
  check("parseRaValue legacy 'RA'", eq(parseRaValue('RA'), { seq: null, grade: null, cls: null, target: '' }));
  check("parseRaValue('XYZ')===null", parseRaValue('XYZ') === null);
  check("parseRaValue('RA1_11A')===null(순번 1자리)", parseRaValue('RA1_11A') === null);
  check("parseRaValue('RA13A')===null", parseRaValue('RA13A') === null);
  check("isRaValue('RA01_11A')===true", isRaValue('RA01_11A') === true);

  check('nextRaSeq 빈 모델 → 1', nextRaSeq({ entries: [] }) === 1);
  check('nextRaSeq RA01_11A·RA05_12 → 6',
    nextRaSeq(CORE.buildModel([dataRow('A', { 0: 'RA01_11A' }), dataRow('B', { 1: 'RA05_12' })], 3)) === 6);
  check('nextRaSeq legacy 값만(RA11B) → 1', nextRaSeq(CORE.buildModel([dataRow('A', { 0: 'RA11B' })], 3)) === 1);
  check('nextRaSeq RA100_8 → 101', nextRaSeq(CORE.buildModel([dataRow('A', { 0: 'RA100_8' })], 3)) === 101);

  // (15) raOpError — 신 형식 값 + target 기준 중복
  const nvModel = CORE.buildModel([dataRow('T', { 2: 'Kor7A' })], 3);
  check('raOpError value=RA01_11A 빈 슬롯 → null', raOpError(nvModel, [{ row: 3, idx: 0, value: 'RA01_11A' }], []) === null);
  check('raOpError value=RA1_11A → invalid_value/400', eq(raOpError(nvModel, [{ row: 3, idx: 0, value: 'RA1_11A' }], []), { error: 'invalid_value', status: 400 }));
  const dupNew = CORE.buildModel([dataRow('A', { 0: 'RA07_11B' }), dataRow('B', {})], 3);
  check('raOpError 신형식 같은 반 중복(순번 달라도) → duplicate_ra/409',
    eq(raOpError(dupNew, [{ row: 4, idx: 0, value: 'RA09_11B' }], []), { error: 'duplicate_ra', status: 409 }));
  const dupLegacyNew = CORE.buildModel([dataRow('A', { 0: 'RA11B' }), dataRow('B', {})], 3);
  check('raOpError legacy RA11B vs 신형식 RA09_11B → duplicate_ra/409',
    eq(raOpError(dupLegacyNew, [{ row: 4, idx: 0, value: 'RA09_11B' }], []), { error: 'duplicate_ra', status: 409 }));
  const dupNewG = CORE.buildModel([dataRow('A', { 0: 'RA03_12' }), dataRow('B', {})], 3);
  check('raOpError 신형식 학년 단위 공동감독 → null', raOpError(dupNewG, [{ row: 4, idx: 0, value: 'RA09_12' }], []) === null);
  const clrNew = CORE.buildModel([dataRow('T', { 0: 'RA01_11A', 2: 'Kor7A' })], 3);
  check('raOpError RA01_11A 셀 해제 → null', raOpError(clrNew, [], [{ row: 3, idx: 0 }]) === null);

  // (16) gradeFreeState 가 신형식 값을 반 커버로 인식
  const gfNew = gradeFreeState(CORE.buildModel([dataRow('T', { 0: 'RA01_11A' })], 3), baseCfg, 11, { day: 0, period: 1 });
  check('gradeFree RA01_11A → raClasses 11A 포함', gfNew.raClasses.indexOf('11A') !== -1);
  check('gradeFree RA01_11A → 11A busy 아님', gfNew.busyClasses.indexOf('11A') === -1);
  const gfNewAll = gradeFreeState(
    CORE.buildModel([dataRow('A', { 0: 'RA01_11A' }), dataRow('B', { 0: 'RA02_11B' }), dataRow('C', { 0: 'RA03_11C' })], 3),
    baseCfg, 11, { day: 0, period: 1 });
  check('gradeFree 신형식 전 반 배정 → covered true', gfNewAll.covered === true);
  const gfNewPart = gradeFreeState(
    CORE.buildModel([dataRow('S', { 4: 'AP Statistics' }), dataRow('R', { 4: 'RA04_12' })], 3),
    Object.assign({}, baseCfg, { classless: { 'AP Statistics': ['12일부'] } }), 12, { day: 0, period: 5 });
  check('gradeFree partial + RA04_12 → covered true', gfNewPart.kind === 'partial' && gfNewPart.covered === true);
}

/* =========================================================
   7·8교시 무제약 이동 (교시 특별취급 제거 후)
   ========================================================= */
{
  function dataRow(name, slotMap) {
    const r = [name, ''];
    for (let i = 0; i < 40; i++) r.push(slotMap[i] || '');
    return r;
  }
  const FRI7 = 38; // 금7 = 4*8 + (7-1)
  const mA = CORE.buildModel([dataRow('교사A', { 0: 'Alge8A' })], 3);
  const moveA = [{ name: '교사A', row: 3, fromIdx: 0, toIdx: FRI7 }];
  check('7교시 이동 block 없음', !CORE.hasBlock(CORE.checkMoves(mA, {}, moveA)));
  check('7교시 이동 델타 block 없음', CORE.checkMovesDelta(mA, {}, moveA).blocks.length === 0);
  // 대체 수단: 금지 슬롯([고정블록])을 지정하면 정상 차단
  const cfgB = { fixedBlocks: [{ day: 4, period: 7, label: '자치모임', grades: [8], classes: [], partialGrades: [] }] };
  check('금지 슬롯 지정 시 7교시 이동 차단', CORE.hasBlock(CORE.checkMoves(mA, cfgB, moveA)));
}

/* =========================================================
   assembleConfig(index.html) — 설정 저장 시 regularSlots 보존
   ========================================================= */
{
  // index.html 안의 assembleConfig 소스를 중괄호 매칭으로 추출 → new Function 으로 로드
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');
  const src = fnSrc(html, 'blocksToConfig') + '\n' + fnSrc(html, 'assembleConfig');
  const runAssemble = new Function('DRAFT', 'STATE', src + '\nreturn assembleConfig();');

  const DRAFT = { fixedBlocks: [], groups: [], classless: {}, team: [], unavailable: [], pinned: [] };
  const regular = [{ grade: 8, day: 4, period: 7 }, { grade: 11, day: 2, period: 8 }];
  const STATE = { config: { regularSlots: regular } };
  const out = runAssemble(DRAFT, STATE);
  check('assembleConfig regularSlots 이월', eq(out.regularSlots, regular));
  out.regularSlots && out.regularSlots[0] && (out.regularSlots[0].grade = 99);
  check('assembleConfig regularSlots 딥카피(원본 불변)', STATE.config.regularSlots[0].grade === 8);

  // regularSlots 가 없으면 필드도 생기지 않아야 함(다른 이월 필드와 동일 규약)
  const out2 = runAssemble(DRAFT, { config: {} });
  check('assembleConfig regularSlots 없으면 미설정', out2.regularSlots === undefined);
}

/* =========================================================
   사용자 OAuth 토큰 전달 (makeSheetsFetch) + Sheets 오류 매핑 (mapSheetsError)
   ========================================================= */
await (async function () {
  // (1) 요청 헤더에 사용자 access token 이 그대로 실린다 (SA 토큰 없음)
  let seen = null;
  const fakeFetch = async function (url, opts) {
    seen = { url: url, opts: opts };
    return { ok: true, status: 200, json: async function () { return { values: [] }; } };
  };
  const sf = makeSheetsFetch('ya29.USER_TOKEN', 'SHEET/ID', fakeFetch);
  const out = await sf('/values:batchGet?ranges=A1', { method: 'GET' });
  check('makeSheetsFetch → 사용자 토큰을 Authorization 으로 전달',
    seen.opts.headers.authorization === 'Bearer ya29.USER_TOKEN');
  check('makeSheetsFetch → sheetId 는 URL 인코딩',
    seen.url === 'https://sheets.googleapis.com/v4/spreadsheets/SHEET%2FID/values:batchGet?ranges=A1');
  check('makeSheetsFetch → method 등 init 보존', seen.opts.method === 'GET');
  check('makeSheetsFetch → res.json() 반환', eq(out, { values: [] }));

  // (2) 비정상 응답은 상태코드를 담아 throw
  const errFetch = function (status) {
    return async function () {
      return { ok: false, status: status, text: async function () { return 'boom'; }, json: async function () { return {}; } };
    };
  };
  await expectFail('403 응답 → sheets_api_error throw',
    makeSheetsFetch('t', 'S', errFetch(403))('/x'), 'sheets_api_error 403 boom');

  // (3) 상태코드 추출
  check('sheetsErrorStatus 401 추출', sheetsErrorStatus(new Error('sheets_api_error 401 x')) === 401);
  check('sheetsErrorStatus 비-Sheets 오류 → null', sheetsErrorStatus(new Error('boom')) === null);

  // ---- 오류 매핑: 구글이 실제로 돌려주는 응답 본문 fixture 로 검증 ----
  // makeSheetsFetch 가 만드는 메시지 형태 그대로 재현한다.
  const apiErr = function (status, bodyObj) {
    const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    return new Error('sheets_api_error ' + status + ' ' + body.slice(0, 1200));
  };

  // 실제 구글 응답: 토큰에 spreadsheets 스코프가 없을 때
  const SCOPE_403 = {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
      status: 'PERMISSION_DENIED',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
        domain: 'googleapis.com',
        metadata: { service: 'sheets.googleapis.com', method: 'google.apps.sheets.v4.SpreadsheetsService.GetSpreadsheet' }
      }]
    }
  };
  // 실제 구글 응답: 시트에 공유 권한이 없을 때
  const NOPERM_403 = {
    error: {
      code: 403,
      message: 'The caller does not have permission',
      errors: [{ message: 'The caller does not have permission', domain: 'global', reason: 'forbidden' }],
      status: 'PERMISSION_DENIED'
    }
  };
  // 실제 구글 응답: 삭제되었거나 없는 시트 ID
  const NOTFOUND_404 = {
    error: {
      code: 404,
      message: 'Requested entity was not found.',
      errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }],
      status: 'NOT_FOUND'
    }
  };
  const RATE_429 = {
    error: {
      code: 429,
      message: "Quota exceeded for quota metric 'Read requests'",
      errors: [{ message: 'Quota exceeded', domain: 'usageLimits', reason: 'rateLimitExceeded' }],
      status: 'RESOURCE_EXHAUSTED'
    }
  };

  // (4) 401 은 토큰 만료(클라이언트가 명시적 재허용 후 재시도할 신호)
  const m401 = mapSheetsError(apiErr(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }));
  check('401 → 401 sheets_token_expired',
    m401.status === 401 && m401.body.error === 'sheets_token_expired');

  // (5) 403 은 본문으로 스코프 부족 / 권한 없음을 구분한다
  const mScope = mapSheetsError(apiErr(403, SCOPE_403));
  check('스코프 부족 403 → insufficient_scope',
    mScope.status === 403 && mScope.body.error === 'insufficient_scope');
  check('insufficient_scope 안내는 재허용 유도(공유 요청 아님)',
    /권한/.test(mScope.body.reasons[0]) && !/공유를 요청/.test(mScope.body.reasons[0]));

  const m403 = mapSheetsError(apiErr(403, NOPERM_403));
  check('권한 없음 403 → no_access', m403.status === 403 && m403.body.error === 'no_access');
  check('no_access 안내는 시트 공유 요청 문구', /공유를 요청/.test(m403.body.reasons[0]));
  check('no_access 안내에 서비스 계정 언급 없음', !/서비스 계정/.test(m403.body.reasons[0]));

  // details 가 본문 뒤쪽에 있어도(길어도) 스코프 부족을 놓치지 않는다
  const padded = JSON.parse(JSON.stringify(SCOPE_403));
  padded.error.details.unshift({ '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'x'.repeat(400), url: 'https://developers.google.com/' + 'y'.repeat(200) }] });
  check('긴 본문에서도 스코프 부족 판별',
    mapSheetsError(apiErr(403, padded)).body.error === 'insufficient_scope');

  // errors[].reason 만 있는(details 없는) 구형 응답도 잡는다
  const legacyScope = { error: { code: 403, message: 'Insufficient Permission', errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }] } };
  check('insufficientPermissions 만 있어도 스코프 부족',
    mapSheetsError(apiErr(403, legacyScope)).body.error === 'insufficient_scope');

  // (6) 404 는 no_access 가 아니라 not_found — 존재하지 않는 시트에 공유 요청을 보내게 하지 않는다
  const m404 = mapSheetsError(apiErr(404, NOTFOUND_404));
  check('404 → 404 not_found', m404.status === 404 && m404.body.error === 'not_found');
  check('not_found 안내는 주소 확인 유도', /주소|찾을 수 없/.test(m404.body.reasons[0]));
  check('not_found 안내에 공유 요청 문구 없음', !/공유를 요청/.test(m404.body.reasons[0]));

  // (7) 방어적 파싱 — 본문 없음/깨진 본문/비 JSON 에서도 throw 하지 않고 no_access 로 폴백
  check('본문 없는 403 → no_access', mapSheetsError(new Error('sheets_api_error 403 ')).body.error === 'no_access');
  check('본문 완전 부재 403 → no_access', mapSheetsError(new Error('sheets_api_error 403')).body.error === 'no_access');
  check('깨진 JSON 403 → no_access', mapSheetsError(apiErr(403, '{"error":{"code":403,')).body.error === 'no_access');
  check('HTML 본문 403 → no_access', mapSheetsError(apiErr(403, '<html><body>403 Forbidden</body></html>')).body.error === 'no_access');
  // 잘려서 JSON.parse 가 실패해도 표식이 남아 있으면 스코프 부족으로 인식
  check('잘린 본문이라도 표식 있으면 insufficient_scope',
    mapSheetsError(apiErr(403, '{"error":{"code":403,"errors":[{"reason":"insufficientPermissions"')).body.error === 'insufficient_scope');

  // (8) 429 는 그대로 상태코드 유지, 원본 메시지 미노출
  const m429 = mapSheetsError(apiErr(429, RATE_429));
  check('429 → 429 sheets_error', m429.status === 429 && m429.body.error === 'sheets_error');
  check('429 응답에 구글 원문 미노출', !/Quota exceeded/.test(JSON.stringify(m429.body)));

  // (9) 그 외는 원본 메시지 미노출
  const m500 = mapSheetsError(new Error('sheets_api_error 500 internal detail'));
  check('500 → sheets_error', m500.status === 500 && m500.body.error === 'sheets_error');
  check('sheets_error 는 원본 메시지 미노출', !/internal detail/.test(JSON.stringify(m500.body)));
  const mUnknown = mapSheetsError(new Error('random failure'));
  check('비-Sheets 오류 → 500 sheets_error', mUnknown.status === 500 && mUnknown.body.error === 'sheets_error');
  check('null 오류에도 throw 하지 않음', mapSheetsError(null).body.error === 'sheets_error');

  // (10) makeSheetsFetch 는 스코프 판별에 필요한 본문을 충분히 남긴다
  const scopeBody = JSON.stringify(SCOPE_403);
  const bigErrFetch = async function () {
    return { ok: false, status: 403, text: async function () { return scopeBody; }, json: async function () { return {}; } };
  };
  let thrown = null;
  try { await makeSheetsFetch('t', 'S', bigErrFetch)('/x'); } catch (e) { thrown = e; }
  check('makeSheetsFetch 403 본문 보존 → insufficient_scope 판별 가능',
    !!thrown && mapSheetsError(thrown).body.error === 'insufficient_scope');
})();

/* =========================================================
   클라이언트 토큰 계층(index.html @token-layer)
   — GIS 토큰 클라이언트만 가짜로 주입하고 requestSheetsToken/requestIdToken/awaitAuth/apiCall 은
     실제 코드를 그대로 실행한다(스텁으로 대체하지 않는다).
   ========================================================= */
await (async function () {
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');
  const start = html.indexOf('/* @token-layer-start');
  const endMark = html.indexOf('/* @token-layer-end */', start);
  check('index.html 에서 @token-layer 구간 추출', start > 0 && endMark > start);
  const src = html.slice(start, endMark);

  const tick = function (n) {
    let p = Promise.resolve();
    for (let i = 0; i < (n || 3); i++) p = p.then(function () {});
    return p;
  };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const resp = function (status, body) {
    return { status: status, ok: status >= 200 && status < 300, json: async function () { return body; } };
  };

  /* 가짜 GIS 토큰 클라이언트. behavior(client, nthCall) 가 콜백을 어떻게 호출할지 정한다. */
  const makeClient = function (behavior) {
    const c = { calls: [], callback: null, error_callback: null };
    c.requestAccessToken = function (o) {
      c.calls.push(o || {});
      behavior(c, c.calls.length);
    };
    return c;
  };
  /* n 번째 호출마다 access_token 을 주는 기본 동작(비동기 — 실제 팝업처럼) */
  const grants = function (prefix) {
    return function (c, n) { setTimeout(function () { c.callback({ access_token: (prefix || 'NEW') + n }); }, 0); };
  };

  /* 가짜 One Tap(google.accounts.id). prompt(momentListener) 가 어떻게 반응할지 behavior 가 정한다.
   * 실제 GIS 처럼 credential 은 initialize 콜백(=deliverIdToken)으로 들어온다. */
  const makeIdClient = function (behavior) {
    const c = { prompts: [] };
    c.prompt = function (listener) {
      c.prompts.push(listener);
      behavior(c, c.prompts.length, listener);
    };
    return c;
  };
  /* n 번째 prompt 마다 새 credential 을 돌려주는 기본 동작(비동기) */
  const issues = function (prefix) {
    return function (c, n) { setTimeout(function () { c.deliver((prefix || 'NEWID') + n); }, 0); };
  };
  const moment = function (o) {
    return {
      isNotDisplayed: function () { return !!o.notDisplayed; },
      isSkippedMoment: function () { return !!o.skipped; },
      isDismissedMoment: function () { return !!o.dismissed; },
      getDismissedReason: function () { return o.reason || ''; }
    };
  };

  /* 토큰 계층을 실제로 실행하는 하네스. DOM 은 배너 대역(fake)으로만 대체한다. */
  const build = function (fetchImpl, client, timeoutMs, idClient) {
    const banner = { shown: [], hidden: 0, grant: null, lastErr: null };
    const store = { idToken: 'ID_TOKEN' };
    const showReauthBanner = function (kind, onGrant) {
      banner.shown.push(kind);
      // 실제 배너처럼: 버튼 클릭 시에만 onGrant 가 호출된다.
      banner.grant = function (promptMode) {
        return onGrant(promptMode === undefined ? (kind === 'consent' ? 'consent' : '') : promptMode)
          .catch(function (e) { banner.lastErr = e; throw e; });
      };
    };
    const hideReauthBanner = function () { banner.hidden++; };
    const api = new Function(
      'DEV_MODE', 'getToken', 'setToken', 'fetch', 'tokenClient', 'idClient', 'onIdCredential',
      'showReauthBanner', 'hideReauthBanner', 'timeoutMs',
      'var sheetsToken = "OLD";' + src +
      '\nif (timeoutMs) { SHEETS_TOKEN_TIMEOUT_MS = timeoutMs; ID_TOKEN_TIMEOUT_MS = timeoutMs; }' +
      '\nreturn { apiCall: apiCall, apiFetch: apiFetch, requestSheetsToken: requestSheetsToken,' +
      '  requestIdToken: requestIdToken, deliverIdToken: deliverIdToken,' +
      '  gen: function () { return sheetsTokenGen; }, token: function () { return sheetsToken; },' +
      '  idGen: function () { return idTokenGen; },' +
      '  setAccessAt: function (t) { sheetsTokenAt = t; },' +
      '  idPending: function () { return !!idPending; },' +
      '  pending: function () { return !!tokenPending; } };'
    )(false, function () { return store.idToken; }, function (t) { store.idToken = t || ''; },
      fetchImpl, client, idClient || null, null, showReauthBanner, hideReauthBanner, timeoutMs);
    api.banner = banner;
    api.client = client;
    api.store = store;
    if (idClient) idClient.deliver = api.deliverIdToken;
    return api;
  };

  // (1) 정상 요청: 두 헤더가 모두 실린다
  let calls = [];
  let h = build(async function (p, o) { calls.push({ path: p, opts: o }); return resp(200, { ok: true }); },
    makeClient(grants()));
  let r = await h.apiCall('/api/state');
  check('apiCall → Authorization 에 ID 토큰', calls[0].opts.headers['Authorization'] === 'Bearer ID_TOKEN');
  check('apiCall → X-Sheets-Token 에 access 토큰', calls[0].opts.headers['X-Sheets-Token'] === 'OLD');
  check('apiCall 정상 응답 통과', r.status === 200 && r.data.ok === true);
  check('정상 응답에서는 팝업 없음', h.client.calls.length === 0 && h.banner.shown.length === 0);

  // (2) 401 sheets_token_expired → 자동 재발급 금지. 배너만 뜨고 팝업은 클릭 전까지 열리지 않는다.
  calls = [];
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1 ? resp(401, { ok: false, error: 'sheets_token_expired' }) : resp(200, { ok: true });
  }, makeClient(grants()));
  let p1 = h.apiCall('/api/state');
  await tick(5);
  check('만료 → 재허용 배너 노출', h.banner.shown.length === 1 && h.banner.shown[0] === 'expired');
  check('만료 → 클릭 전에는 requestAccessToken 호출 없음', h.client.calls.length === 0);
  check('만료 → 클릭 전에는 재시도도 없음', calls.length === 1);
  await h.banner.grant();          // 사용자가 [다시 허용] 클릭
  r = await p1;
  check('클릭 후 → requestAccessToken 1회', h.client.calls.length === 1);
  check('클릭 후 → 원래 요청을 그대로 1회 재시도', calls.length === 2 && calls[1].path === '/api/state');
  check('재시도는 갱신된 토큰 사용', calls[1].opts.headers['X-Sheets-Token'] === 'NEW1');
  check('재시도 성공 시 정상 응답 반환', r.status === 200 && r.data.ok === true);
  check('성공 후 배너 숨김', h.banner.hidden >= 1);
  check('만료 경로는 prompt 빈 문자열(재동의 화면 생략)', h.client.calls[0].prompt === '');

  // (3) POST 재시도 시 method/body/헤더가 보존된다
  calls = [];
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1 ? resp(401, { ok: false, error: 'sheets_token_expired' }) : resp(200, { ok: true });
  }, makeClient(grants()));
  const bodyStr = JSON.stringify({ moves: [{ row: 3, from: 1, to: 2 }], version: 'v1' });
  p1 = h.apiCall('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyStr });
  await tick(5);
  await h.banner.grant();
  r = await p1;
  check('POST 재시도 → method 보존', calls[1].opts.method === 'POST');
  check('POST 재시도 → body 원문 보존', calls[1].opts.body === bodyStr);
  check('POST 재시도 → 호출자 헤더 보존', calls[1].opts.headers['content-type'] === 'application/json');
  check('POST 재시도 → 경로 보존', calls[1].path === '/api/apply');
  check('POST 재시도 → 새 토큰 사용', calls[1].opts.headers['X-Sheets-Token'] === 'NEW1');

  // (4) 동시 401 두 건 → 배너 1회, 재발급 1회, 각자 재시도
  calls = [];
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return o.headers['X-Sheets-Token'] === 'OLD' ? resp(401, { ok: false, error: 'sheets_token_expired' }) : resp(200, { ok: true });
  }, makeClient(grants()));
  const both = Promise.all([h.apiCall('/api/state'), h.apiCall('/api/sheets')]);
  await tick(5);
  check('동시 401 → 배너 1회만', h.banner.shown.length === 1);
  await h.banner.grant();
  const rs = await both;
  check('동시 401 → 재발급(팝업) 1회만', h.client.calls.length === 1);
  check('동시 401 → 두 요청 모두 재시도 성공', rs[0].status === 200 && rs[1].status === 200);
  check('동시 401 → 총 4회 호출(각 2회)', calls.length === 4);

  // (5) 늦게 도착한 401 → 세대 카운터로 판별해 중복 팝업 없이 즉시 재시도
  calls = [];
  let releaseFirst = null;
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    if (calls.length === 1) return new Promise(function (res) { releaseFirst = res; });
    return resp(200, { ok: true });
  }, makeClient(grants()));
  p1 = h.apiCall('/api/state');           // gen 0 에서 전송, 응답은 보류
  await tick(5);
  await h.requestSheetsToken('');         // 다른 경로에서 토큰 갱신 → gen 1
  check('별도 갱신으로 세대 증가', h.gen() === 1);
  releaseFirst(resp(401, { ok: false, error: 'sheets_token_expired' }));   // 늦은 401 도착
  r = await p1;
  check('늦은 401 → 추가 팝업 없음', h.client.calls.length === 1);
  check('늦은 401 → 배너 없음', h.banner.shown.length === 0);
  check('늦은 401 → 새 토큰으로 즉시 재시도', calls.length === 2 && calls[1].opts.headers['X-Sheets-Token'] === 'NEW1');
  check('늦은 401 → 재시도 결과 반환', r.status === 200);

  // (6) GIS 가 콜백을 영영 부르지 않아도 타임아웃으로 빠져나온다(영구 pending 없음)
  const deadClient = makeClient(function () { /* 콜백도 error_callback 도 오지 않음 */ });
  h = build(async function () { return resp(200, { ok: true }); }, deadClient, 25);
  let caught = null;
  try { await h.requestSheetsToken(''); } catch (e) { caught = e; }
  check('GIS 무응답 → 타임아웃으로 reject', !!caught && /sheets_token_timeout/.test(caught.message));
  check('타임아웃 후 tokenPending 해제', h.pending() === false);
  // 죽은 promise 를 재사용하지 않고 새 요청이 실제로 나간다
  deadClient.requestAccessToken = function (o) {
    deadClient.calls.push(o);
    setTimeout(function () { deadClient.callback({ access_token: 'AFTER_TIMEOUT' }); }, 0);
  };
  const t2 = await h.requestSheetsToken('');
  check('타임아웃 후 재시도 가능(죽은 promise 재사용 안 함)', t2 === 'AFTER_TIMEOUT' && h.token() === 'AFTER_TIMEOUT');
  check('타임아웃 후 재시도로 세대 증가', h.gen() === 1);

  // (7) 팝업 닫힘(popup_closed) → 복구 가능: 배너 유지, 재클릭으로 성공하면 원 요청 재개
  calls = [];
  let attempt = 0;
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1 ? resp(401, { ok: false, error: 'sheets_token_expired' }) : resp(200, { ok: true });
  }, makeClient(function (c, n) {
    attempt = n;
    setTimeout(function () {
      if (n === 1) c.error_callback({ type: 'popup_closed' });
      else c.callback({ access_token: 'NEW_AFTER_CLOSE' });
    }, 0);
  }));
  p1 = h.apiCall('/api/state');
  await tick(5);
  caught = null;
  try { await h.banner.grant(); } catch (e) { caught = e; }
  check('popup_closed → 클릭 결과가 오류로 전달(배너가 안내 갱신 가능)',
    !!caught && /popup_closed/.test(caught.message));
  check('popup_closed → 원 요청은 아직 실패 처리되지 않음(재시도 여지 유지)', calls.length === 1);
  await h.banner.grant();          // 사용자가 다시 클릭
  r = await p1;
  check('재클릭 성공 → 원래 요청 재개', calls.length === 2 && r.status === 200);
  check('재클릭 성공 → 새 토큰 사용', calls[1].opts.headers['X-Sheets-Token'] === 'NEW_AFTER_CLOSE' && attempt === 2);

  // (8) 사용자가 동의를 거부(access_denied)해도 배너가 남아 복구 가능
  h = build(async function () { return resp(401, { ok: false, error: 'sheets_token_expired' }); },
    makeClient(function (c) { setTimeout(function () { c.callback({ error: 'access_denied' }); }, 0); }));
  p1 = h.apiCall('/api/state');
  p1.catch(function () {});
  await tick(5);
  caught = null;
  try { await h.banner.grant(); } catch (e) { caught = e; }
  check('access_denied → 클릭 결과가 오류로 전달', !!caught && /access_denied/.test(caught.message));
  check('access_denied → 배너는 숨겨지지 않음(흰 화면 없음)', h.banner.hidden === 0);
  check('access_denied → 다시 클릭할 수 있는 상태', typeof h.banner.grant === 'function');

  // (9) insufficient_scope(403) → prompt:'consent' 로 재동의를 요구한다
  calls = [];
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1
      ? resp(403, { ok: false, error: 'insufficient_scope', reasons: ['스코프 부족'] })
      : resp(200, { ok: true });
  }, makeClient(grants('SCOPED')));
  p1 = h.apiCall('/api/state');
  await tick(5);
  check('insufficient_scope → consent 배너', h.banner.shown[0] === 'consent');
  await h.banner.grant();
  r = await p1;
  check('insufficient_scope → prompt:consent 로 요청', h.client.calls[0].prompt === 'consent');
  check('insufficient_scope → 재동의 후 재시도 성공', calls.length === 2 && r.status === 200);

  // (10) 재허용 후에도 같은 401 → 로그인 화면으로 튕기지 않는 sheetsAccess 오류(작업 상태 보존)
  calls = [];
  h = build(async function (p, o) { calls.push({ path: p, opts: o }); return resp(401, { ok: false, error: 'sheets_token_expired' }); },
    makeClient(grants()));
  p1 = h.apiCall('/api/state');
  caught = null;
  p1 = p1.catch(function (e) { caught = e; });
  await tick(5);
  await h.banner.grant();
  await p1;
  check('재허용 후에도 401 → sheetsAccess 오류', !!caught && caught.sheetsAccess === true);
  check('재허용 후에도 401 → auth 오류 아님(로그인 화면으로 안 튕김)', caught.auth !== true);
  check('재시도는 1회뿐(총 2회 호출)', calls.length === 2);

  // (11) missing_sheets_token 도 같은 재허용 경로
  calls = [];
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1 ? resp(401, { ok: false, error: 'missing_sheets_token' }) : resp(200, { ok: true });
  }, makeClient(grants()));
  p1 = h.apiCall('/api/state');
  await tick(5);
  await h.banner.grant();
  r = await p1;
  check('missing_sheets_token → 재허용 후 재시도 성공', calls.length === 2 && r.status === 200);

  // (12) ID 토큰 만료(401 invalid_token) → 로그인 화면으로 튕기지 않고 같은 배너로 복구
  calls = [];
  let idc = makeIdClient(issues());
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1 ? resp(401, { ok: false, error: 'invalid_token' }) : resp(200, { ok: true });
  }, makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now());        // access 토큰은 방금 받아 아직 유효
  p1 = h.apiCall('/api/state');
  await tick(5);
  check('invalid_token → 재허용 배너(login) 노출', h.banner.shown.length === 1 && h.banner.shown[0] === 'login');
  check('invalid_token → 클릭 전 One Tap 없음', idc.prompts.length === 0);
  check('invalid_token → 클릭 전 재시도 없음', calls.length === 1);
  await h.banner.grant();           // 사용자가 [다시 허용] 클릭
  r = await p1;
  check('클릭 후 → One Tap 1회', idc.prompts.length === 1);
  check('클릭 후 → 원래 요청을 1회만 재시도', calls.length === 2 && calls[1].path === '/api/state');
  check('재시도는 새 ID 토큰 사용', calls[1].opts.headers['Authorization'] === 'Bearer NEWID1');
  check('새 ID 토큰이 저장된다', h.store.idToken === 'NEWID1');
  check('ID 토큰 세대 증가', h.idGen() === 1);
  check('access 토큰이 신선하면 시트 팝업은 열지 않는다', h.client.calls.length === 0);
  check('재시도 성공 시 정상 응답 반환', r.status === 200 && r.data.ok === true);
  check('성공 후 배너 숨김', h.banner.hidden >= 1);

  // (12b) ID 토큰 만료 재시도에서도 POST 의 method/body/헤더가 보존된다
  calls = [];
  idc = makeIdClient(issues());
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1 ? resp(401, { ok: false, error: 'expired' }) : resp(200, { ok: true });
  }, makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now());
  p1 = h.apiCall('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyStr });
  await tick(5);
  await h.banner.grant();
  r = await p1;
  check('ID 만료 POST 재시도 → method 보존', calls[1].opts.method === 'POST');
  check('ID 만료 POST 재시도 → body 원문 보존', calls[1].opts.body === bodyStr);
  check('ID 만료 POST 재시도 → 호출자 헤더 보존', calls[1].opts.headers['content-type'] === 'application/json');
  check('ID 만료 POST 재시도 → 경로 보존', calls[1].path === '/api/apply');

  // (12c) 두 토큰 동시 만료: 서버가 ID 토큰을 먼저 보므로 응답은 invalid_token 하나뿐 —
  //       배너도 하나, 클릭도 한 번으로 둘 다 갱신되어야 한다(두 번째 배너 금지).
  calls = [];
  idc = makeIdClient(issues());
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    if (o.headers['Authorization'] !== 'Bearer NEWID1') return resp(401, { ok: false, error: 'expired' });
    if (o.headers['X-Sheets-Token'] === 'OLD') return resp(401, { ok: false, error: 'sheets_token_expired' });
    return resp(200, { ok: true });
  }, makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now() - 55 * 60 * 1000);   // access 토큰도 만료 가능 시점
  p1 = h.apiCall('/api/state');
  await tick(5);
  check('동시 만료 → 배너는 하나만', h.banner.shown.length === 1 && h.banner.shown[0] === 'login');
  await h.banner.grant();
  r = await p1;
  check('동시 만료 → 한 번의 클릭으로 두 토큰 모두 갱신',
    idc.prompts.length === 1 && h.client.calls.length === 1);
  check('동시 만료 → 배너가 다시 뜨지 않음', h.banner.shown.length === 1);
  check('동시 만료 → 재시도 1회로 성공', calls.length === 2 && r.status === 200);
  check('동시 만료 → 재시도에 두 새 토큰이 모두 실림',
    calls[1].opts.headers['Authorization'] === 'Bearer NEWID1' &&
    calls[1].opts.headers['X-Sheets-Token'] === 'NEW1');

  // (12d) 동시 401 두 건(ID 만료) → 배너 1회, One Tap 1회, 각자 재시도
  calls = [];
  idc = makeIdClient(issues());
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return o.headers['Authorization'] === 'Bearer ID_TOKEN' ? resp(401, { ok: false, error: 'expired' }) : resp(200, { ok: true });
  }, makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now());
  const bothId = Promise.all([h.apiCall('/api/state'), h.apiCall('/api/sheets')]);
  await tick(5);
  check('ID 만료 동시 401 → 배너 1회만', h.banner.shown.length === 1);
  await h.banner.grant();
  const rsId = await bothId;
  check('ID 만료 동시 401 → One Tap 1회만', idc.prompts.length === 1);
  check('ID 만료 동시 401 → 두 요청 모두 재시도 성공', rsId[0].status === 200 && rsId[1].status === 200);
  check('ID 만료 동시 401 → 총 4회 호출(각 2회)', calls.length === 4);

  // (12e) 늦게 도착한 invalid_token → 세대 카운터로 판별해 배너 없이 즉시 재시도
  calls = [];
  releaseFirst = null;
  idc = makeIdClient(issues());
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    if (calls.length === 1) return new Promise(function (res) { releaseFirst = res; });
    return resp(200, { ok: true });
  }, makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now());
  p1 = h.apiCall('/api/state');
  await tick(5);
  await h.requestIdToken();                 // 다른 경로에서 ID 토큰 갱신 → idGen 1
  check('ID 토큰 별도 갱신으로 세대 증가', h.idGen() === 1);
  releaseFirst(resp(401, { ok: false, error: 'expired' }));   // 늦은 401 도착
  r = await p1;
  check('늦은 invalid_token → 추가 One Tap 없음', idc.prompts.length === 1);
  check('늦은 invalid_token → 배너 없음', h.banner.shown.length === 0);
  check('늦은 invalid_token → 새 토큰으로 즉시 재시도',
    calls.length === 2 && calls[1].opts.headers['Authorization'] === 'Bearer NEWID1');

  // (12f) 재취득 후에도 401 → 재시도는 1회뿐이고 그때는 auth 오류(로그인 화면)
  calls = [];
  idc = makeIdClient(issues());
  h = build(async function (p, o) { calls.push({ path: p, opts: o }); return resp(401, { ok: false, error: 'expired' }); },
    makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now());
  caught = null;
  p1 = h.apiCall('/api/state').catch(function (e) { caught = e; });
  await tick(5);
  await h.banner.grant();
  await p1;
  check('재취득 후에도 401 → auth 401(로그인 화면)', !!caught && caught.auth === true && caught.status === 401);
  check('ID 만료 재시도는 1회뿐(총 2회 호출)', calls.length === 2 && idc.prompts.length === 1);

  // (12g) One Tap 이 뜨지 못하면(id_unavailable) 배너로 복구 불가 → 로그인 화면행 오류로 알린다
  calls = [];
  idc = makeIdClient(function (c, n, listener) {
    setTimeout(function () { listener(moment({ notDisplayed: true })); }, 0);
  });
  h = build(async function (p, o) { calls.push({ path: p, opts: o }); return resp(401, { ok: false, error: 'expired' }); },
    makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now());
  p1 = h.apiCall('/api/state');
  p1.catch(function () {});
  await tick(5);
  caught = null;
  try { await h.banner.grant(); } catch (e) { caught = e; }
  check('One Tap 미표시 → id_unavailable 오류 전달', !!caught && /id_unavailable/.test(caught.message));
  check('One Tap 미표시 → 원 요청은 재시도되지 않음', calls.length === 1);
  check('One Tap 미표시 → pending 잔류 없음', h.idPending() === false);

  // (12h) One Tap 을 사용자가 닫으면(dismiss) 배너는 유지되고 다시 클릭해 복구할 수 있다
  calls = [];
  let idAttempt = 0;
  idc = makeIdClient(function (c, n, listener) {
    idAttempt = n;
    setTimeout(function () {
      if (n === 1) listener(moment({ dismissed: true, reason: 'cancel_called' }));
      else c.deliver('ID_AFTER_CANCEL');
    }, 0);
  });
  h = build(async function (p, o) {
    calls.push({ path: p, opts: o });
    return calls.length === 1 ? resp(401, { ok: false, error: 'expired' }) : resp(200, { ok: true });
  }, makeClient(grants()), 0, idc);
  h.setAccessAt(Date.now());
  p1 = h.apiCall('/api/state');
  await tick(5);
  caught = null;
  try { await h.banner.grant(); } catch (e) { caught = e; }
  check('One Tap 취소 → id_dismissed 오류(배너가 안내 갱신 가능)', !!caught && /id_dismissed/.test(caught.message));
  check('One Tap 취소 → 배너 숨겨지지 않음', h.banner.hidden === 0);
  await h.banner.grant();
  r = await p1;
  check('One Tap 재클릭 성공 → 원래 요청 재개', calls.length === 2 && r.status === 200 && idAttempt === 2);
  check('One Tap 재클릭 성공 → 새 ID 토큰 사용', calls[1].opts.headers['Authorization'] === 'Bearer ID_AFTER_CANCEL');

  // (12i) credential 이 영영 오지 않아도 타임아웃으로 빠져나온다(영구 pending 금지)
  idc = makeIdClient(function () { /* 아무 응답도 없음 */ });
  h = build(async function () { return resp(200, { ok: true }); }, makeClient(grants()), 25, idc);
  caught = null;
  try { await h.requestIdToken(); } catch (e) { caught = e; }
  check('One Tap 무응답 → 타임아웃으로 reject', !!caught && /id_token_timeout/.test(caught.message));
  check('One Tap 타임아웃 후 pending 해제', h.idPending() === false);

  // (12j) idClient 가 없으면 즉시 reject — 영구 pending 금지
  h = build(async function () { return resp(200, { ok: true }); }, makeClient(grants()), 25, null);
  caught = null;
  try { await h.requestIdToken(); } catch (e) { caught = e; }
  check('idClient 없음 → 즉시 reject', !!caught && /id_client_unavailable/.test(caught.message));

  // (12k) missing_token(헤더 자체가 없음)은 재취득 대상이 아니다 → 배너 없이 auth 401
  calls = [];
  idc = makeIdClient(issues());
  h = build(async function (p, o) { calls.push({ path: p, opts: o }); return resp(401, { ok: false, error: 'missing_token' }); },
    makeClient(grants()), 0, idc);
  caught = null;
  try { await h.apiCall('/api/state'); } catch (e) { caught = e; }
  check('missing_token → 재시도/배너 없음', calls.length === 1 && h.banner.shown.length === 0 && idc.prompts.length === 0);
  check('missing_token → auth 401', !!caught && caught.auth === true && caught.status === 401);

  // (13) no_access(403) / not_found(404) 는 throw 하지 않고 본문을 그대로 넘긴다
  h = build(async function () { return resp(403, { ok: false, error: 'no_access', reasons: ['권한 없음'] }); }, makeClient(grants()));
  r = await h.apiCall('/api/state');
  check('no_access(403) 는 본문 그대로 전달', r.status === 403 && r.data.error === 'no_access');
  check('no_access 에서는 팝업/배너 없음', h.client.calls.length === 0 && h.banner.shown.length === 0);

  h = build(async function () { return resp(404, { ok: false, error: 'not_found', reasons: ['없음'] }); }, makeClient(grants()));
  r = await h.apiCall('/api/state');
  check('not_found(404) 는 본문 그대로 전달', r.status === 404 && r.data.error === 'not_found');

  // (14) 그 외 403(도메인)은 auth 오류
  h = build(async function () { return resp(403, { ok: false, error: 'domain_not_allowed' }); }, makeClient(grants()));
  caught = null;
  try { await h.apiCall('/api/state'); } catch (e) { caught = e; }
  check('domain_not_allowed(403) → auth 403', !!caught && caught.auth === true && caught.status === 403);

  // (15) tokenClient 가 없으면(스크립트 로드 실패) 즉시 reject — 영구 pending 금지
  h = build(async function () { return resp(200, { ok: true }); }, null, 25);
  caught = null;
  try { await h.requestSheetsToken(''); } catch (e) { caught = e; }
  check('tokenClient 없음 → 즉시 reject', !!caught && /token_client_unavailable/.test(caught.message));
  check('tokenClient 없음 → pending 잔류 없음', h.pending() === false);

  // (16) requestAccessToken 이 동기 throw 해도 reject 되고 pending 이 남지 않는다
  const throwClient = makeClient(function () { throw new Error('popup_failed_to_open'); });
  h = build(async function () { return resp(200, { ok: true }); }, throwClient, 25);
  caught = null;
  try { await h.requestSheetsToken(''); } catch (e) { caught = e; }
  check('requestAccessToken 동기 throw → reject', !!caught && /popup_failed_to_open/.test(caught.message));
  check('동기 throw 후 pending 잔류 없음', h.pending() === false);
})();


/* =========================================================
   22. 데이터 파괴 방지 — D1 설정 조회 실패 / D2 쓰기 탭 폴백 / D4 clear→write 비원자성
   ========================================================= */
await (async function () {
  const CFG_TAB = '설정';
  const listWithConfig = [{ title: 'revised' }, { title: CFG_TAB }];
  const listWithoutConfig = [{ title: 'revised' }];
  const rawConfig = [['[고정블록]'], ['슬롯', '라벨', '적용학년'], ['월3', 'Counseling', '전체']];

  /* ---- D1: 일시적 조회 오류가 "설정 탭 없음"으로 둔갑하면 안 된다 ---- */

  // (1) 설정 탭이 실제로 없음 → 조회 시도조차 하지 않고 빈 config + 빈 해시(정상 저장 가능)
  let getCalls = 0;
  const absent = await readConfigWithVersion({
    batchGet: async function () { getCalls++; throw new Error('호출되면 안 됨'); },
    parseConfig: parseConfig, hashValues: hashValues
  }, listWithoutConfig, CFG_TAB);
  check('D1 설정 탭 부재 → batchGet 미호출', getCalls === 0);
  check('D1 설정 탭 부재 → unavailable false', absent.unavailable === false);
  check('D1 설정 탭 부재 → version === hashValues([])', absent.version === hashValues([]));
  check('D1 설정 탭 부재 → config.missing true', absent.config.missing === true);

  // (2) 설정 탭은 있는데 조회가 실패(429/503/네트워크) → 빈 config로 위장하지 않는다
  let logged = null;
  const failed = await readConfigWithVersion({
    batchGet: async function () { throw new Error('sheets_api_error 429 rate limit exceeded'); },
    parseConfig: parseConfig, hashValues: hashValues,
    onError: function (e) { logged = e; }
  }, listWithConfig, CFG_TAB);
  check('D1 조회 실패 → unavailable true', failed.unavailable === true);
  check('D1 조회 실패 → version null (빈 해시 위장 없음)', failed.version === null);
  check('D1 조회 실패 → raw null', failed.raw === null);
  check('D1 조회 실패 → onError로 원인 전달(로깅 가능)',
    logged !== null && /429/.test(String(logged.message)));

  // (3) 회귀 핵심: 조회 실패 버전이 "빈 해시"와 같으면 낙관적 락이 무력화된다
  check('D1 조회 실패 version !== hashValues([]) (낙관적 락 무력화 방지)',
    failed.version !== hashValues([]));
  check('D1 조회 실패 version !== 실제 설정 해시', failed.version !== hashValues(rawConfig));

  // (4) 정상 조회 → 실제 값 기준 해시 + raw 보존(D4의 prevRowCount 계산에 사용)
  const okCfg = await readConfigWithVersion({
    batchGet: async function (ranges) {
      check('D1 정상 조회 범위는 A:C', eq(ranges, ["'" + CFG_TAB + "'!A:C"]));
      return [rawConfig];
    },
    parseConfig: parseConfig, hashValues: hashValues
  }, listWithConfig, CFG_TAB);
  check('D1 정상 조회 → unavailable false', okCfg.unavailable === false);
  check('D1 정상 조회 → version === hashValues(raw)', okCfg.version === hashValues(rawConfig));
  check('D1 정상 조회 → raw 행 수 보존', okCfg.raw.length === 3);
  check('D1 정상 조회 → fixedBlocks 파싱', okCfg.config.fixedBlocks.length === 1);

  // (5) 실제 파괴 경로 재현: /api/state 조회 실패 → 클라이언트가 그때 받은 버전으로 저장 →
  //     서버 재조회도 실패. 옛 코드는 양쪽 모두 hashValues([]) 라 락을 통과해 설정을 전멸시켰다.
  //     handleConfig 의 가드 순서(unavailable 먼저)를 그대로 흉내 낸다.
  async function saveGuard(batchGet, sheetsList, baseConfigVersion) {
    const cur = await readConfigWithVersion(
      { batchGet: batchGet, parseConfig: parseConfig, hashValues: hashValues }, sheetsList, CFG_TAB);
    if (cur.unavailable) return { status: 503, error: 'config_unavailable' };
    if (baseConfigVersion !== cur.version) return { status: 409, error: 'stale_config' };
    return { status: 200, error: null, prevRowCount: (cur.raw || []).length };
  }
  const flaky = async function () { throw new Error('sheets_api_error 503 backend error'); };
  // 클라이언트가 조회 실패 때 받은 값(null)을 그대로 보내도 저장은 거부되어야 한다
  check('D1 조회 실패 상태 + baseVersion null → 503 config_unavailable',
    eq(await saveGuard(flaky, listWithConfig, null), { status: 503, error: 'config_unavailable' }));
  // 옛 버그 값(빈 해시)을 보내도 마찬가지
  check('D1 조회 실패 상태 + baseVersion 빈해시 → 503 (설정 전멸 경로 차단)',
    eq(await saveGuard(flaky, listWithConfig, hashValues([])), { status: 503, error: 'config_unavailable' }));
  // 설정 탭이 진짜 없을 때는 빈 해시로 정상 저장(최초 생성) 가능해야 한다 — 과잉 차단 방지
  check('D1 설정 탭 부재 + baseVersion 빈해시 → 저장 허용(최초 생성)',
    (await saveGuard(flaky, listWithoutConfig, hashValues([]))).status === 200);
  // 정상 조회 시 낙관적 락은 그대로 동작
  const okGet2 = async function () { return [rawConfig]; };
  check('D1 정상 + 최신 버전 → 저장 허용(prevRowCount 전달)',
    eq(await saveGuard(okGet2, listWithConfig, hashValues(rawConfig)), { status: 200, error: null, prevRowCount: 3 }));
  check('D1 정상 + 낡은 버전 → 409 stale_config',
    (await saveGuard(okGet2, listWithConfig, 'stale')).status === 409);

  /* ---- D2: 쓰기 경로는 없는 탭을 다른 탭으로 폴백하지 않는다 ---- */
  const tabs = [{ title: 'revised' }, { title: 'revised (사본1)' }];
  check('D2 존재하는 탭 → 그대로 사용',
    eq(resolveApplyTab(tabs, 'revised (사본1)'), { tab: 'revised (사본1)' }));
  check('D2 없는 탭(삭제·개명) → tab_not_found (revised 폴백 금지)',
    eq(resolveApplyTab(tabs, 'revised (사본2)'), { error: 'tab_not_found' }));
  check('D2 탭 미지정 → 자동 선택 위임(null)', eq(resolveApplyTab(tabs, ''), { tab: null }));
  check('D2 탭 undefined → 자동 선택 위임(null)', eq(resolveApplyTab(tabs, undefined), { tab: null }));
  check('D2 빈 시트목록 + 탭 지정 → tab_not_found',
    eq(resolveApplyTab([], 'revised'), { error: 'tab_not_found' }));

  /* ---- D4: clear 없는 범위 지정 덮어쓰기 ---- */
  function recordingFetch() {
    const calls = [];
    const sf = async function (path, init) {
      calls.push({ path: path, body: init && init.body ? JSON.parse(init.body) : null });
      return {};
    };
    sf.calls = calls;
    return sf;
  }

  // (1) 이전 내용이 더 길 때 → 잔여 행이 빈 값으로 덮여 지워진다
  const sf1 = recordingFetch();
  await overwriteSheetRange(sf1, CFG_TAB, [['[고정블록]'], ['월3', 'X', '전체']], 3, 5);
  check('D4 clear 호출 없음', sf1.calls.every(function (c) { return !/:clear/.test(c.path); }));
  check('D4 단일 요청으로 완료(비원자 구간 없음)', sf1.calls.length === 1);
  const d1 = sf1.calls[0].body.data[0];
  check('D4 범위는 A1:C5 (이전 행 수까지 포함)', d1.range === "'" + CFG_TAB + "'!A1:C5");
  check('D4 잔여 행 3개가 빈 값으로 채워짐',
    d1.values.length === 5 && eq(d1.values.slice(2), [['', '', ''], ['', '', ''], ['', '', '']]));
  check('D4 짧은 행은 C열까지 빈 값 패딩', eq(d1.values[0], ['[고정블록]', '', '']));

  // (2) D열은 범위에 포함되지 않는다 → 메모·보조 데이터 보존
  check('D4 범위에 D열 이후 미포함', !/![A-Z]*1:[D-Z]/.test(d1.range));

  // (3) 새 내용이 더 길 때 → 새 길이만큼만
  const sf2 = recordingFetch();
  await overwriteSheetRange(sf2, CFG_TAB, [['a'], ['b'], ['c']], 3, 1);
  check('D4 새 내용이 더 길면 새 길이 사용', sf2.calls[0].body.data[0].range === "'" + CFG_TAB + "'!A1:C3");

  // (4) 쓸 것도 지울 것도 없으면 요청 자체를 보내지 않는다
  const sf3 = recordingFetch();
  const res3 = await overwriteSheetRange(sf3, CFG_TAB, [], 3, 0);
  check('D4 빈 값 + 이전 없음 → 요청 없음', sf3.calls.length === 0 && res3 === null);

  // (5) padRows 경계: 긴 행은 잘라내고 짧은 행은 채운다
  check('D4 padRows 폭 정규화', eq(padRows([['a', 'b', 'c', 'd'], ['x']], 3), [['a', 'b', 'c'], ['x', '', '']]));
})();

/* =========================================================
   빈 sheetId — 배포 기본값(SPREADSHEET_ID)이 비고 요청에도 없을 때
   Sheets 를 호출하지 않고 no_sheet_selected(400) 로 끊는다.
   ========================================================= */
(function () {
  // 1) 순수 해석기
  check('resolveSheetId: 둘 다 비면 빈 문자열', resolveSheetId('', '') === '' &&
    resolveSheetId(null, undefined) === '' && resolveSheetId('   ', '') === '');
  check('resolveSheetId: 요청값 없으면 배포 기본값 사용', resolveSheetId('', 'ENV_ID') === 'ENV_ID' &&
    resolveSheetId(null, 'ENV_ID') === 'ENV_ID');
  check('resolveSheetId: 요청값이 기본값을 이긴다', resolveSheetId('REQ_ID', 'ENV_ID') === 'REQ_ID');
  check('resolveSheetId: 공백 제거', resolveSheetId(' REQ_ID ', '') === 'REQ_ID');

  // 2) 값이 있으면 기존대로 해당 시트로 Sheets 호출이 나간다
  let calledUrl = '';
  const sf = makeSheetsFetch('tok', resolveSheetId('', 'ENV_ID'), function (url) {
    calledUrl = url;
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
  });
  sf('/values/A1', { method: 'GET' });
  check('빈 요청값 + 기본값 있음 → 기본 시트로 Sheets 호출', calledUrl.indexOf('/spreadsheets/ENV_ID') > -1);

  // 3) 라우팅: 각 API 경로가 makeSheetsFetch 이전에 빈 sheetId 를 끊는다
  const w = readFileSync(join(__dir, '../src/worker.js'), 'utf8');
  check('noSheetSelected 헬퍼가 400 no_sheet_selected 반환',
    /function noSheetSelected\(\)[\s\S]*?no_sheet_selected[\s\S]*?\}, 400\)/.test(w));
  ['/api/sheets', '/api/state', '/api/apply', '/api/duplicate-tab', '/api/config'].forEach(function (p) {
    const start = w.indexOf("if (path === '" + p + "'", w.indexOf('const sheetsToken'));
    const next = w.indexOf("if (path === '", start + 10);   // 다음 라우트 직전까지만 본다
    const block = w.slice(start, next > start ? next : start + 700);
    check('빈 sheetId 가드 존재: ' + p, /if \(!sheetId\) return noSheetSelected\(\);/.test(block));
    check('가드가 makeSheetsFetch 보다 앞: ' + p,
      block.indexOf('noSheetSelected()') > -1 &&
      block.indexOf('noSheetSelected()') < block.indexOf('makeSheetsFetch'));
    check('env.SPREADSHEET_ID 직접 || 폴백 제거: ' + p, !/\|\| env\.SPREADSHEET_ID/.test(block));
  });

  // 4) 배포 기본값은 빈 값으로 출고된다(공개 저장소)
  const wr = readFileSync(join(__dir, '../wrangler.jsonc'), 'utf8');
  check('wrangler.jsonc SPREADSHEET_ID 기본값 비어 있음', /"SPREADSHEET_ID"\s*:\s*""/.test(wr));

  // 5) 클라이언트: 오류 화면이 아니라 시트 입력 안내로 시작한다
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');
  check('클라이언트 isNoSheet 판별 존재', /function isNoSheet\(r\)[\s\S]*?no_sheet_selected/.test(html));
  check('클라이언트 renderNoSheet 가 시트 입력 안내 표시',
    /function renderNoSheet\(\)[\s\S]*?setupSheetInput\(\)[\s\S]*?URL 또는 ID/.test(html));
  const loadSheetsFn = html.slice(html.indexOf('function loadSheets()'), html.indexOf('function isNoSheet'));
  check('loadSheets 가 no_sheet_selected 를 안내 화면으로 처리',
    /isNoSheet\(r\)\) \{ renderNoSheet\(\); return false; \}/.test(loadSheetsFn));
  const loadStateFn = html.slice(html.indexOf('function loadState(sheetId, tab)'), html.indexOf('function onState'));
  check('loadState 가 no_sheet_selected 를 안내 화면으로 처리',
    /isNoSheet\(r\)\) \{ renderNoSheet\(\); return; \}/.test(loadStateFn));
})();

/* =========================================================
   worker.js 정적 검증 — 데이터 파괴 경로가 코드에 남아 있지 않은지
   (worker.js 는 index.html/core 를 텍스트로 import 해 Node 에서 직접 import 불가)
   ========================================================= */
(function () {
  const w = readFileSync(join(__dir, '../src/worker.js'), 'utf8');
  const sh = readFileSync(join(__dir, '../src/lib/sheets.js'), 'utf8');

  // D1: 설정 저장 전 unavailable 검사 → 503 config_unavailable
  check('D1 handleConfig 에 config_unavailable 503 경로 존재',
    /config_unavailable/.test(w) && /\}, 503\)/.test(w));
  const cfgFn = w.slice(w.indexOf('async function handleConfig(sf'), w.indexOf('DEV MODE 핸들러'));
  check('D1 unavailable 검사가 쓰기(overwriteSheetRange)보다 앞',
    cfgFn.indexOf('cur.unavailable') > -1 &&
    cfgFn.indexOf('cur.unavailable') < cfgFn.indexOf('overwriteSheetRange'));
  check('D1 handleConfig 에 빈 해시 폴백(hashValues([])) 없음', !/hashValues\(\[\]\)/.test(cfgFn));

  // D2: apply 경로에서 tab_not_found 가 어떤 쓰기보다 앞
  const applyFn = w.slice(w.indexOf('async function handleApply(sf'), w.indexOf('async function handleDuplicateTab'));
  check('D2 handleApply 에 tab_not_found 400 존재', /tab_not_found/.test(applyFn));
  check('D2 tab_not_found 검사가 batchUpdateValues 보다 앞',
    applyFn.indexOf('tab_not_found') < applyFn.indexOf('batchUpdateValues'));
  check('D2 handleApply 이 body.tab 을 pickTimetableTab 으로 폴백하지 않음',
    !/body\.tab.*\n?.*pickTimetableTab/.test(applyFn));
  // dev 핸들러도 동일 계약 미러링
  check('D2 dev apply 도 tab_not_found 미러링',
    /function handleApplyDev/.test(w) &&
    w.slice(w.indexOf('function handleApplyDev')).indexOf('tab_not_found') > -1);

  // D3: 은닉된 오류가 로그로는 남는다
  check('D3 logError 헬퍼 존재', /function logError\(/.test(w));
  check('D3 console.error 사용', /console\.error\(/.test(w));
  check('D3 mapSheetsError 직전 로깅', /logError\('sheets_api'/.test(w));
  // 합쳐 읽기 도입 후: 조회 실패는 readSide 가 'side:<key>' 로, 파싱 실패는 각 사이트가 로깅한다
  check('D3 합쳐 읽기의 범위별 실패 로깅', /logError\('side:'\s*\+/.test(w));
  ['readConfigWithVersion', 'readLinkedPinned', 'electives', 'parseDepts', 'dev_handler']
    .forEach(function (site) {
      check('D3 무음 catch 로깅: ' + site, w.indexOf("logError('" + site + "'") > -1);
    });
  // 토큰·시트 내용을 로그에 넣지 않는다
  check('D3 로그에 토큰/그리드 미포함', !/console\.error\([^)]*(token|grid|values)/i.test(w));

  // D4: 탭 전체 clear 경로 제거
  check('D4 rewriteSheetValues 제거됨', !/rewriteSheetValues/.test(w) && !/rewriteSheetValues/.test(sh));
  check('D4 sheets.js 에 :clear 호출 없음', !/:clear/.test(sh));
})();

/* =========================================================
   로그아웃(index.html @logout) — 실제 doLogout 소스를 그대로 실행한다.
   DOM(showLogin/closeOverlays)과 GIS(google)만 가짜로 주입한다.
   ========================================================= */
(function () {
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');
  const start = html.indexOf('/* @logout-start');
  const endMark = html.indexOf('/* @logout-end */', start);
  check('index.html 에서 @logout 구간 추출', start > 0 && endMark > start);
  const src = html.slice(start, endMark);

  /* devMode / confirm 응답 / STATE 초기값을 바꿔가며 doLogout 을 실행한다. */
  const build = function (opts) {
    const o = opts || {};
    const env = {
      stored: { idToken: 'ID_TOKEN', recent: 'SHEET_1' },   // recent 는 로그아웃해도 남아야 한다
      confirms: [],
      login: [],
      overlaysClosed: 0,
      autoSelectDisabled: 0
    };
    const setToken = function (t) { env.stored.idToken = t || ''; };
    const confirmFn = function (msg) { env.confirms.push(msg); return !!o.confirmYes; };
    const showLogin = function (msg) { env.login.push(msg); };
    const closeOverlays = function () { env.overlaysClosed++; };
    const google = o.noGis ? undefined : {
      accounts: { id: { disableAutoSelect: function () { env.autoSelectDisabled++; } } }
    };
    const STATE = Object.assign({
      target: null, plan: null, planTo: null, cellMap: null, undoStack: [],
      grid: null, config: null, model: null, user: 'a@b.c',
      unavailMode: false, unavailDirty: false
    }, o.state || {});

    const api = new Function(
      'DEV_MODE', 'setToken', 'confirm', 'google', 'STATE', 'SETTINGS_DIRTY', 'DRAFT', 'showLogin', 'closeOverlays',
      'var sheetsToken = "ACCESS_TOKEN"; var sheetsTokenAt = 12345; var onIdCredential = function () {};' +
      'var sheetsTokenGen = 7; var idTokenGen = 3;' +
      'var tokenPending = {}; var idPending = {}; var authPending = {};' + src +
      '\nreturn { doLogout: doLogout, hasUnsavedWork: hasUnsavedWork,' +
      '  sheetsToken: function () { return sheetsToken; },' +
      '  gen: function () { return sheetsTokenGen; },' +
      '  idGen: function () { return idTokenGen; },' +
      '  idCb: function () { return onIdCredential; },' +
      '  pending: function () { return [tokenPending, idPending, authPending]; },' +
      '  settingsDirty: function () { return SETTINGS_DIRTY; },' +
      '  draft: function () { return DRAFT; } };'
    )(!!o.devMode, setToken, confirmFn, google, STATE, !!o.settingsDirty, o.draft || null, showLogin, closeOverlays);
    api.env = env;
    api.STATE = STATE;
    return api;
  };

  // (1) 깨끗한 상태: 확인 없이 바로 로그아웃되고 토큰이 실제로 지워진다
  let h = build({});
  h.doLogout();
  check('로그아웃: 확인 대화상자 없음(미저장 변경 없을 때)', h.env.confirms.length === 0);
  check('로그아웃: ID 토큰 삭제', h.env.stored.idToken === '');
  check('로그아웃: 메모리 sheetsToken 초기화', h.sheetsToken() === '');
  check('로그아웃: 토큰 세대 증가', h.gen() === 8);
  check('로그아웃: 진행 중 토큰 요청 해제', h.pending().every((p) => p === null));
  check('로그아웃: ID 토큰 세대 증가', h.idGen() === 4);
  check('로그아웃: 대기 중인 credential 콜백 해제', h.idCb() === null);
  check('로그아웃: disableAutoSelect 호출', h.env.autoSelectDisabled === 1);
  check('로그아웃: 최근 시트(RECENT_KEY) 보존', h.env.stored.recent === 'SHEET_1');
  check('로그아웃: 로그인 화면 복귀', h.env.login.length === 1 && /로그아웃/.test(h.env.login[0]));
  check('로그아웃: 오버레이 정리', h.env.overlaysClosed === 1);

  // (2) 진행 중 상태 정리
  h = build({ state: { plan: { steps: [1] }, undoStack: [{ summary: 'x' }], user: 'me@x.org' }, draft: { fixedBlocks: [] } });
  h.doLogout();   // plan 이 있으므로 confirm → 기본 build 는 confirmYes=false
  check('로그아웃: 미확정 이동 계획이면 확인 대화상자', h.env.confirms.length === 1 && /저장하지 않은 변경이 있습니다/.test(h.env.confirms[0]));
  check('로그아웃: 확인 거부하면 토큰 유지', h.env.stored.idToken === 'ID_TOKEN');
  check('로그아웃: 확인 거부하면 로그인 화면으로 가지 않음', h.env.login.length === 0);
  check('로그아웃: 확인 거부하면 계획도 유지', h.STATE.plan !== null);

  // (3) 확인 수락 → 진행 중 상태까지 정리된다
  h = build({ confirmYes: true, state: { plan: { steps: [1] }, undoStack: [{ summary: 'x' }], unavailMode: true }, draft: { fixedBlocks: [] }, settingsDirty: true });
  h.doLogout();
  check('로그아웃: 확인 수락 시 ID 토큰 삭제', h.env.stored.idToken === '');
  check('로그아웃: STATE.plan 정리', h.STATE.plan === null && h.STATE.target === null && h.STATE.planTo === null);
  check('로그아웃: 되돌리기 스택 비움', h.STATE.undoStack.length === 0);
  check('로그아웃: 모드 해제', h.STATE.unavailMode === false);
  check('로그아웃: 사용자 정보 제거', h.STATE.user === '');
  check('로그아웃: 설정 초안 정리', h.draft() === null && h.settingsDirty() === false);

  // (4) 미저장 판정: 설정 초안 dirty / 불가시간 dirty 도 경고 대상
  check('미저장 판정: 설정 모달 dirty', build({ settingsDirty: true }).hasUnsavedWork() === true);
  check('미저장 판정: 불가 시간 dirty', build({ state: { unavailDirty: true } }).hasUnsavedWork() === true);
  check('미저장 판정: 확정된 이동(undoStack)은 미저장이 아님', build({ state: { undoStack: [{ summary: 'x' }] } }).hasUnsavedWork() === false);
  check('미저장 판정: 깨끗한 상태', build({}).hasUnsavedWork() === false);

  // (5) DEV_MODE 에서는 아무 일도 하지 않는다
  h = build({ devMode: true });
  h.doLogout();
  check('DEV_MODE: 로그아웃 동작 없음', h.env.stored.idToken === 'ID_TOKEN' && h.env.login.length === 0);

  // (6) GIS 스크립트가 없어도 로그아웃은 끝까지 진행된다
  h = build({ noGis: true });
  h.doLogout();
  check('GIS 미로드: 토큰은 그래도 삭제', h.env.stored.idToken === '' && h.env.login.length === 1);

  // 정적: 버튼 마크업 / 배선 / revoke 금지 / RECENT_KEY 미삭제
  check('로그아웃 버튼 마크업 존재', /id="btnLogout"/.test(html));
  check('로그아웃 버튼 클릭 배선', /getElementById\('btnLogout'\)\.addEventListener\('click', doLogout\)/.test(html));
  check('DEV_MODE 에서 로그아웃 버튼 숨김', /if \(DEV_MODE\) show\('btnLogout', false\)/.test(html));
  check('구글 계정 권한 revoke 하지 않음', !/accounts\.id\.revoke|revoke\(/.test(html));
  check('로그아웃이 RECENT_KEY 를 지우지 않음', !/removeItem\(RECENT_KEY\)/.test(html));
})();

/* =========================================================
   index.html 정적 검증 — 자동 재발급/흰 화면 경로가 남아 있지 않은지
   ========================================================= */
(function () {
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');
  // GSI ID 콜백 안에서 access token 을 자동 요청하지 않는다(제스처 소멸 → 팝업 차단)
  const gsiCb = html.slice(html.indexOf('google.accounts.id.initialize'), html.indexOf('renderButton'));
  check('GSI ID 콜백에서 requestSheetsToken 자동 호출 없음', !/requestSheetsToken/.test(gsiCb));
  // 메시지 정규식으로 오류를 분류하던 경로 제거
  check('enterApp 의 정규식 오류 매칭 제거', !/sheets_token\|token_client/.test(html));
  // 복구 UI 존재
  check('재허용 배너 마크업 존재', /id="reauthBanner"/.test(html) && /id="reauthBtn"/.test(html));
  check('시트 권한 허용 버튼 마크업 존재', /id="btnSheetsGrant"/.test(html));
  // GIS 실제 오류 타입 안내 문구
  ['popup_closed', 'popup_failed_to_open', 'access_denied', 'sheets_token_timeout'].forEach(function (t) {
    check('GIS 오류 안내 처리: ' + t, new RegExp(t).test(html));
  });
  // renderNoAccess 는 ID 토큰에서 이메일을 얻는다
  check('renderNoAccess 계정 표시에 idTokenEmail 사용', /STATE\.user \|\| idTokenEmail\(\)/.test(html));
})();

/* =========================================================
   툴바 정리(index.html 정적 검증)
   — 설정 모드 삭제 / RA행 버튼 토글 / 미분류 카운트 삭제 / 공강 현황 탭
   ========================================================= */
(function () {
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');

  // (1) '설정 모드'가 UI·상태·분기 어디에도 남아 있지 않다
  check('설정 모드 토글 마크업 제거', !/setModeToggle|setModeCheck/.test(html));
  check('STATE.setMode 상태 제거', !/setMode/.test(html));
  check('body.set-mode 스타일/토글 제거', !/set-mode/.test(html));
  // 설정 모드에서만 도달하던 슬롯 금지 팝업(열 머리글 클릭) 경로가 통째로 제거됐다
  check('열 머리글 클릭 핸들러 제거', !/onHeaderClick/.test(html));
  check('슬롯 금지 팝업(slotPop) 잔재 없음', !/slotPop|SlotPopup|saveSlotBlock|removeSlotBlock/.test(html));
  // 안내 문구가 사라진 '설정 모드'를 더 이상 가리키지 않는다
  const blockSecStart = html.indexOf('data-tab="block"><h3>금지 슬롯 규칙');
  const blockSec = html.slice(blockSecStart, html.indexOf('data-tab="group"><h3>', blockSecStart));
  check('금지 슬롯 안내 문구에서 설정 모드 언급 제거', blockSec.length > 0 && !/설정 모드/.test(blockSec));

  // (2) RA행: 체크박스가 아니라 '불가 시간'과 같은 모드 버튼
  check('RA행 체크박스 제거', !/id="raCheck"/.test(html));
  check('RA행 모드 버튼 마크업', /<button id="btnRaRows" type="button" class="tb-mode"/.test(html));
  check('RA행/불가 시간 버튼 스타일 통일(tb-mode)', /id="btnUnavailMode" type="button" class="tb-mode"/.test(html)
    && /#toolbar button\.tb-mode\.active/.test(html));
  const raBind = html.slice(html.indexOf("getElementById('btnRaRows')"), html.indexOf("getElementById('btnConfirm')"));
  check('RA행 버튼이 show-ra 를 토글', /classList\.toggle\('show-ra'\)/.test(raBind));
  check('RA행 버튼이 active 상태를 표시', /classList\.toggle\('active', on\)/.test(raBind));
  check('RA행 버튼이 셀 크기 재계산(fitCells) 호출', /fitCells\(\)/.test(raBind));
  check('RA행 표시 CSS 유지', /body\.show-ra table\.grid tr\.ra-row \{ display: table-row; \}/.test(html));

  // (3) 툴바에서 '미분류 N'은 사라지되, 설정 탭 없음 안내와 경고는 남는다
  const noteFn = html.slice(html.indexOf('function updateToolbarNote()'), html.indexOf('function setGroupHint'));
  check('툴바 알림 함수 존재', noteFn.length > 0);
  check('툴바에서 미분류 카운트 제거', !/미분류/.test(noteFn));
  check('설정 탭 없음 안내 유지', /설정 탭이 없습니다 — \[설정\]에서 규칙을 저장하면 생성됩니다/.test(noteFn));
  check('고정시간 인식불가 경고 유지', /고정시간 인식불가: /.test(noteFn));
  check('툴바 알림 엘리먼트 마크업/스타일', /<span id="toolbarNote"><\/span>/.test(html)
    && /#toolbarNote \{[^}]*color: #b3261e/.test(html));
  // 학년별 시간표 안의 '미분류 N과목은 판정에서 제외됨'은 별개 표시라 그대로 남는다
  check('학년별 시간표의 미분류 안내는 유지', /미분류 ' \+ n \+ '과목은 판정에서 제외됨/.test(html));

  // (4) 학년별 시간표: 독립 모달 → 설정 모달의 8번째 탭
  check('학년별 시간표 독립 모달 제거', !/id="gradeFree"|btnGradeFree|btnCloseGradeFree|openGradeFree|closeGradeFree/.test(html));
  const tabbar = html.slice(html.indexOf('<div id="settingsTabs"'), html.indexOf('<div id="settingsBody">'));
  const tabs = tabbar.match(/data-tab="([a-z]+)"/g) || [];
  check('설정 탭이 7개(학년별 시간 흡수)', tabs.length === 7);
  check('학년별 시간표 탭이 처음', tabs[0] === 'data-tab="gradefree"' && /학년별 시간표<\/button>/.test(tabbar));
  check('설정 모달 기본 탭이 학년별 시간표', /SETTINGS_TAB = 'gradefree'/.test(html));
  check('학년 버튼에 금지 개수 표기 없음', !/금지 ' \+ n \+ '\)/.test(html));
  check('탭 이름에 옛 이름(공강 현황)이 남아 있지 않음', !/공강 현황<\/button>/.test(html)
    && !/>공강 현황 <span class="muted h-help"/.test(html));
  check('학년별 시간표 섹션이 설정 본문에 렌더됨', /class="sec" data-tab="gradefree"/.test(html)
    && /id="gradeFreeNote"/.test(html) && /id="gradeFreeGrades"/.test(html) && /id="gradeFreeBody"/.test(html));
  check('학년별 시간표 섹션 제목이 새 이름', /data-tab="gradefree"><h3>학년별 시간표 /.test(html));
  // 모든 탭이 DRAFT + [저장] 방식 → 탭에 따라 푸터를 숨기지 않는다
  check('탭에 따라 저장 푸터를 숨기지 않음', !/settingsFooter'\)\.style\.display/.test(html));
  // 보기만 해도 dirty 가 되면 안 된다 — 렌더 경로에 SETTINGS_DIRTY 대입이 없다
  const gfRender = html.slice(html.indexOf('function renderGradeFree()'), html.indexOf('function isGradeFreeOpen()'));
  check('학년별 시간표 렌더가 SETTINGS_DIRTY 를 켜지 않음', gfRender.length > 0 && !/SETTINGS_DIRTY = /.test(gfRender));
  check('학년별 시간표 열림 판정이 설정 탭 기준', /SETTINGS_TAB === 'gradefree'/.test(html)
    && /function isGradeFreeOpen\(\) \{ return isSettingsOpen\(\) && SETTINGS_TAB === 'gradefree'; \}/.test(html));
  check('탭 전환 시 학년별 시간표 재렌더', /applySettingsTab\(\);\n  renderGradeFreeIfOpen\(\);/.test(html));
  // RA 감독 배정 흐름이 설정 모달 위에서도 뜬다(z-index) — 그리고 닫아도 설정의 백드롭은 남는다
  check('RA 배정 팝업이 설정 모달보다 위(z-index)', /#raAssign \{[\s\S]*?z-index: 60;/.test(html)
    && /#settings \{[\s\S]*?z-index: 55;/.test(html));
  check('RA 배정 닫을 때 설정이 열려 있으면 백드롭 유지',
    /function closeRaAssign\(\) \{[\s\S]*?if \(!isSettingsOpen\(\)\) document\.getElementById\('backdrop'\)\.classList\.remove\('on'\);/.test(html));
  // 그리드의 공강 행에서 들어가는 RA 배정 경로는 그대로 살아 있다
  check('그리드 공강 행 → RA 배정 경로 유지', /td\.gfr-all,td\.gfr-some,td\.gfr-partial/.test(html)
    && /openRaAssign\(\+td\.dataset\.day, \+td\.dataset\.period, \+td\.dataset\.grade\)/.test(html));
})();

/* =========================================================
   툴바 아이콘 3종 인라인 SVG (index.html 정적 검증)
   — 문자 글리프는 브라우저·OS마다 모양이 달라 인라인 SVG 로 고정한다.
     Worker 가 HTML 한 장을 서빙하므로 외부 리소스 참조는 어떤 형태로도 안 된다.
   ========================================================= */
(function () {
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');

  const btn = function (id) {
    const s = html.indexOf('<button id="' + id + '"');
    return s < 0 ? '' : html.slice(s, html.indexOf('</button>', s) + 9);
  };
  const ids = ['btnRefresh', 'btnUndo', 'btnSettings'];
  const marks = ids.map(btn);

  // (1) 세 버튼 모두 인라인 SVG — 옛 문자 글리프는 남아 있지 않다
  check('아이콘 버튼 3종 마크업 존재', marks.every(function (m) { return m.length > 0; }));
  check('세 아이콘 모두 인라인 <svg>', marks.every(function (m) { return /<svg\b[\s\S]*<\/svg>/.test(m); }));
  check('옛 문자 글리프 제거(⟳ ↩ ⚙️)', !/&#x27F3;|&#x21A9;|⚙/.test(html));
  check('아이콘 버튼 안에 텍스트 노드 없음',
    marks.every(function (m) { return !/>[^<>]*[^\s<>][^<>]*</.test(m.replace(/<svg[\s\S]*<\/svg>/, '<svg/>')); }));

  // (2) 외부 리소스 참조 금지 — <img>·<use href>·url()·아이콘 폰트 전부 없어야 한다
  check('아이콘에 <img>/<use> 없음', marks.every(function (m) { return !/<img\b|<use\b|<image\b/.test(m); }));
  check('아이콘에 외부 URL·xlink 참조 없음',
    marks.every(function (m) { return !/xlink:|https?:\/\/|url\(|src=/.test(m); }));
  check('툴바에 아이콘 폰트 로드 없음', !/@font-face|fonts\.googleapis|material-icons|font-awesome/i.test(html));

  // (3) 시각적 무게 통일 — 같은 viewBox / stroke-width / 선 끝 처리
  const svgTag = marks.map(function (m) { return (m.match(/<svg[^>]*>/) || [''])[0]; });
  check('세 아이콘 viewBox 동일(0 0 24 24)',
    svgTag.every(function (t) { return /viewBox="0 0 24 24"/.test(t); }));
  check('세 아이콘 stroke-width 동일(2)', svgTag.every(function (t) { return /stroke-width="2"/.test(t); }));
  check('세 아이콘 선 끝·모서리 처리 동일(round)',
    svgTag.every(function (t) { return /stroke-linecap="round"/.test(t) && /stroke-linejoin="round"/.test(t); }));

  // (4) 색은 CSS 가 제어 — fill 은 비우고 stroke 는 currentColor
  check('세 아이콘 fill="none"', svgTag.every(function (t) { return /fill="none"/.test(t); }));
  check('세 아이콘 stroke="currentColor"', svgTag.every(function (t) { return /stroke="currentColor"/.test(t); }));
  check('아이콘 내부에 하드코딩된 색 없음',
    marks.every(function (m) { return !/(fill|stroke)="#|(fill|stroke)="rgb/.test(m); }));
  // 기존 색 규칙(특히 되돌리기 비활성 회색)이 그대로 살아 있어야 한다
  check('되돌리기 비활성 회색 규칙 유지', /#btnUndo:disabled \{ color: #b9b9b9; \}/.test(html));
  check('새로고침·되돌리기 색 규칙 유지',
    /#btnRefresh \{ color: #2b6cb0; \}/.test(html) && /#btnUndo \{ color: #c05621; \}/.test(html));

  // (5) 접근성 — svg 는 감추고, 이름은 버튼의 title 이 담당한다
  check('세 아이콘 aria-hidden="true"', svgTag.every(function (t) { return /aria-hidden="true"/.test(t); }));
  check('아이콘 버튼 title(툴팁) 유지',
    /id="btnRefresh"[^>]*title="새로고침 — 시트 최신 상태 다시 불러오기"/.test(html)
    && /id="btnUndo"[^>]*title="되돌리기 \(Ctrl\+Z\)"/.test(html)
    && /id="btnSettings"[^>]*title="설정"/.test(html));

  // (6) 버튼 크기·정렬 — 다른 툴바 버튼과 세로 중앙 정렬되도록 flex 중앙 정렬
  check('tb-icon 이 정사각(32px) 유지', /#toolbar button\.tb-icon \{[^}]*width: 32px;/.test(html));
  check('tb-icon 이 아이콘을 중앙 정렬', /#toolbar button\.tb-icon \{[^}]*display: inline-flex;[^}]*align-items: center;[^}]*justify-content: center;/.test(html));
  check('tb-icon svg 크기 지정(18px)', /#toolbar button\.tb-icon svg \{[^}]*width: 18px; height: 18px;/.test(html));

  // (7) 모양 — 톱니바퀴는 톱니 8개 + 가운데 뚫린 원
  const gear = btn('btnSettings');
  check('톱니바퀴 톱니 8개', (gear.match(/A8\.5 8\.5 0 0 1/g) || []).length === 8);
  check('톱니바퀴 가운데 원이 뚫려 있음(stroke 원)', /<circle cx="12" cy="12" r="[\d.]+"\/>/.test(gear));
  // 새로고침은 끊긴 원호(large-arc) + 화살촉, 되돌리기는 곡선 + 화살촉 — 각 2개 path
  check('새로고침이 끊긴 원호 + 화살촉', (btn('btnRefresh').match(/<path /g) || []).length === 2
    && /A8 8 0 1 1 /.test(btn('btnRefresh')));
  check('되돌리기가 곡선 + 화살촉', (btn('btnUndo').match(/<path /g) || []).length === 2
    && /d="M19\.5 19C/.test(btn('btnUndo')));
})();

/* =========================================================
   '학년별 시간' + '학년별 시간표' 통합 탭 (index.html 정적 검증)
   — DRAFT 편집 + [저장] / 드래그 1회 커밋 / RA 배정은 그리드 전용 / 이름 있는 금지 슬롯
   ========================================================= */
(function () {
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');

  // (1) 학년별 시간 탭은 흔적 없이 사라졌다
  check('gradehours 탭/섹션 제거', !/gradehours/.test(html));
  check('학년별 시간 전용 렌더 제거', !/gradeMatrixHtml|GH_UI|GH_DRAG/.test(html));
  check('학년별 시간 전용 클릭 액션 제거', !/'ghGrade'|'ghDay'|'ghPeriod'/.test(html));
  // 공용 규칙 연산(ghState/ghToggle/ghPartClasses)은 통합 탭이 이어받아 계속 쓴다
  check('금지 슬롯 토글 로직은 유지', /function ghState\(/.test(html)
    && /function ghToggle\(/.test(html) && /function ghPartClasses\(/.test(html));

  // (2) 통합 탭 UI: 모드 전환 + 범례
  check('학년별 시간표 탭에 모드 전환 바', /id="gradeFreeMode"/.test(html)
    && /data-gfmode="view"/.test(html) && /data-gfmode="paint"/.test(html));
  check('학년별 시간표 탭에 범례', /id="gradeFreeLegend"/.test(html) && /function gradeFreeLegendHtml\(/.test(html));
  check('기본 모드는 조회', /GF_UI = \{ grade: \d+, mode: 'view' \}/.test(html));
  // 색만으로 구분하지 않는다: 이름없는 금지=사선, 이름있는 금지=회색+실선테두리+이름, 부분금지=삼각, RA=✓
  check('이름 없는 금지 슬롯을 사선 무늬로 구분', /td\.gf-nogo \{[\s\S]*?repeating-linear-gradient/.test(html));
  check('이름 있는 금지 슬롯은 회색 + 무늬 없음', /td\.gf-nogo\.gf-named \{[\s\S]*?background-image: none;/.test(html));
  check('이름 있는 금지 슬롯에 색 외 채널(실선 안쪽 테두리)',
    /td\.gf-nogo\.gf-named \{[\s\S]*?box-shadow: inset 0 0 0 2px/.test(html));
  check('라벨 유무로 gf-named 를 나눈다',
    /cls \+= blkLabel \? ' gf-nogo gf-named' : ' gf-nogo';/.test(html));
  check('금지 슬롯 본문은 라벨(있으면) 아니면 \'금지\'', /if \(bst === '불가'\) text = blkLabel \|\| '금지';/.test(html));
  check('부분 금지를 모서리 삼각으로 구분', /td\.gf-pblock::before \{[\s\S]*?border-style: solid/.test(html));
  check('RA 배정 셀에 ✓ 표식', /r\.covered \? '✓ ' : ''/.test(html));
  // 범례가 두 종류의 금지 슬롯을 각각 설명한다
  const legend = html.slice(html.indexOf('function gradeFreeLegendHtml('), html.indexOf('// 통합 매트릭스:'));
  check('범례에 이름 있는 금지 슬롯 항목', /\['sw-named', '이름 있는 금지 슬롯/.test(legend));
  check('범례에 이름 없는 금지 슬롯 항목', /\['sw-nogo', '이름 없는 금지 슬롯/.test(legend));
  check('범례 스와치 sw-named 스타일 존재', /\.gf-legend i\.sw-named \{[\s\S]*?box-shadow: inset/.test(html));
  check('범례가 RA 배정 위치를 그리드로 안내', /배정은 메인 그리드에서/.test(legend));

  // (3) 클릭 예측 가능성: 이 탭의 칸 클릭 동작은 칠하기뿐이다
  const hint = html.slice(html.indexOf('function gfClickHint('), html.indexOf('function gradeFreeNote('));
  check('클릭 힌트 함수가 모드를 먼저 본다', /if \(paint\) return '클릭: '/.test(hint));
  check('조회 모드에는 클릭 동작이 없다', /클릭 동작 없음/.test(hint) && !/RA/.test(hint));
  check('칠하기 모드 클릭 힌트에 [저장] 필요 명시',
    /금지 해제\(\[저장\] 필요\)/.test(hint) && /금지로 지정\(\[저장\] 필요\)/.test(hint));
  // 렌더는 dirty 를 '켜지'도 '끄지'도 않는다
  const rgf = html.slice(html.indexOf('function renderGradeFree()'), html.indexOf('function isGradeFreeOpen()'));
  check('통합 렌더가 SETTINGS_DIRTY 를 건드리지 않음', rgf.length > 0 && !/SETTINGS_DIRTY/.test(rgf));
  check('칠하기 모드가 아니면 칸 핸들러를 걸지 않음', /if \(!paint\) return;/.test(rgf));

  // (4) RA 감독 배정은 이 탭에서 제거 — 메인 그리드 전용
  check('학년별 시간표 탭에서 openRaAssign 호출 없음', !/openRaAssign/.test(rgf));
  const gfCell = html.slice(html.indexOf('function gradeFreeCellHtml('), html.indexOf('// "이 칸을 클릭하면'));
  check('셀 렌더에도 RA 배정 배선 없음', !/openRaAssign/.test(gfCell));
  check('매트릭스 공강 셀에 pointer 커서 없음(클릭 대상 아님)',
    !/table\.gh-matrix td\.gf-all, table\.gh-matrix td\.gf-some, table\.gh-matrix td\.gf-part \{ cursor: pointer; \}/.test(html));
  // RA 배정 팝업 자체와 그리드 경로는 그대로 살아 있다(회귀 방지)
  check('RA 배정 팝업은 그대로 존재', /id="raAssign"/.test(html) && /function openRaAssign\(day, period, grade\)/.test(html));
  check('그리드 공강 행 → RA 배정 경로 유지(회귀)', /td\.gfr-all,td\.gfr-some,td\.gfr-partial/.test(html)
    && /openRaAssign\(\+td\.dataset\.day, \+td\.dataset\.period, \+td\.dataset\.grade\)/.test(html));
  check('openRaAssign 호출 지점은 그리드 한 곳뿐',
    (html.match(/openRaAssign\(\+td\.dataset/g) || []).length === 1);
  // 조회용 RA 상태 표시(감독 이름·✓)는 남긴다
  check('RA 감독 이름은 조회용으로 유지', /function raSupBreakdownAt\(/.test(html)
    && /raSupBreakdownAt\(dd \* 8 \+ \(p - 1\), g\)/.test(html));

  // (5) 칠하기는 DRAFT 편집 — 드래그는 미리보기만, 커밋은 한 번, 저장은 [저장] 버튼이
  const paintStart = html.indexOf('function gfPaintable(ev)');
  const paintSrc = html.slice(paintStart, html.indexOf('// 고정 수업 카드', paintStart));
  check('칠하기 소스 블록 추출', paintSrc.length > 500);
  check('드래그 중에는 아무것도 커밋하지 않음(미리보기 클래스만)',
    /function gfPaintAdd\([\s\S]*?classList\.add\(GF_PAINT\.action === 'PAINT' \? 'gf-paint-on' : 'gf-paint-off'\)/.test(paintSrc));
  check('칠하기 경로에 postConfig 호출이 없다(저장은 [저장] 버튼만)', !/postConfig/.test(paintSrc));
  check('드래그 종료 시 커밋은 1회', (paintSrc.slice(paintSrc.indexOf('function gfPaintEnd()'),
    paintSrc.indexOf('function gfBulkToggle(')).match(/gfCommitBlocks\(/g) || []).length === 1);
  check('바뀐 칸이 없으면 커밋하지 않음', /if \(!n\) \{ renderGradeFree\(\); return; \}/.test(paintSrc));
  check('칠하기 대상은 시트가 아니라 DRAFT',
    /function gfBlocks\(\) \{ return \(DRAFT && DRAFT\.fixedBlocks\) \|\| \[\]; \}/.test(html));
  check('커밋은 DRAFT 갱신 + dirty + 재렌더뿐',
    /function gfCommitBlocks\(n, action\) \{\s*SETTINGS_DIRTY = true;\s*renderSettings\(\);/.test(paintSrc));
  check('커밋 토스트가 [저장] 필요를 알린다', /\[저장\]을 눌러야 반영됩니다'\);/.test(paintSrc));
  // 미리보기 config: 저장 전에도 화면이 DRAFT 편집 결과와 일치한다
  check('미리보기 판정이 DRAFT 기준 config 를 쓴다',
    /function gfViewConfig\(\) \{[\s\S]*?fixedBlocks: blocksToConfig\(gfBlocks\(\)\)/.test(html)
    && /var cfg = gfViewConfig\(\);/.test(html)
    && /var r = gradeFreeState\(STATE\.model, cfg, g, \{ day: dd, period: p \}\);/.test(html));
  check('저장 형태 변환은 [저장] 경로와 공용(blocksToConfig)',
    /var blocks = blocksToConfig\(DRAFT\.fixedBlocks\)/.test(html));

  // (6) 혼재 처리용 가드는 더 이상 필요 없다 — 모든 조작이 draft 라 정리했다
  check('gfPaintGuard 제거', !/gfPaintGuard/.test(html));
  check('미저장 변경이 칠하기 모드를 강제로 내리지 않음',
    !/GF_UI\.mode === 'paint' && SETTINGS_DIRTY/.test(html));

  // (7) 일괄 전환(머리글)은 확인을 받되 [저장] 방식임을 알린다
  check('요일/교시 일괄 전환에 확인 절차', /function gfBulkToggle\([\s\S]*?if \(!confirm\(/.test(paintSrc));
  check('일괄 전환 확인문구가 [저장] 방식 안내', /\[저장\]을 눌러야 반영됩니다\.'\)\) return;/.test(paintSrc));
  check('즉시 저장 문구가 남아 있지 않음', !/즉시 저장/.test(html));

  // (8) 드래그 위임 핸들러가 새 이름으로 연결됐고 학년별 시간표 탭에서만 동작한다
  check('드래그 핸들러 바인딩 갱신', /body\.addEventListener\('mousedown', gfPaintStart\);/.test(html)
    && /document\.addEventListener\('mouseup', gfPaintEnd\);/.test(html));
  check('칠하기는 학년별 시간표 탭 + paint 모드에서만',
    /function gfPaintable\(ev\) \{\n\s*if \(!isGradeFreeOpen\(\) \|\| GF_UI\.mode !== 'paint'\) return null;/.test(paintSrc));

  // (9) 금지 슬롯 탭과 완전히 같은 계약 — 탭 전체가 draft + [저장]으로 통일됐다
  const blkSec = html.slice(html.indexOf('data-tab="block"><h3>금지 슬롯 규칙'), html.indexOf('data-tab="group"><h3>'));
  check('금지 슬롯 탭은 [저장] 방식 유지 안내', /\[저장\]을 눌러야 반영됩니다/.test(blkSec));
  const gfSec = html.slice(html.indexOf('data-tab="gradefree"><h3>'), html.indexOf("html += '<div id=\"gradeFreeNote\""));
  check('학년별 시간표 탭 안내도 [저장] 방식', /\[저장\]을 눌러야 반영됩니다/.test(gfSec));
  check('학년별 시간표 탭 안내가 RA 배정 위치를 그리드로 지목', /RA 감독 배정은 메인 그리드에서 합니다/.test(gfSec));
})();

/* =========================================================
   설정 모달 열기 순서 — 열림 표시(.open)가 최초 렌더보다 먼저다
   (회귀: openSettings 가 .open 을 붙이기 전에 renderSettings 를 불러
    첫 탭 '학년별 시간표' 매트릭스가 비어 있던 버그)
   ========================================================= */
(function () {
  const html = readFileSync(join(__dir, '../src/index.html'), 'utf8');
  const src = fnSrc(html, 'openSettings');
  check('openSettings 소스 추출', src.length > 50);

  const iOpen = src.indexOf("getElementById('settings').classList.add('open')");
  const iBackdrop = src.indexOf("getElementById('backdrop').classList.add('on')");
  const iRender = src.indexOf('renderSettings()');
  check('openSettings 가 settings 에 .open 을 붙인다', iOpen !== -1);
  check('openSettings 가 backdrop 에 .on 을 붙인다', iBackdrop !== -1);
  check('openSettings 가 renderSettings() 를 호출한다', iRender !== -1);
  check('.open 추가가 renderSettings() 호출보다 앞선다', iOpen !== -1 && iRender !== -1 && iOpen < iRender);
  check('backdrop .on 추가도 renderSettings() 호출보다 앞선다', iBackdrop !== -1 && iRender !== -1 && iBackdrop < iRender);
  check('openSettings 가 첫 탭을 학년별 시간표로 지정', /SETTINGS_TAB = 'gradefree';/.test(src));
  const iTab = src.indexOf("SETTINGS_TAB = 'gradefree'");
  check('탭 지정도 renderSettings() 호출보다 앞선다', iTab !== -1 && iTab < iRender);

  // 순서가 중요한 이유(게이트 사슬)가 그대로인지 함께 못 박는다
  check('매트릭스 렌더는 .open 클래스 게이트를 거친다',
    /function isSettingsOpen\(\) \{ return document\.getElementById\('settings'\)\.classList\.contains\('open'\); \}/.test(html)
    && /function isGradeFreeOpen\(\) \{ return isSettingsOpen\(\) && SETTINGS_TAB === 'gradefree'; \}/.test(html)
    && /function renderGradeFreeIfOpen\(\) \{ if \(isGradeFreeOpen\(\)\) renderGradeFree\(\); \}/.test(html));
  check('renderSettings 가 마지막에 renderGradeFreeIfOpen 을 부른다',
    /applySettingsTab\(\);\s*renderGradeFreeIfOpen\(\);\s*\}/.test(fnSrc(html, 'renderSettings')));

  // 탭 전환도 같은 계약 — 플래그(SETTINGS_TAB) 를 세운 뒤에 렌더한다
  const swSrc = fnSrc(html, 'switchSettingsTab');
  const iSet = swSrc.indexOf('SETTINGS_TAB = tab');
  const iGf = swSrc.indexOf('renderGradeFreeIfOpen()');
  check('switchSettingsTab 은 SETTINGS_TAB 갱신 후에 렌더한다', iSet !== -1 && iGf !== -1 && iSet < iGf);
})();

/* =========================================================
   설정 저장 왕복 횟수 (회귀 방지) — 실제 worker.js 를 Node 로 로드해
   가짜 fetch 로 Sheets API 호출을 센다. DEV_MODE 를 쓰지 않고 프로덕션 경로를 탄다.
   worker.js 는 index.html·core 를 텍스트로 import 하므로, 그 import 만
   문자열 상수로 치환하고 lib/dev 모듈 경로를 절대 URL 로 바꿔 임시 .mjs 로 로드한다.
   ========================================================= */
await (async function () {
  const { writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');

  const P = function (rel) { return join(__dir, '../' + rel); };
  function loadWorker() {
    let src = readFileSync(P('src/worker.js'), 'utf8');
    const textConst = function (name, rel) {
      return 'const ' + name + ' = ' + JSON.stringify(readFileSync(P(rel), 'utf8')) + ';';
    };
    src = src
      .replace(/^import html from '\.\/index\.html';$/m, textConst('html', 'src/index.html'))
      .replace(/^import CoreModelSrc from '\.\/core\/Core_Model\.js';$/m, textConst('CoreModelSrc', 'src/core/Core_Model.js'))
      .replace(/^import CoreValidateSrc from '\.\/core\/Core_Validate\.js';$/m, textConst('CoreValidateSrc', 'src/core/Core_Validate.js'))
      .replace(/^import CoreRecommendSrc from '\.\/core\/Core_Recommend\.js';$/m, textConst('CoreRecommendSrc', 'src/core/Core_Recommend.js'))
      .replace(/^import WebExtraSrc from '\.\/core\/web_extra\.js';$/m, textConst('WebExtraSrc', 'src/core/web_extra.js'))
      .replace(/from '\.\/(lib|dev)\/([A-Za-z0-9_-]+)\.js'/g, function (m, d, n) {
        return "from '" + pathToFileURL(P('src/' + d + '/' + n + '.js')).href + "'";
      });
    const f = join(tmpdir(), 'tt_worker_test_' + process.pid + '.mjs');
    writeFileSync(f, src);
    return import(pathToFileURL(f).href);
  }

  /* --- 모의 스프레드시트 --- */
  function makeGrid() {
    const g = [];
    g.push(['교사', '교실'].concat(new Array(40).fill('')));
    const hdr = ['', ''];
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].forEach(function (d) {
      for (let p = 1; p <= 8; p++) hdr.push(d + p);
    });
    g.push(hdr);
    for (let r = 0; r < 80; r++) {
      const row = ['교사' + r, 'R' + r];
      for (let i = 0; i < 40; i++) row.push(i % 3 === 0 ? 'Kor10A' : '');
      g.push(row);
    }
    return g;
  }
  function makeStore(extra) {
    return Object.assign({
      tabs: ['revised', '설정', '연결그룹', '교과별교사'],
      grid: makeGrid(),
      config: [['[연결그룹]', '', ''], ['그룹명', '과목들', ''], ['G1', 'Kor10A, Kor10B', '']],
      linked: [['학년', '과목명', '교사명', '시간표 표기명', '고정수업시간', '그룹'],
               ['10', '국어', '김', 'Kor10A', '월1', 'G1']],
      depts: [['교사명', '교과', '주임여부', '', '배치순서'], ['교사0', '국어', '주임', '', '국어']],
      writes: [],
      failConfigRead: 0,       // >0 이면 설정 A:C 조회를 그 횟수만큼 실패시킨다
      failRanges: null         // RegExp — 매칭되는 range 가 든 batchGet 은 503
    }, extra || {});
  }

  function makeFetch(store, jwks, log) {
    return async function (url, init) {
      const u = String(url);
      if (u.indexOf('oauth2/v3/certs') !== -1) {
        return new Response(JSON.stringify(jwks), { status: 200 });
      }
      let kind = 'other', body = {};
      if (u.indexOf('fields=sheets.properties') !== -1) {
        kind = 'getSheets';
        body = { sheets: store.tabs.map(function (t, i) { return { properties: { sheetId: i, title: t, index: i } }; }) };
      } else if (u.indexOf('/values:batchGet') !== -1) {
        const ranges = new URL(u).searchParams.getAll('ranges');
        kind = 'batchGet';
        if (ranges.some(function (r) { return /^'?설정'?!/.test(r); }) && store.failConfigRead > 0) {
          store.failConfigRead--;
          log.push({ kind: 'batchGet:설정(실패)', ranges: ranges });
          return new Response('{"error":{"code":503}}', { status: 503 });
        }
        if (store.failRanges && ranges.some(function (r) { return store.failRanges.test(r); })) {
          log.push({ kind: 'batchGet(실패)', ranges: ranges });
          return new Response('{"error":{"code":503}}', { status: 503 });
        }
        body = {
          valueRanges: ranges.map(function (r) {
            if (/^'?설정'?!/.test(r)) return { values: store.config };
            if (/^'?연결그룹'?!/.test(r)) return { values: store.linked };
            if (/^'?교과별교사'?!/.test(r)) return { values: store.depts };
            if (/A1:M10/.test(r)) {
              const t = /^'([^']+)'/.exec(r);
              return { values: (t && t[1] === 'revised') ? store.grid.slice(0, 10).map(function (x) { return x.slice(0, 13); }) : [] };
            }
            return { values: store.grid };
          })
        };
      } else if (u.indexOf('/values:batchUpdate') !== -1) {
        kind = 'batchUpdate';
        const payload = JSON.parse(init.body);
        payload.data.forEach(function (d) {
          store.writes.push(d.range);
          if (/^'?설정'?!/.test(d.range)) store.config = d.values.map(function (r) { return r.slice(); });
        });
        body = { totalUpdatedCells: 1 };
      } else if (/:batchUpdate$/.test(u.split('?')[0])) {
        kind = 'addSheet';
        body = { replies: [{ addSheet: { properties: { sheetId: 999 } } }] };
      }
      log.push({ kind: kind, url: u });
      return new Response(JSON.stringify(body), { status: 200 });
    };
  }

  /* --- 인증 --- */
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privPem = priv.export({ type: 'pkcs8', format: 'pem' });
  const jwk = pub.export({ format: 'jwk' });
  const KID2 = 'kid-rt';
  jwk.kid = KID2;
  const CID = 'cid.apps.googleusercontent.com';
  const env = { GOOGLE_CLIENT_ID: CID, ALLOWED_DOMAIN: 'gvcs-mg.org', SPREADSHEET_ID: 'SHEET_X' };
  const now2 = Math.floor(Date.now() / 1000);
  const idTok = await signJwtRS256({
    iss: 'https://accounts.google.com', aud: CID, sub: '1', email: 'x@gvcs-mg.org',
    email_verified: true, hd: 'gvcs-mg.org', iat: now2, exp: now2 + 3600
  }, privPem, KID2);
  const H = { authorization: 'Bearer ' + idTok, 'x-sheets-token': 'ya29.tok', 'content-type': 'application/json' };

  const worker = (await loadWorker()).default;
  const realFetch = globalThis.fetch;

  async function withStore(store, fn) {
    const log = [];
    globalThis.fetch = makeFetch(store, { keys: [jwk] }, log);
    try { return { out: await fn(log), log: log }; }
    finally { globalThis.fetch = realFetch; }
  }
  const call = function (path, init) {
    return worker.fetch(new Request('https://w' + path, Object.assign({ headers: H }, init || {})), env);
  };
  const postCfg = function (config, ver) {
    return call('/api/config', { method: 'POST', body: JSON.stringify({ config: config, baseConfigVersion: ver }) });
  };

  /* (1) 저장 1회의 Sheets 왕복 횟수 — 개선 전 config 3 + state 6 = 9회였다 */
  {
    const store = makeStore();
    const r = await withStore(store, async function (log) {
      const st = await (await call('/api/state?tab=revised')).json();
      log.length = 0;                                   // 저장분만 센다
      const res = await postCfg(st.config, st.configVersion);
      return { st: st, cfg: await res.json(), status: res.status };
    });
    const n = r.log.length;
    check('설정 저장 1회 Sheets 왕복 ≤ 5회 (개선 전 config 3 + state 6 = 9)', n <= 5);
    check('설정 저장 왕복 내역: ' + r.log.map(function (l) { return l.kind; }).join(' → '), true);
    check('설정 저장 응답이 config 를 실어 보낸다(클라이언트 /api/state 불필요)', !!r.out.cfg.config);
    check('설정 저장 응답이 configVersion 을 실어 보낸다', r.out.cfg.configVersion != null);
    check('설정 저장 응답이 linkedPinned/warnings/pinnedSource 를 포함',
      r.out.cfg.linkedPinned !== undefined && r.out.cfg.warnings !== undefined && 'pinnedSource' in r.out.cfg);
    check('설정 저장 응답에 grid 를 싣지 않는다(그리드 재전송 없음)', r.out.cfg.grid === undefined);
    // 독립 조회(설정 A:C / 연결그룹 A:F)는 병렬 → 순차 왕복 깊이가 호출 수보다 작다
    check('설정 조회와 연결그룹 조회가 병렬(batchGet 2건이 write 이전)',
      r.log.filter(function (l) { return l.kind === 'batchGet'; }).length >= 2);
  }

  /* (2) 응답 configVersion 이 시트 실제 해시와 일치 → 연속 저장이 헛 409 를 내지 않는다 */
  {
    const store = makeStore();
    const r = await withStore(store, async function () {
      const st = await (await call('/api/state?tab=revised')).json();
      const a = await (await postCfg(st.config, st.configVersion)).json();
      const res2 = await postCfg(a.config, a.configVersion);
      const b = await res2.json();
      const st2 = await (await call('/api/state?tab=revised')).json();
      return { a: a, b: b, status2: res2.status, st2: st2 };
    });
    check('응답 configVersion 재사용 연속 저장 → 200 (락 정합, 헛 409 없음)',
      r.out.status2 === 200 && r.out.b.ok === true);
    check('저장 응답 configVersion == 이후 /api/state configVersion',
      r.out.b.configVersion === r.out.st2.configVersion);
    check('저장 응답 config == 이후 /api/state config (파생값 포함 동등)',
      JSON.stringify(r.out.b.config) === JSON.stringify(r.out.st2.config));
    check('저장 응답 pinnedSource/linkedPinned/warnings == /api/state',
      r.out.b.pinnedSource === r.out.st2.pinnedSource &&
      JSON.stringify(r.out.b.linkedPinned) === JSON.stringify(r.out.st2.linkedPinned) &&
      JSON.stringify(r.out.b.warnings) === JSON.stringify(r.out.st2.warnings));
  }

  /* (3) 낙관적 락 — 어긋난 baseConfigVersion 은 409 이고 쓰기가 일어나지 않는다 */
  {
    const store = makeStore();
    const r = await withStore(store, async function () {
      const res = await postCfg({ groups: [] }, 'WRONG_VERSION');
      return { status: res.status, body: await res.json() };
    });
    check('baseConfigVersion 불일치 → 409 stale_config',
      r.out.status === 409 && r.out.body.error === 'stale_config');
    check('stale_config 시 시트에 쓰기 없음', store.writes.length === 0);
  }
  {
    const store = makeStore();
    const r = await withStore(store, async function () {
      const res = await call('/api/config', { method: 'POST', body: JSON.stringify({ config: {} }) });
      return { status: res.status, body: await res.json() };
    });
    check('baseConfigVersion 누락 → 400 missing_base_version',
      r.out.status === 400 && r.out.body.error === 'missing_base_version');
    check('missing_base_version 시 시트에 쓰기 없음', store.writes.length === 0);
  }

  /* (4) 조회 실패는 "설정 탭 없음"으로 위장하지 않는다 → 503, 쓰기 없음 */
  {
    const store = makeStore({ failConfigRead: 1 });
    const r = await withStore(store, async function () {
      const res = await postCfg({ groups: [] }, 'anything');
      return { status: res.status, body: await res.json() };
    });
    check('저장 전 설정 조회 실패 → 503 config_unavailable',
      r.out.status === 503 && r.out.body.error === 'config_unavailable');
    check('config_unavailable 시 시트에 쓰기 없음(설정 소거 방지)', store.writes.length === 0);
  }

  /* (5) 저장 후 확정 조회가 실패하면 신뢰 못 할 config/version 을 내려보내지 않는다 */
  {
    const store = makeStore();
    const r = await withStore(store, async function () {
      const st = await (await call('/api/state?tab=revised')).json();
      store.failConfigRead = 1;               // 저장 직후 재조회만 실패
      // 저장 전 조회는 이미 끝났으므로, 다음 설정 조회 = 확정 조회
      const res = await postCfg(st.config, st.configVersion);
      return { status: res.status, body: await res.json() };
    });
    // 저장 전 조회가 먼저 실패하면 503(그것도 안전) — 어느 쪽이든 "가짜 버전"은 내려가지 않는다
    const b = r.out.body;
    check('확정 조회 실패 시 가짜 configVersion 을 내려보내지 않는다',
      b.configVersion == null);
    check('확정 조회 실패 시 클라이언트에 전체 재조회를 지시(reload) 하거나 503',
      (b.ok === true && b.reload === true) || r.out.status === 503);
  }

  /* (6) D열 보존 — 설정 쓰기는 A:C 범위 지정 batchUpdate 뿐(clear 없음) */
  {
    const store = makeStore();
    await withStore(store, async function () {
      const st = await (await call('/api/state?tab=revised')).json();
      await postCfg(st.config, st.configVersion);
    });
    const cfgWrites = store.writes.filter(function (r) { return /설정/.test(r); });
    check('설정 쓰기는 1건(단일 batchUpdate)', cfgWrites.length === 1);
    check('설정 쓰기 범위가 A1:C{n} 로 제한(D열 이후 미접촉): ' + cfgWrites[0],
      /^'설정'!A1:C\d+$/.test(cfgWrites[0] || ''));
  }

  /* (7) 클라이언트: 성공 경로는 /api/state 를 다시 타지 않고, 실패·409 경로는 STATE 를 건드리지 않는다 */
  {
    const html2 = readFileSync(P('src/index.html'), 'utf8');
    const pc = fnSrc(html2, 'postConfig');
    check('postConfig 성공 경로가 applyConfigResult 로 응답을 반영', /applyConfigResult\(r\.data\)/.test(pc));
    check('postConfig 409 stale_config 는 종전대로 loadState 로 최신화',
      /stale_config[\s\S]*?loadState\(STATE\.sheetId, STATE\.tab\)/.test(pc));
    check('postConfig 503 config_unavailable 경로 유지', /config_unavailable/.test(pc));
    // 실패/409/503 경로에서 STATE 를 낙관적으로 갱신하지 않는다(되돌릴 것이 없어야 안전)
    const beforeOk = pc.slice(0, pc.indexOf('applyConfigResult(r.data)'));
    check('저장 성공 확인 전에 STATE.config/configVersion 을 갱신하지 않는다',
      !/STATE\.(config|configVersion)\s*=/.test(beforeOk));
    const ac = fnSrc(html2, 'applyConfigResult');
    check('applyConfigResult 가 config/configVersion/warnings/linkedPinned 를 갱신',
      /STATE\.config = data\.config/.test(ac) && /STATE\.configVersion = data\.configVersion/.test(ac) &&
      /STATE\.warnings = data\.warnings/.test(ac) && /STATE\.linkedPinned = data\.linkedPinned/.test(ac));
    check('applyConfigResult 가 그리드·모델을 건드리지 않는다(설정 저장은 그리드 무변경)',
      !/STATE\.(grid|model|version)\s*=/.test(ac));
    check('applyConfigResult 가 화면을 다시 그린다', /renderGrid\(\)/.test(ac) && /renderGradeFreeIfOpen\(\)/.test(ac));
    check('서버가 reload 를 지시하면 클라이언트는 /api/state 전체 재조회로 폴백',
      /r\.data\.reload[\s\S]*?loadState\(STATE\.sheetId, STATE\.tab\)/.test(pc));
  }

  /* (8) DEV 핸들러도 동일 계약(응답 형태 미러링) */
  {
    resetMockStore();
    const devEnv = { DEV_MODE: '1', DEV_EMAIL: 'dev@gvcs-mg.org' };
    const st = await (await worker.fetch(new Request('https://w/api/state'), devEnv)).json();
    const res = await worker.fetch(new Request('https://w/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: st.config, baseConfigVersion: st.configVersion })
    }), devEnv);
    const b = await res.json();
    const st2 = await (await worker.fetch(new Request('https://w/api/state'), devEnv)).json();
    check('DEV 설정 저장 응답도 config/configVersion 포함', !!b.config && b.configVersion != null);
    check('DEV 저장 응답 configVersion == 이후 state configVersion', b.configVersion === st2.configVersion);
    check('DEV 저장 응답 config == 이후 state config',
      JSON.stringify(b.config) === JSON.stringify(st2.config));
    resetMockStore();
  }

  /* =========================================================
     (9) 조회 경로 왕복 횟수 — 초기 로딩·탭 전환 지연 회귀 방지
         개선 전: /api/state 6회(탭 지정)·7회(미지정), /api/sheets 4회
     ========================================================= */
  {
    const store = makeStore();
    const r = await withStore(store, async function (log) {
      const st = await (await call('/api/state?tab=revised')).json();
      return { n: log.length, st: st, kinds: log.map(function (l) { return l.kind; }) };
    });
    check('/api/state(탭 지정) Sheets 왕복 ≤ 2회 (개선 전 6): ' + r.out.kinds.join(' → '), r.out.n <= 2);
    check('/api/state 왕복 감소 후에도 그리드 정상', (r.out.st.grid || []).length > 0 && r.out.st.dataStart > 0);
    check('/api/state 왕복 감소 후에도 config/configVersion 정상',
      !!r.out.st.config && r.out.st.configVersion != null && r.out.st.config.missing === false);
    check('/api/state 왕복 감소 후에도 depts(교과별교사) 정상', r.out.st.depts !== null);
    check('/api/state 왕복 감소 후에도 linkedPinned/warnings 정상',
      r.out.st.linkedPinned !== undefined && Array.isArray(r.out.st.warnings));
  }
  {
    const store = makeStore();
    const r = await withStore(store, async function (log) {
      const st = await (await call('/api/state')).json();
      return { n: log.length, tab: st.tab, kinds: log.map(function (l) { return l.kind; }) };
    });
    check('/api/state(탭 미지정) Sheets 왕복 ≤ 3회 (개선 전 7): ' + r.out.kinds.join(' → '), r.out.n <= 3);
    check('/api/state(탭 미지정) 이 시간표 탭을 고른다', r.out.tab === 'revised');
  }
  {
    const store = makeStore();
    const r = await withStore(store, async function (log) {
      const sh = await (await call('/api/sheets')).json();
      return { n: log.length, sh: sh, kinds: log.map(function (l) { return l.kind; }) };
    });
    check('/api/sheets Sheets 왕복 ≤ 2회 (개선 전 4): ' + r.out.kinds.join(' → '), r.out.n <= 2);
    check('/api/sheets 가 시간표 탭을 식별', r.out.sh.tabs.some(function (t) { return t.title === 'revised' && t.isTimetable; }));
    check('/api/sheets 가 electives(연결그룹)를 실어 보낸다', Object.keys(r.out.sh.electives || {}).length > 0);
    check('/api/sheets configVersion 정상', r.out.sh.configVersion != null);
  }

  /* (9b) 클라이언트: 첫 /api/state 에 탭을 실어 서버의 헤더 재탐색 왕복을 없앤다 */
  {
    const html3 = readFileSync(P('src/index.html'), 'utf8');
    const bs = fnSrc(html3, 'bootstrap');
    check('bootstrap 이 첫 loadState 에 탭을 지정(왕복 1회 절약)', /loadState\(STATE\.sheetId, firstTimetableTab\(\)\)/.test(bs));
    const ft = fnSrc(html3, 'firstTimetableTab');
    check('firstTimetableTab 이 서버와 같은 규칙(첫 isTimetable 탭 → 첫 탭)',
      /isTimetable/.test(ft) && /tabs\.length \? tabs\[0\]\.title : null/.test(ft));
    // 서버 자동 선택과 결과가 같아야 왕복만 줄고 동작은 안 바뀐다
    const store = makeStore();
    const r = await withStore(store, async function () {
      const auto = await (await call('/api/state')).json();
      const explicit = await (await call('/api/state?tab=revised')).json();
      return { auto: auto.tab, explicit: explicit.tab };
    });
    check('클라이언트가 고른 탭 == 서버 자동 선택 탭', r.out.auto === r.out.explicit);
  }

  /* (10) 합쳐 읽기의 전부-실패 위험 — 없는 탭은 range 에 넣지 않아 실패가 원천 제거된다 */
  {
    const store = makeStore({ tabs: ['revised'] });   // 설정·연결그룹·교과별교사 전부 없음
    const r = await withStore(store, async function (log) {
      const st = await (await call('/api/state?tab=revised')).json();
      const sh = await (await call('/api/sheets')).json();
      return { st: st, sh: sh, ranges: log.filter(function (l) { return l.ranges; }) };
    });
    check('부가 탭이 하나도 없는 시트에서도 /api/state 정상', r.out.st.ok === true && (r.out.st.grid || []).length > 0);
    check('없는 탭은 아예 조회 range 에 넣지 않는다(탭 없음發 실패 원천 제거)',
      !r.log.some(function (l) { return /연결그룹|교과별교사|설정|선택과목코드/.test(String(l.url || '')); }));
    check('설정 탭 부재는 "조회 실패"가 아니다 → configVersion 유지(저장 가능)',
      r.out.st.configVersion != null && r.out.st.config.missing === true);
    check('연결그룹·교과별교사 부재 시 빈 값으로 흡수', r.out.st.depts === null && eq(r.out.st.linkedPinned, {}));
    check('부가 탭 부재에서도 /api/sheets 정상', r.out.sh.ok === true && r.out.sh.tabs.length === 1);
  }

  /* (11) 부가 조회가 실패해도 앱은 죽지 않는다(batchGet 전부-실패 → 개별 폴백) */
  {
    const store = makeStore({ failRanges: /연결그룹|교과별교사/ });
    const r = await withStore(store, async function () {
      const res = await call('/api/state?tab=revised');
      return { status: res.status, st: await res.json() };
    });
    check('연결그룹·교과별교사 조회 실패해도 /api/state 는 200', r.out.status === 200 && r.out.st.ok === true);
    check('실패해도 그리드는 온전히 내려온다(합쳐 읽기가 그리드를 삼키지 않는다)',
      (r.out.st.grid || []).length > 0 && r.out.st.dataStart > 0);
    check('실패한 부가 조회는 빈 값으로 흡수', r.out.st.depts === null && eq(r.out.st.linkedPinned, {}));
    check('부가 조회 실패가 설정을 오염시키지 않는다(configVersion 유효 → 저장 가능)',
      r.out.st.configVersion != null && r.out.st.config.missing === false);
  }

  /* (12) 설정 조회만 실패 — 합쳐 읽어도 "탭 없음"으로 위장하지 않고, 저장은 거부된다 */
  {
    const store = makeStore({ failRanges: /설정/ });
    const r = await withStore(store, async function () {
      const st = await (await call('/api/state?tab=revised')).json();
      const res = await postCfg(st.config, st.configVersion);
      return { st: st, status: res.status, body: await res.json() };
    });
    check('설정 조회 실패 시 /api/state 는 그리드를 계속 내려준다', (r.out.st.grid || []).length > 0);
    check('설정 조회 실패 시 configVersion=null (빈 해시 위장 없음)', r.out.st.configVersion === null);
    check('설정 조회 실패 상태에서 저장은 503 config_unavailable 로 거부',
      r.out.status === 503 && r.out.body.error === 'config_unavailable');
    check('config_unavailable 시 시트에 쓰기 없음', store.writes.length === 0);
  }
})();

console.log('');
if (failures.length) {
  console.log('실패 ' + failures.length + '건:');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
} else {
  console.log('전체 통과');
}
