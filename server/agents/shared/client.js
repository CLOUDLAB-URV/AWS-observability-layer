'use strict';

// Gemini (Google Vertex AI) client via the Google Gen AI SDK (@google/genai),
// exposed through a thin Anthropic-Messages-compatible adapter so the rest of the
// codebase (toolLoop.js, architect, reconciler) keeps calling
// `getGemini().messages.stream({...})` unchanged:
//   - stream.on('text', delta)         → streamed text chunks
//   - await stream.finalMessage()      → { content: [...blocks], stop_reason }
// where blocks are Anthropic-shaped { type:'text', text } / { type:'tool_use',
// id, name, input }, and the loop replies with { type:'tool_result', tool_use_id,
// content }. The adapter translates that dialect to/from Gemini's contents /
// functionCall / functionResponse shape.

import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { withLimit, withRetry } from './limiter.js';
import * as usageStore from '../../usageStore.js';

// Per-agent model routing (cost control): cheap Flash for diagram design and
// state reconciliation, Pro for the agentic AWS tool loop.
export const MODELS = {
    architect: 'gemini-2.5-flash',
    reconciler: 'gemini-2.5-flash',
    aws: 'gemini-2.5-pro',
    teardown: 'gemini-2.5-pro'
};

// Permissive safety thresholds: this is an autonomous infra/DevOps agent that
// routinely handles security-adjacent AWS content; only block the highest-risk
// categories to avoid spurious refusals mid-task.
const SAFETY_SETTINGS = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

// Lazy so the server can boot (and render diagrams) without GCP credentials set.
let genai = null;
function genaiClient() {
    if (!genai) {
        genai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID,
            // Gemini models require a physical region — 'global' is not valid here.
            location: process.env.CLOUD_ML_REGION || 'us-central1'
        });
    }
    return genai;
}

// Anthropic-compatible facade. Single shared instance — the adapter is stateless.
const gemini = {
    messages: {
        stream(params) {
            return new GeminiMessageStream(params);
        }
    }
};

export function getGemini() {
    return gemini;
}

// ---------------------------------------------------------------------------
// Streaming adapter
// ---------------------------------------------------------------------------
class GeminiMessageStream {
    constructor(params) {
        this._handlers = new Map();
        // Kick off immediately; callers attach `.on('text')` synchronously and
        // then `await finalMessage()`.
        this._final = this._run(params);
    }

    on(event, handler) {
        const list = this._handlers.get(event) ?? [];
        list.push(handler);
        this._handlers.set(event, list);
        return this;
    }

    _emit(event, payload) {
        for (const handler of this._handlers.get(event) ?? []) {
            handler(payload);
        }
    }

    finalMessage() {
        return this._final;
    }

    // Every attempt (request + full stream consumption) runs inside one
    // concurrency slot; the retry sits outside the slot so backoff sleeps never
    // hold capacity. Once any text has been emitted to a listener we stop
    // retrying — re-running would duplicate the streamed output downstream.
    _run(params) {
        let emitted = false;
        return withRetry(
            () => withLimit(() => this._attempt(params, () => { emitted = true; })),
            { canRetry: () => !emitted }
        );
    }

    async _attempt(params, markEmitted) {
        const config = {
            maxOutputTokens: params.max_tokens ?? 8192,
            safetySettings: SAFETY_SETTINGS
        };
        const systemInstruction = toSystemInstruction(params.system);
        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }
        const tools = toGeminiTools(params.tools);
        if (tools) {
            config.tools = tools;
        }

        const stream = await genaiClient().models.generateContentStream({
            model: params.model,
            contents: toContents(params.messages),
            config
        });

        // Aggregate the streamed chunks into a single Anthropic-shaped message.
        let text = '';
        let usage = null; // last usageMetadata wins — the final chunk carries the totals
        const functionCalls = [];
        for await (const chunk of stream) {
            if (chunk?.usageMetadata) {
                usage = chunk.usageMetadata;
            }
            for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
                if (part.thought) {
                    continue; // internal reasoning, never surfaced to the user
                }
                if (typeof part.text === 'string' && part.text) {
                    text += part.text;
                    markEmitted();
                    this._emit('text', part.text);
                } else if (part.functionCall) {
                    functionCalls.push(part.functionCall);
                }
            }
        }

        // Per-user token accounting (admin panel + monthly cap). params.user is the
        // userId the call runs for; calls without one (Design mode's shared session)
        // accrue under the _design pseudo-user. Never blocks or fails the response.
        if (usage) {
            usageStore.record(params.user ?? null, {
                input: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
                output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
                total: usage.totalTokenCount ?? 0
            }).catch((error) => console.error('[llm-usage] record failed', error));
        }

        return toAnthropicMessage(text, functionCalls);
    }
}

