const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ── Zoho credentials ──────────────────────────────────────────
const ZOHO_CLIENT_ID     = "1000.0O68U7O5KE0ZII98X11HS0XU1B4JPA";
const ZOHO_CLIENT_SECRET = "d9439eef9ef7235ff17653536e2c7eca0dd4f5f8bd";
const ZOHO_REFRESH_TOKEN = "1000.719ab5d5ba2243b659ff6edecdff9afd.7a73edb52fa415012b98ccc384a0c8a7";
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

app.get("/health", (_, res) => res.json({ ok: true }));

// All invoices for a salesperson grouped by customer
app.get("/api/invoices/:salesperson_id", async (req, res) => {
  try {
    const { salesperson_id } = req.params;
    const invoices = await fetchAllPages("/invoices", "invoices", { salesperson_id });

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
      if (!c.last_invoice_date || inv.date > c.last_invoice_date)
        c.last_invoice_date = inv.date;
    });

    Object.values(customers).forEach(c => {
      c.total_paid = c.total_invoiced - c.outstanding_balance;
    });

    res.json({ customers: Object.values(customers), invoices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full transaction history for a customer
// Returns invoices + credit notes + payments in one unified list
app.get("/api/transactions/:customer_id", async (req, res) => {
  try {
    const { customer_id } = req.params;

    // Fetch all three in parallel
    const [invoices, creditNotes, payments] = await Promise.all([
      fetchAllPages("/invoices", "invoices", { customer_id }),
      fetchAllPages("/creditnotes", "creditnotes", { customer_id }),
      fetchAllPages("/customerpayments", "customerpayments", { customer_id }),
    ]);

    // Normalize invoices
    const invItems = invoices.map(i => ({
      type:           "invoice",
      id:             i.invoice_id,
      number:         i.invoice_number,
      date:           i.date,
      due_date:       i.due_date,
      details:        i.reference_number || "",
      amount:         i.total,
      payments:       0,
      refund:         0,
      balance:        i.balance,
      status:         i.status,
      last_payment_date: i.last_payment_date || "",
    }));

    // Normalize credit notes
    const cnItems = creditNotes.map(cn => ({
      type:     "creditnote",
      id:       cn.creditnote_id,
      number:   cn.creditnote_number,
      date:     cn.date,
      due_date: "",
      details:  cn.reference_number || "",
      amount:   0,
      payments: 0,
      refund:   cn.total,
      balance:  0,
      status:   cn.status,
      last_payment_date: "",
    }));

    // Normalize payments
    const payItems = payments.map(p => ({
      type:     "payment",
      id:       p.payment_id,
      number:   p.payment_number || p.reference_number || "",
      date:     p.date,
      due_date: "",
      details:  p.reference_number || p.description || "",
      amount:   0,
      payments: p.amount,
      refund:   0,
      balance:  0,
      status:   "paid",
      last_payment_date: "",
    }));

    // Combine and sort by date descending
    const all = [...invItems, ...cnItems, ...payItems]
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    // Summary totals
    const totalInvoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const totalPaid     = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const totalCN       = creditNotes.reduce((s, cn) => s + (cn.total || 0), 0);
    const balanceDue    = invoices.reduce((s, i) => s + (i.balance || 0), 0);

    res.json({
      transactions: all,
      summary: {
        total_invoiced: parseFloat(totalInvoiced.toFixed(2)),
        total_paid:     parseFloat(totalPaid.toFixed(2)),
        total_cn:       parseFloat(totalCN.toFixed(2)),
        balance_due:    parseFloat(balanceDue.toFixed(2)),
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Bash Sales API running on port ${PORT}`));
