import type { LayoutProject, PanelSpec, PcsUnitLine, WiringOverride } from "../types";
import { cellKey } from "../types";
import { panelPxDims, shadedCellKeys, pixelsPerMeterOf } from "./shadow";

/** パワコン色（PC1, PC2, … の順）。PDFの凡例に倣った配色。 */
export const PCS_COLORS = [
  "#ef4444", // 赤
  "#06b6d4", // 水色
  "#22c55e", // 緑
  "#eab308", // 黄
  "#94a3b8", // 灰
  "#a855f7", // 紫
  "#f97316", // 橙
  "#3b82f6", // 青
  "#ec4899", // ピンク
  "#14b8a6", // 青緑
];

export function pcsColor(pcsNo: number): string {
  return PCS_COLORS[(pcsNo - 1 + PCS_COLORS.length * 10) % PCS_COLORS.length];
}

export interface CellAssign {
  arrayId: string;
  r: number;
  c: number;
  /** パワコン番号（1始まり） */
  pcsNo: number;
  /** そのパワコン内のストリング番号（MPPT入力, 1始まり） */
  stringNo: number;
  /** ストリング内の並列枝番号（1始まり） */
  parallelNo: number;
  color: string;
  shaded: boolean;
}

export interface WiringAssignResult {
  /** key: `${arrayId}:${r},${c}` → 割付 */
  byCell: Map<string, CellAssign>;
  /** 結線対象（改修案＝流用＋新設）のセルキー集合。入換セルは含まない。 */
  targetCells: Set<string>;
  assignedCount: number;
  unassignedCount: number;
  perPcs: { pcsNo: number; color: string; panels: number; strings: number }[];
}

/**
 * レイアウトのパネルを、パワコン構成のストリング（型式・直列×並列）の「通り」に割り付ける。
 *
 * 割付の3原則（パワコン構成の通り＝最善）:
 *  1. 型式一致：各ストリングは、その string の panelId と同じ型式の実セルだけを取る。
 *     （例 CS6P-255P のストリングには 255P のパネルしか割り当てない）
 *  2. 枚数きっちり：直列×並列の枚数だけ、型式別プールから順に消費する。
 *  3. 物理的まとまり：型式別プールは「配列順→行優先（左→右・上→下）」で並べるため、
 *     連続消費すると同じ配列の隣接セルがそのままストリングになる。影セルは型式内で末尾へ。
 *
 * 型式が合うセルが足りなければ割り当て不足（unassigned）として残し、余れば未割付のまま残す
 * ＝構成表とレイアウトの食い違いがそのまま図面に出る（隠さない）。
 * overrides があるセルは手編集で上書き（自動割付より優先）。
 * 既存配列は流用セルのみ対象（入換セルは撤去・置換で対象外）。
 */
