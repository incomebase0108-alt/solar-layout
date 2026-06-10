import { useEffect, useState } from "react";
import type { PanelSpec, PcsSpec, PowerPlant, PcsUnitLine, PcsString } from "../types";
import { uid } from "../store";
import { summarizeLayout } from "../calc/layoutCount";

interface Props {
  plant: PowerPlant;
  panels: PanelSpec[];
  pcsList: PcsSpec[];
  updatePlant: (id: string, patch: Partial<Omit<PowerPlant, "id" | "layout" | "wiring">>) => void;
}

/**
 * パワコン構成（1台＝1行で個別管理）。
 * 台数を決めると、その台数分が1台ずつ下に並び、各台を別々に設定できる。
 * 各台はストリング（使用パネル混在・直列数・並列）を持ち、
 * 合計V・DC kW・過積載率を自動計算。図面のパネル枚数とも突き合わせる。
 */
export function PcsComposer({ plant, panels, pcsList, updatePlant }: Props) {
  const units = plant.pcsUnits ?? [];
  const [bulkCount, setBulkCount] = useState(1);
  const fmt = (n: number) => n.toLocaleString();
  const kw = (n: number) => n.toFixed(2);

  // --- 旧データ（台数まとめ）を 1台＝1行 に自動展開 ---
  useEffect(() => {
    if (!units.some((u) => (u.count ?? 1) > 1)) return;
    const expanded: PcsUnitLine[] = units.flatMap((u) => {
      const c = u.count ?? 1;
      if (c <= 1) return [{ ...u, count: 1 }];
      return Array.from({ length: c }, (_, i) => ({
        ...u,
        id: i === 0 ? u.id : uid("pcsline"),
        count: 1,
        strings: (u.strings ?? []).map((s) => ({ ...s, id: i === 0 ? s.id : uid("str") })),
      }));
    });
    updatePlant(plant.id, { pcsUnits: expanded });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  // --- 図面（レイアウト）のパネル集計：改修案ベース（既存は流用枚数＋新設） ---
  const layoutSummary = summarizeLayout(plant.layout, panels, "kaishu");
  const layoutPanels = layoutSummary.totalPanels;
  const layoutDcKw = layoutSummary.totalKw;

  // --- 各台（ユニット）の集計 ---
  const computed = units.map((u, idx) => {
    const pcs = pcsList.find((p) => p.id === u.pcsId) ?? null;
    const ratedKw = pcs?.ratedPowerKw ?? 0;
    const strings = (u.strings ?? []).map((s) => {
      const panel = panels.find((p) => p.id === s.panelId) ?? null;
      const cells = s.series * s.parallel;
      const dcW = cells * (panel?.pmaxW ?? 0);
      const vmpStr = s.series * (panel?.vmpV ?? 0);
      const vocStr = s.series * (panel?.vocV ?? 0);
      const warns: string[] = [];
      if (pcs) {
        if (vmpStr > 0 && (vmpStr < pcs.mpptVoltageMinV || vmpStr > pcs.mpptVoltageMaxV))
          warns.push(`動作電圧 ${vmpStr.toFixed(0)}V がMPPT範囲(${pcs.mpptVoltageMinV}–${pcs.mpptVoltageMaxV}V)外`);
        if (vocStr > pcs.maxInputVoltageV)
          warns.push(`開放電圧 ${vocStr.toFixed(0)}V が最大入力 ${pcs.maxInputVoltageV}V 超過`);
      }
      return { s, panel, cells, dcW, vmpStr, vocStr, warns };
    });
    const unitCells = strings.reduce((a, b) => a + b.cells, 0);
    const unitDcKw = strings.reduce((a, b) => a + b.dcW, 0) / 1000;
    const overloadPct = ratedKw > 0 ? (unitDcKw / ratedKw) * 100 : 0;
    return { no: idx + 1, line: u, pcs, ratedKw, strings, unitCells, unitDcKw, overloadPct };
  });

  const totalUnits = units.length;
  const totalAcKw = computed.reduce((s, g) => s + g.ratedKw, 0);
  const totalDcKw = computed.reduce((s, g) => s + g.unitDcKw, 0);
  const usedPanels = computed.reduce((s, g) => s + g.unitCells, 0);
  const overloadPct = totalAcKw > 0 ? (totalDcKw / totalAcKw) * 100 : 0;
  const remainPanels = layoutPanels - usedPanels;

  // --- 更新ヘルパ ---
  function setUnits(next: PcsUnitLine[]) {
    updatePlant(plant.id, { pcsUnits: next });
  }
  function syncStringsToMppt(strings: PcsString[], mpptCount: number): PcsString[] {
    const n = Math.max(1, mpptCount || 1);
    const out = strings.slice(0, n);
    while (out.length < n) {
      const base = out[out.length - 1];
      out.push({
        id: uid("str"),
        panelId: base?.panelId ?? panels[0]?.id ?? "",
        series: base?.series ?? 10,
        parallel: base?.parallel ?? 1,
      });
    }
    return out;
  }
  function makeUnit(pcs: PcsSpec): PcsUnitLine {
    return { id: uid("pcsline"), pcsId: pcs.id, count: 1, strings: syncStringsToMppt([], pcs.mpptCount) };
  }
  /** 台数分の新規ユニットをまとめて追加（各台は同じ初期構成・別々に編集可）。 */
  function addUnits(n: number) {
    const first = pcsList[0];
    if (!first) return;
    const add = Array.from({ length: Math.max(1, n) }, () => makeUnit(first));
    setUnits([...units, ...add]);
  }
  function duplicateUnit(id: string) {
    const u = units.find((x) => x.id === id);
    if (!u) return;
    const copy: PcsUnitLine = {
      ...u,
      id: uid("pcsline"),
      strings: (u.strings ?? []).map((s) => ({ ...s, id: uid("str") })),
    };
    const i = units.findIndex((x) => x.id === id);
    const next = [...units];
    next.splice(i + 1, 0, copy); // 直後に挿入
    setUnits(next);
  }
  function updateUnit(id: string, patch: Partial<PcsUnitLine>) {
    setUnits(units.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }
  function changeUnitPcs(id: string, pcsId: string) {
    const newPcs = pcsList.find((p) => p.id === pcsId);
    setUnits(
      units.map((u) =>
        u.id === id ? { ...u, pcsId, strings: syncStringsToMppt(u.strings ?? [], newPcs?.mpptCount ?? 1) } : u
      )
    );
  }
  function resyncStrings(id: string) {
    const u = units.find((x) => x.id === id);
    const pcs = pcsList.find((p) => p.id === u?.pcsId);
    if (!u || !pcs) return;
    updateUnit(id, { strings: syncStringsToMppt(u.strings ?? [], pcs.mpptCount) });
  }
  function removeUnit(id: string) {
    setUnits(units.filter((u) => u.id !== id));
  }
  function addString(id: string) {
    const panel = panels[0];
    if (!panel) return;
    updateUnit(id, {
      strings: [...(units.find((u) => u.id === id)?.strings ?? []), { id: uid("str"), panelId: panel.id, series: 10, parallel: 1 }],
    });
  }
  function updateString(uid_: string, sid: string, patch: Partial<PcsString>) {
    const u = units.find((x) => x.id === uid_);
    if (!u) return;
    updateUnit(uid_, { strings: (u.strings ?? []).map((s) => (s.id === sid ? { ...s, ...patch } : s)) });
  }
  function removeString(uid_: string, sid: string) {
    const u = units.find((x) => x.id === uid_);
    if (!u) return;
    updateUnit(uid_, { strings: (u.strings ?? []).filter((s) => s.id !== sid) });
  }

  if (pcsList.length === 0 || panels.length === 0) {
    return (
      <div className="card">
        <h2>パワコン構成</h2>
        <div className="empty">先に「パネル登録」「パワコン登録」を済ませてください。</div>
      </div>
    );
  }

  const capKw = plant.outputCapKw ?? 0;
  const overCap = capKw > 0 && totalDcKw > capKw + 1e-6;

  return (
    <>
      {/* サマリ */}
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>パワコン構成 — {plant.name}</h2>
          <span className="spacer" />
          <button className="btn secondary small no-print" onClick={() => window.print()}>印刷 / PDF</button>
        </div>
        <div className="result-grid" style={{ marginTop: 8 }}>
          <div className="metric">
            <div className="label">パワコン合計出力 (AC)</div>
            <div className="value">{kw(totalAcKw)}<small> kW</small></div>
            <div className="hint">{totalUnits} 台</div>
          </div>
          <div className="metric">
            <div className="label">構成パネル出力 (DC)</div>
            <div className="value" style={{ color: overCap ? "var(--danger)" : undefined }}>
              {kw(totalDcKw)}<small> kW{capKw > 0 ? ` / 上限 ${capKw}` : ""}</small>
            </div>
          </div>
          <div className="metric">
            <div className="label">過積載率（DC÷AC）</div>
            <div className="value" style={{ color: overloadPct > 130 ? "var(--warn)" : undefined }}>
              {totalAcKw > 0 ? overloadPct.toFixed(0) : "—"}<small> %</small>
            </div>
            <div className="hint">目安 110–130%</div>
          </div>
          <div className="metric">
            <div className="label">パネル枚数（使用 / 図面）</div>
            <div className="value" style={{ color: remainPanels < 0 ? "var(--danger)" : undefined }}>
              {fmt(usedPanels)}<small> / {fmt(layoutPanels)} 枚</small>
            </div>
            <div className="hint">
              {remainPanels >= 0 ? `残 ${fmt(remainPanels)} 枚` : `不足 ${fmt(-remainPanels)} 枚`}（図面DC {kw(layoutDcKw)}kW）
            </div>
          </div>
        </div>
        {overCap && (
          <div className="warn-item" style={{ marginTop: 6 }}>
            ⚠ 構成DC {kw(totalDcKw)}kW が出力上限 {capKw}kW を超過。買取単価区分に注意。
          </div>
        )}
        <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
          <button className="btn" onClick={() => addUnits(1)}>＋ パワコンを1台追加</button>
          <div className="field" style={{ width: 90 }}>
            <label>台数</label>
            <input type="number" min={1} value={bulkCount} onChange={(e) => setBulkCount(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <button className="btn secondary" onClick={() => addUnits(bulkCount)}>この台数をまとめて追加</button>
          <span className="hint">
            追加すると1台ずつ下に並びます。各台を<strong>別々に設定</strong>でき、似た台は<strong>「複製」</strong>で増やせます。
          </span>
        </div>
      </div>

      {units.length === 0 && (
        <div className="card">
          <div className="empty">「＋ パワコンを1台追加」または台数を指定してまとめて追加してください。</div>
        </div>
      )}

      {/* 1台ずつのカード */}
      {computed.map((g) => (
        <div className="card" key={g.line.id}>
          <div className="form-grid">
            <div className="field" style={{ width: 70 }}>
              <label>No.</label>
              <div className="value" style={{ fontSize: 20 }}>#{g.no}</div>
            </div>
            <div className="field" style={{ minWidth: 240 }}>
              <label>パワコン機種</label>
              <select value={g.line.pcsId} onChange={(e) => changeUnitPcs(g.line.id, e.target.value)}>
                {pcsList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.maker} {p.model}（{p.kind === "existing" ? "既設" : "新設"} / {p.ratedPowerKw}kW）
                  </option>
                ))}
              </select>
              <div className="hint">MPPT {g.pcs?.mpptCount ?? "—"} 回路</div>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}>
              <label>メモ</label>
              <input
                type="text"
                placeholder="例) 南面用 / 影区画用"
                value={g.line.note ?? ""}
                onChange={(e) => updateUnit(g.line.id, { note: e.target.value })}
              />
            </div>
            <div className="field" style={{ justifyContent: "flex-end" }}>
              <div className="row">
                <button className="btn secondary small" onClick={() => duplicateUnit(g.line.id)}>複製</button>
                <button className="btn danger small" onClick={() => removeUnit(g.line.id)}>削除</button>
              </div>
            </div>
          </div>

          <table className="list" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>使用パネル</th>
                <th className="num">W</th>
                <th className="num">直列数</th>
                <th className="num">並列</th>
                <th className="num">合計V(Vmp)</th>
                <th className="num">枚数</th>
                <th className="num">DC(kW)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {g.strings.map((st) => (
                <tr key={st.s.id}>
                  <td>
                    <select value={st.s.panelId} onChange={(e) => updateString(g.line.id, st.s.id, { panelId: e.target.value })}>
                      {panels.map((p) => (
                        <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
                      ))}
                    </select>
                    {st.warns.map((wm, i) => (
                      <div className="warn-item" key={i} style={{ marginTop: 2 }}>⚠ {wm}</div>
                    ))}
                  </td>
                  <td className="num">{st.panel?.pmaxW ?? "—"}</td>
                  <td className="num">
                    <input
                      type="number" min={1} style={{ width: 64 }} value={st.s.series}
                      onChange={(e) => updateString(g.line.id, st.s.id, { series: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number" min={1} style={{ width: 56 }} value={st.s.parallel}
                      onChange={(e) => updateString(g.line.id, st.s.id, { parallel: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </td>
                  <td className="num">{st.vmpStr.toFixed(0)}</td>
                  <td className="num">{st.cells}</td>
                  <td className="num">{(st.dcW / 1000).toFixed(2)}</td>
                  <td className="num">
                    <button className="btn danger small" onClick={() => removeString(g.line.id, st.s.id)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="num"><strong>この1台 合計</strong></td>
                <td className="num"><strong>{g.unitCells} 枚</strong></td>
                <td className="num"><strong>{kw(g.unitDcKw)}</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>

          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn secondary small" onClick={() => addString(g.line.id)}>＋ ストリング追加</button>
            <button
              className="btn secondary small"
              title="ストリング数をマスタのMPPT回路数に合わせる"
              onClick={() => resyncStrings(g.line.id)}
            >
              MPPT数({g.pcs?.mpptCount ?? "—"})に合わせる
            </button>
            <span className="spacer" />
            <span className="hint">
              1台AC {kw(g.ratedKw)}kW ／ 1台DC {kw(g.unitDcKw)}kW ／
              <strong style={{ color: g.overloadPct > 130 ? "var(--warn)" : undefined, marginLeft: 4 }}>
                過積載率 {g.ratedKw > 0 ? g.overloadPct.toFixed(0) : "—"}%
              </strong>
            </span>
          </div>
        </div>
      ))}

      {/* 全体の一覧（読み取り） */}
      {totalUnits > 0 && (
        <div className="card">
          <h2>パワコン別 一覧（全 {totalUnits} 台）</h2>
          <table className="list">
            <thead>
              <tr>
                <th>#</th>
                <th>機種</th>
                <th className="num">AC(kW)</th>
                <th className="num">DC(kW)</th>
                <th className="num">枚数</th>
                <th className="num">過積載率</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {computed.map((g) => (
                <tr key={g.line.id}>
                  <td>#{g.no}</td>
                  <td><strong>{g.pcs ? `${g.pcs.maker} ${g.pcs.model}` : "—"}</strong></td>
                  <td className="num">{kw(g.ratedKw)}</td>
                  <td className="num">{kw(g.unitDcKw)}</td>
                  <td className="num">{g.unitCells}</td>
                  <td className="num" style={{ color: g.overloadPct > 130 ? "var(--warn)" : undefined }}>
                    {g.ratedKw > 0 ? g.overloadPct.toFixed(0) : "—"}%
                  </td>
                  <td className="hint">{g.line.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}><strong>合計 {totalUnits} 台</strong></td>
                <td className="num"><strong>{kw(totalAcKw)}</strong></td>
                <td className="num"><strong>{kw(totalDcKw)}</strong></td>
                <td className="num"><strong>{fmt(usedPanels)}</strong></td>
                <td className="num"><strong>{totalAcKw > 0 ? overloadPct.toFixed(0) : "—"}%</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
          <div className="hint" style={{ marginTop: 8 }}>
            使用 {fmt(usedPanels)} 枚 / 図面 {fmt(layoutPanels)} 枚（{remainPanels >= 0 ? `残 ${fmt(remainPanels)}` : `不足 ${fmt(-remainPanels)}`} 枚）。
            合計V＝直列数×Vmp。電圧がパワコン範囲外のストリングは ⚠ で表示します。
          </div>
        </div>
      )}
    </>
  );
}
