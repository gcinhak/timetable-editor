// Core_Recommend — 순수 로직. 빈 슬롯(레벨1) / 1:1 스왑(레벨2) / 연쇄 BFS 깊이3(레벨3).
// 결과 후보는 적용 시 무충돌(block 없음) 보장. 팀티칭은 한 단위로 이동.

var CM = (typeof module !== 'undefined') ? require('./Core_Model.js') : null;
var CV = (typeof module !== 'undefined') ? require('./Core_Validate.js') : null;
function _SLOT() { return CM ? CM.SLOT_COUNT : SLOT_COUNT; }
function _resolveEntry(m, mv) { return CV ? CV.resolveEntry(m, mv) : resolveEntry(m, mv); }
function _expandUnit(m, c, mv) { return CV ? CV.expandUnit(m, c, mv) : expandUnit(m, c, mv); }
function _checkMoves(m, c, mv) { return CV ? CV.checkMoves(m, c, mv) : checkMoves(m, c, mv); }
function _applyMoves(m, mv) { return CV ? CV.applyMoves(m, mv) : applyMoves(m, mv); }
function _hasBlock(cf) { return CV ? CV.hasBlock(cf) : hasBlock(cf); }
function _checkMovesDelta(m, c, mv) { return CV ? CV.checkMovesDelta(m, c, mv) : checkMovesDelta(m, c, mv); }
function _expandTargets(s, c) { return CV ? CV.expandTargets(s, c) : expandTargets(s, c); }

var NODE_CAP = 5000;
var CAND_CAP = 20;

function teachersOf(model) {
  return model.entries.filter(function (e) { return e.type === 'teacher'; });
}
function freeSlots(entry) {
  var out = [];
  for (var i = 0; i < _SLOT(); i++) if (!entry.slots[i]) out.push(i);
  return out;
}

// 레벨1: 빈 슬롯 이동(팀 동반). 무충돌 목적지.
function level1(model, config, target) {
  var out = [];
  var n = _SLOT();
  for (var to = 0; to < n; to++) {
    if (to === target.fromIdx) continue;
    var moves = _expandUnit(model, config, { name: target.name, row: target.row, fromIdx: target.fromIdx, toIdx: to });
    if (!_hasBlock(_checkMoves(model, config, moves))) {
      out.push({ level: 1, kind: '빈슬롯', moves: moves, steps: 1,
        desc: target.name + ' ' + subjectAt(model, target) + ' → ' + labelOf(to) });
    }
  }
  return out;
}

// 레벨2: 1:1 스왑(팀 과목 제외). 대상 수업과 다른 수업을 맞교환, 결과 무충돌.
function level2(model, config, target) {
  var out = [];
  var tSubj = subjectAt(model, target);
  if (isUnit(config, tSubj)) return out; // 팀 과목은 스왑 대상에서 제외(레벨1/3만)
  var teachers = teachersOf(model);
  var i = target.fromIdx;
  for (var t = 0; t < teachers.length; t++) {
    var e = teachers[t];
    for (var j = 0; j < _SLOT(); j++) {
      if (!e.slots[j]) continue;
      if (e.name === target.name && j === i) continue;
      if (j === i) continue; // 같은 슬롯 스왑 무의미
      if (isUnit(config, e.slots[j])) continue;
      var moves = [
        { name: target.name, row: target.row, fromIdx: i, toIdx: j },
        { name: e.name, row: e.row, fromIdx: j, toIdx: i },
      ];
      if (!_hasBlock(_checkMoves(model, config, moves))) {
        out.push({ level: 2, kind: '스왑', moves: moves, steps: 2,
          desc: target.name + '(' + tSubj + ')@' + labelOf(i) + ' ↔ ' + e.name + '(' + e.slots[j] + ')@' + labelOf(j) });
      }
    }
  }
  return out;
}

// 레벨3: 연쇄. 목적지가 점유되어 막히면 점유 수업을 빈 슬롯으로 먼저 옮기고(각 단계 무충돌) 대상 배치.
function level3(model, config, target, ctx) {
  var out = [];
  var n = _SLOT();
  for (var to = 0; to < n; to++) {
    if (to === target.fromIdx) continue;
    resolve(model, config, target, to, [], 2, ctx, out); // 연쇄 추가이동 최대 2 + 대상 1 = 깊이 3
    if (out.length >= CAND_CAP || ctx.nodes >= NODE_CAP) break;
  }
  return out;
}

