import { parse } from "csv-parse/sync";
import type {
  ExportedAddressV1,
  ExportedLineItemV1,
  ExportedOrderV1,
} from "./orders-import.types";

export type ShopifyOrderRow = Record<string, string>;

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

function cell(row: ShopifyOrderRow, key: string) {
  const v = row[key];
  return v == null ? "" : String(v).trim();
}

/** Shopify exports use "Customer Id"; some sheets vary spacing/casing. */
function customerIdFromRow(row: ShopifyOrderRow): string {
  const keys = Object.keys(row);
  const direct = cell(row, "Customer Id") || cell(row, "Customer ID");
  if (direct) return direct;
  const match = keys.find(
    (k) => k.trim().toLowerCase().replace(/\s+/g, " ") === "customer id",
  );
  return match ? cell(row, match) : "";
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

function sanitizePhone(
  raw: string | null | undefined,
  countryCode?: string | null,
): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;

  // If Excel exported phone as a number, it may become scientific notation
  // like "2.01E+11" which Shopify rejects.
  if (/[eE][+-]?\d+/.test(t)) return undefined;

  const cc = countryCode?.trim()?.toUpperCase();
  const digits = t.replace(/[^\d]/g, "");
  if (!digits) return undefined;

  // Egypt heuristic: local often exported without the leading 0.
  if (cc === "EG") {
    if (digits.startsWith("0")) return `+20${digits.slice(1)}`;
    if (digits.length === 10 && digits.startsWith("1")) return `+20${digits}`;
  }

  if (t.startsWith("+")) return `+${digits}`;
  if (digits.length < 7 || digits.length > 15) return undefined;
  return digits;
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
  row: ShopifyOrderRow,
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
  const phoneRaw = cell(row, `${prefix} Phone`);

  const countryCode = normalizeCountry(countryRaw);
  const phone = sanitizePhone(phoneRaw, countryCode);

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
  row: ShopifyOrderRow,
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

function orderFromGroup(rows: ShopifyOrderRow[]): ExportedOrderV1 {
  const base = rows[0];
  const currencyCode = cell(base, "Currency") || "USD";
  const id = cell(base, "Id");
  const name = cell(base, "Name");

  const lineItems: ExportedLineItemV1[] = [];
  for (const row of rows) {
    const li = lineItemFromRow(row, currencyCode);
    if (li) lineItems.push(li);
  }

  let notesOnly = cell(base, "Notes");
  const paymentMethod = cell(base, "Payment Method");
  if (notesOnly && paymentMethod) {
    const n = notesOnly.trim();
    const pm = paymentMethod.trim();
    if (
      n === pm ||
      n.toLowerCase() === `payment method: ${pm}`.toLowerCase()
    ) {
      // Some CSV exports put payment context into the Notes column; don't keep it.
      notesOnly = "";
    }
  }

  const shippingAddress = addressFromRow(base, "Shipping");
  const billingAddress = addressFromRow(base, "Billing");
  const inferredCountry =
    billingAddress?.countryCode || shippingAddress?.countryCode;
  const phoneFromCsv = cell(base, "Phone");
  const phone =
    sanitizePhone(phoneFromCsv, inferredCountry) ||
    billingAddress?.phone ||
    shippingAddress?.phone;

  const discount = cell(base, "Discount Code");
  const discountCodes = discount
    ? discount.split(/,\s*/).map((s) => s.trim()).filter(Boolean)
    : [];

  const shippingRaw = parseDecimal(cell(base, "Shipping"));
  const shippingPrice =
    shippingRaw && Number(shippingRaw) > 0
      ? { amount: shippingRaw, currencyCode }
      : undefined;

  const customerIdRaw = customerIdFromRow(base);

  return {
    sourceId: id || undefined,
    sourceName: name || undefined,
    legacyResourceId: id || undefined,
    createdAt: cell(base, "Created at") || undefined,
    currencyCode,
    displayFinancialStatus: cell(base, "Financial Status") || undefined,
    displayFulfillmentStatus: cell(base, "Fulfillment Status") || undefined,
    customerLegacyResourceId: customerIdRaw || undefined,
    email: cell(base, "Email") || undefined,
    phone: phone || undefined,
    note: notesOnly ? notesOnly : undefined,
    tags: parseTags(cell(base, "Tags")),
    poNumber: cell(base, "Receipt Number") || undefined,
    customer: cell(base, "Email")
      ? {
          email: cell(base, "Email"),
          phone,
          ...splitPersonName(cell(base, "Billing Name")),
        }
      : null,
    shippingAddress,
    billingAddress,
    lineItems,
    discountCodes,
    shippingLineTitle: cell(base, "Shipping Method") || "Shipping",
    shippingPrice,
  };
}

export function parseShopifyAdminOrdersRows(records: ShopifyOrderRow[]): ExportedOrderV1[] {
  if (!records.length) {
    throw new Error("File has no data rows.");
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

  const groups = new Map<string, ShopifyOrderRow[]>();
  for (const row of records) {
    // Spreadsheet tools often convert Id to scientific notation (e.g. 6.94E+12),
    // which is not unique and can merge different orders. Name is usually stable.
    const key = cell(row, "Name") || cell(row, "Id");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  if (groups.size === 0) {
    throw new Error("No orders found (missing Id and Name on rows).");
  }

  return [...groups.values()].map(orderFromGroup);
}

export function parseShopifyAdminOrdersCsv(raw: string): ExportedOrderV1[] {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) {
    throw new Error("CSV file is empty.");
  }

  let records: ShopifyOrderRow[];
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    }) as ShopifyOrderRow[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not parse CSV: ${msg}`);
  }

  return parseShopifyAdminOrdersRows(records);
}
