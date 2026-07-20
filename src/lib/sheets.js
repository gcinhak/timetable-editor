/**
 * Sheets API 순수 헬퍼 + A1 변환 + 그리드 해시.
 * 네트워크 호출은 caller가 주입한 sheetsFetch(path, init)로만 수행한다.
 * (sheetsFetch는 이미 res.json()을 반환하도록 바인딩되어 있음)
 * top-level 네트워크 호출 없음 → 테스트에서 env 없이 순수 함수 import 가능.
 */

// 열 번호(1-based) → 시트 열 문자. 1→A, 26→Z, 27→AA ...
export function colLetter(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 슬롯 인덱스(0..39) → 시트 열 문자. 열 번호(1-based) = 3 + idx. C..AP.
export function slotColLetter(idx) {
  return colLetter(3 + idx);
}

// [{row, idx, value}] → batchUpdate data 항목 [{range, values}].
// slotStartCol(1-based, 기본 3=C) 기준으로 슬롯 idx → 실제 시트 열 매핑.
export function cellsToBatchData(tab, cells, slotStartCol) {
  var start = slotStartCol || 3;
  return (cells || []).map(function (c) {
    return {
      range: "'" + tab + "'!" + colLetter(start + c.idx) + c.row,
      values: [[c.value]]
    };
  });
}

function cyrb53(str) {
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  var out = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return String(out);
}

// 슬롯 셀만으로 결정적 해시. dataStart/dataEnd 는 1-based 시트 행(index dataStart-1..dataEnd-1), 열 index 2..41.
// A/B열(0,1)·범위 밖 행/열 변경은 해시에 영향 없음. 짧은 행은 ''로 보정.
export function hashGrid(grid, dataStart, dataEnd) {
  var g = grid || [];
  var parts = [];
  for (var r = dataStart - 1; r <= dataEnd - 1; r++) {
    var row = g[r] || [];
    for (var c = 2; c <= 41; c++) {
      var v = row[c];
      parts.push(v == null ? '' : String(v));
    }
  }
  return cyrb53(parts.join(''));
}

// 2차원 배열 → 결정적 문자열 해시(설정 낙관적 락용).
export function hashValues(values) {
  return cyrb53(JSON.stringify(values || []));
}

// 열 A(index 0)가 비어있지 않은(trim) 마지막 행의 1-based 번호. 없으면 0.
export function lastDataRow(grid) {
  var g = grid || [];
  for (var r = g.length - 1; r >= 0; r--) {
    var v = g[r] && g[r][0];
    if (v != null && String(v).trim() !== '') return r + 1;
  }
  return 0;
}

// 시트 목록: [{sheetId, title, index}]
export async function getSheets(sheetsFetch) {
  var data = await sheetsFetch('?fields=sheets.properties(sheetId,title,index)', { method: 'GET' });
  return (data.sheets || []).map(function (s) {
    return { sheetId: s.properties.sheetId, title: s.properties.title, index: s.properties.index };
  });
}

// 여러 범위 일괄 조회 → ranges에 정렬된 2D 배열 배열
export async function batchGetValues(sheetsFetch, ranges) {
  var qs = (ranges || []).map(function (r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
  var data = await sheetsFetch(
    '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS&' + qs,
    { method: 'GET' }
  );
  return (data.valueRanges || []).map(function (vr) { return vr.values || []; });
}

// 서로 독립적인 범위들을 1회의 batchGet 으로 합쳐 읽는다.
// batchGet 은 전부-성공/전부-실패이므로, 실패하면 개별 조회로 한 번만 되돌아간다
// (추가 순차 깊이 1, 실패 경로에서만). 그래야 "한 범위의 실패가 나머지까지 삼키는" 일이 없다.
// 반환: ranges 순서의 [{ values, error }] — error 가 있으면 그 범위만 실패한 것.
export async function batchGetPartial(sheetsFetch, ranges) {
  var rs = ranges || [];
  if (!rs.length) return [];
  try {
    var vals = await batchGetValues(sheetsFetch, rs);
    return rs.map(function (_, i) { return { values: vals[i] || [], error: null }; });
  } catch (_) {
    return Promise.all(rs.map(function (r) {
      return batchGetValues(sheetsFetch, [r]).then(
        function (v) { return { values: v[0] || [], error: null }; },
        function (err) { return { values: null, error: err }; }
      );
    }));
  }
}

// 시간표 탭의 그리드 조회 범위. detectLayout 이 찾을 수 있는 slotStartCol 최대값은 12 이므로
// 슬롯 40개의 끝은 아무리 밀려도 12+39=51열(AY). 넉넉히 A:AY 를 한 번에 읽고 정규화 단계에서 잘라 쓴다
// (헤더 탐지 → 범위 결정 → 그리드 조회의 순차 의존 제거). 빈 후행 열은 Sheets 가 잘라 돌려주므로 응답은 커지지 않는다.
export function gridRange(tab) {
  return "'" + tab + "'!A:" + colLetter(51);
}

// 값 일괄 기록
export async function batchUpdateValues(sheetsFetch, data) {
  return sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data: data })
  });
}

