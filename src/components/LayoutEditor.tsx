import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelSpec, LayoutProject, PanelArray, ShadowZone, FreePanel, LegendItem } from "../types";
import { cellKey, arrayGaps } from "../types";
import { shadedCellKeys, pointInZones } from "../calc/shadow";
import { summarizeLayout } from "../calc/layoutCount";
import { fileToScaledDataUrl } from "../utils/image";
import { geocodeAddress, buildSeamlessPhoto, calibrationFromScale } from "../utils/gsiMap";
import { uid } from "../store";

const KEEP_COLOR = "#22c55e"; // 流用（変更しない）パネルの色

interface Props {
  panels: PanelSpec[];
  layout: LayoutProject;
  patch: (p: Partial<LayoutProject>) => void;
  /** 発電所の住所（住所→地図の初期値） */
  defaultAddress?: string;
}

interface View {
  tx: number;
  ty: number;
  zoom: number;
}

const ARRAY_COLORS = ["#38bdf8", "#22c55e", "#f59e0b", "#a78bfa", "#f472b6"];

/** 角度を (-180, 180] に正規化 */
function normalizeDeg(d: number): number {
  let x = ((d % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
}

export function LayoutEditor({ panels, layout, patch: rawPatch, defaultAddress }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(false);

  // 元に戻す（Undo）用の履歴。変更前の layout を積む。
  // 既存の patch 呼び出しはすべてこのラッパ経由になり、自動で履歴対象になる。
  const historyRef = useRef<LayoutProject[]>([]);
  const [histLen, setHistLen] = useState(0);
  const patch = (p: Partial<LayoutProject>) => {
    historyRef.current.push(layout);
    if (historyRef.current.length > 50) historyRef.current.shift();
    setHistLen(historyRef.current.length);
    rawPatch(p);
  };
  function undo() {
    const prev = historyRef.current.pop();
    setHistLen(historyRef.current.length);
    if (prev) rawPatch(prev); // 履歴に積まずに丸ごと復元
  }
  const [view, setView] = useState<View>({ tx: 40, ty: 40, zoom: 0.5 });
  const [mode, setMode] = useState<"pan" | "calibrate" | "select" | "shadow" | "remove" | "scan" | "keeprect">("pan");
  // 範囲ドラッグで流用/入換を一括指定するときの値（true=流用にする, false=入換にする）
  const [keepRectValue, setKeepRectValue] = useState(true);

  // 住所 → 地理院タイル取得
  const [address, setAddress] = useState(defaultAddress ?? "");
  const [gsiZoom, setGsiZoom] = useState(18);
  const [gsiSpan, setGsiSpan] = useState(250); // 取得する一辺(m)目安
  const [gsiBusy, setGsiBusy] = useState(false);
  const [gsiMsg, setGsiMsg] = useState<string | null>(null);
  const [calibPts, setCalibPts] = useState<{ x: number; y: number }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFreeId, setSelectedFreeId] = useState<string | null>(null);
  const [shadowDraft, setShadowDraft] = useState<ShadowZone | null>(null);
  // スキャン：画面（スクリーン）座標の選択矩形。回転後の見た目に沿ってグリッドを作る。
  const [scanDraft, setScanDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // 配置フォーム
  const [formPanelId, setFormPanelId] = useState(panels[0]?.id ?? "");
  const [formOrient, setFormOrient] = useState<"portrait" | "landscape">("portrait");
  const [formRows, setFormRows] = useState(10);
  const [formCols, setFormCols] = useState(10);
  const [formGapX, setFormGapX] = useState(0.02); // 横方向（列の左右）の隙間 m
  const [formGapY, setFormGapY] = useState(0.02); // 縦方向（行の前後）の隙間 m

  const rot = (layout.imageRotationDeg * Math.PI) / 180;

  // --- 画像読み込み ---
  useEffect(() => {
    if (!layout.imageDataUrl) {
      imgRef.current = null;
      setImgReady(false);
      return;
    }
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgReady(true);
      fitToView(img);
    };
    img.src = layout.imageDataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.imageDataUrl]);

  const fitToView = useCallback((img: HTMLImageElement) => {
    const c = canvasRef.current;
    if (!c) return;
    const zoom = Math.min(c.width / img.width, c.height / img.height) * 0.9;
    setView({
      tx: (c.width - img.width * zoom) / 2,
      ty: (c.height - img.height * zoom) / 2,
      zoom,
    });
  }, []);

  // --- 座標変換 ---
  const screenToImage = useCallback(
    (sx: number, sy: number) => {
      const a = (sx - view.tx) / view.zoom;
      const b = (sy - view.ty) / view.zoom;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      return { x: cos * a + sin * b, y: -sin * a + cos * b };
    },
    [view, rot]
  );

  // 画像座標 → 画面座標（screenToImage の逆変換）
  const imageToScreen = useCallback(
    (px: number, py: number) => {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const rx = cos * px - sin * py;
      const ry = sin * px + cos * py;
      return { x: view.tx + view.zoom * rx, y: view.ty + view.zoom * ry };
    },
    [view, rot]
  );

  // --- スケール（px/m） ---
  const pixelsPerMeter = (() => {
    const cal = layout.calibration;
    if (!cal) return 50; // 未校正時の暫定値
    const len = Math.hypot(cal.x2 - cal.x1, cal.y2 - cal.y1);
    return cal.meters > 0 ? len / cal.meters : 50;
  })();

  // --- パネル配列の寸法 (px) ---
  const arrayPanelPx = useCallback(
    (arr: PanelArray) => {
      const panel = panels.find((p) => p.id === arr.panelId);
      const lenM = (panel?.lengthMm ?? 1700) / 1000;
      const widM = (panel?.widthMm ?? 1000) / 1000;
      const pw =
        (arr.orientation === "portrait" ? widM : lenM) * pixelsPerMeter;
      const ph =
        (arr.orientation === "portrait" ? lenM : widM) * pixelsPerMeter;
      const { gx, gy } = arrayGaps(arr);
      return { pw, ph, gapXpx: gx * pixelsPerMeter, gapYpx: gy * pixelsPerMeter };
    },
    [panels, pixelsPerMeter]
  );

  // 単独パネルの表示寸法(px)
  const freePanelPx = useCallback(
    (fp: { panelId: string; orientation: "portrait" | "landscape" }) => {
      const panel = panels.find((p) => p.id === fp.panelId);
      const lenM = (panel?.lengthMm ?? 1700) / 1000;
      const widM = (panel?.widthMm ?? 1000) / 1000;
      const pw = (fp.orientation === "portrait" ? widM : lenM) * pixelsPerMeter;
      const ph = (fp.orientation === "portrait" ? lenM : widM) * pixelsPerMeter;
      return { pw, ph };
    },
    [panels, pixelsPerMeter]
  );

  // --- 描画 ---
  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.translate(view.tx, view.ty);
    ctx.scale(view.zoom, view.zoom);
    ctx.rotate(rot);

    const img = imgRef.current;
    if (img) {
      ctx.globalAlpha = layout.imageOpacity;
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1;
    }

    const zones = layout.shadowZones ?? [];

    // パネル配列
    for (const arr of layout.arrays) {
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapXpx, gapYpx } = dims;
      ctx.save();
      ctx.translate(arr.posXpx, arr.posYpx);
      ctx.rotate((arr.rotationDeg * Math.PI) / 180);
      const selected = arr.id === selectedId;
      const keep = new Set(arr.keepCells ?? []);
      const removed = new Set(arr.removedCells ?? []);
      const shaded = shadedCellKeys(arr, dims, zones);
      for (let r = 0; r < arr.rows; r++) {
        for (let col = 0; col < arr.cols; col++) {
          const x = col * (pw + gapXpx);
          const y = r * (ph + gapYpx);
          // 撤去セルは空き枠（破線）で表示し、カウントしない
          if (removed.has(cellKey(r, col))) {
            ctx.strokeStyle = "#64748b";
            ctx.lineWidth = 1 / view.zoom;
            ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
            ctx.strokeRect(x, y, pw, ph);
            ctx.setLineDash([]);
            continue;
          }
          const isKeep = keep.has(cellKey(r, col));
          ctx.fillStyle = (isKeep ? KEEP_COLOR : arr.color) + (isKeep ? "66" : "44");
          ctx.strokeStyle = isKeep ? KEEP_COLOR : selected ? "#fff" : arr.color;
          ctx.lineWidth = (isKeep ? 1.5 : selected ? 2 : 1) / view.zoom;
          ctx.fillRect(x, y, pw, ph);
          ctx.strokeRect(x, y, pw, ph);
          // 影に入るセルは暗くオーバーレイ
          if (shaded.has(cellKey(r, col))) {
            ctx.fillStyle = "rgba(15,23,42,0.55)";
            ctx.fillRect(x, y, pw, ph);
          }
        }
      }
      // 選択枠
      if (selected) {
        const totalW = arr.cols * pw + (arr.cols - 1) * gapXpx;
        const totalH = arr.rows * ph + (arr.rows - 1) * gapYpx;
        ctx.strokeStyle = "#fff";
        ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
        ctx.strokeRect(-4, -4, totalW + 8, totalH + 8);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // 単独パネル
    for (const fp of layout.freePanels ?? []) {
      const { pw, ph } = freePanelPx(fp);
      ctx.save();
      ctx.translate(fp.posXpx, fp.posYpx);
      ctx.rotate((fp.rotationDeg * Math.PI) / 180);
      const sel = fp.id === selectedFreeId;
      ctx.fillStyle = fp.color + "66";
      ctx.strokeStyle = sel ? "#fff" : fp.color;
      ctx.lineWidth = (sel ? 2.5 : 1.5) / view.zoom;
      ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
      ctx.strokeRect(-pw / 2, -ph / 2, pw, ph);
      // 影
      const ctr = { x: fp.posXpx, y: fp.posYpx };
      if (pointInZones(ctr.x, ctr.y, zones)) {
        ctx.fillStyle = "rgba(15,23,42,0.55)";
        ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
      }
      if (sel) {
        ctx.strokeStyle = "#fff";
        ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
        ctx.strokeRect(-pw / 2 - 4, -ph / 2 - 4, pw + 8, ph + 8);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // 校正線
    const cal = layout.calibration;
    if (cal) {
      drawLine(ctx, cal.x1, cal.y1, cal.x2, cal.y2, "#f43f5e", view.zoom);
    }
    if (calibPts.length === 1) {
      ctx.fillStyle = "#f43f5e";
      ctx.beginPath();
      ctx.arc(calibPts[0].x, calibPts[0].y, 5 / view.zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // 影ゾーン
    for (const z of zones) {
      ctx.fillStyle = "rgba(15,23,42,0.35)";
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 1.5 / view.zoom;
      ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.setLineDash([]);
    }
    if (shadowDraft) {
      ctx.fillStyle = "rgba(14,165,233,0.2)";
      ctx.fillRect(shadowDraft.x, shadowDraft.y, shadowDraft.w, shadowDraft.h);
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 1.5 / view.zoom;
      ctx.strokeRect(shadowDraft.x, shadowDraft.y, shadowDraft.w, shadowDraft.h);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // スキャンの選択矩形（画面座標＝回転後の見た目に沿う）
    if (scanDraft) {
      ctx.fillStyle = "rgba(56,189,248,0.18)";
      ctx.fillRect(scanDraft.x, scanDraft.y, scanDraft.w, scanDraft.h);
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(scanDraft.x, scanDraft.y, scanDraft.w, scanDraft.h);
      ctx.setLineDash([]);
    }
  }, [view, rot, layout, selectedId, selectedFreeId, calibPts, shadowDraft, scanDraft, arrayPanelPx, freePanelPx]);

  useEffect(() => {
    draw();
  }, [draw, imgReady]);

  // キャンバスサイズを親に合わせる
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const resize = () => {
      const parent = c.parentElement;
      if (!parent) return;
      c.width = parent.clientWidth;
      c.height = 620;
      draw();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draw]);

  // --- マウス操作 ---
  const dragRef = useRef<{
    kind: "pan" | "array" | "free";
    startSx: number;
    startSy: number;
    orig: { tx: number; ty: number } | { px: number; py: number };
    arrId?: string;
    freeId?: string;
  } | null>(null);
  const shadowStartRef = useRef<{ x: number; y: number } | null>(null);
  // スキャンの開始点（画面座標）
  const scanStartRef = useRef<{ sx: number; sy: number } | null>(null);

  function hitFree(ix: number, iy: number): FreePanel | null {
    const fps = layout.freePanels ?? [];
    for (let i = fps.length - 1; i >= 0; i--) {
      const fp = fps[i];
      const { pw, ph } = freePanelPx(fp);
      const dx = ix - fp.posXpx;
      const dy = iy - fp.posYpx;
      const a = (-fp.rotationDeg * Math.PI) / 180;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      if (Math.abs(lx) <= pw / 2 && Math.abs(ly) <= ph / 2) return fp;
    }
    return null;
  }

  function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): ShadowZone {
    return {
      id: "draft",
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  function hitArray(ix: number, iy: number): PanelArray | null {
    for (let i = layout.arrays.length - 1; i >= 0; i--) {
      const arr = layout.arrays[i];
      const { pw, ph, gapXpx, gapYpx } = arrayPanelPx(arr);
      const totalW = arr.cols * pw + (arr.cols - 1) * gapXpx;
      const totalH = arr.rows * ph + (arr.rows - 1) * gapYpx;
      const dx = ix - arr.posXpx;
      const dy = iy - arr.posYpx;
      const a = (-arr.rotationDeg * Math.PI) / 180;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      if (lx >= 0 && lx <= totalW && ly >= 0 && ly <= totalH) return arr;
    }
    return null;
  }

  /** 画像座標から (配列, 行, 列) を求める。なければ null。 */
  function hitCell(ix: number, iy: number): { arr: PanelArray; r: number; col: number } | null {
    for (let i = layout.arrays.length - 1; i >= 0; i--) {
      const arr = layout.arrays[i];
      const { pw, ph, gapXpx, gapYpx } = arrayPanelPx(arr);
      const dx = ix - arr.posXpx;
      const dy = iy - arr.posYpx;
      const a = (-arr.rotationDeg * Math.PI) / 180;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      const col = Math.floor(lx / (pw + gapXpx));
      const r = Math.floor(ly / (ph + gapYpx));
      if (r >= 0 && r < arr.rows && col >= 0 && col < arr.cols) {
        // セル内（隙間でない）か確認
        const cx = lx - col * (pw + gapXpx);
        const cy = ly - r * (ph + gapYpx);
        if (cx <= pw && cy <= ph) return { arr, r, col };
      }
    }
    return null;
  }

  function toggleCell(arr: PanelArray, r: number, col: number) {
    const key = cellKey(r, col);
    const keep = new Set(arr.keepCells ?? []);
    if (keep.has(key)) keep.delete(key);
    else keep.add(key);
    patch({
      arrays: layout.arrays.map((a) =>
        a.id === arr.id ? { ...a, keepCells: [...keep] } : a
      ),
    });
  }

  function toggleRemove(arr: PanelArray, r: number, col: number) {
    const key = cellKey(r, col);
    const removed = new Set(arr.removedCells ?? []);
    if (removed.has(key)) removed.delete(key);
    else removed.add(key);
    patch({
      arrays: layout.arrays.map((a) =>
        a.id === arr.id ? { ...a, removedCells: [...removed] } : a
      ),
    });
  }

  function setAllCells(arrId: string, keepAll: boolean) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (a.id !== arrId) return a;
        if (!keepAll) return { ...a, keepCells: [] };
        const all: string[] = [];
        for (let r = 0; r < a.rows; r++)
          for (let c = 0; c < a.cols; c++) all.push(cellKey(r, c));
        return { ...a, keepCells: all };
      }),
    });
  }

  function invertCells(arrId: string) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (a.id !== arrId) return a;
        const keep = new Set(a.keepCells ?? []);
        const next: string[] = [];
        for (let r = 0; r < a.rows; r++)
          for (let c = 0; c < a.cols; c++) {
            const k = cellKey(r, c);
            if (!keep.has(k)) next.push(k);
          }
        return { ...a, keepCells: next };
      }),
    });
  }

  function onMouseDown(e: React.MouseEvent) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (mode === "shadow") {
      shadowStartRef.current = screenToImage(sx, sy);
      return;
    }

    if (mode === "scan" || mode === "keeprect") {
      // 画面座標で記録（回転後の見た目に沿って囲む）。scan と 範囲流用 で共用。
      scanStartRef.current = { sx, sy };
      return;
    }

    if (mode === "select") {
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell) {
        setSelectedId(cell.arr.id);
        toggleCell(cell.arr, cell.r, cell.col);
      }
      return;
    }

    if (mode === "remove") {
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell) {
        setSelectedId(cell.arr.id);
        toggleRemove(cell.arr, cell.r, cell.col);
      }
      return;
    }

    if (mode === "calibrate") {
      const p = screenToImage(sx, sy);
      const next = [...calibPts, p];
      if (next.length === 2) {
        const m = prompt("この2点間の実際の距離 (m) を入力してください", "10");
        const meters = m ? Number(m) : NaN;
        if (meters > 0) {
          patch({
            calibration: { x1: next[0].x, y1: next[0].y, x2: next[1].x, y2: next[1].y, meters },
          });
        }
        setCalibPts([]);
        setMode("pan");
      } else {
        setCalibPts(next);
      }
      return;
    }

    const img = screenToImage(sx, sy);
    const free = hitFree(img.x, img.y);
    if (free) {
      setSelectedFreeId(free.id);
      setSelectedId(null);
      dragRef.current = {
        kind: "free",
        startSx: sx,
        startSy: sy,
        orig: { px: free.posXpx, py: free.posYpx },
        freeId: free.id,
      };
      return;
    }
    const hit = hitArray(img.x, img.y);
    if (hit) {
      setSelectedId(hit.id);
      setSelectedFreeId(null);
      dragRef.current = {
        kind: "array",
        startSx: sx,
        startSy: sy,
        orig: { px: hit.posXpx, py: hit.posYpx },
        arrId: hit.id,
      };
    } else {
      setSelectedId(null);
      setSelectedFreeId(null);
      dragRef.current = {
        kind: "pan",
        startSx: sx,
        startSy: sy,
        orig: { tx: view.tx, ty: view.ty },
      };
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // 影ゾーンのドラッグ矩形描画（画像座標）
    if (mode === "shadow" && shadowStartRef.current) {
      const cur = screenToImage(sx, sy);
      setShadowDraft(rectFrom(shadowStartRef.current, cur));
      return;
    }

    // スキャン／範囲流用のドラッグ矩形描画（画面座標＝回転後の見た目に沿う）
    if ((mode === "scan" || mode === "keeprect") && scanStartRef.current) {
      const s = scanStartRef.current;
      setScanDraft({
        x: Math.min(s.sx, sx),
        y: Math.min(s.sy, sy),
        w: Math.abs(sx - s.sx),
        h: Math.abs(sy - s.sy),
      });
      return;
    }

    const d = dragRef.current;
    if (!d) return;
    const dsx = sx - d.startSx;
    const dsy = sy - d.startSy;

    const orig = d.orig;
    if (d.kind === "pan" && "tx" in orig) {
      setView((v) => ({ ...v, tx: orig.tx + dsx, ty: orig.ty + dsy }));
    } else if (d.kind === "array" && d.arrId && "px" in orig) {
      // 画面移動量を画像座標の移動量へ（回転とズームを戻す）
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const idx = (cos * dsx + sin * dsy) / view.zoom;
      const idy = (-sin * dsx + cos * dsy) / view.zoom;
      patch({
        arrays: layout.arrays.map((a) =>
          a.id === d.arrId
            ? { ...a, posXpx: orig.px + idx, posYpx: orig.py + idy }
            : a
        ),
      });
    } else if (d.kind === "free" && d.freeId && "px" in orig) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const idx = (cos * dsx + sin * dsy) / view.zoom;
      const idy = (-sin * dsx + cos * dsy) / view.zoom;
      patch({
        freePanels: (layout.freePanels ?? []).map((f) =>
          f.id === d.freeId
            ? { ...f, posXpx: orig.px + idx, posYpx: orig.py + idy }
            : f
        ),
      });
    }
  }

  function onMouseUp() {
    dragRef.current = null;
    // 影ゾーンの確定
    if (mode === "shadow" && shadowStartRef.current) {
      shadowStartRef.current = null;
      if (shadowDraft && shadowDraft.w > 4 && shadowDraft.h > 4) {
        const zone: ShadowZone = { ...shadowDraft, id: uid("shadow") };
        patch({ shadowZones: [...(layout.shadowZones ?? []), zone] });
      }
      setShadowDraft(null);
    }
    // スキャン／範囲流用：画面で囲んだ範囲を確定
    if ((mode === "scan" || mode === "keeprect") && scanStartRef.current) {
      scanStartRef.current = null;
      if (scanDraft && scanDraft.w > 4 && scanDraft.h > 4) {
        if (mode === "scan") scanFromScreenRect(scanDraft);
        else applyKeepRect(scanDraft, keepRectValue);
      }
      setScanDraft(null);
    }
  }

  /**
   * 画面で囲んだ範囲内のセルをまとめて流用/入換にする。
   * value=true で流用（緑）に、false で入換に。撤去セルは対象外。
   */
  function applyKeepRect(r: { x: number; y: number; w: number; h: number }, value: boolean) {
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    const arrays = layout.arrays.map((arr) => {
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapXpx, gapYpx } = dims;
      const a = (arr.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const keep = new Set(arr.keepCells ?? []);
      const removed = new Set(arr.removedCells ?? []);
      for (let row = 0; row < arr.rows; row++) {
        for (let col = 0; col < arr.cols; col++) {
          const k = cellKey(row, col);
          if (removed.has(k)) continue;
          // セル中心の画像座標（配列の回転を反映）→ 画面座標
          const lx = col * (pw + gapXpx) + pw / 2;
          const ly = row * (ph + gapYpx) + ph / 2;
          const ix = arr.posXpx + cos * lx - sin * ly;
          const iy = arr.posYpx + sin * lx + cos * ly;
          const s = imageToScreen(ix, iy);
          if (s.x >= r.x && s.x <= x2 && s.y >= r.y && s.y <= y2) {
            if (value) keep.add(k);
            else keep.delete(k);
          }
        }
      }
      return { ...arr, keepCells: [...keep] };
    });
    patch({ arrays });
  }

  /**
   * 画面（スクリーン）で囲んだ矩形から、実寸÷パネル寸法で行×列を自動計算し配列を生成。
   * 生成する配列は画面の見た目に沿わせる（rotationDeg = -画像回転）ので、
   * 「写真を回してパネル列を水平にする → スキャン」で実パネルにグリッドが一致する。
   * スケール校正が前提（地理院地図なら自動設定済み）。
   */
  function scanFromScreenRect(r: { x: number; y: number; w: number; h: number }) {
    if (!formPanelId) {
      alert("先に下の「パネル」を選択してください");
      return;
    }
    if (!layout.calibration) {
      alert("スケール未設定です。地理院地図の取得か、基準寸法の設定を先に行ってください");
      return;
    }
    const panel = panels.find((p) => p.id === formPanelId);
    if (!panel) return;
    const lenM = panel.lengthMm / 1000;
    const widM = panel.widthMm / 1000;
    const pwM = formOrient === "portrait" ? widM : lenM; // 1枚の横幅(m)
    const phM = formOrient === "portrait" ? lenM : widM; // 1枚の高さ(m)
    if (pwM <= 0 || phM <= 0) {
      alert("選択したパネルの寸法が未登録です");
      return;
    }
    // 画面px → メートル（zoom: 画面px/画像px、pixelsPerMeter: 画像px/m）
    const mPerScreenPx = 1 / (view.zoom * pixelsPerMeter);
    const realW = r.w * mPerScreenPx;
    const realH = r.h * mPerScreenPx;
    const cols = Math.max(1, Math.floor((realW + formGapX) / (pwM + formGapX)));
    const rows = Math.max(1, Math.floor((realH + formGapY) / (phM + formGapY)));
    // 配列の原点（左上）は画面矩形の左上に対応する画像座標
    const tl = screenToImage(r.x, r.y);
    // 画面で水平に見えるよう、画像回転を打ち消す角度を配列に持たせる
    const arrRot = normalizeDeg(-layout.imageRotationDeg);
    const arr: PanelArray = {
      id: uid("arr"),
      panelId: formPanelId,
      orientation: formOrient,
      rows,
      cols,
      gapM: formGapX,
      gapYm: formGapY,
      posXpx: tl.x,
      posYpx: tl.y,
      rotationDeg: arrRot,
      color: ARRAY_COLORS[layout.arrays.length % ARRAY_COLORS.length],
    };
    patch({ arrays: [...layout.arrays, arr] });
    setSelectedId(arr.id);
  }

  // ホイールズーム：React の onWheel は passive 登録で preventDefault が効かず
  // ページがスクロールしてしまうため、ネイティブの非passiveリスナーで実装する。
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault(); // ページスクロールを止める
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((v) => {
        const nz = Math.max(0.05, Math.min(8, v.zoom * factor));
        // カーソル位置を固定してズーム
        const tx = sx - (sx - v.tx) * (nz / v.zoom);
        const ty = sy - (sy - v.ty) * (nz / v.zoom);
        return { tx, ty, zoom: nz };
      });
    };
    c.addEventListener("wheel", handler, { passive: false });
    return () => c.removeEventListener("wheel", handler);
  }, [layout.imageDataUrl]); // キャンバスがマウントされた後に確実に貼る

  /** ＋/− ボタン用：キャンバス中心を固定して拡大縮小 */
  function zoomByCentered(factor: number) {
    const c = canvasRef.current;
    if (!c) return;
    const sx = c.width / 2;
    const sy = c.height / 2;
    setView((v) => {
      const nz = Math.max(0.05, Math.min(8, v.zoom * factor));
      const tx = sx - (sx - v.tx) * (nz / v.zoom);
      const ty = sy - (sy - v.ty) * (nz / v.zoom);
      return { tx, ty, zoom: nz };
    });
  }

  // --- 操作ハンドラ ---
  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await fileToScaledDataUrl(file);
      patch({ imageDataUrl: url, calibration: null, arrays: [] });
    } catch {
      alert("画像の読み込みに失敗しました");
    }
    e.target.value = "";
  }

  /** 住所を地理院ジオコーディング→航空写真を取得し、背景＋スケールを自動設定 */
  async function loadFromAddress() {
    const q = address.trim();
    if (!q) {
      setGsiMsg("住所を入力してください");
      return;
    }
    setGsiBusy(true);
    setGsiMsg("住所を検索中…");
    try {
      const geo = await geocodeAddress(q);
      if (!geo) {
        setGsiMsg("住所が見つかりませんでした。表記を変えて再検索してください。");
        return;
      }
      setGsiMsg(`地図を取得中…（${geo.label}）`);
      const photo = await buildSeamlessPhoto(geo.lat, geo.lon, gsiZoom, gsiSpan);
      const cal = calibrationFromScale(photo.metersPerPixel, photo.heightPx, 50);
      // 既存の配置・影はクリア（新しい台紙のため）。校正は自動設定。
      patch({
        imageDataUrl: photo.dataUrl,
        calibration: cal,
        arrays: [],
        freePanels: [],
        shadowZones: [],
        imageRotationDeg: 0,
        imageOpacity: 1,
      });
      setGsiMsg(
        `取得完了：${geo.label}｜ズーム${photo.zoom}｜スケール ${(1 / photo.metersPerPixel).toFixed(1)} px/m（自動校正済み・出典:地理院タイル）`
      );
    } catch (err) {
      setGsiMsg(err instanceof Error ? err.message : "地図の取得に失敗しました");
    } finally {
      setGsiBusy(false);
    }
  }

  /**
   * 画像を回転する。画面中心にある画像上の点を軸に回す（view を補正）ので、
   * 拡大中でも見ている被写体が画面外へ飛ばない。
   */
  function setRotation(newDeg: number) {
    const c = canvasRef.current;
    const deg = ((newDeg % 360) + 360) % 360;
    if (!c) {
      patch({ imageRotationDeg: deg });
      return;
    }
    const Cx = c.width / 2;
    const Cy = c.height / 2;
    const rot0 = (layout.imageRotationDeg * Math.PI) / 180;
    const rot1 = (deg * Math.PI) / 180;
    // 現在、画面中心にある画像上の点 P0 を求める（screenToImage と同じ式）
    const a = (Cx - view.tx) / view.zoom;
    const b = (Cy - view.ty) / view.zoom;
    const p0x = Math.cos(rot0) * a + Math.sin(rot0) * b;
    const p0y = -Math.sin(rot0) * a + Math.cos(rot0) * b;
    // 新しい回転で P0 が画面中心に来るよう平行移動を補正
    const tx = Cx - view.zoom * (Math.cos(rot1) * p0x - Math.sin(rot1) * p0y);
    const ty = Cy - view.zoom * (Math.sin(rot1) * p0x + Math.cos(rot1) * p0y);
    setView((v) => ({ ...v, tx, ty }));
    patch({ imageRotationDeg: deg });
  }

  function rotate(delta: number) {
    setRotation(layout.imageRotationDeg + delta);
  }

  function exportPng() {
    const c = canvasRef.current;
    if (!c) return;
    draw(); // 最新状態で描画してから書き出し
    const url = c.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `layout_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  }

  function addArray() {
    if (!formPanelId) {
      alert("パネルを登録・選択してください");
      return;
    }
    const center = screenToImage(
      (canvasRef.current?.width ?? 600) / 2,
      (canvasRef.current?.height ?? 600) / 2
    );
    const arr: PanelArray = {
      id: uid("arr"),
      panelId: formPanelId,
      orientation: formOrient,
      rows: formRows,
      cols: formCols,
      gapM: formGapX,
      gapYm: formGapY,
      posXpx: center.x,
      posYpx: center.y,
      // 画面の見た目（回転後）に合わせる。スキャンのグリッドと同じ向きになる。
      rotationDeg: normalizeDeg(-layout.imageRotationDeg),
      color: ARRAY_COLORS[layout.arrays.length % ARRAY_COLORS.length],
    };
    patch({ arrays: [...layout.arrays, arr] });
    setSelectedId(arr.id);
  }

  function updateArray(id: string, p: Partial<PanelArray>) {
    patch({ arrays: layout.arrays.map((a) => (a.id === id ? { ...a, ...p } : a)) });
  }
  function deleteArray(id: string) {
    patch({ arrays: layout.arrays.filter((a) => a.id !== id) });
    if (selectedId === id) setSelectedId(null);
  }

  /** 単独パネル（free panel）だけを全消去。Undoで戻せる。 */
  function clearFreePanels() {
    if ((layout.freePanels?.length ?? 0) === 0) return;
    if (!confirm(`単独パネル ${layout.freePanels?.length ?? 0} 枚をすべて消去します。よろしいですか？（「戻す」で復元可）`)) return;
    patch({ freePanels: [] });
    setSelectedFreeId(null);
  }

  /** 配置した配列・単独パネル（＝画面上のグリッド線）を全消去。Undoで戻せる。 */
  function clearAllArrays() {
    if (layout.arrays.length === 0 && (layout.freePanels?.length ?? 0) === 0) return;
    if (!confirm("配置したパネル配列をすべて消去します。よろしいですか？（「戻す」で復元可）")) return;
    patch({ arrays: [], freePanels: [] });
    setSelectedId(null);
    setSelectedFreeId(null);
  }

  function addFreePanel() {
    if (!formPanelId) {
      alert("パネルを登録・選択してください");
      return;
    }
    const center = screenToImage(
      (canvasRef.current?.width ?? 600) / 2,
      (canvasRef.current?.height ?? 600) / 2
    );
    const fp: FreePanel = {
      id: uid("free"),
      panelId: formPanelId,
      orientation: formOrient,
      posXpx: center.x,
      posYpx: center.y,
      // 画面の見た目（回転後）に合わせる
      rotationDeg: normalizeDeg(-layout.imageRotationDeg),
      color: "#f472b6",
    };
    patch({ freePanels: [...(layout.freePanels ?? []), fp] });
    setSelectedFreeId(fp.id);
    setSelectedId(null);
  }
  function updateFree(id: string, p: Partial<FreePanel>) {
    patch({ freePanels: (layout.freePanels ?? []).map((f) => (f.id === id ? { ...f, ...p } : f)) });
  }
  function deleteFree(id: string) {
    patch({ freePanels: (layout.freePanels ?? []).filter((f) => f.id !== id) });
    if (selectedFreeId === id) setSelectedFreeId(null);
  }

  const selected = layout.arrays.find((a) => a.id === selectedId) ?? null;
  const selectedFree = (layout.freePanels ?? []).find((f) => f.id === selectedFreeId) ?? null;
  const freeCount = (layout.freePanels ?? []).length;
  const removedTotal = layout.arrays.reduce((s, a) => s + (a.removedCells?.length ?? 0), 0);
  const arrayCells = layout.arrays.reduce((s, a) => s + a.rows * a.cols, 0);
  const totalPanels = arrayCells - removedTotal + freeCount;
  const keepTotal = layout.arrays.reduce((s, a) => s + (a.keepCells?.length ?? 0), 0);
  const zones = layout.shadowZones ?? [];
  const shadedTotal = layout.arrays.reduce(
    (s, a) => s + shadedCellKeys(a, arrayPanelPx(a), zones).size,
    0
  );

  function deleteZone(id: string) {
    patch({ shadowZones: zones.filter((z) => z.id !== id) });
  }
  function clearZones() {
    patch({ shadowZones: [] });
  }

  /** いまの構成を「現状（基準）」として凍結保存する（現況＝既存配列の全数）。 */
  function registerBaseline() {
    const sum = summarizeLayout(layout, panels, "genkyo");
    if (sum.totalPanels === 0) {
      alert("現況の既存パネルがありません。配列に『流用』を指定してから登録してください（流用マークのある配列＝既存と判定します）。");
      return;
    }
    if (
      layout.baseline &&
      !confirm("すでに基準が登録されています。今の構成で上書きしますか？")
    )
      return;
    patch({ baseline: { ...sum, registeredAt: Date.now() } });
  }

  function clearBaseline() {
    if (!confirm("登録した基準を削除します。よろしいですか？（戻すで復元可）")) return;
    patch({ baseline: null });
  }

  // --- 凡例（写真の下の状況説明） ---
  const legend = layout.legend ?? [];
  /** 図面から凡例を自動生成（流用＝既設・緑／入換・新規＝新設・青、型式ごと）。 */
  function genLegend() {
    const map = new Map<string, { existing: number; added: number; orient: string; name: string; w: number }>();
    const touch = (panelId: string, orient: string) => {
      const p = panels.find((x) => x.id === panelId);
      const key = panelId;
      const cur = map.get(key) ?? {
        existing: 0,
        added: 0,
        orient,
        name: `${p?.maker ?? ""} ${p?.model ?? ""}`.trim() || "未登録パネル",
        w: p?.pmaxW ?? 0,
      };
      map.set(key, cur);
      return cur;
    };
    // 配列単位で判定：流用マークあり＝既設（流用数）／無し＝新設（全数）。
    // 既存配列の入換セル（流用でない分）は撤去されるため凡例には出さない。
    for (const a of layout.arrays) {
      const keepN = a.keepCells?.length ?? 0;
      const full = a.rows * a.cols - (a.removedCells?.length ?? 0);
      const cur = touch(a.panelId, a.orientation === "portrait" ? "縦" : "横");
      if (keepN > 0) cur.existing += keepN;
      else cur.added += full;
    }
    for (const f of layout.freePanels ?? []) {
      const cur = touch(f.panelId, f.orientation === "portrait" ? "縦" : "横");
      cur.added++;
    }
    const items: LegendItem[] = [];
    for (const v of map.values()) {
      if (v.existing > 0)
        items.push({ id: uid("lg"), color: KEEP_COLOR, label: `${v.name} ${v.w}W ${v.existing}枚 既設 ${v.orient}` });
      if (v.added > 0)
        items.push({ id: uid("lg"), color: "#38bdf8", label: `${v.name} ${v.w}W ${v.added}枚 新設 ${v.orient}` });
    }
    if (items.length === 0) {
      alert("配列がありません。先にパネルを配置してください。");
      return;
    }
    patch({ legend: items });
  }
  function addLegend() {
    patch({ legend: [...legend, { id: uid("lg"), color: "#22c55e", label: "" }] });
  }
  function updateLegend(id: string, p: Partial<LegendItem>) {
    patch({ legend: legend.map((l) => (l.id === id ? { ...l, ...p } : l)) });
  }
  function removeLegend(id: string) {
    patch({ legend: legend.filter((l) => l.id !== id) });
  }

  function setAllPlant(keepAll: boolean) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (!keepAll) return { ...a, keepCells: [] };
        const all: string[] = [];
        for (let r = 0; r < a.rows; r++)
          for (let c = 0; c < a.cols; c++) all.push(cellKey(r, c));
        return { ...a, keepCells: all };
      }),
    });
  }

  return (
    <>
      <div className="card">
        <h2>現況レイアウト（航空写真トレース）</h2>

        <h3>住所から地図を取得（地理院タイル）</h3>
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>住所</label>
            <input
              type="text"
              value={address}
              placeholder="例）愛知県西尾市吉良町吉田西川畔"
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !gsiBusy) loadFromAddress(); }}
            />
          </div>
          <div className="field" style={{ width: 120 }}>
            <label>詳細さ（ズーム）</label>
            <select value={gsiZoom} onChange={(e) => setGsiZoom(Number(e.target.value))}>
              <option value={16}>16（広い・粗い）</option>
              <option value={17}>17</option>
              <option value={18}>18（最も詳細）</option>
            </select>
          </div>
          <div className="field" style={{ width: 130 }}>
            <label>範囲・一辺(m)</label>
            <input
              type="number"
              min={50}
              step={50}
              value={gsiSpan}
              onChange={(e) => setGsiSpan(Number(e.target.value))}
            />
          </div>
          <button className="btn small" onClick={loadFromAddress} disabled={gsiBusy}>
            {gsiBusy ? "取得中…" : "地図を取得"}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          住所→航空写真を自動取得。<strong>スケールも自動設定</strong>されるので基準寸法の手入力は不要です。
          範囲を広げると視野が広く・詳細さは粗くなります。出典：地理院タイル（国土地理院）。
          {gsiMsg && (
            <div style={{ marginTop: 4, color: "#38bdf8" }}>{gsiMsg}</div>
          )}
        </div>

        <h3>または写真をアップロード</h3>
        <div className="row">
          <label className="btn secondary small" style={{ cursor: "pointer" }}>
            写真をアップロード
            <input type="file" accept="image/*" onChange={onUpload} style={{ display: "none" }} />
          </label>
          {imgReady && (
            <button className="btn secondary small" onClick={() => imgRef.current && fitToView(imgRef.current)}>
              全体表示
            </button>
          )}
          {layout.imageDataUrl && (
            <button className="btn secondary small" onClick={exportPng}>
              図面をPNG保存
            </button>
          )}
          <span className="spacer" />
          <span className="hint">
            {layout.calibration
              ? `スケール: ${pixelsPerMeter.toFixed(1)} px/m`
              : "未校正（基準寸法を設定してください）"}
            ／ 合計 {totalPanels} 枚（流用 {keepTotal}{removedTotal ? ` / 撤去 ${removedTotal}` : ""}{freeCount ? ` / 追加 ${freeCount}` : ""}）
          </span>
        </div>

        {!layout.imageDataUrl && (
          <div className="empty">住所から地図を取得するか、写真をアップロードすると、ここに表示されます。</div>
        )}

        {layout.imageDataUrl && (
          <>
            <h3>写真の向き・表示</h3>
            <div className="row">
              <button className="btn secondary small" onClick={() => rotate(-90)}>⟲ 90°</button>
              <button className="btn secondary small" onClick={() => rotate(90)}>⟳ 90°</button>
              <button className="btn secondary small" onClick={() => rotate(-1)}>⟲ 1°</button>
              <button className="btn secondary small" onClick={() => rotate(1)}>⟳ 1°</button>
              <div className="field" style={{ flex: 1, minWidth: 200 }}>
                <label>向き（回転）: {layout.imageRotationDeg}°</label>
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={layout.imageRotationDeg}
                  onChange={(e) => setRotation(Number(e.target.value))}
                />
              </div>
              <div className="field" style={{ width: 160 }}>
                <label>背景の透過度: {(layout.imageOpacity * 100) | 0}%</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={layout.imageOpacity}
                  onChange={(e) => patch({ imageOpacity: Number(e.target.value) })}
                />
              </div>
            </div>

            <h3>スケール校正</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "calibrate" ? "" : "secondary"}`}
                onClick={() => {
                  setMode(mode === "calibrate" ? "pan" : "calibrate");
                  setCalibPts([]);
                }}
              >
                {mode === "calibrate" ? "基準線：2点をクリック中…" : "基準寸法を設定"}
              </button>
              {layout.calibration && (
                <button className="btn secondary small" onClick={() => patch({ calibration: null })}>
                  校正クリア
                </button>
              )}
              <span className="hint">
                既知の長さ（パネル1枚の実寸や敷地の一辺）の両端をクリック→実長(m)を入力
              </span>
            </div>

            <h3>流用パネルの指定（変更しないパネル）</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "select" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "select" ? "pan" : "select")}
              >
                {mode === "select" ? "選択中：パネルをクリックで切替" : "流用/入換を指定"}
              </button>
              <button
                className={`btn small ${mode === "keeprect" && keepRectValue ? "" : "secondary"}`}
                onClick={() => {
                  setKeepRectValue(true);
                  setMode(mode === "keeprect" && keepRectValue ? "pan" : "keeprect");
                }}
              >
                {mode === "keeprect" && keepRectValue ? "範囲流用中：ドラッグで囲む" : "▦ 範囲を流用（ドラッグ）"}
              </button>
              <button
                className={`btn small ${mode === "keeprect" && !keepRectValue ? "" : "secondary"}`}
                onClick={() => {
                  setKeepRectValue(false);
                  setMode(mode === "keeprect" && !keepRectValue ? "pan" : "keeprect");
                }}
              >
                {mode === "keeprect" && !keepRectValue ? "範囲入換中：ドラッグで囲む" : "▦ 範囲を入換（ドラッグ）"}
              </button>
              <button className="btn secondary small" onClick={() => setAllPlant(true)}>
                全部を流用
              </button>
              <button className="btn secondary small" onClick={() => setAllPlant(false)}>
                全部を入換
              </button>
              <span className="hint">
                <span style={{ color: KEEP_COLOR }}>■</span> 緑＝流用（変更しない）／ その他＝入換対象。<br />
                <strong>範囲ドラッグ</strong>でまとめて指定（下段だけ入換など）、または個別クリックで1枚ずつ切替。
              </span>
            </div>

            <h3>パネルの撤去（フェンス離隔など）</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "remove" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "remove" ? "pan" : "remove")}
              >
                {mode === "remove" ? "撤去モード：パネルをクリックで撤去/復活" : "パネルを撤去/復活"}
              </button>
              <span className="hint">
                クリックでそのパネルを取り外し（破線の空き枠）。もう一度で復活。撤去分は枚数から除外。
              </span>
            </div>

            <h3>影ゾーン</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "shadow" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "shadow" ? "pan" : "shadow")}
              >
                {mode === "shadow" ? "描画中：ドラッグで影エリアを囲む" : "影ゾーンを描く"}
              </button>
              {zones.length > 0 && (
                <button className="btn secondary small" onClick={clearZones}>影を全消去</button>
              )}
              <span className="hint">
                影になる範囲をドラッグで囲むと、かかるパネルを暗く表示し枚数をカウント。
                合計 <strong>{shadedTotal}</strong> 枚が影。
              </span>
            </div>
            {zones.length > 0 && (
              <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
                {zones.map((z, i) => (
                  <span key={z.id} className="badge" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    影{i + 1}
                    <button className="btn danger small" style={{ padding: "0 6px" }} onClick={() => deleteZone(z.id)}>×</button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {layout.imageDataUrl && (
        <div className="card" style={{ padding: 0, overflow: "hidden", position: "relative" }}>
          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", cursor: mode === "pan" ? "grab" : "crosshair", touchAction: "none" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
          {/* 戻す・全消去（左上にオーバーレイ） */}
          <div
            style={{ position: "absolute", top: 10, left: 10, display: "flex", gap: 6 }}
          >
            <button
              className="btn secondary small"
              title="一つ前の状態に戻す"
              onClick={undo}
              disabled={histLen === 0}
            >
              ↩ 戻す
            </button>
            <button
              className="btn danger small"
              title="配置したパネル配列を全消去"
              onClick={clearAllArrays}
              disabled={layout.arrays.length === 0 && (layout.freePanels?.length ?? 0) === 0}
            >
              🗑 全消去
            </button>
          </div>
          {/* 拡大縮小ボタン（右上にオーバーレイ） */}
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <button className="btn secondary small" title="拡大" onClick={() => zoomByCentered(1.25)}>＋</button>
            <button className="btn secondary small" title="縮小" onClick={() => zoomByCentered(1 / 1.25)}>－</button>
            <button
              className="btn secondary small"
              title="全体表示"
              onClick={() => imgRef.current && fitToView(imgRef.current)}
            >
              ⤢
            </button>
          </div>
          <div className="hint" style={{ padding: "6px 12px" }}>
            ドラッグ＝移動／ホイール or ＋−ボタン＝ズーム／⤢＝全体表示／↩戻す・🗑全消去／配列をドラッグで位置調整
          </div>

          {/* 写真の下：現状の説明・凡例 */}
          <div style={{ padding: "8px 12px", borderTop: "1px solid #1e293b" }}>
            <div className="row" style={{ alignItems: "center" }}>
              <strong>現状の説明・凡例</strong>
              <span className="spacer" />
              <button className="btn secondary small no-print" onClick={genLegend}>図面から自動生成</button>
              <button className="btn secondary small no-print" onClick={addLegend}>＋ 行を追加</button>
            </div>
            {legend.length === 0 ? (
              <div className="hint" style={{ marginTop: 4 }}>
                「図面から自動生成」で 緑＝既設／青＝新設 の説明を作成。手入力で枚数・既設/新設・向きを調整できます。
              </div>
            ) : (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                {legend.map((l) => (
                  <div key={l.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                    <input
                      type="color"
                      value={l.color}
                      title="色"
                      onChange={(e) => updateLegend(l.id, { color: e.target.value })}
                      style={{ width: 34, height: 28, padding: 0, border: "none", background: "none", cursor: "pointer" }}
                    />
                    <span
                      aria-hidden
                      style={{ width: 14, height: 14, borderRadius: 3, background: l.color, display: "inline-block", flex: "0 0 auto" }}
                    />
                    <input
                      type="text"
                      value={l.label}
                      placeholder="例) トリナソーラー 360W 150枚 既設 横"
                      onChange={(e) => updateLegend(l.id, { label: e.target.value })}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="btn danger small no-print" onClick={() => removeLegend(l.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {layout.imageDataUrl && (
        <div className="card">
          <h2>パネル配列の配置</h2>
          {panels.length === 0 ? (
            <div className="empty">先に「パネル登録」でパネルを登録してください。</div>
          ) : (
            <div className="form-grid">
              <div className="field">
                <label>パネル</label>
                <select value={formPanelId} onChange={(e) => setFormPanelId(e.target.value)}>
                  {panels.map((p) => (
                    <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>向き</label>
                <select value={formOrient} onChange={(e) => setFormOrient(e.target.value as "portrait" | "landscape")}>
                  <option value="portrait">縦置き</option>
                  <option value="landscape">横置き</option>
                </select>
              </div>
              <div className="field">
                <label>行数（縦）</label>
                <input type="number" min={1} value={formRows} onChange={(e) => setFormRows(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>列数（横）</label>
                <input type="number" min={1} value={formCols} onChange={(e) => setFormCols(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>横の隙間 (m)</label>
                <input type="number" step={0.01} value={formGapX} onChange={(e) => setFormGapX(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>縦の隙間 (m)</label>
                <input type="number" step={0.01} value={formGapY} onChange={(e) => setFormGapY(Number(e.target.value))} />
              </div>
              <div className="field" style={{ justifyContent: "flex-end" }}>
                <button className="btn" onClick={addArray}>配列を追加</button>
              </div>
            </div>
          )}
          <div className="hint" style={{ marginTop: 4 }}>
            <strong>横の隙間</strong>＝パネルの左右（桁間）、<strong>縦の隙間</strong>＝行の前後（アレイ離隔）。
            両面パネルは裏面採光のため<strong>縦（前後）の隙間を広め</strong>に取るのが一般的です。
          </div>

          {panels.length > 0 && (
            <div className="row" style={{ marginTop: 6, padding: "8px 10px", background: "#0b1220", borderRadius: 8 }}>
              <button
                className={`btn small ${mode === "scan" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "scan" ? "pan" : "scan")}
              >
                {mode === "scan" ? "スキャン中：アレイをドラッグで囲む" : "🔍 既設パネルをスキャン（範囲ドラッグ）"}
              </button>
              <span className="hint">
                上で選んだ<strong>パネル・向き・間隔</strong>を使い、囲んだ範囲の<strong>実寸÷パネル寸法</strong>で
                行×列を自動計算して配列を生成します。
                {layout.calibration ? "" : "（先に地理院地図の取得かスケール設定が必要）"}
                アレイが斜めなら、先に写真を回して水平にしてから囲むと正確です。
              </span>
            </div>
          )}

          {panels.length > 0 && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn secondary" onClick={addFreePanel}>＋ 1枚追加（単独パネル）</button>
              {freeCount > 0 && (
                <>
                  <span className="badge">単独パネル {freeCount} 枚</span>
                  <button className="btn danger small" onClick={clearFreePanels}>単独パネルを全消去</button>
                </>
              )}
              <span className="hint">
                上の「パネル」「向き」で<strong>1枚だけ</strong>追加（ピンク）。端の増設や、横置きの中に縦置きを混ぜる用。
                ※「配列を追加」は<strong>行×列のまとまり</strong>を置くボタンで別物です（1×1だと1枚に見えます）。
              </span>
            </div>
          )}

          {selectedFree && (
            <div style={{ marginTop: 12 }}>
              <h3>選択中の単独パネル</h3>
              <div className="form-grid">
                <div className="field">
                  <label>パネル</label>
                  <select value={selectedFree.panelId} onChange={(e) => updateFree(selectedFree.id, { panelId: e.target.value })}>
                    {panels.map((p) => (
                      <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>向き</label>
                  <select value={selectedFree.orientation} onChange={(e) => updateFree(selectedFree.id, { orientation: e.target.value as "portrait" | "landscape" })}>
                    <option value="portrait">縦置き</option>
                    <option value="landscape">横置き</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 1, minWidth: 200 }}>
                  <label>回転: {selectedFree.rotationDeg}°</label>
                  <input type="range" min={-90} max={90} value={selectedFree.rotationDeg} onChange={(e) => updateFree(selectedFree.id, { rotationDeg: Number(e.target.value) })} />
                </div>
                <div className="field" style={{ justifyContent: "flex-end" }}>
                  <button className="btn danger" onClick={() => deleteFree(selectedFree.id)}>このパネルを削除</button>
                </div>
              </div>
            </div>
          )}

          {layout.arrays.length > 0 && (
            <table className="list" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>配列</th>
                  <th className="num">行×列</th>
                  <th className="num">枚数</th>
                  <th>向き</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {layout.arrays.map((a, i) => {
                  const p = panels.find((x) => x.id === a.panelId);
                  return (
                    <tr
                      key={a.id}
                      style={{ outline: a.id === selectedId ? "1px solid #fff" : undefined, cursor: "pointer" }}
                      onClick={() => setSelectedId(a.id)}
                    >
                      <td>
                        <span style={{ color: a.color }}>■</span> 配列{i + 1}
                        <div className="hint">{p?.model ?? "—"}</div>
                      </td>
                      <td className="num">{a.rows}×{a.cols}</td>
                      <td className="num">
                        {a.rows * a.cols}
                        {(a.keepCells?.length ?? 0) > 0 && (
                          <span className="hint"> (流用{a.keepCells!.length})</span>
                        )}
                      </td>
                      <td>{a.orientation === "portrait" ? "縦" : "横"}</td>
                      <td className="num">
                        <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                          <button
                            className={`btn small ${a.id === selectedId ? "" : "secondary"}`}
                            onClick={(e) => { e.stopPropagation(); setSelectedId(a.id); setSelectedFreeId(null); }}
                          >
                            編集
                          </button>
                          <button className="btn danger small" onClick={(e) => { e.stopPropagation(); deleteArray(a.id); }}>削除</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {selected && (
            <div style={{ marginTop: 12 }}>
              <h3>選択中の配列を調整</h3>
              <div className="form-grid">
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>パネル（型式の変更）</label>
                  <select value={selected.panelId} onChange={(e) => updateArray(selected.id, { panelId: e.target.value })}>
                    {panels.map((p) => (
                      <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>行数</label>
                  <input type="number" min={1} value={selected.rows} onChange={(e) => updateArray(selected.id, { rows: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>列数</label>
                  <input type="number" min={1} value={selected.cols} onChange={(e) => updateArray(selected.id, { cols: Number(e.target.value) })} />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 200 }}>
                  <label>配列の回転: {selected.rotationDeg}°</label>
                  <input type="range" min={-45} max={45} value={selected.rotationDeg} onChange={(e) => updateArray(selected.id, { rotationDeg: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>向き</label>
                  <select value={selected.orientation} onChange={(e) => updateArray(selected.id, { orientation: e.target.value as "portrait" | "landscape" })}>
                    <option value="portrait">縦置き</option>
                    <option value="landscape">横置き</option>
                  </select>
                </div>
                <div className="field">
                  <label>横の隙間 (m)</label>
                  <input type="number" step={0.01} value={selected.gapM} onChange={(e) => updateArray(selected.id, { gapM: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>縦の隙間 (m)</label>
                  <input
                    type="number"
                    step={0.01}
                    value={selected.gapYm ?? selected.gapM}
                    onChange={(e) => updateArray(selected.id, { gapYm: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="hint">この配列の流用指定：</span>
                <button className="btn secondary small" onClick={() => setAllCells(selected.id, true)}>全部流用</button>
                <button className="btn secondary small" onClick={() => setAllCells(selected.id, false)}>全部入換</button>
                <button className="btn secondary small" onClick={() => invertCells(selected.id)}>反転</button>
                <span className="hint">流用 {selected.keepCells?.length ?? 0} 枚</span>
              </div>
            </div>
          )}
        </div>
      )}

      {layout.imageDataUrl && (
        <div className="card">
          <h2>現状の基準登録 ＆ 前後比較</h2>
          <div className="row">
            <button className="btn" onClick={registerBaseline}>
              {layout.baseline ? "現状を再登録（上書き）" : "現状を基準として登録"}
            </button>
            {layout.baseline && (
              <button className="btn secondary small" onClick={clearBaseline}>基準を削除</button>
            )}
            <span className="hint">
              <strong>現状（基準）＝流用マークのある既存配列の全数</strong>（新設パネルは除外）。
              <strong>改修案＝既存は流用枚数＋新設パネル</strong>で計算します。
            </span>
          </div>

          {(() => {
            const cur = summarizeLayout(layout, panels, "kaishu");
            const base = layout.baseline;
            const fmt = (n: number) => n.toLocaleString();
            const kw = (n: number) => n.toFixed(1);
            return (
              <table className="list" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th></th>
                    <th className="num">合計枚数</th>
                    <th className="num">合計出力(kW)</th>
                    <th>型式内訳</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>現状（基準）</strong>
                      <div className="hint">{base ? "登録済み" : "未登録"}</div>
                    </td>
                    <td className="num">{base ? fmt(base.totalPanels) : "—"}</td>
                    <td className="num">{base ? kw(base.totalKw) : "—"}</td>
                    <td className="hint">
                      {base
                        ? base.byPanel.map((b) => `${b.model}：${fmt(b.count)}枚(${kw(b.kw)}kW)`).join(" / ")
                        : "「現状を基準として登録」を押すと記録されます"}
                    </td>
                  </tr>
                  <tr>
                    <td><strong>現在（改修案）</strong></td>
                    <td className="num">{fmt(cur.totalPanels)}</td>
                    <td className="num">{kw(cur.totalKw)}</td>
                    <td className="hint">
                      {cur.byPanel.map((b) => `${b.model}：${fmt(b.count)}枚(${kw(b.kw)}kW)`).join(" / ") || "—"}
                    </td>
                  </tr>
                  {base && (
                    <tr style={{ background: "#0b1220" }}>
                      <td><strong>差分（改修−現状）</strong></td>
                      <td className="num" style={{ color: cur.totalPanels - base.totalPanels >= 0 ? "#22c55e" : "#f43f5e" }}>
                        {cur.totalPanels - base.totalPanels >= 0 ? "+" : ""}{fmt(cur.totalPanels - base.totalPanels)}
                      </td>
                      <td className="num" style={{ color: cur.totalKw - base.totalKw >= 0 ? "#22c55e" : "#f43f5e" }}>
                        {cur.totalKw - base.totalKw >= 0 ? "+" : ""}{kw(cur.totalKw - base.totalKw)}
                      </td>
                      <td className="hint">出力が増える分はパワコン上限（低圧≈49.5kW）でピークカットされる点に注意</td>
                    </tr>
                  )}
                </tbody>
              </table>
            );
          })()}
          <div className="hint" style={{ marginTop: 6 }}>
            ※ 入れ替えで撤去する既存パネルは「パネルを撤去」で外すと、現在（改修案）の枚数に正しく反映されます。
          </div>
        </div>
      )}
    </>
  );
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  zoom: number
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / zoom;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  for (const [x, y] of [[x1, y1], [x2, y2]] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4 / zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}
