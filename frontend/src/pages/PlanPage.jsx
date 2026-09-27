import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { api } from '../lib/api';
import { href } from '../lib/router';
import { stateName, tierColour, TIER_LABELS } from '../lib/format';

/**
 * Response plan (officials only): the national allocation of rescue teams, boats,
 * pumps and barricades, solved by the server as a mixed-integer program and
 * re-solved whenever the risk data, the stock or the deployments change.
 *
 * Every number here comes from the plan the server returns - this page draws it,
 * explains it and lets an official dispatch orders; it never re-ranks anything.
 */

const TYPE_COLOUR = { rescue_team: '#1B5FA8', boat: '#0E7C86', pump: '#6B4FA0', barricade: '#5A6472' };
const REASON = {
  stock_committed: ['All reachable stock is committed to higher-priority places', 'पहुँच वाला सारा भंडार अधिक प्राथमिकता वाले स्थानों को'],
  no_depot_in_reach: ['No depot within driving range', 'ड्राइविंग सीमा में कोई डिपो नहीं'],
  island_needs_lift: ['Island: needs sea or air lift from the mainland', 'द्वीप: मुख्य भूमि से समुद्री या हवाई सहायता चाहिए'],
};
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));

function Card({ title, right, children, className = '' }) {
  return (
    <section className={`overflow-hidden rounded-2xl border border-ink-700 bg-white shadow-sm ${className}`}>
      <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
        <h2 className="text-[14px] font-extrabold text-chakra-500">{title}</h2>
        <span className="ml-auto">{right}</span>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({ label, ours, base, better, note }) {
  return (
    <div className="rounded-2xl border border-ink-700 bg-white px-4 py-3.5 shadow-sm">
      <div className="text-[11.5px] font-semibold leading-tight text-ink-400">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-[22px] font-extrabold text-ink-100">{ours}</span>
        {base != null && <span className="text-[12px] text-ink-500">vs {base}</span>}
      </div>
      {note && <div className={`mt-0.5 text-[11.5px] font-bold ${better ? 'text-indiagreen-300' : 'text-ink-500'}`}>{note}</div>}
    </div>
  );
}

function PlanMap({ plan, types }) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (mapRef.current || !hostRef.current) return undefined;
    const map = L.map(hostRef.current, { zoomSnap: 0.5, minZoom: 4 });
    map.zoomControl.setPosition('bottomright');
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Basemap &copy; Esri · Roads: OpenStreetMap / OSRM',
      maxZoom: 14,
    }).addTo(map);
    map.fitBounds([[6.5, 68], [36.5, 97.5]]);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 100);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !plan) return;
    layer.clearLayers();
    const pts = [];
    plan.orders.forEach((o) => {
      const dst = plan.placesById[o.place_id];
      if (!dst || o.depot_lat === undefined || o.basis === 'same_place') return;
      L.polyline([[o.depot_lat, o.depot_lon], [dst.lat, dst.lon]], {
        color: TYPE_COLOUR[o.rtype],
        weight: 1 + Math.min(4, o.count / 6),
        opacity: 0.55,
        dashArray: o.timely < 0.999 ? '4 5' : null,
      })
        .bindTooltip(`${o.count} ${types?.[o.rtype]?.en ?? o.rtype} · ${o.depot_name} → ${o.place_name} · ~${o.arrive_h} h`)
        .addTo(layer);
    });
    const depots = new Map();
    plan.orders.forEach((o) => depots.set(o.depot_id, o));
    depots.forEach((o) => {
      L.circleMarker([o.depot_lat, o.depot_lon], { radius: 4, color: '#0B2A5B', weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(o.depot_name)
        .addTo(layer);
    });
    plan.places.forEach((p) => {
      const r = 4 + Math.min(14, Math.sqrt(p.expected_affected || 0) / 30);
      L.circleMarker([p.lat, p.lon], { radius: r, color: '#fff', weight: 1, fillColor: tierColour(p.tier), fillOpacity: 0.85 })
        .bindTooltip(`#${p.rank} ${p.name} · score ${Math.round(p.s_now)} → ${Math.round(p.s_peak)}`)
        .addTo(layer);
      pts.push([p.lat, p.lon]);
    });
    if (pts.length > 1) mapRef.current.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 8 });
    else if (pts.length === 1) mapRef.current.setView(pts[0], 8);
  }, [plan, types]);

  return <div ref={hostRef} className="h-[380px] w-full rounded-xl" aria-label="Map of planned resource movements" />;
}

