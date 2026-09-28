# Deployment Guide — AI Healthy Scheduler (Deliverable 8 of 8)

A single Next.js 15 app deployed on **Vercel**, with **Neon** (managed PostgreSQL), **Clerk** (auth), **Stripe** (payments), and **OpenAI** (AI layer). This guide takes you from a clean clone to a live, working deployment.

---

## 0. Prerequisites

- Node.js ≥ 20 and npm
- Accounts: Vercel, Neon (or any managed Postgres), Clerk, Stripe, OpenAI
- The Stripe CLI (for local webhook testing): `stripe`
- Git

---

## 1. Local setup

```bash
git clone <your-repo> ai-healthy-scheduler
cd ai-healthy-scheduler
npm install                      # runs `prisma generate` via postinstall

# Add the shadcn/ui primitives the components import:
npx shadcn@latest add button card checkbox badge alert dialog tabs \
  input label slider switch select skeleton separator dropdown-menu sonner tooltip

cp .env.example .env.local       # then fill in real values (sections below)
```

Mount the toaster once (so `sonner` toasts render). In `src/app/(app)/layout.tsx`, add `<Toaster />` from `@/components/ui/sonner` near the root of the shell (or in the root layout).

---

## 2. Database (Neon)

1. Create a Neon project → copy the two connection strings.
2. In `.env.local` set:
   - `DATABASE_URL` → the **pooled** string (has `-pooler` host / `pgbouncer=true`). Used at runtime.
   - `DIRECT_URL` → the **direct** string. Used only by migrations.
3. Create the schema and generate the client:

```bash
npx prisma migrate dev --name init    # creates tables from prisma/schema.prisma
npm run db:seed                        # optional demo data (see note below)
```

> **Why two URLs?** Serverless/edge functions open many short-lived connections; the pooled URL (PgBouncer) prevents connection exhaustion, while migrations need a direct connection. This split is already wired in `schema.prisma`.

> **Seed caveat:** the seed user's id won't match a real Clerk session, so don't expect to *log in* as it — it's for engine/API testing. Real users are created by the Clerk webhook (or lazily on first request).

