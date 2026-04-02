import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { data, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  importOrdersFromCsv,
  importOrdersFromXlsx,
  type ImportOrderResult,
} from "../services/orders-import.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app");
};

function importSummaryFromResults(results: ImportOrderResult[]) {
  return {
    total: results.length,
    imported: results.filter((r) => r.status === "imported").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "error").length,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const wantsStream = (request.headers.get("Accept") || "").includes(
    "application/x-ndjson",
  );

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return data(
      { error: "Choose a non-empty Shopify export CSV or XLSX file." },
      { status: 400 },
    );
  }

  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    return data(
      { error: "File is too large (max 50 MB for this app)." },
      { status: 400 },
    );
  }

  const fileName = file.name.toLowerCase();
  const isXlsx =
    fileName.endsWith(".xlsx") ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const isCsv = fileName.endsWith(".csv") || file.type === "text/csv";

  if (!isCsv && !isXlsx) {
    return data(
      { error: "Unsupported file type. Upload a Shopify export CSV or XLSX file." },
      { status: 400 },
    );
  }

  if (wantsStream) {
    const encoder = new TextEncoder();
    const xlsxBuffer = isXlsx ? await file.arrayBuffer() : null;
    const csvText = isCsv ? await file.text() : "";

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        };
        try {
          const onProgress = (payload: {
            index: number;
            total: number;
            result: ImportOrderResult;
          }) => {
            send({ type: "progress", ...payload });
          };

          const result = isXlsx
            ? await importOrdersFromXlsx(
                admin,
                session.shop,
                xlsxBuffer!,
                onProgress,
              )
            : await importOrdersFromCsv(
                admin,
                session.shop,
                csvText,
                onProgress,
              );

          if (result.error && !result.results.length) {
            send({ type: "error", message: result.error });
            return;
          }

          send({
            type: "complete",
            ok: result.ok,
            summary: importSummaryFromResults(result.results),
            results: result.results,
            warning: result.error,
          });
        } catch (e) {
          send({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const result = isXlsx
    ? await importOrdersFromXlsx(admin, session.shop, await file.arrayBuffer())
    : await importOrdersFromCsv(admin, session.shop, await file.text());

  if (result.error && !result.results.length) {
    return data({ error: result.error }, { status: 400 });
  }

  return data({
    ok: result.ok,
    summary: importSummaryFromResults(result.results),
    results: result.results,
    warning: result.error,
  });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
