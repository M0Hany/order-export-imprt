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
} from "../services/orders-import.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

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

  const result = isXlsx
    ? await importOrdersFromXlsx(admin, session.shop, await file.arrayBuffer())
    : await importOrdersFromCsv(admin, session.shop, await file.text());

  if (result.error && !result.results.length) {
    return data({ error: result.error }, { status: 400 });
  }

  return data({
    ok: result.ok,
    summary: {
      total: result.results.length,
      imported: result.results.filter((r) => r.status === "imported").length,
      skipped: result.results.filter((r) => r.status === "skipped").length,
      failed: result.results.filter((r) => r.status === "error").length,
    },
    results: result.results,
    warning: result.error,
  });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
