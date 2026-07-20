/**
 * 순수 상태 헬퍼 — 설정 안전 로드 / 교사행 이동 검증 / 변경이력 유형 라벨.
 * worker.js와 test가 공용으로 import (index.html·core 텍스트 의존 없음).
 */

// 설정 탭 조회를 그리드와 분리해 별도로 감싼다.
// 조회 실패(설정 탭 부재 등) 시 빈 config(missing:true)로 폴백.
export async function readConfigSafe(batchGet, configRange, parseConfig) {
  try {
    const vals = await batchGet([configRange]);
    const config = parseConfig((vals && vals[0]) || []);
    config.missing = false;
    return config;
  } catch (_) {
    const config = parseConfig([]);
    config.missing = true;
    return config;
  }
}

// 설정 탭 조회 — "탭이 실제로 없음"과 "조회에 실패함"을 구분한다.
// 탭 부재: 빈 config + version=hashValues([]) + unavailable:false (정상적으로 새 설정 저장 가능).
// 조회 실패(429/503/네트워크 순단 등): unavailable:true + version:null + raw:null.
//   → 호출자는 이 상태에서 설정 저장을 허용해서는 안 된다(빈 해시 위장 = 설정 전체 소거).
// deps: { batchGet, parseConfig, hashValues, onError? }
export async function readConfigWithVersion(deps, sheetsList, configTab) {
  const exists = !sheetsList || sheetsList.some(function (s) { return s.title === configTab; });
  if (!exists) {
    const empty = deps.parseConfig([]);
    empty.missing = true;
    return { config: empty, version: deps.hashValues([]), raw: [], unavailable: false };
  }
  try {
    const vals = await deps.batchGet(["'" + configTab + "'!A:C"]);
    const raw = (vals && vals[0]) || [];
    const config = deps.parseConfig(raw);
    config.missing = false;
    return { config: config, version: deps.hashValues(raw), raw: raw, unavailable: false };
  } catch (e) {
    if (deps.onError) deps.onError(e);
    const config = deps.parseConfig([]);
    config.missing = true;
    return { config: config, version: null, raw: null, unavailable: true };
  }
}

// apply(쓰기) 경로의 대상 탭 결정. 조회 경로와 달리 폴백하지 않는다.
// bodyTab 이 주어졌는데 시트 목록에 없으면 { error:'tab_not_found' } — 다른 탭에 쓰면
// 교사가 의도하지 않은 탭(대개 원본)을 덮어쓰게 된다.
// bodyTab 이 비어 있으면 { tab:null } → 호출자가 자동 선택한다.
export function resolveApplyTab(sheetsList, bodyTab) {
  if (!bodyTab) return { tab: null };
  const found = (sheetsList || []).some(function (s) { return s.title === bodyTab; });
  if (!found) return { error: 'tab_not_found' };
  return { tab: bodyTab };
}

// moves 중 교사 행(entry.type==='teacher')이 아닌 row 목록을 반환.
// 빈 배열이면 모든 move가 교사 행.
export function nonTeacherRows(model, moves) {
  const teacher = {};
  ((model && model.entries) || []).forEach(function (e) {
    if (e.type === 'teacher') teacher[e.row] = true;
  });
  return (moves || [])
    .filter(function (m) { return !teacher[m.row]; })
    .map(function (m) { return m.row; });
}

// 제출된 moves 를 그룹(fromIdx>toIdx)별로 묶어, 각 그룹이 expandUnit 로 확장한
// 완전한 단위(연결그룹/팀티칭)와 일치하는지 검증. 불일치 그룹 키 배열 반환(빈 배열=정상).
export function incompleteUnits(model, config, moves, expandUnit) {
  const groups = {};
  (moves || []).forEach(function (m) {
    const gk = m.fromIdx + '>' + m.toIdx;
    (groups[gk] = groups[gk] || []).push(m);
  });
  const key = function (m) { return m.row + ':' + m.fromIdx + ':' + m.toIdx; };
  const offending = [];
  Object.keys(groups).forEach(function (gk) {
    const submitted = groups[gk];
    const rep = submitted[0];
    const expected = expandUnit(model, config, { name: rep.name, row: rep.row, fromIdx: rep.fromIdx, toIdx: rep.toIdx }) || [];
    const subSet = submitted.map(key).sort();
    const expSet = expected.map(key).sort();
    if (JSON.stringify(subSet) !== JSON.stringify(expSet)) offending.push(gk);
  });
  return offending;
}

