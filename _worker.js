export default {
  async fetch(request, env, ctx) {
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") || request.method !== "GET") return response;
    return new HTMLRewriter()
      .on("body", {
        element(element) {
          element.append('<script src="/assets/ls-quota-guard.js" defer></script><script src="/assets/clincoo-bug.js" defer></script>', { html: true });
        }
      })
      .transform(response);
  }
};
