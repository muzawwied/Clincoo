export async function onRequest(context) {
  const { request, next } = context;
  const response = await next();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") || request.method !== "GET") return response;
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        element.append('<script src="/assets/ls-quota-guard.js" defer></script><script src="/assets/clincoo-bug.js?v=2" defer></script>', { html: true });
      }
    })
    .transform(response);
}