/** Street-level placement of a city's pumps and barricades, loaded on demand. */
function CityDeployment({ placeId, lang, tname }) {
  const L_ = (en, hi) => (lang === 'hi' ? hi : en);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      setData(await api.cityPlan(placeId));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return (
      <div className="rounded-lg border border-dashed border-ink-600 px-3 py-2.5">
        <button type="button" className="btn px-3 py-1.5 text-[12.5px]" disabled={busy} onClick={load}>
          {busy ? L_('Placing units on the street grid…', 'गली ग्रिड पर इकाइयाँ रखी जा रही हैं…') : L_('Street-level deployment (800 m cells) →', 'गली-स्तर तैनाती (800 मी सेल) →')}
        </button>
        {error && <p className="mt-1.5 text-[12px] text-risk-red">{error}</p>}
      </div>
    );
  const s = data.summary;
  return (
    <div className="space-y-2.5 rounded-lg border border-ink-700 bg-white px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[12.5px] font-extrabold text-chakra-500">{L_('Street-level deployment', 'गली-स्तर तैनाती')}</span>
        <span className="text-[11.5px] text-ink-500">
          {L_(`${data.pool.pump} pumps, ${data.pool.barricade} barricade sets from the ${data.pool_basis}`, `${data.pool.pump} पंप, ${data.pool.barricade} बैरिकेड सेट`)}
        </span>
        <a href={href(`/hotspots/${placeId}`)} className="ml-auto text-[12px] font-bold text-chakra-500 hover:underline">{L_('Open street map →', 'गली नक्शा →')}</a>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          [`${s.pumps_placed} / ${s.barricades_placed}`, L_('pumps / barricade sets placed', 'पंप / बैरिकेड रखे')],
          [`${s.before_water} / ${data.assignments.length}`, L_('arrive before the water', 'पानी से पहले पहुँचें')],
          [`${s.hospitals_covered} vs ${s.terrain_only_hospitals_covered}`, L_(`flood-prone hospitals covered (of ${s.prone_hospitals}) vs terrain-only`, `बाढ़-प्रवण अस्पताल (${s.prone_hospitals} में) बनाम केवल भूभाग`)],
          [`${s.underpasses_closed}`, L_('underpasses closed', 'अंडरपास बंद')],
        ].map(([v, k]) => (
          <div key={k} className="rounded-md bg-ink-850 px-2.5 py-1.5">
            <div className="font-mono text-[14px] font-extrabold text-ink-100">{v}</div>
            <div className="text-[10.5px] leading-tight text-ink-500">{k}</div>
          </div>
        ))}
      </div>
      {data.note_en && <p className="text-[12.5px] font-semibold text-indiagreen-300">{lang === 'hi' ? data.note_hi : data.note_en}</p>}
      <ul className="max-h-64 space-y-1 overflow-auto">
        {data.assignments.map((a, i) => (
          <li key={`${a.k}-${a.rtype}-${i}`} className="flex gap-2 text-[12px] leading-snug text-ink-200">
            <b className="shrink-0" style={{ color: TYPE_COLOUR[a.rtype] }}>
              {a.count} {tname(a.rtype).toLowerCase()}
            </b>
            <span className={a.before_water ? '' : 'text-risk-orange'}>{lang === 'hi' ? a.why_hi : a.why_en}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-ink-500">
        {data.live_rain
          ? L_('Flood weight = the street model’s ensemble chance each cell floods.', 'बाढ़ भार = प्रत्येक सेल में बाढ़ की सामूहिक संभावना।')
          : L_('Live rain is unavailable, so cells are ranked by terrain susceptibility; placements update when rain data returns.', 'लाइव वर्षा उपलब्ध नहीं; भूभाग संवेदनशीलता से क्रम।')}{' '}
        {L_('Facility counts are named OpenStreetMap entries, a lower bound.', 'सुविधा गिनती OpenStreetMap से, न्यूनतम।')}
      </p>
    </div>
  );
}

export default function PlanPage({ lang }) {
  const L_ = (en, hi) => (lang === 'hi' ? hi : en);
  const hiFont = lang === 'hi' ? 'font-devanagari' : '';
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [open, setOpen] = useState(() => new Set());
  const [notice, setNotice] = useState(null);

  const load = useCallback(async (fn = api.plan) => {
    try {
      const p = await fn();
      setPlan(p);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 60_000); // picks up re-plans after new risk data
    return () => clearInterval(id);
  }, [load]);

  const view = useMemo(() => {
    if (!plan) return null;
    const placesById = Object.fromEntries(plan.places.map((p) => [p.id, p]));
    const ordersByPlace = {};
    plan.orders.forEach((o) => (ordersByPlace[o.place_id] ??= []).push(o));
    return { ...plan, placesById, ordersByPlace };
  }, [plan]);

  // A new plan id means new orders: keep only selections that still exist.
  useEffect(() => {
    if (!plan) return;
    const ids = new Set(plan.orders.map((o) => o.id));
    setSelected((prev) => new Set([...prev].filter((x) => ids.has(x))));
  }, [plan]);

  if (error && !plan) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="rounded-xl border border-risk-red/40 bg-white p-4 text-[13px] text-risk-red">{error}</p>
        <button type="button" className="btn btn-primary mt-3" onClick={() => load()}>{L_('Try again', 'पुनः प्रयास करें')}</button>
      </div>
    );
  }
  if (!view) return <div className="p-10 text-center text-[13px] text-ink-400">{L_('Solving the response plan…', 'प्रतिक्रिया योजना बन रही है…')}</div>;

  const types = view.assumptions.rtypes;
  const s = view.summary;
  const tname = (r) => (lang === 'hi' ? types[r]?.hi : types[r]?.en) ?? r;
  const selUnits = view.orders.filter((o) => selected.has(o.id)).reduce((n, o) => n + o.count, 0);

  const run = async (key, fn) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ ok: false, text: e.message });
    } finally {
      setBusy(null);
    }
  };
  const dispatch = () =>
    run('dispatch', async () => {
      const r = await api.dispatch(view.id, [...selected]);
      setPlan(r.plan);
      setSelected(new Set());
      setNotice({
        ok: true,
        text: L_(
          `${r.dispatched_units} units dispatched — the plan was re-optimised around them.${r.notified ? ` Deployment orders sent to ${r.notified} official(s) via viaSocket.` : ''}`,
          `${r.dispatched_units} इकाइयाँ रवाना — योजना उनके अनुसार पुनः अनुकूलित।${r.notified ? ` ${r.notified} अधिकारियों को आदेश भेजे गए।` : ''}`,
        ),
      });
    });
  const release = (id) =>
    run(`rel-${id}`, async () => {
      await api.releaseDeployment(id);
      await load();
      setNotice({ ok: true, text: L_('Units returned to reserve; plan re-optimised.', 'इकाइयाँ रिज़र्व में लौटीं; योजना पुनः अनुकूलित।') });
    });
  const toggle = (set, setter, id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };
  const created = new Date(view.created_at.endsWith('Z') || view.created_at.includes('+') ? view.created_at : `${view.created_at}Z`);
  const when = created.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

  return (
    <div id="main-content" className={`mx-auto w-full max-w-[1400px] space-y-5 px-4 py-5 ${hiFont}`}>
      {/* --------------------------------------------------------- header */}
      <section className="rounded-3xl border border-ink-700 bg-white px-6 py-5 shadow-sm">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[260px] flex-1">
            <div className="text-[12px] font-bold uppercase tracking-wider text-ink-500">{L_('Response plan', 'प्रतिक्रिया योजना')}</div>
            <h1 className="mt-1 text-[26px] font-extrabold leading-tight text-chakra-500">
              {L_('Where to send rescue teams, boats, pumps and barricades', 'बचाव दल, नावें, पंप और बैरिकेड कहाँ भेजें')}
            </h1>
            <p className="mt-1 text-[13px] text-ink-400">
              {L_(
                `Optimised at ${when} IST (${view.trigger}) · re-solves automatically when risk, stock or deployments change`,
                `${when} IST पर अनुकूलित (${view.trigger}) · जोखिम, भंडार या तैनाती बदलने पर स्वतः`,
              )}
              {' · '}
              <span className={view.travel?.source === 'osrm' ? 'text-indiagreen-300' : 'text-risk-orange'}>
                {view.travel?.source === 'osrm' ? L_('road times from OpenStreetMap (OSRM)', 'OpenStreetMap (OSRM) से सड़क समय') : L_('road times estimated', 'सड़क समय अनुमानित')}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={!!busy} onClick={() => run('replan', () => load(api.replan))}>
              {busy === 'replan' ? L_('Re-planning…', 'पुनः योजना…') : L_('Re-plan now', 'अभी पुनः योजना')}
            </button>
            <a href={href('/resources')} className="btn">{L_('Resources & stock', 'संसाधन व भंडार')}</a>
            <button
              type="button"
              disabled={!selected.size || !!busy}
              onClick={dispatch}
              className="btn border-chakra-500 bg-chakra-500 text-white hover:bg-[#123A78] hover:text-white disabled:opacity-50"
            >
              {busy === 'dispatch' ? L_('Dispatching…', 'रवाना हो रहा…') : L_(`Dispatch selected (${selUnits} units)`, `चयनित रवाना करें (${selUnits})`)}
            </button>
          </div>
        </div>
        {notice && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-[13px] ${notice.ok ? 'bg-indiagreen-500/[0.08] text-indiagreen-300' : 'bg-risk-red/5 text-risk-red'}`}>{notice.text}</p>
        )}
      </section>

      {/* ----------------------------------------------------------- kpis */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={L_('People reached by rescue teams & boats (expected)', 'बचाव दल व नावों से पहुँचे लोग (अपेक्षित)')}
          ours={fmt(s.ours.helped)}
          base={fmt(s.baseline.helped)}
          better={s.gain > 0}
          note={s.gain_pct != null ? L_(`${s.gain >= 0 ? '+' : ''}${s.gain_pct}% vs severity-only`, `गंभीरता-मात्र से ${s.gain_pct}%`) : null}
        />
        <Stat
          label={L_('Units arriving before the peak', 'शिखर से पहले पहुँचने वाली इकाइयाँ')}
          ours={fmt(s.ours.on_time_units)}
          base={fmt(s.baseline.on_time_units)}
          better={s.ours.on_time_units > s.baseline.on_time_units}
          note={L_(`of ${fmt(s.ours.units)} units planned`, `${fmt(s.ours.units)} नियोजित में से`)}
        />
        <Stat
          label={L_('Places at risk (72 h) · getting worse', 'जोखिम वाले स्थान (72 घंटे) · बिगड़ रहे')}
          ours={`${s.places_at_risk} · ${s.places_worsening}`}
          note={L_(`${s.ours.prepositioned} pre-positioned before their peak`, `${s.ours.prepositioned} शिखर से पहले तैनात`)}
          better
        />
        <Stat
          label={L_('Places still short of resources', 'संसाधनों की कमी वाले स्थान')}
          ours={s.short_places}
          note={L_('see the reasons below', 'कारण नीचे देखें')}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-5">
          <Card title={L_('Planned movements', 'नियोजित आवाजाही')} right={
            <span className="flex flex-wrap gap-3 text-[11px] text-ink-400">
              {Object.keys(TYPE_COLOUR).map((r) => (
                <span key={r} className="flex items-center gap-1"><span className="inline-block h-1 w-4 rounded" style={{ background: TYPE_COLOUR[r] }} />{tname(r)}</span>
              ))}
              <span>- - {L_('arrives after peak', 'शिखर के बाद')}</span>
            </span>
          }>
            <PlanMap plan={view} types={types} />
          </Card>

          {/* ------------------------------------------------ priority list */}
          <Card title={L_('Priority list — ranked by expected people affected', 'प्राथमिकता सूची — अपेक्षित प्रभावित लोगों के अनुसार')}>
            {view.places.length === 0 ? (
              <p className="text-[13.5px] font-semibold text-indiagreen-300">{L_('No place in your area is at Yellow or above in the next 72 hours.', 'अगले 72 घंटों में आपके क्षेत्र में कोई स्थान पीले या ऊपर नहीं।')}</p>
            ) : (
              <ol className="space-y-2.5">
                {view.places.map((p) => {
                  const orders = view.ordersByPlace[p.id] ?? [];
                  const isOpen = open.has(p.id);
                  const short = Object.entries(p.types).filter(([, t]) => t.short > 0);
                  return (
                    <li key={p.id} className="rounded-xl border border-ink-700" style={{ borderLeft: `4px solid ${tierColour(p.tier)}` }}>
                      <button type="button" onClick={() => toggle(open, setOpen, p.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-3 text-left" aria-expanded={isOpen}>
                        <span className="w-8 font-mono text-[15px] font-extrabold text-chakra-500">#{p.rank}</span>
                        <span className="min-w-[160px] flex-1">
                          <span className="block text-[14.5px] font-bold text-ink-100">{lang === 'hi' ? p.name_hi || p.name : p.name}</span>
                          <span className="block text-[11.5px] text-ink-500">
                            {stateName(p.state, lang)} · {L_(TIER_LABELS[p.tier].en, TIER_LABELS[p.tier].hi)} {Math.round(p.s_now)}
                            {p.t_peak > 0 ? ` → ${Math.round(p.s_peak)} ${L_(`in ${p.t_peak} h`, `${p.t_peak} घंटे में`)}` : ''}
                            {p.baseline_rank && p.baseline_rank !== p.rank ? ` · ${L_(`severity-only rank #${p.baseline_rank}`, `गंभीरता-मात्र क्रम #${p.baseline_rank}`)}` : ''}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="block font-mono text-[13px] font-bold text-ink-200">{fmt(p.expected_affected)}</span>
                          <span className="block text-[10.5px] text-ink-500">{L_('expected affected', 'अपेक्षित प्रभावित')}</span>
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {Object.entries(p.types).map(([r, t]) => (
                            <span key={r} className="rounded-md px-1.5 py-0.5 font-mono text-[11px] font-bold text-white" style={{ background: TYPE_COLOUR[r], opacity: t.planned + t.already ? 1 : 0.35 }} title={tname(r)}>
                              {t.planned + t.already}/{t.need}
                            </span>
                          ))}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="space-y-3 border-t border-ink-800 px-3.5 py-3">
                          <p className="text-[12.5px] leading-relaxed text-ink-300">{lang === 'hi' ? p.why.hi : p.why.en}</p>
                          {short.length > 0 && (
                            <ul className="space-y-1">
                              {short.map(([r, t]) => (
                                <li key={r} className="text-[12px] text-risk-red">
                                  {L_(`Short by ${t.short} ${tname(r).toLowerCase()}`, `${t.short} ${tname(r)} कम`)}: {L_(...(REASON[t.short_reason] ?? ['', '']))}
                                </li>
                              ))}
                            </ul>
                          )}
                          {p.assets && <CityDeployment placeId={p.id} lang={lang} tname={tname} />}
                          {orders.length === 0 ? (
                            <p className="text-[12px] text-ink-500">{L_('No new units planned for this place.', 'इस स्थान के लिए कोई नई इकाई नियोजित नहीं।')}</p>
                          ) : (
                            <ul className="space-y-2">
                              {orders.map((o) => (
                                <li key={o.id} className="flex gap-2.5 rounded-lg bg-ink-850 px-3 py-2">
                                  <input
                                    type="checkbox"
                                    className="mt-1"
                                    checked={selected.has(o.id)}
                                    onChange={() => toggle(selected, setSelected, o.id)}
                                    aria-label={L_(`Select ${o.count} ${tname(o.rtype)} from ${o.depot_name}`, `चुनें`)}
                                  />
                                  <span className="text-[12.5px] leading-snug text-ink-200">
                                    <b style={{ color: TYPE_COLOUR[o.rtype] }}>{tname(o.rtype)}</b> · {lang === 'hi' ? o.why.hi : o.why.en}
                                    {o.basis === 'estimated' && <span className="text-risk-orange"> {L_('(road time estimated)', '(अनुमानित)')}</span>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>

        {/* --------------------------------------------------- side column */}
        <div className="space-y-5">
          <Card title={L_('Plan vs severity-only, by resource', 'संसाधनवार: योजना बनाम गंभीरता-मात्र')}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-500">
                  <th className="pb-1.5 font-bold">{L_('Resource', 'संसाधन')}</th>
                  <th className="pb-1.5 text-right font-bold">{L_('Need', 'ज़रूरत')}</th>
                  <th className="pb-1.5 text-right font-bold">{L_('On time: plan', 'समय पर: योजना')}</th>
                  <th className="pb-1.5 text-right font-bold">{L_('severity-only', 'गंभीरता')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {Object.keys(TYPE_COLOUR).map((r) => (
                  <tr key={r}>
                    <td className="py-1.5 font-semibold" style={{ color: TYPE_COLOUR[r] }}>{tname(r)}</td>
                    <td className="py-1.5 text-right font-mono">{fmt(s.need?.[r])}</td>
                    <td className="py-1.5 text-right font-mono font-bold">{fmt(s.ours.by_type[r].on_time)} / {fmt(s.ours.by_type[r].units)}</td>
                    <td className="py-1.5 text-right font-mono text-ink-400">{fmt(s.baseline.by_type[r].on_time)} / {fmt(s.baseline.by_type[r].units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
              {L_(
                'Severity-only ranks places by their current score and fills each from its nearest depots. Both are scored with the same yardstick.',
                'गंभीरता-मात्र: वर्तमान स्कोर के क्रम में, निकटतम डिपो से। दोनों एक ही पैमाने पर आँके गए।',
              )}
            </p>
          </Card>

          <Card title={L_('What changed since the last plan', 'पिछली योजना से क्या बदला')}>
            {view.changes.length === 0 ? (
              <p className="text-[12.5px] text-ink-500">{L_('No change in allocations.', 'आवंटन में कोई बदलाव नहीं।')}</p>
            ) : (
              <ul className="space-y-1.5">
                {view.changes.slice(0, 10).map((c) => (
                  <li key={`${c.place_id}-${c.rtype}`} className="text-[12.5px] text-ink-200">
                    <b>{c.place_name}</b> · {tname(c.rtype)}: {c.was} → <b>{c.now}</b>
                    <span className="text-ink-500"> — {lang === 'hi' ? c.reason_hi : c.reason_en}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={L_('Where one more unit helps most', 'एक और इकाई सबसे अधिक कहाँ काम आएगी')}>
            {view.marginal.length === 0 ? (
              <p className="text-[12.5px] text-ink-500">{L_('Stock covers every need that can be reached.', 'भंडार हर पहुँच योग्य ज़रूरत पूरी करता है।')}</p>
            ) : (
              <ul className="space-y-1.5">
                {view.marginal.slice(0, 6).map((m) => (
                  <li key={`${m.depot_id}-${m.rtype}`} className="text-[12.5px] text-ink-200">
                    {L_('One more', 'एक और')} <b style={{ color: TYPE_COLOUR[m.rtype] }}>{tname(m.rtype).toLowerCase()}</b> {L_('at', '')} {m.depot_name}:
                    <b> +{fmt(m.per_unit)}</b> {L_('people reached', 'लोग')}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11.5px] text-ink-500">{L_('From the optimisation’s shadow prices — use it to decide what to request.', 'अनुकूलन के छाया-मूल्य से — माँग तय करने हेतु।')}</p>
          </Card>

          {(view.releases.length > 0 || view.deployments.length > 0) && (
            <Card title={L_('Deployed units', 'तैनात इकाइयाँ')}>
              {view.releases.length > 0 && (
                <ul className="mb-3 space-y-2">
                  {view.releases.map((r) => (
                    <li key={r.id} className="rounded-lg bg-indiagreen-500/[0.07] px-3 py-2 text-[12.5px] text-ink-200">
                      {lang === 'hi' ? r.why_hi : r.why_en}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="space-y-1.5">
                {view.deployments.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-[12.5px] text-ink-200">
                    <span className="flex-1">
                      {d.count} {tname(d.rtype).toLowerCase()} → <b>{view.placesById[d.place_id]?.name ?? d.place_id}</b>
                      <span className="text-ink-500"> · {d.created_by}</span>
                    </span>
                    <button type="button" className="btn px-2 py-0.5 text-[11.5px]" disabled={!!busy} onClick={() => release(d.id)}>
                      {L_('Release', 'वापस')}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <details className="rounded-2xl border border-ink-700 bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-[13.5px] font-extrabold text-chakra-500">{L_('How the plan is made (assumptions)', 'योजना कैसे बनती है (मान्यताएँ)')}</summary>
            <div className="mt-3 space-y-2 text-[12px] leading-relaxed text-ink-300">
              <p>
                {L_(
                  'Mixed-integer optimisation (HiGHS): maximise expected people reached, never exceeding any depot’s available stock. Each place’s need is split into thirds worth 100%, 70% and 40% per unit, so scarce units spread across places.',
                  'मिश्रित-पूर्णांक अनुकूलन (HiGHS): अपेक्षित पहुँचे लोग अधिकतम, किसी डिपो के भंडार से अधिक नहीं।',
                )}
              </p>
              <p>
                {L_('Chance of flooding by level, from past floods:', 'स्तरवार बाढ़ की संभावना, पिछली बाढ़ों से:')}{' '}
                {view.assumptions.calibration.bands.map((b) => `${b.from}–${b.to}: ${(100 * b.rate).toFixed(1)}% (${b.floods}/${b.days})`).join(' · ')}
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {Object.entries(types).map(([r, t]) => (
                  <li key={r}>
                    {tname(r)}: {L_(`serves ~${fmt(t.cap)} people; drive limit ${t.max_h} h; weight river ${t.rel.riverine} / rain ${t.rel.pluvial}`, `~${fmt(t.cap)} लोग; अधिकतम ${t.max_h} घंटे`)}
                  </li>
                ))}
              </ul>
              <p>
                {L_(
                  `Mobilisation: NDRF ${view.assumptions.mobilise_h.ndrf} h, SDRF ${view.assumptions.mobilise_h.sdrf} h, district ${view.assumptions.mobilise_h.district} h. Roads into Red areas are 1.5× slower, Orange 1.25×. A flood already under way: arriving within ${view.assumptions.ongoing_window_h} h counts in full. People in the flood area: ${view.assumptions.exposed_share}.`,
                  `तैयारी समय: NDRF ${view.assumptions.mobilise_h.ndrf} घंटे, SDRF ${view.assumptions.mobilise_h.sdrf} घंटे। लाल क्षेत्र की सड़कें 1.5× धीमी।`,
                )}
              </p>
              {view.assumptions.assets && (
                <p>
                  {L_(
                    `Assets: in cities with a street grid, each hospital in a flood-prone cell (susceptibility ≥ ${view.assumptions.assets.prone_susceptibility}) counts as ${fmt(view.assumptions.assets.hospital_eq)} people and needs a pump; each school counts as ${fmt(view.assumptions.assets.school_eq)} people; each flood-prone underpass needs ${view.assumptions.assets.barricades_per_underpass} barricade sets.`,
                    `संपत्तियाँ: बाढ़-प्रवण सेल में हर अस्पताल ${fmt(view.assumptions.assets.hospital_eq)} लोगों के बराबर और एक पंप; हर अंडरपास ${view.assumptions.assets.barricades_per_underpass} बैरिकेड सेट।`,
                  )}
                </p>
              )}
              <p className="text-ink-500">{L_('These are stated planning assumptions, not measured rates. Stock is demo data except NDRF battalion bases and teams; officials can enter real counts on the Resources page.', 'ये नियोजन मान्यताएँ हैं। NDRF को छोड़ भंडार डेमो है।')}</p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
