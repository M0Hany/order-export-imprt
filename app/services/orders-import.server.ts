import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ExportedLineItemV1, ExportedOrderV1 } from "./orders-import.types";
import { parseShopifyAdminOrdersCsv } from "./shopify-orders-csv.server";
import { parseShopifyAdminOrdersXlsx } from "./shopify-orders-xlsx.server";
import db from "../db.server";

export type ImportOrderResult = {
  sourceName?: string | null;
  sourceId?: string;
  status: "imported" | "skipped" | "error";
  newOrderId?: string;
  newOrderName?: string;
  draftOrderId?: string;
  message?: string;
};

export type ImportOrdersResult = {
  ok: boolean;
  results: ImportOrderResult[];
  error?: string;
};

function toMailingInput(
  addr: NonNullable<ExportedOrderV1["shippingAddress"]> | null | undefined,
) {
  if (!addr) return undefined;
  const countryCode = addr.countryCode?.trim();
  const out: Record<string, string> = {};
  if (addr.address1) out.address1 = addr.address1;
  if (addr.address2) out.address2 = addr.address2;
  if (addr.city) out.city = addr.city;
  if (addr.company) out.company = addr.company;
  if (countryCode) out.countryCode = countryCode;
  if (addr.firstName) out.firstName = addr.firstName;
  if (addr.lastName) out.lastName = addr.lastName;
  if (addr.phone) out.phone = addr.phone;
  if (addr.provinceCode) out.provinceCode = addr.provinceCode;
  if (addr.zip) out.zip = addr.zip;
  return Object.keys(out).length ? out : undefined;
}

const DRAFT_DISCOUNT_FIXED = "FIXED_AMOUNT";

/** Shopify DraftOrderAppliedDiscountInput: fixed amount using presentment currency. */
function draftAppliedDiscountFixed(
  amountStr: string,
  currencyCode: string,
  title: string,
  description?: string,
): Record<string, unknown> | undefined {
  const n = Number(amountStr);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const out: Record<string, unknown> = {
    valueType: DRAFT_DISCOUNT_FIXED,
    value: n,
    amountWithCurrency: { amount: amountStr, currencyCode },
    title,
  };
  if (description) out.description = description;
  return out;
}

function draftLineItemInput(
  li: ExportedLineItemV1,
  orderCurrency: string,
  orderHasDiscountCodes: boolean,
): Record<string, unknown> {
  const qty = li.quantity;
  const cur = li.originalUnitPrice.currencyCode || orderCurrency;
  const unitFinalAmt = li.originalUnitPrice.amount;
  const finalN = Number(unitFinalAmt);

  const lineDisc = li.lineDiscountTotal;
  const lineDiscN = lineDisc?.amount != null ? Number(lineDisc.amount) : 0;

  const compare = li.compareAtUnitPrice;
  const compareN = compare?.amount != null ? Number(compare.amount) : NaN;

  let lineDiscountTotalStr: string | undefined;

  if (lineDiscN > 0.0001 && lineDisc?.amount) {
    lineDiscountTotalStr = lineDisc.amount;
  } else if (
    !orderHasDiscountCodes &&
    Number.isFinite(compareN) &&
    compareN > finalN + 0.0001 &&
    compare?.amount
  ) {
    lineDiscountTotalStr = ((compareN - finalN) * qty).toFixed(2);
  }

  const lineDiscInput =
    lineDiscountTotalStr &&
    draftAppliedDiscountFixed(
      lineDiscountTotalStr,
      cur,
      "Line discount",
      "Imported from order export",
    );

  let unitOriginalAmount = unitFinalAmt;
  if (lineDiscInput) {
    if (lineDiscN > 0.0001 && lineDisc?.amount) {
      unitOriginalAmount = (finalN + lineDiscN / qty).toFixed(2);
    } else if (compare?.amount) {
      unitOriginalAmount = compare.amount;
    }
  }

  const row: Record<string, unknown> = {
    quantity: qty,
    title: li.title,
    taxable: li.taxable ?? true,
    requiresShipping: li.requiresShipping ?? true,
    originalUnitPriceWithCurrency: {
      amount: unitOriginalAmount,
      currencyCode: cur,
    },
  };

  if (li.sku?.trim()) row.sku = li.sku.trim();
  if (li.customAttributes?.length) {
    row.customAttributes = li.customAttributes.map((a) => ({
      key: a.key,
      value: a.value,
    }));
  }

  if (lineDiscInput) row.appliedDiscount = lineDiscInput;
  else {
    const unit =
      li.discountedUnitPrice?.amount && li.discountedUnitPrice.currencyCode
        ? li.discountedUnitPrice
        : li.originalUnitPrice;
    row.originalUnitPriceWithCurrency = {
      amount: unit.amount,
      currencyCode: unit.currencyCode,
    };
  }

  return row;
}

