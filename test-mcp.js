#!/usr/bin/env node

const { spawn } = require('child_process');
const { createHash } = require('crypto');

// Simple MCP client that bypasses SDK issues
class SimpleMcpClient {
  constructor(command, args, env) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.process = null;
    this.messageId = 1;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env }
      });

      this.process.stderr.on('data', (data) => {
        console.error('MCP server stderr:', data.toString());
      });

      // Send initialize message
      const initMessage = {
        jsonrpc: '2.0',
        id: this.messageId++,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'simple-mcp-client',
            version: '1.0.0'
          }
        }
      };

      this.process.stdin.write(JSON.stringify(initMessage) + '\n');

      this.process.stdout.on('data', (data) => {
        const response = data.toString().trim();
        console.log('MCP response:', response);
        
        if (response.includes('"result"')) {
          resolve();
        }
      });

      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  }

  async callTool(toolName, args) {
    return new Promise((resolve, reject) => {
      const message = {
        jsonrpc: '2.0',
        id: this.messageId++,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      };

      let responseData = '';
      
      const onData = (data) => {
        responseData += data.toString();
        const lines = responseData.split('\n');
        
        for (const line of lines) {
          if (line.trim() && line.includes('"id"')) {
            try {
              const response = JSON.parse(line);
              if (response.id === message.id) {
                this.process.stdout.off('data', onData);
                resolve(response);
                return;
              }
            } catch (e) {
              // Continue trying to parse
            }
          }
        }
      };

      this.process.stdout.on('data', onData);
      this.process.stdin.write(JSON.stringify(message) + '\n');

      setTimeout(() => {
        this.process.stdout.off('data', onData);
        reject(new Error('Tool call timeout'));
      }, 10000);
    });
  }

  disconnect() {
    if (this.process) {
      this.process.kill();
    }
  }
}

async function main() {
  const client = new SimpleMcpClient('node', [
    'mcp-miro/build/index.js',
    '--token',
    process.env.MIRO_TOKEN
  ], {});

  try {
    console.log('Connecting to MCP server...');
    await client.connect();
    
    console.log('Creating sticky note...');
    const response = await client.callTool('create_sticky_note', {
      boardId: process.env.BOARD_ID,
      content: 'Hello from MCP! 🎯',
      color: 'yellow',
      x: 100,
      y: 100
    });

    console.log('Sticky note created:', JSON.stringify(response, null, 2));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    client.disconnect();
  }
}

main();
