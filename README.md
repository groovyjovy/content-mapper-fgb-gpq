# geoparquet-content-mapper

TypeScript 7.1 の content mapper を使い、**GeoParquet ファイルを import すると、ファイルのフッタから型が自動で付く**ようにする実験です。

```ts
import type { Row, RowCounts, RowGroups } from "./data/facilities.parquet";
import { readParquet } from "typed-hyparquet";

const read = readParquet<Row, RowGroups, RowCounts>();

const rows = await read(file, { rowGroups: [5], filter: { opened: { $gte: 2000 } }, columns: ["name", "opened"] });
//    ^? { name: string; opened: number }[]

const minami = await read(file, { rowGroups: [5, 8] });
//    ^? ward は "南区" | "手稲区"、length は 200

row.contry;           // TS2551: Property 'contry' does not exist on type 'Row'. Did you mean 'country'?
distance(parcel, area);
                      // TS2345: Type '"OGC:CRS84"' is not assignable to type '"EPSG:6680"'.
```

- **スキーマ → 型**: 列名と型、入れ子の struct / list / map、null の有無
- **geo メタデータ → ジオメトリの型**: ジオメトリ種別と CRS（`Polygon<"EPSG:6680">`）。CRS の違うデータを混ぜるとコンパイルエラー
- **row group の統計 → 型を狭める**: 読み方（列・条件・row group・bbox）に応じて戻り値の型が変わる。行数もリテラル型になる
- **リモート対応**: URL を書いた `.parquet.ref` を import すると、HTTP Range でフッタだけを取る

> [!WARNING]
> TypeScript 7.1 は beta です。content mapper の仕様は変わる可能性があります。型チェック時に mapper（任意のコード）を実行するため、`--runExternalCode` は信頼できるリポジトリでだけ有効にしてください。

## 実測

| 対象 | ファイルサイズ | 型のために取得した量 |
|---|---|---|
| Overture `division_area` part-00000 | 約 767MB | 253,517 B（約 0.03%） |
| Overture `places` part-00015（日本を含む） | 約 733MB | 約 1.6MB（row group 256） |

`example/src/remote.ts` では、GitHub に置いた facilities.parquet（106KB）を読み、送った Range リクエストを表示します。

```
## フッタ: 1000 行、row group 10
  bytes=106158-106165  → 206 8 B        末尾 8 バイト（フッタの長さと "PAR1"）
  bytes=81667-106157   → 206 24491 B    フッタ
## row group 0 の name / visitors: 100 件
  bytes=766-2427       → 206 1662 B     row group 0 の 2 列だけ
```

`example/src/overture.ts` では、places（733MB）から札幌市中心部の bbox × `confidence >= 0.8` の 7,947 件を、フッタ 1.6MB + データ 3.1MB の取得で読んでいます。

## 動かし方

Node 24.10 以上と pnpm が必要です。

```sh
pnpm install
pnpm typecheck                              # example で tsc --runExternalCode

cd example
node src/typed-read.ts                      # 絞り込むたびに型が狭まる様子（手元のファイル）
node src/sapporo-facilities.ts              # 実務を想定したサンプル
node src/read-parcels.ts                    # hyparquet で読んだ値とメタデータの確認
node src/remote.ts                          # GitHub 上の facilities.parquet を Range で読む（通信あり）
node src/overture.ts                        # Overture の実データ（通信あり）
```

`example/src/*.ts` の `@ts-expect-error` は「ここでエラーになるはず」の確認です。型チェックがエラーなしで終われば期待どおりです。

デバッグ（JSON-RPC、Range リクエスト、生成コードを表示）:

```sh
cd example && TS_CONTENT_MAPPER_DEBUG=1 GEOPARQUET_MAPPER_DEBUG=1 pnpm exec tsc --runExternalCode
```

## 構成

