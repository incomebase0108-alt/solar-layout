import { useEffect, useState } from "react";
import type { PanelSpec, PcsSpec, PowerPlant, PcsUnitLine, PcsString, DesignConditions } from "../types";
import { uid } from "../store";
import { summarizeLayout } from "../calc/layoutCount";
import { calcStringSizing } from "../calc/stringSizing";
import { optimizeIntoUnitsPatterns, type OptimizeIntoUnitsResult, type OptimizePattern } from "../calc/pcsOptimize";

interface Props {
  plant: PowerPlant;
  panels: PanelSpec[];
  pcsList: PcsSpec[];
  conditions: DesignConditions;
  updatePlant: (id: string, patch: Partial<Omit<PowerPlant, "id" | "layout" | "wiring">>) => void;
}

/**
 * パワコン構成（1台＝1行で個別管理）。
 * 台数を決めると、その台数分が1台ずつ下に並び、各台を別々に設定できる。
 * 各台はストリング（使用パネル混在・直列数・並列）を持ち、
 * 合計V・DC kW・過積載率を自動計算。図面のパネル枚数とも突き合わせる。
 */
export function PcsComposer({ plant, panels, pcsList, conditions, updatePlant }: Props) {
  const units = plant.pcsUnits ?? [];
  const [bulkCount, setBulkCount] = useState(1);
  const [addPcsId, setAddPcsId] = useState(pcsList[0]?.id ?? ""); // 追加する機種
  const [addKind, setAddKind] = useState<"new" | "existing">("new"); // 追加する種別（新設/既設）
  // 機種一覧が変わったとき、未選択なら先頭機種に寄せる
  useEffect(() => {
    if (!pcsList.some((p) => p.id === addPcsId)) setAddPcsId(pcsList[0]?.id ?? "");
  }, [pcsList, addPcsId]);
  const fmt = (n: number) => n.toLocaleString();
  const kw = (n: number) => n.toFixed(2);

  // --- 最適化（下の一覧へ割り当て）の入力state ---
  // 台数・機種は「下の一覧」由来。任意の最大回路数上書きのみ持つ。
  const [optMaxCircuits, setOptMaxCircuits] = useState(0); // 0=各機種のMPPT数を既定
  const [optForce, setOptForce] = useState(false); // 残りを無理やり割り当てる（注意マーク付き）
  const [optPatterns, setOptPatterns] = useState<OptimizePattern[] | null>(null); // おすすめ3案
  const [optKey, setOptKey] = useState<string>("balanced"); // 選択中の案
  const optPreview: OptimizeIntoUnitsResult | null =
    optPatterns?.find((p) => p.key === optKey)?.result ?? optPatterns?.[1]?.result ?? null;

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
      // ストリング計算（温度補正込み）でPCS上限を判定。超えたらエラー。
      const errors: string[] = [];
      if (pcs && panel) {
        const sz = calcStringSizing(panel, pcs, conditions);
        if (s.series > sz.seriesMaxByVoltage)
          errors.push(
            `直列${s.series}本：低温Voc合計 ${(sz.detail.vocLowTemp * s.series).toFixed(0)}V が最大入力 ${pcs.maxInputVoltageV}V を超過（上限 ${sz.seriesMaxByVoltage}本）`
          );
        if (s.series < sz.seriesMinByMppt)
          errors.push(
            `直列${s.series}本：高温Vmp合計 ${(sz.detail.vmpHighTemp * s.series).toFixed(0)}V がMPPT下限 ${pcs.mpptVoltageMinV}V を下回る（下限 ${sz.seriesMinByMppt}本）`
          );
        if (s.parallel > sz.parallelMaxPerMppt)
          errors.push(
            `並列${s.parallel}本：最大入力電流 ${pcs.maxInputCurrentPerMpptA}A／並列上限 ${pcs.stringsPerMppt} を超過（上限 ${sz.parallelMaxPerMppt}本）`
          );
      }
      return { s, panel, cells, dcW, vmpStr, vocStr, errors };
    });
    const unitCells = strings.reduce((a, b) => a + b.cells, 0);
    const unitDcKw = strings.reduce((a, b) => a + b.dcW, 0) / 1000;
    const overloadPct = ratedKw > 0 ? (unitDcKw / ratedKw) * 100 : 0;
    // ユニット単位のエラー
    const unitErrors: string[] = [];
    if (pcs) {
      if (pcs.multiMppt === false) {
        // 非マルチ機（1MPPT）：行数ではなく「並列合計」で上限判定。直列は ±1 までの混在は許容（例 7直×2＋6直×2）。
        const ss = u.strings ?? [];
        if (ss.length > 0) {
          const samePanel = ss.every((s) => s.panelId === ss[0].panelId);
          if (!samePanel) unitErrors.push("非マルチMPPT機：1台に複数の型式は載せられません（同一型式に揃えてください）");
          const totalParallel = ss.reduce((a, s) => a + s.parallel, 0);
          const panel0 = panels.find((p) => p.id === ss[0].panelId);
          const cap = panel0 ? calcStringSizing(panel0, pcs, conditions).parallelMaxPerMppt : pcs.stringsPerMppt;
          if (totalParallel > Math.max(1, cap))
            unitErrors.push(`並列合計 ${totalParallel} 本が上限 ${cap} 本を超過（1MPPT・電流/並列上限）`);
          const sv = ss.map((s) => s.series);
          if (Math.max(...sv) - Math.min(...sv) > 1)
            unitErrors.push("非マルチMPPT機：直列数の差が大きく非効率（最弱ストリングに律速・±1直程度に）");
        }
      } else {
        // マルチ機：ストリング行＝MPPT数まで
        if ((u.strings?.length ?? 0) > pcs.mpptCount)
          unitErrors.push(`ストリング行 ${u.strings?.length} がMPPT回路数 ${pcs.mpptCount} を超過`);
      }
    }
    const hasError = unitErrors.length > 0 || strings.some((s) => s.errors.length > 0);
    return { no: idx + 1, line: u, pcs, ratedKw, strings, unitCells, unitDcKw, overloadPct, unitErrors, hasError };
  });

  const totalUnits = units.length;
  const totalAcKw = computed.reduce((s, g) => s + g.ratedKw, 0);
  const totalDcKw = computed.reduce((s, g) => s + g.unitDcKw, 0);
  const usedPanels = computed.reduce((s, g) => s + g.unitCells, 0);
  const overloadPct = totalAcKw > 0 ? (totalDcKw / totalAcKw) * 100 : 0;
  const remainPanels = layoutPanels - usedPanels;
  const errorUnits = computed.filter((g) => g.hasError);

  // --- 自動構成（下書き）：在庫構築とハンドラ ---
  // 図面の型式別在庫を panelId 単位に変換（最適化の入力）
  const optInventory = layoutSummary.byPanel
    .map((b) => {
      const p = panels.find((pp) => `${pp.maker} ${pp.model}` === b.model);
      return p ? { panelId: p.id, count: b.count } : null;
    })
    .filter((x): x is { panelId: string; count: number } => x !== null);

  function runOptimize(force = optForce) {
    if (units.length === 0) return;
    const pats = optimizeIntoUnitsPatterns({
      units,
      inventory: optInventory,
      panels,
      pcsList,
      conditions,
      maxCircuitsPerUnit: optMaxCircuits || undefined,
      force,
    });
    setOptPatterns(pats);
    setOptKey("balanced"); // 既定は「標準（おすすめ）」
  }
  function applyOptimize() {
    if (!optPreview) return;
    updatePlant(plant.id, { pcsUnits: optPreview.units });
    setOptPatterns(null);
  }

  // --- 型式別の在庫（図面枚数 vs パワコンへ割り振った使用枚数） ---
  // 割り振り作業中に「どの型式があと何枚残っているか」を図面ページへ切り替えずに見るための集計。
  const usedByModel = new Map<string, number>();
  for (const g of computed) {
    for (const st of g.strings) {
      const model = st.panel ? `${st.panel.maker} ${st.panel.model}` : "未登録パネル";
      usedByModel.set(model, (usedByModel.get(model) ?? 0) + st.cells);
    }
  }
  const stockModels = new Set<string>([
    ...layoutSummary.byPanel.map((b) => b.model),
    ...usedByModel.keys(),
  ]);
  const stockRows = [...stockModels]
    .map((model) => {
      const fig = layoutSummary.byPanel.find((b) => b.model === model)?.count ?? 0;
      const used = usedByModel.get(model) ?? 0;
      return { model, fig, used, remain: fig - used };
    })
    .sort((a, b) => b.fig - a.fig);

  // 現在表示している変更候補の名前（候補未使用なら「現在の内容」）。在庫がどの候補のものか明示する。
  const activeCand = (plant.candidates ?? []).find((c) => c.id === plant.currentCandidateId);
  const candLabel = activeCand ? activeCand.name : "現在の内容（候補未使用）";

  // 手動でパワコン／ストリングを追加するときの既定パネル：
  // 図面で最も枚数が多い型式を採用（無ければマスタ先頭）。stockRows は図面枚数の降順。
  const topFigModel = stockRows.find((r) => r.fig > 0)?.model;
  const defaultPanelId =
    panels.find((p) => `${p.maker} ${p.model}` === topFigModel)?.id ?? panels[0]?.id ?? "";

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
        panelId: base?.panelId ?? defaultPanelId,
        series: base?.series ?? 10,
        parallel: base?.parallel ?? 1,
      });
    }
    return out;
  }
  function makeUnit(pcs: PcsSpec, kind?: "new" | "existing"): PcsUnitLine {
    return { id: uid("pcsline"), pcsId: pcs.id, count: 1, kind, strings: syncStringsToMppt([], pcs.mpptCount) };
  }
  /** 台数分の新規ユニットをまとめて追加（各台は同じ初期構成・別々に編集可）。 */
  function addUnits(n: number, pcsId?: string, kind?: "new" | "existing") {
    const pcs = pcsList.find((p) => p.id === (pcsId ?? addPcsId)) ?? pcsList[0];
    if (!pcs) return;
    const k = kind ?? addKind;
    const add = Array.from({ length: Math.max(1, n) }, () => makeUnit(pcs, k));
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
    // 機種だけ差し替え、入力済みストリング行は保持する（切り詰めるとデータが不可逆に消える）。
    // ストリング行がまだ無いユニットだけ、新機種のMPPT回路数に合わせて初期行を用意する。
    // MPPT回路数を超える行は下の警告＋「MPPT数に合わせる」ボタンで手動調整できる。
    const newPcs = pcsList.find((p) => p.id === pcsId);
    setUnits(
      units.map((u) => {
        if (u.id !== id) return u;
        const hasStrings = (u.strings?.length ?? 0) > 0;
        return {
          ...u,
          pcsId,
          strings: hasStrings ? u.strings : syncStringsToMppt([], newPcs?.mpptCount ?? 1),
        };
      })
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
    const cur = units.find((u) => u.id === id);
    // 追加ストリングは、そのユニットの既存型式に揃える。無ければ図面で最も多い型式（既定パネル）。
    const fallbackPanelId = cur?.strings?.[0]?.panelId ?? defaultPanelId;
    if (!fallbackPanelId) return;
    updateUnit(id, {
      strings: [...(cur?.strings ?? []), { id: uid("str"), panelId: fallbackPanelId, series: 10, parallel: 1 }],
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
      {/* 型式別パネル在庫バー：スクロールしても上部に残り、割り振り中に常に枚数を確認できる */}
      <div
        className="no-print"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "8px 12px",
          marginBottom: 12,
          boxShadow: "0 4px 12px rgba(0,0,0,0.30)",
        }}
      >
        <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
          <strong style={{ fontSize: 13 }}>📋 型式別パネル在庫 — 図面「{candLabel}」</strong>
          <span className="hint" style={{ marginTop: 0 }}>
            合計：図面 {fmt(layoutPanels)} ／ 使用 {fmt(usedPanels)} ／
            <strong style={{ color: remainPanels < 0 ? "var(--danger)" : "var(--accent)", marginLeft: 4 }}>
              残 {fmt(remainPanels)} 枚
            </strong>
            {remainPanels < 0 && <span style={{ color: "var(--danger)" }}>（図面より多く割り振っています）</span>}
          </span>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 6, overflowX: "auto" }}>
          {stockRows.length === 0 ? (
            <span className="hint" style={{ marginTop: 0 }}>図面にパネルがありません（②図面で配置してください）。</span>
          ) : (
            stockRows.map((r) => {
              const color = r.remain < 0 ? "var(--danger)" : r.remain === 0 ? "var(--muted)" : "var(--accent)";
              return (
                <span
                  key={r.model}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                    padding: "3px 10px",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    background: "var(--panel-2)",
                  }}
                >
                  <strong>{r.model}</strong>：図面 {fmt(r.fig)} ／ 使用 {fmt(r.used)} ／
                  <strong style={{ color, marginLeft: 3 }}>残 {fmt(r.remain)}</strong>
                </span>
              );
            })
          )}
        </div>
      </div>

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
        {errorUnits.length > 0 && (
          <div
            className="warn-item"
            style={{ marginTop: 6, background: "rgba(244,63,94,0.12)", borderColor: "var(--danger)", color: "var(--danger)" }}
          >
            ⛔ ストリング設計エラー：{errorUnits.length} 台（#{errorUnits.map((g) => g.no).join(", #")}）。
            直列数・並列数がパワコンの電圧/電流上限を超えています。各台の赤い表示を確認してください。
          </div>
        )}
        {/* 最適化（下の一覧へ割り当て） */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <strong style={{ fontSize: 14 }}>🎯 最適化（現在の台数へ割り当て）</strong>
            <div className="field" style={{ width: 220 }}>
              <label>最大回路数/台（空欄=各機種の最大）</label>
              <input
                type="number"
                min={0}
                value={optMaxCircuits || ""}
                placeholder="空欄=満杯（MPPT×並列）"
                onChange={(e) => setOptMaxCircuits(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
            <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
              <input type="checkbox" checked={optForce} onChange={(e) => setOptForce(e.target.checked)} />
              <span style={{ fontSize: 12 }}>残りも強制割当（注意マーク付き）</span>
            </label>
            <button className="btn" onClick={() => runOptimize()} disabled={units.length === 0}>
              おすすめ3案を作成
            </button>
          </div>
          <span className="hint">
            {units.length === 0
              ? "先に下で「＋ パワコンを1台追加」してから最適化してください。"
              : "下の一覧のパワコン（現在の台数・機種）へ、図面のパネルを自動割り当て。各台の過積載率（DC/定格）がそろうよう型式のW差を直列数で吸収します（機種混在対応・電圧/電流は厳守）。ストリングの組み方違いで【影に強い／標準／配線シンプル】の3案を提示するので、選んで適用してください。入りきらない分は残＋「あと◯台」を表示。"}
          </span>

          {optPatterns && optPreview && (
            <div className="card" style={{ marginTop: 10, background: "var(--panel-2)" }}>
              {/* おすすめ3案セレクタ（1案/2案/3案 を横並びで比較） */}
              {(() => {
                const metrics = optPatterns.map((p) => {
                  const strCount = p.result.units.reduce((a, u) => a + (u.strings ?? []).length, 0);
                  const ov = p.result.units
                    .map((u) => {
                      const pcs = pcsList.find((x) => x.id === u.pcsId);
                      const dc = (u.strings ?? []).reduce(
                        (a, s) => a + s.series * s.parallel * (panels.find((pp) => pp.id === s.panelId)?.pmaxW ?? 0),
                        0
                      );
                      return pcs && pcs.ratedPowerKw > 0 && dc > 0 ? (dc / (pcs.ratedPowerKw * 1000)) * 100 : null;
                    })
                    .filter((x): x is number => x != null);
                  const ovLabel = ov.length ? `${Math.round(Math.min(...ov))}–${Math.round(Math.max(...ov))}%` : "—";
                  return { strCount, ovLabel, leftover: p.result.leftoverTotal };
                });
                const allSame = metrics.every(
                  (m) => m.strCount === metrics[0].strCount && m.leftover === metrics[0].leftover && m.ovLabel === metrics[0].ovLabel
                );
                return (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
                      {optPatterns.map((p, idx) => {
                        const selected = p.key === optKey;
                        const m = metrics[idx];
                        return (
                          <button
                            key={p.key}
                            className={selected ? "btn" : "btn secondary"}
                            onClick={() => setOptKey(p.key)}
                            style={{ flexDirection: "column", alignItems: "flex-start", textAlign: "left", padding: "8px 10px", height: "auto" }}
                          >
                            <span style={{ fontWeight: 700 }}>{idx + 1}案</span>
                            <span style={{ fontSize: 12 }}>{p.label}</span>
                            <span style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                              過積載 {m.ovLabel}
                              <br />
                              {m.strCount}本 ／ 残{m.leftover}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {allSame && (
                      <div className="hint" style={{ marginBottom: 6 }}>
                        ※ この機種・枚数では3案とも同じ構成になります（機種仕様でストリングの組み方が一通りに決まるため）。
                      </div>
                    )}
                  </>
                );
              })()}
              <div className="row">
                <strong>プレビュー：{optPatterns.find((p) => p.key === optKey)?.label}（{optPreview.units.length} 台）</strong>
                <span className="spacer" />
                <button className="btn small" onClick={applyOptimize}>この案を適用</button>
                <button className="btn secondary small" onClick={() => setOptPatterns(null)}>破棄</button>
              </div>
              <div className="row" style={{ marginTop: 4, alignItems: "center", gap: 8 }}>
                <span className="hint" style={{ marginTop: 0 }}>
                  残 {fmt(optPreview.leftoverTotal)} 枚
                  {optPreview.extraUnitsNeeded.length > 0 &&
                    `（使い切るには ${optPreview.extraUnitsNeeded
                      .map((e) => `${e.pcsLabel} 約${e.count}台`)
                      .join(" / ")} の追加が目安）`}
                </span>
                {optPreview.leftoverTotal > 0 && !optForce && (
                  <button
                    className="btn warn small"
                    onClick={() => {
                      setOptForce(true);
                      runOptimize(true);
                    }}
                  >
                    ⚠ 残りを強制割当
                  </button>
                )}
              </div>
              {optPreview.units.every((u) => (u.strings ?? []).length === 0) && (
                <div className="warn-item" style={{ marginTop: 6 }}>
                  どの台にも回路を作成できませんでした（図面が空、または図面のパネルが各機種の電圧範囲に合いません）。図面のパネル配置・機種・条件を確認してください。
                </div>
              )}
              {optPreview.ampWarnings.map((w, i) => (
                <div className="warn-item" key={"a" + i} style={{ marginTop: 4, color: "var(--warn)", borderColor: "var(--warn)" }}>⚠ {w}</div>
              ))}
              {optPreview.notes.map((n, i) => (
                <div className="hint" key={"n" + i} style={{ marginTop: 2 }}>・{n}</div>
              ))}
              <table className="list" style={{ marginTop: 8 }}>
                <thead><tr><th>#</th><th>機種</th><th>MPPT構成（型式 / 直列 × 並列）</th><th className="num">枚数</th></tr></thead>
                <tbody>
                  {optPreview.units.map((u, i) => {
                    const cells = (u.strings ?? []).reduce((a, s) => a + s.series * s.parallel, 0);
                    const pcs = pcsList.find((p) => p.id === u.pcsId);
                    const pcsLabel = pcs ? `${pcs.maker} ${pcs.model}` : "?";
                    const desc =
                      (u.strings ?? []).length === 0
                        ? "（割当なし）"
                        : (u.strings ?? [])
                            .map((s) => {
                              const p = panels.find((pp) => pp.id === s.panelId);
                              return `${p ? p.model : "?"} ${s.series}直×${s.parallel}並`;
                            })
                            .join(" ／ ");
                    return (
                      <tr key={u.id}>
                        <td>#{i + 1}</td>
                        <td>{pcsLabel}</td>
                        <td>{desc}</td>
                        <td className="num">{cells}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 240 }}>
            <label>追加する機種</label>
            <select value={addPcsId} onChange={(e) => setAddPcsId(e.target.value)}>
              {pcsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.maker} {p.model}（{p.ratedPowerKw}kW）
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label>種別</label>
            <select value={addKind} onChange={(e) => setAddKind(e.target.value as "new" | "existing")}>
              <option value="new">新設</option>
              <option value="existing">既設（流用）</option>
            </select>
            <div className="hint">{addKind === "existing" ? "流用＝設置費なし" : "新設＝設置費がかかる"}</div>
          </div>
          <div className="field" style={{ width: 90 }}>
            <label>台数</label>
            <input type="number" min={1} value={bulkCount} onChange={(e) => setBulkCount(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <button className="btn" onClick={() => addUnits(bulkCount)}>この機種を追加</button>
          <button className="btn secondary" onClick={() => addUnits(1)}>1台だけ追加</button>
          <span className="hint">
            選んだ機種を台数分まとめて追加します（1台ずつ下に並び、各台を<strong>別々に設定</strong>・<strong>「複製」</strong>も可）。機種が一覧に無いときは「パワコン登録」で追加してください。
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
        <div
          className="card"
          key={g.line.id}
          style={g.hasError ? { borderColor: "var(--danger)", boxShadow: "0 0 0 1px var(--danger) inset" } : undefined}
        >
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
                    {p.maker} {p.model}（{p.ratedPowerKw}kW{p.warranty ? ` / ${p.warranty}` : ""}）
                  </option>
                ))}
              </select>
              <div className="hint">
                MPPT {g.pcs?.mpptCount ?? "—"} 回路 ／ マルチ{g.pcs?.multiMppt === false ? "なし（全ストリング同一が必要）" : "あり"}
              </div>
            </div>
            <div className="field" style={{ minWidth: 150 }}>
              <label>種別</label>
              <select
                value={g.line.kind ?? "new"}
                onChange={(e) => updateUnit(g.line.id, { kind: e.target.value as "existing" | "new" })}
              >
                <option value="new">新設</option>
                <option value="existing">既設（流用）</option>
              </select>
              <div className="hint">
                {(g.line.kind ?? "new") === "existing" ? "流用＝設置費なし" : "新設＝設置費がかかる"}
              </div>
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
                <th className="num">合計V(Voc)</th>
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
                    {st.errors.map((em, i) => (
                      <div
                        className="warn-item"
                        key={i}
                        style={{ marginTop: 2, color: "var(--danger)", borderColor: "var(--danger)", background: "rgba(244,63,94,0.1)" }}
                      >
                        ⛔ {em}
                      </div>
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
                  <td className="num" style={{ color: g.pcs && st.vocStr > g.pcs.maxInputVoltageV ? "var(--danger)" : undefined }}>
                    {st.vocStr.toFixed(0)}
                  </td>
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

          {g.unitErrors.map((em, i) => (
            <div className="warn-item" key={i} style={{ marginTop: 4, color: "var(--danger)", borderColor: "var(--danger)", background: "rgba(244,63,94,0.1)" }}>
              ⛔ {em}
            </div>
          ))}

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
              {g.hasError && <strong style={{ color: "var(--danger)", marginRight: 6 }}>⛔ ストリングエラーあり</strong>}
              1台AC {kw(g.ratedKw)}kW ／ 1台DC {kw(g.unitDcKw)}kW ／
              <strong style={{ color: g.overloadPct > 130 ? "var(--warn)" : undefined, marginLeft: 4 }}>
                過積載率 {g.ratedKw > 0 ? g.overloadPct.toFixed(0) : "—"}%
              </strong>
            </span>
          </div>
          {g.pcs && g.strings[0]?.panel && (() => {
            const sz = calcStringSizing(g.strings[0].panel, g.pcs, conditions);
            return (
              <div className="hint" style={{ marginTop: 4 }}>
                適合範囲（{g.strings[0].panel.model}・温度補正）：直列 {sz.seriesRange.min}–{sz.seriesRange.max} 本 ／ 並列 最大 {sz.parallelMaxPerMppt} 本/MPPT
                （低温Voc {sz.detail.vocLowTemp.toFixed(1)}V・高温Vmp {sz.detail.vmpHighTemp.toFixed(1)}V）
              </div>
            );
          })()}
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
                  <td><strong>{g.pcs ? `${g.pcs.maker} ${g.pcs.model}${g.pcs.warranty ? `（${g.pcs.warranty}）` : ""}` : "—"}</strong></td>
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
            合計V＝直列数×Voc（開放電圧, STC）。パワコン最大入力電圧を超えると赤字＋⛔エラー。直列上限は低温Vocで自動判定します。
          </div>
        </div>
      )}
    </>
  );
}
