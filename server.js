// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Parse JSON bodies
app.use(express.json());

// --- PARSER: turns alert_message text into structured data ---
function parseAlertMessage(text) {
    const result = {
        direction: null,
        symbol: null,
        entry: null,
        sl: null,
        tp: null,
        lots: null,
        risk: null,
        type: null
    };

    if (!text || typeof text !== 'string') {
        return result;
    }

    // Type / direction
    if (text.includes("BUY SIGNAL")) result.direction = "BUY";
    if (text.includes("SELL SIGNAL")) result.direction = "SELL";
    if (text.includes("TIME EXIT")) result.type = "TIME_EXIT";
    if (text.includes("CIRCUIT BREAKER")) result.type = "CIRCUIT_BREAKER";

    // Symbol (e.g. GBPUSD)
    const symbolMatch = text.match(/([A-Z]{6})/);
    if (symbolMatch) result.symbol = symbolMatch[1];

    // Numbers
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

// --- Simple root route so you don't see "Cannot GET /" ---
app.get('/', (req, res) => {
    res.send('London Sniper Webhook is online.');
});

// --- Main webhook endpoint ---
app.post('/webhook', (req, res) => {
    const payload = req.body;

    console.log('RAW WEBHOOK DATA:', JSON.stringify(payload, null, 2));

    let parsed = null;
    if (payload && payload.alert_message) {
        parsed = parseAlertMessage(payload.alert_message);
        console.log('PARSED SIGNAL:', parsed);
    } else {
        console.log('No alert_message field found in payload.');
    }

    // --- Simple file logging (NDJSON format) ---
    const logEntry = {
        receivedAt: new Date().toISOString(),
        raw: payload,
        parsed
    };

    const logPath = path.join(__dirname, 'webhook-log.ndjson');
    fs.appendFile(logPath, JSON.stringify(logEntry) + '\n', (err) => {
        if (err) {
            console.error('Error writing log file:', err);
        }
    });

    res.status(200).json({ status: 'ok' });
});

// --- Start server ---
app.listen(PORT, () => {
    console.log(`Webhook server running on port ${PORT}`);
});
