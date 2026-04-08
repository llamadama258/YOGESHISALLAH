"""
QuakeSpread Training Pipeline

Downloads USGS ShakeMap data, parses grid XMLs, extracts training features,
and trains an MLPRegressor model saved as model.pkl.

Usage:
    python train.py
"""

import os
import sys
import csv
import math
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import numpy as np
import requests
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_squared_error, r2_score
import joblib


BASE_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE_DIR, "data")
SAMPLES_CSV = os.path.join(DATA_DIR, "samples.csv")
MODEL_PATH = os.path.join(BASE_DIR, "model.pkl")

FDSNWS_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
USGS_DETAIL_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"

FEATURE_COLS = ["magnitude", "depth", "distance", "vs30", "azimuth"]
TARGET_COL = "mmi"
ALL_COLS = FEATURE_COLS + [TARGET_COL, "event_id"]

REQUEST_DELAY = 0.2
MAX_RETRIES = 3
RETRY_BACKOFF = 2
MIN_SAMPLES = 400


def haversine(lat1, lon1, lat2, lon2):
    """Compute great-circle distance in km between two lat/lng points."""
    R = 6371.0
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def calculate_azimuth(lat1, lon1, lat2, lon2):
    """Compute bearing in degrees (0-360) from point 1 to point 2."""
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlon = rlon2 - rlon1
    x = math.sin(dlon) * math.cos(rlat2)
    y = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(dlon)
    bearing = math.degrees(math.atan2(x, y))
    return (bearing + 360) % 360


