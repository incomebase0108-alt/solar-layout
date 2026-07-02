// ============================================================
// 既設マスタ（existingArrays）と候補の分解・合成
//   既設の実体（位置・行列・型式）は発電所に1つだけ持ち（layout.existingArrays）、
//   候補には「既設へのマーク（流用/撤去/型式上書き）」と「新設配列」だけを保存する。
//   画面側は従来どおり layout.arrays（合成済みの作業コピー）を使う。
//   store.ts（候補切替）と candidateCost.ts（非アクティブ候補の試算）で共有する。
// ============================================================
import type { PanelArray, ExistingArrayMarks } from "../types";
import { cellKey } from "../types";

/** 配列の全セルキー（マークの無い既設＝全部流用のデフォルトに使う） */
export function allCellKeysOf(a: PanelArray): string[] {
  const keys: string[] = [];
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++) keys.push(cellKey(r, c));
  return keys;
}

/** 作業コピーの配列を「既設マスタ実体＋マーク」と「新設」に分解する。 */
export function splitWorkingArrays(arrays: PanelArray[]): {
  existing: PanelArray[];
  marks: Record<string, ExistingArrayMarks>;
  newArrays: PanelArray[];
} {
  const existing: PanelArray[] = [];
  const marks: Record<string, ExistingArrayMarks> = {};
  const newArrays: PanelArray[] = [];
  for (const a of arrays ?? []) {
    if (a.keepCells !== undefined) {
      // 既設：マーク（流用/撤去）を剥がした実体をマスタへ、マークは候補側へ。
      // セルごとの型式（cellPanels＝混在の塗り分け）は「何が載っているか」という実体なのでマスタに残す
      const body: PanelArray = { ...a };
      delete body.keepCells;
      delete body.removedCells;
      existing.push(body);
      marks[a.id] = { keepCells: a.keepCells, removedCells: a.removedCells };
    } else {
      newArrays.push(a);
    }
  }
  return { existing, marks, newArrays };
}

/** 既設マスタに候補のマークを適用し、新設を足して作業コピー用の配列へ合成する。
 *  マークの無い既設は「全部流用」スタート（候補2で既設が新設扱いになる事故の構造的防止）。 */
export function composeWorkingArrays(
  existing: PanelArray[],
  marks: Record<string, ExistingArrayMarks> | undefined,
  newArrays: PanelArray[]
): PanelArray[] {
  const ex = existing.map((a) => {
    const m = marks?.[a.id];
    return {
      ...a,
      keepCells: m ? m.keepCells ?? [] : allCellKeysOf(a),
      removedCells: m?.removedCells,
      // 型式の混在はマスタ実体が正。旧データ（候補マーク側に持っていた頃）の値はフォールバックで救う
      cellPanels: a.cellPanels ?? m?.cellPanels,
    };
  });
  return [...ex, ...newArrays];
}