// model 상태에서 target 을 to 로 배치. 막히면 depthLeft 만큼 점유 수업을 빈 슬롯으로 선이동.
function resolve(model, config, target, to, movesSoFar, depthLeft, ctx, out) {
  if (ctx.nodes >= NODE_CAP || out.length >= CAND_CAP) return;
  ctx.nodes++;
  var place = _expandUnit(model, config, { name: target.name, row: target.row, fromIdx: target.fromIdx, toIdx: to });
  if (_checkMovesDelta(model, config, place).blocks.length === 0) {
    var all = movesSoFar.concat(place);
    if (movesSoFar.length > 0) { // 연쇄만 레벨3 으로 기록(직접 배치는 레벨1 이 담당)
      out.push({ level: 3, kind: '연쇄', moves: all, steps: all.length,
        desc: '연쇄 ' + all.length + '단계로 ' + target.name + ' → ' + labelOf(to) });
    }
    return;
  }
  if (depthLeft <= 0) return;
  // 목적지 to 를 막는 점유 수업들(교사/학급 충돌 유발)을 빈 슬롯으로 선이동
  var blockers = blockersAt(model, config, target, to);
  for (var b = 0; b < blockers.length; b++) {
    if (ctx.nodes >= NODE_CAP || out.length >= CAND_CAP) return;
    var occ = blockers[b];
    var occEntry = _resolveEntry(model, occ);
    if (!occEntry) continue;
    var frees = freeSlots(occEntry);
    for (var f = 0; f < frees.length; f++) {
      var dest = frees[f];
      if (dest === to) continue;
      var relo = _expandUnit(model, config, { name: occ.name, row: occ.row, fromIdx: occ.idx, toIdx: dest });
      if (_checkMovesDelta(model, config, relo).blocks.length) continue;
      var nextModel = _applyMoves(model, relo);
      resolve(nextModel, config, target, to, movesSoFar.concat(relo), depthLeft - 1, ctx, out);
      if (out.length >= CAND_CAP || ctx.nodes >= NODE_CAP) return;
    }
  }
}

// 목적지 to 에 대상 배치를 막는 교사 행 수업 목록
function blockersAt(model, config, target, to) {
  var res = [];
  var teachers = teachersOf(model);
  var tEntry = _resolveEntry(model, target);
  // 대상 교사 자신이 to 에 이미 수업 → 교사 중복 유발
  if (tEntry && tEntry.slots[to]) res.push({ name: target.name, row: target.row, idx: to });
  // 대상 학급과 겹치는 다른 교사 수업(학급 중복)
  var tg = _expandTargets(subjectAt(model, target), config);
  var wantCls = {}; tg.classes.forEach(function (c) { wantCls[c.cls] = true; });
  teachers.forEach(function (e) {
    if (e.name === target.name) return;
    var subj = e.slots[to];
    if (!subj) return;
    var og = _expandTargets(subj, config);
    if (og.classes.some(function (c) { return wantCls[c.cls]; })) res.push({ name: e.name, row: e.row, idx: to });
  });
  return res;
}

function subjectAt(model, target) {
  var e = _resolveEntry(model, target);
  return e ? e.slots[target.fromIdx] : '';
}
function isTeam(config, subject) {
  var tt = (config && config.teamTeaching) || {};
  return Object.prototype.hasOwnProperty.call(tt, subject);
}
function isUnit(config, subject) {
  if (isTeam(config, subject)) return true;
  var groups = (config && config.linkedGroups) || {};
  for (var g in groups) if (Object.prototype.hasOwnProperty.call(groups, g) && groups[g].indexOf(subject) !== -1) return true;
  return false;
}
function labelOf(idx) { return CM ? CM.slotLabel(idx) : slotLabel(idx); }

// === 복수 해 열거 (planMovesTo) ===============================================
// 이동집합 정규화 서명: 각 이동 `${row}:${fromIdx}→${toIdx}` 을 정렬 후 '|' 결합.
function pmtSig(moves) {
  return moves.map(function (m) { return m.row + ':' + m.fromIdx + '→' + m.toIdx; }).sort().join('|');
}

