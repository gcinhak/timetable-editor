// Core_Validate — 순수 로직. 모델 + 설정 + 이동/교체 연산 → 충돌 목록.
// 규칙 3종(시수 한도 검사 없음): 교사 중복 / 학급 중복 / 고정 블록.

// GAS: 전역 함수 사용. Node: require.
var M = (typeof module !== 'undefined') ? require('./Core_Model.js') : null;
function _slotLabel(i) { return M ? M.slotLabel(i) : slotLabel(i); }
function _parseSubject(s) { return M ? M.parseSubject(s) : parseSubject(s); }
function _cloneModel(m) { return M ? M.cloneModel(m) : cloneModel(m); }
function _findEntry(m, n) { return M ? M.findEntry(m, n) : findEntry(m, n); }
function _findEntryByRow(m, r) { return M ? M.findEntryByRow(m, r) : findEntryByRow(m, r); }
function resolveEntry(model, mv) {
  if (mv && mv.row != null) return _findEntryByRow(model, mv.row);
  return _findEntry(model, mv.name);
}
var _SLOT_COUNT = M ? M.SLOT_COUNT : SLOT_COUNT;

// '12A' / '12전체' 토큰 → [{grade, cls}]
function classesFromTokens(tokens) {
  var out = [];
  (tokens || []).forEach(function (tok) {
    tok = String(tok).trim();
    var whole = /^(\d+)\s*전체$/.exec(tok);
    if (whole) {
      var g = parseInt(whole[1], 10);
      ['A', 'B', 'C'].forEach(function (c) { out.push({ grade: g, cls: g + c }); });
      return;
    }
    var m = /^(\d+)([A-C])$/.exec(tok);
    if (m) out.push({ grade: parseInt(m[1], 10), cls: tok });
  });
  return out;
}

// 과목명 → 대상 학급 목록 + 분류 상태.
// 메모(성능): 순수 함수((subject, config.classless) 고정 → 결과 고정)이며, 스캔 중
// 교사×슬롯마다 정규식 파싱을 반복하므로 캐시한다. WeakMap 을 config 객체 정체성으로
// 키잉 → 서로 다른 config 는 절대 캐시를 공유하지 않는다(설정 변경 시 stale 불가).
// 반환 객체는 전 호출측에서 read-only 로만 사용(전수 확인) → 참조 공유 안전.
// (config 는 세션 중 in-place 변경 없음: 설정 편집은 DRAFT 사본→새 config 교체.)
var _expandTargetsCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
function expandTargets(subject, config) {
  if (!_expandTargetsCache || !config || typeof config !== 'object') {
    return expandTargetsUncached(subject, config);
  }
  var byConfig = _expandTargetsCache.get(config);
  if (!byConfig) { byConfig = new Map(); _expandTargetsCache.set(config, byConfig); }
  var key = String(subject);
  var hit = byConfig.get(key);
  if (hit !== undefined) return hit;
  var res = expandTargetsUncached(subject, config);
  byConfig.set(key, res);
  return res;
}
function expandTargetsUncached(subject, config) {
  if (/^RA(?:\d{2,}_)?(?:7|8|9|10|11|12)?$/.test(String(subject).trim())) return { classes: [], parsed: false, mapped: false, unclassified: false, partialGrades: [] };
  var p = _parseSubject(subject);
  if (p) return { classes: [{ grade: p.grade, cls: p.cls }], parsed: true, mapped: false, unclassified: false, partialGrades: [] };
  var classless = (config && config.classless) || {};
  if (Object.prototype.hasOwnProperty.call(classless, subject)) {
    var toks = classless[subject] || [];
    var partialGrades = [];
    var regularToks = [];
    toks.forEach(function (tok) {
      var mp = /^(\d+)\s*일부$/.exec(String(tok).trim());
      if (mp) { var g = parseInt(mp[1], 10); if (partialGrades.indexOf(g) === -1) partialGrades.push(g); }
      else regularToks.push(tok);
    });
    return { classes: classesFromTokens(regularToks), parsed: false, mapped: true, unclassified: false, partialGrades: partialGrades };
  }
  return { classes: [], parsed: false, mapped: false, unclassified: true, partialGrades: [] };
}

function teamOf(config, subject) {
  var tt = (config && config.teamTeaching) || {};
  return Object.prototype.hasOwnProperty.call(tt, subject) ? tt[subject] : null;
}

