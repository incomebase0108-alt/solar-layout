import { useCallback, useEffect, useState } from "react";
import type {
  PanelSpec,
  PcsSpec,
  DesignConditions,
  LayoutProject,
  PowerPlant,
  WiringPlan,
  CostRates,
} from "./types";
import {
  DEFAULT_CONDITIONS,
  EMPTY_LAYOUT,
  EMPTY_WIRING,
  DEFAULT_COST_RATES,
} from "./types";

// ============================================================
// LocalStorage ベースの簡易永続化ストア
//   - マスタ（パネル / パワコン）と設計条件を保存する
//   - 将来 API/DB に差し替えやすいよう薄いフックに閉じ込める
// ============================================================

export const KEYS = {
  panels: "solar-layout.panels",
  pcs: "solar-layout.pcs",
  conditions: "solar-layout.conditions",
  layout: "solar-layout.layout",
  plants: "solar-layout.plants",
  currentPlant: "solar-layout.currentPlant",
  costRates: "solar-layout.costRates",
} as const;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 容量超過などは無視 */
  }
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/** 実機マスタ（初回のみ投入）。値はデータシート/spec DB から。要現物確認。 */
const SEED_PANELS: PanelSpec[] = [
  {
    id: "trina_de14a_360",
    maker: "Trina Solar",
    model: "TSM-360DE14A(II)",
    lengthMm: 1960,
    widthMm: 992,
    thicknessMm: 40,
    weightKg: 22.5,
    pmaxW: 360,
    vmpV: 38.8,
    impA: 9.28,
    vocV: 47.7,
    iscA: 9.7,
    tempCoeffVocPctPerC: -0.29,
    tempCoeffPmaxPctPerC: -0.37,
    note: "既設パネル（360W単結晶）",
  },
  {
    id: "trina_neg21c_700",
    maker: "Trina Solar",
    model: "TSM-700NEG21C.20",
    lengthMm: 2384,
    widthMm: 1303,
    thicknessMm: 33,
    weightKg: 38.3,
    pmaxW: 700,
    vmpV: 44.2,
    impA: 15.84,
    vocV: 52.5,
    iscA: 15.8,
    tempCoeffVocPctPerC: -0.25,
    tempCoeffPmaxPctPerC: -0.29,
    note: "候補（700W両面・N型TOPCon。2384×1303mmの大判=要再架台）",
  },
];

const SEED_PCS: PcsSpec[] = [
  {
    id: "huawei_495_nhl2",
    maker: "Huawei",
    model: "SUN2000-4.95KTL-NHL2",
    kind: "new",
    ratedPowerKw: 4.95,
    mpptCount: 2,
    stringsPerMppt: 2,
    maxInputVoltageV: 600,
    mpptVoltageMinV: 90,
    mpptVoltageMaxV: 560,
    startVoltageV: 100,
    maxInputCurrentPerMpptA: 16,
    unitPriceYen: 75500,
    note: "8台構成 / 10回路入力・主幹ELCB付",
  },
];

export function usePanels() {
  const [panels, setPanels] = useState<PanelSpec[]>(() =>
    load(KEYS.panels, SEED_PANELS)
  );
  useEffect(() => save(KEYS.panels, panels), [panels]);

  const upsert = useCallback((p: PanelSpec) => {
    setPanels((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      if (i === -1) return [...prev, p];
      const next = prev.slice();
      next[i] = p;
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setPanels((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return { panels, upsert, remove };
}

export function usePcsList() {
  const [pcsList, setPcsList] = useState<PcsSpec[]>(() =>
    load(KEYS.pcs, SEED_PCS)
  );
  useEffect(() => save(KEYS.pcs, pcsList), [pcsList]);

  const upsert = useCallback((p: PcsSpec) => {
    setPcsList((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      if (i === -1) return [...prev, p];
      const next = prev.slice();
      next[i] = p;
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setPcsList((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return { pcsList, upsert, remove };
}

export function useConditions() {
  const [conditions, setConditions] = useState<DesignConditions>(() =>
    load(KEYS.conditions, DEFAULT_CONDITIONS)
  );
  useEffect(() => save(KEYS.conditions, conditions), [conditions]);
  return { conditions, setConditions };
}

export function useCostRates() {
  const [costRates, setCostRates] = useState<CostRates>(() =>
    load(KEYS.costRates, DEFAULT_COST_RATES)
  );
  useEffect(() => save(KEYS.costRates, costRates), [costRates]);
  return { costRates, setCostRates };
}

function newPlant(name: string, layout?: LayoutProject): PowerPlant {
  return {
    id: uid("plant"),
    name,
    address: "",
    note: "",
    outputCapKw: null,
    createdAt: Date.now(),
    layout: layout ?? { ...EMPTY_LAYOUT },
    wiring: { ...EMPTY_WIRING },
  };
}

/** 初期化：旧 単一レイアウト があれば 1 発電所へ移行。無ければ既定の発電所を作る。 */
function initialPlants(): PowerPlant[] {
  const saved = load<PowerPlant[] | null>(KEYS.plants, null);
  if (saved && saved.length) return saved;
  const legacy = load<LayoutProject | null>(KEYS.layout, null);
  if (legacy && legacy.imageDataUrl) {
    return [newPlant("発電所1", { ...EMPTY_LAYOUT, ...legacy })];
  }
  return [newPlant("発電所1")];
}

export function usePlants() {
  const [plants, setPlants] = useState<PowerPlant[]>(initialPlants);
  const [currentId, setCurrentIdState] = useState<string>(() => {
    const saved = load<string | null>(KEYS.currentPlant, null);
    return saved ?? "";
  });

  useEffect(() => save(KEYS.plants, plants), [plants]);
  useEffect(() => save(KEYS.currentPlant, currentId), [currentId]);

  // currentId が未設定/不正なら先頭に寄せる
  useEffect(() => {
    if (plants.length && !plants.some((p) => p.id === currentId)) {
      setCurrentIdState(plants[0].id);
    }
  }, [plants, currentId]);

  const current = plants.find((p) => p.id === currentId) ?? plants[0] ?? null;

  const setCurrentId = useCallback((id: string) => setCurrentIdState(id), []);

  const addPlant = useCallback((name: string) => {
    const p = newPlant(name || "新規発電所");
    setPlants((prev) => [...prev, p]);
    setCurrentIdState(p.id);
    return p.id;
  }, []);

  const updatePlant = useCallback(
    (id: string, patch: Partial<Omit<PowerPlant, "id" | "layout" | "wiring">>) => {
      setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    []
  );

  const deletePlant = useCallback((id: string) => {
    setPlants((prev) => {
      const next = prev.filter((p) => p.id !== id);
      return next.length ? next : [newPlant("発電所1")];
    });
  }, []);

  /** 現在の発電所の図面を部分更新 */
  const patchLayout = useCallback(
    (p: Partial<LayoutProject>) => {
      setPlants((prev) =>
        prev.map((pl) =>
          pl.id === currentId ? { ...pl, layout: { ...pl.layout, ...p } } : pl
        )
      );
    },
    [currentId]
  );

  /** 現在の発電所の配線設定を部分更新 */
  const patchWiring = useCallback(
    (p: Partial<WiringPlan>) => {
      setPlants((prev) =>
        prev.map((pl) =>
          pl.id === currentId ? { ...pl, wiring: { ...pl.wiring, ...p } } : pl
        )
      );
    },
    [currentId]
  );

  return {
    plants,
    current,
    currentId: current?.id ?? "",
    setCurrentId,
    addPlant,
    updatePlant,
    deletePlant,
    patchLayout,
    patchWiring,
  };
}
