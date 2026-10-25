#!/bin/sh
# data/facilities.parquet を作る（example ディレクトリで実行）
# 1. DuckDB で 1000 件のデータを作る（中間ファイル）
# 2. GDAL で 100 行ずつの row group に区切り、GeoParquet（CRS は PROJJSON、bbox 列付き）として書き出す
set -eu
duckdb < scripts/make-facilities.sql > /dev/null
rm -f data/facilities.parquet
ogr2ogr -f Parquet data/facilities.parquet data/facilities.tmp.parquet \
  -nln facilities -a_srs EPSG:6680 -lco ROW_GROUP_SIZE=100 -lco FID=
rm data/facilities.tmp.parquet
