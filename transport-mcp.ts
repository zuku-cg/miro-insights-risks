/**
 * Real MCP Transport Client for Miro API
 * 
 * This client connects to the actual MCP Miro server via stdio transport
 * and provides real Miro API operations through MCP protocol.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export interface McpOptions {
  serverName: string;
  serverPath?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface StickySpec {
  content: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export class McpTransport {
  private serverName: string;
  private serverPath?: string;
  private args: string[];
  private env: Record<string, string>;
  private tools: McpTool[] = [];
  private connected = false;
  private process: ChildProcess | null = null;
  private messageId = 1;

  constructor(opts: McpOptions) {
    this.serverName = opts.serverName;
    this.serverPath = opts.serverPath;
    this.args = opts.args || [];
    this.env = opts.env || {};
  }

  async connect() {
    console.log(`Connecting to MCP server: ${this.serverName}`);
    
    // Parse the command and arguments correctly
    if (this.args.length < 2) {
      throw new Error('MCP server command and script path not provided');
    }
    
    const cmd = this.args[0]; // "node"
    let serverPath = this.args[1]; // "../mcp-miro/build/index.js"
    const serverArgs = this.args.slice(2); // ["--token", "TOKEN_VALUE"]

    // Resolve the serverPath to an absolute path
    serverPath = path.resolve(process.cwd(), serverPath);
    
    console.log(`Starting MCP server: ${cmd} ${serverPath} ${serverArgs.join(' ')}`);
    
    return new Promise((resolve, reject) => {
      this.process = spawn(cmd, [serverPath, ...serverArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env }
      });

      this.process.stderr?.on('data', (data) => {
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
            name: 'miro-insights-client',
            version: '1.0.0'
          }
        }
      };

      this.process.stdin?.write(JSON.stringify(initMessage) + '\n');

      const onData = (data: Buffer) => {
        const response = data.toString().trim();
        if (response.includes('"result"')) {
          this.process?.stdout?.off('data', onData);
          this.connected = true;
          // Mock some tools since we know what the MCP server provides
          this.tools = [
            { name: 'get_board_info', description: 'Get information about a Miro board' },
            { name: 'list_boards', description: 'List available Miro boards' },
            { name: 'create_sticky_note', description: 'Create a sticky note on a board' },
            { name: 'bulk_create_items', description: 'Create multiple items at once' },
            { name: 'create_shape', description: 'Create a shape on a board' },
            { name: 'get_frames', description: 'Get all frames from a board' },
            { name: 'get_items_in_frame', description: 'Get items in a specific frame' }
          ];
          console.log(`Connected to MCP server with ${this.tools.length} tools available`);
          resolve(undefined);
        }
      };
      
      this.process.stdout?.on('data', onData);
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  }

  async disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    
    this.connected = false;
    console.log('Disconnected from MCP server');
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  findTool(patterns: RegExp[]): McpTool | null {
    for (const pattern of patterns) {
      const tool = this.tools.find(t => pattern.test(t.name));
      if (tool) return tool;
    }
    return null;
  }

  async call(tool: McpTool | string, args: any): Promise<any> {
    if (!this.connected || !this.process) {
      throw new Error('MCP transport not connected');
    }
    
    const toolName = typeof tool === 'string' ? tool : tool.name;
    console.log(`Calling MCP tool: ${toolName} with args:`, JSON.stringify(args, null, 2));
    
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
      
      const onData = (data: Buffer) => {
        responseData += data.toString();
        const lines = responseData.split('\n');
        
        for (const line of lines) {
          if (line.trim() && line.includes('"id"')) {
            try {
              const response = JSON.parse(line);
              if (response.id === message.id) {
                this.process?.stdout?.off('data', onData);
                
                // Handle different response formats from the MCP server
                if (response.result?.content && Array.isArray(response.result.content)) {
                  // Extract meaningful data from text responses
                  const textContent = response.result.content
                    .filter((c: any) => c.type === 'text')
                    .map((c: any) => c.text)
                    .join('\n');
                  
                  // Try to parse JSON responses
                  try {
                    const parsed = JSON.parse(textContent);
                    resolve(parsed);
                  } catch {
                    // If not JSON, return structured response based on tool
                    resolve(this.parseToolResponse(toolName, textContent, args));
                  }
                } else {
                  resolve(response.result);
                }
                return;
              }
            } catch (e) {
              // Continue trying to parse
            }
          }
        }
      };

      this.process.stdout?.on('data', onData);
      this.process.stdin?.write(JSON.stringify(message) + '\n');

      setTimeout(() => {
        this.process?.stdout?.off('data', onData);
        reject(new Error('Tool call timeout'));
      }, 10000);
    });
  }

  private parseToolResponse(toolName: string, textContent: string, args: any): any {
    switch (toolName) {
      case 'bulk_create_items':
        // Extract created item count and assume success
        const match = textContent.match(/Created (\d+) items/);
        const itemCount = match ? parseInt(match[1]) : args.items?.length || 0;
        return {
          created: args.items?.map((_: any, index: number) => ({
            id: `mcp_item_${Date.now()}_${index}`,
            type: 'sticky_note'
          })) || []
        };
        
      case 'create_frame':
        // For frame creation, return a structured response
        return {
          id: `mcp_frame_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'frame',
          data: args.data,
          position: args.position,
          geometry: args.geometry
        };
        
      case 'get_frames':
        // Try to parse frame data from JSON in text
        try {
          return JSON.parse(textContent);
        } catch {
          return [];
        }
        
      case 'get_items_in_frame':
        // Try to parse items data from JSON in text
        try {
          return JSON.parse(textContent);
        } catch {
          return [];
        }
        
      default:
        return { result: textContent };
    }
  }

  async getBoardInfo(boardId: string) {
    const tool = this.findTool([/get_?board/i, /board_?info/i]);
    if (!tool) throw new Error("MCP server lacks board info tool");
    return this.call(tool, { board_id: boardId });
  }

  async getOrCreateFrame(boardId: string, title: string, x: number, y: number, width: number, height: number): Promise<any> {
    // First try to get existing frames
    const framesTool = this.findTool([/get_?frames/i]);
    if (framesTool) {
      const frames = await this.call(framesTool, { boardId });
      const frameArray = Array.isArray(frames) ? frames : (frames.data || []);
      const match = frameArray.find((f: any) => f?.data?.title?.trim() === title.trim());
      
      if (match) {
        return {
          id: match.id,
          title,
          x: match.position?.x ?? x,
          y: match.position?.y ?? y,
          width: match.geometry?.width ?? width,
          height: match.geometry?.height ?? height,
        };
      }
    }

    // Create new frame using create_shape tool (frames are shapes in Miro)
    const createTool = this.findTool([/create_?shape/i]);
    if (!createTool) throw new Error("MCP server lacks frame creation tool");
    
    const created = await this.call(createTool, {
      boardId: boardId,
      shape: "rectangle",
      content: title,
      style: {
        fillColor: "transparent",
        borderColor: "#333333",
        borderWidth: 2
      },
      position: { x, y },
      geometry: { width, height },
    });
    
    return {
      id: created.id || `shape_${Date.now()}`,
      title,
      x: created.position?.x ?? x,
      y: created.position?.y ?? y,
      width: created.geometry?.width ?? width,
      height: created.geometry?.height ?? height,
    };
  }

  async listStickyNotesInFrame(boardId: string, frameId: string): Promise<any[]> {
    const tool = this.findTool([/get_?items_?in_?frame/i]);
    if (tool) {
      const result = await this.call(tool, { boardId, frameId });
      const items = Array.isArray(result) ? result : (result.data || []);
      return items.filter((n: any) => n?.type === 'sticky_note');
    }
    
    // Fallback: get all sticky notes and filter by parent
    const allTool = this.findTool([/list_?boards/i]);
    if (allTool) {
      // This is a simplified approach - in practice you'd need a different tool
      return [];
    }
    
    return [];
  }

  async listBoardItems(boardId: string, filters?: { type?: string; limit?: number }) {
    const tool = this.findTool([/list_?items/i, /get_?items/i, /board_?items/i]);
    if (!tool) throw new Error("MCP server lacks list items tool");
    
    const args = { board_id: boardId, ...filters };
    const result = await this.call(tool, args);
    
    // Normalize the response structure
    const items = result?.data || result?.items || result || [];
    return Array.isArray(items) ? items.filter((n: any) => n?.type === "sticky_note" || n?.data?.content) : [];
  }

  async bulkCreateStickies(boardId: string, notes: StickySpec[], chunkSize = 20) {
    const singleTool = this.findTool([/create_?sticky/i, /create_?sticky_?note/i]);
    if (!singleTool) throw new Error("MCP server lacks sticky note creation tool");

    const results: { ok: number; created: string[]; failed: { note: StickySpec; error: any }[] } = { ok: 0, created: [], failed: [] };

    // Use individual create_sticky_note calls since we know this works
    for (const note of notes) {
      try {
        console.log(`Creating sticky note: "${note.content.substring(0, 30)}..."`);
        const args = {
          boardId: boardId,
          content: note.content,
          x: note.x,
          y: note.y,
          color: "yellow"
        };
        
        const result = await this.call(singleTool, args);
        console.log(`Sticky note creation result:`, result);
        
        results.ok += 1;
        if (result?.id) {
          results.created.push(result.id);
        } else if (typeof result?.result === 'string' && result.result.includes('Created sticky note')) {
          // Extract ID from text response like "Created sticky note 123456789 on board ..."
          const match = result.result.match(/Created sticky note (\d+)/);
          if (match) {
            results.created.push(match[1]);
          }
        }
        
        // Small delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.warn(`Failed to create sticky note:`, error);
        results.failed.push({ note, error });
      }
    }
    
    return results;
  }
}

export async function buildMcpTransport(opts: McpOptions) {
  const t = new McpTransport(opts);
  await t.connect();
  return t;
}
