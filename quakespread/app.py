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


def apply_vs30_amplification(mmi, vs30):
    """Apply VS30 site amplification to MMI value."""
    if vs30 < 180:
        mmi *= 1.5
    elif vs30 > 760:
        mmi *= 0.8
    return max(1.0, min(10.0, mmi))


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

    # Generate grid points within 150km radius at 5km spacing
    radius_km = 150
    step_km = 5
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

    # Sample ~50 points for VS30 lookup, interpolate to all
    n_samples = min(50, len(grid_points))
    sample_indices = np.linspace(0, len(grid_points) - 1, n_samples, dtype=int)
    sample_points = [grid_points[i] for i in sample_indices]

    with ThreadPoolExecutor(max_workers=10) as executor:
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

    # Apply VS30 amplification, filter, and sort
    results = []
    for p, mmi, vs30 in zip(grid_points, predictions, all_vs30):
        adjusted = apply_vs30_amplification(mmi, float(vs30))
        if adjusted >= 2.0:
            results.append({
                "lat": p["lat"],
                "lng": p["lng"],
                "intensity": round(adjusted, 2),
                "distance": round(p["distance"], 2),
            })

    results.sort(key=lambda r: r["distance"])
    return jsonify(results)


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


if __name__ == "__main__":
    app.run(debug=True, port=5000)