// 행 추가
export async function appendRows(sheetsFetch, tab, rows) {
  return sheetsFetch(
    '/values/' + encodeURIComponent(tab + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }
  );
}

// 시트 추가 → 새 sheetId 반환
export async function addSheet(sheetsFetch, title) {
  var res = await sheetsFetch(':batchUpdate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: title } } }] })
  });
  return res.replies[0].addSheet.properties.sheetId;
}

// 시트 삭제
export async function deleteSheet(sheetsFetch, sheetId) {
  return sheetsFetch(':batchUpdate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: sheetId } }] })
  });
}

// 시트 복제(insertIndex 위치에 삽입) + 기존 탭 이름 정리를 단일 batchUpdate 로 보낸다.
// renames: [{ sheetId, to }] — batchUpdate 는 전부-성공/전부-실패이므로
// "새 탭은 생겼는데 '(최종)' 이동이 실패한" 중간 상태가 남지 않는다.
// 이름을 먼저 떼고 복제하므로 요청 중간에 이름이 겹치는 순간도 없다.
export async function duplicateSheet(sheetsFetch, sourceSheetId, newName, insertIndex, renames) {
  var requests = (renames || []).map(function (r) {
    return { updateSheetProperties: { properties: { sheetId: r.sheetId, title: r.to }, fields: 'title' } };
  });
  requests.push({ duplicateSheet: { sourceSheetId: sourceSheetId, insertSheetIndex: insertIndex, newSheetName: newName } });
  return sheetsFetch(':batchUpdate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: requests })
  });
}

// 레이아웃 탐지: 상위 min(10,행) × 좌측 min(12,열) 범위에서 'Mon1' 셀을 스캔.
// 첫 매치의 { headerRow: r+1, slotStartCol: c+1 }(둘 다 1-based) 반환. 없으면 null.
export function detectLayout(values) {
  var g = values || [];
  var rn = Math.min(10, g.length);
  for (var r = 0; r < rn; r++) {
    var row = g[r] || [];
    var cn = Math.min(12, row.length);
    for (var c = 0; c < cn; c++) {
      if (row[c] === 'Mon1') return { headerRow: r + 1, slotStartCol: c + 1 };
    }
  }
  return null;
}

// 헤더행 탐지(하위호환 wrapper): Mon1이 있는 1-based 행번호. 없으면 null.
export function detectHeaderRow(grid) {
  var l = detectLayout(grid);
  return l ? l.headerRow : null;
}

// 원시 그리드를 표준 42열 그리드로 정규화(행 수 유지).
// out[0]=teacher(시트 A열), out[1]=classroom(slotStartCol>=3 일 때 시트 B열, 아니면 ''),
// out[2..41]=슬롯 40개(원시 열 (slotStartCol-1)..(slotStartCol-1+39), 0-based).
export function normalizeGrid(rawGrid, layout) {
  var start0 = layout.slotStartCol - 1; // 0-based 슬롯 시작 열
  return (rawGrid || []).map(function (raw) {
    var r = raw || [];
    var out = new Array(42);
    out[0] = r[0] != null ? r[0] : '';
    out[1] = layout.slotStartCol >= 3 ? (r[1] != null ? r[1] : '') : '';
    for (var k = 0; k < 40; k++) {
      var v = r[start0 + k];
      out[2 + k] = v != null ? v : '';
    }
    return out;
  });
}

