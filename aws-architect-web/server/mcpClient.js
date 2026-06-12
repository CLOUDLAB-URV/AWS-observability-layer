'use strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let clientPromise = null;

async function connect() {
    const transport = new StdioClientTransport({
        command: process.env.AWS_MCP_COMMAND || 'uvx',
        args: process.env.AWS_MCP_ARGS
            ? process.env.AWS_MCP_ARGS.split(' ')
            : ['awslabs.aws-api-mcp-server@latest'],
        env: {
            ...process.env,
            AWS_PROFILE: process.env.AWS_PROFILE || 'apozo-cloudlab',
            AWS_REGION: process.env.AWS_REGION || 'us-east-1'
        },
        stderr: 'inherit'
    });

    const client = new Client({ name: 'aws-architect-web', version: '0.1.0' });
    await client.connect(transport);
    return client;
}

export function getMcpClient() {
    if (!clientPromise) {
        clientPromise = connect().catch((error) => {
            clientPromise = null;
            throw error;
        });
    }
    return clientPromise;
}

// MCP tool definitions mapped to Messages API tool shape.
export async function listAnthropicTools() {
    const client = await getMcpClient();
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema
    }));
}

export async function callMcpTool(name, args) {
    const client = await getMcpClient();
    return client.callTool({ name, arguments: args ?? {} });
}

// Same extraction the extension does in serverService.extractOutputMessages(),
// applied to the structuredContent of a call_aws tool result.
export function extractOutputMessages(structuredContent) {
    const outputMessages = [];

    if (!structuredContent || structuredContent.suggestions) {
        return outputMessages;
    }

    if (Array.isArray(structuredContent.result)) {
        for (const res of structuredContent.result) {
            if (!res.cli_command) {
                continue;
            }

            let resourceState = {};
            if (res.response) {
                if (typeof res.response.as_json !== 'undefined') {
                    try {
                        const parsedJson = typeof res.response.as_json === 'string'
                            ? JSON.parse(res.response.as_json)
                            : res.response.as_json;
                        if (parsedJson && parsedJson.ResponseMetadata) {
                            delete parsedJson.ResponseMetadata;
                        }
                        resourceState = parsedJson;
                    } catch {
                        resourceState = res.response;
                    }
                } else {
                    resourceState = res.response;
                }
            }

            const outputMessage = {
                action: res.cli_command,
                resource_state: resourceState
            };
            if (res.error) {
                outputMessage.error = res.error;
            }
            outputMessages.push(outputMessage);
        }
    }

    return outputMessages;
}
