import { useMemo, useState } from "react";
import type { PanelSpec, PcsSpec, PowerPlant, DesignConditions } from "../types";
import { calcStringSizing } from "../calc/stringSizing";
import { checkExistingPcs } from "../calc/existingPcs";

interface Props {
  plant: PowerPlant;
  panels: PanelSpec[];
  pcsList: PcsSpec[];
  conditions: DesignConditions;
}

export function ExistingPcsCheck({ plant, panels, pcsList, conditions }: Props) {
  const layoutPanels = plant.layout.arrays.reduce((s, a) => s + a.rows * a.cols, 0);

  const [panelId, setPanelId] = useState(plant.wiring.panelId ?? panels[0]?.id ?? "");
  const [pcsId, setPcsId] = useState(
    pcsList.find((p) => p.kind === "existing")?.id ?? pcsList[0]?.id ?? ""
  );
  const [pcsCount, setPcsCount] = useState(1);
  const [series, setSeries] = useState<number | "">("");
  const [parallel, setParallel] = useState<number | "">("");
  const [totalPanels, setTotalPanels] = useState<number | "">("");
  const [overloadCap, setOverloadCap] = useState(130);

  const panel = panels.find((p) => p.id === panelId) ?? null;
  const pcs = pcsList.find((p) => p.id === pcsId) ?? null;

  const sizing = useMemo(
    () => (panel && pcs ? calcStringSizing(panel, pcs, conditions) : null),
    [panel, pcs, conditions]
  );

  const effSeries = series === "" ? sizing?.seriesRange.max ?? 0 : series;
  const effParallel = parallel === "" ? sizing?.parallelMaxPerMppt ?? 0 : parallel;
  const effTotal = totalPanels === "" ? layoutPanels : totalPanels;

  const result = useMemo(() => {
    if (!panel || !pcs) return null;
    return checkExistingPcs(
      panel, pcs, pcsCount, effSeries, effParallel, effTotal, conditions, overloadCap
    );
  }, [panel, pcs, pcsCount, effSeries, effParallel, effTotal, conditions, overloadCap]);

  if (panels.length === 0 || pcsList.length === 0) {
    return (
      <div className="card">
        <h2>既設パワコン空き容量チェック</h2>
        <div className="empty">先にパネルとパワコンを登録してください。</div>
      </div>
    );
  }

  const verdictBadge =
    result?.verdict === "ok" ? "new" : result?.verdict === "rework" ? "existing" : "existing";

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>既設パワコン空き容量チェック — {plant.name}</h2>
          <span className="spacer" />
          <button className="btn secondary small no-print" onClick={() => window.print()}>印刷 / PDF</button>
        </div>
        <div className="hint">既設パワコンに、計画したパネル・直列/並列が収まるかを判定します。</div>

        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="field">
            <label>既設パワコン</label>
            <select value={pcsId} onChange={(e) => setPcsId(e.target.value)}>
              {pcsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.maker} {p.model}（{p.kind === "existing" ? "既設" : "新設"} / {p.ratedPowerKw}kW）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>既設台数</label>
            <input type="number" min={1} value={pcsCount} onChange={(e) => setPcsCount(Math.max(1, Number(e.target.value)))} />
          </div>
          <div className="field">
            <label>パネル</label>
            <select value={panelId} onChange={(e) => setPanelId(e.target.value)}>
              {panels.map((p) => (
                <option key={p.id} value={p.id}>{p.maker} {p.model}（{p.pmaxW}W）</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>直列数 {sizing && `(推奨${sizing.seriesRange.min}–${sizing.seriesRange.max})`}</label>
            <input type="number" min={1} placeholder={`${sizing?.seriesRange.max ?? ""}`} value={series} onChange={(e) => setSeries(e.target.value === "" ? "" : Number(e.target.value))} />
          </div>
          <div className="field">
            <label>並列数/MPPT {sizing && `(最大${sizing.parallelMaxPerMppt})`}</label>
            <input type="number" min={1} placeholder={`${sizing?.parallelMaxPerMppt ?? ""}`} value={parallel} onChange={(e) => setParallel(e.target.value === "" ? "" : Number(e.target.value))} />
          </div>
          <div className="field">
            <label>総パネル枚数</label>
            <input type="number" min={1} placeholder={`図面: ${layoutPanels}`} value={totalPanels} onChange={(e) => setTotalPanels(e.target.value === "" ? "" : Number(e.target.value))} />
          </div>
          <div className="field">
            <label>目標過積載率上限 (%)</label>
            <input type="number" value={overloadCap} onChange={(e) => setOverloadCap(Number(e.target.value))} />
          </div>
        </div>
      </div>

      {result && (
        <>
          <div className="card">
            <h2>判定</h2>
            <div className="row" style={{ alignItems: "center", gap: 12 }}>
              <span
                className={`badge ${verdictBadge}`}
                style={{ fontSize: 16, padding: "6px 16px" }}
              >
                {result.verdict === "ok" ? "✓ " : result.verdict === "rework" ? "△ " : "✕ "}
                {result.verdictLabel}
              </span>
              <span className="hint">
                必要 {result.neededStrings} 系統／既設 {result.totalSlots} 系統
                （{result.freeSlots >= 0 ? `空き ${result.freeSlots}` : `不足 ${-result.freeSlots}`}）
                ・過積載 {result.overloadPct.toFixed(0)}%
              </span>
            </div>
          </div>

          <div className="card">
            <h2>チェック項目</h2>
            <table className="list">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>判定</th>
                  <th>項目</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {result.checks.map((c, i) => (
                  <tr key={i}>
                    <td style={{ color: c.ok ? "var(--accent-2)" : "var(--danger)", fontWeight: 700 }}>
                      {c.ok ? "✓ OK" : "✕ NG"}
                    </td>
                    <td>{c.label}</td>
                    <td className="hint" style={{ color: "var(--text)" }}>{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ marginTop: 8 }}>
              {result.verdict === "rework" &&
                "NG項目を設定調整（直列/並列/枚数を見直し）すれば既設で流用可能です。"}
              {result.verdict === "infeasible" &&
                "既設パワコンには収まりません。台数増設または新設パワコンを検討してください。"}
              {result.verdict === "ok" &&
                "そのまま既設パワコンに収まります。"}
            </div>
          </div>
        </>
      )}
    </>
  );
}
