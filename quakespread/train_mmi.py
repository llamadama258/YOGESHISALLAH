"""
QuakeSpread — MMI Model Training (Real USGS ShakeMap Data)

Loads real training samples from data/samples.csv (collected by train.py),
trains an MLPRegressor, and saves as mmi_model.pkl.

Falls back to synthetic data only if samples.csv doesn't exist.

Usage:
    python train_mmi.py
"""

import os
import sys
import csv

import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import root_mean_squared_error, r2_score
import joblib

BASE_DIR = os.path.dirname(__file__)
SAMPLES_CSV = os.path.join(BASE_DIR, "data", "samples.csv")
MODEL_PATH = os.path.join(BASE_DIR, "mmi_model.pkl")

FEATURE_COLS = ["magnitude", "depth", "distance", "vs30", "azimuth"]
TARGET_COL = "mmi"


def load_real_data():
    """Load real USGS ShakeMap training data from samples.csv."""
    if not os.path.exists(SAMPLES_CSV):
        return None, None

    print(f"Loading real data from {SAMPLES_CSV}...")
    rows = []
    with open(SAMPLES_CSV, "r", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                sample = {col: float(row[col]) for col in FEATURE_COLS + [TARGET_COL]}
                if sample["mmi"] >= 1.0 and sample["vs30"] > 0:
                    rows.append(sample)
            except (ValueError, KeyError):
                continue

    if not rows:
        return None, None

    X = np.array([[r[c] for c in FEATURE_COLS] for r in rows], dtype=np.float64)
    y = np.array([r[TARGET_COL] for r in rows], dtype=np.float64)
    return X, y


def generate_synthetic_fallback(n=10000):
    """Fallback: generate synthetic data if no real data available."""
    print("No real data found. Generating 10,000 synthetic samples as fallback...")
    rng = np.random.default_rng(42)

    magnitude = rng.uniform(3.0, 9.0, n)
    depth = rng.uniform(0, 300, n)
    distance = rng.uniform(0.1, 500, n)
    vs30 = rng.uniform(100, 1500, n)
    azimuth = rng.uniform(0, 360, n)

    soil_factor = np.where(vs30 < 180, 1.5, np.where(vs30 > 760, -0.8, 0.0))
    mmi = magnitude - 1.5 * np.log10(distance + 1) - 0.005 * distance + soil_factor - 0.002 * depth
    mmi = mmi + rng.normal(0, 0.3, n)
    mmi = np.clip(mmi, 1.0, 10.0)

    X = np.column_stack([magnitude, depth, distance, vs30, azimuth])
    return X, mmi


def main():
    X, y = load_real_data()

    if X is None:
        X, y = generate_synthetic_fallback()
        print(f"Using {len(X)} synthetic samples.")
    else:
        print(f"Loaded {len(X)} real USGS ShakeMap samples.")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    print(f"Training MLPRegressor on {len(X_train)} samples...")
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
    rmse = root_mean_squared_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)

    print(f"Test RMSE: {rmse:.4f}")
    print(f"Test R2:   {r2:.4f}")

    joblib.dump(model, MODEL_PATH)
    print(f"Model saved to {MODEL_PATH}")
    print("Done!")


if __name__ == "__main__":
    main()
