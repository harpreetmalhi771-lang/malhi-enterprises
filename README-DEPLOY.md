# Malhi Enterprise — Free Deployment

Architecture:

Browser -> Render Free Node/Express -> Neon Free PostgreSQL

The frontend is served by the Express server, so you only deploy one Render Web Service.

## 1. Local test

1. Install Node.js 20+.
2. Create a PostgreSQL database named `malhi_enterprise` locally (pgAdmin is fine).
3. Copy `.env.example` to `.env` and set `DATABASE_URL`.
4. Run:

```bash
npm install
npm start
```

5. Open `http://localhost:3000`.

## 2. Move your existing SQLite data

Keep your existing `malhi.db` in the project folder temporarily. Do NOT delete it.

Set `DATABASE_URL` to the PostgreSQL database you want to receive the data, then run:

```bash
npm install
npm run migrate:sqlite
```

The migration script creates the PostgreSQL tables and upserts settings, products, customers, sales, payments, and audit rows from SQLite.

## 3. Create Neon database

Create a Neon PostgreSQL project and copy its connection string into `DATABASE_URL`.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "Malhi Enterprise PostgreSQL deployment"
git branch -M main
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

Do not commit `.env` or `malhi.db`.

## 5. Deploy to Render

Create **New -> Web Service**, select the GitHub repository, and use:

- Build Command: `npm install`
- Start Command: `npm start`
- Plan: `Free`
- Health Check Path: `/api/health`
- Environment variable: `DATABASE_URL` = your Neon connection string
- Environment variable: `NODE_ENV` = `production`

Render will provide an `onrender.com` URL.

## Important

Do not use the old SQLite `server.js` on Render Free. Render's free service filesystem is ephemeral, so SQLite changes can disappear when the service restarts or spins down. PostgreSQL on Neon keeps the application data outside the Render filesystem.