// 변경이력 '유형' 한글 라벨. undo→'되돌리기'. chain→'연쇄'. direct→'이동'
// (단 moves 2건 이상이며 전부 같은 슬롯 조합(fromIdx·toIdx 동일)인 팀 이동이면 '이동(팀)').
export function historyKindLabel(kind, moves) {
  if (kind === 'undo') return '되돌리기';
  if (kind === 'chain') return '연쇄';
  if (kind === 'swap') return '맞교환';
  if (kind === 'assign') return '배정';
  if (kind === 'unassign') return '배정 해제';
  const mv = moves || [];
  if (mv.length >= 2 && mv.every(function (m) {
    return m.fromIdx === mv[0].fromIdx && m.toIdx === mv[0].toIdx;
  })) return '이동(팀)';
  return '이동';
}

export var RA_VALUE_RE = /^RA(?:(7|8|9|10|11|12)([A-C])?)?$/;
export function isRaValue(v) { return RA_VALUE_RE.test(String(v == null ? '' : v).trim()); }

// 특정 슬롯(idx)에 RA 감독으로 배정 가능한 교사 후보(정렬됨).
// 조건: type==='teacher' && 슬롯 비어있음 && 불가시간 아님.
// 각 후보 { name, row, lessons, ra, total }: total=비어있지 않은 슬롯 수, ra=값이 정확히 'RA'인 슬롯 수, lessons=total-ra.
// 정렬: total 오름차순, 동률이면 name 오름차순.
export function assignCandidates(model, config, idx) {
  var unavail = (config && config.unavailable) || [];
  function isUnavail(entry) {
    for (var i = 0; i < unavail.length; i++) {
      var u = unavail[i];
      if (u.name !== entry.name) continue;
      if (u.row != null && u.row !== entry.row) continue;
      if (u.slots && u.slots.indexOf(idx) !== -1) return true;
    }
    return false;
  }
  var out = [];
  ((model && model.entries) || []).forEach(function (e) {
    if (e.type !== 'teacher') return;
    var cur = e.slots[idx];
    if (cur != null && String(cur).trim() !== '') return;
    if (isUnavail(e)) return;
    var total = 0, ra = 0;
    for (var i = 0; i < e.slots.length; i++) {
      var v = e.slots[i];
      if (v == null || String(v).trim() === '') continue;
      total++;
      if (isRaValue(v)) ra++;
    }
    out.push({ name: e.name, row: e.row, lessons: total - ra, ra: ra, total: total });
  });
  out.sort(function (a, b) { return a.total - b.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  return out;
}

// RA 배정/해제 서버측 재검증(순수). 첫 위반의 {error,status} 반환, 정상이면 null.
// assigns [{row,idx,value}]: 교사행 && 슬롯 범위(0..39) && 슬롯 비어 있어야 함.
//   value 미지정/빈값이면 'RA'(하위호환). RA_VALUE_RE(순수 'RA' / 'RA'+학년 / 'RA'+학년+반) 만족해야 함(invalid_value).
//   반 지정('RA'+학년+반)이면 같은 idx에 동일 값이 이미 있으면 duplicate_ra. 순수 'RA'·'RA'+학년(일부)은 공동 감독 허용→중복 허용.
// clears  [{row,idx}]: 교사행 && 슬롯 값이 RA 계열(isRaValue) 이어야 함(not_ra).
export function raOpError(model, assigns, clears) {
  var byRow = {};
  ((model && model.entries) || []).forEach(function (e) { byRow[e.row] = e; });
  var entries = (model && model.entries) || [];
  var a = assigns || [], c = clears || [];
  for (var i = 0; i < a.length; i++) {
    var e = byRow[a[i].row];
    if (!e || e.type !== 'teacher') return { error: 'invalid_assign', status: 400 };
    if (!(a[i].idx >= 0 && a[i].idx < 40)) return { error: 'invalid_assign', status: 400 };
    var v = e.slots[a[i].idx];
    if (v != null && String(v).trim() !== '') return { error: 'cell_occupied', status: 409 };
    var val = (a[i].value == null || String(a[i].value).trim() === '') ? 'RA' : String(a[i].value).trim();
    if (!RA_VALUE_RE.test(val)) return { error: 'invalid_value', status: 400 };
    var m = RA_VALUE_RE.exec(val);
    if (m && m[2]) {
      for (var k = 0; k < entries.length; k++) {
        var en = entries[k];
        if (String(en.slots[a[i].idx] == null ? '' : en.slots[a[i].idx]).trim() === val) return { error: 'duplicate_ra', status: 409 };
      }
    }
  }
  for (var j = 0; j < c.length; j++) {
    var e2 = byRow[c[j].row];
    if (!e2 || e2.type !== 'teacher') return { error: 'invalid_clear', status: 400 };
    if (!(c[j].idx >= 0 && c[j].idx < 40)) return { error: 'invalid_clear', status: 400 };
    if (!isRaValue(e2.slots[c[j].idx])) return { error: 'not_ra', status: 409 };
  }
  return null;
}

// '교과별교사' 탭(A:E, 1행 헤더 skip) → { names: {교사명→교과}, order: [배치순서...], heads: [주임 교사명...] }.
// C열(idx2, 주임여부)이 '주임'인 행의 교사명을 heads로 수집.
export function parseDepts(rows) {
  if (!rows || !rows.length) return null;
  var names = {}, order = [], heads = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i] || [];
    var nm = String(r[0] == null ? '' : r[0]).trim();
    var dp = String(r[1] == null ? '' : r[1]).trim();
    if (nm && dp) names[nm] = dp;
    var hd = String(r[2] == null ? '' : r[2]).trim();
    if (nm && hd === '주임') heads.push(nm);
    var od = String(r[4] == null ? '' : r[4]).trim();
    if (od) order.push(od);
  }
  if (!Object.keys(names).length && !order.length) return null;
  return { names: names, order: order, heads: heads };
}

