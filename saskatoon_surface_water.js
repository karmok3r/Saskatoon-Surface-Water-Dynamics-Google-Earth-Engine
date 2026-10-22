/******************************************************************************
 * Surface Water Dynamics — Saskatoon Region, Saskatchewan
 * Google Earth Engine (Code Editor, JavaScript)
 *
 * What it does
 *   1. Classifies open water in every clear Landsat 5/7/8/9 scene, 1984–present
 *      (MNDWI/NDVI/EVI rule of Zou et al. 2018), TM/ETM+ harmonized to OLI
 *   2. Builds annual water-frequency maps and annual open-water area, split
 *      into the South Saskatchewan River corridor and off-river water
 *      (prairie pothole wetlands, sloughs, lakes)
 *   3. Cross-checks the Landsat series against JRC Global Surface Water
 *   4. Maps the per-pixel trend in water frequency (Sen's slope)
 *   5. Tracks monthly water extent with Sentinel-2 (2019–present)
 *   6. Relates off-river water area to water-year precipitation and PDSI
 *      (TerraClimate)
 *   7. Exports rasters + CSV tables to Google Drive
 *
 * Author: Uday Karmoker
 ******************************************************************************/

// ============================ USER SETTINGS =================================

// Area of interest: Saskatoon, the South Saskatchewan River and the prairie
// pothole wetlands to the east (incl. St. Denis National Wildlife Area).
// Replace with your own: draw a rectangle and set AOI = geometry;
var AOI = ee.Geometry.Rectangle([-107.10, 51.85, -105.95, 52.40]);

// Landsat record
var START_YEAR = 1984;
var END_YEAR   = 2025;

// Open-water season (months, inclusive). Ice-off is usually mid/late April.
var START_MONTH = 5;
var END_MONTH   = 9;

// Water-frequency thresholds (share of clear observations classified as water)
var WATER_FREQ     = 0.25;  // open water during the season (Zou et al. 2018)
var PERMANENT_FREQ = 0.75;  // water for most of the season
var MIN_OBS        = 3;     // Landsat: fewer clear observations = no data
var MIN_OBS_S2     = 2;     // Sentinel-2, per month
var MIN_YEARS_TREND = 20;   // years with data needed for a pixel trend

// River corridor: HydroSHEDS reaches with upstream area above this (km2),
// buffered to cover the channel, bars and line-position error (m)
var RIVER_MIN_UPLAND_KM2 = 10000;
var RIVER_BUFFER_M       = 750;

// Sentinel-2 monthly series
var S2_START_YEAR = 2019;
var CS_THRESHOLD  = 0.6;    // Cloud Score+ cs_cdf; higher = stricter

// Scales (m). Charts use a coarser scale so the Console does not time out;
// exported tables use the full resolution.
var SCALE       = 30;
var S2_SCALE    = 20;
var CHART_SCALE = 90;

// Only years with at least this share of the AOI observed go into the
// climate correlation
var MIN_COVERAGE_PCT = 90;

// Export settings
var EXPORT_FOLDER = 'gee_saskatoon_water';
var EXPORT_CRS    = 'EPSG:3978';   // Canada Atlas Lambert

// ============================ LANDSAT HELPERS ================================

var BANDS = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];

// QA_PIXEL bits: 1 dilated cloud, 3 cloud, 4 cloud shadow, 5 snow.
// The water bit (7) is not masked: water is what we are mapping.
function qaMask(img) {
  var qa = img.select('QA_PIXEL');
  return qa.bitwiseAnd(1 << 1).eq(0)
    .and(qa.bitwiseAnd(1 << 3).eq(0))
    .and(qa.bitwiseAnd(1 << 4).eq(0))
    .and(qa.bitwiseAnd(1 << 5).eq(0));
}

