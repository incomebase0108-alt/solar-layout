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
  /** 配分の優先（既定: spread=影に強い分散） */
  strategy?: PackStrategy;
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

/** 配分の優先：spread=影に強い(MPPT分散)・dense=台数を詰める(分岐優先) */
export type PackStrategy = "spread" | "dense";

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
  maxCircuitsPerUnit: number,
  strategy: PackStrategy = "spread"
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
    // 台の選び方：spread=空いている台から(バランス)／dense=埋まっている台から(台数最小化)
    const order = units
      .map((u, i) => ({ u, i }))
      .sort((x, y) =>
        strategy === "dense"
          ? (y.u.total - x.u.total) || (x.i - y.i)
          : (x.u.total - y.u.total) || (x.i - y.i)
      );
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
      const canNewMppt = u.slots.length < pcs.mpptCount;
      if (strategy === "dense") {
        // 分岐(stringsPerMpptまで並列)で束ねる → 次に別MPPT
        if (match) {
          match.parallel += 1;
          u.total += 1;
          placed = true;
          break;
        }
        if (canNewMppt) {
          u.slots.push({ id: uid("str"), panelId: c.panelId, series: c.series, parallel: 1 });
          u.total += 1;
          placed = true;
          break;
        }
      } else {
        // spread：別MPPTに1並列ずつ散らす → 空きMPPTが無い時だけ分岐にフォールバック
        if (canNewMppt) {
          u.slots.push({ id: uid("str"), panelId: c.panelId, series: c.series, parallel: 1 });
          u.total += 1;
          placed = true;
          break;
        }
        if (match) {
          match.parallel += 1;
          u.total += 1;
          placed = true;
          break;
        }
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
  const strategy = input.strategy ?? "spread";
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

  const { units, leftoverCircuits } = distribute(allCircuits, pcs, unitCount, maxCircuitsPerUnit, strategy);

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
  const unitsNeededForAll = totalCircuits > 0 && perUnitCap > 0 ? Math.ceil(totalCircuits / perUnitCap) : 0;

  const leftoverTotal = leftover.reduce((a, l) => a + l.count, 0);
  return { units, leftover, leftoverTotal, unitsNeededForAll, ampWarnings, notes };
}

// ===== 既存ユニットへの割り当て（機種混在対応） =====

export interface OptimizeIntoUnitsInput {
  /** 一覧の現状ユニット（順序＝処理順）。各台の id/pcsId/kind/note は保持され strings のみ差し替える。 */
  units: PcsUnitLine[];
  /** 図面の型式別在庫（panelId 単位） */
  inventory: InventoryItem[];
  panels: PanelSpec[];
  /** pcsId 解決用のマスタ一覧（単一機種ではなくリスト） */
  pcsList: PcsSpec[];
  conditions: DesignConditions;
  /** 1台あたり最大回路数の上書き。未指定/0 のとき各機種の mpptCount を既定にする。 */
  maxCircuitsPerUnit?: number;
  strategy?: PackStrategy;
  /**
   * ストリングの組み方の好み（過積載率はどれも揃える・パネル使い切り志向）。
   * - "shade"：直列短め・本数多め（全MPPT使用）＝部分影/故障に強い
   * - "balanced"：中間（既定）
   * - "wiring"：直列長め・本数少なめ＝配線/接続箱/手間を削減
   */
  pref?: SeriesPref;
  /**
   * 残りを無理やり割り当てる（注意マーク付き）。電圧上限は厳守し、MPPT本数超過・直列下限未満を許容して残ゼロにする。
   */
  force?: boolean;
}

export type SeriesPref = "shade" | "balanced" | "wiring";

/** 1パターン分の最適化結果（おすすめ3案の各案） */
export interface OptimizePattern {
  key: SeriesPref;
  label: string;
  result: OptimizeIntoUnitsResult;
}

export interface OptimizeIntoUnitsResult {
  /** 元 units と同数・同順。id/pcsId/kind/note を保持し strings のみ差替（受領なしは []） */
  units: PcsUnitLine[];
  /** 配置できなかった残（型式別） */
  leftover: InventoryItem[];
  leftoverTotal: number;
  /** 残を使い切る目安（機種別の追加台数。あくまで概算） */
  extraUnitsNeeded: { pcsId: string; pcsLabel: string; count: number }[];
  /** 電流超過の警報（容認するが知らせる） */
  ampWarnings: string[];
  notes: string[];
  /** 一覧が空など対象なし */
  empty: boolean;
}