// relo 를 moves 에 병합. 완전 중복은 스킵, 같은(row,fromIdx) 다른 toIdx 는 무효(null 반환).
function pmtMerge(moves, relo) {
  var out = moves.slice();
  for (var i = 0; i < relo.length; i++) {
    var m = relo[i], conflict = false, dup = false;
    for (var j = 0; j < out.length; j++) {
      var o = out[j];
      if (o.row === m.row && o.fromIdx === m.fromIdx) {
        if (o.toIdx === m.toIdx) { dup = true; } else { conflict = true; }
        break;
      }
    }
    if (conflict) return null;
    if (!dup) out.push(m);
  }
  return out;
}

// 막힌 슬롯의 '충돌 참여' 점유 수업만 선별(교사중복 동일행 / 학급중복 학급겹침). 원본 모델 기준.
function pmtOccupants(model, config, moves, blocks) {
  var movedFrom = {};
  moves.forEach(function (mv) { movedFrom[mv.row + '@' + mv.fromIdx] = true; });
  var inRowsBySlot = {}, inClsBySlot = {};
  moves.forEach(function (mv) {
    var e = _resolveEntry(model, mv);
    var subj = e ? e.slots[mv.fromIdx] : '';
    (inRowsBySlot[mv.toIdx] = inRowsBySlot[mv.toIdx] || {})[mv.row] = true;
    var cs = _expandTargets(subj, config).classes.map(function (c) { return c.cls; });
    inClsBySlot[mv.toIdx] = (inClsBySlot[mv.toIdx] || []).concat(cs);
  });
  var slotsSeen = {}, occSeen = {}, list = [];
  blocks.forEach(function (c) {
    var S = c.slot;
    if (slotsSeen[S]) return; slotsSeen[S] = true;
    var inRows = inRowsBySlot[S] || {}, inCls = inClsBySlot[S] || [];
    teachersOf(model).forEach(function (t) {
      var subj = t.slots[S];
      if (!subj) return;
      if (movedFrom[t.row + '@' + S]) return;               // 이미 S 밖으로 이동됨
      var participates = !!inRows[t.row];                    // 동일 교사행 교사중복
      if (!participates) {
        var cs = _expandTargets(subj, config).classes.map(function (x) { return x.cls; });
        participates = cs.some(function (x) { return inCls.indexOf(x) !== -1; }); // 학급 겹침
      }
      if (!participates) return;
      var key = t.row + '@' + S;
      if (occSeen[key]) return; occSeen[key] = true;
      list.push({ name: t.name, row: t.row, idx: S });
    });
  });
  return list;
}

// 점유 수업 relo 후보 목적지: (원본) 자기 교사 빈 슬롯 ∪ 현재 이동집합이 비운 슬롯(스왑 유도). 오름차순.
// emptyOnly=true(경량 스캔/planMovesTo 1차 패스): 스왑 유도 슬롯을 제외한 빈 슬롯만(진부분집합).
function pmtDests(model, occ, moves, emptyOnly) {
  var set = {};
  var e = _resolveEntry(model, { name: occ.name, row: occ.row });
  if (e) { for (var i = 0; i < _SLOT(); i++) if (!e.slots[i]) set[i] = true; }
  if (!emptyOnly) moves.forEach(function (mv) { set[mv.fromIdx] = true; });
  var dests = [];
  Object.keys(set).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
    if (d !== occ.idx) dests.push(d);
  });
  return dests;
}

// DFS: 이동집합이 원본 대비 무충돌이면 기록, 아니면 참여 점유 수업을 후보지로 relo 후 재귀.
function pmtSearch(model, config, moves, steps, depthLeft, ctx) {
  if (ctx.plans.length >= ctx.maxPlans) return;
  if (ctx.nodes >= ctx.nodeCap) return;
  ctx.nodes++;
  var delta = _checkMovesDelta(model, config, moves); // 항상 원본 모델 기준
  if (delta.blocks.length === 0) {
    var s = pmtSig(moves);
    if (!ctx.seen[s]) {
      ctx.seen[s] = true;
      ctx.plans.push({ moves: moves, kind: (s === ctx.targetSig ? 'direct' : 'chain'), steps: steps });
    }
    return;
  }
  if (depthLeft <= 0) return;
  var occs = pmtOccupants(model, config, moves, delta.blocks);
  for (var i = 0; i < occs.length; i++) {
    var occ = occs[i];
    var dests = pmtDests(model, occ, moves, ctx.emptyOnly);
    for (var d = 0; d < dests.length; d++) {
      if (ctx.plans.length >= ctx.maxPlans || ctx.nodes >= ctx.nodeCap) return;
      var relo = _expandUnit(model, config, { name: occ.name, row: occ.row, fromIdx: occ.idx, toIdx: dests[d] });
      var next = pmtMerge(moves, relo);
      if (!next) continue;
      pmtSearch(model, config, next, steps + 1, depthLeft - 1, ctx);
    }
  }
}

