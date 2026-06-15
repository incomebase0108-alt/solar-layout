import type { PanelSpec, PcsSpec, DesignConditions, PcsUnitLine, PcsString } from "../types";
import { uid } from "../store";
import { calcStringSizing } from "./stringSizing";

/** 図面の型式別在庫（panelId 単位） */
export interface InventoryItem {
  panelId: string;
  count: number;
}

export interface OptimizeInput {
  inventory: InventoryItem[];
  panels: PanelSpec[];
  pcs: PcsSpec;
  conditions: DesignConditions;
  /** 台数（固定） */
  unitCount: number;
  /** 1台あたり最大回路数（分岐含む・手入力） */
  maxCircuitsPerUnit: number;
}

export interface OptimizeResult {
  /** 生成された各台（count=1・strings入り）。plant.pcsUnits にそのまま入れられる */
  units: PcsUnitLine[];
  /** 配置できなかった残（型式別） */
  leftover: InventoryItem[];
  leftoverTotal: number;
  /** すべて使い切るのに必要な台数の目安 */
  unitsNeededForAll: number;
  /** 電流超過の警報（容認するが知らせる） */
  ampWarnings: string[];
  /** 短い回路・回路生成不可などの注記 */
  notes: string[];
}

/** 配分の途中表現：1ストリング（直列数 series のパネル panelId 1本） */
interface Circuit {
  panelId: string;
  series: number;
}

/**
 * 残（配置できない端数）が最小になる直列数を選ぶ。
 * 直列数はパネル枚数 total を超えられない（total本より長い直列は作れない）。
 * 端数 R は R>=min なら短い回路で吸収でき残0、R<min なら R 枚が残になる。
 * waste(s) を最小化し、同点は直列数の大きい方（回路数少）を選ぶ。
 */
export function pickSeries(total: number, min: number, max: number): number {
  let best = min;
  let bestWaste = Number.POSITIVE_INFINITY;
  const hi = Math.min(max, total); // 直列数は枚数を超えない
  for (let s = hi; s >= min; s--) {
    const r = total % s;
    const waste = r < min ? r : 0;
    if (waste < bestWaste) {
      bestWaste = waste;
      best = s;
    }
  }
  return best;
}

/**
 * 1型式の枚数を回路（直列数枚の束）に分割する。
 */
export function buildCircuits(
  panelId: string,
  total: number,
  range: { min: number; max: number }
): { circuits: Circuit[]; leftover: number } {
  if (range.max < 1 || range.min > range.max || total < range.min) {
    return { circuits: [], leftover: total };
  }
  const s = pickSeries(total, range.min, range.max);
  const full = Math.floor(total / s);
  const r = total - full * s;
  const circuits: Circuit[] = Array.from({ length: full }, () => ({ panelId, series: s }));
  let leftover = 0;
  if (r >= range.min) circuits.push({ panelId, series: r });
  else leftover = r;
  return { circuits, leftover };
}

interface UnitState {
  pcsId: string;
  slots: PcsString[];
  total: number;
}

/**
 * 回路群を N 台へ均等配分する。
 */