// 차수 탭 판별: 정확히 "{N}차" 또는 "{N}차(최종)" 만 대상.
// 'revised'·'기초자료'·'2차 최종본' 같이 규칙에서 벗어난 이름은 무관 탭으로 두고 건드리지 않는다.
export function parseStageTab(title) {
  var m = /^(\d+)차(\(최종\))?$/.exec(String(title == null ? '' : title));
  return m ? { n: parseInt(m[1], 10), final: !!m[2] } : null;
}

// 탭 복제 이름 계산(순수). 원본이 몇 차인지와 무관하게 항상 맨 끝 차수를 새로 만든다.
//  - 새 이름 = (기존 차수 탭의 최대 차수 + 1) + '차(최종)'. 차수 탭이 하나도 없으면 '1차(최종)'.
//  - 기존 '(최종)' 탭에서는 접미사를 뗀다. 단 뗀 이름이 이미 있으면 충돌이므로 그대로 둔다.
// 반환 { newName, renames: [{ from, to }] }
export function nextStageNames(existingTitles) {
  var titles = (existingTitles || []).map(function (t) { return String(t); });
  var set = {};
  titles.forEach(function (t) { set[t] = true; });
  var max = 0;
  titles.forEach(function (t) {
    var p = parseStageTab(t);
    if (p && p.n > max) max = p.n;
  });
  var n = max + 1;
  // 규칙상 max+1 차 탭은 존재할 수 없지만(존재하면 max 가 그 값이다), 방어적으로 빈 차수까지 올린다.
  while (set[n + '차(최종)']) n++;
  var newName = n + '차(최종)';
  var renames = [];
  titles.forEach(function (t) {
    var p = parseStageTab(t);
    if (!p || !p.final) return;
    var to = p.n + '차';
    if (set[to] || to === newName) return;
    renames.push({ from: t, to: to });
  });
  return { newName: newName, renames: renames };
}

// values(2D) 를 폭 colCount 로 정규화한다. 짧은 행은 ''로 패딩, 긴 행은 잘라낸다.
// 반환 배열의 모든 행은 정확히 colCount 개 셀 → batchUpdate 가 남은 셀을 확실히 덮어쓴다.
export function padRows(values, colCount) {
  return (values || []).map(function (row) {
    var out = new Array(colCount);
    for (var c = 0; c < colCount; c++) {
      var v = row && row[c];
      out[c] = v == null ? '' : v;
    }
    return out;
  });
}

// A..{colCount번째 열} 범위만 단일 batchUpdate 로 덮어쓴다.
// - clear 를 쓰지 않으므로 "지운 뒤 쓰기 전에 실패" 라는 비원자 구간이 없다.
// - prevRowCount(이전 내용의 행 수)가 더 크면 남는 행을 빈 값으로 채워 잔여 데이터를 제거한다.
// - 지정한 열 범위 밖(예: D열 이후)은 절대 건드리지 않는다.
export async function overwriteSheetRange(sheetsFetch, tab, values, colCount, prevRowCount) {
  var cols = colCount || 1;
  var rows = padRows(values, cols);
  var blank = new Array(cols).fill('');
  var target = Math.max(rows.length, prevRowCount || 0);
  if (target === 0) return null;
  while (rows.length < target) rows.push(blank.slice());
  var range = "'" + tab + "'!A1:" + colLetter(cols) + target;
  return batchUpdateValues(sheetsFetch, [{ range: range, values: rows }]);
}

var LG_DAYS = { '월': 0, '화': 1, '수': 2, '목': 3, '금': 4 };
var LG_SLOT_RE = /^(월|화|수|목|금)([1-8])$/;

