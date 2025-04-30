# WhatsApp Web API Server

A simple API server for WhatsApp Web to send messages and media.

## Features

- WhatsApp Web authentication with QR code
- Send text messages
- Send media messages (regular and HD)
- Status monitoring
- Auto-reconnection
- Web interface for connection management

## Setup

1. Clone this repository
2. Install dependencies: `npm install`
3. Start the server: `npm start`

## API Endpoints

- `GET /` - Web interface for managing WhatsApp connection
- `GET /status` - Get server and WhatsApp connection status
- `POST /send-text` - Send text message
- `POST /send-message` - Send text message with optional media
- `POST /send-messagehd` - Send text message with optional HD media
- `POST /reset` - Reset WhatsApp session
- `POST /logout` - Logout from WhatsApp
- `GET /ping` - Test connection

## Deployment

This server is designed to be deployed on platforms like Render.

### Render Deployment Steps

1. Push this repository to GitHub
2. Create a new Web Service in Render
3. Connect your GitHub repository
4. Configure as Node.js service
5. Set start command: `npm start`
6. Deploy

## Environment Variables

None required, but PORT can be customized (defaults to 3000).