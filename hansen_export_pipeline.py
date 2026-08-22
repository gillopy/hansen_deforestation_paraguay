# -*- coding: utf-8 -*-
"""
hansen_export_pipeline.py
==========================

Evolución de `hansen_global_forest_interactivo.py`. Pensado para correr en
Google Colab, igual que el notebook original, pero con dos diferencias:

1) Además de exportar imágenes PNG por departamento, calcula estadísticas
   reales (hectáreas de cobertura en 2000 y hectáreas de pérdida por año)
   usando reduceRegion sobre el propio dataset — el notebook original solo
   generaba mapas, no números.
2) Junta todo en un único `paraguay_deforestacion.json` (+ un `.csv`) con
   la MISMA estructura que espera `index.html`, así que al terminar de
   correr esto solo hace falta copiar `images/` y `data/` junto al
   artículo web para reemplazar las cifras de referencia (demo) por datos
   reales de Earth Engine.

De paso, esto resuelve el pendiente que quedaba anotado al final del
notebook original: "falta que el nombre del archivo guarde el año" — acá
cada imagen tiene un nombre estable por departamento y, si se usa
`export_year_slice`, por año también.

Uso típico en Colab:
    1. Subí tu `py.json` (límites de los departamentos) a /content/py.json
    2. Ejecutá este script de punta a punta (o celda por celda)
    3. Descargá las carpetas `salida_hansen/data/` y `salida_hansen/images/`
    4. Reemplazá esas mismas carpetas junto a `index.html`
"""

import ee
import geemap
import json
import os
import csv
import unicodedata
from datetime import datetime, timezone

# ==========================================================================
# CONFIGURACIÓN — ajustá esto a tu proyecto
# ==========================================================================
GEOJSON_PATH = '/content/py.json'
OUTPUT_DIR = '/content/salida_hansen'
IMAGES_DIR = os.path.join(OUTPUT_DIR, 'images')
DATA_DIR = os.path.join(OUTPUT_DIR, 'data')
JSON_PATH = os.path.join(DATA_DIR, 'paraguay_deforestacion.json')
CSV_PATH = os.path.join(DATA_DIR, 'paraguay_deforestacion.csv')

EARTH_ENGINE_PROJECT = 'hansen-480517'  # tu Project ID de Google Cloud
DATASET_ID = 'UMD/hansen/global_forest_change_2025_v1_13'

EXPORT_DIMENSIONS = '1600'   # resolución (px) de los PNG exportados
STATS_SCALE = 30             # metros por pixel para las estadísticas (30 = nativo)
CANOPY_THRESHOLD = 30        # % de copa mínimo para contar un pixel como "bosque" en 2000
YEAR_MIN, YEAR_MAX = 2001, 2025

# Departamentos con geometrías muy grandes (Chaco) pueden necesitar más
# "tileScale" para que reduceRegion no se quede sin memoria. Si un
# departamento falla, subí este número (8, 16...) antes de reintentar.
TILE_SCALE = 4

# ==========================================================================
# AUTENTICACIÓN Y DATASET (igual que en el notebook original)
# ==========================================================================
ee.Authenticate()
ee.Initialize(project=EARTH_ENGINE_PROJECT)

dataset = ee.Image(DATASET_ID)

tree_cover_vis_param = {
    'bands': ['treecover2000'],
    'min': 0,
    'max': 100,
    'palette': ['black', 'green'],
}

tree_loss_vis_param = {
    'bands': ['lossyear'],
    'min': 0,
    'max': 25,
    'palette': ['yellow', 'red'],
}


# ==========================================================================
# UTILIDADES
# ==========================================================================
def slugify(name):
    """'Presidente Hayes' -> 'presidente_hayes' (para nombres de archivo y URLs)."""
    n = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode('ascii')
    return n.lower().strip().replace(' ', '_')


def load_geojson(path=GEOJSON_PATH):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def iter_department_features(geojson_data):
    """Recorre el GeoJSON y devuelve (nombre, geometría) por cada departamento.

    Soporta FeatureCollection o Feature suelto, y acepta 'name', 'NOMBRE' o
    'nombre' como campo de nombre (ajustá esta lista si tu py.json usa otra
    clave)."""
    name_keys = ('name', 'NOMBRE', 'nombre', 'DEPARTAMEN', 'dep_desc')

    def get_name(props):
        for k in name_keys:
            if props.get(k):
                return props[k]
        return None

    if geojson_data['type'] == 'FeatureCollection':
        for feature in geojson_data['features']:
            props = feature.get('properties', {}) or {}
            name = get_name(props)
            if name:
                yield name, feature['geometry']
    elif geojson_data['type'] == 'Feature':
        props = geojson_data.get('properties', {}) or {}
        name = get_name(props)
        if name:
            yield name, geojson_data['geometry']
    else:
        raise ValueError("El GeoJSON debe ser 'FeatureCollection' o 'Feature'.")


