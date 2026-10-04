import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PanelLine,
  RankedPanel,
  ReportDocument,
  StatementDocument,
  StatementPanel,
} from "../report-document";

/**
 * Retained reports on paper, in the brand's design language: the logo, one
 * headline with an Instrument Serif tail, a mono line of facts, stat tiles
 * on the warm paper tile, mono captions on hairlines for everything tabular,
 * and a footer on every page that says whose report it is and which revision
 * of the books it shows. The palette is the invoice PDF's paper palette
 * (app/src/lib/invoice-pdf): hex only, because react-pdf cannot read CSS.
 *
 * Nothing is fetched over the network: fonts and the logo are read from
 * pdf-assets on the server, so exporting private books never calls out.
 */
const paper = {
  page: "#FFFFFF",
  tile: "#F5F3EF",
  tileRim: "#E6E4DF",
  ink: "#0D0F14",
  body: "#3F4046",
  muted: "#6E6D69",
  hairline: "#E6E4DF",
  hairlineStrong: "#D9D6CF",
  row: "#EFEDE8",
  accent: "#4A7171",
  accentDeep: "#3A5959",
  accentTile: "#F0F5F5",
  accentBorder: "#D9E6E6",
  copper: "#8F7159",
  income: "#5B8A8A",
  expense: "#C5A68F",
  rose: "#A33F3F",
};
const SANS = "Report DM Sans",
  MONO = "Report DM Mono",
  SERIF = "Report Instrument Serif";
const MARGIN_X = 48;

/** pdf-assets beside this file; the tests run from the repo root, Next from admin. */
function assetDirectory() {
  const relative = join("src", "lib", "accounting", "server", "pdf-assets");
  const candidates = [
    join(process.cwd(), relative),
    join(process.cwd(), "admin", relative),
  ];
  const found = candidates.find((dir) =>
    existsSync(join(dir, "dm-sans-400.ttf")),
  );
  if (!found) throw new Error("The report PDF fonts are missing.");
  return found;
}

let registered = false;
type ReactPdf = typeof import("@react-pdf/renderer");
function registerFonts(Font: ReactPdf["Font"], dir: string) {
  if (registered) return;
  const file = (name: string) => join(dir, name);
  Font.register({
    family: SANS,
    fonts: [
      { src: file("dm-sans-400.ttf"), fontWeight: 400 },
      { src: file("dm-sans-500.ttf"), fontWeight: 500 },
      { src: file("dm-sans-600.ttf"), fontWeight: 600 },
      { src: file("dm-sans-700.ttf"), fontWeight: 700 },
    ],
  });
  Font.register({
    family: MONO,
    fonts: [
      { src: file("dm-mono-300.ttf"), fontWeight: 300 },
      { src: file("dm-mono-400.ttf"), fontWeight: 400 },
      { src: file("dm-mono-500.ttf"), fontWeight: 500 },
    ],
  });
  Font.register({
    family: SERIF,
    fonts: [
      {
        src: file("instrument-serif-400.ttf"),
        fontWeight: 400,
        fontStyle: "normal",
      },
      {
        src: file("instrument-serif-400-italic.ttf"),
        fontWeight: 400,
        fontStyle: "italic",
      },
    ],
  });
  // Account names and memos must not break mid-word.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Phoenix",
});
const monthFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});
const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const prepared = (iso: string | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? dateFormat.format(d) : "";
};
const meta = (doc: ReportDocument, key: string) =>
  doc.metadata.find(([k]) => k === key)?.[1];

