# パワコン自動構成（下書き補助）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 機種・台数・1台あたり最大回路数を指定すると、図面の実パネル在庫に合わせたパワコン構成の「下書き」を自動生成し、プレビュー確認後に `plant.pcsUnits` へ流し込む補助機能を作る。

**Architecture:** 最適化ロジックは副作用のない純関数群（`pickSeries` / `buildCircuits` / `distribute` / `optimizePcs`）として `src/calc/pcsOptimize.ts` に分離し、Vitest で単体テストする。UI（`PcsComposer.tsx`）は入力欄とプレビュー／適用ボタンを足して純関数を呼ぶだけの薄い層にする。電圧上限は絶対条件、電流超過は容認して警報、分岐は `PcsString.parallel≥2` で表現する。

**Tech Stack:** React + Vite + TypeScript、Vitest、既存の `calcStringSizing`（`src/calc/stringSizing.ts`）・`summarizeLayout`（`src/calc/layoutCount.ts`）・型（`src/types.ts`）。

仕様書: `docs/superpowers/specs/2026-06-16-pcs-optimizer-design.md`

---

## ファイル構成

- 新規 `src/calc/pcsOptimize.ts` — 最適化の純関数とその型。
- 新規 `src/calc/pcsOptimize.test.ts` — 単体テスト。
- 変更 `src/components/PcsComposer.tsx` — 入力UI・プレビュー・適用の追加（既存ロジックは温存）。

### 型の取り決め（Task1〜4で使う共通定義）

`src/calc/pcsOptimize.ts` の先頭に定義する。

```ts
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
```

---

## Task 1: 直列数の選定 `pickSeries`

型式の枚数 T と有効直列範囲 [min,max] から、**配置できない端数（残）が最小**になる直列数を選ぶ。同点なら直列数が大きい方（回路数が少ない方）。これが「使い切り最優先」の実体。

**Files:**
- Create: `src/calc/pcsOptimize.ts`
- Test: `src/calc/pcsOptimize.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/calc/pcsOptimize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickSeries } from "./pcsOptimize";

describe("pickSeries", () => {
  it("割り切れる直列数を選ぶ（24枚は直列12でちょうど2回路）", () => {
    expect(pickSeries(24, 3, 12)).toBe(12);
  });
  it("割り切れないが端数を回路にできる直列数を選ぶ（26枚→直列11で残0）", () => {
    // 26%12=2(<min=3で残2) より 26%11=4(>=3で短い回路に吸収=残0) が良い
    expect(pickSeries(26, 3, 12)).toBe(11);
  });
  it("T が範囲内ならその枚数で1回路（7枚→直列7）", () => {
    expect(pickSeries(7, 3, 12)).toBe(7);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: FAIL（`pickSeries` is not defined / モジュールなし）

- [ ] **Step 3: 最小実装**

`src/calc/pcsOptimize.ts`（先頭に「型の取り決め」のimport/interface群を置いた上で）に追加:

```ts
/**
 * 残（配置できない端数）が最小になる直列数を選ぶ。
 * 端数 R は R>=min なら短い回路で吸収でき残0、R<min なら R 枚が残になる。
 * waste(s) を最小化し、同点は直列数の大きい方（回路数少）。
 */
