import { describe, it, expect } from "vitest";
import { optimizeReplacement, pickCandidates, currentSummary } from "./optimize";
import type { PanelSpec, PanelArray } from "../types";

const base: PanelSpec = {
  id: "base", maker: "x", model: "B-400",
  lengthMm: 1700, widthMm: 1000, pmaxW: 400,
  vmpV: 33, impA: 12, vocV: 40, iscA: 13, tempCoeffVocPctPerC: -0.3,
};
// 同寸法・高出力
const sameSizeHi: PanelSpec = { ...base, id: "hi", model: "H-450", pmaxW: 450 };
// 少し大きい（+4%）高出力
const slightlyBig: PanelSpec = { ...base, id: "big", model: "G-460", lengthMm: 1760, widthMm: 1030, pmaxW: 460 };
// 大きすぎ（+20%）
const tooBig: PanelSpec = { ...base, id: "xl", model: "XL-500", lengthMm: 2040, widthMm: 1200, pmaxW: 500 };

const arrays: PanelArray[] = [
  {
    id: "a1", panelId: "base", orientation: "portrait",
    rows: 10, cols: 10, gapM: 0.02, posXpx: 0, posYpx: 0, rotationDeg: 0,
    color: "#38bdf8", keepCells: [],
  },
];

describe("現状集計", () => {
  it("総枚数と出力", () => {
    const s = currentSummary(arrays, [base]);
    expect(s.totalCells).toBe(100);
    expect(s.currentKw).toBeCloseTo(40, 3); // 100*400/1000
  });
});

describe("入換最適化", () => {
  const panels = [base, sameSizeHi, slightlyBig, tooBig];

  it("同寸法の高出力パネルは全配列に収まり出力が上がる", () => {
    const { proposals } = optimizeReplacement(arrays, panels, panels, 5, 5);
    const hi = proposals.find((p) => p.panel.id === "hi");
    expect(hi).toBeTruthy();
    expect(hi!.feasible).toBe(true);
    expect(hi!.newPanels).toBe(100);
    expect(hi!.totalKw).toBeCloseTo(45, 1);
  });

  it("許容5%では大きすぎパネルは収まらない", () => {
    const { proposals } = optimizeReplacement(arrays, panels, panels, 5, 5);
    const xl = proposals.find((p) => p.panel.id === "xl");
    // 収まらない候補は除外 or infeasible
    if (xl) expect(xl.feasible).toBe(false);
  });

  it("流用指定分は据置で計上される", () => {
    const withKeep: PanelArray[] = [{ ...arrays[0], keepCells: ["0,0", "0,1"] }];
    const { proposals } = optimizeReplacement(withKeep, [base, sameSizeHi], [sameSizeHi], 5, 5);
    const hi = proposals[0];
    expect(hi.keptPanels).toBe(2);
    expect(hi.newPanels).toBe(98);
    // 流用2枚は既設400W、新98枚は450W
    expect(hi.totalKw).toBeCloseTo((2 * 400 + 98 * 450) / 1000, 1);
  });

  it("最大5案に制限", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...sameSizeHi, id: `p${i}`, model: `M${i}`, pmaxW: 400 + i }));
    const { proposals } = optimizeReplacement(arrays, many, many, 5, 5);
    expect(proposals.length).toBeLessThanOrEqual(5);
  });
});

describe("候補抽出", () => {
  it("同サイズ近傍のみ残す", () => {
    const c = pickCandidates(base, [base, sameSizeHi, slightlyBig, tooBig], 5);
    expect(c.map((p) => p.id)).toContain("hi");
    expect(c.map((p) => p.id)).not.toContain("xl");
  });
});