/** "$12k", "$1.2M": axis labels only; every figure elsewhere is exact. */
function compactDollars(value: number) {
  const a = Math.abs(value),
    sign = value < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a)}`;
}
function niceStep(max: number) {
  const raw = Math.max(max, 1) / 4,
    magnitude = 10 ** Math.floor(Math.log10(raw)),
    n = raw / magnitude;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude;
}

export async function reportPdf(doc: ReportDocument): Promise<Buffer> {
  const pdf = await import("@react-pdf/renderer");
  const {
    Document,
    Page,
    Text,
    View,
    Image,
    Svg,
    Rect,
    Line,
    StyleSheet,
    renderToBuffer,
    Font,
  } = pdf;
  const assets = assetDirectory();
  registerFonts(Font, assets);
  // A Buffer, not a path: react-pdf reads a Windows path as a URL to fetch.
  const logo = readFileSync(join(assets, "valiance-media-logo.png"));
  if (doc.rows.length > 10000)
    throw new Error(
      "PDF export supports up to 10,000 rows. Choose a shorter period or export the complete CSV.",
    );

  const s = StyleSheet.create({
    page: {
      fontFamily: SANS,
      fontSize: 9,
      color: paper.body,
      backgroundColor: paper.page,
      // DM Sans draws fi, ff and fl as single ligature glyphs, which copy and
      // search read back as "Proft". Plain glyphs keep the text extractable.
      fontFeatureSettings: { liga: false, clig: false, dlig: false },
      paddingTop: 44,
      paddingBottom: 66,
      paddingHorizontal: MARGIN_X,
    },
    monoLabel: {
      fontFamily: MONO,
      fontSize: 6.75,
      fontWeight: 400,
      letterSpacing: 1,
      textTransform: "uppercase",
      color: paper.muted,
    },
    masthead: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 26,
    },
    logo: { width: 138, height: 32.2 },
    mastheadRight: { alignItems: "flex-end" },
    mastheadDate: {
      fontFamily: MONO,
      fontSize: 8.5,
      color: paper.ink,
      marginTop: 4,
    },
    heading: {
      fontSize: 26,
      fontWeight: 500,
      letterSpacing: -0.7,
      lineHeight: 1.1,
      color: paper.ink,
    },
    headingTail: {
      fontFamily: SERIF,
      fontStyle: "italic",
      fontWeight: 400,
      fontSize: 28,
      letterSpacing: -0.2,
      color: paper.copper,
    },
    facts: {
      marginTop: 7,
      fontFamily: MONO,
      fontSize: 7.25,
      letterSpacing: 0.7,
      textTransform: "uppercase",
      color: paper.muted,
      lineHeight: 1.5,
    },
    scope: { marginTop: 6, fontSize: 8, color: paper.body },
    tiles: { flexDirection: "row", gap: 8, marginTop: 20 },
    tile: {
      flex: 1,
      backgroundColor: paper.tile,
      borderWidth: 0.75,
      borderColor: paper.hairline,
      borderTopColor: paper.tileRim,
      borderRadius: 10,
      paddingVertical: 11,
      paddingHorizontal: 12,
    },
    tileAccent: {
      backgroundColor: paper.accentTile,
      borderColor: paper.accentBorder,
      borderTopColor: paper.accentBorder,
    },
    tileValue: {
      fontFamily: MONO,
      fontWeight: 400,
      letterSpacing: -0.4,
      color: paper.ink,
      marginTop: 7,
    },
    tileChange: {
      fontFamily: MONO,
      fontSize: 6.5,
      marginTop: 5,
      color: paper.muted,
    },
    sectionHead: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-end",
      marginBottom: 8,
    },
    sectionTitle: { fontSize: 10.5, fontWeight: 600, color: paper.ink },
    legend: { flexDirection: "row", gap: 12, alignItems: "center" },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
    swatch: { width: 6, height: 6, borderRadius: 1.5 },
    chartNote: { marginTop: 4, fontSize: 7, color: paper.muted },
    tableHead: {
      flexDirection: "row",
      borderBottomWidth: 0.75,
      borderBottomColor: paper.hairlineStrong,
      paddingTop: 2,
      paddingBottom: 6,
      backgroundColor: paper.page,
    },
    th: {
      fontFamily: MONO,
      fontSize: 6.5,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      color: paper.muted,
    },
    sectionRow: {
      flexDirection: "row",
      paddingTop: 12,
      paddingBottom: 5,
    },
    sectionLabel: {
      fontFamily: MONO,
      fontSize: 7,
      fontWeight: 500,
      letterSpacing: 1.1,
      textTransform: "uppercase",
      color: paper.accent,
    },
    groupLabel: {
      fontSize: 8.5,
      fontWeight: 600,
      color: paper.body,
      paddingLeft: 8,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingVertical: 4.25,
      borderBottomWidth: 0.5,
      borderBottomColor: paper.row,
    },
    subtotal: {
      borderTopWidth: 0.75,
      borderTopColor: paper.hairlineStrong,
      borderBottomWidth: 0,
      paddingVertical: 6,
      marginBottom: 2,
    },
    total: {
      backgroundColor: paper.accentTile,
      borderWidth: 0.75,
      borderColor: paper.accentBorder,
      borderRadius: 6,
      paddingVertical: 7,
      marginTop: 10,
    },
    label: { fontSize: 8.75, color: paper.body, lineHeight: 1.3 },
    figure: { fontFamily: MONO, fontSize: 8.5, color: paper.ink },
    notes: { marginTop: 16, gap: 3 },
    note: { fontSize: 7, color: paper.muted, lineHeight: 1.45 },
    metaTile: {
      flexDirection: "row",
      flexWrap: "wrap",
      backgroundColor: paper.tile,
      borderWidth: 0.75,
      borderColor: paper.hairline,
      borderRadius: 10,
      paddingTop: 10,
      paddingHorizontal: 12,
      marginTop: 18,
      marginBottom: 18,
    },
    metaItem: { width: "50%", paddingRight: 12, marginBottom: 9 },
    metaValue: { fontSize: 8.25, color: paper.ink, marginTop: 3 },
    footerRule: {
      position: "absolute",
      bottom: 42,
      left: MARGIN_X,
      right: MARGIN_X,
      height: 0.5,
      backgroundColor: paper.hairline,
    },
    footer: {
      position: "absolute",
      bottom: 26,
      left: MARGIN_X,
      right: MARGIN_X,
      flexDirection: "row",
      justifyContent: "space-between",
    },
    footerText: {
      fontFamily: MONO,
      fontSize: 6.5,
      letterSpacing: 0.5,
      color: paper.muted,
    },
  });

  const words = doc.title.split(" ");
  const tail = words.pop() ?? doc.title;
  const head = words.join(" ");
  const preparedOn = prepared(meta(doc, "Retained at"));
  const revision = meta(doc, "Data revision");
  const tone = (t: "good" | "bad" | "flat" | null | undefined) =>
    t === "good"
      ? paper.accent
      : t === "bad"
        ? paper.rose
        : t === "flat"
          ? paper.muted
          : undefined;
  /**
   * Rows in page-safe blocks. A heading never sits at the foot of a page
   * with one row under it: it travels with the next three rows of its
   * section (or the whole section when it is shorter), and moves to the
   * next page with them when they do not fit. Totals stay with the line
   * above them.
   */
  function blocks<T extends { kind: string }>(rows: T[], keep = 3): T[][] {
    const out: T[][] = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== "heading") {
        // A subtotal or total never opens a page alone: it travels with
        // the row before it.
        if (rows[i].kind !== "account" && out.length) out[out.length - 1].push(rows[i]);
        else out.push([rows[i]]);
        i++;
        continue;
      }
      const block: T[] = [];
      while (i < rows.length && rows[i].kind === "heading") block.push(rows[i++]);
      let taken = 0;
      while (i < rows.length && taken < keep && rows[i].kind !== "heading") {
        block.push(rows[i++]);
        taken++;
      }
      out.push(block);
    }
    return out;
  }

  const masthead = (
    <View style={s.masthead}>
      {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image has no alt prop */}
      <Image src={logo} style={s.logo} />
      <View style={s.mastheadRight}>
        <Text style={s.monoLabel}>{doc.title}</Text>
        {preparedOn ? (
          <Text style={s.mastheadDate}>Prepared {preparedOn}</Text>
        ) : null}
      </View>
    </View>
  );
  const heading = (
    <Text style={s.heading}>
      {head ? `${head} ` : ""}
      <Text style={s.headingTail}>{tail}</Text>
    </Text>
  );
  const footer = (
    <>
      <View style={s.footerRule} fixed />
      <View style={s.footer} fixed>
        <Text style={s.footerText}>
          {doc.company} · {doc.title}
        </Text>
        <Text
          style={s.footerText}
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages}`
          }
        />
        <Text style={s.footerText}>
          {[preparedOn && `Prepared ${preparedOn}`, revision && `Revision ${revision}`]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
    </>
  );
  const notes = (
    <View style={s.notes} wrap={false}>
      {doc.notes.map((note) => (
        <Text key={note} style={s.note}>
          {note}
        </Text>
      ))}
      <Text style={s.note}>Snapshot {doc.snapshotId}</Text>
    </View>
  );

  if (doc.statement)
    return renderToBuffer(
      <Document
        title={`${doc.company} - ${doc.title}`}
        author={doc.company}
        subject={`Retained accounting report ${doc.snapshotId}`}
      >
        <Page size="LETTER" style={s.page}>
          {masthead}
          {heading}
          <Text style={s.facts}>
            {[doc.company, doc.statement.periodLabel, "Cash basis", "USD"].join(
              "  ·  ",
            )}
            {doc.statement.comparisonLabel
              ? `\nCompared with ${doc.statement.comparisonLabel}`
              : ""}
          </Text>
          {doc.statement.scopeNote ? (
            <Text style={s.scope}>{doc.statement.scopeNote}</Text>
          ) : null}
          <Tiles statement={doc.statement} />
          <MonthlyChart statement={doc.statement} />
          {doc.statement.panels.map((panel) => (
            <Panel key={panel.title} panel={panel} />
          ))}
          {doc.statement.ranked?.map((panel) => (
            <Ranked key={panel.title} panel={panel} />
          ))}
          {doc.statement.checks ? <Checks checks={doc.statement.checks} /> : null}
          {/* The statement starts on the next page unless its title, column
              heads and first rows fit here: the repeating column heads
              would otherwise sit alone at the foot of this page. */}
          <View minPresenceAhead={240} />
          <Statement statement={doc.statement} />
          {notes}
          {footer}
        </Page>
      </Document>,
    );

  function Tiles({ statement }: { statement: StatementDocument }) {
    return (
      <View style={s.tiles} wrap={false}>
        {statement.tiles.map((t, i) => {
          const accent = i === statement.accentTile;
          const negative = t.value.startsWith("-");
          return (
            <View key={t.label} style={[s.tile, ...(accent ? [s.tileAccent] : [])]}>
              <Text style={s.monoLabel}>{t.label}</Text>
              <Text
                style={[
                  s.tileValue,
                  {
                    fontSize: t.value.length > 13 ? 11 : t.value.length > 11 ? 12.5 : 14,
                    color: negative
                      ? paper.rose
                      : accent
                        ? paper.accentDeep
                        : paper.ink,
                  },
                ]}
              >
                {t.value}
              </Text>
              <Text
                style={[
                  s.tileChange,
                  { color: t.change ? (tone(t.tone) ?? paper.muted) : paper.muted },
                ]}
              >
                {t.change ?? t.note}
              </Text>
            </View>
          );
        })}
      </View>
    );
  }

  /**
   * A waterfall card (the balance sheet's equity, the cash flow's bridge
   * and profit vs cash): each line moves the running total on from where
   * the last one left it, an optional first bar starts from zero, and the
   * last bar is the total, so the lines visibly add up. Each card stays
   * together on one page.
   */
  function Panel({ panel }: { panel: StatementPanel }) {
    const labelW = 188,
      valueW = 92,
      barW = 612 - MARGIN_X * 2 - labelW - valueW - 16;
    let running = panel.start?.amount ?? 0;
    const steps = panel.lines.map((l) => {
      const start = running;
      running += l.amount;
      return { ...l, start, end: running };
    });
    const points = [
      0,
      panel.total.amount,
      ...(panel.start ? [panel.start.amount] : []),
      ...steps.flatMap((s) => [s.start, s.end]),
    ];
    const low = Math.min(...points),
      high = Math.max(...points),
      span = high - low || 1;
    const x = (v: number) => ((v - low) / span) * barW;
    const bar = (from: number, to: number, fill: string) => {
      const left = x(Math.min(from, to)),
        width = Math.max(1, Math.abs(x(to) - x(from)));
      return (
        <Svg width={barW} height={9}>
          <Line
            x1={x(0)}
            x2={x(0)}
            y1={0}
            y2={9}
            stroke={paper.hairlineStrong}
            strokeWidth={0.5}
          />
          <Rect x={left} y={1} width={width} height={7} rx={1.5} fill={fill} />
        </Svg>
      );
    };
    const row = (
      key: string,
      line: PanelLine,
      graphic: React.ReactNode,
      strong = false,
    ) => (
      <View
        key={key}
        wrap={false}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 4,
          borderTopWidth: strong ? 0.75 : 0,
          borderTopColor: paper.hairlineStrong,
          marginTop: strong ? 3 : 0,
        }}
      >
        <View style={{ width: labelW }}>
          <Text
            style={[
              s.label,
              { fontWeight: strong ? 600 : 400, color: strong ? paper.ink : paper.body },
            ]}
          >
            {line.label}
          </Text>
          {line.hint ? (
            <Text style={{ fontSize: 7, color: paper.muted, lineHeight: 1.35 }}>
              {line.hint}
            </Text>
          ) : null}
        </View>
        <View style={{ width: barW, marginHorizontal: 8 }}>{graphic}</View>
        <Text
          style={[
            s.figure,
            {
              width: valueW,
              textAlign: "right",
              fontWeight: strong ? 500 : 400,
              color: line.value.startsWith("-")
                ? paper.rose
                : strong
                  ? paper.accentDeep
                  : paper.ink,
            },
          ]}
        >
          {line.value}
        </Text>
      </View>
    );
    // A card stays on one page unless it is too long for one; then its
    // title and first lines still travel together.
    const long = steps.length > 14;
    return (
      <View style={{ marginTop: 24 }} wrap={long}>
        <View style={s.sectionHead} minPresenceAhead={long ? 90 : 0}>
          <Text style={s.sectionTitle}>{panel.title}</Text>
        </View>
        <Text style={[s.scope, { marginTop: 0, marginBottom: 8, lineHeight: 1.4 }]}>
          {panel.sentence}
        </Text>
        {panel.start
          ? row("start", panel.start, bar(0, panel.start.amount, paper.hairlineStrong))
          : null}
        {steps.map((step, i) =>
          row(
            `line-${i}`,
            step,
            bar(step.start, step.end, step.amount < 0 ? paper.expense : paper.income),
          ),
        )}
        {row(
          "total",
          panel.total,
          bar(0, panel.total.amount, panel.total.amount < 0 ? paper.rose : paper.accent),
          true,
        )}
        {panel.footer ? (
          <Text style={[s.scope, { marginTop: 8, lineHeight: 1.4 }]}>{panel.footer}</Text>
        ) : null}
      </View>
    );
  }

  /**
   * A ranked list on paper (who paid you, other income): each line with its
   * amount, its share and a bar against the biggest line, then the total.
   * A list stays on one page unless it is too long for one.
   */
  function Ranked({ panel }: { panel: RankedPanel }) {
    const labelW = 200,
      valueW = 86,
      shareW = 44,
      barW = 612 - MARGIN_X * 2 - labelW - valueW - shareW - 16;
    const max = Math.max(...panel.rows.map((r) => Math.abs(r.amount)), 0) || 1;
    // A long list may break across pages; its title still travels with its first rows.
    const long = panel.rows.length > 8;
    return (
      <View style={{ marginTop: 24 }} wrap={long}>
        <View style={s.sectionHead} minPresenceAhead={long ? 90 : 0}>
          <Text style={s.sectionTitle}>{panel.title}</Text>
        </View>
        <Text style={[s.scope, { marginTop: 0, marginBottom: panel.note ? 3 : 8, lineHeight: 1.4 }]}>
          {panel.sentence}
        </Text>
        {panel.note ? (
          <Text style={[s.scope, { marginTop: 0, marginBottom: 8, lineHeight: 1.4, color: paper.muted }]}>
            {panel.note}
          </Text>
        ) : null}
        {panel.rows.map((r, i) => (
          <View
            key={`${r.label}-${i}`}
            wrap={false}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 3.5 }}
          >
            <View style={{ width: labelW }}>
              <Text style={[s.label, { color: paper.body }]}>
                {r.label}
                {r.tag ? <Text style={{ fontSize: 7, color: paper.muted }}>{`  ${r.tag}`}</Text> : null}
              </Text>
              {r.hint ? (
                <Text style={{ fontSize: 7, color: paper.muted, lineHeight: 1.35 }}>{r.hint}</Text>
              ) : null}
            </View>
            <View style={{ width: barW, marginHorizontal: 8 }}>
              <Svg width={barW} height={7}>
                <Rect x={0} y={0} width={barW} height={7} rx={2} fill={paper.row} />
                <Rect
                  x={0}
                  y={0}
                  width={Math.max(1, (Math.abs(r.amount) / max) * barW)}
                  height={7}
                  rx={2}
                  fill={r.amount < 0 ? paper.rose : (r.tone ?? panel.tone) === "expense" ? paper.expense : paper.income}
                />
              </Svg>
            </View>
            <Text
              style={[
                s.figure,
                { width: valueW, textAlign: "right", color: r.value.startsWith("-") ? paper.rose : paper.ink },
              ]}
            >
              {r.value}
            </Text>
            <Text style={[s.figure, { width: shareW, textAlign: "right", fontSize: 7.5, color: paper.muted }]}>
              {r.share}
            </Text>
          </View>
        ))}
        <View
          wrap={false}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            paddingVertical: 4,
            borderTopWidth: 0.75,
            borderTopColor: paper.hairlineStrong,
            marginTop: 3,
          }}
        >
          <Text style={[s.label, { fontWeight: 600, color: paper.ink }]}>{panel.total.label}</Text>
          <Text style={[s.figure, { fontWeight: 500, color: paper.accentDeep, paddingRight: shareW }]}>
            {panel.total.value}
          </Text>
        </View>
      </View>
    );
  }

  /** The trial balance's checks: a short list, or a plain all-clear. */
  function Checks({ checks }: { checks: NonNullable<StatementDocument["checks"]> }) {
    return (
      <View style={{ marginTop: 24 }} wrap={checks.items.length > 8}>
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>{checks.title}</Text>
        </View>
        {checks.items.length === 0 ? (
          <Text style={[s.scope, { marginTop: 0 }]}>{checks.empty}</Text>
        ) : (
          checks.items.map((c, i) => (
            <View
              key={`${c.title}-${i}`}
              wrap={false}
              style={{
                flexDirection: "row",
                gap: 8,
                paddingVertical: 5,
                borderTopWidth: i === 0 ? 0 : 0.5,
                borderTopColor: paper.hairline,
              }}
            >
              <Text
                style={{
                  width: 34,
                  fontFamily: MONO,
                  fontSize: 6.5,
                  letterSpacing: 0.6,
                  color: c.tone === "look" ? paper.copper : paper.muted,
                  paddingTop: 1.5,
                }}
              >
                {c.tone === "look" ? "LOOK" : "NOTE"}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={[s.label, { color: paper.ink, fontWeight: 500 }]}>{c.title}</Text>
                <Text style={{ fontSize: 7.5, color: paper.muted, lineHeight: 1.4 }}>{c.detail}</Text>
              </View>
            </View>
          ))
        )}
      </View>
    );
  }

  function MonthlyChart({ statement }: { statement: StatementDocument }) {
    const months = statement.months;
    // One month is already the tiles; a chart needs at least two to compare.
    if (months.length < 2) return null;
    const width = 612 - MARGIN_X * 2,
      height = 118,
      axis = 34,
      plotW = width - axis,
      plotH = height - 16;
    const max = Math.max(...months.flatMap((m) => [m.income, m.expense]), 0);
    const step = niceStep(max),
      top = Math.max(step, Math.ceil(max / step) * step);
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    const slot = plotW / months.length,
      bar = Math.min(14, slot * 0.3);
    const y = (v: number) => plotH - (v / top) * plotH;
    const every = months.length > 18 ? 3 : months.length > 12 ? 2 : 1;
    const partial = months.filter((m) => m.partial);
    return (
      <View style={{ marginTop: 24 }} wrap={false}>
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>Month by month</Text>
          <View style={s.legend}>
            {(
              [
                ["Income", paper.income],
                ["Expenses", paper.expense],
              ] as const
            ).map(([label, color]) => (
              <View key={label} style={s.legendItem}>
                <View style={[s.swatch, { backgroundColor: color }]} />
                <Text style={s.monoLabel}>{label}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={{ position: "relative", height }}>
          <Svg width={width} height={plotH + 1} style={{ position: "absolute", top: 0, left: 0 }}>
            {ticks.map((t) => (
              <Line
                key={t}
                x1={axis}
                x2={width}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? paper.hairlineStrong : paper.row}
                strokeWidth={t === 0 ? 0.75 : 0.5}
              />
            ))}
            {months.map((m, i) => {
              const x = axis + slot * i + slot / 2;
              const ih = (m.income / top) * plotH,
                eh = (Math.max(m.expense, 0) / top) * plotH;
              return (
                <React.Fragment key={m.month}>
                  <Rect
                    x={x - bar - 1}
                    y={plotH - Math.max(ih, 0.6)}
                    width={bar}
                    height={Math.max(ih, 0.6)}
                    rx={1.5}
                    fill={paper.income}
                  />
                  <Rect
                    x={x + 1}
                    y={plotH - Math.max(eh, 0.6)}
                    width={bar}
                    height={Math.max(eh, 0.6)}
                    rx={1.5}
                    fill={paper.expense}
                  />
                </React.Fragment>
              );
            })}
          </Svg>
          {ticks.map((t) => (
            <Text
              key={t}
              style={[
                s.footerText,
                {
                  position: "absolute",
                  left: 0,
                  width: axis - 6,
                  textAlign: "right",
                  top: y(t) - 4,
                },
              ]}
            >
              {compactDollars(t)}
            </Text>
          ))}
          {months.map((m, i) =>
            i % every === 0 || m.partial ? (
              <Text
                key={m.month}
                style={[
                  s.footerText,
                  {
                    position: "absolute",
                    top: plotH + 5,
                    left: axis + slot * i,
                    width: slot,
                    textAlign: "center",
                  },
                ]}
              >
                {monthFormat.format(new Date(`${m.month}T00:00:00Z`))}
                {m.partial ? "*" : ""}
              </Text>
            ) : null,
          )}
        </View>
        {partial.length ? (
          <Text style={s.chartNote}>
            *{" "}
            {partial
              .map(
                (m) =>
                  `${dayFormat.format(new Date(`${m.partial!.from}T00:00:00Z`))} to ${dayFormat.format(new Date(`${m.partial!.to}T00:00:00Z`))}`,
              )
              .join(" and ")}{" "}
            only, so {partial.length === 1 ? "that month is" : "those months are"} partial.
          </Text>
        ) : null}
      </View>
    );
  }

  function Statement({ statement }: { statement: StatementDocument }) {
    const comparing = statement.columns.length > (statement.shareColumn ? 2 : 1);
    // The share column (when there is one) is second and narrower.
    const share = statement.shareColumn ? 1 : -1;
    const widths = statement.shareColumn
      ? comparing
        ? [86, 62, 86, 82]
        : [104, 70]
      : statement.columns.length === 4
        ? [80, 80, 92, 90]
        : comparing
          ? [96, 96, 90]
          : [110];
    const cell = (i: number) => ({
      width: widths[i],
      textAlign: "right" as const,
      paddingLeft: 6,
    });
    const statementRow = (r: StatementDocument["rows"][number]) => {
      if (r.kind === "heading")
        return (
          <View key={r.key} style={s.sectionRow}>
            <Text style={r.section ? s.sectionLabel : s.groupLabel}>
              {r.label}
            </Text>
          </View>
        );
      const strong = r.kind !== "account";
      return (
        <View
          key={r.key}
          wrap={false}
          style={[
            s.row,
            ...(r.kind === "subtotal" ? [s.subtotal] : []),
            ...(r.kind === "total" ? [s.total] : []),
          ]}
        >
          {statement.dateWidth ? (
            <Text style={[s.label, { width: statement.dateWidth, paddingLeft: 8, color: paper.muted }]}>
              {r.date ?? ""}
            </Text>
          ) : null}
          <Text
            style={[
              s.label,
              {
                flex: 1,
                paddingLeft:
                  r.kind === "total"
                    ? 8
                    : r.kind === "account"
                      ? statement.dateWidth
                        ? 0
                        : r.indent
                          ? 18
                          : 8
                      : 0,
                fontWeight: r.kind === "total" ? 700 : strong ? 600 : 400,
                color: strong ? paper.ink : paper.body,
                fontSize: r.kind === "total" ? 9.5 : 8.75,
              },
            ]}
          >
            {r.label}
          </Text>
          {r.cells.map((value, i) => (
            <Text
              key={i}
              style={[
                s.figure,
                cell(i),
                {
                  fontWeight: strong ? 500 : 400,
                  fontSize:
                    r.kind === "total" && i === 0 ? 9.5 : i === share ? 7.75 : 8.5,
                  // The smaller percent sits on the amounts' baseline.
                  marginTop: i === share ? 0.8 : 0,
                  color:
                    tone(r.tones[i]) ??
                    (i === share
                      ? paper.muted
                      : r.kind === "total"
                        ? paper.accentDeep
                        : paper.ink),
                  paddingRight:
                    r.kind === "total" && i === r.cells.length - 1 ? 8 : 0,
                },
              ]}
            >
              {value}
            </Text>
          ))}
        </View>
      );
    };
    return (
      <View style={{ marginTop: 26 }}>
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>{statement.statementTitle ?? "Statement"}</Text>
        </View>
        <View style={s.tableHead} fixed>
          {statement.dateWidth ? (
            <Text style={[s.th, { width: statement.dateWidth, paddingLeft: 8 }]}>Date</Text>
          ) : null}
          <Text style={[s.th, { flex: 1 }]}>{statement.labelHead ?? "Account"}</Text>
          {statement.columns.map((c, i) => (
            <Text key={c} style={[s.th, cell(i)]}>
              {c}
            </Text>
          ))}
        </View>
        {blocks(statement.rows).map((block) => (
          // A heading never ends a page: it travels with the row after it.
          <View key={block[0].key} wrap={false}>
            {block.map((r) => statementRow(r))}
          </View>
        ))}
      </View>
    );
  }

  // Every other report: the same masthead, facts and footer around one table.
  const ledger = doc.columns[0] === "Date",
    landscape = ledger || doc.columns.length > 4;
  const widths = ledger
    ? ["12%", "30%", "22%", "12%", "12%", "12%"]
    : [
        `${doc.columns.length > 4 ? 30 : 44}%`,
        ...doc.columns
          .slice(1)
          .map(
            () =>
              `${(doc.columns.length > 4 ? 70 : 56) / (doc.columns.length - 1)}%`,
          ),
      ];
  const grouped = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const period = meta(doc, "Period");
  return renderToBuffer(
    <Document
      title={`${doc.company} - ${doc.title}`}
      author={doc.company}
      subject={`Retained accounting report ${doc.snapshotId}`}
    >
      <Page
        size="LETTER"
        orientation={landscape ? "landscape" : "portrait"}
        style={s.page}
      >
        {masthead}
        {heading}
        <Text style={s.facts}>
          {[doc.company, period, meta(doc, "Basis"), meta(doc, "Currency")]
            .filter(Boolean)
            .join("  ·  ")}
        </Text>
        <View style={s.metaTile}>
          {doc.metadata
            .filter(([label]) => !["Period", "Basis", "Currency"].includes(label))
            .map(([label, value]) => (
              <View key={label} style={s.metaItem}>
                <Text style={s.monoLabel}>{label}</Text>
                <Text style={s.metaValue}>{value}</Text>
              </View>
            ))}
        </View>
        <View style={s.tableHead} fixed>
          {doc.columns.map((label, i) => (
            <Text
              key={label}
              style={[
                s.th,
                {
                  width: widths[i],
                  paddingHorizontal: 6,
                  textAlign: doc.numeric[i] ? "right" : "left",
                },
              ]}
            >
              {label}
            </Text>
          ))}
        </View>
        {blocks(doc.rows).map((block) => (
          <View key={block[0].key} wrap={false}>
            {block.map((row) =>
              row.kind === "heading" ? (
                <View key={row.key} style={s.sectionRow}>
                  <Text style={s.sectionLabel}>{row.cells[0]}</Text>
                </View>
              ) : (
                <View
                  key={row.key}
                  style={[
                    s.row,
                    ...(row.kind === "subtotal" ? [s.subtotal] : []),
                    ...(row.kind === "total" ? [s.total] : []),
                  ]}
                >
                  {row.cells.map((value, i) => (
                    <Text
                      key={i}
                      style={[
                        doc.numeric[i] ? s.figure : s.label,
                        {
                          width: widths[i],
                          paddingHorizontal: 6,
                          textAlign: doc.numeric[i] ? "right" : "left",
                          fontSize: ledger ? 7.25 : doc.numeric[i] ? 8.5 : 8.75,
                          fontWeight:
                            row.kind === "account"
                              ? 400
                              : doc.numeric[i]
                                ? 500
                                : 600,
                          color:
                            row.kind === "total"
                              ? paper.accentDeep
                              : doc.numeric[i]
                                ? paper.ink
                                : paper.body,
                        },
                      ]}
                    >
                      {doc.numeric[i] ? grouped(value) : value}
                    </Text>
                  ))}
                </View>
              ),
            )}
          </View>
        ))}
        {!doc.rows.length && (
          <Text style={{ marginVertical: 20, color: paper.muted }}>
            No activity in the selected period.
          </Text>
        )}
        {notes}
        {footer}
      </Page>
    </Document>,
  );
}
