# パワコン自動構成：配分の優先（影に強い／詰める）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自動構成（下書き）に「配分の優先」を追加し、`spread`（影に強い・MPPT分散・既定）と `dense`（台数を詰める・分岐優先）を選べるようにする。

**Architecture:** `distribute`／`optimizePcs`（`src/calc/pcsOptimize.ts`・純関数）に `strategy` 引数を足し、1回路ずつの (a) 台の選び方 と (b) 1台内の置き方 を切り替える。UI（`PcsComposer.tsx`）にセレクトを1つ追加し state を渡すだけ。電圧厳守・電流容認警報・残/必要台数は不変。

**Tech Stack:** React + Vite + TypeScript、Vitest。仕様書: `docs/superpowers/specs/2026-06-16-pcs-optimizer-strategy-design.md`。

## ファイル構成
- 変更 `src/calc/pcsOptimize.ts`：`PackStrategy` 型・`distribute`/`optimizePcs` に `strategy` 追加。
- 変更 `src/calc/pcsOptimize.test.ts`：既存テストを spread 既定に整合＋dense/spread の対比テスト追加。
- 変更 `src/components/PcsComposer.tsx`：「配分の優先」セレクト＋state＋呼び出しに strategy。

---

## Task 1: pcsOptimize に strategy を追加（ロジック＋テスト）

**Files:**
- Modify: `src/calc/pcsOptimize.ts`
- Modify: `src/calc/pcsOptimize.test.ts`

- [ ] **Step 1: テストを更新（失敗する状態にする）**

`src/calc/pcsOptimize.test.ts` を**以下の内容で全置換**する（既存の分岐前提テストを dense へ振替＋spread/dense 対比を追加）:

