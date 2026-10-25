-- 札幌市の架空の施設 1000 件（10 区 × 100 件）を GeoParquet で書き出す
-- 実行: sh scripts/make-facilities.sh（example ディレクトリで）
--
-- このファイルは中間ファイルを作るだけ。DuckDB は 2048 行単位で書き出すので、
-- row group を 100 行に区切る作業は make-facilities.sh の ogr2ogr で行う。
-- 区ごとに並べてあるので、100 行ずつ区切ると 1 つの row group = 1 つの区になる。
-- row group ごとの統計（最小・最大・null の数）に差が出るよう、区ごとに値の傾向を変えている。

INSTALL spatial;
LOAD spatial;
SET threads = 1;              -- row group の切れ目を行の順番どおりにする
SELECT setseed(0.42);         -- 毎回同じデータにする

CREATE TABLE wards AS
SELECT * FROM (VALUES
  (0, '中央区', 141.354, 43.055, 5.0),
  (1, '北区',   141.340, 43.105, 2.0),
  (2, '東区',   141.365, 43.095, 2.0),
  (3, '白石区', 141.405, 43.045, 1.5),
  (4, '豊平区', 141.380, 43.030, 1.5),
  (5, '南区',   141.320, 42.960, 0.5),
  (6, '西区',   141.290, 43.075, 1.2),
  (7, '厚別区', 141.475, 43.040, 1.0),
  (8, '手稲区', 141.245, 43.110, 0.7),
  (9, '清田区', 141.445, 42.995, 0.6)
) AS t(ward_no, ward, lon, lat, scale);

CREATE TABLE facilities AS
WITH base AS (
  SELECT
    w.*,
    n,
    random() AS r1, random() AS r2, random() AS r3, random() AS r4, random() AS r5
  FROM wards w, range(100) AS t(n)
)
SELECT
  (ward_no * 1000 + n + 1)::BIGINT AS id,
  ward,
  ['駅', '公園', '学校', '病院', '図書館', 'コンビニ'][1 + floor(r1 * 6)::INT] AS category,
  ward || ['駅', '公園', '学校', '病院', '図書館', 'コンビニ'][1 + floor(r1 * 6)::INT] || (n + 1) AS name,
  -- 南区と手稲区だけ、開業年が不明（null）の施設がある
  CASE WHEN ward IN ('南区', '手稲区') AND r2 < 0.3 THEN NULL
       ELSE (1950 + floor(r2 * 76))::INT END AS opened,
  -- 区ごとに規模が違う（中央区は大きく、南区は小さい）
  (100 + floor(r3 * 10000 * scale))::INT AS visitors,
  r4 > 0.1 AS is_open,
  TIMESTAMP '2026-01-01' + to_seconds((r5 * 86400 * 290)::BIGINT) AS updated_at,
  CASE WHEN r4 < 0.3 THEN ['バリアフリー']
       WHEN r4 < 0.5 THEN ['駐車場', 'バリアフリー']
       WHEN r4 < 0.6 THEN []::VARCHAR[]
       ELSE ['駐車場'] END AS tags,
  -- 区の中心から ±約 2km にばらまき、平面直角座標系 XII 系（EPSG:6680）に変換
  ST_Transform(
    ST_Point(lon + (r2 - 0.5) * 0.05, lat + (r3 - 0.5) * 0.035),
    'EPSG:4326', 'EPSG:6680', always_xy := true
  ) AS geometry
FROM base
ORDER BY ward_no, n;

COPY (
  SELECT * EXCLUDE (geometry), ST_SetCRS(geometry, 'EPSG:6680') AS geometry FROM facilities
) TO 'data/facilities.tmp.parquet' (FORMAT parquet);