// '연결그룹' 탭 파싱. 1행 헤더에서 열 위치를 탐지한다.
// 신schema: 학년|과목명|교사명|시간표 표기명|고정수업시간|그룹.
// 구schema(fallback): 과목명|교사명|시간표 표기명|그룹 (고정수업시간 없음).
// 반환: { groups:{그룹:[표기명...]}, pinned:{표기명:[slotIdx...]}, warnings:[인식불가 라벨...] }.
// 동일 표기명의 고정수업시간은 slotIdx UNION(중복제거+오름차순).
export function parseLinkedGroups(rows) {
  var hdr = (rows && rows[0]) || [];
  var dispCol = -1, groupCol = -1, fixedCol = -1, gradeCol = -1;
  for (var h = 0; h < hdr.length; h++) {
    var cell = String(hdr[h] != null ? hdr[h] : '').trim();
    if (cell === '시간표 표기명') dispCol = h;
    else if (cell === '그룹') groupCol = h;
    else if (cell === '고정수업시간') fixedCol = h;
    else if (cell === '학년') gradeCol = h;
  }
  if (dispCol < 0 || groupCol < 0) {
    // 구schema fallback
    dispCol = 2; groupCol = 3; fixedCol = -1; gradeCol = -1;
  }

  var groups = {};
  var pinned = {};
  var warnings = [];
  var grades = {};
  for (var i = 1; i < (rows ? rows.length : 0); i++) {
    var r = rows[i] || [];
    var group = String(r[groupCol] != null ? r[groupCol] : '').trim();
    var disp = String(r[dispCol] != null ? r[dispCol] : '').trim();
    if (!group || !disp) continue;
    var lst = groups[group] || (groups[group] = []);
    if (lst.indexOf(disp) === -1) lst.push(disp);

    if (gradeCol >= 0) {
      var gv = r[gradeCol];
      if (gv != null && String(gv).trim() !== '') {
        var gToks = String(gv).split(',');
        for (var gt = 0; gt < gToks.length; gt++) {
          var g = parseInt(String(gToks[gt]).trim(), 10);
          if (!isNaN(g)) {
            var garr = grades[disp] || (grades[disp] = []);
            if (garr.indexOf(g) === -1) garr.push(g);
          }
        }
      }
    }

    if (fixedCol >= 0) {
      var fx = r[fixedCol];
      if (fx != null && String(fx).trim() !== '') {
        var tokens = String(fx).split(',');
        for (var t = 0; t < tokens.length; t++) {
          var tok = tokens[t].trim();
          if (tok === '') continue;
          var m = LG_SLOT_RE.exec(tok);
          if (m) {
            var idx = LG_DAYS[m[1]] * 8 + (parseInt(m[2], 10) - 1);
            var arr = pinned[disp] || (pinned[disp] = []);
            if (arr.indexOf(idx) === -1) arr.push(idx);
          } else {
            if (warnings.indexOf(tok) === -1) warnings.push(tok);
          }
        }
      }
    }
  }
  Object.keys(pinned).forEach(function (k) {
    pinned[k].sort(function (a, b) { return a - b; });
  });
  Object.keys(grades).forEach(function (k) {
    grades[k].sort(function (a, b) { return a - b; });
  });
  return { groups: groups, pinned: pinned, warnings: warnings, grades: grades };
}

// grades: {표기명:[학년int...]}. 각 표기명이 config.classless 에 키로 없을 때만
// config.classless[표기명] = 학년.map(g=>g+'일부') 주입 + config.classlessDerived[표기명]=true.
// 이미 존재하는 키(수동)는 건드리지 않는다(수동 우선). config 를 변형 후 반환.
export function deriveClasslessFromGrades(config, grades) {
  if (!config || !grades) return config;
  var cl = config.classless || (config.classless = {});
  var derived = config.classlessDerived || {};
  Object.keys(grades).forEach(function (disp) {
    if (Object.prototype.hasOwnProperty.call(cl, disp)) return;
    var gs = grades[disp] || [];
    if (!gs.length) return;
    cl[disp] = gs.map(function (g) { return g + '일부'; });
    derived[disp] = true;
  });
  if (Object.keys(derived).length) config.classlessDerived = derived;
  return config;
}

/* =========================================================
   Sheets API 호출 바인딩 / 오류 분류
   ========================================================= */

// 요청이 지정한 sheetId(없으면 배포 기본값)를 정규화한다. 둘 다 비면 '' →
// 호출자는 Sheets API 를 부르지 말고 no_sheet_selected 로 응답해야 한다.
export function resolveSheetId(explicit, fallback) {
  var v = (explicit == null) ? '' : String(explicit).trim();
  if (v) return v;
  return (fallback == null) ? '' : String(fallback).trim();
}

