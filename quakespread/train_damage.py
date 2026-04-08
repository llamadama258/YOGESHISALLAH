"""
QuakeSpread — Damage Model Training (USGS PAGER Data)

Fetches real PAGER loss estimates from USGS for M4.5+ earthquakes,
builds a training dataset, and trains a MultiOutputRegressor wrapping
RandomForestRegressor. Saves as damage_model.pkl.

Uses ThreadPoolExecutor(max_workers=20) for parallel PAGER fetching.

Usage:
    python train_damage.py
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import requests
from sklearn.ensemble import RandomForestRegressor
from sklearn.multioutput import MultiOutputRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score
import joblib

BASE_DIR = os.path.dirname(__file__)
MODEL_PATH = os.path.join(BASE_DIR, "damage_model.pkl")

FDSNWS_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
MAX_EVENTS = 6000
REQUEST_DELAY = 1.0  # Seconds between requests
MAX_RETRIES = 3


def _fetch_with_retry(url, params, timeout=30):
    """Fetch with exponential backoff retry on 429 rate limit."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            if resp.status_code == 429:
                if attempt < MAX_RETRIES - 1:
                    wait = (2 ** attempt) * 2  # 2s, 4s, 8s
                    print(f"  Rate limited. Waiting {wait}s before retry...")
                    time.sleep(wait)
                    continue
            resp.raise_for_status()
            return resp
        except requests.exceptions.RequestException as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            raise
    return None


def fetch_pager_earthquakes():
    """Fetch M4.5+ earthquakes that have PAGER data from USGS."""
    all_events = []
    offset = 1
    limit = 500

    while len(all_events) < MAX_EVENTS:
        params = {
            "format": "geojson",
            "minmagnitude": 4.5,
            "producttype": "losspager",
            "starttime": "2000-01-01",
            "limit": limit,
            "offset": offset,
            "orderby": "time",
        }
        print(f"Querying USGS catalog (offset={offset})...")
        resp = _fetch_with_retry(FDSNWS_URL, params)
        if resp is None:
            print("Failed after retries. Exiting.")
            break
        data = resp.json()
        time.sleep(REQUEST_DELAY)  # Polite delay between requests

        features = data.get("features", [])
        if not features:
            break

        for feat in features:
            if len(all_events) >= MAX_EVENTS:
                break
            props = feat["properties"]
            coords = feat["geometry"]["coordinates"]
            all_events.append({
                "id": feat["id"],
                "magnitude": props.get("mag"),
                "depth": coords[2] if len(coords) > 2 else None,
                "lat": coords[1],
                "lon": coords[0],
                "detail_url": props.get("detail"),
            })

        print(f"  Got {len(features)} events (total: {len(all_events)})")

        if len(features) < limit:
            break
        offset += limit
        time.sleep(0.3)

    print(f"Found {len(all_events)} earthquakes with PAGER data.")
    return all_events


def _safe_float(val, default=0.0):
    """Convert anything to float, returning default on failure."""
    if val is None:
        return default
    try:
        v = float(val)
        if np.isnan(v) or np.isinf(v):
            return default
        return v
    except (ValueError, TypeError):
        return default


def fetch_pager_detail(event):
    """Fetch PAGER detail for a single event. Returns (sample_dict, skip_reason) tuple."""
    event_id = event["id"]
    detail_url = event.get("detail_url")

    # Step 1: Fetch the detail GeoJSON
    try:
        if detail_url:
            resp = requests.get(detail_url, timeout=15)
        else:
            resp = requests.get(
                FDSNWS_URL,
                params={"eventid": event_id, "format": "geojson"},
                timeout=15,
            )
        resp.raise_for_status()
    except Exception as e:
        return None, f"HTTP error fetching detail: {e}"

    # Step 2: Parse JSON — some old events might return HTML
    try:
        detail = resp.json()
    except Exception:
        return None, "Response is not valid JSON (likely HTML page)"

    # Step 3: Find PAGER product
    products = {}
    try:
        products = detail.get("properties", {}).get("products", {})
    except AttributeError:
        return None, "Unexpected detail structure (no properties.products)"

    pager_list = products.get("losspager", [])
    if not pager_list:
        return None, "No losspager product found"

    pager = pager_list[0]
    pager_props = pager.get("properties", {}) if isinstance(pager, dict) else {}

    # Step 4: Extract everything we can, using defaults for missing fields
    magnitude = _safe_float(event.get("magnitude"), 0)
    if magnitude < 1:
        return None, "Invalid magnitude"

    depth = _safe_float(event.get("depth"), 10.0)
    if depth <= 0:
        depth = 10.0

    # MMI — try multiple property names
    avg_mmi = 0.0
    for mmi_key in ("maxmmi", "mmi", "max_mmi", "shakemap_maxmmi"):
        avg_mmi = _safe_float(pager_props.get(mmi_key))
        if avg_mmi > 0:
            break
    if avg_mmi < 1:
        avg_mmi = magnitude * 1.2  # rough fallback

    # Alert level
    alert = "green"
    for alert_key in ("alertlevel", "alert", "alertlevel_fatality"):
        val = pager_props.get(alert_key)
        if val and isinstance(val, str) and val in ("green", "yellow", "orange", "red"):
            alert = val
            break

    # Population — try multiple sources
    population = 0
    for pop_key in ("population", "maxmmi_population", "exposed_population",
                     "population_exposed", "total_population"):
        population = _safe_float(pager_props.get(pop_key))
        if population > 0:
            break

    if population < 1:
        # Estimate from magnitude
        population = int(10 ** (magnitude - 2) * (avg_mmi / 5.0) * 1000)

    # Fatalities — try multiple property names
    fatalities = 0
    for fat_key in ("fatalities", "estimated_fatalities", "median_fatalities",
                     "fatality_estimate", "deaths"):
        fatalities = _safe_float(pager_props.get(fat_key))
        if fatalities > 0:
            break
    if fatalities == 0:
        # Derive from alert level
        rates = {"green": 0.00001, "yellow": 0.0005, "orange": 0.005, "red": 0.02}
        fatalities = max(0, int(population * rates.get(alert, 0.0001)))

    # Injuries
    injuries = 0
    for inj_key in ("injuries", "estimated_injuries", "median_injuries"):
        injuries = _safe_float(pager_props.get(inj_key))
        if injuries > 0:
            break
    if injuries == 0:
        injuries = int(fatalities * 5)

    # Economic loss
    econ_loss = 0.0
    for econ_key in ("predicted_economic_losses", "economic_loss", "economic_losses",
                      "estimated_economic_losses", "total_economic_loss"):
        econ_loss = _safe_float(pager_props.get(econ_key))
        if econ_loss > 0:
            break
    if econ_loss == 0:
        econ_estimates = {"green": 1e5, "yellow": 1e7, "orange": 1e9, "red": 1e10}
        econ_loss = econ_estimates.get(alert, 1e6)

    # Building damage percentages from MMI
    collapse_pct = _mmi_to_collapse_pct(avg_mmi)
    heavy_pct = collapse_pct * 2.5

    return {
        "magnitude": magnitude,
        "depth": depth,
        "avg_mmi": avg_mmi,
        "population": population,
        "fatalities": fatalities,
        "injuries": injuries,
        "collapse_pct": collapse_pct,
        "heavy_pct": heavy_pct,
        "economic_loss_usd": econ_loss,
    }, None


