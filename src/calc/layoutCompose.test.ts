import { describe, it, expect } from "vitest";
import { allCellKeysOf, splitWorkingArrays, composeWorkingArrays } from "./layoutCompose";
import type { PanelArray } from "../types";

/** テスト用の最小配列（keepCells の有無で既設/新設を切り替える） */
function arr(id: string, over: Partial<PanelArray> = {}): PanelArray {
  return {
    id,
    panelId: "p1",
    orientation: "landscape",
    rows: 2,
    cols: 3,
    gapM: 0.02,
    posXpx: 0,
    posYpx: 0,
    rotationDeg: 0,
    color: "green",
    ...over,
  };
}

describe("layoutCompose（既設マスタと候補の分解・合成）", () => {
  it("allCellKeysOf は行×列の全セルキーを返す", () => {
    expect(allCellKeysOf(arr("a"))).toEqual(["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"]);
  });

  it("split: keepCells 定義あり＝既設（実体からマークを剥がす）、無し＝新設", () => {
    const existing = arr("ex", { keepCells: ["0,0"], removedCells: ["0,1"] });
    const fresh = arr("new");
    const { existing: ex, marks, newArrays } = splitWorkingArrays([existing, fresh]);
    expect(ex.map((a) => a.id)).toEqual(["ex"]);
    expect(ex[0].keepCells).toBeUndefined();
    expect(ex[0].removedCells).toBeUndefined();
    expect(marks["ex"]).toEqual({ keepCells: ["0,0"], removedCells: ["0,1"] });
    expect(newArrays.map((a) => a.id)).toEqual(["new"]);
  });

  it("split→compose の往復で作業コピーが同一内容に戻る", () => {
    const working = [arr("ex", { keepCells: ["0,0", "1,2"], removedCells: ["0,1"] }), arr("new")];
    const { existing, marks, newArrays } = splitWorkingArrays(working);
    const composed = composeWorkingArrays(existing, marks, newArrays);
    expect(composed).toEqual([
      { ...working[0], cellPanels: undefined },
      working[1],
    ]);
  });

  it("compose: マークの無い既設は全セル流用スタート（新設扱い事故の防止）", () => {
    const composed = composeWorkingArrays([arr("ex")], undefined, []);
    expect(composed[0].keepCells).toEqual(allCellKeysOf(arr("ex")));
    expect(composed[0].removedCells).toBeUndefined();
  });

  it("compose: cellPanels（型式混在）はマスタ実体が正、旧データはマーク側からフォールバック", () => {
    const master = arr("ex", { cellPanels: { "0,0": "pX" } });
    const withMaster = composeWorkingArrays([master], { ex: { keepCells: [], cellPanels: { "0,0": "pOld" } } }, []);
    expect(withMaster[0].cellPanels).toEqual({ "0,0": "pX" });
    const legacy = composeWorkingArrays([arr("ex")], { ex: { keepCells: [], cellPanels: { "0,0": "pOld" } } }, []);
    expect(legacy[0].cellPanels).toEqual({ "0,0": "pOld" });
  });
});
