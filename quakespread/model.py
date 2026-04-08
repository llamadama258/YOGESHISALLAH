import os
import math
import numpy as np

_model = None


def _load_model():
    global _model
    if _model is None:
        import joblib
        model_path = os.path.join(os.path.dirname(__file__), "model.pkl")
        if not os.path.exists(model_path):
            raise RuntimeError(
                "model.pkl not found. Run train.py first to generate it."
            )
        _model = joblib.load(model_path)
    return _model


def _fallback_predict(magnitude, depth, distance, vs30, azimuth):
    """Simple distance-decay formula for development without a trained model."""
    if distance < 1:
        distance = 1
    mmi = magnitude * math.exp(-distance / 50)
    return max(1.0, min(10.0, mmi))


def predict(magnitude, depth, distance, vs30, azimuth):
    """Predict MMI for a single point.

    Returns a float (Modified Mercalli Intensity, 1-10).
    """
    backend = os.getenv("MODEL_BACKEND", "local")

    if backend == "palantir":
        import requests
        response = requests.post(
            os.getenv("PALANTIR_ENDPOINT"),
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
        try:
            model = _load_model()
            result = model.predict([[magnitude, depth, distance, vs30, azimuth]])
            return float(result[0])
        except RuntimeError:
            if os.getenv("FLASK_DEBUG"):
                return _fallback_predict(magnitude, depth, distance, vs30, azimuth)
            raise


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
                os.getenv("PALANTIR_ENDPOINT"),
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
        try:
            model = _load_model()
            arr = np.array(features, dtype=np.float64)
            predictions = model.predict(arr)
            return [float(p) for p in predictions]
        except RuntimeError:
            if os.getenv("FLASK_DEBUG"):
                return [
                    _fallback_predict(mag, dep, dist, vs, az)
                    for mag, dep, dist, vs, az in features
                ]
            raise
