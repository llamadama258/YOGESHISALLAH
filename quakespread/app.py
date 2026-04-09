"""
QuakeSpread — Flask Backend

API Endpoints:
    POST /simulate    — Run earthquake damage simulation
    GET  /recent      — Recent M3.0+ earthquakes from USGS
    GET  /vs30        — VS30 soil value lookup
    GET  /ocean-check — Check if lat/lng is in ocean (NOAA ETOPO1)
    POST /tsunami     — Run tsunami wave propagation simulation
"""

import os
import math
import time
import threading
import heapq
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from dotenv import load_dotenv
from scipy.interpolate import NearestNDInterpolator

from model import predict_batch

load_dotenv()

app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# VS30 lookup with caching
# ---------------------------------------------------------------------------
_vs30_cache = {}
VS30_DEFAULT = 360.0

# ---------------------------------------------------------------------------
# NOAA ETOPO1 bathymetry constants
# ---------------------------------------------------------------------------
ETOPO1_URL = (
    "https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics"
    "/DEM_global_mosaic/ImageServer/identify"
)
_bathy_cache = {}  # (rounded_lat, rounded_lng) -> elevation_m

# ---------------------------------------------------------------------------
# NOAA historical tsunami database
# ---------------------------------------------------------------------------
NOAA_TSUNAMI_URL = (
    "https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/tsunamis/events"
)

# ---------------------------------------------------------------------------
# DART buoy network — known active buoy positions
# ---------------------------------------------------------------------------
DART_BUOYS = [
    {"id": "21418", "lat": 38.711,  "lng": 148.694,  "name": "DART 21418 (NW Pacific)"},
    {"id": "21413", "lat": 30.519,  "lng": 152.117,  "name": "DART 21413 (Japan)"},
    {"id": "21401", "lat": 42.617,  "lng": 152.583,  "name": "DART 21401 (NW Pacific)"},
    {"id": "21415", "lat": 14.601,  "lng": 176.247,  "name": "DART 21415 (W Pacific)"},
    {"id": "21416", "lat": 19.273,  "lng": 174.878,  "name": "DART 21416 (Micronesia)"},
    {"id": "52402", "lat": 11.883,  "lng": 154.116,  "name": "DART 52402 (W Pacific)"},
    {"id": "52403", "lat":  4.053,  "lng": 141.851,  "name": "DART 52403 (W Pacific)"},
    {"id": "55015", "lat": -24.637, "lng": 177.685,  "name": "DART 55015 (Tonga)"},
    {"id": "55023", "lat": -10.010, "lng": 170.009,  "name": "DART 55023 (Solomon Is.)"},
    {"id": "46407", "lat": 54.007,  "lng": -136.102, "name": "DART 46407 (Gulf of Alaska)"},
    {"id": "46408", "lat": 58.893,  "lng": -144.694, "name": "DART 46408 (Alaska)"},
    {"id": "46409", "lat": 55.497,  "lng": -155.949, "name": "DART 46409 (Alaska)"},
    {"id": "46411", "lat": 39.313,  "lng": -126.001, "name": "DART 46411 (NE Pacific)"},
    {"id": "46412", "lat": 37.936,  "lng": -129.977, "name": "DART 46412 (NE Pacific)"},
    {"id": "46419", "lat": 48.487,  "lng": -129.381, "name": "DART 46419 (NE Pacific)"},
    {"id": "32401", "lat": -17.975, "lng": -100.131, "name": "DART 32401 (SE Pacific)"},
    {"id": "32412", "lat":  8.492,  "lng": -125.028, "name": "DART 32412 (E Pacific)"},
    {"id": "43412", "lat": 11.138,  "lng":  -93.527, "name": "DART 43412 (E Pacific)"},
    {"id": "23401", "lat":  -4.061, "lng":   86.932, "name": "DART 23401 (Indian Ocean)"},
    {"id": "23227", "lat": -13.700, "lng":   53.200, "name": "DART 23227 (Indian Ocean)"},
]

USGS_VS30_URL = (
    "https://earthquake.usgs.gov/arcgis/rest/services/eq/vs30_mosaic/MapServer/identify"
)


# ---------------------------------------------------------------------------
# NOAA ETOPO1 bathymetry fetch
# ---------------------------------------------------------------------------

def _round_bathy(val, precision=0.1):
    return round(val / precision) * precision


