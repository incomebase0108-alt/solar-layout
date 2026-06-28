# Claude ワークログ — 直近の作業の流れ
> 別名(Slack): #ソーラーレイアウト 太陽光レイアウト&パワコン構成設計アプリ

> このファイルは「常時読む記憶」です。**小さく保ってください**。
> 古い記録は `/worklog` スキルが `archive/` に圧縮移動します。
> 新しいエントリは**この見出しの直下**（新しい順）に追記します。

---

## 2026-06-28 19:00 — DESKTOP-L9CSJDA — main
- やったこと: パワコン構成の自動最適化を全面刷新（`src/calc/pcsOptimize.ts`＋`PcsComposer.tsx`）。目的＝各台の過積載率(DC/定格)を揃える＋全パネル使い切り。台数を型式のDC量に比例配分→型式内で直列均等(W差を直列長で吸収)→端数は直列+1で吸収→残れば⚠強制割当(マルチ機の空きMPPTのみ・電圧上限厳守)。非マルチ機は1MPPTでも±1直の並列混在可(例26枚=7直×2並+6直×2並)。検証は「並列合計≤上限」で判定。
- 追加: **おすすめ3案**(影に強い/標準/配線シンプル＝`pref` shade/balanced/wiring、`optimizeIntoUnitsPatterns`)、1案/2案/3案を横並び比較→選択適用。設計最低気温の既定を−3℃(西尾市基準・`DEFAULT_CONDITIONS`)＋StringCalculatorにヒント。
- 区分まわり: パワコンマスタの「区分(新設/既設)」を廃止(PcsRegistry/PcsSpec.kind任意化)、新設/既設は台ごと(PcsUnitLine.kind・既定=新設)。概算コストは**新設の台だけ・各台の実機種unitPriceYen**で計上(CostEstimator)。
- 決めたこと: 電圧上限は強制割当でも絶対に破らない(下限未満/本数は許容して警告)。電流は effParallel=min(stringsPerMppt,⌊MPPT最大電流÷Isc⌋) で分岐抑制(赤エラー防止)。
- 検証: vitest 80件通過。pcsOptimize/PcsComposer等の自分の変更は型エラー0。
- 次の一手: ⚠OMRON(KPV/KPR/KPW)はseed単価が未登録(0円)→「パワコン登録」で単価を入れる(or seedに追加)。`src/calc/candidateCost.ts`(未追跡)＋CostEstimator/CandidateCostInputsは別作業のコスト改修WIPで`npm run build`(tsc)が通らない→要整理。b.txt/e.txt/probe_defs.txtは不明な未追跡ファイル(掃除候補)。コード変更は未コミット(本記録はworklogのみ)。

## 2026-06-18 13:17 — DESKTOP-L9CSJDA — main
- 何のプロジェクト: 太陽光レイアウト&パワコン構成設計アプリ（React + Vite + TypeScript）。
- やったこと: 既存リポジトリ「solar-layout」を横断目次に取り込み、ワークログ一式を後付け。
- 注意（取り込み前からの未コミット変更）: `src/components/LayoutEditor.tsx` と `起動.bat` が変更済み（私は未着手・内容未確認）。
- 次の一手: 上記2ファイルの変更内容を確認し、意図した変更ならコミット、不要なら破棄を判断する。