export function deptBoundaries(entries, depts) {
  if (!depts || !depts.names || !Array.isArray(depts.order)) return [];
  var names = depts.names, order = depts.order;
  var oi = function (d) { return d == null ? -1 : order.indexOf(d); };
  var ents = entries || [];
  var tIdx = [];
  for (var k = 0; k < ents.length; k++) if (ents[k].type === 'teacher') tIdx.push(k);
  var out = [];
  var cur = null;
  for (var t = 0; t < tIdx.length; t++) {
    var e = ents[tIdx[t]];
    var d = names[e.name];
    if (d === undefined) d = null;
    if (d === null || d === cur) continue;
    if (cur === null) { cur = d; continue; }
    var nextE = (t + 1 < tIdx.length) ? ents[tIdx[t + 1]] : null;
    var nextD = nextE ? names[nextE.name] : undefined;
    if (nextD === undefined) nextD = null;
    var ai = oi(cur), di = oi(d);
    var condA = (di > ai) && (nextD === d || di === ai + 1);
    var condB = (nextD === d);
    if (condA || condB) { out.push(e.row); cur = d; }
  }
  for (var r = 0; r < ents.length; r++) {
    if (ents[r].type === 'raSlot' || ents[r].type === 'raCourse') { out.push(ents[r].row); break; }
  }
  return out;
}

// 학년별 시간 매트릭스 ↔ fixedBlocks 매핑 (index.html 인라인 미러 ghState/ghToggle 와 로직 동일 유지).
// 슬롯(day,period)의 학년 grade 상태: '불가' | '일부' | '가능'. 같은 슬롯 다중 규칙이면 첫 규칙 기준.
export function gradeSlotState(blocks, day, period, grade) {
  var rule = (blocks || []).find(function (b) { return b.day === day && b.period === period; });
  if (!rule) return '가능';
  if (rule.grades === 'all') return '불가';
  if ((rule.grades || []).indexOf(grade) !== -1) return '불가';
  if ((rule.classes || []).some(function (cl) { return parseInt(cl, 10) === grade; })) return '일부';
  return '가능';
}

// 클릭 토글: blocks 배열을 직접 변형하고 반환(테스트는 사본 전달).
// 불가→가능: 'all'은 [7..12] 전개 후 grade 제거, 배열은 grade 제거, 규칙이 완전히 비면 삭제.
// 가능/일부→불가: 규칙 있으면 grades에 grade 추가(중복 방지), 없으면 신규 생성.
export function toggleGradeSlot(blocks, day, period, grade) {
  blocks = blocks || [];
  var idx = blocks.findIndex(function (b) { return b.day === day && b.period === period; });
  var state = gradeSlotState(blocks, day, period, grade);
  if (state === '불가') {
    var rule = blocks[idx];
    if (rule.grades === 'all') rule.grades = [7, 8, 9, 10, 11, 12];
    rule.grades = (rule.grades || []).filter(function (g) { return g !== grade; });
    if (!rule.grades.length && !((rule.classes || []).length) && !((rule.label || '').trim())) {
      blocks.splice(idx, 1);
    }
  } else if (idx === -1) {
    blocks.push({ day: day, period: period, label: '', grades: [grade], classes: [] });
  } else {
    var r = blocks[idx];
    if (r.grades !== 'all' && (r.grades || []).indexOf(grade) === -1) (r.grades = r.grades || []).push(grade);
  }
  return blocks;
}