**Production-hardening SQL** (run as a follow-up migration; Prisma can't express these — from the DB design doc): partial indexes excluding `deletedAt IS NOT NULL`, `CHECK` constraints (`estimatedMinutes > 0`, `endTime > startTime`), and monthly range partitioning on the high-volume tables once they grow.

---

## 3. Clerk (authentication)

1. Create a Clerk application → copy the API keys into `.env.local`:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
2. Set the sign-in/up URL env vars (already in `.env.example`) so Clerk routes to `/sign-in` and `/sign-up`.
3. **Webhook:** in Clerk → Webhooks → add endpoint `https://<your-domain>/api/webhooks/clerk`, subscribe to `user.created`, `user.updated`, `user.deleted`. Copy the signing secret → `CLERK_WEBHOOK_SECRET`.
4. Confirm `src/middleware.ts` leaves `/api/webhooks/*` public (it does) — webhooks must bypass auth.

---

## 4. Stripe (payments)

1. Create a **recurring Price** for the Premium plan → copy its id into both:
   - `STRIPE_PREMIUM_PRICE_ID` (server) and `NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID` (client; the pricing page reads this).
2. Copy `STRIPE_SECRET_KEY`.
3. **Webhook (production):** Stripe Dashboard → Developers → Webhooks → add `https://<your-domain>/api/webhooks/stripe`, subscribe to:
   - `checkout.session.completed`
   - `customer.subscription.created` / `.updated` / `.deleted`
   - `invoice.payment_succeeded` / `.payment_failed`
   Copy the signing secret → `STRIPE_WEBHOOK_SECRET`.
4. **Webhook (local):**

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET in .env.local
```

> The webhook is the source of truth for entitlements — it flips `User.subscriptionTier` and writes the `Subscription` row. Without it configured, payments succeed but premium is never granted.

---

## 5. OpenAI (AI layer)

Set `OPENAI_API_KEY` and (optionally) `OPENAI_MODEL` (defaults to `gpt-4o-mini`). The AI layer degrades gracefully — task parsing and substitutions fall back to rules if the key is missing — so the core scheduler works without it.

---

## 6. Run locally

```bash
npm run dev        # http://localhost:3000
```

Smoke test: sign up → land on `/dashboard` → Settings → set your routine → Tasks → add a task → Dashboard → **Generate today** → check a block off.

---

## 7. Deploy to Vercel

1. Push to GitHub and **Import Project** in Vercel.
2. **Environment Variables:** add every key from `.env.local` to the Vercel project (Production + Preview). Set `NEXT_PUBLIC_APP_URL` to your real domain (e.g. `https://app.yourdomain.com`).
3. **Build command** is `npm run build` (which runs `prisma generate` first — already in `package.json`).
4. **Run migrations against production** (Vercel build does *not* migrate). Either run locally pointed at prod, or as a deploy step:

```bash
# with prod DATABASE_URL / DIRECT_URL exported:
npx prisma migrate deploy
```

5. Deploy. Then **update both webhook URLs** (Clerk + Stripe) to your production domain and re-copy their signing secrets into Vercel env vars if they differ from local.

> **Database choice:** Vercel's first-party Postgres now runs on Neon, so either Vercel Postgres or a standalone Neon project works. Keep the API on Vercel's Node runtime (not Edge) — Prisma needs Node.

---

## 8. Post-deploy checklist

- [ ] Sign-up creates a DB user (check Clerk webhook deliveries → 200).
- [ ] Profile saves; invalid input (min sleep > target) returns a clean 400.
- [ ] **Generate** produces a schedule; sleep <6h shows a warning.
- [ ] Checking a block writes a `CompletionLog`; completing task blocks advances the task.
- [ ] Analytics renders after a day or two of check-offs.
- [ ] Upgrade → Stripe Checkout → return → **premium granted** (Stripe webhook → 200, `subscriptionTier = PREMIUM`).
- [ ] Emergency mode: free user gets 402; premium user works; second use within 48h gets 429.
- [ ] Billing portal opens for premium users.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Too many connections` on Postgres | Using the direct URL at runtime — set `DATABASE_URL` to the **pooled** string. |
| Payments work but no premium | Stripe webhook not configured, wrong `STRIPE_WEBHOOK_SECRET`, or `/api/webhooks/stripe` not public in middleware. |
| Webhook 400 "Invalid signature" | Body was parsed before verification (we use `req.text()`), or the secret doesn't match this environment. |
| Users not created | Clerk webhook missing — the lazy resolver still creates them on first request, so check `/api/webhooks/clerk` deliveries. |
| Prisma errors on Vercel | Ensure `prisma generate` runs in build (it does) and `serverExternalPackages` includes Prisma (it does in `next.config.ts`). |
| Schedule off by an hour near DST | Known MVP edge — the timezone helpers in `schedule.service.ts` add absolute minutes; wall-clock-aware math is the fix. |
| AI parse returns generic guesses | `OPENAI_API_KEY` missing/invalid → fallback heuristic in use (by design). |

---

## 10. Architecture recap (one paragraph)

Requests hit Next.js Route Handlers, authenticated by Clerk and validated by Zod. The **deterministic scheduling engine** (`src/server/scheduling/*`) is pure and framework-free — it decides feasibility, protects sleep/meals/exercise, prioritizes by deadline, detects overload via an exact EDF test, and migrates tasks. The **service layer** handles all timezone and Prisma concerns. **OpenAI advises only** (NL parsing, substitutions) behind a swappable provider, with rules-based fallbacks — it never decides feasibility. Stripe webhooks are the source of truth for entitlements. That separation — exact algorithms for correctness, LLM for polish — is the core of the design.

---

*End of Deployment Guide — and of the 8-part MVP build.*