// Landsat 8/9 OLI Collection 2 Level 2
function prepOLI(img) {
  var sr = img.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'], BANDS)
    .multiply(0.0000275).add(-0.2);
  return ee.Image(sr.updateMask(qaMask(img))
    .copyProperties(img, ['system:time_start']));
}

// Landsat 5 TM / 7 ETM+ Collection 2 Level 2, harmonized to OLI
// (Roy et al. 2016, ETM+ -> OLI OLS coefficients)
var SLOPES = ee.Image.constant([0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071]);
var ITCPS  = ee.Image.constant([0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172]);

function prepTM(img) {
  var sr = img.select(['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'], BANDS)
    .multiply(0.0000275).add(-0.2)
    .multiply(SLOPES).add(ITCPS)
    .rename(BANDS);
  return ee.Image(sr.updateMask(qaMask(img))
    .copyProperties(img, ['system:time_start']));
}

function landsat(start, end, region) {
  var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
    .filterBounds(region).filterDate(start, end).map(prepOLI);
  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterBounds(region).filterDate(start, end).map(prepOLI);
  var l7 = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
    .filterBounds(region).filterDate(start, end).map(prepTM);
  var l5 = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
    .filterBounds(region).filterDate(start, end).map(prepTM);
  return l9.merge(l8).merge(l7).merge(l5);
}

// ============================ SENTINEL-2 HELPERS =============================

var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');

// Sentinel-2 L2A with Cloud Score+ cloud/shadow mask; SCL 11 = snow / ice
function prepS2(img) {
  var clear = img.select('cs_cdf').gte(CS_THRESHOLD)
    .and(img.select('SCL').neq(11));
  var sr = img.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'], BANDS).divide(10000);
  return ee.Image(sr.updateMask(clear)
    .copyProperties(img, ['system:time_start']));
}

function sentinel2(start, end, region) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(region).filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
    .linkCollection(csPlus, ['cs_cdf'])
    .map(prepS2);
}

// ============================ WATER CLASSIFICATION ===========================

// Zou et al. (2018): water if (MNDWI > NDVI or MNDWI > EVI) and EVI < 0.1
function classifyWater(img) {
  var mndwi = img.normalizedDifference(['green', 'swir1']);
  var ndvi  = img.normalizedDifference(['nir', 'red']);
  var evi = img.expression(
    '2.5 * (nir - red) / (nir + 6 * red - 7.5 * blue + 1)', {
      nir: img.select('nir'), red: img.select('red'), blue: img.select('blue')
    });
  var water = mndwi.gt(ndvi).or(mndwi.gt(evi)).and(evi.lt(0.1));
  return ee.Image(water.rename('water')
    .copyProperties(img, ['system:time_start']));
}

// Share of clear observations that are water, plus the observation count
function waterFrequency(col, minObs) {
  var w = col.map(classifyWater);
  var nObs = w.count().rename('n_obs');
  return w.mean().rename('freq')
    .updateMask(nObs.gte(minObs))
    .addBands(nObs);
}

// ============================ RIVER CORRIDOR =================================
// South Saskatchewan River from HydroSHEDS (Lehner & Grill 2013). Water outside
// the corridor is treated as off-river water: wetlands, sloughs and lakes.
var rivers = ee.FeatureCollection('WWF/HydroSHEDS/v1/FreeFlowingRivers')
  .filterBounds(AOI)
  .filter(ee.Filter.gt('UPLAND_SKM', RIVER_MIN_UPLAND_KM2));
print('River reaches in AOI', rivers.size());

var riverZone = ee.Image(0).byte()
  .paint(rivers.map(function (f) { return f.buffer(RIVER_BUFFER_M); }), 1)
  .clip(AOI)
  .rename('river');

// ============================ AREA HELPERS ===================================

var pixelHa = ee.Image.pixelArea().divide(10000);
var AOI_HA  = AOI.area(1).divide(10000);

