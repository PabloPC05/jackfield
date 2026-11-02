/**
 * A small BM25 index, used by the `search` exposure mode so a client that
 * cannot load tool definitions on demand gets `find_tool` instead of 500
 * definitions. Pure and dependency-free: it also runs on a serverless runtime
 * where the index is rebuilt per request.
 */

export interface IndexedDocument {
    id: string;
    /** Weighted fields. A term in the name counts for more than one in the text. */
    fields: { text: string; weight: number }[];
}

export interface SearchHit {
    id: string;
    score: number;
}

const K1 = 1.2;
const B = 0.75;

/** Splits on non-alphanumerics and on camelCase/snake_case boundaries. */
export function tokenize(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length > 1 && token.length < 40);
}

export class Bm25Index {
    private readonly termFrequency = new Map<string, Map<string, number>>();
    private readonly documentLength = new Map<string, number>();
    private readonly documentFrequency = new Map<string, number>();
    private averageLength = 0;

    constructor(documents: IndexedDocument[] = []) {
        for (const document of documents) this.add(document);
        this.finalize();
    }

    add(document: IndexedDocument): void {
        const counts = new Map<string, number>();
        let length = 0;
        for (const field of document.fields) {
            for (const token of tokenize(field.text)) {
                counts.set(token, (counts.get(token) ?? 0) + field.weight);
                length += field.weight;
            }
        }
        this.termFrequency.set(document.id, counts);
        this.documentLength.set(document.id, length);
        for (const token of counts.keys()) {
            this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
        }
    }

    finalize(): void {
        const lengths = [...this.documentLength.values()];
        this.averageLength = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
    }

    get size(): number {
        return this.documentLength.size;
    }

    search(query: string, limit = 10): SearchHit[] {
        const terms = tokenize(query);
        if (terms.length === 0 || this.size === 0) return [];
        const total = this.size;
        const scores = new Map<string, number>();

        for (const term of terms) {
            const df = this.documentFrequency.get(term);
            if (!df) continue;
            const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
            for (const [id, counts] of this.termFrequency) {
                const tf = counts.get(term);
                if (!tf) continue;
                const length = this.documentLength.get(id) ?? 0;
                const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (length / (this.averageLength || 1))));
                scores.set(id, (scores.get(id) ?? 0) + idf * norm);
            }
        }

        return [...scores.entries()]
            .map(([id, score]) => ({ id, score }))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .slice(0, limit);
    }
}
