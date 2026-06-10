// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const JOURNAL_PATH = path.join(__dirname, 'journal.csv');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());


// ==========================================================
//  LONDON SNIPER — unchanged
// ==========================================================

function parseAlertMessage(text) {
    const result = {
        direction: null, symbol: null, entry: null,
        sl: null, tp: null, lots: null, risk: null, type: null
    };
    if (!text || typeof text !== 'string') return result;

    if (text.includes("BUY SIGNAL"))    result.direction = "BUY";
    if (text.includes("SELL SIGNAL"))   result.direction = "SELL";
    if (text.includes("TIME EXIT"))     result.type = "TIME_EXIT";
    if (text.includes("CIRCUIT BREAKER")) result.type = "CIRCUIT_BREAKER";

    const symbolMatch = text.match(/([A-Z]{6})/);
    if (symbolMatch) result.symbol = symbolMatch[1];

    const priceMatch = text.match(/Price:\s([\d.]+)/);
    const slMatch    = text.match(/SL:\s([\d.]+)/);
    const tpMatch    = text.match(/TP:\s([\d.]+)/);
    const lotsMatch  = text.match(/Lots:\s([\d.]+)/);
    const riskMatch  = text.match(/Risk:\s([^|]+)/);

    if (priceMatch) result.entry = parseFloat(priceMatch[1]);
    if (slMatch)    result.sl    = parseFloat(slMatch[1]);
    if (tpMatch)    result.tp    = parseFloat(tpMatch[1]);
    if (lotsMatch)  result.lots  = parseFloat(lotsMatch[1]);
    if (riskMatch)  result.risk  = riskMatch[1].trim();

    return result;
}

function appendToJournal(parsed, raw) {
    const headers = [
        'timestamp','strategy','symbol','direction','entry',
        'sl','tp','lots','risk_pct','alert_type','raw_message'
    ];
    if (!fs.existsSync(JOURNAL_PATH)) {
        fs.writeFileSync(JOURNAL_PATH, headers.join(',') + '\n', 'utf8');
    }
    const row = [
        new Date().toISOString(), 'London Sniper EDGE v5',
        parsed.symbol || '', parsed.direction || '',
        parsed.entry ?? '', parsed.sl ?? '', parsed.tp ?? '',
        parsed.lots ?? '', parsed.risk ?? '', parsed.type || '',
        JSON.stringify(raw.alert_message || '')
    ];
    fs.appendFileSync(JOURNAL_PATH, row.join(',') + '\n', 'utf8');
}

app.get('/', (req, res) => {
    res.send('AlgoEngine Webhook — London Sniper + Break & Bounce online.');
});

app.post('/webhook', (req, res) => {
    const payload = req.body;
    console.log('LS RAW:', JSON.stringify(payload, null, 2));
    let parsed = null;
    if (payload && payload.alert_message) {
        parsed = parseAlertMessage(payload.alert_message);
        console.log('LS PARSED:', parsed);
        appendToJournal(parsed, payload);
    } else {
        console.log('No alert_message field found.');
    }
    const logPath = path.join(__dirname, 'webhook-log.ndjson');
    fs.appendFile(logPath, JSON.stringify({ receivedAt: new Date().toISOString(), raw: payload, parsed }) + '\n', (err) => {
        if (err) console.error('Error writing log:', err);
    });
    res.status(200).json({ status: 'ok' });
});

app.get('/journal', (req, res) => {
    if (!fs.existsSync(JOURNAL_PATH)) return res.send('journal.csv does not exist yet.');
    res.type('text/plain').send(fs.readFileSync(JOURNAL_PATH, 'utf8'));
});


// ==========================================================
//  BREAK & BOUNCE — auto-ranker + email
// ==========================================================

const sgMail      = require('@sendgrid/mail');
const yahooFinance = require('yahoo-finance2').default;

const BB_EMAIL = 'jaidan2003@hotmail.com';

const BB_TIERS = {
    TSLA:1, NVDA:1, AAPL:1, META:1, AMD:1, MSFT:1,
    MSTR:2, COIN:2, NFLX:2,
    SPY:3, QQQ:3,
    PLTR:4, SOFI:4
};
const TIER_SCORE = { 1:20, 2:14, 3:16, 4:8 };

// Parse: "BUY PUT TSLA [ENGULF] Entry 394.11 | SL 396.24 | TP1 389.85 | TP2 387.72"
function parseBBAlert(text) {
    if (!text) return null;
    const m = text.match(/BUY\s+(CALL|PUT)\s+(\w+)\s+\[([^\]]+)\]\s*Entry\s+([\d.]+)\s*\|\s*SL\s+([\d.]+)\s*\|\s*TP1\s+([\d.]+)\s*\|\s*TP2\s+([\d.]+)/i);
    if (!m) return null;
    return {
        direction: m[1].toUpperCase(),
        ticker:    m[2].toUpperCase(),
        pattern:   m[3],
        entry:     parseFloat(m[4]),
        sl:        parseFloat(m[5]),
        tp1:       parseFloat(m[6]),
        tp2:       parseFloat(m[7])
    };
}

