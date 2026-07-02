// ============================================================
// 候補（変更案）ごとの概算コスト計算
//   - deriveCostInputs: 図面＋パワコン構成から「自動導出値」を集計
//     （CostEstimator.tsx の derived useMemo と同一ロジック。両者で共有して数字を一致させる）
//   - buildCostInput: 自動導出値＋候補の手入力(cost)から estimateCost 用の入力を組み立てる
//   - computeCandidateCost / computeActiveCost: 1候補ぶんの概算コスト要約（⑤比較表用）
// ============================================================
import type {
  PowerPlant,
  PlanCandidate,
  PanelSpec,
  PcsSpec,
  CostRates,
  CandidateCostInputs,
  PanelArray,
  FreePanel,
  PcsUnitLine,
} from "../types";
import { arrayCellStats } from "./layoutCount";
import { composeWorkingArrays } from "./layoutCompose";
import { estimateCost, estimateRoi, estimateAfterGeneration } from "./cost";
import type { CostInput } from "./cost";

/** 図面（arrays / freePanels / manualCurrent）とパワコン構成から自動で出る値。 */
export interface DerivedCostInputs {
  /** 新設パネル明細（型式ごと） */
  newLines: { panelId: string; label: string; w: number; count: number; unitYen: number }[];
  /** 新設パネル合計枚数 */
  newTotal: number;
  /** 既設の撤去枚数 */
  removedExisting: number;
  /** 流用（据置）容量(kW) */
  keptKw: number;
  /** 改修前の既設容量(kW) */
  beforeKw: number;
  /** 新設パワコン台数（構成の実効 kind=new から） */
  newPcs: number;
}

/**
 * 図面＋パワコン構成から新設/撤去パネル・新設パワコンを集計する純粋関数。
 * CostEstimator.tsx の derived useMemo と同一ロジック（挙動を一致させること）。
 */
export function deriveCostInputs(
  arrays: PanelArray[],
  freePanels: FreePanel[] | undefined,
  manualCurrent: { id: string; panelId: string; count: number }[] | undefined,
  pcsUnits: PcsUnitLine[] | undefined,
  panels: PanelSpec[],
  pcsList: PcsSpec[]
): DerivedCostInputs {
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
  for (const a of arrays) {
    const p = panels.find((x) => x.id === a.panelId);
    const pmax = p?.pmaxW ?? 0;
    const { grid, removed, keep, hasKeep, marked } = arrayCellStats(a);
    if (marked) {
      // 既設配列：流用以外（入換・撤去）は撤去枚数に計上
      beforeKw += (grid * pmax) / 1000;
      keptKw += (keep * pmax) / 1000;
      removedExisting += grid - keep;
      // 全部入換（流用0）：既設は全数撤去し同じグリッドに新パネルを載せる → 新設にも計上
      if (!hasKeep) addNew(a.panelId, grid - removed);
    } else {
      // 新設配列（②で追加。既設は無いので撤去は発生しない）
      addNew(a.panelId, grid - removed);
    }
  }
  for (const f of freePanels ?? []) addNew(f.panelId, 1);

  // レイアウト未作成（複雑な発電所の手入力）の場合、手入力の現状を撤去対象にする
  if (arrays.length === 0) {
    for (const m of manualCurrent ?? []) {
      if (m.count <= 0) continue;
      const p = panels.find((x) => x.id === m.panelId);
      const pmax = p?.pmaxW ?? 0;
      beforeKw += (m.count * pmax) / 1000;
      removedExisting += m.count;
    }
  }

  const newLines = [...map.entries()].map(([panelId, v]) => ({ panelId, ...v }));
  const newTotal = newLines.reduce((s, l) => s + l.count, 0);
  let newPcs = 0;
  for (const u of pcsUnits ?? []) {
    const pcs = pcsList.find((p) => p.id === u.pcsId);
    const eff = u.kind ?? pcs?.kind;
    if (eff === "new") newPcs += u.count ?? 1;
  }
  return { newLines, newTotal, removedExisting, keptKw, beforeKw, newPcs };
}

/**
 * パワコン構成のうち「新設なのに単価未登録」の機種名一覧（重複なし）。
 * 単価未登録は ?? 0 で黙って0円計上されるため、UI側の警告表示に使う。
 */
export function missingPcsPrices(pcsUnits: PcsUnitLine[] | undefined, pcsList: PcsSpec[]): string[] {
  const names = new Set<string>();
  for (const u of pcsUnits ?? []) {
    const eff = u.kind ?? "new"; // 区分は台ごと。未指定は新設扱い（コスト計上対象）
    if (eff !== "new") continue;
    const pcs = pcsList.find((p) => p.id === u.pcsId);
    if (!pcs) {
      names.add("マスタ未登録の機種");
    } else if (pcs.unitPriceYen == null) {
      names.add(`${pcs.maker} ${pcs.model}`);
    }
  }
  return [...names];
}

/** 監視装置の表示名（CostEstimator と一致させる）。 */
function loggerLabelOf(t: CandidateCostInputs["loggerType"]): string {
  return t === "full"
    ? "監視装置 SmartLogger 3000A"
    : t === "lite"
    ? "監視装置 SmartLogger 3000A Lite版"
    : "";
}

/**
 * 自動導出値＋候補の手入力(cost)から estimateCost 用の入力を組み立てる。
 * 手入力が未指定の項目は自動導出値／既定にフォールバック（撤去は既定で全数「処分」）。
 */