/**
 * 重み（型式ごとのDC量など）に比例して total 台を各型式へ配分する。
 * 各型式は可能な限り最低1台を確保し、合計はちょうど total になる。
 * total が型式数以下のときは、重みの大きい型式から1台ずつ割り当てる。
 */
function allocateUnits(weights: number[], total: number): number[] {
  const n = weights.length;
  const out = weights.map(() => 0);
  if (n === 0 || total <= 0) return out;
  if (total <= n) {
    const order = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
    for (let k = 0; k < total; k++) out[order[k].i] = 1;
    return out;
  }
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (total * w) / sumW);
  for (let i = 0; i < n; i++) out[i] = Math.max(1, Math.floor(raw[i]));
  let diff = total - out.reduce((a, b) => a + b, 0);
  if (diff > 0) {
    const byFrac = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f);
    for (let k = 0; k < diff; k++) out[byFrac[k % n].i]++;
  } else if (diff < 0) {
    const byVal = out.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
    let k = 0;
    let g = 0;
    while (diff < 0 && g < n * 1000) {
      const idx = byVal[k % n].i;
      if (out[idx] > 1) {
        out[idx]--;
        diff++;
      }
      k++;
      g++;
    }
  }
  return out;
}

/**
 * 「下の一覧」に並んだ現状ユニット（機種混在可）に対して、図面在庫を各台へ割り当てる。
 * 機種(pcsId)ごとにグループ化し、在庫を登場順（リスト順）で greedy に配分する。
 * 各機種の電圧範囲（calcStringSizing.seriesRange）で回路化し、入りきらない端数は
 * 枚数に戻して次の機種グループへ繰り越す（＝混在の利点：別機種の範囲で再評価される）。
 * 台数は自動で増やさない。余りは leftover として返す。
 */