// Water area (ha) by zone, and the share of the AOI with valid data
function waterAreas(freq, scale) {
  var water = freq.gte(WATER_FREQ);
  var s = ee.Image.cat([
    pixelHa.updateMask(water).rename('water_ha'),
    pixelHa.updateMask(freq.gte(PERMANENT_FREQ)).rename('permanent_ha'),
    pixelHa.updateMask(water.and(riverZone)).rename('river_ha'),
    pixelHa.updateMask(water.and(riverZone.not())).rename('offriver_ha'),
    pixelHa.updateMask(freq.mask()).rename('valid_ha')
  ]).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: AOI,
    scale: scale,
    maxPixels: 1e13,
    tileScale: 4
  });
  return ee.Dictionary({
    water_ha: ee.Number(s.get('water_ha')).round(),
    permanent_ha: ee.Number(s.get('permanent_ha')).round(),
    river_ha: ee.Number(s.get('river_ha')).round(),
    offriver_ha: ee.Number(s.get('offriver_ha')).round(),
    coverage_pct: ee.Number(s.get('valid_ha')).divide(AOI_HA).multiply(1000).round().divide(10)
  });
}

// ============================ JRC GLOBAL SURFACE WATER =======================
// Pekel et al. (2016), v1.4: 1984–2021 Landsat water history
var gsw = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').clip(AOI);
var jrcYearly = ee.ImageCollection('JRC/GSW1_4/YearlyHistory');

// waterClass: 0 no data, 1 not water, 2 seasonal water, 3 permanent water
function jrcAreas(img, scale) {
  var wc = ee.Image(img).select('waterClass');
  var s = ee.Image.cat([
    pixelHa.updateMask(wc.gte(2)).rename('jrc_water_ha'),
    pixelHa.updateMask(wc.eq(3)).rename('jrc_permanent_ha')
  ]).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: AOI,
    scale: scale,
    maxPixels: 1e13,
    tileScale: 4
  });
  return ee.Dictionary({
    jrc_water_ha: ee.Number(s.get('jrc_water_ha')).round(),
    jrc_permanent_ha: ee.Number(s.get('jrc_permanent_ha')).round()
  });
}

// Transition classes 1984–1999 vs 2000–2021
var TRANSITION_NAMES = [
  'Permanent', 'New permanent', 'Lost permanent', 'Seasonal', 'New seasonal',
  'Lost seasonal', 'Seasonal to permanent', 'Permanent to seasonal',
  'Ephemeral permanent', 'Ephemeral seasonal'
];
var TRANSITION_PALETTE = [
  '0000ff', '22b14c', 'd1102d', '99d9ea', 'b5e61d',
  'e6a1aa', 'ff7f27', 'ffc90e', '7f7f7f', 'c3c3c3'
];

var transition = gsw.select('transition').updateMask(gsw.select('transition').gt(0));

var transitionStats = pixelHa.addBands(transition).reduceRegion({
  reducer: ee.Reducer.sum().group({groupField: 1, groupName: 'class'}),
  geometry: AOI,
  scale: SCALE,
  maxPixels: 1e13,
  tileScale: 4
});

var transitionTable = ee.FeatureCollection(
  ee.List(transitionStats.get('groups')).map(function (g) {
    g = ee.Dictionary(g);
    var c = ee.Number(g.get('class')).int();
    return ee.Feature(null, {
      class: c,
      name: ee.List(TRANSITION_NAMES).get(c.subtract(1)),
      area_ha: ee.Number(g.get('sum')).round()
    });
  })
);

print('JRC surface-water transitions, 1984–99 vs 2000–21 (ha)', transitionTable);
print(ui.Chart.feature.byFeature(transitionTable, 'name', 'area_ha')
  .setChartType('ColumnChart')
  .setOptions({
    title: 'Surface-water transitions (JRC GSW v1.4)',
    legend: {position: 'none'},
    vAxis: {title: 'Area (ha)'},
    colors: ['2166ac']
  }));