// ---------------------------------------------------------------------------
// Anthropic → Gemini request translation
// ---------------------------------------------------------------------------
function toSystemInstruction(system) {
    if (!system) {
        return undefined;
    }
    if (typeof system === 'string') {
        return system;
    }
    const text = system
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n');
    return text || undefined;
}

function toGeminiTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return undefined;
    }
    return [
        {
            functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: toGeminiSchema(tool.input_schema)
            }))
        }
    ];
}

// JSON-Schema keywords Gemini's function declarations reject.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
    '$schema',
    '$id',
    '$defs',
    'definitions',
    'additionalProperties',
    'default',
    'examples'
]);

// Convert a JSON Schema (as emitted by the MCP server) into Gemini's schema
// dialect: uppercase `type` values, strip unsupported keywords, and rewrite an
// `anyOf` whose only extra branch is `null` into a plain nullable schema (e.g.
// call_aws's `max_results: integer | null`).
function toGeminiSchema(schema) {
    if (schema == null || typeof schema !== 'object') {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map(toGeminiSchema);
    }

    const out = {};
    let nullable = schema.nullable === true;

    for (const [key, value] of Object.entries(schema)) {
        if (UNSUPPORTED_SCHEMA_KEYS.has(key)) {
            continue;
        }

        if (key === 'anyOf' && Array.isArray(value)) {
            const members = value.map(toGeminiSchema);
            const nonNull = members.filter((member) => !(member && member.type === 'NULL'));
            if (nonNull.length < members.length) {
                nullable = true;
            }
            if (nonNull.length === 1) {
                Object.assign(out, nonNull[0]); // collapse single remaining branch
            } else {
                out.anyOf = nonNull;
            }
        } else if (key === 'type' && typeof value === 'string') {
            out.type = value.toUpperCase();
        } else if (key === 'properties' && value && typeof value === 'object') {
            out.properties = Object.fromEntries(
                Object.entries(value).map(([name, sub]) => [name, toGeminiSchema(sub)])
            );
        } else if (key === 'nullable') {
            nullable = nullable || value === true;
        } else {
            out[key] = toGeminiSchema(value);
        }
    }

    if (nullable) {
        out.nullable = true;
    }
    return out;
}

// Translate the Anthropic `messages` array into Gemini `contents`. Tool results
// (`tool_use_id`) are matched back to their function name via the `tool_use`
// blocks earlier in the same conversation.
function toContents(messages) {
    const nameByToolUseId = new Map();
    for (const message of messages) {
        if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block.type === 'tool_use') {
                    nameByToolUseId.set(block.id, block.name);
                }
            }
        }
    }

    const contents = [];
    for (const message of messages) {
        if (message.role === 'assistant') {
            contents.push({ role: 'model', parts: toModelParts(message.content) });
        } else {
            // 'user' — plain text, or an array carrying tool_result/text blocks.
            contents.push({ role: 'user', parts: toUserParts(message.content, nameByToolUseId) });
        }
    }
    return contents;
}

function toModelParts(content) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }
    const parts = [];
    for (const block of content ?? []) {
        if (block.type === 'text') {
            parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
            parts.push({ functionCall: { name: block.name, args: block.input ?? {} } });
        }
    }
    return parts;
}

function toUserParts(content, nameByToolUseId) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }
    const parts = [];
    for (const block of content ?? []) {
        if (block.type === 'tool_result') {
            parts.push({
                functionResponse: {
                    name: nameByToolUseId.get(block.tool_use_id) ?? 'tool',
                    response: toFunctionResponse(block.content)
                }
            });
        } else if (block.type === 'text') {
            parts.push({ text: block.text });
        }
    }
    return parts;
}

// Gemini requires functionResponse.response to be a JSON *object* (struct) —
// arrays and primitives must be wrapped, or Vertex rejects the payload with
// "Proto field is not repeating, cannot start list".
function toFunctionResponse(content) {
    let value = content;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            // not JSON — keep the raw string, wrapped below
        }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return { result: value };
}

// ---------------------------------------------------------------------------
// Gemini → Anthropic response translation
// ---------------------------------------------------------------------------
function toAnthropicMessage(text, functionCalls) {
    const content = [];
    if (text) {
        content.push({ type: 'text', text });
    }
    for (const call of functionCalls) {
        content.push({
            type: 'tool_use',
            id: `gem_${randomUUID()}`,
            name: call.name,
            input: call.args ?? {}
        });
    }
    return { content, stop_reason: functionCalls.length > 0 ? 'tool_use' : 'end_turn' };
}
