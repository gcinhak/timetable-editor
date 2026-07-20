import { grid as MOCK_GRID, grid1 as MOCK_GRID1, grid2 as MOCK_GRID2, configValues as MOCK_CONFIG, electives as MOCK_ELECTIVES, depts as MOCK_DEPTS, pinned as MOCK_PINNED, linkedWarnings as MOCK_LINKED_WARNINGS, grades as MOCK_GRADES } from './mock_data.js';
import { nextCopyName } from '../lib/sheets.js';
const clone2d = (a) => a.map((r) => r.slice());
export function getMockStore() {
  if (!globalThis.__TT_MOCK__) {
    globalThis.__TT_MOCK__ = {
      sheets: { revised: clone2d(MOCK_GRID), '1차': clone2d(MOCK_GRID1), '2차': clone2d(MOCK_GRID2) },
      config: withLinkedGroups(clone2d(MOCK_CONFIG), MOCK_ELECTIVES),
      history: [],
      electives: MOCK_ELECTIVES,
      depts: MOCK_DEPTS || null,
      pinned: MOCK_PINNED || {},
      warnings: MOCK_LINKED_WARNINGS || [],
      grades: MOCK_GRADES || {},
    };
  }
  return globalThis.__TT_MOCK__;
}
export function resetMockStore() { delete globalThis.__TT_MOCK__; }
// 초기 설정에 [연결그룹] 블록이 없으면 선택과목코드(electives) 기반 초안을 붙인다 (dev 전용)
function withLinkedGroups(values, electives) {
  var has = values.some(function (r) { return String(r[0] || '').trim() === '[연결그룹]'; });
  if (has || !electives) return values;
  values.push(['[연결그룹]', '', '']);
  values.push(['그룹명', '과목들', '']);
  Object.keys(electives).forEach(function (code) {
    var subs = electives[code] || [];
    if (subs.length >= 2) values.push([code, subs.join(', '), '']);
  });
  return values;
}
export function mockPickTab(store) { return store.sheets['revised'] ? 'revised' : Object.keys(store.sheets)[0]; }
export function applyCellsToGrid(grid, cells) { (cells||[]).forEach((c) => { grid[c.row - 1][2 + c.idx] = c.value; }); return grid; }
// 모든 시트 탭 → 형식 탭 메타(테스트/오프라인 UI용, 헤더행 고정 2/데이터 3).
export function mockListTabs(store) {
  return Object.keys(store.sheets).map((title) => ({ title, isTimetable: true, headerRow: 2, dataStart: 3 }));
}
// 탭 복제: nextCopyName 으로 사본명 결정 후 딥카피. 새 이름 반환.
export function mockDuplicateTab(store, tab) {
  const name = nextCopyName(Object.keys(store.sheets), tab);
  store.sheets[name] = clone2d(store.sheets[tab]);
  return name;
}
// 설정 저장: serializeConfig 결과 2D 를 그대로 보관.
export function mockSaveConfig(store, values2d) { store.config = values2d; return store.config; }
