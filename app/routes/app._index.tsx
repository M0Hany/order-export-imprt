import { useEffect, useRef } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

type ImportActionData = {
  error?: string;
  ok?: boolean;
  warning?: string;
  summary?: {
    total: number;
    imported: number;
    skipped: number;
    failed: number;
  };
  results?: {
    sourceName?: string | null;
    status: string;
    newOrderName?: string;
    message?: string;
  }[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop };
};

export default function Index() {
  const { shop } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ImportActionData>();
  const shopify = useAppBridge();
  const lastNotified = useRef<string | null>(null);

  const busy =
    fetcher.state === "submitting" || fetcher.state === "loading";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const key = JSON.stringify(fetcher.data);
    if (lastNotified.current === key) return;
    lastNotified.current = key;

    if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      return;
    }
    if (fetcher.data.summary) {
      const { imported, skipped, failed } = fetcher.data.summary;
      shopify.toast.show(
        `Import finished: ${imported} imported, ${skipped} skipped, ${failed} failed.`,
        { isError: Boolean(failed) },
      );
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading="Order import">
      <s-section heading="Import from Shopify export">
        <s-paragraph>
          Export orders from your source store in Shopify Admin:{" "}
          <s-text type="strong">Orders</s-text> → select orders →{" "}
          <s-text type="strong">Export</s-text> →{" "}
          <s-text type="strong">CSV (or XLSX)</s-text>. Then upload that file
          here for <s-text type="strong">{shop}</s-text>. Rows are grouped by
          order <s-text type="strong">Name</s-text> (fallback{" "}
          <s-text type="strong">Id</s-text>), so multi-item orders stay
          together.
        </s-paragraph>
        <s-paragraph>
          Each order is recreated via draft orders (custom line items from
          titles, SKUs, and prices in the CSV). Shipping from the CSV is added
          as a shipping line when the Shipping total is greater than zero.
          New orders are completed as{" "}
          <s-text type="strong">unpaid</s-text> (payment status is not copied
          from the export).
        </s-paragraph>
        <s-paragraph>
          The Admin CSV does not include order metafields; for most moves it is
          enough for order records and line items.
        </s-paragraph>
        <fetcher.Form
          method="post"
          action="/app/import-orders"
          encType="multipart/form-data"
        >
          <s-stack direction="block" gap="base">
            <input
              type="file"
              name="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              disabled={busy}
            />
            <s-button
              variant="primary"
              type="submit"
              disabled={busy}
              {...(busy ? { loading: true } : {})}
            >
              Import orders
            </s-button>
          </s-stack>
        </fetcher.Form>

        {fetcher.data?.summary && (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-text type="strong">Last run</s-text>
              <s-paragraph>
                Total {fetcher.data.summary.total} · Imported{" "}
                {fetcher.data.summary.imported} · Skipped{" "}
                {fetcher.data.summary.skipped} · Failed{" "}
                {fetcher.data.summary.failed}
              </s-paragraph>
              {fetcher.data.warning && (
                <s-paragraph tone="caution">{fetcher.data.warning}</s-paragraph>
              )}
              {fetcher.data.results && fetcher.data.results.length > 0 && (
                <pre
                  style={{
                    margin: 0,
                    maxHeight: 280,
                    overflow: "auto",
                    fontSize: 12,
                  }}
                >
                  <code>
                    {JSON.stringify(fetcher.data.results, null, 2)}
                  </code>
                </pre>
              )}
            </s-stack>
          </s-box>
        )}
      </s-section>

      <s-section slot="aside" heading="Notes">
        <s-unordered-list>
          <s-list-item>
            Reinstall the app if you change OAuth scopes (draft orders are
            required for import).
          </s-list-item>
          <s-list-item>
            Large CSV/XLSX files are limited to 50 MB per upload in this app.
          </s-list-item>
          <s-list-item>
            Country must be a 2-letter code or a common English country name we
            recognize; otherwise leave addresses blank in the CSV or fix them
            after import.
          </s-list-item>
          <s-list-item>
            Discounts: codes from the export are sent to Shopify (they must
            still exist and be valid). Lineitem discount and compare-at vs price
            become line discounts when the order has no codes. Order-level
            Discount Amount is applied only when the export has no discount
            codes (to avoid doubling with codes).
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
