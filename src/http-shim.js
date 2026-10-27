// Lets the unchanged Vercel-style handlers (handler(req, res)) run inside a Worker.
// Handlers only use: req.method, req.headers, req.body, req.query and
// res.status(code).json(body) / res.end(text) / res.setHeader(name, value).

export async function toNodeLikeRequest(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
  if (!headers.host) headers.host = url.host;

  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text; // same as Vercel: a non-JSON body arrives as a string
      }
    }
  }
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    query: Object.fromEntries(url.searchParams),
    body,
  };
}

export function createNodeLikeResponse() {
  const headers = new Headers();
  let statusCode = 200;
  let payload = null;
  let finished = false;

  const res = {
    setHeader(name, value) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      return res;
    },
    getHeader(name) {
      return headers.get(name) ?? undefined;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    json(body) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
      payload = JSON.stringify(body);
      finished = true;
      return res;
    },
    send(body) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      finished = true;
      return res;
    },
    end(body) {
      payload = body == null ? "" : String(body);
      finished = true;
      return res;
    },
    get finished() {
      return finished;
    },
  };

  res.toResponse = () => new Response(statusCode === 204 || statusCode === 304 ? null : payload, { status: statusCode, headers });
  return res;
}