// 로그인 사용자 본인의 OAuth access token 으로 Sheets API 를 호출하는 sf(path, init) 를 만든다.
// 응답은 res.json(). 비정상 응답은 'sheets_api_error <status> <body>' 로 throw.
// fetchImpl 은 테스트 주입용(기본 전역 fetch).
export function makeSheetsFetch(token, sheetId, fetchImpl) {
  var doFetch = fetchImpl || fetch;
  return async function (path, init) {
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      encodeURIComponent(sheetId) + path;
    var opts = Object.assign({}, init);
    opts.headers = Object.assign(
      { authorization: 'Bearer ' + token },
      (init && init.headers) || {}
    );
    var res = await doFetch(url, opts);
    if (!res.ok) {
      var body = await res.text().catch(function () { return ''; });
      // 본문은 mapSheetsError 가 스코프 부족(ACCESS_TOKEN_SCOPE_INSUFFICIENT 등)을 판별하는 데 쓴다.
      // 해당 표식은 error.details 안(본문 뒤쪽)에 오기도 해서 넉넉히 남긴다.
      throw new Error('sheets_api_error ' + res.status + ' ' + body.slice(0, 1200));
    }
    return res.json();
  };
}

// 'sheets_api_error <status> ...' 메시지에서 HTTP 상태코드 추출(없으면 null).
export function sheetsErrorStatus(e) {
  var m = /sheets_api_error\s+(\d+)/.exec(String((e && e.message) || e));
  return m ? parseInt(m[1], 10) : null;
}

// 'sheets_api_error <status> <body>' 메시지에서 body 부분만 추출(없으면 '').
export function sheetsErrorBody(e) {
  var s = String((e && e.message) || e || '');
  var m = /sheets_api_error\s+\d+\s?/.exec(s);
  return m ? s.slice(m.index + m[0].length) : '';
}

// 403 본문이 "토큰 스코프 부족"인지 판정. 본문이 없거나 형태가 달라도 절대 throw 하지 않는다.
// 구글은 스코프 부족 시 details[].reason=ACCESS_TOKEN_SCOPE_INSUFFICIENT 또는
// errors[].reason=insufficientPermissions("Insufficient Permission") 를 준다.
export function isInsufficientScope(body) {
  var raw = String(body == null ? '' : body);
  if (!raw) return false;
  try {
    var parsed = JSON.parse(raw);
    var err = (parsed && parsed.error) || {};
    var details = err.details || [];
    for (var i = 0; i < details.length; i++) {
      if (details[i] && details[i].reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return true;
    }
    var errors = err.errors || [];
    for (var j = 0; j < errors.length; j++) {
      if (errors[j] && errors[j].reason === 'insufficientPermissions') return true;
    }
    if (/insufficient authentication scopes/i.test(String(err.message || ''))) return true;
    return false;
  } catch (_) {
    // 잘림/비 JSON 본문 폴백 — 표식 문자열만 확인
    return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes/i.test(raw);
  }
}

// Sheets API 오류 → 클라이언트 응답 본문/상태.
//   401  → sheets_token_expired (클라이언트가 명시적 재허용 후 재시도)
//   403  → 본문이 스코프 부족이면 insufficient_scope(재동의 필요), 아니면 no_access(공유 필요)
//   404  → not_found (시트 주소 오타/삭제)
//   그 외 → sheets_error (원본 메시지 미노출)
export function mapSheetsError(e) {
  var st = sheetsErrorStatus(e);
  if (st === 401) {
    return {
      status: 401,
      body: { ok: false, error: 'sheets_token_expired', reasons: ['시트 접근 권한이 만료되었습니다. 다시 허용해 주세요.'] }
    };
  }
  if (st === 403) {
    var body = '';
    try { body = sheetsErrorBody(e); } catch (_) { body = ''; }
    if (isInsufficientScope(body)) {
      return {
        status: 403,
        body: {
          ok: false, error: 'insufficient_scope',
          reasons: ['시트 접근 권한(스코프)이 부족합니다. 권한을 다시 허용해 주세요.']
        }
      };
    }
    return {
      status: 403,
      body: {
        ok: false, error: 'no_access',
        reasons: ['이 스프레드시트에 접근할 권한이 없습니다. 시트 소유자에게 공유를 요청하세요.']
      }
    };
  }
  if (st === 404) {
    return {
      status: 404,
      body: {
        ok: false, error: 'not_found',
        reasons: ['시트를 찾을 수 없습니다. 주소(시트 ID)를 확인해 주세요. 삭제되었거나 오타일 수 있습니다.']
      }
    };
  }
  return {
    status: st || 500,
    body: { ok: false, error: 'sheets_error', reasons: ['시트 처리 중 오류가 발생했습니다.'] }
  };
}
