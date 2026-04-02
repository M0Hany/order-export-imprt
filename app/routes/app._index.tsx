import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import type { ImportOrderResult } from "../services/orders-import.server";

type ImportSummary = {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
};

type StreamProgress = {
  index: number;
  total: number;
  result: ImportOrderResult;
};

type StreamComplete = {
  type: "complete";
  ok: boolean;
  summary: ImportSummary;
  results: ImportOrderResult[];
  warning?: string;
};

type StreamError = { type: "error"; message: string };

type StreamProgressEvent = { type: "progress" } & StreamProgress;

type StreamEvent = StreamProgressEvent | StreamComplete | StreamError;

function orderRowLabel(result: ImportOrderResult, index: number): string {
  const name = result.newOrderName?.trim();
  if (name) return name;
  const sid = result.sourceId?.trim();
  if (sid) return sid;
  return `Source order ${index}`;
}

function statusTone(
  status: ImportOrderResult["status"],
): "success" | "caution" | "critical" {
  if (status === "imported") return "success";
  if (status === "skipped") return "caution";
  return "critical";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop };
};

export default function Index() {
  const { shop } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const lastToastKey = useRef<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [progressRows, setProgressRows] = useState<StreamProgress[]>([]);
  const [complete, setComplete] = useState<StreamComplete | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const handleImport = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fileInput = form.elements.namedItem("file") as HTMLInputElement;
      if (!fileInput?.files?.length) {
        shopify.toast.show("Choose a file to import.", { isError: true });
        return;
      }

      setBusy(true);
      setProgressRows([]);
      setComplete(null);
      setStreamError(null);

      const fd = new FormData(form);

      try {
        const res = await fetch("/app/import-orders", {
          method: "POST",
          body: fd,
          headers: { Accept: "application/x-ndjson" },
          credentials: "same-origin",
        });

        if (!res.ok) {
          const ct = res.headers.get("content-type") || "";
          let message = `Request failed (${res.status}).`;
          if (ct.includes("application/json")) {
            try {
              const j = (await res.json()) as { error?: string };
              if (j.error) message = j.error;
            } catch {
              /* ignore */
            }
          }
          setStreamError(message);
          shopify.toast.show(message, { isError: true });
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          const message = "No response body from server.";
          setStreamError(message);
          shopify.toast.show(message, { isError: true });
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let evt: StreamEvent;
            try {
              evt = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }
            if (evt.type === "progress") {
              setProgressRows((prev) => [
                ...prev,
                {
                  index: evt.index,
                  total: evt.total,
                  result: evt.result,
                },
              ]);
            } else if (evt.type === "complete") {
              setComplete(evt);
              const key = `done-${evt.summary.imported}-${evt.summary.failed}`;
              if (lastToastKey.current !== key) {
                lastToastKey.current = key;
                const { imported, skipped, failed } = evt.summary;
                shopify.toast.show(
                  `Import finished: ${imported} imported, ${skipped} skipped, ${failed} failed.`,
                  { isError: Boolean(failed) },
                );
              }
            } else if (evt.type === "error") {
              setStreamError(evt.message);
              shopify.toast.show(evt.message, { isError: true });
            }
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Import request failed.";
        setStreamError(message);
        shopify.toast.show(message, { isError: true });
      } finally {
        setBusy(false);
      }
    },
    [shopify],
  );

  const current = progressRows[progressRows.length - 1];
  const showProgressPanel = busy || progressRows.length > 0 || complete;

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
          as a shipping line when the Shipping total is greater than zero. New
          orders are completed as <s-text type="strong">unpaid</s-text>{" "}
          (payment status is not copied from the export).
        </s-paragraph>
        <s-paragraph>
          The Admin CSV does not include order metafields; for most moves it is
          enough for order records and line items.
        </s-paragraph>
        <form
          method="post"
          action="/app/import-orders"
          encType="multipart/form-data"
          onSubmit={handleImport}
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
        </form>

        {streamError && !busy && (
          <s-box padding="base" paddingBlockStart="base">
            <s-text tone="critical">{streamError}</s-text>
          </s-box>
        )}

        {showProgressPanel && (
          <s-box
            padding="base"
            paddingBlockStart="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-text type="strong">Import progress</s-text>
              {busy && current && (
                <s-paragraph>
                  Processing{" "}
                  <s-text type="strong">
                    {current.index} / {current.total}
                  </s-text>
                  …
                </s-paragraph>
              )}
              {busy && !current && (
                <s-paragraph>Parsing file and starting import…</s-paragraph>
              )}
              {!busy && complete && (
                <s-paragraph>
                  Done — total {complete.summary.total} · imported{" "}
                  {complete.summary.imported} · skipped{" "}
                  {complete.summary.skipped} · failed {complete.summary.failed}
                </s-paragraph>
              )}
              {progressRows.length > 0 && (
                <div
                  style={{
                    maxHeight: 320,
                    overflow: "auto",
                    border: "1px solid var(--p-color-border, #e3e3e3)",
                    borderRadius: 8,
                    background: "var(--p-color-bg-surface, #fff)",
                  }}
                >
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: 13,
                    }}
                  >
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid #e3e3e3" }}>
                        <th style={{ padding: "8px 10px" }}>#</th>
                        <th style={{ padding: "8px 10px" }}>Status</th>
                        <th style={{ padding: "8px 10px" }}>Order</th>
                        <th style={{ padding: "8px 10px" }}>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {progressRows.map((row) => (
                        <tr
                          key={row.index}
                          style={{ borderBottom: "1px solid #f1f1f1" }}
                        >
                          <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                            {row.index}/{row.total}
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <s-text tone={statusTone(row.result.status)}>
                              {row.result.status}
                            </s-text>
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            {orderRowLabel(row.result, row.index)}
                          </td>
                          <td
                            style={{
                              padding: "8px 10px",
                              color: "#6d7175",
                              maxWidth: 220,
                              wordBreak: "break-word",
                            }}
                          >
                            {row.result.message ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {complete?.warning && (
                <s-paragraph tone="caution">{complete.warning}</s-paragraph>
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
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
