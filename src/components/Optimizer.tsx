import { useMemo, useState } from "react";
import type { PanelSpec, PowerPlant } from "../types";
import { optimizeReplacement, pickCandidates } from "../calc/optimize";

interface Props {
  plant: PowerPlant;
  panels: PanelSpec[];
}

export function Optimizer({ plant, panels }: Props) {
  const [tolerancePct, setTolerancePct] = useState(5);
  const [basePanelId, setBasePanelId] = useState<string>(
    plant.layout.arrays[0]?.panelId ?? panels[0]?.id ?? ""
  );
  const [onlySimilar, setOnlySimilar] = useState(true);

  const basePanel = panels.find((p) => p.id === basePanelId) ?? null;

  const result = useMemo(() => {
    const candidates = onlySimilar
      ? pickCandidates(basePanel, panels, tolerancePct)
      : panels;
    return optimizeReplacement(
      plant.layout.arrays,
      panels,
      candidates,
      tolerancePct,
      5,
      plant.outputCapKw ?? null
    );
  }, [plant.layout.arrays, panels, basePanel, tolerancePct, onlySimilar, plant.outputCapKw]);

  const cap = plant.outputCapKw ?? null;
  const hasCap = cap != null && cap > 0;

  if (plant.layout.arrays.length === 0) {
    return (
      <div className="card">
        <h2>入換レイアウト最適化</h2>
        <div className="empty">
          先に「現況レイアウト」で配列を配置してください。流用パネルの指定も反映されます。
        </div>
      </div>
    );
  }

  const { current, proposals } = result;

  return (
    <>
      <div className="card">
        <h2>入換レイアウト最適化 — {plant.name}</h2>
        <div className="form-grid">
          <div className="field">
            <label>基準パネル（既設）</label>
            <select value={basePanelId} onChange={(e) => setBasePanelId(e.target.value)}>
              {panels.map((p) => (
                <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>許容拡大率: +{tolerancePct}%</label>
            <input
              type="range"
              min={0}
              max={15}
              value={tolerancePct}
              onChange={(e) => setTolerancePct(Number(e.target.value))}
            />
            <div className="hint">「少し大きいまでOK」の範囲（スロットに対する寸法余裕）</div>
          </div>
          <div className="field" style={{ justifyContent: "flex-end" }}>
            <label className="row" style={{ gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={onlySimilar}
                onChange={(e) => setOnlySimilar(e.target.checked)}
              />
              <span>同サイズ近傍に絞る</span>
            </label>
          </div>
        </div>

        <div className="result-grid" style={{ marginTop: 8 }}>
          <div className="metric">
            <div className="label">現状 総枚数</div>
            <div className="value">{current.totalCells}<small> 枚</small></div>
            <div className="hint">流用 {current.keepCells} / 入換 {current.replaceCells}</div>
          </div>
          <div className="metric">
            <div className="label">現状 総出力</div>
            <div className="value">{current.currentKw.toFixed(1)}<small> kW</small></div>
          </div>
          <div className="metric">
            <div className="label">パネル出力上限</div>
            <div className="value">
              {hasCap ? cap!.toFixed(1) : "—"}<small> kW</small>
            </div>
            <div className="hint">
              {hasCap ? "この値を超えると警告" : "発電所タブで設定可"}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>最適化案（{proposals.length}）</h2>
        {proposals.length === 0 ? (
          <div className="empty">
            条件に合う候補パネルがありません。許容拡大率を上げるか、「同サイズ近傍に絞る」を外してください。
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>案 / パネル</th>
                <th>向き</th>
                <th className="num">入換枚数</th>
                <th className="num">流用</th>
                <th className="num">総出力</th>
                <th className="num">現状比</th>
                <th>適合</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="badge new">{p.label}</span>
                    <div style={{ marginTop: 4 }}>
                      <strong>{p.panel.maker} {p.panel.model}</strong>
                      <span className="hint"> {p.panel.pmaxW}W</span>
                    </div>
                    {p.notes.map((n, k) => (
                      <div className="hint" key={k}>※ {n}</div>
                    ))}
                  </td>
                  <td>{p.orientation === "portrait" ? "縦" : "横"}</td>
                  <td className="num">{p.newPanels}</td>
                  <td className="num">{p.keptPanels}</td>
                  <td className="num" style={{ color: p.overCap ? "var(--danger)" : undefined }}>
                    {p.totalKw.toFixed(1)} kW
                    {p.overCap && <div className="hint" style={{ color: "var(--danger)" }}>上限超過</div>}
                    {hasCap && !p.overCap && p.capHeadroomKw != null && (
                      <div className="hint">余裕 {p.capHeadroomKw.toFixed(1)}</div>
                    )}
                  </td>
                  <td className="num" style={{ color: p.deltaKw >= 0 ? "var(--accent-2)" : "var(--danger)" }}>
                    {p.deltaKw >= 0 ? "+" : ""}{p.deltaKw.toFixed(1)} kW
                  </td>
                  <td>
                    {p.feasible ? (
                      <span className="badge new">全配列OK</span>
                    ) : (
                      <span className="badge existing">一部不可({p.infeasibleArrays})</span>
                    )}
                    <div className="hint">余裕 {p.minMarginPct.toFixed(1)}%</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="hint" style={{ marginTop: 8 }}>
          ※ 既設スロットに 1:1 で収まる前提（同サイズ〜許容拡大率まで）。緑で「流用」指定したパネルは据置で計上。
          採用案のパネルを「パワコン配線表」で系統共通パネルに選べば配線まで連動します。
        </div>
      </div>
    </>
  );
}
