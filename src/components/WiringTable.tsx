import { useMemo } from "react";
import type {
  PanelSpec,
  PcsSpec,
  PowerPlant,
  WiringPlan,
  DesignConditions,
} from "../types";
import { calcStringSizing } from "../calc/stringSizing";
import { generateWiring } from "../calc/wiring";

interface Props {
  plant: PowerPlant;
  panels: PanelSpec[];
  pcsList: PcsSpec[];
  conditions: DesignConditions;
  patchWiring: (p: Partial<WiringPlan>) => void;
}

export function WiringTable({ plant, panels, pcsList, conditions, patchWiring }: Props) {
  const w = plant.wiring;
  const panel = panels.find((p) => p.id === w.panelId) ?? null;
  const pcs = pcsList.find((p) => p.id === w.pcsId) ?? null;

  const layoutPanels = plant.layout.arrays.reduce(
    (s, a) => s + a.rows * a.cols,
    0
  );
  const totalPanels = w.totalPanelsOverride ?? layoutPanels;

  const sizing = useMemo(
    () => (panel && pcs ? calcStringSizing(panel, pcs, conditions) : null),
    [panel, pcs, conditions]
  );

  const wiring = useMemo(() => {
    if (!panel || !pcs) return null;
    return generateWiring(
      panel,
      pcs,
      w.seriesPerString,
      w.parallelPerMppt,
      totalPanels
    );
  }, [panel, pcs, w.seriesPerString, w.parallelPerMppt, totalPanels]);

  function applyRecommended() {
    if (!sizing) return;
    patchWiring({
      seriesPerString: sizing.seriesRange.max,
      parallelPerMppt: sizing.parallelMaxPerMppt,
    });
  }

  if (panels.length === 0 || pcsList.length === 0) {
    return (
      <div className="card">
        <h2>パワコン配線表</h2>
        <div className="empty">先にパネルとパワコンを登録してください。</div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>配線設定 — {plant.name}</h2>
          <span className="spacer" />
          <button className="btn secondary small no-print" onClick={() => window.print()}>
            印刷 / PDF
          </button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>系統共通パネル</label>
            <select
              value={w.panelId ?? ""}
              onChange={(e) => patchWiring({ panelId: e.target.value || null })}
            >
              <option value="">選択してください</option>
              {panels.map((p) => (
                <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>パワコン（既設/新設）</label>
            <select
              value={w.pcsId ?? ""}
              onChange={(e) => patchWiring({ pcsId: e.target.value || null })}
            >
              <option value="">選択してください</option>
              {pcsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.maker} {p.model}（{p.kind === "existing" ? "既設" : "新設"} / {p.ratedPowerKw}kW）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>直列数 / string</label>
            <input
              type="number"
              min={1}
              value={w.seriesPerString || ""}
              onChange={(e) => patchWiring({ seriesPerString: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>並列数 / MPPT</label>
            <input
              type="number"
              min={1}
              value={w.parallelPerMppt || ""}
              onChange={(e) => patchWiring({ parallelPerMppt: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>総パネル枚数</label>
            <input
              type="number"
              min={1}
              value={w.totalPanelsOverride ?? ""}
              placeholder={`図面: ${layoutPanels}`}
              onChange={(e) =>
                patchWiring({
                  totalPanelsOverride: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <div className="hint">空欄なら図面の {layoutPanels} 枚を使用</div>
          </div>
          <div className="field" style={{ justifyContent: "flex-end" }}>
            <button className="btn secondary" onClick={applyRecommended} disabled={!sizing}>
              推奨値を反映
            </button>
          </div>
        </div>

        <label className="row" style={{ marginTop: 10, cursor: "pointer", gap: 8 }}>
          <input
            type="checkbox"
            checked={w.allowMixedPanelSeries}
            onChange={(e) => patchWiring({ allowMixedPanelSeries: e.target.checked })}
          />
          <span>
            直列に異なるパネルの混在を許可する
            <span className="hint" style={{ marginLeft: 6 }}>
              （通常はOFF＝同一系統＝同一パネル。流用パネルと新パネルをどうしても同じ直列に組む場合のみON）
            </span>
          </span>
        </label>
        {w.allowMixedPanelSeries && (
          <div className="warn-item" style={{ marginTop: 6 }}>
            ⚠ 混在許可中：異種パネルを直列にすると電流の小さい側に律速されます。Imp/Vmpが近い組合せに限定してください。
          </div>
        )}

        {sizing && (
          <div className="hint" style={{ marginTop: 8 }}>
            推奨：直列 {sizing.seriesRange.min}–{sizing.seriesRange.max} 枚 ／ 並列 最大 {sizing.parallelMaxPerMppt} 本/MPPT
            （低温Voc {sizing.detail.vocLowTemp.toFixed(1)}V・高温Vmp {sizing.detail.vmpHighTemp.toFixed(1)}V）
          </div>
        )}
        {sizing?.warnings.map((wr, i) => (
          <div className="warn-item" key={i} style={{ marginTop: 6 }}>⚠ {wr}</div>
        ))}
      </div>

      {wiring && pcs && panel && (() => {
        const dcKw = (wiring.usedPanels * panel.pmaxW) / 1000;
        const overCap = !!plant.outputCapKw && dcKw > plant.outputCapKw + 1e-6;
        return (
        <>
          <div className="card">
            <h2>集計</h2>
            <div className="result-grid">
              <div className="metric">
                <div className="label">必要パワコン台数</div>
                <div className="value">{wiring.pcsCount}<small> 台</small></div>
                <div className="hint">{pcs.model}</div>
              </div>
              <div className="metric">
                <div className="label">ストリング総数</div>
                <div className="value">{wiring.totalStrings}<small> 系統</small></div>
              </div>
              <div className="metric">
                <div className="label">接続枚数 / 半端</div>
                <div className="value">
                  {wiring.usedPanels}
                  <small> 枚{wiring.leftoverPanels ? ` / 余${wiring.leftoverPanels}` : ""}</small>
                </div>
              </div>
              <div className="metric">
                <div className="label">DC 容量</div>
                <div className="value" style={{ color: overCap ? "var(--danger)" : undefined }}>
                  {dcKw.toFixed(1)}
                  <small> kW{plant.outputCapKw ? ` / 上限 ${plant.outputCapKw}` : ""}</small>
                </div>
              </div>
            </div>
            {overCap && (
              <div className="warn-item" style={{ marginTop: 6 }}>
                ⚠ DC容量 {dcKw.toFixed(1)}kW が出力上限 {plant.outputCapKw}kW を超過しています。買取単価区分に注意。
              </div>
            )}
            {wiring.warnings.map((wr, i) => (
              <div className="warn-item" key={i} style={{ marginTop: 6 }}>⚠ {wr}</div>
            ))}
          </div>

          <div className="card">
            <h2>パワコン配線表</h2>
            <table className="list">
              <thead>
                <tr>
                  <th>パワコン</th>
                  <th>MPPT</th>
                  <th className="num">並列(系統)</th>
                  <th className="num">直列</th>
                  <th className="num">枚数</th>
                  <th>パネル</th>
                </tr>
              </thead>
              <tbody>
                {wiring.perPcs.flatMap((u) =>
                  u.mppts.map((m) => (
                    <tr key={`${u.pcsIndex}-${m.mpptIndex}`}>
                      <td>
                        {m.mpptIndex === 1 ? (
                          <strong>{pcs.model} #{u.pcsIndex}</strong>
                        ) : (
                          <span className="hint">　〃</span>
                        )}
                      </td>
                      <td>MPPT{m.mpptIndex}</td>
                      <td className="num">{m.strings}</td>
                      <td className="num">{wiring.series}</td>
                      <td className="num">{m.panels}</td>
                      <td>{panel.model}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="num"><strong>合計</strong></td>
                  <td className="num"><strong>{wiring.usedPanels} 枚</strong></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
            <div className="hint" style={{ marginTop: 8 }}>
              同一系統＝同一パネル（{panel.model}）／ 各 MPPT に {w.parallelPerMppt} 並列・{wiring.series} 直列で割付。
            </div>
          </div>
        </>
        );
      })()}
    </>
  );
}
