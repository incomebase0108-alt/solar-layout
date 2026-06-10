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
import { countShadedPanels, pixelsPerMeterOf } from "../calc/shadow";

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
      totalPanels,
      w.shadedPcsCount,
      w.shadeFactor
    );
  }, [panel, pcs, w.seriesPerString, w.parallelPerMppt, totalPanels, w.shadedPcsCount, w.shadeFactor]);

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

        <h3>影ゾーン（過積載率の調整）</h3>
        {(() => {
          const zones = plant.layout.shadowZones ?? [];
          if (!zones.length) return null;
          const shadedPanels = countShadedPanels(
            plant.layout.arrays,
            panels,
            pixelsPerMeterOf(plant.layout.calibration),
            zones
          );
          const panelsPerPcs =
            w.seriesPerString * w.parallelPerMppt * (pcs?.mpptCount ?? 0);
          const estShadedPcs = panelsPerPcs > 0 ? Math.round(shadedPanels / panelsPerPcs) : 0;
          return (
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="hint">
                図面の影ゾーンにかかるパネル <strong>{shadedPanels}</strong> 枚
                {panelsPerPcs > 0 && <> ≒ <strong>{estShadedPcs}</strong> 台分</>}
              </span>
              {panelsPerPcs > 0 && (
                <button
                  className="btn secondary small"
                  onClick={() => patchWiring({ shadedPcsCount: estShadedPcs })}
                >
                  図面の影を反映
                </button>
              )}
            </div>
          );
        })()}
        <div className="form-grid">
          <div className="field">
            <label>影ゾーンのパワコン台数</label>
            <input
              type="number"
              min={0}
              value={w.shadedPcsCount}
              onChange={(e) => patchWiring({ shadedPcsCount: Math.max(0, Number(e.target.value)) })}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>影ゾーンの目標負荷率: {(w.shadeFactor * 100) | 0}%</label>
            <input
              type="range"
              min={0.3}
              max={1}
              step={0.05}
              value={w.shadeFactor}
              onChange={(e) => patchWiring({ shadeFactor: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="hint">
          影になる場所のパワコンを指定すると、その台のストリングを減らして過積載率を下げます（余りは他の台が負担）。0台＝全台を均等配分。
        </div>

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
              <div className="metric">
                <div className="label">過積載率（平均）</div>
                <div className="value">
                  {wiring.avgOverloadPct.toFixed(0)}
                  <small> %</small>
                </div>
                <div className="hint">
                  範囲 {wiring.minOverloadPct.toFixed(0)}–{wiring.maxOverloadPct.toFixed(0)}%／目安110–130%
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
            <h2>パワコン別 過積載率</h2>
            <table className="list">
              <thead>
                <tr>
                  <th>パワコン</th>
                  <th>区分</th>
                  <th className="num">系統数</th>
                  <th className="num">枚数</th>
                  <th className="num">DC容量</th>
                  <th className="num">過積載率</th>
                </tr>
              </thead>
              <tbody>
                {wiring.perPcs.map((u) => (
                  <tr key={u.pcsIndex}>
                    <td><strong>{pcs.model} #{u.pcsIndex}</strong></td>
                    <td>
                      {u.isShaded
                        ? <span className="badge existing">影ゾーン</span>
                        : <span className="badge new">通常</span>}
                    </td>
                    <td className="num">{u.totalStrings}</td>
                    <td className="num">{u.totalPanels}</td>
                    <td className="num">{u.dcKw.toFixed(2)} kW</td>
                    <td className="num" style={{ color: u.overloadPct > 130 ? "var(--warn)" : undefined }}>
                      {u.overloadPct.toFixed(0)} %
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ marginTop: 8 }}>
              平均 {wiring.avgOverloadPct.toFixed(0)}%。影ゾーン台は負荷を下げて過積載率を抑えています。
            </div>
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
