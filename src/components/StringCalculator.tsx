import { useMemo, useState } from "react";
import type { PanelSpec, PcsSpec, DesignConditions } from "../types";
import { calcStringSizing, calcArrayCapacity } from "../calc/stringSizing";

interface Props {
  panels: PanelSpec[];
  pcsList: PcsSpec[];
  conditions: DesignConditions;
  setConditions: (c: DesignConditions) => void;
}

export function StringCalculator({
  panels,
  pcsList,
  conditions,
  setConditions,
}: Props) {
  const [panelId, setPanelId] = useState(panels[0]?.id ?? "");
  const [pcsId, setPcsId] = useState(pcsList[0]?.id ?? "");

  const panel = panels.find((p) => p.id === panelId);
  const pcs = pcsList.find((p) => p.id === pcsId);

  const sizing = useMemo(
    () => (panel && pcs ? calcStringSizing(panel, pcs, conditions) : null),
    [panel, pcs, conditions]
  );

  // 採用直列数（既定は推奨範囲の上限寄り）
  const [series, setSeries] = useState<number | null>(null);
  const effectiveSeries =
    series ?? (sizing ? sizing.seriesRange.max : 0);
  const [parallel, setParallel] = useState<number | null>(null);
  const effectiveParallel =
    parallel ?? (sizing ? sizing.parallelMaxPerMppt : 0);

  const capacity =
    panel && pcs && effectiveSeries > 0
      ? calcArrayCapacity(panel, pcs, effectiveSeries, effectiveParallel)
      : null;

  if (panels.length === 0 || pcsList.length === 0) {
    return (
      <div className="card">
        <h2>ストリング計算</h2>
        <div className="empty">
          パネルとパワコンを先に登録してください。
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>計算対象の選択</h2>
        <div className="form-grid">
          <div className="field">
            <label>パネル</label>
            <select value={panelId} onChange={(e) => { setPanelId(e.target.value); setSeries(null); setParallel(null); }}>
              {panels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.maker} {p.model}（{p.pmaxW}W）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>パワコン</label>
            <select value={pcsId} onChange={(e) => { setPcsId(e.target.value); setSeries(null); setParallel(null); }}>
              {pcsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.maker} {p.model}（{p.ratedPowerKw}kW）
                </option>
              ))}
            </select>
          </div>
        </div>

        <h3>設計条件（温度）</h3>
        <div className="form-grid">
          <div className="field">
            <label>設計最低気温 ℃（低温Voc）</label>
            <input
              type="number"
              value={conditions.minAmbientTempC}
              onChange={(e) =>
                setConditions({ ...conditions, minAmbientTempC: Number(e.target.value) })
              }
            />
            <div className="hint">既定 −3℃（西尾市基準）。低いほど低温Vocが上がり直列上限が下がる（過電圧に安全側）。寒冷地は下げる。</div>
          </div>
          <div className="field">
            <label>設計最高セル温度 ℃（高温Vmp）</label>
            <input
              type="number"
              value={conditions.maxCellTempC}
              onChange={(e) =>
                setConditions({ ...conditions, maxCellTempC: Number(e.target.value) })
              }
            />
          </div>
        </div>
        <div className="hint">
          低温で開放電圧 Voc が上がり最大直列数を、高温で動作電圧 Vmp が下がり最小直列数を決めます。
        </div>
      </div>

      {sizing && panel && pcs && (
        <>
          <div className="card">
            <h2>計算結果：直列数・並列数</h2>
            <div className="result-grid">
              <div className="metric">
                <div className="label">推奨 直列数（範囲）</div>
                <div className="value">
                  {sizing.seriesRange.min}–{sizing.seriesRange.max}
                  <small> 枚/string</small>
                </div>
              </div>
              <div className="metric">
                <div className="label">最大並列数 / MPPT</div>
                <div className="value">
                  {sizing.parallelMaxPerMppt}
                  <small> string</small>
                </div>
              </div>
              <div className="metric">
                <div className="label">低温 Voc（{conditions.minAmbientTempC}℃）</div>
                <div className="value">
                  {sizing.detail.vocLowTemp.toFixed(1)}
                  <small> V/枚</small>
                </div>
              </div>
              <div className="metric">
                <div className="label">高温 Vmp（{conditions.maxCellTempC}℃）</div>
                <div className="value">
                  {sizing.detail.vmpHighTemp.toFixed(1)}
                  <small> V/枚</small>
                </div>
              </div>
            </div>

            {sizing.warnings.length > 0 && (
              <div className="warnings">
                {sizing.warnings.map((w, i) => (
                  <div className="warn-item" key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2>構成シミュレーション</h2>
            <div className="form-grid">
              <div className="field">
                <label>採用 直列数（{sizing.seriesRange.min}–{sizing.seriesRange.max}）</label>
                <input
                  type="number"
                  min={1}
                  value={effectiveSeries}
                  onChange={(e) => setSeries(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label>採用 並列数/MPPT（最大 {sizing.parallelMaxPerMppt}）</label>
                <input
                  type="number"
                  min={1}
                  value={effectiveParallel}
                  onChange={(e) => setParallel(Number(e.target.value))}
                />
              </div>
            </div>

            {capacity && (
              <div className="result-grid" style={{ marginTop: 12 }}>
                <div className="metric">
                  <div className="label">PCS 1台あたり枚数</div>
                  <div className="value">
                    {capacity.maxPanelsPerPcs}
                    <small> 枚</small>
                  </div>
                  <div className="hint">
                    {effectiveSeries}直列 × {effectiveParallel}並列 × {pcs.mpptCount}MPPT
                  </div>
                </div>
                <div className="metric">
                  <div className="label">DC 容量</div>
                  <div className="value">
                    {capacity.maxDcKw.toFixed(2)}
                    <small> kW</small>
                  </div>
                </div>
                <div className="metric">
                  <div className="label">過積載率 DC/AC</div>
                  <div className="value">
                    {capacity.overloadPct.toFixed(0)}
                    <small> %</small>
                  </div>
                  <div className="hint">一般的な目安 110–130%</div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
