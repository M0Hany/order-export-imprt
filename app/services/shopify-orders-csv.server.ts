import { parse } from "csv-parse/sync";
import type {
  ExportedAddressV1,
  ExportedLineItemV1,
  ExportedOrderV1,
} from "./orders-import.types";

const COUNTRY_TO_CODE: Record<string, string> = {
  "united states": "US",
  usa: "US",
  us: "US",
  canada: "CA",
  australia: "AU",
  "united kingdom": "GB",
  uk: "GB",
  germany: "DE",
  france: "FR",
  spain: "ES",
  italy: "IT",
  mexico: "MX",
  japan: "JP",
  china: "CN",
  india: "IN",
  brazil: "BR",
};

function normalizeCountry(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const t = raw.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return COUNTRY_TO_CODE[t.toLowerCase()];
}

function cell(row: Record<string, string>, key: string) {
  const v = row[key];
  return v == null ? "" : String(v).trim();
}

function parseBool(raw: string, fallback: boolean) {
  const t = raw.trim().toLowerCase();
  if (t === "true" || t === "yes") return true;
  if (t === "false" || t === "no") return false;
  return fallback;
}

function parseDecimal(raw: string): string | null {
  const t = raw.replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

function splitPersonName(full: string): {
  firstName?: string;
  lastName?: string;
} {
  const p = full.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return {};
  if (p.length === 1) return { firstName: p[0] };
  return { firstName: p[0], lastName: p.slice(1).join(" ") };
}

function addressFromRow(
  row: Record<string, string>,
  prefix: "Billing" | "Shipping",
): ExportedAddressV1 | null {
  const name = cell(row, `${prefix} Name`);
  const { firstName, lastName } = splitPersonName(name);
  const address1 =
    cell(row, `${prefix} Address1`) || cell(row, `${prefix} Street`);
  const address2 = cell(row, `${prefix} Address2`);
  const city = cell(row, `${prefix} City`);
  const zip = cell(row, `${prefix} Zip`);
  const provinceCode =
    cell(row, `${prefix} Province`) ||
    cell(row, `${prefix} Province Name`);
  const countryRaw =
    cell(row, `${prefix} Country`) || cell(row, `${prefix} Country Code`);
  const company = cell(row, `${prefix} Company`);
  const phone = cell(row, `${prefix} Phone`);

  const countryCode = normalizeCountry(countryRaw);

  if (
    !address1 &&
    !city &&
    !zip &&
    !firstName &&
    !phone &&
    !company
  ) {
    return null;
  }

  return {
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    address1: address1 || undefined,
    address2: address2 || undefined,
    city: city || undefined,
    zip: zip || undefined,
    provinceCode: provinceCode || undefined,
    countryCode,
    company: company || undefined,
    phone: phone || undefined,
  };
}

function parseTags(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function lineItemFromRow(
  row: Record<string, string>,
  currencyCode: string,
): ExportedLineItemV1 | null {
  const title = cell(row, "Lineitem name");
  const qtyRaw = cell(row, "Lineitem quantity");
  const qty = Math.max(1, parseInt(qtyRaw, 10) || 1);
  const price = parseDecimal(cell(row, "Lineitem price"));
  if (!title || !price) return null;

  return {
    title,
    quantity: qty,
    sku: cell(row, "Lineitem sku") || undefined,
    vendor: cell(row, "Vendor") || undefined,
    originalUnitPrice: { amount: price, currencyCode },
    requiresShipping: parseBool(cell(row, "Lineitem requires shipping"), true),
    taxable: parseBool(cell(row, "Lineitem taxable"), true),
  };
}

function orderFromGroup(rows: Record<string, string>[]): ExportedOrderV1 {
  const base = rows[0];
  const currencyCode = cell(base, "Currency") || "USD";
  const id = cell(base, "Id");
  const name = cell(base, "Name");

  const lineItems: ExportedLineItemV1[] = [];
  for (const row of rows) {
    const li = lineItemFromRow(row, currencyCode);
    if (li) lineItems.push(li);
  }

  const noteParts = [
    cell(base, "Notes"),
    cell(base, "Note Attributes"),
    cell(base, "Payment Method")
      ? `Payment method: ${cell(base, "Payment Method")}`
      : "",
    cell(base, "Payment Reference")
      ? `Payment reference: ${cell(base, "Payment Reference")}`
      : "",
    cell(base, "Cancelled at") ? `Cancelled at: ${cell(base, "Cancelled at")}` : "",
  ].filter(Boolean);

  const discount = cell(base, "Discount Code");
  const discountCodes = discount
    ? discount.split(/,\s*/).map((s) => s.trim()).filter(Boolean)
    : [];

  const shippingRaw = parseDecimal(cell(base, "Shipping"));
  const shippingPrice =
    shippingRaw && Number(shippingRaw) > 0
      ? { amount: shippingRaw, currencyCode }
      : undefined;

  return {
    sourceId: id || undefined,
    sourceName: name || undefined,
    legacyResourceId: id || undefined,
    createdAt: cell(base, "Created at") || undefined,
    currencyCode,
    displayFinancialStatus: cell(base, "Financial Status") || undefined,
    displayFulfillmentStatus: cell(base, "Fulfillment Status") || undefined,
    email: cell(base, "Email") || undefined,
    phone: cell(base, "Phone") || undefined,
    note: noteParts.length ? noteParts.join("\n\n") : undefined,
    tags: parseTags(cell(base, "Tags")),
    poNumber: cell(base, "Receipt Number") || undefined,
    customer: cell(base, "Email")
      ? {
          email: cell(base, "Email"),
          phone: cell(base, "Phone") || undefined,
          ...splitPersonName(cell(base, "Billing Name")),
        }
      : null,
    shippingAddress: addressFromRow(base, "Shipping"),
    billingAddress: addressFromRow(base, "Billing"),
    lineItems,
    discountCodes,
    shippingLineTitle: cell(base, "Shipping Method") || "Shipping",
    shippingPrice,
  };
}

export function parseShopifyAdminOrdersCsv(raw: string): ExportedOrderV1[] {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) {
    throw new Error("CSV file is empty.");
  }

  let records: Record<string, string>[];
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    }) as Record<string, string>[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not parse CSV: ${msg}`);
  }

  if (!records.length) {
    throw new Error("CSV has no data rows.");
  }

  const headers = Object.keys(records[0] || {});
  const hasLineitem = headers.some((h) =>
    h.toLowerCase().includes("lineitem"),
  );
  if (!hasLineitem) {
    throw new Error(
      "This file does not look like a Shopify order export (missing Lineitem columns). Export orders from Shopify Admin: Orders → Export.",
    );
  }

  const groups = new Map<string, Record<string, string>[]>();
  for (const row of records) {
    const key = cell(row, "Id") || cell(row, "Name");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  if (groups.size === 0) {
    throw new Error("No orders found (missing Id and Name on rows).");
  }

  return [...groups.values()].map(orderFromGroup);
}