// ============================ CLIMATE ========================================
// TerraClimate (Abatzoglou et al. 2018), ~4.6 km monthly
var terra = ee.ImageCollection('IDAHO_EPSCOR/TERRACLIMATE');

// Water-year (Oct–Sep) precipitation, which includes the snowpack that fills
// prairie wetlands in spring, and mean PDSI over the open-water season
function climate(wy, y) {
  var season = terra.filterDate(
    ee.Date.fromYMD(y, START_MONTH, 1),
    ee.Date.fromYMD(y, END_MONTH, 1).advance(1, 'month'));
  var s = wy.select('pr').sum().rename('pr')
    .addBands(season.select('pdsi').mean().multiply(0.01).rename('pdsi'))
    .reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: AOI,
      scale: 4638,
      maxPixels: 1e13
    });
  return ee.Dictionary({
    wy_precip_mm: ee.Number(s.get('pr')).round(),
    pdsi: ee.Number(s.get('pdsi')).multiply(100).round().divide(100)
  });
}

// ============================ ANNUAL LANDSAT WATER ===========================

var years = ee.List.sequence(START_YEAR, END_YEAR);

var annual = ee.ImageCollection.fromImages(years.map(function (y) {
  y = ee.Number(y);
  var s = ee.Date.fromYMD(y, START_MONTH, 1);
  var e = ee.Date.fromYMD(y, END_MONTH, 1).advance(1, 'month');
  var col = landsat(s, e, AOI);
  var img = ee.Image(ee.Algorithms.If(
    col.size().gt(0),
    waterFrequency(col, MIN_OBS),
    ee.Image.constant([0, 0]).rename(['freq', 'n_obs']).updateMask(0)
  ));
  return img.clip(AOI).set({'system:time_start': s.millis(), year: y, n_scenes: col.size()});
}));

function annualTable(scale) {
  return ee.FeatureCollection(annual.map(function (img) {
    var y = ee.Number(img.get('year'));
    var f = ee.Feature(null, {year: y, n_scenes: img.get('n_scenes')})
      .set(waterAreas(img.select('freq'), scale));

    // JRC yearly history (ends 2021)
    var jrc = jrcYearly.filter(ee.Filter.calendarRange(y, y, 'year'));
    f = ee.Feature(ee.Algorithms.If(jrc.size().gt(0), f.set(jrcAreas(jrc.first(), scale)), f));

    // Climate, only when the whole water year is available
    var wy = terra.filterDate(ee.Date.fromYMD(y.subtract(1), 10, 1), ee.Date.fromYMD(y, 10, 1));
    return ee.Feature(ee.Algorithms.If(wy.size().eq(12), f.set(climate(wy, y)), f));
  }));
}

var annualChartTable = annualTable(CHART_SCALE);

print(ui.Chart.feature.byFeature(annualChartTable, 'year',
    ['water_ha', 'river_ha', 'offriver_ha', 'jrc_water_ha'])
  .setChartType('LineChart')
  .setOptions({
    title: 'Open-water area, ' + START_YEAR + '–' + END_YEAR + ' (' + CHART_SCALE + ' m preview)',
    hAxis: {title: 'Year', format: '####'},
    vAxis: {title: 'Area (ha)'},
    lineWidth: 2,
    pointSize: 3,
    series: {3: {lineDashStyle: [4, 4]}},
    colors: ['08306b', '2171b5', '41ab5d', '969696']
  }));

print(ui.Chart.feature.byFeature(annualChartTable, 'year', 'coverage_pct')
  .setChartType('ColumnChart')
  .setOptions({
    title: 'Share of AOI with >= ' + MIN_OBS + ' clear Landsat observations',
    hAxis: {title: 'Year', format: '####'},
    vAxis: {title: 'Coverage (%)', viewWindow: {min: 0, max: 100}},
    legend: {position: 'none'},
    colors: ['737373']
  }));

