// Entry point. Static pages come from the assets binding; /api/* goes to the one Durable Object.
import { quickReject } from "./auth.js";
export { ShopDO } from "./shop-do.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Same redirects as vercel.json: the old landing and kitchen URLs go to the admin page.
    if (url.pathname === "/" || url.pathname === "/kitchen" || url.pathname === "/kitchen.html") {
      return Response.redirect(`${url.origin}/admin${url.search}`, 302);
    }

    if (url.pathname.startsWith("/api/")) {
      // Requests with no usable credential for a protected route stop here, before the
      // Durable Object is woken (the exact check happens inside the Durable Object).
      const rejected = await quickReject(request, env);
      if (rejected) return rejected;
      const stub = env.SHOP.get(env.SHOP.idFromName("shop"));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
