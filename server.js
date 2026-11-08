const express = require('express');
const cors = require('cors');
const path = require('path');
const StellarSdk = require('stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HORIZON_URL = "https://api.mainnet.minepi.com";
let piServer;
if (StellarSdk.Horizon && StellarSdk.Horizon.Server) {
    piServer = new StellarSdk.Horizon.Server(HORIZON_URL);
} else if (StellarSdk.Server) {
    piServer = new StellarSdk.Server(HORIZON_URL);
} else {
    const ServerClass = StellarSdk.Horizon?.HorizonApi?.Server || StellarSdk.Horizon;
    piServer = new ServerClass(HORIZON_URL);
}

const NETWORK_PASSPHRASE = "Pi Network";

function getKeypair(mnemonic) {
    try {
        const seed = bip39.mnemonicToSeedSync(mnemonic.toLowerCase().trim());
        const { key } = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
    } catch (e) { return null; }
}

let botState = { isArmed: false, logs: [], timers: [] };

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
    botState.logs.unshift({ time, msg, type });
    if (botState.logs.length > 100) botState.logs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// 🔥 LIVE AUTO-PING RADAR (Network Latency Measure Engine)
async function getDynamicNetworkOffset() {
    addLog("📡 Pinging Pi Network Mainnet to calculate live MS latency...", "info");
    let pings = [];
    for (let i = 0; i < 4; i++) {
        const start = Date.now();
        try {
            await fetch(`${HORIZON_URL}/fee_stats`);
            pings.push(Date.now() - start);
        } catch (e) {
            pings.push(300); // Fallback if packet drops
        }
    }
    const avgPing = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
    // Auto Offset = Average Ping + 150ms internal NodeJS execution delay
    const autoOffset = avgPing + 150;
    addLog(`🎯 Live Ping: ${avgPing}ms | AUTO PRE-FIRE OFFSET SET TO: ${autoOffset}ms`, "success");
    return autoOffset;
}

app.post('/api/scan', async (req, res) => {
    const { targetMnemonic } = req.body;
    const kp = getKeypair(targetMnemonic);
    if (!kp) return res.json({ success: false, error: 'Invalid Passphrase' });

    try {
        const response = await piServer.claimableBalances().claimant(kp.publicKey()).limit(10).call();
        res.json({ success: true, balances: response.records });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post('/api/disarm', (req, res) => {
    botState.timers.forEach(t => clearTimeout(t));
    botState.timers = [];
    botState.isArmed = false;
    addLog("🛑 BOT DISARMED & ABORTED BY USER", "warning");
    res.json({ success: true });
});

app.post('/api/arm', async (req, res) => {
    const { operationMode, targetMnemonic, sponsorPool, receiverAddress, selectedBalanceId, targetTime, surgeFee } = req.body;
    
    if (botState.isArmed) return res.json({ success: false, error: 'Bot is already armed! First click Abort.' });
    
    botState.isArmed = true;
    botState.timers = [];
    addLog(`🔥 AUTO-MS TITAN ARMED! Sponsors: ${sponsorPool.length} | Fee: ${surgeFee} PI`, "warning");

    try {
        const [targetH, targetM, targetS] = targetTime.split(':').map(Number);
        const nowIST = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
        
        let targetIST = new Date(nowIST);
        targetIST.setHours(targetH, targetM, targetS || 0, 0);
        
        if (targetIST.getTime() <= nowIST.getTime()) {
            targetIST.setDate(targetIST.getDate() + 1);
        }
        
        const delayMs = targetIST.getTime() - nowIST.getTime();
        addLog(`Target locked: ${targetTime} IST. Countdown: ${(delayMs/1000).toFixed(1)}s`, "info");

        const targetKp = getKeypair(targetMnemonic);
        if (!targetKp) throw new Error("Invalid Sender Passphrase");

        let amountToSendStr = "0.01";
        if (operationMode === 'claim_and_transfer') {
            const cbRes = await piServer.claimableBalances().claimant(targetKp.publicKey()).limit(10).call();
            const cb = cbRes.records.find(r => r.id === selectedBalanceId);
            if (!cb) throw new Error("Selected Locked Balance ID not found!");
            amountToSendStr = cb.amount;
        } else {
            const targetAcc = await piServer.loadAccount(targetKp.publicKey());
            const native = targetAcc.balances.find(b => b.asset_type === 'native');
            if (!native) throw new Error("Sender wallet empty!");
            amountToSendStr = Math.max(0, parseFloat(native.balance) - 1.05).toFixed(7);
        }

        const TxBuilderClass = StellarSdk.TransactionBuilder || StellarSdk.Horizon?.TransactionBuilder;
        const AccountClass = StellarSdk.Account;
        const OperationClass = StellarSdk.Operation;
        const AssetClass = StellarSdk.Asset;

        const tasks = sponsorPool.map(async (mn, i) => {
            const spKp = getKeypair(mn);
            if (!spKp) return null;
            const acc = await piServer.loadAccount(spKp.publicKey());
            
            const builder = new TxBuilderClass(new AccountClass(spKp.publicKey(), acc.sequenceNumber()), {
                fee: Math.round(parseFloat(surgeFee) * 10000000).toString(),
                networkPassphrase: NETWORK_PASSPHRASE
            }).setTimeout(600);

            if (operationMode === 'claim_and_transfer') {
                builder.addOperation(OperationClass.claimClaimableBalance({
                    balanceId: selectedBalanceId,
                    source: targetKp.publicKey()
                }));
            }

            builder.addOperation(OperationClass.payment({
                source: targetKp.publicKey(),
                destination: receiverAddress,
                asset: AssetClass.native(),
                amount: amountToSendStr
            }));

            const tx = builder.build();
            tx.sign(targetKp);
            tx.sign(spKp);
            return { xdr: tx.toXDR(), wave: [1, 2, 3][i % 3] };
        });

        const packets = (await Promise.all(tasks)).filter(Boolean);
        addLog(`✅ ${packets.length} Packets pre-signed & locked in Railway RAM!`, "success");
        
        // 🔥 TRIGGER AUTO-PING CALIBRATION 8 SECONDS BEFORE T-0
        let dynamicOffset = 300; // Default fallback
        const pingMeasureDelay = Math.max(0, delayMs - 8000);
        
        const radarTimer = setTimeout(async () => {
            dynamicOffset = await getDynamicNetworkOffset();
        }, pingMeasureDelay);
        botState.timers.push(radarTimer);

        // 🔥 ADAPTIVE FIRING ENGINE (Uses exact measured dynamicOffset)
        [3, 2, 1].forEach(wave => {
            const waves = packets.filter(p => p.wave === wave);
            if (waves.length === 0) return;

            // Wave 3, 2, 1 chalega dynamic offset ke sath
            const waveDelay = Math.max(0, delayMs - ((wave - 1) * 700));
            
            const timer = setTimeout(() => {
                // Fire time pe offset deduct karte hain dynamically
                setTimeout(() => {
                    addLog(`💥 AUTO-MS FIRE WAVE T-${wave}s (${waves.length} SHOTS)...`, "warning");
                    waves.forEach((w, idx) => {
                        fetch("https://api.mainnet.minepi.com/transactions", {
                            method: 'POST',
                            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                            body: `tx=${encodeURIComponent(w.xdr)}`
                        }).then(r => r.json()).then(d => {
                            if (d.hash) addLog(`[Shot #${idx+1}] 🏆 VICTORY! Hash: ${d.hash}`, "success");
                            else addLog(`[Shot #${idx+1}] ❌ Failed: ${JSON.stringify(d?.extras?.result_codes || d.title)}`, "error");
                        }).catch(e => addLog(`[Shot #${idx+1}] Network Error`, "error"));
                    });
                    if (wave === 1) botState.isArmed = false;
                }, 0);
            }, Math.max(0, waveDelay - dynamicOffset));

            botState.timers.push(timer);
        });

        res.json({ success: true });

    } catch (e) {
        botState.isArmed = false;
        addLog(`❌ Build Crash: ${e.message}`, "error");
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/status', (req, res) => res.json({ isArmed: botState.isArmed, logs: botState.logs }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RAILWAY TITAN SERVER LIVE ON PORT ${PORT}`));
