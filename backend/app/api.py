"""
REST surface.

Endpoint shapes follow the country -> state -> hyperlocal drill-down of the UI,
because that is also how CWC and NDMA structure flood response, so each screen
makes exactly one call.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from . import engine as eng
from . import consensus, copilot, explain, llm, store
from .ml import ml
from .nowcast import status as nowcast_status

log = logging.getLogger("jaldrishti.api")
from .config import (
    ALERT_TIERS,
    APP_NAME,
    APP_TAGLINE_EN,
    APP_TAGLINE_HI,
    CLIMATOLOGY_END_YEAR,
    CLIMATOLOGY_START_YEAR,
    FACTOR_LABELS,
    IMD_RAIN_CLASSES,
    REFRESH_MINUTES,
    VERSION,
    WEIGHTS,
)
from .engine import EVENTS, LOCATIONS, LOCATIONS_BY_ID, engine
from .risk import load_ml_model

router = APIRouter(prefix="/api")


async def _snapshot(date_str: str | None):
    """Live snapshot, or the Time Machine snapshot when ?date=YYYY-MM-DD is given."""
    if not date_str:
        return _require_snapshot()
    try:
        when = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    if when >= date.today() or when < date(1994, 1, 1):
        raise HTTPException(status_code=400, detail="Replay dates must be between 1994-01-01 and yesterday")
    try:
        return await engine.snapshot_for_date(when)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Historical replay unavailable: {exc}")


def _require_snapshot():
    if engine.snapshot is None:
        raise HTTPException(
            status_code=503,
            detail="No snapshot yet — the first ingestion run is still in flight. Retry in a few seconds.",
        )
    return engine.snapshot


def _meta(snapshot) -> dict:
    """The 'is this live?' block every screen shows."""
    age = (datetime.now(timezone.utc) - snapshot.computed_at).total_seconds()
    if getattr(snapshot, "replay_date", None):
        return {
            "mode": "replay",
            "replay_date": snapshot.replay_date,
            "run_id": 0,
            "computed_at": snapshot.computed_at.isoformat(timespec="seconds"),
            "age_seconds": 0,
            "duration_ms": snapshot.duration_ms,
            "trigger": "replay",
            "refresh_minutes": REFRESH_MINUTES,
            "next_refresh_in_seconds": 0,
            "locations": len(snapshot.assessments),
            "degraded": snapshot.degraded,
            "refreshing": False,
            "climatology_locations": len(engine.climatology),
            "climatology_years": f"{CLIMATOLOGY_START_YEAR}-{CLIMATOLOGY_END_YEAR}",
        }
    return {
        "mode": "live",
        "run_id": snapshot.run_id,
        "computed_at": snapshot.computed_at.isoformat(timespec="seconds"),
        "age_seconds": int(age),
        "duration_ms": snapshot.duration_ms,
        "trigger": snapshot.trigger,
        "refresh_minutes": REFRESH_MINUTES,
        "next_refresh_in_seconds": max(0, int(REFRESH_MINUTES * 60 - age)),
        "locations": len(snapshot.assessments),
        "degraded": snapshot.degraded,
        "refreshing": engine.refreshing,
        "climatology_locations": len(engine.climatology),
        "climatology_years": f"{CLIMATOLOGY_START_YEAR}-{CLIMATOLOGY_END_YEAR}",
    }


# ------------------------------------------------------------------ meta/system


@router.get("/system", summary="App identity, model card and data-source health")
def system() -> dict:
    model = load_ml_model()
    return {
        "app": {
            "name": APP_NAME,
            "version": VERSION,
            "tagline_en": APP_TAGLINE_EN,
            "tagline_hi": APP_TAGLINE_HI,
            "disclaimer_en": (
                "Prototype for research and demonstration. Not an official Government of India "
                "service and not a public flood warning. For operational warnings follow IMD, "
                "CWC and your State Disaster Management Authority."
            ),
            "disclaimer_hi": (
                "यह शोध एवं प्रदर्शन हेतु प्रोटोटाइप है। यह भारत सरकार की आधिकारिक सेवा नहीं है "
                "और न ही सार्वजनिक बाढ़ चेतावनी। आधिकारिक चेतावनी के लिए IMD, CWC एवं राज्य "
                "आपदा प्रबंधन प्राधिकरण का पालन करें।"
            ),
        },
        "model": {
            "kind": "hybrid weighted-rule score blended with a logistic classifier",
            "features": [
                {"key": k, "weight": w, "label_en": FACTOR_LABELS[k][0], "label_hi": FACTOR_LABELS[k][1]}
                for k, w in WEIGHTS.items()
            ],
            "alert_tiers": ALERT_TIERS,
            "imd_rain_classes": IMD_RAIN_CLASSES,
            "trained_model": model.as_dict() if model else None,
        },
        "sources": eng.source_manifest(),
        "coverage": {
            "locations": len(LOCATIONS),
            "states": len({l["state"] for l in LOCATIONS}),
            "historical_events": len(EVENTS),
            "enriched": eng.ENRICHED,
        },
        "runs": store.recent_runs(10),
        "status": {
            "has_snapshot": engine.snapshot is not None,
            "refreshing": engine.refreshing,
            "last_error": engine.last_error,
            "climatology_locations": len(engine.climatology),
        },
    }


@router.get("/health", summary="Liveness probe")
def health() -> dict:
    return {
        "ok": engine.snapshot is not None,
        "refreshing": engine.refreshing,
        "locations": len(engine.snapshot.assessments) if engine.snapshot else 0,
        "last_error": engine.last_error,
    }


# --------------------------------------------------------------- country view


@router.get("/country/summary", summary="National roll-up for the India choropleth")
async def country_summary(date: str | None = None) -> dict:
    snap = await _snapshot(date)
    states = eng.state_rollup(snap)
    counts = snap.tier_counts
    worst = snap.worst(6)

    return {
        "meta": _meta(snap),
        "counts": counts,
        "total_locations": len(snap.assessments),
        "states": states,
        "summary": explain.national_summary_text(counts, len(snap.assessments), worst),
        "population_at_risk": sum(s["population_at_risk"] for s in states),
        "worst": [
            {
                "id": a["location"]["id"],
                "name": a["location"]["name"],
                "name_hi": a["location"].get("name_hi"),
                "state": a["location"]["state"],
                "river": a["location"].get("river"),
                "lat": a["location"]["lat"],
                "lon": a["location"]["lon"],
                "score": a["risk"]["score"],
                "tier": a["risk"]["tier"]["key"],
                "direction": a["risk"]["direction"],
                "confidence": a["confidence"]["level"],
                "headline_en": a["explanation"]["headline_en"],
                "headline_hi": a["explanation"]["headline_hi"],
            }
            for a in worst
        ],
        "basins": _basin_rollup(snap),
    }


def _basin_rollup(snap) -> list[dict]:
    """Risk by CWC river basin — the axis a water-resources engineer thinks in."""
    from collections import Counter, defaultdict

    grouped: dict[str, list[dict]] = defaultdict(list)
    for a in snap.assessments:
        grouped[a["location"].get("cwc_basin") or "Other"].append(a)
    rows = []
    for basin, items in grouped.items():
        scores = [a["risk"]["score"] for a in items]
        counts = Counter(a["risk"]["tier"]["key"] for a in items)
        rows.append(
            {
                "basin": basin,
                "score": round(max(scores), 1),
                "mean_score": round(sum(scores) / len(scores), 1),
                "locations": len(items),
                "counts": {k: counts.get(k, 0) for k in ("red", "orange", "yellow", "green")},
            }
        )
    rows.sort(key=lambda r: r["score"], reverse=True)
    return rows


@router.get("/locations", summary="Every monitored location with its current score")
async def all_locations(date: str | None = None) -> dict:
    snap = await _snapshot(date)
    return {
        "meta": _meta(snap),
        "locations": [
            {
                "id": a["location"]["id"],
                "name": a["location"]["name"],
                "name_hi": a["location"].get("name_hi"),
                "state": a["location"]["state"],
                "district": a["location"].get("district"),
                "lat": a["location"]["lat"],
                "lon": a["location"]["lon"],
                "river": a["location"].get("river"),
                "basin": a["location"].get("basin"),
                "coastal": a["location"]["coastal"],
                "population": a["location"]["population"],
                "population_label": a["exposure"]["population_label"],
                "score": a["risk"]["score"],
                "tier": a["risk"]["tier"]["key"],
                "colour": a["risk"]["tier"]["colour"],
                "direction": a["risk"]["direction"],
                "confidence": a["confidence"]["level"],
                "confidence_value": a["confidence"]["value"],
                "impact_index": a["exposure"]["impact_index"],
                "rain_24h_mm": a["observations"]["rain_24h_mm"],
                "weather": a.get("current_weather"),
                "discharge_cumecs": a["river"].get("current_cumecs"),
                "percentile_for_season": a["river"].get("percentile_for_season"),
                "top_factor": a["factors"][0]["label_en"] if a["factors"] else None,
                "top_factor_hi": a["factors"][0]["label_hi"] if a["factors"] else None,
            }
            for a in sorted(snap.assessments, key=lambda a: a["risk"]["score"], reverse=True)
        ],
    }


# ------------------------------------------------------------------ state view


@router.get("/state/{state_name}/locations", summary="Drill-down for one state or UT")
async def state_locations(state_name: str, date: str | None = None) -> dict:
    snap = await _snapshot(date)
    target = state_name.strip().lower()
    items = [a for a in snap.assessments if a["location"]["state"].lower() == target]
    if not items:
        known = sorted({a["location"]["state"] for a in snap.assessments})
        raise HTTPException(status_code=404, detail=f"No monitored locations in '{state_name}'. Monitored: {known}")

    items.sort(key=lambda a: a["risk"]["score"], reverse=True)
    scores = [a["risk"]["score"] for a in items]
    from collections import Counter

    counts = Counter(a["risk"]["tier"]["key"] for a in items)
    return {
        "meta": _meta(snap),
        "state": items[0]["location"]["state"],
        "score": round(max(scores), 1),
        "mean_score": round(sum(scores) / len(scores), 1),
        "counts": {k: counts.get(k, 0) for k in ("red", "orange", "yellow", "green")},
        "population_at_risk": sum(
            a["location"]["population"] or 0 for a in items if a["risk"]["tier"]["key"] in ("orange", "red")
        ),
        "districts": sorted({a["location"].get("district") for a in items if a["location"].get("district")}),
        "locations": items,
    }


# -------------------------------------------------------------- location views


@router.get("/location/{location_id}/detail", summary="Full hyperlocal assessment")
async def location_detail(location_id: str, date: str | None = None) -> dict:
    snap = await _snapshot(date)
    a = snap.by_id.get(location_id)
    if a is None:
        raise HTTPException(status_code=404, detail=f"Unknown location '{location_id}'")
    return {
        "meta": _meta(snap),
        "assessment": a,
        "score_history": [] if date else store.score_history(location_id),
        "peers": [
            {
                "id": p["location"]["id"],
                "name": p["location"]["name"],
                "score": p["risk"]["score"],
                "tier": p["risk"]["tier"]["key"],
            }
            for p in sorted(
                (x for x in snap.assessments if x["location"]["state"] == a["location"]["state"]),
                key=lambda x: x["risk"]["score"],
                reverse=True,
            )
            if p["location"]["id"] != location_id
        ][:6],
    }


@router.get("/location/{location_id}/timeline", summary="72-hour risk trajectory with uncertainty band")
async def location_timeline(location_id: str, date: str | None = None) -> dict:
    snap = await _snapshot(date)
    a = snap.by_id.get(location_id)
    if a is None:
        raise HTTPException(status_code=404, detail=f"Unknown location '{location_id}'")
    return {
        "meta": _meta(snap),
        "location": a["location"],
        "trajectory": a["trajectory"],
        "direction": a["risk"]["direction"],
        "peak": a["risk"]["peak"],
        "river": {
            "observed": a["river"].get("observed"),
            "forecast": a["river"].get("forecast"),
            "seasonal_bands": a["river"].get("seasonal_bands"),
            "units": "m³/s",
        },
        "score_history": [] if date else store.score_history(location_id),
    }


@router.get("/location/{location_id}/replay", summary="Event replay — score a past date")
async def location_replay(
    location_id: str,
    target: str = Query(..., description="Date to replay, YYYY-MM-DD"),
) -> dict:
    if location_id not in LOCATIONS_BY_ID:
        raise HTTPException(status_code=404, detail=f"Unknown location '{location_id}'")
    try:
        when = date.fromisoformat(target)
    except ValueError:
        raise HTTPException(status_code=400, detail="target must be YYYY-MM-DD")
    if when >= date.today():
        raise HTTPException(status_code=400, detail="Replay only works on past dates")
    try:
        return await engine.replay(location_id, when)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Archive fetch failed: {exc}")


@router.get("/events", summary="The historical flood register")
def events(location_id: str | None = None) -> dict:
    rows = [e for e in EVENTS if location_id is None or e["location_id"] == location_id]
    rows.sort(key=lambda e: e["date"], reverse=True)
    for e in rows:
        loc = LOCATIONS_BY_ID.get(e["location_id"], {})
        e = e.setdefault("location_name", loc.get("name", e["location_id"]))
    return {
        "count": len(rows),
        "events": [
            {
                **e,
                "location_name": LOCATIONS_BY_ID.get(e["location_id"], {}).get("name", e["location_id"]),
                "state": LOCATIONS_BY_ID.get(e["location_id"], {}).get("state"),
            }
            for e in rows
        ],
    }


# ---------------------------------------------------------------------- refresh


@router.post("/refresh", summary="Trigger a re-ingestion and re-score now")
async def refresh() -> dict:
    if engine.refreshing:
        return {"started": False, "reason": "A refresh is already running", "meta": _meta(engine.snapshot) if engine.snapshot else None}
    try:
        snap = await engine.refresh("manual")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Refresh failed: {exc}")
    return {
        "started": True,
        "meta": _meta(snap),
        "counts": snap.tier_counts,
        "changed": _diff_against_previous(snap),
    }


def _diff_against_previous(snap) -> list[dict]:
    """
    What moved since the previous run. This is the proof that the system adapts
    rather than serving a fixed scenario — press refresh on stage and watch rows
    appear here.
    """
    history_runs = [r for r in store.recent_runs(6) if r["status"] in ("ok", "partial") and r["id"] != snap.run_id]
    if not history_runs:
        return []
    prev = store.load_assessments(history_runs[0]["id"])
    prev_by_id = {a["location"]["id"]: a for a in prev}
    changes = []
    for a in snap.assessments:
        before = prev_by_id.get(a["location"]["id"])
        if not before:
            continue
        delta = round(a["risk"]["score"] - before["risk"]["score"], 1)
        if abs(delta) >= 0.5 or a["risk"]["tier"]["key"] != before["risk"]["tier"]["key"]:
            changes.append(
                {
                    "id": a["location"]["id"],
                    "name": a["location"]["name"],
                    "from_score": before["risk"]["score"],
                    "to_score": a["risk"]["score"],
                    "delta": delta,
                    "from_tier": before["risk"]["tier"]["key"],
                    "to_tier": a["risk"]["tier"]["key"],
                    "tier_changed": a["risk"]["tier"]["key"] != before["risk"]["tier"]["key"],
                }
            )
    changes.sort(key=lambda c: abs(c["delta"]), reverse=True)
    return changes[:20]


# ------------------------------------------------------------------- AI / ML


@router.get("/ai/status", summary="Which AI providers, keys and ML models are active")
def ai_status() -> dict:
    model = load_ml_model()
    return {
        "llm": llm.status(),
        "openweathermap": {"enabled": consensus.enabled()},
        "classifier": model.as_dict() if model else None,
        "analogs": {"enabled": ml.ready, "training_days": len(ml.samples)},
        "anomaly": {"method": "isolation_forest" if ml.forest is not None else "snapshot_zscore"},
        "nowcast": nowcast_status(),
    }


class ChatTurn(BaseModel):
    role: str
    content: str


class CopilotRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list)
    lang: str | None = None


@router.post("/copilot", summary="Ask a question about current flood risk")
async def copilot_ask(req: CopilotRequest) -> dict:
    snap = _require_snapshot()
    return await copilot.answer(
        req.question, [t.model_dump() for t in req.history], snap, req.lang
    )


@router.post("/location/{location_id}/advisory", summary="Generate a bilingual public advisory")
async def location_advisory(location_id: str) -> dict:
    snap = _require_snapshot()
    a = snap.by_id.get(location_id)
    if a is None:
        raise HTTPException(status_code=404, detail=f"Unknown location '{location_id}'")
    return await copilot.advisory(a)


class SimulateRequest(BaseModel):
    extra_rain_past_24h: float = Field(0.0, ge=0, le=600)
    extra_rain_next_24h: float = Field(0.0, ge=0, le=600)
    discharge_multiplier: float = Field(1.0, ge=0.2, le=6.0)
    soil_moisture: float | None = Field(None, ge=0.05, le=0.6)


@router.post("/location/{location_id}/simulate", summary="What-if scenario on live inputs")
def location_simulate(location_id: str, req: SimulateRequest) -> dict:
    _require_snapshot()
    try:
        result = engine.simulate(location_id, **req.model_dump())
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No live inputs for '{location_id}' yet")
    s = result["scenario"]
    # The full assessment is large; the simulator needs the headline, drivers,
    # trajectory and the ML read, not the history list and river series.
    return {
        "inputs": result["inputs"],
        "baseline": result["baseline"],
        "delta": result["delta"],
        "scenario": {
            "risk": {k: v for k, v in s["risk"].items() if k != "normalised"},
            "confidence": s["confidence"],
            "factors": s["factors"],
            "trajectory": s["trajectory"],
            "actions": s["actions"],
            "explanation": s["explanation"],
            "observations": s["observations"],
            "ai": {"analogs": s["ai"]["analogs"], "anomaly": s["ai"]["anomaly"]},
        },
    }


@router.get("/insights", summary="ML insights across all locations")
async def insights(date: str | None = None) -> dict:
    snap = await _snapshot(date)
    rows = []
    for a in snap.assessments:
        ai = a.get("ai") or {}
        an, ag = ai.get("anomaly") or {}, ai.get("analogs") or {}
        rows.append(
            {
                "id": a["location"]["id"],
                "name": a["location"]["name"],
                "name_hi": a["location"].get("name_hi"),
                "state": a["location"]["state"],
                "score": a["risk"]["score"],
                "tier": a["risk"]["tier"]["key"],
                "ml_probability": a["risk"].get("ml_probability"),
                "anomaly_score": an.get("score") if an.get("available") else None,
                "anomaly_level": an.get("level"),
                "unusual_features": an.get("unusual_features", []),
                "knn_flood_probability": ag.get("knn_flood_probability") if ag.get("available") else None,
                "top_analog": (ag.get("matches") or [None])[0] if ag.get("available") else None,
                "consensus": ai.get("forecast_consensus"),
            }
        )
    by_anomaly = sorted((r for r in rows if r["anomaly_score"] is not None), key=lambda r: -r["anomaly_score"])
    by_knn = sorted((r for r in rows if r["knn_flood_probability"] is not None), key=lambda r: -r["knn_flood_probability"])
    # Where the independent ML reads disagree with the rule score by a wide
    # margin is where a human should look twice.
    disagreements = sorted(
        (
            r | {"gap": round((r["knn_flood_probability"] * 100) - r["score"], 1)}
            for r in rows
            if r["knn_flood_probability"] is not None
        ),
        key=lambda r: -abs(r["gap"]),
    )[:5]
    return {
        "meta": _meta(snap),
        "status": ai_status(),
        "anomalies": by_anomaly[:8],
        "analog_ranking": by_knn[:8],
        "model_disagreements": disagreements,
    }


@router.get("/timemachine/presets", summary="Well-documented flood days for the national Time Machine")
def timemachine_presets() -> dict:
    """Severity-3, exact-day events: the days worth replaying."""
    rows = [e for e in EVENTS if e.get("severity") == 3 and e.get("date_precision") == "day"]
    rows.sort(key=lambda e: e["date"], reverse=True)
    seen, out = set(), []
    for e in rows:
        if e["date"] in seen:
            continue
        seen.add(e["date"])
        loc = LOCATIONS_BY_ID.get(e["location_id"], {})
        out.append({**e, "location_name": loc.get("name"), "location_name_hi": loc.get("name_hi"), "state": loc.get("state")})
    return {"presets": out}


# -------------------------------------------------------- official government data


@router.get("/official/summary", summary="CWC gauge and NDMA SACHET alert counts")
def official_summary() -> dict:
    from .official import official

    return official.summary()


@router.get("/official/stations", summary="CWC gauges with danger marks and live status")
def official_stations(only_alerting: bool = False) -> dict:
    from .official import official

    rows = official.stations_payload(only_alerting)
    return {"count": len(rows), "fetched_at": official.fetched_at, "stations": rows}


@router.get("/official/alerts", summary="Active NDMA SACHET CAP alerts")
def official_alerts(flood_only: bool = False) -> dict:
    from .official import official

    rows = [a for a in official.alerts if a["flood_related"] or not flood_only]
    rank = {"red": 0, "orange": 1, "yellow": 2}
    rows.sort(key=lambda a: rank.get(a["colour"], 3))
    return {"count": len(rows), "fetched_at": official.fetched_at, "alerts": rows}


@router.get("/official/station/{code}", summary="Gauge hydrograph + CWC forecast + Chronos AI forecast")
async def official_station(code: str) -> dict:
    from .nowcast import forecast_station
    from .official import official

    if code not in official.catalog:
        raise HTTPException(status_code=404, detail=f"Unknown CWC station '{code}'")
    try:
        return await forecast_station(code)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"CWC data unavailable: {exc}")


# ------------------------------------------------------------- rivers & hotspots


@router.get("/rivers", summary="India river network coloured by CWC gauge status")
def rivers_status() -> dict:
    from .rivers import network_status

    return network_status()


@router.get("/hotspots/{location_id}", summary="Hyperlocal water-accumulation grid for one city")
async def city_hotspots(
    location_id: str,
    capacity: float = Query(1.0, ge=0.3, le=3.0, description="Drainage capacity multiplier"),
    scenario_mm_h: float | None = Query(None, ge=1, le=200, description="Design storm intensity"),
    scenario_hours: int = Query(3, ge=1, le=12),
) -> dict:
    from .hotspots import hotspots

    if location_id not in LOCATIONS_BY_ID:
        raise HTTPException(status_code=404, detail=f"Unknown location '{location_id}'")
    try:
        return await hotspots(location_id, capacity, scenario_mm_h, scenario_hours)
    except Exception as exc:
        log.warning("hotspots %s failed: %s", location_id, str(exc)[:300])
        busy = "429" in str(exc) or "rate limit" in str(exc).lower()
        raise HTTPException(
            status_code=503 if busy else 502,
            detail=(
                "The weather service is busy right now, so street-level data for this city could not be loaded. Please try again in a minute."
                if busy
                else "Street-level data for this city is temporarily unavailable. Please try again shortly."
            ),
        )
