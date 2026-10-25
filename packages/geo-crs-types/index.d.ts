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

export interface Feature<G extends Geometry<Crs>, P = Record<string, unknown>> {
  type: "Feature";
  geometry: G;
  properties: P;
}

export interface FeatureCollection<G extends Geometry<Crs>, P = Record<string, unknown>> {
  type: "FeatureCollection";
  features: Feature<G, P>[];
}

/** ジオメトリ型の形を保ったまま CRS だけ付け替える */
export type WithCrs<G extends Geometry<Crs>, To extends Crs> =
  G extends Point<Crs> ? Point<To>
  : G extends MultiPoint<Crs> ? MultiPoint<To>
  : G extends LineString<Crs> ? LineString<To>
  : G extends MultiLineString<Crs> ? MultiLineString<To>
  : G extends Polygon<Crs> ? Polygon<To>
  : G extends MultiPolygon<Crs> ? MultiPolygon<To>
  : GeometryCollection<To>;

/** 2 点間の距離。両者の CRS が一致していないとコンパイルエラーになる。 */
export declare function distance<C extends Crs>(
  a: Feature<Point<C>, unknown>,
  b: Feature<Point<NoInfer<C>>, unknown>,
): number;

/** ポリゴンの重心。CRS は入力のまま引き継がれる。 */
export declare function centroid<C extends Crs, P>(
  f: Feature<Polygon<C> | MultiPolygon<C>, P>,
): Feature<Point<C>, P>;

/** 座標変換。通したときだけ CRS の型が変わる。 */
export declare function transform<G extends Geometry<Crs>, P, To extends Crs>(
  fc: FeatureCollection<G, P>,
  to: To,
): FeatureCollection<WithCrs<G, To>, P>;
