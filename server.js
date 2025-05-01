const express = require('express');
const qrcode = require('qrcode');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
// For auto open browser - uncomment for development, keep commented for production
// const open = require('open');

const app = express();

// 👇 Middleware to allow JSON body
app.use(express.json());

// Auth directory path
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

// Function to check if auth directory exists
function checkAuthExists() {
  return fs.existsSync(AUTH_DIR);
}

// Set up logging with timestamps
function log(message) {
  const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  console.log(`[${timestamp}] ${message}`);
}

// Global variables
let qrCodeData = '';
let isLoggedIn = false;
let loggedInNumber = '';
let connectionState = 'INITIALIZING';
let client = null;
let isClientDestroying = false;
let reconnectionTimer = null;
let monitoringTimer = null;
let connectionCheckTimer = null; // New timer for active connection checks
let lastConnectionAttempt = 0;
let reconnectionAttempts = 0;
let lastKnownState = null; // Track the last known state
let lastActiveTimestamp = 0; // Track when we last confirmed the connection was active
const MAX_RECONNECTION_ATTEMPTS = 3;
const MIN_RECONNECT_INTERVAL = 30000; // 30 seconds between reconnection attempts
const CONNECTION_CHECK_INTERVAL = 15000; // Check connection every 15 seconds

// Function to safely destroy client
async function destroyClient() {
  if (client && !isClientDestroying) {
    isClientDestroying = true;
    try {
      log('🛑 Destroying existing WhatsApp client...');
      await client.destroy();
      log('✅ Client destroyed successfully');
    } catch (error) {
      log(`❌ Error destroying client: ${error.message}`);
    } finally {
      client = null;
      isClientDestroying = false;
      isLoggedIn = false;
      connectionState = 'DISCONNECTED';
    }
  }
}

// Function to clean auth directory
function cleanAuthDirectory() {
  return new Promise((resolve) => {
    if (!checkAuthExists()) {
      log('📁 Auth directory does not exist, nothing to clean');
      resolve(true);
      return;
    }

    try {
      // Delete auth directory recursively
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      log('🧹 Auth directory cleaned');
      resolve(true);
    } catch (error) {
      log(`❌ Error cleaning auth directory: ${error.message}`);
      resolve(false);
    }
  });
}

// Active check for connection state
async function checkActiveConnection() {
  if (!client || !isLoggedIn) return;

  try {
    // Try to get state as a live check
    const state = await client.getState();
    lastKnownState = state;
    lastActiveTimestamp = Date.now();
    
    log(`🔍 Active connection check: ${state}`);
    
    if (state === 'CONNECTED') {
      // All good, connection is active
      connectionState = 'CONNECTED';
    } else if (state === 'DISCONNECTED') {
      log('⚠️ Active check detected disconnection');
      handleDisconnection('Connection check detected disconnected state');
    } else {
      // Handle other states like CONNECTING
      connectionState = state;
    }
  } catch (error) {
    log(`❌ Active connection check failed: ${error.message}`);
    
    // If we can't get state, the connection might be broken
    if (Date.now() - lastActiveTimestamp > 30000) { // If no successful check in last 30 seconds
      log('⚠️ Connection appears to be broken after failed state checks');
      handleDisconnection('Failed connection checks');
    }
  }
}

// Centralized function to handle disconnection
async function handleDisconnection(reason) {
  log(`🔌 Handling disconnection: ${reason}`);
  connectionState = 'DISCONNECTED';
  isLoggedIn = false;
  loggedInNumber = '';
  
  // Stop active connection checking
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }
  
  // Destroy the client
  await destroyClient();
  
  // Schedule reconnection attempt if not already scheduled
  if (!reconnectionTimer) {
    reconnectionTimer = setTimeout(async () => {
      reconnectionTimer = null;
      reconnectionAttempts++;
      
      if (reconnectionAttempts > MAX_RECONNECTION_ATTEMPTS) {
        log('⚠️ Maximum reconnection attempts reached. Cleaning auth...');
        await cleanAuthDirectory();
        reconnectionAttempts = 0;
      }
      
      // Try to reconnect
      initializeWhatsAppClient();
    }, 5000);
  }
}