def fetch_elevation_single(lat, lng):
    """Return elevation (m) from NOAA ETOPO1 global mosaic.

    Negative values = ocean depth below sea level.
    Positive values = land elevation above sea level.
    """
    key = (_round_bathy(lat), _round_bathy(lng))
    if key in _bathy_cache:
        return _bathy_cache[key]

    try:
        params = {
            "geometry": f"{lng},{lat}",
            "geometryType": "esriGeometryPoint",
            "returnGeometry": "false",
            "returnCatalogItems": "false",
            "f": "json",
        }
        resp = requests.get(ETOPO1_URL, params=params, timeout=8)
        resp.raise_for_status()
        data = resp.json()
        val = data.get("value", "NoData")
        if val and val != "NoData":
            elev = float(val)
            _bathy_cache[key] = elev
            return elev
    except Exception:
        pass

    # Default: assume deep ocean (-4000m) — safer than assuming land
    _bathy_cache[key] = -4000.0
    return -4000.0


# ---------------------------------------------------------------------------
# Tsunami helpers
# ---------------------------------------------------------------------------
_G = 9.81  # gravity m/s²


def _wave_speed_ms(depth_m):
    """Shallow-water wave speed c = sqrt(g * d)."""
    return math.sqrt(_G * max(depth_m, 1.0))


def _initial_wave_height(magnitude):
    """Source wave height estimate (Abe 1979 empirical formula, meters)."""
    return max(0.05, 10 ** (0.5 * magnitude - 3.5))


def _rupture_radius_km(magnitude):
    """Approximate half-length of rupture zone (km)."""
    return max(20.0, 10 ** (0.5 * magnitude - 2.0))


def _check_noaa_tsunami(lat, lng, magnitude):
    """Query NOAA historical tsunami database for events near this location.

    Returns (source_tag, event_dict_or_None).
    """
    try:
        # Year window: look across the full catalog
        params = {
            "minLatitude": lat - 3.0,
            "maxLatitude": lat + 3.0,
            "minLongitude": lng - 3.0,
            "maxLongitude": lng + 3.0,
            "minMagnitude": magnitude - 0.8,
            "maxMagnitude": magnitude + 0.8,
            "orderBy": "time",
            "limit": 5,
        }
        resp = requests.get(NOAA_TSUNAMI_URL, params=params, timeout=8)
        resp.raise_for_status()
        data = resp.json()
        items = data.get("items", [])
        if items:
            ev = items[0]
            return "real", {
                "year": ev.get("year"),
                "location": ev.get("locationName", "Unknown"),
                "magnitude": ev.get("eqMagnitude"),
                "max_wave_height": ev.get("maximumWaterHeight"),
            }
    except Exception:
        pass
    return "simulated", None


def _get_nearby_dart_buoys(lat, lng, radius_km=4000):
    """Return DART buoys within radius_km of the given point."""
    nearby = []
    for b in DART_BUOYS:
        d = haversine(lat, lng, b["lat"], b["lng"])
        if d <= radius_km:
            # Try fetching real-time status (optional — fails gracefully)
            status = _fetch_dart_status(b["id"])
            nearby.append({
                "id": b["id"],
                "lat": b["lat"],
                "lng": b["lng"],
                "name": b["name"],
                "distance_km": round(d, 0),
                "status": status,
            })
    nearby.sort(key=lambda x: x["distance_km"])
    return nearby[:8]  # Limit to 8 nearest


def _fetch_dart_status(buoy_id):
    """Fetch latest DART buoy reading; returns dict or None."""
    try:
        url = f"https://www.ndbc.noaa.gov/data/realtime2/{buoy_id}.dart"
        resp = requests.get(url, timeout=5)
        if resp.status_code != 200:
            return None
        lines = [l for l in resp.text.splitlines() if not l.startswith("#")]
        if len(lines) < 2:
            return None
        # Most-recent data line
        parts = lines[-1].split()
        # DART format: YY MM DD hh mm ss T HEIGHT(m) ...
        if len(parts) >= 8:
            try:
                height = float(parts[7])
                return {"wc_height_m": round(height, 3), "online": True}
            except ValueError:
                pass
        return {"online": True}
    except Exception:
        return None


