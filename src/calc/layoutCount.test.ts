import { describe, it, expect } from "vitest";
import { arrayCellStats, arrayCountByMode } from "./layoutCount";
import type { PanelArray } from "../types";

function makeArray(partial: Partial<PanelArray>): PanelArray {
  return {
    id: "a1",
    panelId: "p1",
    orientation: "landscape",
    rows: 2,
    cols: 3,
    gapM: 0,
    posXpx: 0,
    posYpx: 0,
    rotationDeg: 0,
    color: "#fff",
    ...partial,
  };
}

describe("arrayCellStats", () => {
  it("流用と撤去が同じセルに付いたら撤去を優先して数える（二重カウント防止）", () => {
    // 全数流用(6) → うち2枚撤去、という操作順で keep∩removed が生じるケース
    const a = makeArray({
      keepCells: ["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"],
      removedCells: ["0,0", "0,1"],
    });
    const s = arrayCellStats(a);
    expect(s.grid).toBe(6);
    expect(s.removed).toBe(2);
    expect(s.keep).toBe(4); // 6流用のうち2撤去 → 流用4
    expect(s.hasKeep).toBe(true);
  });

  it("グリッド外の死にキー（行列縮小後の残骸）は数えない", () => {
    const a = makeArray({
      rows: 1,
      cols: 2,
      keepCells: ["0,0", "5,5"],
      removedCells: ["9,9", "0,1"],
    });
    const s = arrayCellStats(a);
    expect(s.grid).toBe(2);
    expect(s.removed).toBe(1); // "0,1" のみ有効
    expect(s.keep).toBe(1); // "0,0" のみ有効
  });

  it("重複キーは1枚として数える", () => {
    const a = makeArray({ removedCells: ["0,0", "0,0", "0,0"] });
    expect(arrayCellStats(a).removed).toBe(1);
  });
});

describe("arrayCountByMode", () => {
  it("現況＝既存配列の満数（撤去を引かない）、改修案＝有効な流用枚数", () => {
    const a = makeArray({
      keepCells: ["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"],
      removedCells: ["0,0", "0,1"],
    });
    expect(arrayCountByMode(a, "genkyo")).toBe(6);
    expect(arrayCountByMode(a, "kaishu")).toBe(4);
  });

  it("流用マーク無し＝新設：現況0、改修案は撤去後全数", () => {
    const a = makeArray({ removedCells: ["0,0"] });
    expect(arrayCountByMode(a, "genkyo")).toBe(0);
    expect(arrayCountByMode(a, "kaishu")).toBe(5);
  });

  it("撤去枚数がグリッドを超える死にキーでも負数にならない", () => {
    const a = makeArray({
      rows: 1,
      cols: 1,
      removedCells: ["0,0", "1,1", "2,2", "3,3"],
    });
    expect(arrayCountByMode(a, "kaishu")).toBe(0);
  });
});