function groupOf(config, subject) {
  var groups = (config && config.linkedGroups) || {};
  for (var g in groups) {
    if (Object.prototype.hasOwnProperty.call(groups, g) && groups[g].indexOf(subject) !== -1) {
      return { name: g, subjects: groups[g] };
    }
  }
  return null;
}

// 교사 불가 시간 여부: config.unavailable 레코드와 대조. row 있으면 해당 행에만, 없으면 이름 전체.
function isUnavailable(config, entry, idx) {
  var list = (config && config.unavailable) || [];
  for (var i = 0; i < list.length; i++) {
    var u = list[i];
    if (u.name !== entry.name) continue;
    if (u.row != null && u.row !== entry.row) continue;
    if (u.slots && u.slots.indexOf(idx) !== -1) return true;
  }
  return false;
}

// 전체 모델 스캔 → 충돌(학급 중복 / 고정블록 / 미분류 / 교사불가). 교사 행만 검사.
function findConflicts(model, config, onlySlots) {
  var conflicts = [];
  var teachers = model.entries.filter(function (e) { return e.type === 'teacher'; });
  var slotFilter = onlySlots ? {} : null;
  if (onlySlots) onlySlots.forEach(function (s) { slotFilter[s] = true; });

  for (var idx = 0; idx < _SLOT_COUNT; idx++) {
    if (slotFilter && !slotFilter[idx]) continue;
    var placements = [];
    teachers.forEach(function (t) {
      var subj = t.slots[idx];
      if (subj) placements.push({ name: t.name, subject: subj, targets: expandTargets(subj, config) });
    });
    if (placements.length === 0) continue;

    // 학급 중복: 대상 학급별로 묶음
    var byCls = {};
    placements.forEach(function (pl) {
      pl.targets.classes.forEach(function (c) {
        (byCls[c.cls] = byCls[c.cls] || []).push(pl);
      });
      if (pl.targets.unclassified) {
        conflicts.push({ type: 'unclassified', severity: 'warn', slot: idx, label: _slotLabel(idx),
          names: [pl.name], subject: pl.subject,
          message: '미분류 과목 "' + pl.subject + '" (' + pl.name + ', ' + _slotLabel(idx) + ') — 대상 학급 매핑 없음' });
      }
    });
    Object.keys(byCls).forEach(function (cls) {
      var group = byCls[cls];
      if (group.length < 2) return;
      var subjects = {}; group.forEach(function (g) { subjects[g.subject] = true; });
      var subjKeys = Object.keys(subjects);
      var team = subjKeys.length === 1 ? teamOf(config, subjKeys[0]) : null;
      var allTeam = false;
      if (team) {
        allTeam = group.every(function (g) { return team.indexOf(g.name) !== -1; });
      }
      if (allTeam) return; // 팀티칭 등록 조합 → 정상
      // 연결그룹 상호 예외: 같은 슬롯 같은 학급의 모든 과목이 동일 연결그룹 소속이면 학급 중복 아님(분반)
      var grp0 = groupOf(config, group[0].subject);
      if (grp0 && group.every(function (g) { return grp0.subjects.indexOf(g.subject) !== -1; })) return;
      conflicts.push({ type: 'class', severity: 'block', slot: idx, label: _slotLabel(idx),
        cls: cls, names: group.map(function (g) { return g.name; }),
        subjects: subjKeys,
        message: '학급 중복 ' + cls + ' @' + _slotLabel(idx) + ': ' + group.map(function (g) { return g.name + '(' + g.subject + ')'; }).join(', ') });
    });

      // 'N일부' 규칙: 같은 슬롯에서 partial(N일부) ↔ 정규(같은 학년 N) 는 학급 중복 차단.
      // partial ↔ partial(같은 학년 일부)은 허용(충돌 아님).
      var partialPls = placements.filter(function (pl) { return pl.targets.partialGrades && pl.targets.partialGrades.length; });
      partialPls.forEach(function (pp) {
        pp.targets.partialGrades.forEach(function (g) {
          var regs = placements.filter(function (pl) {
            if (pl === pp) return false;
            return pl.targets.classes.some(function (c) { return c.grade === g; });
          });
          if (!regs.length) return;
          // 연결그룹 예외 유지: partial 과목과 정규 과목이 같은 연결그룹이면 제외
          regs = regs.filter(function (reg) {
            var grp = groupOf(config, pp.subject);
            return !(grp && grp.subjects.indexOf(reg.subject) !== -1);
          });
          if (!regs.length) return;
          var involved = [pp].concat(regs);
          conflicts.push({ type: 'class', severity: 'block', slot: idx, label: _slotLabel(idx),
            cls: g + '학년(일부↔정규)',
            names: involved.map(function (x) { return x.name; }),
            subjects: involved.map(function (x) { return x.subject; }),
            message: '학급 중복 ' + g + '학년(일부↔정규) @' + _slotLabel(idx) + ': ' + involved.map(function (x) { return x.name + '(' + x.subject + ')'; }).join(', ') });
        });
      });
  }

  // 교사 불가 시간: 기존 수업이 불가 슬롯에 배치되어 있으면 경고
  teachers.forEach(function (t) {
    for (var ui = 0; ui < _SLOT_COUNT; ui++) {
      if (slotFilter && !slotFilter[ui]) continue;
      if (t.slots[ui] && isUnavailable(config, t, ui)) {
        conflicts.push({ type: 'unavailable', severity: 'warn', slot: ui, label: _slotLabel(ui),
          names: [t.name], row: t.row, subject: t.slots[ui],
          message: '교사 불가 시간에 수업: ' + t.name + '(' + t.slots[ui] + ') @' + _slotLabel(ui) });
      }
    }
  });

  // 고정 시간 이탈: pinned 과목이 지정 슬롯 밖에 배치되어 있으면 경고
  var pinnedMap = (config && config.pinned) || {};
  teachers.forEach(function (t) {
    for (var pj = 0; pj < _SLOT_COUNT; pj++) {
      if (slotFilter && !slotFilter[pj]) continue;
      var psubj = t.slots[pj];
      if (!psubj) continue;
      if (!Object.prototype.hasOwnProperty.call(pinnedMap, psubj)) continue;
      var pslots = pinnedMap[psubj] || [];
      if (pslots.indexOf(pj) !== -1) continue;
      conflicts.push({ type: 'pinnedLeave', severity: 'warn', slot: pj, label: _slotLabel(pj),
        names: [t.name], subject: psubj,
        message: '고정 시간 이탈: ' + psubj + ' — 지정: ' + pslots.map(function (x) { return _slotLabel(x); }).join(',') });
    }
  });

  // 고정 블록
  var blocks = (config && config.fixedBlocks) || [];
  blocks.forEach(function (b) {
    var idx = b.day * 8 + (b.period - 1);
    if (slotFilter && !slotFilter[idx]) return;
    teachers.forEach(function (t) {
      var subj = t.slots[idx];
      if (!subj) return;
      var tg = expandTargets(subj, config);
      var hasGradeR = Array.isArray(b.grades) && b.grades.length > 0;
      var hasClassR = Array.isArray(b.classes) && b.classes.length > 0;
      var hasPartialR = Array.isArray(b.partialGrades) && b.partialGrades.length > 0;
      var hasRestriction = (b.grades === 'all') || hasGradeR || hasClassR || hasPartialR;
      var hit = false;
      if (b.grades === 'all') hit = true;
      else {
        if (hasGradeR) hit = tg.classes.some(function (c) { return b.grades.indexOf(c.grade) !== -1; })
                           || (tg.partialGrades || []).some(function (g) { return b.grades.indexOf(g) !== -1; });
        if (!hit && hasClassR) hit = tg.classes.some(function (c) { return b.classes.indexOf(c.cls) !== -1; });
        if (!hit && hasPartialR) hit = tg.classes.some(function (c) { return b.partialGrades.indexOf(c.grade) !== -1; });
      }
      if (hasRestriction) {
        if (hit) {
          conflicts.push({ type: 'fixed', severity: 'block', slot: idx, label: _slotLabel(idx),
            names: [t.name], subject: subj, blockLabel: b.label,
            message: '고정블록 위반 ' + _slotLabel(idx) + ' [' + b.label + ']: ' + t.name + '(' + subj + ')' });
        }
      } else {
        // 적용학년 빈칸 → 경고만
        conflicts.push({ type: 'fixed', severity: 'warn', slot: idx, label: _slotLabel(idx),
          names: [t.name], subject: subj, blockLabel: b.label,
          message: '고정블록(경고) ' + _slotLabel(idx) + ' [' + b.label + ']: ' + t.name + '(' + subj + ')' });
      }
    });
  });

  return conflicts;
}

