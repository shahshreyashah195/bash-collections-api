const express  = require("express");
const cors     = require("cors");
const axios    = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(cors());
app.use(express.json());

// ── Zoho credentials ──────────────────────────────────────
const ZOHO_CLIENT_ID     = "1000.0O68U7O5KE0ZII98X11HS0XU1B4JPA";
const ZOHO_CLIENT_SECRET = "d9439eef9ef7235ff17653536e2c7eca0dd4f5f8bd";
const ZOHO_REFRESH_TOKEN = "1000.719ab5d5ba2243b659ff6edecdff9afd.7a73edb52fa415012b98ccc384a0c8a7";
const ZOHO_ORG_ID        = "60067759868";
const ZOHO_API_BASE      = "https://www.zohoapis.in/inventory/v1";
const ZOHO_AUTH_URL      = "https://accounts.zoho.in/oauth/v2/token";

// ── MongoDB ───────────────────────────────────────────────
const MONGO_URI = "mongodb+srv://bashsales:zz44%40Shreya@cluster0.ayelkf0.mongodb.net/bashsales?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI).then(() => console.log("MongoDB connected")).catch(e => console.error("MongoDB error:", e.message));

// Reminder schema
const reminderSchema = new mongoose.Schema({
  salesperson_id:   String,
  salesperson_name: String,
  customer_id:      String,
  customer_name:    String,
  date:             String,   // YYYY-MM-DD
  kept:             { type: Boolean, default: false },
  created_at:       { type: Date, default: Date.now },
  updated_at:       { type: Date, default: Date.now },
});
reminderSchema.index({ salesperson_id: 1, customer_id: 1 });
const Reminder = mongoose.model("Reminder", reminderSchema);

// ── Zoho Token cache ──────────────────────────────────────
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

// ── ROUTES: Health ────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));