// Function to initialize WhatsApp client
async function initializeWhatsAppClient() {
  // Prevent multiple initialization attempts
  if (client || isClientDestroying) {
    log('⚠️ Client initialization already in progress...');
    return;
  }

  // Minimum time between attempts
  const now = Date.now();
  if (now - lastConnectionAttempt < MIN_RECONNECT_INTERVAL) {
    const waitTime = MIN_RECONNECT_INTERVAL - (now - lastConnectionAttempt);
    log(`⏳ Too many connection attempts. Waiting ${waitTime/1000} seconds...`);
    return;
  }
  lastConnectionAttempt = now;

  log('🔄 Initializing WhatsApp client...');
  connectionState = 'INITIALIZING';
  isLoggedIn = false;
  qrCodeData = '';

  // Create a fresh client instance
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2409.2.html'
    }
  });

  // Set up event handlers
  client.on('qr', async (qr) => {
    log('📱 QR Code received');
    qrCodeData = await qrcode.toDataURL(qr);
    connectionState = 'QR_READY';
  });

  client.on('authenticated', () => {
    log('🔐 Authentication successful!');
    connectionState = 'AUTHENTICATED';
    qrCodeData = '';
  });

  client.on('auth_failure', async (error) => {
    log(`❌ Authentication failed: ${error}`);
    await handleDisconnection('Authentication failure');
    
    // Schedule cleanup after a delay
    setTimeout(async () => {
      await cleanAuthDirectory();
      
      // Try to reinitialize after cleanup
      setTimeout(() => {
        initializeWhatsAppClient();
      }, 5000);
    }, 2000);
  });

  client.on('ready', () => {
    log('✅ Client is ready!');
    isLoggedIn = true;
    connectionState = 'CONNECTED';
    reconnectionAttempts = 0;
    lastActiveTimestamp = Date.now();
    
    try {
      loggedInNumber = client.info.wid.user;
      log(`📱 Connected with number: +${loggedInNumber}`);
      
      // Start active connection checking
      if (connectionCheckTimer) clearInterval(connectionCheckTimer);
      connectionCheckTimer = setInterval(checkActiveConnection, CONNECTION_CHECK_INTERVAL);
    } catch (error) {
      log(`⚠️ Could not get connected number: ${error.message}`);
    }
  });

  client.on('disconnected', async (reason) => {
    log(`❌ Client disconnected event: ${reason}`);
    await handleDisconnection(`Client disconnected: ${reason}`);
  });

  // Additional event to detect when WhatsApp Web is logged out
  client.on('change_state', (state) => {
    log(`🔄 Connection state changed to: ${state}`);
    lastKnownState = state;
    
    if (state === 'DISCONNECTED') {
      handleDisconnection('State changed to DISCONNECTED');
    }
  });
  
  // Handle when device is unpaired (important for detecting manual unlinking)
  client.on('change_battery', async (batteryInfo) => {
    log(`🔋 Battery state updated: ${JSON.stringify(batteryInfo)}`);
    // This event confirms connection is still alive
    lastActiveTimestamp = Date.now();
  });

  // Try to initialize
  try {
    log('🚀 Starting WhatsApp client...');
    await client.initialize();
  } catch (error) {
    log(`❌ Client initialization failed: ${error.message}`);
    await handleDisconnection(`Initialization failed: ${error.message}`);
    
    if (!reconnectionTimer) {
      reconnectionTimer = setTimeout(async () => {
        reconnectionTimer = null;
        await cleanAuthDirectory();
        initializeWhatsAppClient();
      }, 5000);
    }
  }
}

// Start periodic monitoring of connection status
function startMonitoring() {
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
  }
  
  monitoringTimer = setInterval(async () => {
    if (isLoggedIn) {
      // Check if the session is actually still valid
      try {
        if (client) {
          const state = await client.getState();
          log(`📱 Connection status: ${state} for +${loggedInNumber}`);
          lastKnownState = state;
          lastActiveTimestamp = Date.now();
          
          if (state !== 'CONNECTED') {
            log(`⚠️ State not CONNECTED but ${state}, checking connection...`);
            // Don't immediately disconnect - give it a chance to recover
            // The active connection check will handle this
          }
        } else {
          log('⚠️ Client is null but isLoggedIn is true - fixing state');
          isLoggedIn = false;
          connectionState = 'DISCONNECTED';
        }
      } catch (error) {
        log(`❌ Error checking connection: ${error.message}`);
        
        // If we haven't had a successful check in a while, consider connection lost
        if (Date.now() - lastActiveTimestamp > 30000) { // 30 seconds
          log('⚠️ Connection appears to be lost, triggering reconnection');
          await handleDisconnection('Failed state check in monitoring');
        }
      }
    } else {
      log(`🔄 Connection status check: ${connectionState}`);
      
      // If client doesn't exist and we're not in the middle of connecting
      if (!client && !isClientDestroying && !reconnectionTimer) {
        // If auth exists but we're not logged in, try to reconnect
        if (checkAuthExists()) {
          log('📂 Auth exists but not connected. Attempting to reconnect...');
          
          reconnectionAttempts++;
          log(`🔄 Reconnection attempt ${reconnectionAttempts} of ${MAX_RECONNECTION_ATTEMPTS}`);
          
          if (reconnectionAttempts > MAX_RECONNECTION_ATTEMPTS) {
            log('⚠️ Too many reconnection failures. Cleaning auth...');
            await cleanAuthDirectory();
            reconnectionAttempts = 0;
          }
          
          // Try to initialize again
          initializeWhatsAppClient();
        } else {
          log('📂 No auth exists. Will initialize fresh client...');
          initializeWhatsAppClient();
        }
      }
    }
  }, 60000); // Check every minute
}

