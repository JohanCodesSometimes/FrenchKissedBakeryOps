const crypto = require("crypto");

function createSquareService({ env, storage, connection, getSales, saveSales, logActivity, fetchImpl = fetch }) {
  const environment = env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";
  const baseUrl = environment === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
  const config = {
    environment,
    baseUrl,
    applicationId: env.SQUARE_APPLICATION_ID || "",
    applicationSecret: env.SQUARE_APPLICATION_SECRET || "",
    redirectUrl: env.SQUARE_OAUTH_REDIRECT_URL || "",
    signatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY || "",
    webhookUrl: env.SQUARE_WEBHOOK_URL || "",
    version: env.SQUARE_VERSION || "2026-05-20",
  };

  const configured = () => Boolean(
    config.applicationId && config.applicationSecret && config.redirectUrl &&
    config.signatureKey && config.webhookUrl,
  );

  function status() {
    return {
      configured: configured(),
      connected: Boolean(connection.accessToken && connection.merchantId),
      environment,
      merchantId: connection.merchantId || null,
      connectedAt: connection.connectedAt || null,
      lastSyncAt: connection.lastSyncAt || null,
      lastError: connection.lastError || null,
    };
  }

  async function startOAuth() {
    requireConfigured();
    connection.oauthState = crypto.randomBytes(32).toString("hex");
    connection.oauthStateExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    connection.environment = environment;
    await storage.saveSquareConnection(connection);
    const query = new URLSearchParams({
      client_id: config.applicationId,
      scope: "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ",
      session: "false",
      state: connection.oauthState,
      redirect_uri: config.redirectUrl,
    });
    return `${baseUrl}/oauth2/authorize?${query}`;
  }

  async function completeOAuth({ code, state, error, errorDescription }) {
    requireConfigured();
    if (error) throw publicError(errorDescription || error, 400);
    const stateIsValid = state && connection.oauthState &&
      safeEqual(state, connection.oauthState) &&
      Date.parse(connection.oauthStateExpiresAt || "") > Date.now();
    if (!stateIsValid) throw publicError("Square authorization expired or could not be verified.", 400);
    if (!code) throw publicError("Square did not return an authorization code.", 400);

    const token = await squareRequest("/oauth2/token", {
      method: "POST",
      authenticated: false,
      body: {
        client_id: config.applicationId,
        client_secret: config.applicationSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUrl,
      },
    });
    saveTokenResponse(token);
    connection.oauthState = "";
    connection.oauthStateExpiresAt = "";
    connection.connectedAt = new Date().toISOString();
    connection.lastError = "";
    await storage.saveSquareConnection(connection);
    await logActivity("square.connected", "Square account connected");
  }

  async function disconnect() {
    const merchantId = connection.merchantId;
    Object.keys(connection).forEach((key) => delete connection[key]);
    connection.environment = environment;
    await storage.saveSquareConnection(connection);
    await logActivity("square.disconnected", `Square account disconnected${merchantId ? ` (${merchantId})` : ""}`);
  }

  function verifyWebhook(rawBody, signature) {
    if (!config.signatureKey || !config.webhookUrl || !signature) return false;
    const expected = crypto
      .createHmac("sha256", config.signatureKey)
      .update(config.webhookUrl + rawBody, "utf8")
      .digest("base64");
    return safeEqual(signature, expected);
  }

  async function processWebhook(event) {
    if (!event || !["payment.created", "payment.updated"].includes(event.type)) {
      return { accepted: true, ignored: true };
    }
    const paymentId = event.data?.id || event.data?.object?.payment?.id;
    if (!paymentId) return { accepted: true, ignored: true };
    if (getSales().some((sale) => sale.squarePaymentId === paymentId)) {
      return { accepted: true, duplicate: true };
    }

    try {
      const paymentResult = await squareRequest(`/v2/payments/${encodeURIComponent(paymentId)}`);
      const payment = paymentResult.payment;
      if (!payment || payment.status !== "COMPLETED") return { accepted: true, ignored: true };
      if (getSales().some((sale) => sale.squarePaymentId === payment.id)) {
        return { accepted: true, duplicate: true };
      }
      const orderResult = payment.order_id
        ? await squareRequest(`/v2/orders/${encodeURIComponent(payment.order_id)}`)
        : {};
      const order = orderResult.order || {};
      const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
      const names = lineItems.map((item) => item.name || item.variation_name).filter(Boolean);
      const quantity = lineItems.reduce((total, item) => total + (Number(item.quantity) || 0), 0) || 1;
      const soldAt = payment.updated_at || payment.created_at || order.closed_at || new Date().toISOString();
      const sale = {
        id: crypto.randomUUID(),
        date: soldAt.slice(0, 10),
        product: names.join(", ") || "Square sale",
        quantitySold: round(quantity),
        saleAmount: money(payment.amount_money || order.total_money),
        tax: money(order.total_tax_money),
        discount: money(order.total_discount_money),
        soldAt,
        source: "square",
        squarePaymentId: payment.id,
        squareOrderId: payment.order_id || order.id || "",
        createdAt: new Date().toISOString(),
      };
      const sales = getSales();
      sales.unshift(sale);
      try {
        await saveSales();
      } catch (saveError) {
        const index = sales.findIndex((item) => item.id === sale.id);
        if (index >= 0) sales.splice(index, 1);
        throw saveError;
      }
      connection.lastSyncAt = new Date().toISOString();
      connection.lastError = "";
      await storage.saveSquareConnection(connection);
      await logActivity("square.sale.synced", `Square sale synced: ${sale.product}`);
      return { accepted: true, synced: true };
    } catch (error) {
      connection.lastError = error.message;
      await storage.saveSquareConnection(connection);
      throw error;
    }
  }

  async function squareRequest(path, options = {}) {
    const headers = { "Content-Type": "application/json", "Square-Version": config.version };
    if (options.authenticated !== false) headers.Authorization = `Bearer ${await accessToken()}`;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.errors?.[0]?.detail || `Square request failed (${response.status})`;
      throw new Error(detail);
    }
    return result;
  }

  async function accessToken() {
    if (!connection.accessToken) throw publicError("Square is not connected.", 409);
    const expiresSoon = connection.tokenExpiresAt && Date.parse(connection.tokenExpiresAt) < Date.now() + 5 * 60 * 1000;
    if (!expiresSoon) return decrypt(connection.accessToken, config.applicationSecret);
    if (!connection.refreshToken) throw publicError("Square authorization has expired. Reconnect Square.", 409);
    const token = await squareRequest("/oauth2/token", {
      method: "POST",
      authenticated: false,
      body: {
        client_id: config.applicationId,
        client_secret: config.applicationSecret,
        grant_type: "refresh_token",
        refresh_token: decrypt(connection.refreshToken, config.applicationSecret),
      },
    });
    saveTokenResponse(token);
    await storage.saveSquareConnection(connection);
    return decrypt(connection.accessToken, config.applicationSecret);
  }

  function saveTokenResponse(token) {
    connection.accessToken = encrypt(token.access_token, config.applicationSecret);
    connection.refreshToken = token.refresh_token
      ? encrypt(token.refresh_token, config.applicationSecret)
      : connection.refreshToken;
    connection.tokenExpiresAt = token.expires_at || "";
    connection.merchantId = token.merchant_id || connection.merchantId || "";
    connection.environment = environment;
  }

  function requireConfigured() {
    if (!configured()) throw publicError("Square environment variables are incomplete.", 503);
  }

  return { status, startOAuth, completeOAuth, disconnect, verifyWebhook, processWebhook };
}

function encrypt(value, secret) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decrypt(value, secret) {
  if (!value) return "";
  if (!value.startsWith("v1.")) return value;
  const [, iv, tag, encrypted] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function money(value) {
  return round(Number(value?.amount || 0) / 100);
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function publicError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = { createSquareService };