// planMovesTo(model, config, move, toIdx, opts) → Array<{moves, kind, steps}>
// move={name,row,fromIdx}. toIdx 에 대상 단위를 놓는 서로 다른 무충돌 계획들을 열거.
// 모든 계획: _checkMovesDelta(원본, plan.moves).blocks.length===0 (하드 불변식).
function planMovesTo(model, config, move, toIdx, opts) {
  opts = opts || {};
  var maxPlans = (opts.maxPlans == null) ? 6 : opts.maxPlans;
  var maxDepth = (opts.maxDepth == null) ? 4 : opts.maxDepth;
  var nodeCap = (opts.nodeCap == null) ? NODE_CAP : opts.nodeCap;
  var tEntry = _resolveEntry(model, { name: move.name, row: move.row });
  var target = { name: move.name, row: tEntry ? tEntry.row : move.row, fromIdx: move.fromIdx };
  if (toIdx === target.fromIdx) return [];
  var placeMoves = _expandUnit(model, config, { name: target.name, row: target.row, fromIdx: target.fromIdx, toIdx: toIdx });
  var ctx = { nodes: 0, nodeCap: nodeCap, maxPlans: maxPlans, plans: [], seen: {}, targetSig: pmtSig(placeMoves), emptyOnly: !!opts.emptyOnly };
  // 1차 패스: 빈슬롯 전용(경량) 탐색을 먼저 완주. 경량 스캔(planScanTo/All)과 '같은 깊이(SCAN_DEPTH)·
  //   같은 emptyOnly·같은 DFS 순서'로, 단 '더 큰 예산(nodeCap)'으로 탐색하므로, 스캔이 찾는 모든 해를
  //   여기서 반드시 먼저 발견 → "스캔 hit ⟹ planMovesTo 해 존재" 부분집합 하드 불변식을 예산과
  //   무관하게 보장(스왑 유도 분기의 예산 소진으로 해를 놓치던 문제 제거).
  //   (opts.emptyOnly 이면 스캔 자신의 호출 — 1차 패스만 수행하고 스왑 패스는 생략.)
  if (!ctx.emptyOnly) {
    ctx.emptyOnly = true;
    // 1차 패스 깊이는 스캔과 '동일한' SCAN_DEPTH 여야 한다. 더 깊게(maxDepth) 탐색하면 DFS 가
    // 스캔이 찾는 해 이전에 더 깊은 분기를 먼저 소진해 순서가 어긋난다(같은 깊이라야 동일 순서·부분집합).
    pmtSearch(model, config, placeMoves, 1, Math.min(SCAN_DEPTH, maxDepth), ctx);
    ctx.emptyOnly = false;
  }
  // 2차 패스: 스왑 유도 포함 전체 탐색(빈슬롯 해는 seen 으로 중복 제거, 스왑 유도 해만 추가).
  pmtSearch(model, config, placeMoves, 1, maxDepth, ctx);
  // 3차 패스: 두 열 맞교환(Kempe). planScanAll 과 동일한 결정적 planSwapTo 를 호출 → 부분집합 불변식 보장.
  //   emptyOnly(스캔 자기호출)일 때는 생략(스캔의 swap 은 planScanAll 이 직접 수행).
  if (!opts.emptyOnly) {
    var sw = planSwapTo(model, config, target, toIdx);
    if (sw) {
      var ssig = pmtSig(sw.moves);
      if (!ctx.seen[ssig]) {
        ctx.seen[ssig] = true;
        // 상한 도달 시: maxPlans>1(열거)이면 최악 경로를 swap 으로 교체(최소 1개 포함 보장).
        // maxPlans===1(planMoveTo/단일 최선)이면 기존 direct/chain 을 swap 으로 덮지 않음(단일 최선 의미 보존).
        // 단, 다른 해가 하나도 없으면(빈 plans) swap 이 유일 해이므로 항상 push.
        if (ctx.plans.length >= maxPlans) { if (maxPlans > 1) ctx.plans[maxPlans - 1] = sw; }
        else ctx.plans.push(sw);
      }
    }
  }
  ctx.plans.sort(function (a, b) { return (a.moves.length - b.moves.length) || (a.steps - b.steps); });
  return ctx.plans;
}