// Ping test route to test connection
app.get('/ping', async (req, res) => {
  if (!isLoggedIn || !client) {
    return res.status(200).json({
      success: false,
      status: connectionState,
      message: 'WhatsApp not connected'
    });
  }

  try {
    const state = await client.getState();
    lastKnownState = state;
    lastActiveTimestamp = Date.now();
    
    return res.status(200).json({
      success: true,
      status: state,
      number: loggedInNumber,
      message: 'Connection active'
    });
  } catch (error) {
    log(`❌ Ping check failed: ${error.message}`);
    
    return res.status(200).json({
      success: false,
      status: 'ERROR',
      message: `Failed to check state: ${error.message}`
    });
  }
});

// Web server routes
app.get('/', (req, res) => {
  if (isLoggedIn) {
    res.send(`
      <html>
        <head>
          <title>WhatsApp Status</title>
          <meta http-equiv="refresh" content="30">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; flex-direction: column; background-color: #f0f2f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
            .success { color: #128C7E; }
            .refresh { color: #777; font-size: 12px; margin-top: 20px; }
            .actions { margin-top: 20px; }
            .btn { background: #128C7E; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; margin: 0 5px; }
            .btn-danger { background: #e74c3c; }
            .btn-warning { background: #f39c12; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2 class="success">✅ Connected with +${loggedInNumber}</h2>
            <p>WhatsApp session is active and being monitored.</p>
            <p>Current status: ${connectionState}</p>
            <p>Last check: ${new Date().toLocaleTimeString()}</p>
            <div class="actions">
              <button class="btn" onclick="pingConnection()">Check Connection</button>
              <button class="btn btn-warning" onclick="logoutConnection()">Logout Device</button>
              <button class="btn btn-danger" onclick="resetConnection()">Reset Connection</button>
            </div>
            <p class="refresh">Page refreshes automatically every 30 seconds.</p>
            <div id="ping-result" style="margin-top: 15px;"></div>
          </div>
          
          <script>
            function pingConnection() {
              document.getElementById('ping-result').innerHTML = 'Checking connection...';
              fetch('/ping')
                .then(response => response.json())
                .then(data => {
                  document.getElementById('ping-result').innerHTML = 
                    data.success ? 
                    '<span style="color:#128C7E">✅ Connection active: ' + data.status + '</span>' : 
                    '<span style="color:#e74c3c">❌ Connection issue: ' + data.message + '</span>';
                })
                .catch(err => {
                  document.getElementById('ping-result').innerHTML = 
                    '<span style="color:#e74c3c">❌ Error checking connection</span>';
                });
            }
            
            function resetConnection() {
              if (confirm('Are you sure you want to reset the WhatsApp connection?')) {
                fetch('/reset', { method: 'POST' })
                  .then(response => response.text())
                  .then(data => {
                    alert(data);
                    setTimeout(() => location.reload(), 1000);
                  })
                  .catch(err => {
                    alert('Error resetting connection');
                  });
              }
            }
            
            function logoutConnection() {
              if (confirm('Are you sure you want to logout this device from WhatsApp?')) {
                fetch('/logout', { method: 'POST' })
                  .then(response => response.text())
                  .then(data => {
                    alert(data);
                    setTimeout(() => location.reload(), 1000);
                  })
                  .catch(err => {
                    alert('Error logging out');
                  });
              }
            }
          </script>
        </body>
      </html>
    `);
  } else if (qrCodeData) {
    res.send(`
      <html>
        <head>
          <title>Scan QR Code</title>
          <meta http-equiv="refresh" content="5">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; flex-direction: column; background-color: #f0f2f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
            img { max-width: 300px; border: 1px solid #ddd; padding: 10px; margin: 20px 0; }
            .refresh { color: #777; font-size: 12px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Scan QR Code with WhatsApp</h2>
            <p>Open WhatsApp on your phone, go to Settings > Linked Devices > Link a Device</p>
            <img src="${qrCodeData}" alt="WhatsApp QR Code" />
            <p>Current status: ${connectionState}</p>
            <p class="refresh">Page refreshes automatically every 5 seconds.</p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="3">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; flex-direction: column; background-color: #f0f2f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
            .waiting { color: #E37400; }
            .refresh { color: #777; font-size: 12px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2 class="waiting">⏳ Preparing WhatsApp Connection...</h2>
            <p>Current status: ${connectionState}</p>
            <p class="refresh">Page refreshes automatically every 3 seconds.</p>
          </div>
        </body>
      </html>
    `);
  }
});

