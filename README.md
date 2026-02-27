# Garden Finance Test Suite
## Complete Setup Guide for Windows (Zero Coding Experience)

---

## What This Does
Runs automated end-to-end tests on the live Garden Finance app using a real wallet.
Tests every bridge route across all 15 supported chains and shows results in a live dashboard.

---

## Step 1 — Install Node.js (one time only)

1. Go to: **https://nodejs.org**
2. Click the big green **"LTS"** download button
3. Run the downloaded `.msi` installer
4. Click Next → Next → Install → Finish
5. Verify: Press `Windows + R`, type `cmd`, press Enter, then type:
   ```
   node --version
   ```
   You should see something like `v18.19.0` ✅

---

## Step 2 — Download This Project

Option A — If you have Git:
```
git clone https://your-gitea-url/your-repo/garden-test-suite.git
cd garden-test-suite
```

Option B — Download as ZIP from your Gitea, then extract it.

---

## Step 3 — Create Your .env File

1. In the project folder, find the file called `.env.example`
2. Right-click it → Copy → Paste → Rename the copy to `.env`
3. Open `.env` with Notepad (right-click → Open with → Notepad)
4. Fill in your values:

```
# These two come from: dashboard.privy.io → Settings
PRIVY_APP_ID=your-actual-app-id
PRIVY_APP_SECRET=your-actual-app-secret

# These come from: dashboard.privy.io → Wallets → Create Wallet
PRIVY_EVM_WALLET_ID=wallet-id-for-evm
PRIVY_SOLANA_WALLET_ID=wallet-id-for-solana

# The Garden API key is already filled in for testnet
# GARDEN_API_KEY is already set

# Bitcoin key — generate this in Step 4
BTC_PRIVATE_KEY_WIF=fill-in-after-step-4
BTC_ADDRESS=fill-in-after-step-4
```

---

## Step 4 — Generate Bitcoin Testnet Key

Open Command Prompt in the project folder:
1. Press `Windows + R`, type `cmd`, press Enter
2. Navigate to the project: `cd C:\path\to\garden-test-suite`
3. First install dependencies:
   ```
   npm install
   ```
4. Then generate the BTC key:
   ```
   npm run generate-btc-key
   ```
5. Copy the two lines it shows and paste them into your `.env` file

---

## Step 5 — Fund Your Test Wallets

These are tiny amounts for testing only:

**Bitcoin (Testnet4):**
- Faucet: https://mempool.space/testnet4
- Get 0.001 BTC to your `BTC_ADDRESS`

**EVM chains (Arbitrum Sepolia etc):**
- Fund your Privy EVM wallet from: https://faucet.arbitrum.io/

**Solana Testnet:**
- Fund: https://faucet.solana.com/

---

## Step 6 — Start the Dashboard

In Command Prompt (in the project folder):
```
npm start
```

You will see:
```
✅  Garden Test Suite running
   Dashboard: http://localhost:3000
   Environment: TESTNET
   Manual Approve: ON ✋
   Chains: 16
```

---

## Step 7 — Open the Dashboard

Open your browser and go to:
**http://localhost:3000**

You will see the full testing dashboard with:
- **Dashboard** — Overview and live test progress
- **Route Matrix** — All 15 chains × pass/fail status
- **Issues** — Tech and UX issues detected
- **Trade Chatbot** — Initiate specific routes by typing
- **Wallet Settings** — Change wallet addresses
- **Live Log** — Real-time event stream

---

## Running Tests

**Run all routes:** Click "▶ Run All Tests" in the dashboard

**Run specific route:** Click "Run Route" on any route card, or use the chatbot:
```
swap BTC to Arbitrum
```

**API tests only:** Click "🔌 API Tests" (no wallet needed)

---

## Manual Approve Mode

When `MANUAL_APPROVE=true` in your `.env`:
- Before every transaction, a popup appears in the dashboard
- You can review the order details
- Click **✅ Approve** to send the transaction
- Click **❌ Reject** to skip it

To disable (fully automated): set `MANUAL_APPROVE=false` and restart.

---

## Switching Testnet ↔ Mainnet

**From dashboard:** Use the toggle in the top-right corner
**From .env:** Change `GARDEN_ENV=testnet` to `GARDEN_ENV=mainnet`
Then restart the server: Press `Ctrl+C` in command prompt, then `npm start` again

⚠️ **Warning:** Mainnet uses real money. Only switch after testnet passes.

---

## Changing Wallet Addresses

Option A — Dashboard (temporary):
1. Go to "Wallet Settings" in the sidebar
2. Type the new address in the relevant field
3. Click "Save Changes" and follow the instructions

Option B — .env file (permanent):
1. Add `OVERRIDE_EVM_ADDRESS=0xYourNewAddress` to `.env`
2. Restart the server

---

## Gitea CI/CD Setup

1. Push this project to your Gitea repository
2. Go to: **Gitea → Your Repo → Settings → Secrets**
3. Add each secret from your `.env` file (without the values being visible)
4. The pipeline in `.gitea/workflows/test.yml` runs automatically on every push

---

## Troubleshooting

**"Missing required environment variables"**
→ Open `.env` and make sure all values are filled in

**"No UTXOs available on BTC test address"**
→ Fund your BTC address using the testnet faucet

**Dashboard shows "Reconnecting"**
→ Make sure `npm start` is still running in the Command Prompt

**Test shows "No liquidity"**
→ That route has no liquidity on testnet right now, skip it

---

## Support

All 15 chains with free public RPCs are pre-configured — no API keys needed for RPCs.
If a chain's RPC stops working, update the `RPC_XXX` value in `.env` with a new URL from:
- https://publicnode.com (free, no signup)
- https://blastapi.io/public-api (free public endpoints)
- https://drpc.org (free tier)
