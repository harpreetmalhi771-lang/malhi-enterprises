require("dotenv").config();

const express = require("express");

const cors = require("cors");

const path = require("path");

const { Pool } = require("pg");

const { AsyncLocalStorage } = require("async_hooks");



const app = express();

const PORT = Number(process.env.PORT || 3000);



app.use(cors());

app.use(express.json({ limit: "5mb" }));

app.use(express.static(__dirname));



if (!process.env.DATABASE_URL) {

  console.error("DATABASE_URL is required. Create a PostgreSQL database and set DATABASE_URL.");

  process.exit(1);

}



const txStorage = new AsyncLocalStorage();



const pool = new Pool({

  connectionString: process.env.DATABASE_URL,

  ssl: process.env.DATABASE_URL.includes("neon.tech") || process.env.NODE_ENV === "production"

    ? { rejectUnauthorized: false }

    : false,

  max: Number(process.env.PG_POOL_MAX || 5),

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000

});



function pgSql(sql) {

  let index = 0;

  return String(sql).replace(/**\\?**/g, () => `$${++index}`);

}



function executor() {

  return txStorage.getStore() || pool;

}



async function run(sql, params = []) {

  const result = await executor().query(pgSql(sql), params);

  return { lastID: result.rows[0]?.id ?? null, changes: result.rowCount };

}



async function get(sql, params = []) {

  const result = await executor().query(pgSql(sql), params);

  return result.rows[0] || null;

}



async function all(sql, params = []) {

  const result = await executor().query(pgSql(sql), params);

  return result.rows || [];

}



async function transaction(work) {

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const result = await txStorage.run(client, work);

    await client.query("COMMIT");

    return result;

  } catch (error) {

    try { await client.query("ROLLBACK"); } catch (_) {}

    throw error;

  } finally {

    client.release();

  }

}



function ok(res, data = {}) {

  return res.json({ success: true, ...data });

}



function fail(res, error, status = 500) {

  console.error(error);

  return res.status(status).json({

    success: false,

    error: error.message || String(error)

  });

}



function digits(value) {

  return String(value || "").replace(/\D/g, "");

}



function phonesMatch(a, b) {

  const da = digits(a);

  const db = digits(b);

  if (!da || !db) return false;

  return da === db || da.slice(-10) === db.slice(-10);

}



function todayISO() {

  const d = new Date();

  return [

    d.getFullYear(),

    String(d.getMonth() + 1).padStart(2, "0"),

    String(d.getDate()).padStart(2, "0")

  ].join("-");

}



function addMonths(iso, n) {

  if (!iso) return "";

  const [y, m, d] = String(iso).split("-").map(Number);

  const dt = new Date(y, m - 1 + Number(n || 0), 1);

  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();

  dt.setDate(Math.min(d, last));

  return [

    dt.getFullYear(),

    String(dt.getMonth() + 1).padStart(2, "0"),

    String(dt.getDate()).padStart(2, "0")

  ].join("-");

}



function dateDiffDays(fromISO, toISO) {

  const a = new Date(`${fromISO}T00:00:00`);

  const b = new Date(`${toISO}T00:00:00`);

  return Math.floor((b - a) / 86400000);

}



function round2(value) {

  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

}



function calcInterest(principal, rate, term, method) {

  const p = Number(principal) || 0;

  const r = Number(rate) || 0;

  const t = Number(term) || 0;



  if (p <= 0 || t <= 0) return 0;



  if (String(method).toUpperCase() === "FLAT_TOTAL") {

    return round2(p * r);

  }



  return round2(p * r * (t / 12));

}



const DEFAULT_SETTINGS = {

  business: "Malhi Enterprise",

  currency: "INR",

  symbol: "₹",

  method: "FLAT_ANNUAL",

  defaultRate: 0.10,

  defaultTerm: 24,

  dueSoonDays: 7,

  autoBackup: true

};



async function initializeDatabase() {

  await run(`

    CREATE TABLE IF NOT EXISTS settings (

      id INTEGER PRIMARY KEY CHECK (id = 1),

      business TEXT NOT NULL DEFAULT 'Malhi Enterprise',

      currency TEXT NOT NULL DEFAULT 'INR',

      symbol TEXT NOT NULL DEFAULT '₹',

      method TEXT NOT NULL DEFAULT 'FLAT_ANNUAL',

      defaultRate DOUBLE PRECISION NOT NULL DEFAULT 0.10,

      defaultTerm INTEGER NOT NULL DEFAULT 24,

      dueSoonDays INTEGER NOT NULL DEFAULT 7,

      autoBackup INTEGER NOT NULL DEFAULT 1,

      updatedAt TEXT

    )

  `);



  await run(`

    CREATE TABLE IF NOT EXISTS customers (

      id TEXT PRIMARY KEY,

      name TEXT NOT NULL,

      phone TEXT NOT NULL,

      alt TEXT DEFAULT '',

      address TEXT DEFAULT '',

      city TEXT DEFAULT '',

      notes TEXT DEFAULT '',

      createdAt TEXT,

      updatedAt TEXT

    )

  `);



  await run(`

    CREATE TABLE IF NOT EXISTS products (

      code TEXT PRIMARY KEY,

      name TEXT NOT NULL,

      model TEXT DEFAULT '',

      category TEXT DEFAULT 'Scooter',

      cost DOUBLE PRECISION NOT NULL DEFAULT 0,

      price DOUBLE PRECISION NOT NULL DEFAULT 0,

      active INTEGER NOT NULL DEFAULT 1,

      createdAt TEXT,

      updatedAt TEXT

    )

  `);



  await run(`

    CREATE TABLE IF NOT EXISTS sales (

      id TEXT PRIMARY KEY,

      custId TEXT NOT NULL,

      name TEXT,

      phone TEXT,

      invoice TEXT,

      date TEXT,

      product TEXT,

      serial TEXT,

      qty INTEGER NOT NULL DEFAULT 1,

      price DOUBLE PRECISION NOT NULL DEFAULT 0,

      discount DOUBLE PRECISION NOT NULL DEFAULT 0,

      advance DOUBLE PRECISION NOT NULL DEFAULT 0,

      rate DOUBLE PRECISION NOT NULL DEFAULT 0,

      term INTEGER NOT NULL DEFAULT 0,

      firstDue TEXT,

      notes TEXT DEFAULT '',

      createdAt TEXT,

      updatedAt TEXT

    )

  `);



  await run(`

    CREATE TABLE IF NOT EXISTS payments (

      id TEXT PRIMARY KEY,

      date TEXT,

      custId TEXT,

      name TEXT,

      phone TEXT,

      saleId TEXT,

      invoice TEXT,

      amount DOUBLE PRECISION NOT NULL DEFAULT 0,

      method TEXT DEFAULT 'Cash',

      category TEXT DEFAULT 'INSTALLMENT',

      notes TEXT DEFAULT '',

      createdAt TEXT,

      updatedAt TEXT

    )

  `);



  await run(`

    CREATE TABLE IF NOT EXISTS audit (

      id BIGSERIAL PRIMARY KEY,

      action TEXT,

      entity TEXT,

      entityId TEXT,

      details TEXT,

      createdAt TEXT

    )

  `);



  const setting = await get("SELECT id FROM settings WHERE id = 1");

  if (!setting) {

    await run(

      `INSERT INTO settings

       (id,business,currency,symbol,method,defaultRate,defaultTerm,dueSoonDays,autoBackup,updatedAt)

       VALUES (1,?,?,?,?,?,?,?,?,?)`,

      [

        DEFAULT_SETTINGS.business,

        DEFAULT_SETTINGS.currency,

        DEFAULT_SETTINGS.symbol,

        DEFAULT_SETTINGS.method,

        DEFAULT_SETTINGS.defaultRate,

        DEFAULT_SETTINGS.defaultTerm,

        DEFAULT_SETTINGS.dueSoonDays,

        DEFAULT_SETTINGS.autoBackup ? 1 : 0,

        new Date().toISOString()

      ]

    );

  }

}



