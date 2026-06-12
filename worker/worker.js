// Cloudflare Worker: välittää GraphQL- ja geokoodauspyynnöt Digitransitiin ja
// lisää API-avaimen palvelinpäässä, jotta sivun käyttäjät eivät tarvitse omaa avainta.
// Avain asetetaan salaisuutena: npx wrangler secret put DIGITRANSIT_KEY

const ROUTING_UPSTREAM = "https://api.digitransit.fi/routing/v2/waltti/gtfs/v1";
const GEOCODING_UPSTREAM = "https://api.digitransit.fi/geocoding/v1";

const ALLOWED_ORIGINS = new Set([
  "https://veikkoville.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://veikkoville.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const geo = url.pathname.match(/^\/geocoding\/(search|autocomplete|reverse)$/);
    if (geo) {
      if (request.method !== "GET") {
        return new Response("Only GET is supported for geocoding", { status: 405, headers: corsHeaders(origin) });
      }
      const upstream = await fetch(`${GEOCODING_UPSTREAM}/${geo[1]}${url.search}`, {
        headers: { "digitransit-subscription-key": env.DIGITRANSIT_KEY },
      });
      const headers = new Headers(corsHeaders(origin));
      headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
      headers.set("Cache-Control", "public, max-age=60");
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    if (request.method !== "POST") {
      return new Response("Only POST is supported", { status: 405, headers: corsHeaders(origin) });
    }
    const upstream = await fetch(ROUTING_UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "digitransit-subscription-key": env.DIGITRANSIT_KEY,
      },
      body: request.body,
    });
    const headers = new Headers(corsHeaders(origin));
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
