export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const { accessToken, event } = await req.json();
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        summary: event.title,
        description: event.description,
        start: { dateTime: event.start, timeZone: "Europe/Amsterdam" },
        end: { dateTime: event.end, timeZone: "Europe/Amsterdam" },
      }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    return new Response(JSON.stringify({ error: data?.error?.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ success: true, event: data }), {
    headers: { "Content-Type": "application/json" },
  });
}