// 팀티칭 동반 이동 확장: 원 이동 + 같은 슬롯 같은 과목의 팀 교사 이동
function expandTeam(model, config, move) {
  var moves = [move];
  var entry = resolveEntry(model, move);
  if (!entry) return moves;
  var subject = entry.slots[move.fromIdx];
  var team = teamOf(config, subject);
  if (!team) return moves;
  // 과목+슬롯 기준: 팀 로스터 교사가 같은 슬롯에 같은 과목을 가진 '모든' 행을 동반 이동
  model.entries.forEach(function (e) {
    if (e === entry) return;
    if (team.indexOf(e.name) === -1) return;
    if (e.slots[move.fromIdx] !== subject) return;
    moves.push({ name: e.name, row: e.row, fromIdx: move.fromIdx, toIdx: move.toIdx });
  });
  return moves;
}

// 이동 단위 확장: 연결그룹 소속이면 같은 fromIdx 슬롯의 그룹 내 모든 과목 행(각자 팀 행 포함)을 함께 이동, 아니면 팀티칭 확장.
function expandUnit(model, config, move) {
  var entry = resolveEntry(model, move);
  if (!entry) return [move];
  var subject = entry.slots[move.fromIdx];
  var grp = groupOf(config, subject);
  if (!grp) return expandTeam(model, config, move);
  var moves = [];
  var seen = {};
  model.entries.forEach(function (e) {
    var subj = e.slots[move.fromIdx];
    if (!subj || grp.subjects.indexOf(subj) === -1) return;
    var key = e.row != null ? ('r' + e.row) : ('n' + e.name);
    if (seen[key]) return;
    seen[key] = true;
    moves.push({ name: e.name, row: e.row, fromIdx: move.fromIdx, toIdx: move.toIdx });
  });
  return moves;
}

