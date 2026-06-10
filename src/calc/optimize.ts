import type { PanelSpec, PanelArray } from "../types";

/** mm → m */
const m = (mm: number) => mm / 1000;

interface SlotInfo {
  /** 配列のスロット幅(m, 既設の向き基準) */
  slotW: number;
  slotH: number;
  /** この配列の入換対象セル数 */
  replaceCells: number;
  /** 既設流用セル数 */
  keepCells: number;
  /** 流用パネル(既設)の出力(W) */
  keepPanel: PanelSpec | null;
}

export interface CurrentSummary {
  totalCells: number;
  replaceCells: number;
  keepCells: number;
  /** 現状の総出力(kW, 既設パネル基準) */
  currentKw: number;
}

export interface ReplacementProposal {
  id: string;
  panel: PanelSpec;
  orientation: "portrait" | "landscape";
  /** 入換で新設する枚数 */
  newPanels: number;
  /** 流用（変更しない）枚数 */
  keptPanels: number;
  totalPanels: number;
  newKw: number;
  keptKw: number;
  totalKw: number;
  /** 現状比の出力差(kW) */
  deltaKw: number;
  /** 全配列のスロットに収まるか */
  feasible: boolean;
  /** 収まらない配列数 */
  infeasibleArrays: number;
  /** 最小寸法余裕(%, 大きいほど余裕) */
  minMarginPct: number;
  /** 出力上限(kW)を超えるか（上限未設定なら false） */
  overCap: boolean;
  /** 上限に対する余裕(kW, 正＝余裕)。上限未設定なら null */
  capHeadroomKw: number | null;
  /** ラベル（この案の強み） */
  label: string;
  notes: string[];
}

function slotOf(arr: PanelArray, panels: PanelSpec[]): SlotInfo {
  const panel = panels.find((p) => p.id === arr.panelId) ?? null;
  const lenM = m(panel?.lengthMm ?? 1700);
  const widM = m(panel?.widthMm ?? 1000);
  const slotW = arr.orientation === "portrait" ? widM : lenM;
  const slotH = arr.orientation === "portrait" ? lenM : widM;
  const removed = arr.removedCells?.length ?? 0;
  const total = arr.rows * arr.cols - removed;
  const keep = arr.keepCells?.length ?? 0;
  return {
    slotW,
    slotH,
    replaceCells: Math.max(0, total - keep),
    keepCells: keep,
    keepPanel: panel,
  };
}

export function currentSummary(
  arrays: PanelArray[],
  panels: PanelSpec[]
): CurrentSummary {
  let totalCells = 0;
  let replaceCells = 0;
  let keepCells = 0;
  let currentKw = 0;
  for (const arr of arrays) {
    const panel = panels.find((p) => p.id === arr.panelId);
    const removed = arr.removedCells?.length ?? 0;
    const cells = arr.rows * arr.cols - removed; // 撤去分を除く
    totalCells += cells;
    const keep = arr.keepCells?.length ?? 0;
    keepCells += keep;
    replaceCells += cells - keep;
    currentKw += (cells * (panel?.pmaxW ?? 0)) / 1000;
  }
  return { totalCells, replaceCells, keepCells, currentKw };
}

/**
 * 入換最適化：既設スロット（＝同サイズ〜少し大きいまで設置可）に
 * 1:1 で収まる候補パネルを総当りし、上位案を返す。
 *
 * - 「流用」指定セルは既設のまま（出力は既設パネルで計上）
 * - 候補は縦置き/横置き両方を評価
 * - tolerancePct はスロットに対する許容拡大率（少し大きいまでOK）
 */