// Send text message
app.post('/send-text', async (req, res) => {
    const { number, message } = req.body;
  
    if (!number || !message) {
      return res.status(400).send('❌ Missing number or message');
    }
  
    try {
      if (!isLoggedIn || !client) {
        return res.status(503).send('❌ WhatsApp not connected. Please scan QR code first.');
      }
  
      const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
  
      const sendPromise = client.sendMessage(chatId, message);
      await Promise.race([
        sendPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Send timeout')), 20000)
        )
      ]);
      
      log(`✅ Text message sent to ${number}`);
      lastActiveTimestamp = Date.now();
      
      res.send('✅ Message sent successfully!');
    } catch (error) {
      log(`❌ Error sending message to ${number}: ${error.message}`);
      
      if (
        error.message &&
        (error.message.includes('Connection closed') ||
         error.message.includes('not connected') ||
         error.message.includes('terminated') ||
         error.message.includes('timeout'))
      ) {
        await handleDisconnection(`Message send failure: ${error.message}`);
        return res.status(503).send('❌ WhatsApp disconnected. Reinitializing connection. Please try again later.');
      }
      
      checkActiveConnection();
      res.status(500).send(`❌ Failed to send message: ${error.message}`);
    }
});

// Send HD media message
// app.post('/send-messagehd', async (req, res) => {
//     const { number, message, image } = req.body;
  
//     if (!number || (!message && !image)) {
//       return res.status(400).send('❌ Missing number or message/image');
//     }
  
//     try {
//       if (!isLoggedIn || !client) {
//         return res.status(503).send('❌ WhatsApp not connected. Please scan QR code first.');
//       }
  
//       const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
  
//       if (image) {
//         const imagePath = path.join(__dirname, 'uploads', image);
  
//         if (!fs.existsSync(imagePath)) {
//           return res.status(404).send('❌ Image file not found');
//         }
  
//         try {
//           const media = await MessageMedia.fromFilePath(imagePath);
  
//           const sendPromise = client.sendMessage(chatId, media, {
//             caption: message || '',
//             sendMediaAsDocument: true
//           });
          
//           await Promise.race([
//             sendPromise,
//             new Promise((_, reject) => 
//               setTimeout(() => reject(new Error('Send timeout')), 30000) // Longer timeout for media
//             )
//           ]);
          
//           log(`✅ HD media message sent to ${number}`);
//         } catch (mediaError) {
//           log(`❌ Error sending media to ${number}: ${mediaError.message}`);
//           return res.status(500).send(`❌ Failed to send media: ${mediaError.message}`);
//         }
//       } else {
//         const sendPromise = client.sendMessage(chatId, message);
//         await Promise.race([
//           sendPromise,
//           new Promise((_, reject) => 
//             setTimeout(() => reject(new Error('Send timeout')), 20000)
//           )
//         ]);
        
//         log(`✅ Text message sent to ${number}`);
//       }
  
//       lastActiveTimestamp = Date.now();
//       res.send('✅ Message sent successfully!');
//     } catch (error) {
//       log(`❌ Error sending message to ${number}: ${error.message}`);
      
//       if (
//         error.message &&
//         (error.message.includes('Connection closed') ||
//          error.message.includes('not connected') ||
//          error.message.includes('terminated') ||
//          error.message.includes('timeout'))
//       ) {
//         await handleDisconnection(`Message send failure: ${error.message}`);
//         return res.status(503).send('❌ WhatsApp disconnected. Reinitializing connection. Please try again later.');
//       }
      