def _run_tsunami_simulation(epi_lat, epi_lng, magnitude, depth_km):
    """
    Run a Dijkstra-based tsunami wave propagation on an ETOPO1 bathymetry grid.

    Returns (animation_rings, coastline_impacts).
    """
    SIM_RADIUS_KM = 1500
    GRID_STEP_KM  = 80

    lat_step = GRID_STEP_KM / 111.0
    lon_step = GRID_STEP_KM / (111.0 * math.cos(math.radians(epi_lat)))

    n_half_lat = int(SIM_RADIUS_KM / (GRID_STEP_KM * 0.9)) + 1
    n_half_lon = int(SIM_RADIUS_KM / (GRID_STEP_KM * 0.9)) + 1

    n_lat = 2 * n_half_lat + 1
    n_lon = 2 * n_half_lon + 1
    ci, cj = n_half_lat, n_half_lon  # center indices

    grid_lats = [epi_lat + (i - ci) * lat_step for i in range(n_lat)]
    grid_lons = [epi_lng + (j - cj) * lon_step for j in range(n_lon)]

    # Collect cells within radius
    in_radius = []
    for i, la in enumerate(grid_lats):
        if la < -85 or la > 85:
            continue
        for j, lo in enumerate(grid_lons):
            dist = haversine(epi_lat, epi_lng, la, lo)
            if dist <= SIM_RADIUS_KM:
                in_radius.append((i, j, la, lo, dist))

    if not in_radius:
        return [], []

    # Sample bathymetry at up to 220 representative points
    n_samples = min(220, len(in_radius))
    sample_idx = np.linspace(0, len(in_radius) - 1, n_samples, dtype=int)
    samples = [in_radius[k] for k in sample_idx]

    with ThreadPoolExecutor(max_workers=15) as exc:
        elev_vals = list(exc.map(
            lambda c: fetch_elevation_single(c[2], c[3]), samples
        ))

    # Interpolate to all in-radius cells
    scoords = np.array([[s[2], s[3]] for s in samples])
    interp  = NearestNDInterpolator(scoords, elev_vals)
    acoords = np.array([[c[2], c[3]] for c in in_radius])
    all_elevs = interp(acoords)

    # Populate 2D arrays
    LAND_ELEV = 9999.0
    elev_grid  = np.full((n_lat, n_lon), LAND_ELEV)
    depth_grid = np.zeros((n_lat, n_lon))  # ocean depth (m), 0 = land/outside

    for (i, j, la, lo, dist), elev in zip(in_radius, all_elevs):
        elev_grid[i, j] = elev
        if elev < 0:
            depth_grid[i, j] = max(1.0, -elev)

    # If epicenter cell is marked land (possible interpolation error), force ocean
    epi_elev = elev_grid[ci, cj]
    if epi_elev >= 0:
        depth_grid[ci, cj] = 500.0  # assume 500m if we can't resolve it

    # Dijkstra travel-time propagation (seconds)
    INF = 1e18
    time_grid = np.full((n_lat, n_lon), INF)
    time_grid[ci, cj] = 0.0
    pq = [(0.0, ci, cj)]

    while pq:
        t, i, j = heapq.heappop(pq)
        if t > time_grid[i, j] + 1.0:
            continue
        if depth_grid[i, j] == 0:
            continue

        for di, dj in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ni, nj = i + di, j + dj
            if not (0 <= ni < n_lat and 0 <= nj < n_lon):
                continue
            if depth_grid[ni, nj] == 0:
                continue

            avg_depth = (depth_grid[i, j] + depth_grid[ni, nj]) / 2.0
            speed_ms  = _wave_speed_ms(avg_depth)
            dist_m    = haversine(grid_lats[i], grid_lons[j],
                                  grid_lats[ni], grid_lons[nj]) * 1000.0
            new_t = t + dist_m / speed_ms
            if new_t < time_grid[ni, nj]:
                time_grid[ni, nj] = new_t
                heapq.heappush(pq, (new_t, ni, nj))

    # Collect animation data
    H0     = _initial_wave_height(magnitude)
    R0_km  = _rupture_radius_km(magnitude)

    animation_cells = []
    coastline_impacts = []

    for i in range(n_lat):
        for j in range(n_lon):
            t = time_grid[i, j]
            if t >= INF or depth_grid[i, j] == 0:
                continue

            la  = grid_lats[i]
            lo  = grid_lons[j]
            t_m = t / 60.0
            r   = haversine(epi_lat, epi_lng, la, lo)

            # Cylindrical spreading
            h = H0 * math.sqrt(R0_km / max(R0_km, r))

            # Green's Law shoaling at d < 500m
            d = depth_grid[i, j]
            if d < 500.0:
                h = h * (4000.0 / max(1.0, d)) ** 0.25

            h = min(h, 120.0)  # physical cap

            animation_cells.append({
                "lat":            round(la, 4),
                "lng":            round(lo, 4),
                "travel_minutes": round(t_m, 1),
                "depth":          round(d, 0),
                "height_m":       round(h, 2),
            })

            # Coastline cell = ocean adjacent to land
            is_coast = any(
                0 <= i + di < n_lat and
                0 <= j + dj < n_lon and
                elev_grid[i + di, j + dj] >= 0 and
                elev_grid[i + di, j + dj] < LAND_ELEV
                for di, dj in ((-1, 0), (1, 0), (0, -1), (0, 1))
            )
            if is_coast and t_m > 0.5:
                coastline_impacts.append({
                    "lat":            round(la, 4),
                    "lng":            round(lo, 4),
                    "travel_minutes": round(t_m, 1),
                    "height_m":       round(h, 2),
                })

    animation_cells.sort(key=lambda x: x["travel_minutes"])
    coastline_impacts.sort(key=lambda x: x["travel_minutes"])

    # Group animation cells into 4-minute time bands
    BAND_MIN = 4
    bands = {}
    for cell in animation_cells:
        b = int(cell["travel_minutes"] / BAND_MIN)
        bands.setdefault(b, []).append(cell)

    animation_rings = [
        {"travel_minutes": b * BAND_MIN, "cells": bands[b]}
        for b in sorted(bands)
    ]

    return animation_rings, coastline_impacts