export function optimizeReplacement(
  arrays: PanelArray[],
  panels: PanelSpec[],
  candidates: PanelSpec[],
  tolerancePct: number,
  maxProposals = 5,
  capKw: number | null = null
): { current: CurrentSummary; proposals: ReplacementProposal[] } {
  const hasCap = capKw != null && capKw > 0;
  const current = currentSummary(arrays, panels);
  const slots = arrays.map((a) => slotOf(a, panels));
  const tol = 1 + tolerancePct / 100;
  const EPS = 1e-6;

  const keptKw = slots.reduce(
    (s, sl) => s + (sl.keepCells * (sl.keepPanel?.pmaxW ?? 0)) / 1000,
    0
  );
  const keptPanels = slots.reduce((s, sl) => s + sl.keepCells, 0);

  const raw: ReplacementProposal[] = [];

  for (const panel of candidates) {
    const clen = m(panel.lengthMm);
    const cwid = m(panel.widthMm);
    for (const orientation of ["portrait", "landscape"] as const) {
      const cw = orientation === "portrait" ? cwid : clen;
      const ch = orientation === "portrait" ? clen : cwid;

      let newPanels = 0;
      let infeasibleArrays = 0;
      let minMargin = Infinity;
      for (const sl of slots) {
        if (sl.replaceCells === 0) continue;
        const fitW = cw <= sl.slotW * tol + EPS;
        const fitH = ch <= sl.slotH * tol + EPS;
        if (fitW && fitH) {
          newPanels += sl.replaceCells;
          const marginW = (sl.slotW * tol - cw) / (sl.slotW * tol);
          const marginH = (sl.slotH * tol - ch) / (sl.slotH * tol);
          minMargin = Math.min(minMargin, marginW, marginH);
        } else {
          infeasibleArrays++;
        }
      }
      if (newPanels === 0) continue; // どの配列にも入らない候補は除外

      const newKw = (newPanels * panel.pmaxW) / 1000;
      const totalKw = newKw + keptKw;
      raw.push({
        id: `${panel.id}_${orientation}`,
        panel,
        orientation,
        newPanels,
        keptPanels,
        totalPanels: newPanels + keptPanels,
        newKw,
        keptKw,
        totalKw,
        deltaKw: totalKw - current.currentKw,
        feasible: infeasibleArrays === 0,
        infeasibleArrays,
        minMarginPct: minMargin === Infinity ? 0 : minMargin * 100,
        overCap: hasCap ? totalKw > capKw! + 1e-6 : false,
        capHeadroomKw: hasCap ? capKw! - totalKw : null,
        label: "",
        notes: [],
      });
    }
  }

  // 完全フィット優先 → (上限ありなら)上限内優先 → 出力大きい順
  raw.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if (hasCap && a.overCap !== b.overCap) return a.overCap ? 1 : -1;
    return b.totalKw - a.totalKw;
  });

  const proposals = raw.slice(0, maxProposals);

  // ラベル付け（各案の強みを言語化）
  if (proposals.length) {
    const byKw = [...proposals].sort((a, b) => b.totalKw - a.totalKw);
    const byCount = [...proposals].sort((a, b) => b.totalPanels - a.totalPanels);
    const byMargin = [...proposals].sort((a, b) => b.minMarginPct - a.minMarginPct);
    // 上限内で最大の案を強調
    if (hasCap) {
      const underCap = [...proposals]
        .filter((p) => p.feasible && !p.overCap)
        .sort((a, b) => b.totalKw - a.totalKw);
      if (underCap[0]) underCap[0].label = "上限内で最大";
    }
    if (!byKw[0].label) byKw[0].label = "最大出力";
    if (!byCount[0].label) byCount[0].label = "最大枚数";
    if (!byMargin[0].label) byMargin[0].label = "余裕設置（同寸法寄り）";
    proposals.forEach((p, i) => {
      if (!p.label) p.label = `候補 ${i + 1}`;
      if (!p.feasible) {
        p.notes.push(`${p.infeasibleArrays} 配列はスロットに収まりません（その分は据置）。`);
      }
      if (p.overCap) {
        p.notes.push(
          `出力上限を ${Math.abs(p.capHeadroomKw ?? 0).toFixed(1)} kW 超過。買取単価区分に注意。`
        );
      }
      if (p.minMarginPct < 2 && p.feasible) {
        p.notes.push("寸法余裕が小さめ。実機の縁部クランプ位置に注意。");
      }
    });
  }

  return { current, proposals };
}

/**
 * 候補抽出：基準パネルに対し「同サイズ〜少し大きい」範囲のパネルを返す。
 * （極端に小さい/大きいものは除外して案を絞る）
 */
export function pickCandidates(
  basePanel: PanelSpec | null,
  panels: PanelSpec[],
  tolerancePct: number
): PanelSpec[] {
  if (!basePanel) return panels;
  const tol = 1 + tolerancePct / 100;
  const baseLong = Math.max(basePanel.lengthMm, basePanel.widthMm);
  const baseShort = Math.min(basePanel.lengthMm, basePanel.widthMm);
  return panels.filter((p) => {
    const long = Math.max(p.lengthMm, p.widthMm);
    const short = Math.min(p.lengthMm, p.widthMm);
    // 少し大きいまで(tol)許容、下限は基準の80%まで
    return (
      long <= baseLong * tol &&
      short <= baseShort * tol &&
      long >= baseLong * 0.8 &&
      short >= baseShort * 0.8
    );
  });
}