def fetch_with_retry(url, params=None, timeout=30):
    """HTTP GET with exponential backoff retry."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp
        except (requests.RequestException, requests.HTTPError) as e:
            if attempt < MAX_RETRIES - 1:
                wait = RETRY_BACKOFF ** (attempt + 1)
                print(f"  Retry {attempt + 1}/{MAX_RETRIES} after {wait}s: {e}")
                time.sleep(wait)
            else:
                raise


def query_earthquakes():
    """Query USGS FDSNWS for M4.0+ earthquakes with ShakeMap data."""
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(days=2 * 365)

    all_events = []
    offset = 1
    limit = 500

    while True:
        params = {
            "format": "geojson",
            "minmagnitude": 4.0,
            "producttype": "shakemap",
            "starttime": start_time.strftime("%Y-%m-%d"),
            "endtime": end_time.strftime("%Y-%m-%d"),
            "limit": limit,
            "offset": offset,
        }
        print(f"Querying USGS catalog (offset={offset})...")
        resp = fetch_with_retry(FDSNWS_URL, params=params)
        data = resp.json()

        features = data.get("features", [])
        if not features:
            break

        for feat in features:
            props = feat["properties"]
            coords = feat["geometry"]["coordinates"]
            all_events.append({
                "id": feat["id"],
                "magnitude": props["mag"],
                "depth": coords[2],
                "lat": coords[1],
                "lon": coords[0],
            })

        if len(features) < limit:
            break
        offset += limit
        time.sleep(REQUEST_DELAY)

    print(f"Found {len(all_events)} earthquakes with ShakeMap data.")
    return all_events


def get_shakemap_grid_url(event_id):
    """Get the grid.xml download URL for a given event."""
    params = {"eventid": event_id, "format": "geojson"}
    resp = fetch_with_retry(USGS_DETAIL_URL, params=params)
    data = resp.json()

    products = data.get("properties", {}).get("products", {})
    shakemaps = products.get("shakemap", [])
    if not shakemaps:
        return None

    contents = shakemaps[0].get("contents", {})
    grid_entry = contents.get("download/grid.xml")
    if not grid_entry:
        return None

    return grid_entry.get("url")


def parse_shakemap_grid(xml_text, event):
    """Parse ShakeMap grid.xml and extract training samples."""
    samples = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        print(f"  XML parse error: {e}")
        return samples

    # Handle XML namespace
    ns = ""
    tag = root.tag
    if tag.startswith("{"):
        ns = tag[: tag.index("}") + 1]

    # Get event info from XML
    event_elem = root.find(f"{ns}event")
    if event_elem is not None:
        eq_lat = float(event_elem.get("lat", event["lat"]))
        eq_lon = float(event_elem.get("lon", event["lon"]))
        eq_depth = float(event_elem.get("depth", event["depth"]))
        eq_mag = float(event_elem.get("magnitude", event["magnitude"]))
    else:
        eq_lat = event["lat"]
        eq_lon = event["lon"]
        eq_depth = event["depth"]
        eq_mag = event["magnitude"]

    # Discover column indices dynamically from <grid_field> elements
    col_index = {}
    for field_elem in root.findall(f"{ns}grid_field"):
        name = field_elem.get("name", "").upper()
        idx = field_elem.get("index")
        if idx is not None:
            col_index[name] = int(idx) - 1  # XML indices are 1-based

    lon_col = col_index.get("LON", 0)
    lat_col = col_index.get("LAT", 1)
    # MMI may be labeled MMI or INTENSITY
    mmi_col = col_index.get("MMI", col_index.get("INTENSITY", 4))
    # VS30 may be labeled SVEL, VS30, or SVEL_ROCK
    vs30_col = col_index.get("SVEL", col_index.get("VS30", col_index.get("SVEL_ROCK", None)))

    # Parse grid data
    grid_data_elem = root.find(f"{ns}grid_data")
    if grid_data_elem is None or not grid_data_elem.text:
        return samples

    for line in grid_data_elem.text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        try:
            lon = float(parts[lon_col])
            lat = float(parts[lat_col])
            mmi = float(parts[mmi_col])
            # Use VS30 if available, otherwise default to 360 m/s
            vs30 = float(parts[vs30_col]) if vs30_col is not None and vs30_col < len(parts) else 360.0
        except (ValueError, IndexError):
            continue

        if mmi < 1.0 or vs30 <= 0:
            continue

        distance = haversine(eq_lat, eq_lon, lat, lon)
        azimuth = calculate_azimuth(eq_lat, eq_lon, lat, lon)

        samples.append({
            "magnitude": eq_mag,
            "depth": eq_depth,
            "distance": distance,
            "vs30": vs30,
            "azimuth": azimuth,
            "mmi": mmi,
            "event_id": event["id"],
        })

    if len(samples) > 500:
        import random
        samples = random.sample(samples, 500)
    return samples


def load_existing_samples():
    """Load previously checkpointed samples and return (list of dicts, set of event IDs)."""
    if os.path.exists(SAMPLES_CSV):
        samples = []
        processed_ids = set()
        with open(SAMPLES_CSV, "r", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Convert numeric fields back from strings
                for col in FEATURE_COLS + [TARGET_COL]:
                    row[col] = float(row[col])
                samples.append(row)
                processed_ids.add(row["event_id"])
        print(f"Loaded {len(samples)} existing samples from {len(processed_ids)} events.")
        return samples, processed_ids
    return [], set()


def save_samples(samples):
    """Checkpoint samples to CSV."""
    with open(SAMPLES_CSV, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=ALL_COLS)
        writer.writeheader()
        writer.writerows(samples)


def download_and_parse(events, existing_samples, processed_ids):
    """Download ShakeMap grids and parse training data."""
    all_samples = list(existing_samples)
    total = len(events)
    failures = 0

    for i, event in enumerate(events):
        if event["id"] in processed_ids:
            continue

        print(f"[{i + 1}/{total}] Processing {event['id']} (M{event['magnitude']})... "
              f"{len(all_samples)} samples so far")

        try:
            grid_url = get_shakemap_grid_url(event["id"])
            if not grid_url:
                print(f"  No grid.xml found, skipping.")
                failures += 1
                continue

            time.sleep(REQUEST_DELAY)
            resp = fetch_with_retry(grid_url)
            samples = parse_shakemap_grid(resp.text, event)

            if samples:
                all_samples.extend(samples)
                processed_ids.add(event["id"])
                # Checkpoint after each event
                save_samples(all_samples)
                print(f"  Extracted {len(samples)} samples.")
            else:
                print(f"  No valid samples extracted.")
                failures += 1

        except Exception as e:
            print(f"  Error: {e}")
            failures += 1

        time.sleep(REQUEST_DELAY)

    print(f"\nDownload complete. {len(all_samples)} total samples, {failures} failures.")
    return all_samples


def train_model(samples):
    """Train MLPRegressor and save as model.pkl."""
    print(f"\nTraining on {len(samples)} samples...")

    X = np.array([[s["magnitude"], s["depth"], s["distance"], s["vs30"], s["azimuth"]]
                   for s in samples], dtype=np.float64)
    y = np.array([s["mmi"] for s in samples], dtype=np.float64)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    model = make_pipeline(
        StandardScaler(),
        MLPRegressor(
            hidden_layer_sizes=(128, 64, 32),
            activation="relu",
            max_iter=500,
            early_stopping=True,
            validation_fraction=0.1,
            random_state=42,
        ),
    )

    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    rmse = mean_squared_error(y_test, y_pred) ** 0.5
    r2 = r2_score(y_test, y_pred)

    print(f"Test RMSE: {rmse:.4f}")
    print(f"Test R²:   {r2:.4f}")

    joblib.dump(model, MODEL_PATH)
    print(f"Model saved to {MODEL_PATH}")

    return model


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    # Phase 1: Query earthquake catalog
    events = query_earthquakes()
    if not events:
        print("No earthquakes found. Check your internet connection.")
        sys.exit(1)

    # Phase 2 & 3: Download and parse ShakeMap grids
    events = events[:200]
    existing_samples, processed_ids = load_existing_samples()
    all_samples = download_and_parse(events, existing_samples, processed_ids)

    # Check minimum threshold
    if len(all_samples) < MIN_SAMPLES:
        print(f"\nInsufficient data: {len(all_samples)} samples (minimum {MIN_SAMPLES}).")
        print("Try running again — checkpointed progress will be resumed.")
        sys.exit(1)

    # Phase 4: Train model
    # Remove event_id before training
    training_samples = [{k: v for k, v in s.items() if k != "event_id"} for s in all_samples]
    train_model(training_samples)

    print("\nDone! You can now run: python app.py")


if __name__ == "__main__":
    main()