```ts
import { describe, it, expect } from "vitest";
import { pickSeries, buildCircuits } from "./pcsOptimize";

describe("pickSeries", () => {
  it("割り切れる直列数を選ぶ（24枚は直列12でちょうど2回路）", () => {
    expect(pickSeries(24, 3, 12)).toBe(12);
  });
  it("割り切れないが端数を回路にできる直列数を選ぶ（26枚→直列11で残0）", () => {
    expect(pickSeries(26, 3, 12)).toBe(11);
  });
  it("T が範囲内ならその枚数で1回路（7枚→直列7）", () => {
    expect(pickSeries(7, 3, 12)).toBe(7);
  });
});

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

import { distribute } from "./pcsOptimize";
import type { PcsSpec } from "../types";

const PCS_T: PcsSpec = {
  id: "pt", maker: "Test", model: "T", kind: "new",
  ratedPowerKw: 5, mpptCount: 2, multiMppt: true, stringsPerMppt: 2,
  maxInputVoltageV: 600, mpptVoltageMinV: 120, mpptVoltageMaxV: 560,
  maxInputCurrentPerMpptA: 20,
};

describe("distribute", () => {
  it("既定(spread)：同一型式5回路を2台へ均等配分（合計≤C=3・並列≤2）", () => {
    const circuits = Array.from({ length: 5 }, () => ({ panelId: "pa", series: 12 }));
    const r = distribute(circuits, PCS_T, 2, 3);
    const counts = r.units.map((u) => (u.strings ?? []).reduce((a, s) => a + s.parallel, 0));
    expect(counts.sort()).toEqual([2, 3]);
    expect(r.leftoverCircuits).toHaveLength(0);
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

  it("spread：同一型式2回路は別MPPTに散らし分岐しない（並列はすべて1）", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
    ];
    const r = distribute(circuits, PCS_T, 1, 4, "spread");
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    expect(slots).toHaveLength(2); // 別MPPTに2行
    for (const s of slots) expect(s.parallel).toBe(1);
    expect(r.leftoverCircuits).toHaveLength(0);
  });

  it("dense：同一型式2回路は分岐2並列で1MPPTに束ねる", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
    ];
    const r = distribute(circuits, PCS_T, 1, 4, "dense");
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    expect(slots).toHaveLength(1); // 1MPPTに束ねる
    expect(slots[0].parallel).toBe(2);
    expect(r.leftoverCircuits).toHaveLength(0);
  });

  it("dense：複数型式は分岐で空きMPPTを作り1台に同居できる", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
      { panelId: "pb", series: 11 },
    ];
    const r = distribute(circuits, PCS_T, 1, 3, "dense");
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
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
    for (const u of r.units) {
      const ids = new Set((u.strings ?? []).map((s) => s.panelId));
      expect(ids.size).toBeLessThanOrEqual(1);
    }
  });
});

import { optimizePcs } from "./pcsOptimize";
import type { PanelSpec, DesignConditions } from "../types";

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
  it("単一型式を使い切る（PANEL_A 24枚 / 既定spread → 1台に24枚・残0）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3,
    });
    expect(r.leftoverTotal).toBe(0);
    const placed = r.units.flatMap((u) => u.strings ?? [])
      .reduce((a, s) => a + s.series * s.parallel, 0);
    expect(placed).toBe(24);
    expect(r.ampWarnings).toHaveLength(0);
  });

  it("spread：同一型式は分岐せず別MPPT（並列はすべて1・電流警報なし）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3, strategy: "spread",
    });
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    expect(slots).toHaveLength(2);
    for (const s of slots) expect(s.parallel).toBe(1);
    expect(r.ampWarnings).toHaveLength(0);
    expect(r.leftoverTotal).toBe(0);
  });

  it("dense：複数型式が1台のMPPTごとに別型式で同居（PANEL_A24 + PANEL_B11）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }, { panelId: "pb", count: 11 }],
      panels: [PANEL_A, PANEL_B], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3, strategy: "dense",
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
    expect(r.leftoverTotal).toBe(12);
    expect(r.unitsNeededForAll).toBe(3);
  });

  it("dense：電流超過は容認して警報に出す（maxInputCurrent16・分岐並列2で 2*10=20>16）", () => {
    const PCS_AMP: PcsSpec = { ...PCS_T, id: "pamp", maxInputCurrentPerMpptA: 16 };
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_AMP, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3, strategy: "dense",
    });
    expect(r.ampWarnings.length).toBeGreaterThan(0);
    expect(r.leftoverTotal).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: FAIL／型エラー（`distribute` が5引数目を受け取らない・`OptimizeInput` に `strategy` が無い・dense/spread の期待に現コードが合わない）

- [ ] **Step 3: `pcsOptimize.ts` を実装**

(3-1) `Circuit` interface の直後あたりに型を追加:

```ts
/** 配分の優先：spread=影に強い(MPPT分散)・dense=台数を詰める(分岐優先) */
export type PackStrategy = "spread" | "dense";
```

(3-2) `OptimizeInput` に任意の `strategy` を追加（`maxCircuitsPerUnit` の後）:

```ts
  /** 1台あたり最大回路数（分岐含む・手入力） */
  maxCircuitsPerUnit: number;
  /** 配分の優先（既定: spread=影に強い分散） */
  strategy?: PackStrategy;
```

(3-3) `distribute` を strategy 対応に置き換える（シグネチャに第5引数 `strategy: PackStrategy = "spread"` を追加し、台の並び順と1台内の置き方を分岐）:

```ts
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
        // 分岐(2並列)で束ねる → 次に別MPPT
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
```

(3-4) `optimizePcs` で strategy を取り出して `distribute` に渡す。`const { inventory, ... maxCircuitsPerUnit } = input;` の行を次に変更:

```ts
  const { inventory, panels, pcs, conditions, unitCount, maxCircuitsPerUnit } = input;
  const strategy = input.strategy ?? "spread";
  const notes: string[] = [];
