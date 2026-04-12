export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const { messages, system } = await req.json();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 800, system, messages }),
  });
  const data = await r.json();
  if (!r.ok) return new Response(JSON.stringify({ error: data?.error?.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify({ reply: data?.content?.[0]?.text }), { headers: { "Content-Type": "application/json" } });
}
