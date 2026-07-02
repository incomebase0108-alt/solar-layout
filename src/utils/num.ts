/**
 * 数値入力の共通ガード。
 * input の文字列を数値化し、空文字・数値化できない値は fallback に置き換える。
 * （NaN や Infinity を localStorage に保存して計算を壊さないための統一入口）
 */
export function numOr(s: string, fallback = 0): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}