// 이동 적용(스왑 안전): 원본 값 스냅샷 → fromIdx 비움 → toIdx 기록. 새 모델 반환.
function applyMoves(model, moves) {
  var next = _cloneModel(model);
  var writes = [];
  moves.forEach(function (mv) {
    var e = resolveEntry(next, mv);
    writes.push({ entry: e, toIdx: mv.toIdx, value: e.slots[mv.fromIdx] });
  });
  moves.forEach(function (mv) {
    var e = resolveEntry(next, mv);
    e.slots[mv.fromIdx] = '';
  });
  writes.forEach(function (w) { w.entry.slots[w.toIdx] = w.value; });
  return next;
}

// 이동 목록 → 셀 단위 쓰기 계획 [{row, idx, value}]. 모든 clear(빈값)를 앞에, write를 뒤에 배치(스왑 덮어쓰기 안전).
function movesToCellWrites(model, moves) {
  var clears = [];
  var writes = [];
  moves.forEach(function (mv) {
    var e = resolveEntry(model, mv);
    if (!e) return;
    clears.push({ row: e.row, idx: mv.fromIdx, value: '' });
    writes.push({ row: e.row, idx: mv.toIdx, value: e.slots[mv.fromIdx] });
  });
  return clears.concat(writes);
}

// 교사 중복(연산에서만 발생): 대상 슬롯이 이미 다른 수업으로 차 있음
function teacherDupConflicts(model, moves) {
  var conflicts = [];
  var byEntry = {};
  moves.forEach(function (mv) {
    var key = mv.row != null ? ('r' + mv.row) : ('n' + mv.name);
    (byEntry[key] = byEntry[key] || []).push(mv);
  });
  Object.keys(byEntry).forEach(function (key) {
    var mvs = byEntry[key];
    var e = resolveEntry(model, mvs[0]);
    if (!e) return;
    var name = mvs[0].name;
    var movedOut = {}; mvs.forEach(function (mv) { movedOut[mv.fromIdx] = true; });
    var occupiedAfter = {};
    for (var i = 0; i < _SLOT_COUNT; i++) if (e.slots[i] && !movedOut[i]) occupiedAfter[i] = true;
    var targetSeen = {};
    mvs.forEach(function (mv) {
      if (occupiedAfter[mv.toIdx] || targetSeen[mv.toIdx]) {
        conflicts.push({ type: 'teacher', severity: 'block', slot: mv.toIdx, label: _slotLabel(mv.toIdx),
          names: [name], message: '교사 중복 ' + name + ' @' + _slotLabel(mv.toIdx) + ': 이미 수업 존재' });
      }
      targetSeen[mv.toIdx] = true;
    });
  });
  return conflicts;
}

// 교사 불가 시간 위반(연산에서만): 목적지 슬롯이 해당 교사 불가 시간
function unavailableMoveConflicts(model, config, moves) {
  var conflicts = [];
  moves.forEach(function (mv) {
    var e = resolveEntry(model, mv);
    if (!e) return;
    if (isUnavailable(config, e, mv.toIdx)) {
      conflicts.push({ type: 'unavailable', severity: 'block', slot: mv.toIdx, label: _slotLabel(mv.toIdx),
        names: [mv.name], row: e.row, subject: e.slots[mv.fromIdx],
        message: '교사 불가 시간 위반: ' + mv.name + ' @' + _slotLabel(mv.toIdx) });
    }
  });
  return conflicts;
}