export function distribute(
  circuits: Circuit[],
  pcs: PcsSpec,
  unitCount: number,
  maxCircuitsPerUnit: number
): { units: PcsUnitLine[]; leftoverCircuits: Circuit[] } {
  const perUnitCap = Math.min(
    Math.max(1, maxCircuitsPerUnit),
    pcs.mpptCount * pcs.stringsPerMppt
  );
  const multi = pcs.multiMppt !== false;
  const units: UnitState[] = Array.from({ length: Math.max(0, unitCount) }, () => ({
    pcsId: pcs.id,
    slots: [],
    total: 0,
  }));

  const sorted = [...circuits].sort((a, b) =>
    a.panelId === b.panelId ? a.series - b.series : a.panelId < b.panelId ? -1 : 1
  );

  const leftoverCircuits: Circuit[] = [];

  for (const c of sorted) {
    const order = units
      .map((u, i) => ({ u, i }))
      .sort((x, y) => (x.u.total - y.u.total) || (x.i - y.i));
    let placed = false;
    for (const { u } of order) {
      if (u.total >= perUnitCap) continue;
      if (!multi && u.slots.length > 0) {
        const s0 = u.slots[0];
        if (s0.panelId !== c.panelId || s0.series !== c.series) continue;
      }
      const match = u.slots.find(
        (s) => s.panelId === c.panelId && s.series === c.series && s.parallel < pcs.stringsPerMppt
      );
      if (match) {
        match.parallel += 1;
        u.total += 1;
        placed = true;
        break;
      }
      if (u.slots.length < pcs.mpptCount) {
        u.slots.push({ id: uid("str"), panelId: c.panelId, series: c.series, parallel: 1 });
        u.total += 1;
        placed = true;
        break;
      }
    }
    if (!placed) leftoverCircuits.push(c);
  }

  const result: PcsUnitLine[] = units
    .filter((u) => u.slots.length > 0)
    .map((u) => ({ id: uid("pcsline"), pcsId: u.pcsId, count: 1, strings: u.slots }));

  return { units: result, leftoverCircuits };
}

/** 在庫・機種・条件から下書き構成を生成する。 */
export function optimizePcs(input: OptimizeInput): OptimizeResult {
  const { inventory, panels, pcs, conditions, unitCount, maxCircuitsPerUnit } = input;
  const notes: string[] = [];

  const allCircuits: Circuit[] = [];
  const leftover: InventoryItem[] = [];
  for (const item of inventory) {
    if (item.count <= 0) continue;
    const panel = panels.find((p) => p.id === item.panelId);
    if (!panel) {
      leftover.push({ ...item });
      notes.push(`型式が見つからないパネル(${item.panelId})は対象外（残）`);
      continue;
    }
    const sz = calcStringSizing(panel, pcs, conditions);
    const { circuits, leftover: lo } = buildCircuits(item.panelId, item.count, sz.seriesRange);
    allCircuits.push(...circuits);
    if (lo > 0) {
      leftover.push({ panelId: item.panelId, count: lo });
      notes.push(`${panel.maker} ${panel.model}：${lo}枚は直列下限(${sz.seriesRange.min})未満で残`);
    }
    if (circuits.some((c) => c.series < sz.seriesRange.max && c.series >= sz.seriesRange.min)) {
      const shorts = circuits.filter((c) => c.series < sz.seriesRange.max);
      if (shorts.length) notes.push(`${panel.maker} ${panel.model}：短い回路あり（直列 ${shorts.map((s) => s.series).join(",")}）`);
    }
  }

  const { units, leftoverCircuits } = distribute(allCircuits, pcs, unitCount, maxCircuitsPerUnit);

  for (const c of leftoverCircuits) {
    const ex = leftover.find((l) => l.panelId === c.panelId);
    if (ex) ex.count += c.series;
    else leftover.push({ panelId: c.panelId, count: c.series });
  }

  const ampWarnings: string[] = [];
  for (const u of units) {
    for (const s of u.strings ?? []) {
      const panel = panels.find((p) => p.id === s.panelId);
      if (!panel) continue;
      const cur = s.parallel * panel.iscA;
      if (cur > pcs.maxInputCurrentPerMpptA) {
        ampWarnings.push(
          `${panel.maker} ${panel.model}：並列${s.parallel}本で入力電流 ${cur.toFixed(1)}A が上限 ${pcs.maxInputCurrentPerMpptA}A を超過（分岐のため・容認）`
        );
      }
    }
  }

  const perUnitCap = Math.min(Math.max(1, maxCircuitsPerUnit), pcs.mpptCount * pcs.stringsPerMppt);
  const totalCircuits = allCircuits.length;
  const unitsNeededForAll = totalCircuits > 0 ? Math.ceil(totalCircuits / perUnitCap) : 0;

  const leftoverTotal = leftover.reduce((a, l) => a + l.count, 0);
  return { units, leftover, leftoverTotal, unitsNeededForAll, ampWarnings, notes };
}