export function assignWiring(
  layout: LayoutProject,
  panels: PanelSpec[],
  pcsUnits: PcsUnitLine[],
  overrides?: Record<string, WiringOverride>
): WiringAssignResult {
  const ppm = pixelsPerMeterOf(layout.calibration);
  const zones = layout.shadowZones ?? [];

  // --- 結線対象セルの収集（改修案フィルタ）＋ 型式別プール ---
  // 各セルの実型式（cellPanels の上書き ＞ 配列の panelId）を記録し、型式ごとに
  // 「配列順→行優先」で並べたプールを作る。連続消費＝物理的に隣接したストリングになる。
  const cellInfo = new Map<string, { arrayId: string; r: number; c: number; shaded: boolean; panelId: string }>();
  const targetCells = new Set<string>();
  const poolSunny = new Map<string, string[]>(); // panelId → セルキー（日向）
  const poolShaded = new Map<string, string[]>(); // panelId → セルキー（影）
  const pushPool = (map: Map<string, string[]>, pid: string, key: string) => {
    const arr = map.get(pid);
    if (arr) arr.push(key);
    else map.set(pid, [key]);
  };
  for (const a of layout.arrays) {
    const panel = panels.find((p) => p.id === a.panelId);
    const dims = panelPxDims(a, panel, ppm);
    const shadedSet = shadedCellKeys(a, dims, zones);
    const missing = new Set(a.missingCells ?? []);
    const removed = new Set(a.removedCells ?? []);
    const keepSet = new Set(a.keepCells ?? []);
    const hasKeep = keepSet.size > 0;
    const cellPanels = a.cellPanels ?? {};
    for (let r = 0; r < a.rows; r++) {
      for (let c = 0; c < a.cols; c++) {
        const k = cellKey(r, c);
        if (missing.has(k)) continue; // 欠け（パネル無し）は結線対象外
        if (removed.has(k)) continue;
        if (hasKeep && !keepSet.has(k)) continue; // 入換セルは結線対象外
        const key = `${a.id}:${r},${c}`;
        const sh = shadedSet.has(k);
        const pid = cellPanels[k] ?? a.panelId; // セルの実型式
        targetCells.add(key);
        cellInfo.set(key, { arrayId: a.id, r, c, shaded: sh, panelId: pid });
        pushPool(sh ? poolShaded : poolSunny, pid, key);
      }
    }
  }
  // 型式ごとの消費列（日向→影の順）とカーソル。
  const pool = new Map<string, string[]>();
  for (const pid of new Set([...poolSunny.keys(), ...poolShaded.keys()])) {
    pool.set(pid, [...(poolSunny.get(pid) ?? []), ...(poolShaded.get(pid) ?? [])]);
  }
  const cursor = new Map<string, number>(); // panelId → 次に取るインデックス

  // --- 自動割付（型式一致・枚数きっちり・型式別プールから連続消費）---
  const byCell = new Map<string, CellAssign>();
  let pcsNo = 0;
  for (const u of pcsUnits) {
    // 1行に複数台（count>1）の旧形式データも、台数分を展開して割り付ける
    const units = Math.max(1, u.count ?? 1);
    for (let t = 0; t < units; t++) {
      pcsNo++;
      const color = pcsColor(pcsNo);
      let stringNo = 0;
      for (const s of u.strings ?? []) {
        stringNo++;
        const list = pool.get(s.panelId) ?? []; // この型式のプール
        let cur = cursor.get(s.panelId) ?? 0;
        const par = Math.max(1, s.parallel);
        const ser = Math.max(0, s.series);
        for (let p = 1; p <= par; p++) {
          for (let n = 0; n < ser && cur < list.length; n++) {
            const key = list[cur++];
            const info = cellInfo.get(key)!;
            byCell.set(key, { arrayId: info.arrayId, r: info.r, c: info.c, pcsNo, stringNo, parallelNo: p, color, shaded: info.shaded });
          }
        }
        cursor.set(s.panelId, cur);
      }
    }
  }

  // --- 手編集の上書き ---
  if (overrides) {
    for (const [key, ov] of Object.entries(overrides)) {
      const info = cellInfo.get(key);
      if (!info) continue; // 対象外セルの上書きは無視
      byCell.set(key, {
        arrayId: info.arrayId,
        r: info.r,
        c: info.c,
        pcsNo: ov.pcsNo,
        stringNo: ov.stringNo,
        parallelNo: ov.parallelNo,
        color: pcsColor(ov.pcsNo),
        shaded: info.shaded,
      });
    }
  }

  // --- パワコン別集計（最終状態から）---
  const m = new Map<number, { color: string; panels: number; strings: Set<string> }>();
  for (const as of byCell.values()) {
    const e = m.get(as.pcsNo) ?? { color: as.color, panels: 0, strings: new Set<string>() };
    e.panels++;
    e.strings.add(`${as.stringNo}-${as.parallelNo}`);
    m.set(as.pcsNo, e);
  }
  const perPcs = [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, e]) => ({ pcsNo: no, color: e.color, panels: e.panels, strings: e.strings.size }));

  return {
    byCell,
    targetCells,
    assignedCount: byCell.size,
    unassignedCount: targetCells.size - byCell.size,
    perPcs,
  };
}