```

そして `distribute` 呼び出しを:

```ts
  const { units, leftoverCircuits } = distribute(allCircuits, pcs, unitCount, maxCircuitsPerUnit, strategy);
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/calc/pcsOptimize.test.ts`
Expected: PASS（pickSeries 3＋buildCircuits 4＋distribute 6＋optimizePcs 5 = 計18件）

- [ ] **Step 5: 全テスト＋型チェック**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全PASS・型エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/calc/pcsOptimize.ts src/calc/pcsOptimize.test.ts
git commit -m "feat(optimize): 配分の優先 strategy(spread/dense) を distribute/optimizePcs に追加"
```

---

## Task 2: UI に「配分の優先」セレクトを追加

**Files:**
- Modify: `src/components/PcsComposer.tsx`

- [ ] **Step 1: import に型を追加**

`import { optimizePcs, type OptimizeResult } from "../calc/pcsOptimize";` を次に変更:

```ts
import { optimizePcs, type OptimizeResult, type PackStrategy } from "../calc/pcsOptimize";
```

- [ ] **Step 2: state を追加**

`const [optPreview, setOptPreview] = useState<OptimizeResult | null>(null);` の直後に追加:

```ts
const [optStrategy, setOptStrategy] = useState<PackStrategy>("spread");
```

- [ ] **Step 3: runOptimize に strategy を渡す**

`runOptimize` 内の `optimizePcs({ ... maxCircuitsPerUnit: optMaxCircuits, })` 呼び出しに `strategy` を追加:

```ts
    setOptPreview(
      optimizePcs({
        inventory: optInventory,
        panels,
        pcs,
        conditions,
        unitCount: optCount,
        maxCircuitsPerUnit: optMaxCircuits,
        strategy: optStrategy,
      })
    );
```

- [ ] **Step 4: セレクトUIを追加**

自動構成の入力行で、「最大回路数/台」の `<div className="field" style={{ width: 130 }}>…</div>`（最大回路数の input を含む field）の**直後**、「最適化（下書きを作成）」ボタンの**直前**に挿入:

```tsx
<div className="field" style={{ minWidth: 200 }}>
  <label>配分の優先</label>
  <select value={optStrategy} onChange={(e) => setOptStrategy(e.target.value as PackStrategy)}>
    <option value="spread">影に強い（MPPT分散）</option>
    <option value="dense">台数を詰める（分岐優先）</option>
  </select>
</div>
```

そして自動構成ブロックの説明 hint（「図面のパネルを使い切る方向で…」の `<span className="hint">…</span>`）の文末に、配分の補足を追記（既存文の後ろに足す）:

```
分散＝影に強い・電流が素直／詰める＝台数最少（分岐・コスト優先）。
```

- [ ] **Step 5: 型チェック**

Run: `npx tsc --noEmit`
Expected: 型エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/components/PcsComposer.tsx
git commit -m "feat(optimize): 自動構成に「配分の優先（影に強い/詰める）」セレクトを追加"
```

---

## セルフレビュー結果
- **Spec 2/3章（spread/dense の挙動）** → Task1 Step3 の `distribute` で台順・1台内順を strategy 切替で実装。spread=別MPPT優先＋バランス、dense=分岐優先＋埋まった台優先。
- **Spec 既定=spread** → `distribute` 第5引数 `= "spread"`、`optimizePcs` で `input.strategy ?? "spread"`。
- **Spec 4/5章（UI・state）** → Task2 でセレクト＋`optStrategy`（既定spread）＋runOptimizeに strategy。
- **Spec 6章（テスト）** → 既存「同居=分岐」テストを dense へ振替、spread/dense 対比テストを distribute・optimizePcs 双方に追加。電圧・電流警報・残/必要台数の検証は維持。
- 既存の「同一型式5回路」「容量不足7回路」「非マルチ」「単一型式使い切り」「台数不足」テストは spread 既定でも成立（counts・容量・配置枚数ベースのため）。
- 型整合：`PackStrategy` を pcsOptimize で定義・export し UI で import。プレースホルダなし。
