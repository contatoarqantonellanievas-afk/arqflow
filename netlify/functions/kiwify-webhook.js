// ARQFLOW — Kiwify webhook
// Netlify Function: /.netlify/functions/kiwify-webhook

const crypto = require("crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  const token = (process.env.KIWIFY_WEBHOOK_TOKEN || "").trim();

  if (!token) {
    return json(500, {
      ok: false,
      error: "KIWIFY_WEBHOOK_TOKEN not configured"
    });
  }

  const rawBody = event.body || "";

  // Kiwify envia a assinatura na query string.
  // Validação temporariamente desativada para teste.

  if (!signature) {
    console.error("Kiwify: signature not found");

    return json(401, {
      ok: false,
      error: "Signature not found"
    });
  }

  // Validação HMAC-SHA1 da Kiwify.
  const expectedSignature = crypto
    .createHmac("sha1", token)
    .update(rawBody, "utf8")
    .digest("hex");

  const received = String(signature).trim().toLowerCase();

  if (
    received.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(
      Buffer.from(received),
      Buffer.from(expectedSignature)
    )
  ) {
    console.error("Kiwify: invalid signature");

    return json(401, {
      ok: false,
      error: "Invalid signature"
    });
  }

  let body;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, {
      ok: false,
      error: "Invalid JSON"
    });
  }

  const eventType = String(
    body.webhook_event_type || ""
  ).toLowerCase();

  const orderStatus = String(
    body.order_status || ""
  ).toLowerCase();

  const email = String(
    body.Customer?.email || ""
  ).trim().toLowerCase();

  const productId =
    body.Product?.product_id || null;

  if (!email) {
    console.error("Kiwify: buyer email not found");

    return json(400, {
      ok: false,
      error: "Customer.email not found"
    });
  }

  let status = null;

  // Compra aprovada
  if (
    eventType === "order_approved" ||
    orderStatus === "paid"
  ) {
    status = "active";
  }

  // Reembolso / chargeback
  if (
    eventType === "order_refunded" ||
    eventType === "order_refunded_partial" ||
    eventType === "chargeback" ||
    orderStatus === "refunded" ||
    orderStatus === "chargeback"
  ) {
    status = "inactive";
  }

  // Boleto gerado, Pix gerado etc.
  if (!status) {
    console.log(
      "Kiwify event ignored:",
      eventType || orderStatus || "unknown"
    );

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
    console.error("Supabase variables missing");

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

  const emailEncoded =
    encodeURIComponent(email);

  // Verifica se já existe licença.
  const lookup = await fetch(
    `${supabaseUrl}/rest/v1/licenses?select=id&email=eq.${emailEncoded}&limit=1`,
    {
      method: "GET",
      headers
    }
  );

  if (!lookup.ok) {
    console.error(
      "Supabase lookup error:",
      await lookup.text()
    );

    return json(500, {
      ok: false,
      error: "Supabase lookup failed"
    });
  }

  const existing = await lookup.json();

  // Atualiza licença existente.
  if (Array.isArray(existing) && existing.length > 0) {
    const update = await fetch(
      `${supabaseUrl}/rest/v1/licenses?email=eq.${emailEncoded}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          product_id: productId,
          status: status,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!update.ok) {
      console.error(
        "Supabase update error:",
        await update.text()
      );

      return json(500, {
        ok: false,
        error: "Supabase update failed"
      });
    }

    console.log(
      "ARQFLOW license updated:",
      email,
      status
    );
  }

  // Cria nova licença.
  else {
    const insert = await fetch(
      `${supabaseUrl}/rest/v1/licenses`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          email: email,
          product_id: productId,
          status: status
        })
      }
    );

    if (!insert.ok) {
      console.error(
        "Supabase insert error:",
        await insert.text()
      );

      return json(500, {
        ok: false,
        error: "Supabase insert failed"
      });
    }

    console.log(
      "ARQFLOW license created:",
      email,
      status
    );
  }

  return json(200, {
    ok: true,
    email: email,
    status: status,
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