// swapOccupants — 맞교환 전용 점유행 탐색. pmtOccupants(교사중복 동일행 / 학급중복 겹침) 로직에
// 더해 block.subjects 참여(일부↔정규처럼 expandTargets 로 학급이 안 잡히는 충돌)까지 포괄한다.
// 원본 모델 기준, row 로 식별(동명 교사 안전). pmtSearch 의 pmtOccupants 는 건드리지 않는다.
function swapOccupants(model, config, moves, blocks) {
  var movedFrom = {};
  moves.forEach(function (mv) { movedFrom[mv.row + '@' + mv.fromIdx] = true; });
  var inRowsBySlot = {}, inClsBySlot = {}, subjBySlot = {};
  moves.forEach(function (mv) {
    var e = _resolveEntry(model, mv);
    var subj = e ? e.slots[mv.fromIdx] : '';
    (inRowsBySlot[mv.toIdx] = inRowsBySlot[mv.toIdx] || {})[mv.row] = true;
    var cs = _expandTargets(subj, config).classes.map(function (c) { return c.cls; });
    inClsBySlot[mv.toIdx] = (inClsBySlot[mv.toIdx] || []).concat(cs);
  });
  blocks.forEach(function (blk) {
    var S = blk.slot;
    subjBySlot[S] = subjBySlot[S] || {};
    (blk.subjects || []).forEach(function (su) { subjBySlot[S][su] = true; });
  });
  var slotsSeen = {}, occSeen = {}, list = [];
  blocks.forEach(function (c) {
    var S = c.slot;
    if (slotsSeen[S]) return; slotsSeen[S] = true;
    var inRows = inRowsBySlot[S] || {}, inCls = inClsBySlot[S] || [], subjSet = subjBySlot[S] || {};
    teachersOf(model).forEach(function (t) {
      var subj = t.slots[S];
      if (!subj) return;
      if (movedFrom[t.row + '@' + S]) return;                 // 이미 S 밖으로 이동됨
      var participates = !!inRows[t.row] || !!subjSet[subj];   // 교사중복(동일행) 또는 block 참여 과목
      if (!participates) {
        var cs = _expandTargets(subj, config).classes.map(function (x) { return x.cls; });
        participates = cs.some(function (x) { return inCls.indexOf(x) !== -1; }); // 학급 겹침
      }
      if (!participates) return;
      var key = t.row + '@' + S;
      if (occSeen[key]) return; occSeen[key] = true;
      list.push({ name: t.name, row: t.row, idx: S });
    });
  });
  return list;
}

