import os
import numpy as np

_mmi_model = None
_damage_model = None


def _load_mmi_model():
    global _mmi_model
    if _mmi_model is None:
        import joblib
        # Try new name first, fall back to old name
        base = os.path.dirname(__file__)
        for name in ("mmi_model.pkl", "model.pkl"):
            path = os.path.join(base, name)
            if os.path.exists(path):
                _mmi_model = joblib.load(path)
                return _mmi_model
        raise RuntimeError(
            "mmi_model.pkl not found. Run train_mmi.py first to generate it."
        )
    return _mmi_model


def _load_damage_model():
    global _damage_model
    if _damage_model is None:
        import joblib
        path = os.path.join(os.path.dirname(__file__), "damage_model.pkl")
        if not os.path.exists(path):
            raise RuntimeError(
                "damage_model.pkl not found. Run train_damage.py first to generate it."
            )
        _damage_model = joblib.load(path)
    return _damage_model


# ---------------------------------------------------------------------------
# Public API — MMI prediction
# ---------------------------------------------------------------------------

def predict(magnitude, depth, distance, vs30, azimuth):
    """Predict MMI for a single point. Alias for predict_mmi."""
    return predict_mmi(magnitude, depth, distance, vs30, azimuth)


def predict_mmi(magnitude, depth, distance, vs30, azimuth):
    """Predict MMI for a single point.

    Returns a float (Modified Mercalli Intensity, 1-10).
    """
    backend = os.getenv("MODEL_BACKEND", "local")

    if backend == "palantir":
        import requests
        response = requests.post(
            os.getenv("PALANTIR_MMI_ENDPOINT", os.getenv("PALANTIR_ENDPOINT", "")),
            json={
                "magnitude": magnitude,
                "depth": depth,
                "distance": distance,
                "vs30": vs30,
                "azimuth": azimuth,
            },
            headers={
                "Authorization": f"Bearer {os.getenv('PALANTIR_TOKEN')}"
            },
            timeout=10,
        )
        response.raise_for_status()
        return float(response.json()["mmi"])
    else:
        model = _load_mmi_model()
        result = model.predict([[magnitude, depth, distance, vs30, azimuth]])
        return float(result[0])


def predict_batch(features):
    """Predict MMI for multiple points at once.

    Args:
        features: list of (magnitude, depth, distance, vs30, azimuth) tuples

    Returns:
        list of float MMI values
    """
    if not features:
        return []

    backend = os.getenv("MODEL_BACKEND", "local")

    if backend == "palantir":
        import requests
        results = []
        for mag, dep, dist, vs, az in features:
            response = requests.post(
                os.getenv("PALANTIR_MMI_ENDPOINT", os.getenv("PALANTIR_ENDPOINT", "")),
                json={
                    "magnitude": mag,
                    "depth": dep,
                    "distance": dist,
                    "vs30": vs,
                    "azimuth": az,
                },
                headers={
                    "Authorization": f"Bearer {os.getenv('PALANTIR_TOKEN')}"
                },
                timeout=10,
            )
            response.raise_for_status()
            results.append(float(response.json()["mmi"]))
        return results
    else:
        model = _load_mmi_model()
        arr = np.array(features, dtype=np.float64)
        predictions = model.predict(arr)
        return [float(p) for p in predictions]


# ---------------------------------------------------------------------------
# Public API — Damage prediction
# ---------------------------------------------------------------------------

def predict_damage(magnitude, depth, avg_mmi, population):
    """Predict damage statistics for an earthquake.

    Returns dict with: fatalities, injuries, collapse_pct, heavy_pct, economic_loss_usd
    """
    backend = os.getenv("MODEL_BACKEND", "local")

    if backend == "palantir":
        import requests
        response = requests.post(
            os.getenv("PALANTIR_DAMAGE_ENDPOINT", ""),
            json={
                "magnitude": magnitude,
                "depth": depth,
                "avg_mmi": avg_mmi,
                "population": population,
            },
            headers={
                "Authorization": f"Bearer {os.getenv('PALANTIR_TOKEN')}"
            },
            timeout=10,
        )
        response.raise_for_status()
        return response.json()
    else:
        model = _load_damage_model()
        result = model.predict([[magnitude, depth, avg_mmi, population]])[0]
        return {
            "fatalities": max(0, int(result[0])),
            "injuries": max(0, int(result[1])),
            "collapse_pct": max(0.0, round(float(result[2]), 2)),
            "heavy_pct": max(0.0, round(float(result[3]), 2)),
            "economic_loss_usd": max(0.0, round(float(result[4]), 2)),
        }
