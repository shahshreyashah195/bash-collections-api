const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ── Zoho credentials ──────────────────────────────────────────
const ZOHO_CLIENT_ID     = "1000.0O68U7O5KE0ZII98X11HS0XU1B4JPA";
const ZOHO_CLIENT_SECRET = "d9439eef9ef7235ff17653536e2c7eca0dd4f5f8bd";
const ZOHO_REFRESH_TOKEN = "1000.2a3e3b52c796ca9f0f51fce787242c01.494c89563b57d8c18af72caaa56867d7";
const ZOHO_ORG_ID        = "60067759868";
const ZOHO_API_BASE      = "https://www.zohoapis.in/inventory/v1";
const ZOHO_AUTH_URL      = "https://accounts.zoho.in/oauth/v2/token";

// ── Token cache ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const res = await axios.post(ZOHO_AUTH_URL, null, {
    params: {
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type:    "refresh_token",
    },
  });
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + res.data.expires_in * 1000;
  return cachedToken;
}

async function zoho(path, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(`${ZOHO_API_BASE}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params:  { organization_id: ZOHO_ORG_ID, ...params },
  });
  return res.data;
}

// ── Helpers ───────────────────────────────────────────────────
async function fetchAllPages(path, key, extraParams = {}) {
  let page = 1, all = [], hasMore = true;
  while (hasMore) {
    const data = await zoho(path, { page, per_page: 200, ...extraParams });
    const items = data[key] || [];
    all = all.concat(items);
    hasMore = data.page_context?.has_more_page === true;
    page++;
    if (items.length === 0) break;
  }
  return all;
}

// ── Routes ────────────────────────────────────────────────────

// Health check
app.get("/health", (_, res) => res.json({ ok: true }));

// List all salespeople (for login verification)
app.get("/api/salespeople", async (_, res) => {
  try {
    const invoices = await fetchAllPages("/invoices", "invoices");
    const map = {};
    invoices.forEach(inv => {
      if (inv.salesperson_name && inv.salesperson_id) {
        map[inv.salesperson_name.toLowerCase()] = {
          id:   inv.salesperson_id,
          name: inv.salesperson_name,
        };
      }
    });
    res.json({ salespeople: Object.values(map) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All invoices for a salesperson (with customer grouping)
app.get("/api/invoices/:salesperson_id", async (req, res) => {
  try {
    const { salesperson_id } = req.params;
    const invoices = await fetchAllPages("/invoices", "invoices", {
      salesperson_id,
    });

    // Group by customer
    const customers = {};
    invoices.forEach(inv => {
      const cid = inv.customer_id;
      if (!customers[cid]) {
        customers[cid] = {
          customer_id:         cid,
          customer_name:       inv.customer_name,
          state:               inv.billing_address?.state || "",
          phone:               inv.billing_address?.phone || "",
          invoices:            [],
          total_invoiced:      0,
          total_paid:          0,
          outstanding_balance: 0,
          invoice_count:       0,
          has_overdue:         false,
          last_invoice_date:   "",
        };
      }
      const c = customers[cid];
      c.invoices.push({
        invoice_id:        inv.invoice_id,
        invoice_number:    inv.invoice_number,
        date:              inv.date,
        due_date:          inv.due_date,
        total:             inv.total,
        balance:           inv.balance,
        status:            inv.status,
        last_payment_date: inv.last_payment_date || "",
      });
      c.total_invoiced      += inv.total || 0;
      c.outstanding_balance += inv.balance || 0;
      c.invoice_count       += 1;
      if (inv.status === "overdue") c.has_overdue = true;
      if (!c.last_invoice_date || inv.date > c.last_invoice_date) {
        c.last_invoice_date = inv.date;
      }
    });

    Object.values(customers).forEach(c => {
      c.total_paid = c.total_invoiced - c.outstanding_balance;
    });

    res.json({ customers: Object.values(customers), invoices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Payment history — derived from invoices (avoids needing customerpayments scope)
app.get("/api/payments/:customer_id", async (req, res) => {
  try {
    const { customer_id } = req.params;
    const invoices = await fetchAllPages("/invoices", "invoices", { customer_id });

    const payments = invoices
      .filter(inv => inv.total > inv.balance)
      .map(inv => ({
        invoice_id:     inv.invoice_id,
        invoice_number: inv.invoice_number,
        date:           inv.date,
        due_date:       inv.due_date,
        total:          inv.total,
        amount_paid:    parseFloat((inv.total - inv.balance).toFixed(2)),
        balance:        inv.balance,
        status:         inv.status,
      }));

    const paid = invoices.filter(i => i.status === "paid");
    const avgDays = paid.length > 0
      ? Math.round(paid.reduce((s, i) => {
          return s + Math.abs(Math.floor((new Date(i.due_date) - new Date(i.date)) / 86400000));
        }, 0) / paid.length)
      : null;

    res.json({
      payments,
      summary: {
        total_invoices:    invoices.length,
        paid_invoices:     paid.length,
        avg_days_to_pay:   avgDays,
        total_paid:        parseFloat(invoices.reduce((s, i) => s + (i.total - i.balance), 0).toFixed(2)),
        total_outstanding: parseFloat(invoices.reduce((s, i) => s + i.balance, 0).toFixed(2)),
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All salespeople summary (for leaderboard)
app.get("/api/leaderboard", async (_, res) => {
  try {
    const invoices = await fetchAllPages("/invoices", "invoices");
    const map = {};
    invoices.forEach(inv => {
      const sp = inv.salesperson_name;
      if (!sp) return;
      if (!map[sp]) map[sp] = { name: sp, outstanding: 0, total: 0, count: 0 };
      map[sp].outstanding += inv.balance || 0;
      map[sp].total       += inv.total   || 0;
      map[sp].count       += 1;
    });
    const exclude = ["Office", "Wholesale"];
    const board = Object.values(map)
      .filter(s => !exclude.includes(s.name))
      .sort((a, b) => a.outstanding - b.outstanding);
    res.json({ leaderboard: board });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Bash Collections API running on port ${PORT}`));
