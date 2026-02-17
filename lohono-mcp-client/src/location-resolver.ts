import { logInfo as logger } from "../../shared/observability/src/index.js";

/**
 * Valid canonical locations in the database.
 * Ideally this should be fetched from the DB, but for now we hardcode common values.
 * This list acts as the source of truth for fuzzy matching.
 */
export const CANONICAL_LOCATIONS = [
    "Goa",
    "Alibaug",
    "Lonavala",
    "Kasauli",
    "Coonoor",
    "Mumbai",
    "Delhi",
    "Bengaluru",
    "Hyderabad",
    "Chennai",
    "Pune",
    "Jaipur",
    "Udaipur",
    "Mussoorie",
    "Shimla",
    "Manali",
    "Nainital",
    "Rishikesh",
    "Dehradun",
    "Chandigarh",
    "Kolkata",
    "Ahmedabad",
    "Surat",
    "Indore",
    "Bhopal",
    "Nagpur",
    "Nashik",
    "Aurangabad",
    "Goa - North",
    "Goa - South",
    "Dubai",
    "London",
    "Phuket",
    "Bali",
    "Sri Lanka",
    "Maldives"
];

/**
 * Calculates Levenshtein distance between two strings.
 * @param a First string
 * @param b Second string
 * @returns The edit distance
 */
function levenshteinDistance(a: string, b: string): number {
    const an = a ? a.length : 0;
    const bn = b ? b.length : 0;
    if (an === 0) return bn;
    if (bn === 0) return an;
    const matrix = new Int32Array((bn + 1) * (an + 1));
    for (let i = 0; i <= bn; ++i) matrix[i] = i;
    for (let i = 0; i <= an; ++i) matrix[i * (bn + 1)] = i;
    for (let i = 1; i <= an; ++i) {
        for (let j = 1; j <= bn; ++j) {
            if (b.charAt(j - 1) === a.charAt(i - 1)) {
                matrix[i * (bn + 1) + j] = matrix[(i - 1) * (bn + 1) + (j - 1)];
            } else {
                matrix[i * (bn + 1) + j] =
                    Math.min(
                        matrix[(i - 1) * (bn + 1) + (j - 1)], // substitution
                        matrix[i * (bn + 1) + (j - 1)], // insertion
                        matrix[(i - 1) * (bn + 1) + j] // deletion
                    ) + 1;
            }
        }
    }
    return matrix[an * (bn + 1) + bn];
}

/**
 * Resolves a list of user inputs to canonical locations using fuzzy matching.
 * @param inputs Array of location strings provided by the user (e.g. ["gao", "albag"])
 * @returns Array of unique canonical location names (e.g. ["Goa", "Alibaug"])
 */
export function resolveLocations(inputs: string[] | undefined): string[] {
    if (!inputs || inputs.length === 0) {
        return [];
    }

    const resolved = new Set<string>();

    // Pre-process inputs: flatten CSV strings and trim
    const flattenedInputs: string[] = [];
    for (const input of inputs) {
        if (!input || typeof input !== "string") continue;
        if (input.includes(",")) {
            flattenedInputs.push(...input.split(",").map(s => s.trim()).filter(s => s.length > 0));
        } else {
            flattenedInputs.push(input.trim());
        }
    }

    for (const input of flattenedInputs) {
        if (!input) continue;

        const normalizedInput = input.trim().toLowerCase();

        // 1. Exact match (case-insensitive)
        const exactMatch = CANONICAL_LOCATIONS.find(
            (loc) => loc.toLowerCase() === normalizedInput
        );
        if (exactMatch) {
            resolved.add(exactMatch);
            continue;
        }

        // 2. Fuzzy match
        let bestMatch: string | null = null;
        let minDistance = Infinity;

        for (const location of CANONICAL_LOCATIONS) {
            const distance = levenshteinDistance(normalizedInput, location.toLowerCase());
            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = location;
            }
        }

        // Threshold: Allow up to 3 edits, or 40% of length, whichever is smaller
        // For very short strings (like "Goa"), 1 edit is significant.
        const threshold = Math.min(3, Math.floor(normalizedInput.length * 0.4) + 1);

        if (bestMatch && minDistance <= threshold) {
            logger(`Fuzzy matched location '${input}' to '${bestMatch}' (distance: ${minDistance})`);
            resolved.add(bestMatch);
        } else {
            logger(`Could not resolve location '${input}' (closest was '${bestMatch}' with distance ${minDistance})`);
            // Optional: Add the original input if we want to trust the user when no match is found
            // resolved.add(input); 
        }
    }

    return Array.from(resolved);
}