// planSwapTo(model, config, move, toIdx[, budget]) → { moves, kind:'swap', steps } | null
// 두 열(F=move.fromIdx, T=toIdx) 맞교환(Kempe 체인). 대상 유닛을 F→T 로 옮기고, 그 결과 T(또는 F)
// 에서 충돌하는 기존 배정을 반대 열로 밀어내는 반복 수리(검증기 checkMovesDelta 를 오라클로).
// 성공 계획은 하드 불변식 checkMovesDelta(원본, moves).blocks.length===0 을 만족.
// 결정적(예산 미지정이면 반복 상한만) → planScanAll/planMovesTo 어디서 호출해도 동일 결과
//   ⇒ "스캔 hit ⟹ planMovesTo 해 존재" 부분집합 불변식이 자동 성립.
// budget(선택, {left}): 스캔이 총 시도량을 제한하려 넘김. 소진 시 abort(null). planMovesTo 는 미지정(완전 탐색).
function planSwapTo(model, config, move, toIdx, budget) {
  var F = move.fromIdx, T = toIdx;
  if (F == null || T == null || F === T) return null;
  var tEntry = _resolveEntry(model, { name: move.name, row: move.row });
  if (!tEntry || !tEntry.slots[F]) return null;
  // 1) 대상 유닛(팀·연결그룹) 전체를 F→T 로.
  var moves = _expandUnit(model, config, { name: move.name, row: tEntry.row, fromIdx: F, toIdx: T });
  if (!moves.length) return null;
  var relos = 0;
  for (var iter = 0; iter < 24; iter++) {
    if (budget) { if (budget.left <= 0) return null; budget.left--; }
    var r = _checkMovesDelta(model, config, moves);
    if (r.blocks.length === 0) return { moves: moves, kind: 'swap', steps: relos + 1 };
    // 맞교환으로 해소 불가한 block → 즉시 null.
    for (var b = 0; b < r.blocks.length; b++) {
      var bt = r.blocks[b].type, bslot = r.blocks[b].slot;
      if (bt === 'fixed' || bt === 'unavailable' || bt === 'pinned') return null;
      if (bslot !== F && bslot !== T) return null; // 두 열 밖 충돌
    }
    // 충돌 유발 기존 배정 행(아직 moves 에 없는 점유행) 을 반대 열로.
    var occs = swapOccupants(model, config, moves, r.blocks);
    if (!occs.length) return null; // 옮길 원인 행을 못 찾음 → 진전 불가.
    var added = false;
    for (var i = 0; i < occs.length; i++) {
      var occ = occs[i];
      var opp = (occ.idx === F) ? T : F; // 반대 열(F 점유→T, T 점유→F)
      var relo = _expandUnit(model, config, { name: occ.name, row: occ.row, fromIdx: occ.idx, toIdx: opp });
      var merged = pmtMerge(moves, relo);
      if (!merged) return null; // 같은 (행,열) 두 방향 → 해소 불가
      if (merged.length > moves.length) { added = true; relos++; }
      moves = merged;
    }
    if (!added) return null; // 진전 없음(무한루프 방지)
  }
  return null; // 반복 상한 초과
}

// === 경량 후보 스캔 (planScanTo / planScanAll) ================================
// 클라이언트 셀 클릭 시 40 슬롯 후보 색칠 전용. planMovesTo 의 진부분집합:
//   빈 슬롯 재배치만(emptyOnly), 깊이 ≤ SCAN_DEPTH(<4), 낮은 노드 예산, 첫 해 조기종료.
// 하드 불변식: 반환하는 모든 계획은 checkMovesDelta 무충돌(pmtSearch 수용 조건)이며,
//   같은 (target,toIdx) 에 대해 planMovesTo 도 최소 1개 계획을 가진다(부분집합 논증).
// 실측 튜닝(43교사 실데이터, node 프로브): NORMAL 40슬롯 스캔 worst≈150ms(<200),
// UNIT worst≈584ms(<800). 슬롯당 상한 120 은 미해결 슬롯의 조기 종료로 worst-case 를 낮춘다.
var SCAN_SLOT_CAP = 120;          // 슬롯당 노드 상한(planScanTo/배치 per-slot 공통)
var SCAN_TOTAL_CAP = 1200;        // NORMAL 배치 스캔 공유 총예산
var SCAN_UNIT_TOTAL_CAP = 4200;   // UNIT(연결그룹/팀) 배치 스캔 공유 총예산(노드당 비용↑)
var SCAN_DEPTH = 3;

// planScanTo(model, config, move, toIdx) → { moves, kind, steps } | null (슬롯 1개)
function planScanTo(model, config, move, toIdx) {
  return planMovesTo(model, config, move, toIdx,
    { maxPlans: 1, maxDepth: SCAN_DEPTH, nodeCap: SCAN_SLOT_CAP, emptyOnly: true })[0] || null;
}