export function pickSeries(total: number, min: number, max: number): number {
  let best = min;
  let bestWaste = Number.POSITIVE_INFINITY;
  for (let s = max; s >= min; s--) {
    const r = total % s;
    const waste = r < min ? r : 0;
    if (waste < bestWaste) {
      bestWaste = waste;
      best = s; // s 降順なので、同waste内では最初に出た最大の s が残る
    }
  }
  return best;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: PASS（3件）

- [ ] **Step 5: コミット**

```bash
git add src/calc/pcsOptimize.ts src/calc/pcsOptimize.test.ts
git commit -m "feat(optimize): 残最小で直列数を選ぶ pickSeries"
```

---

## Task 2: 在庫を回路に分割 `buildCircuits`

1型式の枚数を「直列数枚の束（回路＝ストリング）」に切り分ける。端数は直列下限を満たせば短い回路で吸収、満たさなければ残。電圧不成立（範囲なし）も残。

**Files:**
- Modify: `src/calc/pcsOptimize.ts`
- Test: `src/calc/pcsOptimize.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/calc/pcsOptimize.test.ts` に追記:

```ts
import { buildCircuits } from "./pcsOptimize";

describe("buildCircuits", () => {
  it("割り切れる：24枚・範囲[3,12] → 直列12×2回路・残0", () => {
    const r = buildCircuits("pa", 24, { min: 3, max: 12 });
    expect(r.circuits).toEqual([
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
    ]);
    expect(r.leftover).toBe(0);
  });
  it("端数を短い回路で吸収：26枚・範囲[3,12] → 直列11×2＋直列4×1・残0", () => {
    const r = buildCircuits("pa", 26, { min: 3, max: 12 });
    expect(r.circuits).toEqual([
      { panelId: "pa", series: 11 },
      { panelId: "pa", series: 11 },
      { panelId: "pa", series: 4 },
    ]);
    expect(r.leftover).toBe(0);
  });
  it("下限未満は残：2枚・範囲[3,12] → 回路0・残2", () => {
    const r = buildCircuits("pa", 2, { min: 3, max: 12 });
    expect(r.circuits).toEqual([]);
    expect(r.leftover).toBe(2);
  });
  it("範囲なし（電圧不成立 max<1）は全数残", () => {
    const r = buildCircuits("pa", 10, { min: 5, max: 0 });
    expect(r.circuits).toEqual([]);
    expect(r.leftover).toBe(10);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: FAIL（`buildCircuits` is not defined）

- [ ] **Step 3: 最小実装**

`src/calc/pcsOptimize.ts` に追加:

```ts
/**
 * 1型式の枚数を回路（直列数枚の束）に分割する。
 * - 範囲なし（max<min または max<1）→ 全数残。
 * - T<min → 回路を作れず全数残。
 * - それ以外：pickSeries で直列数 s を決め、満数回路 floor(T/s) 本。
 *   端数 R が R>=min なら短い回路1本（R枚）、R<min なら R 枚を残。
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: PASS（Task1の3件 + Task2の4件 = 7件）

- [ ] **Step 5: コミット**

```bash
git add src/calc/pcsOptimize.ts src/calc/pcsOptimize.test.ts
git commit -m "feat(optimize): 在庫を回路に分割する buildCircuits"
```

---

## Task 3: 回路を台へ均等配分 `distribute`

回路群を N 台へバランスよく詰める。制約：1MPPT=単一(型式,直列数)・並列≤`stringsPerMppt`、MPPT行数≤`mpptCount`、1台合計回路数≤C。分岐（同一型式・同一直列）は同じMPPT行の並列で表現。`multiMppt===false` の機種は1台＝単一(型式,直列数)に限定。

**Files:**
- Modify: `src/calc/pcsOptimize.ts`
- Test: `src/calc/pcsOptimize.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/calc/pcsOptimize.test.ts` に追記:

```ts
import { distribute } from "./pcsOptimize";
import type { PcsSpec } from "../types";

// 合成PCS（温度補正の影響を避けるため電気特性は単純値）。Huawei相当の2MPPT/分岐2。
const PCS_T: PcsSpec = {
  id: "pt", maker: "Test", model: "T", kind: "new",
  ratedPowerKw: 5, mpptCount: 2, multiMppt: true, stringsPerMppt: 2,
  maxInputVoltageV: 600, mpptVoltageMinV: 120, mpptVoltageMaxV: 560,
  maxInputCurrentPerMpptA: 20,
};

describe("distribute", () => {
  it("同一型式5回路を2台へ均等配分（分岐で並列化、合計≤C=3）", () => {
    const circuits = Array.from({ length: 5 }, () => ({ panelId: "pa", series: 12 }));
    const r = distribute(circuits, PCS_T, 2, 3);
    // 1台最大 min(C=3, mpptCount2*stringsPerMppt2=4)=3。5本→3+2 に分かれる
    const counts = r.units.map((u) =>
      (u.strings ?? []).reduce((a, s) => a + s.parallel, 0)
    );
    expect(counts.sort()).toEqual([2, 3]);
    expect(r.leftoverCircuits).toHaveLength(0);
    // 各MPPT行の並列は stringsPerMppt(2) 以内
    for (const u of r.units)
      for (const s of u.strings ?? []) expect(s.parallel).toBeLessThanOrEqual(2);
  });

  it("容量不足は余った回路を leftoverCircuits に返す（7回路・2台・C3 → 6配置/1余り）", () => {
    const circuits = Array.from({ length: 7 }, () => ({ panelId: "pa", series: 12 }));
    const r = distribute(circuits, PCS_T, 2, 3);
    const placed = r.units.flatMap((u) => u.strings ?? []).reduce((a, s) => a + s.parallel, 0);
    expect(placed).toBe(6);
    expect(r.leftoverCircuits).toHaveLength(1);
  });

  it("複数型式は1台のMPPTごとに別型式で同居できる", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
      { panelId: "pb", series: 11 },
    ];
    const r = distribute(circuits, PCS_T, 1, 3);
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    // pa は分岐で並列2、pb は別MPPTに並列1
    const pa = slots.find((s) => s.panelId === "pa");
    const pb = slots.find((s) => s.panelId === "pb");
    expect(pa?.parallel).toBe(2);
    expect(pb?.parallel).toBe(1);
    expect(r.leftoverCircuits).toHaveLength(0);
  });

  it("非マルチMPPT機は1台＝単一型式・単一直列に限定", () => {
    const nonMulti: PcsSpec = { ...PCS_T, multiMppt: false, mpptCount: 1, stringsPerMppt: 4 };
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pb", series: 11 },
    ];
    const r = distribute(circuits, nonMulti, 2, 4);
    // pa と pb は別の台に入る（同居しない）
    for (const u of r.units) {
      const ids = new Set((u.strings ?? []).map((s) => s.panelId));
      expect(ids.size).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: FAIL（`distribute` is not defined）

- [ ] **Step 3: 最小実装**

`src/calc/pcsOptimize.ts` に追加:

```ts
interface UnitState {
  pcsId: string;
  slots: PcsString[]; // 各 slot = 1 MPPT 行（panelId+series 固定、parallel=分岐数）
  total: number;      // 合計回路数（parallel の総和）
}

/**
 * 回路群を N 台へ均等配分する。
 * 1台の上限：合計回路数 ≤ min(maxCircuitsPerUnit, mpptCount*stringsPerMppt)。
 * 1 MPPT 行：単一(panelId,series)・並列 ≤ stringsPerMppt。
 * multiMppt===false の機種：1台に複数の(panelId,series)を混在させない。
 * 配置先は「合計回路数が最小の台（同点は番号の小さい台）」を選びバランスを取る。
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

  // 同一(型式,直列)が固まると分岐に束ねやすいので、グループ順に処理する
  const sorted = [...circuits].sort((a, b) =>
    a.panelId === b.panelId ? a.series - b.series : a.panelId < b.panelId ? -1 : 1
  );

  const leftoverCircuits: Circuit[] = [];

  for (const c of sorted) {
    // この回路を置ける台の候補をバランス順（total 昇順, index 昇順）に評価
    const order = units
      .map((u, i) => ({ u, i }))
      .sort((x, y) => (x.u.total - y.u.total) || (x.i - y.i));
    let placed = false;
    for (const { u } of order) {
      if (u.total >= perUnitCap) continue;
      // 非マルチ機：既に別(型式,直列)が入っている台には入れない
      if (!multi && u.slots.length > 0) {
        const s0 = u.slots[0];
        if (s0.panelId !== c.panelId || s0.series !== c.series) continue;
      }
      // 同一(型式,直列)の既存スロットがあり並列に余裕 → 分岐で束ねる
      const match = u.slots.find(
        (s) => s.panelId === c.panelId && s.series === c.series && s.parallel < pcs.stringsPerMppt
      );
      if (match) {
        match.parallel += 1;
        u.total += 1;
        placed = true;
        break;
      }
      // 空きMPPT行があれば新規スロット
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: PASS（累計 11 件）

- [ ] **Step 5: コミット**

```bash
git add src/calc/pcsOptimize.ts src/calc/pcsOptimize.test.ts
git commit -m "feat(optimize): 回路を台へ均等配分する distribute"
```

---

## Task 4: 総合 `optimizePcs`（在庫→直列範囲→回路→配分→残/警報）

在庫・PCS・条件から一気通貫で構成を生成する。電流超過は容認して `ampWarnings` に出す。残枚数・必要台数・注記をまとめる。

**Files:**
- Modify: `src/calc/pcsOptimize.ts`
- Test: `src/calc/pcsOptimize.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/calc/pcsOptimize.test.ts` に追記:

```ts
import { optimizePcs } from "./pcsOptimize";
import type { PanelSpec, DesignConditions } from "../types";

// 温度補正が効かないよう温度係数0。range は STC 値で決まる。
const PANEL_A: PanelSpec = {
  id: "pa", maker: "Test", model: "A",
  lengthMm: 1700, widthMm: 1000, pmaxW: 300, vmpV: 40, impA: 9.5, vocV: 50, iscA: 10,
  tempCoeffVocPctPerC: 0, tempCoeffPmaxPctPerC: 0,
};
const PANEL_B: PanelSpec = {
  id: "pb", maker: "Test", model: "B",
  lengthMm: 1700, widthMm: 1000, pmaxW: 360, vmpV: 39, impA: 9.2, vocV: 48, iscA: 9.5,
  tempCoeffVocPctPerC: 0, tempCoeffPmaxPctPerC: 0,
};
const COND: DesignConditions = { minAmbientTempC: -10, maxCellTempC: 70 };

describe("optimizePcs", () => {
  it("単一型式を使い切る（PANEL_A 24枚 / PCS_T 範囲[3,12]→直列12×2回路, 1台に収容）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3,
    });
    expect(r.leftoverTotal).toBe(0);
    const placed = r.units.flatMap((u) => u.strings ?? [])
      .reduce((a, s) => a + s.series * s.parallel, 0);
    expect(placed).toBe(24);
    expect(r.ampWarnings).toHaveLength(0); // 2*isc10=20 ≤ 20 で超過なし
  });

  it("複数型式が1台のMPPTごとに別型式で同居（PANEL_A24 + PANEL_B11）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }, { panelId: "pb", count: 11 }],
      panels: [PANEL_A, PANEL_B], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3,
    });
    expect(r.units).toHaveLength(1);
    const ids = new Set((r.units[0].strings ?? []).map((s) => s.panelId));
    expect(ids).toEqual(new Set(["pa", "pb"]));
    expect(r.leftoverTotal).toBe(0);
  });

  it("台数不足は残＋必要台数を返す（PANEL_A 84枚=7回路 / 2台・C3 → 6回路配置・1回路残）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 84 }],
      panels: [PANEL_A], pcs: PCS_T, conditions: COND,
      unitCount: 2, maxCircuitsPerUnit: 3,
    });
    expect(r.leftoverTotal).toBe(12);          // 残1回路 = 直列12
    expect(r.unitsNeededForAll).toBe(3);        // ceil(7 / 3)
  });

  it("電流超過は容認して警報に出す（maxInputCurrent16・並列2で 2*10=20>16）", () => {
    const PCS_AMP: PcsSpec = { ...PCS_T, id: "pamp", maxInputCurrentPerMpptA: 16 };
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_AMP, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3,
    });
    expect(r.ampWarnings.length).toBeGreaterThan(0);
    // 容認なので配置は行われている（残0）
    expect(r.leftoverTotal).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: FAIL（`optimizePcs` is not defined）

- [ ] **Step 3: 最小実装**

`src/calc/pcsOptimize.ts` に追加:

```ts
/** 在庫・機種・条件から下書き構成を生成する。 */
export function optimizePcs(input: OptimizeInput): OptimizeResult {
  const { inventory, panels, pcs, conditions, unitCount, maxCircuitsPerUnit } = input;
  const notes: string[] = [];

  // 1) 型式ごとに回路へ分割
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
      // 短い回路がある場合の注記（満数より少ない直列）
      const shorts = circuits.filter((c) => c.series < sz.seriesRange.max);
      if (shorts.length) notes.push(`${panel.maker} ${panel.model}：短い回路あり（直列 ${shorts.map((s) => s.series).join(",")}）`);
    }
  }

  // 2) 台へ配分
  const { units, leftoverCircuits } = distribute(allCircuits, pcs, unitCount, maxCircuitsPerUnit);

  // 3) 入り切らなかった回路を残へ合算
  for (const c of leftoverCircuits) {
    const ex = leftover.find((l) => l.panelId === c.panelId);
    if (ex) ex.count += c.series;
    else leftover.push({ panelId: c.panelId, count: c.series });
  }

  // 4) 電流超過の警報（容認）
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

  // 5) 必要台数の目安（配置できた回路＋入り切らなかった回路の総数 ÷ 1台容量）
  const perUnitCap = Math.min(Math.max(1, maxCircuitsPerUnit), pcs.mpptCount * pcs.stringsPerMppt);
  const totalCircuits = allCircuits.length;
  const unitsNeededForAll = totalCircuits > 0 ? Math.ceil(totalCircuits / perUnitCap) : 0;

  const leftoverTotal = leftover.reduce((a, l) => a + l.count, 0);
  return { units, leftover, leftoverTotal, unitsNeededForAll, ampWarnings, notes };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: PASS（累計 15 件）

