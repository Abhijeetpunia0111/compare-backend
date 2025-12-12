// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer'); // keep puppeteer (not puppeteer-core) unless you intentionally use core
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname)); // serve static if needed

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
});

// Sessions map (optional - not heavily used here)
const sessions = new Map();

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
// Frame interval in ms (33ms ≈ 30fps). Increase if you want lower CPU/bandwidth.
const FRAME_INTERVAL_MS = 33;

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  let browser = null;
  let page = null;
  let cdpClient = null; // CDP session
  let streaming = false;
  let streamTimeout = null;

  // Helper to stop streaming
  const stopStreaming = async () => {
    streaming = false;
    if (streamTimeout) {
      clearTimeout(streamTimeout);
      streamTimeout = null;
    }
  };

  // Helper to close page/browser
  const cleanupBrowser = async () => {
    try {
      if (cdpClient) {
        try { await cdpClient.detach(); } catch (e) {}
        cdpClient = null;
      }
      if (page) {
        try { await page.close(); } catch (e) {}
        page = null;
      }
      if (browser) {
        try { await browser.close(); } catch (e) {}
        browser = null;
      }
    } catch (err) {
      console.error('Error during browser cleanup:', err);
    }
  };

  socket.on('start-session', async ({ url, width, height }) => {
    // Basic validation
    if (!url) {
      socket.emit('error', 'No URL provided');
      return;
    }

    // Ensure previous browser/page cleaned
    await stopStreaming();
    await cleanupBrowser();

    // Determine executable path from environment if provided (Render, Docker, custom)
    const chromeExec =
      process.env.CHROME_EXECUTABLE ||
      process.env.CHROME_PATH ||
      process.env.CHROME_BIN ||
      null;

    const launchOpts = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
      ],
      defaultViewport: null,
      ignoreHTTPSErrors: true,
    };

    if (chromeExec) {
      launchOpts.executablePath = chromeExec;
    }

    try {
      console.log('Launching browser. executablePath:', launchOpts.executablePath || '(auto)');
      browser = await puppeteer.launch(launchOpts);

      page = await browser.newPage();

      // Set user agent to reduce bot-detection
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Create CDP session for events and advanced commands
      cdpClient = await page.target().createCDPSession();
      await cdpClient.send('Page.enable');

      cdpClient.on('Page.frameStartedLoading', () => {
        socket.emit('loading-start');
      });

      cdpClient.on('Page.loadEventFired', () => {
        socket.emit('loading-end');
      });

      cdpClient.on('Page.frameStoppedLoading', () => {
        socket.emit('loading-end');
      });

      // Console logs from page - for debugging
      page.on('console', (msg) => {
        try {
          console.log('PAGE LOG:', msg.text());
        } catch (e) {}
      });

      // Spoof WebGL vendor/renderer to look more like a real GPU (runs in page context)
      await page.evaluateOnNewDocument(() => {
        try {
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function (parameter) {
            // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
            if (parameter === 37445) return 'Intel Open Source Technology Center';
            if (parameter === 37446) return 'Mesa DRI Intel(R) HD Graphics 630 (Kaby Lake GT2)';
            return getParameter.apply(this, arguments);
          };
        } catch (e) {
          // ignore if page doesn't support WebGL or environment blocks it
        }
      });

      // Set viewport
      const vw = width || DEFAULT_WIDTH;
      const vh = height || DEFAULT_HEIGHT;
      await page.setViewport({ width: vw, height: vh });

      // Navigate
      console.log(`Navigating to ${url} (viewport ${vw}x${vh})`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Start streaming screenshots
      streaming = true;
      socket.emit('session-started');

      const captureFrame = async () => {
        if (!streaming || !page || !browser || !socket.connected) return;

        try {
          const screenshot = await page.screenshot({
            encoding: 'base64',
            type: 'jpeg',
            quality: 70,
          });
          // emit frame
          socket.emit('frame', screenshot);
        } catch (err) {
          console.log('Frame capture error (stopping stream):', err && err.message ? err.message : err);
          streaming = false;
          return;
        }

        // schedule next frame
        streamTimeout = setTimeout(captureFrame, FRAME_INTERVAL_MS);
      };

      // initial kick
      captureFrame();
    } catch (err) {
      console.error('Session start error:', err && err.message ? err.message : err);
      // Helpful log when chrome missing
      if (!chromeExec) {
        console.error('Tip: If Chrome is not bundled, set CHROME_EXECUTABLE env var to the path of the chrome binary (e.g. /usr/bin/google-chrome-stable).');
      } else {
        console.error('Tried CHROME_EXECUTABLE:', chromeExec);
      }
      socket.emit('error', 'Failed to start session: ' + (err && err.message ? err.message : String(err)));
      // attempt cleanup
      await stopStreaming();
      await cleanupBrowser();
    }
  });

  socket.on('input-event', async (event) => {
    if (!page) return;
    try {
      switch (event.type) {
        case 'click':
          await page.mouse.click(event.x, event.y);
          break;
        case 'mousemove':
          await page.mouse.move(event.x, event.y);
          break;
        case 'scroll':
          await page.mouse.wheel({ deltaX: event.deltaX || 0, deltaY: event.deltaY || 0 });
          break;
        case 'zoom':
          // Use CDP to set page scale (best-effort)
          if (cdpClient) {
            try {
              await cdpClient.send('Emulation.setPageScaleFactor', { pageScaleFactor: event.scale });
            } catch (e) {
              console.warn('Zoom emulation failed:', e && e.message ? e.message : e);
            }
          }
          break;
        case 'keydown':
          // map keys carefully — using press for single-key events
          await page.keyboard.press(event.key);
          break;
        case 'type':
          await page.keyboard.type(event.text);
          break;
      }
    } catch (err) {
      console.error('Input error:', err && err.message ? err.message : err);
    }
  });

  socket.on('resize', async ({ width, height }) => {
    if (!page) return;
    try {
      const w = width || DEFAULT_WIDTH;
      const h = height || DEFAULT_HEIGHT;
      console.log(`Resizing viewport to ${w}x${h}`);
      await page.setViewport({ width: w, height: h });
    } catch (err) {
      console.error('Resize error:', err && err.message ? err.message : err);
    }
  });

  socket.on('navigate', async (newUrl) => {
    if (!page) return;
    try {
      console.log('Navigate to:', newUrl);
      await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err) {
      console.error('Navigation error:', err && err.message ? err.message : err);
    }
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    await stopStreaming();
    await cleanupBrowser();
  });

  // Defensive: if the socket errors, cleanup
  socket.on('error', async (err) => {
    console.error('Socket error:', err);
    await stopStreaming();
    await cleanupBrowser();
  });
});

// Graceful shutdown for process signals
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

const graceful = async () => {
  console.log('Shutting down gracefully...');
  try {
    await new Promise((res) => server.close(res));
  } catch (e) {
    console.error('Error closing server:', e);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);