// planScanAll(model, config, move, opts) → Array(SLOT_COUNT): 각 원소 {moves,kind,steps} | null.
// 40 슬롯을 '하나의 공유 노드 예산'으로 스캔(구 level3 의 ctx.nodes 공유와 동일 취지)해 총작업을
// 강하게 제한한다. Pass1: 직접 배치(1노드/슬롯, 항상 확보) → green. Pass2: 나머지 슬롯을
// 충돌 적은 순으로 연쇄 탐색(빈슬롯 재배치, 공유 예산) → chain(yellow).
// 각 슬롯 결과 ⊆ planScanTo(그 슬롯) ⊆ planMovesTo(그 슬롯) 이 계획을 가짐(부분집합).
function planScanAll(model, config, move, opts) {
  opts = opts || {};
  var n = _SLOT();
  var results = new Array(n);
  for (var k = 0; k < n; k++) results[k] = null;

  var tEntry = _resolveEntry(model, { name: move.name, row: move.row });
  var target = { name: move.name, row: tEntry ? tEntry.row : move.row, fromIdx: move.fromIdx };
  var subj = tEntry ? tEntry.slots[target.fromIdx] : '';
  if (!tEntry || !subj) return results;

  var unit = isUnit(config, subj);
  var perSlotCap = (opts.perSlotCap != null) ? opts.perSlotCap : SCAN_SLOT_CAP;
  var totalCap = (opts.nodeCap != null) ? opts.nodeCap : (unit ? SCAN_UNIT_TOTAL_CAP : SCAN_TOTAL_CAP);
  var maxDepth = (opts.maxDepth != null) ? opts.maxDepth : SCAN_DEPTH;

  // Pass 1: 직접 배치(1노드) — 저렴하고 항상 실행 → 모든 green 후보 보장.
  var place = new Array(n);
  var pending = [];
  for (var to = 0; to < n; to++) {
    if (to === target.fromIdx) continue;
    var pm = _expandUnit(model, config, { name: target.name, row: target.row, fromIdx: target.fromIdx, toIdx: to });
    place[to] = pm;
    var delta = _checkMovesDelta(model, config, pm);
    if (delta.blocks.length === 0) {
      results[to] = { moves: pm, kind: 'direct', steps: 1 };
    } else {
      pending.push({ to: to, nb: delta.blocks.length });
    }
  }

  // Pass 2: 연쇄 탐색(빈슬롯 재배치). 공유 총예산 소진 시 중단. 충돌 적은 슬롯 우선(커버리지↑).
  pending.sort(function (a, b) { return a.nb - b.nb; });
  var spent = 0;
  for (var p = 0; p < pending.length; p++) {
    if (spent >= totalCap) break;
    var pto = pending[p].to;
    var placeMoves = place[pto];
    var ctx = {
      nodes: 0, nodeCap: Math.min(perSlotCap, totalCap - spent),
      maxPlans: 1, plans: [], seen: {}, targetSig: pmtSig(placeMoves), emptyOnly: true,
    };
    pmtSearch(model, config, placeMoves, 1, maxDepth, ctx);
    spent += ctx.nodes;
    if (ctx.plans.length) results[pto] = ctx.plans[0];
  }

  // Pass 3: 여전히 후보 없는 슬롯에 두 열 맞교환(Kempe) 시도. planSwapTo 는 결정적 →
  //   planMovesTo 도 같은 슬롯에 동일 swap 을 반환(부분집합 불변식). 공유 예산으로 총 시도량 제한.
  var swapBudget = { left: (opts.swapNodeCap != null) ? opts.swapNodeCap : (unit ? SCAN_UNIT_TOTAL_CAP : SCAN_TOTAL_CAP) };
  for (var so = 0; so < n; so++) {
    if (results[so] || so === target.fromIdx) continue;
    if (swapBudget.left <= 0) break;
    var sw = planSwapTo(model, config, move, so, swapBudget);
    if (sw) results[so] = sw;
  }
  return results;
}

// planMoveTo(model, config, move, toIdx) → { moves, kind, steps } | null
// planMovesTo 의 첫 해(없으면 null). 기존 동작 보존(레벨1 direct / 팀 / 연쇄 / 고정블록 null).
function planMoveTo(model, config, move, toIdx) {
  return planMovesTo(model, config, move, toIdx, { maxPlans: 1 })[0] || null;
}

// 통합 추천: 레벨1 → 2 → 3, 단계 수 오름차순, 상한 20.
function recommend(model, config, target) {
  var ctx = { nodes: 0 };
  var cands = [].concat(level1(model, config, target), level2(model, config, target), level3(model, config, target, ctx));
  cands.sort(function (a, b) { return a.steps - b.steps || a.level - b.level; });
  return cands.slice(0, CAND_CAP);
}

if (typeof module !== 'undefined') {
  module.exports = {
    NODE_CAP: NODE_CAP, CAND_CAP: CAND_CAP,
    level1: level1, level2: level2, level3: level3, recommend: recommend,
    planMoveTo: planMoveTo, planMovesTo: planMovesTo,
    planScanTo: planScanTo, planScanAll: planScanAll, planSwapTo: planSwapTo,
  };
}