- [ ] **Step 5: 全テスト＆型チェック**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS・型エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/calc/pcsOptimize.ts src/calc/pcsOptimize.test.ts
git commit -m "feat(optimize): 在庫から下書き構成を生成する optimizePcs"
```

---

## Task 5: UI 統合（入力・プレビュー・適用）

`PcsComposer.tsx` に「🎯 自動構成（下書き）」ブロックを追加。機種・台数・最大回路数を入力 →「最適化（下書きを作成）」でプレビュー →「この内容を適用」で `pcsUnits` を置き換え。React 単体テストは本リポジトリに無いため、稼働アプリでの手動確認とする。

**Files:**
- Modify: `src/components/PcsComposer.tsx`

- [ ] **Step 1: import と state を追加**

`src/components/PcsComposer.tsx` 冒頭の import 群に追加:

```ts
import { optimizePcs, type OptimizeResult } from "../calc/pcsOptimize";
```

`PcsComposer` 関数の上部（`const fmt = ...` の近く）に state を追加:

```ts
const [optModelId, setOptModelId] = useState(pcsList[0]?.id ?? "");
const [optCount, setOptCount] = useState(8);
const [optMaxCircuits, setOptMaxCircuits] = useState(pcsList[0]?.mpptCount ?? 2);
const [optPreview, setOptPreview] = useState<OptimizeResult | null>(null);
```

- [ ] **Step 2: 在庫構築と実行/適用ハンドラを追加**

`computed` などの集計の後ろ（`const errorUnits = ...` 付近）に追加:

```ts
// 図面の型式別在庫を panelId 単位に変換（最適化の入力）
const optInventory = layoutSummary.byPanel
  .map((b) => {
    const p = panels.find((pp) => `${pp.maker} ${pp.model}` === b.model);
    return p ? { panelId: p.id, count: b.count } : null;
  })
  .filter((x): x is { panelId: string; count: number } => x !== null);

