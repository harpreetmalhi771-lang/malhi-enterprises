const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { Pool } = require("pg");

const sqliteFile = path.join(__dirname, "malhi.db");
if (!fs.existsSync(sqliteFile)) {
  console.error(`SQLite database not found: ${sqliteFile}`);
  console.error("Copy your existing malhi.db into this project folder first.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sqlite = new sqlite3.Database(sqliteFile);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("neon.tech") || process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

function sAll(sql, params=[]) {
  return new Promise((resolve,reject)=>sqlite.all(sql,params,(e,r)=>e?reject(e):resolve(r||[])));
}
function sGet(sql, params=[]) {
  return new Promise((resolve,reject)=>sqlite.get(sql,params,(e,r)=>e?reject(e):resolve(r||null)));
}
async function q(sql, params=[]) { return pool.query(sql,params); }

async function schema() {
  await q(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), business TEXT NOT NULL DEFAULT 'Malhi Enterprise',
    currency TEXT NOT NULL DEFAULT 'INR', symbol TEXT NOT NULL DEFAULT '₹', method TEXT NOT NULL DEFAULT 'FLAT_ANNUAL',
    defaultRate DOUBLE PRECISION NOT NULL DEFAULT 0.10, defaultTerm INTEGER NOT NULL DEFAULT 24,
    dueSoonDays INTEGER NOT NULL DEFAULT 7, autoBackup INTEGER NOT NULL DEFAULT 1, updatedAt TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, alt TEXT DEFAULT '', address TEXT DEFAULT '',
    city TEXT DEFAULT '', notes TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT DEFAULT '', category TEXT DEFAULT 'Scooter',
    cost DOUBLE PRECISION NOT NULL DEFAULT 0, price DOUBLE PRECISION NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT, updatedAt TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY, custId TEXT NOT NULL, name TEXT, phone TEXT, invoice TEXT, date TEXT, product TEXT, serial TEXT,
    qty INTEGER NOT NULL DEFAULT 1, price DOUBLE PRECISION NOT NULL DEFAULT 0, discount DOUBLE PRECISION NOT NULL DEFAULT 0,
    advance DOUBLE PRECISION NOT NULL DEFAULT 0, rate DOUBLE PRECISION NOT NULL DEFAULT 0, term INTEGER NOT NULL DEFAULT 0,
    firstDue TEXT, notes TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, date TEXT, custId TEXT, name TEXT, phone TEXT, saleId TEXT, invoice TEXT,
    amount DOUBLE PRECISION NOT NULL DEFAULT 0, method TEXT DEFAULT 'Cash', category TEXT DEFAULT 'INSTALLMENT',
    notes TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS audit (
    id BIGSERIAL PRIMARY KEY, action TEXT, entity TEXT, entityId TEXT, details TEXT, createdAt TEXT)`);
}

async function migrate() {
  await schema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const settings = await sAll("SELECT * FROM settings");
    for (const s of settings) {
      await client.query(`INSERT INTO settings
        (id,business,currency,symbol,method,defaultRate,defaultTerm,dueSoonDays,autoBackup,updatedAt)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET business=EXCLUDED.business,currency=EXCLUDED.currency,symbol=EXCLUDED.symbol,
        method=EXCLUDED.method,defaultRate=EXCLUDED.defaultRate,defaultTerm=EXCLUDED.defaultTerm,
        dueSoonDays=EXCLUDED.dueSoonDays,autoBackup=EXCLUDED.autoBackup,updatedAt=EXCLUDED.updatedAt`,
        [s.id,s.business,s.currency,s.symbol,s.method,s.defaultRate,s.defaultTerm,s.dueSoonDays,s.autoBackup,s.updatedAt]);
    }

    const customers = await sAll("SELECT * FROM customers");
    for (const r of customers) await client.query(`INSERT INTO customers
      (id,name,phone,alt,address,city,notes,createdAt,updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,alt=EXCLUDED.alt,address=EXCLUDED.address,
      city=EXCLUDED.city,notes=EXCLUDED.notes,updatedAt=EXCLUDED.updatedAt`,
      [r.id,r.name,r.phone,r.alt||'',r.address||'',r.city||'',r.notes||'',r.createdAt,r.updatedAt]);

    const products = await sAll("SELECT * FROM products");
    for (const r of products) await client.query(`INSERT INTO products
      (code,name,model,category,cost,price,active,createdAt,updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,model=EXCLUDED.model,category=EXCLUDED.category,
      cost=EXCLUDED.cost,price=EXCLUDED.price,active=EXCLUDED.active,updatedAt=EXCLUDED.updatedAt`,
      [r.code,r.name,r.model||'',r.category||'Scooter',r.cost,r.price,r.active,r.createdAt,r.updatedAt]);

    const sales = await sAll("SELECT * FROM sales");
    for (const r of sales) await client.query(`INSERT INTO sales
      (id,custId,name,phone,invoice,date,product,serial,qty,price,discount,advance,rate,term,firstDue,notes,createdAt,updatedAt)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (id) DO UPDATE SET custId=EXCLUDED.custId,name=EXCLUDED.name,phone=EXCLUDED.phone,invoice=EXCLUDED.invoice,
      date=EXCLUDED.date,product=EXCLUDED.product,serial=EXCLUDED.serial,qty=EXCLUDED.qty,price=EXCLUDED.price,
      discount=EXCLUDED.discount,advance=EXCLUDED.advance,rate=EXCLUDED.rate,term=EXCLUDED.term,firstDue=EXCLUDED.firstDue,
      notes=EXCLUDED.notes,updatedAt=EXCLUDED.updatedAt`,
      [r.id,r.custId,r.name,r.phone,r.invoice,r.date,r.product,r.serial,r.qty,r.price,r.discount,r.advance,r.rate,r.term,r.firstDue,r.notes||'',r.createdAt,r.updatedAt]);

    const payments = await sAll("SELECT * FROM payments");
    for (const r of payments) await client.query(`INSERT INTO payments
      (id,date,custId,name,phone,saleId,invoice,amount,method,category,notes,createdAt,updatedAt)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET date=EXCLUDED.date,custId=EXCLUDED.custId,name=EXCLUDED.name,phone=EXCLUDED.phone,
      saleId=EXCLUDED.saleId,invoice=EXCLUDED.invoice,amount=EXCLUDED.amount,method=EXCLUDED.method,category=EXCLUDED.category,
      notes=EXCLUDED.notes,updatedAt=EXCLUDED.updatedAt`,
      [r.id,r.date,r.custId,r.name,r.phone,r.saleId,r.invoice,r.amount,r.method,r.category,r.notes||'',r.createdAt,r.updatedAt]);

    const audit = await sAll("SELECT * FROM audit ORDER BY id ASC");
    for (const r of audit) await client.query(`INSERT INTO audit
      (id,action,entity,entityId,details,createdAt) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET action=EXCLUDED.action,entity=EXCLUDED.entity,entityId=EXCLUDED.entityId,
      details=EXCLUDED.details,createdAt=EXCLUDED.createdAt`,
      [r.id,r.action,r.entity,r.entityId,r.details,r.createdAt]);
    if (audit.length) await client.query(`SELECT setval(pg_get_serial_sequence('audit','id'), GREATEST((SELECT MAX(id) FROM audit),1), true)`);

    await client.query("COMMIT");
    console.log(`Migration complete: ${settings.length} settings, ${customers.length} customers, ${products.length} products, ${sales.length} sales, ${payments.length} payments, ${audit.length} audit rows.`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }
}

migrate().catch(e=>{ console.error("SQLite -> PostgreSQL migration failed:",e); process.exitCode=1; })
  .finally(async()=>{ sqlite.close(); await pool.end(); });
