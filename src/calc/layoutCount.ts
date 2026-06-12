import type { LayoutProject, PanelArray, PanelSpec, LayoutSummary } from "../types";
import { cellKey } from "../types";

/**
 * 枚数の数え方。
 * - genkyo（現況・基準）：流用マークのある配列＝全数、無い配列（新設）＝0、単独パネル＝0
 * - kaishu（改修案）    ：流用マークのある配列＝流用数、無い配列（新設）＝全数、単独パネル＝全数
 *
 * 考え方：流用マークがある配列＝「既存（一部を流用、残りは入換で撤去）」。
 *   現況ではその既存が丸ごと建っている（全数）。改修案では流用分だけ残る。
 *   流用マークが無い配列＝「新設（入換で新たに載せるパネル）」。現況には無い。
 */
export type CountMode = "genkyo" | "kaishu";

/** "r,c" キーが rows×cols の範囲内か。行列を縮小した後に残る死にキーを集計から除くため。 */
function inGrid(key: string, rows: number, cols: number): boolean {
  const i = key.indexOf(",");
  const r = Number(key.slice(0, i));
  const c = Number(key.slice(i + 1));
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < rows && c >= 0 && c < cols;
}

/**
 * 配列1つのセルマークの実数。
 * - 範囲外（行列縮小後の死にキー）・重複は数えない
 * - 流用と撤去が同じセルに付いている場合は撤去を優先（「全数流用→一部撤去」の操作順で重複が生じる）
 */
export function arrayCellStats(a: PanelArray): {
  grid: number;
  removed: number;
  keep: number;
  hasKeep: boolean;
} {
  const removedSet = new Set((a.removedCells ?? []).filter((k) => inGrid(k, a.rows, a.cols)));
  const keepSet = new Set((a.keepCells ?? []).filter((k) => inGrid(k, a.rows, a.cols)));
  let keep = 0;
  for (const k of keepSet) if (!removedSet.has(k)) keep++;
  return { grid: a.rows * a.cols, removed: removedSet.size, keep, hasKeep: keepSet.size > 0 };
}

/** 配列1つの、mode に応じた枚数。 */
export function arrayCountByMode(a: PanelArray, mode: CountMode): number {
  const s = arrayCellStats(a);
  // 現況（基準）：既存配列は「撤去前の満数」＝元々建っていた枚数（撤去は改修操作なので引かない）。
  if (mode === "genkyo") return s.hasKeep ? s.grid : 0;
  // 改修案：既存は流用枚数、新設は撤去後の全数。
  return s.hasKeep ? s.keep : s.grid - s.removed;
}

/** レイアウトを型式ごとに集計（枚数・kW）。 */
export function summarizeLayout(
  layout: LayoutProject,
  panels: PanelSpec[],
  mode: CountMode
): LayoutSummary {
  const byModel = new Map<string, { count: number; kw: number }>();
  const add = (panelId: string, count: number) => {
    if (count <= 0) return;
    const p = panels.find((x) => x.id === panelId);
    const model = p ? `${p.maker} ${p.model}` : "未登録パネル";
    const kw = (count * (p?.pmaxW ?? 0)) / 1000;
    const cur = byModel.get(model) ?? { count: 0, kw: 0 };
    byModel.set(model, { count: cur.count + count, kw: cur.kw + kw });
  };
  for (const a of layout.arrays) {
    const overrides = a.cellPanels;
    if (!overrides || Object.keys(overrides).length === 0) {
      add(a.panelId, arrayCountByMode(a, mode));
      continue;
    }
    // セルごとにパネル型式が混在する配列は1セルずつ数える（範囲外の死にキーは除外）
    const keep = new Set((a.keepCells ?? []).filter((k) => inGrid(k, a.rows, a.cols)));
    const removed = new Set((a.removedCells ?? []).filter((k) => inGrid(k, a.rows, a.cols)));
    const hasKeep = keep.size > 0;
    for (let r = 0; r < a.rows; r++) {
      for (let c = 0; c < a.cols; c++) {
        const k = cellKey(r, c);
        let counted: boolean;
        if (mode === "genkyo") {
          counted = hasKeep; // 現況＝既存配列の満数（撤去前）
        } else {
          counted = removed.has(k) ? false : hasKeep ? keep.has(k) : true;
        }
        if (counted) add(overrides[k] ?? a.panelId, 1);
      }
    }
  }
  // 単独パネルは「新設」扱い：改修案のみ加算。
  if (mode === "kaishu") for (const f of layout.freePanels ?? []) add(f.panelId, 1);

  const byPanel = [...byModel.entries()].map(([model, v]) => ({ model, count: v.count, kw: v.kw }));
  return {
    totalPanels: byPanel.reduce((s, b) => s + b.count, 0),
    totalKw: byPanel.reduce((s, b) => s + b.kw, 0),
    byPanel,
  };
}