def _round_coord(val, precision=0.02):
    return round(val / precision) * precision


def fetch_vs30_single(lat, lng):
    """Fetch VS30 value for a single lat/lng from USGS ArcGIS service."""
    key = (_round_coord(lat), _round_coord(lng))
    if key in _vs30_cache:
        return _vs30_cache[key]

    try:
        params = {
            "geometryType": "esriGeometryPoint",
            "geometry": f"{lng},{lat}",
            "sr": "4326",
            "tolerance": "1",
            "mapExtent": f"{lng - 1},{lat - 1},{lng + 1},{lat + 1}",
            "imageDisplay": "100,100,96",
            "layers": "all",
            "f": "json",
        }
        resp = requests.get(USGS_VS30_URL, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])
        if results:
            pixel_val = results[0].get("attributes", {}).get("Classify.Pixel Value")
            if pixel_val is not None:
                vs30 = float(pixel_val)
                if vs30 > 0:
                    _vs30_cache[key] = vs30
                    return vs30
    except Exception:
        pass

    _vs30_cache[key] = VS30_DEFAULT
    return VS30_DEFAULT


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def calculate_azimuth(lat1, lon1, lat2, lon2):
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlon = rlon2 - rlon1
    x = math.sin(dlon) * math.cos(rlat2)
    y = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(dlon)
    bearing = math.degrees(math.atan2(x, y))
    return (bearing + 360) % 360


# ---------------------------------------------------------------------------
# Recent earthquakes cache
# ---------------------------------------------------------------------------
_recent_cache = {"data": None, "timestamp": 0}
RECENT_CACHE_TTL = 600  # 10 minutes

