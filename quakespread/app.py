"""
QuakeSpread — Flask Backend

API Endpoints:
    POST /simulate  — Run earthquake damage simulation
    GET  /recent    — Recent M3.0+ earthquakes from USGS
    GET  /vs30      — VS30 soil value lookup
"""

import os
import math
import time
import threading
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

USGS_VS30_URL = (
    "https://earthquake.usgs.gov/arcgis/rest/services/eq/vs30_mosaic/MapServer/identify"
)


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


if __name__ == "__main__":
    app.run(debug=True, port=5000)