async function fetchBBMarketData(ticker) {
    try {
        const [hist, spyH, qqqH] = await Promise.all([
            yahooFinance.historical(ticker, { period1: '30d', interval: '1d' }),
            yahooFinance.historical('SPY',  { period1: '5d',  interval: '1d' }),
            yahooFinance.historical('QQQ',  { period1: '5d',  interval: '1d' })
        ]);
        if (!hist || hist.length < 5) return null;
        const atr5 = hist.slice(-5).reduce((s, d) => s + (d.high - d.low), 0) / 5;
        const vol20avg = hist.slice(-20).reduce((s, d) => s + d.volume, 0) / Math.min(hist.length, 20);
        const volRatio = vol20avg > 0 ? hist[hist.length - 1].volume / vol20avg : 1.0;
        const spyUp = spyH.length >= 2 && spyH[spyH.length-1].close > spyH[spyH.length-2].close;
        const qqqUp = qqqH.length >= 2 && qqqH[qqqH.length-1].close > qqqH[qqqH.length-2].close;
        return { atr5, volRatio, spyUp, qqqUp };
    } catch (e) {
        console.error('[BB] fetchMarketData error:', e.message);
        return null;
    }
}

function scoreBBSignal(signal, market, receivedAt) {
    let score = 0;
    const bd = {};

    // Tier (20 pts)
    const tier = BB_TIERS[signal.ticker] || 4;
    const tierPts = TIER_SCORE[tier] || 8;
    score += tierPts;
    bd.tier = `${tierPts}/20 (Tier ${tier})`;

    // ATR vs SL (25 pts)
    const slDist = Math.abs(signal.entry - signal.sl);
    let atrPts = 5;
    if (market && market.atr5 > 0) {
        const r = market.atr5 / slDist;
        if (r >= 2.0)      atrPts = 25;
        else if (r >= 1.5) atrPts = 18;
        else if (r >= 1.0) atrPts = 12;
    }
    score += atrPts;
    bd.atr = `${atrPts}/25`;

    // Market alignment (20 pts)
    let mktPts = 0;
    if (market) {
        const bull = signal.direction === 'CALL';
        mktPts = [(bull ? market.spyUp : !market.spyUp), (bull ? market.qqqUp : !market.qqqUp)]
            .filter(Boolean).length * 10;
    }
    score += mktPts;
    bd.market = `${mktPts}/20`;

    // Time of day ET (20 pts)  — accounts for EDT (UTC-4) and EST (UTC-5)
    const utcH = receivedAt.getUTCHours() + receivedAt.getUTCMinutes() / 60;
    const etH  = (utcH - 4 + 24) % 24;   // rough EDT offset
    let timePts = 0;
    if      (etH < 10.0) timePts = 20;
    else if (etH < 10.5) timePts = 15;
    else if (etH < 11.0) timePts = 10;
    else if (etH < 11.5) timePts = 5;
    score += timePts;
    bd.time = `${timePts}/20`;

    // Volume (15 pts)
    let volPts = 0;
    if (market) {
        if      (market.volRatio >= 1.5)  volPts = 15;
        else if (market.volRatio >= 1.0)  volPts = 10;
        else if (market.volRatio >= 0.75) volPts = 5;
    }
    score += volPts;
    bd.volume = `${volPts}/15`;

    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';
    return { score, grade, breakdown: bd, tier };
}