function runOptimize() {
  const pcs = pcsList.find((p) => p.id === optModelId);
  if (!pcs || optCount < 1 || optMaxCircuits < 1) return;
  setOptPreview(
    optimizePcs({
      inventory: optInventory,
      panels,
      pcs,
      conditions,
      unitCount: optCount,
      maxCircuitsPerUnit: optMaxCircuits,
    })
  );
}
function applyOptimize() {
  if (!optPreview) return;
  updatePlant(plant.id, { pcsUnits: optPreview.units });
  setOptPreview(null);
}
```

- [ ] **Step 3: 入力UI＋プレビューを描画**

サマリカード内、`<div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>`（パワコン追加ボタンの行）の**直前**に挿入:

```tsx
{/* 自動構成（下書き補助） */}
<div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
  <div className="row" style={{ alignItems: "flex-end" }}>
    <strong style={{ fontSize: 14 }}>🎯 自動構成（下書き）</strong>
    <div className="field" style={{ minWidth: 220 }}>
      <label>対象パワコン機種</label>
      <select
        value={optModelId}
        onChange={(e) => {
          setOptModelId(e.target.value);
          const p = pcsList.find((x) => x.id === e.target.value);
          if (p) setOptMaxCircuits(p.mpptCount);
        }}
      >
        {pcsList.map((p) => (
          <option key={p.id} value={p.id}>{p.maker} {p.model}（{p.ratedPowerKw}kW）</option>
        ))}
      </select>
    </div>
    <div className="field" style={{ width: 80 }}>
      <label>台数</label>
      <input type="number" min={1} value={optCount}
        onChange={(e) => setOptCount(Math.max(1, Number(e.target.value) || 1))} />
    </div>
    <div className="field" style={{ width: 130 }}>
      <label>最大回路数/台</label>
      <input type="number" min={1} value={optMaxCircuits}
        onChange={(e) => setOptMaxCircuits(Math.max(1, Number(e.target.value) || 1))} />
    </div>
    <button className="btn" onClick={runOptimize}>最適化（下書きを作成）</button>
  </div>
  <span className="hint">
    図面のパネルを使い切る方向で各台へ割り振った下書きを作ります（電圧上限は厳守・電流超過は警報のみ）。最大回路数は機種のMPPT数が既定（Huaweiは分岐で3など手入力）。
  </span>

  {optPreview && (
    <div className="card" style={{ marginTop: 10, background: "var(--panel-2)" }}>
      <div className="row">
        <strong>プレビュー（{optPreview.units.length} 台）</strong>
        <span className="spacer" />
        <button className="btn small" onClick={applyOptimize}>この内容を適用</button>
        <button className="btn secondary small" onClick={() => setOptPreview(null)}>破棄</button>
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        残 {fmt(optPreview.leftoverTotal)} 枚
        {optPreview.leftoverTotal > 0 && optPreview.unitsNeededForAll > optCount &&
          `（使い切るには約 ${optPreview.unitsNeededForAll} 台必要）`}
      </div>
      {optPreview.ampWarnings.map((w, i) => (
        <div className="warn-item" key={"a" + i} style={{ marginTop: 4, color: "var(--warn)", borderColor: "var(--warn)" }}>⚠ {w}</div>
      ))}
      {optPreview.notes.map((n, i) => (
        <div className="hint" key={"n" + i} style={{ marginTop: 2 }}>・{n}</div>
      ))}
      <table className="list" style={{ marginTop: 8 }}>
        <thead><tr><th>#</th><th>MPPT構成（型式 / 直列 × 並列）</th><th className="num">枚数</th></tr></thead>
        <tbody>
          {optPreview.units.map((u, i) => {
            const cells = (u.strings ?? []).reduce((a, s) => a + s.series * s.parallel, 0);
            const desc = (u.strings ?? []).map((s) => {
              const p = panels.find((pp) => pp.id === s.panelId);
              return `${p ? p.model : "?"} ${s.series}直×${s.parallel}並`;
            }).join(" ／ ");
            return (<tr key={u.id}><td>#{i + 1}</td><td>{desc}</td><td className="num">{cells}</td></tr>);
          })}
        </tbody>
      </table>
    </div>
  )}
</div>
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: 型エラーなし

- [ ] **Step 5: 稼働アプリで手動確認**

1. `npm run dev` が動いていることを確認（http://localhost:5173/）。
2. ③パワコン構成タブを開く（在庫のある発電所・候補。例: 西尾市上町発電所／候補2）。
3. 「🎯 自動構成（下書き）」で機種=Huawei、最大回路数=3、台数を適当に入れ「最適化」を押す。
4. 確認項目:
   - プレビューに各台のMPPT構成・枚数が出る。
   - 残枚数／必要台数の表示が在庫（254枚）と整合。
   - 電流超過があれば⚠警報が出る（エラーで止まらない）。
   - 「この内容を適用」で下の各台カードが置き換わり、上部の「型式別パネル在庫」バーの使用/残が更新される。
   - 適用後、各台カードで直列/並列を手編集できる（下書きの微調整）。
5. スクリーンショットで結果を確認する。

- [ ] **Step 6: コミット**

```bash
git add src/components/PcsComposer.tsx
git commit -m "feat(optimize): パワコン構成に自動構成（下書き）UIを追加"
```

---

## セルフレビュー結果

- **Spec 6章「電流超過は容認＋警報」** → Task4 Step3 の `ampWarnings`、Task5 のプレビュー⚠表示で実装。
- **Spec 4章 直列選定（使い切り優先）** → Task1 `pickSeries` は「mod最小」ではなく「残（配置不能端数）最小」で実装。これは spec の最優先事項「使い切り」をより忠実に満たす実体化（spec 4章の意図に一致）。
- **Spec 「1台複数型式OK・MPPTごと別型式」「分岐＝同一型式同一直列の並列」** → Task3 `distribute` の slot 単位＋ `multiMppt` 分岐で実装・テスト。
- **Spec 「台数固定・残・あと約N台」** → Task4 `leftoverTotal`/`unitsNeededForAll`、Task5 表示。
- **Spec 「プレビュー→適用」** → Task5。
- **Spec 7章 エッジ（範囲なし・分岐不可機種・空在庫）** → Task2（範囲なし/下限未満）・Task3（非マルチ）でテスト。空在庫は `optInventory` が空→ `units` 空・残0（UIで台数0等はボタン無効化はしないが、回路0で空結果。必要なら手動確認で挙動を見る）。
- プレースホルダなし。型整合（`OptimizeResult`/`InventoryItem`/`Circuit`/`PcsUnitLine`/`PcsString`）を Task1〜5 で一貫使用。