export function buildCostInput(
  d: DerivedCostInputs,
  cost: CandidateCostInputs,
  rates: CostRates,
  pcsList: PcsSpec[]
): CostInput {
  const newPanelLines = (cost.panelLines ?? d.newLines).map((l) => ({
    label: l.label,
    count: l.count,
    unitYen: l.unitYen,
    w: l.w,
  }));
  const pcsMode = cost.pcsMode ?? (d.newPcs > 0 ? "new" : "keep");
  const newPcsCount = pcsMode === "new" ? cost.newPcsCount ?? d.newPcs : 0;
  const pcsId = cost.pcsId ?? pcsList[0]?.id ?? "";
  const pcsMaster = pcsList.find((p) => p.id === pcsId) ?? null;
  const pcsUnitYen = cost.pcsUnitYen ?? pcsMaster?.unitPriceYen ?? 0;
  const loggerType = cost.loggerType ?? "none";
  const extraLines =
    loggerType !== "none"
      ? [{ label: loggerLabelOf(loggerType), count: 1, unitYen: cost.loggerUnitYen ?? 0 }]
      : [];
  const extra = cost.extraCostLines ?? [];
  return {
    newPanelLines,
    removedDisposal: cost.removedDisposal ?? d.removedExisting,
    removedStock: cost.removedStock ?? 0,
    newPcsCount,
    pcsUnitYen,
    removedPcsCount: cost.removedPcsCount ?? 0,
    extraLines,
    otherLines: extra.map((e) => ({
      label: e.label,
      qty: e.qty,
      unit: e.unit,
      unitYen: e.unitYen,
      inMisc: e.inMisc,
    })),
    rates,
  };
}

/** 比較表の1行ぶんの要約。 */
export interface CandidateCostSummary {
  candidateId: string;
  name: string;
  /** 新設パネル枚数 */
  newPanelCount: number;
  /** 新設容量(kW) */
  newCapacityKw: number;
  /** 撤去枚数（処分＋在庫） */
  removedCount: number;
  /** 新設パワコン台数 */
  newPcsCount: number;
  /** 総工事費（諸経費込み） */
  totalYen: number;
  /** 新設容量あたり単価（円/W） */
  yenPerW: number | null;
  /** 年間増収（円/年） */
  annualRevenueIncreaseYen: number;
  /** 投資回収年数 */
  paybackYears: number | null;
  /** ROI(%) */
  roiPct: number | null;
}

/** 自動導出値＋手入力から1候補ぶんの要約を作る（内部共通）。 */
function summarize(
  id: string,
  name: string,
  d: DerivedCostInputs,
  cost: CandidateCostInputs,
  plant: PowerPlant,
  rates: CostRates,
  pcsList: PcsSpec[]
): CandidateCostSummary {
  const input = buildCostInput(d, cost, rates, pcsList);
  const result = estimateCost(input);
  const newCapacityKw = input.newPanelLines.reduce((s, l) => s + (l.w * l.count) / 1000, 0);
  const afterKw = d.keptKw + newCapacityKw;
  const afterGen =
    cost.afterGenOverride ?? estimateAfterGeneration(plant.annualGenerationKwh ?? 0, d.beforeKw, afterKw);
  const roi = estimateRoi({
    currentAnnualKwh: plant.annualGenerationKwh ?? 0,
    afterAnnualKwh: afterGen,
    fitPriceYenPerKwh: plant.fitPriceYenPerKwh ?? 10,
    remainingYears: plant.fitRemainingYears ?? 10,
    upgradeCostYen: result.totalYen,
  });
  const newPanelCount = input.newPanelLines.reduce((s, l) => s + l.count, 0);
  return {
    candidateId: id,
    name,
    newPanelCount,
    newCapacityKw,
    removedCount: input.removedDisposal + input.removedStock,
    newPcsCount: input.newPcsCount,
    totalYen: result.totalYen,
    yenPerW: result.yenPerW,
    annualRevenueIncreaseYen: roi.annualRevenueIncreaseYen,
    paybackYears: roi.paybackYears,
    roiPct: roi.roiPct,
  };
}

/** 任意候補（保存形式＝マーク＋新設）から概算コスト要約を計算する（非アクティブ候補用）。 */
export function computeCandidateCost(
  plant: PowerPlant,
  candidate: PlanCandidate,
  ctx: { panels: PanelSpec[]; pcsList: PcsSpec[]; rates: CostRates }
): CandidateCostSummary {
  const arrays = composeWorkingArrays(
    plant.layout.existingArrays ?? [],
    candidate.existingMarks,
    candidate.arrays ?? []
  );
  const d = deriveCostInputs(
    arrays,
    candidate.freePanels ?? [],
    plant.layout.manualCurrent,
    candidate.pcsUnits ?? [],
    ctx.panels,
    ctx.pcsList
  );
  return summarize(candidate.id, candidate.name, d, candidate.cost ?? {}, plant, ctx.rates, ctx.pcsList);
}

/** アクティブ候補（作業コピー＝編集中の最新内容）から概算コスト要約を計算する。 */
export function computeActiveCost(
  plant: PowerPlant,
  ctx: { panels: PanelSpec[]; pcsList: PcsSpec[]; rates: CostRates }
): CandidateCostSummary {
  const d = deriveCostInputs(
    plant.layout.arrays ?? [],
    plant.layout.freePanels ?? [],
    plant.layout.manualCurrent,
    plant.pcsUnits ?? [],
    ctx.panels,
    ctx.pcsList
  );
  const active = plant.candidates?.find((c) => c.id === plant.currentCandidateId);
  const id = plant.currentCandidateId ?? "active";
  const name = active?.name ?? "現在の内容";
  return summarize(id, name, d, plant.activeCost ?? {}, plant, ctx.rates, ctx.pcsList);
}