// Off-river water vs climate
var climTable = annualChartTable
  .filter(ee.Filter.notNull(['offriver_ha', 'wy_precip_mm', 'pdsi']))
  .filter(ee.Filter.gte('coverage_pct', MIN_COVERAGE_PCT));

print('Years used in climate correlation', climTable.size());
print('Pearson r (water-year precipitation vs off-river water area)',
  climTable.reduceColumns(ee.Reducer.pearsonsCorrelation(), ['wy_precip_mm', 'offriver_ha']));
print('Pearson r (season PDSI vs off-river water area)',
  climTable.reduceColumns(ee.Reducer.pearsonsCorrelation(), ['pdsi', 'offriver_ha']));

print(ui.Chart.feature.byFeature(annualChartTable, 'year', ['offriver_ha', 'wy_precip_mm'])
  .setChartType('LineChart')
  .setOptions({
    title: 'Off-river water (wetlands, sloughs, lakes) vs water-year precipitation',
    hAxis: {title: 'Year', format: '####'},
    series: {
      0: {targetAxisIndex: 0, color: '41ab5d'},
      1: {targetAxisIndex: 1, color: '6baed6', lineDashStyle: [4, 4]}
    },
    vAxes: {0: {title: 'Off-river water (ha)'}, 1: {title: 'Precipitation, Oct–Sep (mm)'}},
    lineWidth: 2,
    pointSize: 3
  }));

// ============================ PIXEL TREND ====================================
// Sen's slope of annual water frequency (change in frequency per decade)

var trendInput = annual.map(function (img) {
  var freq = img.select('freq');
  return freq.multiply(0).add(ee.Number(img.get('year'))).rename('year')
    .addBands(freq)
    .float();
});

var nYears  = annual.select('freq').count().rename('n_years');
var maxFreq = annual.select('freq').max().rename('max_freq');

var trend = trendInput.reduce(ee.Reducer.sensSlope()).select('slope')
  .multiply(10)
  .rename('freq_change_per_decade')
  .updateMask(nYears.gte(MIN_YEARS_TREND).and(maxFreq.gte(WATER_FREQ)));

var latest = ee.Image(annual.filter(ee.Filter.eq('year', END_YEAR)).first()).select('freq');

// ============================ SENTINEL-2 MONTHLY =============================

function s2Month(y, m, scale) {
  var s = ee.Date.fromYMD(y, m, 1);
  var col = sentinel2(s, s.advance(1, 'month'), AOI);
  var f = ee.Feature(null, {
    date: y + '-' + (m < 10 ? '0' : '') + m,
    year: y,
    month: m,
    n_scenes: col.size()
  });
  return ee.Feature(ee.Algorithms.If(
    col.size().gt(0),
    f.set(waterAreas(waterFrequency(col, MIN_OBS_S2).select('freq').clip(AOI), scale)),
    f
  ));
}

function monthlyTable(scale) {
  var feats = [];
  for (var y = S2_START_YEAR; y <= END_YEAR; y++) {
    for (var m = START_MONTH; m <= END_MONTH; m++) {
      feats.push(s2Month(y, m, scale));
    }
  }
  return ee.FeatureCollection(feats);
}

var monthlyChartTable = monthlyTable(CHART_SCALE)
  .filter(ee.Filter.gte('coverage_pct', 80));

print(ui.Chart.feature.byFeature(monthlyChartTable, 'date', ['river_ha', 'offriver_ha'])
  .setChartType('LineChart')
  .setOptions({
    title: 'Monthly open water, Sentinel-2 (months with >= 80% coverage)',
    hAxis: {title: 'Month', slantedText: true},
    vAxis: {title: 'Area (ha)'},
    lineWidth: 2,
    pointSize: 3,
    colors: ['2171b5', '41ab5d']
  }));

// ============================ MAP ============================================

Map.centerObject(AOI, 10);

var s2Summer = sentinel2(END_YEAR + '-07-01', END_YEAR + '-09-01', AOI).median().clip(AOI);
var freqVis = {min: 0, max: 1, palette: ['ffffff', 'c6dbef', '6baed6', '08306b']};

