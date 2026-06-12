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
 * レイアウトのパネルを、パワコン構成のストリング（直列×並列）に順番に割り付ける。
 * 行優先（左→右・上→下、配列順）。影ゾーンのパネルは後回し＝末尾に固める。
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

  // --- 結線対象セルの収集（改修案フィルタ）---
  const cellInfo = new Map<string, { arrayId: string; r: number; c: number; shaded: boolean }>();
  const targetCells = new Set<string>();
  const sunny: string[] = [];
  const shaded: string[] = [];
  for (const a of layout.arrays) {
    const panel = panels.find((p) => p.id === a.panelId);
    const dims = panelPxDims(a, panel, ppm);
    const shadedSet = shadedCellKeys(a, dims, zones);
    const removed = new Set(a.removedCells ?? []);
    const keepSet = new Set(a.keepCells ?? []);
    const hasKeep = keepSet.size > 0;
    for (let r = 0; r < a.rows; r++) {
      for (let c = 0; c < a.cols; c++) {
        const k = cellKey(r, c);
        if (removed.has(k)) continue;
        if (hasKeep && !keepSet.has(k)) continue; // 入換セルは結線対象外
        const key = `${a.id}:${r},${c}`;
        const sh = shadedSet.has(k);
        targetCells.add(key);
        cellInfo.set(key, { arrayId: a.id, r, c, shaded: sh });
        (sh ? shaded : sunny).push(key);
      }
    }
  }
  const ordered = [...sunny, ...shaded];

  // --- 自動割付 ---
  const byCell = new Map<string, CellAssign>();
  let idx = 0;
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
        const par = Math.max(1, s.parallel);
        const ser = Math.max(0, s.series);
        for (let p = 1; p <= par; p++) {
          for (let n = 0; n < ser && idx < ordered.length; n++) {
            const key = ordered[idx++];
            const info = cellInfo.get(key)!;
            byCell.set(key, { arrayId: info.arrayId, r: info.r, c: info.c, pcsNo, stringNo, parallelNo: p, color, shaded: info.shaded });
          }
        }
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
