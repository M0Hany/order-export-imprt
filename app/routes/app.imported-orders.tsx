import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 50;

type ImportedOrderRow = {
  id: string;
  orderGid: string;
  orderName: string | null;
  sourceName: string | null;
  sourceId: string | null;
  importedAt: string;
  createdAt?: string | null;
  trackedByApp?: boolean;
};

type ActionResult = {
  ok: boolean;
  deleted: number;
  errors: string[];
  orderGids?: string[];
  deletedOrderGids?: string[];
};

async function deleteOrderByGid(admin: AdminApiContext, orderGid: string) {
  const res = await admin.graphql(
    `#graphql
      mutation OrderDelete($orderId: ID!) {
        orderDelete(orderId: $orderId) {
          deletedId
          userErrors {
            message
            code
          }
        }
      }
    `,
    { variables: { orderId: orderGid } },
  );

  const json = (await res.json()) as {
    data?: {
      orderDelete?: {
        deletedId?: string | null;
        userErrors?: { message: string; code?: string | null }[];
      };
    };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    return {
      ok: false,
      error: json.errors.map((e) => e.message).join("; "),
      deleted: false,
    };
  }

  const payload = json.data?.orderDelete;
  const userErr = payload?.userErrors?.map((e) => e.message).join("; ");
  if (userErr) {
    return { ok: false, error: userErr, deleted: false };
  }

  return { ok: true, error: null, deleted: Boolean(payload?.deletedId) };
}

async function listImportedOrderGidsFromShopify(admin: AdminApiContext) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const res = await admin.graphql(
      `#graphql
        query ImportedOrdersBySource($cursor: String) {
          orders(
            first: 100
            after: $cursor
            query: "source_name:orders-export-import"
            sortKey: CREATED_AT
            reverse: true
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
            }
          }
        }
      `,
      { variables: { cursor } },
    );

    const json = (await res.json()) as {
      data?: {
        orders?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: { id: string }[];
        };
      };
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }

    const conn = json.data?.orders;
    for (const n of conn?.nodes ?? []) {
      if (n.id) ids.push(n.id);
    }
    hasNext = Boolean(conn?.pageInfo?.hasNextPage);
    cursor = conn?.pageInfo?.endCursor ?? null;
  }

  return ids;
}

async function fetchOrdersPage(admin: AdminApiContext, after: string | null) {
  const res = await admin.graphql(
    `#graphql
      query OrdersForManagement($after: String) {
        orders(first: ${PAGE_SIZE}, after: $after, sortKey: CREATED_AT, reverse: true) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            name
            sourceName
            createdAt
          }
        }
      }
    `,
    { variables: { after } },
  );
  const json = (await res.json()) as {
    data?: {
      orders?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: {
          id: string;
          name: string | null;
          sourceName: string | null;
          createdAt: string;
        }[];
      };
    };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  return {
    nodes: json.data?.orders?.nodes ?? [],
    pageInfo: json.data?.orders?.pageInfo ?? {
      hasNextPage: false,
      endCursor: null,
    },
  };
}

async function fetchOrdersByPageNumber(admin: AdminApiContext, page: number) {
  let currentPage = 1;
  let after: string | null = null;
  let result = await fetchOrdersPage(admin, after);

  while (currentPage < page && result.pageInfo.hasNextPage) {
    after = result.pageInfo.endCursor ?? null;
    result = await fetchOrdersPage(admin, after);
    currentPage += 1;
  }

  return {
    nodes: result.nodes,
    hasNextPage: Boolean(result.pageInfo.hasNextPage),
    actualPage: currentPage,
  };
}

function parseOrderNumbersRaw(raw: string): string[] {
  const tokens = raw
    .split(/[\s,]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t.slice(1) : t));

  // Shopify "order name" is usually numeric (displayed like "#1283").
  // To avoid search syntax issues, keep digits-only.
  return [...new Set(tokens.filter((t) => /^\d+$/.test(t)))];
}

async function findImportedOrderIdsByNumbers(
  admin: AdminApiContext,
  numbers: string[],
): Promise<{ orderGids: string[]; notFound: string[] }> {
  const orderGids: string[] = [];
  const notFound: string[] = [];

  for (const n of numbers) {
    const res = await admin.graphql(
      `#graphql
        query OrdersByName($query: String!) {
          orders(first: 5, query: $query) {
            nodes {
              id
            }
          }
        }
      `,
      {
        variables: {
          query: `source_name:orders-export-import name:${n}`,
        },
      },
    );

    const json = (await res.json()) as {
      data?: { orders?: { nodes?: { id: string }[] } };
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }

    const id = json.data?.orders?.nodes?.[0]?.id;
    if (id) orderGids.push(id);
    else notFound.push(n);
  }

  return { orderGids: [...new Set(orderGids)], notFound };
}

