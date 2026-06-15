import { useMemo, useState } from "react";
import type { PanelSpec, PcsSpec, PowerPlant, CostRates } from "../types";
import { estimateCost, estimateAfterGeneration, estimateRoi, type NewPanelLine } from "../calc/cost";
import { arrayCellStats } from "../calc/layoutCount";
import { uid } from "../store";

interface Props {
  plant: PowerPlant;
  panels: PanelSpec[];
  pcsList: PcsSpec[];
  costRates: CostRates;
  setCostRates: (r: CostRates) => void;
  updatePlant: (id: string, patch: Partial<Omit<PowerPlant, "id" | "layout" | "wiring">>) => void;
}

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

interface EditLine extends NewPanelLine {
  id: string;
}

export function CostEstimator({ plant, panels, pcsList, costRates, setCostRates, updatePlant }: Props) {
  // ===== 現況レイアウトから導出（改修案ベース） =====
  const derived = useMemo(() => {
    // 新設パネル（流用マーク無しの配列＝新設 ＋ 単独パネル）を型式ごとに集計
    const map = new Map<string, { label: string; w: number; count: number; unitYen: number }>();
    const addNew = (panelId: string, n: number) => {
      const p = panels.find((x) => x.id === panelId);
      const label = p ? `${p.maker} ${p.model}` : "未登録パネル";
      const cur = map.get(panelId) ?? { label, w: p?.pmaxW ?? 0, count: 0, unitYen: p?.unitPriceYen ?? 0 };
      cur.count += n;
      map.set(panelId, cur);
    };
    let removedExisting = 0; // 既設で撤去する枚数（現況満数 − 流用）
    let keptKw = 0; // 流用（据置）容量
    let beforeKw = 0; // 現況容量（撤去前満数）
    for (const a of plant.layout.arrays) {
      const p = panels.find((x) => x.id === a.panelId);
      const pmax = p?.pmaxW ?? 0;
      // 撤去との重複・グリッド外の死にキーを除いた実数で数える（layoutCount と同一ルール）
      const { grid, removed, keep, hasKeep, marked } = arrayCellStats(a);
      if (marked) {
        // 既設配列：流用以外（入換・撤去）は撤去枚数に計上
        beforeKw += (grid * pmax) / 1000;
        keptKw += (keep * pmax) / 1000;
        removedExisting += grid - keep;
        // 全部入換（流用0）：既設は全数撤去し、同じグリッドに新パネルを載せる → 新設にも計上
        if (!hasKeep) addNew(a.panelId, grid - removed);
      } else {
        // 新設配列（②で追加。既設は無いので撤去は発生しない）
        addNew(a.panelId, grid - removed);
      }
    }
    for (const f of plant.layout.freePanels ?? []) addNew(f.panelId, 1);

    // レイアウト未作成（複雑な発電所の手入力）の場合、手入力の現状を撤去対象にする
    if (plant.layout.arrays.length === 0) {
      for (const m of plant.layout.manualCurrent ?? []) {
        if (m.count <= 0) continue;
        const p = panels.find((x) => x.id === m.panelId);
        const pmax = p?.pmaxW ?? 0;
        beforeKw += (m.count * pmax) / 1000;
        removedExisting += m.count;
      }
    }

    const newLines = [...map.entries()].map(([panelId, v]) => ({ panelId, ...v }));
    const newTotal = newLines.reduce((s, l) => s + l.count, 0);
    // 新設パワコン台数（マスタが新設のもの）
    let newPcs = 0;
    for (const u of plant.pcsUnits ?? []) {
      const pcs = pcsList.find((p) => p.id === u.pcsId);
      if (pcs?.kind === "new") newPcs += u.count ?? 1;
    }
    return { newLines, newTotal, removedExisting, keptKw, beforeKw, newPcs };
  }, [plant.layout.arrays, plant.layout.freePanels, plant.layout.manualCurrent, plant.pcsUnits, panels, pcsList]);

  // ===== 編集用ステート（初期値＝現況から反映） =====
  const [lines, setLines] = useState<EditLine[]>(() =>
    derived.newLines.map((l) => ({ id: uid("cl"), label: l.label, w: l.w, count: l.count, unitYen: l.unitYen }))
  );
  const [removedDisposal, setRemovedDisposal] = useState(derived.removedExisting);
  const [removedStock, setRemovedStock] = useState(0);

  const [pcsMode, setPcsMode] = useState<"keep" | "new">(derived.newPcs > 0 ? "new" : "keep");
  const [pcsId, setPcsId] = useState(pcsList[0]?.id ?? "");
  const [newPcsCount, setNewPcsCount] = useState(derived.newPcs);
  const [removedPcsCount, setRemovedPcsCount] = useState(0);
  const [pcsUnitYen, setPcsUnitYen] = useState<number | "">("");
  const [afterGenOverride, setAfterGenOverride] = useState<number | "">("");

  // 監視装置（SmartLogger 等）：なし / 通常 / Lite の3択＋単価
  const [loggerType, setLoggerType] = useState<"none" | "full" | "lite">("none");
  const [loggerUnitYen, setLoggerUnitYen] = useState<number | "">("");
  const loggerLabel = loggerType === "full" ? "監視装置 SmartLogger 3000A" : loggerType === "lite" ? "監視装置 SmartLogger 3000A Lite版" : "";
  const extraLines =
    loggerType !== "none"
      ? [{ label: loggerLabel, count: 1, unitYen: loggerUnitYen === "" ? 0 : loggerUnitYen }]
      : [];

  const pcs = pcsList.find((p) => p.id === pcsId) ?? null;
  const effPcsUnit = pcsUnitYen === "" ? pcs?.unitPriceYen ?? 0 : pcsUnitYen;

  /** 現況レイアウトの数字を編集欄に反映する。 */
  function applyFromLayout() {
    setLines(derived.newLines.map((l) => ({ id: uid("cl"), label: l.label, w: l.w, count: l.count, unitYen: l.unitYen })));
    setRemovedDisposal(derived.removedExisting);
    setRemovedStock(0);
    setNewPcsCount(derived.newPcs);
    setPcsMode(derived.newPcs > 0 ? "new" : "keep");
  }

  // ===== 集計 =====
  const newTotal = lines.reduce((s, l) => s + l.count, 0);
  const removedTotal = removedDisposal + removedStock;
  const result = useMemo(
    () =>
      estimateCost({
        newPanelLines: lines.map((l) => ({ label: l.label, count: l.count, unitYen: l.unitYen, w: l.w })),
        removedDisposal,
        removedStock,
        newPcsCount: pcsMode === "new" ? newPcsCount : 0,
        pcsUnitYen: effPcsUnit,
        removedPcsCount,
        extraLines,
        rates: costRates,
      }),
    [lines, removedDisposal, removedStock, pcsMode, newPcsCount, effPcsUnit, removedPcsCount, loggerType, loggerUnitYen, costRates]
  );

  // ===== 現況との相違チェック =====
  const newDiff = newTotal !== derived.newTotal;
  const removedDiff = removedTotal !== derived.removedExisting;

  const setRate = (k: keyof CostRates) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCostRates({ ...costRates, [k]: Number(e.target.value) });
  const updateLine = (id: string, patch: Partial<EditLine>) =>
    setLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLine = (id: string) => setLines(lines.filter((l) => l.id !== id));
  const addLine = () => setLines([...lines, { id: uid("cl"), label: panels[0] ? `${panels[0].maker} ${panels[0].model}` : "新パネル", w: panels[0]?.pmaxW ?? 0, count: 0, unitYen: panels[0]?.unitPriceYen ?? 0 }]);

  // ===== 費用対効果 =====
  const newKw = lines.reduce((s, l) => s + (l.count * l.w) / 1000, 0);
  const afterKw = newKw + derived.keptKw;
  const currentAnnualKwh = plant.annualGenerationKwh ?? 0;
  const estAfterKwh = estimateAfterGeneration(currentAnnualKwh, derived.beforeKw, afterKw);
  const afterAnnualKwh = afterGenOverride === "" ? estAfterKwh : afterGenOverride;
  const roi = useMemo(
    () =>
      estimateRoi({
        currentAnnualKwh,
        afterAnnualKwh,
        fitPriceYenPerKwh: plant.fitPriceYenPerKwh ?? 0,
        remainingYears: plant.fitRemainingYears ?? 0,
        upgradeCostYen: result.totalYen,
      }),
    [currentAnnualKwh, afterAnnualKwh, plant.fitPriceYenPerKwh, plant.fitRemainingYears, result.totalYen]
  );
  const remainingYears = plant.fitRemainingYears ?? 0;
  const setPlantNum = (k: "fitPriceYenPerKwh" | "fitRemainingYears" | "annualGenerationKwh") =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      updatePlant(plant.id, { [k]: e.target.value === "" ? null : Number(e.target.value) });

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>概算コスト — {plant.name}</h2>
          <span className="spacer" />
          <button className="btn no-print" onClick={applyFromLayout}>🔄 現況レイアウトから反映</button>
          <button className="btn secondary small no-print" onClick={() => window.print()}>印刷 / PDF</button>
        </div>
        <div className="hint">
          現況レイアウトの改修案：新設 <strong>{derived.newTotal}</strong> 枚／既設撤去 <strong>{derived.removedExisting}</strong> 枚／新設パワコン <strong>{derived.newPcs}</strong> 台。
          「反映」で下の数量に取り込みます。手で変えて数が合わないと ⚠ が出ます。
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>新設パネル（型式ごと）</h2>
          <span className="spacer" />
          <button className="btn secondary small" onClick={addLine}>＋ 型式を追加</button>
        </div>
        {newDiff && (
          <div className="warn-item" style={{ marginTop: 6, color: "var(--warn)", borderColor: "var(--warn)" }}>
            ⚠ 新設枚数の合計 {newTotal} 枚が、現況レイアウトの {derived.newTotal} 枚と相違しています。「反映」で合わせられます。
          </div>
        )}
        <table className="list" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>型式</th>
              <th className="num">W</th>
              <th className="num">枚数</th>
              <th className="num">単価(円/枚)</th>
              <th className="num">材料費</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <select
                    value={l.label}
                    onChange={(e) => {
                      const p = panels.find((x) => `${x.maker} ${x.model}` === e.target.value);
                      updateLine(l.id, { label: e.target.value, w: p?.pmaxW ?? l.w, unitYen: p?.unitPriceYen ?? l.unitYen });
                    }}
                  >
                    {panels.map((p) => (
                      <option key={p.id} value={`${p.maker} ${p.model}`}>{p.maker} {p.model}（{p.pmaxW}W）</option>
                    ))}
                  </select>
                </td>
                <td className="num">{l.w}</td>
                <td className="num">
                  <input type="number" min={0} style={{ width: 80 }} value={l.count} onChange={(e) => updateLine(l.id, { count: Number(e.target.value) || 0 })} />
                </td>
                <td className="num">
                  <input type="number" min={0} style={{ width: 100 }} value={l.unitYen} onChange={(e) => updateLine(l.id, { unitYen: Number(e.target.value) || 0 })} />
                </td>
                <td className="num">{yen(l.count * l.unitYen)}</td>
                <td className="num"><button className="btn danger small" onClick={() => removeLine(l.id)}>×</button></td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={6} className="empty">「＋ 型式を追加」または「反映」で新設パネルを入れてください。</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>既設パネルの撤去（処分／在庫）</h2>
        {removedDiff && (
          <div className="warn-item" style={{ marginBottom: 8, color: "var(--warn)", borderColor: "var(--warn)" }}>
            ⚠ 撤去合計 {removedTotal} 枚（処分{removedDisposal}＋在庫{removedStock}）が、現況の撤去 {derived.removedExisting} 枚と相違しています。
          </div>
        )}
        <div className="form-grid">
          <div className="field">
            <label>処分する枚数</label>
            <input type="number" min={0} value={removedDisposal} onChange={(e) => setRemovedDisposal(Number(e.target.value) || 0)} />
            <div className="hint">撤去工事費＋処分費がかかる</div>
          </div>
          <div className="field">
            <label>在庫に回す枚数</label>
            <input type="number" min={0} value={removedStock} onChange={(e) => setRemovedStock(Number(e.target.value) || 0)} />
            <div className="hint">撤去工事費のみ（処分費なし）</div>
          </div>
          <div className="field">
            <label>撤去合計</label>
            <div className="value" style={{ fontSize: 20 }}>{removedTotal}<small> 枚</small></div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>パワコン</h2>
        <div className="form-grid">
          <div className="field">
            <label>パワコン</label>
            <select value={pcsMode} onChange={(e) => setPcsMode(e.target.value as "keep" | "new")}>
              <option value="keep">既設流用（コストなし）</option>
              <option value="new">新設</option>
            </select>
          </div>
          {pcsMode === "new" && (
            <>
              <div className="field">
                <label>機種（単価参照）</label>
                <select value={pcsId} onChange={(e) => { setPcsId(e.target.value); setPcsUnitYen(""); }}>
                  {pcsList.map((p) => (<option key={p.id} value={p.id}>{p.maker} {p.model}（{p.ratedPowerKw}kW）</option>))}
                </select>
              </div>
              <div className="field">
                <label>新設台数</label>
                <input type="number" min={0} value={newPcsCount} onChange={(e) => setNewPcsCount(Number(e.target.value) || 0)} />
              </div>
              <div className="field">
                <label>パワコン単価 (円/台)</label>
                <input type="number" min={0} placeholder={pcs?.unitPriceYen ? `マスタ: ${pcs.unitPriceYen}` : "未設定"} value={pcsUnitYen} onChange={(e) => setPcsUnitYen(e.target.value === "" ? "" : Number(e.target.value))} />
              </div>
            </>
          )}
          <div className="field">
            <label>既設パワコン 撤去台数</label>
            <input type="number" min={0} value={removedPcsCount} onChange={(e) => setRemovedPcsCount(Number(e.target.value) || 0)} />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>監視装置（SmartLogger 等）</h2>
        <div className="form-grid">
          <div className="field">
            <label>使用する監視装置</label>
            <select value={loggerType} onChange={(e) => setLoggerType(e.target.value as "none" | "full" | "lite")}>
              <option value="none">なし（使用しない）</option>
              <option value="full">SmartLogger 3000A（通常版）</option>
              <option value="lite">SmartLogger 3000A Lite版</option>
            </select>
            <div className="hint">Huaweiパワコン等で遠隔監視を付ける場合に選択。コストに反映されます。</div>
          </div>
          {loggerType !== "none" && (
            <div className="field">
              <label>監視装置 単価 (円/式)</label>
              <input
                type="number"
                min={0}
                placeholder="単価を入力"
                value={loggerUnitYen}
                onChange={(e) => setLoggerUnitYen(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          )}
        </div>
      </div>

      <div className="card no-print">
        <h2>工事費・処分費・諸経費の単価設定</h2>
        <div className="form-grid">
          <div className="field"><label>パネル設置 (円/枚)</label><input type="number" value={costRates.panelInstallYen} onChange={setRate("panelInstallYen")} /></div>
          <div className="field"><label>パネル撤去工事 (円/枚)</label><input type="number" value={costRates.panelRemovalYen} onChange={setRate("panelRemovalYen")} /></div>
          <div className="field"><label>パネル処分費 (円/枚)</label><input type="number" value={costRates.panelDisposalYen} onChange={setRate("panelDisposalYen")} /></div>
          <div className="field"><label>パワコン設置 (円/台)</label><input type="number" value={costRates.pcsInstallYen} onChange={setRate("pcsInstallYen")} /></div>
          <div className="field"><label>パワコン撤去 (円/台)</label><input type="number" value={costRates.pcsRemovalYen} onChange={setRate("pcsRemovalYen")} /></div>
          <div className="field"><label>諸経費率 (%)</label><input type="number" value={costRates.miscRatePct} onChange={setRate("miscRatePct")} /></div>
        </div>
        <div className="hint">※ 工事費・処分費は目安の初期値です。実際の見積に合わせて調整してください。</div>
      </div>

      <div className="card">
        <h2>概算見積</h2>
        <table className="list">
          <thead><tr><th>項目</th><th className="num">数量</th><th className="num">単価</th><th className="num">金額</th></tr></thead>
          <tbody>
            {result.lines.map((l, i) => (
              <tr key={i}><td>{l.label}</td><td className="num">{l.qty.toLocaleString()} {l.unit}</td><td className="num">{yen(l.unitYen)}</td><td className="num">{yen(l.amountYen)}</td></tr>
            ))}
            {removedStock > 0 && (
              <tr><td>（在庫へ）</td><td className="num">{removedStock} 枚</td><td className="num">—</td><td className="num">¥0</td></tr>
            )}
            {result.lines.length === 0 && <tr><td colSpan={4} className="empty">数量・単価を入力してください。</td></tr>}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} className="num">小計</td><td className="num">{yen(result.subtotalYen)}</td></tr>
            <tr><td colSpan={3} className="num">諸経費（{costRates.miscRatePct}%）</td><td className="num">{yen(result.miscYen)}</td></tr>
            <tr><td colSpan={3} className="num"><strong>合計</strong></td><td className="num"><strong>{yen(result.totalYen)}</strong></td></tr>
          </tfoot>
        </table>
        {result.yenPerW != null && (
          <div className="hint" style={{ marginTop: 8 }}>新設容量あたり単価：{result.yenPerW.toFixed(1)} 円/W（新設 {newKw.toFixed(1)} kW）</div>
        )}
      </div>

      <div className="card">
        <h2>費用対効果（FIT）</h2>
        <div className="form-grid">
          <div className="field"><label>FIT単価 (円/kWh)</label><input type="number" step="0.1" value={plant.fitPriceYenPerKwh ?? ""} onChange={setPlantNum("fitPriceYenPerKwh")} /></div>
          <div className="field"><label>FIT残存年数 (年)</label><input type="number" step="0.5" value={plant.fitRemainingYears ?? ""} onChange={setPlantNum("fitRemainingYears")} /></div>
          <div className="field"><label>現在の年間発電量 (kWh/年)</label><input type="number" value={plant.annualGenerationKwh ?? ""} onChange={setPlantNum("annualGenerationKwh")} /></div>
          <div className="field">
            <label>変更後の年間発電量 (kWh/年)</label>
            <input type="number" placeholder={`自動推定: ${Math.round(estAfterKwh).toLocaleString()}`} value={afterGenOverride} onChange={(e) => setAfterGenOverride(e.target.value === "" ? "" : Number(e.target.value))} />
            <div className="hint">
              {derived.beforeKw > 0
                ? `空欄なら容量比（${derived.beforeKw.toFixed(1)}→${afterKw.toFixed(1)}kW）で自動推定`
                : `純新設は現況比が取れないため、空欄時は ${afterKw.toFixed(1)}kW × 約1,200kWh/kW で概算。実際の想定発電量があれば入力してください。`}
            </div>
          </div>
        </div>
        <div className="result-grid" style={{ marginTop: 12 }}>
          <div className="metric"><div className="label">年間発電量の増分</div><div className="value">{roi.deltaAnnualKwh >= 0 ? "+" : ""}{Math.round(roi.deltaAnnualKwh).toLocaleString()}<small> kWh/年</small></div></div>
          <div className="metric"><div className="label">年間 増収</div><div className="value">{yen(roi.annualRevenueIncreaseYen)}<small>/年</small></div></div>
          <div className="metric"><div className="label">残存{remainingYears || "—"}年の累計増収</div><div className="value">{yen(roi.totalRevenueIncreaseYen)}</div></div>
          <div className="metric"><div className="label">改修費用</div><div className="value">{yen(result.totalYen)}</div></div>
          <div className="metric"><div className="label">正味便益（増収−費用）</div><div className="value" style={{ color: roi.netBenefitYen >= 0 ? "var(--accent-2)" : "var(--danger)" }}>{yen(roi.netBenefitYen)}</div></div>
          <div className="metric">
            <div className="label">投資回収年数</div>
            <div className="value">{roi.paybackYears != null ? roi.paybackYears.toFixed(1) : "—"}<small> 年</small></div>
            {roi.paybackYears != null && remainingYears > 0 && (
              <div className="hint" style={{ color: roi.paybackYears <= remainingYears ? "var(--accent-2)" : "var(--danger)" }}>{roi.paybackYears <= remainingYears ? "残存年数内に回収" : "残存年数内に回収できない"}</div>
            )}
          </div>
          <div className="metric"><div className="label">ROI</div><div className="value" style={{ color: (roi.roiPct ?? 0) >= 0 ? "var(--accent-2)" : "var(--danger)" }}>{roi.roiPct != null ? `${roi.roiPct >= 0 ? "+" : ""}${roi.roiPct.toFixed(0)}` : "—"}<small> %</small></div></div>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>※ 増収＝(変更後−現在)発電量 × FIT単価 × 残存年数。FIT契約・容量変更に伴う単価/区分の変更や経年劣化は別途確認してください。</div>
      </div>
    </>
  );
}
