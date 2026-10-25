// mapper が作る Row 型の使い方: 入れ子の struct / list / map、null、ジオメトリの union、CRS
// 型チェック専用（実行はしない）。値の import（url / crs）は型の上にしかないため、実行時には失敗する
import { centroid, distance } from "geo-crs-types";
import type { Feature, MultiPolygon, Polygon } from "geo-crs-types";
import { asyncBufferFromFile, asyncBufferFromUrl, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { Row as ParcelRow } from "../data/parcels.parquet";
import { crs as parcelRowCrs } from "../data/parcels.parquet";
import type { Row as Area } from "../data/division_area.parquet.ref";
import { crs as areaCrs, url as areaUrl } from "../data/division_area.parquet.ref";

// --- G1: 実行時に読んで、生成された Row 型を付ける -----------------------------
// mapper は型だけを作る。読み込みは hyparquet で行い、`as Row[]` で型を付ける。

export async function readParcels(path: string): Promise<ParcelRow[]> {
  const file = await asyncBufferFromFile(path);
  return (await parquetReadObjects({ file })) as ParcelRow[];
}

// リモートの URL も型（文字列リテラル）になっているので、そのまま渡せる
export async function readAreas(rowEnd = 100): Promise<Area[]> {
  const file = await asyncBufferFromUrl({ url: areaUrl });
  return (await parquetReadObjects({ file, compressors, rowEnd })) as Area[];
}

// --- G2: 列を絞って読む（存在しない列名はコンパイルエラー） ----------------------

export async function readColumns<K extends keyof Area>(columns: K[], rowEnd = 100) {
  const file = await asyncBufferFromUrl({ url: areaUrl });
  const rows = await parquetReadObjects({ file, compressors, columns, rowEnd });
  return rows as Pick<Area, K>[];
}

export async function slimExample() {
  const rows = await readColumns(["id", "country", "admin_level"]);
  rows[0]?.country; // string | null
  // @ts-expect-error 読んでいない列は Pick で落ちている
  rows[0]?.names;
  // @ts-expect-error 存在しない列名は渡せない
  await readColumns(["id", "contry"]);
}

// --- G3: 入れ子の struct / list / map を辿る -----------------------------------

// list<struct> の要素型を取り出して名前を付ける
export type NameRule = NonNullable<NonNullable<NonNullable<Area["names"]>["rules"]>[number]>;
export type Source = NonNullable<NonNullable<Area["sources"]>[number]>;

// map 型（names.common）は Record<string, string | null>
export const commonName = (a: Area, lang: string): string | null | undefined =>
  a.names?.common?.[lang];

// 言語ごとの名前を集める（list の要素は欠けることがあるので型ガードで除く）
export function namesByLanguage(a: Area): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of (a.names?.rules ?? []).filter((r): r is NameRule => r !== undefined)) {
    if (r.language && r.value) out.set(r.language, r.value);
  }
  return out;
}

// 視点（perspectives）付きの名前: さらに 1 段深い struct と list
export const disputedBy = (r: NameRule): string[] =>
  (r.perspectives?.countries ?? []).filter((c): c is string => c !== null);

// 出典のライセンス一覧
export const licenses = (a: Area): Set<string> =>
  new Set((a.sources ?? []).flatMap((s) => (s?.license ? [s.license] : [])));

// --- G4: null / undefined を正しく扱わないとエラー ---------------------------------

export function adminLevelLabel(a: Area): string {
  // admin_level は number | null。null チェックなしで算術はできない
  // @ts-expect-error 'a.admin_level' is possibly 'null'
  a.admin_level + 1;
  return a.admin_level === null ? "不明" : `レベル ${a.admin_level}`;
}

// bbox 列（struct）。欠けることがあるので undefined チェックが要る
export function bboxWidth(a: Area): number | undefined {
  const b = a.bbox;
  if (!b || b.xmin === null || b.xmax === null) return undefined;
  return b.xmax - b.xmin;
}

// --- G5: 列の値でグループ化・絞り込み -------------------------------------------

export function groupByCountry(rows: Area[]): Map<string, Area[]> {
  const out = new Map<string, Area[]>();
  for (const r of rows) {
    if (r.country === null) continue;
    out.set(r.country, [...(out.get(r.country) ?? []), r]);
  }
  return out;
}

// 型述語で「ジオメトリと名前が必ずある行」に絞る
type Named = Area & { geometry: NonNullable<Area["geometry"]>; names: NonNullable<Area["names"]> };
export const isNamed = (r: Area): r is Named => r.geometry !== null && r.names !== undefined;

export function landNames(rows: Area[]): (string | null)[] {
  return rows.filter((r) => r.is_land === true).filter(isNamed).map((r) => r.names.primary);
}

// --- G6: ジオメトリ列は geo メタデータの geometry_types から union になる -----------

export function ringCount(a: Area): number {
  const g = a.geometry;
  if (g === null) return 0;
  switch (g.type) {
    case "Polygon":
      return g.coordinates.length; // Position[][]
    case "MultiPolygon":
      return g.coordinates.reduce((n, p) => n + p.length, 0); // Position[][][]
    default: {
      // division_area は Polygon / MultiPolygon だけ。ほかの種別は来ない
      const never: never = g;
      return never;
    }
  }
}

// --- G7: CRS は列の型に載っている ----------------------------------------------

const _areaCrs: "OGC:CRS84" = areaCrs;
const _parcelRowCrs: "EPSG:6680" = parcelRowCrs;

// 行を Feature に包む。CRS はジオメトリ列の型からそのまま引き継がれる
export function toFeature<C extends string, P>(
  geometry: Polygon<C> | MultiPolygon<C>,
  properties: P,
): Feature<Polygon<C> | MultiPolygon<C>, P> {
  return { type: "Feature", geometry, properties };
}

export function nearestParcelDistance(areaRow: Named, parcelRow: ParcelRow): number | undefined {
  const a = centroid(toFeature(areaRow.geometry, { id: areaRow.id }));
  if (parcelRow.geometry === null) return undefined;
  const p = centroid(toFeature(parcelRow.geometry, { name: parcelRow.name }));
  // @ts-expect-error OGC:CRS84 と EPSG:6680 は混ぜられない
  distance(a, p);
  // 同じファイル同士なら OK
  return distance(a, a);
}