function buildBBEmail(results, receivedAt) {
    const etStr   = receivedAt.toLocaleString('en-US', { timeZone: 'America/New_York', hour12:false });
    const aestStr = receivedAt.toLocaleString('en-AU', { timeZone: 'Australia/Sydney',  hour12:false });
    const gc = { A:'#2e7d32', B:'#1565c0', C:'#f57f17', D:'#c62828' };

    let rows = '';
    results.forEach((r, i) => {
        const badge = i === 0
            ? '<span style="background:#2e7d32;color:#fff;padding:2px 6px;border-radius:3px;font-size:11px;">TRADE THIS</span>'
            : '<span style="background:#888;color:#fff;padding:2px 6px;border-radius:3px;font-size:11px;">SKIP</span>';
        rows += `
<tr style="background:${i%2===0?'#f9f9f9':'#fff'};">
  <td style="padding:8px;"><b>#${i+1} ${r.signal.ticker}</b> ${badge}</td>
  <td style="padding:8px;">${r.signal.direction}</td>
  <td style="padding:8px;">${r.signal.pattern}</td>
  <td style="padding:8px;">${r.signal.entry}</td>
  <td style="padding:8px;">${r.signal.sl}</td>
  <td style="padding:8px;">${r.signal.tp1} / ${r.signal.tp2}</td>
  <td style="padding:8px;font-weight:bold;color:${gc[r.scored.grade]||'#333'};">${r.scored.score}/100 (${r.scored.grade})</td>
</tr>
<tr>
  <td colspan="7" style="padding:3px 8px;font-size:11px;color:#888;background:#f5f5f5;">
    Tier: ${r.scored.breakdown.tier} &nbsp;|&nbsp;
    ATR/SL: ${r.scored.breakdown.atr} &nbsp;|&nbsp;
    Market: ${r.scored.breakdown.market} &nbsp;|&nbsp;
    Time: ${r.scored.breakdown.time} &nbsp;|&nbsp;
    Volume: ${r.scored.breakdown.volume}
  </td>
</tr>`;
    });

    const top = results[0];
    const cmd = top
        ? `python options_sizing.py --entry ${top.signal.entry} --stop ${top.signal.sl} --${top.signal.direction==='CALL'?'long':'short'}`
        : '';

    return `<html><body style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222;font-size:13px;">
<div style="background:#1a1a2e;color:#fff;padding:12px 16px;border-radius:4px 4px 0 0;">
  <h2 style="margin:0;font-size:16px;">Break &amp; Bounce &mdash; Alert Ranker</h2>
  <p style="margin:4px 0 0;font-size:11px;color:#aaa;">${etStr} ET &nbsp;|&nbsp; ${aestStr} AEST</p>
</div>
<div style="padding:12px 16px;background:#e8f5e9;border-left:4px solid #2e7d32;">
  <b>Top pick: ${top?top.signal.ticker+' '+top.signal.direction:'N/A'}</b>
  &nbsp; Score: ${top?top.scored.score+'/100 ('+top.scored.grade+')':'N/A'}
  ${cmd?`<br><code style="font-size:11px;color:#555;">${cmd}</code>`:''}
</div>
<table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin-top:12px;">
  <tr style="background:#1a1a2e;color:#fff;font-size:12px;">
    <th style="padding:6px;">Ticker</th><th style="padding:6px;">Dir</th>
    <th style="padding:6px;">Pattern</th><th style="padding:6px;">Entry</th>
    <th style="padding:6px;">SL</th><th style="padding:6px;">TP1/TP2</th>
    <th style="padding:6px;">Score</th>
  </tr>
  ${rows}
</table>
<div style="margin-top:12px;padding:10px;background:#fff8e1;border-left:4px solid #f57f17;font-size:12px;">
  <b>Next steps:</b> Run options_sizing.py (command above) &rarr;
  MooMoo Options &rarr; Today 0DTE &rarr; ATM strike &rarr;
  TradingView triangle visible? &rarr; Limit order within 5 min &rarr;
  Hard close 2:00 AM AEST
</div>
<p style="font-size:10px;color:#aaa;margin-top:16px;">
  Break &amp; Bounce Ranker &nbsp;|&nbsp; Alert expiry: 2026-06-30 &nbsp;|&nbsp; Max risk $250/trade
</p>
</body></html>`;
}

async function sendBBEmail(html, subject) {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) { console.error('[BB] SENDGRID_API_KEY not set'); return false; }
    sgMail.setApiKey(apiKey);
    try {
        await sgMail.send({
            to:      BB_EMAIL,
            from:    process.env.SENDGRID_FROM || 'alerts@algoengine.io',
            subject,
            html
        });
        console.log('[BB] Ranker email sent to', BB_EMAIL);
        return true;
    } catch (e) {
        console.error('[BB] SendGrid error:', e.message);
        return false;
    }
}

// POST /bb-webhook  — TradingView fires this on every B&B alert
app.post('/bb-webhook', async (req, res) => {
    const receivedAt = new Date();
    const payload    = req.body;
    console.log('[BB] Raw payload:', JSON.stringify(payload, null, 2));

    const rawText = payload.alert_message || payload.message || '';
    const signal  = parseBBAlert(rawText);

    if (!signal) {
        console.warn('[BB] Could not parse B&B alert from:', rawText);
        return res.status(200).json({ status: 'ignored', reason: 'not a B&B alert' });
    }
    console.log('[BB] Parsed signal:', signal);

    const market = await fetchBBMarketData(signal.ticker);
    const scored = scoreBBSignal(signal, market, receivedAt);

    const subj = `B&B Alert: ${signal.ticker} ${signal.direction} — Score ${scored.score}/100 (${scored.grade})`;
    const html = buildBBEmail([{ signal, scored }], receivedAt);
    await sendBBEmail(html, subj);

    const logPath = path.join(__dirname, 'bb-webhook-log.ndjson');
    fs.appendFile(logPath, JSON.stringify({ receivedAt: receivedAt.toISOString(), signal, scored }) + '\n', () => {});

    res.status(200).json({ status: 'ok', ticker: signal.ticker, score: scored.score, grade: scored.grade });
});

// GET /bb-log  — view received B&B alerts
app.get('/bb-log', (req, res) => {
    const logPath = path.join(__dirname, 'bb-webhook-log.ndjson');
    if (!fs.existsSync(logPath)) return res.send('No B&B alerts logged yet.');
    res.type('text/plain').send(fs.readFileSync(logPath, 'utf8'));
});


// ==========================================================
//  Start server
// ==========================================================
app.listen(PORT, () => {
    console.log(`Webhook server running on port ${PORT}`);
});