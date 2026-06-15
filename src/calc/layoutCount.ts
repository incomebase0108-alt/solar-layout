import type { LayoutProject, PanelArray, PanelSpec, LayoutSummary } from "../types";
import { cellKey } from "../types";

/**
 * 枚数の数え方。
 * - genkyo（現況・基準）：既設配列＝全数、新設配列＝0、単独パネル＝0
 * - kaishu（改修案）    ：既設配列＝流用数（全部入換なら入換後の全数）、新設配列＝全数、単独パネル＝全数
 *
 * 既設/新設の判定（keepCells の有無で区別する）：
 *   - keepCells が未定義 ＝「新設配列」（②変更の検討で追加。現況には無い）
 *   - keepCells が定義済み＝「既設配列」（①既設の設定で作成。作成時に全セル流用が付く）
 *     - 流用マーク1枚以上：流用分は残し、それ以外は入換＝撤去
 *     - 流用マーク0枚（全部入換）：既設は全数撤去し、同じグリッドに新パネルを載せる
 *   ※ 旧データ（keepCells 未定義の既設配列）は②「全部を流用」を一度押せば既設扱いになる。
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
  /** keepCells が定義済み＝既設配列（空＝全部入換）。未定義＝新設配列。 */
  marked: boolean;
} {
  const missingSet = new Set((a.missingCells ?? []).filter((k) => inGrid(k, a.rows, a.cols)));
  const removedSet = new Set(
    (a.removedCells ?? []).filter((k) => inGrid(k, a.rows, a.cols) && !missingSet.has(k))
  );
  const keepSet = new Set(
    (a.keepCells ?? []).filter((k) => inGrid(k, a.rows, a.cols) && !missingSet.has(k))
  );
  let keep = 0;
  for (const k of keepSet) if (!removedSet.has(k)) keep++;
  return {
    // 欠け（最初からパネルが無いセル）は母数から除外する
    grid: a.rows * a.cols - missingSet.size,
    removed: removedSet.size,
    keep,
    hasKeep: keepSet.size > 0,
    marked: a.keepCells !== undefined,
  };
}

/** 配列1つの、mode に応じた枚数。 */
export function arrayCountByMode(a: PanelArray, mode: CountMode): number {
  const s = arrayCellStats(a);
  // 現況（基準）：既設配列は「撤去前の満数」＝元々建っていた枚数（撤去は改修操作なので引かない）。
  if (mode === "genkyo") return s.marked ? s.grid : 0;
  // 改修案：既設は流用枚数（全部入換なら入換後の全数）、新設は撤去後の全数。
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
    // セルごとにパネル型式が混在する配列は1セルずつ数える（範囲外の死にキー・欠けセルは除外）
    const missing = new Set((a.missingCells ?? []).filter((k) => inGrid(k, a.rows, a.cols)));
    const keep = new Set((a.keepCells ?? []).filter((k) => inGrid(k, a.rows, a.cols) && !missing.has(k)));
    const removed = new Set((a.removedCells ?? []).filter((k) => inGrid(k, a.rows, a.cols) && !missing.has(k)));
    const hasKeep = keep.size > 0;
    const marked = a.keepCells !== undefined;
    for (let r = 0; r < a.rows; r++) {
      for (let c = 0; c < a.cols; c++) {
        const k = cellKey(r, c);
        if (missing.has(k)) continue; // 欠け＝パネルが存在しない
        let counted: boolean;
        if (mode === "genkyo") {
          counted = marked; // 現況＝既設配列の満数（撤去前）
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