// 고정 수업(pinned) 이동 차단: 출발 슬롯의 과목이 지정 슬롯에 고정되어 있으면 이동 불가.
function pinnedMoveConflicts(model, config, moves) {
  var pinned = (config && config.pinned) || {};
  var conflicts = [];
  (moves || []).forEach(function (mv) {
    var e = resolveEntry(model, mv);
    if (!e) return;
    var subj = e.slots[mv.fromIdx];
    if (!subj) return;
    if (!Object.prototype.hasOwnProperty.call(pinned, subj)) return;
    var slots = pinned[subj] || [];
    if (slots.indexOf(mv.fromIdx) !== -1) {
      conflicts.push({ type: 'pinned', severity: 'block', slot: mv.fromIdx, label: _slotLabel(mv.fromIdx),
        names: [mv.name], subject: subj,
        message: '고정 수업 이동 불가: ' + subj + ' @' + _slotLabel(mv.fromIdx) });
    }
  });
  return conflicts;
}

// 연산 검사: 교사 중복(사전) + 교사불가(사전) + 적용 후 영향 슬롯의 학급/고정/미분류 충돌
function checkMoves(model, config, moves) {
  var dup = teacherDupConflicts(model, moves);
  var next = applyMoves(model, moves);
  var affected = {};
  moves.forEach(function (mv) { affected[mv.fromIdx] = true; affected[mv.toIdx] = true; });
  var others = findConflicts(next, config, Object.keys(affected).map(Number));
  return dup.concat(others).concat(unavailableMoveConflicts(model, config, moves)).concat(pinnedMoveConflicts(model, config, moves));
}

// 충돌 정규화 키: 타입 + 슬롯 + 정렬된 관련 교사/학급 조합. 이동 전후 동일 충돌은 같은 키.
function conflictKey(c) {
  var names = (c.names || (c.name != null ? [c.name] : [])).slice().sort();
  return [c.type, c.slot, names.join(','), c.cls || '', c.blockLabel || '', c.subject || ''].join('|');
}

// 델타 검사: 이동이 '새로' 만든 block 충돌만 blocks, 기존 충돌(전후 동일 키)은 preexisting 경고로 통과.
// 반환: { blocks: [...], preexisting: [{severity:'warn', preexisting:true, ...}] }
function checkMovesDelta(model, config, moves) {
  var affected = {};
  moves.forEach(function (mv) { affected[mv.fromIdx] = true; affected[mv.toIdx] = true; });
  var slots = Object.keys(affected).map(Number);
  var before = findConflicts(model, config, slots);
  var next = applyMoves(model, moves);
  var after = teacherDupConflicts(model, moves).concat(unavailableMoveConflicts(model, config, moves)).concat(pinnedMoveConflicts(model, config, moves)).concat(findConflicts(next, config, slots));
  var beforeKeys = {};
  before.forEach(function (c) { beforeKeys[conflictKey(c)] = true; });
  var blocks = [];
  var preexisting = [];
  after.forEach(function (c) {
    if (beforeKeys[conflictKey(c)]) {
      var w = {};
      for (var k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) w[k] = c[k]; }
      w.severity = 'warn'; w.preexisting = true;
      preexisting.push(w);
    } else if (c.severity === 'block') {
      blocks.push(c);
    }
  });
  return { blocks: blocks, preexisting: preexisting };
}

function hasBlock(conflicts) {
  return conflicts.some(function (c) { return c.severity === 'block'; });
}

if (typeof module !== 'undefined') {
  module.exports = {
    classesFromTokens: classesFromTokens, expandTargets: expandTargets, teamOf: teamOf,
    findConflicts: findConflicts, expandTeam: expandTeam, expandUnit: expandUnit, groupOf: groupOf, applyMoves: applyMoves, resolveEntry: resolveEntry,
    movesToCellWrites: movesToCellWrites,
    teacherDupConflicts: teacherDupConflicts, checkMoves: checkMoves, checkMovesDelta: checkMovesDelta, conflictKey: conflictKey, hasBlock: hasBlock,
    isUnavailable: isUnavailable, unavailableMoveConflicts: unavailableMoveConflicts,
    pinnedMoveConflicts: pinnedMoveConflicts,
  };
}