//       checkActiveConnection();
//       res.status(500).send(`❌ Failed to send message: ${error.message}`);
//     }
// });

app.post('/send-messagehd', async (req, res) => {
  const { number, message, mediaUrl, mediaType } = req.body;

  if (!number || (!message && !mediaUrl)) {
    return res.status(400).send('❌ Missing number or message/mediaUrl');
  }

  try {
    if (!isLoggedIn || !client) {
      return res.status(503).send('❌ WhatsApp not connected. Please scan QR code first.');
    }

    const chatId = number.includes('@c.us') ? number : `${number}@c.us`;

    if (mediaUrl) {
      try {
        // Load media from URL with unsafe MIME option
        const media = await MessageMedia.fromUrl(mediaUrl, {
          unsafeMime: true,
          mimetype: mediaType // Use provided MIME type if available
        });

        const sendPromise = client.sendMessage(chatId, media, {
          caption: message || '',
          sendMediaAsDocument: true // Send as document
        });
        
        await Promise.race([
          sendPromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Send timeout')), 30000) // Longer timeout for media
          )
        ]);
        
        log(`✅ HD media message sent to ${number} from URL`);
      } catch (mediaError) {
        log(`❌ Error sending media to ${number}: ${mediaError.message}`);
        return res.status(500).send(`❌ Failed to send media: ${mediaError.message}`);
      }
    } else {
      const sendPromise = client.sendMessage(chatId, message);
      await Promise.race([
        sendPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Send timeout')), 20000)
        )
      ]);
      
      log(`✅ Text message sent to ${number}`);
    }

    lastActiveTimestamp = Date.now();
    res.send('✅ Message sent successfully!');
  } catch (error) {
    log(`❌ Error sending message to ${number}: ${error.message}`);
    
    if (
      error.message &&
      (error.message.includes('Connection closed') ||
       error.message.includes('not connected') ||
       error.message.includes('terminated') ||
       error.message.includes('timeout'))
    ) {
      await handleDisconnection(`Message send failure: ${error.message}`);
      return res.status(503).send('❌ WhatsApp disconnected. Reinitializing connection. Please try again later.');
    }
    
    checkActiveConnection();
    res.status(500).send(`❌ Failed to send message: ${error.message}`);
  }
});

// Send regular media message
// app.post('/send-message', async (req, res) => {
//     const { number, message, image } = req.body;
  
//     if (!number || (!message && !image)) {
//       return res.status(400).send('❌ Missing number or message/image');
//     }
  
//     try {
//       if (!isLoggedIn || !client) {
//         return res.status(503).send('❌ WhatsApp not connected. Please scan QR code first.');
//       }
  
//       const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
  
//       if (image) {
//         const imagePath = path.join(__dirname, 'uploads', image);
        
//         if (!fs.existsSync(imagePath)) {
//           return res.status(404).send('❌ Image file not found');
//         }
        
//         try {
//           const media = await MessageMedia.fromFilePath(imagePath);
          
//           const sendPromise = client.sendMessage(chatId, media, { caption: message || '' });
//           await Promise.race([
//             sendPromise,
//             new Promise((_, reject) => 
//               setTimeout(() => reject(new Error('Send timeout')), 30000) // Longer timeout for media
//             )
//           ]);
          
//           log(`✅ Media message sent to ${number}`);
//         } catch (mediaError) {
//           log(`❌ Error sending media to ${number}: ${mediaError.message}`);
//           return res.status(500).send(`❌ Failed to send media: ${mediaError.message}`);
//         }
//       } else {
//         const sendPromise = client.sendMessage(chatId, message);
//         await Promise.race([
//           sendPromise,
//           new Promise((_, reject) => 
//             setTimeout(() => reject(new Error('Send timeout')), 20000)
//           )
//         ]);
        
//         log(`✅ Text message sent to ${number}`);
//     }
      
//     lastActiveTimestamp = Date.now();
//     res.send('✅ Message sent successfully!');
//   } catch (error) {
//     log(`❌ Error sending message to ${number}: ${error.message}`);
    
//     if (
//       error.message &&
//       (error.message.includes('Connection closed') ||
//        error.message.includes('not connected') ||
//        error.message.includes('terminated') ||
//        error.message.includes('timeout'))
//     ) {
//       await handleDisconnection(`Message send failure: ${error.message}`);
//       return res.status(503).send('❌ WhatsApp disconnected. Reinitializing connection. Please try again later.');
//     }
    