Map.addLayer(s2Summer, {bands: ['red', 'green', 'blue'], min: 0, max: 0.2},
  'Sentinel-2 Jul–Aug ' + END_YEAR);
Map.addLayer(gsw.select('occurrence').selfMask(),
  {min: 0, max: 100, palette: ['ffffff', 'ffbbbb', '0000ff']}, 'JRC water occurrence (%)', false);
Map.addLayer(transition, {min: 1, max: 10, palette: TRANSITION_PALETTE},
  'JRC transitions 1984–2021', false);
Map.addLayer(maxFreq.updateMask(maxFreq.gt(0)), freqVis,
  'Max annual water frequency ' + START_YEAR + '–' + END_YEAR, false);
Map.addLayer(latest.updateMask(latest.gt(0)), freqVis, 'Water frequency ' + END_YEAR);
Map.addLayer(trend, {min: -0.3, max: 0.3, palette: ['b2182b', 'f7f7f7', '2166ac']},
  'Water frequency trend (per decade)');
Map.addLayer(riverZone.selfMask(), {palette: ['ffff00']}, 'River corridor', false, 0.4);
Map.addLayer(ee.Image().paint(AOI, 0, 2), {palette: ['ff00ff']}, 'AOI');

// Legend
var legend = ui.Panel({style: {position: 'bottom-left', padding: '8px 12px'}});
legend.add(ui.Label('JRC water transitions', {fontWeight: 'bold'}));
TRANSITION_NAMES.forEach(function (n, i) {
  legend.add(ui.Panel([
    ui.Label('', {backgroundColor: '#' + TRANSITION_PALETTE[i], padding: '8px', margin: '2px 6px 2px 0'}),
    ui.Label(n, {margin: '2px 0'})
  ], ui.Panel.Layout.Flow('horizontal')));
});
legend.add(ui.Label('Trend: red = drying, blue = wetting', {margin: '6px 0 0 0'}));
Map.add(legend);

// ============================ EXPORTS ========================================

Export.image.toDrive({
  image: trend.addBands(nYears).addBands(maxFreq).addBands(latest.rename('freq_' + END_YEAR))
    .addBands(gsw.select('occurrence')).addBands(riverZone).toFloat(),
  description: 'water_trend_' + START_YEAR + '_' + END_YEAR,
  folder: EXPORT_FOLDER,
  region: AOI,
  scale: SCALE,
  crs: EXPORT_CRS,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: annual.select('freq').toBands()
    .rename(years.map(function (y) { return ee.String('freq_').cat(ee.Number(y).int().format()); }))
    .toFloat(),
  description: 'annual_water_frequency',
  folder: EXPORT_FOLDER,
  region: AOI,
  scale: SCALE,
  crs: EXPORT_CRS,
  maxPixels: 1e13
});

Export.table.toDrive({
  collection: annualTable(SCALE),
  description: 'annual_water_area',
  folder: EXPORT_FOLDER,
  fileFormat: 'CSV',
  selectors: ['year', 'n_scenes', 'coverage_pct', 'water_ha', 'permanent_ha', 'river_ha',
    'offriver_ha', 'jrc_water_ha', 'jrc_permanent_ha', 'wy_precip_mm', 'pdsi']
});

Export.table.toDrive({
  collection: monthlyTable(S2_SCALE),
  description: 's2_monthly_water_area',
  folder: EXPORT_FOLDER,
  fileFormat: 'CSV',
  selectors: ['date', 'year', 'month', 'n_scenes', 'coverage_pct', 'water_ha',
    'permanent_ha', 'river_ha', 'offriver_ha']
});

Export.table.toDrive({
  collection: transitionTable,
  description: 'jrc_transition_area',
  folder: EXPORT_FOLDER,
  fileFormat: 'CSV'
});