async function getSettings() {

  const row = await get("SELECT * FROM settings WHERE id = 1");

  if (!row) return { ...DEFAULT_SETTINGS };



  return {

    business: row.business,

    currency: row.currency,

    symbol: row.symbol,

    method: row.method,

    defaultRate: Number(row.defaultRate),

    defaultTerm: Number(row.defaultTerm),

    dueSoonDays: Number(row.dueSoonDays),

    autoBackup: Boolean(row.autoBackup)

  };

}



async function getProduct(code) {

  return get("SELECT * FROM products WHERE code = ?", [code]);

}



async function getSale(id) {

  return get("SELECT * FROM sales WHERE id = ?", [id]);

}



async function getPaymentsForSale(saleId) {

  return all(

    "SELECT * FROM payments WHERE saleId = ? ORDER BY date ASC, id ASC",

    [saleId]

  );

}



async function calculateSale(sale) {

  const settings = await getSettings();

  const product = await getProduct(sale.product);

  const payments = await getPaymentsForSale(sale.id);



  const qty = Number(sale.qty) || 1;

  const price = Number(sale.price) || 0;

  const discount = Number(sale.discount) || 0;

  const advance = Number(sale.advance) || 0;

  const term = Number(sale.term) || 0;

  const rate = Number(sale.rate) || 0;



  const invoice = round2(Math.max(0, qty * price - discount));

  const financed = round2(Math.max(0, invoice - advance));

  const interest = calcInterest(financed, rate, term, settings.method);

  const repay = financed > 0 ? round2(financed + interest) : 0;

  const monthly = term > 0 && repay > 0

    ? round2(repay / term)

    : 0;



  const received = round2(

    payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)

  );



  const outstanding = round2(

    Math.max(0, invoice + interest - received)

  );



  const productCost = product ? Number(product.cost || 0) : 0;

  const productProfit = round2(invoice - productCost * qty);



  return {

    sale,

    product,

    invoice,

    financed,

    interest,

    repay,

    monthly,

    received,

    outstanding,

    productProfit,

    financeProfit: interest,

    payments

  };

}



async function calculateSchedule(sale) {

  const f = await calculateSale(sale);



  if (

    f.financed <= 0 ||

    Number(sale.term) <= 0 ||

    !sale.firstDue

  ) {

    return [];

  }



  const rows = [];

  const today = todayISO();



  let remainingCash = round2(

    f.payments

      .filter(p => String(p.category).toUpperCase() !== "DEPOSIT")

      .reduce((sum, p) => sum + Number(p.amount || 0), 0)

  );



  for (let i = 1; i <= Number(sale.term); i++) {

    const due = addMonths(sale.firstDue, i - 1);



    const expected =

      i === Number(sale.term)

        ? round2(f.repay - f.monthly * (Number(sale.term) - 1))

        : f.monthly;



    const allocated = round2(

      Math.max(0, Math.min(expected, remainingCash))

    );



    remainingCash = round2(remainingCash - allocated);



    const left = round2(Math.max(0, expected - allocated));



    const overdueDays =

      left > 0.009 && due < today

        ? dateDiffDays(due, today)

        : 0;



    let status = "UPCOMING";



    if (left <= 0.009) status = "PAID";

    else if (allocated > 0.009 && due < today) status = "PARTIAL";

    else if (due === today) status = "DUE TODAY";

    else if (due < today) status = "OVERDUE";



    rows.push({

      installment: i,

      due,

      expected,

      allocated,

      left,

      overdueDays,

      status

    });

  }



  return rows;

}



async function getSaleStatus(sale) {

  const f = await calculateSale(sale);



  if (f.outstanding <= 0.009) {

    return "PAID IN FULL";

  }



  const schedule = await calculateSchedule(sale);



  if (

    schedule.some(

      x => x.status === "OVERDUE" ||

           (x.status === "PARTIAL" && x.overdueDays > 0)

    )

  ) {

    return "OVERDUE";

  }



  if (schedule.some(x => x.status === "DUE TODAY")) {

    return "DUE TODAY";

  }



  if (f.financed > 0) return "CURRENT";



  return "CASH";

}



async function enrichSale(sale) {

  const finance = await calculateSale(sale);

  const status = await getSaleStatus(sale);



  return {

    ...sale,

    ...finance,

    productName: finance.product ? finance.product.name : sale.product,

    status

  };

}



