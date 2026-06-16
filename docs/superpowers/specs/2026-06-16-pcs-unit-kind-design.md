# パワコン構成：台ごとの新設/既設（kind）指定 設計

- 日付: 2026-06-16
- 対象: ソーラーレイアウト設計支援アプリ（`solar-layout`）／③パワコン構成・④概算コスト
- 種別: バグ修正＋小機能追加

## 1. 背景・目的（バグの根本原因）

④概算コストの「🔄 現況レイアウトから反映」(`applyFromLayout`) は、押すたびにパワコンの
新設/既設トグル(`pcsMode`)を設計内容から決め直す（`CostEstimator.tsx:110`）。
その判定 `derived.newPcs`（同 70-74行）は、パワコン構成の各台が参照する**機種マスタの
`kind`** が `"new"` のものを数える。Huawei SUN2000-4.95KTL-NHL2 のマスタは `kind: "new"`
なので、設計でHuaweiを使うと `derived.newPcs > 0` となり、コスト画面で手動で「既設流用」に
しても反映で「新設」へ戻ってしまう。

根本原因は「新設/既設が機種マスタ単位でしか持てない」こと。同じ型番でも発電所によって
新設（購入）か既設（流用）かは変わるため、**台ごとに新設/既設を持てる**ようにするのが正しい。
これにより設計が既設を表現でき、反映・コストも一貫して既設になる。

## 2. 決定方針

- `PcsUnitLine` に任意の `kind?: "existing" | "new"` を追加。**実効種別 = `unit.kind ?? master.kind`**。
- パワコン構成の各台カードに「種別：新設／既設」セレクトを追加（既定＝実効種別）。
- 概算コストの `derived.newPcs` を実効種別で数える。これでバグが設計的に解消する。
- 既存データ（kind 未指定）は従来どおりマスタ継承＝挙動不変。

## 3. データモデル（types.ts）

`PcsUnitLine` にフィールドを追加：

```ts
export interface PcsUnitLine {
  id: string;
  pcsId: string;
  count: number;
  note?: string;
  strings?: PcsString[];
  /** この台の新設/既設の上書き。未指定なら機種マスタの kind を継承。 */
  kind?: "existing" | "new";
}
```

実効種別の解決は `unit.kind ?? master.kind`（master は `pcsList.find(p => p.id === unit.pcsId)`）。
ヘルパ関数は作らずインラインで解決する（一行・YAGNI）。

## 4. パワコン構成UI（PcsComposer.tsx）

各台カードの機種セレクトの隣に「種別」セレクトを追加：

- ラベル「種別」。option: `新設`(value=new) / `既設（流用）`(value=existing)。
- `value` ＝ 実効種別（`g.line.kind ?? g.pcs?.kind ?? "new"`）。
- `onChange` で `updateUnit(g.line.id, { kind: e.target.value as "existing" | "new" })`。
- 既設のとき、ヒントで「流用＝コストに設置費なし」を小さく表示（任意・1行）。

機種セレクトの option ラベルにある `(既設/新設 …)` 表記はマスタ既定の参考表示として残す。
種別セレクトが台の実効種別の入力源（source of truth）。

## 5. 概算コストへの反映（CostEstimator.tsx）

`derived` 内の新設パワコン台数集計（70-74行）を実効種別ベースに変更：

```ts
let newPcs = 0;
for (const u of plant.pcsUnits ?? []) {
  const pcs = pcsList.find((p) => p.id === u.pcsId);
  const eff = u.kind ?? pcs?.kind;   // 台ごとの実効種別（未指定はマスタ継承）
  if (eff === "new") newPcs += u.count ?? 1;
}
```

`applyFromLayout`（110行）は変更しない。`derived.newPcs` が実効種別で正しく算出されるため、
全台を既設にすれば `derived.newPcs === 0` となり、反映後も `pcsMode === "keep"`（既設）のまま
になる。これが今回のバグ修正の本体。

## 6. 影響範囲・既定

- 自動構成（`optimizePcs`）が生成する台は `kind` 未指定＝マスタ継承（新設）。生成ロジックは不変。
  生成後に台ごとへ既設へ切替できる。
- `duplicateUnit` は `...u` の展開で `kind` も複製される（既存実装のまま）。
- 既存の発電所データは `kind` 未指定なので従来どおり（マスタの新設扱い）。挙動の後方互換あり。

## 7. テスト

- 実効種別の判定は CostEstimator 内の集計（React コンポーネント）で、本リポには React 単体テスト
  基盤が無いため、**稼働アプリでの手動確認**とする：
  1. ③パワコン構成で台を「既設」に切替。
  2. ④概算コストで「現況レイアウトから反映」を押す。
  3. パワコンが「既設流用」のまま・新設台数が既設台数ぶん減ることを確認。
  4. 一部の台だけ既設にした場合、新設台数が新設の台数だけになることを確認。
- 既存の純関数テスト（`pcsOptimize` 等 62件）は本変更の影響を受けない＝維持。

## 8. スコープ外（YAGNI）

- 既設パワコンの撤去台数（`removedPcsCount`）の自動算出（従来どおり手入力）。
- 機種マスタ側の kind 既定の変更。
- 自動構成での新設/既設の自動振り分け。
