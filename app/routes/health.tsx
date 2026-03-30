/**
 * Used by hosts (e.g. Render) for health checks. Keep this route fast and public.
 */
export function loader() {
  return new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
