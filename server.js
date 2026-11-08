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

async function getDynamicNetworkOffset() {
    let pings = [];
    for (let i = 0; i < 4; i++) {
        const start = Date.now();
        try {
            await fetch(`${HORIZON_URL}/fee_stats`);
            pings.push(Date.now() - start);
        } catch (e) { pings.push(300); }
    }
    const avgPing = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
    const autoOffset = avgPing + 150; 
    addLog(`🎯 Live Ping: ${avgPing}ms | Pre-fire Offset: ${autoOffset}ms`, "success");
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
        const now = new Date();
        const nowISTString = now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
        const nowIST = new Date(nowISTString);
        
        let targetIST = new Date(nowISTString);
        targetIST.setHours(targetH, targetM, targetS || 0, 0);
        if (targetIST.getTime() <= nowIST.getTime()) targetIST.setDate(targetIST.getDate() + 1); 
        
        const delayMs = targetIST.getTime() - nowIST.getTime();
        const targetUnix = Math.floor((Date.now() + delayMs) / 1000);
        
        addLog(`Target locked: ${targetTime} IST. Precise Countdown: ${(delayMs/1000).toFixed(3)}s`, "info");

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

        const tasks = sponsorPool.map(async (mn) => {
            const spKp = getKeypair(mn);
            if (!spKp) return null;
            const acc = await piServer.loadAccount(spKp.publicKey());
            
            const builder = new TxBuilderClass(new AccountClass(spKp.publicKey(), acc.sequenceNumber()), {
                fee: Math.round(parseFloat(surgeFee) * 10000000).toString(),
                networkPassphrase: NETWORK_PASSPHRASE,
                timebounds: {
                    minTime: targetUnix.toString(),
                    maxTime: (targetUnix + 600).toString() 
                }
            });

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
            return { xdr: tx.toXDR() };
        });

        const packets = (await Promise.all(tasks)).filter(Boolean);
        addLog(`✅ ${packets.length} Packets pre-signed with TimeBounds & Locked in RAM!`, "success");
        
        let dynamicOffset = 300; 
        
        // 🚀 THE NEW LEDGER SYNC ENGINE (Runs 10 seconds before unlock)
        const syncDelay = Math.max(0, delayMs - 10000);
        const ledgerSyncTimer = setTimeout(async () => {
            try {
                addLog("🧱 Scanning Pi Blockchain for Live Ledger Phase...", "info");
                const ledgers = await fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`).then(r => r.json());
                const lastLedgerTime = new Date(ledgers._embedded.records[0].closed_at);
                const istTime = lastLedgerTime.toLocaleTimeString('en-US', {timeZone: 'Asia/Kolkata', hour12: false});
                addLog(`⚡ LEDGER SYNC LOCK-ON: Last Ledger closed at ${istTime}. Tracking 5s Cycle...`, "success");
                dynamicOffset = await getDynamicNetworkOffset();
            } catch(e) {}
        }, syncDelay);
        botState.timers.push(ledgerSyncTimer);

        const startDelay = Math.max(0, delayMs - 3000 - dynamicOffset);
        
        const masterTimer = setTimeout(() => {
            addLog(`💥 GATLING GUN ACTIVATED (100ms SPEED)! PRE-LOADING MEMPOOL...`, "warning");
            
            let shotCount = 0;
            let raceOver = false;

            const fireSpam = () => {
                if (raceOver) return;
                shotCount++;
                
                if (shotCount > 150) { 
                    clearInterval(spamInterval);
                    botState.isArmed = false;
                    addLog(`🛑 GATLING GUN STOPPED (Time window closed).`, "info");
                    return;
                }

                packets.forEach((w) => {
                    fetch("https://api.mainnet.minepi.com/transactions", {
                        method: 'POST',
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        body: `tx=${encodeURIComponent(w.xdr)}`
                    }).then(r => r.json()).then(d => {
                        if (raceOver) return; 
                        
                        if (d.hash) {
                            raceOver = true;
                            addLog(`🏆 VICTORY! Transaction Mined! Hash: ${d.hash}`, "success");
                            clearInterval(spamInterval);
                            botState.isArmed = false;
                        } else {
                            let errCode = JSON.stringify(d?.extras?.result_codes || d.title || "");
                            
                            if (errCode.includes("tx_too_early") || errCode.includes("tx_bad_seq")) {
                                // Silent pre-fire mode (keeps sequences safe)
                            } else {
                                raceOver = true; 
                                clearInterval(spamInterval);
                                botState.isArmed = false;
                                addLog(`🛑 RACE OVER: Ledger just closed and packet was rejected.`, "warning");
                                addLog(`[Final Shot #${shotCount}] ❌ Failed: ${errCode}`, "error");
                            }
                        }
                    }).catch(e => {}); 
                });
            };

            fireSpam(); 
            const spamInterval = setInterval(fireSpam, 100); 
            botState.timers.push(spamInterval);

        }, startDelay);

        botState.timers.push(masterTimer);
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