//     checkActiveConnection();
//     res.status(500).send(`❌ Failed to send message: ${error.message}`);
//   }
// });

//media from url
// app.post('/send-message', async (req, res) => {
//   const { number, message, mediaUrl } = req.body;
  
//   if (!number || (!message && !mediaUrl)) {
//     return res.status(400).send('❌ Missing number or message/mediaUrl');
//   }
  
//   try {
//     if (!isLoggedIn || !client) {
//       return res.status(503).send('❌ WhatsApp not connected. Please scan QR code first.');
//     }
    
//     const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
    
//     if (mediaUrl) {
//       try {
//         // Load media from URL instead of local file
//         const media = await MessageMedia.fromUrl(mediaUrl);
        
//         const sendPromise = client.sendMessage(chatId, media, { caption: message || '' });
//         await Promise.race([
//           sendPromise,
//           new Promise((_, reject) =>
//             setTimeout(() => reject(new Error('Send timeout')), 30000) // Longer timeout for media
//           )
//         ]);
        
//         log(`✅ Media message sent to ${number}`);
//       } catch (mediaError) {
//         log(`❌ Error sending media to ${number}: ${mediaError.message}`);
//         return res.status(500).send(`❌ Failed to send media: ${mediaError.message}`);
//       }
//     } else {
//       const sendPromise = client.sendMessage(chatId, message);
//       await Promise.race([
//         sendPromise,
//         new Promise((_, reject) =>
//           setTimeout(() => reject(new Error('Send timeout')), 20000)
//         )
//       ]);
      
//       log(`✅ Text message sent to ${number}`);
//     }
    
//     lastActiveTimestamp = Date.now();
//     res.send('✅ Message sent successfully!');
//   } catch (error) {
//     log(`❌ Error sending message to ${number}: ${error.message}`);
    
//     if (
//       error.message &&
//       (error.message.includes('Connection closed') ||
//        error.message.includes('not connected') ||
//        error.message.includes('terminated') ||
//        error.message.includes('timeout'))
//     ) {
//       await handleDisconnection(`Message send failure: ${error.message}`);
//       return res.status(503).send('❌ WhatsApp disconnected. Reinitializing connection. Please try again later.');
//     }
    
//     checkActiveConnection();
//     res.status(500).send(`❌ Failed to send message: ${error.message}`);
//   }
// });

app.post('/send-message', async (req, res) => {
  const { number, message, mediaUrl, mediaType } = req.body;
  
  if (!number || (!message && !mediaUrl)) {
    return res.status(400).send('❌ Missing number or message/mediaUrl');
  }
  
  try {
    if (!isLoggedIn || !client) {
      return res.status(503).send('❌ WhatsApp not connected. Please scan QR code first.');
    }
    
    const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
    
    if (mediaUrl) {
      try {
        // Load media from URL with unsafe MIME option
        const media = await MessageMedia.fromUrl(mediaUrl, {
          unsafeMime: true,
          mimetype: mediaType // Use provided MIME type if available
        });
        
        const sendPromise = client.sendMessage(chatId, media, { caption: message || '' });
        await Promise.race([
          sendPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Send timeout')), 30000)
          )
        ]);
        
        log(`✅ Media message sent to ${number}`);
      } catch (mediaError) {
        log(`❌ Error sending media to ${number}: ${mediaError.message}`);
        return res.status(500).send(`❌ Failed to send media: ${mediaError.message}`);
      }
    } else {
      const sendPromise = client.sendMessage(chatId, message);
      await Promise.race([
        sendPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Send timeout')), 20000)
        )
      ]);
      
      log(`✅ Text message sent to ${number}`);
    }
    
    lastActiveTimestamp = Date.now();
    res.send('✅ Message sent successfully!');
  } catch (error) {
    log(`❌ Error sending message to ${number}: ${error.message}`);
    
    if (
      error.message &&
      (error.message.includes('Connection closed') ||
       error.message.includes('not connected') ||
       error.message.includes('terminated') ||
       error.message.includes('timeout'))
    ) {
      await handleDisconnection(`Message send failure: ${error.message}`);
      return res.status(503).send('❌ WhatsApp disconnected. Reinitializing connection. Please try again later.');
    }
    
    checkActiveConnection();
    res.status(500).send(`❌ Failed to send message: ${error.message}`);
  }
});

// app.post('/send-group-message', async (req, res) => {
//   const { groupIds, message, mediaPath } = req.body;
  