# ==========================================================================
# ESTADÍSTICAS — lo que el notebook original no calculaba
# ==========================================================================
def compute_department_stats(geometry, scale=STATS_SCALE, tile_scale=TILE_SCALE):
    """Calcula, para una geometría de departamento:
      - cobertura de bosque en 2000 (ha)
      - pérdida por año, 2001-2025 (ha)
      - bounding box [minLon, minLat, maxLon, maxLat]
    """
    geom = ee.Geometry(geometry)

    # --- cobertura 2000: "bosque" = copa >= CANOPY_THRESHOLD ---
    forest_mask = dataset.select('treecover2000').gte(CANOPY_THRESHOLD)
    cover_area_img = forest_mask.multiply(ee.Image.pixelArea()).rename('area')
    cover_stats = cover_area_img.reduceRegion(
        reducer=ee.Reducer.sum(),
        geometry=geom, scale=scale, maxPixels=1e10,
        bestEffort=True, tileScale=tile_scale,
    ).getInfo()
    cover_ha = (cover_stats.get('area') or 0) / 10000.0

    # --- pérdida agrupada por año (patrón estándar de Earth Engine:
    #     reduceRegion + Reducer.sum().group() sobre la banda 'lossyear') ---
    loss_area_img = dataset.select('loss').multiply(ee.Image.pixelArea()).rename('area')
    grouped = loss_area_img.addBands(dataset.select('lossyear')).reduceRegion(
        reducer=ee.Reducer.sum().group(groupField=1, groupName='year'),
        geometry=geom, scale=scale, maxPixels=1e10,
        bestEffort=True, tileScale=tile_scale,
    ).getInfo()

    loss_by_year = {str(y): 0.0 for y in range(YEAR_MIN, YEAR_MAX + 1)}
    for group in grouped.get('groups', []):
        year_code = int(group['year'])
        if year_code == 0:
            continue  # 0 = pixel sin pérdida registrada
        year = 2000 + year_code
        if YEAR_MIN <= year <= YEAR_MAX:
            loss_by_year[str(year)] = round(group['area'] / 10000.0, 2)

    ring = geom.bounds(1).coordinates().getInfo()[0]
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    bbox = [min(lons), min(lats), max(lons), max(lats)]

    return cover_ha, loss_by_year, bbox


# ==========================================================================
# EXPORTACIÓN DE IMÁGENES — adaptado de export_department_images()
# ==========================================================================
def export_department_assets(name, geometry, dims=EXPORT_DIMENSIONS):
    """Exporta cobertura / pérdida / combinado para un departamento.
    A diferencia del notebook original, el nombre de archivo usa un slug
    estable (sin espacios ni tildes) y siempre vive en IMAGES_DIR, así que
    no se pisa entre corridas."""
    slug = slugify(name)
    geom = ee.Geometry(geometry)
    clipped = dataset.clip(geom)

    # --- cobertura ---
    cover_path = os.path.join(IMAGES_DIR, f'{slug}_cover.png')
    geemap.get_image_thumbnail(
        clipped, region=geom, dimensions=dims,
        vis_params=tree_cover_vis_param, out_img=cover_path, format='png',
    )

    # --- pérdida (solo pixeles donde loss == 1) ---
    loss_masked = clipped.select('lossyear').updateMask(clipped.select('loss'))
    loss_path = os.path.join(IMAGES_DIR, f'{slug}_loss.png')
    geemap.get_image_thumbnail(
        loss_masked, region=geom, dimensions=dims,
        vis_params=tree_loss_vis_param, out_img=loss_path, format='png',
    )

    # --- combinado: cobertura + pérdida + ganancia (2000-2012) ---
    cover_rgb = clipped.visualize(**tree_cover_vis_param)
    loss_rgb = loss_masked.visualize(**tree_loss_vis_param)
    gain_rgb = clipped.select('gain').selfMask().visualize(palette=['0000FF'])
    combined = cover_rgb.blend(loss_rgb).blend(gain_rgb)

    combined_path = os.path.join(IMAGES_DIR, f'{slug}_combined.png')
    geemap.get_image_thumbnail(
        combined, region=geom, dimensions=dims,
        vis_params={}, out_img=combined_path, format='png',
    )

    print(f'  imágenes exportadas para {name} ({slug}_*.png)')
    return {
        'cover': f'images/{slug}_cover.png',
        'loss': f'images/{slug}_loss.png',
        'combined': f'images/{slug}_combined.png',
    }


def export_year_slice(name, geometry, year, dims=EXPORT_DIMENSIONS):
    """Bonus: exporta la pérdida de UN solo año, con el año en el nombre de
    archivo. Esto es justo lo que el notebook original dejaba pendiente
    ("falta... que guarde el nombre de acuerdo al año generado"). No se usa
    en el flujo principal porque son muchas imágenes (departamentos × años);
    llamala manualmente si te sirve para una animación año a año."""
    slug = slugify(name)
    geom = ee.Geometry(geometry)
    clipped = dataset.clip(geom)
    year_code = year - 2000

    loss_year_img = clipped.select('lossyear').updateMask(
        clipped.select('lossyear').eq(year_code).And(clipped.select('loss'))
    )
    vis = {'bands': ['lossyear'], 'min': year_code, 'max': year_code, 'palette': ['red']}
    out_path = os.path.join(IMAGES_DIR, f'{slug}_loss_{year}.png')
    geemap.get_image_thumbnail(
        loss_year_img, region=geom, dimensions=dims,
        vis_params=vis, out_img=out_path, format='png',
    )
    return out_path


