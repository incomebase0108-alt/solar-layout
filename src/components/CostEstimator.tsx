import { useMemo, useState } from "react";
import type { PanelSpec, PcsSpec, PowerPlant, CostRates } from "../types";
import { estimateCost } from "../calc/cost";

interface Props {
  plant: PowerPlant;
  panels: PanelSpec[];
  pcsList: PcsSpec[];
  costRates: CostRates;
  setCostRates: (r: CostRates) => void;
}

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

export function CostEstimator({ plant, panels, pcsList, costRates, setCostRates }: Props) {
  // 図面の入換対象枚数（流用を除く）
  const replaceCount = plant.layout.arrays.reduce(
    (s, a) => s + a.rows * a.cols - (a.keepCells?.length ?? 0),
    0
  );

  const [panelId, setPanelId] = useState(
    plant.wiring.panelId ?? panels[0]?.id ?? ""
  );
  const [newPanels, setNewPanels] = useState(replaceCount);
  const [removedPanels, setRemovedPanels] = useState(replaceCount);
  const [panelUnitYen, setPanelUnitYen] = useState<number | "">("");

  const [pcsMode, setPcsMode] = useState<"keep" | "new">("keep");
  const [pcsId, setPcsId] = useState(plant.wiring.pcsId ?? pcsList[0]?.id ?? "");
  const [newPcsCount, setNewPcsCount] = useState(0);
  const [removedPcsCount, setRemovedPcsCount] = useState(0);
  const [pcsUnitYen, setPcsUnitYen] = useState<number | "">("");

  const panel = panels.find((p) => p.id === panelId) ?? null;
  const pcs = pcsList.find((p) => p.id === pcsId) ?? null;

  // マスタ単価を既定値に（未入力時）
  const effPanelUnit = panelUnitYen === "" ? panel?.unitPriceYen ?? 0 : panelUnitYen;
  const effPcsUnit = pcsUnitYen === "" ? pcs?.unitPriceYen ?? 0 : pcsUnitYen;

  const result = useMemo(
    () =>
      estimateCost({
        newPanels,
        panelUnitYen: effPanelUnit,
        removedPanels,
        newPcsCount: pcsMode === "new" ? newPcsCount : 0,
        pcsUnitYen: effPcsUnit,
        removedPcsCount,
        newPanelW: newPanels * (panel?.pmaxW ?? 0),
        rates: costRates,
      }),
    [newPanels, effPanelUnit, removedPanels, pcsMode, newPcsCount, effPcsUnit, removedPcsCount, panel, costRates]
  );

  const setRate = (k: keyof CostRates) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCostRates({ ...costRates, [k]: Number(e.target.value) });

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>概算コスト — {plant.name}</h2>
          <span className="spacer" />
          <button className="btn secondary small no-print" onClick={() => window.print()}>
            印刷 / PDF
          </button>
        </div>
        <div className="hint">図面の入換対象は {replaceCount} 枚（流用を除く）。下の数量は必要に応じて調整できます。</div>
      </div>

      <div className="card">
        <h2>数量・単価</h2>
        <h3>パネル</h3>
        <div className="form-grid">
          <div className="field">
            <label>新パネル</label>
            <select value={panelId} onChange={(e) => { setPanelId(e.target.value); setPanelUnitYen(""); }}>
              {panels.map((p) => (
                <option key={p.id} value={p.id}>{p.maker} {p.model}（{p.pmaxW}W）</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>新設枚数</label>
            <input type="number" min={0} value={newPanels} onChange={(e) => setNewPanels(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>撤去枚数</label>
            <input type="number" min={0} value={removedPanels} onChange={(e) => setRemovedPanels(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>パネル単価 (円/枚)</label>
            <input
              type="number"
              min={0}
              placeholder={panel?.unitPriceYen ? `マスタ: ${panel.unitPriceYen}` : "未設定"}
              value={panelUnitYen}
              onChange={(e) => setPanelUnitYen(e.target.value === "" ? "" : Number(e.target.value))}
            />
          </div>
        </div>

        <h3>パワコン</h3>
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
                <label>機種</label>
                <select value={pcsId} onChange={(e) => { setPcsId(e.target.value); setPcsUnitYen(""); }}>
                  {pcsList.map((p) => (
                    <option key={p.id} value={p.id}>{p.maker} {p.model}（{p.ratedPowerKw}kW）</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>新設台数</label>
                <input type="number" min={0} value={newPcsCount} onChange={(e) => setNewPcsCount(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>パワコン単価 (円/台)</label>
                <input
                  type="number"
                  min={0}
                  placeholder={pcs?.unitPriceYen ? `マスタ: ${pcs.unitPriceYen}` : "未設定"}
                  value={pcsUnitYen}
                  onChange={(e) => setPcsUnitYen(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </div>
            </>
          )}
          <div className="field">
            <label>既設パワコン 撤去台数</label>
            <input type="number" min={0} value={removedPcsCount} onChange={(e) => setRemovedPcsCount(Number(e.target.value))} />
          </div>
        </div>
      </div>

      <div className="card no-print">
        <h2>工事費・諸経費の単価設定</h2>
        <div className="form-grid">
          <div className="field">
            <label>パネル設置 (円/枚)</label>
            <input type="number" value={costRates.panelInstallYen} onChange={setRate("panelInstallYen")} />
          </div>
          <div className="field">
            <label>パネル撤去 (円/枚)</label>
            <input type="number" value={costRates.panelRemovalYen} onChange={setRate("panelRemovalYen")} />
          </div>
          <div className="field">
            <label>パワコン設置 (円/台)</label>
            <input type="number" value={costRates.pcsInstallYen} onChange={setRate("pcsInstallYen")} />
          </div>
          <div className="field">
            <label>パワコン撤去 (円/台)</label>
            <input type="number" value={costRates.pcsRemovalYen} onChange={setRate("pcsRemovalYen")} />
          </div>
          <div className="field">
            <label>諸経費率 (%)</label>
            <input type="number" value={costRates.miscRatePct} onChange={setRate("miscRatePct")} />
          </div>
        </div>
        <div className="hint">※ 工事費は目安の初期値です。実際の見積に合わせて調整してください。</div>
      </div>

      <div className="card">
        <h2>概算見積</h2>
        <table className="list">
          <thead>
            <tr>
              <th>項目</th>
              <th className="num">数量</th>
              <th className="num">単価</th>
              <th className="num">金額</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.label}</td>
                <td className="num">{l.qty.toLocaleString()} {l.unit}</td>
                <td className="num">{yen(l.unitYen)}</td>
                <td className="num">{yen(l.amountYen)}</td>
              </tr>
            ))}
            {result.lines.length === 0 && (
              <tr><td colSpan={4} className="empty">数量・単価を入力してください。</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="num">小計</td>
              <td className="num">{yen(result.subtotalYen)}</td>
            </tr>
            <tr>
              <td colSpan={3} className="num">諸経費（{costRates.miscRatePct}%）</td>
              <td className="num">{yen(result.miscYen)}</td>
            </tr>
            <tr>
              <td colSpan={3} className="num"><strong>合計</strong></td>
              <td className="num"><strong>{yen(result.totalYen)}</strong></td>
            </tr>
          </tfoot>
        </table>
        {result.yenPerW != null && (
          <div className="hint" style={{ marginTop: 8 }}>
            新設容量あたり単価：{result.yenPerW.toFixed(1)} 円/W
            （新設 {((newPanels * (panel?.pmaxW ?? 0)) / 1000).toFixed(1)} kW）
          </div>
        )}
      </div>
    </>
  );
}
