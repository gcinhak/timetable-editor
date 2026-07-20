// Core_Model — 순수 로직 (SpreadsheetApp 의존 없음).
// 2차원 배열(데이터행: [교사, 강의실, ...40슬롯]) → 모델.

var DAYS = ['월', '화', '수', '목', '금'];
var SLOT_COUNT = 40;

// 슬롯 인덱스(0..39) = day*8 + (period-1). 시트 열(1-based) = 3 + idx.
function slotIndex(day, period) { return day * 8 + (period - 1); }
function indexToSlot(idx) { return { day: Math.floor(idx / 8), period: (idx % 8) + 1 }; }
function slotLabel(idx) { var s = indexToSlot(idx); return DAYS[s.day] + s.period; }

// 과목명 분해: ^(.+?)(7|8|9|10|11|12)([A-C])$ → {abbr, grade, cls}
var SUBJECT_RE = /^(.+?)(7|8|9|10|11|12)([A-C])$/;
function parseSubject(str) {
  if (!str) return null;
  var m = SUBJECT_RE.exec(String(str).trim());
  if (!m) return null;
  return { abbr: m[1], grade: parseInt(m[2], 10), cls: m[2] + m[3] };
}

// A열 이름으로 행 타입 분류
var RA_SLOT_RE = /^RA[1-9]$/;      // RA1..RA9
var RA_COURSE_RE = /^RA\d{2}$/;    // RA01..RA29
function rowType(name) {
  if (!name) return 'empty';
  var n = String(name).trim();
  if (RA_SLOT_RE.test(n)) return 'raSlot';
  if (RA_COURSE_RE.test(n)) return 'raCourse';
  return 'teacher';
}

// rows: 데이터행 2D 배열. dataStartRow: 시트 1-based 시작행(기본 3) — entry.row 계산용.
function buildModel(rows, dataStartRow) {
  var start = dataStartRow || 3;
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var name = row[0];
    var type = rowType(name);
    if (type === 'empty') continue;
    var slots = [];
    for (var s = 0; s < SLOT_COUNT; s++) {
      var v = row[2 + s];
      slots.push(v == null ? '' : String(v));
    }
    entries.push({
      name: String(name).trim(),
      room: row[1] == null ? '' : String(row[1]),
      type: type,
      row: start + i,
      slots: slots,
    });
  }
  var teachers = entries.filter(function (e) { return e.type === 'teacher'; });
  return { entries: entries, teachers: teachers, dataStartRow: start };
}

// 모델 깊은 복제(슬롯만 변경되므로 슬롯 배열도 복사)
function cloneModel(model) {
  return {
    dataStartRow: model.dataStartRow,
    entries: model.entries.map(function (e) {
      return { name: e.name, room: e.room, type: e.type, row: e.row, slots: e.slots.slice() };
    }),
    get teachers() { return this.entries.filter(function (x) { return x.type === 'teacher'; }); },
  };
}

// 이름으로 entry 찾기(teacher/RA 포함)
function findEntry(model, name) {
  for (var i = 0; i < model.entries.length; i++) {
    if (model.entries[i].name === name) return model.entries[i];
  }
  return null;
}

// 행 번호로 entry 찾기 (동명이인/동일인 2행 대응 — 식별자는 이름이 아니라 행)
function findEntryByRow(model, row) {
  for (var i = 0; i < model.entries.length; i++) {
    if (model.entries[i].row === row) return model.entries[i];
  }
  return null;
}

// 한 교사의 수업 목록: [{idx, subject, label}]
function teacherClasses(entry) {
  var out = [];
  for (var i = 0; i < SLOT_COUNT; i++) {
    if (entry.slots[i]) out.push({ idx: i, subject: entry.slots[i], label: slotLabel(i) });
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = {
    DAYS: DAYS, SLOT_COUNT: SLOT_COUNT,
    slotIndex: slotIndex, indexToSlot: indexToSlot, slotLabel: slotLabel,
    parseSubject: parseSubject, rowType: rowType,
    buildModel: buildModel, cloneModel: cloneModel,
    findEntry: findEntry, findEntryByRow: findEntryByRow, teacherClasses: teacherClasses,
  };
}