//   if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
//       return res.status(400).json({ 
//           status: false, 
//           message: 'Group IDs array is required.' 
//       });
//   }
  
//   if (!message && !mediaPath) {
//       return res.status(400).json({ 
//           status: false, 
//           message: 'Either message or mediaPath must be provided.' 
//       });
//   }
  
//   try {
//       let media = null;
      
//       // If mediaPath is provided, check if file exists and prepare media
//       if (mediaPath) {
//           if (!fs.existsSync(mediaPath)) {
//               return res.status(404).json({ 
//                   status: false, 
//                   message: 'Media file not found.' 
//               });
//           }
//           media = MessageMedia.fromFilePath(mediaPath);
//       }
      
//       const results = [];
//       const errors = [];
      
//       // Send to each group in parallel
//       const sendPromises = groupIds.map(async (groupId) => {
//           try {
//               if (media) {
//                   // Send media with caption (if message is provided)
//                   await client.sendMessage(groupId, media, { caption: message || '' });
//               } else {
//                   // Send text-only message
//                   await client.sendMessage(groupId, message);
//               }
//               results.push({ groupId, status: 'success' });
//           } catch (error) {
//               errors.push({ groupId, error: error.toString() });
//           }
//       });
      
//       // Wait for all sending operations to complete
//       await Promise.all(sendPromises);
      
//       const messageType = media ? 'Media' : 'Text message';
      
//       res.status(200).json({ 
//           status: true, 
//           message: `${messageType} sending process completed`,
//           results: {
//               successful: results,
//               failed: errors
//           }
//       });
//   } catch (error) {
//       res.status(500).json({ 
//           status: false, 
//           message: 'Error in message sending process', 
//           error: error.toString() 
//       });
//   }
// });

app.post('/send-group-message', async (req, res) => {
  const { groupIds, message, mediaUrl, mediaType } = req.body;
  
  if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ 
      status: false, 
      message: 'Group IDs array is required.' 
    });
  }
  
  if (!message && !mediaUrl) {
    return res.status(400).json({ 
      status: false, 
      message: 'Either message or mediaUrl must be provided.' 
    });
  }
  
  try {
    if (!isLoggedIn || !client) {
      return res.status(503).json({
        status: false,
        message: '❌ WhatsApp not connected. Please scan QR code first.'
      });
    }
    
    let media = null;
    
    // If mediaUrl is provided, prepare media from URL
    if (mediaUrl) {
      try {
        // Load media from URL with unsafe MIME option
        media = await MessageMedia.fromUrl(mediaUrl, {
          unsafeMime: true,
          mimetype: mediaType // Use provided MIME type if available
        });
      } catch (mediaError) {
        log(`❌ Error loading media from URL: ${mediaError.message}`);
        return res.status(500).json({ 
          status: false, 
          message: `Failed to load media: ${mediaError.message}` 
        });
      }
    }
    
    const results = [];
    const errors = [];
    
    // Send to each group in parallel
    const sendPromises = groupIds.map(async (groupId) => {
      try {
        // Add timeout protection
        const sendPromise = media 
          ? client.sendMessage(groupId, media, { caption: message || '' })
          : client.sendMessage(groupId, message);
          
        await Promise.race([
          sendPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Send timeout')), 30000)
          )
        ]);
        
        results.push({ groupId, status: 'success' });
        log(`✅ ${media ? 'Media' : 'Text'} message sent to group ${groupId}`);
      } catch (error) {
        errors.push({ groupId, error: error.toString() });
        log(`❌ Error sending message to group ${groupId}: ${error.message}`);
      }
    });
    
    // Wait for all sending operations to complete
    await Promise.all(sendPromises);
    
    const messageType = media ? 'Media' : 'Text message';
    
    lastActiveTimestamp = Date.now();
    
    res.status(200).json({ 
      status: true, 
      message: `${messageType} sending process completed`,
      results: {
        successful: results,
        failed: errors
      }
    });
  } catch (error) {
    log(`❌ Error in group message sending process: ${error.message}`);
    
    if (
      error.message &&
      (error.message.includes('Connection closed') ||
       error.message.includes('not connected') ||
       error.message.includes('terminated') ||
       error.message.includes('timeout'))
    ) {
      await handleDisconnection(`Group message send failure: ${error.message}`);
      return res.status(503).json({
        status: false,
        message: '❌ WhatsApp disconnected. Reinitializing connection. Please try again later.'
      });
    }
    
    checkActiveConnection();
    res.status(500).json({ 
      status: false, 
      message: 'Error in message sending process', 
      error: error.toString() 
    });
  }
});
// Status endpoint to check server and WhatsApp connection status
app.get('/status', async (req, res) => {
  let state = connectionState;

  // If logged in, try to get real-time state
  if (isLoggedIn && client) {
    try {
      state = await client.getState();
      lastKnownState = state;
      lastActiveTimestamp = Date.now();
    } catch (error) {
      log(`❌ Error getting state for status endpoint: ${error.message}`);
      // Keep using the stored connectionState if error
    }
  }

  res.json({
    server: 'running',
    whatsapp: {
      connected: isLoggedIn,
      state: state,
      number: isLoggedIn ? loggedInNumber : null,
      authExists: checkAuthExists(),
      lastActive: lastActiveTimestamp > 0 ? new Date(lastActiveTimestamp).toISOString() : null
    }
  });
});

