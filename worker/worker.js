// Cloudflare Worker: välittää GraphQL-pyynnöt Digitransitiin ja lisää
// API-avaimen palvelinpäässä, jotta sivun käyttäjät eivät tarvitse omaa avainta.
// Avain asetetaan salaisuutena: npx wrangler secret put DIGITRANSIT_KEY

const UPSTREAM = "https://api.digitransit.fi/routing/v2/waltti/gtfs/v1";

const ALLOWED_ORIGINS = new Set([
  "https://veikkoville.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://veikkoville.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    if (request.method !== "POST") {
      return new Response("Only POST is supported", { status: 405, headers: corsHeaders(origin) });
    }
    const upstream = await fetch(UPSTREAM, {
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
