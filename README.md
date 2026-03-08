# YOGESHISALLAH

This workspace contains a single-page React app (`App.jsx` – previously `sue-the-system-pro (1).jsx`) that powers an "AI‑powered legal engine".
## Setup

### Create a .env file

Create a `.env` file in the project root with your AI configuration:

```env
# Use Featherless API (recommended - low cost)
USE_FEATHERLESS=true
FEATHERLESS_API_KEY=your_api_key_here
FEATHERLESS_MODEL=llama-3-8b-instruct

# Alternative: Anthropic Claude
# ANTHROPIC_API_KEY=your_api_key_here
```

**The `.env` file is in .gitignore - never commit real API keys!**
## Running in a browser

You can open the UI directly in Chrome (or any modern browser) without a build step:

1. Make sure `index.html` and `App.jsx` are in the same folder.
2. Open `index.html` in Chrome by double‑clicking or dragging it into the browser. No server is required — the page now loads and compiles `App.jsx` directly with Babel, so it works over `file://`.

   If you ever prefer to serve it via HTTP (e.g. to avoid any browser restrictions), you still can using a simple server:

   ```bash
   python -m http.server 8080
   # or, if you have Node: npx http-server .
   ```

   then visit `http://localhost:8080`.

The page will load React/ReactDOM from CDNs and use Babel to transpile the JSX file on the fly. The app renders itself into `#root`.

For a more production‑ready setup, you can scaffold a proper React project (Create React App, Vite, etc.) and import the component as `App.jsx`.

### API key and billing (skip if running locally)

By default the app talks to Anthropic’s Claude API, which requires a paid key. On first use it will prompt you for that key and store it in `localStorage`.

The API is pay‑as‑you‑go; you must have a positive credit balance to make requests. A low‑balance error will be shown in the UI, and you can top up at https://console.anthropic.com/.

If you're running inside a claude.ai environment the prompt is skipped and the request goes through the built‑in proxy.

(You can always open `App.jsx` and hardcode `API_KEY` if you prefer.)

### Running completely free with a local model

To avoid billing altogether you can run a small local server that hosts an open‑source model. Follow these steps:

1. Install Python dependencies:
   ```bash
   pip install fastapi uvicorn transformers torch
   ```
2. Run the supplied server script:
   ```bash
   python local_server.py
   ```
   It listens on `http://127.0.0.1:5000/generate` and includes CORS headers so requests work even when the page is loaded via `file://`.
   **Start the server before opening `index.html`**; if the page loads while the server is down you may see a blank screen because the fetch will fail early.
3. In `App.jsx`, ensure the constant `USE_LOCAL` is set to `true` (this is already the default in the workspace). Reload `index.html` in your browser.

With the local server running the web page will call it instead of Anthropic, so **no API key or credits are needed**. The quality will be lower (the default model is GPT‑2), but it’s entirely free and works offline.

#### Troubleshooting

- If the page still shows a white screen or you see `Error: Failed to fetch`, open the browser console (F12) and look at the network tab. You should see a request to `/generate` – check its status and any error text.
- Make sure the Python server is up **before** loading the page; the app now pings `http://127.0.0.1:5000` when you hit "Build My Case" and will show an error message if it can't connect.
- Running the Python script in the same folder will output `Uvicorn running on http://127.0.0.1:5000` when it's ready. If you get a dependency error, re-run `pip install fastapi uvicorn transformers torch`.

---
