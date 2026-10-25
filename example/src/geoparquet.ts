// GeoParquet: 手元のファイルと、クラウド上の 767MB のファイル（Overture Maps）
import { distance, centroid } from "geo-crs-types";
import type { Row as Area } from "../data/division_area.parquet.ref";
import type { Row as Parcel } from "../data/parcels.parquet";

// --- 入れ子の構造まで型が付く -----------------------------------------------------

export function displayName(a: Area): string {
  return a.names?.primary ?? a.id ?? "?";
}

export function japaneseName(a: Area): string | undefined {
  return a.names?.rules?.find((r) => r?.language === "ja")?.value ?? undefined;
}

export const sourcesOf = (a: Area) => a.sources?.map((s) => s?.dataset);

// @ts-expect-error 存在しない列
export const typo = (a: Area) => a.contry;

// @ts-expect-error names は欠けることがある（undefined チェックが必要）
export const unsafe = (a: Area) => a.names.primary;

// @ts-expect-error admin_level は number | null
export const level: number = null! as Area["admin_level"];

// --- CRS もジオメトリ列の型に載る ---------------------------------------------------

declare const parcel: Parcel; // EPSG:6680
declare const area: Area; // OGC:CRS84

if (parcel.geometry && area.geometry?.type === "Polygon") {
  const p = { type: "Feature", geometry: parcel.geometry, properties: {} } as const;
  const a = { type: "Feature", geometry: area.geometry, properties: {} } as const;
  // @ts-expect-error EPSG:6680 と OGC:CRS84 は混ぜられない
  distance(centroid(p), centroid(a));
}
