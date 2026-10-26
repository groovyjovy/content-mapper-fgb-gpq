# geoparquet-content-mapper

TypeScript 7.1 の content mapper を使い、**GeoParquet ファイルを import すると、ファイルのフッタから型が自動で付く**ようにする実験です。

```ts
import type { Row, RowCounts, RowGroups } from "../data/facilities.parquet";

const read = readParquet<Row, RowGroups, RowCounts>();

const all = await read(file);
all[0].ward;     // "中央区" | "北区" | ... | "清田区"（10 区）
all.length;      // 1000

const unknown = await read(file, { filter: { opened: null } });
unknown[0].ward; // "南区" | "手稲区"  ← 開業年が不明な施設があるのはこの 2 区だけ（読む前にわかる）

const chuo = await read(file, { filter: { ward: "中央区" }, columns: ["name", "opened"] });
chuo[0].opened;  // number
```

- **スキーマ → 型**: 列名と型、null の有無
- **geo メタデータ → ジオメトリの型**: ジオメトリ種別と CRS（`Point<"EPSG:6680">`）
- **row group の統計 → 型を絞り込む**: 読み方（列・条件・row group・bbox）に応じて戻り値の型が変わる。行数もリテラル型になる
- **リモート対応**: URL を書いた `.parquet.ref` を import すると、HTTP Range でフッタだけを取る（Overture の places 733MB から 1.6MB）

> [!WARNING]
> TypeScript 7.1 は beta です。content mapper の仕様は変わる可能性があります。型チェック時に mapper（任意のコード）を実行するため、`--runExternalCode` は信頼できるリポジトリでだけ有効にしてください。

## 動かし方

Node 24.10 以上と pnpm が必要です。

```sh
pnpm install
pnpm typecheck                     # example で tsc --runExternalCode

cd example
node src/sapporo-facilities.ts     # 札幌市の施設データ（手元のファイル）
node src/overture.ts               # Overture Maps の実データ（通信あり）
```

デバッグ（JSON-RPC、Range リクエスト、生成コードを表示）:

```sh
cd example && TS_CONTENT_MAPPER_DEBUG=1 GEOPARQUET_MAPPER_DEBUG=1 pnpm exec tsc --runExternalCode
```

## 構成

```
packages/
  geoparquet-content-mapper/   mapper 本体。フッタから Row / RowGroups / RowCounts / crs を生成
  typed-hyparquet/             hyparquet のラッパー。読み方から戻り値の型を計算する
  geo-crs-types/               CRS を型に載せた GeoJSON のジオメトリ型（Point<C> など）
example/
  tsconfig.json                contentMappers の登録例
  data/
    facilities.parquet         札幌市の架空の施設 1,000 件（10 区 × 100 件、row group = 1 区）
    places.parquet.ref         Overture Maps 2026-10-21.0 の places（日本を含むパート）
  scripts/make-facilities.*    facilities.parquet の作成（DuckDB → ogr2ogr で row group を 100 行に）
  src/
    sapporo-facilities.ts      読み方を変えるたびに型が絞り込まれる例
    overture.ts                大きなリモートファイルの例と取得量の計測
.zed/settings.json             Zed 用の設定（下記「エディタ」）
```

## 仕組み

### content mapper

1. `tsconfig.json` の `contentMappers` で、`.parquet` / `.parquet.ref` をこの mapper に割り当てる
2. mapper の `package.json` の `typescript.contentMapper.exec` に起動コマンドを書く
3. TS（tsgo）は mapper を子プロセスとして起動し、JSON-RPC で `transform` を送る。mapper は TS のコードを文字列で返す

型チェックとエディタ支援のためだけの仕組みで、実行時には何もしません。

### フッタの読み方

```
PAR1 | row group ... | フッタ | フッタの長さ（uint32 LE） | PAR1
```

末尾 8 バイトでフッタの長さを知り、フッタだけを読みます。解析は hyparquet の `parquetMetadata` です。リモートの場合は取得したフッタを `node_modules/.cache/geoparquet-content-mapper/` に保存し、2 回目以降は通信しません（取り直しは `GEOPARQUET_MAPPER_REFRESH=1`）。

### 生成するコード

```ts
import type { Point } from "geo-crs-types";
export interface Row { "id": bigint | null; "ward": string | null; "geometry": Point<"EPSG:6680"> | null; ... }
export declare const crs: "EPSG:6680";
type RowGroup0 = { "ward": { nulls: "none"; value: "中央区" }; "opened": { nulls: "none" }; ... };
export type RowGroups = [RowGroup0, RowGroup1, ...];
export type RowCounts = [100, 100, ...];
```

- `Row` の型は hyparquet の `parquetReadObjects` で読んだときの値の形に合わせています（`INT64` → `bigint`、`TIMESTAMP` → `Date` など）
- `RowGroups` は row group ごとの統計から、null がない / 全部 null（`nulls`）と、全行が同じ値（`value`、最小 = 最大）を書き出したものです

### 型の絞り込み（typed-hyparquet）

`readParquet` の戻り値は「row group ごとに絞り込んだ行の型」の union です。

- `rowGroups`: 指定した row group だけ残す。`length` は行数の合計
- `filter`: 条件を満たしえない row group を消す。`$eq` / `$in` / 値そのものは列をその値に、`$gt` などの比較と `$ne: null` は null を除く
- `columns`: 選んだ列だけ残す
- `bbox`: GeoParquet の covering（bbox 列）の条件に変換する
- `filter` / `bbox` を使うと、行数は読むまでわからないので `length` は `number`

実行時も hyparquet が同じ統計で row group を読み飛ばします。

## 注意点

- **型はフッタのスナップショット**: 実行時に別のファイル（更新されたデータなど）を読むと、型と中身が食い違います。`.parquet.ref` はバージョンを固定した URL を指してください
- **`.parquet.ref` の値は実行時に import できない**: `url` / `crs` は型の上にしかありません。実行時に URL が必要なら JSON を読みます（`overture.ts` 参照）
- **ZSTD**: hyparquet は標準で ZSTD を読めません。Overture を読むには `hyparquet-compressors` を渡します
- **mapper を変更したら言語サーバーを再起動**: エディタは mapper のプロセスを起動したまま使い続けるため、変更が反映されません

## エディタ

Zed では tsgo 拡張（言語サーバー名 `typescript-ls`）を使います。`.zed/settings.json` で TS 7.1 beta と `runExternalCode` を指定し、content mapper を知らない vtsls を外しています。

VS Code などでは、TS 7.1 の言語サーバーに `initializationOptions.runExternalCode: true` を渡してください。

## 環境

| もの | バージョン |
|---|---|
| typescript | 7.1.0-beta |
| ts-content-mapper | 0.1.0 |
| hyparquet / hyparquet-compressors | 1.31.5 / 1.1.2 |
| Node | 24.10 以上（24.22.1 で確認） |

## 参考

- [Announcing TypeScript 7.1 Beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
- [ts-content-mapper](https://github.com/sxzz/ts-content-mapper)
- [GeoParquet](https://geoparquet.org/)
- [hyparquet](https://github.com/hyparam/hyparquet)
- [Overture Maps](https://overturemaps.org/)（データは各テーマのライセンスに従います）