// Force QR code regeneration (cleans auth and reinitializes)
app.post('/reset', async (req, res) => {
  log('🔄 Manual reset requested...');

  // Stop any monitoring
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }

  // Stop active connection checks
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }

  // Clear any pending reconnection
  if (reconnectionTimer) {
    clearTimeout(reconnectionTimer);
    reconnectionTimer = null;
  }

  // Destroy client if it exists
  await destroyClient();
  
  // Reset state variables
  isLoggedIn = false;
  qrCodeData = '';
  connectionState = 'RESETTING';
  reconnectionAttempts = 0;
  lastActiveTimestamp = 0;
  
  // Clean auth directory - FIXED: Changed from cleanAuthDirectoryWindows() to cleanAuthDirectory()
  await cleanAuthDirectory();
  
  // Start monitoring again
  startMonitoring();
  
  // Initialize new client after a delay
  setTimeout(() => {
    initializeWhatsAppClient();
  }, 3000);
  
  res.send('✅ WhatsApp session reset. QR code will be generated shortly.');
});

// NEW ENDPOINT: Logout from WhatsApp (remove device from connected devices list)
app.post('/logout', async (req, res) => {
  log('🔑 WhatsApp logout requested...');
  
  if (isLoggedIn && client) {
    try {
      // First try to logout from WhatsApp Web (removes device from connected devices)
      log('📱 Sending logout command to WhatsApp Web...');
      await client.logout();
      log('✅ WhatsApp Web logout successful');
    } catch (error) {
      log(`❌ Error during WhatsApp logout: ${error.message}`);
    }
  }
  
  // Stop any monitoring
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }
  
  // Stop active connection checks
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }
  
  // Clear any pending reconnection
  if (reconnectionTimer) {
    clearTimeout(reconnectionTimer);
    reconnectionTimer = null;
  }
  
  // Destroy client
  await destroyClient();
  
  // Reset state variables
  isLoggedIn = false;
  qrCodeData = '';
  connectionState = 'LOGGED_OUT';
  reconnectionAttempts = 0;
  lastActiveTimestamp = 0;

  // Clean auth directory after logout
  await cleanAuthDirectory();
  
  // Start monitoring again
  startMonitoring();
  
  // Generate new QR after some delay
  setTimeout(() => {
    initializeWhatsAppClient();
  }, 3000);
  
  res.send('✅ Successfully logged out from WhatsApp. QR code will be generated shortly.');
});

// Define port and start the server
const PORT = process.env.PORT || 3000;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  log('📁 Created uploads directory');
}

// Initialize WhatsApp client
initializeWhatsAppClient();

// Start monitoring
startMonitoring();

// Start the server
app.listen(PORT, () => {
  log(`🚀 Server running on port ${PORT}`);
  log(`🌐 Visit http://localhost:${PORT} to scan QR code or check status`);
  
  // Uncomment for development to auto-open browser
  // open(`http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  log('👋 Shutting down gracefully...');
  
  // Stop timers
  if (monitoringTimer) clearInterval(monitoringTimer);
  if (connectionCheckTimer) clearInterval(connectionCheckTimer);
  if (reconnectionTimer) clearTimeout(reconnectionTimer);
  
  // Destroy client if it exists
  if (client) {
    try {
      await client.destroy();
      log('✅ WhatsApp client destroyed');
    } catch (error) {
      log(`❌ Error destroying client: ${error.message}`);
    }
  }
  
  log('✅ Goodbye!');
  process.exit(0);
});