```
packages/
  geoparquet-content-mapper/   mapper 本体（src/mapper.ts）。フッタから Row / RowGroups / RowCounts / crs を生成
  typed-hyparquet/             hyparquet のラッパー。読み方から戻り値の型を計算する
  geo-crs-types/               CRS ブランド型（Point<C> など）と distance / centroid / transform（型宣言のみ）
example/
  tsconfig.json                contentMappers の登録例
  data/
    facilities.parquet         札幌市の架空の施設 1,000 件（10 区 × 100 件、row group = 1 区）
    parcels.parquet            架空の区画 2 件（Polygon, EPSG:6680）
    facilities.parquet.ref     GitHub 上の facilities.parquet（コミットハッシュ付きの URL）
    places.parquet.ref         Overture 2026-10-21.0 places part-00015
    division_area.parquet.ref  Overture 2026-10-21.0 division_area part-00000
  scripts/make-facilities.*    facilities.parquet の作成（DuckDB → ogr2ogr で row group を 100 行に）
  src/
    typed-read.ts              typed-hyparquet: 列・条件・row group で型が狭まる様子
    sapporo-facilities.ts      typed-hyparquet: 実務を想定したサンプル
    remote.ts                  Range リクエストの様子（フッタ → 必要な column chunk だけ）
    overture.ts                typed-hyparquet: Overture の実データと取得量の計測
    schema-types.ts            Row 型の使い方（入れ子、null、ジオメトリの union、CRS）
    geoparquet.ts              手元とリモートのファイル、CRS 不一致
    read-parcels.ts            parcels.parquet のメタデータと値の形
.zed/settings.json             Zed 用の設定（下記「エディタ」）
```

## 仕組み

### content mapper

1. `tsconfig.json` の `contentMappers` で、`.parquet` / `.parquet.ref` をこの mapper に割り当てる
2. mapper の `package.json` の `typescript.contentMapper.exec` に起動コマンドを書く
3. TS（tsgo）は mapper を子プロセスとして起動し、JSON-RPC で `transform` を送る。mapper は仮想の TS コードを返す

型チェックとエディタ支援のためだけの仕組みで、実行時には何もしません。

### フッタの読み方

```
PAR1 | row group ... | フッタ（Thrift） | フッタの長さ（uint32 LE） | PAR1
```

1. 末尾 8 バイトを読む（HTTP なら `Range: bytes=-8`）→ フッタの長さを得る
2. 末尾のフッタの長さ + 8 バイトを読む → hyparquet の `parquetMetadata` で解析
3. `key_value_metadata` の `geo`（GeoParquet のメタデータ）を JSON として読む

リモートの場合、取得したフッタを `node_modules/.cache/geoparquet-content-mapper/` に保存し、2 回目以降は通信しません（取り直しは `GEOPARQUET_MAPPER_REFRESH=1`）。サーバーが Range に対応していない場合は、全体をダウンロードせずにエラーにします。

### 生成する仮想コード

```ts
import type { Point } from "geo-crs-types";
export interface Row { "id": bigint | null; "ward": string | null; "geometry": Point<"EPSG:6680"> | null; ... }
declare const facilities: Row[];
export default facilities;
export declare const crs: "EPSG:6680";
type RowGroup0 = { "ward": { nulls: "none"; value: "中央区" }; "opened": { nulls: "none" }; ... };
export type RowGroups = [RowGroup0, RowGroup1, ...];
export type RowCounts = [100, 100, ...];
export declare const url: "https://...";   // .parquet.ref のときだけ
```

### 型の対応

hyparquet の `parquetReadObjects` で読んだときの値の形に合わせています。

| Parquet | TS |
|---|---|
| OPTIONAL の単純な列 | `T \| null` |
| OPTIONAL の struct / list / map | `T \| undefined` |
| list / map | `(T \| null)[]` / `Record<string, V>` |
| `INT64` | `bigint` |
| `INT32` / `FLOAT` / `DOUBLE` / `DECIMAL` | `number` |
| `DATE` / `TIMESTAMP*` / `INT96` | `Date` |
| `STRING` / `UTF8` / `ENUM` / `UUID` / 素の `BYTE_ARRAY` | `string` |
| `JSON` / `BSON` / `INTERVAL` / `VARIANT` | `unknown` |
| ジオメトリ列（geo メタデータで WKB） | `geometry_types` から `Polygon<C> \| ...`。空なら `Geometry<C>` |