// ── ROUTES: Invoices (salesperson) ────────────────────────
app.get("/api/invoices/:salesperson_id", async (req, res) => {
  try {
    const { salesperson_id } = req.params;
    const invoices = await fetchAllPages("/invoices", "invoices", { salesperson_id });

    const customers = {};
    invoices.forEach(inv => {
      const cid = inv.customer_id;
      if (!customers[cid]) {
        customers[cid] = {
          customer_id: cid, customer_name: inv.customer_name,
          state: inv.billing_address?.state || "",
          phone: inv.billing_address?.phone || "",
          invoices: [], total_invoiced: 0, total_paid: 0,
          outstanding_balance: 0, invoice_count: 0,
          has_overdue: false, last_invoice_date: "",
        };
      }
      const c = customers[cid];
      c.invoices.push({
        invoice_id: inv.invoice_id, invoice_number: inv.invoice_number,
        date: inv.date, due_date: inv.due_date, total: inv.total,
        balance: inv.balance, status: inv.status,
        last_payment_date: inv.last_payment_date || "",
      });
      c.total_invoiced += inv.total || 0;
      c.outstanding_balance += inv.balance || 0;
      c.invoice_count += 1;
      if (inv.status === "overdue") c.has_overdue = true;
      if (!c.last_invoice_date || inv.date > c.last_invoice_date) c.last_invoice_date = inv.date;
    });

    Object.values(customers).forEach(c => { c.total_paid = c.total_invoiced - c.outstanding_balance; });
    res.json({ customers: Object.values(customers), invoices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ROUTES: Transactions ──────────────────────────────────
app.get("/api/transactions/:customer_id", async (req, res) => {
  try {
    const { customer_id } = req.params;
    const [invoices, creditNotes, payments, contactData] = await Promise.all([
      fetchAllPages("/invoices", "invoices", { customer_id }),
      fetchAllPages("/creditnotes", "creditnotes", { customer_id }),
      fetchAllPages("/customerpayments", "customerpayments", { customer_id }),
      zoho(`/contacts/${customer_id}`).catch(() => ({})),
    ]);
    const openingBalance = contactData?.contact?.opening_balance_amount || 0;
    const customerName   = contactData?.contact?.contact_name || "";
    const gstNo          = contactData?.contact?.gst_no || "";
    const billingAddr    = contactData?.contact?.billing_address || {};

    const invItems = invoices.map(i => ({
      type: "invoice", id: i.invoice_id, number: i.invoice_number,
      date: i.date, due_date: i.due_date, details: i.reference_number || "",
      amount: i.total, payments: 0, refund: 0, balance: i.balance,
      status: i.status, last_payment_date: i.last_payment_date || "",
    }));
    const cnItems = creditNotes.map(cn => ({
      type: "creditnote", id: cn.creditnote_id, number: cn.creditnote_number,
      date: cn.date, due_date: "", details: cn.reference_number || "",
      amount: 0, payments: 0, refund: cn.total, balance: 0,
      status: cn.status, last_payment_date: "",
    }));
    const payItems = payments.map(p => ({
      type: "payment", id: p.payment_id, number: p.payment_number || p.reference_number || "",
      date: p.date, due_date: "", details: p.reference_number || p.description || "",
      amount: 0, payments: p.amount, refund: 0, balance: 0,
      status: "paid", last_payment_date: "",
    }));

    const all = [...invItems, ...cnItems, ...payItems].sort((a, b) => new Date(b.date) - new Date(a.date));
    const totalInvoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const totalPaid     = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const totalCN       = creditNotes.reduce((s, cn) => s + (cn.total || 0), 0);
    const balanceDue    = invoices.reduce((s, i) => s + (i.balance || 0), 0);

    res.json({
      transactions: all,
      summary: {
        opening_balance: +openingBalance.toFixed(2),
        total_invoiced:  +totalInvoiced.toFixed(2),
        total_paid:      +totalPaid.toFixed(2),
        total_cn:        +totalCN.toFixed(2),
        balance_due:     +(openingBalance + totalInvoiced - totalPaid - totalCN).toFixed(2),
      },
      customer_detail: {
        name:    customerName,
        gst_no:  gstNo,
        address: billingAddr,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ROUTES: Reminders ─────────────────────────────────────

// Get reminders for a salesperson
app.get("/api/reminders/:salesperson_id", async (req, res) => {
  try {
    const reminders = await Reminder.find({ salesperson_id: req.params.salesperson_id });
    res.json({ reminders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save or update a reminder
app.post("/api/reminders", async (req, res) => {
  try {
    const { salesperson_id, salesperson_name, customer_id, customer_name, date, kept } = req.body;
    const existing = await Reminder.findOne({ salesperson_id, customer_id });
    if (existing) {
      existing.date = date;
      existing.kept = kept || false;
      existing.customer_name = customer_name || existing.customer_name;
      existing.updated_at = new Date();
      await existing.save();
      res.json({ reminder: existing, updated: true });
    } else {
      const reminder = new Reminder({ salesperson_id, salesperson_name, customer_id, customer_name, date, kept: kept || false });
      await reminder.save();
      res.json({ reminder, updated: false });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk sync — salesman sends all their local reminders
app.post("/api/reminders/sync", async (req, res) => {
  try {
    const { salesperson_id, salesperson_name, reminders } = req.body;
    const results = [];
    for (const r of reminders) {
      const existing = await Reminder.findOne({ salesperson_id, customer_id: r.customer_id });
      if (existing) {
        // Only update if local is newer
        if (new Date(r.updated_at || 0) >= new Date(existing.updated_at || 0)) {
          existing.date = r.date;
          existing.kept = r.kept;
          existing.customer_name = r.customer_name || existing.customer_name;
          existing.updated_at = new Date();
          await existing.save();
          results.push(existing);
        } else {
          results.push(existing);
        }
      } else {
        const newR = new Reminder({
          salesperson_id, salesperson_name,
          customer_id: r.customer_id, customer_name: r.customer_name,
          date: r.date, kept: r.kept,
        });
        await newR.save();
        results.push(newR);
      }
    }
    res.json({ synced: results.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ROUTES: Admin ─────────────────────────────────────────

// All invoices across all salespeople (for admin dashboard)
app.get("/api/admin/overview", async (req, res) => {
  try {
    const invoices = await fetchAllPages("/invoices", "invoices");

    // Group by salesperson
    const salespeople = {};
    const allCustomers = {};
    const exclude = ["Office", "Wholesale"];

    invoices.forEach(inv => {
      const sp = inv.salesperson_name;
      if (!sp || exclude.includes(sp)) return;
      const sid = inv.salesperson_id;

      if (!salespeople[sid]) {
        salespeople[sid] = {
          id: sid, name: sp,
          total_invoiced: 0, outstanding: 0, paid: 0,
          invoice_count: 0, customer_ids: new Set(),
        };
      }
      const s = salespeople[sid];
      s.total_invoiced += inv.total || 0;
      s.outstanding += inv.balance || 0;
      s.invoice_count += 1;
      s.customer_ids.add(inv.customer_id);

      // Track all customers
      const cid = inv.customer_id;
      if (!allCustomers[cid]) {
        allCustomers[cid] = {
          customer_id: cid, customer_name: inv.customer_name,
          state: inv.billing_address?.state || "",
          salesperson: sp, salesperson_id: sid,
          total_invoiced: 0, outstanding: 0, max_overdue_days: 0,
        };
      }
      const c = allCustomers[cid];
      c.total_invoiced += inv.total || 0;
      c.outstanding += inv.balance || 0;
      if (inv.balance > 0 && inv.due_date) {
        const days = Math.floor((Date.now() - new Date(inv.due_date)) / 86400000);
        if (days > c.max_overdue_days) c.max_overdue_days = days;
      }
    });

    // Convert Sets to counts
    Object.values(salespeople).forEach(s => {
      s.customer_count = s.customer_ids.size;
      s.paid = s.total_invoiced - s.outstanding;
      delete s.customer_ids;
    });

    // Sort salespeople by outstanding desc
    const spList = Object.values(salespeople).sort((a, b) => b.outstanding - a.outstanding);

    // Company totals
    const totalInvoiced = spList.reduce((s, sp) => s + sp.total_invoiced, 0);
    const totalOutstanding = spList.reduce((s, sp) => s + sp.outstanding, 0);
    const totalPaid = spList.reduce((s, sp) => s + sp.paid, 0);

    // Avg days to pay
    let daysSum = 0, daysCt = 0;
    invoices.forEach(inv => {
      if (inv.status === "paid" && inv.date && inv.last_payment_date) {
        const d = Math.floor((new Date(inv.last_payment_date) - new Date(inv.date)) / 86400000);
        if (d >= 0) { daysSum += d; daysCt++; }
      }
    });
    const avgDays = daysCt > 0 ? Math.round(daysSum / daysCt) : 0;

    // Top overdue customers
    const topOverdue = Object.values(allCustomers)
      .filter(c => c.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 10);

    const topOverdueDays = Object.values(allCustomers)
      .filter(c => c.max_overdue_days > 0)
      .sort((a, b) => b.max_overdue_days - a.max_overdue_days)
      .slice(0, 10);

    // Aging buckets — from invoice date (matches Zoho)
    const aging = { "0-30": 0, "30-60": 0, "60-90": 0, "90-120": 0, "120-150": 0, "150+": 0 };
    invoices.forEach(inv => {
      if (inv.balance <= 0 || !inv.date) return;
      const days = Math.floor((Date.now() - new Date(inv.date)) / 86400000);
      if (days < 30) aging["0-30"] += inv.balance;
      else if (days < 60) aging["30-60"] += inv.balance;
      else if (days < 90) aging["60-90"] += inv.balance;
      else if (days < 120) aging["90-120"] += inv.balance;
      else if (days < 150) aging["120-150"] += inv.balance;
      else aging["150+"] += inv.balance;
    });

    res.json({
      totals: { total_invoiced: totalInvoiced, total_outstanding: totalOutstanding, total_paid: totalPaid, avg_days: avgDays },
      salespeople: spList,
      top_overdue_amount: topOverdue,
      top_overdue_days: topOverdueDays,
      aging,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All reminders (for admin)
app.get("/api/admin/reminders", async (req, res) => {
  try {
    const reminders = await Reminder.find({}).sort({ date: 1 });
    res.json({ reminders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Bash Sales API running on port ${PORT}`));