export function optimizeIntoUnits(input: OptimizeIntoUnitsInput): OptimizeIntoUnitsResult {
  const { units, inventory, panels, pcsList, conditions } = input;
  const pref: SeriesPref = input.pref ?? "balanced";
  const notes: string[] = [];
  const ampWarnings: string[] = [];

  // 残在庫マップ（panelId → 枚数）
  const remaining = new Map<string, number>();
  for (const it of inventory) {
    if (it.count > 0) remaining.set(it.panelId, (remaining.get(it.panelId) ?? 0) + it.count);
  }

  if (units.length === 0) {
    const leftover = [...remaining.entries()].map(([panelId, count]) => ({ panelId, count }));
    return {
      units: [],
      leftover,
      leftoverTotal: leftover.reduce((a, l) => a + l.count, 0),
      extraUnitsNeeded: [],
      ampWarnings: [],
      notes: [],
      empty: true,
    };
  }

  // 電流制約から「1MPPTあたり電気的に有効な並列数」を求める。
  // 例: Huawei(MPPT最大16A) に Isc 9.7A のパネルを2並列＝19.4A は超過＝不可 → 有効並列1（分岐しない）。
  // これを無視して分岐すると各台が電流オーバーで赤エラーになるため、ここで上限を絞る。
  const effParallelFor = (pcs: PcsSpec, panelIds: Iterable<string>): number => {
    let eff = pcs.stringsPerMppt;
    for (const pid of panelIds) {
      const panel = panels.find((p) => p.id === pid);
      if (!panel || panel.iscA <= 0) continue;
      eff = Math.min(eff, Math.max(1, Math.floor(pcs.maxInputCurrentPerMpptA / panel.iscA)));
    }
    return Math.max(1, eff);
  };

  // 機種の登場順（extraUnitsNeeded の代表機種選定に使用）
  const groupOrder: string[] = [];
  for (const u of units) if (!groupOrder.includes(u.pcsId)) groupOrder.push(u.pcsId);

  // === 自動最適化：過積載率（DC/定格）を全台でそろえる ===
  // 「目標過積載率＝配置可能な全パネルW ÷ 全台定格」を求め、各台がこの値に近づくよう
  // 直列数を型式ごとに調整して配置する（W差を直列長で吸収＝過積載率が均一になる）。手計算より平準化が効く。
  // マルチ機はMPPTごとに型式混在可・1本ずつ。非マルチ機は1台＝同一型式・同一直列（並列）。
  interface UnitWork {
    lineId: string;
    pcs: PcsSpec;
    rated: number; // 定格 W
    multi: boolean;
    slots: PcsString[];
    dc: number; // 合計 DC W（過積載率の平準化に使用）
  }
  const work: UnitWork[] = [];
  for (const u of units) {
    const pcs = pcsList.find((p) => p.id === u.pcsId);
    if (!pcs) {
      notes.push(`機種が見つからないユニット(${u.pcsId})は割当対象外`);
      continue;
    }
    work.push({
      lineId: u.id,
      pcs,
      rated: Math.max(1, pcs.ratedPowerKw * 1000),
      multi: pcs.multiMppt !== false,
      slots: [],
      dc: 0,
    });
  }

  // pcs×panel の直列範囲・電流上の有効並列（キャッシュ）。電圧不成立は null。
  const sizeCache = new Map<string, { min: number; max: number; eff: number } | null>();
  const sizeFor = (pcs: PcsSpec, panelId: string) => {
    const key = pcs.id + "|" + panelId;
    const hit = sizeCache.get(key);
    if (hit !== undefined) return hit;
    const panel = panels.find((p) => p.id === panelId);
    if (!panel) {
      sizeCache.set(key, null);
      return null;
    }
    const sz = calcStringSizing(panel, pcs, conditions);
    const { min, max } = sz.seriesRange;
    const val = max < 1 || min > max ? null : { min, max, eff: effParallelFor(pcs, [panelId]) };
    sizeCache.set(key, val);
    return val;
  };

  // 1台あたりの公称ストリング本数（任意の最大回路数で制限可）
  const slotsOf = (w: UnitWork) => {
    const nominal = w.multi ? w.pcs.mpptCount : w.pcs.stringsPerMppt;
    return input.maxCircuitsPerUnit && input.maxCircuitsPerUnit > 0
      ? Math.min(input.maxCircuitsPerUnit, nominal)
      : nominal;
  };

  const panelW = (pid: string) => panels.find((p) => p.id === pid)?.pmaxW ?? 0;

  // 目標過積載率 = 配置可能な全パネルW ÷ 全台定格。各台をこの過積載率にそろえる。
  const totalRated = work.reduce((a, w) => a + w.rated, 0);
  const placeableW = [...remaining.entries()].reduce((sum, [pid, cnt]) => {
    if (cnt <= 0) return sum;
    const ok = work.some((w) => sizeFor(w.pcs, pid)); // どこかの台で電圧成立
    return ok ? sum + cnt * panelW(pid) : sum;
  }, 0);
  const targetOverload = totalRated > 0 ? placeableW / totalRated : 0;
  const targetDC = (w: UnitWork) => w.rated * targetOverload;

  // 台 w の空きストリング枠（マルチ=空きMPPT数／非マルチ=空き台なら1）
  const freeCapacity = (w: UnitWork) =>
    w.multi ? slotsOf(w) - w.slots.length : w.slots.length === 0 ? 1 : 0;

  // 台 w に置ける型式（残あり・電圧成立・最小直列を満たす）のうち、残の最も多いものを選ぶ。
  // 非マルチで既に型式が入っていればそれに固定（基本は空台でのみ呼ぶ）。
  const chooseType = (w: UnitWork): string | null => {
    const lockId = !w.multi && w.slots.length > 0 ? w.slots[0].panelId : null;
    let best: string | null = null;
    let bestRem = 0;
    for (const [pid, cnt] of remaining) {
      if (cnt <= 0) continue;
      if (lockId && pid !== lockId) continue;
      const s = sizeFor(w.pcs, pid);
      if (!s || cnt < s.min) continue;
      if (cnt > bestRem) {
        bestRem = cnt;
        best = pid;
      }
    }
    return best;
  };

  // 台 w に1本（マルチ）／1台ぶん（非マルチ）配置する。over=true は目標超過を許して最大直列で使い切る。
  const placeOne = (w: UnitWork, over: boolean): boolean => {
    const pid = chooseType(w);
    if (!pid) return false;
    const s = sizeFor(w.pcs, pid)!;
    const Wp = panelW(pid);
    const avail = remaining.get(pid) ?? 0;
    if (w.multi) {
      const deficitDC = Math.max(0, targetDC(w) - w.dc);
      let series = over || Wp <= 0 ? s.max : Math.round(deficitDC / Wp);
      series = Math.min(s.max, Math.max(s.min, series));
      if (series > avail) series = avail;
      if (series < s.min) return false;
      w.slots.push({ id: uid("str"), panelId: pid, series, parallel: 1 });
      w.dc += series * Wp;
      remaining.set(pid, avail - series);
      return true;
    }
    // 非マルチ空台：parallel 本を同一直列で（過積載率が目標に近づく直列を選ぶ）
    const par = Math.max(1, Math.min(slotsOf(w), s.eff));
    let series = over || Wp <= 0 ? s.max : Math.round(targetDC(w) / (par * Wp));
    series = Math.min(s.max, Math.max(s.min, series));
    let usePar = par;
    if (series * usePar > avail) {
      // 在庫に収まらない：まず直列を短くして並列(par)を維持（端数を使い切る）。
      const maxSeriesForPar = Math.floor(avail / par);
      if (maxSeriesForPar >= s.min) {
        series = maxSeriesForPar;
      } else {
        usePar = Math.floor(avail / series); // それでも無理なら並列を減らす
      }
    }
    if (usePar <= 0 || series < s.min) return false;
    w.slots.push({ id: uid("str"), panelId: pid, series, parallel: usePar });
    w.dc += series * usePar * Wp;
    remaining.set(pid, avail - series * usePar);
    return true;
  };

  const totalRemaining = () => [...remaining.values()].reduce((a, b) => a + b, 0);

  // フェーズ1：台数を型式のDC量へ比例配分し、型式内で直列を均等にして過積載率をそろえる。
  // 高W型式ほど台数を少なめに割り当て＝直列が短くなり、各台のDC（過積載率）がそろう。
  const types = [...remaining.entries()]
    .filter(([pid, c]) => c > 0 && work.some((w) => sizeFor(w.pcs, pid) !== null))
    .map(([pid, c]) => ({ pid, dc: c * panelW(pid) }))
    .sort((a, b) => b.dc - a.dc);
  const unitAlloc = allocateUnits(types.map((t) => t.dc), work.length);
  const pool = [...work];

  // 指定した台群へ、型式 pid のパネルを直列均等で配置する。
  // pref で「使うストリング本数」を変える：shade=本数多め(直列短)／wiring=本数少なめ(直列長)／balanced=中間。
  // 過積載率（各台のDC）は台数配分で既に揃っているので、ここは本数と直列長だけを調整する。
  const fillTypeEven = (chosen: UnitWork[], pid: string) => {
    if (chosen.length === 0) return;
    const Wp = panelW(pid);
    const strOf = (w: UnitWork) => {
      const s = sizeFor(w.pcs, pid)!;
      return w.multi ? slotsOf(w) : Math.max(1, Math.min(slotsOf(w), s.eff));
    };
    const allStr = chosen.reduce((a, w) => a + strOf(w), 0);
    if (allStr <= 0) return;
    const rng = sizeFor(chosen[0].pcs, pid)!;
    let avail = remaining.get(pid) ?? 0;
    if (avail < rng.min) return;

    // 好みに応じた目標直列 → 使うストリング本数を決める
    const prefSeries = pref === "wiring" ? rng.max : pref === "shade" ? rng.min : Math.round((rng.min + rng.max) / 2);
    let usedStr = Math.round(avail / Math.max(1, prefSeries));
    usedStr = Math.max(usedStr, Math.ceil(avail / rng.max)); // 最大直列でも要る本数は確保
    usedStr = Math.min(usedStr, allStr);
    usedStr = Math.max(1, usedStr);

    let base = Math.floor(avail / usedStr);
    if (base > rng.max) base = rng.max;
    if (base < rng.min) {
      usedStr = Math.max(1, Math.floor(avail / rng.min));
      base = Math.floor(avail / usedStr);
      if (base > rng.max) base = rng.max;
    }
    let rem = base >= rng.max ? 0 : avail - base * usedStr;

    // 使う本数 usedStr を全台へ均等配分（ラウンドロビン・各台の上限 strOf でクランプ）。
    // → 本数を絞っても特定の台に偏らず、過積載率が揃ったまま。
    const caps = chosen.map(strOf);
    const perUnitStr = caps.map(() => 0);
    {
      let left = usedStr;
      let r = 0;
      while (left > 0 && r < 10000) {
        let placed = false;
        for (let i = 0; i < chosen.length && left > 0; i++) {
          if (perUnitStr[i] < caps[i]) {
            perUnitStr[i]++;
            left--;
            placed = true;
          }
        }
        if (!placed) break;
        r++;
      }
    }

    // マルチ機を先に（端数+1を1本単位で配れる）、非マルチを後に
    const order = chosen.map((w, i) => ({ w, i })).sort((a, b) => (a.w.multi === b.w.multi ? 0 : a.w.multi ? -1 : 1));
    for (const { w, i } of order) {
      const s = sizeFor(w.pcs, pid)!;
      const cnt = perUnitStr[i];
      if (cnt <= 0) continue;
      if (w.multi) {
        for (let k = 0; k < cnt; k++) {
          avail = remaining.get(pid) ?? 0;
          if (avail < s.min) break;
          let series = base + (rem > 0 ? 1 : 0);
          series = Math.min(s.max, Math.max(s.min, series));
          if (series > avail) series = avail;
          if (series < s.min) break;
          if (rem > 0 && series === base + 1) rem--;
          w.slots.push({ id: uid("str"), panelId: pid, series, parallel: 1 });
          w.dc += series * Wp;
          remaining.set(pid, avail - series);
        }
      } else {
        // 非マルチ：1MPPTに cnt 本まで並列。直列は均等（base/base+1）で配り、端数を吸収する。
        // 例：26枚を4本へ → 7,7,6,6（＝7直×2並 ＋ 6直×2並）。同一直列をまとめて行(並列)にする。
        const seriesList: number[] = [];
        for (let k = 0; k < cnt; k++) {
          avail = remaining.get(pid) ?? 0;
          if (avail < s.min) break;
          let series = base + (rem > 0 ? 1 : 0);
          series = Math.min(s.max, Math.max(s.min, series));
          if (series > avail) series = avail;
          if (series < s.min) break;
          if (rem > 0 && series === base + 1) rem--;
          seriesList.push(series);
          w.dc += series * Wp;
          remaining.set(pid, avail - series);
        }
        // 同一直列を並列にまとめる（直列の大きい順に行を作る）
        const bySeries = new Map<number, number>();
        for (const sv of seriesList) bySeries.set(sv, (bySeries.get(sv) ?? 0) + 1);
        for (const [sv, par] of [...bySeries.entries()].sort((a, b) => b[0] - a[0])) {
          w.slots.push({ id: uid("str"), panelId: pid, series: sv, parallel: par });
        }
      }
    }
  };

  for (let ti = 0; ti < types.length; ti++) {
    const nUnits = unitAlloc[ti] ?? 0;
    if (nUnits <= 0) continue;
    const chosen: UnitWork[] = [];
    for (let i = 0; i < pool.length && chosen.length < nUnits; ) {
      if (sizeFor(pool[i].pcs, types[ti].pid)) {
        chosen.push(pool[i]);
        pool.splice(i, 1);
      } else i++;
    }
    fillTypeEven(chosen, types[ti].pid);
  }

  // フェーズ2（使い切り）：まだ残があれば、空き枠のある台へ過積載率の低い順に最大直列で詰める
  const blocked = new Set<UnitWork>();
  let guard = 0;
  while (totalRemaining() > 0 && guard++ < 100000) {
    let best: UnitWork | null = null;
    let bestRatio = Infinity;
    for (const w of work) {
      if (blocked.has(w) || freeCapacity(w) <= 0) continue;
      const ratio = targetDC(w) > 0 ? w.dc / targetDC(w) : 1;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = w;
      }
    }
    if (!best) break;
    if (!placeOne(best, true)) blocked.add(best);
  }

  // フェーズ3（端数の仕上げ）：全枠が埋まって新ストリングを足せない端数を、既存ストリングの
  // 直列数を+1して吸収する（電圧上限内のみ）。過積載率の低い台から延長して残ゼロに近づける。
  // 非マルチ台は並列ぶんの枚数が必要（同一直列を維持）、マルチ台は1枚で延長可。
  guard = 0;
  while (totalRemaining() > 0 && guard++ < 100000) {
    let target: { w: UnitWork; slot: PcsString; need: number } | null = null;
    let bestRatio = Infinity;
    for (const w of work) {
      for (const slot of w.slots) {
        const avail = remaining.get(slot.panelId) ?? 0;
        if (avail <= 0) continue;
        const s = sizeFor(w.pcs, slot.panelId);
        if (!s || slot.series >= s.max) continue; // これ以上直列を伸ばせない（電圧上限）
        const need = w.multi ? 1 : slot.parallel; // 非マルチは並列ぶん必要
        if (avail < need) continue;
        const ratio = w.dc / w.rated;
        if (ratio < bestRatio) {
          bestRatio = ratio;
          target = { w, slot, need };
        }
      }
    }
    if (!target) break;
    const Wp = panelW(target.slot.panelId);
    target.slot.series += 1;
    target.w.dc += target.need * Wp;
    remaining.set(target.slot.panelId, (remaining.get(target.slot.panelId) ?? 0) - target.need);
  }

  // フェーズ4（強制割当）：force のとき、まだ残るパネルを過積載率の低い台へ無理やり載せる。
  // 安全のため【電圧上限だけは絶対に超えない】。代わりにMPPT本数超過・直列下限未満を許容し、警告を出す。
  if (input.force) {
    guard = 0;
    while (totalRemaining() > 0 && guard++ < 100000) {
      const entry = [...remaining.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0];
      if (!entry) break;
      const pid = entry[0];
      const avail = entry[1];
      const panel = panels.find((p) => p.id === pid);
      // 電圧成立する機種（＝直列1本でも電圧範囲がある）だけが対象。電圧は破れない。
      // 強制でも違反は作らない：マルチ機の空きMPPTのみに追加（非マルチ機は並列上限があり2本目で違反になるため除外）。
      const cands = work
        .filter((w) => sizeFor(w.pcs, pid) && w.multi && w.slots.length < slotsOf(w))
        .sort((a, b) => a.dc / a.rated - b.dc / b.rated);
      if (cands.length === 0 || !panel) {
        notes.push(
          `⚠ ${panel ? `${panel.maker} ${panel.model}` : pid}：残${avail}枚は空きMPPTが無く強制割当できません（台を増やすか手動調整が必要）。`
        );
        break;
      }
      const w = cands[0];
      const s = sizeFor(w.pcs, pid)!;
      const series = Math.min(s.max, avail); // 電圧上限は厳守。下限未満は許容（警告）。
      if (series < 1) break;
      w.slots.push({ id: uid("str"), panelId: pid, series, parallel: 1 });
      w.dc += series * (panel.pmaxW ?? 0);
      remaining.set(pid, avail - series);
      const idx = work.indexOf(w) + 1;
      notes.push(
        `⚠ 強制割当：${panel.maker} ${panel.model} を ${idx}番目の台（空きMPPT）へ ${series}直×1 で追加（直列下限未満の可能性・要確認）`
      );
    }
  }

  // 結果を line へ
  const stringsByLine = new Map<string, PcsString[]>();
  for (const u of units) stringsByLine.set(u.id, []);
  for (const w of work) stringsByLine.set(w.lineId, w.slots);

  // 結果ユニット（同順・同一性を保ち strings のみ差替）
  const resultUnits: PcsUnitLine[] = units.map((u) => ({ ...u, strings: stringsByLine.get(u.id) ?? [] }));

  // 電流超過の警報
  for (const u of resultUnits) {
    const pcs = pcsList.find((p) => p.id === u.pcsId);
    if (!pcs) continue;
    for (const s of u.strings ?? []) {
      const panel = panels.find((p) => p.id === s.panelId);
      if (!panel) continue;
      const curA = s.parallel * panel.iscA;
      if (curA > pcs.maxInputCurrentPerMpptA) {
        ampWarnings.push(
          `${panel.maker} ${panel.model}：並列${s.parallel}本で入力電流 ${curA.toFixed(1)}A が上限 ${pcs.maxInputCurrentPerMpptA}A を超過（分岐のため・容認）`
        );
      }
    }
  }

  // 残在庫
  const leftover: InventoryItem[] = [];
  for (const [panelId, count] of remaining) {
    if (count > 0) leftover.push({ panelId, count });
  }
  const leftoverTotal = leftover.reduce((a, l) => a + l.count, 0);

  // 型式ごとの配分サマリ（透明性・診断用）。図面→割当→残 が一目で分かる。
  const figByPanel = new Map<string, number>();
  for (const it of inventory) if (it.count > 0) figByPanel.set(it.panelId, (figByPanel.get(it.panelId) ?? 0) + it.count);
  for (const [panelId, fig] of figByPanel) {
    const panel = panels.find((p) => p.id === panelId);
    const label = panel ? `${panel.maker} ${panel.model}` : panelId;
    const rem = Math.max(0, remaining.get(panelId) ?? 0);
    notes.push(`${label}：図面${fig}枚 → 割当${fig - rem}枚 / 残${rem}枚`);
  }

  // 残を使い切る目安（機種別の追加台数・概算）：
  // 1台あたりの収容枚数 ≈ ストリング本数 × 最大直列。残÷収容枚数で追加台数を概算する。
  const extraByPcs = new Map<string, number>();
  for (const l of leftover) {
    const panel = panels.find((p) => p.id === l.panelId);
    if (!panel) continue;
    let chosen: PcsSpec | undefined;
    let sMax = 0;
    for (const pcsId of groupOrder) {
      const pcs = pcsList.find((p) => p.id === pcsId);
      if (!pcs) continue;
      const sz = calcStringSizing(panel, pcs, conditions);
      if (sz.seriesRange.max >= 1 && sz.seriesRange.min <= sz.seriesRange.max && l.count >= sz.seriesRange.min) {
        chosen = pcs;
        sMax = sz.seriesRange.max;
        break;
      }
    }
    if (!chosen) continue; // 一覧のどの機種でも電圧範囲に合わない＝目安算出不可
    const nominalStrings = chosen.multiMppt !== false ? chosen.mpptCount : chosen.stringsPerMppt;
    const capPanels = Math.max(1, nominalStrings * Math.max(1, sMax));
    const add = Math.ceil(l.count / capPanels);
    extraByPcs.set(chosen.id, (extraByPcs.get(chosen.id) ?? 0) + add);
  }
  const extraUnitsNeeded = [...extraByPcs.entries()]
    .map(([pcsId, count]) => {
      const pcs = pcsList.find((p) => p.id === pcsId)!;
      return { pcsId, pcsLabel: `${pcs.maker} ${pcs.model}`, count };
    })
    .filter((e) => e.count > 0);

  return {
    units: resultUnits,
    leftover,
    leftoverTotal,
    extraUnitsNeeded,
    ampWarnings,
    notes,
    empty: false,
  };
}

/**
 * おすすめ3案（ストリングの組み方違い）を返す。過積載率はどれも揃え・パネル使い切り志向。
 * - 影に強い：直列短め・本数多め（全MPPT使用・部分影/故障に強い）
 * - 標準（おすすめ）：中間
 * - 配線シンプル：直列長め・本数少なめ（接続箱/配線/手間を削減）
 */
export function optimizeIntoUnitsPatterns(input: OptimizeIntoUnitsInput): OptimizePattern[] {
  const defs: { key: SeriesPref; label: string }[] = [
    { key: "shade", label: "影に強い（直列短め・本数多め）" },
    { key: "balanced", label: "標準（おすすめ）" },
    { key: "wiring", label: "配線シンプル（直列長め・本数少なめ）" },
  ];
  return defs.map((d) => ({ key: d.key, label: d.label, result: optimizeIntoUnits({ ...input, pref: d.key }) }));
}
