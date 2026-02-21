// ======================================================
// Hansen Global Forest Change 2024 v1.12
// ======================================================

var dataset = ee.Image('UMD/hansen/global_forest_change_2024_v1_12');

var loss = dataset.select('lossyear');
var treecover2000 = dataset.select('treecover2000');

// ======================================================
// 1. DEFINIR POLÍGONO (EDITAR COORDENADAS)
// ======================================================
var polygon = ee.Geometry.Polygon([
  [
    [-58.170895485496679, -19.833040755706904],
    [-58.171130676138745, -19.833125160499069],
    [-58.171140092699538, -19.833129609162906],
    [-58.171403867394645, -19.833174469598912],
    [-58.170895485496679, -19.833040755706904]  // cerrar polígono
  ]
]);


Map.centerObject(polygon, 17);

var datasetClipped = dataset.clip(polygon);

// ======================================================
// 2. PARÁMETROS ANALÍTICOS
// ======================================================

var forestMask = treecover2000.gte(30);
var pixelArea = ee.Image.pixelArea();

// HISTÓRICO 2001–2022 (mantiene valores originales)
var loss2001_2022 = loss.updateMask(
  loss.gte(1).and(loss.lte(22))
);

// 2023 y 2024
var loss2023 = loss.eq(23);
var loss2024 = loss.eq(24);

// Para métricas forestales
var loss2023_forest = loss2023.updateMask(forestMask);
var loss2024_forest = loss2024.updateMask(forestMask);

// ======================================================
// 3. CÁLCULO DE ÁREAS
// ======================================================

var area2023 = loss2023_forest.multiply(pixelArea).reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: polygon,
  scale: 30,
  maxPixels: 1e13,
  tileScale: 4
});

var area2024 = loss2024_forest.multiply(pixelArea).reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: polygon,
  scale: 30,
  maxPixels: 1e13,
  tileScale: 4
});

var ha2023 = ee.Number(area2023.get('lossyear')).divide(10000);
var ha2024 = ee.Number(area2024.get('lossyear')).divide(10000);

var totalArea_m2 = polygon.area(1);
var totalArea_ha = totalArea_m2.divide(10000);
var totalArea_km2 = totalArea_m2.divide(1e6);

var forestArea = forestMask.multiply(pixelArea).reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: polygon,
  scale: 30,
  maxPixels: 1e13,
  tileScale: 4
});

var forest_ha = ee.Number(forestArea.get('treecover2000')).divide(10000);

var pctAOI_2023 = ha2023.divide(totalArea_ha).multiply(100);
var pctAOI_2024 = ha2024.divide(totalArea_ha).multiply(100);

var pctForest_2023 = ha2023.divide(forest_ha).multiply(100);
var pctForest_2024 = ha2024.divide(forest_ha).multiply(100);

// Resultados
print('Área total AOI (ha):', totalArea_ha);
print('Área total AOI (km²):', totalArea_km2);
print('Bosque inicial (ha):', forest_ha);

print('Pérdida forestal 2023 (ha):', ha2023);
print('Pérdida forestal 2024 (ha):', ha2024);

print('% AOI afectado 2023:', pctAOI_2023);
print('% AOI afectado 2024:', pctAOI_2024);

print('% bosque inicial perdido 2023:', pctForest_2023);
print('% bosque inicial perdido 2024:', pctForest_2024);

// ======================================================
// 4. VISUALIZACIÓN
// ======================================================

// Tree Cover 2000
var treeCoverVisParam = {
  bands: ['treecover2000'],
  min: 0,
  max: 100,
  palette: ['black', 'green']
};

// Escala histórica 2001–2022
var lossHistoricVis = {
  min: 1,
  max: 22,
  palette: [
    'yellow',
    'orange',
    'red'
  ]
};

// 2023 y 2024 diferenciados
var loss2023Vis = {palette: ['magenta']};
var loss2024Vis = {palette: ['cyan']};

Map.addLayer(datasetClipped.select('treecover2000'),
             treeCoverVisParam,
             'Tree Cover 2000');

Map.addLayer(loss2001_2022.clip(polygon),
             lossHistoricVis,
             'Loss 2001–2022');

Map.addLayer(loss2023.updateMask(loss2023).clip(polygon),
             loss2023Vis,
             'Loss 2023');

Map.addLayer(loss2024.updateMask(loss2024).clip(polygon),
             loss2024Vis,
             'Loss 2024');

Map.addLayer(polygon, {color: 'white'}, 'AOI');

// ======================================================
// 5. EXPORTACIÓN ANALÍTICA (GeoTIFF crudo)
// ======================================================

Export.image.toDrive({
  image: datasetClipped.select('treecover2000'),
  description: 'TreeCover2000_Raw_2024v112',
  folder: 'EarthEngineExports',
  region: polygon,
  scale: 30,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: datasetClipped.select('lossyear'),
  description: 'TreeLossYear_Raw_2024v112',
  folder: 'EarthEngineExports',
  region: polygon,
  scale: 30,
  maxPixels: 1e13
});

// ======================================================
// 6. EXPORTACIÓN VISUAL
// ======================================================

var treeCoverRGB = datasetClipped
  .select('treecover2000')
  .visualize(treeCoverVisParam);

Export.image.toDrive({
  image: treeCoverRGB,
  description: 'TreeCover2000_Visual',
  folder: 'EarthEngineExports',
  region: polygon,
  scale: 30,
  maxPixels: 1e13
});

var lossHistoricRGB = loss2001_2022
  .clip(polygon)
  .visualize(lossHistoricVis);

Export.image.toDrive({
  image: lossHistoricRGB,
  description: 'Loss_2001_2022_Visual',
  folder: 'EarthEngineExports',
  region: polygon,
  scale: 30,
  maxPixels: 1e13
});

var loss2023RGB = loss2023.clip(polygon).visualize(loss2023Vis);
var loss2024RGB = loss2024.clip(polygon).visualize(loss2024Vis);

Export.image.toDrive({
  image: loss2023RGB,
  description: 'Loss2023_Visual',
  folder: 'EarthEngineExports',
  region: polygon,
  scale: 30,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: loss2024RGB,
  description: 'Loss2024_Visual',
  folder: 'EarthEngineExports',
  region: polygon,
  scale: 30,
  maxPixels: 1e13
});

