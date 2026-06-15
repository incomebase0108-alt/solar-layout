import { describe, it, expect } from "vitest";
import { countShadedPanels, shadedCellKeys, panelPxDims, pixelsPerMeterOf } from "./shadow";
import type { PanelSpec, PanelArray, ShadowZone, Calibration } from "../types";

const panel: PanelSpec = {
  id: "p1", maker: "x", model: "M", lengthMm: 1000, widthMm: 1000, pmaxW: 400,
  vmpV: 33, impA: 12, vocV: 40, iscA: 13, tempCoeffVocPctPerC: -0.3,
};

// 1m角パネル、ppm=10 → 1セル=10px、隙間0。3x3配列を原点に配置
const arr: PanelArray = {
  id: "a1", panelId: "p1", orientation: "portrait",
  rows: 3, cols: 3, gapM: 0, posXpx: 0, posYpx: 0, rotationDeg: 0,
  color: "#fff",
};

describe("スケール", () => {
  it("校正2点と実長からpx/mを求める", () => {
    const cal: Calibration = { x1: 0, y1: 0, x2: 100, y2: 0, meters: 10 };
    expect(pixelsPerMeterOf(cal)).toBe(10);
  });
  it("未校正は暫定50", () => {
    expect(pixelsPerMeterOf(null)).toBe(50);
  });
});

describe("影判定", () => {
  const dims = panelPxDims(arr, panel, 10); // pw=ph=10, gap=0

  it("左上1セルだけを覆う影は1枚", () => {
    // セル(0,0)の中心は(5,5)。0..9を覆う矩形
    const zones: ShadowZone[] = [{ id: "z", x: 0, y: 0, w: 9, h: 9 }];
    const set = shadedCellKeys(arr, dims, zones);
    expect(set.size).toBe(1);
    expect(set.has("0,0")).toBe(true);
  });

  it("左列を覆う影は3枚（縦1列）", () => {
    // x:0..9 で全行(0..29)を覆う → col0の3セル
    const zones: ShadowZone[] = [{ id: "z", x: 0, y: 0, w: 9, h: 30 }];
    expect(shadedCellKeys(arr, dims, zones).size).toBe(3);
  });

  it("全体を覆う影は9枚", () => {
    const zones: ShadowZone[] = [{ id: "z", x: 0, y: 0, w: 30, h: 30 }];
    expect(countShadedPanels([arr], [panel], 10, zones)).toBe(9);
  });

  it("影ゾーンなしは0枚", () => {
    expect(countShadedPanels([arr], [panel], 10, [])).toBe(0);
  });
});