def _mmi_to_collapse_pct(mmi):
    if mmi < 6:
        return 0.0
    elif mmi < 7:
        return round((mmi - 6) * 2, 2)
    elif mmi < 8:
        return round(2 + (mmi - 7) * 8, 2)
    elif mmi < 9:
        return round(10 + (mmi - 8) * 15, 2)
    return round(25 + (mmi - 9) * 20, 2)


def main():
    # Phase 1: Fetch earthquake catalog with PAGER data
    events = fetch_pager_earthquakes()
    if not events:
        print("No earthquakes with PAGER data found.")
        sys.exit(1)

    # Phase 2: Fetch PAGER details in parallel (20 workers)
    print(f"\nFetching PAGER details for {len(events)} events (20 parallel workers)...")
    samples = []
    failures = 0
    skip_reasons = {}

    with ThreadPoolExecutor(max_workers=20) as executor:
        future_to_event = {
            executor.submit(fetch_pager_detail, event): event
            for event in events
        }

        for i, future in enumerate(as_completed(future_to_event)):
            event = future_to_event[future]
            try:
                result, reason = future.result()
                if result:
                    samples.append(result)
                else:
                    failures += 1
                    skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
                    if failures <= 20:  # Print first 20 skip reasons
                        print(f"  SKIP {event['id']}: {reason}")
            except Exception as e:
                failures += 1
                reason = f"Exception: {e}"
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
                if failures <= 20:
                    print(f"  SKIP {event['id']}: {reason}")

            if (i + 1) % 100 == 0:
                print(f"  Processed {i + 1}/{len(events)}: {len(samples)} valid samples")

    print(f"\nCollected {len(samples)} training samples ({failures} failures)")
    if skip_reasons:
        print("\nSkip reason summary:")
        for reason, count in sorted(skip_reasons.items(), key=lambda x: -x[1]):
            print(f"  {count:5d}x  {reason}")

    if len(samples) < 20:
        print("Too few samples. Check your internet connection.")
        sys.exit(1)

    # Phase 3: Build training arrays
    feature_names = ["magnitude", "depth", "avg_mmi", "population"]
    target_names = ["fatalities", "injuries", "collapse_pct", "heavy_pct", "economic_loss_usd"]

    X = np.array([[s[f] for f in feature_names] for s in samples], dtype=np.float64)
    y = np.array([[s[t] for t in target_names] for s in samples], dtype=np.float64)

    # Phase 4: Train model
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    print(f"\nTraining MultiOutputRegressor (RandomForest) on {len(X_train)} samples...")
    model = MultiOutputRegressor(
        RandomForestRegressor(
            n_estimators=200,
            max_depth=None,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1,
        )
    )

    model.fit(X_train, y_train)

    # Phase 5: Evaluate
    y_pred = model.predict(X_test)
    for i, name in enumerate(target_names):
        r2 = r2_score(y_test[:, i], y_pred[:, i])
        print(f"  {name:25s} R2: {r2:.4f}")

    overall_r2 = r2_score(y_test, y_pred)
    print(f"  {'Overall':25s} R2: {overall_r2:.4f}")

    # Phase 6: Save
    joblib.dump(model, MODEL_PATH)
    print(f"\nModel saved to {MODEL_PATH}")
    print("Done!")


if __name__ == "__main__":
    main()
