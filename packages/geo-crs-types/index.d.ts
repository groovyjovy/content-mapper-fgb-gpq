// GeoJSON 互換の型に CRS をブランドとして載せたもの。
// ブランドは型の上だけに存在し、実行時のデータには影響しない。

declare const crsBrand: unique symbol;

/** CRS 識別子（例: "EPSG:4326"）。CRS 不明のデータは `string` になる。 */
export type Crs = string;

export type Position<C extends Crs> = readonly number[] & { readonly [crsBrand]: C };

export interface Point<C extends Crs> {
  type: "Point";
  coordinates: Position<C>;
}
export interface MultiPoint<C extends Crs> {
  type: "MultiPoint";
  coordinates: Position<C>[];
}
export interface LineString<C extends Crs> {
  type: "LineString";
  coordinates: Position<C>[];
}
export interface MultiLineString<C extends Crs> {
  type: "MultiLineString";
  coordinates: Position<C>[][];
}
export interface Polygon<C extends Crs> {
  type: "Polygon";
  coordinates: Position<C>[][];
}
export interface MultiPolygon<C extends Crs> {
  type: "MultiPolygon";
  coordinates: Position<C>[][][];
}
export interface GeometryCollection<C extends Crs> {
  type: "GeometryCollection";
  geometries: Geometry<C>[];
}

export type Geometry<C extends Crs> =
  | Point<C>
  | MultiPoint<C>
  | LineString<C>
  | MultiLineString<C>
  | Polygon<C>
  | MultiPolygon<C>
  | GeometryCollection<C>;
