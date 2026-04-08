"""
QuakeSpread — MMI Model Training (Real USGS ShakeMap Data + Depth Augmentation)

Loads real training samples from data/samples.csv (collected by train.py),
augments with depth-shifted copies using hypocentral distance scaling,
trains a GradientBoostingRegressor, and saves as mmi_model.pkl.

Usage:
    python train_mmi.py
"""

import os
import sys
import csv

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import root_mean_squared_error, r2_score
import joblib

BASE_DIR = os.path.dirname(__file__)
SAMPLES_CSV = os.path.join(BASE_DIR, "data", "samples.csv")
MODEL_PATH = os.path.join(BASE_DIR, "model.pkl")

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


def augment_depth(X, y, rng):
    """Create depth-shifted copies using hypocentral distance scaling.

    Physics: MMI depends on hypocentral distance = sqrt(epicentral_dist² + depth²).
    For each sample, we create copies at different depths and adjust MMI based on
    the change in hypocentral distance, using the Bakun-Wentworth attenuation
    relationship: delta_MMI ≈ -3.5 * log10(new_hypo / old_hypo).
    """
    print("Augmenting training data with depth variations...")

    # Feature column indices: 0=magnitude, 1=depth, 2=distance, 3=vs30, 4=azimuth
    aug_X = []
    aug_y = []

    target_depths = [5, 10, 20, 35, 50, 70, 100, 150, 200, 300, 500]

    for i in range(len(X)):
        mag, depth_orig, dist, vs30, az = X[i]
        mmi_orig = y[i]

        hypo_orig = np.sqrt(dist ** 2 + depth_orig ** 2)
        if hypo_orig < 1:
            hypo_orig = 1.0

        for new_depth in target_depths:
            # Skip if too close to original (no meaningful change)
            if abs(new_depth - depth_orig) < 3:
                continue

            hypo_new = np.sqrt(dist ** 2 + new_depth ** 2)
            if hypo_new < 1:
                hypo_new = 1.0

            # Attenuation correction based on hypocentral distance ratio
            delta_mmi = -3.5 * np.log10(hypo_new / hypo_orig)

            new_mmi = mmi_orig + delta_mmi
            new_mmi = np.clip(new_mmi, 1.0, 10.0)

            # Only keep if still above perceptible threshold
            if new_mmi >= 1.0:
                aug_X.append([mag, new_depth, dist, vs30, az])
                aug_y.append(new_mmi)

    aug_X = np.array(aug_X, dtype=np.float64)
    aug_y = np.array(aug_y, dtype=np.float64)

    # Add noise to augmented MMI to prevent overfitting to the formula
    aug_y += rng.normal(0, 0.15, len(aug_y))
    aug_y = np.clip(aug_y, 1.0, 10.0)

    print(f"  Created {len(aug_X)} depth-augmented samples")

    # Combine original + augmented, with original samples weighted more heavily
    # by duplicating them
    X_combined = np.vstack([X, X, aug_X])  # original counted twice
    y_combined = np.concatenate([y, y, aug_y])

    return X_combined, y_combined


def main():
    X, y = load_real_data()

    if X is None:
        print("No real data found at", SAMPLES_CSV)
        print("Run train.py first to collect USGS ShakeMap data.")
        sys.exit(1)

    print(f"Loaded {len(X)} real USGS ShakeMap samples.")

    # Check depth-MMI correlation before augmentation
    corr_before = np.corrcoef(X[:, 1], y)[0, 1]
    print(f"Depth-MMI correlation (before augmentation): {corr_before:.4f}")

    rng = np.random.default_rng(42)
    X_aug, y_aug = augment_depth(X, y, rng)
    print(f"Total training samples after augmentation: {len(X_aug)}")

    corr_after = np.corrcoef(X_aug[:, 1], y_aug)[0, 1]
    print(f"Depth-MMI correlation (after augmentation): {corr_after:.4f}")

    X_train, X_test, y_train, y_test = train_test_split(
        X_aug, y_aug, test_size=0.2, random_state=42
    )

    print(f"\nTraining HistGradientBoostingRegressor on {len(X_train)} samples...")
    model = HistGradientBoostingRegressor(
        max_iter=500,
        max_depth=8,
        learning_rate=0.1,
        min_samples_leaf=10,
        random_state=42,
    )

    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    rmse = root_mean_squared_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)

    print(f"Test RMSE: {rmse:.4f}")
    print(f"Test R2:   {r2:.4f}")

    joblib.dump(model, MODEL_PATH)
    print(f"\nModel saved to {MODEL_PATH}")
    print("Done!")


if __name__ == "__main__":
    main()