USGS_RECENT_URL = (
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson"
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/simulate", methods=["POST"])
def simulate():
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    lat = data.get("lat")
    lng = data.get("lng")
    magnitude = data.get("magnitude")
    depth = data.get("depth")
    # Validate inputs
    errors = []
    if lat is None or not (-90 <= lat <= 90):
        errors.append("lat must be between -90 and 90")
    if lng is None or not (-180 <= lng <= 180):
        errors.append("lng must be between -180 and 180")
    if magnitude is None or not (3.0 <= magnitude <= 9.0):
        errors.append("magnitude must be between 3.0 and 9.0")
    if depth is None or not (0 <= depth <= 700):
        errors.append("depth must be between 0 and 700")
    if errors:
        return jsonify({"error": "; ".join(errors)}), 400

    # Scale simulation radius with magnitude — larger quakes affect much wider areas.
    # Approximate felt-radius from empirical seismology (Wald et al.).
    radius_km = int(10 ** (0.32 * magnitude - 0.09))  # ~20km at M3, ~80km at M5, ~300km at M7, ~700km at M9
    radius_km = max(20, min(800, radius_km))
    step_km = max(3, radius_km // 50)  # keep grid ~50 cells across
    lat_step = step_km / 111.0
    lon_step = step_km / (111.0 * math.cos(math.radians(lat)))

    lat_range = radius_km / 111.0
    lon_range = radius_km / (111.0 * math.cos(math.radians(lat)))

    grid_points = []
    cur_lat = lat - lat_range
    while cur_lat <= lat + lat_range:
        cur_lng = lng - lon_range
        while cur_lng <= lng + lon_range:
            dist = haversine(lat, lng, cur_lat, cur_lng)
            if dist <= radius_km:
                az = calculate_azimuth(lat, lng, cur_lat, cur_lng)
                grid_points.append({
                    "lat": round(cur_lat, 5),
                    "lng": round(cur_lng, 5),
                    "distance": dist,
                    "azimuth": az,
                })
            cur_lng += lon_step
        cur_lat += lat_step

    if not grid_points:
        return jsonify([])

    # Sample VS30 at many points for soil-driven shape variation
    n_samples = min(300, len(grid_points))
    sample_indices = np.linspace(0, len(grid_points) - 1, n_samples, dtype=int)
    sample_points = [grid_points[i] for i in sample_indices]

    with ThreadPoolExecutor(max_workers=20) as executor:
        vs30_values = list(executor.map(
            lambda p: fetch_vs30_single(p["lat"], p["lng"]),
            sample_points,
        ))

    # Nearest-neighbor interpolation for all grid points
    if len(sample_points) >= 3:
        sample_coords = np.array([[p["lat"], p["lng"]] for p in sample_points])
        interpolator = NearestNDInterpolator(sample_coords, vs30_values)
        all_coords = np.array([[p["lat"], p["lng"]] for p in grid_points])
        all_vs30 = interpolator(all_coords)
    else:
        all_vs30 = [VS30_DEFAULT] * len(grid_points)

    # Build feature matrix and predict
    features = [
        (magnitude, depth, p["distance"], float(vs30), p["azimuth"])
        for p, vs30 in zip(grid_points, all_vs30)
    ]

    try:
        predictions = predict_batch(features)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 500

    # Use the ML model predictions directly — no manual correction formulas.
    # The model was trained on real USGS ShakeMap data and already encodes
    # distance attenuation, depth effects, VS30 soil amplification, and
    # azimuthal variation from thousands of real earthquakes.
    results = []
    for p, mmi in zip(grid_points, predictions):
        mmi = max(1.0, min(10.0, float(mmi)))
        if mmi >= 2.0:
            results.append({
                "lat": p["lat"],
                "lng": p["lng"],
                "intensity": round(mmi, 2),
                "distance": round(p["distance"], 2),
            })

    results.sort(key=lambda r: r["distance"])

    # Fault proximity check — warns if simulated magnitude is geologically implausible
    fault_dist, fault_name = _nearest_fault(lat, lng)
    fault_info = None
    if fault_dist is not None:
        max_mag = _max_realistic_magnitude(fault_dist)
        fault_info = {
            "nearest_fault": fault_name,
            "distance_km": round(fault_dist, 1),
            "max_realistic_magnitude": max_mag,
            "warning": (
                f"M{magnitude} is geologically implausible {fault_dist:.0f} km from the nearest "
                f"known fault ({fault_name}). Max realistic magnitude here: M{max_mag}."
            ) if magnitude > max_mag else None,
        }

    return jsonify({"points": results, "fault_info": fault_info, "step_km": step_km})


@app.route("/damage", methods=["POST"])
def damage():
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    lat = data.get("lat")
    lng = data.get("lng")
    magnitude = data.get("magnitude")
    depth = data.get("depth")
    points = data.get("points", [])
    step_km = data.get("step_km", 3)

    if magnitude is None or depth is None:
        return jsonify({"error": "magnitude and depth are required"}), 400

    # Check if this matches a real USGS earthquake with PAGER data
    real_pager = _fetch_real_pager(lat, lng, magnitude)
    if real_pager:
        real_pager["source"] = "real"
        return jsonify(real_pager)

    # --- Empirical PAGER-style estimation from grid points ---
    exposed_pop = _fetch_area_population(lat, lng)
    result = _estimate_damage_from_grid(points, magnitude, step_km, exposed_pop)
    result["source"] = "estimated"
    return jsonify(result)


# ---------------------------------------------------------------------------
# Population lookup via GeoNames API
# ---------------------------------------------------------------------------
_pop_cache = {}  # (rounded_lat, rounded_lng) -> density per km²

GEODB_URL = "https://geodb-free-service.wirefreethought.com/v1/geo/places"


def _fetch_area_population(lat, lng):
    """Fetch actual population near the epicenter using GeoDB Cities API.

    Returns the real sum of city populations within 30 miles (~50km).
    This IS the exposed population — not a density to multiply.
    """
    # Cache by rounded epicenter (0.2° ≈ 22km grid)
    cache_key = (round(lat * 5) / 5, round(lng * 5) / 5)
    if cache_key in _pop_cache:
        return _pop_cache[cache_key]

    total_pop = 0
    try:
        loc = f"{lat:+.4f}{lng:+.4f}"

        for offset in range(0, 50, 10):
            resp = requests.get(GEODB_URL, params={
                "location": loc,
                "radius": 30,  # 30 miles ≈ 50km
                "limit": 10,
                "offset": offset,
                "sort": "-population",
                "types": "CITY",
            }, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            cities = data.get("data", [])
            if not cities:
                break
            total_pop += sum(int(c.get("population", 0)) for c in cities)
            if len(cities) < 10:
                break

        # Metro multiplier — city-proper undercounts suburbs by ~50%
        total_pop = int(total_pop * 1.5)

    except Exception as e:
        print(f"GeoDB population lookup failed: {e}")
        total_pop = 100_000  # conservative fallback

    total_pop = max(100, total_pop)  # at least a small settlement
    _pop_cache[cache_key] = total_pop
    return total_pop


def _estimate_damage_from_grid(points, magnitude, step_km, exposed_pop):
    """Estimate damage using empirical PAGER methodology.

    Key insight: exposed_pop is the REAL population from GeoDB (city data).
    We distribute this population across MMI bands using distance weighting —
    most people live near the epicenter, not at the grid edges.
    """
    if not points or exposed_pop < 1:
        return {
            "fatalities": 0, "injuries": 0, "collapse_pct": 0.0,
            "heavy_pct": 0.0, "economic_loss_usd": 0, "population": 0,
        }

    # PAGER fatality rates per MMI (Jaiswal & Wald 2010, modern building codes)
    fatality_rate = {
        2: 0, 3: 0, 4: 0, 5: 0,
        6: 0.000003, 7: 0.00003, 8: 0.0003, 9: 0.003, 10: 0.03,
    }
    injury_multiplier = 7  # WHO guideline

    # HAZUS building damage percentages by MMI
    collapse_rate = {
        2: 0, 3: 0, 4: 0, 5: 0,
        6: 0.1, 7: 0.5, 8: 2.0, 9: 8.0, 10: 20.0,
    }
    heavy_rate = {
        2: 0, 3: 0, 4: 0, 5: 0.1,
        6: 0.5, 7: 2.0, 8: 6.0, 9: 15.0, 10: 35.0,
    }

    # HAZUS economic loss ratio by MMI
    econ_loss_ratio = {
        2: 0, 3: 0, 4: 0, 5: 0.001,
        6: 0.005, 7: 0.02, 8: 0.08, 9: 0.20, 10: 0.40,
    }

    # Distribute population across cells weighted by inverse distance.
    # People concentrate near the epicenter, not uniformly across the grid.
    weights = []
    for p in points:
        dist = max(1.0, p.get("distance", 1))
        w = 1.0 / (1.0 + (dist / 15.0) ** 2)  # sharp falloff beyond ~15km
        weights.append(w)

    total_weight = sum(weights)
    if total_weight < 0.001:
        total_weight = 1.0

    total_fatalities = 0.0
    total_injuries = 0.0
    total_econ_loss = 0.0
    weighted_collapse = 0.0
    weighted_heavy = 0.0
    cells_with_damage = 0

    # Per-capita property value (~$200K US average)
    per_capita_value = 200_000

    for p, w in zip(points, weights):
        mmi = p.get("intensity", 0)
        mmi_band = max(2, min(10, int(round(mmi))))

        # Population in this cell = share of total based on distance weight
        cell_pop = exposed_pop * (w / total_weight)

        total_fatalities += cell_pop * fatality_rate.get(mmi_band, 0)
        total_injuries += cell_pop * fatality_rate.get(mmi_band, 0) * injury_multiplier

        if mmi_band >= 6:
            cells_with_damage += 1
            weighted_collapse += collapse_rate.get(mmi_band, 0)
            weighted_heavy += heavy_rate.get(mmi_band, 0)

        # Economic loss = people × per-capita value × loss ratio
        total_econ_loss += cell_pop * per_capita_value * econ_loss_ratio.get(mmi_band, 0)

    avg_collapse = weighted_collapse / cells_with_damage if cells_with_damage else 0
    avg_heavy = weighted_heavy / cells_with_damage if cells_with_damage else 0

    return {
        "fatalities": max(0, int(total_fatalities)),
        "injuries": max(0, int(total_injuries)),
        "collapse_pct": round(avg_collapse, 2),
        "heavy_pct": round(avg_heavy, 2),
        "economic_loss_usd": round(total_econ_loss, 2),
        "population": exposed_pop,
    }


def _fetch_real_pager(lat, lng, magnitude):
    """Check if a real USGS earthquake with PAGER data exists near this location."""
    try:
        params = {
            "format": "geojson",
            "latitude": lat,
            "longitude": lng,
            "maxradiuskm": 50,
            "minmagnitude": magnitude - 0.5,
            "maxmagnitude": magnitude + 0.5,
            "producttype": "losspager",
            "limit": 1,
            "orderby": "time",
        }
        resp = requests.get(
            "https://earthquake.usgs.gov/fdsnws/event/1/query",
            params=params,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        features = data.get("features", [])
        if not features:
            return None

        feat = features[0]
        event_id = feat["id"]
        detail_url = feat["properties"].get("detail")
        if not detail_url:
            return None

        # Fetch PAGER detail
        detail_resp = requests.get(detail_url, timeout=10)
        detail_resp.raise_for_status()
        detail = detail_resp.json()

        products = detail.get("properties", {}).get("products", {})
        pager_list = products.get("losspager", [])
        if not pager_list:
            return None

        pager_props = pager_list[0].get("properties", {})
        alert = pager_props.get("alertlevel", "green")

        # Extract what we can from PAGER
        maxmmi = _safe_float(pager_props.get("maxmmi", 0))

        return {
            "fatalities": _pager_alert_to_fatalities(alert),
            "injuries": _pager_alert_to_fatalities(alert) * 5,
            "collapse_pct": _mmi_to_collapse(maxmmi),
            "heavy_pct": _mmi_to_collapse(maxmmi) * 2.5,
            "economic_loss_usd": _pager_alert_to_econ(alert),
            "population": _safe_int(pager_props.get("maxmmi_population", 0)),
            "alert_level": alert,
            "event_id": event_id,
        }
    except Exception:
        return None


def _safe_float(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def _safe_int(v):
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def _pager_alert_to_fatalities(alert):
    return {"green": 0, "yellow": 10, "orange": 100, "red": 1000}.get(alert, 0)


def _pager_alert_to_econ(alert):
    return {"green": 1e5, "yellow": 1e7, "orange": 1e9, "red": 1e10}.get(alert, 1e5)


def _mmi_to_collapse(mmi):
    if mmi < 6:
        return 0.0
    elif mmi < 7:
        return round((mmi - 6) * 2, 2)
    elif mmi < 8:
        return round(2 + (mmi - 7) * 8, 2)
    elif mmi < 9:
        return round(10 + (mmi - 8) * 15, 2)
    return round(25 + (mmi - 9) * 20, 2)


@app.route("/recent")
def recent():
    now = time.time()

    if _recent_cache["data"] and (now - _recent_cache["timestamp"]) < RECENT_CACHE_TTL:
        return jsonify(_recent_cache["data"])

    try:
        resp = requests.get(USGS_RECENT_URL, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        if _recent_cache["data"]:
            return jsonify(_recent_cache["data"])
        return jsonify({"error": f"Failed to fetch USGS data: {e}"}), 502

    # Filter to M3.0+
    filtered = {
        "type": "FeatureCollection",
        "features": [
            f for f in data.get("features", [])
            if f.get("properties", {}).get("mag", 0) and f["properties"]["mag"] >= 3.0
        ],
    }

    _recent_cache["data"] = filtered
    _recent_cache["timestamp"] = now

    return jsonify(filtered)


@app.route("/vs30")
def vs30():
    lat = request.args.get("lat", type=float)
    lng = request.args.get("lng", type=float)

    if lat is None or lng is None:
        return jsonify({"error": "lat and lng query parameters required"}), 400

    vs30_val = fetch_vs30_single(lat, lng)
    return jsonify({"vs30": vs30_val, "lat": lat, "lng": lng})


# ---------------------------------------------------------------------------
# Fault lines — cached server-side, filtered by zoom + viewport
# ---------------------------------------------------------------------------
_fault_cache = {"data": None}
_fault_lock = threading.Lock()
FAULT_URL = (
    "https://raw.githubusercontent.com/cossatot/gem-global-active-faults"
    "/master/geojson/gem_active_faults.geojson"
)


def _nearest_fault(lat, lng):
    """Return (distance_km, fault_name) to the nearest cached fault. Returns (None, None) if not loaded."""
    features = _fault_cache.get("data")
    if not features:
        return None, None

    min_dist_sq = float("inf")
    nearest_name = "Unknown fault"

    for feature in features:
        geom = feature.get("geometry", {})
        coords = geom.get("coordinates", [])
        gtype = geom.get("type", "")
        name = (feature.get("properties") or {}).get("name") or "Unknown fault"

        lines = [coords] if gtype == "LineString" else (coords if gtype == "MultiLineString" else [])
        for line in lines:
            if not line:
                continue
            # Sample up to 8 evenly-spaced points from each segment (fast approximation)
            step = max(1, len(line) // 8)
            for pt in line[::step]:
                d_lat = pt[1] - lat
                d_lng = (pt[0] - lng) * math.cos(math.radians(lat))
                dist_sq = d_lat ** 2 + d_lng ** 2
                if dist_sq < min_dist_sq:
                    min_dist_sq = dist_sq
                    nearest_name = name

    dist_km = (min_dist_sq ** 0.5) * 111.0
    return dist_km, nearest_name


def _max_realistic_magnitude(fault_dist_km):
    """
    Max plausible earthquake magnitude based on distance to nearest known fault.
    Based on Wells & Coppersmith (1994) and intraplate seismicity records.
    """
    if fault_dist_km < 10:
        return 9.5   # On or adjacent to a mapped fault — anything possible
    elif fault_dist_km < 30:
        return 8.0   # Near-fault, could be unmapped splay
    elif fault_dist_km < 75:
        return 7.0   # Intraplate edge — rare but possible (e.g. Christchurch 2011)
    elif fault_dist_km < 150:
        return 6.0   # Deep intraplate — uncommon
    else:
        return 5.5   # Stable craton — very rare, small events only


def _load_faults():
    with _fault_lock:
        if _fault_cache["data"] is None:
            resp = requests.get(FAULT_URL, timeout=30)
            resp.raise_for_status()
            _fault_cache["data"] = resp.json().get("features", [])
    return _fault_cache["data"]


def _coord_count(feature):
    geom = feature.get("geometry", {})
    coords = geom.get("coordinates", [])
    if geom.get("type") == "LineString":
        return len(coords)
    if geom.get("type") == "MultiLineString":
        return sum(len(ln) for ln in coords)
    return 0


def _in_bounds(feature, min_lat, min_lng, max_lat, max_lng):
    geom = feature.get("geometry", {})
    coords = geom.get("coordinates", [])
    lines = [coords] if geom.get("type") == "LineString" else coords
    for line in lines:
        for pt in line:
            if min_lng <= pt[0] <= max_lng and min_lat <= pt[1] <= max_lat:
                return True
    return False


@app.route("/faults")
def faults():
    zoom = request.args.get("zoom", 5, type=int)
    min_lat = request.args.get("min_lat", -90, type=float)
    max_lat = request.args.get("max_lat", 90, type=float)
    min_lng = request.args.get("min_lng", -180, type=float)
    max_lng = request.args.get("max_lng", 180, type=float)

    # Zoom thresholds — higher min_coords = only longer (more major) faults shown
    if zoom < 4:
        return jsonify({"type": "FeatureCollection", "features": []})
    elif zoom <= 5:
        min_coords = 80
    elif zoom <= 7:
        min_coords = 30
    else:
        min_coords = 0

    try:
        features = _load_faults()
    except Exception as e:
        return jsonify({"error": f"Failed to load fault data: {e}"}), 502

    filtered = [
        f for f in features
        if _coord_count(f) >= min_coords and _in_bounds(f, min_lat, min_lng, max_lat, max_lng)
    ]

    return jsonify({"type": "FeatureCollection", "features": filtered})


# ---------------------------------------------------------------------------
# Ocean-check endpoint — uses NOAA ETOPO1
# ---------------------------------------------------------------------------

@app.route("/ocean-check")
def ocean_check():
    lat = request.args.get("lat", type=float)
    lng = request.args.get("lng", type=float)

    if lat is None or lng is None:
        return jsonify({"error": "lat and lng query parameters required"}), 400

    elevation = fetch_elevation_single(lat, lng)
    return jsonify({
        "is_ocean": bool(elevation < 0),
        "elevation_m": round(elevation, 1),
    })


# ---------------------------------------------------------------------------
# Tsunami simulation endpoint
# ---------------------------------------------------------------------------

@app.route("/tsunami", methods=["POST"])
def tsunami():
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    lat       = data.get("lat")
    lng       = data.get("lng")
    magnitude = data.get("magnitude")
    depth_km  = data.get("depth")

    if None in (lat, lng, magnitude, depth_km):
        return jsonify({"error": "lat, lng, magnitude, depth are required"}), 400
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return jsonify({"error": "Invalid coordinates"}), 400
    if not (3.0 <= magnitude <= 9.0):
        return jsonify({"error": "magnitude must be 3.0–9.0"}), 400

    # Verify epicenter is actually in the ocean
    epi_elev = fetch_elevation_single(lat, lng)
    if epi_elev >= 0:
        return jsonify({"error": "Epicenter is not in the ocean"}), 400

    animation_rings, coastline_impacts = _run_tsunami_simulation(
        lat, lng, magnitude, depth_km
    )

    noaa_source, noaa_event = _check_noaa_tsunami(lat, lng, magnitude)
    dart_buoys = _get_nearby_dart_buoys(lat, lng, radius_km=4000)

    H0 = _initial_wave_height(magnitude)

    return jsonify({
        "animation_rings":   animation_rings,
        "coastline_impacts": coastline_impacts[:25],
        "noaa_source":       noaa_source,
        "noaa_event":        noaa_event,
        "dart_buoys":        dart_buoys,
        "initial_height_m":  round(H0, 2),
        "grid_step_km":      80,
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)