async function logAudit(action, entity, entityId, details = {}) {

  await run(

    `INSERT INTO audit (action,entity,entityId,details,createdAt)

     VALUES (?,?,?,?,?)`,

    [

      action,

      entity,

      entityId,

      JSON.stringify(details),

      new Date().toISOString()

    ]

  );

}



/* =========================================================

   HEALTH

   ========================================================= */



app.get("/api/health", async (req, res) => {

  try {

    await get("SELECT 1 AS ok");

    ok(res, {

      message: "Malhi Enterprise API is running",

      database: "connected",

      currency: "INR"

    });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   SETTINGS

   ========================================================= */



app.get("/api/settings", async (req, res) => {

  try {

    ok(res, { settings: await getSettings() });

  } catch (error) {

    fail(res, error);

  }

});



app.put("/api/settings", async (req, res) => {

  try {

    const body = req.body || {};

    const current = await getSettings();



    const settings = {

      business: String(body.business ?? current.business).trim() || "Malhi Enterprise",

      currency: String(body.currency ?? current.currency).trim().toUpperCase() || "INR",

      symbol: String(body.symbol ?? current.symbol).trim() || "₹",

      method: String(body.method ?? current.method).toUpperCase(),

      defaultRate: Number(body.defaultRate ?? current.defaultRate) || 0,

      defaultTerm: Number(body.defaultTerm ?? current.defaultTerm) || 24,

      dueSoonDays: Number(body.dueSoonDays ?? current.dueSoonDays) || 7,

      autoBackup:

        body.autoBackup === undefined

          ? current.autoBackup

          : Boolean(body.autoBackup)

    };



    if (!["FLAT_ANNUAL", "FLAT_TOTAL"].includes(settings.method)) {

      return fail(res, new Error("Invalid interest method"), 400);

    }



    await run(

      `UPDATE settings SET

        business=?,

        currency=?,

        symbol=?,

        method=?,

        defaultRate=?,

        defaultTerm=?,

        dueSoonDays=?,

        autoBackup=?,

        updatedAt=?

       WHERE id=1`,

      [

        settings.business,

        settings.currency,

        settings.symbol,

        settings.method,

        settings.defaultRate,

        settings.defaultTerm,

        settings.dueSoonDays,

        settings.autoBackup ? 1 : 0,

        new Date().toISOString()

      ]

    );



    await logAudit("UPDATE", "settings", "1", settings);



    ok(res, { settings });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   CUSTOMERS

   ========================================================= */



app.get("/api/customers", async (req, res) => {

  try {

    const search = String(req.query.search || "").trim();



    let customers;



    if (search) {

      const d = `%${digits(search)}%`;

      const text = `%${search}%`;



      customers = await all(

        `SELECT * FROM customers

         WHERE name LIKE ?

            OR city LIKE ?

            OR phone LIKE ?

            OR alt LIKE ?

         ORDER BY name ASC`,

        [text, text, d, d]

      );

    } else {

      customers = await all(

        "SELECT * FROM customers ORDER BY name ASC"

      );

    }



    const result = [];



    for (const customer of customers) {

      const sales = await all(

        "SELECT * FROM sales WHERE custId = ? ORDER BY date DESC, id DESC",

        [customer.id]

      );



      let outstanding = 0;

      let overdue = false;



      for (const sale of sales) {

        const f = await calculateSale(sale);

        outstanding += f.outstanding;



        const status = await getSaleStatus(sale);

        if (status === "OVERDUE") overdue = true;

      }



      result.push({

        ...customer,

        salesCount: sales.length,

        outstanding: round2(outstanding),

        status:

          overdue

            ? "OVERDUE"

            : sales.length === 0

              ? "—"

              : outstanding <= 0.009

                ? "PAID IN FULL"

                : "CURRENT"

      });

    }



    ok(res, { customers: result });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/customers/:id", async (req, res) => {

  try {

    const customer = await get(

      "SELECT * FROM customers WHERE id = ?",

      [req.params.id]

    );



    if (!customer) {

      return fail(res, new Error("Customer not found"), 404);

    }



    const sales = await all(

      "SELECT * FROM sales WHERE custId = ? ORDER BY date DESC, id DESC",

      [customer.id]

    );



    const enrichedSales = [];

    let outstanding = 0;



    for (const sale of sales) {

      const enriched = await enrichSale(sale);

      outstanding += enriched.outstanding;

      enrichedSales.push(enriched);

    }



    const payments = await all(

      "SELECT * FROM payments WHERE custId = ? ORDER BY date DESC, id DESC",

      [customer.id]

    );



    ok(res, {

      customer,

      sales: enrichedSales,

      payments,

      outstanding: round2(outstanding)

    });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/customers/search/phone/:phone", async (req, res) => {

  try {

    const phone = req.params.phone;

    const customers = await all(

      `SELECT * FROM customers

       WHERE phone LIKE ? OR alt LIKE ?

       ORDER BY name ASC`,

      [`%${digits(phone).slice(-10)}%`, `%${digits(phone).slice(-10)}%`]

    );



    const matched = customers.find(c =>

      phonesMatch(c.phone, phone) || phonesMatch(c.alt, phone)

    );



    if (!matched) {

      return fail(res, new Error("Customer not found"), 404);

    }



    res.json({ success: true, customer: matched });

  } catch (error) {

    fail(res, error);

  }

});



app.post("/api/customers", async (req, res) => {

  try {

    const c = req.body || {};



    if (!c.name || !c.phone) {

      return fail(res, new Error("Name and phone are required"), 400);

    }



    const id =

      c.id ||

      `C${String(Date.now()).slice(-8)}`;



    const now = new Date().toISOString();



    await run(

      `INSERT INTO customers

       (id,name,phone,alt,address,city,notes,createdAt,updatedAt)

       VALUES (?,?,?,?,?,?,?,?,?)`,

      [

        id,

        c.name.trim(),

        c.phone.trim(),

        c.alt || "",

        c.address || "",

        c.city || "",

        c.notes || "",

        now,

        now

      ]

    );



    const customer = await get(

      "SELECT * FROM customers WHERE id = ?",

      [id]

    );



    await logAudit("CREATE", "customer", id, customer);



    ok(res, { customer });

  } catch (error) {

    fail(res, error, (error.code === "23505" || error.code === "23503") ? 409 : 500);

  }

});



app.put("/api/customers/:id", async (req, res) => {

  try {

    const existing = await get(

      "SELECT * FROM customers WHERE id = ?",

      [req.params.id]

    );



    if (!existing) {

      return fail(res, new Error("Customer not found"), 404);

    }



    const c = { ...existing, ...(req.body || {}) };



    await run(

      `UPDATE customers SET

        name=?,

        phone=?,

        alt=?,

        address=?,

        city=?,

        notes=?,

        updatedAt=?

       WHERE id=?`,

      [

        c.name,

        c.phone,

        c.alt || "",

        c.address || "",

        c.city || "",

        c.notes || "",

        new Date().toISOString(),

        req.params.id

      ]

    );



    const customer = await get(

      "SELECT * FROM customers WHERE id = ?",

      [req.params.id]

    );



    await logAudit("UPDATE", "customer", req.params.id, customer);



    ok(res, { customer });

  } catch (error) {

    fail(res, error);

  }

});



app.delete("/api/customers/:id", async (req, res) => {

  try {

    const customer = await get(

      "SELECT * FROM customers WHERE id = ?",

      [req.params.id]

    );



    if (!customer) {

      return fail(res, new Error("Customer not found"), 404);

    }



    const saleCount = await get(

      "SELECT COUNT(*) AS count FROM sales WHERE custId = ?",

      [req.params.id]

    );



    if (Number(saleCount.count) > 0) {

      return fail(

        res,

        new Error("Cannot delete a customer with sales. Archive it instead."),

        409

      );

    }



    await run("DELETE FROM customers WHERE id = ?", [req.params.id]);

    await logAudit("DELETE", "customer", req.params.id, customer);



    ok(res);

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   PRODUCTS

   ========================================================= */



app.get("/api/products", async (req, res) => {

  try {

    const includeInactive = String(req.query.includeInactive || "") === "true";



    const products = await all(

      includeInactive

        ? "SELECT * FROM products ORDER BY name ASC"

        : "SELECT * FROM products WHERE active = 1 ORDER BY name ASC"

    );



    ok(res, {

      products: products.map(p => ({

        ...p,

        active: Boolean(p.active)

      }))

    });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/products/:code", async (req, res) => {

  try {

    const product = await getProduct(req.params.code);



    if (!product) {

      return fail(res, new Error("Product not found"), 404);

    }



    product.active = Boolean(product.active);



    ok(res, { product });

  } catch (error) {

    fail(res, error);

  }

});



app.post("/api/products", async (req, res) => {

  try {

    const p = req.body || {};



    if (!p.code || !p.name) {

      return fail(res, new Error("Product code and name are required"), 400);

    }



    const code = String(p.code).trim().toUpperCase();

    const now = new Date().toISOString();



    await run(

      `INSERT INTO products

       (code,name,model,category,cost,price,active,createdAt,updatedAt)

       VALUES (?,?,?,?,?,?,?,?,?)`,

      [

        code,

        String(p.name).trim(),

        p.model || "—",

        p.category || "Scooter",

        Number(p.cost) || 0,

        Number(p.price) || 0,

        p.active === false ? 0 : 1,

        now,

        now

      ]

    );



    const product = await getProduct(code);

    product.active = Boolean(product.active);



    await logAudit("CREATE", "product", code, product);



    ok(res, { product });

  } catch (error) {

    fail(res, error, (error.code === "23505" || error.code === "23503") ? 409 : 500);

  }

});



app.put("/api/products/:code", async (req, res) => {

  try {

    const existing = await getProduct(req.params.code);



    if (!existing) {

      return fail(res, new Error("Product not found"), 404);

    }



    const p = { ...existing, ...(req.body || {}) };



    await run(

      `UPDATE products SET

        name=?,

        model=?,

        category=?,

        cost=?,

        price=?,

        active=?,

        updatedAt=?

       WHERE code=?`,

      [

        p.name,

        p.model || "—",

        p.category || "Scooter",

        Number(p.cost) || 0,

        Number(p.price) || 0,

        p.active === false || p.active === 0 ? 0 : 1,

        new Date().toISOString(),

        req.params.code

      ]

    );



    const product = await getProduct(req.params.code);

    product.active = Boolean(product.active);



    await logAudit("UPDATE", "product", req.params.code, product);



    ok(res, { product });

  } catch (error) {

    fail(res, error);

  }

});



app.patch("/api/products/:code/toggle", async (req, res) => {

  try {

    const product = await getProduct(req.params.code);



    if (!product) {

      return fail(res, new Error("Product not found"), 404);

    }



    const active =

      req.body && req.body.active !== undefined

        ? Boolean(req.body.active)

        : !Boolean(product.active);



    await run(

      "UPDATE products SET active=?, updatedAt=? WHERE code=?",

      [active ? 1 : 0, new Date().toISOString(), req.params.code]

    );



    const updated = await getProduct(req.params.code);

    updated.active = Boolean(updated.active);



    await logAudit("TOGGLE", "product", req.params.code, updated);



    ok(res, { product: updated });

  } catch (error) {

    fail(res, error);

  }

});



app.delete("/api/products/:code", async (req, res) => {

  try {

    const product = await getProduct(req.params.code);



    if (!product) {

      return fail(res, new Error("Product not found"), 404);

    }



    const used = await get(

      "SELECT COUNT(*) AS count FROM sales WHERE product = ?",

      [req.params.code]

    );



    if (Number(used.count) > 0) {

      return fail(

        res,

        new Error("Product is already used in sales. Hide it instead of deleting it."),

        409

      );

    }



    await run("DELETE FROM products WHERE code = ?", [req.params.code]);

    await logAudit("DELETE", "product", req.params.code, product);



    ok(res);

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   SALES

   ========================================================= */



app.get("/api/sales", async (req, res) => {

  try {

    const {

      search = "",

      status = "",

      from = "",

      to = "",

      limit = "100",

      offset = "0"

    } = req.query;



    const conditions = [];

    const params = [];



    if (search) {

      conditions.push(

        `(s.id LIKE ? OR s.invoice LIKE ? OR s.name LIKE ? OR s.phone LIKE ?)`

      );

      const q = `%${search}%`;

      params.push(q, q, q, q);

    }



    if (from) {

      conditions.push("s.date >= ?");

      params.push(from);

    }



    if (to) {

      conditions.push("s.date <= ?");

      params.push(to);

    }



    const where = conditions.length

      ? `WHERE ${conditions.join(" AND ")}`

      : "";



    const sales = await all(

      `SELECT s.*,

              p.name AS productName,

              p.model AS productModel

       FROM sales s

       LEFT JOIN products p ON p.code = s.product

       ${where}

       ORDER BY s.date DESC, s.id DESC

       LIMIT ? OFFSET ?`,

      [...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0]

    );



    const result = [];



    for (const sale of sales) {

      const enriched = await enrichSale(sale);



      if (status && enriched.status !== status) continue;



      result.push(enriched);

    }



    ok(res, { sales: result });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/sales/:id", async (req, res) => {

  try {

    const sale = await getSale(req.params.id);



    if (!sale) {

      return fail(res, new Error("Sale not found"), 404);

    }



    const enriched = await enrichSale(sale);

    const schedule = await calculateSchedule(sale);



    ok(res, {

      sale: enriched,

      schedule

    });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/sales/:id/schedule", async (req, res) => {

  try {

    const sale = await getSale(req.params.id);



    if (!sale) {

      return fail(res, new Error("Sale not found"), 404);

    }



    ok(res, {

      saleId: sale.id,

      schedule: await calculateSchedule(sale)

    });

  } catch (error) {

    fail(res, error);

  }

});



app.post("/api/sales", async (req, res) => {

  try {

    const { sale, customer, deposit } = req.body || {};



    if (!sale || !customer) {

      return fail(res, new Error("Sale and customer are required"), 400);

    }



    if (!customer.name || !customer.phone) {

      return fail(res, new Error("Customer name and phone are required"), 400);

    }



    if (!sale.product) {

      return fail(res, new Error("Product is required"), 400);

    }



    if (!(Number(sale.price) > 0)) {

      return fail(res, new Error("Selling price must be greater than zero"), 400);

    }



    if (Number(sale.term) > 0 && !sale.firstDue) {

      return fail(

        res,

        new Error("First installment date is required for finance sales"),

        400

      );

    }



    const result = await transaction(async () => {

      const now = new Date().toISOString();



      const existingCustomer = await get(

        "SELECT * FROM customers WHERE id = ?",

        [customer.id]

      );



      if (existingCustomer) {

        await run(

          `UPDATE customers SET

            name=?, phone=?, alt=?, address=?, city=?, notes=?, updatedAt=?

           WHERE id=?`,

          [

            customer.name,

            customer.phone,

            customer.alt || "",

            customer.address || "",

            customer.city || "",

            customer.notes || "",

            now,

            customer.id

          ]

        );

      } else {

        await run(

          `INSERT INTO customers

           (id,name,phone,alt,address,city,notes,createdAt,updatedAt)

           VALUES (?,?,?,?,?,?,?,?,?)`,

          [

            customer.id,

            customer.name,

            customer.phone,

            customer.alt || "",

            customer.address || "",

            customer.city || "",

            customer.notes || "",

            now,

            now

          ]

        );

      }



      const saleRow = {

        ...sale,

        qty: Number(sale.qty) || 1,

        price: Number(sale.price) || 0,

        discount: Number(sale.discount) || 0,

        advance: Number(sale.advance) || 0,

        rate: Number(sale.rate) || 0,

        term: Number(sale.term) || 0

      };



      await run(

        `INSERT INTO sales

         (id,custId,name,phone,invoice,date,product,serial,qty,price,discount,advance,rate,term,firstDue,notes,createdAt,updatedAt)

         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,

        [

          saleRow.id,

          saleRow.custId || customer.id,

          saleRow.name || customer.name,

          saleRow.phone || customer.phone,

          saleRow.invoice || "",

          saleRow.date || todayISO(),

          saleRow.product,

          saleRow.serial || "",

          saleRow.qty,

          saleRow.price,

          saleRow.discount,

          saleRow.advance,

          saleRow.rate,

          saleRow.term,

          saleRow.firstDue || "",

          saleRow.notes || "",

          now,

          now

        ]

      );



      if (deposit && Number(deposit.amount) > 0) {

        await run(

          `INSERT INTO payments

           (id,date,custId,name,phone,saleId,invoice,amount,method,category,notes,createdAt,updatedAt)

           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,

          [

            deposit.id,

            deposit.date || saleRow.date,

            customer.id,

            customer.name,

            customer.phone,

            saleRow.id,

            saleRow.invoice,

            Number(deposit.amount),

            deposit.method || "Cash",

            "DEPOSIT",

            deposit.notes || `Advance on ${saleRow.invoice}`,

            now,

            now

          ]

        );

      }



      await logAudit("CREATE", "sale", saleRow.id, {

        sale: saleRow,

        customer,

        deposit: deposit || null

      });



      return saleRow;

    });



    const enriched = await enrichSale(result);



    ok(res, {

      sale: enriched,

      schedule: await calculateSchedule(result)

    });

  } catch (error) {

    fail(res, error, (error.code === "23505" || error.code === "23503") ? 409 : 500);

  }

});



app.put("/api/sales/:id", async (req, res) => {

  try {

    const existing = await getSale(req.params.id);



    if (!existing) {

      return fail(res, new Error("Sale not found"), 404);

    }



    const s = { ...existing, ...(req.body || {}) };



    await run(

      `UPDATE sales SET

        custId=?,

        name=?,

        phone=?,

        invoice=?,

        date=?,

        product=?,

        serial=?,

        qty=?,

        price=?,

        discount=?,

        advance=?,

        rate=?,

        term=?,

        firstDue=?,

        notes=?,

        updatedAt=?

       WHERE id=?`,

      [

        s.custId,

        s.name,

        s.phone,

        s.invoice,

        s.date,

        s.product,

        s.serial || "",

        Number(s.qty) || 1,

        Number(s.price) || 0,

        Number(s.discount) || 0,

        Number(s.advance) || 0,

        Number(s.rate) || 0,

        Number(s.term) || 0,

        s.firstDue || "",

        s.notes || "",

        new Date().toISOString(),

        req.params.id

      ]

    );



    const sale = await getSale(req.params.id);



    await logAudit("UPDATE", "sale", req.params.id, sale);



    ok(res, {

      sale: await enrichSale(sale),

      schedule: await calculateSchedule(sale)

    });

  } catch (error) {

    fail(res, error);

  }

});



app.delete("/api/sales/:id", async (req, res) => {

  try {

    const sale = await getSale(req.params.id);



    if (!sale) {

      return fail(res, new Error("Sale not found"), 404);

    }



    await transaction(async () => {

      await run("DELETE FROM payments WHERE saleId = ?", [req.params.id]);

      await run("DELETE FROM sales WHERE id = ?", [req.params.id]);

      await logAudit("DELETE", "sale", req.params.id, sale);

    });



    ok(res);

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   PAYMENTS

   ========================================================= */



app.get("/api/payments", async (req, res) => {

  try {

    const {

      search = "",

      saleId = "",

      custId = "",

      method = "",

      category = "",

      from = "",

      to = "",

      limit = "200",

      offset = "0"

    } = req.query;



    const conditions = [];

    const params = [];



    if (search) {

      const q = `%${search}%`;

      conditions.push("(name LIKE ? OR phone LIKE ? OR invoice LIKE ? OR id LIKE ?)");

      params.push(q, q, q, q);

    }



    if (saleId) {

      conditions.push("saleId = ?");

      params.push(saleId);

    }



    if (custId) {

      conditions.push("custId = ?");

      params.push(custId);

    }



    if (method) {

      conditions.push("method = ?");

      params.push(method);

    }



    if (category) {

      conditions.push("category = ?");

      params.push(category);

    }



    if (from) {

      conditions.push("date >= ?");

      params.push(from);

    }



    if (to) {

      conditions.push("date <= ?");

      params.push(to);

    }



    const where = conditions.length

      ? `WHERE ${conditions.join(" AND ")}`

      : "";



    const payments = await all(

      `SELECT * FROM payments

       ${where}

       ORDER BY date DESC, id DESC

       LIMIT ? OFFSET ?`,

      [...params, Math.min(Number(limit) || 200, 1000), Number(offset) || 0]

    );



    const totals = await get(

      `SELECT

         COALESCE(SUM(amount),0) AS total,

         COUNT(*) AS count

       FROM payments

       ${where}`,

      params

    );



    ok(res, {

      payments,

      totals: {

        total: Number(totals.total || 0),

        count: Number(totals.count || 0)

      }

    });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/payments/:id", async (req, res) => {

  try {

    const payment = await get(

      "SELECT * FROM payments WHERE id = ?",

      [req.params.id]

    );



    if (!payment) {

      return fail(res, new Error("Payment not found"), 404);

    }



    ok(res, { payment });

  } catch (error) {

    fail(res, error);

  }

});



app.post("/api/payments", async (req, res) => {

  try {

    const p = req.body || {};



    if (!p.id) {

      return fail(res, new Error("Payment id is required"), 400);

    }



    if (!(Number(p.amount) > 0)) {

      return fail(res, new Error("Payment amount must be greater than zero"), 400);

    }



    if (!p.saleId) {

      return fail(res, new Error("Sale is required"), 400);

    }



    const sale = await getSale(p.saleId);



    if (!sale) {

      return fail(res, new Error("Sale not found"), 404);

    }



    const now = new Date().toISOString();



    await run(

      `INSERT INTO payments

       (id,date,custId,name,phone,saleId,invoice,amount,method,category,notes,createdAt,updatedAt)

       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,

      [

        p.id,

        p.date || todayISO(),

        p.custId || sale.custId,

        p.name || sale.name,

        p.phone || sale.phone,

        p.saleId,

        p.invoice || sale.invoice,

        Number(p.amount),

        p.method || "Cash",

        p.category || "INSTALLMENT",

        p.notes || "",

        now,

        now

      ]

    );



    const payment = await get(

      "SELECT * FROM payments WHERE id = ?",

      [p.id]

    );



    await logAudit("CREATE", "payment", p.id, payment);



    ok(res, {

      payment,

      sale: await enrichSale(sale)

    });

  } catch (error) {

    fail(res, error, (error.code === "23505" || error.code === "23503") ? 409 : 500);

  }

});



app.put("/api/payments/:id", async (req, res) => {

  try {

    const existing = await get(

      "SELECT * FROM payments WHERE id = ?",

      [req.params.id]

    );



    if (!existing) {

      return fail(res, new Error("Payment not found"), 404);

    }



    const p = { ...existing, ...(req.body || {}) };



    await run(

      `UPDATE payments SET

        date=?,

        custId=?,

        name=?,

        phone=?,

        saleId=?,

        invoice=?,

        amount=?,

        method=?,

        category=?,

        notes=?,

        updatedAt=?

       WHERE id=?`,

      [

        p.date,

        p.custId,

        p.name,

        p.phone,

        p.saleId,

        p.invoice,

        Number(p.amount) || 0,

        p.method || "Cash",

        p.category || "INSTALLMENT",

        p.notes || "",

        new Date().toISOString(),

        req.params.id

      ]

    );



    const payment = await get(

      "SELECT * FROM payments WHERE id = ?",

      [req.params.id]

    );



    await logAudit("UPDATE", "payment", req.params.id, payment);



    ok(res, { payment });

  } catch (error) {

    fail(res, error);

  }

});



app.delete("/api/payments/:id", async (req, res) => {

  try {

    const payment = await get(

      "SELECT * FROM payments WHERE id = ?",

      [req.params.id]

    );



    if (!payment) {

      return fail(res, new Error("Payment not found"), 404);

    }



    await run("DELETE FROM payments WHERE id = ?", [req.params.id]);



    await logAudit("DELETE", "payment", req.params.id, payment);



    ok(res);

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   OVERDUE / INSTALLMENTS

   ========================================================= */



app.get("/api/overdue", async (req, res) => {

  try {

    const sales = await all(

      "SELECT * FROM sales ORDER BY date DESC, id DESC"

    );



    const rows = [];



    for (const sale of sales) {

      const schedule = await calculateSchedule(sale);



      for (const item of schedule) {

        if (

          item.status === "OVERDUE" ||

          (item.status === "PARTIAL" && item.overdueDays > 0)

        ) {

          rows.push({

            saleId: sale.id,

            invoice: sale.invoice,

            customerId: sale.custId,

            name: sale.name,

            phone: sale.phone,

            product: sale.product,

            installment: item.installment,

            due: item.due,

            expected: item.expected,

            allocated: item.allocated,

            left: item.left,

            overdueDays: item.overdueDays,

            status: "OVERDUE"

          });

        }

      }

    }



    rows.sort((a, b) => {

      if (a.due < b.due) return -1;

      if (a.due > b.due) return 1;

      return b.overdueDays - a.overdueDays;

    });



    ok(res, {

      count: rows.length,

      totalOverdue: round2(rows.reduce((s, x) => s + x.left, 0)),

      overdue: rows

    });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/installments/:saleId", async (req, res) => {

  try {

    const sale = await getSale(req.params.saleId);



    if (!sale) {

      return fail(res, new Error("Sale not found"), 404);

    }



    ok(res, {

      saleId: sale.id,

      schedule: await calculateSchedule(sale)

    });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   SEARCH

   ========================================================= */



app.get("/api/search", async (req, res) => {

  try {

    const q = String(req.query.q || "").trim();



    if (!q) {

      return ok(res, {

        customers: [],

        sales: [],

        payments: []

      });

    }



    const customers = await all(

      `SELECT * FROM customers

       WHERE name LIKE ?

          OR phone LIKE ?

          OR alt LIKE ?

          OR city LIKE ?

       ORDER BY name ASC

       LIMIT 50`,

      [

        `%${q}%`,

        `%${q}%`,

        `%${q}%`,

        `%${q}%`

      ]

    );



    const sales = await all(

      `SELECT s.*, p.name AS productName

       FROM sales s

       LEFT JOIN products p ON p.code = s.product

       WHERE s.id LIKE ?

          OR s.invoice LIKE ?

          OR s.name LIKE ?

          OR s.phone LIKE ?

       ORDER BY s.date DESC

       LIMIT 100`,

      [

        `%${q}%`,

        `%${q}%`,

        `%${q}%`,

        `%${q}%`

      ]

    );



    const payments = await all(

      `SELECT * FROM payments

       WHERE id LIKE ?

          OR name LIKE ?

          OR phone LIKE ?

          OR invoice LIKE ?

       ORDER BY date DESC

       LIMIT 100`,

      [

        `%${q}%`,

        `%${q}%`,

        `%${q}%`,

        `%${q}%`

      ]

    );



    const enrichedSales = [];

    for (const sale of sales) {

      enrichedSales.push(await enrichSale(sale));

    }



    ok(res, {

      customers,

      sales: enrichedSales,

      payments

    });

  } catch (error) {

    fail(res, error);

  }

});



app.get("/api/search/phone/:phone", async (req, res) => {

  try {

    const phone = req.params.phone;

    const customerRows = await all("SELECT * FROM customers");



    const customer = customerRows.find(c =>

      phonesMatch(c.phone, phone) ||

      phonesMatch(c.alt, phone)

    );



    if (!customer) {

      return fail(res, new Error("Customer not found"), 404);

    }



    const sales = await all(

      "SELECT * FROM sales WHERE custId = ? ORDER BY date DESC",

      [customer.id]

    );



    const payments = await all(

      "SELECT * FROM payments WHERE custId = ? ORDER BY date DESC, id DESC",

      [customer.id]

    );



    const enrichedSales = [];

    let outstanding = 0;



    for (const sale of sales) {

      const enriched = await enrichSale(sale);

      outstanding += enriched.outstanding;

      enrichedSales.push(enriched);

    }



    ok(res, {

      customer,

      sales: enrichedSales,

      payments,

      outstanding: round2(outstanding)

    });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   DASHBOARD / HOME

   ========================================================= */



app.get("/api/dashboard", async (req, res) => {

  try {

    const month = String(req.query.month || todayISO().slice(0, 7));



    const customerCount = await get(

      "SELECT COUNT(*) AS count FROM customers"

    );



    const productCount = await get(

      "SELECT COUNT(*) AS count FROM products WHERE active = 1"

    );



    const sales = await all("SELECT * FROM sales");



    let outstanding = 0;

    let overdue = 0;



    for (const sale of sales) {

      const f = await calculateSale(sale);

      const status = await getSaleStatus(sale);



      outstanding += f.outstanding;



      if (status === "OVERDUE") {

        overdue += f.outstanding;

      }

    }



    const collected = await get(

      `SELECT COALESCE(SUM(amount),0) AS total

       FROM payments

       WHERE substr(date,1,7) = ?`,

      [month]

    );



    const salesMonth = await all(

      `SELECT * FROM sales

       WHERE substr(date,1,7) = ?`,

      [month]

    );



    let salesTotal = 0;



    for (const sale of salesMonth) {

      const f = await calculateSale(sale);

      salesTotal += f.invoice;

    }



    const paymentMethods = await all(

      `SELECT method, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count

       FROM payments

       WHERE substr(date,1,7) = ?

       GROUP BY method

       ORDER BY total DESC`,

      [month]

    );



    const categoryTotals = await all(

      `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count

       FROM payments

       WHERE substr(date,1,7) = ?

       GROUP BY category

       ORDER BY total DESC`,

      [month]

    );



    ok(res, {

      month,

      kpis: {

        customers: Number(customerCount.count || 0),

        activeProducts: Number(productCount.count || 0),

        outstanding: round2(outstanding),

        overdue: round2(overdue),

        collectedThisMonth: round2(collected.total || 0),

        salesThisMonth: round2(salesTotal)

      },

      paymentMethods,

      categoryTotals

    });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   BACKUP / RESTORE

   ========================================================= */



app.get("/api/backup", async (req, res) => {

  try {

    const [settings, customers, products, sales, payments, audit] =

      await Promise.all([

        getSettings(),

        all("SELECT * FROM customers ORDER BY id"),

        all("SELECT * FROM products ORDER BY code"),

        all("SELECT * FROM sales ORDER BY id"),

        all("SELECT * FROM payments ORDER BY id"),

        all("SELECT * FROM audit ORDER BY id")

      ]);



    res.setHeader(

      "Content-Disposition",

      `attachment; filename="malhi-backup-${todayISO()}.json"`

    );



    res.json({

      version: 2,

      exportedAt: new Date().toISOString(),

      settings,

      customers,

      products,

      sales,

      payments,

      audit

    });

  } catch (error) {

    fail(res, error);

  }

});



app.post("/api/restore", async (req, res) => {

  try {

    const data = req.body || {};



    if (!Array.isArray(data.customers) ||

        !Array.isArray(data.products) ||

        !Array.isArray(data.sales) ||

        !Array.isArray(data.payments)) {

      return fail(res, new Error("Invalid Malhi backup format"), 400);

    }



    await transaction(async () => {

      await run("DELETE FROM payments");

      await run("DELETE FROM sales");

      await run("DELETE FROM customers");

      await run("DELETE FROM products");



      const now = new Date().toISOString();



      for (const c of data.customers) {

        await run(

          `INSERT INTO customers

           (id,name,phone,alt,address,city,notes,createdAt,updatedAt)

           VALUES (?,?,?,?,?,?,?,?,?)`,

          [

            c.id, c.name, c.phone, c.alt || "", c.address || "",

            c.city || "", c.notes || "", c.createdAt || now, c.updatedAt || now

          ]

        );

      }



      for (const p of data.products) {

        await run(

          `INSERT INTO products

           (code,name,model,category,cost,price,active,createdAt,updatedAt)

           VALUES (?,?,?,?,?,?,?,?,?)`,

          [

            p.code, p.name, p.model || "—", p.category || "Scooter",

            Number(p.cost) || 0, Number(p.price) || 0,

            p.active ? 1 : 0, p.createdAt || now, p.updatedAt || now

          ]

        );

      }



      for (const s of data.sales) {

        await run(

          `INSERT INTO sales

           (id,custId,name,phone,invoice,date,product,serial,qty,price,discount,advance,rate,term,firstDue,notes,createdAt,updatedAt)

           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,

          [

            s.id, s.custId, s.name, s.phone, s.invoice, s.date,

            s.product, s.serial || "", Number(s.qty) || 1,

            Number(s.price) || 0, Number(s.discount) || 0,

            Number(s.advance) || 0, Number(s.rate) || 0,

            Number(s.term) || 0, s.firstDue || "", s.notes || "",

            s.createdAt || now, s.updatedAt || now

          ]

        );

      }



      for (const p of data.payments) {

        await run(

          `INSERT INTO payments

           (id,date,custId,name,phone,saleId,invoice,amount,method,category,notes,createdAt,updatedAt)

           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,

          [

            p.id, p.date, p.custId, p.name, p.phone, p.saleId,

            p.invoice, Number(p.amount) || 0, p.method || "Cash",

            p.category || "INSTALLMENT", p.notes || "",

            p.createdAt || now, p.updatedAt || now

          ]

        );

      }



      if (data.settings) {

        const s = data.settings;



        await run(

          `UPDATE settings SET

            business=?, currency=?, symbol=?, method=?,

            defaultRate=?, defaultTerm=?, dueSoonDays=?,

            autoBackup=?, updatedAt=?

           WHERE id=1`,

          [

            s.business || DEFAULT_SETTINGS.business,

            s.currency || "INR",

            s.symbol || "₹",

            s.method || "FLAT_ANNUAL",

            Number(s.defaultRate) || 0,

            Number(s.defaultTerm) || 24,

            Number(s.dueSoonDays) || 7,

            s.autoBackup ? 1 : 0,

            now

          ]

        );

      }



      await logAudit("RESTORE", "database", "all", {

        customers: data.customers.length,

        products: data.products.length,

        sales: data.sales.length,

        payments: data.payments.length

      });

    });



    ok(res, { message: "Backup restored successfully" });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   SAMPLE DATA / RESET

   ========================================================= */



app.post("/api/reset", async (req, res) => {

  try {

    await transaction(async () => {

      await run("DELETE FROM payments");

      await run("DELETE FROM sales");

      await run("DELETE FROM customers");



      await run("DELETE FROM products");
      const now = new Date().toISOString();




      await run(

        `UPDATE settings SET

          business=?, currency=?, symbol=?, method=?,

          defaultRate=?, defaultTerm=?, dueSoonDays=?,

          autoBackup=?, updatedAt=?

         WHERE id=1`,

        [

          DEFAULT_SETTINGS.business,

          DEFAULT_SETTINGS.currency,

          DEFAULT_SETTINGS.symbol,

          DEFAULT_SETTINGS.method,

          DEFAULT_SETTINGS.defaultRate,

          DEFAULT_SETTINGS.defaultTerm,

          DEFAULT_SETTINGS.dueSoonDays,

          DEFAULT_SETTINGS.autoBackup ? 1 : 0,

          now

        ]

      );



      await logAudit("RESET", "database", "all", {});

    });



    ok(res, { message: "Sample data restored" });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   AUDIT

   ========================================================= */



app.get("/api/audit", async (req, res) => {

  try {

    const limit = Math.min(Number(req.query.limit) || 100, 1000);



    const audit = await all(

      `SELECT * FROM audit

       ORDER BY id DESC

       LIMIT ?`,

      [limit]

    );



    ok(res, { audit });

  } catch (error) {

    fail(res, error);

  }

});



/* =========================================================

   ERROR HANDLERS

   ========================================================= */



app.use((req, res) => {

  res.status(404).json({

    success: false,

    error: `API route not found: ${req.method} ${req.originalUrl}`

  });

});



app.use((err, req, res, next) => {

  console.error(err);

  res.status(500).json({

    success: false,

    error: err.message || "Internal server error"

  });

});



/* =========================================================

   START

   ========================================================= */



initializeDatabase()

  .then(() => {

    app.listen(PORT, "0.0.0.0", () => {

      console.log("==============================================");

      console.log(" MALHI ENTERPRISE API");

      console.log(` http://0.0.0.0:${PORT}`);

      console.log(" Database: PostgreSQL");

      console.log(" Currency: INR / ₹");

      console.log("==============================================");

    });

  })

  .catch(error => {

    console.error("Database initialization failed:", error);

    process.exit(1);

  });



async function shutdown(signal) {

  console.log(`${signal}: closing PostgreSQL pool...`);

  try {

    await pool.end();

  } finally {

    process.exit(0);

  }

}



process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));
