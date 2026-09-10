// ARQFLOW — Kiwify webhook
// Netlify Function: /.netlify/functions/kiwify-webhook

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const expectedToken = (process.env.KIWIFY_WEBHOOK_TOKEN || "").trim();
  if (!expectedToken) {
    return json(500, { ok: false, error: "KIWIFY_WEBHOOK_TOKEN not configured" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" });
  }

  const headerToken =
    event.headers?.["x-kiwify-token"] ||
    event.headers?.["x-webhook-token"] ||
    event.headers?.["x-token"] ||
    "";

  const authHeader =
    event.headers?.authorization || event.headers?.Authorization || "";

  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  const queryToken =
    event.queryStringParameters?.token ||
    event.queryStringParameters?.webhook_token ||
    "";

  const bodyToken = body.token || body.webhook_token || "";

  const receivedToken = [headerToken, bearerToken, queryToken, bodyToken]
    .map(v => String(v || "").trim())
    .find(v => v);

  if (receivedToken !== expectedToken) {
    return json(401, { ok: false, error: "Invalid webhook token" });
  }

  const eventType = String(body.webhook_event_type || "").toLowerCase();
  const orderStatus = String(body.order_status || "").toLowerCase();
  const email = String(body.Customer?.email || "").trim().toLowerCase();
  const productId = body.Product?.product_id || null;

  if (!email) {
    return json(400, { ok: false, error: "Customer.email not found" });
  }

  const expectedProductId =
    (process.env.ARQFLOW_KIWIFY_PRODUCT_ID || "").trim();

  if (
    expectedProductId &&
    productId &&
    productId !== expectedProductId
  ) {
    return json(200, {
      ok: true,
      ignored: true,
      reason: "Different product"
    });
  }

  let status = null;

  if (
    eventType === "order_approved" ||
    orderStatus === "paid"
  ) {
    status = "active";
  } else if (
    eventType === "order_refunded" ||
    eventType === "order_refunded_partial" ||
    eventType === "chargeback" ||
    orderStatus === "refunded" ||
    orderStatus === "chargeback"
  ) {
    status = "inactive";
  }

  if (!status) {
    return json(200, {
      ok: true,
      ignored: true,
      event: eventType || orderStatus || "unknown"
    });
  }

  const supabaseUrl =
    (process.env.SUPABASE_URL || "").replace(/\/$/, "");

  const supabaseKey =
    (process.env.SUPABASE_SECRET_KEY || "").trim();

  if (!supabaseUrl || !supabaseKey) {
    return json(500, {
      ok: false,
      error: "Supabase environment variables not configured"
    });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  const encodedEmail = encodeURIComponent(email);

  const updateResponse = await fetch(
    `${supabaseUrl}/rest/v1/licenses?email=eq.${encodedEmail}`,
    {
      method: "PATCH",
      headers: {
        ...headers,
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        product_id: productId,
        status,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!updateResponse.ok) {
    console.error(
      "Supabase update error:",
      await updateResponse.text()
    );

    return json(500, {
      ok: false,
      error: "Failed to update license"
    });
  }

  const lookupResponse = await fetch(
    `${supabaseUrl}/rest/v1/licenses?select=id&email=eq.${encodedEmail}&limit=1`,
    {
      method: "GET",
      headers
    }
  );

  if (!lookupResponse.ok) {
    console.error(
      "Supabase lookup error:",
      await lookupResponse.text()
    );

    return json(500, {
      ok: false,
      error: "Failed to verify license"
    });
  }

  const rows = await lookupResponse.json();

  if (!Array.isArray(rows) || rows.length === 0) {
    const insertResponse = await fetch(
      `${supabaseUrl}/rest/v1/licenses`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          email,
          product_id: productId,
          status
        })
      }
    );

    if (!insertResponse.ok) {
      console.error(
        "Supabase insert error:",
        await insertResponse.text()
      );

      return json(500, {
        ok: false,
        error: "Failed to create license"
      });
    }
  }

  return json(200, {
    ok: true,
    email,
    status,
    event: eventType || orderStatus
  });
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}
