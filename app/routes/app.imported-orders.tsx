import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { useMemo } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type ImportedOrderRow = {
  id: string;
  orderGid: string;
  orderName: string | null;
  sourceName: string | null;
  sourceId: string | null;
  importedAt: string;
};

type ActionResult = {
  ok: boolean;
  deleted: number;
  errors: string[];
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const rows = await db.importedOrder.findMany({
    where: { shop: session.shop },
    orderBy: { importedAt: "desc" },
    take: 500,
  });

  const importedOrders: ImportedOrderRow[] = rows.map((r) => ({
    id: r.id,
    orderGid: r.orderGid,
    orderName: r.orderName,
    sourceName: r.sourceName,
    sourceId: r.sourceId,
    importedAt: r.importedAt.toISOString(),
  }));

  return {
    shop: session.shop,
    importedOrders,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  let targets: { id: string; orderGid: string }[] = [];
  if (intent === "delete-all") {
    targets = await db.importedOrder.findMany({
      where: { shop: session.shop },
      select: { id: true, orderGid: true },
    });
  } else if (intent === "delete-selected") {
    const ids = form
      .getAll("selectedIds")
      .map((v) => String(v))
      .filter(Boolean);

    if (!ids.length) {
      return data<ActionResult>(
        { ok: false, deleted: 0, errors: ["No orders were selected."] },
        { status: 400 },
      );
    }

    targets = await db.importedOrder.findMany({
      where: { id: { in: ids }, shop: session.shop },
      select: { id: true, orderGid: true },
    });
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
  } else {
    return data<ActionResult>(
      { ok: false, deleted: 0, errors: ["Unknown action."] },
      { status: 400 },
    );
  }

  let deleted = 0;
  const errors: string[] = [];

  for (const t of targets) {
    const result = await deleteOrderByGid(admin, t.orderGid);
    if (result.ok || result.deleted) {
      deleted += 1;
      if (intent === "delete-by-source") {
        await db.importedOrder.deleteMany({
          where: { shop: session.shop, orderGid: t.orderGid },
        });
      } else {
        await db.importedOrder.delete({ where: { id: t.id } });
      }
    } else {
      errors.push(`${t.orderGid}: ${result.error ?? "delete failed"}`);
    }
  }

  return data<ActionResult>({
    ok: errors.length === 0,
    deleted,
    errors,
  });
};

export default function ImportedOrdersPage() {
  const { importedOrders } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();

  const deleting = fetcher.state !== "idle";
  const deleted = fetcher.data?.deleted ?? 0;
  const hasRows = importedOrders.length > 0;
  const errorText = useMemo(
    () => fetcher.data?.errors?.join("\n"),
    [fetcher.data?.errors],
  );

  return (
    <s-page heading="Imported orders">
      <s-section heading="Manage imported orders">
        <s-paragraph>
          Select orders imported by this app and delete them in bulk from Shopify.
        </s-paragraph>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="delete-selected" />
          <s-stack direction="inline" gap="base">
            <s-button
              type="submit"
              variant="primary"
              disabled={deleting || !hasRows}
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
                  <th style={{ textAlign: "left", padding: 8 }}>Imported at</th>
                </tr>
              </thead>
              <tbody>
                {importedOrders.map((o) => (
                  <tr key={o.id}>
                    <td style={{ padding: 8 }}>
                      <input
                        type="checkbox"
                        name="selectedIds"
                        value={o.id}
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
                      {new Date(o.importedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {!importedOrders.length && (
                  <tr>
                    <td style={{ padding: 8 }} colSpan={4}>
                      No imported orders tracked yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </fetcher.Form>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="delete-all" />
          <s-stack direction="inline" gap="base">
            <s-button
              type="submit"
              variant="primary"
              disabled={deleting || !hasRows}
            >
              Delete all imported orders
            </s-button>
          </s-stack>
        </fetcher.Form>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="delete-by-source" />
          <s-stack direction="inline" gap="base">
            <s-button
              type="submit"
              variant="primary"
              disabled={deleting}
            >
              Delete previously imported orders (source filter)
            </s-button>
          </s-stack>
          <s-paragraph>
            Use this for old imports created before tracking existed. It deletes
            Shopify orders where <code>source_name</code> is
            <code>orders-export-import</code>.
          </s-paragraph>
        </fetcher.Form>

        {fetcher.data && (
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
