import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Keeps a tool result under a byte budget.
 *
 * A single reply that fills the context window is worse than a trimmed one:
 * the agent loses the conversation either way, and with a trim it at least
 * knows what happened and can ask for less. Text blocks are cut from the end,
 * largest first, and a note says how much went.
 */
export function trimResult(result: CallToolResult, maxBytes: number): { result: CallToolResult; trimmedBytes: number } {
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    const original = size(result);
    if (original <= maxBytes) return { result, trimmedBytes: 0 };

    const content = [...(result.content ?? [])];
    let budget = maxBytes;
    let trimmed = 0;

    // Non-text blocks (images, audio, resources) cannot be trimmed usefully;
    // they are kept or dropped whole, from the end.
    const overhead = size({ ...result, content: [] });
    budget -= overhead;

    const sizes = content.map(size);
    const textIndexes = content
        .map((block, index) => ({ block, index }))
        .filter(entry => entry.block.type === 'text')
        .sort((a, b) => (sizes[b.index] ?? 0) - (sizes[a.index] ?? 0));

    let total = sizes.reduce((sum, value) => sum + value, 0);

    for (const entry of textIndexes) {
        if (total <= budget) break;
        const excess = total - budget;
        const block = content[entry.index] as { type: 'text'; text: string };
        const keep = Math.max(200, block.text.length - excess - 120);
        if (keep >= block.text.length) continue;
        const cut = block.text.length - keep;
        content[entry.index] = {
            ...block,
            text: `${block.text.slice(0, keep)}\n\n[trimmed by the gateway: ${cut} more characters. Ask for a narrower result, a page, or a filter.]`
        };
        trimmed += cut;
        total = content.map(size).reduce((sum, value) => sum + value, 0);
    }

    // Still over budget: drop whole blocks from the end.
    while (total > budget && content.length > 1) {
        const dropped = content.pop();
        trimmed += size(dropped);
        total = content.map(size).reduce((sum, value) => sum + value, 0);
    }

    const out: CallToolResult = { ...result, content };
    if (out.structuredContent && size(out.structuredContent) > budget / 2) {
        delete out.structuredContent;
        out.content = [
            ...content,
            { type: 'text', text: '[the structured result was dropped by the gateway: too large]' }
        ];
    }

    return { result: out, trimmedBytes: trimmed };
}
