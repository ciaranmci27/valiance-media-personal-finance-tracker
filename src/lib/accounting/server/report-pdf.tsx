import React from "react";
import type { ReportDocument } from "../report-document";

const colors = {
  ink: "#18262b",
  muted: "#647277",
  teal: "#3a5959",
  line: "#dce4e5",
  wash: "#f3f6f6",
};
// No network fonts or remote assets are fetched when exporting private books.
export async function reportPdf(doc: ReportDocument): Promise<Buffer> {
  const { Document, Page, Text, View, StyleSheet, renderToBuffer } =
    await import("@react-pdf/renderer");
  const styles = StyleSheet.create({
    page: {
      fontFamily: "Helvetica",
      fontSize: 9,
      color: colors.ink,
      paddingTop: 40,
      paddingBottom: 58,
      paddingHorizontal: 40,
    },
    brand: {
      fontSize: 9,
      color: colors.teal,
      letterSpacing: 1.3,
      marginBottom: 12,
    },
    title: { fontSize: 24, fontFamily: "Helvetica-Bold", marginBottom: 8 },
    company: { fontSize: 11, marginBottom: 15 },
    meta: {
      flexDirection: "row",
      flexWrap: "wrap",
      padding: 12,
      backgroundColor: colors.wash,
      marginBottom: 16,
    },
    metaItem: {
      width: "50%",
      marginBottom: 5,
      paddingRight: 12,
      fontSize: 8,
      color: colors.muted,
      lineHeight: 1.35,
    },
    row: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderBottomColor: colors.line,
      minHeight: 23,
      alignItems: "center",
    },
    header: {
      flexDirection: "row",
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.teal,
      color: colors.muted,
      fontSize: 8,
      fontFamily: "Helvetica-Bold",
      backgroundColor: "#ffffff",
    },
    cell: { paddingHorizontal: 8, paddingVertical: 5, lineHeight: 1.4 },
    heading: {
      padding: 9,
      backgroundColor: colors.wash,
      fontFamily: "Helvetica-Bold",
      fontSize: 9,
      marginTop: 10,
    },
    note: {
      fontSize: 7.5,
      color: colors.muted,
      lineHeight: 1.45,
      marginBottom: 5,
    },
    footer: {
      position: "absolute",
      bottom: 24,
      left: 40,
      right: 40,
      flexDirection: "row",
      justifyContent: "space-between",
      borderTopWidth: 0.5,
      borderTopColor: colors.line,
      paddingTop: 8,
      fontSize: 7,
      color: colors.muted,
    },
  });

  if (doc.rows.length > 10000)
    throw new Error(
      "PDF export supports up to 10,000 rows. Choose a shorter period or export the complete CSV.",
    );
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
  const numeric = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const header = (
    <View style={styles.header} fixed>
      {doc.columns.map((label, i) => (
        <Text
          key={label}
          style={{
            width: widths[i],
            paddingHorizontal: 8,
            textAlign: doc.numeric[i] ? "right" : "left",
          }}
        >
          {label}
        </Text>
      ))}
    </View>
  );
  return renderToBuffer(
    <Document
      title={`${doc.company} - ${doc.title}`}
      author={doc.company}
      subject={`Retained accounting report ${doc.snapshotId}`}
    >
      <Page
        size="A4"
        orientation={landscape ? "landscape" : "portrait"}
        style={styles.page}
      >
        <Text style={styles.brand}>VALIANCE MEDIA / ACCOUNTING</Text>
        <Text style={styles.title}>{doc.title}</Text>
        <Text style={styles.company}>{doc.company}</Text>
        <View style={styles.meta}>
          {doc.metadata.map(([label, value]) => (
            <Text key={label} style={styles.metaItem}>
              {label}: {value}
            </Text>
          ))}
        </View>
        {header}
        {doc.rows.map((row) =>
          row.kind === "heading" ? (
            <View key={row.key} wrap={false} minPresenceAhead={54} style={styles.heading}>
              <Text>{row.cells[0]}</Text>
            </View>
          ) : (
            <View
              key={row.key}
              wrap={false}
              style={[
                styles.row,
                ...(row.kind === "total"
                  ? [
                      {
                        backgroundColor: "#eaf0ef",
                        fontFamily: "Helvetica-Bold",
                      },
                    ]
                  : row.kind === "subtotal"
                    ? [{ fontFamily: "Helvetica-Bold" }]
                    : []),
              ]}
            >
              {row.cells.map((cell, i) => (
                <Text
                  key={i}
                  style={[
                    styles.cell,
                    {
                      width: widths[i],
                      textAlign: doc.numeric[i] ? "right" : "left",
                      fontSize: ledger ? 7.5 : 9,
                    },
                  ]}
                >
                  {doc.numeric[i] ? numeric(cell) : cell}
                </Text>
              ))}
            </View>
          ),
        )}
        {!doc.rows.length && (
          <Text style={{ marginVertical: 20, color: colors.muted }}>
            No activity in the selected period.
          </Text>
        )}
        <View style={{ marginTop: 16 }}>
          {doc.notes.map((note) => (
            <Text key={note} style={styles.note}>
              {note}
            </Text>
          ))}
          <Text style={styles.note}>Snapshot: {doc.snapshotId}</Text>
        </View>
        <View style={styles.footer} fixed>
          <Text>
            {doc.title} / {doc.company}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>,
  );
}
