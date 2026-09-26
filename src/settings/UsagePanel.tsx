import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  messageFrom,
  type DailyPoint,
  type HostedAccount,
  type Period,
  type Rates,
  type Settings,
  type UsageSummary,
} from "./api";

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: "today", label: "Today" },
  { id: "month", label: "This month" },
  { id: "lifetime", label: "All time" },
];

const CHART_DAYS = 30;

/**
 * What TeleKey has cost, and how long has been spent dictating.
 *
 * Minutes sit beside the money rather than beneath it. Duration is what OpenAI
 * actually billed and is stored directly; money is derived from it at the rates
 * below. So if a rate drifts the spend is an estimate, but the minutes never
 * stop being exact — and the labelling says as much.
 */
export function UsagePanel({
  settings,
  hosted,
  refreshKey,
  onSaveRates,
}: {
  settings: Settings;
  hosted: HostedAccount | null;
  /** Bumped by the window when a dictation settles, so the figures refetch
   *  while the tab is on screen. */
  refreshKey: number;
  onSaveRates: (rates: Rates) => Promise<boolean>;
}) {
  const [period, setPeriod] = useState<Period>("today");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [next, points] = await Promise.all([
        api.usageSummary(period),
        api.usageDaily(CHART_DAYS),
      ]);
      setSummary(next);
      setDaily(points);
      setError(null);
    } catch (err) {
      setError(messageFrom(err));
    }
  }, [period]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const clearAll = async () => {
    try {
      await api.clearUsage();
      setConfirmingClear(false);
      await refresh();
    } catch (err) {
      setError(messageFrom(err));
    }
  };

  if (!summary) {
    return <p className="loading">{error ?? "Loading…"}</p>;
  }

  const { units, cost } = summary;
  const polishTokens = units.polishInputTokens + units.polishOutputTokens;

  // The headline is the sum of what the rows actually display. Rounding each
  // part independently against an exactly-rounded total can show $1.19 + $0.15
  // under a $1.33 heading, which reads as a bug. Rounding stays here rather than
  // in the pricing itself, where it would lose real money on sub-cent amounts.
  const shownTotal = roundCents(cost.transcription) + roundCents(cost.formatting);

  return (
    <>
      <nav className="tabs periods" role="tablist">
        {PERIODS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={period === id}
            className={period === id ? "tab current" : "tab"}
            onClick={() => setPeriod(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      {hosted && (
        <div className="card usageSummary">
          <div className="headline">
            <div>
              <span className="figure">{money(hosted.balanceCents / 100)}</span>
              <span className="figureLabel">credits left</span>
            </div>
            <div>
              <span className="figure">{hosted.email ?? "Signed in"}</span>
              <span className="figureLabel">TeleKey account</span>
            </div>
          </div>
          {hosted.packs.length > 0 ? (
            <div className="packRow">
              {hosted.packs.map((pack) => (
                <button
                  key={pack.id}
                  className="primary"
                  onClick={() => void api.createCheckout(pack.id).catch((err) => setError(messageFrom(err)))}
                >
                  Buy {pack.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="packRow">
              <button
                className="primary"
                onClick={() => void api.openHostedAccount().catch((err) => setError(messageFrom(err)))}
              >
                Buy credits
              </button>
            </div>
          )}
        </div>
      )}

      <div className="card usageSummary">
        <div className="headline">
          <div>
            <span className="figure">{money(shownTotal)}</span>
            <span className="figureLabel">estimated spend</span>
          </div>
          <div>
            <span className="figure">{duration(units.transcribeSeconds)}</span>
            <span className="figureLabel">dictated</span>
          </div>
          <div>
            <span className="figure">{count(units.dictations)}</span>
            <span className="figureLabel">
              {units.dictations === 1 ? "dictation" : "dictations"}
            </span>
          </div>
        </div>

        <div className="row">
          <div className="rowText">
            <span className="rowLabel">Transcription</span>
            <span className="rowHint">{duration(units.transcribeSeconds)} of audio</span>
          </div>
          <span className="rowValue">{money(cost.transcription)}</span>
        </div>

        <div className="row">
          <div className="rowText">
            <span className="rowLabel">Formatting</span>
            <span className="rowHint">
              {polishTokens === 0
                ? "Not used in this period"
                : `${compact(polishTokens)} tokens${
                    units.polishCachedTokens > 0
                      ? `, ${compact(units.polishCachedTokens)} cached`
                      : ""
                  }`}
            </span>
          </div>
          <span className="rowValue">{money(cost.formatting)}</span>
        </div>
      </div>

      <section className="section">
        <h2>Last 30 days</h2>
        <div className="card chartCard">
          <DailyChart points={daily} />
        </div>
      </section>

      {!hosted && (
        <RatesEditor
          rates={settings.rates}
          updated={settings.ratesUpdated}
          onSave={onSaveRates}
        />
      )}

      <section className="section">
        <div className="card">
          <div className="row">
            <div className="rowText">
              <span className="rowLabel">Usage data</span>
              <span className="rowHint">
                Counts and totals only, stored on this Mac. No transcripts.
              </span>
            </div>
            {confirmingClear ? (
              <>
                <button className="danger" onClick={() => void clearAll()}>
                  Delete all
                </button>
                <button className="ghost" onClick={() => setConfirmingClear(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="ghost" onClick={() => setConfirmingClear(true)}>
                Clear
              </button>
            )}
          </div>
        </div>
        <p className="note footnote">
          Totals start from when usage tracking was added — earlier dictations
          were not recorded.
          {hosted
            ? " Credits are the server ledger; minutes below are what this Mac has dictated."
            : " Figures are OpenAI's reported units priced at the rates above, not your invoice."}
        </p>
      </section>
    </>
  );
}

function RatesEditor({
  rates,
  updated,
  onSave,
}: {
  rates: Rates;
  updated: string;
  onSave: (rates: Rates) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(rates);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(rates), [rates]);

  const dirty =
    draft.transcribePerMinute !== rates.transcribePerMinute ||
    draft.polishInputPerMillion !== rates.polishInputPerMillion ||
    draft.polishOutputPerMillion !== rates.polishOutputPerMillion;

  const save = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
  };

  const field = (
    label: string,
    hint: string,
    key: keyof Rates,
    step: string,
  ) => (
    <div className="row" key={key}>
      <div className="rowText">
        <span className="rowLabel">{label}</span>
        <span className="rowHint">{hint}</span>
      </div>
      <input
        className="input rateInput"
        type="number"
        min="0"
        step={step}
        value={draft[key]}
        onChange={(event) =>
          setDraft({ ...draft, [key]: Number(event.target.value) })
        }
      />
    </div>
  );

  return (
    <section className="section">
      <h2>Rates</h2>
      <p className="note">
        Published prices change. These are yours to keep current — editing one
        re-prices every past figure, since the underlying units are stored.
      </p>
      <div className="card">
        {field(
          "Transcription",
          "US$ per minute of audio",
          "transcribePerMinute",
          "0.0001",
        )}
        {field(
          "Formatting input",
          "US$ per million tokens",
          "polishInputPerMillion",
          "0.01",
        )}
        {field(
          "Formatting output",
          "US$ per million tokens",
          "polishOutputPerMillion",
          "0.01",
        )}
        <div className="row">
          <div className="rowText">
            <span className="rowHint">Last set {updated}</span>
          </div>
          <button
            className="primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save rates"}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Daily minutes for the last 30 days.
 *
 * Minutes rather than money: the chart is about how much you dictated, which
 * stays true regardless of what the rates say.
 */
function DailyChart({ points }: { points: DailyPoint[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = element.getBoundingClientRect();
      if (!rect.width) return;

      element.width = rect.width * ratio;
      element.height = rect.height * ratio;

      const ctx = element.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      if (points.length === 0) return;

      const accent =
        getComputedStyle(element).getPropertyValue("--voice").trim() || "#b57d0a";
      const peak = Math.max(...points.map((p) => p.units.transcribeSeconds), 1);

      const gap = 3;
      const barWidth = Math.max(2, (rect.width - gap * (points.length - 1)) / points.length);

      points.forEach((point, index) => {
        const value = point.units.transcribeSeconds;
        const x = index * (barWidth + gap);
        // A day with no activity still draws a baseline, so the axis reads as
        // continuous time rather than a gap in the data.
        const height = value === 0 ? 2 : Math.max(3, (value / peak) * (rect.height - 4));

        ctx.fillStyle = accent;
        ctx.globalAlpha = value === 0 ? 0.16 : 0.85;
        ctx.beginPath();
        ctx.roundRect(x, rect.height - height, barWidth, height, Math.min(2, barWidth / 2));
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    };

    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [points]);

  const total = points.reduce((sum, p) => sum + p.units.transcribeSeconds, 0);
  const busiest = points.reduce(
    (best, p) => (p.units.transcribeSeconds > best.units.transcribeSeconds ? p : best),
    points[0],
  );

  return (
    <div className="chart">
      <canvas ref={canvas} height={72} />
      <div className="chartMeta">
        <span>{duration(total)} over 30 days</span>
        {busiest && busiest.units.transcribeSeconds > 0 && (
          <span>busiest {shortDate(busiest.date)}</span>
        )}
      </div>
    </div>
  );
}

// ---- formatting --------------------------------------------------------

export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Sub-cent amounts round to $0.00, which reads as free rather than tiny. */
export function money(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** Minutes below an hour, hours and minutes above it. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function count(value: number): string {
  return value.toLocaleString();
}

/** 1.9k rather than 1900, so a token count does not dominate the row. */
export function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}