function parseAdminOrderCsvOnly(raw: string): ExportedOrderV1[] {
  const trimmed = raw.trim().replace(/^\uFEFF/, "");
  if (trimmed.startsWith("{")) {
    throw new Error(
      "Upload a plain order CSV from Shopify Admin (Orders → Export), not JSON.",
    );
  }
  return parseShopifyAdminOrdersCsv(trimmed);
}

async function draftOrderCreate(
  admin: AdminApiContext,
  order: ExportedOrderV1,
) {
  const email =
    order.email?.trim() ||
    order.customer?.email?.trim() ||
    undefined;
  const phone =
    order.phone?.trim() ||
    order.customer?.phone?.trim() ||
    undefined;

  const orderCurrency = order.currencyCode || "USD";
  const hasDiscountCodes = order.discountCodes.length > 0;
  const lineItems = order.lineItems.map((li) =>
    draftLineItemInput(li, orderCurrency, hasDiscountCodes),
  );

  const tags = order.tags.filter(Boolean);

  const input: Record<string, unknown> = {
    lineItems,
    email,
    phone,
    note: order.note?.trim() || undefined,
    tags,
    shippingAddress: toMailingInput(order.shippingAddress),
    billingAddress: toMailingInput(order.billingAddress ?? order.shippingAddress),
    presentmentCurrencyCode: order.currencyCode || undefined,
    poNumber: order.poNumber || undefined,
    sourceName: "orders-export-import",
    taxExempt: false,
    acceptAutomaticDiscounts: true,
  };

  if (order.discountCodes.length) {
    input.discountCodes = order.discountCodes;
  }

  if (
    !hasDiscountCodes &&
    order.orderDiscountAmount?.amount &&
    order.orderDiscountAmount.currencyCode
  ) {
    const od = draftAppliedDiscountFixed(
      order.orderDiscountAmount.amount,
      order.orderDiscountAmount.currencyCode,
      "Order discount",
      "Imported from order export (Discount Amount)",
    );
    if (od) input.appliedDiscount = od;
  }

  if (
    order.shippingPrice &&
    Number(order.shippingPrice.amount) > 0 &&
    order.shippingPrice.currencyCode
  ) {
    input.shippingLine = {
      title: (order.shippingLineTitle || "Shipping").trim() || "Shipping",
      priceWithCurrency: {
        amount: order.shippingPrice.amount,
        currencyCode: order.shippingPrice.currencyCode,
      },
    };
  }

  const res = await admin.graphql(
    `#graphql
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { variables: { input } },
  );
  const json = (await res.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string } | null;
        userErrors: { field?: string[] | null; message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    return {
      error: json.errors.map((e) => e.message).join("; "),
      draftOrderId: undefined as string | undefined,
    };
  }

  const payload = json.data?.draftOrderCreate;
  const errMsg = payload?.userErrors?.map((e) => e.message).join("; ");
  if (errMsg) {
    return { error: errMsg, draftOrderId: undefined as string | undefined };
  }
  const id = payload?.draftOrder?.id;
  if (!id) return { error: "No draft order id returned", draftOrderId: undefined };
  return { draftOrderId: id };
}

async function draftOrderComplete(admin: AdminApiContext, draftOrderId: string) {
  const res = await admin.graphql(
    `#graphql
      mutation DraftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder {
            id
            order {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { variables: { id: draftOrderId } },
  );
  const json = (await res.json()) as {
    data?: {
      draftOrderComplete?: {
        draftOrder?: {
          id: string;
          order?: { id: string; name: string } | null;
        } | null;
        userErrors: { message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    return {
      error: json.errors.map((e) => e.message).join("; "),
      orderId: undefined as string | undefined,
      orderName: undefined as string | undefined,
    };
  }
  const p = json.data?.draftOrderComplete;
  const uerr = p?.userErrors?.map((e) => e.message).join("; ");
  if (uerr) {
    return { error: uerr, orderId: undefined, orderName: undefined };
  }
  const ord = p?.draftOrder?.order;
  if (!ord?.id) {
    return { error: "Complete did not return an order", orderId: undefined, orderName: undefined };
  }
  return { orderId: ord.id, orderName: ord.name, error: undefined };
}

/**
 * Shopify often writes payment context (e.g. COD) into the order note when a draft
 * is completed with no merchant note. Clear it when the CSV had no Notes column text.
 */
async function clearAutoOrderNoteIfNoCsvNote(
  admin: AdminApiContext,
  orderId: string,
): Promise<string | null> {
  const res = await admin.graphql(
    `#graphql
      mutation OrderUpdateClearNote($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors {
            message
          }
        }
      }
    `,
    { variables: { input: { id: orderId, note: "" } } },
  );
  const json = (await res.json()) as {
    data?: { orderUpdate?: { userErrors: { message: string }[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    return json.errors.map((e) => e.message).join("; ");
  }
  const errs = json.data?.orderUpdate?.userErrors;
  if (errs?.length) {
    return errs.map((e) => e.message).join("; ");
  }
  return null;
}

async function importOneOrder(
  admin: AdminApiContext,
  shop: string,
  order: ExportedOrderV1,
): Promise<ImportOrderResult> {
  const base: ImportOrderResult = {
    sourceName: order.sourceName,
    sourceId: order.sourceId,
    status: "error",
  };

  if (!order.lineItems.length) {
    return {
      ...base,
      status: "skipped",
      message: "No line items (nothing to import).",
    };
  }

  const hadCsvNote = Boolean(order.note?.trim());

  const created = await draftOrderCreate(admin, order);
  if (created.error || !created.draftOrderId) {
    return {
      ...base,
      message: created.error ?? "Draft create failed",
    };
  }

  const completed = await draftOrderComplete(admin, created.draftOrderId);
  if (completed.error || !completed.orderId) {
    return {
      ...base,
      draftOrderId: created.draftOrderId,
      message: completed.error ?? "Draft complete failed",
    };
  }

  let extraMessage: string | undefined;
  if (!hadCsvNote && completed.orderId) {
    const clearErr = await clearAutoOrderNoteIfNoCsvNote(admin, completed.orderId);
    if (clearErr) {
      extraMessage = `Note could not be cleared: ${clearErr}`;
    }
  }

  await db.importedOrder.upsert({
    where: {
      shop_orderGid: {
        shop,
        orderGid: completed.orderId,
      },
    },
    update: {
      orderName: completed.orderName,
      sourceName: order.sourceName ?? undefined,
      sourceId: order.sourceId ?? undefined,
    },
    create: {
      shop,
      orderGid: completed.orderId,
      orderName: completed.orderName,
      sourceName: order.sourceName ?? undefined,
      sourceId: order.sourceId ?? undefined,
    },
  });

  return {
    ...base,
    status: "imported",
    newOrderId: completed.orderId,
    newOrderName: completed.orderName,
    draftOrderId: created.draftOrderId,
    message: extraMessage,
  };
}

export async function importOrdersFromCsv(
  admin: AdminApiContext,
  shop: string,
  raw: string,
): Promise<ImportOrdersResult> {
  let orders: ExportedOrderV1[];
  try {
    orders = parseAdminOrderCsvOnly(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, results: [], error: message };
  }

  return importParsedOrders(admin, shop, orders);
}

export async function importOrdersFromXlsx(
  admin: AdminApiContext,
  shop: string,
  fileBuffer: ArrayBuffer,
): Promise<ImportOrdersResult> {
  let orders: ExportedOrderV1[];
  try {
    orders = parseShopifyAdminOrdersXlsx(fileBuffer);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, results: [], error: message };
  }

  return importParsedOrders(admin, shop, orders);
}

async function importParsedOrders(
  admin: AdminApiContext,
  shop: string,
  orders: ExportedOrderV1[],
): Promise<ImportOrdersResult> {
  const results: ImportOrderResult[] = [];
  for (const order of orders) {
    const r = await importOneOrder(admin, shop, order);
    results.push(r);
    await new Promise((r2) => setTimeout(r2, 150));
  }

  const errors = results.filter((r) => r.status === "error");
  return {
    ok: errors.length === 0,
    results,
    error:
      errors.length > 0
        ? `${errors.length} order(s) failed to import.`
        : undefined,
  };
}