// 학년별 공강 현황 (조회 전용, 순수). 학년 G(7~12), 슬롯 S({day,period}: day 0~4, period 1~8).
// 각 반 GA/GB/GC 상태: 'busy'(수업 커버) | 'partial'('G일부' 매핑 과목만 존재) | 'free'.
// index.html 인라인 미러(gradeFreeState) 와 로직 동일 유지 — 브라우저는 state.js 미주입.
var GF_SUBJECT_RE = /^(.+?)(7|8|9|10|11|12)([A-C])$/;
// 과목명 하나가 학년 G 에서 차지하는 대상(순수). 해당 없으면 null.
//  { classes: ['10A',...], partial: bool } — classes 는 반 단위 점유, partial 은 'G일부' 매핑.
//  ① 과목명 파싱(Eng10A) 우선 → 파싱되면 무반 매핑은 보지 않는다. ② 무반 과목은 classless 토큰으로 판정.
export function subjectGradeTargets(subj, G, classless) {
  subj = String(subj == null ? '' : subj).trim();
  if (!subj || isRaValue(subj)) return null;
  var m = GF_SUBJECT_RE.exec(subj);
  if (m) return (parseInt(m[2], 10) === G) ? { classes: [m[2] + m[3]], partial: false } : null;
  var toks = (classless || {})[subj];
  if (!toks) return null;                    // 미분류/매핑없음 → 무시
  var out = { classes: [], partial: false };
  toks.forEach(function (tok) {
    tok = String(tok).trim();
    var mm;
    if ((mm = /^(\d+)\s*전체$/.exec(tok)) && parseInt(mm[1], 10) === G) {          // G전체
      out.classes = [G + 'A', G + 'B', G + 'C'];
    } else if ((mm = /^(\d+)([A-C])$/.exec(tok)) && parseInt(mm[1], 10) === G) {   // 반 토큰
      if (out.classes.indexOf(mm[1] + mm[2]) === -1) out.classes.push(mm[1] + mm[2]);
    } else if ((mm = /^(\d+)\s*일부$/.exec(tok)) && parseInt(mm[1], 10) === G) {   // G일부
      out.partial = true;
    }
  });
  return (out.classes.length || out.partial) ? out : null;
}

// 학년 G 의 슬롯별 편성 과목(순수). 반환: 길이 40 배열, 각 원소는 중복 제거된 과목명 배열.
// 모델을 한 번만 훑어 인덱스를 만든다(칸마다 재순회 금지). 과목명 → 판정 결과는 메모이즈.
export function gradeSubjectIndex(model, config, G) {
  var classless = (config && config.classless) || {};
  var out = [];
  for (var i = 0; i < 40; i++) out.push([]);
  var memo = Object.create(null);
  var entries = (model && model.entries) || [];
  entries.forEach(function (e) {
    var slots = e.slots || [];
    for (var s = 0; s < 40; s++) {
      var subj = slots[s];
      if (subj == null) continue;
      subj = String(subj).trim();
      if (!subj) continue;
      var hit = memo[subj];
      if (hit === undefined) hit = memo[subj] = !!subjectGradeTargets(subj, G, classless);
      if (hit && out[s].indexOf(subj) === -1) out[s].push(subj);   // 팀티칭 중복 제거
    }
  });
  return out;
}

