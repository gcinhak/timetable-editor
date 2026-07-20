// web_extra — 설정 탭 순수 파서 (SpreadsheetApp 의존 없음).
// Gas_Config.js의 파싱 로직만 이식. 세 블록: [고정블록]/[무반과목]/[팀티칭].
// draft 생성 함수는 이식하지 않음.

var BLOCK_HEADERS = {
  '[고정블록]': ['슬롯', '라벨', '적용학년'],
  '[무반과목]': ['과목명', '대상학급', '비고'],
  '[팀티칭]': ['과목명', '교사들'],
  '[연결그룹]': ['그룹명', '과목들'],
  '[교사불가]': ['교사명', '슬롯들'],
  '[고정수업]': ['과목명', '교시들'],
  '[정규교시]': ['학년', '요일', '교시'],
};

var DAY_MAP = { '월': 0, '화': 1, '수': 2, '목': 3, '금': 4 };
var REV_DAY = ['월', '화', '수', '목', '금'];

function isBlockHeader_(block, row) {
  var h = BLOCK_HEADERS[block];
  if (!h) return false;
  for (var i = 0; i < h.length; i++) {
    if (String(row[i] == null ? '' : row[i]).trim() !== h[i]) return false;
  }
  return true;
}

// 블록 분리 + 파서가 버리는 원본 행(rawExtras) 수집.
// extras 키: 블록명 + '__outside__'(첫 블록 이전). 값: 버려지는 원본 행 배열.
//  (a) 첫 셀은 비었지만 다른 셀에 내용이 있는 행, (b) 블록 이전의 내용 있는 행.
//  (고정블록의 슬롯 파싱 실패 행은 parseConfig 에서 추가로 이동한다.)
function scanBlocks_(values) {
  var blocks = {}, extras = {}, cur = null;
  function rowHasContent(row) {
    for (var j = 0; j < row.length; j++) {
      if (String(row[j] == null ? '' : row[j]).trim() !== '') return true;
    }
    return false;
  }
  for (var i = 0; i < values.length; i++) {
    var row = values[i] || [];
    var first = String((row[0] != null ? row[0] : '')).trim();
    if (/^\[.*\]$/.test(first)) { cur = first; blocks[cur] = blocks[cur] || []; continue; }
    if (!cur) {
      if (rowHasContent(row)) (extras['__outside__'] = extras['__outside__'] || []).push(row);
      continue;
    }
    if (blocks[cur].length === 0 && isBlockHeader_(cur, row)) continue; // 블록 헤더 행 건너뜀
    if (first === '') {
      if (rowHasContent(row)) (extras[cur] = extras[cur] || []).push(row);
      continue;
    }
    blocks[cur].push(row);
  }
  return { blocks: blocks, extras: extras };
}

function parseSlotLabel_(label) {
  var m = /^([월화수목금])\s*([1-8])$/.exec(String(label).trim());
  if (!m) return null;
  return { day: DAY_MAP[m[1]], period: parseInt(m[2], 10) };
}

function parseFixedBlocks_(rows) {
  var out = [];
  rows.forEach(function (r) {
    var sl = parseSlotLabel_(r[0]);
    if (!sl) return;
    var gtext = String(r[2] == null ? '' : r[2]).trim();
    var grades, classes = [], partialGrades = [];
    if (gtext === '') grades = [];
    else if (gtext === '전체') grades = 'all';
    else {
      grades = []; partialGrades = [];
      gtext.split(/[,\s]+/).filter(Boolean).forEach(function (tok) {
        var mp = /^(\d+)일부$/.exec(tok);
        if (mp) partialGrades.push(parseInt(mp[1], 10));
        else if (/^\d+$/.test(tok)) grades.push(parseInt(tok, 10));
        else if (/^\d+[A-C]$/.test(tok)) classes.push(tok);
      });
    }
    out.push({ day: sl.day, period: sl.period, label: String(r[1] || '').trim(), grades: grades, classes: classes, partialGrades: partialGrades });
  });
  return out;
}

function parseClassless_(rows) {
  var out = {};
  rows.forEach(function (r) {
    var subj = String(r[0] || '').trim();
    if (!subj) return;
    var targets = String(r[1] == null ? '' : r[1]).trim();
    if (targets === '') return; // 미지정(미분류): 키를 만들지 않음
    var norm = targets.replace(/\s+/g, '');
    if (norm === '없음' || norm === '대상없음') { out[subj] = []; return; } // 대상 없음 확정
    out[subj] = targets.split(/[,\s]+/).filter(Boolean);
  });
  return out;
}

function parseTeam_(rows) {
  var out = {};
  rows.forEach(function (r) {
    var subj = String(r[0] || '').trim();
    if (!subj) return;
    out[subj] = String(r[1] || '').split(/[,\s]+/).filter(Boolean);
  });
  return out;
}

