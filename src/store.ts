import { useCallback, useEffect, useState } from "react";
import type { PanelSpec, PcsSpec, DesignConditions } from "./types";
import { DEFAULT_CONDITIONS } from "./types";

// ============================================================
// LocalStorage ベースの簡易永続化ストア
//   - マスタ（パネル / パワコン）と設計条件を保存する
//   - 将来 API/DB に差し替えやすいよう薄いフックに閉じ込める
// ============================================================

const KEYS = {
  panels: "solar-layout.panels",
  pcs: "solar-layout.pcs",
  conditions: "solar-layout.conditions",
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

/** 動作確認用のサンプルマスタ（初回のみ投入） */
const SEED_PANELS: PanelSpec[] = [
  {
    id: "seed_panel_1",
    maker: "サンプル",
    model: "STD-450",
    lengthMm: 2094,
    widthMm: 1038,
    thicknessMm: 35,
    weightKg: 24,
    pmaxW: 450,
    vmpV: 34.2,
    impA: 13.16,
    vocV: 41.3,
    iscA: 13.9,
    tempCoeffVocPctPerC: -0.27,
    tempCoeffPmaxPctPerC: -0.34,
    note: "サンプルデータ",
  },
];

const SEED_PCS: PcsSpec[] = [
  {
    id: "seed_pcs_1",
    maker: "サンプル",
    model: "PCS-5.5",
    kind: "existing",
    ratedPowerKw: 5.5,
    mpptCount: 2,
    stringsPerMppt: 2,
    maxInputVoltageV: 600,
    mpptVoltageMinV: 80,
    mpptVoltageMaxV: 500,
    startVoltageV: 100,
    maxInputCurrentPerMpptA: 18,
    note: "サンプルデータ",
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
