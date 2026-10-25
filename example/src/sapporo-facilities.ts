// 実務を想定したサンプル: 札幌市の施設データ（facilities.parquet）を扱う業務サービス
// 実行: node src/sapporo-facilities.ts（example ディレクトリで）
//
// 想定: 市の施設管理システムや地図アプリのバックエンド。データは GeoParquet で配られ、
// 区ごとに row group が分かれている（区で並べて書き出す運用）。
//
// 型はすべて content mapper が facilities.parquet のフッタから作る。アプリ側で書いている型は
// 「画面に返す形」だけで、データの列の型は 1 つも手で書いていない。
// データの列が増えた・型が変わった・区が増えた、といった変化は、型チェックで呼び出し側まで伝わる。
import { fileURLToPath } from "node:url";
import { asyncBufferFromFile } from "hyparquet";
import type { AsyncBuffer } from "hyparquet";
import type { Feature, FeatureCollection, Point, Position } from "geo-crs-types";
import { readParquet } from "typed-hyparquet";
import type { Row, RowCounts, RowGroups } from "../data/facilities.parquet";

const read = readParquet<Row, RowGroups, RowCounts>();

// --- データから導かれる型 -----------------------------------------------------------

/** 区の名前。row group の統計（区ごとに ward の最小 = 最大）から作られる 10 区の union */
export type Ward = RowGroups[number]["ward"]["value"];
//     ^? "中央区" | "北区" | "東区" | "白石区" | "豊平区" | "南区" | "西区" | "厚別区" | "手稲区" | "清田区"

/**
 * データの座標系。平面直角座標系 XII 系なので、座標の単位はメートル。
 * crs は型の上にしかない（実行時の値はない）ので、typeof import(...) で型だけ取る
 */
type Crs = (typeof import("../data/facilities.parquet"))["crs"]; // "EPSG:6680"

/** アプリで扱う点。CRS が型に載っているので、緯度経度の点を渡すとコンパイルエラーになる */
type PlanePoint = Point<Crs>;

export function planePoint(x: number, y: number): PlanePoint {
  return { type: "Point", coordinates: [x, y] as unknown as Position<Crs> };
}

/** 平面直角座標なので、距離（m）は三平方の定理で求められる。緯度経度の点は受け付けない */
export function distanceMeters(a: PlanePoint, b: PlanePoint): number {
  const [ax = 0, ay = 0] = a.coordinates;
  const [bx = 0, by = 0] = b.coordinates;
  return Math.hypot(ax - bx, ay - by);
}

// --- ユースケース 1: 区の施設サマリ（区役所向けの帳票） ------------------------------------

export interface WardSummary {
  ward: Ward;
  total: number;
  byCategory: Record<string, number>;
  totalVisitors: number;
  /** 開業年の中央値。開業年が不明な施設は除く */
  medianOpened: number | undefined;
  closed: number;
}

export async function wardSummary(file: AsyncBuffer, ward: Ward): Promise<WardSummary> {
  // ward で絞ると、hyparquet は統計を見てほかの区の row group を読まずに飛ばす
  const rows = await read(file, { filter: { ward }, columns: ["category", "visitors", "opened", "is_open"] });

  const byCategory: Record<string, number> = {};
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  //                               ^ category は string（null チェック不要。どの row group にも null がないため）

  // opened は南区・手稲区だけ null がありうる。ward が union のままなので、ここでは null を除く必要がある
  const years = rows.map((r) => r.opened).filter((y) => y !== null).sort((a, b) => a - b);
  return {
    ward,
    total: rows.length,
    byCategory,
    totalVisitors: rows.reduce((n, r) => n + r.visitors, 0),
    medianOpened: years[Math.floor(years.length / 2)],
    closed: rows.filter((r) => !r.is_open).length,
  };
}

// --- ユースケース 2: 近くの施設を探す（地図アプリの API） -------------------------------------

export interface NearbyFacility {
  id: bigint;
  name: string;
  category: string;
  ward: Ward;
  distance: number;
  location: PlanePoint;
}

