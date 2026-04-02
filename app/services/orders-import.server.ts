import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ExportedOrderV1 } from "./orders-import.types";
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

/** Emitted after each order is processed (1-based index). */
export type ImportProgressPayload = {
  index: number;
  total: number;
  result: ImportOrderResult;
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

function parseAdminOrderCsvOnly(raw: string): ExportedOrderV1[] {
  const trimmed = raw.trim().replace(/^\uFEFF/, "");
  if (trimmed.startsWith("{")) {
    throw new Error(
      "Upload a plain order CSV from Shopify Admin (Orders → Export), not JSON.",
    );
  }
  return parseShopifyAdminOrdersCsv(trimmed);
}

function toCustomerGid(raw: string | null | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  if (/^gid:\/\/shopify\/Customer\//i.test(t)) return t;
  const digits = t.replace(/\D/g, "");
  if (!digits) return undefined;
  return `gid://shopify/Customer/${digits}`;
}

async function findCustomerGidByEmail(
  admin: AdminApiContext,
  email: string,
): Promise<string | undefined> {
  const res = await admin.graphql(
    `#graphql
      query CustomerLookupByEmail($q: String!) {
        customers(first: 1, query: $q) {
          edges {
            node {
              id
            }
          }
        }
      }
    `,
    { variables: { q: `email:${email.trim()}` } },
  );
  const json = (await res.json()) as {
    data?: {
      customers?: { edges?: { node?: { id: string } }[] };
    };
    errors?: { message: string }[];
  };
  if (json.errors?.length) return undefined;
  return json.data?.customers?.edges?.[0]?.node?.id;
}

/**
 * Prefer Customer Id from the export (same store). Otherwise resolve by email on this
 * store (no email is placed on the draft — avoids order confirmation on complete).
 */
async function resolveCustomerGidForDraft(
  admin: AdminApiContext,
  order: ExportedOrderV1,
): Promise<string | undefined> {
  const fromExport = toCustomerGid(order.customerLegacyResourceId);
  if (fromExport) return fromExport;

  const email =
    order.email?.trim() ||
    order.customer?.email?.trim() ||
    undefined;
  if (!email) return undefined;

  return findCustomerGidByEmail(admin, email);
}

function shouldRetryDraftWithoutCustomer(userErrorMessage: string): boolean {
  const m = userErrorMessage.toLowerCase();
  if (m.includes("purchasing")) return true;
  if (!m.includes("customer")) return false;
  return (
    m.includes("invalid") ||
    m.includes("not found") ||
    m.includes("could not") ||
    m.includes("couldn't") ||
    m.includes("does not exist") ||
    m.includes("doesn't exist") ||
    m.includes("unable to find")
  );
}

function buildDraftOrderInput(order: ExportedOrderV1): Record<string, unknown> {
  const lineItems = order.lineItems.map((li) => {
    const unit =
      li.discountedUnitPrice?.amount && li.discountedUnitPrice.currencyCode
        ? li.discountedUnitPrice
        : li.originalUnitPrice;
    const row: Record<string, unknown> = {
      quantity: li.quantity,
      title: li.title,
      taxable: li.taxable ?? true,
      requiresShipping: li.requiresShipping ?? true,
      originalUnitPriceWithCurrency: {
        amount: unit.amount,
        currencyCode: unit.currencyCode,
      },
    };
    if (li.sku?.trim()) row.sku = li.sku.trim();
    if (li.customAttributes?.length) {
      row.customAttributes = li.customAttributes.map((a) => ({
        key: a.key,
        value: a.value,
      }));
    }
    return row;
  });

  const tags = order.tags.filter(Boolean);

  // Do not set email/phone on the draft: completing the draft would send Shopify's
  // order confirmation to the customer. Link customer via purchasingEntity when known.
  // Email is applied later with orderUpdate.
  const input: Record<string, unknown> = {
    lineItems,
    note: order.note?.trim() || undefined,
    tags,
    shippingAddress: toMailingInput(order.shippingAddress),
    billingAddress: toMailingInput(order.billingAddress ?? order.shippingAddress),
    presentmentCurrencyCode: order.currencyCode || undefined,
    poNumber: order.poNumber || undefined,
    sourceName: "orders-export-import",
    taxExempt: false,
  };

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

  return input;
}

async function draftOrderCreateRequest(
  admin: AdminApiContext,
  input: Record<string, unknown>,
): Promise<{ error?: string; draftOrderId?: string }> {
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

async function draftOrderCreate(
  admin: AdminApiContext,
  order: ExportedOrderV1,
  customerGid?: string,
) {
  const baseInput = buildDraftOrderInput(order);

  if (customerGid) {
    const linked = await draftOrderCreateRequest(admin, {
      ...baseInput,
      purchasingEntity: { customerId: customerGid },
    });
    if (!linked.error) return linked;
    if (shouldRetryDraftWithoutCustomer(linked.error)) {
      return draftOrderCreateRequest(admin, baseInput);
    }
    return linked;
  }

  return draftOrderCreateRequest(admin, baseInput);
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
 * After import, restore customer email on the order (not on the draft, so no
 * confirmation email is sent at complete). Optionally clear the auto-filled payment
 * note when the CSV had no Notes text.
 *
 * Do not use OrderInput.phone (not accepted on all Admin API versions); put phone on shippingAddress.
 */
async function syncOrderContactAndNoteAfterImport(
  admin: AdminApiContext,
  orderId: string,
  order: ExportedOrderV1,
  hadCsvNote: boolean,
): Promise<string | null> {
  const email =
    order.email?.trim() ||
    order.customer?.email?.trim() ||
    undefined;
  const orderPhone =
    order.phone?.trim() ||
    order.customer?.phone?.trim() ||
    undefined;

  const canSetPhoneOnShipping =
    Boolean(orderPhone) && Boolean(order.shippingAddress);

  if (hadCsvNote && !email && !canSetPhoneOnShipping) {
    return null;
  }

  const input: Record<string, unknown> = { id: orderId };
  if (email) input.email = email;

  if (canSetPhoneOnShipping && order.shippingAddress) {
    const merged = {
      ...order.shippingAddress,
      phone:
        order.shippingAddress.phone?.trim() || orderPhone || undefined,
    };
    const mailing = toMailingInput(merged);
    if (mailing) input.shippingAddress = mailing;
  }

  if (!hadCsvNote) input.note = "";

  const res = await admin.graphql(
    `#graphql
      mutation OrderUpdateAfterImport($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors {
            message
          }
        }
      }
    `,
    { variables: { input } },
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

  const customerGid = await resolveCustomerGidForDraft(admin, order);
  const created = await draftOrderCreate(admin, order, customerGid);
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
  if (completed.orderId) {
    const syncErr = await syncOrderContactAndNoteAfterImport(
      admin,
      completed.orderId,
      order,
      hadCsvNote,
    );
    if (syncErr) {
      extraMessage = `Post-import order update failed: ${syncErr}`;
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
  onProgress?: (payload: ImportProgressPayload) => void,
): Promise<ImportOrdersResult> {
  let orders: ExportedOrderV1[];
  try {
    orders = parseAdminOrderCsvOnly(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, results: [], error: message };
  }

  return importParsedOrders(admin, shop, orders, onProgress);
}

export async function importOrdersFromXlsx(
  admin: AdminApiContext,
  shop: string,
  fileBuffer: ArrayBuffer,
  onProgress?: (payload: ImportProgressPayload) => void,
): Promise<ImportOrdersResult> {
  let orders: ExportedOrderV1[];
  try {
    orders = parseShopifyAdminOrdersXlsx(fileBuffer);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, results: [], error: message };
  }

  return importParsedOrders(admin, shop, orders, onProgress);
}

async function importParsedOrders(
  admin: AdminApiContext,
  shop: string,
  orders: ExportedOrderV1[],
  onProgress?: (payload: ImportProgressPayload) => void,
): Promise<ImportOrdersResult> {
  const results: ImportOrderResult[] = [];
  const total = orders.length;
  for (let i = 0; i < orders.length; i++) {
    const r = await importOneOrder(admin, shop, orders[i]!);
    results.push(r);
    onProgress?.({ index: i + 1, total, result: r });
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