export function gradeFreeState(model, config, G, S) {
  var classless = (config && config.classless) || {};
  var fixedBlocks = (config && config.fixedBlocks) || [];
  var idx = S.day * 8 + (S.period - 1);
  var order = [G + 'A', G + 'B', G + 'C'];
  // 슬롯의 fixedBlocks 규칙: 학년 단위 금지면 공강 아님(blocked)
  var slotRules = fixedBlocks.filter(function (b) { return b.day === S.day && b.period === S.period; });
  var gBlock = null;
  slotRules.forEach(function (b) {
    if (gBlock) return;
    if (b.grades === 'all' || (b.grades || []).indexOf(G) !== -1) gBlock = b;
  });
  if (gBlock) {
    return { classes: {}, cover: {}, freeClasses: [], partialClasses: [], busyClasses: [], blockedClasses: [], raClasses: [], covered: false, label: (gBlock.label || ''), kind: 'blocked' };
  }
  // 반 단위 금지(classes): 해당 학년 반을 free 나열에서 제외
  var blocked = {};
  slotRules.forEach(function (b) {
    (b.classes || []).forEach(function (cl) {
      var mm = /^(\d+)([A-C])$/.exec(String(cl).trim());
      if (mm && parseInt(mm[1], 10) === G) blocked[mm[1] + mm[2]] = true;
    });
  });
  var busy = {}, cover = {};
  var raCov = {}, raGradeCov = false;
  order.forEach(function (c) { cover[c] = []; });
  var partialGrade = false;
  var entries = (model && model.entries) || [];
  entries.forEach(function (e) {
    var subj = e.slots && e.slots[idx];
    if (subj == null) return;
    subj = String(subj).trim();
    if (!subj) return;
    if (isRaValue(subj)) {                       // RA 감독 값: busy 집계 안 함(반은 free 유지)
      if (subj === 'RA') { /* legacy 순수 RA: 아무 반도 커버 안 함 */ }
      else {
        var _rm = RA_VALUE_RE.exec(subj);
        if (_rm && _rm[1] != null && parseInt(_rm[1], 10) === G) {
          if (_rm[2]) raCov[_rm[1] + _rm[2]] = true;   // RA+학년+반 → 반 단위 커버
          else raGradeCov = true;                       // RA+학년 → 학년 단위(일부) 커버
        }
      }
      return;
    }
    var tg = subjectGradeTargets(subj, G, classless);
    if (!tg) return;
    tg.classes.forEach(function (c) { busy[c] = true; if (cover[c]) cover[c].push(subj); });
    if (tg.partial) partialGrade = true;
  });
  var classes = {}, freeC = [], partialC = [], busyC = [], blockedC = [];
  order.forEach(function (c) {
    if (blocked[c]) { classes[c] = 'blocked'; blockedC.push(c); }
    else if (busy[c]) { classes[c] = 'busy'; busyC.push(c); }
    else if (partialGrade) { classes[c] = 'partial'; partialC.push(c); }
    else { classes[c] = 'free'; freeC.push(c); }
  });
  var label, kind;
  if (freeC.length === 3) { label = '전체'; kind = 'all'; }
  else if (freeC.length > 0) { label = freeC.join(', '); kind = 'some'; }
  else if (partialC.length > 0) { label = '일부'; kind = 'partial'; }
  else { label = ''; kind = 'none'; }
  var raClasses = order.filter(function (c) { return raCov[c]; });
  var covered;
  if (freeC.length > 0) covered = freeC.every(function (c) { return raCov[c]; });
  else if (partialC.length > 0) covered = raGradeCov;
  else covered = false;
  return { classes: classes, cover: cover, freeClasses: freeC, partialClasses: partialC, busyClasses: busyC, blockedClasses: blockedC, raClasses: raClasses, covered: covered, label: label, kind: kind };
}

// 학년별 공강 셀에 표시할 라벨 문자열(순수). 감독이 배정된 대상은 대상 아래 줄('\n')에 교사명.
// r: gradeFreeState 결과; bd: { byClass:{반:[이름]}, gradeSups:[이름] }; G: 학년 숫자.
//  partial → 'G일부'(감독 있으면 아래 줄에 이름들); all → 감독 있으면 반별 줄바꿈 나열, 없으면 '전체'; some → 반별 나열(감독 있으면 줄바꿈, 없으면 ', ').
export function raFreeCellLabel(r, bd, G) {
  bd = bd || {}; var byClass = bd.byClass || {}, gradeSups = bd.gradeSups || [];
  function cls(c) { var s = byClass[c] || []; return s.length ? c + '\n' + s.join(',') : c; }
  if (r.kind === 'partial') { var base = G + '일부'; return gradeSups.length ? base + '\n' + gradeSups.join(',') : base; }
  if (r.kind === 'all') { var order = [G + 'A', G + 'B', G + 'C']; var any = order.some(function (c) { return (byClass[c] || []).length; }); return any ? order.map(cls).join('\n') : '전체'; }
  if (r.kind === 'some') { var anyS = r.freeClasses.some(function (c) { return (byClass[c] || []).length; }); return r.freeClasses.map(cls).join(anyS ? '\n' : ', '); }
  return r.label;  // blocked/after/none 그대로
}