# ==========================================================================
# ARMADO DEL JSON / CSV QUE CONSUME index.html
# ==========================================================================
def build_dataset(geojson_path=GEOJSON_PATH, export_images=True):
    geojson_data = load_geojson(geojson_path)

    departments = []
    national_by_year = {str(y): 0.0 for y in range(YEAR_MIN, YEAR_MAX + 1)}
    national_cover = 0.0
    national_loss = 0.0

    for name, geometry in iter_department_features(geojson_data):
        print(f'Procesando {name}...')
        cover_ha, loss_by_year, bbox = compute_department_stats(geometry)
        loss_total_ha = round(sum(loss_by_year.values()), 2)
        loss_pct = round(loss_total_ha / cover_ha * 100, 2) if cover_ha else 0.0

        images = export_department_assets(name, geometry) if export_images else {
            'cover': f'images/{slugify(name)}_cover.png',
            'loss': f'images/{slugify(name)}_loss.png',
            'combined': f'images/{slugify(name)}_combined.png',
        }

        for y, ha in loss_by_year.items():
            national_by_year[y] += ha
        national_cover += cover_ha
        national_loss += loss_total_ha

        departments.append({
            'name': name,
            'slug': slugify(name),
            'treecover2000_ha': round(cover_ha, 1),
            'loss_total_ha': loss_total_ha,
            'loss_pct': loss_pct,
            'loss_by_year_ha': loss_by_year,
            'bbox': [round(v, 4) for v in bbox],
            'images': images,
        })

    data = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source_dataset': DATASET_ID,
        'is_demo_data': False,
        'years': list(range(YEAR_MIN, YEAR_MAX + 1)),
        'national': {
            'treecover2000_ha': round(national_cover, 1),
            'loss_total_ha': round(national_loss, 1),
            'loss_pct': round(national_loss / national_cover * 100, 2) if national_cover else 0.0,
            'loss_by_year_ha': {k: round(v, 1) for k, v in national_by_year.items()},
        },
        'departments': departments,
        'note': f'Estadísticas calculadas sobre {DATASET_ID} vía Google Earth Engine.',
    }
    return data


def write_outputs(data):
    os.makedirs(DATA_DIR, exist_ok=True)

    with open(JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    with open(CSV_PATH, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['departamento', 'slug', 'anio', 'perdida_ha',
                    'cobertura_2000_ha', 'perdida_total_ha', 'perdida_pct'])
        for d in data['departments']:
            for year in data['years']:
                w.writerow([
                    d['name'], d['slug'], year,
                    d['loss_by_year_ha'].get(str(year), 0.0),
                    d['treecover2000_ha'], d['loss_total_ha'], d['loss_pct'],
                ])

    print(f'\nListo:')
    print(f'  {JSON_PATH}')
    print(f'  {CSV_PATH}')
    print(f'  {IMAGES_DIR}/  ({len(data["departments"]) * 3} imágenes)')
    print('\nCopiá las carpetas "data/" e "images/" junto a index.html para')
    print('reemplazar las cifras de referencia (demo) por datos reales.')


def main():
    os.makedirs(IMAGES_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    data = build_dataset()
    write_outputs(data)


if __name__ == '__main__':
    main()


# ==========================================================================
# EXPLORADOR INTERACTIVO OPCIONAL (ipywidgets) — igual espíritu que el
# notebook original, para revisar un departamento a la vez dentro de Colab
# sin tener que correr todo el pipeline.
# ==========================================================================
def launch_interactive_explorer():
    import ipywidgets as widgets
    from IPython.display import display, clear_output

    geojson_data = load_geojson()
    names = sorted(name for name, _ in iter_department_features(geojson_data))
    geometry_by_name = dict(iter_department_features(geojson_data))

    dept_dropdown = widgets.Dropdown(options=names, description='Departamento:')
    resolution_slider = widgets.IntSlider(value=1600, min=500, max=4000, step=100,
                                           description='Resolución (px):', continuous_update=False)
    export_button = widgets.Button(description='Calcular y exportar')
    output_widget = widgets.Output()

    def on_click(_b):
        with output_widget:
            clear_output(wait=True)
            name = dept_dropdown.value
            geometry = geometry_by_name[name]
            print(f'Calculando estadísticas de {name}...')
            cover_ha, loss_by_year, bbox = compute_department_stats(geometry)
            loss_total_ha = round(sum(loss_by_year.values()), 2)
            loss_pct = round(loss_total_ha / cover_ha * 100, 2) if cover_ha else 0.0
            print(f'Cobertura 2000: {cover_ha:,.0f} ha')
            print(f'Pérdida total:  {loss_total_ha:,.0f} ha ({loss_pct}%)')
            export_department_assets(name, geometry, dims=str(resolution_slider.value))

    export_button.on_click(on_click)
    display(dept_dropdown, resolution_slider, export_button, output_widget)


# Para usarlo en Colab, descomentá:
# launch_interactive_explorer()
