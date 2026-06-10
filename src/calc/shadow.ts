import type { PanelArray, PanelSpec, ShadowZone, Calibration } from "../types";

export interface PanelPxDims {
  pw: number;
  ph: number;
  gapPx: number;
}

/** スケール校正から px/m を求める（未校正は暫定 50）。 */
export function pixelsPerMeterOf(cal: Calibration | null | undefined): number {
  if (!cal) return 50;
  const len = Math.hypot(cal.x2 - cal.x1, cal.y2 - cal.y1);
  return cal.meters > 0 ? len / cal.meters : 50;
}

/** 配列のパネル 1 枚の表示寸法（px）。 */
export function panelPxDims(
  arr: PanelArray,
  panel: PanelSpec | undefined,
  ppm: number
): PanelPxDims {
  const lenM = (panel?.lengthMm ?? 1700) / 1000;
  const widM = (panel?.widthMm ?? 1000) / 1000;
  const pw = (arr.orientation === "portrait" ? widM : lenM) * ppm;
  const ph = (arr.orientation === "portrait" ? lenM : widM) * ppm;
  return { pw, ph, gapPx: arr.gapM * ppm };
}

/** セル (r,c) の中心の画像ピクセル座標。 */
export function cellCenterImage(
  arr: PanelArray,
  r: number,
  c: number,
  dims: PanelPxDims
): { x: number; y: number } {
  const lx = c * (dims.pw + dims.gapPx) + dims.pw / 2;
  const ly = r * (dims.ph + dims.gapPx) + dims.ph / 2;
  const a = (arr.rotationDeg * Math.PI) / 180;
  return {
    x: arr.posXpx + Math.cos(a) * lx - Math.sin(a) * ly,
    y: arr.posYpx + Math.sin(a) * lx + Math.cos(a) * ly,
  };
}

/** 点がいずれかの影ゾーンに入るか。 */
export function pointInZones(
  x: number,
  y: number,
  zones: ShadowZone[]
): boolean {
  return zones.some(
    (z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h
  );
}

/** 配列の中で影に入るセルのキー集合。 */
export function shadedCellKeys(
  arr: PanelArray,
  dims: PanelPxDims,
  zones: ShadowZone[]
): Set<string> {
  const set = new Set<string>();
  if (!zones.length) return set;
  const removed = new Set(arr.removedCells ?? []);
  for (let r = 0; r < arr.rows; r++) {
    for (let c = 0; c < arr.cols; c++) {
      if (removed.has(`${r},${c}`)) continue;
      const ctr = cellCenterImage(arr, r, c, dims);
      if (pointInZones(ctr.x, ctr.y, zones)) set.add(`${r},${c}`);
    }
  }
  return set;
}

/** 全配列で影に入るパネル枚数の合計。 */
export function countShadedPanels(
  arrays: PanelArray[],
  panels: PanelSpec[],
  ppm: number,
  zones: ShadowZone[]
): number {
  if (!zones.length) return 0;
  let n = 0;
  for (const arr of arrays) {
    const panel = panels.find((p) => p.id === arr.panelId);
    const dims = panelPxDims(arr, panel, ppm);
    n += shadedCellKeys(arr, dims, zones).size; // 撤去セルは除外済み
  }
  return n;
}