export async function findNearby(file: AsyncBuffer, center: PlanePoint, radius: number, category?: string): Promise<NearbyFacility[]> {
  const [x = 0, y = 0] = center.coordinates;
  // まず bbox（正方形）で、範囲に重なる row group だけを読む。座標はファイルの CRS（m）で指定できる
  const candidates = await read(file, {
    bbox: [x - radius, y - radius, x + radius, y + radius],
    filter: category ? { category } : {},
    columns: ["id", "name", "category", "ward", "geometry"],
  });
  // 次に円の中だけ残す。geometry は Point<"EPSG:6680">（null なし）なので、そのまま距離を計算できる
  return candidates
    .map((r) => ({ id: r.id, name: r.name, category: r.category, ward: r.ward, location: r.geometry, distance: distanceMeters(center, r.geometry) }))
    .filter((r) => r.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

// --- ユースケース 3: 地図に表示する GeoJSON を返す --------------------------------------------

export type FacilityFeature = Feature<PlanePoint, { name: string; category: string; ward: Ward; visitors: number }>;

export async function wardGeoJSON(file: AsyncBuffer, ward: Ward): Promise<FeatureCollection<PlanePoint, FacilityFeature["properties"]>> {
  const rows = await read(file, { filter: { ward, is_open: true }, columns: ["name", "category", "ward", "visitors", "geometry"] });
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: r.geometry, // CRS も含めて型が合っている。別の CRS の列を入れるとここでエラー
      properties: { name: r.name, category: r.category, ward: r.ward, visitors: r.visitors },
    })),
  };
}

// --- ユースケース 4: データ品質チェック（開業年が不明な施設の洗い出し） ------------------------------

export async function missingOpened(file: AsyncBuffer) {
  const rows = await read(file, { filter: { opened: null }, columns: ["id", "name", "ward", "opened"] });
  // 型は「opened が null の行」。統計で null がない区の row group は「ありえない」として消えるので、
  // ward は "南区" | "手稲区" だけになる。読む前から、どの区を確認すればよいかが型でわかる
  type Ward = (typeof rows)[number]["ward"]; // "南区" | "手稲区"
  const byWard: Partial<Record<Ward, string[]>> = {};
  for (const r of rows) (byWard[r.ward] ??= []).push(r.name);
  return byWard;
}

// --- ユースケース 5: 差分の取り込み（指定日以降に更新された施設） -----------------------------------

export async function updatedSince(file: AsyncBuffer, since: Date) {
  const rows = await read(file, { filter: { updated_at: { $gte: since } }, columns: ["id", "name", "updated_at"] });
  return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at.toISOString() }));
  //                                                          ^ Date（null チェック不要）
}

// --- 型が止めてくれる間違いの例（実行はしない） ---------------------------------------------

declare const file: AsyncBuffer;
declare const latLonPoint: Point<"EPSG:4326">;
export async function mistakes() {
  // @ts-expect-error 区の名前の打ち間違い（"中央区" の誤り）
  await wardSummary(file, "中央");
  // @ts-expect-error 札幌市にない区
  await wardSummary(file, "新宿区");
  // @ts-expect-error 緯度経度（EPSG:4326）の点で距離を測ろうとした。平面直角座標に変換してから
  distanceMeters(latLonPoint, planePoint(0, 0));
  // @ts-expect-error 存在しない列
  await read(file, { columns: ["adress"] });
  // @ts-expect-error 列の型と合わない条件（visitors は数値）
  await read(file, { filter: { visitors: { $gte: "1000" } } });
}

// --- 実行 ----------------------------------------------------------------------------

const facilities = await asyncBufferFromFile(fileURLToPath(new URL("../data/facilities.parquet", import.meta.url)));

console.log("## 1. 区の施設サマリ");
for (const ward of ["中央区", "南区"] as const) {
  const s = await wardSummary(facilities, ward);
  console.log(`  ${s.ward}: ${s.total} 件、利用者計 ${s.totalVisitors.toLocaleString()} 人、開業年の中央値 ${s.medianOpened}、休止中 ${s.closed} 件`);
  console.log(`    ${Object.entries(s.byCategory).map(([k, n]) => `${k} ${n}`).join("、")}`);
}

console.log("\n## 2. 札幌駅から 1km 以内の駅");
const sapporoStation = planePoint(-73232.78, -103067.59); // 札幌駅（141.3508, 43.0687）を EPSG:6680 に変換した座標
for (const f of (await findNearby(facilities, sapporoStation, 1000, "駅")).slice(0, 5)) {
  console.log(`  ${f.name}（${f.ward}）${Math.round(f.distance)} m`);
}

console.log("\n## 3. 地図用 GeoJSON（清田区の営業中の施設）");
const geojson = await wardGeoJSON(facilities, "清田区");
console.log(`  ${geojson.features.length} 地物。先頭: ${JSON.stringify(geojson.features[0])}`);

console.log("\n## 4. 開業年が不明な施設");
for (const [ward, names] of Object.entries(await missingOpened(facilities))) {
  console.log(`  ${ward}: ${names.length} 件（${names.slice(0, 3).join("、")} …）`);
}

console.log("\n## 5. 2026-10-01 以降に更新された施設");
const updated = await updatedSince(facilities, new Date("2026-10-01"));
console.log(`  ${updated.length} 件。例: ${updated.slice(0, 3).map((u) => `${u.name}（${u.updatedAt.slice(0, 10)}）`).join("、")}`);