CRS は、geo の `crs` が省略なら `"OGC:CRS84"`、`null` なら不明で `string`、PROJJSON に `id` があれば `"EPSG:6680"` のような文字列になります。

### row group の統計で型を狭める（typed-hyparquet）

mapper は、最上位の単純な列について、row group ごとの統計から次の事実を `RowGroups` に書き出します。

- `nulls: "none"` / `"all"`: null が 1 つもない / 全部 null（`null_count`）
- `value`: 全行が同じ値（最小 = 最大。切り詰められた値は使わない）

同じ内容の row group は型を共有します（places は row group 256 → 型 2 つ）。row group が 5,000 を超えたら書き出しません。

`readParquet` の戻り値は「row group ごとに狭めた行の型」の union です。

- `rowGroups`: 指定した row group のメンバーだけ残す。`length` は行数の合計
- `filter`: `$eq` / `$in` / 値そのものは列をその値に、`$gt` などの比較と `$ne: null` は null を除く。どの条件にも合わないメンバーは消える（ありえない条件は `never[]`）。`$and` / `$or` も扱う
- `columns`: 各メンバーから列を選ぶ
- `bbox`: GeoParquet の covering（bbox 列）の条件に変換する。座標はファイルの CRS
- `filter` / `bbox` を使うと、行数は読むまでわからないので `length` は `number`

実行時は hyparquet が同じ統計で row group を読み飛ばします。

## 注意点

- **型はフッタのスナップショット**: 実行時に別のファイル（更新されたデータなど）を読むと、型と中身が食い違います。統計で狭めた型や行数は、特にそのファイルにしか成り立ちません。`.parquet.ref` はバージョンを固定した URL を指してください
- **値の import は実行時に失敗する**: `url` / `crs` は型の上にしかありません。実行時に URL が必要なら `.parquet.ref` の JSON を読みます（`overture.ts` 参照）
- **バイナリは壊れて届く**: `transform` の `content` は UTF-8 として読まれた文字列です。mapper は `fileName` から直接読んでいます。また TS は import されたファイル全体を JSON-RPC で送るため、大きなファイルは `.parquet.ref` 経由にするのが現実的です
- **ZSTD**: hyparquet は標準で ZSTD を読めません。Overture などを読むには `hyparquet-compressors` を渡します（型の生成には不要）
- **INT64 は bigint**: hyparquet の挙動に合わせています。別のリーダーでは値の形が変わる可能性があります
- **`OGC:CRS84` と `EPSG:4326` は別の型**: 軸順以外は同じですが、現状は区別しています
- **mapper を変更したら言語サーバーを再起動**: エディタは mapper のプロセスを起動したまま使い続けるため、変更が反映されません
- **`.json` で終わる拡張子は登録できない**: しおりファイルを `.parquet.ref` にしているのはこのためです

## エディタ

Zed では tsgo 拡張（言語サーバー名 `typescript-ls`）を使います。`.zed/settings.json` で TS 7.1 beta と `runExternalCode` を指定し、content mapper を知らない vtsls を外しています。

VS Code などでは、TS 7.1 の言語サーバーに `initializationOptions.runExternalCode: true` を渡してください。

## 環境

| もの | バージョン |
|---|---|
| typescript | 7.1.0-beta（固定） |
| ts-content-mapper | 0.1.0 |
| hyparquet / hyparquet-compressors | 1.31.5 / 1.1.2 |
| Node | 24.10 以上（24.22.1 で確認） |

## 参考

- [Announcing TypeScript 7.1 Beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
- [ts-content-mapper](https://github.com/sxzz/ts-content-mapper)
- [GeoParquet](https://geoparquet.org/)
- [hyparquet](https://github.com/hyparam/hyparquet)
- [Overture Maps](https://overturemaps.org/)（データは各テーマのライセンスに従います）
