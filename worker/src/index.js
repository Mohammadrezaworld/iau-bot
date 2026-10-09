// Worker پایه: سلامت سرویس و دریافت پست‌های اسکرپ‌شده از GitHub Actions.
// دستورات تلگرام و منوها در مراحل بعدی اضافه میشن.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const nowUtc = () => Math.floor(Date.now() / 1000);

async function handleIngest(request, env) {
  // فقط GitHub Actions با رمز مشترک می‌تونه پست بفرسته
  if (request.headers.get("x-ingest-secret") !== env.INGEST_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await request.json();
  const source = String(body.source || "");
  const channel = String(body.channel || "");
  const posts = Array.isArray(body.posts) ? body.posts : [];

  if (!["bale", "telegram"].includes(source) || !channel) {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  let newCount = 0;
  const ts = nowUtc();
  for (const p of posts) {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO posts
         (source, channel, post_id, text, image_url, first_seen_utc)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(source, channel, String(p.post_id), String(p.text || ""), String(p.image_url || ""), ts)
      .run();
    if (res.meta && res.meta.changes > 0) newCount += 1;
  }

  await env.DB.prepare(
    `INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(source, channel, ts, newCount)
    .run();

  return json({ ok: true, received: posts.length, new: newCount });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, time_utc: nowUtc() });
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};
