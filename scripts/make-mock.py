#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate src/dev/mock_data.js from a real-data xlsx snapshot.
stdlib only (zipfile + xml.etree.ElementTree). NO openpyxl.

Reads the `revised` sheet, builds an 83x42 grid, and assembles a
설정-tab style configValues 2D array consumed by web_extra.parseConfig:
  [고정블록] (hardcoded), [팀티칭] (auto-detected), [무반과목] (auto-extracted).

교사 실명은 출력 직전에 가명(교사01/Teacher01…)으로 치환된다 — 저장소가 공개이므로
mock_data.js에 실명이 남지 않아야 한다. build_alias_map/anonymize 참조.

사용법:
  python3 scripts/make-mock.py <입력.xlsx> [출력.js]
출력 기본값: src/dev/mock_data.js (저장소 기준 상대 경로)
"""
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, "src", "dev", "mock_data.js")

ROWS = 83   # A1:AP83
COLS = 42   # A..AP


def local(tag):
    """strip XML namespace → local name"""
    return tag.rsplit("}", 1)[-1]


def find_child(el, name):
    for c in el:
        if local(c.tag) == name:
            return c
    return None


def col_to_index(col_letters):
    """A->0, B->1, ... AP->41"""
    n = 0
    for ch in col_letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


CELL_RE = re.compile(r"^([A-Z]+)(\d+)$")


def read_shared_strings(zf):
    try:
        data = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(data)
    out = []
    for si in root:
        if local(si.tag) != "si":
            continue
        # concatenate all <t> descendants (handles <r><t> runs)
        parts = []
        for t in si.iter():
            if local(t.tag) == "t":
                parts.append(t.text or "")
        out.append("".join(parts))
    return out


def resolve_sheet_path(zf, want_name):
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    sheets = find_child(wb, "sheets")
    rid = None
    for s in sheets:
        if local(s.tag) != "sheet":
            continue
        name = s.attrib.get("name")
        if name == want_name:
            for k, v in s.attrib.items():
                if local(k) == "id":  # r:id
                    rid = v
                    break
            break
    if rid is None:
        raise SystemExit("sheet %r not found in workbook.xml" % want_name)

    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    target = None
    for rel in rels:
        if rel.attrib.get("Id") == rid:
            target = rel.attrib.get("Target")
            break
    if target is None:
        raise SystemExit("relationship %s not found" % rid)
    # Target like 'worksheets/sheet1.xml' relative to xl/
    if target.startswith("/"):
        return target.lstrip("/")
    return "xl/" + target


def parse_sheet(zf, path, shared, rows=ROWS, cols=COLS):
    root = ET.fromstring(zf.read(path))
    sheet_data = find_child(root, "sheetData")
    ROWS, COLS = rows, cols
    grid = [["" for _ in range(COLS)] for _ in range(ROWS)]
    if sheet_data is None:
        return grid
    for row in sheet_data:
        if local(row.tag) != "row":
            continue
        for c in row:
            if local(c.tag) != "c":
                continue
            ref = c.attrib.get("r")
            m = CELL_RE.match(ref) if ref else None
            if not m:
                continue
            ci = col_to_index(m.group(1))
            ri = int(m.group(2)) - 1
            if ri < 0 or ri >= ROWS or ci < 0 or ci >= COLS:
                continue
            t = c.attrib.get("t")
            val = ""
            if t == "s":
                v = find_child(c, "v")
                if v is not None and v.text is not None:
                    val = shared[int(v.text)]
            elif t == "inlineStr":
                is_el = find_child(c, "is")
                if is_el is not None:
                    parts = []
                    for tt in is_el.iter():
                        if local(tt.tag) == "t":
                            parts.append(tt.text or "")
                    val = "".join(parts)
            elif t == "str":
                v = find_child(c, "v")
                val = v.text if (v is not None and v.text is not None) else ""
            else:
                v = find_child(c, "v")
                val = v.text if (v is not None and v.text is not None) else ""
            grid[ri][ci] = val if val is not None else ""
    return grid


# ---- row/subject classification (mirrors Core_Model) ----
RA_SLOT_RE = re.compile(r"^RA[1-9]$")
RA_COURSE_RE = re.compile(r"^RA\d{2}$")
SUBJECT_RE = re.compile(r"^(.+?)(7|8|9|10|11|12)([A-C])$")
GRADE_RE = re.compile(r"(1[012]|[789])")


def is_teacher(name):
    n = (name or "").strip()
    if not n:
        return False
    if RA_SLOT_RE.match(n):
        return False
    if RA_COURSE_RE.match(n):
        return False
    return True


# ---- 익명화 (공개 저장소용 모의 데이터) ----
# 교사명 열(col0)에 나타나지만 사람이 아닌 라벨 → 치환 제외
NON_PERSON_LABELS = {"교사", "English1", "BandClass", "진로진학"}
KOREAN_NAME_RE = re.compile(r"^[가-힣]{2,4}$")
LATIN_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z.'\- ]*$")


def is_person_name(v):
    n = (v or "").strip()
    if not n or n in NON_PERSON_LABELS:
        return False
    if RA_SLOT_RE.match(n) or RA_COURSE_RE.match(n):
        return False
    return bool(KOREAN_NAME_RE.match(n) or LATIN_NAME_RE.match(n))


def build_alias_map(grids, depts):
    """실명 → 가명. 등장 순서대로 번호 부여.
    동일 실명은 어느 위치에서든 같은 가명 → 동명이인(같은 이름 2행) 구조가 보존된다."""
    alias = {}

    def add(v):
        n = (v or "").strip()
        if not n or n in alias or not is_person_name(n):
            return
        i = len(alias) + 1
        alias[n] = ("교사%02d" % i) if KOREAN_NAME_RE.match(n) else ("Teacher%02d" % i)

    for g in grids:
        for row in g:
            if row:
                add(row[0])
    if depts:
        for n in depts["names"]:
            add(n)
        for n in depts["heads"]:
            add(n)
    return alias


def anonymize(grids, depts, alias):
    """grid col0(교사명)과 교과별교사 매핑의 실명을 가명으로 치환.
    configValues의 [팀티칭]은 치환된 grid에서 파생되므로 별도 처리 불필요."""
    for g in grids:
        for row in g:
            if row and row[0] in alias:
                row[0] = alias[row[0]]
    if depts:
        depts["names"] = {alias.get(k, k): v for k, v in depts["names"].items()}
        depts["heads"] = [alias.get(n, n) for n in depts["heads"]]


def build_config(grid, grades):
    # teacher rows = grid index 2..82; slot cols = grid col index 2..41
    teacher_rows = [r for r in range(2, ROWS) if is_teacher(grid[r][0])]

    # ---- [팀티칭] auto-detect ----
    team = {}  # subject -> ordered unique teacher names
    for slot in range(40):
        col = 2 + slot
        bysubj = {}  # subject -> list of teacher names (row order)
        for r in teacher_rows:
            subj = (grid[r][col] or "").strip()
            if not subj:
                continue
            bysubj.setdefault(subj, []).append((grid[r][0] or "").strip())
        for subj, names in bysubj.items():
            if len(names) >= 2:
                lst = team.setdefault(subj, [])
                for nm in names:
                    if nm and nm not in lst:
                        lst.append(nm)

    # ---- [무반과목] auto-extract ----
    classless = []  # ordered list of (subject, target)
    seen = set()
    for r in teacher_rows:
        for slot in range(40):
            subj = (grid[r][2 + slot] or "").strip()
            if not subj or subj in seen:
                continue
            if subj in grades:
                continue  # 연결그룹 학년에서 파생 → 수동 키로 pre-seed 안 함
            if SUBJECT_RE.match(subj):
                continue  # it's a class subject
            seen.add(subj)
            gm = GRADE_RE.search(subj)
            target = ("%s전체" % gm.group(1)) if gm else ""
            classless.append((subj, target))

    # ---- assemble configValues ----
    fixed_data = [
        ["월3", "Counseling", "전체"],
        ["화7", "S.A(중)", "7,8,9"],
        ["수3", "CHAPEL", "전체"],
        ["수5", "Band8", "8"],
        ["수6", "Band7", "7"],
        ["수7", "Band9", "9"],
        ["금6", "C.A.", "전체"],
        ["금7", "자치모임", "7,9,10,11,12"],
        ["금8", "교사회의", "전체"],
    ]

    cfg = []
    # [고정블록]
    cfg.append(["[고정블록]"])
    cfg.append(["슬롯", "라벨", "적용학년"])
    cfg.extend(fixed_data)
    cfg.append([""])
    # [팀티칭]
    cfg.append(["[팀티칭]"])
    cfg.append(["과목명", "교사들"])
    for subj, names in team.items():
        cfg.append([subj, ",".join(names)])
    cfg.append([""])
    # [무반과목]
    cfg.append(["[무반과목]"])
    cfg.append(["과목명", "대상학급", "비고"])
    for subj, target in classless:
        cfg.append([subj, target, ""])

    return cfg, team, classless


def read_electives(zf, shared):
    """'선택과목코드' 탭 → {code: [subjects]}. col B(idx1)=code, col C(idx2)=subject, 1행 헤더 스킵."""
    try:
        path = resolve_sheet_path(zf, "선택과목코드")
    except SystemExit:
        return {}
    g = parse_sheet(zf, path, shared, rows=1000, cols=3)
    groups = {}
    for r in range(1, len(g)):  # skip header row
        code = (g[r][1] or "").strip()
        subj = (g[r][2] or "").strip()
        if code and subj:
            groups.setdefault(code, []).append(subj)
    return groups


LG_DAYS = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4}
LG_SLOT_RE = re.compile(r"^(월|화|수|목|금)([1-8])$")


def read_linked(zf, shared):
    """'연결그룹' 탭 파싱 (JS parseLinkedGroups 미러) → (groups, pinned, warnings, grades).
    1행 헤더에서 열 위치 탐지. 신schema: 학년|과목명|교사명|시간표 표기명|고정수업시간|그룹.
    구schema fallback: 과목명|교사명|시간표 표기명|그룹 (고정수업시간 없음).
    동일 표기명 고정수업시간은 slotIdx UNION(중복제거+오름차순).
    학년: 콤마분리 int(소수형 '12.0' 포함) → {disp:[학년int...]}."""
    try:
        path = resolve_sheet_path(zf, "연결그룹")
    except SystemExit:
        return ({}, {}, [], {})
    g = parse_sheet(zf, path, shared, rows=1000, cols=6)
    hdr = g[0] if g else []
    disp_col = group_col = fixed_col = grade_col = -1
    for h, c in enumerate(hdr):
        cell = (c or "").strip()
        if cell == "시간표 표기명":
            disp_col = h
        elif cell == "그룹":
            group_col = h
        elif cell == "고정수업시간":
            fixed_col = h
        elif cell == "학년":
            grade_col = h
    if disp_col < 0 or group_col < 0:
        disp_col, group_col, fixed_col, grade_col = 2, 3, -1, -1

    groups = {}
    pinned = {}
    warnings = []
    grades = {}
    for r in range(1, len(g)):  # skip header row
        row = g[r]
        group = (row[group_col] or "").strip() if group_col < len(row) else ""
        disp = (row[disp_col] or "").strip() if disp_col < len(row) else ""
        if not group or not disp:
            continue
        lst = groups.setdefault(group, [])
        if disp not in lst:
            lst.append(disp)

        if grade_col >= 0 and grade_col < len(row):
            gv = row[grade_col]
            if gv is not None and str(gv).strip() != "":
                for tok in str(gv).split(","):
                    tok = tok.strip()
                    try:
                        gnum = int(float(tok))
                    except ValueError:
                        continue
                    garr = grades.setdefault(disp, [])
                    if gnum not in garr:
                        garr.append(gnum)

        if fixed_col >= 0 and fixed_col < len(row):
            fx = row[fixed_col]
            if fx is not None and str(fx).strip() != "":
                for tok in str(fx).split(","):
                    tok = tok.strip()
                    if tok == "":
                        continue
                    m = LG_SLOT_RE.match(tok)
                    if m:
                        idx = LG_DAYS[m.group(1)] * 8 + (int(m.group(2)) - 1)
                        arr = pinned.setdefault(disp, [])
                        if idx not in arr:
                            arr.append(idx)
                    else:
                        if tok not in warnings:
                            warnings.append(tok)
    for k in pinned:
        pinned[k].sort()
    for k in grades:
        grades[k].sort()
    return (groups, pinned, warnings, grades)


def read_depts(zf, shared):
    """'교과별교사' 탭 → {names:{교사명:교과}, order:[배치순서...]}. 헤더 1행 skip. A=교사명,B=교과,E(idx4)=배치순서."""
    try:
        path = resolve_sheet_path(zf, "교과별교사")
    except SystemExit:
        return None
    g = parse_sheet(zf, path, shared, rows=1000, cols=5)
    names = {}
    order = []
    heads = []
    for r in range(1, len(g)):
        nm = (g[r][0] or "").strip()
        dp = (g[r][1] or "").strip()
        if nm and dp:
            names[nm] = dp
        hd = (g[r][2] or "").strip()
        if nm and hd == "주임":
            heads.append(nm)
        od = (g[r][4] or "").strip()
        if od:
            order.append(od)
    if not names and not order:
        return None
    return {"names": names, "order": order, "heads": heads}


def normalize_grid(raw):
    """원시 그리드 → 표준 83x42 그리드 (worker의 normalizeGrid 미러).
    상위 ~10행 × ~12열에서 'Mon1' 탐지 → (header_row0, slot_start0) 0-based.
    out[r][0]=teacher(A열), out[r][1]=classroom(slot_start0>=2 일 때 B열, 아니면 ''),
    out[r][2+k]=슬롯(원시 열 slot_start0..slot_start0+39). 누락 셀 → ''."""
    slot_start0 = 2  # 폴백: C열 시작(기존 동작)
    rn = min(10, len(raw))
    found = False
    for r in range(rn):
        row = raw[r]
        cn = min(12, len(row))
        for c in range(cn):
            if row[c] == "Mon1":
                slot_start0 = c
                found = True
                break
        if found:
            break
    out = [["" for _ in range(COLS)] for _ in range(ROWS)]
    for r in range(ROWS):
        row = raw[r] if r < len(raw) else []
        out[r][0] = row[0] if len(row) > 0 and row[0] is not None else ""
        out[r][1] = (row[1] if len(row) > 1 and row[1] is not None else "") if slot_start0 >= 2 else ""
        for k in range(40):
            ci = slot_start0 + k
            out[r][2 + k] = row[ci] if ci < len(row) and row[ci] is not None else ""
    return out


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: make-mock.py <input.xlsx> [output.js]")
    xlsx = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT

    with zipfile.ZipFile(xlsx) as zf:
        shared = read_shared_strings(zf)
        grid = normalize_grid(parse_sheet(zf, resolve_sheet_path(zf, "revised"), shared, rows=ROWS, cols=50))
        grid1 = normalize_grid(parse_sheet(zf, resolve_sheet_path(zf, "1차"), shared, rows=ROWS, cols=50))
        grid2 = normalize_grid(parse_sheet(zf, resolve_sheet_path(zf, "2차"), shared, rows=ROWS, cols=50))
        groups, pinned, linked_warnings, grades = read_linked(zf, shared)
        if not groups:
            groups = read_electives(zf, shared)
            pinned = {}
            linked_warnings = []
            grades = {}
        electives = groups
        depts = read_depts(zf, shared)

    # 공개 저장소용: 실명 → 가명 (build_config 전에 수행해야 [팀티칭]도 가명으로 나옴)
    alias = build_alias_map([grid, grid1, grid2], depts)
    anonymize([grid, grid1, grid2], depts, alias)

    config, team, classless = build_config(grid, grades)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write("// AUTO-GENERATED by scripts/make-mock.py — do not edit by hand.\n")
        f.write("export const grid = %s;\n" % json.dumps(grid, ensure_ascii=False))
        f.write("export const grid1 = %s;\n" % json.dumps(grid1, ensure_ascii=False))
        f.write("export const grid2 = %s;\n" % json.dumps(grid2, ensure_ascii=False))
        f.write("export const configValues = %s;\n" % json.dumps(config, ensure_ascii=False))
        f.write("export const electives = %s;\n" % json.dumps(electives, ensure_ascii=False))
        f.write("export const pinned = %s;\n" % json.dumps(pinned, ensure_ascii=False))
        f.write("export const linkedWarnings = %s;\n" % json.dumps(linked_warnings, ensure_ascii=False))
        f.write("export const grades = %s;\n" % json.dumps(grades, ensure_ascii=False))
        f.write("export const depts = %s;\n" % json.dumps(depts, ensure_ascii=False))

    # ---- stats ----
    ncols = len(grid[0]) if grid else 0
    print("grid: %d rows x %d cols" % (len(grid), ncols))
    print("grid1: %d rows x %d cols" % (len(grid1), len(grid1[0]) if grid1 else 0))
    print("grid2: %d rows x %d cols" % (len(grid2), len(grid2[0]) if grid2 else 0))
    print("teamTeaching (%d):" % len(team))
    for subj, names in team.items():
        print("  %s -> %s" % (subj, ",".join(names)))
    print("classless subjects: %d" % len(classless))
    print("electives codes: %d" % len(electives))
    print("pinned 표기명: %d" % len(pinned))
    print("grades 표기명: %d" % len(grades))
    print("linkedWarnings (%d): %s" % (len(linked_warnings), ",".join(linked_warnings)))
    print("depts names: %d, order: %d" % (len(depts["names"]) if depts else 0, len(depts["order"]) if depts else 0))
    print("anonymized names: %d" % len(alias))


if __name__ == "__main__":
    main()
