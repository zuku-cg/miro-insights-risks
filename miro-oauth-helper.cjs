#!/usr/bin/env node
/**
 * Simple OAuth helper for Miro API access token generation.
 * 
 * USAGE:
 *   1. Create a Miro app at https://developers.miro.com/docs/getting-started
 *   2. Set redirect URI to: http://localhost:4357/callback
 *   3. Set environment variables:
 *      export MIRO_CLIENT_ID=your_client_id
 *      export MIRO_CLIENT_SECRET=your_client_secret
 *   4. Run: node miro-oauth-helper.cjs
 *   5. Open the printed URL in your browser
 *   6. Copy the access token from the response
 */

const http = require('http');
const url = require('url');
const crypto = require('crypto');

const CLIENT_ID = process.env.MIRO_CLIENT_ID;
const CLIENT_SECRET = process.env.MIRO_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:4357/callback';
const PORT = 4357;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing environment variables:');
  console.error('  MIRO_CLIENT_ID=your_client_id');
  console.error('  MIRO_CLIENT_SECRET=your_client_secret');
  console.error('\nGet these from: https://developers.miro.com/docs/getting-started');
  process.exit(1);
}

// Generate state parameter for security
const state = crypto.randomBytes(16).toString('hex');

// Build authorization URL
const authUrl = new URL('https://miro.com/oauth/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', 'boards:read boards:write');
authUrl.searchParams.set('state', state);

let server;

const server_handler = async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  
  if (parsedUrl.pathname === '/auth') {
    // Redirect to Miro authorization
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }
  
  if (parsedUrl.pathname === '/callback') {
    const { code, state: returnedState, error } = parsedUrl.query;
    
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authorization Error</h1><p>${error}</p>`);
      return;
    }
    
    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Security Error</h1><p>State parameter mismatch</p>');
      return;
    }
    
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Authorization Error</h1><p>No authorization code received</p>');
      return;
    }
    
    try {
      // Exchange code for access token
      const tokenResponse = await fetch('https://api.miro.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code: code,
          redirect_uri: REDIRECT_URI
        })
      });
      
      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`);
      }
      
      const tokenData = await tokenResponse.json();
      
      // Success page with token
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><title>Miro OAuth Success</title></head>
          <body style="font-family: Arial, sans-serif; padding: 20px;">
            <h1>✅ Authorization Successful!</h1>
            <h2>Access Token:</h2>
            <div style="background: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all; margin: 10px 0;">
              <code>${tokenData.access_token}</code>
            </div>
            <h2>Export Command:</h2>
            <div style="background: #f0f8ff; padding: 10px; border-radius: 4px; margin: 10px 0;">
              <code>export MIRO_TOKEN="${tokenData.access_token}"</code>
            </div>
            <p><strong>Token Type:</strong> ${tokenData.token_type}</p>
            <p><strong>Scope:</strong> ${tokenData.scope}</p>
            ${tokenData.expires_in ? `<p><strong>Expires in:</strong> ${tokenData.expires_in} seconds</p>` : ''}
            <p style="color: #666; font-size: 14px;">
              Copy the export command above and run it in your terminal, then you can close this window.
            </p>
          </body>
        </html>
      `);
      
      console.log('\n✅ Success! Access token generated.');
      console.log('📋 Copy this command to set your environment variable:');
      console.log(`export MIRO_TOKEN="${tokenData.access_token}"`);
      
      // Close server after a delay
      setTimeout(() => {
        server.close();
        console.log('\n🔒 OAuth server closed.');
      }, 2000);
      
    } catch (error) {
      console.error('Token exchange error:', error);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Token Exchange Error</h1><p>${error.message}</p>`);
    }
    return;
  }
  
  // Default response
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end('<h1>404 Not Found</h1><p>Go to <a href="/auth">/auth</a> to start OAuth flow</p>');
};

server = http.createServer(server_handler);

server.listen(PORT, () => {
  console.log(`🚀 Miro OAuth helper running on http://localhost:${PORT}`);
  console.log('📖 Instructions:');
  console.log('   1. Open this URL in your browser: http://localhost:4357/auth');
  console.log('   2. Authorize the app in Miro');
  console.log('   3. Copy the access token from the success page');
  console.log('   4. Set it as MIRO_TOKEN environment variable');
  console.log('\n🔧 Make sure your Miro app has this redirect URI: http://localhost:4357/callback');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down OAuth server...');
  server.close();
  process.exit(0);
});