function parseLinked_(rows) {
  var out = {};
  rows.forEach(function (r) {
    var name = String(r[0] || '').trim();
    if (!name) return;
    out[name] = String(r[1] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  });
  return out;
}

function parseUnavailable_(rows) {
  var out = [];
  rows.forEach(function (r) {
    var raw = String(r[0] || '').trim();
    if (!raw) return;
    var name = raw, row = null;
    var m = /^(.+?)\(행(\d+)\)$/.exec(raw);
    if (m) { name = m[1].trim(); row = parseInt(m[2], 10); }
    var slots = [];
    String(r[1] == null ? '' : r[1]).split(/[,\s]+/).filter(Boolean).forEach(function (tok) {
      var sl = parseSlotLabel_(tok);
      if (sl) slots.push(sl.day * 8 + (sl.period - 1));
    });
    var rec = { name: name, slots: slots };
    if (row != null) rec.row = row;
    out.push(rec);
  });
  return out;
}

// [고정수업] 블록: 과목명 | 교시들(쉼표 구분 슬롯 라벨). → { 과목명: [slotIdx...] }
// 인식 불가 라벨은 무시, 동일 슬롯 중복 제거·오름차순 정렬, 슬롯 0개 과목은 제외.
function parsePinnedManual_(rows) {
  var out = {};
  rows.forEach(function (r) {
    var subj = String(r[0] || '').trim();
    if (!subj) return;
    var slots = [];
    String(r[1] == null ? '' : r[1]).split(/[,\s]+/).filter(Boolean).forEach(function (tok) {
      var sl = parseSlotLabel_(tok);
      if (sl) slots.push(sl.day * 8 + (sl.period - 1));
    });
    slots = slots.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    if (slots.length) out[subj] = slots;
  });
  return out;
}

// [정규교시] 블록: 학년 | 요일 | 교시. → [{grade,day,period}]
// 요일/교시 형식 불일치 행은 null(파싱 실패) → parseConfig 에서 rawExtras 로 이동.
// 사용처 없음(이동 규칙 제거됨) — 기존 시트의 [정규교시] 내용을 왕복 보존하려고 파싱만 유지한다.
function parseRegularSlot_(r) {
  var gtext = String(r[0] == null ? '' : r[0]).trim();
  var dtext = String(r[1] == null ? '' : r[1]).trim();
  var ptext = String(r[2] == null ? '' : r[2]).trim();
  if (!/^\d+$/.test(gtext)) return null;
  if (!/^[월화수목금]$/.test(dtext)) return null;
  if (!/^[1-8]$/.test(ptext)) return null;
  return { grade: parseInt(gtext, 10), day: DAY_MAP[dtext], period: parseInt(ptext, 10) };
}
function parseRegularSlots_(rows) {
  var out = [];
  rows.forEach(function (r) { var s = parseRegularSlot_(r); if (s) out.push(s); });
  return out;
}

// 고정수업 우선순위(웹 전용, 순수): 수동설정(pinnedManual) 우선, 없으면 연결그룹 파생(linkedPinned), 둘 다 없으면 빈 값.
// config.pinned / config.pinnedSource('manual'|'linked'|'none') 를 설정하고 config 반환.
function resolvePinned(config, linkedPinned) {
  var manual = config.pinnedManual || {};
  var keys = Object.keys(manual).filter(function (k) { return (manual[k] || []).length >= 1; });
  if (keys.length >= 1) {
    var m = {};
    keys.forEach(function (k) { m[k] = manual[k]; });
    config.pinned = m;
    config.pinnedSource = 'manual';
  } else if (linkedPinned && Object.keys(linkedPinned).length > 0) {
    config.pinned = linkedPinned;
    config.pinnedSource = 'linked';
  } else {
    config.pinned = {};
    config.pinnedSource = 'none';
  }
  return config;
}

// values: 설정 탭의 2차원 배열 → { fixedBlocks, classless, teamTeaching, linkedGroups, classlessNotes, rawExtras }
function parseConfig(values) {
  var scan = scanBlocks_(values || []);
  var blocks = scan.blocks, extras = scan.extras;

  // 고정블록: 슬롯 라벨 파싱 실패 행(첫 셀 있음)을 rawExtras 로 이동.
  var fixedKept = [];
  (blocks['[고정블록]'] || []).forEach(function (r) {
    if (parseSlotLabel_(r[0]) === null) (extras['[고정블록]'] = extras['[고정블록]'] || []).push(r);
    else fixedKept.push(r);
  });

  // 정규교시: 파싱 실패 행(첫 셀 있음)을 rawExtras 로 이동.
  var regularKept = [];
  (blocks['[정규교시]'] || []).forEach(function (r) {
    if (parseRegularSlot_(r) === null) (extras['[정규교시]'] = extras['[정규교시]'] || []).push(r);
    else regularKept.push(r);
  });

  // 무반과목 비고(r[2]) 보존: 비어있지 않은 것만.
  var classlessRows = blocks['[무반과목]'] || [];
  var notes = {};
  classlessRows.forEach(function (r) {
    var subj = String(r[0] || '').trim();
    if (!subj) return;
    var note = (r[2] == null) ? '' : String(r[2]);
    if (note !== '') notes[subj] = note;
  });

  var classlessUnset = [];
  classlessRows.forEach(function (r) {
    var subj = String(r[0] || '').trim();
    if (!subj) return;
    var targets = String(r[1] == null ? '' : r[1]).trim();
    if (targets === '') classlessUnset.push(subj);
  });

  var rawExtras = {};
  Object.keys(extras).forEach(function (k) { if (extras[k] && extras[k].length) rawExtras[k] = extras[k]; });

  return {
    fixedBlocks: parseFixedBlocks_(fixedKept),
    classless: parseClassless_(classlessRows),
    teamTeaching: parseTeam_(blocks['[팀티칭]'] || []),
    linkedGroups: parseLinked_(blocks['[연결그룹]'] || []),
    unavailable: parseUnavailable_(blocks['[교사불가]'] || []),
    pinnedManual: parsePinnedManual_(blocks['[고정수업]'] || []),
    regularSlots: parseRegularSlots_(regularKept),
    classlessNotes: notes,
    classlessUnset: classlessUnset,
    rawExtras: rawExtras,
  };
}

// config 객체 → 설정 탭 2차원 배열. parseConfig 의 정확한 역함수(왕복 일치).
// 블록 순서: [고정블록] → [무반과목] → [팀티칭] → [연결그룹]. 블록마다 헤더행 포함, 블록 사이 빈 행 1개.
function serializeConfig(config) {
  var cfg = config || {};
  var extras = cfg.rawExtras || {};
  var out = [];

  function emitExtras(key) { (extras[key] || []).forEach(function (r) { out.push(r); }); }

  emitExtras('__outside__');

  out.push(['[고정블록]']);
  out.push(BLOCK_HEADERS['[고정블록]'].slice());
  (cfg.fixedBlocks || []).forEach(function (b) {
    var slot = REV_DAY[b.day] + b.period;
    var gtext;
    if (b.grades === 'all') gtext = '전체';
    else gtext = (b.grades || []).map(String)
      .concat((b.partialGrades || []).map(function (g) { return g + '일부'; }))
      .concat(b.classes || []).join(',');
    out.push([slot, String(b.label == null ? '' : b.label), gtext]);
  });
  emitExtras('[고정블록]');
  out.push(['']);

  out.push(['[무반과목]']);
  out.push(BLOCK_HEADERS['[무반과목]'].slice());
  var classless = cfg.classless || {};
  var notes = cfg.classlessNotes || {};
  Object.keys(classless).forEach(function (subj) {
    var val = classless[subj] || [];
    out.push([subj, val.length ? val.join(',') : '없음', notes[subj] || '']);
  });
  (cfg.classlessUnset || []).forEach(function (subj) {
    if (Object.prototype.hasOwnProperty.call(classless, subj)) return; // 이미 매핑된 과목은 중복 출력 금지
    out.push([subj, '', notes[subj] || '']);
  });
  emitExtras('[무반과목]');
  out.push(['']);

  out.push(['[팀티칭]']);
  out.push(BLOCK_HEADERS['[팀티칭]'].slice());
  var team = cfg.teamTeaching || {};
  Object.keys(team).forEach(function (subj) {
    out.push([subj, (team[subj] || []).join(', ')]);
  });
  emitExtras('[팀티칭]');
  out.push(['']);

  out.push(['[연결그룹]']);
  out.push(BLOCK_HEADERS['[연결그룹]'].slice());
  var linked = cfg.linkedGroups || {};
  Object.keys(linked).forEach(function (name) {
    out.push([name, (linked[name] || []).join(', ')]);
  });
  emitExtras('[연결그룹]');
  out.push(['']);

  out.push(['[교사불가]']);
  out.push(BLOCK_HEADERS['[교사불가]'].slice());
  var unav = cfg.unavailable || [];
  unav.forEach(function (u) {
    var nameTok = (u.row != null) ? (u.name + '(행' + u.row + ')') : u.name;
    var slots = (u.slots || []).map(function (idx) { return REV_DAY[Math.floor(idx / 8)] + (idx % 8 + 1); }).join(', ');
    out.push([nameTok, slots]);
  });
  emitExtras('[교사불가]');
  out.push(['']);

  out.push(['[고정수업]']);
  out.push(BLOCK_HEADERS['[고정수업]'].slice());
  var pm = cfg.pinnedManual || {};
  Object.keys(pm).forEach(function (subj) {
    var slots = (pm[subj] || []).map(function (idx) { return REV_DAY[Math.floor(idx / 8)] + (idx % 8 + 1); }).join(', ');
    out.push([subj, slots]);
  });
  emitExtras('[고정수업]');

  out.push(['']);

  out.push(['[정규교시]']);
  out.push(BLOCK_HEADERS['[정규교시]'].slice());
  (cfg.regularSlots || []).forEach(function (s) {
    out.push([String(s.grade), REV_DAY[s.day], String(s.period)]);
  });
  emitExtras('[정규교시]');

  return out;
}

if (typeof module !== 'undefined') { module.exports = { parseConfig: parseConfig, serializeConfig: serializeConfig, resolvePinned: resolvePinned }; }
