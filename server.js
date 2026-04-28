const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

app.post("/webhook", (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(__dirname, "signals", `signal-${timestamp}.json`);

  fs.mkdirSync(path.join(__dirname, "signals"), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));

  console.log("Saved signal:", filePath);
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
