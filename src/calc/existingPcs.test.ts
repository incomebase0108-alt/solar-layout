import { describe, it, expect } from "vitest";
import { checkExistingPcs } from "./existingPcs";
import type { PanelSpec, PcsSpec, DesignConditions } from "../types";

const panel: PanelSpec = {
  id: "p", maker: "x", model: "M-450",
  lengthMm: 2094, widthMm: 1038, pmaxW: 450,
  vmpV: 34.2, impA: 13.16, vocV: 41.3, iscA: 13.9,
  tempCoeffVocPctPerC: -0.27, tempCoeffPmaxPctPerC: -0.34,
};

const pcs: PcsSpec = {
  id: "c", maker: "x", model: "C-5.5", kind: "existing",
  ratedPowerKw: 5.5, mpptCount: 2, stringsPerMppt: 2,
  maxInputVoltageV: 600, mpptVoltageMinV: 80, mpptVoltageMaxV: 500,
  maxInputCurrentPerMpptA: 18,
};

const cond: DesignConditions = { minAmbientTempC: -10, maxCellTempC: 70 };

describe("既設パワコン空き容量チェック", () => {
  it("系統が足りないと流用不可", () => {
    // 1台=2MPPT×2並列=4系統。13直列×100枚=... neededStrings=floor(800/13) 大
    const r = checkExistingPcs(panel, pcs, 1, 13, 1, 800, cond, 130);
    expect(r.totalSlots).toBe(4);
    expect(r.neededStrings).toBeGreaterThan(4);
    expect(r.verdict).toBe("infeasible");
  });

  it("収まる構成は流用OK", () => {
    // 13直列×1系統=13枚, 450W=5.85kW / 5.5kW=106% ≤130%。電流13.9A≤18A。系統1≤4
    const r = checkExistingPcs(panel, pcs, 1, 13, 1, 13, cond, 130);
    expect(r.neededStrings).toBe(1);
    expect(r.freeSlots).toBe(3);
    expect(r.verdict).toBe("ok");
  });

  it("電流オーバーは要組み替え", () => {
    // 2並列 × Isc13.9 = 27.8A > 上限18A → currentNG だが系統は足りる
    const r = checkExistingPcs(panel, pcs, 4, 13, 2, 52, cond, 300);
    const cur = r.checks.find((c) => c.label === "MPPT入力電流");
    expect(cur?.ok).toBe(false);
    expect(r.verdict).toBe("rework");
  });

  it("過積載超過は要組み替え", () => {
    // 13直列×4系統=52枚, 450W=23.4kW / 5.5kW=425% > 130%
    const r = checkExistingPcs(panel, pcs, 1, 13, 2, 52, cond, 130);
    const ov = r.checks.find((c) => c.label === "過積載率");
    expect(ov?.ok).toBe(false);
    // 系統は足りる(4=4)ので infeasible ではなく rework
    expect(r.verdict).toBe("rework");
  });

  it("空き系統数を算出する", () => {
    // 2台=8系統, 必要5系統 → 空き3
    const r = checkExistingPcs(panel, pcs, 2, 13, 1, 5 * 13, cond, 300);
    expect(r.totalSlots).toBe(8);
    expect(r.neededStrings).toBe(5);
    expect(r.freeSlots).toBe(3);
  });
});
