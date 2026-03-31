import * as XLSX from "xlsx";
import type { ExportedOrderV1 } from "./orders-import.types";
import { parseShopifyAdminOrdersRows } from "./shopify-orders-csv.server";

export function parseShopifyAdminOrdersXlsx(buffer: ArrayBuffer): ExportedOrderV1[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not parse XLSX: ${msg}`);
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("XLSX file has no sheets.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) {
    throw new Error("Could not read first XLSX sheet.");
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const rows = rawRows
    .map((row) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        const key = String(k || "").trim();
        if (!key) continue;
        out[key] = v == null ? "" : String(v).trim();
      }
      return out;
    })
    .filter((row) => Object.values(row).some((v) => v !== ""));

  if (!rows.length) {
    throw new Error("XLSX file has no data rows.");
  }

  return parseShopifyAdminOrdersRows(rows);
}
