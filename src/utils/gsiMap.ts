// ============================================================
// 国土地理院（GSI）タイル・ジオコーディング ユーティリティ
//   住所 → 緯度経度 → 航空写真（シームレス空中写真）を貼り合わせ、
//   背景画像（データURL）とスケール(px/m)を返す。
//
//   ・出典表示が必要：「地理院タイル（国土地理院）」
//   ・タイル/ジオコーディングAPIは CORS 対応のため、ブラウザから直接取得可。
//   ・toDataURL を使うため、タイル画像は crossOrigin=anonymous で読む。
// ============================================================

/** Web メルカトルの定数（赤道での 1px あたりメートル, zoom0・256pxタイル） */
const EARTH_CIRC_M = 156543.03392804097; // 2 * PI * 6378137 / 256

/** ジオコーディング結果 */
export interface GeocodeResult {
  lat: number;
  lon: number;
  /** 住所表記（API の title） */
  label: string;
}

/**
 * 住所文字列から緯度経度を取得（国土地理院 住所検索API）。
 * 複数候補のうち先頭を返す。見つからなければ null。
 */
export async function geocodeAddress(q: string): Promise<GeocodeResult | null> {
  const url =
    "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" +
    encodeURIComponent(q.trim());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`住所検索に失敗しました (HTTP ${res.status})`);
  const data: Array<{
    geometry?: { coordinates?: [number, number] };
    properties?: { title?: string };
  }> = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const top = data[0];
  const coords = top.geometry?.coordinates;
  if (!coords) return null;
  return { lon: coords[0], lat: coords[1], label: top.properties?.title ?? q };
}

/** 指定ズーム・緯度での 1px あたりメートル（Web メルカトル） */
export function metersPerPixel(lat: number, zoom: number): number {
  return (EARTH_CIRC_M * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** 経度 → 小数タイル X 座標 */
function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** 緯度 → 小数タイル Y 座標 */
function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** タイル画像を crossOrigin 付きで読み込む */
function loadTile(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 欠損タイルは空白で許容
    img.src = src;
  });
}

/** 航空写真貼り合わせの結果 */
export interface SeamlessPhoto {
  /** 貼り合わせ画像（JPEG データURL） */
  dataUrl: string;
  /** 画像サイズ(px) */
  widthPx: number;
  heightPx: number;
  /** スケール: 1px あたりメートル */
  metersPerPixel: number;
  /** 中心緯度経度（記録用） */
  centerLat: number;
  centerLon: number;
  /** 使用ズーム */
  zoom: number;
}

const TILE = 256;

/**
 * 中心の緯度経度を中心に、指定した一辺(m)を覆う航空写真を貼り合わせる。
 *
 * @param lat 中心緯度
 * @param lon 中心経度
 * @param zoom タイルズーム（seamlessphoto は最大18）
 * @param spanMeters 取得したい一辺の長さ(m)目安
 * @param layer GSI レイヤ（既定 seamlessphoto=航空写真）
 */
export async function buildSeamlessPhoto(
  lat: number,
  lon: number,
  zoom: number,
  spanMeters: number,
  layer = "seamlessphoto"
): Promise<SeamlessPhoto> {
  const mpp = metersPerPixel(lat, zoom);
  const spanPx = spanMeters / mpp;
  // 中心タイルから左右に何枚必要か（端の余白を含めて少し多めに）
  const half = Math.max(1, Math.ceil(spanPx / TILE / 2));
  const xf = lonToTileX(lon, zoom);
  const yf = latToTileY(lat, zoom);
  const xc = Math.floor(xf);
  const yc = Math.floor(yf);
  const x0 = xc - half;
  const y0 = yc - half;
  const count = 2 * half + 1;
  const sizePx = count * TILE;

  const canvas = document.createElement("canvas");
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas を初期化できませんでした");
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(0, 0, sizePx, sizePx);

  const n = 2 ** zoom;
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      const tx = x0 + i;
      const ty = y0 + j;
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue; // 範囲外
      const src = `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${zoom}/${tx}/${ty}.jpg`;
      jobs.push(
        loadTile(src).then((img) => {
          if (img) ctx.drawImage(img, i * TILE, j * TILE);
        })
      );
    }
  }
  await Promise.all(jobs);

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    // CORS で汚染された場合（通常は発生しない）
    throw new Error(
      "地図画像の取り込みに失敗しました（CORS）。写真アップロードをご利用ください。"
    );
  }

  return {
    dataUrl,
    widthPx: sizePx,
    heightPx: sizePx,
    metersPerPixel: mpp,
    centerLat: lat,
    centerLon: lon,
    zoom,
  };
}

/**
 * px/m から、エディタの校正データ（2点＋実長）を作る。
 * 画像左下に「scaleMeters m のスケールバー」を置く形で表現する。
 */
export function calibrationFromScale(
  metersPerPixelVal: number,
  imageHeightPx: number,
  scaleMeters = 50
): { x1: number; y1: number; x2: number; y2: number; meters: number } {
  const lenPx = scaleMeters / metersPerPixelVal;
  const margin = Math.min(40, imageHeightPx * 0.04);
  const y = imageHeightPx - margin;
  return { x1: margin, y1: y, x2: margin + lenPx, y2: y, meters: scaleMeters };
}