/** Total orders (same unfiltered list as fetchOrdersPage). Used for ?page=last only. */
async function fetchOrdersTotalCount(admin: AdminApiContext): Promise<number> {
  const res = await admin.graphql(
    `#graphql
      query OrdersTotalCount {
        ordersCount(limit: null) {
          count
        }
      }
    `,
  );
  const json = (await res.json()) as {
    data?: { ordersCount?: { count?: number } | null };
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  const n = json.data?.ordersCount?.count;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const pageParam = url.searchParams.get("page") ?? "1";

  let requestedPage: number;
  if (pageParam.toLowerCase() === "last") {
    const total = await fetchOrdersTotalCount(admin);
    requestedPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  } else {
    const n = Number(pageParam);
    requestedPage =
      Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  const pageResult = await fetchOrdersByPageNumber(admin, requestedPage);
  const remoteOrders = pageResult.nodes;

  const tracked = await db.importedOrder.findMany({
    where: {
      shop: session.shop,
      orderGid: { in: remoteOrders.map((o) => o.id) },
    },
    orderBy: { importedAt: "desc" },
  });
  const trackedByOrderGid = new Map(tracked.map((r) => [r.orderGid, r]));

  const importedOrders: ImportedOrderRow[] = remoteOrders.map((o) => {
    const row = trackedByOrderGid.get(o.id);
    return {
      id: row?.id ?? o.id,
      orderGid: o.id,
      orderName: o.name,
      sourceName: row?.sourceName ?? o.sourceName,
      sourceId: row?.sourceId ?? null,
      importedAt: row?.importedAt.toISOString() ?? o.createdAt,
      createdAt: o.createdAt,
      trackedByApp: Boolean(row),
    };
  });

  return {
    shop: session.shop,
    page: pageResult.actualPage,
    hasPrevPage: pageResult.actualPage > 1,
    hasNextPage: pageResult.hasNextPage,
    importedOrders,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  let targets: { id: string; orderGid: string }[] = [];
  let preErrors: string[] = [];
  if (intent === "delete-all") {
    targets = await db.importedOrder.findMany({
      where: { shop: session.shop },
      select: { id: true, orderGid: true },
    });
  } else if (intent === "delete-selected") {
    const selectedJson = String(form.get("selectedOrderGidsJson") || "[]");
    let orderGids: string[] = [];
    try {
      const parsed = JSON.parse(selectedJson) as unknown;
      if (Array.isArray(parsed)) {
        orderGids = parsed.map((v) => String(v)).filter(Boolean);
      }
    } catch {
      orderGids = [];
    }

    if (!orderGids.length) {
      return data<ActionResult>(
        { ok: false, deleted: 0, errors: ["No orders were selected."] },
        { status: 400 },
      );
    }

    targets = [...new Set(orderGids)].map((orderGid) => ({ id: orderGid, orderGid }));
  } else if (intent === "delete-by-order-numbers") {
    const raw = String(form.get("orderNumbersRaw") || "");
    const orderNumbers = parseOrderNumbersRaw(raw);

    if (!orderNumbers.length) {
      return data<ActionResult>(
        {
          ok: false,
          deleted: 0,
          errors: [
            "Paste order numbers like #1283 (comma/space/newline separated).",
          ],
        },
        { status: 400 },
      );
    }

    const { orderGids, notFound } = await findImportedOrderIdsByNumbers(
      admin,
      orderNumbers,
    );

    preErrors = notFound.map(
      (n) => `Order #${n} not found in imported orders.`,
    );

    if (!orderGids.length) {
      return data<ActionResult>(
        { ok: false, deleted: 0, errors: preErrors, deletedOrderGids: [] },
        { status: 404 },
      );
    }

    targets = orderGids.map((orderGid) => ({ id: orderGid, orderGid }));
  } else if (intent === "delete-by-source") {
    try {
      const remoteIds = await listImportedOrderGidsFromShopify(admin);
      targets = remoteIds.map((orderGid) => ({ id: orderGid, orderGid }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return data<ActionResult>(
        { ok: false, deleted: 0, errors: [message] },
        { status: 500 },
      );
    }
  } else if (intent === "list-all-order-ids") {
    try {
      const allIds: string[] = [];
      let cursor: string | null = null;
      let hasNext = true;

      while (hasNext) {
        const page = await fetchOrdersPage(admin, cursor);
        allIds.push(...page.nodes.map((n) => n.id).filter(Boolean));
        hasNext = Boolean(page.pageInfo.hasNextPage);
        cursor = page.pageInfo.endCursor ?? null;
      }

      return data<ActionResult>({
        ok: true,
        deleted: 0,
        errors: [],
        orderGids: [...new Set(allIds)],
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return data<ActionResult>(
        { ok: false, deleted: 0, errors: [message] },
        { status: 500 },
      );
    }
  } else {
    return data<ActionResult>(
      { ok: false, deleted: 0, errors: ["Unknown action."] },
      { status: 400 },
    );
  }

  let deleted = 0;
  const errors: string[] = [...preErrors];
  const deletedOrderGids: string[] = [];

  for (const t of targets) {
    const result = await deleteOrderByGid(admin, t.orderGid);
    if (result.ok || result.deleted) {
      deleted += 1;
      deletedOrderGids.push(t.orderGid);
      if (intent === "delete-by-source") {
        await db.importedOrder.deleteMany({
          where: { shop: session.shop, orderGid: t.orderGid },
        });
      } else {
        await db.importedOrder.deleteMany({
          where: { shop: session.shop, orderGid: t.orderGid },
        });
      }
    } else {
      errors.push(`${t.orderGid}: ${result.error ?? "delete failed"}`);
    }
  }

  return data<ActionResult>({
    ok: errors.length === 0,
    deleted,
    errors,
    deletedOrderGids,
  });
};

export default function ImportedOrdersPage() {
  const { importedOrders, page, hasPrevPage, hasNextPage } =
    useLoaderData<typeof loader>();
  const deleteFetcher = useFetcher<ActionResult>();
  const selectAllFetcher = useFetcher<ActionResult>();

  const deleting = deleteFetcher.state !== "idle";
  const deleted = deleteFetcher.data?.deleted ?? 0;
  const hasRows = importedOrders.length > 0;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [orderNumbersRaw, setOrderNumbersRaw] = useState<string>("");
  const storageKey = "orders-export-import:selected-order-gids";

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr)) setSelected(new Set(arr));
    } catch {
      // ignore parse errors
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify([...selected]));
  }, [selected]);

  useEffect(() => {
    const ids = selectAllFetcher.data?.orderGids;
    if (!ids?.length) return;
    setSelected(new Set(ids));
  }, [selectAllFetcher.data?.orderGids]);

  useEffect(() => {
    const deletedIds = deleteFetcher.data?.deletedOrderGids;
    if (!deletedIds?.length) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of deletedIds) next.delete(id);
      return next;
    });
  }, [deleteFetcher.data?.deletedOrderGids]);

  const selectedCount = selected.size;
  const selectedOnPageCount = importedOrders.filter((o) =>
    selected.has(o.orderGid),
  ).length;
  const allOnPageSelected =
    hasRows && importedOrders.every((o) => selected.has(o.orderGid));

  const toggleOne = (orderGid: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(orderGid);
      else next.delete(orderGid);
      return next;
    });
  };

  const togglePage = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const o of importedOrders) {
        if (checked) next.add(o.orderGid);
        else next.delete(o.orderGid);
      }
      return next;
    });
  };

  const submitDeleteSelected = () => {
    const fd = new FormData();
    fd.set("intent", "delete-selected");
    fd.set("selectedOrderGidsJson", JSON.stringify([...selected]));
    deleteFetcher.submit(fd, { method: "post" });
  };

  const submitSelectAllOrders = () => {
    const fd = new FormData();
    fd.set("intent", "list-all-order-ids");
    selectAllFetcher.submit(fd, { method: "post" });
  };

  const submitDeleteBySource = () => {
    const fd = new FormData();
    fd.set("intent", "delete-by-source");
    deleteFetcher.submit(fd, { method: "post" });
  };

  const submitDeleteByOrderNumbers = () => {
    const fd = new FormData();
    fd.set("intent", "delete-by-order-numbers");
    fd.set("orderNumbersRaw", orderNumbersRaw);
    deleteFetcher.submit(fd, { method: "post" });
  };

  const clearSelection = () => setSelected(new Set());

  const errorText = useMemo(
    () => deleteFetcher.data?.errors?.join("\n"),
    [deleteFetcher.data?.errors],
  );

  return (
    <s-page heading="Imported orders">
      <s-section heading="Manage imported orders">
        <s-paragraph>
          Select any orders from your store and delete them in bulk from Shopify.
        </s-paragraph>
        <s-paragraph>
          Bulk delete by order number (order name): paste values like{" "}
          <code>#1283</code> separated by commas, spaces, or new lines.
        </s-paragraph>
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            marginTop: 6,
            marginBottom: 6,
          }}
        >
          <textarea
            value={orderNumbersRaw}
            onChange={(e) => setOrderNumbersRaw(e.currentTarget.value)}
            placeholder="#1283, #1284"
            style={{
              width: 340,
              height: 64,
              resize: "vertical",
              padding: 8,
              fontSize: 13,
              borderRadius: 6,
              border: "1px solid var(--p-border-subdued, #dfe3e8)",
            }}
            disabled={deleting}
          />
          <s-button
            variant="primary"
            type="button"
            onClick={submitDeleteByOrderNumbers}
            disabled={deleting || !orderNumbersRaw.trim()}
            {...(deleting ? { loading: true } : {})}
          >
            Delete by numbers
          </s-button>
        </div>
        <s-paragraph>
          Selected across all pages: <s-text type="strong">{selectedCount}</s-text>
        </s-paragraph>
        <s-paragraph>
          Selected on this page: <s-text type="strong">{selectedOnPageCount}</s-text>
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <s-button
            onClick={() => togglePage(!allOnPageSelected)}
            disabled={!hasRows || deleting}
          >
            {allOnPageSelected ? "Unselect page" : "Select page"}
          </s-button>
          <s-button
            onClick={submitSelectAllOrders}
            disabled={selectAllFetcher.state !== "idle"}
            {...(selectAllFetcher.state !== "idle" ? { loading: true } : {})}
          >
            Select all orders
          </s-button>
          <s-button onClick={clearSelection} disabled={selectedCount === 0 || deleting}>
            Clear selection
          </s-button>
          <s-button
            variant="primary"
            onClick={submitDeleteSelected}
            disabled={selectedCount === 0 || deleting}
            {...(deleting ? { loading: true } : {})}
          >
            Delete selected
          </s-button>
        </s-stack>

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8 }}>Select</th>
                <th style={{ textAlign: "left", padding: 8 }}>Order</th>
                <th style={{ textAlign: "left", padding: 8 }}>Source</th>
                <th style={{ textAlign: "left", padding: 8 }}>Created at</th>
                <th style={{ textAlign: "left", padding: 8 }}>Tracked</th>
              </tr>
            </thead>
            <tbody>
              {importedOrders.map((o) => (
                <tr key={o.id}>
                  <td style={{ padding: 8 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(o.orderGid)}
                      onChange={(e) => toggleOne(o.orderGid, e.currentTarget.checked)}
                      disabled={deleting}
                    />
                  </td>
                  <td style={{ padding: 8 }}>
                    {o.orderName || o.orderGid}
                  </td>
                  <td style={{ padding: 8 }}>
                    {o.sourceName || "-"}
                  </td>
                  <td style={{ padding: 8 }}>
                    {new Date(o.createdAt || o.importedAt).toLocaleString()}
                  </td>
                  <td style={{ padding: 8 }}>
                    {o.trackedByApp ? "Yes" : "No"}
                  </td>
                </tr>
              ))}
              {!importedOrders.length && (
                <tr>
                  <td style={{ padding: 8 }} colSpan={5}>
                    No orders found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <s-stack direction="inline" gap="base">
          {hasPrevPage ? (
            <s-link href="/app/imported-orders?page=1">First</s-link>
          ) : (
            <s-text>First</s-text>
          )}
          {hasPrevPage ? (
            <s-link href={`/app/imported-orders?page=${page - 1}`}>Previous</s-link>
          ) : (
            <s-text>Previous</s-text>
          )}
          <s-text>Page {page}</s-text>
          {hasNextPage ? (
            <s-link href={`/app/imported-orders?page=${page + 1}`}>Next</s-link>
          ) : (
            <s-text>Next</s-text>
          )}
          {hasNextPage ? (
            <s-link href="/app/imported-orders?page=last">Last</s-link>
          ) : (
            <s-text>Last</s-text>
          )}
        </s-stack>

        <s-stack direction="inline" gap="base">
          <s-button
            type="button"
            variant="primary"
            onClick={submitDeleteBySource}
            disabled={deleting}
          >
            Delete previously imported orders (source filter)
          </s-button>
        </s-stack>
        <s-paragraph>
          This deletes Shopify orders where <code>source_name</code> is
          <code>orders-export-import</code>.
        </s-paragraph>

        {deleteFetcher.data && (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-paragraph>
              Deleted {deleted} order{deleted === 1 ? "" : "s"}.
            </s-paragraph>
            {errorText ? (
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                <code>{errorText}</code>
              </pre>
            ) : null}
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
